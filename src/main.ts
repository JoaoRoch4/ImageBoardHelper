// ═══════════════════════════════════════════════════════════
// Boot
//
// The modules only set up their own constants and state. Everything else
// that runs while the page loads runs here, in the order the single file
// had: the listeners and the IndexedDB open that sat between its sections
// first, then the boot itself. The imports are every module, in that
// file's order; tools/build.mts checks that nothing is read before it is set.
// ═══════════════════════════════════════════════════════════

import { VERSION } from './core/site'
import { CFG } from './core/config'
import './core/strings'
import './core/i18n'
import { LOG, info, logLine } from './core/log'
import { STATE } from './core/state'
import { clearHostCache, imageBase } from './urls/hosts'
import { clearUrlCache, flushUrlCache, loadUrlCache, urlDb, urlIndexStats, urlStats } from './urls/url-cache'
import './video/limits'
import './thumbs/badges'
import { IMAGE_MAX_INFLIGHT, gifQueue, gifRebuild, gifsLive, imageWaiters, imagesInflight, markedCards, scanCards } from './thumbs/covers'
import { scanThumbs } from './thumbs/feed'
import { installVideoScrub, scrub } from './scrub/scrub'
import './scrub/reel'
import './video/mp4'
import './scrub/h264'
import { installMemorySaver, onNodesRemoved, parked, previewPaused } from './thumbs/memory'
import { asElement, modal } from './modal/modal'
import './post/post'
import { GM_STORE, STORE_KEYS, restoreCfg, setCfg, setMovedIn, storeReady } from './storage/storage'
import './post/download'
import './post/app'
import './lists/later'
import { ensureFavSearch } from './lists/favorites'
import './search/suggest'
import { onBulkClick } from './page/bulk'
import { loadLikedIds, onHeartClick, onHeartTouchEnd, onHeartTouchMove, onHeartTouchStart } from './thumbs/marks'
import { cancelRawHold, onRawClick, onRawContextMenu, onRawTouchMove, onRawTouchStart, rawHold } from './page/raw-hold'
import { onDoubleTapClick } from './page/double-tap'
import { ensureSiteSearch } from './search/site-search'
import { ensureFavPager } from './lists/autopager'
import './modal/tags'
import './post/votes'
import './modal/gestures'
import './modal/player'
import './modal/media'
import { installVideoModal } from './modal/open'
import { freeMemory, logSnapshot, probeVideoUrls, redoThumbs, tabChannel } from './diag'
import { mountPanel, panelHost, panelOpen, setPanelHost, setShadow, togglePanel } from './panel/panel'
import { ensureFeedNav } from './panel/nav'
import { applyFeed } from './page/feed-css'
import { applySiteTheme } from './page/theme'
import { applyAdBlock, installAdBlock } from './page/ads'
import { injectPageCSS } from './page/page-css'

window.addEventListener('pagehide', flushUrlCache)
// Opened now, while the page loads: the first cards are scanned during
// that, and their wait (URLIDX_WAIT_MS) would otherwise pay the ~0.1 s
// an open costs.
if (CFG.urlCache) urlDb()
if (tabChannel) {
  tabChannel.onmessage = ev => {
    const msg = ev.data || {}
    if (msg.type === 'free-memory') {
      freeMemory('tab').then(n => (tabChannel as BroadcastChannel).postMessage({ type: 'freed', n, page: location.pathname }))   // this very channel
    } else if (msg.type === 'freed') {
      const { n } = msg
      info(`another tab (${msg.page}) freed ${n.covers} covers, ${n.gifs} GIFs, ${n.images} upgraded images`)
    }
  }
}

// A tap anywhere outside the open panel closes it (the ◐ button toggles it itself).
window.addEventListener('pointerdown', ev => {
  if (!panelOpen || !panelHost) return
  if (ev.composedPath().includes(panelHost)) return
  togglePanel(false)
}, true)

// One observer on the document finds new thumbnails (autopager, search
// results) and keeps the page-level pieces in place.
installAdBlock()
new MutationObserver(records => {
  applyAdBlock()   // first: the policy must be in the head before the body's scripts
  for (const r of records) {
    for (const node of r.addedNodes) {
      if (node.nodeType !== 1) continue
      scanCards(node)
      scanThumbs(node)
    }
    if (CFG.memorySaver && r.removedNodes.length) onNodesRemoved(r.removedNodes)
  }
  if (panelHost && !panelHost.isConnected) { setPanelHost(null); setShadow(null) }
  if (!panelHost) mountPanel()
  ensureFeedNav()
  injectPageCSS()
  applySiteTheme()
  applyFeed()
  ensureFavSearch()
  ensureFavPager()
  ensureSiteSearch()
}).observe(document, { childList: true, subtree: true })

