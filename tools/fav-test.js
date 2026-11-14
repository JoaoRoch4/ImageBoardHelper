#!/usr/bin/env node
// Development helper, not part of the userscript.
//
// The favorites search (rule34) in a headless Firefox (Playwright) with the
// site faked: favorites pages are served from here, slowly when a case needs
// a read to be cut short or a refresh to lag, so no site and no phone are
// involved.
//
//   node tools/fav-test.js
//
// Each case is something 1.16.2 got wrong (2026-11-14):
//   - rule34 stopped showing its user_id cookie to scripts, so the bar never
//     showed: one's own favorites page tells by its Remove links;
//   - an index of 6,000 favorites (123 pages, ~2 min) was saved only at the
//     end, so a reload before then started it over from page 1;
//   - a search restored on a stale index waited for the refresh before
//     showing anything.

'use strict'
const fs = require('fs')
const path = require('path')
const { firefox } = require('playwright')

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'image-board-helper.user.js'), 'utf8')
const ORIGIN = 'https://rule34.xxx'
const ME = '42'   // the user whose favorites these are; no cookie says so
// A 1×1 PNG for the thumbnails.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

// n favorite ids, newest first.
const favorites = (/** @type {number} */ n, first = 9000) => Array.from({ length: n }, (_, i) => String(first - i))

// A favorites page as rule34 serves it: each thumbnail in a span of its own,
// with a Remove link for the owner only, and the scores in inline scripts.
/** @param {string[]} ids @param {number} pid @param {boolean} own */
function favPage(ids, pid, own) {
  const items = ids.slice(pid, pid + 50).map(id =>
    '<span style="align-self: flex-start; display: grid; grid-template-rows: auto 10px;"><span class="thumb">' +
    `<a href="index.php?page=post&amp;s=view&amp;id=${id}" id="p${id}"><img src="${ORIGIN}//thumbnails//1/thumbnail_${id}.jpg?${id}" title=" common tag_${Number(id) % 7} " alt=" common tag_${Number(id) % 7} " border="0"></a>` +
    `</span><br>${own ? `<a href="#" onclick="document.location='index.php?page=favorites&amp;s=delete&amp;id=${id}&amp;return_pid=${pid}'; return false;"><b>Remove</b></a>` : ''}</span>` +
    `<script>posts[${id}] = { tags: "common", score: '${Number(id) % 100}' }</script>`).join('\n')
  return '<!doctype html><html><head><meta charset="utf-8"><title>Favorites</title></head><body>' +
    `<script>var posts = {};</script><div class="image-list">${items}</div><div id="paginator"><b>${pid / 50 + 1}</b></div></body></html>`
}

// GM storage in sessionStorage, so it outlives a reload as Violentmonkey's does.
/** @param {object} cfg */
const inject = cfg => `if (window.top === window) {
  const key = k => 'gm:' + k
  window.GM_getValue = (k, d) => { const v = sessionStorage.getItem(key(k)); return v === null ? d : JSON.parse(v) }
  window.GM_setValue = (k, v) => { sessionStorage.setItem(key(k), JSON.stringify(v)) }
  window.GM_xmlhttpRequest = d => setTimeout(() => d.onerror && d.onerror(new Error('stub')), 0)
  window.unsafeWindow = window
  if (sessionStorage.getItem(key('movedIn')) === null) sessionStorage.setItem(key('movedIn'), 'true')   // no storage bridge to wait for
  try { localStorage.setItem('IBH_CFG', ${JSON.stringify(JSON.stringify(cfg))}) } catch (e) {}
  ${SCRIPT}
}`

