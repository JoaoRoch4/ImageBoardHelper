import { CFG } from '../core/config'
import { t } from '../core/i18n'
import { dbg, info } from '../core/log'
import { fileCandidates, thumbParts } from '../urls/hosts'
import { cacheSet } from '../urls/url-cache'
import { isGifCard, isVideoCard, rebuildGif } from '../thumbs/covers'
import { ORIGINAL_EXTS, originalViewport, pictureOf } from '../thumbs/feed'
import { watchDistance } from '../thumbs/memory'
import { SITE_LINK, asElement, modal } from '../modal/modal'
import { bulkBadge, bulkMode, pageToast } from './bulk'
import { knownOriginal, postId, raceImage } from '../modal/media'

// ── Hold an image for its raw file ──
// The feed shows the sample (as sharp as the screen can show); holding an
// image half a second swaps in the original right there, for reading the
// small print of a comic. Measured on touch events: Firefox for Android
// cancels the pointer during a long press (see chipGestures). The release
// does not open the post, and the long-press menu stays out of the way.
// A GIF's thumbnail takes the same hold to be built again (holdGif).
const RAW_HOLD_MS = 500
export let rawHold: { img: HTMLImageElement, link: HTMLAnchorElement, gif: boolean, x: number, y: number, scrollY: number, fired: boolean, timer: number } | null = null
let rawClickUntil = 0

// An image post's thumbnail on a site page (not a video or GIF: those have
// their own hold, the scene preview, or play on their own).
function rawTarget(target: EventTarget | null) {
  // The selectors end in img and in a.
  const img = asElement(target)?.closest(`${SITE_LINK} img`) as HTMLImageElement | null | undefined
  const link = (img && img.closest(SITE_LINK)) as HTMLAnchorElement | null | undefined
  if (!link || link.dataset.ibhVideo || isVideoCard(link) || isGifCard(link)) return null
  return { img, link } as { img: HTMLImageElement, link: HTMLAnchorElement }   // the link was found from img
}

// A GIF post's thumbnail, by tag or found out (a card tagged "animated"
// that no video host has).
function gifTarget(target: EventTarget | null) {
  const img = asElement(target)?.closest(`${SITE_LINK} img`) as HTMLImageElement | null | undefined
  const link = (img && img.closest(SITE_LINK)) as HTMLAnchorElement | null | undefined
  if (!link || !isGifCard(link)) return null
  return { img, link } as { img: HTMLImageElement, link: HTMLAnchorElement }
}

// What a hold on this target does: the raw file, or the GIF built again.
function holdTarget(target: EventTarget | null) {
  const raw = CFG.holdRaw && rawTarget(target)
  if (raw) return { ...raw, gif: false }
  const gif = CFG.holdGif && gifTarget(target)
  return gif ? { ...gif, gif: true } : null
}

export function onRawTouchStart(ev: TouchEvent) {
  rawHold = null
  if (!(CFG.holdRaw || CFG.holdGif) || bulkMode || ev.touches.length !== 1 || (modal && modal.open)) return
  const hit = holdTarget(ev.target)
  if (!hit) return
  const finger = ev.touches[0]
  rawHold = { ...hit, x: finger.clientX, y: finger.clientY, scrollY: window.scrollY, fired: false, timer: 0 }
  rawHold.timer = setTimeout(() => {
    const h = rawHold
    if (!h || Math.abs(window.scrollY - h.scrollY) > 12) return   // the page scrolled: not a hold
    h.fired = true
    rawClickUntil = Date.now() + 800   // the click after the release opens nothing
    if (h.gif) rebuildGif(h.link)
    else loadRaw(h.img, h.link)
  }, RAW_HOLD_MS)
}

export function cancelRawHold() {
  if (rawHold && !rawHold.fired) clearTimeout(rawHold.timer)
  rawHold = null
}

export function onRawTouchMove(ev: TouchEvent) {
  if (!rawHold || rawHold.fired) return
  const finger = ev.touches[0]
  if (ev.touches.length > 1 || Math.hypot(finger.clientX - rawHold.x, finger.clientY - rawHold.y) > 12) cancelRawHold()
}

