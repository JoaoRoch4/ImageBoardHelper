import type { Rub } from '../scrub/scrub'
import type { H264Reel } from '../scrub/reel'
import type { H264 } from '../scrub/h264'
import { CFG } from '../core/config'
import { LANG, t } from '../core/i18n'
import { dbg, describeError, info } from '../core/log'
import { makeRub, previewEl, previewLoad, previewStop, seekFraction } from '../scrub/scrub'
import { openStream, reelFor } from '../scrub/reel'
import { decodeKeyframe, h264Broken, h264Decoder } from '../scrub/h264'
import { flash, modal } from './modal'
import { setCfg } from '../storage/storage'
import { centerDoubleTap } from '../post/votes'
import { resetZoom } from './gestures'
import { setQuality, setRes } from './media'
import { el } from '../panel/panel'

// On the modal video: drag sideways to move the video (holdRub: a rub, see
// makeRub; a quick flick stays a swipe to the next post); hold the middle
// third for 2x while the finger stays down, and slide from there to move
// it too; double
// tap on the right or left third to jump seekStep seconds (5, or what ⚙
// picked) forward or back. The control strip is
// left to the player. Turned, "left/right" follow the viewer, not the screen.
const HOLD_FAST_MS = 600   // the user's pick (2026-11-15): 400 ms caught drags that started slowly
const FLICK_MS = 300   // a sideways drag shorter than this is a swipe to the next post, not a rub
const HOLD_RATE = 2
export const videoPress = { held: false }

let badgeTimer = 0
function showBadge(text: string, sticky?: boolean) {
  modal.badge.textContent = text
  modal.badge.hidden = false
  clearTimeout(badgeTimer)
  if (!sticky) badgeTimer = setTimeout(() => { modal.badge.hidden = true }, 700)
}

// The player's rub: a sideways drag on the video, or a slide once a hold
// started. A hold's 2× gives way to it, the time shows in the badge with
// the seek bar up, and a resting or lifted finger plays on only when the
// video was playing.
function playerRub(video: HTMLVideoElement, press: { x: number, rate: number }, layer: HTMLElement): Rub {
  let playing = false
  const box = modal.box
  return makeRub(video, press.x, () => layer.getBoundingClientRect().width, {
    alive: () => !!modal && modal.open && modal.box === box,
    begin: () => {
      playing = !video.paused
      video.playbackRate = press.rate
      dbg('modal: rub, the hold slides the video')
    },
    paint: at => {
      showBadge(`${mmss(at)} / ${mmss(video.duration)}`, true)
      modal.controls.poke()
    },
    rest: () => {
      showBadge(mmss(video.currentTime))
      if (playing) video.play().catch(e => dbg(`modal: rub, play refused — ${describeError(e)}`))
    },
    lift: () => { if (playing) video.play().catch(e => dbg(`modal: rub, play refused — ${describeError(e)}`)) },
  })
}

