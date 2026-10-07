#!/usr/bin/env node
// Development helper, not part of the userscript.
//
// An MCP server (stdio, no dependencies) for the phone this repo is tested
// on. Claude Code starts it from .mcp.json; every tool reconnects by itself
// when the Wireless debugging session or the Firefox forward is gone.
//
//   phone and browser  status, connect, tabs, eval, reload_tabs, open_url,
//                      firefox_pref, screenshot, latest_screenshot,
//                      screen_record, input, logcat, apps, device
//   the userscript     script_log, console, css, try_css, log_snapshot, slideshow_stats, deploy
//   videos and WASM    video_info, reel_preview, wasm_build
//   repo checks        check, smoke
//   native Termux      termux_run, termux_job: windows of a tmux session
//                      outside proot, started by Termux's own ~/.zshrc
//
// The protocol is JSON-RPC 2.0, one message per line on stdin/stdout:
// initialize, tools/list, tools/call. Nothing else may go to stdout.
// TypeScript that Node runs as it is (it strips the types); tsc -p tools checks it.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as https from 'node:https'
import * as readline from 'node:readline'
import { execFileSync, spawn } from 'node:child_process'
import * as ff from './ffrdp.mts'
import { rish, shizukuUp } from './rish.mts'
import type { Connection, PrefAction, Tab } from './ffrdp.mts'

const REPO = path.resolve(import.meta.dirname, '..')
const SCRIPT = 'image-board-helper.user.js'
const BROWSER = 'org.mozilla.firefox_beta'   // the Firefox used until connect picks another
const SCREENSHOTS = '/sdcard/Pictures/Screenshots'   // where the phone's own screenshots land
const SHOT = '/sdcard/Download/ibh.png'              // where screencap writes; the container reads it too
const RECORDING = '/sdcard/Download/ibh-rec.mp4'
const LOGS = path.join(os.homedir(), '.cache', 'ibh-logs')    // log snapshots, taken before every deploy
const WORK = path.join(os.homedir(), '.cache', 'ibh-mcp')     // scratch: frames, wasm build state
const SITE_REFERER = 'https://rule34.xxx/'                    // rule34's fast host serves videos only with it
// Termux's prefix: the same path inside proot and outside it, so files under
// it (tmp, var/run) are shared by both sides.
const TERMUX = '/data/data/com.termux/files/usr'
const TERM_DIR = `${TERMUX}/tmp/ibh-term`   // native jobs: script, log, exit code
const SESSION = 'ibh'                       // the native tmux session (Termux's ~/.zshrc starts it)
const MAX_TEXT = 30000                      // longer results are cut, to keep the reply readable

// MCP content blocks: what a tool returns when plain text is not enough.
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (${s.length - MAX_TEXT} more characters cut)` : s)
const tail = (s: unknown, n: number) => String(s).trim().split('\n').slice(-n).join('\n')
const kb = (n: number) => `${Math.round(n / 1024)} KB`
const shq = (s: unknown) => `'${String(s).replace(/'/g, `'\\''`)}'`   // one shell word
const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null)

// What a caught value says. Anything can be thrown, so catch variables are
// unknown: an Error's message, a failed command's stderr (execFileSync puts
// it on the error), or the value itself.
const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
const stderrOf = (e: unknown) => (typeof e === 'object' && e !== null && 'stderr' in e && e.stderr ? String(e.stderr) : '')
const firstLine = (e: unknown) => (stderrOf(e) || errMessage(e)).trim().split('\n')[0] ?? ''

function run(cmd: string, args: string[], opts: { timeout?: number } = {}): string {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64e6, ...opts })
}

// For the long ones (checks, builds): the server keeps answering meanwhile.
function runAsync(cmd: string, args: string[], { cwd = REPO, timeout = 900000, env }: { cwd?: string; timeout?: number; env?: Record<string, string> } = {}) {
  return new Promise<{ code: number | null; out: string }>(resolve => {
    const child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const add = (d: Buffer) => { out += d; if (out.length > 4e6) out = out.slice(-2e6) }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    const timer = setTimeout(() => { child.kill('SIGKILL'); out += `\n(stopped after ${timeout / 1000} s)` }, timeout)
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }) })
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: String(e) }) })
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

// ─── the phone: Shizuku (rish) first, the adb connection as a fallback ───

// The rish session (Shizuku, uid shell) lives in ./rish.mts, shared with the phone server.

function adbSerial(): string | null {
  try {
    const device = run('adb', ['devices']).split('\n').slice(1).map(l => l.trim().split(/\s+/)).find(p => p[1] === 'device')
    return device?.[0] ?? null
  } catch (e) {
    return null
  }
}

// A shell command on the phone, as uid shell either way: through the rish
// session, or adb when Shizuku is down.
async function phoneShell(cmd: string, timeout = 20000): Promise<string> {
  try {
    return (await rish(cmd, timeout)).out
  } catch (e) {
    const serial = adbSerial()
    if (!serial) throw new Error(`Shizuku is not answering (${errMessage(e)}) and adb has no device: ask the user to start Shizuku or turn on Wireless debugging`, { cause: e })
    return run('adb', ['-s', serial, 'shell', cmd], { timeout }).trim()
  }
}

// true on, false off, null when it cannot be read (Shizuku down). Read
// only: turning it on with `settings put` restarts adbd and kills Shizuku.
async function wirelessDebugging(): Promise<boolean | null> {
  try {
    const v = (await rish('settings get global adb_wifi_enabled')).out.split('\n').map(l => l.trim()).find(l => l === '0' || l === '1')
    return v === '1' ? true : v === '0' ? false : null
  } catch (e) {
    return null
  }
}

// ─── Firefox: the debugger forward, set up again when it is gone ───

async function firefoxTabs(): Promise<Tab[] | null> {
  const c = ff.connect()
  try {
    await withTimeout(c.ready, 4000, 'Firefox greeting')
    return await withTimeout(ff.listTabs(c), 4000, 'tab list')
  } catch (e) {
    return null
  } finally {
    c.sock.destroy()
  }
}

// The Firefox whose debugger is forwarded (Beta, Nightly…), remembered
// across restarts: open_url, deploy and device follow it.
const BROWSER_FILE = path.join(WORK, 'firefox-app')
let browser = (() => { try { return fs.readFileSync(BROWSER_FILE, 'utf8').trim() || BROWSER } catch (e) { return BROWSER } })()

async function connectPhone(force: boolean, app?: string) {
  if (!force && !app && await firefoxTabs()) return 'already connected'
  if (await wirelessDebugging() === false) {
    throw new Error('Wireless debugging is off. Ask the user to turn it on (Developer options → Wireless debugging); never with `settings put`, which kills Shizuku.')
  }
  const { serial, socket, app: chosen } = ff.setup(app || browser)
  if (app && chosen !== app) throw new Error(`${app} has no debugger socket: ask the user to open it and turn on its "Remote debugging via USB"`)
  browser = chosen
  try { fs.mkdirSync(WORK, { recursive: true }); fs.writeFileSync(BROWSER_FILE, browser) } catch (e) { /* remembered for this run only */ }
  return `connected to ${serial}, forward tcp:${ff.PORT} -> ${socket}`
}

async function withFirefox<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
  let c = ff.connect()
  try {
    await withTimeout(c.ready, 4000, 'Firefox greeting')
  } catch (e) {
    c.sock.destroy()
    await connectPhone(true)
    c = ff.connect()
    // Silence after a fresh forward: Android froze the app in the background
    // (its debugger queue fills up, adbd logs "Try again").
    await withTimeout(c.ready, 4000, 'Firefox greeting').catch(err => {
      c.sock.destroy()
      throw new Error(`${browser} does not answer: Android freezes it in the background. Ask the user to bring it to the front (and accept a debugging prompt if one shows)`, { cause: err })
    })
  }
  try {
    return await fn(c)
  } finally {
    c.sock.destroy()
  }
}

const tabKey = (tab?: string | number | null) => (tab === undefined || tab === null || tab === '' ? 'rule34' : String(tab))
const TAB_STATE = '({ hidden: document.visibilityState === "hidden", version: (window.__ibh && window.__ibh.version) || null })'

// One tab's answer in inTabs: where it is, plus the fields of the object the
// expression returned (page data, so untyped).
interface TabValue {
  index: number
  url: string
  title: string
  [key: string]: any
}

// A line in the tab for what a tool does there, so the user sees it on the
// phone: in Firefox's console, and in MobiDevTools' panel. MobiDevTools does
// not see the page's console (it hooks console in its own content script),
// only messages posted through its bridge; "pr" is its REPL's answer, shown
// as a result line. Best effort: a tab that cannot take it fails nothing.
async function announce(c: Connection, key: string, what: string) {
  const text = JSON.stringify(`[Claude] ${what.replace(/\s+/g, ' ').slice(0, 200)}`)
  try { await ff.evaluate(c, key, `(console.info(${text}), window.postMessage({ _mdt: 'pr', id: -1, v: ${text} }, '*'), 0)`, 0) } catch (e) { /* the tool goes on */ }
}

// The same expression in every tab whose URL has `match`, by index. The
// expression must return an object (or null): its fields join the tab's.
// With `what`, each tab is told first (announce).
async function inTabs(match: string, expr: string, what?: string): Promise<TabValue[]> {
  return withFirefox(async c => {
    const tabs = await ff.listTabs(c)
    const out: TabValue[] = []
    for (const [i, t] of tabs.entries()) {
      if (match && !t.url.includes(match)) continue
      if (what) await announce(c, String(i), what)
      let value
      try { value = JSON.parse(await ff.evaluate(c, String(i), expr, 0)) } catch (e) { value = { error: errMessage(e) } }
      out.push({ index: i, url: t.url, title: t.title, ...value })
    }
    return out
  })
}

