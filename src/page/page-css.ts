import { LINE, LIST, THUMB } from '../core/site'
import { CFG } from '../core/config'
import { SCRUB_CSS } from '../scrub/scrub'
import { LIKE_CSS } from '../modal/modal'
import { el } from '../panel/panel'
import { THEME_CSS } from './theme'
import { ADS_CSS } from './ads'

// The site's own video frame, repeated so it also applies on pages whose
// stylesheet lacks it (favorites), where the mark is added back.
const NATIVE_MARK_CSS = `${LIST} img.webm-thumb { border: 3px solid rgb(0, 0, 255); box-sizing: border-box; }`

const FAVSEARCH_CSS = `
    .ibh-search { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0 12px; position: relative; }
    .ibh-suggest { position: absolute; z-index: 30; margin: 0 !important; padding: 4px 0 !important; list-style: none;
      max-height: 50vh; overflow-y: auto; overscroll-behavior: contain; user-select: none; -webkit-touch-callout: none;
      background: #1f2b30 !important; border: 1px solid ${LINE} !important;
      border-radius: 8px; box-shadow: 0 8px 18px rgba(0, 0, 0, .5); }
    .ibh-suggest[hidden] { display: none; }
    .ibh-suggest li { display: flex !important; justify-content: space-between; gap: 12px; padding: 9px 12px !important;
      font-size: 15px; color: #e6eef0 !important; background: transparent !important; }
    .ibh-suggest li small { opacity: .65; font-size: 12px; color: inherit !important; }
    .ibh-suggest li span { color: inherit !important; }
    .ibh-suggest li.k-artist { color: #f2ac08 !important; }
    .ibh-suggest li.k-character { color: #3fb950 !important; }
    .ibh-suggest li.k-copyright { color: #c678dd !important; }
    .ibh-search input[type="search"] { flex: 1 1 100%; min-width: 0; padding: 9px 10px; font-size: 15px; box-sizing: border-box; }
    .ibh-search input.min { width: 96px; padding: 7px 8px; font-size: 14px; box-sizing: border-box; }
    .ibh-search select, .ibh-search button { padding: 7px 12px; font-size: 14px; }
    .ibh-search .st { flex: 1 1 100%; font-size: 12px; opacity: .85; }
    .ibh-search select.saved { flex: 1 1 100%; }
    .ibh-search select.saved[hidden] { display: none; }
    #ibh-favmore { display: block; margin: 14px auto; padding: 9px 18px; font-size: 14px; }
    #ibh-favmore[hidden] { display: none; }
    #ibh-pager { min-height: 1px; padding: 14px 0; text-align: center; font-size: 13px; opacity: .85; }
    .ibh-bulkbadge, .ibh-rawbadge { position: absolute; top: 6px; right: 6px; z-index: 3; min-width: 26px; height: 26px; padding: 0 6px;
      border-radius: 13px; color: #fff; font: 600 15px/26px system-ui, sans-serif; text-align: center; pointer-events: none;
      box-shadow: 0 2px 8px rgba(0,0,0,.5); }
    .ibh-rawbadge { right: auto; left: 6px; font-size: 12px; }
    ${LIST} a img { -webkit-touch-callout: none; }
  `

// Two quick taps on a thumbnail are a double tap for the script, never the
// browser's double-tap zoom (video cards set their own touch-action).
const TAP_CSS = `${THUMB} a:not([data-ibh-video]) { touch-action: manipulation; }`

// The site's title, centred: on the left it sat under the « » page buttons
// in the top-left corner (two IDs outrank the site's own #site-title rule).
const HEADER_CSS = '#header #site-title { text-align: center; padding-left: 0; }'

// The card marks: ❤️ top right (big enough to hold), the resolution top
// left; a favorite's other top-right badges step aside for the heart.
const CARD_MARKS_CSS = `
    .ibh-liked { position: absolute; top: 1px; right: 1px; z-index: 5; padding: 3px; font-size: 16px; line-height: 1;
      filter: drop-shadow(0 0 2px rgba(0, 0, 0, .8)); cursor: pointer; user-select: none; -webkit-user-select: none;
      -webkit-touch-callout: none; }
    .ibh-res { position: absolute; top: 3px; left: 3px; z-index: 4; pointer-events: none; padding: 0 3px; border-radius: 3px;
      font: 10px/1.4 ui-monospace, monospace; color: #fff; background: rgba(0, 0, 0, .65); }
    [data-ibh-liked] .ibh-heavy { right: 26px !important; }
    [data-ibh-liked] .ibh-bulkbadge, [data-ibh-liked] .ibh-rawbadge { right: 30px !important; }`

export function injectPageCSS() {
  if (document.querySelector('style[data-ibh]')) return
  const style = el('style', { 'data-ibh': '1' })
  style.textContent = NATIVE_MARK_CSS + THEME_CSS + FAVSEARCH_CSS + TAP_CSS + HEADER_CSS + LIKE_CSS + CARD_MARKS_CSS +
    (CFG.videoScrub ? SCRUB_CSS : '') + (CFG.blockAds ? ADS_CSS : '')
  ;(document.head || document.documentElement).appendChild(style)
}
