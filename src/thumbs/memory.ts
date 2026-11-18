import type { AnyNode } from './covers'
import { CFG } from '../core/config'
import { dbg, info } from '../core/log'
import { coverQueue, freeOffscreen, isGifCard, isVideoCard, markedCards, markedImages, mountCover, nextGif, playGif, setLiveCovers, stopGif, unmountCover } from './covers'
import { originalViewport } from './feed'
import { decodersBorrowed, scrub } from '../scrub/scrub'
import { modal } from '../modal/modal'
import { redoThumbs, resetUpgrade } from '../diag'

// ═══════════════════════════════════════════════════════════
// D. Memory management
//
// Upgraded images stay decoded while the page lives, so a long feed keeps
// every original it ever showed. Release what scrolled far away, unload
// videos taken out of the page, and drop everything when the page is left.
// ═══════════════════════════════════════════════════════════

// Two screens of slack each way: far enough that a quick scroll back does
// not refetch, close enough that a long feed keeps only a few originals.
const FAR_MARGIN = '200% 0px'

export const farViewport = 'IntersectionObserver' in window
  ? new IntersectionObserver(entries => {
      for (const e of entries) if (!e.isIntersecting) releaseFar(e.target as HTMLImageElement)   // watchDistance's images
    }, { rootMargin: FAR_MARGIN })
  : null

export function watchDistance(el: Element) {
  if (CFG.memorySaver && farViewport) farViewport.observe(el)
}

// Going back to the thumbnail must not change the height of something above
// the viewport, or the page jumps. Hold the current height until the better
// file is back (inline !important beats the feed's height:auto !important).
export function pinHeight(el: HTMLElement) {
  if (el.tagName !== 'IMG' || !el.clientHeight) return
  el.style.setProperty('height', `${el.clientHeight}px`, 'important')
  el.dataset.ibhPinned = '1'
}

export function unpinHeight(el: HTMLElement) {
  if (!el.dataset.ibhPinned) return
  el.style.removeProperty('height')
  delete el.dataset.ibhPinned
}

let releasedCount = 0

// Called by farViewport itself.
function releaseFar(el: HTMLImageElement) {
  if (el.dataset.ibhOrig !== 'done') { (farViewport as IntersectionObserver).unobserve(el); return }
  pinHeight(el)
  resetUpgrade(el)
  ;(farViewport as IntersectionObserver).unobserve(el)
  if (originalViewport) originalViewport.observe(el)   // upgraded again when it comes back
  releasedCount++
  if (releasedCount % 10 === 1) dbg(`memory: released ${releasedCount} off-screen images so far`)
}

// Recount from the document. The decoders lent to a scene preview count too:
// leaving them out let covers open past the phone's limit mid-preview.
const liveDecoders = () => document.querySelectorAll('video[data-ibh]').length + decodersBorrowed

// A <video> taken out of the page (search results replacing the list, a
// card rebuilt) keeps its decoder until garbage collection, and the
// live-cover count would never come back down. Unload them and recount
// from what is actually in the document.
export function onNodesRemoved(nodes: Iterable<AnyNode>) {
  let unloaded = 0
  for (const node of nodes) {
    if (node.nodeType !== 1) continue
    const vids = node.matches && node.matches('video[data-ibh]')
      ? [node as HTMLVideoElement]
      : (node.querySelectorAll ? [...node.querySelectorAll('video[data-ibh]')] : [])
    for (const v of vids) {
      if (!v.currentSrc) continue   // already unloaded: one of our own unmounts
      v.removeAttribute('src')
      v.load()
      unloaded++
    }
  }
  if (!unloaded) return
  setLiveCovers(liveDecoders())
  for (const card of coverQueue) if (!card.isConnected) coverQueue.delete(card)
  dbg(`memory: unloaded ${unloaded} videos removed from the page`)
}