export function installVideoGestures(layer: HTMLElement, video: HTMLVideoElement) {
  let press: { id: number, x: number, y: number, t: number, fx: number, rate: number, timer: number, rub?: Rub, drag?: boolean } | null = null
  let tap: { t: number, side: number, timer: number } | null = null   // a first tap waiting to see whether a second one follows
  const viewerX = (ev: PointerEvent) => {
    const r = layer.getBoundingClientRect()
    return Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width))
  }
  const release = () => {
    if (!press) return
    clearTimeout(press.timer)
    if (press.rub) {
      press.rub.end()
      if (press.rub.count()) info(`modal: rubbed ${press.rub.count()}×, left at ${mmss(video.currentTime)}`)
    }
    if (videoPress.held) {
      video.playbackRate = press.rate
      modal.badge.hidden = true
      dbg('modal: hold released, back to normal speed')
    }
    press = null
    // Cleared after the swipe handler on the stage has seen this pointerup.
    setTimeout(() => { videoPress.held = false }, 0)
  }

  // A long press would open the browser's media menu and cancel the hold.
  layer.addEventListener('contextmenu', ev => ev.preventDefault())

  layer.addEventListener('pointerdown', ev => {
    if (press) return
    const fx = viewerX(ev)
    press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: Date.now(), fx, rate: video.playbackRate || 1, timer: 0 }
    dbg(`modal: video press at ${Math.round(fx * 100)}%`)
    // Only the middle third holds for 2x; the sides are for double taps and drags.
    if (fx < 0.35 || fx > 0.65) return
    press.timer = setTimeout(() => {
      if (!press) return
      // From here a slide moves the video. A paused one stays paused, at 1×.
      if (CFG.holdRub) press.rub = playerRub(video, press, layer)
      if (video.paused) {
        if (CFG.holdRub) videoPress.held = true
        dbg(`modal: hold on a paused video${CFG.holdRub ? ': a slide moves it' : ', ignored'}`)
        return
      }
      videoPress.held = true
      video.playbackRate = HOLD_RATE
      showBadge(`${HOLD_RATE}×`, true)
      dbg(`modal: hold, playing at ${HOLD_RATE}x`)
    }, HOLD_FAST_MS)
  })
  layer.addEventListener('pointermove', ev => {
    if (!press || ev.pointerId !== press.id) return
    if (videoPress.held || press.drag) { press.rub?.move(ev.clientX); return }
    const dx = ev.clientX - press.x
    const dy = ev.clientY - press.y
    if (Math.hypot(dx, dy) <= 10) return
    clearTimeout(press.timer)
    // Sideways: a rub from here (the stage still takes a quick flick as a
    // swipe, see pointerup). Down, or sideways with holdRub off: a swipe,
    // handled on the stage.
    if (CFG.holdRub && Math.abs(dx) > Math.abs(dy)) {
      press.drag = true
      press.rub = playerRub(video, press, layer)
      press.rub.move(ev.clientX)
      return
    }
    press = null
  })
  layer.addEventListener('pointercancel', () => { if (press) dbg('modal: video press cancelled by the browser'); release() })
  layer.addEventListener('pointerup', ev => {
    if (!press || ev.pointerId !== press.id) return
    const quickTap = !videoPress.held && Date.now() - press.t < 250 &&
      Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < 10
    const side = press.fx > 0.65 ? 1 : press.fx < 0.35 ? -1 : 0
    // A drag that took longer than a flick moved the video: the stage's
    // swipe skips it as it skips a hold (release clears this after it).
    if (press.drag && Date.now() - press.t >= FLICK_MS) videoPress.held = true
    release()
    if (!quickTap) return
    // Second tap within 300 ms: a double tap. On a side it seeks, in the
    // centre it toggles fullscreen (like YouTube); the pending single-tap
    // action is cancelled either way. The tap is the user gesture
    // fullscreen needs.
    if (tap && Date.now() - tap.t < 300) {
      clearTimeout(tap.timer)
      if (!side && !tap.side) centerDoubleTap()
      else if (side && side === tap.side) {
        const d = Number.isFinite(video.duration) ? video.duration : Infinity
        const step = Number(CFG.seekStep) || 5
        video.currentTime = Math.min(d, Math.max(0, video.currentTime + side * step))
        showBadge(side > 0 ? `+${step}s` : `−${step}s`)
        dbg(`modal: double tap, ${side > 0 ? '+' : '-'}${step}s`)
      }
      tap = null
      return
    }
    // A single tap plays or pauses, once it is clear no second tap follows.
    tap = { t: Date.now(), side, timer: 0 }
    tap.timer = setTimeout(() => {
      tap = null
      // Controls hidden: the tap only brings them back.
      if (!modal.controls.shown()) { modal.controls.poke(); return }
      if (video.paused) { video.play().catch(() => {}); showBadge('▶') }
      else { video.pause(); showBadge('❚❚') }
      modal.controls.poke()
      dbg(`modal: tap, ${video.paused ? 'paused' : 'playing'}`)
    }, 300)
  })
}

export const mmss = (sec: number) => Number.isFinite(sec) ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : '0:00'

const CONTROLS_HIDE_MS = 2000

// The seek bar's preview from keyframes (seekReel): this many, evenly spread.
const SEEK_STEPS = Array.from({ length: 40 }, (_, i) => i / 40)

