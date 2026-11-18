// The settings' copies and the lists' storage: GM storage, the site's
// IndexedDB, the move from the old storage bridge.
import type { Config } from '../core/config'
import type { LaterItem } from '../lists/later'
import { CFG, CFG_FOUND, CFG_KEY, NEEDS_RELOAD, readJSON, writeJSON } from '../core/config'
import { describeError, info, warn } from '../core/log'
import { LATER_MAX } from '../lists/later'
import { searchKey } from '../search/site-search'

export function setCfg<K extends keyof Config>(key: K, value: Config[K]) {
  CFG[key] = value
  writeJSON(CFG_KEY, CFG)
  // The copies (see restoreCfg); not yet reachable this early in the boot.
  try { backupCfg() } catch (e) { /* the boot copy in restoreCfg covers it */ }
  info(`option ${key} = ${value}${NEEDS_RELOAD.has(key) ? ' (reload the page)' : ''}`)
}

// ── Storage ──
// The lists (Watch later, the favorites index, saved searches) and a copy
// of the settings live in Violentmonkey's storage, on the device, out of
// reach of anything that clears the site's data. Where GM storage is
// missing (another userscript manager), the site's IndexedDB holds them.
export const GM_STORE = typeof GM_getValue === 'function' && typeof GM_setValue === 'function'
export type StoreKey = 'later' | 'favs' | 'cfg' | 'searches'
export const STORE_KEYS: StoreKey[] = ['later', 'favs', 'cfg', 'searches']   // also what the storage bridge held (moveIn)
// An empty list or object counts as nothing stored.
const hasData = (v: unknown) => v != null && (typeof v !== 'object' || (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0))

// A copy of the settings in Violentmonkey and in the site's IndexedDB:
// both outlive localStorage.clear() (another script's reset cleared
// localStorage and the settings with it).
function backupCfg() {
  const copy = JSON.parse(JSON.stringify(CFG))
  idbSet('cfg', copy)
  if (GM_STORE && JSON.stringify(GM_getValue('cfg', null)) !== JSON.stringify(copy)) GM_setValue('cfg', copy)
}

// Settings gone from localStorage come back from a copy, and the page
// reloads once so every option applies from the start. Settings still
// there refresh the copies.
export async function restoreCfg() {
  if (CFG_FOUND) { backupCfg(); return }
  await storeReady()   // the first run may still be bringing the copy over
  let saved = GM_STORE ? GM_getValue('cfg', null) : null
  if (!hasData(saved)) saved = await idbGet('cfg')
  if (!hasData(saved) || typeof saved !== 'object') return
  try {
    if (sessionStorage.getItem('IBH_CFG_RESTORED')) return   // once: no reload loop
    sessionStorage.setItem('IBH_CFG_RESTORED', '1')
  } catch (e) { return }
  writeJSON(CFG_KEY, saved)
  warn('settings were missing from localStorage (cleared by another script?); restored from their copy, reloading')
  location.reload()
}

// ── Site storage that outlives localStorage.clear() ──
// IndexedDB of the site: a store of its own, not touched by a script that
// clears localStorage, and far roomier (the favorites index runs to MBs).
// Resolves undefined when IndexedDB is not available.
let idbOpen: Promise<IDBDatabase> | null = null

