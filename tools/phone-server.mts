#!/usr/bin/env node
// Development helper, not part of the userscript.
//
// A local HTTP+JSON server that controls the phone, run natively in Termux
// (see docs/superpowers/specs/2026-10-07-phone-server-design.md):
//
//   node tools/phone-server.mts serve                 run the server on 127.0.0.1:8730
//   node tools/phone-server.mts call <route> [json]   one request, the answer printed
//   node tools/phone-server.mts token                 the token (created if missing)
//   node tools/phone-server.mts install-boot          starts the server when the phone boots (Termux:Boot)
//   node tools/phone-server.mts install-shortcuts     the "IBH servidor" home-screen icon (Termux:Widget) and the ibh-servidor command
//
// Every request carries "Authorization: Bearer <token>"; the token lives in
// ~/.config/ibh-server/token in Termux's home (mode 600), where the server
// also keeps its log.
// GET /status; every action is POST /<action> with a JSON body; answers are
// { ok: true, ... } or { ok: false, error } with 400, 401, 404, 413, 503, 500.
// The video routes (part 2, tools/video-reducer.mts) add GET /video/<id> and
// GET /v/<key>.mp4, the one route without the token (a <video> sends no
// header; the key is the capability).
// Everything outside is reached through paths the tests override:
// IBH_SERVER_DIR, IBH_SERVER_PORT, RISH, IBH_TERMUX_BIN.
// TypeScript that Node runs as it is (it strips the types); tsc -p tools checks it.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import * as crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { ROOTFS, findRish, rish, shizukuUp } from './rish.mts'
import { HttpError } from './http-error.mts'
import type { Handler } from './http-error.mts'
import { makeVideoReducer } from './video-reducer.mts'

export { HttpError }
export type { Handler }

const VERSION = '2.0.0'
// Termux's home: the same path natively and from the container, so both
// sides read one token.
const TERMUX_HOME = '/data/data/com.termux/files/home'
const DIR = process.env.IBH_SERVER_DIR || path.join(fs.existsSync(TERMUX_HOME) ? TERMUX_HOME : os.homedir(), '.config', 'ibh-server')
const PORT = Number(process.env.IBH_SERVER_PORT || 8730)
const TERMUX_BIN = process.env.IBH_TERMUX_BIN || ''   // a folder ending in /, or empty: termux-* from PATH
const MEDIA = process.env.IBH_SERVER_MEDIA || '/sdcard/Download'   // screenshots and recordings
const TERMUX_TIMEOUT = Number(process.env.IBH_TERMUX_TIMEOUT_MS || 20000)   // termux-* hang when the Termux:API app is missing
const MAX_BODY = 30 * 1024 * 1024                     // a 20 MB file as base64, with room to spare
const LOG_MAX = 1024 * 1024
const started = Date.now()


export const serverDir = () => DIR

// The token: read, or created on the first serve (32 random bytes, mode 600).
export function readToken(create: boolean): string {
  const file = path.join(DIR, 'token')
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
  if (!create) throw new Error(`no token file at ${file}: start the server once (serve) to create it`)
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const token = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 })
  return token
}

// Where a termux-* command would run from (IBH_TERMUX_BIN, else PATH).
function termuxPath(name: string) {
  if (TERMUX_BIN) return `${TERMUX_BIN}${name}`
  const dir = (process.env.PATH || '').split(':').find(d => fs.existsSync(path.join(d, name)))
  return dir ? path.join(dir, name) : name
}

// A Termux:API command: its stdout, or 503 when Termux:API is not installed.
export function termux(name: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(termuxPath(name), args)
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new HttpError(503, `${name} did not answer in ${TERMUX_TIMEOUT / 1000} s: is the Termux:API app installed?`))
    }, TERMUX_TIMEOUT)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(e.code === 'ENOENT' ? new HttpError(503, `Termux:API is not installed (${name} is missing): pkg install termux-api, and the Termux:API app`) : e)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new HttpError(500, `${name} failed (${code}): ${err.trim()}`))
    })
    // A command that exits without reading its stdin breaks the pipe (EPIPE):
    // unhandled, that error would take the whole server down.
    child.stdin.on('error', () => { /* its exit code tells what happened */ })
    child.stdin.end(input ?? '')
  })
}

const RUN_CUT = 1024 * 1024        // stdout and stderr of run, each
const FILE_MAX = 20 * 1024 * 1024

