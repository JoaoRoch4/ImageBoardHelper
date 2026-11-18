// What the script learns about a post and its user from the site's pages.
import { dbg } from '../core/log'
import { setMark } from '../modal/modal'
import { setDims } from '../thumbs/marks'

// The logged-in user's id, or null. rule34 stopped letting scripts read its
// user_id cookie (2026-11-14: logged in, document.cookie had none, though
// it still goes with every request), so the page tells instead: a
// listing's My Favorites link, or one's own favorites page, whose Remove
// links only its owner gets. Once seen it is kept for the page's life:
// search results replace those links. A post page shows neither.
let pageUser: string | null = null
export const userId = () => (document.cookie.match(/(?:^|; )user_id=(\d+)/) || [])[1] || pageUser || (pageUser = userFromPage())

function userFromPage() {
  const nav = document.querySelector('#my-favorites-container a[href*="id="]')
  const fromNav = ((nav && nav.getAttribute('href')) || '').match(/[?&]id=(\d+)/)
  if (fromNav) return fromNav[1]
  const q = new URLSearchParams(location.search)
  const own = q.get('page') === 'favorites' && /^\d+$/.test(q.get('id') || '') && document.querySelector('a[onclick*="favorites&s=delete"]')
  return own ? q.get('id') : null
}

// The viewer's own favorites page: every post on it is a favorite.
export const onOwnFavorites = () => {
  const q = new URLSearchParams(location.search)
  return q.get('page') === 'favorites' && !!userId() && q.get('id') === userId()
}

// The post page, fetched once per post while the page lives (the swipe
// ahead warms it), gives the favorite state (its heart icon) and the tags
// with their kind (its sidebar). Only the parsed facts are kept.
export type PostPage = ReturnType<typeof readPostPage>
export const postInfos: Map<string, Promise<PostPage | null>> = new Map()   // id -> Promise<{ fav, tags } | null>

export function postInfo(id: string) {
  let p = postInfos.get(id)
  if (!p) {
    p = fetch(`/index.php?page=post&s=view&id=${encodeURIComponent(id)}`, { credentials: 'same-origin' })
      .then(res => (res.ok ? res.text() : null))
      .then(html => (html ? readPostPage(html) : null))
      .then(page => {
        // "Size: 1920x1080" in its statistics, for the resolution badge.
        const size = page && page.stats.map(st => st.text.match(/^Size:\s*(\d+)\s*x\s*(\d+)/i)).find(Boolean)
        if (size) setDims(id, Number(size[1]), Number(size[2]))
        return page
      })
      .catch(() => null)
    postInfos.set(id, p)
  }
  return p
}

// Comments of a post page: #comment-list > div#c<id>, author/date/score in
// .col1, text in .col2 (<br> for its line breaks). Ten a page; the next ten
// come from the "Next »" link of the comments' paginator (a cursor).
export type Comments = ReturnType<typeof readComments>
/**
 * @param base  what the links are relative to
 */
export function readComments(doc: ParentNode, base: string = location.href) {
  const list = [...doc.querySelectorAll('#comment-list > div[id]')].filter(d => /^c\d+$/.test(d.id)).map(d => {
    const head = d.querySelector('.col1')
    const body = d.querySelector('.col2')
    if (body) body.querySelectorAll('br').forEach((br: Element) => br.replaceWith('\n'))
    const headText = head ? (head.textContent || '').replace(/\s+/g, ' ') : ''
    const author = head && head.querySelector('a[href*="page=account"]')
    return {
      id: d.id.slice(1),   // c22197352 -> 22197352, for the vote
      user: ((author && author.textContent) || '').trim(),
      profile: author ? new URL(author.getAttribute('href') as string, base).href : null,   // matched a[href…]
      date: (headText.match(/Posted on (\S+ \S+)/) || [])[1] || '',
      score: Number((head && head.querySelector('[id^="sc"]') || {}).textContent) || 0,
      text: body ? (body.textContent || '').replace(/\n{3,}/g, '\n\n').trim() : '',
    }
  }).filter(c => c.text)
  const total = Number(((doc.querySelector('#comment-list') || {}).textContent || '').match(/(\d+) comments?/)?.[1]) || list.length
  const more = [...doc.querySelectorAll('#post-comments #paginator a')].find(a => /next/i.test(a.textContent || ''))
  const href = more && more.getAttribute('href')   // a link without one leads nowhere
  return { list, total, next: href ? new URL(href, base).href : null }
}

function readPostPage(html: string) {
  const heart = html.match(/id="heart-img"[^>]*src="[^"]*\/(heart(?:-added)?)\.svg"/)
  // An inert document: no scripts run, no images load.
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const tags = []
  for (const li of doc.querySelectorAll('li[class*="tag-type-"]')) {
    const type = (li.className.match(/tag-type-([a-z]+)/) || [])[1] || 'general'
    // The search link carries the tag as typed in a search (underscores).
    const a = [...li.querySelectorAll('a[href*="tags="]')].pop()
    const q = a && (a.getAttribute('href') as string).match(/[?&]tags=([^&]+)/)   // matched a[href…]
    if (q) tags.push({ name: decodeURIComponent(q[1].replace(/\+/g, ' ')), type })
  }
  // The sidebar's statistics: Id, Posted … by, Size, Source, Rating, Score.
  const stats = [...doc.querySelectorAll('#stats li')].map(li => {
    const text = (li.textContent || '').replace(/\s+/g, ' ').replace(/\(\s*vote.*$/i, '').trim()
    const link = li.querySelector('a[href^="http"]')
    return { text, href: link ? link.getAttribute('href') : null }
  }).filter(st => st.text)
  const comments = readComments(doc)
  // The sidebar's "Original image" link: the exact file, no guessing.
  const orig = [...doc.querySelectorAll('a[href*="/images/"]')].find(a => /original/i.test(a.textContent || ''))
  // The page links videos on api-cdn-mp4, the slow origin (0.4–0.6 MB/s
  // measured, against 6–7 MB/s for the same file on api-cdn, Cloudflare).
  const original = orig ? (orig.getAttribute('href') as string).replace(/([^:])\/\/+/g, '$1/').replace('//api-cdn-mp4.', '//api-cdn.') : null   // matched a[href…]
  return { fav: heart ? heart[1] === 'heart-added' : null, tags, stats, original, comments }
}

export const favLookups: Map<string, Promise<boolean | null>> = new Map()   // id -> Promise<true | false | null>

export function lookUpFavorite(id: string): Promise<boolean | null> {
  if (!userId()) return Promise.resolve(null)   // logged out: the page has no state to give
  let p = favLookups.get(id)
  if (!p) {
    p = postInfo(id).then(info => {
      if (!info || info.fav === null) return null
      setMark('f', id, info.fav)
      dbg(`modal: post ${id} ${info.fav ? 'is' : 'is not'} a favorite (from the post page)`)
      return info.fav
    })
    favLookups.set(id, p)
  }
  return p
}
