#!/usr/bin/env node
// Development helper, not part of the userscript.
//
// Talks to Firefox for Android over its Remote Debugging Protocol, so the
// userscript can be inspected on the real device: list tabs, evaluate JS in a
// tab (e.g. `window.__ibh.log()`), without the desktop DevTools.
//
//   node tools/ffrdp.js setup                 adb connect + forward tcp:6000
//   node tools/ffrdp.js tabs                  list open tabs
//   node tools/ffrdp.js eval <tab> '<expr>'   evaluate in a tab
//
// <tab> is the index printed by `tabs` or any substring of the tab URL.
// The result is passed through JSON.stringify, so objects print in full.
// Also a module: tools/phone-mcp.js builds on the functions exported below.
//
// Requires: Firefox "Remote debugging via USB" on, and adb already paired with
// the phone's own Wireless debugging (one-time `adb pair`).

'use strict'
const net = require('net')
const { execFileSync } = require('child_process')

const PORT = +(process.env.FFRDP_PORT || 6000)
const DEBUG = !!process.env.FFRDP_DEBUG  // print every packet to stderr

// ─── setup: find the wireless debugging port and forward the Firefox socket ───

function adb(...args) {
  return execFileSync('adb', args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// Connects adb to the phone's Wireless debugging and forwards Firefox's
// debugger socket to tcp:PORT. Returns { serial, socket }.
function setup() {
  // The connect port changes every time Wireless debugging restarts; mDNS has
  // it. A record can outlive the service, so try each one, on the loopback
  // address first (the phone talking to itself) and then the one advertised.
  const records = adb('mdns', 'services').split('\n').filter(l => l.includes('_adb-tls-connect'))
  if (!records.length) throw new Error('Wireless debugging not advertised; is it on?')
  let serial = null
  for (const line of records) {
    const addr = line.trim().split(/\s+/).pop()
    const port = addr.split(':')[1]
    for (const candidate of [`127.0.0.1:${port}`, addr]) {
      const out = adb('connect', candidate)
      if (/connected to/.test(out)) { serial = candidate; break }
    }
    if (serial) break
  }
  if (!serial) throw new Error('Wireless debugging advertised but refusing connections (stale record?); is it on?')

  // Firefox and Firefox Beta use different socket names; take whichever exists.
  const sockets = adb('-s', serial, 'shell', 'cat /proc/net/unix')
    .match(/@org\.mozilla\.[\w.]+\/firefox-debugger-socket/g)
  if (!sockets) throw new Error('No Firefox debugger socket; enable "Remote debugging via USB" and open Firefox')
  const socket = sockets[0].slice(1)
  adb('-s', serial, 'forward', `tcp:${PORT}`, `localabstract:${socket}`)
  return { serial, socket }
}

// ─── protocol: packets are "<byte length>:<json>" in both directions ───

function connect() {
  const sock = net.connect(PORT, '127.0.0.1')
  let buf = Buffer.alloc(0)
  const waiters = []
  let failure = null

  // A dropped connection fails whatever still waits, instead of hanging it.
  const fail = e => {
    failure = failure || e
    for (const w of waiters.splice(0)) w.reject(failure)
  }
  sock.on('error', fail)
  sock.on('close', () => fail(new Error('connection to Firefox closed')))

  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      const colon = buf.indexOf(0x3a)  // ':'
      if (colon < 0) return
      const len = +buf.subarray(0, colon).toString()
      if (buf.length < colon + 1 + len) return  // packet not complete yet
      const packet = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString())
      buf = buf.subarray(colon + 1 + len)
      if (DEBUG) console.error('<-', JSON.stringify(packet).slice(0, 300))
      // Hand the packet to the first waiter that wants it; unsolicited events
      // nobody waits for (tab list changes, etc.) are dropped.
      const i = waiters.findIndex(w => w.match(packet))
      if (i >= 0) waiters.splice(i, 1)[0].resolve(packet)
    }
  })

  const waitFor = match => new Promise((resolve, reject) => {
    if (failure) reject(failure)
    else waiters.push({ match, resolve, reject })
  })

  function send(msg) {
    const body = Buffer.from(JSON.stringify(msg))
    if (DEBUG) console.error('->', body.toString().slice(0, 300))
    sock.write(Buffer.concat([Buffer.from(body.length + ':'), body]))
  }

  // A reply comes from the actor we asked and has no `type`; events do.
  async function request(to, type, extra = {}) {
    const reply = waitFor(p => p.from === to && (!p.type || p.error))
    send({ to, type, ...extra })
    const p = await reply
    if (p.error) throw new Error(`${type}: ${p.error} ${p.message || ''}`)
    return p
  }

  // The greeting, or the connection error (no forward: run setup).
  const ready = waitFor(p => p.from === 'root' && p.applicationType)
  return { sock, waitFor, request, ready }
}

// Strings over ~10k chars arrive as a handle; fetch the full text.
async function fullString(c, grip) {
  if (grip?.type !== 'longString') return grip
  const r = await c.request(grip.actor, 'substring', { start: 0, end: grip.length })
  return r.substring
}

async function listTabs(c) {
  return (await c.request('root', 'listTabs')).tabs
}

async function pickTab(c, key) {
  const tabs = await listTabs(c)
  const tab = /^\d+$/.test(String(key)) ? tabs[+key] : tabs.find(t => t.url.includes(key))
  if (!tab) throw new Error(`no tab matches "${key}"`)
  return tab
}

// Evaluates an expression in a tab and returns it as JSON text ('undefined'
// for undefined). Throws with the page's exception message.
async function evaluate(c, key, expr, indent = 2) {
  const tab = await pickTab(c, key)
  // The tab descriptor hands out the target, which owns the console actor.
  const { frame } = await c.request(tab.actor, 'getTarget')
  const consoleActor = frame.consoleActor

  // evaluateJSAsync replies at once with an id, then sends the result as an event.
  // Both often arrive in the same chunk, so the waiter must exist before sending.
  const text = `JSON.stringify((${expr}), null, ${indent})`
  const result = c.waitFor(p => p.type === 'evaluationResult' && p.from === consoleActor)
  await c.request(consoleActor, 'evaluateJSAsync', { text })
  const r = await result

  if (r.exceptionMessage) throw new Error(r.exceptionMessage)
  const out = await fullString(c, r.result)
  return out?.type === 'undefined' ? 'undefined' : out
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === 'setup') {
    const { serial, socket } = setup()
    console.log(`connected to ${serial}\nforward tcp:${PORT} -> ${socket}`)
    return
  }

  const c = connect()
  await c.ready.catch(e => { console.error(`cannot reach 127.0.0.1:${PORT} (${e.code}); run "setup" first`); process.exit(1) })
  try {
    if (cmd === 'tabs') {
      const tabs = await listTabs(c)
      tabs.forEach((t, i) => console.log(`${i}  ${(t.title || '').slice(0, 40).padEnd(40)}  ${t.url}`))
    } else if (cmd === 'eval' && args.length === 2) {
      console.log(await evaluate(c, args[0], args[1]))
    } else {
      console.log('usage: ffrdp.js setup | tabs | eval <tab> <expr>')
    }
  } finally {
    c.sock.end()
  }
}

module.exports = { PORT, adb, setup, connect, listTabs, pickTab, evaluate }

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1) })