installMemorySaver()
window.addEventListener('click', onHeartClick, true)  // first: a tap on a card's ❤️ opens nothing
window.addEventListener('touchstart', onHeartTouchStart, { capture: true, passive: true })
window.addEventListener('touchmove', onHeartTouchMove, { capture: true, passive: true })
window.addEventListener('touchend', onHeartTouchEnd, true)
window.addEventListener('touchcancel', onHeartTouchEnd, true)
window.addEventListener('contextmenu', ev => { if (asElement(ev.target)?.closest('.ibh-liked')) ev.preventDefault() }, true)
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { loadLikedIds() }, { once: true })
else loadLikedIds()
window.addEventListener('click', onBulkClick, true)   // before the modal: in mass favorite a tap favorites
window.addEventListener('click', onRawClick, true)    // before the modal: the release of a raw hold
window.addEventListener('touchstart', onRawTouchStart, { capture: true, passive: true })
window.addEventListener('touchmove', onRawTouchMove, { capture: true, passive: true })
window.addEventListener('touchend', () => { if (rawHold && !rawHold.fired) cancelRawHold() }, true)
window.addEventListener('touchcancel', cancelRawHold, true)
window.addEventListener('contextmenu', onRawContextMenu, true)
installVideoScrub()   // before the modal: its click guard must run first
window.addEventListener('click', onDoubleTapClick, true)   // after the guards, before the modal
installVideoModal()
logSnapshot()
if (CFG.originalThumbs) info('original thumbnails on: visible thumbnails load the full file')
if (CFG.nativeFeed) info(`feed on: ${CFG.feedColumns} columns, ${CFG.feedLayout}; site pages show samples`)

storeReady()   // the first run brings the lists over from the storage bridge
restoreCfg()

const boot = () => {
  injectPageCSS()
  mountPanel()
  ensureFeedNav()
  scanCards(document)
  scanThumbs(document)
  imageBase()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true })
} else {
  boot()
}

// What __ibh.help() answers. The console functions return text or data
// instead of printing it: MobiDevTools' REPL shows what a call returns, but
// it never sees the page's console.
const CONSOLE_HELP = [
  `Image Board Helper v${VERSION} · window.__ibh`,
  '  help()                 this list',
  '  tail(n, filter)        the last n log lines (20), only those matching filter (a regular expression)',
  '  log()                  the whole log (250 entries) as objects',
  '  version, cfg, state    the version, the settings, the live state',
  '  set(key, value)        changes a setting, as the panel does',
  '  probe()                tests the candidate URLs of the first video on screen (Test URLs)',
  '  free()                 frees memory and caches (Free memory & cache)',
  '  redo()                 starts every thumbnail over (Redo thumbnails)',
  '  clearHostCache()       resolves the image host again (Clear host)',
  '  urlCache(), clearUrlCache()   the cache of which address worked',
  '  await urlIndex()       its IndexedDB side: entries, misses, the cap',
  '  stored(), moveAgain()  the stored lists; merges the old storage bridge in again',
  '  gifs()                 inline GIFs: download slots, turn queue, card states, what holds them',
].join('\n')

// Console access, useful when the panel is turned off. On the page's own
// window: with GM grants, this script's window is a wrapper around it.
;(typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__ibh = {
  help: () => CONSOLE_HELP,
  // The last n log lines as text; with a filter, only the lines whose
  // message matches it (a regular expression, case-insensitive).
  tail: (n = 20, filter = '') => {
    const re = filter ? new RegExp(filter, 'i') : null
    return LOG.filter(e => !re || re.test(e.msg)).slice(-Math.max(1, n)).map(logLine).join('\n') || '(no matching lines)'
  },
  version: VERSION,
  cfg: CFG,
  state: STATE,
  log: () => LOG,
  probe: probeVideoUrls,
  clearHostCache,
  free: freeMemory,
  urlCache: () => ({ ...urlStats, entries: Object.keys(loadUrlCache()).length }),
  urlIndex: urlIndexStats,
  clearUrlCache,
  redo: redoThumbs,
  // Where the inline GIFs stand, for one stuck on its still: the three
  // download slots and who waits for one, the turn queue, each card's state,
  // and what makes nextGif() wait.
  gifs: () => {
    const cards: Record<string, number> = {}
    markedCards('[data-ibh-gif]').forEach(c => {
      const k = `${c.dataset.ibhGif}${c.dataset.ibhSeen ? ' on screen' : ''}`
      cards[k] = (cards[k] || 0) + 1
    })
    return {
      slots: `${imagesInflight}/${IMAGE_MAX_INFLIGHT}`, slotWaiters: imageWaiters.length,
      live: `${gifsLive()}/${Number(CFG.gifMaxLive) || 3}`, queued: gifQueue.size, cards,
      previewPaused: previewPaused.length, parked: parked.length,
      holding: [document.hidden && 'hidden tab', modal && modal.open && 'modal', scrub && 'finger on a video', gifRebuild && 'a held GIF rebuilding'].filter(Boolean),
    }
  },
  set: setCfg,
  // Size of each stored key (JSON characters) and the move-in state.
  stored: () => (GM_STORE ? Object.fromEntries([...STORE_KEYS.map(k => [k, JSON.stringify(GM_getValue(k, null)).length]), ['movedIn', GM_getValue('movedIn', 0)]]) : null),
  // Merges the storage bridge's lists in once more (a tab on an old
  // version wrote to it after the move): the bridge only, never site data.
  moveAgain: () => {
    if (!GM_STORE) return
    GM_setValue('movedIn', 1)
    setMovedIn(null)
    storeReady()
  },
}