// Body fields: the type asked for, or 400 naming the field.
function text(body: Record<string, unknown>, key: string): string {
  const v = body[key]
  if (typeof v !== 'string' || !v) throw new HttpError(400, `${key} is required (a string)`)
  return v
}
function optText(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key]
  if (v !== undefined && typeof v !== 'string') throw new HttpError(400, `${key} must be a string`)
  return v
}
function optNumber(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key]
  if (v !== undefined && typeof v !== 'number') throw new HttpError(400, `${key} must be a number`)
  return v
}

// A native command in a login bash, in its own process group so a timeout
// kills it and everything it started (a lone kill would leave a `sleep`
// holding the output open).
function runCommand(command: string, cwd: string, timeoutS: number) {
  return new Promise<Record<string, unknown>>(resolve => {
    const child = spawn('bash', ['-lc', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = { stdout: '', stderr: '' }
    let cut = false
    let timedOut = false
    const add = (key: 'stdout' | 'stderr') => (d: Buffer) => {
      const room = RUN_CUT - out[key].length
      const chunk = d.toString('utf8')
      if (chunk.length > room) cut = true
      if (room > 0) out[key] += chunk.slice(0, room)
    }
    child.stdout.on('data', add('stdout'))
    child.stderr.on('data', add('stderr'))
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-(child.pid ?? 0), 'SIGKILL') } catch (e) { child.kill('SIGKILL') } }, timeoutS * 1000)
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: String(e), timedOut, cut }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, ...out, timedOut, cut }) })
  })
}

