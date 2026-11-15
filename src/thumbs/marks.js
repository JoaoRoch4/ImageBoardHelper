// The marks on a post's card: ❤️ on a favorite (hold it to unfavorite) and
// the resolution, from rule34's API with the user's key; that API's gate
// (r34Api) and its panel section.
import { SITE } from '../core/site'
import { CFG, readJSON, writeJSON } from '../core/config'
import { t } from '../core/i18n'
import { dbg, describeError, info, warn } from '../core/log'
import { nativeTags } from './covers'
import { SITE_LINK, asElement, hasMark, siteLinks } from '../modal/modal'
import { onOwnFavorites, userId } from '../post/post'
import { GM_STORE } from '../storage/storage'
import { GM_XHR } from '../post/download'
import { favIndex, favScan, favsGet, favsSet, loadFavIndex, setFavEntries } from '../lists/favorites'
import { pageToast } from '../page/bulk'
import { favoritePost } from '../post/votes'
import { postId } from '../modal/media'
import { el, rebuildPanel, toggle } from '../panel/panel'

// ── Card marks: ❤️ on favorites, the resolution ──
// likedBadge: a ❤️ in a favorite's top right, known from the favorites
// index (read once a page, only its ids kept), the posts favorited here
// (marks) and the user's own favorites page; holding it unfavorites the
// post. favAutoIndex: a like or unlike made here goes into the index too,
// so it stays right between reads. resBadge: the resolution in the top
// left, from rule34's API with the user's key (GM storage only, like the
// app's token), a video's cover or an opened post's page; remembered per
// post, since a post's size never changes.
const UNLIKE_HOLD_MS = 500
/** @type {Set<string> | null} */
let likedIds = null                   // the favorites index's ids
const unliked = new Set()             // unfavorited on this page (the favorites page still lists them)
/** @type {Promise<void>} */
let favIndexWrites = Promise.resolve()   // one index edit at a time: each reads, changes and writes it whole

export const wantsLiked = () => !!CFG.likedBadge && SITE === 'rule34.xxx' && !!userId()
/** @param {string} id */
const isLiked = id => !unliked.has(id) && (hasMark('f', id) || !!likedIds?.has(id) || onOwnFavorites())
/** @param {string} id @returns {HTMLAnchorElement[]} */
const cardsOf = id => siteLinks().filter(a => postId(a) === id)

/** @param {HTMLElement} link */
export function paintCardMarks(link) {
  paintLiked(link)
  paintRes(link)
  wantDims(link)
}

export function repaintCards() {
  for (const link of siteLinks()) paintCardMarks(link)
}

/** @param {HTMLElement} link */
function paintLiked(link) {
  const id = postId(link)
  const on = wantsLiked() && id !== '?' && isLiked(id)
  const had = link.querySelector('.ibh-liked')
  if (!on) {
    had?.remove()
    delete link.dataset.ibhLiked
    return
  }
  link.dataset.ibhLiked = '1'   // moves the other top-right badges aside (CARD_MARKS_CSS)
  if (had) return
  if (getComputedStyle(link).position === 'static') link.style.position = 'relative'
  link.appendChild(el('span', { class: 'ibh-liked', 'data-ibh-ui': '', role: 'button', title: t('heartHint'), text: '❤️' }))
}

// The index's ids, once the page has the user's id (its links) to match it to.
export async function loadLikedIds() {
  if (!wantsLiked() || likedIds) return
  const idx = favIndex && favIndex.user === userId() ? favIndex : await favsGet()
  if (!idx || idx.user !== userId()) return
  likedIds = new Set(idx.items.map(item => item[0]))
  let shown = 0
  for (const link of siteLinks()) {
    paintLiked(link)
    if (link.dataset.ibhLiked) shown++
  }
  info(`liked: ${likedIds.size} favorites in the index, ${shown} of them on this page`)
}

