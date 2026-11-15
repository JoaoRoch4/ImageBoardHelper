// What the modal shows: the video, the image and its original, a GIF.
/** @import { Picture } from '../thumbs/covers' */
import { CFG } from '../core/config'
import { t } from '../core/i18n'
import { dbg, info, warn } from '../core/log'
import { fileCandidates, thumbParts } from '../urls/hosts'
import { cacheGet, cacheSet, cachedFirst } from '../urls/url-cache'
import { pastDecoder } from '../video/limits'
import { GIF_RETRIES, NATIVE_GIF, NATIVE_REAL_VIDEO, cardPicture, coverQueue, markedCards, nativeTags, unmountCover } from '../thumbs/covers'
import { ORIGINAL_EXTS } from '../thumbs/feed'
import { flash, modal } from './modal'
import { renderInfo } from './tags'
import { applyZoom } from './gestures'
import { fitFullscreenOrientation } from './player'
import { preloadAhead } from './open'

/**
 * @param {string[]} candidates
 * @param {string | undefined} hash
 * @param {() => void} [onMissing]   no host has a video file
 * @param {() => void} [onFound]     its metadata arrived
 */
export function showVideo(candidates, hash, onMissing, onFound) {
  const vcached = cacheGet('video', hash)
  const urls = cachedFirst(candidates, vcached)
  const seq = modal.seq
  // The phone decodes about four videos at once; the modal gets one of them.
  markedCards('[data-ibh-cover]').forEach(card => unmountCover(card))
  coverQueue.clear()
  modal.image.hidden = true
  modal.video.hidden = false
  modal.vwrap.hidden = false
  modal.stage.classList.remove('tall')
  modal.stage.style.touchAction = 'none'   // all drags are ours; the controls still work
  const v = modal.video
  let i = 0
  v.onerror = () => {
    if (i < urls.length) { v.src = urls[i++]; return }   // walk the hosts, like covers
    // No decoder free (3) or a network drop (2) is not "missing".
    const missing = !(v.error && (v.error.code === 3 || v.error.code === 2))
    if (missing) cacheSet('video', hash, null)
    // No host has a video file: posts tagged "animated" but not "gif" are
    // often GIFs, so try that before showing the failure.
    if (missing && onMissing && modal.seq === seq) { onMissing(); return }
    modal.status.textContent = t('mFail')
  }
  v.oncanplay = () => { modal.status.hidden = true; preloadAhead(seq) }
  v.onloadedmetadata = () => {
    cacheSet('video', hash, urls[i - 1], vcached)
    if (modal.seq === seq) modal.fileUrl = urls[i - 1]
    if (modal.seq === seq && CFG.playerButton) {
      modal.playerBtn.hidden = false
      modal.appDlBtn.hidden = false
      // The phone would decode it on the CPU, slowly: the app converts it.
      modal.appReduceBtn.hidden = !pastDecoder(v.videoWidth, v.videoHeight) && !(modal.link && modal.link.dataset.ibhBigVideo)
      if (!modal.appReduceBtn.hidden) flash(t('bigVideo'))
    }
    if (modal.seq === seq && !modal.sheet.hidden && modal.sheetTab === 'info') renderInfo(modal.link, seq)
    fitFullscreenOrientation()   // swiped onto a wide video while fullscreen
    if (onFound) onFound()
  }
  v.muted = false   // with sound, even if the previous video was muted from the controls
  v.src = urls[i++]
  // The tap that opened the modal is a user gesture, which is what lets the
  // browser play with sound. If its autoplay policy still blocks audio, play
  // muted rather than not at all: the controls' speaker button unmutes.
  const played = v.play()
  if (played && played.catch) {
    played.catch(e => {
      if (e.name !== 'NotAllowedError') return
      dbg('modal: sound blocked by the autoplay policy, playing muted')
      v.muted = true
      v.play().catch(() => {})
    })
  }
}

