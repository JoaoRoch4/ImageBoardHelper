import { LIST } from '../core/site'
import { CFG } from '../core/config'
import { t } from '../core/i18n'
import { dbg, describeError, info, warn } from '../core/log'
import { fileCandidates, thumbParts } from '../urls/hosts'
import { cacheGet, cacheSet, cachedFirst } from '../urls/url-cache'
import { NATIVE_REAL_VIDEO, giveImageSlot, takeImageSlot } from '../thumbs/covers'
import { sampleCandidates } from '../thumbs/feed'
import { favPage } from './favorites'
import { el } from '../panel/panel'
import { pageTarget } from '../panel/nav'

// ── Autopager ──
// Search listings and favorites fetch the next page as the bottom nears
// and append its thumbnails, the site's own nodes, to the list. The
// observer treats them like any thumbnail (covers, feed, modal and swipe).
// The next address comes from the paginator of each page fetched; the
// favorites paginator navigates from onclick handlers with no real href,
// which is why autopager extensions find no next page there.
let pager: { next: string | null, busy: boolean, done: boolean, page: number, sentinel: HTMLDivElement, io: IntersectionObserver } | null = null   // { next, busy, done, io, sentinel }

const onListPage = () => {
  const q = new URLSearchParams(location.search)
  return q.get('page') === 'post' && q.get('s') === 'list'
}

export const onFavoritesPage = () => {
  const q = new URLSearchParams(location.search)
  return q.get('page') === 'favorites' && q.get('s') === 'view' && !!q.get('id')
}

// Idempotent: the observer calls it on every change of the page.
export function ensureFavPager() {
  const want = CFG.favAutopager && (onFavoritesPage() || onListPage()) &&
    !!document.querySelector(LIST)
  if (!want) {
    if (pager) { pager.io.disconnect(); pager.sentinel.remove(); pager = null }
    return
  }
  if (pager && pager.sentinel.isConnected) return
  const sentinel = el('div', { id: 'ibh-pager' })
  const above = (document.getElementById('ibh-favmore') || document.querySelector(LIST)) as Element   // want found the list
  above.after(sentinel)
  sentinel.addEventListener('click', () => { if (pager && !pager.done) favPagerNext() })   // retry after a failure
  const next = pageTarget(1)
  const io = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) favPagerNext()
  }, { rootMargin: '1500px 0px' })
  pager = { next, busy: false, done: !next, page: 1, sentinel, io }
  if (!next) sentinel.textContent = t('pagerEnd')
  io.observe(sentinel)
  dbg(`autopager: watching the bottom of the page${next ? '' : ' (last page)'}`)
}

export async function favPagerNext() {
  const p = pager
  // favPage: search results are on show, not the favorites pages.
  if (!p || p.busy || p.done || favPage) return
  p.busy = true
  p.sentinel.textContent = t('pagerLoading')
  try {
    const url = p.next as string   // not done: there is a next page
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
    const src = doc.querySelector(LIST)
    const items = src ? [...src.children].filter(node => node.querySelector && node.querySelector('img')) : []
    const list = document.querySelector(LIST)
    if (!items.length || !list) {
      p.done = true
      p.sentinel.textContent = t('pagerEnd')
      info(`autopager: end of the list at ${url.replace(/^.*\?/, '?')}`)
      return
    }
    list.append(...items.map(node => document.adoptNode(node)))
    p.page++
    p.next = pageTarget(1, doc, url)
    info(`autopager: page ${p.page} added (${items.length} posts)`)
    if (!p.next) { p.done = true; p.sentinel.textContent = t('pagerEnd'); return }
    p.sentinel.textContent = ''
  } catch (e) {
    warn(`autopager: next favorites page failed — ${describeError(e)}`)
    p.sentinel.textContent = t('pagerFail')
    return
  } finally {
    p.busy = false
  }
  // Still near the bottom (a short page): the observer will not fire again.
  if (p.sentinel.getBoundingClientRect().top < window.innerHeight + 1500) setTimeout(favPagerNext, 300)
}

// The site's thumbnail is small and blurry stretched over a tile. Swap in
// the sample (images, GIFs: their still) or the full-size poster frame
// (videos), from the same download slots and URL cache as the page; the
// thumbnail stays when there is none.
export function sharpenTile(img: HTMLImageElement) {
  const src = img.getAttribute('src')
  const hash = (thumbParts(src) || {}).hash
  if (!hash) return
  // src: thumbParts found the hash in it.
  const tags = ` ${img.dataset.tags || ''} `
  const video = !!img.dataset.webm || NATIVE_REAL_VIDEO.test(tags)
  const kind = video ? 'poster' : 'sample'
  const cached = cacheGet(kind, hash)
  if (cached === null) return   // known: nothing better exists
  const urls = cachedFirst(video ? fileCandidates(src as string, ['jpg']) : sampleCandidates(src as string), cached)
  if (!urls.length) return
  takeImageSlot(() => {
    const probe = new Image()
    probe.decoding = 'async'
    let i = 0
    let held = true
    const release = () => { if (held) { held = false; giveImageSlot() } }
    probe.onerror = () => {
      if (i < urls.length) { probe.src = urls[i++]; return }
      release()
      cacheSet(kind, hash, null)
    }
    probe.onload = () => {
      release()
      cacheSet(kind, hash, probe.src, cached)
      if (img.isConnected) img.src = probe.src   // a tile in our own Shadow DOM: no Imagus to keep happy
    }
    probe.src = urls[i++]
  })
}
