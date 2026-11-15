/** @import { Comments, PostPage } from '../post/post' */
import { t } from '../core/i18n'
import { dbg, describeError, info, warn } from '../core/log'
import { pastDecoder } from '../video/limits'
import { nativeTags } from '../thumbs/covers'
import { asElement, flash, hasMark, modal, readCookie, setMark } from './modal'
import { lookUpFavorite, onOwnFavorites, postInfo, readComments } from '../post/post'
import { PLAYER_ICON, mmss, setIcon } from './player'
import { postId } from './media'
import { el } from '../panel/panel'

// ── Tags menu ──
// ☰ opens a sheet with the post's tags as a grid; a tap copies one, "Copy
// all" the whole list, ready to paste in a search. The thumbnail's own tags
// show at once; the post page replaces them with the full list by kind.
const TAG_ORDER = ['artist', 'character', 'copyright', 'general', 'metadata']
/** @param {string} type */
const tagRank = type => { const i = TAG_ORDER.indexOf(type); return i < 0 ? TAG_ORDER.length : i }

/** @typedef {{ name: string, type: string }} Tag  type: the site's tag-type-*, general when unknown */
/**
 * @param {HTMLElement} link
 * @returns {Tag[]}
 */
function thumbTags(link) {
  return nativeTags(link).trim().split(/\s+/)
    .filter(name => name && !/^(score|rating):/i.test(name))
    .map(name => ({ name, type: 'general' }))
}

export function toggleMenu() {
  const open = /** @type {boolean} */ (modal.sheet.hidden)   // a boolean: nothing here sets 'until-found'
  modal.sheet.hidden = !open
  modal.menu.classList.toggle('on', open)
  if (open) renderSheet(modal.link, modal.seq)
}

/** @typedef {'tags' | 'info' | 'comments'} SheetTab */
/** @param {HTMLAnchorElement} link @param {number} seq */
export function renderSheet(link, seq) {
  if (modal.sheetTab === 'info') renderInfo(link, seq)
  else if (modal.sheetTab === 'comments') renderComments(link, seq)
  else renderTags(link, seq)
}

/** @param {SheetTab} tab */
function markTab(tab) {
  modal.sheetTab = tab
  modal.tabTags.classList.toggle('on', tab === 'tags')
  modal.tabInfo.classList.toggle('on', tab === 'info')
  modal.tabComments.classList.toggle('on', tab === 'comments')
  modal.tagList.hidden = tab !== 'tags'
  modal.infoList.hidden = tab !== 'info'
  modal.commentList.hidden = tab !== 'comments'
}

/** @param {SheetTab} tab */
export function showTab(tab) {
  markTab(tab)
  renderSheet(modal.link, modal.seq)
}

// The player's ⓘ: the sheet open on Info, or closed if it already shows it.
export function toggleInfo() {
  const open = !modal.sheet.hidden
  if (open && modal.sheetTab === 'info') toggleMenu()
  else if (open) showTab('info')
  else { markTab('info'); toggleMenu() }   // toggleMenu draws it
  dbg(`modal: info ${modal.sheet.hidden ? 'closed' : 'opened'} from the player`)
}

// Comments tab: read from the post page (already fetched for the heart and
// Info), in the site's order, as text. Those under the account's comment
// threshold stay hidden, as on the site.
/** @param {HTMLAnchorElement} link @param {number} seq */
async function renderComments(link, seq) {
  modal.commentList.replaceChildren(el('div', { class: 'none', text: t('infoLoading') }))
  const info = await postInfo(postId(link))
  if (modal.seq !== seq || modal.sheetTab !== 'comments') return
  /** @type {Comments} */
  const page = (info && info.comments) || { list: [], total: 0, next: null }
  modal.tabComments.textContent = `${t('tabComments')} (${page.total})`
  modal.commentList.replaceChildren()
  if (!page.total) { modal.commentList.append(el('div', { class: 'none', text: t('commentsNone') })); return }
  appendComments(page, seq)
  dbg(`modal: ${page.total} comments for post ${postId(link)}`)
}

