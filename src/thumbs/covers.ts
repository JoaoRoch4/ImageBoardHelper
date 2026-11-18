import { THUMB } from '../core/site'
import { CFG } from '../core/config'
import { dbg, info, warn } from '../core/log'
import { STATE, touch } from '../core/state'
import { fileCandidates, thumbParts } from '../urls/hosts'
import { cacheGet, cacheSet, cachedFirst, forgetMiss, urlPending, urlPrefetch } from '../urls/url-cache'
import { pastDecoder } from '../video/limits'
import { markDuration, markPastDecoder } from './badges'
import { originalViewport, pumpOriginals } from './feed'
import { scrub } from '../scrub/scrub'
import { farViewport, pinHeight } from './memory'
import { modal } from '../modal/modal'
import { paintCardMarks, setDims } from './marks'
import { postId } from '../modal/media'
import { resetUpgrade } from '../diag'

// ═══════════════════════════════════════════════════════════
// A. Real video covers
// ═══════════════════════════════════════════════════════════


const tracked: WeakSet<HTMLElement> = new WeakSet()

// The elements carrying one of this script's own data-ibh-* marks, typed as
// what it marks: cards (a thumbnail's link) and, for data-ibh-orig, their
// <img>. Only the selectors below are accepted, so a lookup can't claim a
// type for a mark the script puts elsewhere.
export function markedCards(selector: '[data-ibh-cover]' | '[data-ibh-seen]' | '[data-ibh-kind]' | '[data-ibh-gif]' | '[data-ibh-gif="playing"]' | '[data-ibh-gif="playing"], [data-ibh-gif="loading"]'): NodeListOf<HTMLElement> {
  return document.querySelectorAll(selector) as NodeListOf<HTMLElement>
}
export function markedImages(selector: '[data-ibh-orig]' | '[data-ibh-orig="done"]'): NodeListOf<HTMLImageElement> {
  return document.querySelectorAll(selector) as NodeListOf<HTMLImageElement>
}

// A card is the link around a thumbnail (Gelbooru 0.2 markup). The kind
// comes from the tags in the thumbnail's title or alt, or the site's own
// .webm-thumb mark. "animated" alone may be either kind: it counts as video,
// and the cover falls back to the GIF when no video host answers.
export const nativeTags = (card: HTMLElement) => {
  const img = card.querySelector('img')
  return ` ${(img && (img.title || img.alt)) || ''} `
}
export const NATIVE_GIF = /\s(gif|animated_gif)\s/i
const NATIVE_VIDEO = /\s(video|mp4|webm|animated)\s/i
export const NATIVE_REAL_VIDEO = /\s(video|mp4|webm)\s/i   // "animated" alone may be a GIF
export const isVideoCard = (card: HTMLElement) => !!card.querySelector('img.webm-thumb') ||   // the site's own video mark
  (NATIVE_VIDEO.test(nativeTags(card)) && !NATIVE_GIF.test(nativeTags(card)))
export const isGifCard = (card: HTMLElement) => card.dataset.ibhKind === 'gif' || NATIVE_GIF.test(nativeTags(card))

export const cardPicture = (card: HTMLElement) => { const img = card.querySelector('img'); return img ? imgPicture(img) : null }

// On an <img>, the better file goes in srcset and src is left alone: the
// browser paints the srcset candidate, while src keeps the site's thumbnail
// URL for everything that reads it (Imagus and other hover-zoom tools match
// on the thumbnail_ pattern). Setting the thumbnail back (or nothing) clears
// srcset.
export type Picture = { src: string, set: (url: string | null | undefined) => void }
export function imgPicture(img: HTMLImageElement): Picture | null {
  if (!img.src) return null
  return {
    src: img.src,
    set: url => {
      if (!url || url === img.src) img.removeAttribute('srcset')
      else img.srcset = url.replace(/ /g, '%20').replace(/,/g, '%2C')   // srcset splits on both
    },
  }
}

// Firefox for Android decodes about four videos at once on a mid-range phone;
// past that, new <video> elements sit at "metadata" forever or fail with a
// decode error. Keep covers under the limit, with one decoder spare for the
// viewer, and hand freed slots to cards still waiting on screen.
export const COVER_MAX_LIVE = 3
export const COVER_POINT = 0.35   // where in the video the cover frame is taken
export let liveCovers = 0
export function setLiveCovers(v: typeof liveCovers) { liveCovers = v }
export const coverQueue: Set<HTMLElement> = new Set()

