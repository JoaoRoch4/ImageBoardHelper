import type { ReelShow } from './reel'
import { ACCENT } from '../core/site'
import { CFG } from '../core/config'
import { t } from '../core/i18n'
import { dbg, describeError, info } from '../core/log'
import { fileCandidates, thumbParts } from '../urls/hosts'
import { cacheGet, cacheSet, cachedFirst } from '../urls/url-cache'
import { pastDecoder } from '../video/limits'
import { markDuration, markPastDecoder } from '../thumbs/badges'
import { COVER_MAX_LIVE, COVER_POINT, cardPicture, coverQueue, liveCovers, markedCards, nextGif, releaseCover, setLiveCovers, unmountCover } from '../thumbs/covers'
import { endReel, startReelShow } from './reel'
import { afterPreview, freeForPreview } from '../thumbs/memory'
import { asElement, insidePanel, modal } from '../modal/modal'
import { setCfg } from '../storage/storage'
import { mmss } from '../modal/player'
import { postId } from '../modal/media'

// ═══════════════════════════════════════════════════════════
// C. Scene preview
//
// Drag a finger sideways across a video thumbnail to see its scenes (left
// edge = start, right edge = end), and drag the modal's seek bar to see the
// frame under the finger. Both use the same tools: a card's own cover when
// it is loaded, otherwise one small shared preview <video>, so previews
// never cost more than one decoder.
// ═══════════════════════════════════════════════════════════

// Seeking under a finger. Measured on the phone: a seek into a part of the
// file not downloaded yet took 4-5 s (about 500 KB/s, and Firefox fetches a
// large chunk per seek). So:
//  - a target already buffered is seeked at once;
//  - otherwise wait until the finger rests (180 ms) and fetch only that spot,
//    instead of queuing a download for every position the finger crossed;
//  - one seek in flight at a time, keeping only the latest target.
// Clips up to a minute seek exactly (short clips have sparse keyframes, so
// fastSeek barely changed the frame); longer ones use fastSeek.
const EXACT_SEEK_MAX_S = 60
const REST_MS = 180
// wanted: the seek to start once the one in flight lands; pending: the
// fraction asked before the duration was known; rest: the finger-rest timer.
export type SeekState = { wanted: number | null, pending: number | null, rest: number }
const seekState: WeakMap<HTMLVideoElement, SeekState> = new WeakMap()

const isBuffered = (v: HTMLVideoElement, t: number) => {
  for (let i = 0; i < v.buffered.length; i++) if (t >= v.buffered.start(i) && t <= v.buffered.end(i)) return true
  return false
}

// `now`: no finger moving (the slideshow), so the rest wait is only a delay.
export function seekFraction(v: HTMLVideoElement, f: number, now: boolean = false) {
  let st = seekState.get(v)
  if (!st) {
    st = { wanted: null, pending: null, rest: 0 }
    seekState.set(v, st)
    // These run with st set for good (no narrowing reaches into them).
    v.addEventListener('seeked', () => {
      if ((st as SeekState).wanted === null) return
      const t = (st as SeekState).wanted as number
      ;(st as SeekState).wanted = null
      seekTo(v, t)
    })
    // Asked before the duration was known: seek once it is.
    v.addEventListener('loadedmetadata', () => {
      if ((st as SeekState).pending === null) return
      const p = (st as SeekState).pending as number
      ;(st as SeekState).pending = null
      seekFraction(v, p, true)
    })
  }
  const d = v.duration
  if (!Number.isFinite(d) || d <= 0) { st.pending = f; return null }
  const t = f * d
  clearTimeout(st.rest)
  if (v.seeking) st.wanted = t
  else if (now || isBuffered(v, t)) seekTo(v, t)
  else st.rest = setTimeout(() => { if (v.seeking) st.wanted = t; else seekTo(v, t) }, REST_MS)
  return { t, d }
}

function seekTo(v: HTMLVideoElement, t: number) {
  if (v.duration > EXACT_SEEK_MAX_S && typeof v.fastSeek === 'function') v.fastSeek(t)
  else v.currentTime = t   // exact: decodes from the keyframe up to this frame
}

// The shared preview video.
export let previewEl: HTMLVideoElement | null = null
export function setPreviewEl(v: typeof previewEl) { previewEl = v }

/**
 * @param hash   the file's, to cache the host that has it
 */
export function previewLoad(container: HTMLElement, urls: string[], hash: string | null | undefined) {
  if (!previewEl) {
    previewEl = document.createElement('video')
    previewEl.muted = true
    previewEl.playsInline = true
    previewEl.preload = 'auto'
    previewEl.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;background:#000'
  }
  const v = previewEl
  let i = 0
  v.onerror = () => { if (i < urls.length) v.src = urls[i++] }   // walk the hosts, like covers
  v.onloadedmetadata = () => { if (hash) cacheSet('video', hash, urls[i - 1]) }
  v.src = urls[i++]
  container.insertBefore(v, container.firstChild)
  return v
}

export function previewStop() {
  if (!previewEl) return
  previewEl.onerror = previewEl.onloadedmetadata = null
  previewEl.removeAttribute('src')
  previewEl.load()   // hand the decoder back
  previewEl.remove()
}