// ─── native Termux: a tmux session outside proot ───
// proot traces every process it runs, which makes builds crawl and keeps
// things away from Termux's own side. Termux's ~/.zshrc starts a detached
// tmux session ("ibh") in every native shell; its socket sits under the
// shared prefix, so Termux's tmux client, run from here, opens windows in
// it whose commands run natively. (A Termux session in the drawer would need
// termux-am, whose socket server this Termux build does not run, or `am`,
// which Android refuses to apps.)

function tmuxSocket(): string | null {
  try {
    const dir = fs.readdirSync(`${TERMUX}/var/run`).find(d => /^tmux-\d+$/.test(d))
    const sock = dir && `${TERMUX}/var/run/${dir}/default`
    return sock && fs.existsSync(sock) ? sock : null
  } catch (e) {
    return null
  }
}

function tmux(...args: string[]) {
  const sock = tmuxSocket()
  if (!sock) throw new Error(`no native tmux server: open a Termux session outside proot (its ~/.zshrc starts "tmux new -d -s ${SESSION}"), or run that command there`)
  return run(`${TERMUX}/bin/tmux`, ['-S', sock, ...args]).trim()
}

function nativeUp() {
  try { tmux('has-session', '-t', SESSION); return true } catch (e) { return false }
}

async function termuxRun({ command = '', cwd, name, keep = true, wait_s = 0 }: { command?: string; cwd?: string; name?: string; keep?: boolean; wait_s?: number }) {
  if (!command) throw new Error('command is required')
  fs.mkdirSync(TERM_DIR, { recursive: true })
  const id = Date.now().toString(36)
  const base = `${TERM_DIR}/${id}`
  const title = String(name || `job-${id}`).replace(/[^\w.-]/g, '_').slice(0, 30)
  // A file run by a login bash: nothing to quote through tmux, and Termux's
  // profile.d is loaded (emcc and the rest on PATH).
  fs.writeFileSync(`${base}.sh`, [
    `cd ${shq(cwd || '/data/data/com.termux/files/home')} || exit 1`,
    `echo "[ibh job ${id}] $(date +%T)"`,
    `{ ${command}\n} 2>&1 | tee ${base}.log`,
    'code=${PIPESTATUS[0]}',
    `echo "$code" > ${base}.done`,
    `echo "[ibh job ${id} finished: exit $code]"`,
    keep ? 'exec bash -l' : '',
  ].join('\n') + '\n')
  tmux('new-window', '-d', '-t', SESSION, '-n', title, `bash -l ${base}.sh`)
  if (!wait_s) {
    return `native job ${id} running in tmux window "${title}" (to watch: \`tmux attach -t ${SESSION}\` in a Termux session, Ctrl+b n to switch windows); termux_job id=${id} for its output`
  }
  const end = Date.now() + wait_s * 1000
  while (Date.now() < end && !fs.existsSync(`${base}.done`)) await sleep(500)
  return termuxJob({ id })
}

function termuxJob({ id, lines = 40 }: { id?: string; lines?: number } = {}) {
  if (!id) {
    const jobs = (fs.existsSync(TERM_DIR) ? fs.readdirSync(TERM_DIR) : []).filter(f => f.endsWith('.sh'))
      .map(f => f.slice(0, -3)).sort().reverse().slice(0, 10)
    if (!jobs.length) return 'no native jobs yet'
    return jobs.map(j => {
      const done = fs.existsSync(`${TERM_DIR}/${j}.done`) ? `exit ${fs.readFileSync(`${TERM_DIR}/${j}.done`, 'utf8').trim()}` : 'running'
      const cmd = (fs.readFileSync(`${TERM_DIR}/${j}.sh`, 'utf8').split('\n')[2] || '').replace(/^\{ /, '').slice(0, 80)
      return `${j}  ${done.padEnd(8)}  ${cmd}`
    }).join('\n')
  }
  const log = `${TERM_DIR}/${id}.log`
  if (!fs.existsSync(`${TERM_DIR}/${id}.sh`)) throw new Error(`no native job ${id}`)
  const done = fs.existsSync(`${TERM_DIR}/${id}.done`) ? `finished, exit ${fs.readFileSync(`${TERM_DIR}/${id}.done`, 'utf8').trim()}` : 'still running'
  const out = fs.existsSync(log) ? tail(fs.readFileSync(log, 'utf8'), Math.min(400, Number(lines) || 40)) : '(no output yet)'
  return clip(`job ${id}: ${done}\n${out}`)
}

// ─── the userscript's own code, reused: the MP4 reader and the decoder rules ───

// What scriptParts() hands out, as the userscript defines it (mp4Boxes,
// mp4Child, mp4VideoTrack, avcConfig, pastDecoder there). The code comes
// from the script's text, so these types are a promise, not a check.
interface Mp4Box {
  type: string
  start: number
  body: number
  end: number
}

interface Mp4Track {
  timescale: number
  duration: number
  width: number
  height: number
  stsd: Uint8Array
  sampleAt(t: number): number
  timeOf(k: number): number
  keyAtOrBefore(k: number): number
  place(k: number): [number, number] | null   // [offset, size] in the file
}

interface ScriptParts {
  mp4Boxes(b: Uint8Array, start: number, end: number): Iterable<Mp4Box>
  mp4Child(b: Uint8Array, box: { body: number; end: number }, type: string): Mp4Box | null
  mp4VideoTrack(b: Uint8Array, moov: { body: number; end: number }): Mp4Track | null
  avcConfig(stsd: Uint8Array): Uint8Array | null
  pastDecoder(w: number, h: number): boolean
}

function scriptParts(): ScriptParts {
  const src = fs.readFileSync(path.join(REPO, SCRIPT), 'utf8')
  const cut = (from: string, to: string) => {
    const i = src.indexOf(from)
    const j = src.indexOf(to, i)
    if (i < 0 || j < 0) throw new Error(`cannot find "${from.trim()}" in ${SCRIPT}`)
    return src.slice(i, j)
  }
  const mp4 = cut('  // MP4 boxes between start and end', '  // A minimal MP4 around the keyframes')
  const avc = cut('  // The decoder configuration (avcC) of an H.264 track', '  async function showReelWasm')
  const past = (src.match(/const pastDecoder = [^\n]+/) || ['const pastDecoder = (w, h) => Math.max(w, h) > 1920 || Math.min(w, h) > 1088'])[0]
  return new Function(`${mp4}${avc}${past}\nreturn { mp4Boxes, mp4Child, mp4VideoTrack, avcConfig, pastDecoder }`)()
}

// A byte range of a file, as the site's own pages would ask for it.
function rangeGet(url: string, start: number, end: number) {
  return new Promise<{ buf: Uint8Array; total: number }>((resolve, reject) => {
    const req = https.get(url, { headers: { Range: `bytes=${start}-${end}`, Referer: SITE_REFERER, 'User-Agent': 'Mozilla/5.0 (Android 16; Mobile; rv:158.0) Gecko/158.0 Firefox/158.0' } }, res => {
      if (res.statusCode !== 206 && res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return }
      const chunks: Buffer[] = []
      res.on('data', (d: Buffer) => chunks.push(d))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const m = /\/(\d+)$/.exec(res.headers['content-range'] || '')
        resolve({ buf: new Uint8Array(buf.buffer, buf.byteOffset, buf.length), total: m ? Number(m[1]) : buf.length })
      })
    })
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error(`timeout reading ${url}`)))
  })
}

// The file of a post, from its page, read in the user's logged-in tab.
async function postFileUrl(post: string): Promise<string> {
  if (!/^\d+$/.test(post)) throw new Error('post must be a number')
  const expr = `(async () => {
    const html = await (await fetch('/index.php?page=post&s=view&id=${post}', { credentials: 'same-origin' })).text()
    const m = html.match(/<source[^>]+src="([^"]+)"/) || html.match(/href="([^"]+)"[^>]*>\\s*Original image/i)
    return m ? m[1].replace(/&amp;/g, '&') : null
  })()`
  const url = JSON.parse(await evalTool({ expression: expr, await: true, timeout_ms: 20000 }))
  if (!url) throw new Error(`post ${post}: no file link on its page`)
  return url
}

// A video, by post id or file URL; scenes: how many a hold asks for.
interface VideoArgs {
  post?: string
  url?: string
  scenes?: number
}

