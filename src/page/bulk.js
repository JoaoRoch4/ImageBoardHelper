import { SITE } from '../core/site'
import { CFG } from '../core/config'
import { t } from '../core/i18n'
import { describeError, info, warn } from '../core/log'
import { SITE_LINK, asElement } from '../modal/modal'
import { userId } from '../post/post'
import { wantsLiked } from '../thumbs/marks'
import { favoritePost, upvotePost } from '../post/votes'
import { postId } from '../modal/media'
import { control, el, shadow } from '../panel/panel'

// ── Mass favorite ──
// ♥ next to 🕒 turns a mode on where a tap on a thumbnail favorites and
// upvotes the post on the spot (like the site's own heart does) instead of
// opening it, and marks the thumbnail. Tap ♥ again to leave.
export const HEART_ICON = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'
export let bulkMode = false

export const wantsBulkButton = () => !!CFG.bulkFavButton && SITE === 'rule34.xxx' && !!userId() && !!document.querySelector(SITE_LINK)

/** @param {boolean} on */
export function setBulkMode(on) {
  bulkMode = on
  const heart = control('.bulkfab')
  if (heart) heart.classList.toggle('on', on)
  pageToast(t(on ? 'bulkOn' : 'bulkOff'))
  info(`mass favorite ${on ? 'on' : 'off'}`)
}

let pageToastTimer = 0
/** @param {string} text */
export function pageToast(text) {
  if (!shadow) return
  let toast = control('.pagetoast')
  if (!toast) { toast = el('div', { class: 'pagetoast' }); shadow.appendChild(toast) }
  toast.textContent = text
  toast.style.opacity = '1'
  clearTimeout(pageToastTimer)
  pageToastTimer = setTimeout(() => { toast.style.opacity = '0' }, 2200)
}

// A mark on the thumbnail: ♥ done, … working, ✕ failed.
/**
 * @param {HTMLElement} link
 * @param {string} text
 * @param {string} tone    its background
 * @param {string} [cls]
 */
export function bulkBadge(link, text, tone, cls = 'ibh-bulkbadge') {
  let badge = /** @type {HTMLSpanElement | null} */ (link.querySelector(`.${cls}`))   // made below
  if (!badge) {
    badge = document.createElement('span')
    badge.className = cls
    badge.dataset.ibhUi = '1'   // the site theme leaves it alone
    if (getComputedStyle(link).position === 'static') link.style.position = 'relative'
    link.appendChild(badge)
  }
  badge.textContent = text
  badge.style.background = tone
}

/** @param {HTMLAnchorElement} link @param {string} [via]  for the log */
export async function bulkFavorite(link, via = 'mass favorite') {
  const id = postId(link)
  if (link.dataset.ibhBulk) return   // done or in progress
  link.dataset.ibhBulk = '1'
  bulkBadge(link, '…', 'rgba(15, 20, 23, .85)')
  try {
    const { code } = await favoritePost(id, false)
    if (code === '2') { bulkBadge(link, '✕', '#b42318'); pageToast(t('favLogin')); delete link.dataset.ibhBulk; return }
    if (code !== '3' && code !== '1') throw new Error(`answer ${code.slice(0, 20)}`)
    await upvotePost(id)
    // The corner ❤️ (afterFavorite painted it) says it; without it, the ♥ badge.
    if (wantsLiked()) link.querySelector('.ibh-bulkbadge')?.remove()
    else bulkBadge(link, '♥', '#e5534b')
    info(`${via}: post ${id} ${code === '3' ? 'favorited' : 'was a favorite'}, upvoted`)
  } catch (e) {
    delete link.dataset.ibhBulk
    bulkBadge(link, '✕', '#b42318')
    warn(`${via}: post ${id} failed — ${describeError(e)}`)
  }
}

// Registered before the modal's click handler, so a tap favorites instead.
/** @param {MouseEvent} ev */
export function onBulkClick(ev) {
  if (!bulkMode || ev.button !== 0) return
  // SITE_LINK ends in a: the link.
  const link = /** @type {HTMLAnchorElement | null | undefined} */ (asElement(ev.target)?.closest(SITE_LINK))
  if (!link) return
  ev.preventDefault()
  ev.stopImmediatePropagation()
  bulkFavorite(link)
}
