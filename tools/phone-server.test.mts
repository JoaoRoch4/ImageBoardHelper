// Tests for tools/phone-server.mts: node --test tools/phone-server.test.mts
// A real server process on a free port, with everything outside reached
// through stubs: the fake rish is a shell whose PATH starts with a folder of
// fake Android commands, and IBH_TERMUX_BIN points at fake termux-* commands.
// Both kinds write what they received to calls.log.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

const SERVER = path.join(import.meta.dirname, 'phone-server.mts')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-server-test-'))
const stubs = path.join(dir, 'stubs')          // fake Android commands, first on the fake rish's PATH
const termuxBin = path.join(dir, 'termux')     // fake termux-* commands
const callsLog = path.join(dir, 'calls.log')
const fakeRish = path.join(dir, 'rish')
fs.mkdirSync(stubs)
fs.mkdirSync(termuxBin)
fs.writeFileSync(fakeRish, `#!/bin/sh\nPATH="${stubs}:$PATH" exec sh "$@"\n`, { mode: 0o755 })   // no arguments: the session; -c: one command

// A stub that records its name and arguments (one line), then runs `extra`.
export function stub(folder: string, name: string, extra = '') {
  fs.writeFileSync(path.join(folder, name), `#!/bin/sh\necho "${name} $*" | sed 's/ $//' >> "${callsLog}"\n${extra}\n`, { mode: 0o755 })
}

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

let port = 0
let TOKEN = ''
const servers: ChildProcess[] = []

const serverEnv = (extra: Record<string, string> = {}) => ({
  ...process.env, IBH_SERVER_DIR: dir, IBH_SERVER_PORT: String(port), RISH: fakeRish, IBH_TERMUX_BIN: `${termuxBin}/`, IBH_SERVER_MEDIA: path.join(dir, 'media'), ...extra,
})

// A server process; resolves once its port answers.
async function startServer(extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, [SERVER, 'serve'], { env: serverEnv(extra), stdio: 'ignore' })
  servers.push(child)
  const p = Number(extra.IBH_SERVER_PORT || port)
  for (let i = 0; i < 100 && !await portOpen(p); i++) await new Promise(r => setTimeout(r, 100))
  return child
}