// ⚙ on the player: its speed and how far a double tap on a side jumps,
// both kept in the settings (playRate, seekStep), as rows of chips.
export const PLAY_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]
export const SEEK_JUMPS = [5, 10, 15, 30]

export function applyPlayRate(video: HTMLVideoElement) {
  const rate = Number(CFG.playRate) || 1
  video.defaultPlaybackRate = rate   // load() puts the speed back to this, so the next video keeps it
  video.playbackRate = rate
}

export function installGearMenu(gear: HTMLElement, menu: HTMLElement, video: HTMLVideoElement, vwrap: HTMLElement, poke: () => void) {
  const chips: Array<{ button: HTMLButtonElement, key: 'playRate' | 'seekStep', value: number }> = []
  const mark = () => chips.forEach(c => c.button.classList.toggle('on', Number(CFG[c.key]) === c.value))
  /**
   * @param attr       the data- attribute that holds the value
   */
  const row = (label: string, key: 'playRate' | 'seekStep', attr: string, values: number[], text: (value: number) => string, apply: () => void) => el('div', { class: 'vmrow' }, [el('span', { class: 'lbl', text: label }),
    ...values.map(value => {
      const button = el('button', { type: 'button', text: text(value), [`data-${attr}`]: String(value) })
      button.addEventListener('click', () => {
        setCfg(key, value)
        apply()
        mark()
        poke()
        dbg(`modal: ${key} set to ${value} from the player's ⚙`)
      })
      chips.push({ button, key, value })
      return button
    })])
  menu.append(
    row(t('gearRate'), 'playRate', 'rate', PLAY_RATES, v => `${v.toLocaleString(LANG)}×`, () => applyPlayRate(video)),
    row(t('gearStep'), 'seekStep', 'step', SEEK_JUMPS, v => `${v} s`, () => {}))
  gear.addEventListener('click', () => {
    menu.hidden = !menu.hidden
    if (!menu.hidden) mark()
    poke()
  })
  // A touch anywhere else on the video closes it.
  vwrap.addEventListener('pointerdown', ev => {
    const path = ev.composedPath()
    if (!menu.hidden && !path.includes(menu) && !path.includes(gear)) menu.hidden = true
  }, true)
}

// Returns { shown(), poke(), dropReel() }: the bar fades after 2 s without
// interaction while playing, and stays up while paused or while the seek
// bar is dragged.
export type VideoControls = ReturnType<typeof installVideoControls>
/**
 * @param times    where it plays, and how long it is
 */
