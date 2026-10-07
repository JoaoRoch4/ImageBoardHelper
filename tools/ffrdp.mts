#!/usr/bin/env node
// Development helper, not part of the userscript.
//
// Talks to Firefox for Android over its Remote Debugging Protocol, so the
// userscript can be inspected on the real device: list tabs, evaluate JS in a
// tab (e.g. `window.__ibh.log()`), without the desktop DevTools.
//
//   node tools/ffrdp.mts setup                 adb connect + forward tcp:6000
//   node tools/ffrdp.mts tabs                  list open tabs
//   node tools/ffrdp.mts eval <tab> '<expr>'   evaluate in a tab
//   node tools/ffrdp.mts pref <name> [value|clear]   read, set or reset a Firefox preference
//   node tools/ffrdp.mts console <tab>         the tab's console (console.* calls, page errors)
//
// <tab> is the index printed by `tabs` or any substring of the tab URL.
// The result is passed through JSON.stringify, so objects print in full.
// Also a module: tools/phone-mcp.mts builds on the functions exported below.
// TypeScript that Node runs as it is (it strips the types); tsc -p tools checks it.
//
// Requires: Firefox "Remote debugging via USB" on, and adb already paired with
// the phone's own Wireless debugging (one-time `adb pair`).

import * as net from 'node:net'
import { execFileSync } from 'node:child_process'

export const PORT = +(process.env.FFRDP_PORT || 6000)
const DEBUG = !!process.env.FFRDP_DEBUG  // print every packet to stderr

// A protocol packet, both ways: replies come from the actor asked, events
// also carry a type. The rest depends on the actor, so it stays loose.
export interface Packet {
  from: string
  type?: string
  error?: string
  message?: string
  [key: string]: any
}

export interface Tab {
  actor: string
  url: string
  title: string
}

export interface Connection {
  sock: net.Socket
  waitFor(match: (p: Packet) => boolean): Promise<Packet>
  request(to: string, type: string, extra?: object): Promise<Packet>
  ready: Promise<Packet>
}

interface Waiter {
  match: (p: Packet) => boolean
  resolve: (p: Packet) => void
  reject: (e: Error) => void
}

// ─── setup: find the wireless debugging port and forward the Firefox socket ───

export function adb(...args: string[]): string {
  return execFileSync('adb', args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// Connects adb to the phone's Wireless debugging and forwards a Firefox's
// debugger socket to tcp:PORT: `app` (a package, such as org.mozilla.fenix
// for Nightly) or FFRDP_APP when its socket exists, else the first found.
// Returns { serial, socket, app }.
export function setup(app = process.env.FFRDP_APP): { serial: string; socket: string; app: string } {
  // The connect port changes every time Wireless debugging restarts; mDNS has
  // it. A record can outlive the service, so try each one, on the loopback
  // address first (the phone talking to itself) and then the one advertised.
  const records = adb('mdns', 'services').split('\n').filter(l => l.includes('_adb-tls-connect'))
  if (!records.length) throw new Error('Wireless debugging not advertised; is it on?')
  let serial: string | null = null
  for (const line of records) {
    const addr = line.trim().split(/\s+/).pop() || ''
    const port = addr.split(':')[1]
    if (!port) continue
    for (const candidate of [`127.0.0.1:${port}`, addr]) {
      const out = adb('connect', candidate)
      if (/connected to/.test(out)) { serial = candidate; break }
    }
    if (serial) break
  }
  if (!serial) throw new Error('Wireless debugging advertised but refusing connections (stale record?); is it on?')

  // Each Firefox (release, Beta, Nightly) has a socket of its own name.
  const sockets = adb('-s', serial, 'shell', 'cat /proc/net/unix')
    .match(/@org\.mozilla\.[\w.]+\/firefox-debugger-socket/g) || []
  const found = (app && sockets.find(s => s.startsWith(`@${app}/`))) || sockets[0]
  if (!found) throw new Error('No Firefox debugger socket; enable "Remote debugging via USB" and open Firefox')
  const socket = found.slice(1)
  adb('-s', serial, 'forward', `tcp:${PORT}`, `localabstract:${socket}`)
  return { serial, socket, app: socket.split('/')[0] ?? socket }
}

// ─── protocol: packets are "<byte length>:<json>" in both directions ───

export function connect(): Connection {
  const sock = net.connect(PORT, '127.0.0.1')
  let buf: Buffer = Buffer.alloc(0)
  const waiters: Waiter[] = []
  let failure: Error | null = null

  // A dropped connection fails whatever still waits, instead of hanging it.
  const fail = (e: Error) => {
    failure = failure || e
    for (const w of waiters.splice(0)) w.reject(failure)
  }
  sock.on('error', fail)
  sock.on('close', () => fail(new Error('connection to Firefox closed')))

  sock.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      const colon = buf.indexOf(0x3a)  // ':'
      if (colon < 0) return
      const len = +buf.subarray(0, colon).toString()
      if (buf.length < colon + 1 + len) return  // packet not complete yet
      const packet: Packet = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString())
      buf = buf.subarray(colon + 1 + len)
      if (DEBUG) console.error('<-', JSON.stringify(packet).slice(0, 300))
      // Hand the packet to the first waiter that wants it; unsolicited events
      // nobody waits for (tab list changes, etc.) are dropped.
      const i = waiters.findIndex(w => w.match(packet))
      if (i >= 0) waiters.splice(i, 1)[0]?.resolve(packet)
    }
  })

  const waitFor = (match: (p: Packet) => boolean) => new Promise<Packet>((resolve, reject) => {
    if (failure) reject(failure)
    else waiters.push({ match, resolve, reject })
  })

  function send(msg: object) {
    const body = Buffer.from(JSON.stringify(msg))
    if (DEBUG) console.error('->', body.toString().slice(0, 300))
    sock.write(Buffer.concat([Buffer.from(body.length + ':'), body]))
  }

  // A reply comes from the actor we asked and has no `type`; events do.
  async function request(to: string, type: string, extra: object = {}): Promise<Packet> {
    const reply = waitFor(p => p.from === to && (!p.type || !!p.error))
    send({ to, type, ...extra })
    const p = await reply
    if (p.error) throw new Error(`${type}: ${p.error} ${p.message || ''}`)
    return p
  }

  // The greeting, or the connection error (no forward: run setup).
  const ready = waitFor(p => p.from === 'root' && !!p.applicationType)
  return { sock, waitFor, request, ready }
}

