// Tests for tools/rish.mts: node --test tools/rish.test.mts
// The fake rish is a plain shell: the session protocol is shell commands on
// stdin, each followed by a marker line carrying its exit code.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rish-test-'))
const fake = path.join(dir, 'rish')
fs.writeFileSync(fake, '#!/bin/sh\nexec sh\n', { mode: 0o755 })
process.env.RISH = fake
const { rish, stopRish, findRish } = await import('./rish.mts')   // after RISH is set

after(() => { stopRish(); fs.rmSync(dir, { recursive: true, force: true }) })

test('finds the rish named by $RISH', () => assert.equal(findRish(), fake))

test('runs a command', async () => assert.deepEqual(await rish('echo hi'), { out: 'hi', code: 0 }))

test('carries the exit code', async () => assert.equal((await rish('false')).code, 1))

test('merges stderr in order', async () => assert.equal((await rish('echo a; echo b >&2; echo c')).out, 'a\nb\nc'))

test('queues concurrent commands', async () => {
  const both = await Promise.all([rish('sleep 0.2; echo 1'), rish('echo 2')])
  assert.deepEqual(both.map(r => r.out), ['1', '2'])
})

test('a stuck command times out and the next one gets a new session', async () => {
  await assert.rejects(rish('sleep 5', 300))
  assert.equal((await rish('echo back')).out, 'back')
})

test('a session that dies is replaced', async () => {   // the fake rish exits: Shizuku went down
  await rish('kill -9 $$').catch(() => {})
  assert.equal((await rish('echo again')).out, 'again')
})