// The preview needs a decoder of its own on the page. With every cover slot
// taken, close the cover of another card and queue it to come back.
// A count: the slideshow borrows a second decoder for its helper video.
export let decodersBorrowed = 0

export function borrowDecoder(card: HTMLElement) {
  decodersBorrowed++
  setLiveCovers(liveCovers + 1)
  if (liveCovers <= COVER_MAX_LIVE) return
  const victim = [...markedCards('[data-ibh-cover]')].find(c => c !== card)
  if (!victim) return
  unmountCover(victim)   // its releaseCover sees the budget still full: nothing remounts
  if (victim.dataset.ibhSeen) coverQueue.add(victim)
}

export function returnDecoder() {
  if (!decodersBorrowed) return
  decodersBorrowed--
  releaseCover()   // a queued cover takes the slot back
}

// Right above the picture, under anything the site lays over it.
export function placeOverPicture(card: HTMLElement, node: Node) {
  if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
  const picEl = card.querySelector(':scope > img')
  if (picEl) picEl.after(node)
  else card.appendChild(node)
}

// ── Scrubbing a thumbnail ──
const SCRUB_SLOP = 8   // px of travel before a drag counts as a scrub or a scroll

// A finger on a video card, from the touch to the lift. It starts with the
// pointer's fields; scrubSource, scrubUi and the slideshow fill in the rest
// before reading them.
export type Scrub = {
  card: HTMLElement,
  id: number,   // the pointer
  x0: number,
  y0: number,
  on: boolean,   // previewing: the bar and the label are up
  holdTimer: number,
  video: HTMLVideoElement,   // what it seeks: the card's cover, or the shared preview
  holder?: HTMLElement,   // the shared preview's box
  shared?: boolean,   // video is the shared preview
  bar: HTMLElement,
  label: HTMLElement,
  stats: SlideStats,   // a hold's slideshow, for the log
  steps: number[],   // the seeking slideshow's scenes, as fractions of the video
  step: number,   // the next one
  dwell: number,   // ms a scene stays once painted
  views: SlideView[],
  queue: SlideView[],   // views seeking a scene, in the order they will show
  front: SlideView | null,   // the view on screen
  helper?: SlideView | null,
  shownAt: number,
  tick?: number,
  reel?: ReelShow | null,
  played: { rate: number, loop: boolean, muted: boolean },   // the video's own, while a short clip (or holdVideo) plays
  onPlayTime?: (() => void) | null,
  rub?: Rub | null,   // the finger sliding a playing hold (holdRub)
}

export type SlideStats = { t0: number, method: string | null, first: number | null, last: number, shown: number, gaps: number[], detail?: string, wasm?: string, reelError?: string, rate?: number, fps?: number, sound?: string, resumed?: number, kept?: number, rubs?: number }
export type SlideView = { v: HTMLVideoElement, helper: boolean, f: number, ready: boolean, slow: boolean, since: number, onSeeked?: () => void }

export let scrub: Scrub | null = null
let scrubClickUntil = 0

function onScrubDown(ev: PointerEvent) {
  if (scrub || insidePanel(ev) || (modal && modal.open)) return
  if (ev.pointerType === 'mouse' && ev.button !== 0) return
  // A press on a hold chip (⏮, 🔊) is a tap on it (onScrubClick), not a hold.
  if (asElement(ev.target)?.closest('[data-ibh-chip], .ibh-liked')) return
  // data-ibh-video marks cards (trackCard).
  const card = asElement(ev.target)?.closest('[data-ibh-video]') as HTMLElement | null | undefined
  if (!card || card.dataset.ibhKind === 'gif') return
  scrub = { card, id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, on: false, holdTimer: 0 } as Scrub
  // Hold mode: a still finger for HOLD_MS starts the slideshow.
  if (CFG.scrubMode === 'hold') scrub.holdTimer = setTimeout(startSlideshow, HOLD_MS)
}

// ── Hold for a slideshow ──
// The scenes step from 00:00 through the video and loop, each shown for a
// moment once painted; lifting the finger stops it.
// Two videos take turns, like double buffering: while one shows a scene, the
// other, hidden, is already seeking and downloading the next. Each <video>
// fetches and decodes on the browser's own threads, so the two load in
// parallel, and a swap only flips the helper's opacity.
const HOLD_MS = 200
const SLIDE_WAIT_MS = 1000   // a scene still loading after this lets the other video go ahead
const SLIDE_TICK_MS = 50

// Scene positions for a jump of `slideStep` %, from the start of the video:
// 10% gives 0%, 10% … 90%, and 25% gives 0%, 25%, 50%, 75%.
export function slideSteps() {
  const n = Math.max(2, Math.round(100 / (Number(CFG.slideStep) || 10)))
  return Array.from({ length: n }, (_, i) => i / n)
}

