// The rub's target (src/scrub/rub-target.ts), with the cases of the app's
// tests/tst_previewrub.cpp, in seconds: a rule both sides have is the same
// rule, with the same cases. A 300 px span, a slide that starts at 110:
// 190 px to the end, 110 px to the start.
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Loaded at run time: src/ isn't part of the tools' program (tsc -p tools
// would read the module as CommonJS), and Node strips its types itself.
const target = new URL('../src/scrub/rub-target.ts', import.meta.url).href
const { rubTarget } = await import(target) as {
  rubTarget: (from: number, t0: number, x: number, width: number, duration: number) => number
}

test('the edges are the ends', () => {
  // Half of the 190 px: half of the 50 s left.
  assert.equal(rubTarget(110, 10, 205, 300, 60), 35)
  // The right edge: the end, short of the very last frame.
  assert.equal(rubTarget(110, 10, 300, 300, 60), 59.95)
  // Half of the 110 px: half of the 10 s before.
  assert.equal(rubTarget(110, 10, 55, 300, 60), 5)
  // The left edge: the start.
  assert.equal(rubTarget(110, 10, 0, 300, 60), 0)
})

test('the sensitivity follows the duration (no 2 min cap)', () => {
  assert.equal(rubTarget(110, 0, 205, 300, 600), 300)
})

test('the target stays in the video', () => {
  assert.equal(rubTarget(90, 5, -500, 300, 60), 0)
  assert.equal(rubTarget(90, 5, 2000, 300, 60), 59.95)
})

test('a slide from where the last rested', () => {
  // From 220 at 31 s: 80 px to the end, half of them is half of the 29 s.
  assert.equal(rubTarget(220, 31, 260, 300, 60), 45.5)
})

test('a slide that starts at an edge stays put toward it', () => {
  assert.equal(rubTarget(300, 20, 310, 300, 60), 20)
  assert.equal(rubTarget(0, 20, -10, 300, 60), 20)
})
