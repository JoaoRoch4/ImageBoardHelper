import type { AnyNode } from './covers'
import { LIST, THUMB } from '../core/site'
import { CFG } from '../core/config'
import { dbg } from '../core/log'
import { fileCandidates, imageBase, thumbParts } from '../urls/hosts'
import { cacheGet, cacheSet, urlPending, urlPrefetch, urlReading } from '../urls/url-cache'
import { IMAGE_MAX_INFLIGHT, giveImageSlot, imagesInflight, imgPicture, isGifCard, isVideoCard, setImagesInflight } from './covers'
import { unpinHeight, watchDistance } from './memory'
import { modal } from '../modal/modal'
import { raceImage } from '../modal/media'
import { suspended } from '../modal/open'

// ═══════════════════════════════════════════════════════════
// B. Sharp thumbnails: feed samples and originals
//
// Swaps visible thumbnails for a sharper file: the sample in the feed (the
// original when there is none) and, with originalThumbs, the original where
// the box shows wider than the sample (upgradePlan). The thumbnail is always
// .jpg, so the real extension is unknown: each one is tried in an off-screen
// Image and the visible <img> only changes once one loads, so nothing
// flickers. Originals cost several times the data and memory of the
// sample, which is why originalThumbs ships off.
// ═══════════════════════════════════════════════════════════

export const ORIGINAL_EXTS = ['jpg', 'png', 'jpeg']   // no gif: animated originals are heavy

// In the one-column feed a 150 px thumbnail is stretched to the screen width.
// The sample (about 850 px) is already sharp there and far lighter than the
// original; posts too small to have a sample fall through to the original.
const inFeed = (el: Element) => CFG.nativeFeed && !!el.closest(LIST)

export function sampleCandidates(src: string) {
  const p = thumbParts(src)
  if (!p) return []
  const bases = [imageBase()]
  try { bases.push(`${new URL(src).origin}/images`) } catch (e) { /* ignore */ }
  return [...new Set(bases.filter(Boolean) as string[])]
    .map(b => `${b.replace(/\/images$/, '/samples')}/${p.dir}/sample_${p.hash}.jpg`)
}

// What an upgrade fetches, and under which cache kind. Candidates come in
// stages for raceImage: samples before originals, so a big original never
// loads beside a sample that exists.
//
// On the site's pages the sample (850 px wide on Gelbooru 0.2) is taken
// whenever it covers the image's width on screen in device pixels: as
// sharp as the screen can show, comics legible, at a fraction of the size
// (measured: a comic page 705 KB against a 51 MB PNG original, another 2 MB
// against 31 MB). originalThumbs then only fetches the original where the
// box is wider than the sample (a desktop screen).
const SAMPLE_WIDTH = 850

function displayPixels(el: HTMLElement) {
  const box = el.closest(THUMB) || el
  return (box.clientWidth || el.clientWidth || 0) * (window.devicePixelRatio || 1)
}

function upgradePlan(el: HTMLElement, src: string): { kind: string, stages: string[][] } {
  if (thumbKind(el) === 'video') return { kind: 'poster', stages: [fileCandidates(src, ['jpg'])] }
  const originals = fileCandidates(src, ORIGINAL_EXTS)
  const sitePage = true
  const sampleDoes = sitePage && (!CFG.originalThumbs || displayPixels(el) <= SAMPLE_WIDTH * 1.1)
  if (sampleDoes && (inFeed(el) || CFG.originalThumbs)) return { kind: 'sample', stages: [sampleCandidates(src), originals] }
  return { kind: 'orig', stages: [originals] }
}

// Downloads already run on the browser's network threads; the slots shared
// with GIFs (IMAGE_MAX_INFLIGHT, see B) cap how many the script starts at once.
// Targets are the thumbnails (and samples) on the site's pages.
const ORIGINAL_SELECTOR = 'img[src*="/thumbnails/"], img[src*="/samples/"]'
export const originalQueue: HTMLImageElement[] = []
export let upgradeGen = 0   // bumped by freeMemory(): upgrades already in flight drop their result
export function setUpgradeGen(v: typeof upgradeGen) { upgradeGen = v }


export function pictureOf(el: HTMLImageElement) {
  return imgPicture(el)
}

// The kind of post a thumbnail shows, taken from its link, which is what the
// cover and GIF code treat as the card (the tags sit in title/alt).
export function thumbKind(el: Element) {
  const card = el.closest('a') || el.parentElement
  if (card && isGifCard(card)) return 'gif'
  if (card && isVideoCard(card)) return 'video'
  return 'image'
}

/**
 * Returns true once the element needs no more watching.
 */
export function upgradeToOriginal(el: HTMLImageElement) {
  if (el.dataset.ibhOrig) return true   // already queued, done or failed
  // Without originalThumbs, only feed images on site pages get upgraded.
  if (!CFG.originalThumbs && !inFeed(el)) return true
  if (thumbKind(el) === 'gif') return true   // inline GIFs have their own path
  // No picture yet: try on the next intersection.
  const pic = pictureOf(el)
  if (!pic || !thumbParts(pic.src)) return false
  el.dataset.ibhOrig = 'queued'
  originalQueue.push(el)
  pumpOriginals()
  return true
}