export function installVideoControls(video: HTMLVideoElement, ctl: HTMLElement, playBtn: HTMLElement, times: HTMLElement[], seek: HTMLInputElement, muteBtn: HTMLElement, prevBox: HTMLElement, vwrap: HTMLElement, { playPause, gearMenu }: { playPause: HTMLElement, gearMenu: HTMLElement }) {
  let dragging = false
  let hideTimer = 0
  let muted: boolean | null = null   // the icons on show, so timeupdate does not rebuild them
  let paused: boolean | null = null
  const poke = () => {
    ctl.classList.remove('hide')
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (!dragging && !video.paused && gearMenu.hidden) ctl.classList.add('hide')
      else if (!gearMenu.hidden) poke()   // ⚙'s menu open: look again later
    }, CONTROLS_HIDE_MS)
  }
  const sync = () => {
    playBtn.hidden = !video.paused
    if (paused !== video.paused) { paused = video.paused; setIcon(playPause, paused ? PLAYER_ICON.play : PLAYER_ICON.pause) }
    if (muted !== video.muted) { muted = video.muted; setIcon(muteBtn, muted ? PLAYER_ICON.muted : PLAYER_ICON.volume) }
    times[1].textContent = mmss(video.duration)
    if (!dragging) times[0].textContent = mmss(video.currentTime)
    if (!dragging && video.duration) seek.value = String(Math.round((video.currentTime / video.duration) * 1000))
    // How far the download reaches from where it plays: the light part of the bar.
    const b = video.buffered
    let end = 0
    for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 0.5) end = Math.max(end, b.end(i))
    seek.style.setProperty('--buf', `${video.duration ? Math.min(100, (end / video.duration) * 100) : 0}%`)
  }
  for (const type of ['timeupdate', 'play', 'pause', 'volumechange', 'loadedmetadata', 'durationchange', 'emptied', 'progress']) {
    video.addEventListener(type, sync)
  }
  playBtn.addEventListener('click', () => { video.play().catch(() => {}) })
  playPause.addEventListener('click', () => {
    if (video.paused) video.play().catch(() => {})
    else video.pause()
    poke()
    dbg(`modal: ${video.paused ? 'paused' : 'playing'} from the player's button`)
  })
  muteBtn.addEventListener('click', () => { video.muted = !video.muted })

  // While the seek bar is dragged, only the preview box follows the finger;
  // the main video jumps once, on release. With seekReel, the box first
  // shows the nearest keyframe (a reel of SEEK_STEPS keyframes of this
  // video, decoded in WebAssembly to the box's size, each kept once
  // decoded), and the preview video, still seeking, takes over when it
  // reaches the exact frame.
  const PREV_W = 160
  // The keyframes of the video on show: x the decoder, frames those decoded
  // (by scene), f where the finger is, failed once either fails.
  type SeekReel = { src: string, reel: H264Reel | null, x: H264 | null, frames: Map<number, ImageData>, canvas: HTMLCanvasElement | null, f: number, failed: boolean }
  let reel: SeekReel | null = null   // { src, reel, x, frames, canvas, f, failed } for the video on show
  let target = 0    // the time the finger asks for, in seconds
  const drawKeyframe = (f: number) => {
    const r = reel
    if (!r || !r.reel || r.failed) return
    const scenes = r.reel.scenes
    let i = 0
    for (let k = 1; k < scenes.length; k++) if (Math.abs(scenes[k].f - f) < Math.abs(scenes[i].f - f)) i = k
    let img = r.frames.get(i)
    if (!img) {
      try {
        // x comes with reel.
        openStream(r.x as H264, r.reel)
        img = decodeKeyframe(r.x as H264, r.reel.frames[i], Math.round(PREV_W * (window.devicePixelRatio || 1)))
      } catch (e) {
        r.failed = true
        dbg(`seek preview: keyframe not decoded (${describeError(e)}), the <video> preview alone`)
        return
      }
      r.frames.set(i, img)
    }
    if (!r.canvas) r.canvas = document.createElement('canvas')
    if (!r.canvas.isConnected) prevBox.insertBefore(r.canvas, prevBox.lastChild)   // over the preview video, under the time
    if (r.canvas.width !== img.width || r.canvas.height !== img.height) { r.canvas.width = img.width; r.canvas.height = img.height }
    (r.canvas.getContext('2d') as CanvasRenderingContext2D).putImageData(img, 0, 0)   // a canvas of our own: it has one
  }
  const reelPreview = (f: number) => {
    if (!CFG.seekReel || !CFG.wasmDecode || h264Broken || typeof GM_xmlhttpRequest !== 'function') return
    const src = video.currentSrc
    if (!/\.mp4(?:[?#]|$)/i.test(src)) return   // WebM and the rest: the preview video alone
    if (!reel || reel.src !== src) {
      const mine: SeekReel = { src, reel: null, x: null, frames: new Map(), canvas: null, f, failed: false }
      reel = mine
      Promise.all([h264Decoder(), reelFor([src], SEEK_STEPS, new Set(), null)]).then(([x, built]) => {
        if (reel !== mine) return
        if (!built.avcC) throw new Error('not H.264')
        mine.x = x
        mine.reel = built as H264Reel   // it has an avcC
        info(`seek preview: wasm reel of ${built.scenes.length} scenes in ${built.ms} ms${built.kept ? ' (kept from before)' : ''}`)
        if (dragging) drawKeyframe(mine.f)   // where the finger is by now
      }).catch(e => {
        if (reel !== mine) return
        mine.failed = true
        dbg(`seek preview: no reel (${describeError(e)}), the <video> preview alone`)
      })
    }
    reel.f = f
    drawKeyframe(f)
  }
  seek.addEventListener('input', () => {
    dragging = true
    const f = Number(seek.value) / 1000
    if (prevBox.hidden && video.currentSrc) {
      prevBox.hidden = false
      const v = previewLoad(prevBox, [video.currentSrc], null)
      // The exact frame arrived: the preview video shows through the keyframe.
      if (!v.dataset.ibhSeekExact) {
        v.dataset.ibhSeekExact = '1'
        v.addEventListener('seeked', () => {
          if (prevBox.contains(v) && Math.abs(v.currentTime - target) < 0.6) prevBox.classList.add('exact')
        })
      }
    }
    const sr = seek.getBoundingClientRect()
    const wr = vwrap.getBoundingClientRect()
    const x = sr.left - wr.left + f * sr.width - PREV_W / 2
    prevBox.style.left = `${Math.min(wr.width - PREV_W - 4, Math.max(4, x))}px`
    const d = video.duration
    target = f * d
    prevBox.classList.remove('exact')
    reelPreview(f)
    if (previewEl && previewEl.isConnected) seekFraction(previewEl, f)
    ;(prevBox.lastChild as ChildNode).textContent = mmss(target)   // the time label, last of the box
    times[0].textContent = mmss(target)
    poke()
  })
  seek.addEventListener('change', () => {
    dragging = false
    const d = video.duration
    if (d) video.currentTime = (Number(seek.value) / 1000) * d
    previewStop()
    prevBox.hidden = true
    prevBox.classList.remove('exact')
    poke()
  })
  ctl.addEventListener('pointerdown', poke)
  video.addEventListener('play', poke)
  video.addEventListener('pause', () => { clearTimeout(hideTimer); ctl.classList.remove('hide') })
  video.addEventListener('emptied', () => { clearTimeout(hideTimer); ctl.classList.remove('hide') })
  // A new post or the modal closing: the decoded keyframes go (the reel
  // itself stays in the reel cache for a return).
  const dropReel = () => {
    if (reel && reel.canvas) reel.canvas.remove()
    reel = null
  }
  return { shown: () => !ctl.classList.contains('hide'), poke, dropReel }
}

// In fullscreen the bar and side buttons hide; a single tap on an image
// toggles them. Video keeps its own controls visible either way.
export function setCleanUi(clean: boolean) {
  modal.box.classList.toggle('clean', clean)
}

// Stop whatever is showing and invalidate loads still in flight (seq).
export function resetMedia() {
  modal.seq++
  modal.fileUrl = null   // the post's own file, once it loaded (Download)
  if (modal.cancelLoad) { modal.cancelLoad(); modal.cancelLoad = null }   // probes of the post left behind
  modal.isSample = false
  modal.origPending = false
  modal.sampleUrl = null    // the sample on show, to come back to from raw
  modal.rawUrl = null       // the original once fetched, to switch back instantly
  modal.keepSample = false  // chose the sample: zooming does not fetch the original
  setQuality(null)
  setRes(null)   // back on the next image's load; a video has none
  const v = modal.video
  v.pause()
  v.onerror = v.oncanplay = v.onloadedmetadata = null
  applyPlayRate(v)
  modal.gearMenu.hidden = true
  modal.badge.hidden = true
  modal.playerBtn.hidden = true
  modal.appDlBtn.hidden = true
  modal.appReduceBtn.hidden = true
  modal.controls.dropReel()
  if (!modal.root.fullscreenElement) setCleanUi(false)
  v.removeAttribute('src')
  v.load()   // hand the decoder back
  modal.image.onerror = null
  modal.image.removeAttribute('src')
  modal.stage.scrollTop = 0
  resetZoom()
}

// The player's own fullscreen button turns the screen for a wide video,
// which Firefox allows only in fullscreen (Screen Orientation API). Outside
// fullscreen nothing is turned.
// Fullscreen on the wrapper (video + gesture layer), from the ⛶ button.
// Fullscreen goes to the whole modal, for any kind of post: the bar, swipes,
// zoom and the video's gesture layer all come along.
export function toggleModalFullscreen() {
  if (modal.root.fullscreenElement) { document.exitFullscreen().catch(() => {}); return }
  if (!modal.box.requestFullscreen) return
  modal.box.requestFullscreen().catch(e => dbg(`modal: fullscreen refused — ${describeError(e)}`))
}

// ↻ turns the screen to the other orientation, for any post, and keeps it
// for the next ones; pressed again it turns back, and leaving fullscreen
// (or closing) returns to the automatic rule. Firefox locks
// the orientation only in fullscreen, so the press enters it first (the tap
// is the user gesture fullscreen needs).
export function turnScreen() {
  const orientation = screen.orientation
  if (!orientation || !orientation.lock) { flash(t('mTurnNo')); return }
  const portrait = String(orientation.type).startsWith('portrait')
  modal.turned = portrait ? 'landscape' : 'portrait'
  modal.turn.classList.add('on')
  info(`modal: screen turned to ${modal.turned}`)
  if (modal.root.fullscreenElement) fitFullscreenOrientation()
  else toggleModalFullscreen()   // its fullscreenchange applies the turn
}

// Material Design's fullscreen icons (the ones YouTube uses), as path data.
const FS_ICON = {
  enter: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  exit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
}

// The player's other Material icons, in the same stroke.
export const PLAYER_ICON = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  heartLine: 'M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z',
  info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
  gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  muted: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
}

// A 24x24 icon from path data, as the button's only content.
export function setIcon(btn: Element, d: string) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', d)
  svg.appendChild(path)
  btn.replaceChildren(svg)
}