let failed = 0
function check(name, ok, detail = '') {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// The fake site: its favorites (a case may add some) and how long a page
// read by the script takes. The page loads themselves are never slowed.
/** @typedef {{ ids: string[], delay: number, asked: number[] }} Site */

// cookie: a user_id cookie readable by scripts, as rule34 had until 2026-11, so
// a case tests its own fix and not the missing cookie's.
/** @param {import('playwright').Browser} browser @param {Site} site @param {string} user @param {boolean} [cookie] */
async function open(browser, site, user, cookie = false) {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true })
  if (cookie) await context.addCookies([{ name: 'user_id', value: ME, domain: 'rule34.xxx', path: '/' }])
  await context.addInitScript({ content: inject({ blockAds: false, videoCovers: false, favAutopager: false, favSearch: true }) })
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== ORIGIN) return route.abort()
    const q = url.searchParams
    if (url.pathname === '/index.php' && q.get('page') === 'favorites') {
      const pid = Number(q.get('pid') || 0)
      if (route.request().resourceType() !== 'document') {
        site.asked.push(pid)
        if (site.delay) await new Promise(r => setTimeout(r, site.delay))
      }
      return route.fulfill({ contentType: 'text/html', body: favPage(site.ids, pid, q.get('id') === ME) }).catch(() => {})   // the page may be gone
    }
    if (/thumbnail_/.test(url.pathname)) return route.fulfill({ contentType: 'image/png', body: PNG })
    return route.fulfill({ status: 404, body: '' })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${ORIGIN}/index.php?page=favorites&s=view&id=${user}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__ibh && window.__ibh.version, null, { timeout: 15000 })
  await page.waitForTimeout(500)
  return { context, page, errors }
}

/** @param {import('playwright').Page} page */
const hasBar = page => page.evaluate(() => !!document.getElementById('ibh-favsearch'))

// The bar's Go button: a search (with nothing typed, every favorite).
/** @param {import('playwright').Page} page */
const go = page => page.evaluate(() => document.querySelectorAll('#ibh-favsearch button')[0].click())

// The stored index, wherever this version keeps it: the site's IndexedDB or
// GM storage. { count, next, updated, ids } or null.
/** @param {import('playwright').Page} page */
const readIndex = page => page.evaluate(() => new Promise(resolve => {
  const gm = JSON.parse(sessionStorage.getItem('gm:favs') || 'null')
  const sum = v => (v && v.items ? { count: v.items.length, next: v.next ?? null, updated: v.updated, ids: v.items.map(i => i[0]) } : null)
  const req = indexedDB.open('ibh', 1)
  req.onupgradeneeded = () => req.result.createObjectStore('kv')
  req.onsuccess = () => {
    const get = req.result.transaction('kv').objectStore('kv').get('favs')
    get.onsuccess = () => { req.result.close(); resolve(sum(get.result) || sum(gm)) }
    get.onerror = () => resolve(sum(gm))
  }
  req.onerror = () => resolve(sum(gm))
}))

// Moves the stored index's last update back by ms, wherever it is kept.
/** @param {import('playwright').Page} page @param {number} ms */
const ageIndex = (page, ms) => page.evaluate(back => new Promise(resolve => {
  const gm = JSON.parse(sessionStorage.getItem('gm:favs') || 'null')
  if (gm) { gm.updated -= back; sessionStorage.setItem('gm:favs', JSON.stringify(gm)) }
  const req = indexedDB.open('ibh', 1)
  req.onupgradeneeded = () => req.result.createObjectStore('kv')
  req.onsuccess = () => {
    const store = req.result.transaction('kv', 'readwrite').objectStore('kv')
    const get = store.get('favs')
    get.onsuccess = () => {
      if (get.result) { get.result.updated -= back; store.put(get.result, 'favs') }
      store.transaction.oncomplete = () => { req.result.close(); resolve(true) }
    }
  }
  req.onerror = () => resolve(false)
}), ms)

// Polls the stored index until `ok` holds; the last one read, either way.
/** @param {import('playwright').Page} page @param {(i: any) => boolean} ok @param {number} ms */
async function indexWhen(page, ok, ms) {
  let last = null
  for (const end = Date.now() + ms; Date.now() < end;) {
    last = await readIndex(page).catch(() => null)   // a navigation in between
    if (last && ok(last)) return { ok: true, index: last }
    await page.waitForTimeout(250)
  }
  return { ok: false, index: last }
}

// The ids of the search results in the page's list (the script's own thumbnails, not the site's).
/** @param {import('playwright').Page} page */
const results = page => page.evaluate(() => [...document.querySelectorAll('.image-list > span.thumb > a')].map(a => a.id.slice(1)))