// The MP4's index and video track, read the way the hold slideshow reads it.
async function readIndex({ post, url }: VideoArgs) {
  let src = url || (post ? await postFileUrl(String(post)) : null)
  if (!src) throw new Error('give a post id or a file url')
  src = src.replace('://api-cdn-mp4.rule34.xxx/', '://api-cdn.rule34.xxx/')   // the fast host: rangeGet sends the Referer
  const parts = scriptParts()
  const head = await rangeGet(src, 0, (1 << 20) - 1)
  const total = head.total
  const boxes: string[] = []
  let p = 0
  let moov: { at: number; size: number } | null = null
  for (let i = 0; p < total && i < 32 && !moov; i++) {
    const h = p + 16 <= head.buf.length ? head.buf.subarray(p, p + 16) : (await rangeGet(src, p, Math.min(total, p + 16) - 1)).buf
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
    let size = dv.getUint32(0)
    const type = String.fromCharCode(...h.subarray(4, 8))
    if (size === 1) size = Number(dv.getBigUint64(8))
    else if (size === 0) size = total - p
    if (size < 8) break
    boxes.push(type)
    if (type === 'moov') moov = { at: p, size }
    p += size
  }
  if (!moov) throw new Error(`no moov box (top level: ${boxes.join(', ') || 'none'}): not an MP4, maybe WebM`)
  const mb = moov.at + moov.size <= head.buf.length ? head.buf.subarray(moov.at, moov.at + moov.size)
    : (await rangeGet(src, moov.at, moov.at + moov.size - 1)).buf
  const body = new DataView(mb.buffer, mb.byteOffset).getUint32(0) === 1 ? 16 : 8
  const track = parts.mp4VideoTrack(mb, { body, end: mb.length })
  if (!track) throw new Error('no video track')
  // Sample and keyframe counts, from the same tables (stsz, stss).
  let count = 0
  let sync: number[] | null = null
  for (const trak of parts.mp4Boxes(mb, body, mb.length)) {
    if (trak.type !== 'trak') continue
    const mdia = parts.mp4Child(mb, trak, 'mdia')
    const hdlr = mdia && parts.mp4Child(mb, mdia, 'hdlr')
    if (!mdia || !hdlr || String.fromCharCode(...mb.subarray(hdlr.body + 8, hdlr.body + 12)) !== 'vide') continue
    const minf = parts.mp4Child(mb, mdia, 'minf')
    const stbl = minf && parts.mp4Child(mb, minf, 'stbl')
    const stsz = stbl && parts.mp4Child(mb, stbl, 'stsz')
    if (!stbl || !stsz) break   // not reached: mp4VideoTrack found these in this track
    const dv = new DataView(mb.buffer, mb.byteOffset, mb.byteLength)
    count = dv.getUint32(stsz.body + 8)
    const stss = parts.mp4Child(mb, stbl, 'stss')
    if (stss) {
      sync = []
      for (let i = 0, n = dv.getUint32(stss.body + 4); i < n; i++) sync.push(dv.getUint32(stss.body + 8 + i * 4) - 1)
    }
    break
  }
  return {
    src, total, moov, boxes, track, parts, count,
    sync: sync || Array.from({ length: count }, (_, i) => i),
    entry: String.fromCharCode(...track.stsd.subarray(20, 24)),   // the sample entry: avc1, hvc1, vp09…
    avcC: parts.avcConfig(track.stsd),
  }
}

type VideoIndex = Awaited<ReturnType<typeof readIndex>>

// The scenes a hold would ask for: the panel's jump (slideStep), from the tab when it answers.
async function sceneCount(scenes?: number) {
  if (scenes) return Math.max(2, Math.min(40, Number(scenes)))
  try {
    const step = Number(JSON.parse(await withFirefox(c => ff.evaluate(c, 'rule34', 'window.__ibh && window.__ibh.cfg.slideStep', 0))))
    if (step > 0) return Math.max(2, Math.round(100 / step))
  } catch (e) { /* no tab: the default */ }
  return 10
}

// What the hold slideshow will do with this video, by the userscript's rules.
function slidePlan(ix: VideoIndex, n: number) {
  const { track, parts } = ix
  const secs = track.duration / track.timescale
  const keys: number[] = []
  for (let i = 0; i < n; i++) {
    const k = track.keyAtOrBefore(track.sampleAt(Math.floor((i / n) * track.duration)))
    if (!keys.includes(k)) keys.push(k)
  }
  const past = parts.pastDecoder(track.width, track.height)
  const frames = keys.map(k => {
    const at = track.place(k)
    if (!at) throw new Error(`keyframe ${k} is past the file's chunk table`)
    return at
  })
  const bytes = ix.moov.size + frames.reduce((s, f) => s + f[1], 0)
  let plan
  if (keys.length < Math.min(n, 3) && !past) {
    plan = secs <= 30 ? `plays muted at 2× (only ${keys.length} keyframe(s) for ${n} scenes)` : `seeks the file (only ${keys.length} keyframes for ${n} scenes)`
  } else {
    plan = `${ix.avcC ? 'WebAssembly reel' : '<video> reel (no avcC: not H.264)'} of ${keys.length} scenes, reading ${kb(bytes)} (index ${kb(ix.moov.size)} + keyframes ${kb(bytes - ix.moov.size)})`
  }
  return { keys, frames, plan, past, secs }
}

// The decoder's exports (wasm/h264dec.c): pointers and sizes are numbers.
interface H264 {
  memory: WebAssembly.Memory
  _initialize?: () => void
  buf_alloc(n: number): number
  buf_free(p: number): void
  dec_open(extra: number, size: number): number
  dec_frame(data: number, size: number, maxW: number): number
  dec_width(): number
  dec_height(): number
  dec_rgba(): number
  dec_decode_us(): number
  dec_convert_us(): number
}

let nodeDecoder: H264 | null = null   // the WebAssembly decoder in Node, for reel_preview

async function h264(): Promise<H264> {
  if (nodeDecoder) return nodeDecoder
  const mod = await WebAssembly.compile(fs.readFileSync(path.join(REPO, 'wasm', 'h264dec.wasm')))
  let mem: WebAssembly.Memory | null = null
  const view = () => {
    if (!mem) throw new Error('the decoder called out before it was ready')
    return new DataView(mem.buffer)
  }
  const calls: Record<string, (...args: number[]) => number> = {
    fd_write: (fd, iov, count, written) => {
      let n = 0
      for (let i = 0; i < count; i++) n += view().getUint32(iov + i * 8 + 4, true)
      view().setUint32(written, n, true)
      return 0
    },
    environ_sizes_get: (count, size) => { view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0 },
    clock_time_get: (id, precision, out) => { view().setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true); return 0 },
    proc_exit: code => { throw new Error(`decoder exited (${code})`) },
  }
  const imports: WebAssembly.Imports = {}
  for (const imp of WebAssembly.Module.imports(mod)) {
    const forModule = imports[imp.module] || {}
    forModule[imp.name] = calls[imp.name] || (() => 0)
    imports[imp.module] = forModule
  }
  const x = (await WebAssembly.instantiate(mod, imports)).exports as unknown as H264
  mem = x.memory
  if (x._initialize) x._initialize()
  nodeDecoder = x
  return x
}

// ─── tools: phone and browser ───

async function status() {
  const rows = []
  const shizuku = await shizukuUp()
  rows.push(`Shizuku (rish): ${shizuku ? 'running (one session kept open)' : 'not running (the user starts it in the Shizuku app; adb still works if connected)'}`)
  const wifi = shizuku ? await wirelessDebugging() : null
  rows.push(`Wireless debugging: ${wifi === null ? 'unknown (needs Shizuku)' : wifi ? 'on' : 'off (ask the user to turn it on; never with settings put)'}`)
  const serial = adbSerial()
  rows.push(`adb: ${serial ? `connected (${serial})` : 'no device'}`)
  const tabs = await firefoxTabs()
  rows.push(`Firefox debugger (tcp:${ff.PORT}): ${tabs ? `answering, ${tabs.length} tab(s)` : 'not reachable (the connect tool sets it up)'}`)
  rows.push(`Native Termux (tmux "${SESSION}"): ${nativeUp() ? 'up: termux_run works' : 'down (any new Termux session starts it, through its ~/.zshrc)'}`)
  return rows.join('\n')
}

async function tabsTool({ details = true }: { details?: boolean } = {}) {
  const tabs: TabValue[] = details ? await inTabs('', TAB_STATE) : (await withFirefox(c => ff.listTabs(c))).map((t, i) => ({ index: i, url: t.url, title: t.title }))
  return tabs.map(t => `${t.index}  ${t.version ? `v${t.version} ` : ''}${t.hidden ? '(hidden) ' : t.hidden === false ? '(visible) ' : ''}${(t.title || '').slice(0, 40)}  ${t.url}`).join('\n') || 'no tabs'
}

