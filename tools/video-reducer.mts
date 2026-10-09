// Development helper, not part of the userscript.
//
// The phone server's video routes (part 2): VideoReducer's `vreduce`
// converts booru videos past the phone's hardware decoder, one at a time,
// into a growing fragmented MP4 that Firefox plays from /v/<key>.mp4. The
// HTTP contract is VideoReducer's spec
// (/root/VideoReducer/docs/superpowers/specs/2026-10-08-videoreducer-design.md);
// this side's design is
// docs/superpowers/specs/2026-10-09-video-reducer-integration-design.md.
// No HTTP server of its own: tools/phone-server.mts routes to it.
//
// Paths and limits the tests override: VREDUCE, IBH_VREDUCE_CACHE,
// IBH_VREDUCE_CACHE_MB, IBH_VIDEO_INTEREST_MS.
// TypeScript that Node runs as it is (it strips the types); tsc -p tools checks it.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as readline from 'node:readline'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type * as http from 'node:http'
import { ROOTFS } from './rish.mts'
import { HttpError } from './http-error.mts'
import type { Handler } from './http-error.mts'

// What the server lends it: Termux's commands, its folder, the media folder.
export interface VideoDeps {
  termux(name: string, args: string[]): Promise<string>
  dir: string
  mediaDir: string
  notify(title: string, text: string): Promise<void>
}

type Priority = 'open' | 'next' | 'batch'
type State = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

interface VideoJob {
  id: string
  key: string            // the /v/ capability: 32 random bytes in hex
  url: string
  referer: string
  hash: string           // SHA-256 of the URL: the cache file's name
  priority: Priority
  state: State
  created: number
  lastPoll: number
  pos: number
  dur: number
  samples: { t: number; speed: number }[]   // the last 5 s of speeds
  stage?: string
  error?: string
  http?: number
  child?: ChildProcess
}

const TERMUX_HOME = '/data/data/com.termux/files/home'
const RANK: Record<Priority, number> = { open: 3, next: 2, batch: 1 }
const SPEED_WINDOW_MS = 5000
const KILL_AFTER_MS = 5000
// The boorus whose files may be fetched: a caller holding the token still
// cannot make the server read an arbitrary address.
const BOORUS = ['rule34.xxx', 'gelbooru.com', 'safebooru.org', 'xbooru.com']
// /v/ answers are read by a <video> in a booru page: allowed cross-origin.
const CORP = { 'cross-origin-resource-policy': 'cross-origin' }

