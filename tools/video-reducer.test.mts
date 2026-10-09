// Tests for tools/video-reducer.mts: node --test tools/video-reducer.test.mts
// Real phone server processes, with tools/fixtures/fake-vreduce.mts in place
// of VideoReducer's vreduce; its behaviour comes from the URL (…/slow/…,
// …/fail-input/…). Three servers: the main one; a second with a 1 MB cache
// already holding files and a 500 ms interest time; a third that is stopped.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import * as crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

const SERVER = path.join(import.meta.dirname, 'phone-server.mts')
const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-vreduce.mts')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-reducer-test-'))
const vreduce = path.join(dir, 'vreduce')
fs.writeFileSync(vreduce, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 })
const hash = (url: string) => crypto.createHash('sha256').update(url).digest('hex')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const freePort = () => new Promise<number>(resolve => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as net.AddressInfo
    probe.close(() => resolve(port))
  })
})

const portOpen = (port: number) => new Promise<boolean>(resolve => {
  const sock = net.connect(port, '127.0.0.1')
  sock.on('connect', () => { sock.destroy(); resolve(true) })
  sock.on('error', () => resolve(false))
})

interface Server { port: number; token: string; cache: string; log: string; child: ChildProcess }
const servers: ChildProcess[] = []

// A server with its own folder, cache and fake-vreduce log.
async function startServer(name: string, extra: Record<string, string> = {}, seed?: (cache: string) => void): Promise<Server> {
  const home = path.join(dir, name)
  const cache = path.join(home, 'cache')
  fs.mkdirSync(cache, { recursive: true })
  if (seed) seed(cache)
  const port = await freePort()
  const log = path.join(home, 'fake.log')
  const child = spawn(process.execPath, [SERVER, 'serve'], {
    stdio: 'ignore',
    env: { ...process.env, IBH_SERVER_DIR: home, IBH_SERVER_PORT: String(port), IBH_SERVER_MEDIA: path.join(home, 'media'), IBH_TERMUX_BIN: `${home}/`,
      VREDUCE: vreduce, IBH_VREDUCE_CACHE: cache, FAKE_VREDUCE_LOG: log, IBH_VIDEO_INTEREST_MS: '5000', ...extra },
  })
  servers.push(child)
  for (let i = 0; i < 100 && !await portOpen(port); i++) await sleep(100)
  return { port, token: fs.readFileSync(path.join(home, 'token'), 'utf8').trim(), cache, log, child }
}