;(async () => {
  const browser = await firefox.launch({ headless: true })
  try {
    // 1. Your own favorites, without the user_id cookie: the Remove links
    //    tell, and the bar stays once results replace them.
    {
      /** @type {Site} */
      const site = { ids: favorites(120), delay: 0, asked: [] }
      const { context, page, errors } = await open(browser, site, ME)
      check('the bar shows on your own favorites without the user_id cookie', await hasBar(page))
      if (await hasBar(page)) {
        await go(page)
        const built = await indexWhen(page, i => i.count === 120 && i.next === null, 10000)
        await page.waitForTimeout(300)
        check('a search there reads every page and shows the results', built.ok && (await results(page)).length > 0,
          `index ${JSON.stringify(built.index && { count: built.index.count, next: built.index.next })}, asked ${site.asked.join(' ')}`)
        check('the bar stays once results replace the Remove links', await hasBar(page))
      }
      check('no page errors', !errors.length, errors.join(' | '))
      await context.close()
    }

    // 2. Someone else's favorites (no Remove links): no bar.
    {
      const { context, page } = await open(browser, { ids: favorites(60), delay: 0, asked: [] }, '77')
      check('no bar on someone else\'s favorites', !(await hasBar(page)))
      await context.close()
    }

    // 3. A reload during the first read goes on where it stopped, with what
    //    was read so far kept.
    {
      /** @type {Site} */
      const site = { ids: favorites(600), delay: 400, asked: [] }
      const { context, page } = await open(browser, site, ME, true)
      if (await hasBar(page)) await go(page)
      const partial = await indexWhen(page, i => i.count > 0 && i.next !== null, 15000)
      check('the read is saved as it goes', partial.ok, `index ${JSON.stringify(partial.index && { count: partial.index.count, next: partial.index.next })}`)
      if (partial.ok) {
        const stop = partial.index.next
        site.asked.length = 0
        await page.reload({ waitUntil: 'domcontentloaded' })
        const done = await indexWhen(page, i => i.count === 600 && i.next === null, 30000)
        const reread = site.asked.filter(pid => pid > 0 && pid < stop)
        check('after a reload it goes on from there', done.ok && !reread.length && site.asked.includes(stop),
          `stopped at ${stop} with ${partial.index.count}; after the reload asked ${site.asked.join(' ')}; index ${done.index && done.index.count}`)
        check('every favorite once', !!done.index && new Set(done.index.ids).size === 600)
      }
      await context.close()
    }

    // 4. A search restored on a stale index shows its results at once; the
    //    refresh comes in behind it and brings the new favorites.
    {
      /** @type {Site} */
      const site = { ids: favorites(100), delay: 0, asked: [] }
      const { context, page } = await open(browser, site, ME, true)
      if (await hasBar(page)) await go(page)
      const built = await indexWhen(page, i => i.count === 100 && i.next === null, 10000)
      if (built.ok) {
        await page.waitForTimeout(500)   // the search is remembered (favLast)
        await ageIndex(page, 11 * 60 * 1000)
        site.ids = [...favorites(5, 9100), ...site.ids]   // five new favorites on top
        site.delay = 3000
        const mark = site.asked.length
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.waitForFunction(() => window.__ibh && window.__ibh.version, null, { timeout: 15000 })
        await page.waitForTimeout(1200)
        const early = await results(page)
        check('a restored search shows the stored results before the refresh', early.length > 0, `${early.length} results after 1.2 s`)
        await page.waitForTimeout(4000)
        const late = await results(page)
        check('then the new favorites come in', late[0] === '9100', `first result ${late[0]}, asked ${site.asked.join(' ')}`)
        // The restored search and the bar both load the index at once: one
        // index in memory, so one refresh.
        const after = site.asked.slice(mark)
        check('one refresh, not one per caller', after.length === 1 && after[0] === 0, `asked after the reload: ${after.join(' ')}`)
      } else {
        check('a restored search shows the stored results before the refresh', false, 'no index to start from')
      }
      await context.close()
    }
  } finally {
    await browser.close()
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