// Strings over ~10k chars arrive as a handle (a grip); fetch the full text.
// Grips are whatever the debugger sends, so they stay untyped.
async function fullString(c: Connection, grip: any): Promise<any> {
  if (grip?.type !== 'longString') return grip
  const r = await c.request(grip.actor, 'substring', { start: 0, end: grip.length })
  return r.substring
}

export async function listTabs(c: Connection): Promise<Tab[]> {
  return (await c.request('root', 'listTabs')).tabs
}

export async function pickTab(c: Connection, key: string): Promise<Tab> {
  const tabs = await listTabs(c)
  const tab = /^\d+$/.test(key) ? tabs[+key] : tabs.find(t => t.url.includes(key))
  if (!tab) throw new Error(`no tab matches "${key}"`)
  return tab
}

// Evaluates an expression in a tab and returns it as JSON text ('undefined'
// for undefined). Throws with the page's exception message.
export async function evaluate(c: Connection, key: string, expr: string, indent = 2): Promise<string> {
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

// One line of a tab's console: a console.* call or a page error.
export interface ConsoleLine {
  time: number
  level: string
  text: string
  source: string
}

// A console argument as text: primitives as they are, a long string by its
// start, an object by its class (a grip, not the object itself).
const argText = (a: any): string =>
  a === null || typeof a !== 'object' ? String(a)
    : a.type === 'longString' ? `${a.initial}…`
    : a.type === 'undefined' ? 'undefined'
    : `[${a.class || a.type}]`

// A tab's console, as Firefox's own console shows it: console.* calls and
// page errors since the page loaded, hidden tabs included. The console
// actor hands out what it kept only once its listeners run.
export async function consoleMessages(c: Connection, key: string): Promise<ConsoleLine[]> {
  const tab = await pickTab(c, key)
  const { frame } = await c.request(tab.actor, 'getTarget')
  const types = ['ConsoleAPI', 'PageError']
  await c.request(frame.consoleActor, 'startListeners', { listeners: types })
  const { messages = [] } = await c.request(frame.consoleActor, 'getCachedMessages', { messageTypes: types })
  return messages.map((m: any): ConsoleLine => {
    if (m.pageError) {
      const e = m.pageError
      return { time: e.timeStamp, level: e.warning ? 'warn' : e.info ? 'info' : 'error', text: e.errorMessage, source: `${e.sourceName}:${e.lineNumber}` }
    }
    const x = m.message || {}
    return { time: x.timeStamp, level: x.level || 'log', text: (x.arguments || []).map(argText).join(' '), source: `${x.filename}:${x.lineNumber}` }
  }).sort((a: ConsoleLine, b: ConsoleLine) => a.time - b.time)   // the actor sends console calls first, then errors
}

export type PrefAction = 'get' | 'set' | 'clear'

// A Firefox preference (what about:config shows, reachable here even where
// about:config is locked): get, set (boolean, number or string, by the
// value's type) or clear back to the default. Returns { before, after }.
export async function pref(c: Connection, name: string, action: PrefAction = 'get', value?: unknown): Promise<{ before: unknown; after: unknown }> {
  const actor = (await c.request('root', 'getRoot')).preferenceActor
  const read = async () => {
    for (const kind of ['Bool', 'Int', 'Char']) {
      try { return (await c.request(actor, `get${kind}Pref`, { value: name })).value } catch (e) { /* another type */ }
    }
    return null   // not set anywhere
  }
  const before = await read()
  if (action === 'set') {
    const kind = typeof value === 'boolean' ? 'Bool' : typeof value === 'number' ? 'Int' : 'Char'
    await c.request(actor, `set${kind}Pref`, { name, value: kind === 'Char' ? String(value) : value })
  } else if (action === 'clear') {
    await c.request(actor, 'clearUserPref', { name })
  }
  return { before, after: action === 'get' ? before : await read() }
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
      const [tab = '', expr = ''] = args
      console.log(await evaluate(c, tab, expr))
    } else if (cmd === 'console' && args.length === 1) {
      for (const l of await consoleMessages(c, args[0] || '')) console.log(`${new Date(l.time).toTimeString().slice(0, 8)} ${l.level.padEnd(5)} ${l.text}`)
    } else if (cmd === 'pref' && args.length >= 1) {
      const [name = '', v] = args
      const value = v === 'true' ? true : v === 'false' ? false : /^-?\d+$/.test(v || '') ? Number(v) : v
      console.log(JSON.stringify(await pref(c, name, v === undefined ? 'get' : v === 'clear' ? 'clear' : 'set', value)))
    } else {
      console.log('usage: ffrdp.mts setup | tabs | eval <tab> <expr> | console <tab> | pref <name> [value|clear]')
    }
  } finally {
    c.sock.end()
  }
}

// Run as a command (node tools/ffrdp.mts …), not when imported.
if (import.meta.main) main().catch(e => { console.error(e.message); process.exit(1) })
