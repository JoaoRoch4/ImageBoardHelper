// The modal's gestures: swipe between posts, pinch zoom, hold an image.
import { dbg } from '../core/log'
import { CONTROLS_BAND, SWIPE_MIN, modal } from './modal'
import { toggleMenu } from './tags'
import { centerDoubleTap } from '../post/votes'
import { setCleanUi, videoPress } from './player'
import { loadModalOriginal } from './media'
import { closeModal, stepModal } from './open'

export function installModalSwipe(stage: HTMLElement, video: HTMLVideoElement) {
  let start: { x: number, y: number, t: number, top: number } | null = null
  stage.addEventListener('pointerdown', ev => {
    const r = video.hidden ? null : video.getBoundingClientRect()
    // Drags on the video's own controls are seeks, not swipes.
    const onControls = r && ev.clientY > r.bottom - CONTROLS_BAND && ev.clientY <= r.bottom
    start = onControls ? null : { x: ev.clientX, y: ev.clientY, t: Date.now(), top: stage.scrollTop }
  })
  stage.addEventListener('pointercancel', () => { start = null })
  stage.addEventListener('pointerup', ev => {
    if (!start) return
    // A pinch, a drag on a zoomed image, or the end of a 2x hold is not a swipe.
    if (zoom.scale > 1 || zoom.multi || videoPress.held) { start = null; return }
    const dx = ev.clientX - start.x
    const dy = ev.clientY - start.y
    const quick = Date.now() - start.t < 600
    const wasAtTop = start.top <= 0
    start = null
    if (!quick) return
    if (Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) stepModal(dx < 0 ? 1 : -1)
    // Down closes, but inside a tall image only from its top: otherwise it is scrolling.
    else if (dy > 90 && dy > Math.abs(dx) * 1.5 && wasAtTop) closeModal(false)
  })
}

// Pinch zoom on the modal image. The stage takes touches itself (touch-action),
// which also turns off the browser's zoom, and that one would scale the
// whole page anyway. transform-origin is the image's top-left, so its screen
// position is its layout position plus the translation.
export const zoom = { scale: 1, x: 0, y: 0, multi: false }
const ZOOM_MAX = 6