function startSlideshow() {
  if (!scrub || scrub.on) return
  scrub.stats = { t0: performance.now(), method: null, first: null, last: 0, shown: 0, gaps: [] }
  // holdVideo: the video itself, unless its cover already knows it is past
  // the hardware decoder (then the slideshow below, as without the option).
  if (CFG.holdVideo && !scrub.card.dataset.ibhBigVideo) {
    if (!startScrub()) { dropScrub(); return }
    holdVideoShow(scrub)
    return
  }
  if (CFG.slideReel && startReelShow(scrub)) return
  if (!startScrub()) { dropScrub(); return }
  if (CFG.slideReel) chooseShow(scrub)   // WebM: no reel, but a short clip plays
  else seekShow(scrub)
}


// holdVideo: the video plays from its start at 1×, muted and looping, in a
// <video>, which Firefox decodes on the phone's hardware decoder (the GPU
// path) instead of the slideshow's keyframes on the CPU. One past that
// decoder would play on the CPU and stutter: it gets the scenes instead,
// by its size at once, or by its frame rate a second into playing (a
// <video> doesn't tell its fps: frames counted over the time played).
const HOLD_FPS_SLACK = 1.04

function holdVideoShow(s: Scrub) {
  const v = s.video
  // Past the decoder the slideshow is forced: from keyframes when the file
  // has an index to read (MP4), else by seeking the file.
  const tooHeavy = (what: string) => {
    markPastDecoder(s.card, what)
    info(`hold: ${what} is past the hardware decoder, the slideshow instead of the video`)
    if (!(CFG.slideReel && startReelShow(s))) seekShow(s)
  }
  const decide = () => {
    if (scrub !== s) return
    markDuration(s.card, v.duration)
    if (pastDecoder(v.videoWidth, v.videoHeight)) { tooHeavy(`${v.videoWidth}x${v.videoHeight}`); return }
    playShow(s, 1, 0)   // from 00:00, or where the last hold lifted (holdResume)
    const frames = () => (v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : 0)
    let start: { f: number, t: number } | null = null
    const measure = () => {
      if (scrub !== s || s.stats.method !== 'play') { v.removeEventListener('timeupdate', measure); return }
      if (v.paused || v.seeking) { start = null; return }   // a rub (holdRub): count again once it plays
      if (!start) { start = { f: frames(), t: v.currentTime }; return }
      const dt = v.currentTime - start.t
      if (dt < 0) { start = null; return }   // looped back: count again
      if (dt < 1) return
      v.removeEventListener('timeupdate', measure)
      const fps = (frames() - start.f) / dt
      s.stats.fps = fps
      // Frames counted over a second wobble by one or two: the rule gets
      // the rate with that slack taken off (1080p60 counted as 61 fits).
      if (!pastDecoder(v.videoWidth, v.videoHeight, fps / HOLD_FPS_SLACK)) return
      endPlayShow(s)
      tooHeavy(`${v.videoWidth}x${v.videoHeight} at ${Math.round(fps)} fps`)
    }
    v.addEventListener('timeupdate', measure)
  }
  if (v.readyState >= 1) decide()
  else v.addEventListener('loadedmetadata', decide, { once: true })
}

// The slideshow by seeking the file itself, two videos taking turns.
function seekShow(s: Scrub) {
  s.stats.method = 'seek'
  const base = s.video
  // Read here, so a change in the panel applies to the next hold.
  s.steps = slideSteps()
  s.dwell = (Number(CFG.slideDwell) || 0.2) * 1000
  s.step = 0   // always from 00:00
  s.views = [slideView(s, base, false)]
  s.queue = []        // views seeking a scene, in the order they will show
  s.front = null      // the view on screen
  s.shownAt = 0
  s.label.textContent = '…'
  loadSlide(s, s.views[0])
  // The helper needs the host the first video settled on.
  const withSrc = () => { if (scrub === s) addSlideHelper(s) }
  if (base.readyState >= 1) withSrc()
  else base.addEventListener('loadedmetadata', withSrc, { once: true })
  s.tick = setInterval(() => tickSlide(s), SLIDE_TICK_MS)
}

function slideView(s: Scrub, v: HTMLVideoElement, helper: boolean) {
  const view: SlideView = { v, helper, f: 0, ready: false, slow: false, since: 0 }
  // Ready once its own seek landed. A stale seek ending makes seekFraction
  // start the wanted one right away, so look after the other listeners ran.
  view.onSeeked = () => setTimeout(() => {
    if (v.seeking) return
    view.ready = true
    view.slow = false
    tickSlide(s)   // swap now if the dwell is over, not on the next tick
  }, 0)
  v.addEventListener('seeked', view.onSeeked)
  return view
}

// Hand a view the next scene to fetch.
function loadSlide(s: Scrub, view: SlideView) {
  view.f = s.steps[s.step++ % s.steps.length]
  view.ready = false
  view.since = Date.now()
  s.queue.push(view)
  seekFraction(view.v, view.f, true)
}

function addSlideHelper(s: Scrub) {
  const src = s.video.currentSrc
  if (!src) return
  borrowDecoder(s.card)
  const h = document.createElement('video')
  h.muted = true
  h.playsInline = true
  // Only the ranges it seeks to: the first video already downloads the whole
  // file, and a second full download of the same file halves the speed of both.
  h.preload = 'metadata'
  h.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
    'border-radius:4px;pointer-events:none;opacity:0'
  h.onerror = () => { if (scrub === s) dropSlideHelper(s) }   // no decoder free: carry on with one
  h.src = src
  s.video.after(h)   // right above the first video
  const view = slideView(s, h, true)
  s.helper = view
  s.views.push(view)
  loadSlide(s, view)
}

