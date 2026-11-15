import { SITE } from '../core/site'
import { CFG } from '../core/config'
import { SITE_LINK, asElement } from '../modal/modal'
import { userId } from '../post/post'
import { bulkFavorite, bulkMode } from './bulk'
import { popHeart } from '../post/votes'

// Double tap on a thumbnail: favorite and upvote it on the spot, as mass
// favorite does, without the mode. A single tap still opens the post, only
// a moment later: that is how long a second tap is waited for. Registered
// after the scrub's and the raw hold's click guards, before the modal.
const DOUBLE_TAP_MS = 300
/** @type {{ link: HTMLAnchorElement, timer: number } | null} */
let pendingTap = null   // { link, timer }: a first tap waiting for a second
/** @type {HTMLAnchorElement | null} */
let passTap = null      // the single tap going through to whatever opens the post

const wantsDoubleTap = () => !!CFG.doubleTapFav && SITE === 'rule34.xxx' && !!userId()

/** @param {MouseEvent} ev */
export function onDoubleTapClick(ev) {
  if (ev.defaultPrevented || ev.button !== 0 || bulkMode) return
  // SITE_LINK ends in a: the link.
  const link = /** @type {HTMLAnchorElement | null | undefined} */ (asElement(ev.target)?.closest(SITE_LINK))
  if (!link || link === passTap || !wantsDoubleTap()) return
  ev.preventDefault()
  ev.stopImmediatePropagation()
  if (pendingTap && pendingTap.link === link) {
    clearTimeout(pendingTap.timer)
    pendingTap = null
    // doubleTapLike 'heart': the ❤️ on every double tap, a favorite already
    // too (as in the player); 'quiet': only the ♥ badge bulkFavorite puts.
    if (CFG.doubleTapLike === 'heart') popHeart(link, Math.min(110, link.getBoundingClientRect().width * 0.5))
    bulkFavorite(link, 'double tap')
    return
  }
  if (pendingTap) clearTimeout(pendingTap.timer)   // a tap on another thumbnail replaces it
  pendingTap = { link, timer: setTimeout(() => { pendingTap = null; openTapped(link) }, DOUBLE_TAP_MS) }
}

// The single tap, replayed: the modal (or the link itself) takes it from here.
/** @param {HTMLAnchorElement} link */
function openTapped(link) {
  if (!link.isConnected) return
  passTap = link
  try { link.click() } finally { passTap = null }
}
