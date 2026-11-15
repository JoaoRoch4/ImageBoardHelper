#!/usr/bin/env node
// Builds image-board-helper.user.js from src/ (npm run build): esbuild joins
// the modules into one IIFE, not minified, the metadata block of
// src/header.txt on top. The generated file stays committed, since the
// deploy installs it by its commit-pinned raw link.
//
//   node tools/build.mts            writes image-board-helper.user.js
//   node tools/build.mts --check    fails when the committed file is not what src/ builds
//
// Two checks run on every build, because the bundle hides what they catch:
// - no identifier renamed: esbuild renames a top-level name that two modules
//   share (foo -> foo2), and tools and readers find functions by name;
// - load order: a bundle turns every top-level const/let into a var, so a
//   value read while the modules load, before its own module ran, is
//   undefined instead of a ReferenceError ("${ACCENT}" would print
//   "undefined" in a CSS string, silently).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import * as espree from 'espree'
import * as eslintScope from 'eslint-scope'
import type * as ESTree from 'estree'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(REPO, 'src')
const OUT = path.join(REPO, 'image-board-helper.user.js')
const HELPERS = /^__[a-zA-Z]+$/   // esbuild's own runtime (keepNames: __name, __defProp)

/** The userscript as src/ builds it. */
export async function build(): Promise<string> {
  const entry = ['main.ts', 'main.js'].map(f => path.join(SRC, f)).find(f => fs.existsSync(f))
  if (!entry) throw new Error('no src/main.ts')
  const result = await esbuild.build({
    entryPoints: [entry],
    absWorkingDir: REPO,       // the bundle names each module by its path from here: // src/core/config.ts
    bundle: true,
    write: false,
    metafile: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    charset: 'utf8',           // emojis stay emojis, not \u escapes
    minify: false,
    keepNames: true,
    treeShaking: false,        // nothing that looks unused is dropped: the source decides
    legalComments: 'inline',
    logLevel: 'silent',
  })
  for (const w of result.warnings) console.warn(`build warning: ${w.text}${w.location ? ` (${w.location.file}:${w.location.line})` : ''}`)
  const out = result.outputFiles[0]
  if (!out) throw new Error('esbuild wrote nothing')
  // ESM is strict, and esbuild says so with a directive above the IIFE. The
  // script's own "use strict" goes inside it, as it always was: Violentmonkey
  // wraps the file in its own function, and a directive only counts as the
  // first statement of one.
  let code = out.text.replace(/^"use strict";\n/, '')
  const open = '(() => {\n'
  if (!code.startsWith(open) || !code.endsWith('})();\n')) throw new Error('unexpected bundle shape: not one IIFE')
  code = `${open}  "use strict";\n${code.slice(open.length)}`

  const inputs = Object.keys(result.metafile.inputs)
  checkNames(code, inputs)
  checkLoadOrder(code)
  const header = fs.readFileSync(path.join(SRC, 'header.txt'), 'utf8').trimEnd()
  checkVersion(header, code)
  return `${header}\n\n${code}`
}

type Variable = eslintScope.Variable
type Node = ESTree.Node

function parse(code: string, sourceType: 'script' | 'module') {
  const ast = espree.parse(code, { ecmaVersion: 2022, sourceType, range: true, loc: true, comment: true }) as ESTree.Program
  const scopes = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType })
  return { ast, scopes }
}

// Every name declared anywhere in the code (variables, functions, parameters,
// catch bindings), leaving out import bindings.
function declaredNames(code: string, sourceType: 'script' | 'module'): Set<string> {
  const { scopes } = parse(code, sourceType)
  const names = new Set<string>()
  for (const scope of scopes.scopes) {
    for (const v of scope.variables) {
      if (v.defs.length && v.defs.every(d => d.type !== 'ImportBinding')) names.add(v.name)
    }
  }
  return names
}

// The bundle declares exactly the names the modules declare: one more is a
// rename (or code esbuild made up), one fewer is code that was dropped.
function checkNames(bundle: string, inputs: string[]) {
  const source = new Set<string>()
  for (const file of inputs) {
    const text = fs.readFileSync(path.join(REPO, file), 'utf8')
    const js = esbuild.transformSync(text, { loader: file.endsWith('.ts') ? 'ts' : 'js', format: 'esm', target: 'es2020' }).code
    for (const n of declaredNames(js, 'module')) source.add(n)
  }
  const built = declaredNames(bundle, 'script')
  const renamed = [...built].filter(n => !source.has(n) && !HELPERS.test(n))
  const dropped = [...source].filter(n => !built.has(n))
  if (renamed.length || dropped.length) {
    throw new Error(`the bundle's names differ from src/: ${renamed.length ? `renamed or new: ${renamed.join(', ')}` : ''}` +
      `${dropped.length ? ` dropped: ${dropped.join(', ')}` : ''}. Two modules may declare the same top-level name; rename one in src/.`)
  }
}

// Array methods that call their callback before they return.
const SYNC_CALLBACKS = new Set(['map', 'forEach', 'filter', 'some', 'every', 'find', 'findIndex', 'reduce', 'flatMap', 'sort', 'from'])
const isFunction = (n: Node | null | undefined): n is ESTree.FunctionExpression | ESTree.ArrowFunctionExpression =>
  !!n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression')