// Show what the page already has at once, then the better file when it loads.
// Loads candidate URLs at once and keeps the first that loads, dropping the
// rest: a wrong extension (404) then costs nothing, where trying them in
// turn cost ~0.5 s each (measured on rule34: .jpeg came after two misses).
// Stages run in order (samples, then originals), so a big original is not
// fetched beside a sample that exists. A known winner goes alone first.
// Returns a cancel function.
// priority: 'high' for what is on screen now (the modal), the browser's
// default otherwise.
/**
 * @param {string[][]} stages
 * @param {string | null | undefined} cached   cacheGet's: tried first when it is a URL
 * @param {(probe: HTMLImageElement) => void} onWin
 * @param {() => void} onFail
 * @param {'high' | 'low' | 'auto'} [priority]
 * @returns {() => void}   calls the race off
 */
export function raceImage(stages, cached, onWin, onFail, priority) {
  let done = false
  /** @type {HTMLImageElement[]} */
  const probes = []
  /** @param {HTMLImageElement | null} keep */
  const drop = keep => probes.forEach(pr => { if (pr !== keep) { pr.onload = pr.onerror = null; pr.removeAttribute('src') } })
  /** @param {HTMLImageElement} pr */
  const win = pr => { if (done) return; done = true; drop(pr); onWin(pr) }
  /** @param {string} url @param {() => void} onError */
  const probe = (url, onError) => {
    const pr = new Image()
    pr.decoding = 'async'
    if (priority) pr.fetchPriority = priority
    probes.push(pr)
    pr.onload = () => win(pr)
    pr.onerror = onError
    pr.src = url
  }
  /** @param {number} i */
  const runStage = i => {
    if (done) return
    const list = (stages[i] || []).filter(url => url !== cached)
    if (i >= stages.length) { done = true; onFail(); return }
    if (!list.length) { runStage(i + 1); return }
    let failed = 0
    list.forEach(url => probe(url, () => { if (++failed === list.length) runStage(i + 1) }))
  }
  if (typeof cached === 'string') probe(cached, () => runStage(0))
  else runStage(0)
  return () => { done = true; drop(null) }
}

// What the page already found for a post: its 'sample' winner is the
// original itself when the post has no sample (an /images/ URL).
/** @param {string} hash */
export function knownOriginal(hash) {
  const orig = cacheGet('orig', hash)
  if (orig !== undefined) return orig
  const page = cacheGet('sample', hash)
  return typeof page === 'string' && page.includes('/images/') ? page : undefined
}

/** @param {string | null | undefined} url */
const isSampleUrl = url => /\/samples\//.test(url || '')

// candidates: a list of URLs, or stages of them (see raceImage).
/**
 * @param {string} placeholder
 * @param {string[] | string[][]} candidates
 * @param {'gif' | 'orig' | 'sample'} kind
 * @param {string} hash
 */
export function showImage(placeholder, candidates, kind, hash) {
  const stages = /** @type {string[][]} */ (Array.isArray(candidates[0]) ? candidates : [candidates])
  const icached = kind === 'orig' ? knownOriginal(hash) : cacheGet(kind, hash)
  const seq = modal.seq
  modal.video.hidden = true
  modal.vwrap.hidden = true
  fitFullscreenOrientation()   // an image in fullscreen: no landscape lock
  modal.image.hidden = false
  const img = modal.image
  img.onload = fitImage
  img.src = placeholder
  modal.status.hidden = true
  if (icached === null) return   // known: nothing better than the placeholder
  modal.cancelLoad = raceImage(stages, icached, probe => {
    cacheSet(kind, hash, probe.src, icached)
    if (modal.seq !== seq) return   // the user moved on
    modal.fileUrl = probe.src
    modal.isSample = isSampleUrl(probe.src)   // the original comes on zoom (modalOriginal)
    if (modal.isSample) { modal.sampleUrl = probe.src; setQuality('sample') }
    if (!modal.sheet.hidden && modal.sheetTab === 'info') setTimeout(() => renderInfo(modal.link, seq), 50)   // once swapped in
    const decoded = typeof probe.decode === 'function' ? probe.decode().catch(() => {}) : Promise.resolve()
    decoded.then(() => {
      if (modal.seq !== seq) return
      img.src = probe.src
      if (kind === 'gif') watchModalGif(img, probe.src, seq)
      preloadAhead(seq)
    })
  }, () => cacheSet(kind, hash, null), 'high')
}