// With `await`, the expression runs in an async function and the result is
// collected by polling: the protocol's evaluate does not wait for promises.
async function evalTool({ tab, expression = '', await: wait = false, timeout_ms = 15000 }: { tab?: string | number; expression?: string; await?: boolean; timeout_ms?: number }) {
  if (!expression) throw new Error('expression is required')
  const key = tabKey(tab)
  return withFirefox(async c => {
    await announce(c, key, `eval${wait ? ' (await)' : ''}: ${expression}`)
    if (!wait) return clip(await ff.evaluate(c, key, expression))
    const slot = JSON.stringify(`__mcp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)
    await ff.evaluate(c, key, `(window[${slot}] = { pending: true }, (async () => (${expression}))().then(` +
      `v => { window[${slot}] = { value: v === undefined ? 'undefined' : JSON.stringify(v, null, 2) } }, ` +
      `e => { window[${slot}] = { error: String((e && e.message) || e) } }), 'started')`)
    const end = Date.now() + timeout_ms
    for (;;) {
      await sleep(200)
      const raw = await ff.evaluate(c, key, `window[${slot}]`, 0)
      if (raw === 'undefined') throw new Error('the page navigated away before the result came back')
      const state = JSON.parse(raw)
      if (!state.pending) {
        await ff.evaluate(c, key, `delete window[${slot}]`)
        if (state.error) throw new Error(state.error)
        return clip(String(state.value))
      }
      if (Date.now() > end) throw new Error(`still pending after ${timeout_ms} ms`)
    }
  })
}

async function reloadTabs({ match = 'rule34', only_hidden = true, except_version = null }: { match?: string; only_hidden?: boolean; except_version?: string | null }) {
  const tabs = await inTabs(match, TAB_STATE)
  if (!tabs.length) return `no tab matches "${match}"`
  const report = []
  for (const t of tabs) {
    const label = `${t.index} v${t.version || '?'} ${t.url}`
    if (except_version && t.version === except_version) { report.push(`${label}: already on ${except_version}`); continue }
    if (only_hidden && !t.hidden) { report.push(`${label}: visible, left alone (ask the user to refresh it)`); continue }
    await withFirefox(async c => { await announce(c, String(t.index), 'reloading this tab'); return ff.evaluate(c, String(t.index), 'location.reload()') })
    report.push(`${label}: reload requested${t.hidden ? ' (a hidden tab reloads when shown)' : ''}`)
  }
  return report.join('\n')
}

async function openUrl({ url = '', package: pkg = browser }: { url?: string; package?: string }) {
  if (!/^https?:\/\/[^\s'"\\]+$/.test(url)) throw new Error('url must be http(s) without spaces or quotes')
  if (!/^[\w.]+$/.test(pkg)) throw new Error('bad package name')
  return phoneShell(`am start -a android.intent.action.VIEW -d '${url}' ${pkg}`)   // a promise: callers await it
}

async function firefoxPref({ name = '', action = 'get', value }: { name?: string; action?: PrefAction; value?: unknown }) {
  if (!/^[\w.@-]+$/.test(name)) throw new Error('name must be a preference name, like media.av1.enabled')
  if (action === 'set' && value === undefined) throw new Error('set needs a value (boolean, number or string)')
  const r = await withFirefox(c => ff.pref(c, name, action, value))
  const show = (v: unknown) => (v === null ? '(not set)' : JSON.stringify(v))
  return action === 'get' ? `${name} = ${show(r.before)}`
    : `${name}: ${show(r.before)} → ${show(r.after)}${action === 'set' ? ' (stays across restarts; firefox_pref action=clear puts the default back)' : ''}`
}

// An image block for the reply: a JPEG through ffmpeg (a fraction of the
// PNG), or the file as it is when ffmpeg is missing.
function imageResult(file: string, label: string): [Content, Content] {
  const when = new Date(fs.statSync(file).mtimeMs).toLocaleString('pt-BR')
  let data: Buffer
  let mimeType = 'image/jpeg'
  try {
    data = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', '-'], { timeout: 30000, maxBuffer: 64e6 })
  } catch (e) {
    data = fs.readFileSync(file)
    mimeType = file.endsWith('.png') ? 'image/png' : 'image/jpeg'
  }
  return [{ type: 'text', text: `${label}: ${file} (${when})` }, { type: 'image', data: data.toString('base64'), mimeType }]
}

async function screenshot() {
  await phoneShell(`screencap -p ${SHOT}`)
  return imageResult(SHOT, 'screen now')
}

function latestScreenshot() {
  const files = fs.readdirSync(SCREENSHOTS).filter(f => /\.(png|jpe?g|webp)$/i.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(SCREENSHOTS, f)).mtimeMs })).sort((a, b) => b.t - a.t)
  const newest = files[0]
  if (!newest) throw new Error(`no screenshots in ${SCREENSHOTS}`)
  return imageResult(path.join(SCREENSHOTS, newest.f), 'newest screenshot')
}

// A few seconds of the screen, as one contact sheet: for what moves
// (a slideshow, a swipe, an animation), where a screenshot shows one instant.
async function screenRecord({ seconds = 5, fps = 2 }: { seconds?: number; fps?: number } = {}) {
  const s = Math.max(1, Math.min(15, Math.round(Number(seconds) || 5)))
  const rate = Math.max(1, Math.min(5, Number(fps) || 2))
  await phoneShell(`screenrecord --time-limit ${s} --bit-rate 6000000 ${RECORDING}`, (s + 20) * 1000)
  fs.mkdirSync(WORK, { recursive: true })
  const sheet = path.join(WORK, 'recording.jpg')
  const n = s * rate
  const cols = Math.min(5, n)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', RECORDING, '-vf', `fps=${rate},scale=216:-2,tile=${cols}x${Math.ceil(n / cols)}:padding=4`, '-frames:v', '1', '-q:v', '4', sheet], { timeout: 60000 })
  const out = imageResult(sheet, `${s} s of the screen at ${rate} frames/s, left to right (video: ${RECORDING})`)
  return out
}

// Touches and keys on the phone, through Android's `input`.
async function inputTool({ action, x, y, x2, y2, ms, key = '', text }: { action?: string; x?: number; y?: number; x2?: number; y2?: number; ms?: number; key?: string; text?: string }) {
  const int = (v: unknown, what: string) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n) || n < 0 || n > 10000) throw new Error(`${what} must be a screen coordinate or a duration`)
    return n
  }
  let cmd
  if (action === 'tap') cmd = `input tap ${int(x, 'x')} ${int(y, 'y')}`
  else if (action === 'long_press') cmd = `input swipe ${int(x, 'x')} ${int(y, 'y')} ${int(x, 'x')} ${int(y, 'y')} ${int(ms || 800, 'ms')}`
  else if (action === 'swipe') cmd = `input swipe ${int(x, 'x')} ${int(y, 'y')} ${int(x2, 'x2')} ${int(y2, 'y2')} ${int(ms || 300, 'ms')}`
  else if (action === 'key') {
    if (!/^(KEYCODE_)?[A-Z0-9_]+$/.test(key)) throw new Error('key must be a key code, like BACK, HOME or KEYCODE_VOLUME_UP')
    cmd = `input keyevent ${key.startsWith('KEYCODE_') ? key : `KEYCODE_${key}`}`
  } else if (action === 'text') {
    if (typeof text !== 'string' || !text) throw new Error('text is required')
    cmd = `input text ${shq(text.replace(/ /g, '%s'))}`
  } else throw new Error('action: tap, long_press, swipe, key or text')
  await phoneShell(cmd, 30000)
  return `done: ${cmd} (screen size: ${(await phoneShell('wm size')).replace(/^Physical size: /, '')})`
}

async function logcat({ filter = '', lines = 80, since_s = 0 }: { filter?: string; lines?: number; since_s?: number } = {}) {
  const re = filter ? new RegExp(filter, 'i') : null
  const now = new Date()
  const from = since_s > 0 ? now.getTime() - since_s * 1000 : 0
  const year = now.getFullYear()
  const out = (await phoneShell('logcat -d -t 20000', 60000)).split('\n').filter(l => {
    if (re && !re.test(l)) return false
    if (!from) return true
    const m = /^(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d+)/.exec(l)
    return m ? new Date(year, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime() >= from : false
  })
  return clip(tail(out.join('\n'), Math.min(1000, Number(lines) || 80)) || '(no matching lines)')
}

// Which apps take a link (what an intent would open), or which are installed.
async function apps({ url, mime = 'video/*', filter }: { url?: string; mime?: string; filter?: string }) {
  if (url) {
    if (!/^[a-z]+:\/\/[^\s'"]+$/i.test(url)) throw new Error('url must be a link without spaces or quotes')
    if (!/^[\w*.+/-]+$/.test(mime)) throw new Error('bad MIME type')
    const out = await phoneShell(`cmd package query-activities --brief -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d '${url}' -t '${mime}'`)
    const found = out.split('\n').map(l => l.trim()).filter(l => /^[\w.]+\/[\w.$]+$/.test(l))
    return found.length ? `${found.length} app(s) open ${mime} links like this:\n${found.join('\n')}` : out
  }
  const list = (await phoneShell(`pm list packages ${filter ? shq(filter) : ''}`)).split('\n').map(l => l.replace(/^package:/, '').trim()).filter(Boolean)
  const rows = []
  for (const p of list.slice(0, 30)) {
    let version = ''
    try { version = ((await phoneShell(`dumpsys package ${p} 2>/dev/null | grep -m1 versionName`)).split('=')[1] || '').trim() } catch (e) { /* none */ }
    rows.push(`${p}${version ? `  ${version}` : ''}`)
  }
  return rows.join('\n') + (list.length > 30 ? `\n… and ${list.length - 30} more` : '')
}

async function device() {
  const rows = []
  const battery = await phoneShell('dumpsys battery')
  const get = (k: string) => ((battery.match(new RegExp(`^\\s*${k}: (.+)$`, 'm')) || [])[1] || '').trim()
  rows.push(`battery: ${get('level')}%, ${Number(get('temperature')) / 10} °C, ${get('status') === '2' ? 'charging' : 'not charging'}${get('AC powered') === 'true' ? ' (AC)' : get('USB powered') === 'true' ? ' (USB)' : ''}`)
  try { rows.push(`thermal: ${(await phoneShell('dumpsys thermalservice 2>/dev/null | grep -m1 -i "thermal status"')).trim()}`) } catch (e) { /* not reported */ }
  const mem = fs.readFileSync('/proc/meminfo', 'utf8')
  const mb = (k: string) => Math.round(Number((mem.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0) / 1024)
  rows.push(`memory: ${mb('MemAvailable')} MB free of ${mb('MemTotal')} MB`)
  try {
    // The per-process list only (the sections after it repeat the same processes).
    const all = await phoneShell('dumpsys meminfo', 60000)
    const at = all.search(/Total (PSS|RSS) by process:/)
    const section = at < 0 ? '' : all.slice(at).split(/\n\s*\n/)[0] ?? ''
    const procs = section.split('\n').filter(l => l.includes(browser))
      .map(l => Number(((l.match(/([\d,]+)K:/) || [])[1] || '0').replace(/,/g, '')))
    rows.push(`${browser}: ${Math.round(procs.reduce((a, b) => a + b, 0) / 1024)} MB (${/PSS/.test(section) ? 'PSS' : 'RSS'}) in ${procs.length} process(es)`)
  } catch (e) { /* not reported */ }
  try {
    const st = fs.statfsSync('/sdcard')
    rows.push(`storage: ${Math.round((st.bavail * st.bsize) / 1e9)} GB free`)
  } catch (e) { /* not reported */ }
  return rows.join('\n')
}

// ─── tools: the userscript ───

async function scriptLog({ tab, filter = '', levels = null, last = 40 }: { tab?: string | number; filter?: string; levels?: string[] | null; last?: number }) {
  const expr = `(() => {
    if (!window.__ibh) return null
    const re = ${JSON.stringify(filter)} ? new RegExp(${JSON.stringify(filter)}, 'i') : null
    const levels = ${JSON.stringify(levels)}
    const lines = window.__ibh.log().filter(e => (!levels || levels.includes(e.level)) && (!re || re.test(e.msg)))
      .slice(-${Math.max(1, Math.min(250, Number(last) || 40))})
      .map(e => new Date(e.t).toTimeString().slice(0, 8) + ' ' + e.level.padEnd(5) + ' ' + e.msg)
    return { version: window.__ibh.version, url: location.href, lines }
  })()`
  const raw = await withFirefox(async c => { await announce(c, tabKey(tab), 'reading the script log'); return ff.evaluate(c, tabKey(tab), expr, 0) })
  const out = JSON.parse(raw)
  if (!out) return 'window.__ibh is missing in that tab: the script is not running there'
  return clip(`v${out.version} · ${out.url}\n${out.lines.join('\n') || '(no matching lines)'}`)
}

// Firefox's own console for a tab, through the debugger: what the page and
// the script wrote (console.*) and the page's errors, hidden tabs included.
async function consoleTool({ tab, filter = '', levels = null, last = 40 }: { tab?: string | number; filter?: string; levels?: string[] | null; last?: number }) {
  const re = filter ? new RegExp(filter, 'i') : null
  const key = tabKey(tab)
  const lines = await withFirefox(async c => { await announce(c, key, 'reading the console'); return ff.consoleMessages(c, key) })
  const picked = lines.filter(l => (!levels || levels.includes(l.level)) && (!re || re.test(l.text)) && !l.text.startsWith('[Claude] reading the console'))
    .slice(-Math.max(1, Math.min(500, Number(last) || 40)))
  return clip(picked.map(l => `${new Date(l.time).toTimeString().slice(0, 8)} ${l.level.padEnd(5)} ${l.text}`).join('\n') || '(no matching messages)')
}

// ─── tools: CSS ───

// Layout properties shown when none are asked for.
const CSS_PROPS = ['display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'width', 'height', 'margin', 'padding',
  'background-color', 'color', 'border', 'opacity', 'visibility', 'overflow', 'transform', 'font-size', 'text-align']

// Runs in the page: the elements matching a selector, each with its box,
// computed style and the rules that match it, in stylesheet order (later
// wins at equal specificity and importance), with where each rule comes
// from. With shadow, the script's open shadow roots (panel, modal) too.
// No selector: the stylesheets themselves.
const CSS_PROBE = `(selector, props, shadow, max, withRules) => {
  const roots = [document]
  if (shadow) for (const h of document.querySelectorAll('*')) if (h.shadowRoot) roots.push(h.shadowRoot)
  const label = (sheet, root) => {
    if (sheet.href) return sheet.href.replace(location.origin, '')
    const n = sheet.ownerNode
    if (root !== document) return 'script shadow <style>'
    if (n && n.dataset && n.dataset.ibh) return 'script <style data-ibh>'
    if (n && n.id === 'ibh-mcp-css') return 'try_css <style>'
    return 'inline <style>'
  }
  const readable = sheet => { try { return sheet.cssRules } catch (e) { return null } }
  if (!selector) {
    return roots.flatMap(root => [...root.styleSheets].map(sh => {
      const rules = readable(sh)
      return label(sh, root) + ': ' + (rules ? rules.length + ' rules' : 'unreadable (another origin)') + (sh.media.mediaText ? ' @media ' + sh.media.mediaText : '') + (sh.disabled ? ' (disabled)' : '')
    }))
  }
  const desc = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
    (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).join('.') : '')
  const found = roots.flatMap(root => [...root.querySelectorAll(selector)].map(el => ({ el, root })))
  const out = found.slice(0, max).map(({ el, root }) => {
    const cs = getComputedStyle(el)
    const b = el.getBoundingClientRect()
    const item = {
      element: desc(el) + (root !== document ? ' (in the script shadow DOM)' : ''),
      box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)].join(' ') + ' (x y w h, css px)',
      computed: Object.fromEntries(props.map(p => [p, cs.getPropertyValue(p)])),
    }
    if (withRules) {
      const rules = []
      const walk = (list, src, media) => {
        for (const r of list) {
          if (r.cssRules && !r.selectorText) {   // @media, @supports, @layer: look inside
            const cond = r.media ? r.media.mediaText : r.conditionText || ''
            walk(r.cssRules, src, cond ? (media ? media + ' and ' : '') + cond + (r.media && !matchMedia(r.media.mediaText).matches ? ' (not now)' : '') : media)
            continue
          }
          if (!r.selectorText) continue
          let hit = false
          try { hit = el.matches(r.selectorText) } catch (e) { /* a pseudo-element selector */ }
          if (hit) rules.push(src + (media ? ' @media ' + media : '') + ' :: ' + r.cssText.replace(/\\s+/g, ' ').slice(0, 300))
        }
      }
      for (const sh of root.styleSheets) { const list = readable(sh); if (list) walk(list, label(sh, root), '') }
      if (el.getAttribute('style')) rules.push('style attribute :: ' + el.getAttribute('style').slice(0, 300))
      item.rules = rules
    }
    return item
  })
  return { matched: found.length, shown: out }
}`

async function cssTool({ tab, selector = '', props, shadow = false, max = 3, rules = true }: { tab?: string | number; selector?: string; props?: string[]; shadow?: boolean; max?: number; rules?: boolean }) {
  const key = tabKey(tab)
  const args = [selector, props && props.length ? props : CSS_PROPS, shadow, Math.max(1, Math.min(20, Number(max) || 3)), rules]
  const raw = await withFirefox(async c => {
    await announce(c, key, selector ? `reading the CSS of ${selector}` : 'listing the stylesheets')
    return ff.evaluate(c, key, `(${CSS_PROBE})(...${JSON.stringify(args)})`)
  })
  return clip(raw)
}

// A temporary stylesheet in the tab, to try a fix live before it goes into
// the script: replaced by the next call, gone with clear or a reload. With
// shadow, it goes into the script's shadow roots (panel, modal) instead.
async function tryCss({ tab, css = '', shadow = false, clear = false }: { tab?: string | number; css?: string; shadow?: boolean; clear?: boolean }) {
  if (!clear && !css) throw new Error('css is required (or clear: true)')
  const key = tabKey(tab)
  const expr = `((css, shadow, clear) => {
    const roots = shadow ? [...document.querySelectorAll('*')].filter(h => h.shadowRoot).map(h => h.shadowRoot) : [document.head || document.documentElement]
    let n = 0
    for (const root of roots) {
      let s = root.querySelector('#ibh-mcp-css')
      if (clear) { if (s) { s.remove(); n++ } continue }
      if (!s) { s = document.createElement('style'); s.id = 'ibh-mcp-css'; root.appendChild(s) }
      s.textContent = css
      n++
    }
    return (clear ? 'removed from ' : 'applied to ') + n + (shadow ? ' shadow root(s)' : ' page')
  })(${JSON.stringify(css)}, ${shadow}, ${clear})`
  return withFirefox(async c => {
    await announce(c, key, clear ? 'removing the trial CSS' : `trying CSS: ${css}`)
    return JSON.parse(await ff.evaluate(c, key, expr))
  })
}

const KEY_LINE = /^(slideshow|download|external player|copied|keyframe decoder|storage)/

// A log entry as logSnapshot saves it: [time, level, message].
type LogEntry = [number, string, string]

// Every site tab's whole log, saved to files: the log lives in the page, so
// a reload (a deploy) wipes it.
async function logSnapshot({ match = 'rule34' }: { match?: string } = {}) {
  const tabs = await inTabs(match, 'window.__ibh ? { v: window.__ibh.version, log: window.__ibh.log().map(e => [e.t, e.level, e.msg]) } : null', 'saving the script log')
  fs.mkdirSync(LOGS, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const out = []
  for (const t of tabs) {
    if (!t.log) continue
    const log: LogEntry[] = t.log
    const file = path.join(LOGS, `${stamp}-tab${t.index}-v${t.v}.log`)
    const line = ([ts, level, msg]: LogEntry) => `${new Date(ts).toTimeString().slice(0, 8)} ${level.padEnd(5)} ${msg}`
    fs.writeFileSync(file, `${t.url}\n${log.map(line).join('\n')}\n`)
    const key = log.filter(([, level, msg]) => level === 'error' || level === 'warn' || KEY_LINE.test(msg)).slice(-10)
    out.push(`tab ${t.index} v${t.v}: ${log.length} lines → ${file}${key.length ? `\n  ${key.map(line).join('\n  ')}` : ''}`)
  }
  return out.length ? out.join('\n') : `no tab matching "${match}" runs the script`
}

// The `slideshow (…)` log lines as a table, with medians per method.
async function slideshowStats({ match = 'rule34', saved = false }: { match?: string; saved?: boolean } = {}) {
  const lines = new Set<string>()
  try {
    // In an object: inTabs spreads the answer into the tab's fields, and a
    // spread array would come apart into numbered keys.
    const tabs = await inTabs(match, '({ slides: window.__ibh ? window.__ibh.log().filter(e => /^slideshow \\(/.test(e.msg)).map(e => new Date(e.t).toTimeString().slice(0, 8) + " " + e.msg) : [] })', 'reading the slideshow lines of the log')
    for (const t of tabs) for (const l of t.slides || []) lines.add(l)
  } catch (e) { if (!saved) throw e }
  if (saved && fs.existsSync(LOGS)) {
    for (const f of fs.readdirSync(LOGS)) {
      for (const l of fs.readFileSync(path.join(LOGS, f), 'utf8').split('\n')) {
        const m = /^(\d\d:\d\d:\d\d) \w+\s+(slideshow \(.*)$/.exec(l)
        if (m) lines.add(`${m[1]} ${m[2]}`)
      }
    }
  }
  if (!lines.size) return 'no slideshow lines (hold a video thumbnail first)'
  const num = (s: string, re: RegExp) => { const m = re.exec(s); return m ? Number(m[1]) : null }
  const rows = [...lines].sort().map(l => ({
    time: l.slice(0, 8),
    method: (/slideshow \(([^)]+)\)/.exec(l) || [])[1] ?? '?',
    post: num(l, /post (\d+)/),
    first: num(l, /first after (\d+) ms/) ?? num(l, /playing after (\d+) ms/),
    none: num(l, /no scene in (\d+) ms/),
    gap: num(l, /then every (\d+) ms/),
    late: num(l, /(\d+) late/),
    kept: /kept from before/.test(l),
    read: num(l, /read in (\d+) ms/),
    decode: num(l, /decoded in (\d+) ms/),
    size: (/; (\d+x\d+), (\d+:\d+)/.exec(l) || []).slice(1).join(' '),
    keys: num(l, /(\d+) keyframes/),
    note: (/no reel: ([^;]+)/.exec(l) || [])[1] || '',
  }))
  const table = rows.map(r => [r.time, r.method.padEnd(9), String(r.post).padEnd(9),
    r.none !== null ? `lifted ${r.none} ms` : `first ${r.first} ms${r.kept ? ' (kept)' : ''}`,
    r.gap ? `gap ${r.gap}` : '', r.late ? `${r.late} late` : '', r.size, r.keys ? `${r.keys} keys` : '',
    r.read ? `read ${r.read}` : '', r.decode ? `dec ${r.decode}` : '', r.note].filter(Boolean).join('  ')).join('\n')
  const by: Record<string, typeof rows> = {}
  for (const r of rows) (by[r.method] = by[r.method] || []).push(r)
  const summary = Object.entries(by).map(([m, rs]) => {
    const fresh = rs.flatMap(r => (r.first !== null && !r.kept ? [r.first] : []))
    const kept = rs.flatMap(r => (r.first !== null && r.kept ? [r.first] : []))
    const gaps = rs.flatMap(r => (r.gap ? [r.gap] : []))
    const lifted = rs.filter(r => r.none !== null).length
    return `${m}: ${rs.length} hold(s)${lifted ? `, ${lifted} lifted before the first scene` : ''}` +
      `${fresh.length ? `, first scene median ${median(fresh)} ms` : ''}${kept.length ? ` (kept reels ${median(kept)} ms)` : ''}` +
      `${gaps.length ? `, gap median ${median(gaps)} ms` : ''}`
  }).join('\n')
  return clip(`${summary}\n\n${table}`)
}

// ─── tools: videos and WebAssembly ───

async function videoInfo({ post, url, scenes }: VideoArgs = {}) {
  const ix = await readIndex({ post, url })
  const { track } = ix
  const n = await sceneCount(scenes)
  const plan = slidePlan(ix, n)
  const times = ix.sync.map(k => track.timeOf(k) / track.timescale)
  const gaps = times.slice(1).map((t, i) => t - times[i]!)   // times[i]: the one before t
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : plan.secs
  return [
    `${post ? `post ${post} → ` : ''}${ix.src}`,
    `file: ${(ix.total / 1e6).toFixed(1)} MB, ${ix.entry}${ix.avcC ? ` (avcC ${ix.avcC.length} B)` : ''}, ${track.width}x${track.height}, ` +
      `${plan.secs.toFixed(1)} s, ${ix.count} frames (${(ix.count / plan.secs).toFixed(1)} fps), ${((ix.total * 8) / plan.secs / 1e6).toFixed(1)} Mbit/s`,
    `index: moov ${kb(ix.moov.size)} at byte ${ix.moov.at} (${ix.moov.at < ix.total / 2 ? 'at the start: made for streaming' : 'at the end'}); top level ${ix.boxes.join(', ')}`,
    `keyframes: ${ix.sync.length}, every ${avgGap.toFixed(1)} s on average${gaps.length ? `, longest gap ${Math.max(...gaps).toFixed(1)} s` : ''}`,
    `hardware decoder: ${plan.past ? 'past 1920×1088: the cover stays a poster and the modal decodes on the CPU (▶ VLC plays it better)' : 'within 1920×1088'}`,
    `hold slideshow (${n} scenes): ${plan.plan}`,
  ].join('\n')
}

// What a hold would show: the scene keyframes, decoded by the userscript's
// WebAssembly decoder here in Node, as one contact sheet.
async function reelPreview({ post, url, scenes, width = 360 }: VideoArgs & { width?: number } = {}): Promise<Content[]> {
  const ix = await readIndex({ post, url })
  const avcC = ix.avcC
  if (!avcC) throw new Error(`${ix.entry} is not H.264: the WebAssembly decoder takes avc1/avc3 only`)
  const n = await sceneCount(scenes)
  const plan = slidePlan(ix, n)
  const frames = await Promise.all(plan.frames.map(([off, size]) => rangeGet(ix.src, off, off + size - 1).then(r => r.buf)))
  const x = await h264()
  const put = (bytes: Uint8Array) => { const p = x.buf_alloc(bytes.length); new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes); return p }
  const cfg = put(avcC)
  const opened = x.dec_open(cfg, avcC.length)
  x.buf_free(cfg)
  if (opened !== 0) throw new Error(`the decoder refused the stream (${opened})`)
  const dir = path.join(WORK, 'reel')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const times = []
  for (const [i, bytes] of frames.entries()) {
    const p = put(bytes)
    const r = x.dec_frame(p, bytes.length, Math.max(64, Number(width) || 360))
    x.buf_free(p)
    if (r !== 0) throw new Error(`keyframe ${i} did not decode (${r})`)
    const w = x.dec_width()
    const h = x.dec_height()
    const px = new Uint8Array(x.memory.buffer, x.dec_rgba(), w * h * 4)
    const rgb = Buffer.alloc(w * h * 3)
    // RGBA to RGB; j stays inside px, so px[j + …]! is never undefined.
    for (let j = 0, o = 0; j < px.length; j += 4) { rgb[o++] = px[j]!; rgb[o++] = px[j + 1]!; rgb[o++] = px[j + 2]! }
    fs.writeFileSync(path.join(dir, `f${String(i).padStart(2, '0')}.ppm`), Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), rgb]))
    times.push(`${(ix.track.timeOf(plan.keys[i]!) / ix.track.timescale).toFixed(1)} s: ${kb(bytes.length)}, decode ${(x.dec_decode_us() / 1000).toFixed(0)} ms + convert ${(x.dec_convert_us() / 1000).toFixed(0)} ms`)
  }
  const cols = Math.min(5, frames.length)
  const sheet = path.join(WORK, 'reel.jpg')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(dir, 'f%02d.ppm'),
    '-vf', `tile=${cols}x${Math.ceil(frames.length / cols)}:padding=4`, '-frames:v', '1', '-q:v', '4', sheet], { timeout: 60000 })
  const head = `${post ? `post ${post}: ` : ''}${plan.plan}\n${times.join('\n')}`
  return [{ type: 'text', text: head }, imageResult(sheet, 'the reel, left to right')[1]]
}

// Builds wasm/h264dec.wasm: natively in Termux when its tmux session is up
// (the first build took 12 min there, Emscripten's one-time cache included,
// against ~25 in proot; the .wasm came out byte-identical), else here.
// `job` asks after a build; a native one is copied into wasm/ once done.
async function wasmBuild({ native = true, job }: { native?: boolean; job?: string } = {}) {
  const stage = `${TERMUX}/tmp/ibh-wasm`
  if (job) {
    if (job.startsWith('proot-')) {
      const log = path.join(WORK, `${job}.log`)
      const done = path.join(WORK, `${job}.done`)
      const state = fs.existsSync(done) ? `finished, exit ${fs.readFileSync(done, 'utf8').trim()}` : 'still running'
      return `${job}: ${state}\n${tail(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', 15)}`
    }
    const report = termuxJob({ id: job, lines: 15 })
    const code = fs.existsSync(`${TERM_DIR}/${job}.done`) ? fs.readFileSync(`${TERM_DIR}/${job}.done`, 'utf8').trim() : null
    if (code === '0' && fs.existsSync(`${stage}/src/h264dec.wasm`)) {
      fs.copyFileSync(`${stage}/src/h264dec.wasm`, path.join(REPO, 'wasm', 'h264dec.wasm'))
      nodeDecoder = null
      return `${report}\ncopied into wasm/h264dec.wasm (${kb(fs.statSync(path.join(REPO, 'wasm', 'h264dec.wasm')).size)}); commit it, then point the @resource link at that commit`
    }
    return report
  }
  if (native && nativeUp()) {
    fs.mkdirSync(`${stage}/src`, { recursive: true })
    for (const f of ['build.sh', 'h264dec.c']) fs.copyFileSync(path.join(REPO, 'wasm', f), `${stage}/src/${f}`)
    const started = await termuxRun({ name: 'wasm-build', keep: false, command: `IBH_WASM_CACHE=${stage} bash ${stage}/src/build.sh` })
    return `${started}\nnative build of wasm/h264dec.wasm; wasm_build job=<id> reports it and copies the result into wasm/`
  }
  fs.mkdirSync(WORK, { recursive: true })
  const id = `proot-${Date.now().toString(36)}`
  const log = path.join(WORK, `${id}.log`)
  const done = path.join(WORK, `${id}.done`)
  const child = spawn('bash', ['-c', `bash wasm/build.sh > ${shq(log)} 2>&1; echo $? > ${shq(done)}`], { cwd: REPO, detached: true, stdio: 'ignore' })
  child.unref()
  return `build ${id} started inside proot (the first FFmpeg configure takes ~15 min here); wasm_build job=${id} reports it`
}

