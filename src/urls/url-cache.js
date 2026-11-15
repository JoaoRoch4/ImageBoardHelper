import { SITE } from '../core/site'
import { CFG, readJSON, writeJSON } from '../core/config'
import { dbg, describeError, warn } from '../core/log'
import { thumbParts } from './hosts'

// ═══════════════════════════════════════════════════════════
// URL cache
//
// Firefox's HTTP cache already keeps the bytes. What the script kept losing
// was which candidate URL won: every re-upgrade (memory saver, modal unload)
// walked the whole ladder again — jpg/png/jpeg, a dozen video hosts for a GIF
// labelled as video, an .mp4 sniff on every modal open. This remembers the
// winning URL per kind and file hash, and "nothing loads" for a day.
//
// Two places keep it: localStorage the newest URLCACHE_MAX, read in one go
// before the first thumbnail, and the site's IndexedDB every entry, up to
// URLIDX_MAX, read for the cards as they are scanned, before they scroll
// in (urlPrefetch). Free memory keeps both: they are what brings the cards
// back in one request each.
// ═══════════════════════════════════════════════════════════

const URLCACHE_KEY = `IBH_URLCACHE_${SITE}`
const URLCACHE_MAX = 1500
const URLCACHE_TTL = 30 * 24 * 60 * 60 * 1000   // a winning URL
const URLCACHE_NEG_TTL = 24 * 60 * 60 * 1000    // "nothing loads": short, a CDN hiccup must not stick
export const urlStats = { hits: 0, misses: 0, healed: 0 }
// An entry: u the winning URL (null: nothing loads), t when it was written,
// and for a miss f when it was first seen and n how many times.
/** @typedef {{ u: string | null, t: number, f?: number, n?: number }} UrlCacheEntry */
/** @typedef {Record<string, UrlCacheEntry>} UrlCache  kind:hash -> entry */
/** @type {UrlCache | null} */
let urlCache = null
/** @type {number} */
let urlCacheTimer = 0

// The IndexedDB side. A database of its own: a new store in 'ibh' would
// need a version change, which a tab still on an older version blocks. A
// script that clears localStorage leaves it alone.
const URLIDX_MAX = 20000
const URL_KINDS = ['sample', 'orig', 'gif', 'video', 'poster']
// When the last batch that reached IndexedDB was taken: newer entries in
// localStorage may have missed it (a write cut short by leaving the page).
const URLIDX_SYNC_KEY = `IBH_URLIDX_SYNC_${SITE}`
/** @type {Promise<IDBDatabase | null> | null} */
let urlDbOpen = null
/** @type {Map<string, UrlCacheEntry | null>} */
const urlDirty = new Map()   // kind:hash -> entry to write, or null to delete, until the next flush
/** @type {Set<string>} */
const urlAsked = new Set()   // hashes already read, or being read, from IndexedDB
/** @type {Set<string>} */
const urlWanted = new Set()  // hashes for the next batched read
let urlGen = 0               // bumped by a clear: reads started before it drop their answer
/** @type {Set<string>} */
const urlInFlight = new Set()   // hashes asked of IndexedDB, not answered yet
/** @type {Promise<void> | null} */
export let urlReading = null           // the batch in flight, or its URLIDX_WAIT_MS if that comes first
// A card on screen at load is scanned and wanted in the same moment: its
// upgrade, GIF or cover waits this long at most for IndexedDB's answer
// (a few ms to tens on the phone) rather than walk a ladder it may know.
const URLIDX_WAIT_MS = 400

/** @param {UrlCacheEntry} entry */
const expired = entry => Date.now() - entry.t >= (entry.u === null ? URLCACHE_NEG_TTL : URLCACHE_TTL)

// Auto-delete: expired entries go on load and on every write, not only when
// read again, so files never seen again do not linger.
// Only called with the cache loaded.
function dropExpired() {
  let n = 0
  for (const k of Object.keys(/** @type {UrlCache} */ (urlCache)))
    if (expired(/** @type {UrlCache} */ (urlCache)[k])) { delete /** @type {UrlCache} */ (urlCache)[k]; n++ }
  return n
}

/** @returns {UrlCache} */
export function loadUrlCache() {
  if (!urlCache) {
    urlCache = /** @type {UrlCache} */ (readJSON(URLCACHE_KEY, {}) || {})
    if (dropExpired()) scheduleUrlFlush()
    syncUrlIndex(urlCache)
  }
  return urlCache
}