// One request; GET for status without a body, POST otherwise.
export async function req(route: string, body?: unknown, token = TOKEN, raw?: string, p = port): Promise<{ status: number; json: any }> {
  const post = body !== undefined || raw !== undefined
  const res = await fetch(`http://127.0.0.1:${p}/${route}`, {
    method: post ? 'POST' : 'GET',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(post ? { 'content-type': 'application/json' } : {}) },
    ...(post ? { body: raw ?? JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : {} }
}

export const calls = () => (fs.existsSync(callsLog) ? fs.readFileSync(callsLog, 'utf8').trimEnd().split('\n') : [])
export const lastCall = () => calls().at(-1)
export const pick = (o: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(keys.map(k => [k, o[k]]))

// The command-line client or a second server: exit code and output.
function cli(args: string[], extra: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [SERVER, ...args], { env: serverEnv(extra) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

before(async () => {
  port = await freePort()
  await startServer()
  TOKEN = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim()
})

after(() => {
  for (const s of servers) s.kill()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ─── core ───

test('the token file is created with mode 600', () => assert.equal(fs.statSync(path.join(dir, 'token')).mode & 0o777, 0o600))

test('no token: 401', async () => assert.equal((await req('status', undefined, '')).status, 401))

test('wrong token: 401', async () => assert.equal((await req('status', undefined, 'x'.repeat(64))).status, 401))

test('unknown route: 404', async () => assert.equal((await req('nope', {})).status, 404))

// ─── the router (part 2): GET routes and the token-free /v/ ───

test('GET /v/<unknown key>: 404 without a token', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/v/${'0'.repeat(64)}.mp4`)
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin')
})

test('GET /video/<id> needs the token', async () => assert.equal((await req('video/abc', undefined, '')).status, 401))

test('GET /video/<unknown id>: 404 from the video reducer', async () => {
  const { status, json } = await req('video/abc')
  assert.equal(status, 404)
  assert.equal(json.error, 'no such video')
})

test('status reports version 2.0.0', async () => assert.equal((await req('status')).json.version, '2.0.0'))

test('a body that is not JSON: 400, and the server lives on', async () => {
  assert.equal((await req('status', undefined, TOKEN, 'not json at all')).status, 400)
  assert.equal((await req('status')).status, 200)
})

test('a body over 30 MB: 413', async () => assert.equal((await req('file', undefined, TOKEN, 'x'.repeat(31 * 1024 * 1024))).status, 413))

test('status', async () => {
  const { json } = await req('status')
  assert.equal(json.ok, true)
  assert.equal(typeof json.version, 'string')
  assert.equal(json.shizuku, true)   // the fake rish answers
  assert.equal(typeof json.termuxApi, 'boolean')
})

test('the log has one line per request and no body', () => {
  const log = fs.readFileSync(path.join(dir, 'server.log'), 'utf8')
  assert.match(log, /status/)
  assert.doesNotMatch(log, /not json at all/)
})

test('a second serve on the same port says so', async () => {
  const second = await cli(['serve'])
  assert.equal(second.code, 1)
  assert.match(second.stderr, /port \d+ busy/)
})

test('call without a token file names the file', async () => {
  const empty = fs.mkdtempSync(path.join(dir, 'empty-'))
  const r = await cli(['call', 'status'], { IBH_SERVER_DIR: empty })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /token/)
  assert.ok(r.stderr.includes(empty))
})

test('call prints the answer', async () => {
  const r = await cli(['call', 'status'])
  assert.equal(r.code, 0)
  assert.equal(JSON.parse(r.stdout).ok, true)
})

// ─── run, file, device ───

stub(termuxBin, 'termux-battery-status', `echo '{"percentage":80,"status":"DISCHARGING","temperature":30.5}'`)

test('run', async () => {
  const { json } = await req('run', { command: 'echo hi; echo err >&2; exit 3' })
  assert.deepEqual(pick(json, 'code', 'stdout', 'stderr'), { code: 3, stdout: 'hi\n', stderr: 'err\n' })
})

test('run in a folder', async () => assert.equal((await req('run', { command: 'pwd', cwd: dir })).json.stdout.trim(), dir))

test('run times out', async () => {
  const { json } = await req('run', { command: 'sleep 5', timeout: 1 })
  assert.equal(json.timedOut, true)
})

test('run cuts output at 1 MB', async () => {
  const { json } = await req('run', { command: 'head -c 2000000 /dev/zero | tr "\\0" a' })
  assert.equal(json.stdout.length, 1048576)
  assert.equal(json.cut, true)
})

test('run refuses a timeout over 600 s', async () => assert.equal((await req('run', { command: 'true', timeout: 601 })).status, 400))

test('file: write then read, utf8 and base64', async () => {
  const text = path.join(dir, 'files', 'a.txt')
  await req('file', { path: text, write: 'olá' })
  assert.equal((await req('file', { path: text })).json.content, 'olá')
  const bin = path.join(dir, 'files', 'b.bin')
  const b64 = Buffer.from([0, 1, 2]).toString('base64')
  await req('file', { path: bin, write: b64, encoding: 'base64' })
  assert.equal((await req('file', { path: bin, encoding: 'base64' })).json.content, b64)
})

test('file: reading a missing file is 400 naming it', async () => {
  const missing = path.join(dir, 'nothing-here')
  const { status, json } = await req('file', { path: missing })
  assert.equal(status, 400)
  assert.ok(json.error.includes(missing))
})

test('file: over 20 MB is refused', async () => {
  assert.equal((await req('file', { path: path.join(dir, 'big'), write: 'x'.repeat(21 * 1024 * 1024) })).status, 400)
})

test('device', async () => {
  const { json } = await req('device', {})
  assert.equal(json.battery.percentage, 80)
  assert.ok(json.memory.total_mb > 0)
  assert.ok(json.storage.length > 0 && json.storage[0].free_mb > 0)   // statfs, not df: Android's /bin/df breaks natively
  assert.ok(json.network.some((n: { address: string }) => n.address === '127.0.0.1'))   // not ip: Android denies netlink to apps
})

// ─── open, apps, screenshot, record, input (through the fake rish) ───

for (const name of ['am', 'monkey', 'cmd', 'screenrecord']) stub(stubs, name)
stub(stubs, 'input', 'case "$*" in *KEYCODE_FAIL*) exit 1;; esac')   // a phone command that fails
stub(stubs, 'pm', 'echo package:org.videolan.vlc')
stub(stubs, 'screencap', `for last; do :; done; printf '\\211PNG\\r\\n\\032\\n' > "$last"`)   // a PNG signature into its last argument

test('open a link in an app', async () => {
  await req('open', { url: 'https://rule34.xxx/', app: 'org.mozilla.fenix' })
  assert.equal(lastCall(), 'am start -a android.intent.action.VIEW -d https://rule34.xxx/ org.mozilla.fenix')
})

test('open an app alone', async () => {
  await req('open', { app: 'org.videolan.vlc' })
  assert.equal(lastCall(), 'monkey -p org.videolan.vlc -c android.intent.category.LAUNCHER 1')
})

test('open refuses quotes and spaces', async () => assert.equal((await req('open', { url: "https://x/'; rm -rf ~" })).status, 400))

test('apps by name', async () => assert.deepEqual((await req('apps', { filter: 'vlc' })).json.packages, ['org.videolan.vlc']))

test('input tap, and out-of-range coordinates refused', async () => {
  await req('input', { action: 'tap', x: 10, y: 20 })
  assert.equal(lastCall(), 'input tap 10 20')
  assert.equal((await req('input', { action: 'tap', x: -1, y: 20 })).status, 400)
})

test('screenshot inline', async () => {
  const { json } = await req('screenshot', { inline: true })
  assert.ok(json.path.endsWith('.png'))
  assert.equal(Buffer.from(json.base64, 'base64').subarray(1, 4).toString(), 'PNG')
})

test('record clamps to 1-15 s', async () => {
  await req('record', { seconds: 99 })
  assert.match(lastCall() ?? '', /^screenrecord --time-limit 15 /)
})

test('two rish requests at once both succeed', async () => {
  const [a, b] = await Promise.all([req('input', { action: 'key', key: 'BACK' }), req('input', { action: 'key', key: 'HOME' })])
  assert.equal(a.json.ok && b.json.ok, true)
})

test('Shizuku down: 503', async () => {
  const p2 = await freePort()
  await startServer({ IBH_SERVER_PORT: String(p2), RISH: path.join(dir, 'no-such-rish') })
  assert.equal((await req('open', { app: 'org.videolan.vlc' }, TOKEN, undefined, p2)).status, 503)
})

// ─── notify, clipboard, toast (through the fake Termux:API) ───

stub(termuxBin, 'termux-notification', 'while [ $# -gt 0 ]; do [ "$1" = --action ] && act="$2"; shift; done; [ -n "$act" ] && sh -c "$act"')   // runs its --action, as a tap would
stub(termuxBin, 'termux-toast')
stub(termuxBin, 'termux-clipboard-set', `cat >> "${callsLog}"; echo >> "${callsLog}"`)   // its stdin, on the next line
stub(termuxBin, 'termux-clipboard-get', 'printf "copied text"')

test('notify with a link', async () => {
  await req('notify', { title: 'Deploy', text: 'v1.9 ok', url: 'https://rule34.xxx/', id: 'deploy' })
  const [note, tap] = calls().slice(-2)
  assert.match(note ?? '', /^termux-notification --title Deploy --content v1\.9 ok --id deploy --action /)
  assert.equal(tap, 'am start -a android.intent.action.VIEW -d https://rule34.xxx/')   // what the tap ran
})

test('notify refuses a link with quotes', async () => assert.equal((await req('notify', { title: 't', text: 'x', url: "https://x/'" })).status, 400))

test('clipboard read', async () => assert.equal((await req('clipboard', {})).json.text, 'copied text'))

test('clipboard write goes through stdin', async () => {
  await req('clipboard', { set: "it's" })
  assert.deepEqual(calls().slice(-2), ['termux-clipboard-set', "it's"])
})

test('toast', async () => {
  await req('toast', { text: 'oi' })
  assert.equal(lastCall(), 'termux-toast oi')
})

test('Termux:API missing: 503', async () => {
  const p3 = await freePort()
  await startServer({ IBH_SERVER_PORT: String(p3), IBH_TERMUX_BIN: path.join(dir, 'no-termux') + '/' })
  assert.equal((await req('toast', { text: 'oi' }, TOKEN, undefined, p3)).status, 503)
})

// ─── install-boot ───

test('install-boot writes the Termux:Boot script', async () => {
  const home = fs.mkdtempSync(path.join(dir, 'home-'))
  const r = await cli(['install-boot'], { IBH_TERMUX_HOME: home })
  assert.equal(r.code, 0)
  const file = path.join(home, '.termux', 'boot', 'ibh-server.sh')
  assert.equal(fs.statSync(file).mode & 0o777, 0o755)
  const script = fs.readFileSync(file, 'utf8')
  assert.ok(script.includes('termux-wake-lock'))
  assert.ok(script.includes('tmux has-session -t ibh || tmux new-session -d -s ibh'))
  assert.ok(script.includes('node /data/data/com.termux/files/usr/var/lib/proot-distro/containers/fedora/rootfs/root/ImageBoardHelper/tools/phone-server.mts serve'))
})

test('the default folder is in Termux\'s home, the same from the container and natively', async () => {
  const saved = process.env.IBH_SERVER_DIR
  delete process.env.IBH_SERVER_DIR
  const fresh = './phone-server.mts?default-dir'   // a fresh copy of the module, read without the override
  const { serverDir } = await import(fresh) as typeof import('./phone-server.mts')
  process.env.IBH_SERVER_DIR = saved
  const termuxHome = '/data/data/com.termux/files/home'
  assert.equal(serverDir(), fs.existsSync(termuxHome) ? `${termuxHome}/.config/ibh-server` : path.join(os.homedir(), '.config', 'ibh-server'))
})

// ─── final review fixes ───

test('a notify link reaches the tap literally: no $ or backtick expansion', async () => {
  const url = 'https://x/?a=$HOME&b=`id`'
  await req('notify', { title: 't', text: 'x', url })
  assert.equal(lastCall(), `am start -a android.intent.action.VIEW -d ${url}`)
})

test('a phone command that fails is not ok', async () => assert.equal((await req('input', { action: 'key', key: 'FAIL' })).status, 500))

test('install-boot defaults to Termux\'s home, also from the container', async () => {
  const saved = process.env.IBH_TERMUX_HOME
  delete process.env.IBH_TERMUX_HOME
  const fresh = './phone-server.mts?boot-file'
  const { bootFile } = await import(fresh) as typeof import('./phone-server.mts')
  if (saved !== undefined) process.env.IBH_TERMUX_HOME = saved
  const termuxHome = '/data/data/com.termux/files/home'
  assert.equal(bootFile(), path.join(fs.existsSync(termuxHome) ? termuxHome : os.homedir(), '.termux', 'boot', 'ibh-server.sh'))
})

test('a Termux:API command that exits early or hangs neither kills nor stalls the server', async () => {
  const broken = path.join(dir, 'termux-broken')
  fs.mkdirSync(broken)
  fs.writeFileSync(path.join(broken, 'termux-clipboard-set'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })   // never reads its stdin
  fs.writeFileSync(path.join(broken, 'termux-toast'), '#!/bin/sh\nsleep 60\n', { mode: 0o755 })         // the app missing: it hangs
  const p4 = await freePort()
  await startServer({ IBH_SERVER_PORT: String(p4), IBH_TERMUX_BIN: `${broken}/`, IBH_TERMUX_TIMEOUT_MS: '1000' })
  await req('clipboard', { set: 'x'.repeat(200000) }, TOKEN, undefined, p4)
  assert.equal((await req('status', undefined, TOKEN, undefined, p4)).status, 200)   // still alive
  const t0 = Date.now()
  assert.equal((await req('toast', { text: 'oi' }, TOKEN, undefined, p4)).status, 503)
  assert.ok(Date.now() - t0 < 5000)
})
