// Development helper, not part of the userscript.
//
// One persistent rish (Shizuku) session for shell commands as uid shell,
// shared by tools/phone-mcp.mts and tools/phone-server.mts.
//
// rish starts a Java VM (app_process) for every call: seconds each on this
// phone, and the first call after ColorOS froze Shizuku's idle process can
// come back empty. So one rish stays open, and every command goes through
// its stdin, followed by a random marker that carries the exit code: the VM
// starts once (~4 s), then commands take ~50 ms. rish mixes up its two
// channels (a plain echo can arrive on stderr), but keeps the order: both
// feed one buffer, and the marker always comes last.
// TypeScript that Node runs as it is (it strips the types); tsc -p tools checks it.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

// The container's root filesystem as native Termux sees it.
export const ROOTFS = '/data/data/com.termux/files/usr/var/lib/proot-distro/containers/fedora/rootfs'

// rish: $RISH, the container's ~/.local/bin/rish, the same file through the
// rootfs path (natively, outside proot), else whatever `rish` is on PATH.
export function findRish(): string {
  const candidates = [path.join(os.homedir(), '.local/bin/rish'), `${ROOTFS}/root/.local/bin/rish`]
  return process.env.RISH || candidates.find(f => fs.existsSync(f)) || 'rish'
}

interface RishCommand {
  cmd: string
  timeout: number
  marker: string
  resolve: (r: { out: string; code: number }) => void
  reject: (e: Error) => void
  timer?: NodeJS.Timeout
}

interface RishSession {
  child: ChildProcessWithoutNullStreams
  buf: string
  queue: RishCommand[]
  busy: RishCommand | null
  dead: boolean
}

let session: RishSession | null = null

function rishSession(): RishSession {
  if (session && !session.dead) return session
  const child = spawn(findRish(), [], { stdio: 'pipe' })
  const s: RishSession = { child, buf: '', queue: [], busy: null, dead: false }
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (d: string) => { s.buf += d; pump(s) })
  }
  child.stdin.on('error', () => { /* the session ended: exit below */ })
  const end = () => {
    if (s.dead) return
    s.dead = true
    const err = new Error('the rish session ended (Shizuku down?)')
    if (s.busy) { clearTimeout(s.busy.timer); s.busy.reject(err) }
    for (const q of s.queue.splice(0)) q.reject(err)
  }
  child.on('exit', end)
  child.on('error', end)
  session = s
  return s
}

// The command in flight finishes at its marker; then the next one goes in.
function pump(s: RishSession) {
  if (s.busy) {
    const at = s.buf.indexOf(s.busy.marker)
    const eol = at < 0 ? -1 : s.buf.indexOf('\n', at)
    if (eol < 0) return
    const code = Number(s.buf.slice(at + s.busy.marker.length, eol).trim())
    const out = s.buf.slice(0, at)
    s.buf = s.buf.slice(eol + 1)
    clearTimeout(s.busy.timer)
    s.busy.resolve({ out: out.trim(), code })
    s.busy = null
  }
  const next = !s.busy && !s.dead ? s.queue.shift() : undefined
  if (next) {
    s.busy = next
    next.timer = setTimeout(() => s.child.kill(), next.timeout)   // a stuck command takes the session with it
    // stdin from /dev/null: a command reading it would eat the ones after.
    s.child.stdin.write(`{ { ${next.cmd}\n} </dev/null; echo "${next.marker} $?"; } 2>&1\n`)
  }
}

export function rish(cmd: string, timeout = 20000) {
  return new Promise<{ out: string; code: number }>((resolve, reject) => {
    const s = rishSession()
    if (s.dead) { reject(new Error('rish would not start')); return }
    s.queue.push({ cmd, timeout, resolve, reject, marker: `__ibh_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}__` })
    pump(s)
  })
}

// The first command also starts the session, so it gets time for the VM.
export async function shizukuUp() {
  try { return (await rish('echo ok', 30000)).out.split('\n').includes('ok') } catch (e) { return false }
}

// Ends the session (tests, shutdown); the next command starts a new one.
export function stopRish() {
  if (session && !session.dead) session.child.kill()
  session = null
}