// What may reach the shell: a link without spaces or quotes (http, https,
// intent…), a package name, a key code; anything else is single-quoted.
const LINK = /^[a-z]+:\/\/[^\s'"\\]+$/i
const PACKAGE = /^[\w.]+$/
const KEY = /^(KEYCODE_)?[A-Z0-9_]+$/
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`   // one shell word

// A command as uid shell, through rish; 503 when Shizuku is not answering.
async function shell(cmd: string, timeout?: number) {
  try {
    return await rish(cmd, timeout)
  } catch (e) {
    throw new HttpError(503, 'Shizuku is not answering: start it in the Shizuku app')
  }
}

// The same, failing with the command's output when it exits nonzero.
async function shellOk(cmd: string, timeout?: number) {
  const r = await shell(cmd, timeout)
  if (r.code !== 0) throw new HttpError(500, r.out || `exit ${r.code}`)
  return r
}

// A screen coordinate or a duration from the body, or 400.
function coord(body: Record<string, unknown>, key: string, fallback?: number): number {
  const v = body[key] ?? fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10000) throw new HttpError(400, `${key} must be a number from 0 to 10000`)
  return Math.round(v)
}

function mediaFile(ext: string) {
  try { fs.mkdirSync(MEDIA, { recursive: true }) } catch (e) { /* /sdcard/Download exists already */ }
  return path.join(MEDIA, `ibh-server-${Date.now()}.${ext}`)
}

export const ROUTES: Record<string, Handler> = {
  status: async () => ({
    version: VERSION,
    uptime_s: Math.round((Date.now() - started) / 1000),
    shizuku: await shizukuUp(),
    termuxApi: fs.existsSync(termuxPath('termux-toast')),
  }),

  // A link (in `app` when given), or `app` launched alone.
  open: async body => {
    const url = optText(body, 'url')
    const app = optText(body, 'app')
    if (!url && !app) throw new HttpError(400, 'url or app is required')
    if (url && !LINK.test(url)) throw new HttpError(400, 'url must be a link without spaces or quotes')
    if (app && !PACKAGE.test(app)) throw new HttpError(400, 'app must be a package name, like org.mozilla.fenix')
    const r = await shellOk(url ? `am start -a android.intent.action.VIEW -d '${url}'${app ? ` ${app}` : ''}` : `monkey -p ${app} -c android.intent.category.LAUNCHER 1`)
    return { output: r.out }
  },

  // The apps that open a link (as Firefox asks, BROWSABLE), or the installed packages matching a name.
  apps: async body => {
    const url = optText(body, 'url')
    if (url) {
      const mime = optText(body, 'mime') ?? 'video/*'
      if (!LINK.test(url)) throw new HttpError(400, 'url must be a link without spaces or quotes')
      if (!/^[\w*.+/-]+$/.test(mime)) throw new HttpError(400, 'bad MIME type')
      const r = await shellOk(`cmd package query-activities --brief -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d '${url}' -t '${mime}'`)
      return { activities: r.out.split('\n').map(l => l.trim()).filter(l => /^[\w.]+\/[\w.$]+$/.test(l)) }
    }
    const filter = optText(body, 'filter') ?? ''
    if (!/^[\w.]*$/.test(filter)) throw new HttpError(400, 'filter is part of a package name')
    const r = await shellOk(`pm list packages ${filter}`)
    return { packages: r.out.split('\n').map(l => l.replace(/^package:/, '').trim()).filter(Boolean) }
  },

  screenshot: async body => {
    const file = mediaFile('png')
    await shellOk(`screencap -p ${shq(file)}`)
    return { path: file, ...(body.inline ? { base64: fs.readFileSync(file).toString('base64') } : {}) }
  },

  record: async body => {
    const seconds = Math.max(1, Math.min(15, Math.round(Number(body.seconds) || 5)))
    const file = mediaFile('mp4')
    await shellOk(`screenrecord --time-limit ${seconds} ${shq(file)}`, (seconds + 20) * 1000)
    return { path: file, seconds }
  },

  // Touches and keys, through Android's `input`.
  input: async body => {
    const action = optText(body, 'action')
    let cmd: string
    if (action === 'tap') cmd = `input tap ${coord(body, 'x')} ${coord(body, 'y')}`
    else if (action === 'long_press') cmd = `input swipe ${coord(body, 'x')} ${coord(body, 'y')} ${coord(body, 'x')} ${coord(body, 'y')} ${coord(body, 'ms', 800)}`
    else if (action === 'swipe') cmd = `input swipe ${coord(body, 'x')} ${coord(body, 'y')} ${coord(body, 'x2')} ${coord(body, 'y2')} ${coord(body, 'ms', 300)}`
    else if (action === 'key') {
      const key = text(body, 'key')
      if (!KEY.test(key)) throw new HttpError(400, 'key must be a key code, like BACK, HOME or KEYCODE_VOLUME_UP')
      cmd = `input keyevent ${key.startsWith('KEYCODE_') ? key : `KEYCODE_${key}`}`
    } else if (action === 'text') cmd = `input text ${shq(text(body, 'text').replace(/ /g, '%s'))}`
    else throw new HttpError(400, 'action: tap, long_press, swipe, key or text')
    await shellOk(cmd, 30000)
    return { done: cmd }
  },

  // A notification; with `url`, tapping it opens the link. The tap runs a
  // shell line in Termux, and Android refuses `am` to Termux: rish runs it.
  notify: async body => {
    const url = optText(body, 'url')
    if (url && !LINK.test(url)) throw new HttpError(400, 'url must be a link without spaces or quotes')
    const args = ['--title', text(body, 'title'), '--content', text(body, 'text'), '--id', optText(body, 'id') ?? 'ibh']
    // Quoted at both layers (Termux's shell, then rish's): a $ or backtick in the link stays literal.
    if (url) args.push('--action', `${shq(findRish())} -c ${shq(`am start -a android.intent.action.VIEW -d ${shq(url)}`)}`)
    await termux('termux-notification', args)
    return {}
  },

  // Reads the clipboard, or writes `set` to it (on stdin: nothing to quote).
  clipboard: async body => {
    const set = optText(body, 'set')
    if (set !== undefined) { await termux('termux-clipboard-set', [], set); return {} }
    return { text: await termux('termux-clipboard-get', []) }
  },

  toast: async body => { await termux('termux-toast', [text(body, 'text')]); return {} },

  run: async body => {
    const timeout = optNumber(body, 'timeout') ?? 60
    if (!(timeout > 0 && timeout <= 600)) throw new HttpError(400, 'timeout is 1 to 600 seconds')
    return runCommand(text(body, 'command'), optText(body, 'cwd') || os.homedir(), timeout)
  },

  // Reads a file, or writes `write` to it (creating its folders); utf8 or base64.
  file: async body => {
    const file = text(body, 'path')
    const encoding = optText(body, 'encoding') ?? 'utf8'
    if (encoding !== 'utf8' && encoding !== 'base64') throw new HttpError(400, 'encoding is utf8 or base64')
    const write = optText(body, 'write')
    if (write !== undefined) {
      const bytes = Buffer.from(write, encoding)
      if (bytes.length > FILE_MAX) throw new HttpError(400, `over ${FILE_MAX / 1048576} MB`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, bytes)
      return { path: file, bytes: bytes.length }
    }
    let size: number
    try {
      const st = fs.statSync(file)
      if (!st.isFile()) throw new HttpError(400, `not a file: ${file}`)
      size = st.size
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(400, `no such file: ${file}`)
    }
    if (size > FILE_MAX) throw new HttpError(400, `over ${FILE_MAX / 1048576} MB: ${file}`)
    return { path: file, bytes: size, content: fs.readFileSync(file).toString(encoding) }
  },

  // Battery (Termux:API, null without it), memory, storage and addresses.
  device: async () => {
    let battery: unknown = null
    try { battery = JSON.parse(await termux('termux-battery-status', [])) } catch (e) { /* no Termux:API: no battery */ }
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8')
    const mb = (key: string) => Math.round(Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] ?? 0) / 1024)
    // Node's own calls, not df or ip: natively Android's /bin/df breaks and
    // netlink is denied to apps, while statfs and getifaddrs work.
    const storage = ['/sdcard', os.homedir()].flatMap(mount => {
      try {
        const st = fs.statfsSync(mount)
        return [{ mount, size_mb: Math.round((st.blocks * st.bsize) / 1048576), free_mb: Math.round((st.bavail * st.bsize) / 1048576) }]
      } catch (e) { return [] }
    })
    const network = Object.entries(os.networkInterfaces()).flatMap(([iface, addrs]) => (addrs ?? []).map(a => ({ iface, address: a.address })))
    return { battery, memory: { total_mb: mb('MemTotal'), available_mb: mb('MemAvailable') }, storage, network }
  },
}

// One line per request, never the body (clipboard text, file contents).
function log(line: string) {
  const file = path.join(DIR, 'server.log')
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
    if (fs.statSync(file).size > LOG_MAX) fs.writeFileSync(file, fs.readFileSync(file).subarray(-LOG_MAX / 2))   // keep the last half
  } catch (e) { /* a log that cannot be written does not stop the server */ }
}

// The body as a JSON object ({} when empty); 413 past MAX_BODY, 400 when not JSON.
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size <= MAX_BODY) chunks.push(c)   // past the limit the rest is read and dropped
    })
    req.on('end', () => {
      if (size > MAX_BODY) { reject(new HttpError(413, `the body is over ${MAX_BODY / 1048576} MB`)); return }
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) { resolve({}); return }
      let value: unknown
      try { value = JSON.parse(text) } catch (e) { reject(new HttpError(400, 'the body is not JSON')); return }
      if (value && typeof value === 'object' && !Array.isArray(value)) resolve(value as Record<string, unknown>)
      else reject(new HttpError(400, 'the body must be a JSON object'))
    })
    req.on('error', reject)
  })
}

function serve() {
  const want = Buffer.from(`Bearer ${readToken(true)}`)
  // Same length first: timingSafeEqual compares equal lengths only.
  const authorized = (header = '') => { const got = Buffer.from(header); return got.length === want.length && crypto.timingSafeEqual(got, want) }
  const video = makeVideoReducer({
    termux, dir: DIR, mediaDir: MEDIA,
    notify: async (title, content) => { await termux('termux-notification', ['--title', title, '--content', content, '--id', 'ibh-video']) },
  })
  const routes: Record<string, Handler> = { ...ROUTES, ...video.routes }
  // No CORS headers: a web page can neither read an answer nor act without the token.
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now()
    const route = (req.url || '/').split('?')[0]?.slice(1) ?? ''
    // The growing video file: the key in the path stands for the token.
    if (req.method === 'GET' && route.startsWith('v/')) { video.serveMedia(req, res); return }
    let status = 200
    let answer: Record<string, unknown>
    try {
      if (!authorized(req.headers.authorization)) throw new HttpError(401, 'missing or wrong token')
      const body = await readBody(req)
      // GET /video/<id> reads a job; every other route is its own name.
      const id = req.method === 'GET' && /^video\/[^/]+$/.test(route) ? route.slice('video/'.length) : null
      const handler = id !== null ? routes['video/status'] : Object.hasOwn(routes, route) ? routes[route] : undefined
      if (!handler) throw new HttpError(404, `no route "${route}"`)
      answer = { ok: true, ...await handler(id !== null ? { id } : body) }
    } catch (e) {
      status = e instanceof HttpError ? e.status : 500
      answer = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
    log(`${route} ${Date.now() - t0}ms ${status === 200 ? 'ok' : `${status} ${answer.error}`}`)
  })
  // Stopped (tmux window closed, SIGTERM): vreduce, in its own process group, goes too.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { video.stop(); process.exit(0) })
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EADDRINUSE') throw e
    console.error(`port ${PORT} busy (a server already running?)`)
    process.exit(1)
  })
  server.listen(PORT, '127.0.0.1', () => {
    log(`serving on 127.0.0.1:${PORT} (v${VERSION})`)
    console.log(`phone server v${VERSION} on 127.0.0.1:${PORT}`)
  })
}

// The Termux:Boot script: Termux's wake lock, the tmux session `ibh`, and
// the server in a window of it. Termux:Boot runs it natively, so it names
// this file as seen from outside proot.
// The boot script's place: Termux's home (IBH_TERMUX_HOME for tests), also
// when this runs in the container, where os.homedir() is /root.
const termuxHome = () => process.env.IBH_TERMUX_HOME || (fs.existsSync(TERMUX_HOME) ? TERMUX_HOME : os.homedir())
export const bootFile = () => path.join(termuxHome(), '.termux', 'boot', 'ibh-server.sh')

// This file as native Termux sees it (through the rootfs path when run in the container).
function nativeSelf() {
  const here = path.join(import.meta.dirname, 'phone-server.mts')
  return here.startsWith(ROOTFS) ? here : `${ROOTFS}${here}`
}

// What the boot script and the shortcut share: Termux's wake lock and the
// tmux session `ibh`; then the server's window.
const SESSION_LINES = ['termux-wake-lock', 'tmux has-session -t ibh || tmux new-session -d -s ibh']
const serverWindow = (native: string) => `tmux new-window -d -t ibh -n server 'node ${native} serve'`

function writeScript(file: string, lines: string[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, ['#!/data/data/com.termux/files/usr/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 })
  fs.chmodSync(file, 0o755)   // mode applies only when the file is created
  console.log(`wrote ${file}`)
}

function installBoot() {
  writeScript(bootFile(), ["# Image Board Helper's phone server, started when the phone boots (Termux:Boot).", ...SESSION_LINES, serverWindow(nativeSelf())])
}

// The "IBH servidor" icon: Termux:Widget runs ~/.shortcuts/tasks/* without a
// terminal. It starts the server when /status does not answer and puts the
// token on the clipboard, for the userscript's panel. ibh-servidor, on
// Termux's PATH, runs the same script.
function installShortcuts() {
  const home = termuxHome()
  const prefix = process.env.IBH_TERMUX_PREFIX || '/data/data/com.termux/files/usr'
  const task = path.join(home, '.shortcuts', 'tasks', 'IBH servidor')
  const token = path.join(DIR, 'token')
  writeScript(task, [
    "# Image Board Helper's phone server: started if it does not answer, then its token copied.",
    `up() { curl -fsS -m 2 -H "Authorization: Bearer $(cat '${token}' 2>/dev/null)" http://127.0.0.1:${PORT}/status >/dev/null 2>&1; }`,
    ...SESSION_LINES,
    'if up; then',
    "  msg='IBH server already on · token copied'",
    'else',
    `  ${serverWindow(nativeSelf())}`,
    '  n=0',
    '  while [ $n -lt 10 ] && ! up; do sleep 1; n=$((n + 1)); done',
    "  if ! up; then termux-toast 'IBH server did not start'; exit 1; fi",
    "  msg='IBH server on · token copied'",
    'fi',
    `termux-clipboard-set < '${token}'`,
    'termux-toast "$msg"',
  ])
  const link = path.join(prefix, 'bin', 'ibh-servidor')
  fs.rmSync(link, { force: true })
  fs.symlinkSync(task, link)
  console.log(`linked ${link}`)
  const icon = path.join(home, '.shortcuts', 'icons', 'IBH servidor.png')
  fs.mkdirSync(path.dirname(icon), { recursive: true })
  fs.copyFileSync(path.join(import.meta.dirname, 'assets', 'ibh-servidor.png'), icon)
  console.log(`wrote ${icon}`)
}

// One request from the command line: the answer printed, exit 0 when ok.
async function call(route: string, json?: string) {
  let token: string
  try { token = readToken(false) } catch (e) { console.error(e instanceof Error ? e.message : e); return 1 }
  const post = json !== undefined || route !== 'status'
  const res = await fetch(`http://127.0.0.1:${PORT}/${route}`, {
    method: post ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(post ? { 'content-type': 'application/json' } : {}) },
    ...(post ? { body: json ?? '{}' } : {}),
  })
  const answer = await res.json() as { ok?: boolean }
  console.log(JSON.stringify(answer, null, 2))
  return answer.ok ? 0 : 1
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === 'serve') serve()
  else if (cmd === 'token') console.log(readToken(true))
  else if (cmd === 'install-boot') installBoot()
  else if (cmd === 'install-shortcuts') installShortcuts()
  else if (cmd === 'call' && args[0]) call(args[0], args[1]).then(code => process.exit(code), e => { console.error(e.message); process.exit(1) })
  else { console.error('usage: phone-server.mts serve | call <route> [json] | token | install-boot | install-shortcuts'); process.exit(1) }
}