// Leaving the page: release everything so the copy Firefox keeps for the
// back button is light. Coming back from that copy, start the page over.
function releaseAll() {
  coverQueue.clear()   // first, or each unmount hands its slot to a queued card
  markedCards('[data-ibh-cover]').forEach(card => unmountCover(card))
  markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach(card => stopGif(card))
  markedImages('[data-ibh-orig="done"]').forEach(el => {
    resetUpgrade(el)
    if (farViewport) farViewport.unobserve(el)
    if (originalViewport) originalViewport.observe(el)
  })
}

// ── Constant cleanup ──
// The observers release what scrolls away, but cards also move when the
// grid reflows, and a GIF or cover can stay alive off screen. Sweep with
// freeOffscreen() every 15 s and whenever a scroll ends.
const SWEEP_MS = 15000
const SWEEP_GAP_MS = 2000   // scroll sweeps no closer than this
let sweepAt = 0

function sweep(why: string) {
  // The modal and a preview run their own cleanup; a hidden tab is parked.
  if (document.hidden || (modal && modal.open) || scrub) return
  if (why === 'scroll' && Date.now() - sweepAt < SWEEP_GAP_MS) return
  sweepAt = Date.now()
  const n = freeOffscreen(null)
  if (n.images || n.gifs || n.covers) dbg(`memory: ${why} sweep freed ${n.images} images, ${n.gifs} GIFs, ${n.covers} covers`)
  // A safety net: a GIF whose turn came while nextGif() had to wait (a
  // finger on a video card, the modal, a hidden tab) starts here at the latest.
  nextGif()
}

// A tab in the background decodes nothing, yet its covers and GIFs keep
// their memory. Park them while hidden and bring them back on return.
// GIFs still downloading go too: Android freezes Firefox in the background,
// and a download cut there would leave the GIF marked as missing.
export const parked: HTMLElement[] = []

function onVisibilityChange() {
  if (modal && modal.open) return   // the modal already unloaded the page
  if (document.hidden) {
    parked.push(...coverQueue)
    coverQueue.clear()   // first, or each unmount hands its slot to a queued card
    markedCards('[data-ibh-cover]').forEach(card => { unmountCover(card); parked.push(card) })
    markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach(card => { stopGif(card); parked.push(card) })
    if (parked.length) dbg(`memory: tab hidden, parked ${parked.length} covers and GIFs`)
    return
  }
  for (const card of parked.splice(0)) {
    if (!card.isConnected || !card.dataset.ibhSeen) continue   // scrolled away: the observer handles it
    if (CFG.videoCovers && isVideoCard(card)) mountCover(card)
    else if (CFG.gifInline && isGifCard(card)) playGif(card)
  }
  sweep('return')
}

// A scene preview decodes a whole video, the slideshow two: free memory
// before it starts. Off-screen work goes, and GIFs on screen stop (an
// animated GIF holds every frame decoded) until the preview ends.
export const previewPaused: HTMLElement[] = []

export function freeForPreview(card: HTMLElement) {
  if (!CFG.memorySaver) return
  const n = freeOffscreen(card)
  markedCards('[data-ibh-gif="playing"]').forEach(c => {
    if (c === card) return
    stopGif(c)
    previewPaused.push(c)
    n.gifs++
  })
  if (n.images || n.gifs || n.covers) dbg(`memory: preview freed ${n.images} images, ${n.gifs} GIFs, ${n.covers} covers`)
}

export function afterPreview() {
  for (const c of previewPaused.splice(0)) {
    if (c.isConnected && c.dataset.ibhSeen && CFG.gifInline) playGif(c)
  }
}

export function installMemorySaver() {
  if (!CFG.memorySaver) return
  setInterval(() => sweep('timed'), SWEEP_MS)
  window.addEventListener('scrollend', () => sweep('scroll'), { passive: true })
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', releaseAll)
  window.addEventListener('pageshow', ev => { if (ev.persisted) redoThumbs() })
  info('memory saver active: off-screen images, GIFs and covers are released (every 15 s, after scrolls, while hidden, before previews)')
}
