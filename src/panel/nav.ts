import { SITE, THUMB } from '../core/site'
import { CFG } from '../core/config'
import { t } from '../core/i18n'
import { dbg, info } from '../core/log'
import { SITE_LINK } from '../modal/modal'
import { userId } from '../post/post'
import { setCfg } from '../storage/storage'
import { showLater } from '../lists/later'
import { HEART_ICON, bulkMode, setBulkMode, wantsBulkButton } from '../page/bulk'
import { freeMemory, redoThumbs } from '../diag'
import { control, el, panelHost, panelOpen, renderStatus, shadow, togglePanel } from './panel'

// The host is often mounted while the page is still parsing, before the
// post list exists, so the buttons are added whenever the list shows up.
// Runs on every mutation batch, so it only rebuilds when the set of buttons
// the page needs has changed (e.g. the post list arrived after the host).
export function ensureFeedNav() {
  if (!shadow) return
  const feed = wantsFeedButtons()
  const free = !!CFG.freeButton
  const redo = !!CFG.redoButton
  const want = `${feed ? 'f' : ''}${free ? 'c' : ''}${redo ? 'r' : ''}`
  let nav = control('.feednav:not(.pagenav)')
  if (nav && nav.dataset.set !== want) { nav.remove(); nav = null }
  if (!nav && want) {
    nav = buildFeedNav(feed, free, redo)
    nav.dataset.set = want
    shadow.appendChild(nav)
    dbg(`buttons added: ${feed ? 'feed ' : ''}${free ? 'free' : ''}`.trim())
  }
  // Your favorites: top right, beside ♥ and 🕒.
  let favs = control('.favsfab')
  const wantFavs = !!CFG.favsButton && SITE === 'rule34.xxx' && !!userId()
  if (favs && !wantFavs) { favs.remove(); favs = null }
  if (!favs && wantFavs) {
    favs = iconButton('laterfab favsfab', t('navFavs'), BOOKMARK_ICON)
    favs.addEventListener('click', () => {
      info('going to your favorites')
      location.href = `index.php?page=favorites&s=view&id=${userId()}`
    })
    shadow.appendChild(favs)
  }
  // Top right, packed from the edge in this order (🕒, ♥, 🔖), whichever show.
  const packRight = () => {
    [control('.clockfab'), control('.bulkfab'), control('.favsfab')].filter(btn => btn !== null)
      .forEach((btn, i) => { btn.style.right = `${12 + i * 52}px` })
  }
  // Mass favorite: next to Watch later, top right.
  let heart = control('.bulkfab')
  if (heart && !wantsBulkButton()) { heart.remove(); heart = null; if (bulkMode) setBulkMode(false) }
  if (!heart && wantsBulkButton()) {
    heart = iconButton('laterfab bulkfab', t('navBulk'), HEART_ICON)
    heart.classList.toggle('on', bulkMode)
    heart.addEventListener('click', () => setBulkMode(!bulkMode))
    shadow.appendChild(heart)
  }
  // Watch later: a button of its own in the top-right corner.
  let clock = control('.clockfab')
  if (clock && !wantsLaterButton()) { clock.remove(); clock = null }
  if (!clock && wantsLaterButton()) {
    clock = iconButton('laterfab clockfab', t('navLater'), CLOCK_ICON)
    clock.addEventListener('click', () => showLater())
    shadow.appendChild(clock)
  }
  packRight()
  // 👁: bottom left, beside ◐ (in its place when the panel is off).
  let eye = control('.eyefab')
  if (eye && !CFG.eyeButton) { eye.remove(); eye = null }
  if (!eye && CFG.eyeButton) {
    eye = iconButton('eyefab', t('eyeHide'), EYE_ICON)
    eye.classList.toggle('solo', !CFG.panel)
    eye.addEventListener('click', () => setButtonsHidden(!CFG.buttonsHidden))
    shadow.appendChild(eye)
  }
  applyButtonsHidden()
  let pages = control('.pagenav')
  if (pages && !feed) { pages.remove(); pages = null }
  if (!pages && feed) { pages = buildPageNav(); shadow.appendChild(pages) }
  // The paginator comes after the post list in the page, so its state is
  // refreshed as the page fills in rather than fixed when the buttons appear.
  if (pages) {
    const prev = pages.querySelector('.pp') as HTMLButtonElement   // buildPageNav's buttons
    const next = pages.querySelector('.np') as HTMLButtonElement
    prev.disabled = !pageTarget(-1)
    next.disabled = !pageTarget(1)
  }
}