function booruUrl(url: string) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && BOORUS.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`))
  } catch (e) {
    return false
  }
}

function text(body: Record<string, unknown>, key: string) {
  const v = body[key]
  if (typeof v !== 'string' || !v) throw new HttpError(400, `${key} is required`)
  return v
}

// Average speed over the window; playable once playback cannot catch up
// with the conversion (the contract's rule).
const speedOf = (job: VideoJob) => job.samples.length ? job.samples.reduce((a, s) => a + s.speed, 0) / job.samples.length : 0
const target = (job: VideoJob) => 1.2 * job.dur * (1 - speedOf(job)) + 2
const playable = (job: VideoJob) => job.state === 'done' || (job.state === 'running' && job.dur > 0 && job.pos >= target(job))

export function makeVideoReducer(_deps: VideoDeps) {
  const VREDUCE = process.env.VREDUCE || `${ROOTFS}/root/VideoReducer/build/vreduce`
  const CACHE = process.env.IBH_VREDUCE_CACHE || path.join(fs.existsSync(TERMUX_HOME) ? TERMUX_HOME : os.homedir(), '.cache', 'vreduce')
  const CACHE_MAX = Number(process.env.IBH_VREDUCE_CACHE_MB || 2048) * 1024 * 1024
  const INTEREST_MS = Number(process.env.IBH_VIDEO_INTEREST_MS || 30000)

  const jobs = new Map<string, VideoJob>()
  let running: VideoJob | null = null
  const file = (job: VideoJob) => path.join(CACHE, `${job.hash}.mp4`)
  const part = (job: VideoJob) => path.join(CACHE, `${job.hash}.part.mp4`)

  // Partial files left by a server that died mid-job are worthless.
  fs.mkdirSync(CACHE, { recursive: true })
  for (const f of fs.readdirSync(CACHE)) if (f.endsWith('.part.mp4')) fs.rmSync(path.join(CACHE, f), { force: true })

  // Least recently used first, until the cache fits (mtime = last use).
  function trimCache() {
    const files = fs.readdirSync(CACHE).filter(f => f.endsWith('.mp4') && !f.endsWith('.part.mp4'))
      .map(f => { const st = fs.statSync(path.join(CACHE, f)); return { f, size: st.size, used: st.mtimeMs } })
      .sort((a, b) => a.used - b.used)
    let total = files.reduce((a, x) => a + x.size, 0)
    for (const x of files) {
      if (total <= CACHE_MAX) break
      fs.rmSync(path.join(CACHE, x.f), { force: true })
      total -= x.size
    }
  }

  const touch = (job: VideoJob) => { const t = new Date(); try { fs.utimesSync(file(job), t, t) } catch (e) { /* not there yet */ } }

  function view(job: VideoJob) {
    const speed = speedOf(job)
    const ready = playable(job)
    const eta = ready ? 0 : job.state === 'running' && speed > 0 ? Math.ceil((target(job) - job.pos) / speed) : null
    return {
      id: job.id, state: job.state, playable: ready, pos: job.pos, dur: job.dur, speed: Math.round(speed * 100) / 100, eta_s: eta,
      stream: `/v/${job.key}.mp4`,
      ...(job.stage ? { stage: job.stage } : {}), ...(job.error ? { error: job.error } : {}), ...(job.http ? { http: job.http } : {}),
    }
  }

  // SIGTERM to vreduce's process group, SIGKILL if it lingers.
  function kill(child: ChildProcess) {
    if (child.pid === undefined || child.exitCode !== null) return
    try { process.kill(-child.pid, 'SIGTERM') } catch (e) { return }
    const pid = child.pid
    setTimeout(() => { if (child.exitCode === null) try { process.kill(-pid, 'SIGKILL') } catch (e) { /* gone */ } }, KILL_AFTER_MS).unref()
  }

  function cancel(job: VideoJob) {
    if (job.state !== 'queued' && job.state !== 'running') return
    job.state = 'cancelled'
    if (job.child) kill(job.child)   // its exit deletes the partial file
  }

  function start(job: VideoJob) {
    trimCache()
    job.state = 'running'
    running = job
    const child = spawn(VREDUCE, ['stream', '--url', job.url, '--referer', job.referer, '--out', part(job)], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    job.child = child
    let doneLine = false
    readline.createInterface({ input: child.stdout! }).on('line', line => {
      let o: Record<string, unknown>
      try { o = JSON.parse(line) } catch (e) { return }
      if (o.done) { doneLine = true; return }
      if (typeof o.error === 'string') {
        job.error = o.error
        job.stage = typeof o.stage === 'string' ? o.stage : undefined
        job.http = typeof o.http === 'number' ? o.http : undefined
        return
      }
      if (typeof o.pos === 'number') job.pos = o.pos
      if (typeof o.dur === 'number') job.dur = o.dur
      if (typeof o.speed === 'number') {
        const now = Date.now()
        job.samples.push({ t: now, speed: o.speed })
        job.samples = job.samples.filter(s => now - s.t <= SPEED_WINDOW_MS)
      }
    })
    let over = false   // 'error' and 'exit' can both come
    const finish = (code: number | null) => {
      if (over) return
      over = true
      job.child = undefined
      if (job.state === 'running' && code === 0 && doneLine) {
        fs.renameSync(part(job), file(job))
        job.state = 'done'
      } else {
        if (job.state === 'running') {
          job.state = 'failed'
          job.stage ??= 'process'
          job.error ??= `vreduce exited with ${code}`
        }
        fs.rmSync(part(job), { force: true })
      }
      if (running === job) running = null
      pump()
    }
    child.on('exit', finish)
    child.on('error', e => { job.error = e.message; job.stage = 'process'; finish(null) })
  }

  // The next job: highest priority, then the oldest.
  function pump() {
    if (running) return
    const next = [...jobs.values()].filter(j => j.state === 'queued')
      .sort((a, b) => RANK[b.priority] - RANK[a.priority] || a.created - b.created)[0]
    if (next) start(next)
  }

  // Nobody asked about it for a while (the tab moved on): cancel it.
  const interest = setInterval(() => {
    const now = Date.now()
    for (const job of jobs.values()) if (job.priority !== 'batch' && now - job.lastPoll > INTEREST_MS) cancel(job)
  }, Math.max(100, Math.min(1000, INTEREST_MS / 4)))
  interest.unref()

  const routes: Record<string, Handler> = {
    'video/reduce': async body => {
      const url = text(body, 'url')
      if (!booruUrl(url)) throw new HttpError(400, 'url must be an https link on a booru')
      const referer = typeof body.referer === 'string' && body.referer ? body.referer : `${new URL(url).origin}/`
      const priority: Priority = body.priority === 'next' ? 'next' : 'open'
      const wanted = body.start !== false
      const hash = crypto.createHash('sha256').update(url).digest('hex')
      const id = hash.slice(0, 16)
      let job = jobs.get(id)
      // A cancelled or failed job asked for again starts over.
      if (job && wanted && (job.state === 'cancelled' || job.state === 'failed')) { jobs.delete(id); job = undefined }
      if (!job) {
        const cached = fs.existsSync(path.join(CACHE, `${hash}.mp4`))
        if (!cached && !wanted) return { state: 'none' }
        job = { id, key: crypto.randomBytes(32).toString('hex'), url, referer, hash, priority, state: cached ? 'done' : 'queued',
          created: Date.now(), lastPoll: Date.now(), pos: 0, dur: 0, samples: [] }
        jobs.set(id, job)
      }
      job.lastPoll = Date.now()
      if (job.state === 'done') { touch(job); return { id, state: job.state, stream: `/v/${job.key}.mp4` } }
      if (!wanted) return { id, state: job.state, stream: `/v/${job.key}.mp4` }
      if (RANK[priority] > RANK[job.priority]) job.priority = priority
      if (job.priority === 'open') {
        // The newest open wins: the older one is the post the user swiped away from.
        for (const other of jobs.values()) if (other !== job && other.priority === 'open') cancel(other)
        // A running next or batch job gives way: killed, its partial file deleted; batch starts over later.
        if (running && running !== job && running.priority !== 'open') {
          const preempted = running
          if (preempted.priority === 'batch') {
            preempted.state = 'queued'
            preempted.created = Date.now()
            if (preempted.child) kill(preempted.child)
          } else cancel(preempted)
        }
      }
      pump()
      return { id, state: job.state, stream: `/v/${job.key}.mp4` }
    },

    'video/status': async body => {
      const job = jobs.get(text(body, 'id'))
      if (!job) throw new HttpError(404, 'no such video')
      job.lastPoll = Date.now()
      return view(job)
    },

    'video/cancel': async body => {
      const job = jobs.get(text(body, 'id'))
      if (!job) throw new HttpError(404, 'no such video')
      cancel(job)
      return {}
    },
  }

  function serveMedia(_req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(404, { ...CORP, 'content-type': 'text/plain' }).end('no such video')
  }

  // The server is going away: vreduce, in its own process group, goes too.
  function stop() {
    clearInterval(interest)
    for (const job of jobs.values()) if (job.child?.pid !== undefined) try { process.kill(-job.child.pid, 'SIGTERM') } catch (e) { /* gone */ }
  }

  return { routes, serveMedia, stop }
}
