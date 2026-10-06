#!/usr/bin/env node
// Development helper, not part of the userscript.
//
// An MCP server (stdio, no dependencies) for the phone this repo is tested
// on: connection status and setup (adb over Wireless debugging, the Firefox
// debugger forward), tabs, JS in a tab, the script's log, screenshots,
// opening a link in Firefox Beta, and the whole userscript deploy. Claude
// Code starts it from .mcp.json; every tool reconnects by itself when the
// forward is gone, so a dropped Wireless debugging session costs one call.
//
// The protocol is JSON-RPC 2.0, one message per line on stdin/stdout:
// initialize, tools/list, tools/call. Nothing else may go to stdout.

'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')
const readline = require('readline')
const { execFileSync } = require('child_process')
const ff = require('./ffrdp')

const REPO = path.resolve(__dirname, '..')
const SCRIPT = 'image-board-helper.user.js'
const BROWSER = 'org.mozilla.firefox_beta'
const SCREENSHOTS = '/sdcard/Pictures/Screenshots'   // where the phone's own screenshots land
const SHOT = '/sdcard/Download/ibh.png'              // where screencap writes; the container reads it too
const LOCAL_RISH = path.join(os.homedir(), '.local/bin/rish')
const RISH = fs.existsSync(LOCAL_RISH) ? LOCAL_RISH : 'rish'
const MAX_TEXT = 30000   // longer results are cut, to keep the reply readable

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const clip = s => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (${s.length - MAX_TEXT} more characters cut)` : s)
const firstLine = e => String((e && (e.stderr || e.message)) || e).trim().split('\n')[0]

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64e6, ...opts })
}

function withTimeout(promise, ms, what) {
  let timer
  const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

// ─── the phone: Shizuku (rish) first, the adb connection as a fallback ───

// The last line rish prints (warnings may come before it).
const rishLast = cmd => run(RISH, ['-c', cmd]).trim().split('\n').pop().trim()

function shizukuUp() {
  try { return rishLast('echo ok') === 'ok' } catch (e) { return false }
}

function adbSerial() {
  try {
    const device = run('adb', ['devices']).split('\n').slice(1).map(l => l.trim().split(/\s+/)).find(p => p[1] === 'device')
    return device ? device[0] : null
  } catch (e) {
    return null
  }
}

// A shell command on the phone, as uid shell either way.
function phoneShell(cmd) {
  if (shizukuUp()) return run(RISH, ['-c', cmd]).trim()
  const serial = adbSerial()
  if (!serial) throw new Error('Shizuku is not running and adb has no device: ask the user to start Shizuku or turn on Wireless debugging')
  return run('adb', ['-s', serial, 'shell', cmd]).trim()
}

// true on, false off, null when it cannot be read (Shizuku down or
// answering something else: then adb gets its try). Read only: turning it
// on with `settings put` restarts adbd and kills Shizuku.
function wirelessDebugging() {
  try {
    const v = rishLast('settings get global adb_wifi_enabled')
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

// ─── tools ───

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
  return rows.join('\n')
}

async function tabsTool({ details = true } = {}) {
  const expr = '({ hidden: document.visibilityState === "hidden", version: (window.__ibh && window.__ibh.version) || null })'
  const tabs = details ? await inTabs('', expr) : (await withFirefox(c => ff.listTabs(c))).map((t, i) => ({ index: i, url: t.url, title: t.title }))
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

async function reloadTabs({ match = 'rule34', only_hidden = true, except_version = null }) {
  const tabs = await inTabs(match, '({ hidden: document.visibilityState === "hidden", version: (window.__ibh && window.__ibh.version) || null })')
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
  phoneShell(`screencap -p ${SHOT}`)
  return imageResult(SHOT, 'screen now')
}

function latestScreenshot() {
  const files = fs.readdirSync(SCREENSHOTS).filter(f => /\.(png|jpe?g|webp)$/i.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(SCREENSHOTS, f)).mtimeMs })).sort((a, b) => b.t - a.t)
  if (!files.length) throw new Error(`no screenshots in ${SCREENSHOTS}`)
  return imageResult(path.join(SCREENSHOTS, files[0].f), 'newest screenshot')
}

function openUrl({ url, package: pkg = BROWSER }) {
  if (!/^https?:\/\/[^\s'"\\]+$/.test(url || '')) throw new Error('url must be http(s) without spaces or quotes')
  if (!/^[\w.]+$/.test(pkg)) throw new Error('bad package name')
  return phoneShell(`am start -a android.intent.action.VIEW -d '${url}' ${pkg}`)
}

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

// The usual ship: committed and pushed file, a copy in Downloads, the
// commit-pinned raw link (no CDN or browser cache in the way) opened in
// Firefox Beta, Violentmonkey watched, site tabs checked and reloaded.
async function deploy({ confirm = false, dry_run = false, wait_s = 60, match = 'rule34' }) {
  const steps = []
  const git = (...args) => run('git', ['-C', REPO, ...args]).trim()
  const sha = git('rev-parse', 'HEAD')
  if (git('status', '--porcelain', '--', SCRIPT)) steps.push(`warning: ${SCRIPT} has uncommitted changes; the committed version is what ships`)
  try { git('fetch', '-q', 'origin') } catch (e) { steps.push(`warning: git fetch failed (${firstLine(e)})`) }
  if (!git('branch', '-r', '--contains', sha)) throw new Error(`HEAD ${sha.slice(0, 7)} is not on the remote: push first (the raw link serves pushed commits only)`)
  const code = git('show', `HEAD:${SCRIPT}`) + '\n'
  const version = (code.match(/@version\s+(\S+)/) || [])[1]
  const repo = git('remote', 'get-url', 'origin').match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!repo) throw new Error('origin is not a GitHub repository')
  const url = `https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/${sha}/${SCRIPT}`
  const served = (await httpsGet(url)).match(/@version\s+(\S+)/)
  if (!served || served[1] !== version) throw new Error(`the raw link serves ${served ? served[1] : 'no version'}, expected ${version}`)
  steps.push(`raw link serves v${version} (${sha.slice(0, 7)})`)
  if (dry_run) return steps.concat(`dry run: would copy it to /sdcard/Download/${SCRIPT} and open ${url}`).join('\n')
  fs.writeFileSync(`/sdcard/Download/${SCRIPT}`, code)
  steps.push(`copied v${version} to /sdcard/Download/${SCRIPT}`)

  steps.push(await connectPhone(false))
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

  const tabs = await inTabs(match, '({ hidden: document.visibilityState === "hidden", version: (window.__ibh && window.__ibh.version) || null })')
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

const TOOLS = [
  {
    name: 'status',
    description: 'Phone connection status: Shizuku, Wireless debugging, adb, the Firefox debugger forward. Read only.',
    inputSchema: { type: 'object', properties: {} },
    run: status,
  },
  {
    name: 'connect',
    description: 'Connects adb over Wireless debugging and forwards Firefox Beta\'s debugger to tcp:6000. Other tools call it by themselves when needed. Fails with what to ask the user when Wireless debugging is off.',
    inputSchema: { type: 'object', properties: { force: { type: 'boolean', description: 'set up again even if Firefox answers' } } },
    run: ({ force = false }) => connectPhone(force),
  },
  {
    name: 'tabs',
    description: 'Firefox tabs on the phone: index, script version (window.__ibh), visible or hidden, title, URL.',
    inputSchema: { type: 'object', properties: { details: { type: 'boolean', description: 'read version and visibility in each tab (default true)' } } },
    run: tabsTool,
  },
  {
    name: 'eval',
    description: 'Evaluates a JS expression in a tab and returns it as JSON. With await, promises are awaited (and `await` may be used). Runs in the page with the user\'s login: only reads unless the user asked for an action.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'tab index or URL substring (default "rule34")' },
        expression: { type: 'string' },
        await: { type: 'boolean', description: 'wait for a promise result' },
        timeout_ms: { type: 'number', description: 'with await (default 15000)' },
      },
      required: ['expression'],
    },
    run: evalTool,
  },
  {
    name: 'script_log',
    description: 'Image Board Helper\'s log in a tab (window.__ibh.log()), newest last, with the version and URL.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'tab index or URL substring (default "rule34")' },
        filter: { type: 'string', description: 'regular expression on the message, case-insensitive' },
        levels: { type: 'array', items: { type: 'string', enum: ['error', 'warn', 'info', 'debug'] } },
        last: { type: 'number', description: 'how many lines (default 40, at most 250)' },
      },
    },
    run: scriptLog,
  },
  {
    name: 'reload_tabs',
    description: 'Reloads the tabs whose URL has `match`: only hidden ones by default (the visible one is the user\'s), skipping tabs already on except_version.',
    inputSchema: {
      type: 'object',
      properties: {
        match: { type: 'string', description: 'URL substring (default "rule34")' },
        only_hidden: { type: 'boolean', description: 'default true' },
        except_version: { type: 'string', description: 'leave tabs on this __ibh.version alone' },
      },
    },
    run: reloadTabs,
  },
  {
    name: 'screenshot',
    description: 'Captures the phone screen now (screencap; touches nothing) and returns it as an image.',
    inputSchema: { type: 'object', properties: {} },
    run: screenshot,
  },
  {
    name: 'latest_screenshot',
    description: 'The newest screenshot the user took (/sdcard/Pictures/Screenshots), as an image: what "olha screenshot" means.',
    inputSchema: { type: 'object', properties: {} },
    run: latestScreenshot,
  },
  {
    name: 'open_url',
    description: 'Opens a link in Firefox Beta on the phone, bringing it to the front. Changes what the user sees: only when the user asked.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, package: { type: 'string', description: `default ${BROWSER}` } },
      required: ['url'],
    },
    run: openUrl,
  },
  {
    name: 'deploy',
    description: 'Ships the committed, pushed image-board-helper.user.js: copy in /sdcard/Download, commit-pinned raw link opened in Firefox Beta, Violentmonkey watched, site tabs checked (hidden ones reloaded). dry_run checks everything without touching the phone.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'click Violentmonkey\'s install button if it asks (changed grants); default false: wait for the user' },
        dry_run: { type: 'boolean' },
        wait_s: { type: 'number', description: 'how long to watch the confirm page (default 60)' },
        match: { type: 'string', description: 'site tabs to check (default "rule34")' },
      },
    },
    run: deploy,
  },
]

const INSTRUCTIONS = 'Tools for the user\'s phone (Firefox Beta with Violentmonkey) where Image Board Helper is tested. ' +
  'Each tool reconnects by itself. When Wireless debugging is off, ask the user to turn it on: never enable it with `settings put` (it kills Shizuku). ' +
  'open_url and deploy change what the user sees: use them when the user asked, or for the deploy that follows a change they requested. ' +
  'Leave the visible tab alone; reload only hidden ones.'

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
        serverInfo: { name: 'phone', version: '1.0.0' },
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
        return reply({ content: [{ type: 'text', text: firstLine(e) || 'failed' }], isError: true })
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
