#!/usr/bin/env node
// Builds image-board-helper.user.js from src/ (npm run build): each module
// with its types erased, joined into one IIFE in the order ES modules run,
// under the metadata block of src/header.txt. Nothing else is rewritten:
// comments, names, quotes and layout are the source's, so the generated
// file reads like src/. It stays committed, since the deploy installs it by
// its commit-pinned raw link.
//
//   node tools/build.mts            writes image-board-helper.user.js
//   node tools/build.mts --check    fails when the committed file is not what src/ builds
//
// Joining modules into one script is only safe because every build checks:
// - types erased in place: Node's stripTypeScriptTypes blanks them with
//   spaces and the blanks go; the result must keep the blanked text's
//   tokens and comments, so no code changed and none got glued together;
// - one scope for all: no two modules declare the same top-level name, and
//   no module uses a global (open, name, …) that another module declares;
// - load order: what a statement reads while the script loads has to be set
//   by an earlier one (a top-level const read too early would throw).

import fs from 'node:fs'
import path from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as espree from 'espree'
import * as eslintScope from 'eslint-scope'
import type * as ESTree from 'estree'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(REPO, 'src')
const OUT = path.join(REPO, 'image-board-helper.user.js')

type Variable = eslintScope.Variable
type Node = ESTree.Node

function parse(code: string, sourceType: 'script' | 'module') {
  const ast = espree.parse(code, { ecmaVersion: 2022, sourceType, range: true, loc: true, comment: true }) as ESTree.Program
  const scopes = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType })
  return { ast, scopes }
}

const span = (n: Node): [number, number] => {
  if (!n.range) throw new Error('a node without its range')
  return n.range
}

// What the parser reads: each token, and each comment unless left out,
// without their positions.
function shape(code: string, sourceType: 'script' | 'module', comments = true): string[] {
  const tokens = espree.tokenize(code, { ecmaVersion: 2022, sourceType, comment: true })
  const words = tokens.map(t => `${t.type} ${String(t.value)}`)
  return comments ? [...words, ...(tokens.comments || []).map(c => `${c.type} ${c.value}`)] : [...words, `${(tokens.comments || []).length} comments`]
}

function sameShape(before: string, after: string, sourceType: 'script' | 'module', what: string, comments = true) {
  const a = shape(before, sourceType, comments)
  const b = shape(after, sourceType, comments)
  const i = a.findIndex((t, k) => t !== b[k])
  if (i >= 0 || a.length !== b.length) {
    const at = i >= 0 ? i : Math.min(a.length, b.length)
    throw new Error(`${what} changed the code: "${a[at] ?? '(end)'}" became "${b[at] ?? '(end)'}"`)
  }
}

// Node's stripTypeScriptTypes is experimental in Node 24 and says so on
// stderr at its first call; the build's own output stays clean.
function quietly<T>(run: () => T): T {
  const emit = process.emitWarning
  process.emitWarning = () => {}
  try { return run() } finally { process.emitWarning = emit }
}

// One line with its types blanked (`blanked`, from `ts`): each run of erased
// text goes, and a blank left before `)`, `,`, `;`, `]`, `}` or a space goes
// with it; at the start of a line the indentation stays.
function squeeze(ts: string, blanked: string): string {
  let out = ''
  let i = 0
  while (i < blanked.length) {
    if (ts[i] === blanked[i]) { out += blanked[i]; i++; continue }
    let end = i   // the run: erased characters and the blanks between them
    for (let k = i; k < blanked.length && (ts[k] !== blanked[k] || blanked[k] === ' ' || blanked[k] === '\t'); k++) {
      if (ts[k] !== blanked[k]) end = k + 1
    }
    if (!out.trim()) {
      while (blanked[end] === ' ' || blanked[end] === '\t') end++
    } else if (/[ \t]$/.test(out) && (end >= blanked.length || /[\s),;\]}]/.test(blanked[end] as string))) {
      out = out.replace(/[ \t]+$/, '')
    }
    i = end
  }
  return out.replace(/[ \t]+$/, '')
}

