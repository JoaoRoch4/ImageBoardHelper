// Opening, closing and stepping the modal; the next post loaded ahead.
import { CFG } from '../core/config'
import { t } from '../core/i18n'
import { dbg, info } from '../core/log'
import { fileCandidates, thumbParts } from '../urls/hosts'
import { cacheGet, cacheSet, cachedFirst } from '../urls/url-cache'
import { cardPicture, coverQueue, giveImageSlot, isGifCard, isVideoCard, markedCards, markedImages, mountCover, playGif, stopGif, takeImageSlot, unmountCover } from '../thumbs/covers'
import { ORIGINAL_EXTS, originalQueue, originalViewport, sampleCandidates, thumbKind } from '../thumbs/feed'
import { farViewport, pinHeight } from '../thumbs/memory'
import { SITE_LINK, asElement, buildModal, modal, siteLinks } from './modal'
import { lookUpFavorite, onOwnFavorites } from '../post/post'
import { refreshDlButton } from '../post/download'
import { refreshLaterButton } from '../lists/later'
import { favPagerNext } from '../lists/autopager'
import { applyMarks, closeMenu, onSiteVoteClick, renderSheet } from './tags'
import { resetZoom } from './gestures'
import { onFullscreenChange, onOrientationChange, resetMedia } from './player'
import { ambiguousAnimated, fitImage, knownOriginal, postId, raceImage, raceVideoAndGif, showImage, showVideo, sniffVideo } from './media'
import { resetUpgrade } from '../diag'

export function openModal(link: HTMLAnchorElement) {
  const thumb = link.querySelector('img')
  const pic = thumb && cardPicture(link)
  if (!pic || !thumbParts(pic.src)) { location.href = link.href; return }   // nothing derivable: go to the post
  if (!modal) buildModal()
  resetMedia()
  const seq = modal.seq
  if (!modal.open) modal.dir = 1
  // The preloaded file, already decoded, shows at once instead of the thumbnail.
  const ready = aheadReady(link)

  modal.link = link
  modal.post.href = link.href
  modal.box.classList.remove('later-mode')
  applyMarks(link, seq)
  modal.tabComments.textContent = t('tabComments')   // its count is per post
  if (!modal.sheet.hidden) renderSheet(link, seq)   // the menu follows the post
  modal.score.textContent = ''
  const list = modalLinks()
  modal.count.textContent = `${list.indexOf(link) + 1} / ${list.length}`
  modal.status.textContent = t('mLoading')
  modal.status.hidden = false

  let kind = thumbKind(thumb)
  const hash = (thumbParts(pic.src) as { hash: string }).hash   // checked on the way in
  const placeholder = ready || thumb.currentSrc || pic.src
  const asGif = () => {
    link.dataset.ibhKind = 'gif'   // the page's cover/GIF code agrees from now on
    info(`modal: post ${postId(link)} has no video file, showing it as a GIF`)
    showImage(placeholder, fileCandidates(pic.src, ['gif']), 'gif', hash)
  }
  // Known from an earlier try: no video file for it.
  if (kind === 'video' && cacheGet('video', hash) === null) kind = 'gif'
  if (kind === 'video' && ambiguousAnimated(link)) {
    raceVideoAndGif(link, thumb, pic, hash, asGif)
  } else if (kind === 'video') {
    showVideo(fileCandidates(pic.src, ['mp4', 'webm']), hash, asGif)
  } else if (kind === 'gif') {
    showImage(placeholder, fileCandidates(pic.src, ['gif']), 'gif', hash)
  } else {
    // The sample first (a few hundred KB, sharp at screen size), or the
    // original straight away; a post without a sample gets its original.
    if (CFG.modalOriginal === 'always') showImage(placeholder, fileCandidates(pic.src, ORIGINAL_EXTS), 'orig', hash)
    else showImage(placeholder, [sampleCandidates(pic.src), fileCandidates(pic.src, ORIGINAL_EXTS)], 'sample', hash)
    sniffVideo(pic.src, link)
  }
  refreshLaterButton(link, seq)
  refreshDlButton()
  // Only now: the preloaded image stays referenced until the modal shows it.
  dropAhead()
  // A post that never finishes loading must not hold the next one back.
  setTimeout(() => preloadAhead(seq), AHEAD_FALLBACK_MS)

  openShell()
  info(`modal: ${kind} post ${postId(link)}`)
}

// Shows the modal over the page (a post, or the Watch later list).
export function openShell() {
  if (modal.open) return
  modal.open = true
  suspendPage()
  if (!modal.host.isConnected) document.documentElement.appendChild(modal.host)
  modal.host.style.display = ''
  document.documentElement.style.setProperty('overflow', 'hidden', 'important')
  // An entry for the back button to close the modal instead of the page.
  // Leaving it, the browser would put back the scroll it saved for the
  // page, undoing the scroll that followed the modal: we place it ourselves.
  modal.scrollMode = history.scrollRestoration
  history.scrollRestoration = 'manual'
  history.pushState({ ibhModal: true }, '')
}