// Each top-level statement of the IIFE runs in order while the script loads.
// What one reads at that moment (outside functions it only defines, and
// inside the functions it calls, transitively) has to be set by an earlier
// statement. Functions are hoisted, so only their bodies count.
function checkLoadOrder(bundle: string) {
  const { ast, scopes } = parse(bundle, 'script')
  const first = ast.body[0]
  if (first?.type !== 'ExpressionStatement' || first.expression.type !== 'CallExpression' || !isFunction(first.expression.callee)) {
    throw new Error('unexpected bundle shape')
  }
  const iife = first.expression.callee
  const body = (iife.body as ESTree.BlockStatement).body
  const top = scopes.acquire(iife)
  if (!top) throw new Error('no scope for the IIFE')

  // Identifier -> the top-level variable it names.
  const refs = new Map<Node | eslintScope.Reference["identifier"], Variable>()
  for (const scope of scopes.scopes) {
    for (const r of scope.references) if (r.resolved && r.resolved.scope === top) refs.set(r.identifier, r.resolved)
  }
  // Variable -> index of the statement that sets it; hoisted functions -> their node.
  const setAt = new Map<Variable, number>()
  const functions = new Map<Variable, ESTree.Function>()
  body.forEach((stmt, i) => {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) {
      const v = top.set.get(stmt.id.name)
      if (v) functions.set(v, stmt)
    }
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) {
        for (const v of scopes.getDeclaredVariables(d)) {
          setAt.set(v, i)
          // const f = () => …, or keepNames' __name(() => …, "f"): callable like a function.
          let init = d.init
          if (init?.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === '__name') init = init.arguments[0] as ESTree.Expression
          if (isFunction(init)) functions.set(v, init)
        }
      }
    }
  })

  // The module each statement came from, by esbuild's "// src/…" comments.
  const marks = (ast.comments || []).filter(c => c.type === 'Line' && /^ src\//.test(c.value))
  const moduleOf = (node: Node) => {
    let name = '?'
    for (const c of marks) if (c.range && node.range && c.range[0] < node.range[0]) name = c.value.trim()
    return name
  }

  // Collects into `into` what running `node` reads; `seen` keeps each called
  // function to one visit per statement (recursion, shared helpers).
  const walk = (node: Node, into: Set<Variable>, seen: Set<ESTree.Function>) => {
    const visit = (n: unknown): void => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) { n.forEach(visit); return }
      const node = n as Node
      if (typeof node.type !== 'string') return
      if (node.type === 'FunctionDeclaration' || isFunction(node)) return   // defined here, not run
      if (node.type === 'Identifier') {
        const v = refs.get(node)
        if (v) into.add(v)
        return
      }
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        const callee = node.callee
        if (isFunction(callee)) follow(callee)   // an IIFE runs now
        else visit(callee)
        if (callee.type === 'Identifier') {
          const v = refs.get(callee)
          const fn = v && functions.get(v)
          if (fn) follow(fn)
        }
        const sync = callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && SYNC_CALLBACKS.has(callee.property.name)
        for (const a of node.arguments) {
          if (sync && isFunction(a as Node)) follow(a as ESTree.Function)
          else visit(a)
        }
        return
      }
      for (const key of Object.keys(node)) {
        if (key === 'parent' || key === 'loc' || key === 'range') continue
        visit((node as unknown as Record<string, unknown>)[key])
      }
    }
    const follow = (fn: ESTree.Function) => {
      if (seen.has(fn)) return
      seen.add(fn)
      visit(fn.body)
    }
    visit(node)
  }

  const problems: string[] = []
  body.forEach((stmt, i) => {
    if (stmt.type === 'FunctionDeclaration') return
    const read = new Set<Variable>()
    walk(stmt, read, new Set())
    for (const v of read) {
      const at = setAt.get(v)
      if (at !== undefined && at > i) {
        const decl = body[at]
        problems.push(`${moduleOf(stmt)} (line ${stmt.loc?.start.line}) reads ${v.name} while loading, before ${decl ? moduleOf(decl) : '?'} sets it`)
      }
    }
  })
  if (problems.length) throw new Error(`load order:\n  ${problems.join('\n  ')}\nImport the module that sets it, or move the read into a function called later (main.ts).`)
}

// The version lives in two places, @version and VERSION: they move together.
function checkVersion(header: string, bundle: string) {
  const meta = (header.match(/^\/\/ @version\s+(\S+)/m) || [])[1]
  const code = (bundle.match(/\bvar VERSION = "([^"]+)"/) || [])[1]
  if (!meta || meta !== code) throw new Error(`@version (${meta}) and VERSION (${code}) differ`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const check = process.argv.includes('--check')
  try {
    const code = await build()
    if (check) {
      const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
      if (committed !== code) {
        console.error('image-board-helper.user.js is not what src/ builds: run npm run build (and edit src/, never the generated file)')
        process.exit(1)
      }
      console.log('build: image-board-helper.user.js matches src/')
    } else {
      fs.writeFileSync(OUT, code)
      console.log(`build: image-board-helper.user.js (${code.split('\n').length} lines)`)
    }
  } catch (e) {
    console.error(`build failed: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
}