export const wantsFeedButtons = () => CFG.feedNav && CFG.nativeFeed && !!document.querySelector(FEED_POST)

// ‹ › buttons for the one-column feed: jump to the start of the previous or
// next post, e.g. to skip a long comic without scrolling through it.
const FEED_POST = THUMB

/** @param dir   1 the next post, -1 the previous */
function jumpPost(dir: number) {
  const posts = [...document.querySelectorAll(FEED_POST)]
  if (!posts.length) return
  // By position on screen, not page order: in columns the order runs down
  // each column. Next: the nearest post starting below the top edge.
  // Previous: the nearest starting above it (inside a long post that is its
  // own start, at a post's start it is the one before).
  let target = null
  let best = dir > 0 ? Infinity : -Infinity
  for (const post of posts) {
    const top = post.getBoundingClientRect().top
    if (dir > 0 ? top > 8 && top < best : top < -8 && top > best) { best = top; target = post }
  }
  if (!target) return
  // Instant, not smooth: smooth-scrolling past a 7000px comic takes ages.
  window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY, behavior: 'auto' })
  dbg(`feed: jumped to the ${dir > 0 ? 'next' : 'previous'} post`)
}

// The site's own pagination link for the next (dir 1) or previous page.
// Favorites put the address in an onclick (href is just "#"). Without a
// usable link, step pid by the number of posts on this page.
// Of this page, or of a page the autopager fetched (root, at base).
export function pageTarget(dir: number, root: ParentNode = document, base: string = location.href) {
  const box = root.querySelector('#paginator, .pagination')
  if (box) {
    const want = dir > 0 ? /^(>|›|next)$/i : /^(<|‹|back|prev(ious)?)$/i
    const a = [...box.querySelectorAll('a')].find(x => want.test((x.textContent || '').trim()) || want.test(x.getAttribute('alt') || ''))
    if (a) {
      const href = a.getAttribute('href')
      if (href && href !== '#') return new URL(href, base).href
      const m = (a.getAttribute('onclick') || '').match(/location\s*=\s*['"]([^'"]+)['"]/)
      if (m) return new URL(m[1], base).href
    }
    if (box.querySelector('a')) return null   // paginator present but no such link: first or last page
  }
  const url = new URL(base)
  const pid = Number(url.searchParams.get('pid')) || 0
  const per = root.querySelectorAll(FEED_POST).length
  if (!per || (dir < 0 && pid === 0)) return null
  url.searchParams.set('pid', String(Math.max(0, pid + dir * per)))
  return url.href
}

function goPage(dir: number) {
  const target = pageTarget(dir)
  if (!target) return
  info(`feed: ${dir > 0 ? 'next' : 'previous'} page`)
  location.href = target
}

// Material Design's "delete" icon (a trash can), as path data.
const TRASH_ICON = 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z'

// Material Design's "bookmark" icon, as path data.
const BOOKMARK_ICON = 'M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z'

// Material Design's "refresh" icon, as path data.
const REDO_ICON = 'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z'

// ↻: Free memory first, then every thumbnail starts over, failures
// included (the URL cache forgets its misses and keeps its winners). Only
// this tab: other tabs keep what they show.
function redoButton() {
  const btn = iconButton('trash', t('navRedo'), REDO_ICON)   // the trash can's look
  btn.addEventListener('click', () => {
    btn.classList.add('on')
    btn.disabled = true
    freeMemory('redo').then(() => redoThumbs()).finally(() => {
      setTimeout(() => { btn.classList.remove('on'); btn.disabled = false }, 400)
      renderStatus()
    })
  })
  return btn
}