// A card element can be rebuilt (the autopager, a page restored from the
// back button), so "this is a GIF" is remembered by file hash, not on it.
export const knownGifs: Set<string> = new Set()

export function releaseCover() {
  liveCovers = Math.max(0, liveCovers - 1)
  for (const card of coverQueue) {
    if (liveCovers >= COVER_MAX_LIVE) break
    coverQueue.delete(card)
    if (card.isConnected && card.dataset.ibhSeen) mountCover(card)
  }
}

export function mountCover(card: HTMLElement) {
  if (card.dataset.ibhCover || card.dataset.ibhBigVideo) return
  const pic = cardPicture(card)
  if (!pic) return
  // Tags call some GIFs videos ("animated" alone). Once a file proved to be
  // a GIF, go straight to the GIF path.
  const parts = thumbParts(pic.src)
  const wait = parts && urlPending('video', parts.hash)
  if (wait) {   // its URL may still come from IndexedDB
    // A post opened meanwhile: resumePage() brings the cover back on close.
    wait.then(() => { if (card.isConnected && card.dataset.ibhSeen && !(modal && modal.open)) mountCover(card) })
    return
  }
  const vcached = parts ? cacheGet('video', parts.hash) : undefined
  // Known not to be a video (no host has it): straight to the GIF path.
  if (parts && (knownGifs.has(parts.hash) || vcached === null)) card.dataset.ibhKind = 'gif'
  if (card.dataset.ibhKind === 'gif') { if (CFG.gifInline) playGif(card); return }
  if (liveCovers >= COVER_MAX_LIVE) { coverQueue.add(card); return }

  const urls = cachedFirst(fileCandidates(pic.src, ['mp4', 'webm']), vcached)
  if (!urls.length) { dbg('video card outside the derivable pattern'); return }

  card.dataset.ibhCover = '1'
  liveCovers++
  const v = document.createElement('video')
  v.dataset.ibh = '1'
  v.muted = true
  v.playsInline = true
  v.preload = 'metadata'   // headers only, not the whole file
  v.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
    'border-radius:4px;pointer-events:none;opacity:0;transition:opacity .2s'

  const giveUp = () => {
    v.remove()
    delete card.dataset.ibhCover
    releaseCover()
  }

  // Walk the candidate hosts until one answers, instead of giving up on the
  // first 404 — that was what made covers vanish without a trace.
  let i = 0
  let networkError = false
  const tryNext = () => {
    if (card.dataset.ibhBigVideo) return   // dropped on purpose (past the decoder), not a failure
    // A decode error means the file was there but no decoder was free; other
    // hosts would fail the same way. The next time the card scrolls in retries.
    if (v.error && v.error.code === 3) {
      giveUp()
      dbg(`cover: no decoder free for ${pic.src}`)
      return
    }
    if (v.error && v.error.code === 2) networkError = true   // MEDIA_ERR_NETWORK: says nothing about the file
    if (i >= urls.length) {
      giveUp()
      // A dropped connection fails every host: not proof it is a GIF.
      if (networkError || navigator.onLine === false) { dbg(`cover: network error for ${pic.src}, will retry`); return }
      card.dataset.ibhKind = 'gif'
      if (parts) { knownGifs.add(parts.hash); cacheSet('video', parts.hash, null) }
      // A video mark we added ourselves does not belong on a GIF.
      const marked = card.querySelector('img[data-ibh-mark]')
      if (marked) { marked.classList.remove('webm-thumb'); delete marked.dataset.ibhMark }
      dbg(`no video host answered for ${pic.src}; trying it as a GIF`)
      if (CFG.gifInline) playGif(card)
      else { STATE.covers.failed++; touch() }
      return
    }
    v.src = urls[i++]
  }

  // The cover is the frame at 35% of the video: past intros and title cards,
  // and the duration is known as soon as the metadata arrives. Reveal only
  // once that frame is painted, otherwise a black rectangle (or frame 0) flashes.
  let seekingCover = false
  const reveal = () => {
    if (v.style.opacity === '1') return
    v.style.opacity = '1'
    STATE.covers.ok++
    touch()
  }
  v.addEventListener('loadedmetadata', () => {
    if (parts) cacheSet('video', parts.hash, urls[i - 1], vcached)
    markDuration(card, v.duration)
    // Past a mid-range hardware decoder (this phone's stops at 1920×1088):
    // decoding a frame falls to the CPU, for a still the poster already
    // gives. Drop the cover and leave the picture (the feed upgrades it to
    // the full-size poster frame).
    setDims(postId(card), v.videoWidth, v.videoHeight)
    if (pastDecoder(v.videoWidth, v.videoHeight)) {
      markPastDecoder(card, `${v.videoWidth}x${v.videoHeight}`)
      dbg(`cover: ${v.videoWidth}x${v.videoHeight} is past the hardware decoder, poster kept instead`)
      v.removeAttribute('src')
      v.load()
      giveUp()
      return
    }
    if (Number.isFinite(v.duration) && v.duration > 0) {
      seekingCover = true
      v.currentTime = v.duration * COVER_POINT
    }
  }, { once: true })
  v.addEventListener('seeked', reveal, { once: true })
  v.addEventListener('loadeddata', () => { if (!seekingCover) reveal() }, { once: true })   // unknown duration
  v.addEventListener('error', tryNext)
  tryNext()

  // Site pages mark videos with a border on the thumbnail (rule34: 3px blue
  // .webm-thumb); give the cover the same border so the mark stays visible.
  const thumb = card.querySelector('img')
  if (thumb) {
    v.style.border = getComputedStyle(thumb).border
    v.style.boxSizing = 'border-box'
    v.style.borderRadius = '0'
  }

  if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
  // Sit right above the picture, under anything the site lays over it.
  const picEl = card.querySelector(':scope > img')
  if (picEl) picEl.after(v)
  else card.appendChild(v)
}