async function req(s: Server, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const post = body !== undefined
  const res = await fetch(`http://127.0.0.1:${s.port}/${route}`, {
    method: post ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${s.token}`, ...(post ? { 'content-type': 'application/json' } : {}) },
    ...(post ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json() }
}

const reduce = (s: Server, url: string, extra: Record<string, unknown> = {}) => req(s, 'video/reduce', { url, referer: 'https://rule34.xxx/', ...extra })
const status = async (s: Server, id: string) => (await req(s, `video/${id}`)).json

// Polls every 50 ms (which also keeps the job wanted) until `ok` holds; every answer goes to `seen`.
async function waitFor(s: Server, id: string, ok: (st: any) => boolean, ms = 8000, seen: any[] = []) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const st = await status(s, id)
    seen.push(st)
    if (ok(st)) return st
  }
  throw new Error(`timed out; last ${JSON.stringify(seen.at(-1))}`)
}

let main: Server
let small: Server   // 1 MB cache, seeded; 500 ms interest
const MB = 1024 * 1024

before(async () => {
  main = await startServer('main')
  small = await startServer('small', { IBH_VREDUCE_CACHE_MB: '1', IBH_VIDEO_INTEREST_MS: '500' }, cache => {
    fs.writeFileSync(path.join(cache, 'old.mp4'), Buffer.alloc(MB))
    fs.writeFileSync(path.join(cache, 'newer.mp4'), Buffer.alloc(MB))
    const t = Date.now() / 1000
    fs.utimesSync(path.join(cache, 'old.mp4'), t - 3600, t - 3600)
    fs.utimesSync(path.join(cache, 'newer.mp4'), t - 60, t - 60)
    fs.writeFileSync(path.join(cache, 'stale.part.mp4'), 'x')
  })
})

after(() => {
  for (const s of servers) s.kill()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('reduce starts a job and status follows it to done', async () => {
  const url = 'https://api-cdn.rule34.xxx/images/1/done.mp4'
  const { json } = await reduce(main, url)
  assert.equal(json.ok, true)
  assert.equal(json.id, hash(url).slice(0, 16))
  assert.match(json.stream, /^\/v\/[0-9a-f]{64}\.mp4$/)
  const seen: any[] = []
  const done = await waitFor(main, json.id, st => st.state === 'done', 8000, seen)
  assert.equal(done.playable, true)
  assert.ok(seen.some(st => st.state === 'running' && st.playable), 'playable before the end (pos ≥ 1.2 × dur × (1 − speed) + 2)')
  assert.ok(fs.existsSync(path.join(main.cache, `${hash(url)}.mp4`)))
  assert.ok(!fs.existsSync(path.join(main.cache, `${hash(url)}.part.mp4`)))
})

test('the same url gives the same id', async () => {
  const url = 'https://api-cdn.rule34.xxx/slow/same.mp4'
  const a = (await reduce(main, url)).json
  const b = (await reduce(main, url)).json
  assert.match(a.id, /^[0-9a-f]{16}$/)
  assert.equal(a.id, b.id)
  assert.equal(a.stream, b.stream)
  await req(main, 'video/cancel', { id: a.id })
})

test('start: false finds nothing, then finds the cached file', async () => {
  const url = 'https://api-cdn.rule34.xxx/images/1/lookup.mp4'
  assert.deepEqual((await reduce(main, url, { start: false })).json, { ok: true, state: 'none' })
  const { json } = await reduce(main, url)
  await waitFor(main, json.id, st => st.state === 'done')
  const again = (await reduce(main, url, { start: false })).json
  assert.equal(again.state, 'done')
  assert.equal(again.id, json.id)
})

test('a non-booru url is refused: 400', async () => {
  assert.equal((await reduce(main, 'https://example.com/a.mp4')).status, 400)
  assert.equal((await reduce(main, 'http://rule34.xxx/a.mp4')).status, 400)
  assert.equal((await reduce(main, 'https://rule34.xxx.example.com/a.mp4')).status, 400)
})

test('one job at a time; a newer open cancels the older open', async () => {
  const a = (await reduce(main, 'https://api-cdn.rule34.xxx/slow/a.mp4')).json
  await waitFor(main, a.id, st => st.state === 'running')
  const b = (await reduce(main, 'https://api-cdn.rule34.xxx/slow/b.mp4')).json
  assert.equal((await status(main, a.id)).state, 'cancelled')
  await waitFor(main, b.id, st => st.state === 'running')
  for (let i = 0; i < 40 && fs.existsSync(path.join(main.cache, `${hash('https://api-cdn.rule34.xxx/slow/a.mp4')}.part.mp4`)); i++) await sleep(50)
  assert.ok(!fs.existsSync(path.join(main.cache, `${hash('https://api-cdn.rule34.xxx/slow/a.mp4')}.part.mp4`)), 'the cancelled job left its partial file')
  await req(main, 'video/cancel', { id: b.id })
})

test('next waits behind open; asking again as open promotes it without a restart', async () => {
  const open = (await reduce(main, 'https://api-cdn.rule34.xxx/slow/open.mp4')).json
  await waitFor(main, open.id, st => st.state === 'running')
  const next = (await reduce(main, 'https://api-cdn.rule34.xxx/slow/next.mp4', { priority: 'next' })).json
  assert.equal((await status(main, next.id)).state, 'queued')
  await req(main, 'video/cancel', { id: open.id })
  const running = await waitFor(main, next.id, st => st.state === 'running' && st.pos >= 1, 5000)
  await reduce(main, 'https://api-cdn.rule34.xxx/slow/next.mp4', { priority: 'open' })
  const later = await waitFor(main, next.id, st => st.pos > running.pos, 5000)
  assert.equal(later.state, 'running')
  await req(main, 'video/cancel', { id: next.id })
})

test('a failed vreduce: failed with stage and http', async () => {
  const url = 'https://api-cdn.rule34.xxx/fail-input/f.mp4'
  const { json } = await reduce(main, url)
  const st = await waitFor(main, json.id, s => s.state === 'failed')
  assert.equal(st.stage, 'input')
  assert.equal(st.http, 403)
  assert.ok(!fs.existsSync(path.join(main.cache, `${hash(url)}.part.mp4`)))
})

test('cancel stops the process', async () => {
  const url = 'https://api-cdn.rule34.xxx/slow/cancel.mp4'
  const { json } = await reduce(main, url)
  await waitFor(main, json.id, st => st.pos >= 1)   // vreduce is up (it reported), so its SIGTERM handler is in place
  await req(main, 'video/cancel', { id: json.id })
  assert.equal((await status(main, json.id)).state, 'cancelled')
  for (let i = 0; i < 20 && !fs.readFileSync(main.log, 'utf8').includes(`SIGTERM ${url}`); i++) await sleep(50)
  assert.ok(fs.readFileSync(main.log, 'utf8').includes(`SIGTERM ${url}`), 'vreduce got SIGTERM')
})

test('.part files are deleted when the server starts', () => assert.ok(!fs.existsSync(path.join(small.cache, 'stale.part.mp4'))))

test('the cache is trimmed by last use before a job starts', async () => {
  const { json } = await reduce(small, 'https://api-cdn.rule34.xxx/images/1/trim.mp4')
  await waitFor(small, json.id, st => st.state !== 'queued')
  assert.ok(!fs.existsSync(path.join(small.cache, 'old.mp4')), 'the least recently used file went')
  assert.ok(fs.existsSync(path.join(small.cache, 'newer.mp4')))
})

test('a job not polled for the interest time is cancelled', async () => {
  const { json } = await reduce(small, 'https://api-cdn.rule34.xxx/slow/interest.mp4')
  await sleep(1500)
  assert.equal((await status(small, json.id)).state, 'cancelled')
})

test('stopping the server stops vreduce', async () => {
  const s = await startServer('stopped')
  const url = 'https://api-cdn.rule34.xxx/slow/stop.mp4'
  const { json } = await reduce(s, url)
  await waitFor(s, json.id, st => st.pos >= 1)
  s.child.kill('SIGTERM')
  for (let i = 0; i < 40 && !(fs.existsSync(s.log) && fs.readFileSync(s.log, 'utf8').includes(`SIGTERM ${url}`)); i++) await sleep(50)
  assert.ok(fs.readFileSync(s.log, 'utf8').includes(`SIGTERM ${url}`))
})

// ─── heat and battery, save, batch, video.log ───

let heat: Server
const battery = (temperature: number, percentage = 80, plugged = 'UNPLUGGED') =>
  fs.writeFileSync(path.join(dir, 'heat', 'battery.json'), JSON.stringify({ temperature, percentage, plugged, status: 'DISCHARGING' }))
const BATTERY_WAIT = 500   // more than IBH_VIDEO_BATTERY_MS below

test('above 45 °C nothing runs and status says hot', async () => {
  heat = await startServer('heat', { IBH_VIDEO_BATTERY_MS: '200', IBH_VIDEO_INTEREST_MS: '800' }, cache => {
    const home = path.dirname(cache)
    fs.writeFileSync(path.join(home, 'battery.json'), JSON.stringify({ temperature: 30, percentage: 80, plugged: 'UNPLUGGED' }))
    fs.writeFileSync(path.join(home, 'termux-battery-status'), `#!/bin/sh\ncat "${home}/battery.json"\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(home, 'termux-notification'), `#!/bin/sh\necho "termux-notification $*" >> "${home}/calls.log"\n`, { mode: 0o755 })
    fs.mkdirSync(path.join(home, 'media'))
  })
  battery(46)
  await sleep(BATTERY_WAIT)
  const { json } = await reduce(heat, 'https://api-cdn.rule34.xxx/slow/hot.mp4')
  for (let i = 0; i < 10; i++) { const st = await status(heat, json.id); assert.equal(st.state, 'queued'); assert.equal(st.hot, true); await sleep(100) }
  battery(30)
  await waitFor(heat, json.id, st => st.state === 'running' && !st.hot)
  await req(heat, 'video/cancel', { id: json.id })
})

