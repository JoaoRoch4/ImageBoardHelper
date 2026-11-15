import { ITEM, LIST, THUMB } from '../core/site'
import { CFG } from '../core/config'
import { info } from '../core/log'
import { scanThumbs } from '../thumbs/feed'
import { el } from '../panel/panel'
import { ensureFeedNav } from '../panel/nav'

// The site injects .thumb { width/max-height: <thumbnail size> !important }
// from the account's thumbnail setting; max-height has to be lifted too, or
// a tall image overflows its 250px box and covers the next post.
// One-column feed on Gelbooru 0.2 site pages: every thumbnail takes the full
// screen width. Favorites wrap each thumb in an extra span with the Remove
// link. calc(50% - 50vw) is the negative margin that cancels whatever side
// padding the site puts around the centred column (5px on rule34).
// Built from the options and kept in a <style> of its own, so the panel
// switches apply at once instead of on the next load. One column takes the
// full screen width; more columns are either masonry (CSS columns, each
// image whole, order running down each column) or a grid of even square
// tiles (cropped to fill). Automatic fits as many 170px columns as the
// screen holds.
const FEED_COL_MIN = 170

function feedCss() {
  const cols = CFG.feedColumns
  const auto = cols === 'auto'
  const common = `
      ${THUMB} a { display: block !important; position: relative; }
      ${LIST} > br { display: none !important; }
      /* Post page: the image carries width="850" and the video a fixed box. */
      #image, #gelcomVideoPlayer { max-width: 100% !important; height: auto !important; }`
  if (!auto && Number(cols) <= 1) return `
      ${LIST} { display: flex !important; flex-direction: column !important;
        flex-wrap: nowrap !important; align-items: stretch !important; gap: 14px !important; }
      ${ITEM} { display: block !important; width: 100% !important; max-width: none !important;
        height: auto !important; max-height: none !important; }
      ${THUMB} { display: block !important; width: 100vw !important; height: auto !important;
        max-width: none !important; max-height: none !important; min-height: 0 !important;
        margin: 0 calc(50% - 50vw) !important; }
      ${THUMB} img { display: block; width: 100% !important; height: auto !important;
        max-width: none !important; max-height: none !important; }` + common
  const item = `
      ${ITEM} { display: block !important; width: 100% !important; max-width: none !important;
        height: auto !important; max-height: none !important; margin: 0 !important; }
      ${THUMB} { display: block !important; width: 100% !important; height: auto !important;
        max-width: none !important; max-height: none !important; min-height: 0 !important; margin: 0 !important; }`
  if (CFG.feedLayout === 'grid') return `
      ${LIST} { display: grid !important; gap: 6px !important; grid-template-columns: ${auto
      ? `repeat(auto-fill, minmax(${FEED_COL_MIN}px, 1fr))` : `repeat(${Number(cols)}, minmax(0, 1fr))`} !important; }
      ${item}
      ${THUMB} img { display: block; width: 100% !important; height: auto !important;
        aspect-ratio: 1 / 1; object-fit: cover; max-width: none !important; max-height: none !important; }` + common
  return `
      ${LIST} { display: block !important; column-gap: 6px !important;
        ${auto ? `column-width: ${FEED_COL_MIN}px` : `column-count: ${Number(cols)}`} !important; }
      ${item}
      ${ITEM} { break-inside: avoid !important; margin-bottom: 6px !important; }
      ${THUMB} img { display: block; width: 100% !important; height: auto !important;
        max-width: none !important; max-height: none !important; }` + common
}

/** @type {string | null} */
let feedCssShown = null

// Keeps the feed's <style> in step with the options, putting it back if it
// goes missing. Unchanged CSS is not rewritten (this runs on every DOM
// change).
export function applyFeed() {
  const css = CFG.nativeFeed ? feedCss() : ''
  let style = document.querySelector('style[data-ibh-feed]')
  if (style && css === feedCssShown) return
  if (!style) {
    style = el('style', { 'data-ibh-feed': '1' })
    ;(document.head || document.documentElement).appendChild(style)
  }
  style.textContent = css
  feedCssShown = css
}

// The panel switch: the layout changes under the reader, so keep the post
// at the top of the screen in place, and start the sharp images the feed
// shows (scanThumbs skips what it already watches).
export function switchFeed() {
  const anchor = [...document.querySelectorAll(THUMB)]
    .find(el => el.getBoundingClientRect().bottom > 0)
  applyFeed()
  if (anchor) anchor.scrollIntoView({ block: 'start' })
  if (CFG.nativeFeed) scanThumbs(document)
  ensureFeedNav()
  info(`feed ${CFG.nativeFeed ? `on: ${CFG.feedColumns} columns, ${CFG.feedLayout}` : 'off'} (switched from the panel)`)
}
