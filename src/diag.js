import { SITE, VERSION } from './core/site'
import { CFG } from './core/config'
import { LANG } from './core/i18n'
import { dbg, describeError, info, log, warn } from './core/log'
import { touch } from './core/state'
import { fileCandidates } from './urls/hosts'
import { clearUrlCache } from './urls/url-cache'
import { cardPicture, coverQueue, fromMiddle, isGifCard, isVideoCard, knownGifs, markedCards, markedImages, mountCover, playGif, scanCards, stopGif, unmountCover } from './thumbs/covers'
import { originalQueue, originalViewport, pictureOf, scanThumbs, setUpgradeGen, upgradeGen, upgradeToOriginal } from './thumbs/feed'
import { endScrub, previewStop, scrub, setPreviewEl } from './scrub/scrub'
import { reels } from './scrub/reel'
import { dropH264 } from './scrub/h264'
import { farViewport, parked, previewPaused } from './thumbs/memory'
import { modal, siteLinks } from './modal/modal'
import { favLookups, postInfos } from './post/post'
import { dropAhead, suspended } from './modal/open'

// ═══════════════════════════════════════════════════════════
// On-demand diagnostics
// ═══════════════════════════════════════════════════════════

/** Test every candidate URL of the first video card and log the outcome. */
export function probeVideoUrls() {
  // Prefer a card that is on screen, so the result matches what you see.
  const cards = siteLinks().filter(isVideoCard)
  const card = cards.find(c => c.dataset.ibhSeen) || cards[0]
  if (!card) { warn('no video card on screen to test'); return }
  const pic = cardPicture(card)
  if (!pic) { warn('video card has no picture yet'); return }

  const urls = fileCandidates(pic.src, ['mp4', 'webm'])
  info(`thumbnail: ${pic.src}`)
  if (!urls.length) { warn('no URL derivable from that thumbnail'); return }

  urls.forEach(url => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    /** @param {boolean} ok */
    const done = ok => {
      v.src = ''
      log(ok ? 'info' : 'warn', `${ok ? 'OK  ' : 'FAIL'} ${url}`)
    }
    v.addEventListener('loadedmetadata', () => done(true), { once: true })
    v.addEventListener('error', () => done(false), { once: true })
    v.src = url
  })
}

/**
 * Put an upgraded element back to its thumbnail and clear its upgrade state.
 * @param {HTMLImageElement} el
 */
export function resetUpgrade(el) {
  if (el.dataset.ibhOrig === 'done' && el.dataset.ibhThumb) {
    const pic = pictureOf(el)
    if (pic) pic.set(el.dataset.ibhThumb)
  }
  delete el.dataset.ibhOrig
  delete el.dataset.ibhThumb
  if (el.dataset.ibhRaw) {
    delete el.dataset.ibhRaw
    delete el.dataset.ibhPreRaw
    delete el.dataset.ibhRawMarked
    const badge = el.closest('a') && /** @type {HTMLAnchorElement} */ (el.closest('a')).querySelector('.ibh-rawbadge')   // the && just checked it
    if (badge) badge.remove()
  }
}

// Other tabs of the same site running the script hear the Free memory
// button through this channel. Without any @grant there is no storage shared
// between sites, so tabs of another site are out of reach; a hidden tab
// parks its covers and GIFs by itself (see D).
export const tabChannel = 'BroadcastChannel' in window ? new BroadcastChannel('ibh') : null

/**
 * Give back the memory this script holds on the page: decoded GIFs,
 * covers, upgraded images, keyframe reels, the site's Cache Storage. What
 * is on screen comes back at once from the browser's HTTP cache, which no
 * page script can reach; the URL cache and the image host are kept, since
 * they are what brings it back without walking the ladders again (they
 * hold no memory to speak of). Settings (IBH_CFG) and the site login are
 * left alone. `reason`: 'button' (this tab and every other tab of the
 * site), 'tab' (asked by another tab), 'redo' (this tab only, before Redo
 * thumbnails, which restarts the cards itself).
 */
/**
 * @param {'button' | 'tab' | 'redo'} [reason]
 * @returns {Promise<{ covers: number, gifs: number, images: number, caches: number }>}
 */