export function unmountCover(card: HTMLElement) {
  coverQueue.delete(card)
  const v = card.querySelector('video[data-ibh]')
  if (!v) return
  v.removeAttribute('src')
  v.load()   // hand the decoder back; Android has few of them
  v.remove()
  delete card.dataset.ibhCover
  releaseCover()
}

// At most three image downloads at a time, GIFs and upgrades together: fewer
// files half-loaded and decoding at once, and each one finishes sooner on a
// slow connection. A GIF waiting for a slot goes before queued upgrades.
export const IMAGE_MAX_INFLIGHT = 3
export let imagesInflight = 0
export function setImagesInflight(v: typeof imagesInflight) { imagesInflight = v }
export const imageWaiters: Array<() => void> = []

export function takeImageSlot(start: () => void) {
  if (imagesInflight < IMAGE_MAX_INFLIGHT) { imagesInflight++; start() }
  else imageWaiters.push(start)
}

export function giveImageSlot() {
  imagesInflight = Math.max(0, imagesInflight - 1)
  const next = imageWaiters.shift()
  if (next) { imagesInflight++; next() }
  else pumpOriginals()
}

// GIF cards show a still (sample or thumbnail .jpg). While on screen, swap in
// the original .gif, probed off-screen first; put the still back on the way
// out, because animated GIFs hold every decoded frame in memory.
// Every animated GIF keeps all its frames decoded: past a few at once the
// phone runs out of memory and Firefox drops them (the broken-GIF rebuild,
// see watchGif). Cards past the limit wait as stills, nearest the middle of
// the screen first, and take the place of one that scrolls away.
export const gifQueue: Set<HTMLElement> = new Set()
export const gifsLive = () => markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').length

// How far a card's middle sits from the middle of the screen, in px.
export const fromMiddle = (card: HTMLElement) => Math.abs(card.getBoundingClientRect().top + card.offsetHeight / 2 - window.innerHeight / 2)