// favoritePost answered: the card's ❤️, and the index (favAutoIndex).
/** @param {string} id @param {boolean} fav */
export function afterFavorite(id, fav) {
  if (fav) unliked.delete(id)
  else unliked.add(id)
  if (likedIds) fav ? likedIds.add(id) : likedIds.delete(id)
  const links = cardsOf(id)
  for (const link of links) {
    paintLiked(link)
    if (!fav) delete link.dataset.ibhBulk   // a double tap can favorite it again
  }
  if (CFG.favAutoIndex && SITE === 'rule34.xxx' && userId()) {
    favIndexWrites = favIndexWrites.then(() => indexFavorite(id, fav, links[0])).catch(e => warn(`favorites: index not updated — ${describeError(e)}`))
  }
}

/**
 * @param {string} id
 * @param {boolean} fav
 * @param {HTMLAnchorElement | undefined} link   the card, for the index's thumbnail and tags
 */
async function indexFavorite(id, fav, link) {
  // A read in progress picks the change up itself, or would add it twice.
  if (favScan) { dbg(`favorites: index being read, post ${id} left to it`); return }
  const idx = await loadFavIndex()
  // Never read: the first read builds it whole, and one item in it now
  // would stop that read at its first page (it reads until a known one).
  if (!idx.items.length && idx.next === undefined) return
  const at = idx.items.findIndex(item => item[0] === id)
  if (fav === at >= 0) return
  if (fav) {
    const img = link && link.querySelector('img')
    idx.items.unshift([id, (img && img.getAttribute('src')) || '', link ? nativeTags(link) : '', null])   // newest first, as the pages
  } else {
    idx.items.splice(at, 1)
  }
  setFavEntries(null)   // a search sees it
  await favsSet(idx)
  info(`favorites: post ${id} ${fav ? 'added to' : 'taken out of'} the index (${idx.items.length})`)
}

// Holding the ❤️: unfavorite. toggle=1 flips, so a post the index wrongly
// thought a favorite comes back as added ('3'): flipped once more, it goes.
/** @param {HTMLAnchorElement} link */
async function unlikeFromCard(link) {
  const id = postId(link)
  try {
    let { code } = await favoritePost(id, true)
    if (code === '3') ({ code } = await favoritePost(id, true))
    if (code !== '4') {
      pageToast(`${t('unlikeFail')} (${code.slice(0, 20)})`)
      warn(`liked: post ${id} not unfavorited — answer ${code.slice(0, 20)}`)
      return
    }
    pageToast(t('favRemoved'))
    info(`liked: post ${id} unfavorited from its ❤️`)
  } catch (e) {
    pageToast(t('unlikeFail'))
    warn(`liked: post ${id} not unfavorited — ${describeError(e)}`)
  }
}

// The ❤️'s hold, on touch events like the raw hold (Firefox for Android
// cancels the pointer during a long press). Its taps go nowhere: the
// click handler runs before every other one on the cards.
/** @type {{ link: HTMLAnchorElement, x: number, y: number, fired: boolean, timer: number } | null} */
let heartHold = null

/** @param {TouchEvent} ev */
export function onHeartTouchStart(ev) {
  const badge = asElement(ev.target)?.closest('.ibh-liked')
  const link = /** @type {HTMLAnchorElement | null | undefined} */ (badge && badge.closest(SITE_LINK))   // SITE_LINK ends in a
  if (!link || ev.touches.length !== 1) return
  const finger = ev.touches[0]
  const hold = { link, x: finger.clientX, y: finger.clientY, fired: false, timer: 0 }
  hold.timer = setTimeout(() => {
    hold.fired = true
    if (navigator.vibrate) navigator.vibrate(15)
    unlikeFromCard(link)
  }, UNLIKE_HOLD_MS)
  heartHold = hold
}

/** @param {TouchEvent} ev */
export function onHeartTouchMove(ev) {
  const finger = ev.touches[0]
  if (heartHold && !heartHold.fired && finger && Math.hypot(finger.clientX - heartHold.x, finger.clientY - heartHold.y) > 12) {
    clearTimeout(heartHold.timer)
    heartHold = null
  }
}

export function onHeartTouchEnd() {
  if (heartHold && !heartHold.fired) clearTimeout(heartHold.timer)
}