function dropSlideHelper(s: Scrub) {
  const view = s.helper
  if (!view) return
  s.helper = null
  view.v.removeEventListener('seeked', view.onSeeked as () => void)   // set by slideView
  view.v.onerror = null
  view.v.removeAttribute('src')
  view.v.load()   // hand the decoder back
  view.v.remove()
  returnDecoder()
  s.views = s.views.filter(o => o !== view)
  s.queue = s.queue.filter(o => o !== view)
  if (s.front === view) s.front = null
  if (!s.queue.length) loadSlide(s, s.views[0])
}

function showSlide(s: Scrub, view: SlideView) {
  if (s.helper) s.helper.v.style.opacity = view === s.helper ? '1' : '0'
  const d = view.v.duration
  s.bar.style.width = `${view.f * 100}%`
  s.label.textContent = `${mmss(view.f * d)} / ${mmss(d)}`
  noteScene(s)
}

// What a hold costs, for the log: the wait for the first scene, then
// between scenes (the dwell is the floor).
export function noteScene(s: Scrub) {
  const st = s.stats
  if (!st) return
  const now = performance.now()
  if (st.first === null) st.first = now - st.t0
  else st.gaps.push(now - st.last)
  st.last = now
  st.shown++
}

function logSlideStats(s: Scrub) {
  const st = s.stats
  if (!st || !st.method) return
  const dwell = (Number(CFG.slideDwell) || 0.2) * 1000
  const avg = st.gaps.length ? Math.round(st.gaps.reduce((a, b) => a + b, 0) / st.gaps.length) : 0
  const late = st.gaps.filter(g => g > dwell + 300).length
  const shown = st.first === null ? `no scene in ${Math.round(performance.now() - st.t0)} ms`
    : st.method === 'play' ? `playing after ${Math.round(st.first)} ms at ${st.rate ?? PLAY_RATE}×${st.fps ? `, ${Math.round(st.fps)} fps` : ''}${st.sound ? `, ${st.sound}` : ''}` +
        (st.resumed !== undefined ? `, resumed at ${mmss(st.resumed)}` : '') + (st.kept !== undefined ? `, lifted at ${mmss(st.kept)}` : '') +
        (st.rubs ? `, rubbed ${st.rubs}×` : '')
      : `${st.shown} scenes, first after ${Math.round(st.first)} ms${avg ? `, then every ${avg} ms` : ''} (dwell ${dwell}), ${late} late`
  const v = s.video
  const what = (st.detail || (v ? `${v.videoWidth}x${v.videoHeight}, ${mmss(v.duration)}, ${s.shared ? 'own video' : 'its cover'}` : '')) +
    (st.wasm ? `, ${st.wasm}` : '')
  info(`slideshow (${st.method}) post ${postId(s.card)}: ${shown}${what ? `; ${what}` : ''}${st.reelError ? `; no reel: ${st.reelError}` : ''}`)
}

function tickSlide(s: Scrub) {
  if (scrub !== s) return
  const now = Date.now()
  if (now - s.shownAt >= s.dwell) {
    // The first view ready shows, even past a slower one still seeking.
    const i = s.queue.findIndex(o => o.ready)
    if (i >= 0) {
      const view = s.queue[i]
      const overtaken = s.queue.splice(0, i + 1).slice(0, i)
      const prev = s.front
      showSlide(s, view)
      s.front = view
      s.shownAt = now
      // Its scene was skipped: aim it further on. It stays busy until the
      // seek in flight lands, so the next scene does not wait for it.
      for (const o of overtaken) { loadSlide(s, o); o.slow = true }
      if (prev && prev !== view && !s.queue.includes(prev)) loadSlide(s, prev)   // just hidden: fetch the scene after next
    } else if (s.queue.length && (s.queue[0].slow || now - s.queue[0].since > SLIDE_WAIT_MS) &&
               s.front && !s.queue.includes(s.front)) {
      // The scene in line is slow to load (that video stays busy until its
      // seek lands): the video on screen fetches the next one meanwhile.
      loadSlide(s, s.front)
    }
  }
  // A single video (no helper yet, or none free) fetches the next scene after the dwell.
  if (!s.queue.length && s.front && now - s.shownAt >= s.dwell) loadSlide(s, s.front)
}

function endSlideshow(s: Scrub) {
  clearInterval(s.tick)
  for (const view of s.views || []) view.v.removeEventListener('seeked', view.onSeeked as () => void)
  const helper = s.helper
  if (!helper) return
  // A cover keeps the last scene shown, even one the helper was showing.
  if (s.front === helper && !s.shared) seekFraction(s.video, helper.f, true)
  s.queue = []
  s.helper = null
  helper.v.onerror = null
  helper.v.removeAttribute('src')
  helper.v.load()
  helper.v.remove()
  returnDecoder()
}

