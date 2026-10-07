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
//   the userscript     script_log, log_snapshot, slideshow_stats, deploy
//   videos and WASM    video_info, reel_preview, wasm_build
//   repo checks        check, smoke
//   native Termux      termux_run, termux_job: windows of a tmux session
//                      outside proot, started by Termux's own ~/.zshrc
//
// The protocol is JSON-RPC 2.0, one message per line on stdin/stdout:
// initialize, tools/list, tools/call. Nothing else may go to stdout.

'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')
const readline = require('readline')
const { execFileSync, spawn } = require('child_process')
const ff = require('./ffrdp')

const REPO = path.resolve(__dirname, '..')
const SCRIPT = 'image-board-helper.user.js'
const BROWSER = 'org.mozilla.firefox_beta'
const SCREENSHOTS = '/sdcard/Pictures/Screenshots'   // where the phone's own screenshots land
const SHOT = '/sdcard/Download/ibh.png'              // where screencap writes; the container reads it too
const RECORDING = '/sdcard/Download/ibh-rec.mp4'
const LOCAL_RISH = path.join(os.homedir(), '.local/bin/rish')
const RISH = fs.existsSync(LOCAL_RISH) ? LOCAL_RISH : 'rish'
const LOGS = path.join(os.homedir(), '.cache', 'ibh-logs')    // log snapshots, taken before every deploy
const WORK = path.join(os.homedir(), '.cache', 'ibh-mcp')     // scratch: frames, wasm build state
const SITE_REFERER = 'https://rule34.xxx/'                    // rule34's fast host serves videos only with it
// Termux's prefix: the same path inside proot and outside it, so files under
// it (tmp, var/run) are shared by both sides.
const TERMUX = '/data/data/com.termux/files/usr'
const TERM_DIR = `${TERMUX}/tmp/ibh-term`   // native jobs: script, log, exit code
const SESSION = 'ibh'                       // the native tmux session (Termux's ~/.zshrc starts it)
const MAX_TEXT = 30000                      // longer results are cut, to keep the reply readable

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const clip = s => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (${s.length - MAX_TEXT} more characters cut)` : s)
const tail = (s, n) => String(s).trim().split('\n').slice(-n).join('\n')
const firstLine = e => String((e && (e.stderr || e.message)) || e).trim().split('\n')[0]
const kb = n => `${Math.round(n / 1024)} KB`
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`   // one shell word
const median = a => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null)

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64e6, ...opts })
}

// For the long ones (checks, builds): the server keeps answering meanwhile.
function runAsync(cmd, args, { cwd = REPO, timeout = 900000, env } = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const add = d => { out += d; if (out.length > 4e6) out = out.slice(-2e6) }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    const timer = setTimeout(() => { child.kill('SIGKILL'); out += `\n(stopped after ${timeout / 1000} s)` }, timeout)
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }) })
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: String(e) }) })
  })
}