// TypeScript to JavaScript, with the types erased where they stand: Node
// blanks them with spaces, keeping every other character in place, and the
// blanks go (squeeze). A line that held only types goes whole, and so does
// a blank line it leaves doubled. The comments and the layout are the
// source's, and the result must parse to the very tokens and comments of
// the blanked text.
export function eraseTypes(ts: string, label: string): string {
  const blanked = quietly(() => stripTypeScriptTypes(ts, { mode: 'strip' }))
  const tsLines = ts.split('\n')
  const jsLines = blanked.split('\n')
  if (blanked.length !== ts.length || tsLines.length !== jsLines.length) throw new Error(`${label}: erasing the types moved code`)
  const out: string[] = []
  let gap = false   // lines of types only left out since the last line kept
  tsLines.forEach((t, n) => {
    const j = jsLines[n] as string
    if (t !== j && !j.trim()) { gap = true; return }
    const line = t === j ? j : squeeze(t, j)
    if (gap && !line.trim() && !(out[out.length - 1] ?? '').trim()) { gap = false; return }
    gap = false
    out.push(line)
  })
  const js = out.join('\n')
  sameShape(blanked, js, 'module', `${label}: erasing the types`)
  return js
}

type Module = { file: string, label: string, code: string, ast: ESTree.Program, scope: eslintScope.Scope }

function load(file: string, label: string): Module {
  const text = fs.readFileSync(file, 'utf8')
  const code = file.endsWith('.ts') ? eraseTypes(text, label) : text
  const { ast, scopes } = parse(code, 'module')
  const scope = scopes.globalScope?.childScopes[0]
  if (!scope || scope.type !== 'module') throw new Error(`${label}: no module scope`)
  return { file, label, code, ast, scope }
}

// The file an import names: as written, or with .ts or .js added.
function resolve(from: Module, spec: string): string {
  if (!spec.startsWith('.')) throw new Error(`${from.label} imports ${spec}: only modules of src/ can be joined`)
  const base = path.resolve(path.dirname(from.file), spec)
  const file = [base, `${base}.ts`, `${base}.js`].find(f => fs.existsSync(f) && fs.statSync(f).isFile())
  if (!file) throw new Error(`${from.label} imports ${spec}, which does not exist`)
  return file
}

// The modules in the order ES modules run them: depth first from the entry,
// each one after the modules it imports, in the order it imports them.
function modules(srcDir: string, entry: string): Module[] {
  const order: Module[] = []
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const m = load(file, `src/${path.relative(srcDir, file).split(path.sep).join('/')}`)
    for (const s of m.ast.body) if (s.type === 'ImportDeclaration') visit(resolve(m, String(s.source.value)))
    order.push(m)
  }
  visit(path.join(srcDir, entry))
  return order
}

// A module's code in the script: no imports (every name is in scope) and
// no `export` before its declarations.
function body(m: Module): string {
  const cuts: [number, number][] = []
  for (const s of m.ast.body) {
    if (s.type === 'ImportDeclaration') {
      let [a, b] = span(s)
      const lineStart = m.code.lastIndexOf('\n', a - 1) + 1
      const lineEnd = m.code.indexOf('\n', b)
      if (!m.code.slice(lineStart, a).trim() && !m.code.slice(b, lineEnd < 0 ? undefined : lineEnd).trim()) {
        a = lineStart
        b = lineEnd < 0 ? m.code.length : lineEnd + 1
      }
      cuts.push([a, b])
    } else if (s.type === 'ExportNamedDeclaration') {
      if (!s.declaration || s.source) throw new Error(`${m.label}: export the declaration itself, not a list`)
      cuts.push([span(s)[0], span(s.declaration)[0]])
    } else if (s.type === 'ExportDefaultDeclaration' || s.type === 'ExportAllDeclaration') {
      throw new Error(`${m.label}: export default and export * cannot be joined; export named declarations`)
    }
  }
  let code = m.code
  for (const [a, b] of cuts.reverse()) code = code.slice(0, a) + code.slice(b)
  return code.replace(/^(?:[ \t]*\n)+/, '').replace(/\s*$/, '\n')
}