// The posts the modal steps through: the page's, or the Watch later list's.
const modalLinks = () => (modal && modal.listLinks) || siteLinks()

/** @param fromBack   the back button closed it: its history entry is gone already */
export function closeModal(fromBack: boolean) {
  if (!modal || !modal.open) return
  if (modal.root.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {})
  modal.open = false
  modal.turned = null   // its fullscreenchange comes after open is false
  modal.turn.classList.remove('on')
  closeMenu()
  modal.listLinks = null
  modal.box.classList.remove('later-mode')
  if (modal.laterIO) { modal.laterIO.disconnect(); modal.laterIO = null }
  modal.laterGrid.replaceChildren()   // its decoded pictures go with it
  dropAhead()
  resetMedia()
  modal.host.style.display = 'none'
  document.documentElement.style.removeProperty('overflow')
  // Leave the page on the post last shown, once the history step is over
  // (the back runs after this function), then bring back what is on screen.
  const link = modal.link
  let landed = false
  const land = () => {
    if (landed) return
    landed = true
    if (link && link.isConnected) link.scrollIntoView({ block: 'center' })
    history.scrollRestoration = modal.scrollMode || 'auto'
    resumePage()
  }
  if (!fromBack && history.state && history.state.ibhModal) {
    window.addEventListener('popstate', () => setTimeout(land, 0), { once: true })
    setTimeout(land, 1000)   // should the popstate never come, the page still comes back
    history.back()
  } else {
    setTimeout(land, 0)
  }
}

// While the modal is open the page underneath is invisible, so it gives its
// memory to the modal: covers closed, GIFs stilled, upgraded images back to
// the thumbnail (heights held so the layout does not move), pending
// upgrades dropped. resumePage() brings back what is on screen on close.
export const suspended: HTMLElement[] = []

function suspendPage() {
  const n = { covers: 0, gifs: 0, images: 0 }
  coverQueue.clear()   // first, or each unmount hands its slot to a queued card
  markedCards('[data-ibh-cover]').forEach(card => { unmountCover(card); n.covers++ })
  markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach(card => { stopGif(card); n.gifs++ })
  originalQueue.length = 0
  markedImages('[data-ibh-orig]').forEach(el => {
    const state = el.dataset.ibhOrig
    if (state === 'failed') return
    if (state === 'done') { pinHeight(el); resetUpgrade(el); n.images++ }
    else delete el.dataset.ibhOrig   // queued: start over later
    if (farViewport) farViewport.unobserve(el)
    if (originalViewport) originalViewport.unobserve(el)   // or it would upgrade again under the modal
    suspended.push(el)
  })
  dbg(`modal: page unloaded (${n.covers} covers, ${n.gifs} GIFs, ${n.images} images)`)
}

function resumePage() {
  // observe() reports what is already on screen at once, so that upgrades now.
  for (const el of suspended.splice(0)) if (el.isConnected && originalViewport) originalViewport.observe(el)
  markedCards('[data-ibh-seen]').forEach(card => {
    if (CFG.videoCovers && isVideoCard(card)) mountCover(card)
    else if (CFG.gifInline && isGifCard(card)) playGif(card)
  })
}

/** @param dir   1 the next post, -1 the previous */
export function stepModal(dir: number) {
  const list = modalLinks()
  const target = list[list.indexOf(modal.link) + dir]
  if (!target) return
  if (!modal.listLinks && dir > 0 && list.indexOf(target) >= list.length - 3) favPagerNext()   // see the autopager
  modal.dir = dir   // the preload follows the direction of travel
  openModal(target)
  // The page follows underneath, so far down the list it is already there
  // on close, with the site's paginator in reach. Nothing loads meanwhile:
  // the observers hold off while the modal is open.
  target.scrollIntoView({ block: 'center' })
}

// ── Next post ready ──
// Once the post on screen has loaded, fetch the next one in the direction
// of travel: an image or GIF downloaded and decoded (held, so the swipe
// paints it at once), a video's host found and its header read (the swipe
// then skips the host walk; the decoder is handed back right away). One
// post ahead only, dropped as soon as the modal moves on or closes.
const AHEAD_FALLBACK_MS = 4000
// The post ahead: an image's winning probe (img, decoded once decoded), or
// a video's metadata probe; release gives the download slot back, cancel
// calls the race off.
export type Ahead = { link: HTMLAnchorElement, img?: HTMLImageElement, decoded?: boolean, video?: HTMLVideoElement, release?: () => void, cancel?: () => void }
let ahead: Ahead | null = null