// Zoomed into a sample: fetch the original and swap it in, the zoom kept
// (same picture, same box, more pixels).
// The quality button: null hides it; 'sample', 'loading' or 'raw'.
/** @param {'sample' | 'loading' | 'raw' | null} state */
export function setQuality(state) {
  const btn = modal && modal.quality
  if (!btn) return
  btn.hidden = !state
  btn.textContent = state === 'raw' ? 'RAW' : state === 'loading' ? 'RAW…' : 'SAMPLE'
  btn.classList.toggle('raw', state === 'raw')
  btn.title = t(state === 'raw' ? 'qualRawTip' : 'qualSampleTip')
}

export function toggleQuality() {
  if (modal.isSample) {
    modal.keepSample = false
    loadModalOriginal()
    return
  }
  if (!modal.sampleUrl) return
  // Back to the sample, and the zoom no longer swaps it on its own.
  modal.keepSample = true
  modal.image.src = modal.sampleUrl
  modal.fileUrl = modal.sampleUrl
  modal.isSample = true
  setQuality('sample')
  dbg('modal: back to the sample')
}

export function loadModalOriginal() {
  if (!modal.isSample || modal.origPending) return
  if (modal.rawUrl) {   // fetched before on this post: swap at once
    modal.image.src = modal.rawUrl
    modal.fileUrl = modal.rawUrl
    modal.isSample = false
    setQuality('raw')
    return
  }
  const link = modal.link
  const pic = link && cardPicture(link)
  const parts = pic && thumbParts(pic.src)
  if (!parts) return
  modal.origPending = true
  const seq = modal.seq
  const cached = knownOriginal(parts.hash)
  if (cached === null) return
  flash(t('origLoading'))
  setQuality('loading')
  raceImage([fileCandidates(pic.src, ORIGINAL_EXTS)], cached, probe => {
    cacheSet('orig', parts.hash, probe.src, cached)
    if (modal.seq !== seq) return
    const decoded = typeof probe.decode === 'function' ? probe.decode().catch(() => {}) : Promise.resolve()
    decoded.then(() => {
      if (modal.seq !== seq) return
      modal.image.src = probe.src
      modal.fileUrl = probe.src
      modal.rawUrl = probe.src
      modal.isSample = false
      modal.origPending = false
      setQuality('raw')
      info(`modal: original loaded (${probe.src.split('/').pop()})`)
    })
  }, () => { cacheSet('orig', parts.hash, null); modal.origPending = false; if (modal.seq === seq) setQuality('sample') }, 'high')
}

// Whether a tap falls on the picture itself, not on the bars object-fit
// leaves around it inside the <img> box.
/** @param {MouseEvent} ev */
export function onImageContent(ev) {
  const img = modal.image
  if (!img.naturalWidth) return true
  const r = img.getBoundingClientRect()
  const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight)
  const w = img.naturalWidth * scale
  const h = img.naturalHeight * scale
  const left = r.left + (r.width - w) / 2
  const top = r.top + (r.height - h) / 2
  return ev.clientX >= left && ev.clientX <= left + w && ev.clientY >= top && ev.clientY <= top + h
}

// A comic (much taller than wide) goes full width and scrolls, vertical drags
// scrolling it; anything else fits whole in the screen. Measured from the
// file's own shape, and again when the screen turns: the old test (taller
// than the screen at full width) cut the top and bottom off an ordinary
// portrait image once the screen was in landscape.
const COMIC_RATIO = 2.2   // height / width

export function fitImage() {
  const img = modal.image
  if (img.hidden || !img.naturalWidth) return
  const ratio = img.naturalHeight / img.naturalWidth
  const stage = modal.stage
  const tall = ratio > COMIC_RATIO && stage.clientWidth * ratio > stage.clientHeight
  stage.classList.toggle('tall', tall)
  applyZoom()   // sets touch-action for the tall/short and zoom state
}

// The modal's GIF can break the same way; the page is already unloaded, so
// just decode it again, twice at most.
/** @param {HTMLImageElement} img @param {string} url @param {number} seq */
function watchModalGif(img, url, seq) {
  let tries = 0
  /** @param {Event} ev */
  const check = ev => {
    if (modal.seq !== seq) { img.removeEventListener('error', check); img.removeEventListener('load', check); return }
    if (ev.type !== 'error' && img.naturalWidth > 0) return
    if (tries >= GIF_RETRIES) { warn('modal: gif still broken after rebuilding'); return }
    tries++
    info(`modal: gif broken, rebuilding (try ${tries})`)
    img.removeAttribute('src')
    setTimeout(() => { if (modal.seq === seq) img.src = url }, 400)
  }
  img.addEventListener('error', check)
  img.addEventListener('load', check)
}