// Short clips: few keyframes make poor scenes, and an exact seek decodes
// everything up to it (an 11 s 1440x1708 clip showed nothing in 5 s).
// Played muted and faster, the clip shows all of it in sequence, the way
// a decoder works best. Past the hardware decoder, seeking stays.
export const PLAY_MAX_S = 30
const PLAY_RATE = 2

export function chooseShow(s: Scrub) {
  const v = s.video
  const decide = () => {
    if (scrub !== s) return
    markDuration(s.card, v.duration)
    if (v.duration <= PLAY_MAX_S && !pastDecoder(v.videoWidth, v.videoHeight) && !s.card.dataset.ibhBigVideo) playShow(s)
    else seekShow(s)
  }
  if (v.readyState >= 1) decide()
  else v.addEventListener('loadedmetadata', decide, { once: true })
}

/**
 * @param rate   PLAY_RATE for a short clip, 1 for holdVideo
 * @param from   s to start at; left out, where the video is (a cover keeps its last frame)
 */
export function playShow(s: Scrub, rate: number = PLAY_RATE, from?: number) {
  s.stats.method = 'play'
  s.stats.rate = rate
  const v = s.video
  // holdResume: a hold lifted less than a minute ago goes on from there.
  const resumed = resumePoint(s.card)
  if (resumed !== null) s.stats.resumed = resumed
  const at = resumed ?? from
  // A play() during the seek starts once the seek lands.
  if (at !== undefined && at !== v.currentTime) v.currentTime = at
  s.played = { rate: v.playbackRate, loop: v.loop, muted: v.muted }
  v.loop = true
  v.playbackRate = rate
  // previewSound: the hold started on a timer, not inside the touch, so the
  // browser allows sound only if the page was tapped before (its sticky
  // user activation). Refused, it plays muted as before.
  v.muted = !CFG.previewSound
  if (CFG.previewSound) s.stats.sound = 'with sound'
  soundChip(s.card)
  s.onPlayTime = () => {
    if (scrub !== s || !v.duration || s.rub?.active()) return   // a rub paints its own target
    s.bar.style.width = `${(v.currentTime / v.duration) * 100}%`
    s.label.textContent = `${mmss(v.currentTime)} / ${mmss(v.duration)} · ${rate}×`
  }
  v.addEventListener('timeupdate', s.onPlayTime)
  v.addEventListener('playing', () => { if (scrub === s) noteScene(s) }, { once: true })
  const go = () => {
    if (scrub !== s) return
    v.play().catch(e => {
      if (e.name !== 'NotAllowedError' || v.muted || scrub !== s) { dbg(`slideshow: play refused — ${describeError(e)}`); return }
      s.stats.sound = 'muted: sound blocked until the page is tapped'
      v.muted = true
      v.play().catch(e2 => dbg(`slideshow: play refused — ${describeError(e2)}`))
    })
  }
  if (v.readyState >= 2) go()
  else v.addEventListener('canplay', go, { once: true })
}

// The cover keeps the frame where the finger lifted, as after a scrub.
function endPlayShow(s: Scrub) {
  const v = s.video
  v.removeEventListener('timeupdate', s.onPlayTime as () => void)   // called while it is set
  s.onPlayTime = null
  v.pause()
  v.playbackRate = s.played.rate
  v.loop = s.played.loop
  v.muted = s.played.muted   // a cover goes back to muted: unmuted, it could not autoplay
}

// ── Resume a hold (holdResume) ──
// Lifting the finger off a hold that plays the video keeps where it was for
// a minute: holding the same post again plays on from there, sound and all.
// Meanwhile the card shows two chips: ⏮ and that time (a tap drops the
// spot, and the cover goes back to its own frame), and 🔊/🔇, which
// switches previewSound. They go a minute after the last lift, and the
// spot and the cover's lifted frame go with them.
const RESUME_MS = 60000
const resumes: Map<string, { t: number, until: number }> = new Map()   // post id -> where its hold lifted, and until when that counts

/**
 * Where a hold on this card goes on from, if its last one lifted less than a minute ago.
 */
function resumePoint(card: HTMLElement): number | null {
  if (!CFG.holdResume) return null
  const id = postId(card)
  const r = resumes.get(id)
  if (!r) return null
  if (Date.now() > r.until) { resumes.delete(id); return null }
  return r.t
}

// Called while the hold still plays (before endPlayShow). A fallback to the
// slideshow already ended the playing, so it keeps nothing.
function keepResume(s: Scrub) {
  const id = postId(s.card)
  const t = s.video.currentTime
  // A hold that never got past its first second has nothing worth going back to.
  if (!CFG.holdResume || id === '?' || !(t >= 1)) return
  resumes.set(id, { t, until: Date.now() + RESUME_MS })
  s.stats.kept = t
}

/**
 * One of the hold's chips on a card, made on first use: ⏮ bottom left (where
 * the time label sits during a hold), 🔊/🔇 top left. A press on either is
 * a tap, not a hold (onScrubDown); the tap goes to onScrubClick, ahead of
 * the modal's handler.
 */