export function nextGif() {
  // Stopped to free memory (the modal, a scene preview, a hidden tab): those
  // bring their GIFs back themselves when they end.
  if (document.hidden || (modal && modal.open) || scrub) return
  const max = Number(CFG.gifMaxLive) || 3
  const waiting = [...gifQueue].filter(card => {
    if (card.isConnected && card.dataset.ibhSeen && !card.dataset.ibhGif) return true
    gifQueue.delete(card)
    return false
  })
  waiting.sort((a, b) => fromMiddle(a) - fromMiddle(b))
  for (const card of waiting) {
    if (gifsLive() >= max) break
    gifQueue.delete(card)
    playGif(card)
  }
}

// The panel changed the limit: stop the GIFs farthest from the middle past
// it, or start waiting ones in the room it made.
export function applyGifLimit() {
  const max = Number(CFG.gifMaxLive) || 3
  const middle = window.innerHeight / 2
  const live = [...markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]')]
    .sort((a, b) => Math.abs(b.getBoundingClientRect().top - middle) - Math.abs(a.getBoundingClientRect().top - middle))
  // The farthest ones, past the limit.
  for (const card of live.splice(0, live.length - max)) {
    stopGif(card)
    gifQueue.add(card)
  }
  nextGif()
}

// A GIF still downloading, per card: stopGif cancels it, which hands its
// download slot on at once. A GIF scrolled past used to keep its slot until
// the whole file came (forever when the download stalled), and with all
// three held no other GIF started.
const gifLoads: WeakMap<HTMLElement, () => void> = new WeakMap()

export function playGif(card: HTMLElement) {
  if (card.dataset.ibhGif) return   // loading, playing or failed
  if (gifRebuild && gifRebuild !== card) { gifQueue.add(card); return }   // after the held one
  if (gifsLive() >= (Number(CFG.gifMaxLive) || 3)) { gifQueue.add(card); return }   // waits its turn
  const pic = cardPicture(card)
  if (!pic) return
  const hash = (thumbParts(pic.src) || {}).hash
  // Its URL may still come from IndexedDB: in the queue until then.
  const wait = urlPending('gif', hash)
  if (wait) { gifQueue.add(card); wait.then(nextGif); return }
  const gcached = cacheGet('gif', hash)
  const urls = cachedFirst(fileCandidates(pic.src, ['gif']), gcached)
  if (!urls.length) { dbg('gif card outside the derivable pattern'); return }
  if (gcached === null) { card.dataset.ibhGif = 'failed'; return }   // known: no .gif for it

  card.dataset.ibhGif = 'loading'
  const probe = new Image()
  let i = 0
  let held = false   // a download slot, once takeImageSlot hands one over
  let live = true    // false once stopGif cancelled this load
  const release = () => { if (held) { held = false; giveImageSlot() } }
  gifLoads.set(card, () => {
    live = false
    probe.onload = probe.onerror = null
    probe.removeAttribute('src')   // Firefox drops the download
    release()
  })
  const tryNext = () => {
    if (i >= urls.length) {
      gifLoads.delete(card)
      release()
      card.dataset.ibhGif = 'failed'
      cacheSet('gif', hash, null)
      if (card.dataset.ibhKind === 'gif') { STATE.covers.failed++; touch() }
      dbg(`gif: no host answered for ${pic.src}`)
      if (gifRebuild === card) warn('gif: held to rebuild it, but no host answered')
      endGifRebuild(card)
      nextGif()   // its place goes to a waiting one
      return
    }
    probe.src = urls[i++]
  }
  probe.onload = () => {
    gifLoads.delete(card)
    release()
    cacheSet('gif', hash, probe.src, gcached)
    if (card.dataset.ibhGif !== 'loading') return
    card.dataset.ibhStill = pic.src
    // The card's <img> had a src when the probe started, and nothing in the
    // script takes either away (resets change srcset only).
    ;(cardPicture(card) as Picture).set(probe.src)
    card.dataset.ibhGif = 'playing'
    watchGif(card)
    endGifRebuild(card, GIF_REBUILD_GRACE_MS)
    if (card.dataset.ibhKind === 'gif') { STATE.covers.ok++; touch() }
    dbg(`gif: playing ${probe.src}`)
  }
  probe.onerror = tryNext
  takeImageSlot(() => {
    if (!live) { giveImageSlot(); return }   // stopped while it waited for the slot
    held = true
    tryNext()
  })
}