function withTimeout(promise, ms, what) {
  let timer
  const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

// ─── the phone: Shizuku (rish) first, the adb connection as a fallback ───

// rish's output lines: warnings can come before or after the answer.
const rishLines = cmd => run(RISH, ['-c', cmd]).split('\n').map(l => l.trim())

// When rish last answered: no need to ask again for a while.
let rishOkAt = 0

// Asked twice before giving up: ColorOS freezes Shizuku's idle process, and
// the first call after that can stumble.
function shizukuUp() {
  for (let i = 0; i < 2; i++) {
    try { if (rishLines('echo ok').includes('ok')) { rishOkAt = Date.now(); return true } } catch (e) { /* once more */ }
  }
  return false
}

function adbSerial() {
  try {
    const device = run('adb', ['devices']).split('\n').slice(1).map(l => l.trim().split(/\s+/)).find(p => p[1] === 'device')
    return device ? device[0] : null
  } catch (e) {
    return null
  }
}

// A shell command on the phone, as uid shell either way. A command that
// should print something and printed nothing runs once more: a Shizuku
// just woken from its freeze can answer empty.
function phoneShell(cmd, timeout = 20000, { expectOutput = true } = {}) {
  if (Date.now() - rishOkAt < 30000 || shizukuUp()) {
    try {
      let out = run(RISH, ['-c', cmd], { timeout }).trim()
      if (!out && expectOutput) out = run(RISH, ['-c', cmd], { timeout }).trim()
      rishOkAt = Date.now()
      return out
    } catch (e) {
      rishOkAt = 0
      if (!adbSerial()) throw e
    }
  }
  const serial = adbSerial()
  if (!serial) throw new Error('Shizuku is not running and adb has no device: ask the user to start Shizuku or turn on Wireless debugging')
  return run('adb', ['-s', serial, 'shell', cmd], { timeout }).trim()
}

// true on, false off, null when it cannot be read (Shizuku down or
// answering something else: then adb gets its try). Read only: turning it
// on with `settings put` restarts adbd and kills Shizuku.
function wirelessDebugging() {
  try {
    const v = rishLines('settings get global adb_wifi_enabled').find(l => l === '0' || l === '1')
    return v === '1' ? true : v === '0' ? false : null
  } catch (e) {
    return null
  }
}

// ─── Firefox: the debugger forward, set up again when it is gone ───

async function firefoxTabs() {
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

async function connectPhone(force) {
  if (!force && await firefoxTabs()) return 'already connected'
  if (wirelessDebugging() === false) {
    throw new Error('Wireless debugging is off. Ask the user to turn it on (Developer options → Wireless debugging); never with `settings put`, which kills Shizuku.')
  }
  const { serial, socket } = ff.setup()
  return `connected to ${serial}, forward tcp:${ff.PORT} -> ${socket}`
}

async function withFirefox(fn) {
  let c = ff.connect()
  try {
    await withTimeout(c.ready, 4000, 'Firefox greeting')
  } catch (e) {
    c.sock.destroy()
    await connectPhone(true)
    c = ff.connect()
    await withTimeout(c.ready, 4000, 'Firefox greeting')
  }
  try {
    return await fn(c)
  } finally {
    c.sock.destroy()
  }
}

const tabKey = tab => (tab === undefined || tab === null || tab === '' ? 'rule34' : String(tab))
const TAB_STATE = '({ hidden: document.visibilityState === "hidden", version: (window.__ibh && window.__ibh.version) || null })'

// The same expression in every tab whose URL has `match`, by index.
async function inTabs(match, expr) {
  return withFirefox(async c => {
    const tabs = await ff.listTabs(c)
    const out = []
    for (const [i, t] of tabs.entries()) {
      if (match && !t.url.includes(match)) continue
      let value
      try { value = JSON.parse(await ff.evaluate(c, String(i), expr, 0)) } catch (e) { value = { error: e.message } }
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

function tmuxSocket() {
  try {
    const dir = fs.readdirSync(`${TERMUX}/var/run`).find(d => /^tmux-\d+$/.test(d))
    const sock = dir && `${TERMUX}/var/run/${dir}/default`
    return sock && fs.existsSync(sock) ? sock : null
  } catch (e) {
    return null
  }
}

function tmux(...args) {
  const sock = tmuxSocket()
  if (!sock) throw new Error(`no native tmux server: open a Termux session outside proot (its ~/.zshrc starts "tmux new -d -s ${SESSION}"), or run that command there`)
  return run(`${TERMUX}/bin/tmux`, ['-S', sock, ...args]).trim()
}

function nativeUp() {
  try { tmux('has-session', '-t', SESSION); return true } catch (e) { return false }
}

async function termuxRun({ command, cwd, name, keep = true, wait_s = 0 }) {
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

function termuxJob({ id, lines = 40 } = {}) {
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

function scriptParts() {
  const src = fs.readFileSync(path.join(REPO, SCRIPT), 'utf8')
  const cut = (from, to) => {
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
function rangeGet(url, start, end) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Range: `bytes=${start}-${end}`, Referer: SITE_REFERER, 'User-Agent': 'Mozilla/5.0 (Android 16; Mobile; rv:158.0) Gecko/158.0 Firefox/158.0' } }, res => {
      if (res.statusCode !== 206 && res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return }
      const chunks = []
      res.on('data', d => chunks.push(d))
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
async function postFileUrl(post) {
  if (!/^\d+$/.test(String(post))) throw new Error('post must be a number')
  const expr = `(async () => {
    const html = await (await fetch('/index.php?page=post&s=view&id=${post}', { credentials: 'same-origin' })).text()
    const m = html.match(/<source[^>]+src="([^"]+)"/) || html.match(/href="([^"]+)"[^>]*>\\s*Original image/i)
    return m ? m[1].replace(/&amp;/g, '&') : null
  })()`
  const url = JSON.parse(await evalTool({ expression: expr, await: true, timeout_ms: 20000 }))
  if (!url) throw new Error(`post ${post}: no file link on its page`)
  return url
}

// The MP4's index and video track, read the way the hold slideshow reads it.
async function readIndex({ post, url }) {
  let src = url || (post ? await postFileUrl(post) : null)
  if (!src) throw new Error('give a post id or a file url')
  src = src.replace('://api-cdn-mp4.rule34.xxx/', '://api-cdn.rule34.xxx/')   // the fast host: rangeGet sends the Referer
  const parts = scriptParts()
  const head = await rangeGet(src, 0, (1 << 20) - 1)
  const total = head.total
  const boxes = []
  let p = 0
  let moov = null
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
  let sync = null
  for (const trak of parts.mp4Boxes(mb, body, mb.length)) {
    if (trak.type !== 'trak') continue
    const mdia = parts.mp4Child(mb, trak, 'mdia')
    const hdlr = mdia && parts.mp4Child(mb, mdia, 'hdlr')
    if (!hdlr || String.fromCharCode(...mb.subarray(hdlr.body + 8, hdlr.body + 12)) !== 'vide') continue
    const stbl = parts.mp4Child(mb, parts.mp4Child(mb, mdia, 'minf'), 'stbl')
    const dv = new DataView(mb.buffer, mb.byteOffset, mb.byteLength)
    const stsz = parts.mp4Child(mb, stbl, 'stsz')
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

// The scenes a hold would ask for: the panel's jump (slideStep), from the tab when it answers.
async function sceneCount(scenes) {
  if (scenes) return Math.max(2, Math.min(40, Number(scenes)))
  try {
    const step = Number(JSON.parse(await withFirefox(c => ff.evaluate(c, 'rule34', 'window.__ibh && window.__ibh.cfg.slideStep', 0))))
    if (step > 0) return Math.max(2, Math.round(100 / step))
  } catch (e) { /* no tab: the default */ }
  return 10
}

// What the hold slideshow will do with this video, by the userscript's rules.
function slidePlan(ix, n) {
  const { track, parts } = ix
  const secs = track.duration / track.timescale
  const keys = []
  for (let i = 0; i < n; i++) {
    const k = track.keyAtOrBefore(track.sampleAt(Math.floor((i / n) * track.duration)))
    if (!keys.includes(k)) keys.push(k)
  }
  const past = parts.pastDecoder(track.width, track.height)
  const frames = keys.map(k => track.place(k))
  const bytes = ix.moov.size + frames.reduce((s, f) => s + f[1], 0)
  let plan
  if (keys.length < Math.min(n, 3) && !past) {
    plan = secs <= 30 ? `plays muted at 2× (only ${keys.length} keyframe(s) for ${n} scenes)` : `seeks the file (only ${keys.length} keyframes for ${n} scenes)`
  } else {
    plan = `${ix.avcC ? 'WebAssembly reel' : '<video> reel (no avcC: not H.264)'} of ${keys.length} scenes, reading ${kb(bytes)} (index ${kb(ix.moov.size)} + keyframes ${kb(bytes - ix.moov.size)})`
  }
  return { keys, frames, plan, past, secs }
}

let nodeDecoder = null   // the WebAssembly decoder in Node, for reel_preview

async function h264() {
  if (nodeDecoder) return nodeDecoder
  const mod = await WebAssembly.compile(fs.readFileSync(path.join(REPO, 'wasm', 'h264dec.wasm')))
  let mem = null
  const view = () => new DataView(mem.buffer)
  const calls = {
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
  const imports = {}
  for (const imp of WebAssembly.Module.imports(mod)) (imports[imp.module] = imports[imp.module] || {})[imp.name] = calls[imp.name] || (() => 0)
  const x = (await WebAssembly.instantiate(mod, imports)).exports
  mem = x.memory
  if (x._initialize) x._initialize()
  nodeDecoder = x
  return x
}

// ─── tools: phone and browser ───

async function status() {
  const rows = []
  const shizuku = shizukuUp()
  rows.push(`Shizuku (rish): ${shizuku ? 'running' : 'not running (the user starts it in the Shizuku app; adb still works if connected)'}`)
  const wifi = shizuku ? wirelessDebugging() : null
  rows.push(`Wireless debugging: ${wifi === null ? 'unknown (needs Shizuku)' : wifi ? 'on' : 'off (ask the user to turn it on; never with settings put)'}`)
  const serial = adbSerial()
  rows.push(`adb: ${serial ? `connected (${serial})` : 'no device'}`)
  const tabs = await firefoxTabs()
  rows.push(`Firefox debugger (tcp:${ff.PORT}): ${tabs ? `answering, ${tabs.length} tab(s)` : 'not reachable (the connect tool sets it up)'}`)
  rows.push(`Native Termux (tmux "${SESSION}"): ${nativeUp() ? 'up: termux_run works' : 'down (any new Termux session starts it, through its ~/.zshrc)'}`)
  return rows.join('\n')
}

async function tabsTool({ details = true } = {}) {
  const tabs = details ? await inTabs('', TAB_STATE) : (await withFirefox(c => ff.listTabs(c))).map((t, i) => ({ index: i, url: t.url, title: t.title }))
  return tabs.map(t => `${t.index}  ${t.version ? `v${t.version} ` : ''}${t.hidden ? '(hidden) ' : t.hidden === false ? '(visible) ' : ''}${(t.title || '').slice(0, 40)}  ${t.url}`).join('\n') || 'no tabs'
}

// With `await`, the expression runs in an async function and the result is
// collected by polling: the protocol's evaluate does not wait for promises.
async function evalTool({ tab, expression, await: wait = false, timeout_ms = 15000 }) {
  if (!expression) throw new Error('expression is required')
  const key = tabKey(tab)
  return withFirefox(async c => {
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

async function reloadTabs({ match = 'rule34', only_hidden = true, except_version = null }) {
  const tabs = await inTabs(match, TAB_STATE)
  if (!tabs.length) return `no tab matches "${match}"`
  const report = []
  for (const t of tabs) {
    const label = `${t.index} v${t.version || '?'} ${t.url}`
    if (except_version && t.version === except_version) { report.push(`${label}: already on ${except_version}`); continue }
    if (only_hidden && !t.hidden) { report.push(`${label}: visible, left alone (ask the user to refresh it)`); continue }
    await withFirefox(c => ff.evaluate(c, String(t.index), 'location.reload()'))
    report.push(`${label}: reload requested${t.hidden ? ' (a hidden tab reloads when shown)' : ''}`)
  }
  return report.join('\n')
}

function openUrl({ url, package: pkg = BROWSER }) {
  if (!/^https?:\/\/[^\s'"\\]+$/.test(url || '')) throw new Error('url must be http(s) without spaces or quotes')
  if (!/^[\w.]+$/.test(pkg)) throw new Error('bad package name')
  return phoneShell(`am start -a android.intent.action.VIEW -d '${url}' ${pkg}`)
}

async function firefoxPref({ name, action = 'get', value }) {
  if (!/^[\w.@-]+$/.test(name || '')) throw new Error('name must be a preference name, like media.av1.enabled')
  if (action === 'set' && value === undefined) throw new Error('set needs a value (boolean, number or string)')
  const r = await withFirefox(c => ff.pref(c, name, action, value))
  const show = v => (v === null ? '(not set)' : JSON.stringify(v))
  return action === 'get' ? `${name} = ${show(r.before)}`
    : `${name}: ${show(r.before)} → ${show(r.after)}${action === 'set' ? ' (stays across restarts; firefox_pref action=clear puts the default back)' : ''}`
}

// An image block for the reply: a JPEG through ffmpeg (a fraction of the
// PNG), or the file as it is when ffmpeg is missing.
function imageResult(file, label) {
  const when = new Date(fs.statSync(file).mtimeMs).toLocaleString('pt-BR')
  let data
  let mimeType = 'image/jpeg'
  try {
    data = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', '-'], { timeout: 30000, maxBuffer: 64e6 })
  } catch (e) {
    data = fs.readFileSync(file)
    mimeType = file.endsWith('.png') ? 'image/png' : 'image/jpeg'
  }
  return [{ type: 'text', text: `${label}: ${file} (${when})` }, { type: 'image', data: data.toString('base64'), mimeType }]
}

function screenshot() {
  phoneShell(`screencap -p ${SHOT}`, 20000, { expectOutput: false })
  return imageResult(SHOT, 'screen now')
}

function latestScreenshot() {
  const files = fs.readdirSync(SCREENSHOTS).filter(f => /\.(png|jpe?g|webp)$/i.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(SCREENSHOTS, f)).mtimeMs })).sort((a, b) => b.t - a.t)
  if (!files.length) throw new Error(`no screenshots in ${SCREENSHOTS}`)
  return imageResult(path.join(SCREENSHOTS, files[0].f), 'newest screenshot')
}

// A few seconds of the screen, as one contact sheet: for what moves
// (a slideshow, a swipe, an animation), where a screenshot shows one instant.
function screenRecord({ seconds = 5, fps = 2 } = {}) {
  const s = Math.max(1, Math.min(15, Math.round(Number(seconds) || 5)))
  const rate = Math.max(1, Math.min(5, Number(fps) || 2))
  phoneShell(`screenrecord --time-limit ${s} --bit-rate 6000000 ${RECORDING}`, (s + 20) * 1000, { expectOutput: false })
  fs.mkdirSync(WORK, { recursive: true })
  const sheet = path.join(WORK, 'recording.jpg')
  const n = s * rate
  const cols = Math.min(5, n)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', RECORDING, '-vf', `fps=${rate},scale=216:-2,tile=${cols}x${Math.ceil(n / cols)}:padding=4`, '-frames:v', '1', '-q:v', '4', sheet], { timeout: 60000 })
  const out = imageResult(sheet, `${s} s of the screen at ${rate} frames/s, left to right (video: ${RECORDING})`)
  return out
}

// Touches and keys on the phone, through Android's `input`.
function inputTool({ action, x, y, x2, y2, ms, key, text }) {
  const int = (v, what) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n) || n < 0 || n > 10000) throw new Error(`${what} must be a screen coordinate or a duration`)
    return n
  }
  let cmd
  if (action === 'tap') cmd = `input tap ${int(x, 'x')} ${int(y, 'y')}`
  else if (action === 'long_press') cmd = `input swipe ${int(x, 'x')} ${int(y, 'y')} ${int(x, 'x')} ${int(y, 'y')} ${int(ms || 800, 'ms')}`
  else if (action === 'swipe') cmd = `input swipe ${int(x, 'x')} ${int(y, 'y')} ${int(x2, 'x2')} ${int(y2, 'y2')} ${int(ms || 300, 'ms')}`
  else if (action === 'key') {
    if (!/^(KEYCODE_)?[A-Z0-9_]+$/.test(key || '')) throw new Error('key must be a key code, like BACK, HOME or KEYCODE_VOLUME_UP')
    cmd = `input keyevent ${key.startsWith('KEYCODE_') ? key : `KEYCODE_${key}`}`
  } else if (action === 'text') {
    if (typeof text !== 'string' || !text) throw new Error('text is required')
    cmd = `input text ${shq(text.replace(/ /g, '%s'))}`
  } else throw new Error('action: tap, long_press, swipe, key or text')
  phoneShell(cmd, 30000, { expectOutput: false })
  return `done: ${cmd} (screen size: ${phoneShell('wm size').replace(/^Physical size: /, '')})`
}

function logcat({ filter = '', lines = 80, since_s = 0 } = {}) {
  const re = filter ? new RegExp(filter, 'i') : null
  const now = new Date()
  const from = since_s > 0 ? now.getTime() - since_s * 1000 : 0
  const year = now.getFullYear()
  const out = phoneShell('logcat -d -t 20000', 60000).split('\n').filter(l => {
    if (re && !re.test(l)) return false
    if (!from) return true
    const m = /^(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d+)/.exec(l)
    return m ? new Date(year, m[1] - 1, m[2], m[3], m[4], m[5]).getTime() >= from : false
  })
  return clip(tail(out.join('\n'), Math.min(1000, Number(lines) || 80)) || '(no matching lines)')
}

// Which apps take a link (what an intent would open), or which are installed.
function apps({ url, mime = 'video/*', filter }) {
  if (url) {
    if (!/^[a-z]+:\/\/[^\s'"]+$/i.test(url)) throw new Error('url must be a link without spaces or quotes')
    if (!/^[\w*.+/-]+$/.test(mime)) throw new Error('bad MIME type')
    const out = phoneShell(`cmd package query-activities --brief -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d '${url}' -t '${mime}'`)
    const found = out.split('\n').map(l => l.trim()).filter(l => /^[\w.]+\/[\w.$]+$/.test(l))
    return found.length ? `${found.length} app(s) open ${mime} links like this:\n${found.join('\n')}` : out
  }
  const list = phoneShell(`pm list packages ${filter ? shq(filter) : ''}`).split('\n').map(l => l.replace(/^package:/, '').trim()).filter(Boolean)
  return list.slice(0, 30).map(p => {
    let version = ''
    try { version = (phoneShell(`dumpsys package ${p} | grep -m1 versionName`).split('=')[1] || '').trim() } catch (e) { /* none */ }
    return `${p}${version ? `  ${version}` : ''}`
  }).join('\n') + (list.length > 30 ? `\n… and ${list.length - 30} more` : '')
}

function device() {
  const rows = []
  const battery = phoneShell('dumpsys battery')
  const get = k => ((battery.match(new RegExp(`^\\s*${k}: (.+)$`, 'm')) || [])[1] || '').trim()
  rows.push(`battery: ${get('level')}%, ${Number(get('temperature')) / 10} °C, ${get('status') === '2' ? 'charging' : 'not charging'}${get('AC powered') === 'true' ? ' (AC)' : get('USB powered') === 'true' ? ' (USB)' : ''}`)
  try { rows.push(`thermal: ${phoneShell('dumpsys thermalservice | grep -m1 -i "thermal status"').trim()}`) } catch (e) { /* not reported */ }
  const mem = fs.readFileSync('/proc/meminfo', 'utf8')
  const mb = k => Math.round(Number((mem.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0) / 1024)
  rows.push(`memory: ${mb('MemAvailable')} MB free of ${mb('MemTotal')} MB`)
  try {
    // The per-process list only (the sections after it repeat the same processes).
    const all = phoneShell('dumpsys meminfo', 60000)
    const at = all.search(/Total (PSS|RSS) by process:/)
    const section = at < 0 ? '' : all.slice(at).split(/\n\s*\n/)[0]
    const procs = section.split('\n').filter(l => l.includes(BROWSER))
      .map(l => Number(((l.match(/([\d,]+)K:/) || [])[1] || '0').replace(/,/g, '')))
    rows.push(`Firefox Beta: ${Math.round(procs.reduce((a, b) => a + b, 0) / 1024)} MB (${/PSS/.test(section) ? 'PSS' : 'RSS'}) in ${procs.length} process(es)`)
  } catch (e) { /* not reported */ }
  try {
    const st = fs.statfsSync('/sdcard')
    rows.push(`storage: ${Math.round((st.bavail * st.bsize) / 1e9)} GB free`)
  } catch (e) { /* not reported */ }
  return rows.join('\n')
}

// ─── tools: the userscript ───

async function scriptLog({ tab, filter = '', levels = null, last = 40 }) {
  const expr = `(() => {
    if (!window.__ibh) return null
    const re = ${JSON.stringify(filter)} ? new RegExp(${JSON.stringify(filter)}, 'i') : null
    const levels = ${JSON.stringify(levels)}
    const lines = window.__ibh.log().filter(e => (!levels || levels.includes(e.level)) && (!re || re.test(e.msg)))
      .slice(-${Math.max(1, Math.min(250, Number(last) || 40))})
      .map(e => new Date(e.t).toTimeString().slice(0, 8) + ' ' + e.level.padEnd(5) + ' ' + e.msg)
    return { version: window.__ibh.version, url: location.href, lines }
  })()`
  const raw = await withFirefox(c => ff.evaluate(c, tabKey(tab), expr, 0))
  const out = JSON.parse(raw)
  if (!out) return 'window.__ibh is missing in that tab: the script is not running there'
  return clip(`v${out.version} · ${out.url}\n${out.lines.join('\n') || '(no matching lines)'}`)
}

const KEY_LINE = /^(slideshow|download|external player|copied|keyframe decoder|storage)/

// Every site tab's whole log, saved to files: the log lives in the page, so
// a reload (a deploy) wipes it.
async function logSnapshot({ match = 'rule34' } = {}) {
  const tabs = await inTabs(match, 'window.__ibh ? { v: window.__ibh.version, log: window.__ibh.log().map(e => [e.t, e.level, e.msg]) } : null')
  fs.mkdirSync(LOGS, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const out = []
  for (const t of tabs) {
    if (!t.log) continue
    const file = path.join(LOGS, `${stamp}-tab${t.index}-v${t.v}.log`)
    const line = ([ts, level, msg]) => `${new Date(ts).toTimeString().slice(0, 8)} ${level.padEnd(5)} ${msg}`
    fs.writeFileSync(file, `${t.url}\n${t.log.map(line).join('\n')}\n`)
    const key = t.log.filter(([, level, msg]) => level === 'error' || level === 'warn' || KEY_LINE.test(msg)).slice(-10)
    out.push(`tab ${t.index} v${t.v}: ${t.log.length} lines → ${file}${key.length ? `\n  ${key.map(line).join('\n  ')}` : ''}`)
  }
  return out.length ? out.join('\n') : `no tab matching "${match}" runs the script`
}

// The `slideshow (…)` log lines as a table, with medians per method.
async function slideshowStats({ match = 'rule34', saved = false } = {}) {
  const lines = new Set()
  try {
    const tabs = await inTabs(match, 'window.__ibh ? window.__ibh.log().filter(e => /^slideshow \\(/.test(e.msg)).map(e => new Date(e.t).toTimeString().slice(0, 8) + " " + e.msg) : []')
    for (const t of tabs) for (const l of Array.isArray(t) ? t : Object.values(t).filter(Array.isArray).flat()) lines.add(l)
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
  const num = (s, re) => { const m = re.exec(s); return m ? Number(m[1]) : null }
  const rows = [...lines].sort().map(l => ({
    time: l.slice(0, 8),
    method: (/slideshow \(([^)]+)\)/.exec(l) || [])[1],
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
  const by = {}
  for (const r of rows) (by[r.method] = by[r.method] || []).push(r)
  const summary = Object.entries(by).map(([m, rs]) => {
    const fresh = rs.filter(r => r.first !== null && !r.kept).map(r => r.first)
    const kept = rs.filter(r => r.first !== null && r.kept).map(r => r.first)
    const gaps = rs.filter(r => r.gap).map(r => r.gap)
    const lifted = rs.filter(r => r.none !== null).length
    return `${m}: ${rs.length} hold(s)${lifted ? `, ${lifted} lifted before the first scene` : ''}` +
      `${fresh.length ? `, first scene median ${median(fresh)} ms` : ''}${kept.length ? ` (kept reels ${median(kept)} ms)` : ''}` +
      `${gaps.length ? `, gap median ${median(gaps)} ms` : ''}`
  }).join('\n')
  return clip(`${summary}\n\n${table}`)
}

// ─── tools: videos and WebAssembly ───

async function videoInfo({ post, url, scenes } = {}) {
  const ix = await readIndex({ post, url })
  const { track } = ix
  const n = await sceneCount(scenes)
  const plan = slidePlan(ix, n)
  const times = ix.sync.map(k => track.timeOf(k) / track.timescale)
  const gaps = times.slice(1).map((t, i) => t - times[i])
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
async function reelPreview({ post, url, scenes, width = 360 } = {}) {
  const ix = await readIndex({ post, url })
  if (!ix.avcC) throw new Error(`${ix.entry} is not H.264: the WebAssembly decoder takes avc1/avc3 only`)
  const n = await sceneCount(scenes)
  const plan = slidePlan(ix, n)
  const frames = await Promise.all(plan.frames.map(([off, size]) => rangeGet(ix.src, off, off + size - 1).then(r => r.buf)))
  const x = await h264()
  const put = bytes => { const p = x.buf_alloc(bytes.length); new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes); return p }
  const cfg = put(ix.avcC)
  const opened = x.dec_open(cfg, ix.avcC.length)
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
    for (let j = 0, o = 0; j < px.length; j += 4) { rgb[o++] = px[j]; rgb[o++] = px[j + 1]; rgb[o++] = px[j + 2] }
    fs.writeFileSync(path.join(dir, `f${String(i).padStart(2, '0')}.ppm`), Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), rgb]))
    times.push(`${(ix.track.timeOf(plan.keys[i]) / ix.track.timescale).toFixed(1)} s: ${kb(bytes.length)}, decode ${(x.dec_decode_us() / 1000).toFixed(0)} ms + convert ${(x.dec_convert_us() / 1000).toFixed(0)} ms`)
  }
  const cols = Math.min(5, frames.length)
  const sheet = path.join(WORK, 'reel.jpg')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(dir, 'f%02d.ppm'),
    '-vf', `tile=${cols}x${Math.ceil(frames.length / cols)}:padding=4`, '-frames:v', '1', '-q:v', '4', sheet], { timeout: 60000 })
  const head = `${post ? `post ${post}: ` : ''}${plan.plan}\n${times.join('\n')}`
  return [{ type: 'text', text: head }, imageResult(sheet, 'the reel, left to right')[1]]
}

// Builds wasm/h264dec.wasm: natively in Termux when its tmux session is up
// (proot makes FFmpeg's configure crawl: ~15 min against ~2), else here.
// `job` asks after a build; a native one is copied into wasm/ once done.
async function wasmBuild({ native = true, job } = {}) {
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

async function smoke({ url } = {}) {
  const r = await runAsync('node', ['tools/smoke.js', ...(url ? [url] : [])], { timeout: 600000 })
  return clip(`${r.code === 0 ? 'smoke test passed' : `smoke test FAILED (exit ${r.code})`}\n${tail(r.out, 30)}`)
}

// ─── deploy ───

function httpsGet(url) {
  return new Promise((resolve, reject) => {
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
// opened in Firefox Beta, Violentmonkey watched, then every site tab's log
// saved before the hidden ones reload.
async function deploy({ confirm = false, dry_run = false, wait_s = 60, match = 'rule34', skip_check = false }) {
  const steps = []
  const git = (...args) => run('git', ['-C', REPO, ...args]).trim()
  const sha = git('rev-parse', 'HEAD')
  if (git('status', '--porcelain', '--', SCRIPT)) steps.push(`warning: ${SCRIPT} has uncommitted changes; the committed version is what ships`)
  try { git('fetch', '-q', 'origin') } catch (e) { steps.push(`warning: git fetch failed (${firstLine(e)})`) }
  if (!git('branch', '-r', '--contains', sha)) throw new Error(`HEAD ${sha.slice(0, 7)} is not on the remote: push first (the raw link serves pushed commits only)`)
  if (!skip_check) steps.push(await check().then(r => r.split('\n')[0]))
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
  openUrl({ url })
  steps.push('opened the raw link in Firefox Beta')

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
      await withFirefox(c => ff.evaluate(c, String(t.index), 'location.reload()'))
      steps.push(`tab ${t.index}: was v${t.version || '?'}, hidden: reload requested`)
    } else {
      steps.push(`tab ${t.index}: still v${t.version || '?'} and visible: ask the user to refresh it`)
    }
  }
  if (!tabs.length) steps.push(`no tab matches "${match}" to check the version`)
  return steps.join('\n')
}

// ─── the tool list ───

const str = description => ({ type: 'string', description })
const num = description => ({ type: 'number', description })
const bool = description => ({ type: 'boolean', description })
const obj = (properties = {}, required) => ({ type: 'object', properties, ...(required ? { required } : {}) })
const TAB = str('tab index or URL substring (default "rule34")')
const VIDEO = { post: str('rule34 post id (its file is read through the logged-in tab)'), url: str('or the file URL') }

const TOOLS = [
  { name: 'status', run: status, inputSchema: obj(),
    description: 'Phone connection status: Shizuku, Wireless debugging, adb, the Firefox debugger forward, the native Termux tmux session. Read only.' },
  { name: 'connect', run: ({ force = false }) => connectPhone(force), inputSchema: obj({ force: bool('set up again even if Firefox answers') }),
    description: 'Connects adb over Wireless debugging and forwards Firefox Beta\'s debugger to tcp:6000. Other tools call it by themselves. Fails with what to ask the user when Wireless debugging is off.' },
  { name: 'tabs', run: tabsTool, inputSchema: obj({ details: bool('read version and visibility in each tab (default true)') }),
    description: 'Firefox tabs on the phone: index, script version (window.__ibh), visible or hidden, title, URL.' },
  { name: 'eval', run: evalTool,
    inputSchema: obj({ tab: TAB, expression: str('JS expression'), await: bool('wait for a promise result (and allow await)'), timeout_ms: num('with await (default 15000)') }, ['expression']),
    description: 'Evaluates a JS expression in a tab and returns it as JSON. Runs in the page with the user\'s login: only reads unless the user asked for an action. In a hidden tab timers stall (fetch works).' },
  { name: 'reload_tabs', run: reloadTabs,
    inputSchema: obj({ match: str('URL substring (default "rule34")'), only_hidden: bool('default true'), except_version: str('leave tabs on this __ibh.version alone') }),
    description: 'Reloads the tabs whose URL has `match`: only hidden ones by default (the visible one is the user\'s). Wipes their script logs: log_snapshot first.' },
  { name: 'open_url', run: openUrl, inputSchema: obj({ url: str('http(s) link'), package: str(`app to open it (default ${BROWSER})`) }, ['url']),
    description: 'Opens a link in Firefox Beta (or another app) on the phone, bringing it to the front. Changes what the user sees: only when the user asked.' },
  { name: 'firefox_pref', run: firefoxPref,
    inputSchema: obj({ name: str('preference, as in about:config'), action: { type: 'string', enum: ['get', 'set', 'clear'], description: 'default get' }, value: { description: 'for set: boolean, number or string' } }, ['name']),
    description: 'Reads, sets or resets a Firefox Beta preference through the debugger (about:config, reachable even where it is locked). get is read only; set and clear change the user\'s browser for good: only when the user asked, and say how to undo it (clear).' },
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
    description: 'Battery (level, temperature), thermal status, free memory, Firefox Beta\'s memory, free storage. Read only.' },
  { name: 'script_log', run: scriptLog,
    inputSchema: obj({ tab: TAB, filter: str('regular expression on the message, case-insensitive'), levels: { type: 'array', items: { type: 'string', enum: ['error', 'warn', 'info', 'debug'] } }, last: num('how many lines (default 40, at most 250)') }),
    description: 'Image Board Helper\'s log in a tab (window.__ibh.log()), newest last, with the version and URL.' },
  { name: 'log_snapshot', run: logSnapshot, inputSchema: obj({ match: str('site tabs (default "rule34")') }),
    description: 'Saves every site tab\'s whole script log to ~/.cache/ibh-logs and shows its key lines (slideshows, downloads, warnings, errors). deploy does it by itself before reloading anything.' },
  { name: 'slideshow_stats', run: slideshowStats, inputSchema: obj({ match: str('site tabs (default "rule34")'), saved: bool('also the logs saved by log_snapshot and deploy') }),
    description: 'The hold slideshow\'s log lines as a table (method, first scene, gap, late scenes, keyframes, read and decode times), with medians per method.' },
  { name: 'video_info', run: videoInfo, inputSchema: obj({ ...VIDEO, scenes: num('scenes a hold asks for (default: from the panel\'s jump)') }),
    description: 'A post\'s video, from its MP4 index alone (a few Range reads, as the slideshow does): codec, size, frames and fps, bitrate, where the index sits, keyframe count and spacing, whether it fits the hardware decoder, and what the hold slideshow will do with it (reel, play or seek).' },
  { name: 'reel_preview', run: reelPreview, inputSchema: obj({ ...VIDEO, scenes: num('scenes (default: from the panel\'s jump)'), width: num('picture width to decode down to (default 360)') }),
    description: 'Decodes the keyframes a hold would show, with the userscript\'s own WebAssembly decoder (in Node here), and returns them as one contact sheet, with each keyframe\'s size and decode time.' },
  { name: 'wasm_build', run: wasmBuild, inputSchema: obj({ native: bool('in native Termux when its tmux session is up (default true; much faster than proot)'), job: str('a build started before: its state, and for a native one, the result copied into wasm/') }),
    description: 'Builds wasm/h264dec.wasm (FFmpeg\'s H.264 decoder) with wasm/build.sh, in the background: natively in Termux when possible. Then commit the .wasm and point the @resource link at that commit.' },
  { name: 'check', run: check, inputSchema: obj(),
    description: 'npm run check in the repo: syntax, I18N parity, ESLint and the TypeScript check. deploy runs it first.' },
  { name: 'smoke', run: smoke, inputSchema: obj({ url: str('a Gelbooru 0.2 listing (default safebooru)') }),
    description: 'The Playwright smoke test (headless Firefox, the script injected): boot, panel, search bar, eye button, feed, modal, autopager. About a minute, and heavy on the phone\'s memory (Firefox\'s tabs may unload).' },
  { name: 'termux_run', run: termuxRun,
    inputSchema: obj({ command: str('shell command (bash, Termux\'s environment)'), cwd: str('folder (default Termux\'s home)'), name: str('window name'), keep: bool('leave a shell open in the window after it ends (default true)'), wait_s: num('wait up to N seconds for it to end and return its output') }, ['command']),
    description: 'Runs a command natively in Termux, outside proot (much faster for builds; Termux\'s own packages, emcc included), in a new window of the native tmux session "ibh": the user watches it with `tmux attach -t ibh` in a Termux session. Output and exit code through termux_job.' },
  { name: 'termux_job', run: termuxJob, inputSchema: obj({ id: str('job id (none: the recent jobs)'), lines: num('output lines (default 40)') }),
    description: 'A native Termux job\'s state and last output lines, or the list of recent jobs.' },
  { name: 'deploy', run: deploy,
    inputSchema: obj({ confirm: bool('click Violentmonkey\'s install button if it asks (changed grants); default false: wait for the user'), dry_run: bool('check everything without touching the phone'), skip_check: bool('skip npm run check'), wait_s: num('how long to watch the confirm page (default 60)'), match: str('site tabs (default "rule34")') }),
    description: 'Ships the committed, pushed image-board-helper.user.js: npm run check, every site tab\'s log saved, a copy in /sdcard/Download, the commit-pinned raw link opened in Firefox Beta, Violentmonkey watched, hidden site tabs reloaded.' },
]

const INSTRUCTIONS = 'Tools for the user\'s phone (Firefox Beta with Violentmonkey) where Image Board Helper is tested, and for the repo around it. ' +
  'Each tool reconnects by itself. When Wireless debugging is off, ask the user to turn it on: never enable it with `settings put` (it kills Shizuku). ' +
  'open_url, input, firefox_pref (set/clear) and deploy change the phone: use them when the user asked, or for the deploy that follows a change they requested. ' +
  'Leave the visible tab alone; reload only hidden ones; script logs vanish on reload, so log_snapshot before (deploy does). ' +
  'For a video question, video_info reads only its index; reel_preview shows the slideshow\'s frames. Long builds go to termux_run (native, outside proot).'

// ─── JSON-RPC over stdio ───

const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`)

async function handle(msg) {
  if (msg.id === undefined || msg.id === null) return   // a notification: nothing to answer
  const reply = result => send({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code, message) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'phone', version: '2.0.0' },
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
        const text = e && e.stderr ? firstLine(e) : clip(String((e && e.message) || e))
        return reply({ content: [{ type: 'text', text: text || 'failed' }], isError: true })
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`)
  }
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return }
  handle(msg).catch(e => console.error(e))
}).on('close', () => process.exit(0))
