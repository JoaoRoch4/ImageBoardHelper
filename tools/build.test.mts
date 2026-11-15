// Tests of the build's own checks (npm run -s test:tools): each takes a
// small bundle made here from modules written to a temporary folder.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as esbuild from 'esbuild'
import { checkLoadOrder, checkNames } from './build.mts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibh-build-'))
after(() => fs.rmSync(dir, { recursive: true, force: true }))

// The modules as files, then the bundle as the build makes it.
function bundle(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(dir, 'case-'))
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text)
  const r = esbuild.buildSync({
    entryPoints: [path.join(root, 'main.js')], bundle: true, write: false, metafile: true,
    format: 'iife', keepNames: true, treeShaking: false, logLevel: 'silent',
  })
  const code = r.outputFiles[0]?.text ?? ''
  return { code, inputs: Object.keys(r.metafile.inputs).map(f => path.resolve(f)) }
}

// main imports a, a imports b, b imports a back: b's body runs first.
const cycle = (b: string) => ({
  'main.js': "import { later } from './a.js'\nlater()\n",
  'a.js': "import { fromB } from './b.js'\nexport const COLOR = 'red'\nexport function later() { return fromB }\n",
  'b.js': `import { COLOR } from './a.js'\n${b}\n`,
})

test('load order: a value read while loading, before its module ran, is refused', () => {
  const { code } = bundle(cycle('function css() { return `color: ${COLOR}` }\nexport const fromB = css()'))
  assert.throws(() => checkLoadOrder(code), /reads COLOR while loading/)
})

test('load order: a read inside a function that only runs later is fine', () => {
  const { code } = bundle(cycle('export const fromB = () => `color: ${COLOR}`'))
  assert.doesNotThrow(() => checkLoadOrder(code))
})

test('load order: a callback that an array method runs at once counts', () => {
  const { code } = bundle(cycle('export const fromB = [1].map(() => COLOR)'))
  assert.throws(() => checkLoadOrder(code), /reads COLOR/)
})

test('names: a local named like another module\'s top-level name is refused (esbuild renames it)', () => {
  const { code, inputs } = bundle({
    'main.js': "import { touch } from './x.js'\nimport { f } from './y.js'\ntouch(); f({})\n",
    'x.js': 'export const touch = () => 1\n',
    'y.js': 'export function f(ev) { const touch = ev; return touch }\n',
  })
  assert.match(code, /touch2/)
  assert.throws(() => checkNames(code, inputs), /renamed or new: touch2/)
})

test('names: distinct names pass', () => {
  const { code, inputs } = bundle({
    'main.js': "import { touch } from './x.js'\nimport { f } from './y.js'\ntouch(); f({})\n",
    'x.js': 'export const touch = () => 1\n',
    'y.js': 'export function f(ev) { const finger = ev; return finger }\n',
  })
  assert.doesNotThrow(() => checkNames(code, inputs))
})