/** @param {MouseEvent} ev */
export function onHeartClick(ev) {
  if (!asElement(ev.target)?.closest('.ibh-liked')) return
  ev.preventDefault()
  ev.stopImmediatePropagation()
  if (!heartHold || !heartHold.fired) pageToast(t('heartHint'))   // a tap: how it works
  heartHold = null
}

// ── The resolution (resBadge) ──
const DIMS_KEY = `IBH_DIMS_${SITE}`   // { id: "WxH" }, newest last
const DIMS_MAX = 8000
const DIMS_INFLIGHT = 2               // API requests at once
// rule34's API (api.rule34.xxx) answers only with the user's key; every
// call to it goes through r34Api, which makes none without one. The file
// hosts (api-cdn*.rule34.xxx) are another thing: they serve images and
// videos to anyone, key or not.
const RULE34_API = 'https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1'
/** @type {Map<string, string> | null} */
let dims = null
let dimsSaveTimer = 0
/** @type {string[]} */
const dimsQueue = []                  // post ids to ask the API for, in page order
const dimsAsked = new Set()           // asked on this page
let dimsLive = 0

/** @returns {Map<string, string>} */
function loadDims() {
  if (!dims) dims = new Map(Object.entries(readJSON(DIMS_KEY, {})))
  return dims
}

/**
 * @param {string} id
 * @param {number} w
 * @param {number} h
 */
export function setDims(id, w, h) {
  if (id === '?' || !(w > 0 && h > 0)) return
  const map = loadDims()
  const size = `${w}x${h}`
  if (map.get(id) === size) return
  map.delete(id)
  map.set(id, size)
  while (map.size > DIMS_MAX) map.delete(/** @type {string} */ (map.keys().next().value))   // not empty
  clearTimeout(dimsSaveTimer)
  dimsSaveTimer = setTimeout(() => writeJSON(DIMS_KEY, Object.fromEntries(loadDims())), 2000)   // one write for a burst
  for (const link of cardsOf(id)) paintRes(link)
}

/** @param {HTMLElement} link */
function paintRes(link) {
  const size = CFG.resBadge ? loadDims().get(postId(link)) : undefined
  let badge = /** @type {HTMLElement | null} */ (link.querySelector('.ibh-res'))
  if (!size) { badge?.remove(); return }
  if (!badge) {
    badge = el('span', { class: 'ibh-res', 'data-ibh-ui': '' })
    if (getComputedStyle(link).position === 'static') link.style.position = 'relative'
    link.appendChild(badge)
  }
  badge.textContent = size.replace('x', '×')
}

// The user's key, as rule34 shows it ("&api_key=…&user_id=…"), kept in GM
// storage only: the site's own storage is read by the site's scripts.
const apiKey = () => (GM_STORE ? String(GM_getValue('r34ApiKey', '') || '') : '')
/**
 * The key from what was pasted, or '' to clear it; null when it isn't one.
 * @param {string} raw
 * @returns {string | null}
 */
function parseApiKey(raw) {
  const text = raw.trim()
  if (!text) return ''
  const key = text.match(/api_key=([0-9a-f]{32,})/i)
  const user = text.match(/user_id=(\d+)/)
  return key && user ? `&api_key=${key[1]}&user_id=${user[1]}` : null
}

/** @param {HTMLElement} link */
function wantDims(link) {
  const id = postId(link)
  // Only rule34's API knows an image's size before it is opened, and it needs the key.
  if (!CFG.resBadge || SITE !== 'rule34.xxx' || !GM_XHR || apiRefused || id === '?' || dimsAsked.has(id) || loadDims().has(id) || !apiKey()) return
  dimsAsked.add(id)
  dimsQueue.push(id)
  pumpDims()
}

let apiRefused = false   // the API turned the key down: no more asking until a new key

/**
 * One request to rule34's API, with the key; false (and nothing sent)
 * without a key, or once the API refused it. `done` gets the JSON, or null
 * for a failure or a refusal.
 * @param {string} query   e.g. "&id=123"
 * @param {(json: unknown) => void} done
 */