// ─── tools: repo checks ───

async function check() {
  const r = await runAsync('npm', ['run', '-s', 'check'], { timeout: 600000 })
  if (r.code !== 0) throw new Error(`npm run check failed:\n${tail(r.out, 40)}`)
  return `npm run check passed\n${tail(r.out, 5)}`
}

async function smoke({ url }: { url?: string } = {}) {
  const r = await runAsync('node', ['tools/smoke.js', ...(url ? [url] : [])], { timeout: 600000 })
  return clip(`${r.code === 0 ? 'smoke test passed' : `smoke test FAILED (exit ${r.code})`}\n${tail(r.out, 30)}`)
}

// ─── deploy ───

function httpsGet(url: string) {
  return new Promise<string>((resolve, reject) => {
    https.get(url, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', d => { body += d })
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode} for ${url}`))))
    }).on('error', reject)
  })
}

// Clicks Violentmonkey's install button, only on the page for this script.
const CLICK_INSTALL = `(() => {
  if (!document.body.innerText.includes('Image Board Helper')) return 'not this script: left alone'
  const buttons = [...document.querySelectorAll('button')]
  const b = buttons.find(x => !x.disabled && /^(confirm|install|reinstall|update|confirmar|instalar|reinstal|atualizar)/i.test(x.textContent.trim()))
  if (!b) return 'no install button: ' + buttons.map(x => x.textContent.trim()).join(' | ')
  b.click()
  return 'clicked ' + b.textContent.trim()
})()`

// The usual ship: the checks, the committed and pushed file, a copy in
// Downloads, the commit-pinned raw link (no CDN or browser cache in the way)
// opened in the connected Firefox, Violentmonkey watched, then every site tab's log
// saved before the hidden ones reload.
async function deploy({ confirm = false, dry_run = false, wait_s = 60, match = 'rule34', skip_check = false }: { confirm?: boolean; dry_run?: boolean; wait_s?: number; match?: string; skip_check?: boolean }) {
  const steps = []
  const git = (...args: string[]) => run('git', ['-C', REPO, ...args]).trim()
  const sha = git('rev-parse', 'HEAD')
  if (git('status', '--porcelain', '--', SCRIPT)) steps.push(`warning: ${SCRIPT} has uncommitted changes; the committed version is what ships`)
  try { git('fetch', '-q', 'origin') } catch (e) { steps.push(`warning: git fetch failed (${firstLine(e)})`) }
  if (!git('branch', '-r', '--contains', sha)) throw new Error(`HEAD ${sha.slice(0, 7)} is not on the remote: push first (the raw link serves pushed commits only)`)
  if (!skip_check) steps.push(await check().then(r => r.split('\n')[0] ?? ''))
  const code = git('show', `HEAD:${SCRIPT}`) + '\n'
  const version = (code.match(/@version\s+(\S+)/) || [])[1]
  const repo = git('remote', 'get-url', 'origin').match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!repo) throw new Error('origin is not a GitHub repository')
  const url = `https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/${sha}/${SCRIPT}`
  const served = (await httpsGet(url)).match(/@version\s+(\S+)/)
  if (!served || served[1] !== version) throw new Error(`the raw link serves ${served ? served[1] : 'no version'}, expected ${version}`)
  steps.push(`raw link serves v${version} (${sha.slice(0, 7)})`)
  if (dry_run) return steps.concat(`dry run: would copy it to /sdcard/Download/${SCRIPT} and open ${url}`).join('\n')

  steps.push(await connectPhone(false))
  // Before anything reloads: the log lives in the page.
  try { steps.push(`logs saved before the update:\n${await logSnapshot({ match })}`) } catch (e) { steps.push(`warning: logs not saved (${firstLine(e)})`) }
  fs.writeFileSync(`/sdcard/Download/${SCRIPT}`, code)
  steps.push(`copied v${version} to /sdcard/Download/${SCRIPT}`)
  await openUrl({ url })
  steps.push(`opened the raw link in ${browser}`)

  // Violentmonkey shows its confirm page on every install and closes it by
  // itself within seconds; one that stays open waits for a tap (or for
  // confirm: true).
  const start = Date.now()
  let seen = 0   // when the confirm page first showed up
  let clicked = false
  let waitingSaid = false
  while (Date.now() - start < wait_s * 1000) {
    await sleep(1500)
    const tabs = await withFirefox(c => ff.listTabs(c))
    const page = tabs.find(t => /^moz-extension:\/\/[^/]+\/confirm\//.test(t.url))
    if (page) {
      seen = seen || Date.now()
      if (Date.now() - seen < 6000) continue
      if (confirm && !clicked) {
        clicked = true
        steps.push(`Violentmonkey confirm page: ${await withFirefox(c => ff.evaluate(c, page.url, CLICK_INSTALL, 0))}`)
      } else if (!confirm && !waitingSaid) {
        waitingSaid = true
        steps.push('Violentmonkey is waiting for confirmation: ask the user to tap it')
      }
      continue
    }
    if (seen || Date.now() - start > 8000) break
  }
  steps.push(!seen ? 'no confirm page seen (installed silently, or still loading)'
    : waitingSaid || clicked ? 'confirm page closed' : 'installed: Violentmonkey closed its page by itself')

  const tabs = await inTabs(match, TAB_STATE)
  for (const t of tabs) {
    if (t.version === version) { steps.push(`tab ${t.index}: on v${version}`); continue }
    if (t.hidden) {
      await withFirefox(async c => { await announce(c, String(t.index), `deploy: reloading this tab for v${version}`); return ff.evaluate(c, String(t.index), 'location.reload()') })
      steps.push(`tab ${t.index}: was v${t.version || '?'}, hidden: reload requested`)
    } else {
      steps.push(`tab ${t.index}: still v${t.version || '?'} and visible: ask the user to refresh it`)
    }
  }
  if (!tabs.length) steps.push(`no tab matches "${match}" to check the version`)
  return steps.join('\n')
}

// ─── the tool list ───

interface Tool {
  name: string
  description: string
  inputSchema: object
  // The arguments arrive as JSON: each tool's parameter type documents them,
  // nothing checks them on the way in.
  run: (args: any) => unknown
}

const str = (description: string) => ({ type: 'string', description })
const num = (description: string) => ({ type: 'number', description })
const bool = (description: string) => ({ type: 'boolean', description })
const obj = (properties: Record<string, object> = {}, required?: string[]) => ({ type: 'object', properties, ...(required ? { required } : {}) })
const TAB = str('tab index or URL substring (default "rule34")')
const VIDEO = { post: str('rule34 post id (its file is read through the logged-in tab)'), url: str('or the file URL') }

const TOOLS: Tool[] = [
  { name: 'status', run: status, inputSchema: obj(),
    description: 'Phone connection status: Shizuku, Wireless debugging, adb, the Firefox debugger forward, the native Termux tmux session. Read only.' },
  { name: 'connect', run: ({ force = false, app }: { force?: boolean; app?: string }) => connectPhone(force, app),
    inputSchema: obj({ force: bool('set up again even if Firefox answers'), app: str('which Firefox: org.mozilla.firefox_beta (Beta), org.mozilla.fenix (Nightly), org.mozilla.firefox; remembered') }),
    description: 'Connects adb over Wireless debugging and forwards a Firefox\'s debugger to tcp:6000: the one last chosen (Beta at first), or `app`. open_url, deploy and device follow it. Other tools call it by themselves. Fails with what to ask the user when Wireless debugging is off.' },
  { name: 'tabs', run: tabsTool, inputSchema: obj({ details: bool('read version and visibility in each tab (default true)') }),
    description: 'Firefox tabs on the phone: index, script version (window.__ibh), visible or hidden, title, URL.' },
  { name: 'eval', run: evalTool,
    inputSchema: obj({ tab: TAB, expression: str('JS expression'), await: bool('wait for a promise result (and allow await)'), timeout_ms: num('with await (default 15000)') }, ['expression']),
    description: 'Evaluates a JS expression in a tab and returns it as JSON. Runs in the page with the user\'s login: only reads unless the user asked for an action. In a hidden tab timers stall (fetch works).' },
  { name: 'reload_tabs', run: reloadTabs,
    inputSchema: obj({ match: str('URL substring (default "rule34")'), only_hidden: bool('default true'), except_version: str('leave tabs on this __ibh.version alone') }),
    description: 'Reloads the tabs whose URL has `match`: only hidden ones by default (the visible one is the user\'s). Wipes their script logs: log_snapshot first.' },
  { name: 'open_url', run: openUrl, inputSchema: obj({ url: str('http(s) link'), package: str('app to open it (default: the connected Firefox)') }, ['url']),
    description: 'Opens a link in the connected Firefox (or another app) on the phone, bringing it to the front. Changes what the user sees: only when the user asked.' },
  { name: 'firefox_pref', run: firefoxPref,
    inputSchema: obj({ name: str('preference, as in about:config'), action: { type: 'string', enum: ['get', 'set', 'clear'], description: 'default get' }, value: { description: 'for set: boolean, number or string' } }, ['name']),
    description: 'Reads, sets or resets a preference of the connected Firefox through the debugger (about:config, reachable even where it is locked). get is read only; set and clear change the user\'s browser for good: only when the user asked, and say how to undo it (clear).' },
  { name: 'screenshot', run: screenshot, inputSchema: obj(),
    description: 'Captures the phone screen now (screencap; touches nothing) and returns it as an image.' },
  { name: 'latest_screenshot', run: latestScreenshot, inputSchema: obj(),
    description: 'The newest screenshot the user took (/sdcard/Pictures/Screenshots), as an image: what "olha screenshot" means.' },
  { name: 'screen_record', run: screenRecord, inputSchema: obj({ seconds: num('1 to 15 (default 5)'), fps: num('frames per second on the sheet, 1 to 5 (default 2)') }),
    description: 'Records the phone screen for a few seconds and returns a contact sheet of frames (left to right), for what moves: a slideshow, a swipe, an animation. Touches nothing.' },
  { name: 'input', run: inputTool,
    inputSchema: obj({ action: { type: 'string', enum: ['tap', 'long_press', 'swipe', 'key', 'text'] }, x: num('x in screen pixels'), y: num('y'), x2: num('swipe end x'), y2: num('swipe end y'), ms: num('duration (long_press default 800, swipe 300)'), key: str('BACK, HOME, ENTER, VOLUME_UP…'), text: str('text to type') }, ['action']),
    description: 'Touches and keys on the phone (Android input): tap, long press (e.g. to hold a video thumbnail), swipe, key, text. Acts on the phone the user is holding: only when the user asked; a screenshot first tells where to touch.' },
  { name: 'logcat', run: logcat, inputSchema: obj({ filter: str('regular expression, case-insensitive'), lines: num('how many (default 80)'), since_s: num('only the last N seconds') }),
    description: 'Android\'s logcat, filtered: app launches (ActivityTaskManager), crashes, what an intent opened. Firefox\'s console is not in it. Read only.' },
  { name: 'apps', run: apps, inputSchema: obj({ url: str('a link: which apps would open it'), mime: str('MIME type for the link (default video/*)'), filter: str('or: installed packages whose name has this') }),
    description: 'Which installed apps take a link (what an intent opens, with BROWSABLE as Firefox asks), or the installed packages matching a name, with versions. Read only.' },
  { name: 'device', run: device, inputSchema: obj(),
    description: 'Battery (level, temperature), thermal status, free memory, the connected Firefox\'s memory, free storage. Read only.' },
  { name: 'script_log', run: scriptLog,
    inputSchema: obj({ tab: TAB, filter: str('regular expression on the message, case-insensitive'), levels: { type: 'array', items: { type: 'string', enum: ['error', 'warn', 'info', 'debug'] } }, last: num('how many lines (default 40, at most 250)') }),
    description: 'Image Board Helper\'s log in a tab (window.__ibh.log()), newest last, with the version and URL.' },
  { name: 'console', run: consoleTool,
    inputSchema: obj({ tab: TAB, filter: str('regular expression on the text, case-insensitive'), levels: { type: 'array', items: { type: 'string', enum: ['error', 'warn', 'info', 'log', 'debug'] } }, last: num('how many lines (default 40, at most 500)') }),
    description: 'Firefox\'s own console for a tab (console.* calls and page errors since the page loaded), read through the debugger: works in hidden tabs, and sees the page\'s console, which MobiDevTools does not. With the panel\'s debug on, the script mirrors its whole log there ([IBH] lines).' },
  { name: 'css', run: cssTool,
    inputSchema: obj({ tab: TAB, selector: str('CSS selector (none: list the stylesheets)'), props: { type: 'array', items: { type: 'string' }, description: 'computed properties to show (default: layout ones: display, position, size, colors, border…)' },
      shadow: bool('also inside the script\'s shadow DOM (panel, modal)'), max: num('elements to show (default 3, at most 20)'), rules: bool('the matching rules, with their source (default true)') }),
    description: 'Reads the CSS of a tab: for each element matching a selector, its box, computed style and every rule that matches it, in stylesheet order, with where each comes from (the site\'s sheet, the script\'s <style data-ibh>, its shadow DOM, a style attribute) and any @media condition. Shows which rule wins and why. Read only; the Firefox must be in front.' },
  { name: 'try_css', run: tryCss,
    inputSchema: obj({ tab: TAB, css: str('CSS to apply (replaces the previous trial)'), shadow: bool('into the script\'s shadow roots (panel, modal) instead of the page'), clear: bool('remove the trial CSS') }),
    description: 'Applies temporary CSS to a tab, to try a fix live before putting it in the script (THEME_CSS and the like): replaced by the next call, removed with clear or by a reload. Changes what the user sees: only when the user asked, and clear it afterwards.' },
  { name: 'log_snapshot', run: logSnapshot, inputSchema: obj({ match: str('site tabs (default "rule34")') }),
    description: 'Saves every site tab\'s whole script log to ~/.cache/ibh-logs and shows its key lines (slideshows, downloads, warnings, errors). deploy does it by itself before reloading anything.' },
  { name: 'slideshow_stats', run: slideshowStats, inputSchema: obj({ match: str('site tabs (default "rule34")'), saved: bool('also the logs saved by log_snapshot and deploy') }),
    description: 'The hold slideshow\'s log lines as a table (method, first scene, gap, late scenes, keyframes, read and decode times), with medians per method.' },
  { name: 'video_info', run: videoInfo, inputSchema: obj({ ...VIDEO, scenes: num('scenes a hold asks for (default: from the panel\'s jump)') }),
    description: 'A post\'s video, from its MP4 index alone (a few Range reads, as the slideshow does): codec, size, frames and fps, bitrate, where the index sits, keyframe count and spacing, whether it fits the hardware decoder, and what the hold slideshow will do with it (reel, play or seek).' },
  { name: 'reel_preview', run: reelPreview, inputSchema: obj({ ...VIDEO, scenes: num('scenes (default: from the panel\'s jump)'), width: num('picture width to decode down to (default 360)') }),
    description: 'Decodes the keyframes a hold would show, with the userscript\'s own WebAssembly decoder (in Node here), and returns them as one contact sheet, with each keyframe\'s size and decode time.' },
  { name: 'wasm_build', run: wasmBuild, inputSchema: obj({ native: bool('in native Termux when its tmux session is up (default true; about twice as fast as proot)'), job: str('a build started before: its state, and for a native one, the result copied into wasm/') }),
    description: 'Builds wasm/h264dec.wasm (FFmpeg\'s H.264 decoder) with wasm/build.sh, in the background: natively in Termux when possible. Then commit the .wasm and point the @resource link at that commit.' },
  { name: 'check', run: check, inputSchema: obj(),
    description: 'npm run check in the repo: syntax, I18N parity, ESLint, and the TypeScript checks of the userscript and of these tools. deploy runs it first.' },
  { name: 'smoke', run: smoke, inputSchema: obj({ url: str('a Gelbooru 0.2 listing (default safebooru)') }),
    description: 'The Playwright smoke test (headless Firefox, the script injected): boot, panel, search bar, eye button, feed, modal, autopager. About a minute, and heavy on the phone\'s memory (Firefox\'s tabs may unload).' },
  { name: 'termux_run', run: termuxRun,
    inputSchema: obj({ command: str('shell command (bash, Termux\'s environment)'), cwd: str('folder (default Termux\'s home)'), name: str('window name'), keep: bool('leave a shell open in the window after it ends (default true)'), wait_s: num('wait up to N seconds for it to end and return its output') }, ['command']),
    description: 'Runs a command natively in Termux, outside proot (faster for builds, each compiler process ~1 s against ~3.6 s; Termux\'s own packages, emcc included), in a new window of the native tmux session "ibh": the user watches it with `tmux attach -t ibh` in a Termux session. Output and exit code through termux_job.' },
  { name: 'termux_job', run: termuxJob, inputSchema: obj({ id: str('job id (none: the recent jobs)'), lines: num('output lines (default 40)') }),
    description: 'A native Termux job\'s state and last output lines, or the list of recent jobs.' },
  { name: 'deploy', run: deploy,
    inputSchema: obj({ confirm: bool('click Violentmonkey\'s install button if it asks (changed grants); default false: wait for the user'), dry_run: bool('check everything without touching the phone'), skip_check: bool('skip npm run check'), wait_s: num('how long to watch the confirm page (default 60)'), match: str('site tabs (default "rule34")') }),
    description: 'Ships the committed, pushed image-board-helper.user.js: npm run check, every site tab\'s log saved, a copy in /sdcard/Download, the commit-pinned raw link opened in the connected Firefox, Violentmonkey watched, hidden site tabs reloaded.' },
]

const INSTRUCTIONS = 'Tools for the user\'s phone (Firefox Beta or Nightly, with Violentmonkey) where Image Board Helper is tested, and for the repo around it. ' +
  'connect app=… picks the Firefox (remembered); a Firefox in the background is frozen by Android and answers nothing until brought to the front. ' +
  'Each tool reconnects by itself. When Wireless debugging is off, ask the user to turn it on: never enable it with `settings put` (it kills Shizuku). ' +
  'open_url, input, firefox_pref (set/clear) and deploy change the phone: use them when the user asked, or for the deploy that follows a change they requested. ' +
  'Leave the visible tab alone; reload only hidden ones; script logs vanish on reload, so log_snapshot before (deploy does). ' +
  'Each tool that works in a tab first writes a "[Claude] …" line there (Firefox\'s console and MobiDevTools), so the user sees it on the phone; console reads that console back. ' +
  'For a video question, video_info reads only its index; reel_preview shows the slideshow\'s frames. Long builds go to termux_run (native, outside proot).'

// ─── JSON-RPC over stdio ───

// A JSON-RPC message from the client: a request (with an id) or a notification.
interface RpcMessage {
  id?: number | string | null
  method?: string
  params?: any
}

const send = (msg: object) => process.stdout.write(`${JSON.stringify(msg)}\n`)

async function handle(msg: RpcMessage) {
  if (msg.id === undefined || msg.id === null) return   // a notification: nothing to answer
  const reply = (result: object) => send({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code: number, message: string) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'phone', version: '2.4.0' },
        instructions: INSTRUCTIONS,
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === (msg.params && msg.params.name))
      if (!tool) return fail(-32602, `unknown tool: ${msg.params && msg.params.name}`)
      try {
        const out = await tool.run((msg.params && msg.params.arguments) || {})
        return reply({ content: Array.isArray(out) ? out : [{ type: 'text', text: String(out) }] })
      } catch (e) {
        // A command's failure carries its stderr; one of ours, its message (a check's output).
        const text = stderrOf(e) ? firstLine(e) : clip(errMessage(e))
        return reply({ content: [{ type: 'text', text: text || 'failed' }], isError: true })
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`)
  }
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return
  let msg: RpcMessage
  try { msg = JSON.parse(line) } catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return }
  handle(msg).catch(e => console.error(e))
}).on('close', () => process.exit(0))
