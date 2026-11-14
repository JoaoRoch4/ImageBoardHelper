#!/usr/bin/env node
// Development helper, not part of the userscript.
//
// The URL cache's IndexedDB side, in a headless Firefox (Playwright) with the
// network faked: a safebooru-like listing whose posts have no sample and a
// .png original, so a thumbnail upgraded without the cache asks for the
// sample, the .jpg and the .jpeg in vain beside the .png.
//
//   node tools/url-test.js
//
// What it checks (2026-11-14):
//   - the winners and the misses reach IndexedDB;
//   - with localStorage cleared before the script runs (another script's
//     localStorage.clear()), the cards below the fold ask only for their .png;
//   - Free memory keeps the cache, and a card on screen comes back with one
//     request;
//   - Redo drops the remembered misses in IndexedDB too.

'use strict'
const fs = require('fs')
const path = require('path')
const { firefox } = require('playwright')

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'image-board-helper.user.js'), 'utf8')
const ORIGIN = 'https://safebooru.org'
const LISTING = `${ORIGIN}/index.php?page=post&s=list&tags=all`
// A 1×1 PNG for every image that exists (Firefox goes by the bytes).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

// Card 1 has no file at all (a miss); the others a .png original and no sample.
const HASHES = ['none1', ...Array.from({ length: 7 }, (_, i) => `png${i + 2}`)]

// Cards 1200 px apart: one per screen (viewport 780 px), so the ones below
// are scanned at load but upgraded only when scrolled to.
const listing = () => `<!doctype html><html><head><meta charset="utf-8"><title>test</title></head><body><div class="image-list">${
  HASHES.map((hash, i) => `<span class="thumb" id="s${i + 1}" style="display:block;height:1200px">` +
    `<a id="p${i + 1}" href="index.php?page=post&amp;s=view&amp;id=${i + 1}">` +
    `<img src="${ORIGIN}/thumbnails/1/thumbnail_${hash}.jpg" alt=" tagme " title=" tagme " class="preview" width="150" height="150"></a></span>`).join('\n')
}</div></body></html>`

// Before the script: on a page opened with &clear=1, what another script's
// localStorage.clear() does, noting first that there was a cache to lose.
const CLEAR = `if (location.search.includes('clear=1')) {
  window.__hadCache = Object.keys(localStorage).some(k => k.startsWith('IBH_URLCACHE_'))
  localStorage.clear()
  window.__cacheGone = !Object.keys(localStorage).some(k => k.startsWith('IBH_URL'))
}`

/** @param {object} cfg */
const inject = cfg => `if (window.top === window) {
  const store = new Map()
  window.GM_getValue = (k, d) => (store.has(k) ? JSON.parse(store.get(k)) : d)
  window.GM_setValue = (k, v) => { store.set(k, JSON.stringify(v)) }
  window.GM_xmlhttpRequest = d => setTimeout(() => d.onerror && d.onerror(new Error('stub')), 0)
  window.unsafeWindow = window
  try { localStorage.setItem('IBH_CFG', ${JSON.stringify(JSON.stringify(cfg))}) } catch (e) {}
  ${SCRIPT}
}`