export function onRawClick(ev: MouseEvent) {
  if (Date.now() > rawClickUntil) return
  rawClickUntil = 0
  ev.preventDefault()
  ev.stopImmediatePropagation()
}

export function onRawContextMenu(ev: MouseEvent) {
  if (holdTarget(ev.target)) ev.preventDefault()   // the hold is ours
}

// The download in flight per image, so a second hold can call it off.
const rawLoads: WeakMap<HTMLImageElement, () => void> = new WeakMap()

// A second hold undoes the first: back to what was on show (the sample, or
// the thumbnail), or the download in flight called off.
function undoRaw(img: HTMLImageElement, link: HTMLAnchorElement) {
  const cancel = rawLoads.get(img)
  if (cancel) { cancel(); rawLoads.delete(img) }
  const before = img.dataset.ibhPreRaw || ''
  if (img.dataset.ibhRaw === '1') {
    if (before) img.srcset = before
    else img.removeAttribute('srcset')
    if (img.dataset.ibhRawMarked) {
      // It had no upgrade of its own: let the feed give it the sample again.
      delete img.dataset.ibhOrig
      delete img.dataset.ibhThumb
      if (originalViewport) originalViewport.observe(img)
    }
  }
  delete img.dataset.ibhRaw
  delete img.dataset.ibhPreRaw
  delete img.dataset.ibhRawMarked
  const badge = link.querySelector('.ibh-rawbadge')
  if (badge) badge.remove()
  if (navigator.vibrate) navigator.vibrate(15)
  info(`raw: post ${postId(link)} back to the ${before ? 'sample' : 'thumbnail'}`)
}

function loadRaw(img: HTMLImageElement, link: HTMLAnchorElement) {
  if (img.dataset.ibhRaw) { undoRaw(img, link); return }   // loading or loaded: a second hold undoes it
  const src = img.getAttribute('src')
  const parts = thumbParts(src)
  if (!parts) return
  const cached = knownOriginal(parts.hash)
  if (cached === null) { bulkBadge(link, '✕', '#b42318', 'ibh-rawbadge'); pageToast(t('rawFailed')); return }
  // A post without a sample already shows its original in the feed: the
  // same file again would change nothing (measured: 2 of 3 posts held).
  if (/\/images\//.test(img.getAttribute('srcset') || '')) {
    pageToast(t('rawAlready'))
    if (navigator.vibrate) navigator.vibrate(15)
    dbg(`raw: post ${postId(link)} already shows its original`)
    return
  }
  img.dataset.ibhRaw = 'loading'
  img.dataset.ibhPreRaw = img.getAttribute('srcset') || ''   // what comes back on a second hold
  bulkBadge(link, 'RAW…', 'rgba(var(--ibh-base-rgb), .85)', 'ibh-rawbadge')
  if (navigator.vibrate) navigator.vibrate(15)
  // src: thumbParts found the parts in it.
  rawLoads.set(img, raceImage([fileCandidates(src as string, ORIGINAL_EXTS)], cached, probe => {
    cacheSet('orig', parts.hash, probe.src, cached)
    const decoded = typeof probe.decode === 'function' ? probe.decode().catch(() => {}) : Promise.resolve()
    decoded.then(() => {
      if (!img.isConnected || img.dataset.ibhRaw !== 'loading') return
      const pic = pictureOf(img)
      if (!pic) return
      rawLoads.delete(img)
      // Release goes back to the thumbnail like any upgrade (see D).
      if (img.dataset.ibhOrig !== 'done') {
        img.dataset.ibhThumb = src as string
        img.dataset.ibhOrig = 'done'
        img.dataset.ibhRawMarked = '1'
        watchDistance(img)
      }
      pic.set(probe.src)
      img.dataset.ibhRaw = '1'
      bulkBadge(link, 'RAW', 'var(--ibh-accent-mid)', 'ibh-rawbadge')
      info(`raw: post ${postId(link)} shows its original (${probe.src.split('/').pop()})`)
    })
  }, () => {
    rawLoads.delete(img)
    delete img.dataset.ibhRaw
    delete img.dataset.ibhPreRaw
    cacheSet('orig', parts.hash, null)
    bulkBadge(link, '✕', '#b42318', 'ibh-rawbadge')
    pageToast(t('rawFailed'))
  }, 'high'))
}
