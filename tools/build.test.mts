// Tests of the build's own checks (npm run -s test:tools): each joins small
// modules written here to a temporary folder, as the build joins src/.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { bundle as join, checkLoadOrder, eraseTypes } from './build.mts'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibh-build-'))
after(() => fs.rmSync(dir, { recursive: true, force: true }))

// The modules as files, then the script as the build makes it.
function bundle(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(dir, 'case-'))
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text)
  return join(root, 'main.js')
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

test('load order: a Promise executor and a replace callback run at once too', () => {
  assert.throws(() => checkLoadOrder(bundle(cycle('export const fromB = new Promise(ok => ok(COLOR))')).code), /reads COLOR/)
  assert.throws(() => checkLoadOrder(bundle(cycle("export const fromB = 'x'.replace('x', () => COLOR)")).code), /reads COLOR/)
})

test('order: each module after the ones it imports, as ES modules run', () => {
  const { modules } = bundle(cycle('export const fromB = 1'))
  assert.deepEqual(modules, ['src/b.js', 'src/a.js', 'src/main.js'])
})

test('names: two modules declaring one top-level name are refused', () => {
  assert.throws(() => bundle({
    'main.js': "import { touch } from './x.js'\nimport { f } from './y.js'\ntouch(); f()\n",
    'x.js': 'export const touch = () => 1\n',
    'y.js': 'const touch = 2\nexport function f() { return touch }\n',
  }), /touch is declared at the top of both src\/x.js and src\/y.js/)
})

test('names: a global that another module declares is refused', () => {
  assert.throws(() => bundle({
    'main.js': "import { open } from './x.js'\nimport { f } from './y.js'\nopen(); f()\n",
    'x.js': 'export const open = () => 1\n',
    'y.js': 'export function f() { return open }\n',   // window.open, not x's
  }), /src\/y.js \(line 1\) uses the global open, which src\/x.js declares/)
})

test('names: a local named like another module\'s top-level name is fine', () => {
  const { code } = bundle({
    'main.js': "import { touch } from './x.js'\nimport { f } from './y.js'\ntouch(); f({})\n",
    'x.js': 'export const touch = () => 1\n',
    'y.js': 'export function f(ev) { const touch = ev; return touch }\n',
  })
  assert.match(code, /const touch = ev/)
})

test('join: no imports, no export keywords, the comments kept', () => {
  const { code } = bundle({
    'main.js': "import { a } from './x.js'\n\n// runs a\na()\n",
    'x.js': '// says one\nexport function a() { return 1 }\n',
  })
  assert.equal(code, '(() => {\n  "use strict";\n\n  // src/x.js\n  // says one\n  function a() { return 1 }\n\n  // src/main.js\n  // runs a\n  a()\n})();\n')
})

test('join: a line inside a template string keeps its text', () => {
  const { code } = bundle({ 'main.js': 'const css = `\na {\n  color: red\n}`\n' })
  assert.match(code, /  const css = `\na \{\n  color: red\n\}`/)
})

test('types: erased in place, the layout and the comments kept', () => {
  assert.equal(
    eraseTypes('const a: number = 1   // one\nfunction f(x: string, y?: number): void {\n  return (x as unknown as string)\n}\n', 't.ts'),
    'const a = 1   // one\nfunction f(x, y) {\n  return (x)\n}\n')
})

test('types: a line of types only goes, with the blank line it leaves doubled', () => {
  assert.equal(eraseTypes("a()\n\ntype T = { a: 1 }\n\nb()\n", 't.ts'), 'a()\n\nb()\n')
  assert.equal(eraseTypes("import type { T } from './t'\nimport { b } from './b'\n", 't.ts'), "import { b } from './b'\n")
})