let failed = 0
function check(name, ok, detail = '') {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** @param {import('playwright').Page} page @param {number} n */
async function showCard(page, n) {
  await page.evaluate(i => window.scrollTo(0, document.getElementById(`s${i}`).offsetTop), n)
  await page.waitForTimeout(300)
}

// Card n's upgrade state: 'done', 'failed', 'queued', …
/** @param {import('playwright').Page} page @param {number} n */
const upgrade = (page, n) => page.evaluate(i => document.querySelector(`#p${i} img`).dataset.ibhOrig || '', n)

/** @param {import('playwright').Page} page @param {number} n @param {string} state @param {number} ms */
const becomes = (page, n, state, ms) => page.waitForFunction(([i, s]) =>
  document.querySelector(`#p${i} img`).dataset.ibhOrig === s, [n, state], { timeout: ms }).then(() => true, () => false)

/** @param {import('playwright').Page} page */
const urlIndex = page => page.evaluate(() => window.__ibh.urlIndex())

// Waits until the IndexedDB side satisfies ok(stats), up to ms.
/** @param {import('playwright').Page} page @param {(s: any) => boolean} ok @param {number} ms */
async function indexWhen(page, ok, ms) {
  const end = Date.now() + ms
  let stats = null
  while (Date.now() < end) {
    stats = await urlIndex(page)
    if (stats && ok(stats)) return stats
    await page.waitForTimeout(250)
  }
  return stats
}

// Taps a floating page button by its title (the English UI): the trash can
// ('Free memory & cache') or ↻ ('Free memory, then redo thumbnails').
/** @param {import('playwright').Page} page @param {'free' | 'redo'} which */
const tapNavButton = (page, which) => page.evaluate(w => {
  const title = w === 'free' ? 'Free memory & cache' : 'Free memory, then redo thumbnails'
  for (const host of document.querySelectorAll('*')) {
    const btn = host.shadowRoot && host.shadowRoot.querySelector(`button[title="${title}"]`)
    if (btn) { btn.click(); return true }
  }
  return false
}, which)

// Shows card n and waits for its upgrade (cards scrolled away are released
// back to the thumbnail by the memory saver, so each is checked in turn).
/** @param {import('playwright').Page} page @param {number} n */
async function upgradedOnScreen(page, n) {
  await showCard(page, n)
  return becomes(page, n, 'done', 5000)
}

;(async () => {
  const browser = await firefox.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true })
  try {
    await context.addInitScript({ content: CLEAR })
    await context.addInitScript({ content: inject({ blockAds: false, videoCovers: false, favAutopager: false, nativeFeed: true }) })
    // Every request for a post's files, by hash: [file name, …].
    /** @type {Map<string, string[]>} */
    const asked = new Map()
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin !== ORIGIN) return route.abort()
      if (url.pathname === '/index.php') return route.fulfill({ contentType: 'text/html', body: listing() })
      if (url.pathname.startsWith('/thumbnails/')) return route.fulfill({ contentType: 'image/png', body: PNG })
      const m = url.pathname.match(/\/(?:samples|images)\/1\/(?:sample_)?([a-z0-9]+)\.(\w+)$/)
      if (m) {
        const list = asked.get(m[1]) || []
        list.push(path.basename(url.pathname))
        asked.set(m[1], list)
        if (url.pathname.startsWith('/images/') && m[2] === 'png' && m[1].startsWith('png')) return route.fulfill({ contentType: 'image/png', body: PNG })
      }
      return route.fulfill({ status: 404, body: '' })
    })
    /** @param {string} hash */
    const wrong = hash => (asked.get(hash) || []).filter(f => f !== `${hash}.png`)

    // 1. First visit: every card walks the ladder, and what it found goes to IndexedDB.
    let page = await context.newPage()
    await page.goto(LISTING, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__ibh && window.__ibh.version, null, { timeout: 15000 })
    await showCard(page, 1)
    let upgraded = true
    for (let n = 2; n <= HASHES.length; n++) upgraded = await upgradedOnScreen(page, n) && upgraded
    const walked = HASHES.slice(1).every(h => wrong(h).length > 0)
    check('first visit: the cards walk the ladder and upgrade', upgraded && walked,
      `upgraded: ${upgraded}, ${HASHES.map(h => `${h}: ${(asked.get(h) || []).join(',')}`).join('; ')}`)
    let stats = await indexWhen(page, s => s.entries >= HASHES.length && s.misses >= 1, 10000)
    check('the winners and the miss reach IndexedDB', !!stats && stats.entries >= HASHES.length && stats.misses >= 1,
      JSON.stringify(stats))
    await page.close()

    // 2. localStorage cleared before the script: the cards below the fold
    //    find their file in IndexedDB, before they scroll in.
    asked.clear()
    page = await context.newPage()
    await page.goto(`${LISTING}&clear=1`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__ibh && window.__ibh.version, null, { timeout: 15000 })
    const cleared = await page.evaluate(() => ({ had: window.__hadCache, gone: window.__cacheGone }))
    check('localStorage held the cache, and it was gone when the script started', cleared.had === true && cleared.gone === true,
      JSON.stringify(cleared))
    upgraded = true
    for (let n = 2; n <= HASHES.length; n++) upgraded = await upgradedOnScreen(page, n) && upgraded
    // Card 1 has nothing to find. The others, on screen at load or below it,
    // wait for IndexedDB's answer instead of walking the ladder.
    const found = HASHES.slice(1)
    check('cleared localStorage: one request per card, its .png', upgraded && found.every(h => wrong(h).length === 0 && (asked.get(h) || []).length === 1),
      `upgraded: ${upgraded}, ${HASHES.map(h => `${h}: ${(asked.get(h) || []).join(',') || '-'}`).join('; ')}`)

    // 3. Free memory keeps the cache; the card on screen comes back with one request.
    await showCard(page, 5)
    const before = await page.evaluate(() => window.__ibh.urlCache().entries)
    asked.clear()
    const freed = await tapNavButton(page, 'free')
    await page.waitForFunction(() => /freed \d+ covers/.test(window.__ibh.tail(5, 'freed')), null, { timeout: 5000 }).catch(() => {})
    const back = await becomes(page, 5, 'done', 5000)
    const after = await page.evaluate(() => window.__ibh.urlCache().entries)
    check('trash can: the cache is kept and the card comes back without a wrong request', freed && back && after >= before && wrong(HASHES[4]).length === 0,
      `tapped: ${freed}, entries ${before} → ${after}, card 5 "${await upgrade(page, 5)}", asked ${(asked.get(HASHES[4]) || []).join(',') || '- (the browser\'s cache)'}`)

    // 4. Redo forgets the misses in IndexedDB too (card 1, off screen, is not retried).
    const redone = await tapNavButton(page, 'redo')
    stats = await indexWhen(page, s => s.misses === 0, 6000)
    const memMisses = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('IBH_URLCACHE_')) || '{}'))).filter(e => e.u === null).length)
    check('↻: the misses are gone from IndexedDB and localStorage, the winners stay', redone && !!stats && stats.misses === 0 && stats.entries >= HASHES.length - 1 && memMisses === 0,
      `${JSON.stringify(stats)}, misses in localStorage: ${memMisses}`)
    await page.close()
  } finally {
    await context.close()
    await browser.close()
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
