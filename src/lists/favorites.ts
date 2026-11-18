import { LIST, SITE } from '../core/site'
import { CFG } from '../core/config'
import { LANG, t } from '../core/i18n'
import { describeError, info, warn } from '../core/log'
import { NATIVE_GIF, NATIVE_REAL_VIDEO } from '../thumbs/covers'
import { onOwnFavorites, userId } from '../post/post'
import { GM_STORE, idbGet, idbSet, storeGet, storeSet } from '../storage/storage'
import { attachSuggest, kindSelect, minScoreInput, orGroups } from '../search/suggest'
import { addRecent, savedControls, searchStore } from '../search/site-search'
import { el } from '../panel/panel'

// ── Favorites search ──
// A search bar on your own favorites page. An index of every favorite (id,
// thumbnail, tags, score) is read once from the favorites pages and kept
// with the lists; later visits only read the first pages, until they
// reach favorites already known (the site lists the newest first). Results
// go into the page's own thumbnail list (LIST) as the site's own thumbnails, so the
// feed, covers, the modal and its swipe all work on them as on any page.
// (Another script with this feature empties the whole page to show its
// results and clears localStorage on reset, which broke this one.)
const FAV_PAGE = 50          // favorites per page on the site
const FAV_SHOW = 60          // results added per step
const FAV_GAP_MS = 250       // between page reads, one at a time
const FAV_STALE_MS = 10 * 60 * 1000   // the index is refreshed in the background after this
const FAV_SAVE_MS = 5000     // a long read is saved this often, so a reload goes on from there
export type FavItem = [id: string, thumb: string, tags: string, score: number | null]
// next: where a read that a reload cut short goes on (a pid); absent once complete.
export type FavIndex = { user: string | null, updated: number, items: FavItem[], next?: number }
export type FavEntry = { item: [id: string, thumb: string, tags: string], tags: string[], set: Set<string>, score: number | null, video: boolean, gif: boolean, animated: boolean }
export let favIndex: FavIndex | null = null          // { user, updated, items: [[id, thumb, tags, score]] }, newest first
export let favEntries: FavEntry[] | null = null        // the items with their tags split, for searching
export function setFavEntries(v: typeof favEntries) { favEntries = v }
export let favScan: Promise<FavIndex | null> | null = null           // the read in progress
export let favPage: ChildNode[] | null = null           // the page's own list content, put back on Clear
let favResults: Array<FavEntry['item']> = []
let favShown = 0
let favBarSync: (() => void) | null = null        // refreshes the ☆ button of the favorites bar
let favBarReload: (() => Promise<void>) | null = null      // refreshes its lists

// The favorites bar's fields: ensureFavSearch builds it with all of them.
const favFields = (bar: HTMLElement) => ({
  text: bar.querySelector('input[type="search"]') as HTMLInputElement,
  or: bar.querySelector('input.or') as HTMLInputElement,
  kind: bar.querySelector('select.kind') as HTMLSelectElement,
  sort: bar.querySelector('select.sort') as HTMLSelectElement,
  min: bar.querySelector('input.min') as HTMLInputElement,
})

// The favorites bar's search, remembered for the next visit (active: shown).
async function rememberFavSearch(active: boolean) {
  const bar = document.getElementById('ibh-favsearch')
  if (!bar) return
  const store = await searchStore()
  const f = favFields(bar)
  store.favLast = { text: f.text.value, or: f.or.value, kind: f.kind.value, sort: f.sort.value, min: f.min.value, active }
  if (active) addRecent(store, { where: 'fav', ...store.favLast, active: undefined })   // one write for both
  await storeSet('searches', store)
  if (active && favBarReload) favBarReload()
}

// The favorites index lives in the site's IndexedDB, not in GM storage:
// Violentmonkey hands a script its whole GM storage on every page it runs
// on, and an index of 6,000 favorites is ~7 MB (2026-11-14). One an older
// version kept in GM storage moves over once. Without IndexedDB it stays
// in GM storage (and without GM storage, storeGet is IndexedDB already).
export async function favsGet(): Promise<FavIndex | null> {
  const saved = await idbGet('favs')
  if (saved === undefined) return storeGet('favs')   // no IndexedDB
  if (saved || !GM_STORE) return saved
  const old = await storeGet('favs')
  if (old && await idbSet('favs', old)) {
    await storeSet('favs', null)
    info(`favorites: index moved from GM storage to IndexedDB (${old.items.length} favorites)`)
  }
  return old
}