// An animated GIF keeps every decoded frame, and under memory pressure
// Firefox drops it and shows a broken image. Watch the <img> after the swap;
// when it breaks, free more memory and build the GIF again, twice at most.
export const GIF_RETRIES = 2

function watchGif(card: HTMLElement) {
  const img = card.querySelector('img')
  if (!img || img.dataset.ibhGifWatch) return
  img.dataset.ibhGifWatch = '1'
  const check = (ev: Event) => {
    if (card.dataset.ibhGif !== 'playing' || !img.srcset) return   // stopped or back to the still
    // "load" with no width is how a broken decode shows up.
    if (ev.type === 'error' || img.naturalWidth === 0) gifBroken(card)
  }
  img.addEventListener('error', check)
  img.addEventListener('load', check)
}

function gifBroken(card: HTMLElement) {
  const tries = Number(card.dataset.ibhGifRetries || 0)
  if (tries >= GIF_RETRIES) {
    stopGif(card)
    card.dataset.ibhGif = 'failed'
    warn('gif: still broken after rebuilding, left as a still')
    return
  }
  card.dataset.ibhGifRetries = String(tries + 1)
  const freed = freeOffscreen(card)
  info(`gif: broken, freed ${freed.images} images, ${freed.gifs} GIFs, ${freed.covers} covers; rebuilding (try ${tries + 1})`)
  stopGif(card)
  // A beat for the freed memory to be reclaimed before decoding again.
  setTimeout(() => { if (card.isConnected && card.dataset.ibhSeen) playGif(card) }, 400)
}

// holdGif: a GIF left broken or on its still is built again on a hold,
// ahead of the others. Their decoded frames are what runs the phone out
// of memory, so they stop and wait in the queue until this one plays (a
// grace for its first frames, a cap for a download that stalls), and what
// is off screen goes. Its retries, its failure and its remembered miss
// start over.
const GIF_REBUILD_GRACE_MS = 1000
const GIF_REBUILD_MAX_MS = 10000
export let gifRebuild: HTMLElement | null = null   // the held GIF, while the others wait for it
let gifRebuildTimer = 0

export function rebuildGif(card: HTMLElement) {
  const pic = cardPicture(card)
  if (!pic) return
  const freed = freeOffscreen(card)
  let paused = 0
  markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach(c => {
    if (c === card) return
    stopGif(c)
    gifQueue.add(c)   // back once the held one plays
    paused++
  })
  const was = card.dataset.ibhGif || 'still'
  stopGif(card)
  delete card.dataset.ibhGif   // stopGif leaves a failed one marked
  delete card.dataset.ibhGifRetries
  forgetMiss('gif', (thumbParts(pic.src) || {}).hash)
  gifRebuild = card
  clearTimeout(gifRebuildTimer)
  gifRebuildTimer = setTimeout(() => endGifRebuild(card), GIF_REBUILD_MAX_MS)
  info(`gif: held, rebuilding it (was ${was}); ${paused} other GIFs paused until it plays, freed ${freed.images} images, ${freed.gifs} GIFs, ${freed.covers} covers off screen`)
  playGif(card)
}

// The others' turn, `after` ms from now. Called when the held GIF plays,
// fails or stops; a call for another card changes nothing.
function endGifRebuild(card: HTMLElement, after: number = 0) {
  if (gifRebuild !== card) return
  clearTimeout(gifRebuildTimer)
  gifRebuildTimer = setTimeout(() => {
    if (gifRebuild !== card) return
    gifRebuild = null
    nextGif()
  }, after)
}

// Release what is not on screen: upgraded images back to the thumbnail
// (heights held), other GIFs stilled, covers closed. On screen means within
// one screen of the viewport.
export function freeOffscreen(keep: HTMLElement | null) {
  const n = { images: 0, gifs: 0, covers: 0 }
  const far = (el: Element) => {
    const r = el.getBoundingClientRect()
    return r.bottom < -window.innerHeight || r.top > window.innerHeight * 2
  }
  markedImages('[data-ibh-orig="done"]').forEach(el => {
    if (!far(el)) return
    pinHeight(el)
    resetUpgrade(el)
    if (farViewport) farViewport.unobserve(el)
    if (originalViewport) originalViewport.observe(el)   // upgraded again when it comes back
    n.images++
  })
  markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach(card => {
    if (card !== keep && far(card)) { stopGif(card); n.gifs++ }
  })
  markedCards('[data-ibh-cover]').forEach(card => {
    if (far(card)) { unmountCover(card); n.covers++ }
  })
  return n
}

