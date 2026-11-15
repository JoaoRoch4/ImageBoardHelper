// The small marks on a video card: its duration, ⚠️ past the decoder.
import { CFG } from '../core/config'
import { t } from '../core/i18n'
import { dbg } from '../core/log'
import { mmss } from '../modal/player'
import { postId } from '../modal/media'
import { el } from '../panel/panel'

// ⚠️ in the corner of a card whose video is past the hardware decoder,
// found by its cover (size), its reel's index (size and fps) or a hold that
// played it (fps measured). Kept on the card: the mark also skips the cover.
/**
 * @param {HTMLElement} card
 * @param {string} what   "3840x2160" or "1920x1080 at 120 fps", for the log and the title
 */
export function markPastDecoder(card, what) {
  if (card.dataset.ibhBigVideo === what) return
  card.dataset.ibhBigVideo = what
  dbg(`card: post ${postId(card)} marked past the hardware decoder (${what})`)
  const badge = cardBadge(card, 'ibh-heavy', 'top:3px;right:3px;font-size:11px;line-height:1;filter:drop-shadow(0 0 1px #000)')
  if (!badge) return
  badge.textContent = '⚠️'
  badge.title = `${t('heavyMark')}: ${what}`
}

// A video card's duration, small in its bottom right corner (thumbBadges).
/** @param {HTMLElement} card @param {number} secs */
export function markDuration(card, secs) {
  if (!Number.isFinite(secs) || secs <= 0) return
  const badge = cardBadge(card, 'ibh-dur', 'bottom:3px;right:3px;padding:0 3px;border-radius:3px;' +
    'font:10px/1.4 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.65)')
  if (badge) badge.textContent = mmss(secs)
}

// The card's badge of that class, made once (the observer comes back to the
// same card); null with thumbBadges off. Painted by us: the theme skips it,
// and z-index keeps it over the cover video and the slideshow's canvas.
/** @param {HTMLElement} card @param {string} cls @param {string} css */
function cardBadge(card, cls, css) {
  if (!CFG.thumbBadges) return null
  const had = /** @type {HTMLElement | null} */ (card.querySelector(`.${cls}`))
  if (had) return had
  if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
  const badge = el('span', { class: cls, 'data-ibh-ui': '' })
  badge.style.cssText = `position:absolute;z-index:4;pointer-events:none;${css}`
  card.appendChild(badge)
  return badge
}