export function applyZoom() {
  const img = modal.image
  img.style.transform = zoom.scale === 1 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`
  if (zoom.scale > 1 && modal.isSample && !modal.keepSample) loadModalOriginal()
  // Zoomed, every drag pans the image; at 1x a tall image scrolls natively.
  if (!img.hidden) modal.stage.style.touchAction = zoom.scale > 1 || !modal.stage.classList.contains('tall') ? 'none' : 'pan-y'
}

export function resetZoom() {
  zoom.scale = 1
  zoom.x = zoom.y = 0
  if (modal) applyZoom()
}

// Holding the image half a second opens the ☰ menu (tags, info). Measured
// on touch events: Firefox for Android cancels the pointer during a long
// press (see chipGestures). The click the release may send is swallowed,
// or a hold on the bars around the picture would close the modal.
const MODAL_HOLD_MS = 500

export function installImageHold(stage: HTMLElement, img: HTMLImageElement, box: HTMLElement) {
  let hold: { x: number, y: number, scale: number, timer: number } | null = null
  let swallowUntil = 0
  const cancel = () => { if (hold) clearTimeout(hold.timer); hold = null }
  stage.addEventListener('touchstart', ev => {
    cancel()
    if (img.hidden || ev.touches.length !== 1 || !modal.sheet.hidden) return
    const finger = ev.touches[0]
    hold = { x: finger.clientX, y: finger.clientY, scale: zoom.scale, timer: 0 }
    hold.timer = setTimeout(() => {
      if (!hold || zoom.scale !== hold.scale) { hold = null; return }   // it became a pinch
      hold = null
      swallowUntil = Date.now() + 800
      if (navigator.vibrate) navigator.vibrate(15)
      toggleMenu()
      dbg('modal: image held, menu opened')
    }, MODAL_HOLD_MS)
  }, { passive: true })
  stage.addEventListener('touchmove', ev => {
    if (!hold) return
    const finger = ev.touches[0]
    if (ev.touches.length > 1 || Math.hypot(finger.clientX - hold.x, finger.clientY - hold.y) > 12) cancel()
  }, { passive: true })
  stage.addEventListener('touchend', cancel)
  stage.addEventListener('touchcancel', cancel)
  img.addEventListener('contextmenu', ev => ev.preventDefault())   // the hold is ours
  box.addEventListener('click', ev => {
    if (Date.now() > swallowUntil) return
    swallowUntil = 0
    ev.stopPropagation()
    ev.preventDefault()
  }, true)
}

export function installImageZoom(stage: HTMLElement, img: HTMLImageElement) {
  const pts: Map<number, { x: number, y: number, t: number }> = new Map()   // pointer id -> where it is, and when it went down
  let pinch: { d: number, scale: number, cx: number, cy: number, o: { left: number, top: number } } | null = null
  let pan: { x: number, y: number, zx: number, zy: number } | null = null
  let lastTap = { t: 0, x: 0, y: 0 }
  // Layout top-left of the image on screen, transform taken out.
  const origin = () => { const r = img.getBoundingClientRect(); return { left: r.left - zoom.x, top: r.top - zoom.y } }
  const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) } }

  stage.addEventListener('pointerdown', ev => {
    if (img.hidden) return
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, t: Date.now() })
    if (pts.size === 2) {
      zoom.multi = true
      const m = mid()
      // The image point under the fingers' midpoint stays under it.
      const o = origin()
      pinch = { d: m.d, scale: zoom.scale, cx: (m.x - o.left - zoom.x) / zoom.scale, cy: (m.y - o.top - zoom.y) / zoom.scale, o }
      pan = null
    } else if (pts.size === 1 && zoom.scale > 1) {
      pan = { x: ev.clientX, y: ev.clientY, zx: zoom.x, zy: zoom.y }
    }
  })

  stage.addEventListener('pointermove', ev => {
    const p = pts.get(ev.pointerId)
    if (!p) return
    p.x = ev.clientX
    p.y = ev.clientY
    if (pinch && pts.size >= 2) {
      const m = mid()
      zoom.scale = Math.min(ZOOM_MAX, Math.max(1, pinch.scale * (m.d / pinch.d)))
      zoom.x = m.x - pinch.o.left - pinch.cx * zoom.scale
      zoom.y = m.y - pinch.o.top - pinch.cy * zoom.scale
      applyZoom()
    } else if (pan) {
      zoom.x = pan.zx + (ev.clientX - pan.x)
      zoom.y = pan.zy + (ev.clientY - pan.y)
      applyZoom()
    }
  })

  const end = (ev: PointerEvent) => {
    const p = pts.get(ev.pointerId)
    pts.delete(ev.pointerId)
    if (pts.size < 2) pinch = null
    if (pts.size === 0) {
      pan = null
      if (zoom.scale < 1.05) resetZoom()   // let go near 1x: snap back
      // Double tap: fullscreen or a like, as on videos (doubleTapCenter; the
      // tap is the user gesture fullscreen needs); zoomed in, it first comes
      // back to 1x. Zoom is the pinch.
      if (ev.type === 'pointerup' && p && !zoom.multi && Date.now() - p.t < 250 &&
          Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 10) {
        const now = Date.now()
        if (now - lastTap.t < 300 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < 30) {
          if (zoom.scale > 1) resetZoom()
          else centerDoubleTap()
          lastTap.t = 0
        } else {
          lastTap = { t: now, x: ev.clientX, y: ev.clientY }
          // A single tap in fullscreen shows or hides the bar, once it is
          // clear no second tap (fullscreen) follows.
          const tapAt = now
          setTimeout(() => {
            if (lastTap.t === tapAt && modal.root.fullscreenElement) setCleanUi(!modal.box.classList.contains('clean'))
          }, 320)
        }
      }
      // Cleared after the swipe handler (registered first) has seen it.
      setTimeout(() => { zoom.multi = false }, 0)
    }
  }
  stage.addEventListener('pointerup', end)
  stage.addEventListener('pointercancel', end)
}