// The queued image nearest the screen goes next. One scrolled two screens
// away goes back to waiting (the observer queues it again when it comes
// near), so a fast scroll does not spend the download slots on what it
// passed by.
function nextQueued() {
  const h = window.innerHeight
  const near: Array<[number, HTMLImageElement]> = []
  for (const el of originalQueue) {
    if (!el.isConnected) continue
    const r = el.getBoundingClientRect()
    const d = r.bottom < 0 ? -r.bottom : r.top > h ? r.top - h : 0
    if (d > h * 2) {
      delete el.dataset.ibhOrig
      if (originalViewport) originalViewport.observe(el)
      continue
    }
    near.push([d, el])
  }
  originalQueue.length = 0
  if (!near.length) return null
  near.sort((a, b) => a[0] - b[0])
  originalQueue.push(...near.slice(1).map(pair => pair[1]))
  return near[0][1]
}

let pumpAfterRead = false
export function pumpOriginals() {
  const later: HTMLImageElement[] = []   // their URLs may still come from IndexedDB
  while (imagesInflight < IMAGE_MAX_INFLIGHT && originalQueue.length) {
    const el = nextQueued()
    if (!el) break
    const pic = pictureOf(el)
    if (!pic) continue
    const plan = upgradePlan(el, pic.src)
    const ck: CacheKey = { kind: plan.kind, hash: (thumbParts(pic.src) || {}).hash }
    if (urlPending(ck.kind, ck.hash)) { later.push(el); continue }
    ck.cached = cacheGet(ck.kind, ck.hash)
    if (ck.cached === null) { el.dataset.ibhOrig = 'failed'; continue }   // known: nothing loads
    setImagesInflight(imagesInflight + 1)
    probeOriginal(el, pic.src, plan.stages, giveImageSlot, ck)
  }
  if (!later.length) return
  originalQueue.push(...later)
  if (!pumpAfterRead && urlReading) {
    pumpAfterRead = true
    urlReading.then(() => { pumpAfterRead = false; pumpOriginals() })
  }
}

// The candidates race (raceImage): a wrong extension costs nothing, where
// trying them in turn held a download slot ~0.5 s per miss.
// ck: where the winner is cached, and what cacheGet had for it.
export type CacheKey = { kind: string, hash: string | undefined, cached?: string | null }
function probeOriginal(el: HTMLImageElement, from: string, stages: string[][], done: () => void, ck?: CacheKey) {
  const gen = upgradeGen
  let probe: HTMLImageElement | null = null
  raceImage(stages, ck ? ck.cached : undefined, winner => {
    probe = winner
    if (gen !== upgradeGen) { done(); return }   // memory freed meanwhile: start over later
    if (ck) cacheSet(ck.kind, ck.hash, probe.src, ck.cached)   // the URL works, whatever happens to the swap
    // Decode off the main thread before swapping, so the new image appears in
    // one go instead of stalling the scroll while a large file is decoded.
    const decoded = typeof probe.decode === 'function' ? probe.decode().catch(() => {}) : Promise.resolve()
    decoded.then(swap)
  }, () => {
    if (gen !== upgradeGen) { done(); return }
    el.dataset.ibhOrig = 'failed'
    if (ck) cacheSet(ck.kind, ck.hash, null)
    dbg(`original: nothing loaded for ${from}`)
    done()
  })
  const swap = () => {
    if (gen !== upgradeGen) { done(); return }   // memory freed meanwhile: the element was reset
    if (el.dataset.ibhRaw) { done(); return }   // held for the raw file meanwhile: keep it
    // The modal unloads the page while it is open: drop this upgrade and let
    // it run again when the modal closes.
    if (modal && modal.open) {
      delete el.dataset.ibhOrig
      suspended.push(el)
      done()
      return
    }
    // Out of the feed the thumbnail has no fixed box: pin its current size so
    // the full-resolution file does not blow up the page layout.
    if (!inFeed(el) && el.clientWidth) {
      el.style.width = `${el.clientWidth}px`
      el.style.height = `${el.clientHeight}px`
      el.style.objectFit = 'contain'
    }
    if (el.tagName === 'IMG') el.decoding = 'async'
    const pic = pictureOf(el)
    if (pic) pic.set((probe as HTMLImageElement).src)   // already in cache and decoded, so this paints at once
    el.dataset.ibhThumb = from    // what freeMemory() and redoThumbs() put back
    el.dataset.ibhOrig = 'done'
    unpinHeight(el)
    watchDistance(el)   // released again once it is far off screen, see G
    dbg(`original: ${(probe as HTMLImageElement).src}`)   // swap runs once the race won
    done()
  }
}

export const originalViewport = 'IntersectionObserver' in window
  ? new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        // Scrolled in under the modal: wait for it to close (resumePage observes again).
        // The observer is this very one, and what it watches are scanThumbs' images.
        if (modal && modal.open) { (originalViewport as IntersectionObserver).unobserve(e.target); suspended.push(e.target as HTMLImageElement); continue }
        if (upgradeToOriginal(e.target as HTMLImageElement)) (originalViewport as IntersectionObserver).unobserve(e.target)
      }
    }, { rootMargin: '300px' })
  : null

const watchedThumbs: WeakSet<Element> = new WeakSet()

export function scanThumbs(root: AnyNode) {
  if (!(CFG.originalThumbs || CFG.nativeFeed) || !root || !root.querySelectorAll) return
  const found = [...root.querySelectorAll(ORIGINAL_SELECTOR)]
  if (root.matches && root.matches(ORIGINAL_SELECTOR)) found.push(root as HTMLImageElement)   // matched img[…]
  for (const el of found) {
    if (watchedThumbs.has(el)) continue
    watchedThumbs.add(el)
    urlPrefetch(el.getAttribute('src'))
    originalViewport ? originalViewport.observe(el) : upgradeToOriginal(el)
  }
}