// An entry written: in memory now, in both stores at the next flush.
/** @param {string} key @param {UrlCacheEntry} entry */
function putUrl(key, entry) {
  /** @type {UrlCache} */ (urlCache)[key] = entry
  urlDirty.set(key, entry)
  scheduleUrlFlush()
}

// A miss counts only when it repeats at least a minute later: a Wi-Fi
// handoff fails every ladder in flight at once, and a single run of misses
// must not hide a real file for a day.
const MISS_CONFIRM_MS = 60 * 1000

/**
 * A URL string, null for a confirmed miss, or undefined when nothing usable is cached.
 * @param {string} kind
 * @param {string | undefined} hash
 * @returns {string | null | undefined}
 */
export function cacheGet(kind, hash) {
  if (!CFG.urlCache || !hash) return undefined
  const key = `${kind}:${hash}`
  const entry = loadUrlCache()[key]
  if (entry && !expired(entry)) {
    if (entry.u === null && (entry.n || 1) < 2) { urlStats.misses++; return undefined }   // unconfirmed miss
    urlStats.hits++
    return entry.u
  }
  if (entry) { delete /** @type {UrlCache} */ (urlCache)[key]; scheduleUrlFlush() }
  urlStats.misses++
  return undefined
}

/**
 * Record the outcome of a ladder. Only definitive ones: a winner, or "none loads".
 * @param {string} kind
 * @param {string | undefined} hash
 * @param {string | null} url
 * @param {string | null} [previous]  what cacheGet gave before the ladder
 */
export function cacheSet(kind, hash, url, previous) {
  if (!CFG.urlCache || !hash) return
  const key = `${kind}:${hash}`
  const old = loadUrlCache()[key]
  const now = Date.now()
  if (url === null) {
    if (navigator.onLine === false) return   // offline: says nothing about the file
    if (old && old.u === null) {
      // Second miss: confirmed once it comes a minute or more after the first.
      if (!old.n || old.n < 2) {
        if (now - (old.f || old.t) < MISS_CONFIRM_MS) return
        putUrl(key, { u: null, t: now, f: old.f || old.t, n: 2 })
      }
      return
    }
    putUrl(key, { u: null, t: now, f: now, n: 1 })
    return
  }
  if (previous && url !== previous) urlStats.healed++   // the cached one had stopped working
  // Same winner seen again recently: nothing new to save. Covers remount
  // often, and re-serialising the cache each time would cost while scrolling.
  if (old && old.u === url && now - old.t < URLCACHE_NEG_TTL) return
  putUrl(key, { u: url, t: now })
}

// The cached winner goes first; if it fails, the full ladder runs behind it.
/** @param {string[]} urls @param {string | null | undefined} cached */
export const cachedFirst = (urls, cached) => typeof cached === 'string' ? [cached, ...urls.filter(u => u !== cached)] : urls

// One file's remembered miss gone from both stores, so its ladder runs
// again (a GIF held to rebuild it). A winner stays: it is still the file.
/** @param {string} kind @param {string | undefined} hash */
export function forgetMiss(kind, hash) {
  if (!CFG.urlCache || !hash) return
  const key = `${kind}:${hash}`
  const entry = loadUrlCache()[key]
  if (entry && entry.u !== null) return
  delete /** @type {UrlCache} */ (urlCache)[key]
  urlDirty.set(key, null)   // IndexedDB may hold it even when memory does not
  scheduleUrlFlush()
}

// Writes are batched: serialising the cache on every swap would stutter the scroll.
function scheduleUrlFlush() {
  if (!urlCacheTimer) urlCacheTimer = setTimeout(flushUrlCache, 3000)
}

/** @param {string[]} keys */
const newestFirst = keys => keys.sort((a, b) => /** @type {UrlCache} */ (urlCache)[b].t - /** @type {UrlCache} */ (urlCache)[a].t)

/** @param {string[]} keys */
const pickUrls = keys => /** @type {UrlCache} */ (Object.fromEntries(keys.map(k => [k, /** @type {UrlCache} */ (urlCache)[k]])))

let lastLoggedHits = -1
export function flushUrlCache() {
  clearTimeout(urlCacheTimer)
  urlCacheTimer = 0
  if (!urlCache) return
  dropExpired()
  // localStorage takes the newest only. Memory keeps the rest: entries read
  // from IndexedDB for this page are old by date, and trimming them here
  // would drop them before their cards scroll in.
  const newest = newestFirst(Object.keys(urlCache)).slice(0, URLCACHE_MAX)
  if (!writeJSON(URLCACHE_KEY, pickUrls(newest))) {
    // Storage full: the newer half, once more.
    if (!writeJSON(URLCACHE_KEY, pickUrls(newest.slice(0, Math.floor(newest.length / 2))))) warn('url cache: could not save it')
  }
  flushUrlIndex()
  if (urlStats.hits !== lastLoggedHits) {
    lastLoggedHits = urlStats.hits
    dbg(`url cache: ${urlStats.hits} hits, ${urlStats.misses} misses, ${urlStats.healed} healed, ${Object.keys(urlCache).length} entries`)
  }
}