function holdChip(card: HTMLElement, kind: 'resume' | 'sound'): HTMLElement {
  const had = card.querySelector(`[data-ibh-chip="${kind}"]`) as HTMLElement | null
  if (had) return had
  const chip = document.createElement('span')
  chip.dataset.ibhChip = kind
  chip.dataset.ibhUi = '1'   // painted by us: the site theme leaves it alone
  chip.setAttribute('role', 'button')
  const label = t(kind === 'resume' ? 'resumeRestart' : 'soundToggle')
  chip.title = label
  chip.setAttribute('aria-label', label)
  // About 32 px tall, a finger's width; z-index over the cover video and
  // the scrub's bar and label (3).
  chip.style.cssText = `position:absolute;${kind === 'resume' ? 'bottom:8px' : 'top:4px'};left:4px;` +
    'padding:6px 12px;border-radius:16px;font:15px/1.3 ui-monospace,monospace;color:#fff;' +
    'background:rgba(0,0,0,.65);z-index:4;cursor:pointer'
  if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
  card.appendChild(chip)
  return chip
}

function soundChip(card: HTMLElement) {
  holdChip(card, 'sound').textContent = CFG.previewSound ? '🔊' : '🔇'
}

// After a playing hold: the chips, for a minute from this lift.
function lingerChips(card: HTMLElement) {
  const at = resumePoint(card)
  if (at !== null) holdChip(card, 'resume').textContent = `⏮ ${mmss(at)}`
  soundChip(card)
  clearTimeout(Number(card.dataset.ibhChipTimer))
  card.dataset.ibhChipTimer = String(setTimeout(() => {   // harmless on a card gone from the page
    removeChips(card)
    if (resumes.delete(postId(card))) coverBack(card)
  }, RESUME_MS))
}

function removeChips(card: HTMLElement) {
  clearTimeout(Number(card.dataset.ibhChipTimer))
  delete card.dataset.ibhChipTimer
  for (const chip of card.querySelectorAll('[data-ibh-chip]')) chip.remove()
}

// The cover shows its own frame again (COVER_POINT), as before any hold.
function coverBack(card: HTMLElement) {
  const v = card.querySelector('video[data-ibh]')
  if (!v || v.readyState < 1 || !Number.isFinite(v.duration) || !(v.duration > 0)) return
  v.currentTime = v.duration * COVER_POINT
  dbg(`hold: post ${postId(card)}'s cover back to its own frame`)
}

// A tap on ⏮: the next hold on that post starts from 00:00, and its cover
// leaves the frame where the finger lifted.
function forgetResume(chip: HTMLElement) {
  const card = chip.closest('[data-ibh-video]') as HTMLElement | null
  chip.remove()
  if (!card) return
  resumes.delete(postId(card))
  coverBack(card)
  info(`hold: post ${postId(card)} starts from 00:00 again`)
}

// A tap on 🔊/🔇: previewSound flips for the holds from now on, and for one
// playing (a tap is a user activation, so the browser lets it unmute).
function flipSound() {
  setCfg('previewSound', !CFG.previewSound)
  for (const chip of document.querySelectorAll('[data-ibh-chip="sound"]')) chip.textContent = CFG.previewSound ? '🔊' : '🔇'
  if (scrub && scrub.onPlayTime) scrub.video.muted = !CFG.previewSound
}

// ── Rub: hold, then slide to move the video (holdRub) ──
// On a thumbnail whose hold plays the video, and on the post's player once
// a hold has started, sliding the finger sideways moves the video: to the
// right forward, to the left back, from wherever it is. Where the finger
// sits doesn't matter, only how far it slides: the width under the finger
// (the card, the player) spans the whole video, at most RUB_SPAN_S. While
// the finger moves, the video waits on the frame there (fastSeek: the
// nearest keyframe, quick to decode); once it rests, the exact frame, and
// the next slide starts from there.
const RUB_SPAN_S = 120
const RUB_REST_MS = 250

// A finger rubbing one video; makeRub builds it.
export type Rub = {
  move: (x: number) => void,   // the finger at x px
  end: () => void,   // the finger lifts: mid-rub, the video stays on the exact target
  active: () => boolean,   // moving the video now (it waits paused)
  count: () => number,   // rubs so far (each start after the finger rested)
}

/**
 * @param x0   px, where the finger went down
 * @param width   px that span the whole video
 * @param hooks
 *   alive: the gesture still runs; begin: a rub starts (before the pause);
 *   paint: the target changed; rest: the finger rests on the exact frame;
 *   lift: the finger lifted mid-rub, the video on the exact frame
 */