// The site's own call (its vote() in application.js): the answer is the
// comment's new score. The site shows no trace of a past vote, so the
// comments voted here are remembered on the device, like post votes.
/** @typedef {Comments['list'][number]} Comment */
/** @param {Comment} c @param {HTMLButtonElement} btn */
async function voteComment(c, btn) {
  if (btn.disabled) return
  btn.disabled = true
  try {
    const url = `/index.php?page=comment&id=${encodeURIComponent(postId(modal.link))}&s=vote&cid=${encodeURIComponent(c.id)}&vote=up`
    const res = await fetch(url, { credentials: 'same-origin' })
    const score = parseInt(await res.text(), 10)
    if (!res.ok || !Number.isFinite(score)) throw new Error(`HTTP ${res.status}`)
    c.score = score
    btn.textContent = `▲ ${score}`
    btn.classList.add('on')
    setMark('c', c.id, true)
    info(`modal: comment ${c.id} upvoted -> ${score}`)
  } catch (e) {
    flash(t('voteFail'))
    warn(`modal: comment vote failed — ${describeError(e)}`)
  } finally {
    btn.disabled = false
  }
}

// Adds a page of comments, and a button for the next one while there is.
/** @param {Comments} page @param {number} seq */
function appendComments(page, seq) {
  const cookie = readCookie('comment_threshold')
  const threshold = cookie === null ? NaN : Number(cookie)
  const shown = Number.isFinite(threshold) ? page.list.filter(c => c.score >= threshold) : page.list
  modal.commentList.append(...shown.map(c => {
    // The author opens their profile in a new tab; ▲ votes the comment up.
    const who = c.profile
      ? el('a', { class: 'who', href: c.profile, target: '_blank', rel: 'noopener', text: c.user || '?' })
      : el('b', { text: c.user || '?' })
    const up = el('button', { class: 'cvote', text: `▲ ${c.score}` })
    up.classList.toggle('on', hasMark('c', c.id))
    up.addEventListener('click', () => voteComment(c, up))
    return el('div', { class: 'cm' }, [
      el('div', { class: 'h' }, [who, ` · ${c.date} `, up]),
      el('div', { class: 'b', text: c.text }),
    ])
  }))
  if (shown.length < page.list.length) {
    modal.commentList.append(el('div', { class: 'none', text: `${page.list.length - shown.length} ${t('commentsHidden')}` }))
  }
  if (!page.next) return
  const more = el('button', { class: 'pill', text: t('commentsMore') })
  more.addEventListener('click', async () => {
    more.disabled = true
    more.textContent = t('infoLoading')
    try {
      // page.next: the button is only there with one.
      const res = await fetch(/** @type {string} */ (page.next), { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const next = readComments(new DOMParser().parseFromString(await res.text(), 'text/html'), /** @type {string} */ (page.next))
      if (modal.seq !== seq || modal.sheetTab !== 'comments') return
      more.remove()
      appendComments(next, seq)
    } catch (e) {
      more.disabled = false
      more.textContent = t('commentsMore')
      warn(`modal: more comments failed — ${describeError(e)}`)
    }
  })
  modal.commentList.append(more)
}

// Info tab: what the file says (kind, size, format, length), how playback
// is going here (frames dropped so far, measured by the video itself), and
// the post page's statistics. Redrawn when the file's metadata arrives.
// (MediaCapabilities was no use: Firefox for Android answers "smooth,
// power efficient" even for 4K on a phone whose decoder stops at 1088p.)
/** @typedef {[label: string, value: string, warn?: boolean]} InfoRow */
/** @param {HTMLAnchorElement} link @param {number} seq */
export async function renderInfo(link, seq) {
  const v = modal.video
  const img = modal.image
  const video = !v.hidden
  const url = modal.fileUrl
  /** @type {InfoRow[]} */
  const rows = []
  const kind = video ? t('kindVideo') : /\.gif(\?|$)/i.test(url || '') ? t('kindGif') : t('kindImage')
  rows.push([t('infoKind'), kind])
  const w = video ? v.videoWidth : (url ? img.naturalWidth : 0)
  const h = video ? v.videoHeight : (url ? img.naturalHeight : 0)
  rows.push([t('infoRes'), w && h ? `${w} × ${h}` : t('infoLoading')])
  // A typical mid-range hardware decoder stops at 1920×1088 (this phone's does).
  if (video && w && h && pastDecoder(w, h)) rows.push(['', t('infoAbove'), true])
  rows.push([t('infoFormat'), url ? `${((url.split(/[?#]/)[0].match(/\.(\w+)$/) || [])[1] || '?').toUpperCase()}${modal.isSample ? ` (${t('infoSample')})` : ''}` : t('infoLoading')])
  if (video) rows.push([t('infoDuration'), Number.isFinite(v.duration) ? mmss(v.duration) : t('infoLoading')])
  if (video && typeof v.getVideoPlaybackQuality === 'function') {
    const q = v.getVideoPlaybackQuality()
    if (q.totalVideoFrames >= 30) {
      const pct = Math.round((q.droppedVideoFrames / q.totalVideoFrames) * 100)
      rows.push([t('infoDrops'), `${pct}% (${q.droppedVideoFrames} ${t('infoDropsOf')} ${q.totalVideoFrames})`, pct >= 10])
    }
  }
  if (modal.seq !== seq || modal.sheetTab !== 'info') return
  fillInfo(rows, [])
  const info = await postInfo(postId(link))
  if (modal.seq !== seq || modal.sheetTab !== 'info' || !info || !info.stats) return
  fillInfo(rows, info.stats)
}

/** @param {InfoRow[]} rows @param {PostPage['stats']} stats */
function fillInfo(rows, stats) {
  const cells = []
  for (const [k, value, warn] of rows) cells.push(el('span', { class: 'k', text: k }), el('span', { class: warn ? 'v warn' : 'v', text: value }))
  for (const st of stats) {
    const m = st.text.match(/^([^:]{1,20}):\s*(.*)$/)
    const k = m ? m[1] : ''
    const value = m ? m[2] : st.text
    const cell = st.href
      ? el('span', { class: 'v' }, [el('a', { href: st.href, target: '_blank', rel: 'noopener', text: value })])
      : el('span', { class: 'v', text: value })
    cells.push(el('span', { class: 'k', text: k }), cell)
  }
  modal.infoList.replaceChildren(...cells)
}

export function closeMenu() {
  modal.sheet.hidden = true
  modal.menu.classList.remove('on')
}

/** @param {HTMLAnchorElement} link @param {number} seq */
function renderTags(link, seq) {
  fillTags(thumbTags(link))
  postInfo(postId(link)).then(info => {
    if (!info || !info.tags.length || modal.seq !== seq || modal.sheet.hidden) return
    fillTags(info.tags)
    dbg(`modal: tags menu, ${info.tags.length} tags from the post page`)
  })
}

/** @param {Tag[]} tags */
function fillTags(tags) {
  const sorted = [...tags].sort((a, b) => tagRank(a.type) - tagRank(b.type))
  modal.tagList.replaceChildren(...sorted.map(tag => {
    const chip = el('button', { class: `tag t-${tag.type}`, text: tag.name })
    chipGestures(chip, tagSearchUrl(tag.name), () => copyText(tag.name, chip))
    return chip
  }))
  if (!sorted.length) modal.tagList.append(el('span', { class: 'none', text: t('tagsNone') }))
}

// A tap copies the tag; a hold opens its search in a new tab. The tab opens
// on release, not when the hold timer fires: a timer is not a user gesture,
// and the popup blocker would stop window.open from it.
const TAG_HOLD_MS = 450
/** @param {string} name */
const tagSearchUrl = name => `/index.php?page=post&s=list&tags=${encodeURIComponent(name)}`

// Measured on the phone (event log): Firefox for Android ends a long press
// three ways — contextmenu then pointerup; contextmenu then pointercancel;
// or pointercancel ~110 ms in, with no contextmenu, as soon as the finger
// trembles (it takes the touch for a scroll of the sheet). Touch events go
// on through all three, so a touch hold is measured on them: long enough,
// the finger nearly still and the sheet not scrolled. Pointer events only
// serve the mouse. The tab opens from touchend/pointerup, both user gestures.
export const HOLD_SLOP = 12   // px the finger may wander and still be holding

// `url`: a link, or a function giving it at the moment of the hold (null:
// not known yet). `what` names it in the log.
/**
 * @param {HTMLElement} chip
 * @param {string | (() => string | null | undefined)} url
 * @param {() => void} onTap
 * @param {string} [what]
 */
export function chipGestures(chip, url, onTap, what = 'tag search') {
  /** @type {{ x: number, y: number, t: number, scroll: number, timer: number } | null} */
  let down = null
  let skipClick = false
  const reset = () => {
    if (down) clearTimeout(down.timer)
    down = null
    chip.classList.remove('held')
  }
  /** @param {number} x @param {number} y */
  const start = (x, y) => {
    skipClick = false
    // Lit once held long enough, so the finger knows it can let go.
    down = { x, y, t: Date.now(), scroll: modal.sheet.scrollTop, timer: setTimeout(() => chip.classList.add('held'), TAG_HOLD_MS) }
  }
  /** @param {number} x @param {number} y */
  const moved = (x, y) => down && Math.hypot(x - down.x, y - down.y) > HOLD_SLOP
  /** @param {Event} ev */
  const finish = ev => {
    if (!down) return
    const held = Date.now() - down.t >= TAG_HOLD_MS && Math.abs(modal.sheet.scrollTop - down.scroll) < HOLD_SLOP
    reset()
    if (!held) return
    skipClick = true   // a click that may follow is not a copy
    if (ev.cancelable) ev.preventDefault()   // and stop it where we can
    const href = typeof url === 'function' ? url() : url
    if (!href) { flash(t('dlWait')); return }
    window.open(href, '_blank', 'noopener')
    flash(t('tagOpened'))
    dbg(`modal: ${what} opened in a new tab (${href})`)
  }
  chip.addEventListener('touchstart', ev => start(ev.touches[0].clientX, ev.touches[0].clientY), { passive: true })
  chip.addEventListener('touchmove', ev => { if (moved(ev.touches[0].clientX, ev.touches[0].clientY)) reset() }, { passive: true })
  chip.addEventListener('touchend', finish)
  chip.addEventListener('touchcancel', reset)
  chip.addEventListener('pointerdown', ev => { if (ev.pointerType === 'mouse') start(ev.clientX, ev.clientY) })
  chip.addEventListener('pointermove', ev => { if (ev.pointerType === 'mouse' && moved(ev.clientX, ev.clientY)) reset() })
  chip.addEventListener('pointerup', ev => { if (ev.pointerType === 'mouse') finish(ev) })
  chip.addEventListener('contextmenu', ev => ev.preventDefault())   // the hold is ours
  chip.addEventListener('click', () => {
    if (skipClick) { skipClick = false; return }
    onTap()
  })
}

/** @param {string} text @param {HTMLElement} chip */
async function copyText(text, chip) {
  let ok = false
  try {
    await navigator.clipboard.writeText(text)   // the tap is the user gesture it needs
    ok = true
  } catch (e) {
    // Older path: a selected text field and the copy command.
    const field = document.createElement('textarea')
    field.value = text
    field.style.cssText = 'position:fixed;opacity:0'
    document.documentElement.appendChild(field)
    field.select()
    try { ok = document.execCommand('copy') } catch (e2) { /* not allowed */ }
    field.remove()
  }
  flash(ok ? `${t('tagCopied')}: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}` : t('tagCopyFail'))
  if (ok) {
    chip.classList.add('copied')
    setTimeout(() => chip.classList.remove('copied'), 600)
  }
  dbg(`modal: copy ${ok ? 'done' : 'failed'} (${text.length} chars)`)
}

/** @param {boolean} on */
export function showFav(on) {
  modal.fav.textContent = on ? '♥' : '♡'
  modal.fav.classList.toggle('on', on)
  setIcon(modal.vfav, on ? PLAYER_ICON.heart : PLAYER_ICON.heartLine)
  modal.vfav.classList.toggle('on', on)
}

// What is known shows at once; the post page corrects it when it answers.
// The site never shows a past vote, but its heart votes up as it favorites
// (post_vote then toggleFav), so a favorite counts as upvoted.
/** @param {HTMLAnchorElement} link @param {number} seq */
export function applyMarks(link, seq) {
  const id = postId(link)
  const own = onOwnFavorites()
  if (own) setMark('f', id, true)
  /** @param {boolean} fav */
  const show = fav => {
    showFav(fav)
    modal.up.classList.toggle('on', fav || hasMark('v', id))
  }
  show(own || hasMark('f', id))
  if (own) return
  lookUpFavorite(id).then(fav => { if (fav !== null && modal.open && modal.seq === seq) show(fav) })
}

// The site's own vote links (post pages, comments) count too.
/** @param {MouseEvent} ev */
export function onSiteVoteClick(ev) {
  const a = asElement(ev.target)?.closest('a[onclick*="post_vote("]')
  const m = a && /** @type {string} */ (a.getAttribute('onclick')).match(/post_vote\('(\d+)',\s*'up'\)/)   // the selector asked for it
  if (m) setMark('v', m[1], true)
}