export async function favsSet(idx: FavIndex) {
  if (!(await idbSet('favs', idx))) await storeSet('favs', idx)
}

export async function loadFavIndex(): Promise<FavIndex> {
  if (favIndex && favIndex.user === userId()) return favIndex
  const saved = await favsGet()
  // Loaded twice at once (the restored search and the bar's status): the
  // first one in wins, so a read in progress and the searches share one index.
  if (favIndex && favIndex.user === userId()) return favIndex
  favIndex = saved && saved.user === userId() ? saved : { user: userId(), updated: 0, items: [] }
  favEntries = null
  return favIndex
}

// One page of favorites: ids, thumbnails and tags from the thumbnails, scores
// from the page's inline script (posts[ID] = { … score: 'N' }).
/**
 * @param pid   the first favorite of the page
 */
async function readFavPage(pid: number): Promise<FavItem[]> {
  const res = await fetch(`/index.php?page=favorites&s=view&id=${userId()}&pid=${pid}`, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()
  const scores: Map<string, number> = new Map()
  for (const m of html.matchAll(/posts\[(\d+)\]\s*=\s*\{[^}]*?score['"]?\s*:\s*['"]?(-?\d+)/g)) scores.set(m[1], Number(m[2]))
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return [...doc.querySelectorAll('.thumb img[src]')].map(img => {
    const a = img.closest('a')
    const src = img.getAttribute('src') as string   // matched img[src]
    const id = ((a && a.getAttribute('href')) || '').match(/id=(\d+)/)?.[1] || (src.split('?')[1] || '')
    return [id, src, (img.getAttribute('title') || img.getAttribute('alt') || '').trim(), scores.has(id) ? scores.get(id) : null] as FavItem
  }).filter(item => /^\d+$/.test(item[0]))
}

// Reads the favorites pages into the index. New favorites first, from the
// top (pages are newest first) until a page holds known ones; then a read
// a reload cut short goes on where it stopped (idx.next). full starts over.
// A long read (6,000 favorites: 123 pages, ~2 min) is saved as it goes, so
// a reload loses only its last seconds. Favorites removed above the stop
// meanwhile shift the rest up, and that many may be missed until a rebuild.
function updateFavIndex(full: boolean) {
  if (favScan) return favScan
  favScan = (async () => {
    const idx = await loadFavIndex()
    if (full || (!idx.items.length && idx.next === undefined)) Object.assign(idx, { items: [], next: 0, updated: 0 })
    const before = idx.items.length
    const known = new Set(idx.items.map(item => item[0]))
    /** @returns the ones not in the index yet */
    const unknown = (items: FavItem[]): FavItem[] => {
      const added = items.filter(item => !known.has(item[0]))
      added.forEach(item => known.add(item[0]))
      return added
    }
    const read = async (pid: number) => {
      setFavStatus(`${t('favScanning')} ${Math.floor(pid / FAV_PAGE) + 1}…`)
      for (let tries = 0; ; tries++) {
        try { return await readFavPage(pid) } catch (e) {
          if (tries >= 2) throw e
          await new Promise(r => setTimeout(r, 1000 * (tries + 1)))
        }
      }
    }
    let saved = Date.now()
    try {
      if (idx.items.length) {
        const top: FavItem[] = []
        for (let pid = 0; ; pid += FAV_PAGE) {
          const items = await read(pid)
          const added = unknown(items)
          top.push(...added)
          if (!items.length || added.length < items.length) break   // reached the index
          await new Promise(r => setTimeout(r, FAV_GAP_MS))
        }
        idx.items = [...top, ...idx.items]
      }
      while (idx.next !== undefined) {
        const items = await read(idx.next)
        if (!items.length) { delete idx.next; break }   // past the last page
        idx.items.push(...unknown(items))
        idx.next += FAV_PAGE
        favEntries = null   // a search meanwhile sees what came in
        if (Date.now() - saved > FAV_SAVE_MS) { await favsSet(idx); saved = Date.now() }
        await new Promise(r => setTimeout(r, FAV_GAP_MS))
      }
    } catch (e) {
      warn(`favorites: ${t('favScanFail')} — ${describeError(e)}`)
      setFavStatus(t('favScanFail'))
      if (idx.next !== undefined) await favsSet(idx)   // what was read stays: the next visit goes on from it
      return null
    } finally {
      favScan = null
    }
    idx.updated = Date.now()
    favEntries = null
    await favsSet(idx)
    info(`favorites: index ${full ? 'rebuilt' : 'updated'}, ${idx.items.length - before} new, ${idx.items.length} in all`)
    setFavStatus()
    return idx
  })()
  return favScan
}

// tag, -tag, tag* (wildcard), a ~ b (either), score:>10 (also >=, <, <=, =).
export type FavMatcher = (e: FavEntry) => boolean
function favMatcher(word: string): FavMatcher {
  const score = word.match(/^score:(>=|<=|>|<|=)?(-?\d+)$/)
  if (score) {
    const n = Number(score[2])
    const op = score[1] || '>='
    return e => e.score != null && (op === '>' ? e.score > n : op === '<' ? e.score < n
      : op === '<=' ? e.score <= n : op === '=' ? e.score === n : e.score >= n)
  }
  if (word.includes('*')) {
    const re = new RegExp(`^${word.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
    return e => e.tags.some(tag => re.test(tag))
  }
  return e => e.set.has(word)
}

function favQuery(text: string): FavMatcher {
  const words = text.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const groups: Array<{ neg: boolean, any: FavMatcher[] }> = []   // every group must hold: one of `any`, or none of it when negated
  words.forEach((word, i) => {
    if (word === '~') return
    const neg = word.startsWith('-') && word.length > 1
    const matcher = favMatcher(neg ? word.slice(1) : word)
    if (!neg && words[i - 1] === '~' && groups.length && !groups[groups.length - 1].neg) groups[groups.length - 1].any.push(matcher)
    else groups.push({ neg, any: [matcher] })
  })
  return e => groups.every(g => g.any.some(m => m(e)) !== g.neg)
}

async function searchFavs() {
  const bar = document.getElementById('ibh-favsearch')
  if (!bar) return
  const fields = favFields(bar)
  const either = orGroups(fields.or.value).map(g => g.join(' ~ '))
  const text = `${fields.text.value} ${either.join(' ')}`.trim()
  let idx = await loadFavIndex()
  if (!idx.items.length) idx = (await updateFavIndex(true)) || idx
  else if (idx.next !== undefined || Date.now() - idx.updated > FAV_STALE_MS) {
    // The stored index answers now. New favorites come in behind it (one
    // page, usually) and the search runs again with them; the rest of a
    // read a reload cut short comes in too, without the rerun, which would
    // scroll back to the top a minute later.
    const had = idx.items.length
    const partial = idx.next !== undefined
    updateFavIndex(false).then(fresh => {
      if (fresh && !partial && fresh.items.length > had && favPage && bar.isConnected) searchFavs()
    })
  }
  // A full scan reads every page: the bar (and its "more" button) may have
  // gone meanwhile (favSearch switched off), and the page stays as it is.
  if (!bar.isConnected) { info('favorites search: the bar went while the index loaded'); return }
  if (!favEntries) {
    favEntries = idx.items.map(([id, thumb, tags, score]) => {
      const list = tags.toLowerCase().split(/\s+/)
      // The kind, from the tags as the covers read it (an untagged video
      // passes for an image here too).
      const spaced = ` ${tags} `
      const video = NATIVE_REAL_VIDEO.test(spaced)
      const gif = NATIVE_GIF.test(spaced)
      const animated = video || gif || /\sanimated\s/i.test(spaced)
      return { item: [id, thumb, tags], tags: list, set: new Set(list), score, video, gif, animated }
    })
  }
  const match = favQuery(text)
  const kind = fields.kind.value
  // kind: the select's other values are FavEntry's flags.
  const ofKind = (e: FavEntry) => kind === 'all' || (kind === 'image' ? !e.animated : e[(kind as 'video' | 'gif' | 'animated')])
  const min = Number(fields.min.value) || 0
  let found = favEntries.filter(e => ofKind(e) && (!min || (e.score != null && e.score >= min)) && match(e))
  const sort = fields.sort.value
  if (sort === 'old') found = found.reverse()
  else if (sort === 'score') found = [...found].sort((a, b) => (b.score ?? -1e9) - (a.score ?? -1e9))
  else if (sort === 'random') found = found.map(e => ([Math.random(), e] as [number, FavEntry])).sort((a, b) => a[0] - b[0]).map(pair => pair[1])
  showFavResults(found.map(e => e.item))
  rememberFavSearch(true)
  if (favBarSync) favBarSync()
  info(`favorites: "${text.trim()}" (${kind}, ${sort}${min ? `, score >= ${min}` : ''}) -> ${found.length} of ${favEntries.length}`)
}

// The site's own thumbnail markup, so every feature treats it like one.
function favThumb([id, thumb, tags]: FavEntry['item']) {
  const span = document.createElement('span')
  span.className = 'thumb'
  span.id = `s${id}`
  const a = document.createElement('a')
  a.id = `p${id}`
  a.href = `index.php?page=post&s=view&id=${id}`
  const img = document.createElement('img')
  img.src = thumb
  img.title = img.alt = tags
  img.className = 'preview'
  a.appendChild(img)
  span.appendChild(a)
  return span
}

// The site's own paginators, hidden while results stand in for the page:
// divs of its HTML.
const sitePaginators = () => (document.querySelectorAll('#paginator, .pagination') as NodeListOf<HTMLElement>)

function showFavResults(items: Array<FavEntry['item']>) {
  const list = document.querySelector(LIST)
  if (!list) return
  if (!favPage) favPage = [...list.childNodes]   // put back on Clear
  favResults = items
  favShown = 0
  list.replaceChildren()
  sitePaginators().forEach(p => { p.style.display = 'none' })
  showMoreFavs()
  window.scrollTo({ top: list.getBoundingClientRect().top + window.scrollY - 80 })
}

function showMoreFavs() {
  const list = document.querySelector(LIST)
  if (!list) return
  const next = favResults.slice(favShown, favShown + FAV_SHOW)
  list.append(...next.map(favThumb))
  favShown += next.length
  // Made with the favorites bar, which searchFavs saw still there after its
  // last await, and its own click handler.
  const more = document.getElementById('ibh-favmore') as HTMLElement
  more.hidden = favShown >= favResults.length
  more.textContent = `${t('favMore')} (${favResults.length - favShown})`
  setFavStatus(`${favResults.length} ${t('favResults')}`)
}

function clearFavSearch() {
  const list = document.querySelector(LIST)
  if (list && favPage) list.replaceChildren(...favPage)
  favPage = null
  favResults = []
  sitePaginators().forEach(p => { p.style.display = '' })
  const more = document.getElementById('ibh-favmore')
  if (more) more.hidden = true
  const bar = document.getElementById('ibh-favsearch')
  if (bar) { const f = favFields(bar); f.text.value = ''; f.or.value = '' }
  rememberFavSearch(false)
  if (favBarSync) favBarSync()
  setFavStatus()
}

function setFavStatus(text?: string) {
  const st = document.querySelector('#ibh-favsearch .st')
  if (!st) return
  const line = st.firstChild as Text   // ensureFavSearch puts a text node first
  if (text) { line.textContent = text; return }
  const idx = favIndex
  line.textContent = idx && idx.items.length
    ? `${idx.items.length} ${t('favIndexed')} · ${idx.next !== undefined ? t('favPartial') : new Date(idx.updated).toLocaleString(LANG)}`
    : t('favNever')
}

// Idempotent: the observer calls it on every change of the page.
export function ensureFavSearch() {
  const bar = document.getElementById('ibh-favsearch')
  const want = CFG.favSearch && SITE === 'rule34.xxx' && onOwnFavorites() && !!document.querySelector(LIST)
  if (!want) { if (bar) { clearFavSearch(); bar.remove(); document.getElementById('ibh-favmore')?.remove() } return }
  if (bar) return
  const list = document.querySelector(LIST) as Element   // want found it
  const input = el('input', { type: 'search', placeholder: t('favPlaceholder'), enterkeyhint: 'search' })
  input.setAttribute('autocapitalize', 'off')
  input.setAttribute('autocomplete', 'off')
  attachSuggest(input)
  const or = orInput()
  const kind = kindSelect()
  const sort = el('select', { class: 'sort' })
  for (const [value, label] of [['new', t('favSortNew')], ['old', t('favSortOld')], ['score', t('favSortScore')], ['random', t('favSortRandom')]]) {
    sort.appendChild(el('option', { value, text: label }))
  }
  const min = minScoreInput()
  const go = el('button', { type: 'button', text: t('favGo') })
  const clear = el('button', { type: 'button', text: t('favClear') })
  const update = el('a', { href: '#', text: t('favUpdate') })
  const rebuild = el('a', { href: '#', text: t('favRebuild') })
  const st = el('div', { class: 'st' }, [document.createTextNode(''), ' · ', update, ' · ', rebuild])
  const read = () => ({ where: 'fav', text: input.value, or: or.value, kind: kind.value, sort: sort.value, min: min.value })
  const saved = savedControls('fav', read, q => {
    input.value = q.text; or.value = q.or || ''; kind.value = q.kind; sort.value = q.sort; min.value = q.min || ''
    searchFavs()
  })
  const box = el('div', { id: 'ibh-favsearch', class: 'ibh-search' }, [input, or, kind, sort, min, go, clear, saved.star, saved.pick, saved.recentPick, st])
  favBarSync = saved.sync
  favBarReload = saved.reload
  list.before(box)
  const more = el('button', { type: 'button', id: 'ibh-favmore' })
  more.hidden = true
  list.after(more)
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); searchFavs() } })
  go.addEventListener('click', () => searchFavs())
  sort.addEventListener('change', () => { if (favPage) searchFavs() })
  kind.addEventListener('change', () => searchFavs())   // a kind alone is a search: every video, every GIF…
  min.addEventListener('change', () => searchFavs())
  min.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); min.blur() } })
  clear.addEventListener('click', () => clearFavSearch())
  more.addEventListener('click', () => showMoreFavs())
  update.addEventListener('click', ev => { ev.preventDefault(); updateFavIndex(false) })
  rebuild.addEventListener('click', ev => { ev.preventDefault(); updateFavIndex(true) })
  input.addEventListener('input', saved.sync)
  or.addEventListener('input', saved.sync)
  or.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); or.blur(); searchFavs() } })
  min.addEventListener('input', saved.sync)
  // The last search comes back, results included, until Clear.
  searchStore().then(store => {
    const last = store.favLast
    if (!last || !last.active || !document.getElementById('ibh-favsearch')) return
    input.value = last.text || ''; or.value = last.or || ''; kind.value = last.kind || 'all'; sort.value = last.sort || 'new'; min.value = last.min || ''
    saved.sync()
    searchFavs()
  })
  loadFavIndex().then(idx => {
    setFavStatus()
    // New favorites since the last visit come in quietly (usually one page),
    // and a read a reload cut short goes on.
    if (idx.items.length && (idx.next !== undefined || Date.now() - idx.updated > FAV_STALE_MS)) updateFavIndex(false)
  })
  info('favorites search bar added')
}

// OR field: tags typed apart by spaces become one either-of group, the
// site's ( a ~ b ~ c ), or a ~ b for the favorites search; || starts
// another group: a b || c d is ( a ~ b ) ( c ~ d ).
export function orInput() {
  const field = el('input', { class: 'or', type: 'search', placeholder: t('orPlaceholder'), enterkeyhint: 'search' })
  field.setAttribute('autocapitalize', 'off')
  field.setAttribute('autocomplete', 'off')
  attachSuggest(field)
  return field
}