/** @param {boolean} missesOnly */
export function clearUrlCache(missesOnly) {
  const c = loadUrlCache()
  let n = 0
  for (const k of Object.keys(c)) if (!missesOnly || c[k].u === null) { delete c[k]; n++ }
  clearUrlIndex(missesOnly)
  flushUrlCache()
  return n
}

// Resolves null where IndexedDB is not available (then localStorage alone,
// as before 1.16.4).
/** @returns {Promise<IDBDatabase | null>} */
export function urlDb() {
  if (!urlDbOpen) {
    urlDbOpen = new Promise(resolve => {
      try {
        const req = indexedDB.open('ibh-urls', 1)
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore('urls')
          store.createIndex('t', 't')   // the oldest go first past URLIDX_MAX
          store.createIndex('m', 'm')   // misses only (m: 1), for ↻ and their short life
        }
        req.onsuccess = () => {
          const db = req.result
          // Made by something else, without the store: left alone.
          if (!db.objectStoreNames.contains('urls')) { db.close(); resolve(null); return }
          // A later version may need it upgraded; the next call opens it again.
          db.onversionchange = () => { db.close(); urlDbOpen = null }
          resolve(db)
        }
        req.onerror = () => resolve(null)
      } catch (e) {
        resolve(null)
      }
    })
  }
  return urlDbOpen
}

// One transaction on the index store; resolves once it completes.
/**
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => void} work
 * @returns {Promise<boolean>} false without IndexedDB or when it failed
 */
async function urlTx(mode, work) {
  const db = await urlDb()
  if (!db) return false
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('urls', mode)
      work(tx.objectStore('urls'))
      tx.oncomplete = resolve
      tx.onerror = tx.onabort = () => reject(tx.error)
    })
    return true
  } catch (e) {
    dbg(`url index: ${mode} failed — ${describeError(e)}`)
    return false
  }
}

// A card's thumbnail, as the card is scanned: its entries come from
// IndexedDB with the others of the same scan, in one transaction.
/** @param {string | null | undefined} src */
export function urlPrefetch(src) {
  if (!CFG.urlCache) return
  const hash = (thumbParts(src) || {}).hash
  if (!hash || urlAsked.has(hash)) return
  urlAsked.add(hash)
  urlInFlight.add(hash)
  urlWanted.add(hash)
  if (urlWanted.size > 1) return   // joins the batch already on its way
  // A microtask, not a timer: it still runs after the rest of this scan has
  // joined, and a timer waits behind the page's loading (~0.15 s measured).
  /** @type {Promise<void>} */
  const batch = new Promise(resolve => queueMicrotask(() => readWanted().then(resolve)))
  const capped = Promise.race([batch, new Promise(resolve => setTimeout(resolve, URLIDX_WAIT_MS))])
  urlReading = /** @type {Promise<void>} */ (capped)
  capped.then(() => { if (urlReading === capped) urlReading = null })
}

// What to wait for before a ladder for this kind and hash: the read in
// flight, when it may bring an entry memory does not have yet; else null.
/** @param {string} kind @param {string | undefined} hash */
export function urlPending(kind, hash) {
  if (!urlReading || !hash || !urlInFlight.has(hash)) return null
  return urlCache && urlCache[`${kind}:${hash}`] ? null : urlReading
}

async function readWanted() {
  const hashes = [...urlWanted]
  urlWanted.clear()
  try {
    await readUrls(hashes)
  } finally {
    for (const hash of hashes) urlInFlight.delete(hash)
  }
}

/** @param {string[]} hashes */
async function readUrls(hashes) {
  const gen = urlGen
  /** @type {Array<[string, UrlCacheEntry & { m?: number }]>} */
  const found = []
  const ok = await urlTx('readonly', store => {
    for (const hash of hashes) {
      for (const kind of URL_KINDS) {
        const key = `${kind}:${hash}`
        const req = store.get(key)
        req.onsuccess = () => { if (req.result) found.push([key, req.result]) }
      }
    }
  })
  if (!ok || gen !== urlGen) return   // a clear came in between
  const c = loadUrlCache()
  let n = 0
  for (const [key, stored] of found) {
    // Written here since the read began, or newer in memory: that one stands.
    if (expired(stored) || urlDirty.has(key) || (c[key] && c[key].t >= stored.t)) continue
    const entry = { ...stored }
    delete entry.m   // the misses' index mark, IndexedDB's only
    c[key] = entry
    n++
  }
  if (n) dbg(`url index: ${n} entries from IndexedDB for ${hashes.length} thumbnails`)
}

