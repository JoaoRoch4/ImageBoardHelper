import { LIST } from '../core/site'
import { CFG } from '../core/config'
import { t } from '../core/i18n'
import { dbg, info } from '../core/log'
import { storeGet, storeSet } from '../storage/storage'
import { orInput } from '../lists/favorites'
import { attachSuggest, kindSelect, minScoreInput, orGroups, orTags } from './suggest'
import { onFavoritesPage } from '../lists/autopager'
import { el } from '../panel/panel'

// ── Saved searches ──
// Every search a bar runs is kept on its own among the recent ones; ☆
// makes one a favorite. The favorites bar also keeps its last search, shown
// again on the next visit until Clear. Stored with the lists as
// { saved (the favorites), recent, favLast }.
const RECENT_MAX = 15   // per bar

// A search as a bar holds it (where: 'fav' or 'site'); active: the favorites
// bar's last one is on show.
export type Search = { where: string, text: string, or?: string, kind: string, sort: string, min?: string, active?: boolean }
export type SearchStore = { saved: Search[], recent: Search[], favLast: Omit<Search, 'where'> | null }
export async function searchStore(): Promise<SearchStore> {
  const v = await storeGet('searches')
  const ok = v && typeof v === 'object' && !Array.isArray(v)
  return { saved: (ok && v.saved) || [], recent: (ok && v.recent) || [], favLast: (ok && v.favLast) || null }
}

// Nothing typed and no filter: not worth keeping.
const emptySearch = (q: Search) => !q.text.trim() && !orGroups(q.or).length && q.kind === 'all' && !q.min && q.sort === 'new'

export function addRecent(store: SearchStore, q: Search) {
  if (emptySearch(q)) return
  const key = searchKey(q)
  store.recent = [q, ...store.recent.filter(other => searchKey(other) !== key)]
  const mine = store.recent.filter(other => other.where === q.where)
  if (mine.length > RECENT_MAX) store.recent = store.recent.filter(other => !mine.slice(RECENT_MAX).includes(other))
}

export const searchKey = (q: Search) => [q.where, q.text.trim().replace(/\s+/g, ' '), orGroups(q.or).map(g => g.join(' ')).join(' || '), q.kind, q.sort, String(q.min || '')].join('|')

function searchLabel(q: Search) {
  const kinds: Record<string, string> = { image: t('favKindImage'), video: t('favKindVideo'), gif: t('favKindGif'), animated: t('favKindAnimated') }
  const orders: Record<string, string> = { score: t('favSortScore'), random: t('favSortRandom'), old: t('favSortOld') }
  const or = orGroups(q.or)
  return [q.text.trim() || (or.length ? '' : t('savedAll')), or.map(g => `( ${g.join(' | ')} )`).join(' '), kinds[q.kind], q.min ? `≥ ${q.min}` : '', orders[q.sort] || '']
    .filter(Boolean).join(' · ')
}

// The two pick lists (favorites, recent) and the ☆ button for a bar:
// read() gives its search, apply() fills it in and runs it.
export function savedControls(where: string, read: () => Search, apply: (q: Search) => void) {
  const pick = el('select', { class: 'saved' })
  const recentPick = el('select', { class: 'saved' })
  const star = el('button', { type: 'button', class: 'star' })
  let saved: Search[] = []
  let recent: Search[] = []
  const sync = () => {
    const on = saved.some(q => searchKey(q) === searchKey(read()))
    star.textContent = t(on ? 'savedSearch' : 'saveSearch')
    star.classList.toggle('on', on)
  }
  const fillOne = (select: HTMLSelectElement, list: Search[], title: 'savedPick' | 'recentPick') => {
    const mine = list.filter(q => q.where === where)
    select.replaceChildren(el('option', { value: '', text: t(title) }), ...mine.map((q, i) => el('option', { value: String(i), text: searchLabel(q) })))
    select.hidden = !mine.length
  }
  const fill = () => {
    fillOne(pick, saved, 'savedPick')
    fillOne(recentPick, recent, 'recentPick')
    sync()
  }
  const reload = async () => { const store = await searchStore(); saved = store.saved; recent = store.recent; fill() }
  const onPick = (select: HTMLSelectElement, source: () => Search[]) => select.addEventListener('change', () => {
    const q = source().filter(other => other.where === where)[Number(select.value)]
    select.value = ''
    if (q) apply(q)
  })
  onPick(pick, () => saved)
  onPick(recentPick, () => recent)
  star.addEventListener('click', async () => {
    const store = await searchStore()
    const q = read()
    const i = store.saved.findIndex(other => searchKey(other) === searchKey(q))
    if (i >= 0) store.saved.splice(i, 1)
    else store.saved.unshift(q)
    await storeSet('searches', store)
    info(`search ${i >= 0 ? 'removed from' : 'saved in'} the ${where} list: ${searchLabel(q)}`)
    saved = store.saved
    fill()
  })
  reload()
  return { pick, recentPick, star, sync, reload }
}

// A search the site bar finds in the address (typed, or a tag link) is a recent one.
async function recordSiteSearch(q: Search) {
  if (emptySearch(q)) return
  const store = await searchStore()
  addRecent(store, q)
  await storeSet('searches', store)
}

