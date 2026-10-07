#!/usr/bin/env node
// Development helper, not part of the userscript.
//
// A local HTTP+JSON server that controls the phone, run natively in Termux
// (see docs/superpowers/specs/2026-10-07-phone-server-design.md):
//
//   node tools/phone-server.mts serve                 run the server on 127.0.0.1:8730
//   node tools/phone-server.mts call <route> [json]   one request, the answer printed
//   node tools/phone-server.mts token                 the token (created if missing)
//
// Every request carries "Authorization: Bearer <token>"; the token lives in
// ~/.config/ibh-server/token (mode 600), where the server also keeps its log.
// GET /status; every action is POST /<action> with a JSON body; answers are
// { ok: true, ... } or { ok: false, error } with 400, 401, 404, 413, 503, 500.
// Everything outside is reached through paths the tests override:
// IBH_SERVER_DIR, IBH_SERVER_PORT, RISH, IBH_TERMUX_BIN.
// TypeScript that Node runs as it is (it strips the types); tsc -p tools checks it.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import * as crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { shizukuUp } from './rish.mts'

const VERSION = '1.0.0'
const DIR = process.env.IBH_SERVER_DIR || path.join(os.homedir(), '.config', 'ibh-server')
const PORT = Number(process.env.IBH_SERVER_PORT || 8730)
const TERMUX_BIN = process.env.IBH_TERMUX_BIN || ''   // a folder ending in /, or empty: termux-* from PATH
const MAX_BODY = 30 * 1024 * 1024                     // a 20 MB file as base64, with room to spare
const LOG_MAX = 1024 * 1024
const started = Date.now()

// A failure with the HTTP status it answers with.
export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type Handler = (body: Record<string, unknown>) => Promise<Record<string, unknown>>

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
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT'
      ? new HttpError(503, `Termux:API is not installed (${name} is missing): pkg install termux-api, and the Termux:API app`)
      : e))
    child.on('close', code => (code === 0 ? resolve(out) : reject(new HttpError(500, `${name} failed (${code}): ${err.trim()}`))))
    child.stdin.end(input ?? '')
  })
}

export const ROUTES: Record<string, Handler> = {
  status: async () => ({
    version: VERSION,
    uptime_s: Math.round((Date.now() - started) / 1000),
    shizuku: await shizukuUp(),
    termuxApi: fs.existsSync(termuxPath('termux-toast')),
  }),
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
  // No CORS headers: a web page can neither read an answer nor act without the token.
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now()
    const route = (req.url || '/').split('?')[0]?.slice(1) ?? ''
    let status = 200
    let answer: Record<string, unknown>
    try {
      if (!authorized(req.headers.authorization)) throw new HttpError(401, 'missing or wrong token')
      const body = await readBody(req)
      const handler = Object.hasOwn(ROUTES, route) ? ROUTES[route] : undefined
      if (!handler) throw new HttpError(404, `no route "${route}"`)
      answer = { ok: true, ...await handler(body) }
    } catch (e) {
      status = e instanceof HttpError ? e.status : 500
      answer = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
    log(`${route} ${Date.now() - t0}ms ${status === 200 ? 'ok' : `${status} ${answer.error}`}`)
  })
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
  else if (cmd === 'call' && args[0]) call(args[0], args[1]).then(code => process.exit(code), e => { console.error(e.message); process.exit(1) })
  else { console.error('usage: phone-server.mts serve | call <route> [json] | token'); process.exit(1) }
}