function trashButton() {
  const btn = el('button', { class: 'trash', title: t('navFree') })
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', TRASH_ICON)
  svg.appendChild(path)
  btn.appendChild(svg)
  // Lit while freeing, so the tap shows it was taken.
  btn.addEventListener('click', () => {
    btn.classList.add('on')
    btn.disabled = true
    freeMemory().finally(() => {
      setTimeout(() => { btn.classList.remove('on'); btn.disabled = false }, 400)
      renderStatus()
    })
  })
  return btn
}

// Material Design's "visibility" and "visibility off" icons, as path data.
const EYE_ICON = 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z'
const EYE_OFF_ICON = 'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z'

// 👁: hides every other floating button (◐ and the panel too) for a page
// with nothing over it, and brings them back. Remembered across pages.
function setButtonsHidden(hidden: boolean) {
  if (hidden) {
    if (bulkMode) setBulkMode(false)   // its ♥ goes away: no tap may favorite unseen
    if (panelOpen) togglePanel(false)
  }
  setCfg('buttonsHidden', hidden)
  applyButtonsHidden()
}

// The hiding is a class on the host, read by PANEL_CSS; without the eye
// nothing stays hidden. Runs on every DOM change: only acts on a change.
function applyButtonsHidden() {
  const eye = control('.eyefab')
  if (!eye) { if (panelHost) panelHost.classList.remove('ibh-clean'); return }
  const hidden = !!CFG.buttonsHidden
  if (eye.dataset.hidden === String(hidden)) return
  eye.dataset.hidden = String(hidden)
  ;(panelHost as HTMLDivElement).classList.toggle('ibh-clean', hidden)   // the eye is in its shadow
  eye.title = t(hidden ? 'eyeShow' : 'eyeHide')
  const icon = eye.querySelector('path') as SVGPathElement   // iconButton's
  icon.setAttribute('d', hidden ? EYE_OFF_ICON : EYE_ICON)
}

// Material Design's "watch later" icon (a clock), as path data.
const CLOCK_ICON = 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm4.2 14.2L11 13V7h1.5v5.2l4.5 2.7-.8 1.3z'

/** @param d   the icon's path data */
function iconButton(cls: string, title: string, d: string) {
  const btn = el('button', { class: cls, title })
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', d)
  svg.appendChild(path)
  btn.appendChild(svg)
  return btn
}

// The list opens in the post modal, which exists on the site's own pages.
const wantsLaterButton = () => !!CFG.laterButton && !!CFG.videoModal && !!document.querySelector(SITE_LINK)

function buildFeedNav(feed: boolean, free: boolean, redo: boolean) {
  const rows = []
  if (feed) {
    const top = el('button', { text: '⤒', title: t('navTop') })
    const prev = el('button', { text: '‹', title: t('navPrev') })
    const next = el('button', { text: '›', title: t('navNext') })
    const bottom = el('button', { text: '⤓', title: t('navBottom') })
    top.addEventListener('click', () => { window.scrollTo({ top: 0, behavior: 'auto' }); dbg('feed: jumped to the top') })
    prev.addEventListener('click', () => jumpPost(-1))
    next.addEventListener('click', () => jumpPost(1))
    bottom.addEventListener('click', () => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' })
      dbg('feed: jumped to the bottom')
    })
    rows.push(el('div', { class: 'row' }, [top, prev, next, bottom]))
  }
  const second = []
  if (free) second.push(trashButton())
  if (redo) second.push(redoButton())
  if (second.length) rows.push(el('div', { class: 'row' }, second))
  return el('div', { class: 'feednav' }, rows)
}

// « » page buttons: top left, across from 🕒 and ♥ on the right.
function buildPageNav() {
  const prevPage = el('button', { class: 'pp', text: '«', title: t('navPrevPage') })
  const nextPage = el('button', { class: 'np', text: '»', title: t('navNextPage') })
  prevPage.addEventListener('click', () => goPage(-1))
  nextPage.addEventListener('click', () => goPage(1))
  return el('div', { class: 'feednav pagenav' }, [el('div', { class: 'row' }, [prevPage, nextPage])])
}