function r34Api(query, done) {
  const key = apiKey()
  if (!key || apiRefused || !GM_XHR || SITE !== 'rule34.xxx') return false
  GM_xmlhttpRequest({
    method: 'GET',
    url: `${RULE34_API}${query}${key}`,
    timeout: 15000,
    onload: res => {
      /** @type {unknown} */
      let json = null
      try { json = JSON.parse(res.responseText) } catch (e) { /* a refusal is plain text */ }
      if (json === null && /authentication|api_key|access denied/i.test(res.responseText)) {
        apiRefused = true
        warn(`rule34 API: the key was refused — ${res.responseText.slice(0, 120)}`)
      }
      done(json)
    },
    onerror: () => done(null),
    ontimeout: () => done(null),
  })
  return true
}

function pumpDims() {
  while (dimsLive < DIMS_INFLIGHT && dimsQueue.length) {
    const id = /** @type {string} */ (dimsQueue.shift())   // not empty
    const sent = r34Api(`&id=${encodeURIComponent(id)}`, json => {
      dimsLive--
      const post = Array.isArray(json) ? json[0] : null
      if (post && typeof post === 'object' && 'width' in post && 'height' in post) setDims(id, Number(post.width), Number(post.height))
      pumpDims()
    })
    if (!sent) { dimsQueue.length = 0; return }   // no key, or refused: the rest would not go either
    dimsLive++
  }
}

// The panel's section for what rule34's API serves with the user's key:
// the key's field first, a warning while there is none, then every option
// that depends on it. Other sites have no key: their options stay plain.
/** @param {HTMLElement} body */
export function apiSection(body) {
  if (SITE !== 'rule34.xxx') {
    body.appendChild(toggle('resBadge', t('tResBadge'), null, repaintCards))
    return
  }
  body.appendChild(el('div', { class: 'sec', text: t('apiSec') }))
  if (!apiKey()) body.appendChild(el('div', { class: 'apiwarn', text: t(GM_STORE ? 'apiWarn' : 'appNoStore') }))
  body.appendChild(apiKeyControls())
  body.appendChild(toggle('resBadge', t('tResBadge'), apiKey() ? null : t('apiPartial'), repaintCards))
}

// The key's field: saved as soon as a key is pasted.
function apiKeyControls() {
  const field = el('input', { class: 'apptoken', type: 'password', autocomplete: 'off', placeholder: t(GM_STORE ? 'apiKeyHint' : 'appNoStore') })
  field.disabled = !GM_STORE
  field.value = apiKey()
  /** @param {string} key */
  const keyUser = key => (key.match(/user_id=(\d+)/) || [])[1]
  /** @param {string} key */
  const shown = key => (key ? `${t('apiKeySet')} (user ${keyUser(key)})` : t('apiKeyNone'))
  const status = el('div', { class: 'lbl appstatus', text: shown(apiKey()) })
  /** @param {boolean} final  the field lost focus: a wrong text gets its message */
  const save = final => {
    const key = parseApiKey(field.value)
    if (key === null) { if (final) status.textContent = t('apiKeyBad'); return }
    // Pasting fires input at once; on the phone, change only comes when the
    // field loses focus, which closing the panel may never give it.
    if (key === apiKey() || (!key && !final)) return
    GM_setValue('r34ApiKey', key)
    field.value = key
    apiRefused = false
    dimsAsked.clear()   // the ones a refused key dropped are asked again
    status.textContent = shown(key)
    info(`resolution: API key ${key ? `saved (user ${keyUser(key)})` : 'cleared'}`)
    repaintCards()
    // The warning and the notes follow the key; a field still being typed
    // in keeps its focus until it is done.
    if (final || key) setTimeout(rebuildPanel, 0)
  }
  field.addEventListener('input', () => save(false))
  field.addEventListener('change', () => save(true))
  return el('div', { class: 'lang' }, [el('div', { class: 'lbl', text: t('apiKey') }), field, status])
}