// Some videos carry no video tag and no .webm-thumb, so they look like images.
// While the image shows, check quietly whether the post has an .mp4; if it
// does, turn the modal into the video. No delay on the tap itself.
/** @param {string} src @param {HTMLAnchorElement} link */
export function sniffVideo(src, link) {
  const seq = modal.seq
  const hash = (thumbParts(src) || {}).hash
  const known = cacheGet('video', hash)
  if (known === null) return   // checked before: not a video
  if (typeof known === 'string') {
    info(`modal: post ${postId(link)} is an untagged video (cached)`)
    showVideo(fileCandidates(src, ['mp4', 'webm']), hash)
    return
  }
  const urls = fileCandidates(src, ['mp4']).slice(0, 2)
  if (!urls.length) return
  const v = document.createElement('video')
  v.muted = true
  v.preload = 'metadata'
  let i = 0
  const done = () => { v.onerror = v.onloadedmetadata = null; v.removeAttribute('src'); v.load() }
  v.onerror = () => {
    const network = v.error && v.error.code === 2
    if (i < urls.length) { v.src = urls[i++]; return }
    done()
    if (!network) cacheSet('video', hash, null)
  }
  v.onloadedmetadata = () => {
    cacheSet('video', hash, urls[i - 1])
    done()
    if (modal.seq !== seq || !modal.open) return
    info(`modal: post ${postId(link)} is an untagged video`)
    showVideo(fileCandidates(src, ['mp4', 'webm']), hash)
  }
  v.src = urls[i++]
}

// A card without a link (scanCards falls back to the <img>'s parent) has
// no href: '?' as for a link without an id, not a throw.
/** @param {Element} link */
export const postId = link => (String(/** @type {HTMLAnchorElement} */ (link).href || '').match(/id=(\d+)/) || [])[1] || '?'

// Only the "animated" tag, nothing else to go by: no gif, no video/mp4/webm,
// no .webm-thumb mark from the site. Those may be either kind.
/** @param {HTMLAnchorElement} link */
export function ambiguousAnimated(link) {
  if (link.querySelector('img.webm-thumb')) return false
  const tags = nativeTags(link)
  return /\sanimated\s/i.test(tags) && !NATIVE_REAL_VIDEO.test(tags) && !NATIVE_GIF.test(tags)
}

// Load the video and probe the .gif at the same time; whichever answers
// first wins and the other is cancelled. A post has a single file, so a
// .gif that loads means it is a GIF. Waiting for every video host to say
// "missing" first cost about 3 s per GIF.
/**
 * @param {HTMLAnchorElement} link
 * @param {HTMLImageElement} thumb
 * @param {Picture} pic
 * @param {string} hash
 * @param {() => void} asGif   shows it as a GIF once no video host has it
 */
export function raceVideoAndGif(link, thumb, pic, hash, asGif) {
  const seq = modal.seq
  let settled = false
  const probe = new Image()
  const gifs = cachedFirst(fileCandidates(pic.src, ['gif']), cacheGet('gif', hash))
  let i = 0
  const stopProbe = () => { probe.onload = probe.onerror = null; probe.removeAttribute('src') }
  probe.onerror = () => { if (!settled && i < gifs.length) probe.src = gifs[i++] }
  probe.onload = () => {
    if (settled || modal.seq !== seq) return
    settled = true
    cacheSet('gif', hash, probe.src)
    cacheSet('video', hash, null)
    const v = modal.video
    v.onerror = v.oncanplay = v.onloadedmetadata = null
    v.pause()
    v.removeAttribute('src')
    v.load()   // cancel the video download and free the decoder
    link.dataset.ibhKind = 'gif'
    info(`modal: post ${postId(link)} is a GIF (answered before the video)`)
    showImage(thumb.currentSrc || pic.src, [probe.src], 'gif', hash)
    stopProbe()
  }
  showVideo(fileCandidates(pic.src, ['mp4', 'webm']), hash,
    () => { if (!settled) { settled = true; stopProbe(); asGif() } },
    () => { if (!settled) { settled = true; stopProbe() } })
  if (gifs.length) probe.src = gifs[i++]
}