export function makeRub(v: HTMLVideoElement, x0: number, width: () => number, hooks: { alive(): boolean, begin(): void, paint(t: number): void, rest(): void, lift?(): void }): Rub {
  let active = false
  let count = 0
  let x = x0          // where the finger was when this rub began (or rested)
  let t = 0           // the video's time then
  let target = 0
  let asked = -1      // the last target handed to a seek
  let busy = false    // a seek in flight: the next waits for its seeked
  let still = 0
  const seek = () => {
    busy = true
    asked = target
    if (typeof v.fastSeek === 'function') v.fastSeek(target)
    else v.currentTime = target
  }
  // One seek at a time: a finger sends moves faster than seeks land, and
  // each queued seek would decode. When one lands, the newest target goes.
  const onSeeked = () => {
    busy = false
    if (active && hooks.alive() && asked !== target) seek()
  }
  v.addEventListener('seeked', onSeeked)
  /** @param at  px, where the finger rests */
  const rest = (at: number) => {
    if (!active || !hooks.alive()) return
    active = false
    x = at
    busy = true
    asked = target
    v.currentTime = target   // fastSeek stopped on a keyframe
    hooks.rest()
  }
  return {
    move(nx) {
      if (!Number.isFinite(v.duration) || !(v.duration > 0)) return
      if (!active) {
        if (Math.abs(nx - x) <= SCRUB_SLOP) return   // a resting finger trembles
        active = true
        count++
        x = nx
        t = v.currentTime
        hooks.begin()
        v.pause()
      }
      const span = Math.min(v.duration, RUB_SPAN_S)
      target = Math.min(v.duration - 0.05, Math.max(0, t + ((nx - x) / (width() || 1)) * span))
      hooks.paint(target)
      if (!busy) seek()
      clearTimeout(still)
      still = setTimeout(() => rest(nx), RUB_REST_MS)
    },
    end() {
      clearTimeout(still)
      v.removeEventListener('seeked', onSeeked)
      if (!active) return
      active = false
      v.currentTime = target
      if (hooks.lift) hooks.lift()
    },
    active: () => active,
    count: () => count,
  }
}

// The thumbnail's rub, made on the first move of a playing hold.
function rubMove(s: Scrub, x: number) {
  const v = s.video
  if (!s.rub) {
    s.rub = makeRub(v, s.x0, () => s.card.getBoundingClientRect().width, {
      alive: () => scrub === s,
      begin: () => { s.stats.rubs = (s.stats.rubs || 0) + 1 },
      paint: at => {
        s.bar.style.width = `${(at / v.duration) * 100}%`
        s.label.textContent = `${mmss(at)} / ${mmss(v.duration)}`
      },
      rest: () => {
        v.play().catch(e => {
          // Unmuted, it needs the page's user activation, as playShow found out.
          if (e.name !== 'NotAllowedError' || v.muted || scrub !== s) { dbg(`rub: play refused — ${describeError(e)}`); return }
          v.muted = true
          v.play().catch(e2 => dbg(`rub: play refused — ${describeError(e2)}`))
        })
      },
    })
  }
  s.rub.move(x)
}

// Called with a scrub under way.
function startScrub() {
  if (!scrubSource(scrub as Scrub)) return false
  scrubUi(scrub as Scrub)
  return true
}

// The video a scrub seeks: the card's cover when loaded, else the shared preview.
export function scrubSource(s: Scrub) {
  const { card } = s
  const pic = cardPicture(card)
  if (!pic) return false
  // freeForPreview() only once the preview will run: one that cannot start
  // never reaches endScrub(), which brings the paused GIFs back.
  const cover = card.querySelector('video[data-ibh]')
  if (cover && cover.readyState >= 1) {
    freeForPreview(card)
    s.video = cover   // already loaded: instant, and no extra decoder
    // Download the whole file from now on: these are a few MB, and every
    // part already downloaded answers a seek at once.
    cover.preload = 'auto'
  } else {
    const hash = (thumbParts(pic.src) || {}).hash
    const urls = cachedFirst(fileCandidates(pic.src, ['mp4', 'webm']), cacheGet('video', hash))
    if (!urls.length) return false
    freeForPreview(card)
    borrowDecoder(card)
    const holder = document.createElement('div')
    holder.style.cssText = 'position:absolute;inset:0;pointer-events:none'
    placeOverPicture(card, holder)
    s.holder = holder
    s.video = previewLoad(holder, urls, hash)
    s.shared = true
  }
  return true
}

// The progress bar and the time label over the card.
export function scrubUi(s: Scrub) {
  if (s.bar) return
  const { card } = s
  // The time label takes the ⏮ chip's place, and the chips' minute stops
  // while the finger is down: the lift starts it again (lingerChips).
  card.querySelector('[data-ibh-chip="resume"]')?.remove()
  clearTimeout(Number(card.dataset.ibhChipTimer))
  // z-index: the card's cover video comes later in the DOM and would paint
  // over them otherwise (it did on site pages, where every video has one).
  s.bar = document.createElement('div')
  s.bar.style.cssText =
    `position:absolute;left:0;bottom:0;height:4px;width:0;background:${ACCENT};pointer-events:none;z-index:3`
  s.label = document.createElement('div')
  s.label.style.cssText =
    'position:absolute;left:4px;bottom:8px;padding:1px 6px;border-radius:3px;font:12px/1.4 ' +
    'ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.6);pointer-events:none;z-index:3'
  // Painted by us: the site theme leaves them alone.
  s.bar.dataset.ibhUi = s.label.dataset.ibhUi = '1'
  if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
  card.appendChild(s.bar)
  card.appendChild(s.label)
  s.on = true
}