export async function freeMemory(reason = 'button') {
  // The button frees every tab of this site running the script, not only this one.
  if (reason === 'button' && tabChannel) tabChannel.postMessage({ type: 'free-memory' })
  for (const r of reels.values()) if (r.url) URL.revokeObjectURL(r.url)   // kept keyframe reels
  reels.clear()
  dropH264()
  const n = { covers: 0, gifs: 0, images: 0, caches: 0 }
  // A preview in progress holds one or two videos; the shared one is dropped.
  if (scrub) endScrub()
  previewStop()
  setPreviewEl(null)
  dropAhead()
  favLookups.clear()
  postInfos.clear()
  coverQueue.clear()   // first, or each unmount hands its slot to a queued card
  markedCards('[data-ibh-cover]').forEach(card => { unmountCover(card); n.covers++ })
  // Animated GIFs keep every decoded frame; back to the still. Ones still
  // loading are dropped too.
  markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach(card => { stopGif(card); n.gifs++ })
  // Undo sample/original upgrades, queued and in flight included, and watch
  // again: what is on screen comes back from the HTTP cache, the rest only
  // when it scrolls in.
  setUpgradeGen(upgradeGen + 1)
  originalQueue.length = 0
  markedImages('[data-ibh-orig]').forEach(el => {
    if (el.dataset.ibhOrig === 'failed') return
    if (el.dataset.ibhOrig === 'done') n.images++
    resetUpgrade(el)
    if (farViewport) farViewport.unobserve(el)
    if (originalViewport) originalViewport.observe(el)
  })
  // Lists that would keep removed cards alive (parked ones still on the
  // page stay, so a hidden tab gets its covers back on return).
  parked.splice(0, parked.length, ...parked.filter(c => c.isConnected))
  previewPaused.splice(0, previewPaused.length, ...previewPaused.filter(c => c.isConnected))
  if (!(modal && modal.open)) suspended.length = 0
  // What is on screen comes back now, freshly decoded, nearest the middle
  // first; the rest when it scrolls in. Not before ↻, which restarts every
  // card itself, nor under the modal or in a hidden tab, which bring their
  // cards back when they end. The options decide, as wherever a card comes
  // back (resumePage): a "video" that proved a GIF goes through mountCover,
  // which plays it only with inline GIFs on.
  if (reason !== 'redo' && !document.hidden && !(modal && modal.open)) {
    const seen = [...markedCards('[data-ibh-seen]')].sort((a, b) => fromMiddle(a) - fromMiddle(b))
    for (const card of seen) {
      if (CFG.videoCovers && isVideoCard(card)) mountCover(card)
      else if (CFG.gifInline && isGifCard(card)) playGif(card)   // past the limit it queues
    }
  }
  try {
    if (window.caches) {
      const keys = await caches.keys()
      await Promise.all(keys.map(k => caches.delete(k)))
      n.caches = keys.length
    }
  } catch (e) {
    warn(`could not clear Cache Storage — ${describeError(e)}`)
  }
  info(`freed ${n.covers} covers, ${n.gifs} GIFs, ${n.images} upgraded images${reason === 'tab' ? ' (asked by another tab)' : reason === 'redo' ? ' (before redoing the thumbnails)' : ''}; ` +
    `${n.caches} Cache Storage entries cleared; URL cache and image host kept`)
  touch()
  return n
}

/**
 * Start every thumbnail over, failures included: upgrades go back to the
 * thumbnail and are queued again, covers and GIFs are dropped, and whatever
 * is on screen is processed again right away.
 */
export function redoThumbs() {
  const n = { images: 0, covers: 0, gifs: 0 }
  const misses = clearUrlCache(true)   // the point is retrying what failed
  markedImages('[data-ibh-orig]').forEach(el => {
    resetUpgrade(el)
    // observe() reports elements already on screen at once, so they upgrade now.
    if (originalViewport) originalViewport.observe(el)
    else upgradeToOriginal(el)
    n.images++
  })
  markedCards('[data-ibh-cover]').forEach(card => unmountCover(card))
  coverQueue.clear()
  markedCards('[data-ibh-gif]').forEach(card => { stopGif(card); delete card.dataset.ibhGif })
  // Forget which video cards turned out to be GIFs, so they get a fresh try.
  knownGifs.clear()
  markedCards('[data-ibh-kind]').forEach(card => { delete card.dataset.ibhKind })
  markedCards('[data-ibh-seen]').forEach(card => {
    if (CFG.videoCovers && isVideoCard(card)) { mountCover(card); n.covers++ }
    else if (CFG.gifInline && isGifCard(card)) { playGif(card); n.gifs++ }
  })
  // Pick up thumbnails added since the last scan (autopager, search results).
  scanCards(document)
  scanThumbs(document)
  info(`redo thumbnails: ${n.images} images re-queued, ${n.covers} covers and ${n.gifs} GIFs restarted, ${misses} cached misses dropped`)
  touch()
}

export function logSnapshot() {
  info(`v${VERSION} on ${SITE} · ui=${LANG}`)
  dbg(`userAgent: ${navigator.userAgent}`)
}