// SIGSTOP stops nothing under proot, which traces every process and resumes
// it; the server runs natively in Termux, where it does. Measured here once.
const sigstopWorks = await new Promise<boolean>(resolve => {
  const child = spawn(process.execPath, ['-e', 'let n = 0; setInterval(() => console.log(++n), 50)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let count = 0
  child.stdout.on('data', d => { count = Number(String(d).trim().split('\n').at(-1)) })
  setTimeout(() => {
    process.kill(-child.pid!, 'SIGSTOP')
    setTimeout(() => {
      const at = count
      setTimeout(() => { process.kill(-child.pid!, 'SIGKILL'); resolve(count === at) }, 400)
    }, 100)
  }, 600)
})

test('a running job pauses above 45 °C and goes on below', { skip: !sigstopWorks && 'SIGSTOP does not stop processes here (proot)' }, async () => {
  const { json } = await reduce(heat, 'https://api-cdn.rule34.xxx/slow/pause.mp4')
  await waitFor(heat, json.id, st => st.pos >= 1)
  battery(46)
  for (let end = Date.now() + BATTERY_WAIT + 1200; Date.now() < end; await sleep(100)) await status(heat, json.id)   // a tick in flight may still land
  const held = (await status(heat, json.id)).pos
  for (let end = Date.now() + 1500; Date.now() < end; await sleep(100)) assert.equal((await status(heat, json.id)).pos, held, 'paused while hot')
  battery(30)
  await waitFor(heat, json.id, st => st.pos > held, 5000)
  await req(heat, 'video/cancel', { id: json.id })
})

test('above 42 °C next and batch wait, open goes on', async () => {
  battery(43)
  await sleep(BATTERY_WAIT)
  const next = (await reduce(heat, 'https://api-cdn.rule34.xxx/slow/warm-next.mp4', { priority: 'next' })).json
  for (let i = 0; i < 8; i++) { assert.equal((await status(heat, next.id)).state, 'queued'); await sleep(100) }
  const open = (await reduce(heat, 'https://api-cdn.rule34.xxx/slow/warm-open.mp4')).json
  await waitFor(heat, open.id, st => st.state === 'running')
  await req(heat, 'video/cancel', { id: open.id })
  await req(heat, 'video/cancel', { id: next.id })
  battery(30)
})

test('below 20 % and not plugged, next waits', async () => {
  battery(30, 15, 'UNPLUGGED')
  await sleep(BATTERY_WAIT)
  const next = (await reduce(heat, 'https://api-cdn.rule34.xxx/slow/low-next.mp4', { priority: 'next' })).json
  for (let i = 0; i < 8; i++) { assert.equal((await status(heat, next.id)).state, 'queued'); await sleep(100) }
  battery(30, 15, 'PLUGGED_AC')
  await waitFor(heat, next.id, st => st.state === 'running')
  await req(heat, 'video/cancel', { id: next.id })
  battery(30)
})

test('save of a finished job copies to the media folder and notifies', async () => {
  const url = 'https://api-cdn.rule34.xxx/images/2/save.mp4'
  const { json } = await reduce(heat, url)
  await waitFor(heat, json.id, st => st.state === 'done')
  assert.deepEqual((await req(heat, 'video/save', { id: json.id, name: 'rule34_1.1080p' })).json, { ok: true, saved: true })
  const home = path.join(dir, 'heat')
  assert.equal(fs.statSync(path.join(home, 'media', 'rule34_1.1080p.mp4')).size, fs.statSync(path.join(heat.cache, `${hash(url)}.mp4`)).size)
  assert.match(fs.readFileSync(path.join(home, 'calls.log'), 'utf8'), /termux-notification .*rule34_1\.1080p\.mp4/)
})

test('save before done answers later, then copies at the end; the job outlives the interest time', async () => {
  const { json } = await reduce(heat, 'https://api-cdn.rule34.xxx/images/2/later.mp4')
  assert.deepEqual((await req(heat, 'video/save', { id: json.id, name: 'rule34_2.1080p' })).json, { ok: true, saved: false, later: true })
  const saved = path.join(dir, 'heat', 'media', 'rule34_2.1080p.mp4')
  for (let i = 0; i < 80 && !fs.existsSync(saved); i++) await sleep(100)   // no polling meanwhile: 8 s against an 800 ms interest time
  assert.ok(fs.existsSync(saved))
})

test('a bad save name: 400', async () => {
  const { json } = await reduce(heat, 'https://api-cdn.rule34.xxx/images/2/save.mp4')
  for (const name of ['../x', 'a b', '', 'x'.repeat(81)]) assert.equal((await req(heat, 'video/save', { id: json.id, name })).status, 400, name)
})

test('batch queues files without a .1080p sibling and writes <name>.1080p.mp4 next to them', async () => {
  const saved = path.join(dir, 'heat', 'saved')
  fs.mkdirSync(saved)
  fs.writeFileSync(path.join(saved, 'clip.mp4'), 'x')
  fs.writeFileSync(path.join(saved, 'done.mp4'), 'x')
  fs.writeFileSync(path.join(saved, 'done.1080p.mp4'), 'x')
  const { json } = await req(heat, 'video/batch', { paths: [path.join(saved, 'clip.mp4'), path.join(saved, 'done.mp4')] })
  assert.deepEqual(json, { ok: true, queued: [path.join(saved, 'clip.mp4')] })
  for (let i = 0; i < 80 && !fs.existsSync(path.join(saved, 'clip.1080p.mp4')); i++) await sleep(100)
  assert.ok(fs.existsSync(path.join(saved, 'clip.1080p.mp4')))
  assert.ok(!fs.readdirSync(saved).some(f => f.includes('.part')))
})

test('video.log has start and done lines without the url', () => {
  const log = fs.readFileSync(path.join(dir, 'heat', 'video.log'), 'utf8')
  const h8 = hash('https://api-cdn.rule34.xxx/images/2/save.mp4').slice(0, 8)
  assert.match(log, new RegExp(`start ${h8}`))
  assert.match(log, new RegExp(`done ${h8}`))
  assert.doesNotMatch(log, /https?:\/\//)
})