// Called with a scrub under way, once startScrub made its bar and label.
function moveScrub(x: number) {
  const r = (scrub as Scrub).card.getBoundingClientRect()
  const f = Math.min(1, Math.max(0, (x - r.left) / r.width))
  ;(scrub as Scrub).bar.style.width = `${f * 100}%`
  const at = seekFraction((scrub as Scrub).video, f)
  ;(scrub as Scrub).label.textContent = at ? `${mmss(at.t)} / ${mmss(at.d)}` : '…'
}

// Lets go of a scrub that never showed anything. nextGif() waits while a
// finger is down on a video card: a GIF whose turn came meanwhile starts now.
function dropScrub() {
  scrub = null
  nextGif()
}

export function endScrub() {
  const s = scrub
  scrub = null
  if (!s) return
  clearTimeout(s.holdTimer)
  if (!s.on) { nextGif(); return }
  if (s.tick) endSlideshow(s)
  if (s.rub) { s.rub.end(); s.rub = null }   // mid-rub, the cover and keepResume get the exact target
  if (s.onPlayTime) { keepResume(s); endPlayShow(s); lingerChips(s.card) }
  else removeChips(s.card)   // a slideshow or a drag: no chips (one a fallback left)
  if (s.stats) logSlideStats(s)
  endReel(s)
  s.bar.remove()
  s.label.remove()
  if (s.shared) { previewStop(); (s.holder as HTMLElement).remove(); returnDecoder() }   // a shared preview has one
  afterPreview()
  nextGif()   // the paused ones first, then any whose turn came meanwhile
  // A cover keeps the frame where the finger stopped.
  dbg(`scrub: stopped at ${s.label.textContent}`)
}

function onScrubMove(ev: PointerEvent) {
  if (!scrub || ev.pointerId !== scrub.id) return
  if (CFG.scrubMode === 'hold') {
    // Moving before the hold starts makes it a scroll. Once the hold plays
    // the video, a sideways slide moves it (holdRub); a slideshow ignores moves.
    if (!scrub.on) {
      if (Math.hypot(ev.clientX - scrub.x0, ev.clientY - scrub.y0) > SCRUB_SLOP) endScrub()
      return
    }
    if (CFG.holdRub && scrub.onPlayTime) rubMove(scrub, ev.clientX)
    return
  }
  if (!scrub.on) {
    const dx = Math.abs(ev.clientX - scrub.x0)
    const dy = Math.abs(ev.clientY - scrub.y0)
    if (dy > SCRUB_SLOP && dy > dx) { dropScrub(); return }   // a page scroll
    if (dx < SCRUB_SLOP) return
    if (!startScrub()) { dropScrub(); return }
  }
  moveScrub(ev.clientX)
}

function onScrubUp(ev: PointerEvent) {
  if (!scrub || ev.pointerId !== scrub.id) return
  // After a scrub, the click that follows must not open the post or the modal.
  if (scrub.on && ev.type === 'pointerup') scrubClickUntil = Date.now() + 400
  endScrub()
}

// Registered before the modal's click handler, so stopping it here wins.
function onScrubClick(ev: MouseEvent) {
  // The hold chips sit inside the card's link: a tap must not open the post.
  const chip = asElement(ev.target)?.closest('[data-ibh-chip]') as HTMLElement | null | undefined
  if (chip) {
    ev.preventDefault()
    ev.stopImmediatePropagation()
    if (chip.dataset.ibhChip === 'sound') flipSound()
    else forgetResume(chip)
    return
  }
  if (Date.now() > scrubClickUntil) return
  scrubClickUntil = 0
  ev.preventDefault()
  ev.stopImmediatePropagation()
}

// The browser hands sideways drags on video cards to the page; vertical
// scrolling and pinch zoom stay with it.
export const SCRUB_CSS = '[data-ibh-video] { touch-action: pan-y pinch-zoom; }' +
  '[data-ibh-video], [data-ibh-video] img { -webkit-user-drag: none; user-select: none; -webkit-touch-callout: none; }'

export function installVideoScrub() {
  if (!CFG.videoScrub) return
  window.addEventListener('pointerdown', onScrubDown, true)
  window.addEventListener('pointermove', onScrubMove, true)
  window.addEventListener('pointerup', onScrubUp, true)
  window.addEventListener('pointercancel', onScrubUp, true)
  window.addEventListener('click', onScrubClick, true)
  // Hold mode: the long press is ours, so the browser's long-press menu stays out.
  window.addEventListener('contextmenu', ev => {
    if (CFG.scrubMode === 'hold' && asElement(ev.target)?.closest('[data-ibh-video]')) ev.preventDefault()
  }, true)
  // Belt and braces for the drag-and-drop that cancels a scrub on site pages.
  window.addEventListener('dragstart', ev => {
    if (asElement(ev.target)?.closest('[data-ibh-video]')) ev.preventDefault()
  }, true)
  info(`video scene preview active: ${CFG.scrubMode !== 'hold' ? 'drag sideways on a video thumbnail' : CFG.holdVideo ? 'hold a video thumbnail to play it (hardware)' : 'hold a video thumbnail for a slideshow'}`)
}