function idb(): Promise<IDBDatabase> {
  if (!idbOpen) {
    idbOpen = new Promise((resolve, reject) => {
      const req = indexedDB.open('ibh', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('kv')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return idbOpen
}

// The stored value (null when there is none), unchecked; undefined without IndexedDB.
export async function idbGet(key: string): Promise<any> {
  try {
    const db = await idb()
    return await new Promise((resolve, reject) => {
      const req = db.transaction('kv').objectStore('kv').get(key)
      req.onsuccess = () => resolve(req.result === undefined ? null : req.result)
      req.onerror = () => reject(req.error)
    })
  } catch (e) {
    return undefined
  }
}

export async function idbSet(key: string, value: unknown) {
  try {
    const db = await idb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite')
      tx.objectStore('kv').put(value, key)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    return true
  } catch (e) {
    return false
  }
}

// Without GM storage: IndexedDB, or localStorage where IndexedDB fails.
// What an older version left in localStorage moves into IndexedDB.
async function siteGet(key: string) {
  const value = await idbGet(key)
  const local = readJSON(`IBH_${key}`, null)
  if (value === undefined) return local
  if (value === null && local !== null && await idbSet(key, local)) {
    try { localStorage.removeItem(`IBH_${key}`) } catch (e) { /* ignore */ }
    return local
  }
  return value
}

async function siteSet(key: string, value: unknown) {
  if (!(await idbSet(key, value))) writeJSON(`IBH_${key}`, value)
}

// ── Moving in from the storage bridge ──
// Up to 0.64 the lists lived in a second script, the storage bridge, and
// Violentmonkey keeps each script's storage apart. Before the first read or
// write, the first run asks the bridge for them (it answers while it is
// installed) and takes what the site's own data held for the rest. Done for
// good once the bridge has answered, or after a few loads without it.
const BRIDGE_WAIT_MS = 1500
const BRIDGE_TRIES = 3
export let movedIn: Promise<void> | null = null
export function setMovedIn(v: typeof movedIn) { movedIn = v }

// The bridge's value for each key that got an answer in time.
function askBridge(keys: string[]): Promise<Record<string, any>> {
  return new Promise(resolve => {
    const got: Record<string, any> = {}
    const asked: Map<string, string> = new Map()   // request id -> key
    let seq = 0
    const ask = () => {
      for (const key of keys) {
        if (key in got) continue
        const id = `move-${++seq}`
        asked.set(id, key)
        window.dispatchEvent(new CustomEvent('ibh-store-request', { detail: JSON.stringify({ id, op: 'get', key }) }))
      }
    }
    const onReply = (ev: Event) => {
      let msg
      try { msg = JSON.parse((ev as CustomEvent<string>).detail) } catch (e) { return }   // ibh-store-reply's
      const key = msg && asked.get(msg.id)
      if (key === undefined) return
      got[key] = msg.value
      if (Object.keys(got).length === keys.length) finish()
    }
    const finish = () => {
      clearTimeout(timer)
      window.removeEventListener('ibh-store-reply', onReply)
      window.removeEventListener('ibh-store-ready', ask)
      resolve(got)
    }
    const timer = setTimeout(finish, BRIDGE_WAIT_MS)
    window.addEventListener('ibh-store-reply', onReply)
    window.addEventListener('ibh-store-ready', ask)   // it loaded after this script: ask again
    ask()
  })
}

// Two copies of the same key, as they can differ when the bridge answers
// only on a later load: everything from both, this script's own first.
// Both are stored values, unchecked.
function mergeStored(key: StoreKey, mine: any, theirs: any) {
  if (!hasData(mine)) return theirs
  const union = <T>(a: T[], b: T[], id: (x: T) => string) => {
    const seen = new Set(a.map(id))
    return [...a, ...b.filter(x => !seen.has(id(x)))]
  }
  if (key === 'later') return union(mine, theirs, (item: LaterItem) => item.href).slice(0, LATER_MAX)
  if (key === 'searches') {
    return { saved: union(mine.saved || [], theirs.saved || [], searchKey), recent: union(mine.recent || [], theirs.recent || [], searchKey),
      favLast: mine.favLast || theirs.favLast || null }
  }
  // The favorites index is a copy of the site's list: the fuller one.
  if (key === 'favs') return (theirs.items || []).length > (mine.items || []).length ? theirs : mine
  return mine
}

async function moveIn() {
  const tries = GM_getValue('movedIn', 0)
  if (tries === true) return
  const bridge = await askBridge(STORE_KEYS)
  const answered = Object.keys(bridge).length > 0
  for (const key of STORE_KEYS) {
    const mine = GM_getValue(key, null)
    if (key === 'cfg' && hasData(mine)) continue   // the live settings are newer (backupCfg)
    let theirs = bridge[key]
    let from = 'the storage bridge'
    // The site's own data on the first try only: later ones look for the bridge.
    // (Not the favorites index: the site's IndexedDB is its home now, favsGet.)
    if (!hasData(theirs) && tries === 0 && key !== 'favs') { theirs = await siteGet(key); from = 'the site’s data' }
    if (!hasData(theirs)) continue
    GM_setValue(key, mergeStored(key, mine, theirs))
    info(`storage: ${key} moved in from ${from}`)
  }
  GM_setValue('movedIn', answered || tries + 1 >= BRIDGE_TRIES ? true : tries + 1)
  if (!answered) info(`storage: no storage bridge answered (load ${tries + 1} of ${BRIDGE_TRIES})`)
}

// Every read and write waits for it, so nothing written at load (a recent
// search, the favorites index) lands before the bridge's copy.
export const storeReady = () => movedIn || (movedIn = (GM_STORE ? moveIn() : Promise.resolve())
  .catch(e => warn(`storage: moving in failed — ${describeError(e)}`)))

// What was stored under the key (null when nothing was), unchecked.
export async function storeGet(key: StoreKey): Promise<any> {
  await storeReady()
  return GM_STORE ? GM_getValue(key, null) : siteGet(key)
}

export async function storeSet(key: StoreKey, value: unknown) {
  await storeReady()
  if (GM_STORE) GM_setValue(key, value)
  else await siteSet(key, value)
}