export function preloadAhead(seq: number) {
  if (!CFG.modalPreload || !modal.open || modal.seq !== seq) return
  const list = modalLinks()
  const link = list[list.indexOf(modal.link) + (modal.dir || 1)]
  if (!link || (ahead && ahead.link === link)) return
  dropAhead()
  const thumb = link.querySelector('img')
  const pic = thumb && cardPicture(link)
  const parts = pic && thumbParts(pic.src)
  if (!parts) return
  const a: Ahead = ahead = { link }
  if (!onOwnFavorites()) lookUpFavorite(postId(link))   // its heart is right on the swipe
  let kind = thumbKind(thumb)
  if (kind === 'video' && cacheGet('video', parts.hash) === null) kind = 'gif'
  if (kind === 'video') aheadVideo(a, pic.src, parts.hash)
  else aheadImage(a, pic.src, parts.hash, kind === 'gif' ? 'gif' : 'orig')
  dbg(`modal: preloading ${kind} post ${postId(link)}`)
}

function aheadImage(a: Ahead, src: string, hash: string, kind: 'gif' | 'orig' | 'sample') {
  const sampleFirst = kind === 'orig' && CFG.modalOriginal !== 'always'
  if (sampleFirst) kind = 'sample'
  const cached = kind === 'orig' ? knownOriginal(hash) : cacheGet(kind, hash)
  if (cached === null) return   // known: nothing loads
  const stages = kind === 'gif' ? [fileCandidates(src, ['gif'])]
    : sampleFirst ? [sampleCandidates(src), fileCandidates(src, ORIGINAL_EXTS)] : [fileCandidates(src, ORIGINAL_EXTS)]
  // Same three download slots as the page (B).
  takeImageSlot(() => {
    if (ahead !== a) { giveImageSlot(); return }   // the modal moved on while it waited
    let held = true
    a.release = () => { if (held) { held = false; giveImageSlot() } }
    // release: set just above.
    a.cancel = raceImage(stages, cached, img => {
      (a.release as () => void)()
      a.img = img
      cacheSet(kind, hash, img.src, cached)
      const decoded = typeof img.decode === 'function' ? img.decode().catch(() => {}) : Promise.resolve()
      decoded.then(() => { if (ahead === a) a.decoded = true })
    }, () => {
      (a.release as () => void)()
      cacheSet(kind, hash, null)
    })
  })
}

function aheadVideo(a: Ahead, src: string, hash: string) {
  const cached = cacheGet('video', hash)
  const urls = cachedFirst(fileCandidates(src, ['mp4', 'webm']), cached)
  if (!urls.length) return
  const v = a.video = document.createElement('video')
  v.muted = true
  v.preload = 'metadata'
  let i = 0
  const stop = () => { v.onerror = v.onloadedmetadata = null; v.removeAttribute('src'); v.load() }
  v.onerror = () => {
    if (i < urls.length) { v.src = urls[i++]; return }
    // No host has it: the swipe goes straight to the GIF. A decode error or a
    // network drop says nothing about the file.
    if (!(v.error && (v.error.code === 3 || v.error.code === 2))) cacheSet('video', hash, null)
    stop()
  }
  v.onloadedmetadata = () => { cacheSet('video', hash, urls[i - 1], cached); stop() }
  v.src = urls[i++]
}

// The preloaded image for this post, if it is downloaded and decoded.
// img: set before decoded.
function aheadReady(link: HTMLAnchorElement) {
  return ahead && ahead.link === link && ahead.decoded && (ahead.img as HTMLImageElement).naturalWidth ? (ahead.img as HTMLImageElement).src : null
}

export function dropAhead() {
  if (!ahead) return
  const a = ahead
  ahead = null
  if (a.cancel) a.cancel()
  if (a.img) { a.img.onload = a.img.onerror = null; a.img.removeAttribute('src') }
  if (a.video) { a.video.onerror = a.video.onloadedmetadata = null; a.video.removeAttribute('src'); a.video.load() }
  if (a.release) a.release()
}

// Capture on window: runs before the link's own onclick (favorites navigate
// from an inline handler).
function onSiteLinkClick(ev: MouseEvent) {
  if (ev.defaultPrevented || ev.button !== 0) return
  // SITE_LINK ends in a: the link.
  const link = asElement(ev.target)?.closest(SITE_LINK) as HTMLAnchorElement | null | undefined
  if (!link) return
  ev.preventDefault()
  ev.stopPropagation()
  openModal(link)
}

export function installVideoModal() {
  if (!CFG.videoModal) return
  window.addEventListener('click', onSiteLinkClick, true)
  window.addEventListener('click', onSiteVoteClick, true)
  // The screen turned (↻, a wide video, the phone itself): fit the image again.
  window.addEventListener('resize', () => { if (modal && modal.open) { resetZoom(); fitImage() } })
  window.addEventListener('popstate', () => { if (modal && modal.open) closeModal(true) })
  document.addEventListener('fullscreenchange', onFullscreenChange)
  if (screen.orientation) screen.orientation.addEventListener('change', onOrientationChange)
  info('post modal active: thumbnails on site pages open in place')
}
