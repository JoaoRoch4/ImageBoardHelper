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
// IBH_VREDUCE_CACHE_MB, IBH_VIDEO_INTEREST_MS, IBH_VIDEO_BATTERY_MS,
// IBH_VIDEO_WARM_C, IBH_VIDEO_HOT_C, IBH_VIDEO_LOW_BATTERY.
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
  skip?: string
  samples: { t: number; speed: number }[]   // the last 5 s of speeds
  stage?: string
  error?: string
  http?: number
  child?: ChildProcess
  final: string          // where the finished file goes
  partial: string        // where it grows meanwhile
  source?: string        // a saved file (batch) instead of a URL
  saveAs?: string        // copy to the media folder once done (and keep the job wanted)
  paused?: boolean       // SIGSTOPped while the phone is hot
  wasPlayable?: boolean
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

export function makeVideoReducer(deps: VideoDeps) {
  const VREDUCE = process.env.VREDUCE || `${ROOTFS}/root/VideoReducer/build/vreduce`
  const CACHE = process.env.IBH_VREDUCE_CACHE || path.join(fs.existsSync(TERMUX_HOME) ? TERMUX_HOME : os.homedir(), '.cache', 'vreduce')
  const CACHE_MAX = Number(process.env.IBH_VREDUCE_CACHE_MB || 2048) * 1024 * 1024
  const INTEREST_MS = Number(process.env.IBH_VIDEO_INTEREST_MS || 30000)
  const BATTERY_MS = Number(process.env.IBH_VIDEO_BATTERY_MS || 30000)
  const WARM_C = Number(process.env.IBH_VIDEO_WARM_C || 42)
  const HOT_C = Number(process.env.IBH_VIDEO_HOT_C || 45)
  const LOW_BATTERY = Number(process.env.IBH_VIDEO_LOW_BATTERY || 20)
  const LOG = path.join(deps.dir, 'video.log')

  const jobs = new Map<string, VideoJob>()
  let running: VideoJob | null = null
  // The last battery reading; unknown (no Termux:API) means no limit.
  let power: { temp: number | null; pct: number | null; plugged: boolean; at: number } = { temp: null, pct: null, plugged: true, at: 0 }
  const hot = () => power.temp !== null && power.temp > HOT_C
  // Whether a job may start or go on now: hot stops everything; warm, or a
  // low battery while not charging, lets only the video on screen through.
  const allowed = (job: VideoJob) => {
    if (hot()) return false
    const warm = power.temp !== null && power.temp > WARM_C
    const low = power.pct !== null && power.pct < LOW_BATTERY && !power.plugged
    return !(warm || low) || job.priority === 'open'
  }

  // One line per job event, without the URL (hash prefix, duration, speed, skip, temperature).
  function log(event: string, job: VideoJob) {
    const line = `${new Date().toISOString()} ${event} ${job.hash.slice(0, 8)} dur=${job.dur} speed=${speedOf(job).toFixed(2)} skip=${job.skip ?? '-'} temp=${power.temp ?? '-'}\n`
    try { fs.appendFileSync(LOG, line) } catch (e) { /* the log is a convenience */ }
  }

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

  const touch = (job: VideoJob) => { const t = new Date(); try { fs.utimesSync(job.final, t, t) } catch (e) { /* not there yet */ } }

  function view(job: VideoJob) {
    const speed = speedOf(job)
    const ready = playable(job)
    const eta = ready ? 0 : job.state === 'running' && speed > 0 ? Math.ceil((target(job) - job.pos) / speed) : null
    return {
      id: job.id, state: job.state, playable: ready, pos: job.pos, dur: job.dur, speed: Math.round(speed * 100) / 100, eta_s: eta,
      stream: `/v/${job.key}.mp4`, ...(hot() ? { hot: true } : {}),
      ...(job.stage ? { stage: job.stage } : {}), ...(job.error ? { error: job.error } : {}), ...(job.http ? { http: job.http } : {}),
    }
  }

  // SIGTERM to vreduce's process group, SIGKILL if it lingers.
  function kill(child: ChildProcess) {
    if (child.pid === undefined || child.exitCode !== null) return
    try { process.kill(-child.pid, 'SIGTERM'); process.kill(-child.pid, 'SIGCONT') } catch (e) { return }   // a paused process handles SIGTERM once continued
    const pid = child.pid
    setTimeout(() => { if (child.exitCode === null) try { process.kill(-pid, 'SIGKILL') } catch (e) { /* gone */ } }, KILL_AFTER_MS).unref()
  }

  function cancel(job: VideoJob) {
    if (job.state !== 'queued' && job.state !== 'running') return
    job.state = 'cancelled'
    log('cancel', job)
    if (job.child) kill(job.child)   // its exit deletes the partial file
  }

  // A finished conversion copied to the media folder (Download), with a notification.
  async function copySaved(job: VideoJob, name: string) {
    const to = path.join(deps.mediaDir, `${name}.mp4`)
    await fs.promises.mkdir(deps.mediaDir, { recursive: true })
    await fs.promises.copyFile(job.final, to)
    await deps.notify('Image Board Helper', `${name}.mp4 saved in Download`).catch(() => { /* saved all the same */ })
  }

  function start(job: VideoJob) {
    if (!job.source) trimCache()
    job.state = 'running'
    running = job
    log('start', job)
    const args = job.source ? ['file', job.source, job.partial] : ['stream', '--url', job.url, '--referer', job.referer, '--out', job.partial]
    const child = spawn(VREDUCE, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
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
      if (typeof o.skip === 'string') job.skip = o.skip
      if (typeof o.speed === 'number') {
        const now = Date.now()
        job.samples.push({ t: now, speed: o.speed })
        job.samples = job.samples.filter(s => now - s.t <= SPEED_WINDOW_MS)
      }
      if (!job.wasPlayable && playable(job)) { job.wasPlayable = true; log('playable', job) }
    })
    let over = false   // 'error' and 'exit' can both come
    const finish = (code: number | null) => {
      if (over) return
      over = true
      job.child = undefined
      if (job.state === 'running' && code === 0 && doneLine) {
        fs.renameSync(job.partial, job.final)
        job.state = 'done'
        log('done', job)
        if (job.saveAs) copySaved(job, job.saveAs).catch(() => { /* the cache keeps it */ })
      } else {
        if (job.state === 'running') {
          job.state = 'failed'
          job.stage ??= 'process'
          job.error ??= `vreduce exited with ${code}`
          log(`fail ${job.stage}`, job)
        }
        fs.rmSync(job.partial, { force: true })
      }
      if (running === job) running = null
      pump()
    }
    child.on('exit', finish)
    child.on('error', e => { job.error = e.message; job.stage = 'process'; finish(null) })
  }

  // termux-battery-status, at most every 2 s; a failure keeps the last reading.
  async function readBattery() {
    if (Date.now() - power.at < 2000) return
    try {
      const o = JSON.parse(await deps.termux('termux-battery-status', []))
      power = { temp: typeof o.temperature === 'number' ? o.temperature : null, pct: typeof o.percentage === 'number' ? o.percentage : null,
        plugged: typeof o.plugged === 'string' ? o.plugged !== 'UNPLUGGED' : true, at: Date.now() }
    } catch (e) {
      power = { ...power, at: Date.now() }
    }
  }

  // The running job stops (SIGSTOP) while the phone is hot, and goes on below.
  function applyHeat() {
    const job = running
    if (!job?.child?.pid) return
    const stop = !allowed(job)
    if (stop === !!job.paused) return
    try { process.kill(-job.child.pid, stop ? 'SIGSTOP' : 'SIGCONT') } catch (e) { return }
    job.paused = stop
  }

  // The next job: the highest priority the battery allows, then the oldest.
  let pumping = false
  async function pump() {
    if (running || pumping) return
    pumping = true
    try { await readBattery() } finally { pumping = false }
    if (running) return
    const next = [...jobs.values()].filter(j => j.state === 'queued' && allowed(j))
      .sort((a, b) => RANK[b.priority] - RANK[a.priority] || a.created - b.created)[0]
    if (next) start(next)
  }

  // Nobody asked about it for a while (the tab moved on): cancel it, unless
  // it is batch work or waits to be saved.
  const interest = setInterval(() => {
    const now = Date.now()
    for (const job of jobs.values()) if (job.priority !== 'batch' && !job.saveAs && now - job.lastPoll > INTEREST_MS) cancel(job)
  }, Math.max(100, Math.min(1000, INTEREST_MS / 4)))
  interest.unref()
  const batteryTimer = setInterval(() => { power.at = 0; readBattery().then(() => { applyHeat(); pump() }) }, BATTERY_MS)
  batteryTimer.unref()

  // vreduce probe on a saved file: does it need converting?
  function probe(file: string) {
    return new Promise<Record<string, unknown> | null>(resolve => {
      const child = spawn(VREDUCE, ['probe', file], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      child.stdout.on('data', d => { out += d })
      child.on('error', () => resolve(null))
      child.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').at(-1) ?? '')) } catch (e) { resolve(null) } })
    })
  }

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
          created: Date.now(), lastPoll: Date.now(), pos: 0, dur: 0, samples: [],
          final: path.join(CACHE, `${hash}.mp4`), partial: path.join(CACHE, `${hash}.part.mp4`) }
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

    'video/save': async body => {
      const job = jobs.get(text(body, 'id'))
      if (!job) throw new HttpError(404, 'no such video')
      const name = typeof body.name === 'string' ? body.name : ''
      if (!/^[\w-][\w.-]{0,79}$/.test(name)) throw new HttpError(400, 'name must be 1-80 letters, digits, _ . - (not starting with a dot)')
      if (job.state === 'done') { await copySaved(job, name); return { saved: true } }
      if (job.state !== 'queued' && job.state !== 'running') throw new HttpError(409, `the conversion is ${job.state}`)
      job.saveAs = name
      return { saved: false, later: true }
    },

    // Saved files past the decoder, converted to <name>.1080p.mp4 beside them.
    'video/batch': async body => {
      if (!Array.isArray(body.paths)) throw new HttpError(400, 'paths must be a list')
      const queued: string[] = []
      for (const p of body.paths) {
        if (typeof p !== 'string' || !path.isAbsolute(p) || /\.1080p\.mp4$/.test(p)) continue
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue
        const final = `${p.replace(/\.[^./]+$/, '')}.1080p.mp4`
        if (fs.existsSync(final)) continue
        if ((await probe(p))?.fits !== false) continue
        const hash = crypto.createHash('sha256').update(`file:${p}`).digest('hex')
        jobs.set(hash.slice(0, 16), { id: hash.slice(0, 16), key: crypto.randomBytes(32).toString('hex'), url: '', referer: '', hash, priority: 'batch',
          state: 'queued', created: Date.now(), lastPoll: Date.now(), pos: 0, dur: 0, samples: [], source: p, final, partial: final.replace(/\.mp4$/, '.part.mp4') })
        queued.push(p)
      }
      pump()
      return { queued }
    },
  }

  function serveMedia(_req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(404, { ...CORP, 'content-type': 'text/plain' }).end('no such video')
  }

  // The server is going away: vreduce, in its own process group, goes too
  // (continued first, in case the heat had stopped it).
  function stop() {
    clearInterval(interest)
    clearInterval(batteryTimer)
    for (const job of jobs.values()) if (job.child?.pid !== undefined) try { process.kill(-job.child.pid, 'SIGTERM'); process.kill(-job.child.pid, 'SIGCONT') } catch (e) { /* gone */ }
  }

  return { routes, serveMedia, stop }
}