export function stopGif(card: HTMLElement) {
  endGifRebuild(card)
  gifQueue.delete(card)
  const cancel = gifLoads.get(card)
  if (cancel) { gifLoads.delete(card); cancel() }
  const state = card.dataset.ibhGif
  if (state === 'playing' && card.dataset.ibhStill) {
    const pic = cardPicture(card)
    if (pic) pic.set(card.dataset.ibhStill)
  }
  if (state === 'playing' || state === 'loading') {
    delete card.dataset.ibhGif
    setTimeout(nextGif, 0)   // after the caller's own stops, e.g. a page-wide release
  }
}

// Opening decoders only for what is on screen keeps the phone alive.
const viewport = 'IntersectionObserver' in window
  ? new IntersectionObserver(entries => {
      for (const e of entries) {
        const card = e.target as HTMLElement   // what trackCard observes
        if (e.isIntersecting) card.dataset.ibhSeen = '1'
        else delete card.dataset.ibhSeen
        // The page scrolls under the modal as it steps (H): keep it unloaded;
        // resumePage() brings back what is seen on close.
        if (modal && modal.open) continue
        if (isVideoCard(card) && card.dataset.ibhKind !== 'gif') {
          e.isIntersecting ? mountCover(card) : unmountCover(card)
        } else if (!e.isIntersecting) {
          stopGif(card)
        } else if (CFG.gifInline) {
          playGif(card)   // a "video" that proved a GIF is watched for its cover: inline GIFs may be off
        }
      }
    }, { rootMargin: '200px' })
  : null

function trackCard(card: HTMLElement) {
  if (tracked.has(card)) return
  tracked.add(card)
  urlPrefetch(card.querySelector('img')?.getAttribute('src'))
  if (CFG.videoScrub && isVideoCard(card)) {
    card.dataset.ibhVideo = '1'   // scrub target, see F
    // On site pages the thumbnail is an <img> in a link, and a sideways drag
    // starts the browser's drag-and-drop, which cancels the touch mid-scrub.
    card.setAttribute('draggable', 'false')
    const img = card.querySelector('img')
    if (img) img.draggable = false
  }
  const video = CFG.videoCovers && isVideoCard(card)
  const gif = CFG.gifInline && isGifCard(card)
  if (!video && !gif) return
  if (video) { STATE.covers.tracked++; touch() }
  if (viewport) viewport.observe(card)
  else { card.dataset.ibhSeen = '1'; video ? mountCover(card) : playGif(card) }
}

// On site pages the link around each thumbnail plays the part of the card.
const NATIVE_THUMB = `${THUMB} img`

// A node of any kind, as a mutation brings it: only elements and documents
// have these, checked before they are called.
export type AnyNode = Node & Partial<Pick<Element, 'querySelectorAll' | 'matches'>>

export function scanCards(root: AnyNode) {
  if (!root || !root.querySelectorAll) return
  // The selector ends in img: these are images.
  const imgs = [...root.querySelectorAll(NATIVE_THUMB)] as HTMLImageElement[]
  if (root.matches && root.matches(NATIVE_THUMB)) imgs.push(root as HTMLImageElement)
  for (const img of imgs) {
    // Inside a card (the selector's THUMB), so it has a parent.
    const link = (img.closest('a') || img.parentElement) as HTMLElement
    // The search list marks videos with .webm-thumb (a blue frame), but
    // favorites leave it out. Put the site's own mark back on real videos.
    const tags = nativeTags(link)
    if (!img.classList.contains('webm-thumb') && NATIVE_REAL_VIDEO.test(tags) && !NATIVE_GIF.test(tags)) {
      img.classList.add('webm-thumb')
      img.dataset.ibhMark = '1'
    }
    // Inline links have no box of their own; the cover needs one to sit on.
    if (getComputedStyle(link).display === 'inline') link.style.display = 'inline-block'
    trackCard(link)
    paintCardMarks(link)
  }
}