// One scope holds every module's top-level names once they are joined: two
// modules declaring one name would clash, and a module reaching a global
// (open, name, …) would get another module's variable of that name instead.
function checkScope(mods: Module[]) {
  const owner = new Map<string, string>()
  const problems: string[] = []
  for (const m of mods) {
    for (const v of m.scope.variables) {
      if (v.defs.some(d => d.type === 'ImportBinding')) continue
      const other = owner.get(v.name)
      if (other) problems.push(`${v.name} is declared at the top of both ${other} and ${m.label}: rename one`)
      else owner.set(v.name, m.label)
    }
  }
  for (const m of mods) {
    for (const r of m.scope.through) {
      const other = owner.get(r.identifier.name)
      if (other && other !== m.label) {
        problems.push(`${m.label} (line ${r.identifier.loc?.start.line}) uses the global ${r.identifier.name}, which ${other} declares: import it, or rename one`)
      }
    }
  }
  if (problems.length) throw new Error(`names:\n  ${problems.join('\n  ')}`)
}

// Two spaces before each line of the IIFE's body, except where a line
// starts inside a template string, whose text would change.
function indent(code: string): string {
  const tokens = espree.tokenize(code, { ecmaVersion: 2022, sourceType: 'script', range: true })
  const texts = tokens.filter(t => t.type === 'Template' && t.range).map(t => t.range as [number, number])
  let pos = 0
  const lines = code.split('\n').map(line => {
    const start = pos
    pos += line.length + 1
    return line && !texts.some(([a, b]) => a < start && start < b) ? `  ${line}` : line
  })
  return lines.join('\n')
}

/** The modules of `srcDir` joined into one IIFE, from `entry`. */
export function bundle(srcDir: string, entry = 'main.ts'): { code: string, modules: string[] } {
  const mods = modules(srcDir, entry)
  checkScope(mods)
  const inner = `"use strict";\n\n${mods.map(m => `// ${m.label}\n${body(m)}`).join('\n')}`
  const indented = indent(inner)
  sameShape(inner, indented, 'script', 'indenting', false)
  return { code: `(() => {\n${indented}})();\n`, modules: mods.map(m => m.label) }
}

/** The userscript as src/ builds it. */
export function build(): string {
  const { code } = bundle(SRC)
  checkLoadOrder(code)
  const header = fs.readFileSync(path.join(SRC, 'header.txt'), 'utf8').trimEnd()
  checkVersion(header, code)
  return `${header}\n\n${code}`
}

// Methods that call their callback before they return (an array's, Array.from,
// a string's replace); new Promise runs its executor at once too.
const SYNC_CALLBACKS = new Set(['map', 'forEach', 'filter', 'some', 'every', 'find', 'findIndex', 'reduce', 'flatMap', 'sort', 'from', 'replace', 'replaceAll'])
const isFunction = (n: Node | null | undefined): n is ESTree.FunctionExpression | ESTree.ArrowFunctionExpression =>
  !!n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression')

// Each top-level statement of the IIFE runs in order while the script loads.
// What one reads at that moment (outside functions it only defines, and
// inside the functions it calls, transitively) has to be set by an earlier
// statement. Functions are hoisted, so only their bodies count.
export function checkLoadOrder(bundle: string) {
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
          // const f = () => …: callable like a function.
          if (isFunction(d.init)) functions.set(v, d.init)
        }
      }
    }
  })

  // The module each statement came from, by the "// src/…" line above it.
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
        const sync = (callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && SYNC_CALLBACKS.has(callee.property.name)) ||
          (node.type === 'NewExpression' && callee.type === 'Identifier' && callee.name === 'Promise')
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
  const code = (bundle.match(/\b(?:const|let|var) VERSION = (['"])([^'"]+)\1/) || [])[2]
  if (!meta || meta !== code) throw new Error(`@version (${meta}) and VERSION (${code}) differ`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const check = process.argv.includes('--check')
  try {
    const code = build()
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
