import { CFG } from '../core/config'
import { t } from '../core/i18n'
import { dbg, describeError, info, warn } from '../core/log'
import { flash, modal, setMark } from '../modal/modal'
import { favLookups } from './post'
import { afterFavorite } from '../thumbs/marks'
import { showFav } from '../modal/tags'
import { toggleModalFullscreen } from '../modal/player'
import { postId } from '../modal/media'
import { el } from '../panel/panel'

// The same endpoints the post page calls, so the site's login cookie goes
// along. Answers decoded from the site's own addFav/toggleFav: 3 added,
// 1 already there, 2 not logged in, 4 removed (toggle only). A lit heart
// pressed again removes the favorite, like the site's own heart.
// The site's answer: '3' added, '1' already there, '2' logged out, '4' removed.
/** @param {string} id @param {boolean} remove */
export async function favoritePost(id, remove) {
  const res = await fetch(`/public/addfav.php?id=${encodeURIComponent(id)}${remove ? '&toggle=1' : ''}`, { credentials: 'same-origin' })
  const code = (await res.text()).trim().replace(/"/g, '')   // toggle answers in JSON
  if (code === '3' || code === '1' || code === '4') {
    const fav = code !== '4'
    setMark('f', id, fav)
    favLookups.set(id, Promise.resolve(fav))
    afterFavorite(id, fav)
  }
  return { code, status: res.status }
}

// The new score, or null.
/** @param {string} id */
export async function upvotePost(id) {
  const res = await fetch(`/index.php?page=post&s=vote&id=${encodeURIComponent(id)}&type=up`, { credentials: 'same-origin' })
  const score = parseInt(await res.text(), 10)
  if (!res.ok || !Number.isFinite(score)) return null
  setMark('v', id, true)
  return score
}

export async function modalFavorite() {
  const id = postId(modal.link)
  const remove = modal.fav.classList.contains('on')
  try {
    const { code, status } = await favoritePost(id, remove)
    const res = { status }
    if (code === '3' || code === '1' || code === '4') {
      const fav = code !== '4'
      showFav(fav)
      flash(t(code === '3' ? 'favAdded' : code === '1' ? 'favAlready' : 'favRemoved'))
      // The site's own heart votes up as it favorites; do the same, so a
      // favorite always counts as upvoted (see applyMarks).
      if (code === '3') modalUpvote(true)
    } else {
      flash(code === '2' ? t('favLogin') : `${t('favFail')} (${res.status} ${code.slice(0, 20)})`)
    }
    info(`modal: ${remove ? 'unfavorite' : 'favorite'} post ${id} -> ${code.slice(0, 20)}`)
  } catch (e) {
    flash(t('favFail'))
    warn(`modal: favorite failed — ${describeError(e)}`)
  }
}

// doubleTapCenter 'like' (Instagram): a double tap in the middle pops a
// heart and favorites the post, which upvotes it as the ♥ does. One already
// in the favorites only gets the heart: a double tap never takes it back.
function modalLike() {
  popHeart(modal.box, 110)
  if (modal.fav.classList.contains('on')) { dbg(`modal: double tap, post ${postId(modal.link)} already a favorite`); return }
  modalFavorite()
}

/**
 * The like's ❤️ over `parent` (positioned), `size` px tall at rest (LIKE_CSS).
 * @param {HTMLElement} parent
 * @param {number} size
 */
export function popHeart(parent, size) {
  const heart = el('div', { class: 'ibh-likeheart', 'data-ibh-ui': '', text: '❤️' })   // the site theme leaves it alone
  heart.style.fontSize = `${Math.round(size)}px`
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
  parent.appendChild(heart)
  heart.addEventListener('animationend', () => heart.remove(), { once: true })
  setTimeout(() => heart.remove(), 1500)   // no animation (reduced motion): it still goes
}

// A double tap in the middle of the video, or anywhere on an image or GIF.
export function centerDoubleTap() {
  if (CFG.doubleTapCenter === 'like') { modalLike(); return }
  dbg('modal: double tap in the middle, fullscreen')
  toggleModalFullscreen()
}

// Answers with the new score as plain text, which the post page shows.
// `quiet` (from the heart): no toast of its own, the heart's one stays.
/** @param {boolean | Event} [quiet] */
export async function modalUpvote(quiet) {
  quiet = quiet === true   // as a click handler it gets the event
  const id = postId(modal.link)
  try {
    const res = await fetch(`/index.php?page=post&s=vote&id=${encodeURIComponent(id)}&type=up`, { credentials: 'same-origin' })
    const score = parseInt(await res.text(), 10)
    if (res.ok && Number.isFinite(score)) {
      if (postId(modal.link) === id) {   // still on that post
        modal.score.textContent = String(score)
        modal.up.classList.add('on')
      }
      setMark('v', id, true)
      if (!quiet) flash(t('voted'))
    } else if (!quiet) {
      flash(`${t('voteFail')} (${res.status})`)
    }
    info(`modal: upvote post ${id} -> ${Number.isFinite(score) ? score : res.status}`)
  } catch (e) {
    flash(t('voteFail'))
    warn(`modal: upvote failed — ${describeError(e)}`)
  }
}