// ── Search bar on site pages ──
// The favorites bar's look on the site's listing pages, built on the site's
// own search: the kind becomes tags, the minimum score score:>=N, the order
// sort:score, and the bar reads them back from the address, so it always
// shows the search on screen.
const KIND_QUERY: Record<string, string> = {
  image: '-animated -video -gif',
  video: 'video',
  gif: '( gif ~ animated_gif )',
  animated: '( animated ~ video ~ gif )',
}

function readSiteQuery(tags: string) {
  let rest = ` ${tags.trim().replace(/\s+/g, ' ')} `
  let kind = 'all'
  for (const [k, q] of Object.entries(KIND_QUERY)) {
    if (rest.includes(` ${q} `)) { kind = k; rest = rest.replace(` ${q} `, ' '); break }
  }
  // The ( a ~ b ) groups left after the kind go to the OR field, apart by ||.
  // The lookahead leaves the space after a group for the next one to start with.
  const groups: string[] = []
  rest = rest.replace(/ \( ([^()]+?) \)(?= )/g, (m, inner) => {
    if (!/ ~ /.test(` ${inner} `)) return m
    groups.push(orTags(inner).join(' '))
    return ''
  })
  const or = groups.join(' || ')
  let sort = 'new'
  rest = rest.replace(/ sort:score(?::desc)? /i, () => { sort = 'score'; return ' ' })
  rest = rest.replace(/ sort:random /i, () => { sort = 'random'; return ' ' })
  let min = ''
  rest = rest.replace(/ score:>=?(\d+) /i, (m, n) => { min = n; return ' ' })
  return { rest: rest.trim(), kind, sort, min, or }
}

function siteQuery({ rest, kind, sort, min, or }: { rest: string, kind: string, sort: string, min?: string, or?: string }) {
  const either = orGroups(or).map(g => g.length > 1 ? `( ${g.join(' ~ ')} )` : g[0]).join(' ')
  return [rest, either, KIND_QUERY[kind] || '', min ? `score:>=${min}` : '', sort === 'score' ? 'sort:score' : sort === 'random' ? 'sort:random' : '']
    .filter(Boolean).join(' ')
}

// Idempotent: the observer calls it on every change of the page.
// The home page's own search form (Gelbooru 0.2: a form with a tags field).
const homeSearchForm = () => {
  if (new URLSearchParams(location.search).get('page')) return null   // not the home page
  const field = document.querySelector('form input[name="tags"]')
  return field ? field.closest('form') : null
}

export function ensureSiteSearch() {
  const bar = document.getElementById('ibh-sitesearch')
  const home = homeSearchForm()
  const listing = new URLSearchParams(location.search).get('page') === 'post' && !!document.querySelector(LIST)
  const want = CFG.siteSearch && !onFavoritesPage() && (listing || !!home)
  if (!want) {
    if (bar) bar.remove()
    if (home) home.style.display = ''   // the site's own box comes back
    return
  }
  if (bar) return
  const now = readSiteQuery(new URLSearchParams(location.search).get('tags') || '')
  const input = el('input', { type: 'search', placeholder: t('sitePlaceholder'), enterkeyhint: 'search' })
  input.setAttribute('autocapitalize', 'off')
  input.setAttribute('autocomplete', 'off')
  attachSuggest(input)
  input.value = now.rest === 'all' ? '' : now.rest
  const or = orInput()
  or.value = now.or
  const kind = kindSelect()
  kind.value = now.kind
  const sort = el('select', { class: 'sort' })
  for (const [value, label] of [['new', t('favSortNew')], ['score', t('favSortScore')], ['random', t('favSortRandom')]]) sort.appendChild(el('option', { value, text: label }))
  sort.value = now.sort
  const min = minScoreInput()
  min.value = now.min
  const go = el('button', { type: 'button', text: t('favGo') })
  const read = () => ({ where: 'site', text: input.value, or: or.value, kind: kind.value, sort: sort.value, min: min.value })
  const saved = savedControls('site', read, q => {
    input.value = q.text; or.value = q.or || ''; kind.value = q.kind; sort.value = q.sort; min.value = q.min || ''
    submit()
  })
  const box = el('div', { id: 'ibh-sitesearch', class: 'ibh-search' }, [input, or, kind, sort, min, go, saved.star, saved.pick, saved.recentPick])
  if (home) {
    // In place of the home page's plain box, which hides.
    home.before(box)
    home.style.display = 'none'
  } else {
    const list = document.querySelector(LIST) as Element   // no home box: a listing, so want found it
    list.before(box)
  }
  recordSiteSearch(read()).then(saved.reload)
  input.addEventListener('input', saved.sync)
  or.addEventListener('input', saved.sync)
  min.addEventListener('input', saved.sync)
  const submit = () => {
    const q = siteQuery({ rest: input.value, or: or.value, kind: kind.value, sort: sort.value, min: min.value })
    info(`site search: ${q || 'all'}`)
    location.href = `index.php?page=post&s=list&tags=${encodeURIComponent(q || 'all').replace(/%20/g, '+')}`
  }
  for (const field of [input, or, min]) field.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); submit() } })
  go.addEventListener('click', submit)
  // The kind and the order wait for Search or Enter: other fields may follow.
  kind.addEventListener('change', saved.sync)
  sort.addEventListener('change', saved.sync)
  dbg('site search bar added')
}