export function setFsIcon(btn: HTMLElement, full: boolean) {
  setIcon(btn, full ? FS_ICON.exit : FS_ICON.enter)
  btn.title = t(full ? 'mFullExit' : 'mFull')
}

// Landscape only while fullscreen shows a wide video, unless ↻ chose an
// orientation; anything else unlocks.
export function fitFullscreenOrientation() {
  const orientation = screen.orientation
  if (!orientation) return
  const v = modal.video
  const full = !!modal.root.fullscreenElement
  if (full && modal.turned && orientation.lock) {
    orientation.lock(modal.turned).catch(e => dbg(`modal: orientation lock refused — ${describeError(e)}`))
  } else if (full && CFG.rotateLandscape && !v.hidden && v.videoWidth > v.videoHeight && orientation.lock) {
    orientation.lock('landscape').then(
      () => dbg('modal: fullscreen locked to landscape'),
      e => dbg(`modal: orientation lock refused — ${describeError(e)}`))
  } else {
    try { if (orientation.unlock) orientation.unlock() } catch (e) { /* not locked */ }
  }
}

export function onFullscreenChange() {
  if (!modal || !modal.open) return
  const v = modal.video
  // Inside our Shadow DOM the document sees the host; the root sees which
  // element inside it is fullscreen.
  const inside = modal.root.fullscreenElement
  // The native controls' button makes the bare <video> fullscreen, which
  // leaves the gesture layer behind. Hand fullscreen to the whole modal;
  // the tap on that button still counts as the user gesture it needs.
  if (inside === v && modal.box.requestFullscreen) {
    modal.box.requestFullscreen().then(
      () => dbg('modal: fullscreen moved to the modal'),
      e => dbg(`modal: could not move fullscreen — ${describeError(e)}`))
    return   // the next fullscreenchange does the orientation
  }
  dbg(`modal: fullscreen ${inside ? 'on' : 'off'}`)
  if (!inside) { modal.turned = null; modal.turn.classList.remove('on') }   // the lock went with it
  setFsIcon(modal.fsBtn, !!inside)
  setCleanUi(!!inside)
  fitFullscreenOrientation()
}

// Firefox for Android keeps its own orientation rules for video fullscreen,
// and with the modal (not a <video>) fullscreen it sometimes drops the lock
// and goes back to portrait. Put landscape back whenever that happens.
export function onOrientationChange() {
  if (!modal || !modal.open || !modal.root.fullscreenElement) return
  if (modal.turned) {
    if (!String(screen.orientation.type).startsWith(modal.turned)) fitFullscreenOrientation()
    return
  }
  const v = modal.video
  if (CFG.rotateLandscape && !v.hidden && v.videoWidth > v.videoHeight &&
      String(screen.orientation.type).startsWith('portrait')) {
    dbg('modal: fullscreen video went back to portrait, locking landscape again')
    fitFullscreenOrientation()
  }
}