// Pending writes in one transaction. The batch's time is noted once it is
// in: what localStorage holds past it may not have reached IndexedDB.
async function flushUrlIndex() {
  if (!urlDirty.size) return
  const batch = [...urlDirty]
  urlDirty.clear()
  const taken = Date.now()
  const ok = await urlTx('readwrite', store => {
    for (const [key, entry] of batch) {
      if (entry) store.put(entry.u === null ? { ...entry, m: 1 } : entry, key)
      else store.delete(key)
    }
  })
  if (ok) writeJSON(URLIDX_SYNC_KEY, taken)
}

// Once per page: localStorage entries newer than the last batch in go to
// IndexedDB (all of them the first time, when nothing was ever sent), and
// a moment later the index sweeps itself.
/** @param {UrlCache} c */
function syncUrlIndex(c) {
  if (!CFG.urlCache) return
  const since = Number(readJSON(URLIDX_SYNC_KEY, 0)) || 0
  // >=: an entry written in the same millisecond the last batch was taken missed it.
  for (const [key, entry] of Object.entries(c)) if (entry.t >= since && !urlDirty.has(key)) urlDirty.set(key, entry)
  if (urlDirty.size) scheduleUrlFlush()
  setTimeout(sweepUrlIndex, 20000)
}

// Expired entries out (misses after a day, winners after 30), then the
// oldest past URLIDX_MAX, one step after the other in one transaction.
function sweepUrlIndex() {
  if (!CFG.urlCache) return
  const now = Date.now()
  let dropped = 0
  /**
   * Deletes what the cursor walks over, while drop() says so; then next().
   * @param {IDBRequest<IDBCursorWithValue | null>} req
   * @param {(value: UrlCacheEntry) => boolean} drop
   * @param {() => void} [next]
   */
  const walk = (req, drop, next) => {
    req.onsuccess = () => {
      const cur = req.result
      if (!cur) { if (next) next(); return }
      if (!drop(cur.value)) { if (next) next(); return }
      cur.delete()
      dropped++
      cur.continue()
    }
  }
  urlTx('readwrite', store => {
    const byAge = store.index('t')
    /** @param {IDBRequest<IDBCursorWithValue | null>} req */
    const expiredMisses = req => {
      req.onsuccess = () => {
        const cur = req.result
        if (!cur) { oldOnes(); return }
        if (expired(cur.value)) { cur.delete(); dropped++ }
        cur.continue()
      }
    }
    // Older than a winner lives: every one of them has expired.
    const oldOnes = () => walk(byAge.openCursor(IDBKeyRange.upperBound(now - URLCACHE_TTL)), () => true, overCap)
    const overCap = () => {
      const count = store.count()
      count.onsuccess = () => {
        let over = count.result - URLIDX_MAX
        if (over > 0) walk(byAge.openCursor(), () => over-- > 0)
      }
    }
    expiredMisses(store.index('m').openCursor())
  }).then(ok => { if (ok && dropped) dbg(`url index: ${dropped} old entries dropped`) })
}

// For __ibh.urlIndex(): what the IndexedDB side holds; null without it.
export async function urlIndexStats() {
  let entries = 0
  let misses = 0
  const ok = await urlTx('readonly', store => {
    const all = store.count()
    all.onsuccess = () => { entries = all.result }
    const m = store.index('m').count()
    m.onsuccess = () => { misses = m.result }
  })
  return ok ? { entries, misses, max: URLIDX_MAX } : null
}

// The clear behind clearUrlCache: reads in flight drop their answer, and
// writes not sent yet go too, or they would bring the cleared back.
/** @param {boolean} missesOnly */
function clearUrlIndex(missesOnly) {
  urlGen++
  // A hash whose read this drops may be asked again. Cards already scanned
  // are not asked again: what they miss, their ladder writes back.
  urlAsked.clear()
  for (const [key, entry] of urlDirty) if (!missesOnly || (entry && entry.u === null)) urlDirty.delete(key)
  urlTx('readwrite', store => {
    if (!missesOnly) { store.clear(); return }
    const req = store.index('m').openCursor()
    req.onsuccess = () => {
      const cur = req.result
      if (!cur) return
      cur.delete()
      cur.continue()
    }
  })
}
