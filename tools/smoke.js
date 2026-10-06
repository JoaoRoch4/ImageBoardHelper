#!/usr/bin/env node
// Development helper, not part of the userscript.
//
// Smoke test in a headless Firefox (Playwright), without the phone: loads a
// safebooru listing with the userscript injected (the GM functions stubbed
// in memory) and checks that it boots, mounts the panel and the search bar,
// lays out the feed, opens and closes the modal and runs the autopager, with
// no page errors. rule34 answers a headless browser with a CAPTCHA;
// safebooru has the same Gelbooru 0.2 markup. Same engine as the phone
// (Gecko), not the same browser: touch, video decoding and Violentmonkey
// itself still need the device.
//
//   npm run smoke                 (or: node tools/smoke.js [listing URL])
//
// One-time setup: npm install && npx playwright install firefox

'use strict'
const fs = require('fs')
const path = require('path')
const { firefox } = require('playwright')

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'image-board-helper.user.js'), 'utf8')
const START = process.argv[2] || 'https://safebooru.org/index.php?page=post&s=list&tags=all'

// What Violentmonkey would provide, in memory, and the feed switched on as
// the phone has it. @noframes by hand: init scripts run in every frame.
const INJECT = `if (window.top === window) {
  const store = new Map()
  window.GM_getValue = (k, d) => (store.has(k) ? JSON.parse(store.get(k)) : d)
  window.GM_setValue = (k, v) => { store.set(k, JSON.stringify(v)) }
  window.GM_xmlhttpRequest = d => setTimeout(() => d.onerror && d.onerror(new Error('stub')), 0)
  window.unsafeWindow = window
  try { if (!localStorage.getItem('IBH_CFG')) localStorage.setItem('IBH_CFG', JSON.stringify({ nativeFeed: true })) } catch (e) {}
  ${SCRIPT}
}`

let failed = 0
function check(name, ok, detail = '') {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// Waits for a line in the script's own log; resolves to it, or null.
const logLine = (page, re, timeout = 15000) => page.waitForFunction(
  source => window.__ibh.log().map(e => e.msg).find(m => new RegExp(source).test(m)) || null,
  re.source, { timeout }).then(h => h.jsonValue(), () => null)

;(async () => {
  const browser = await firefox.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true })
  await context.addInitScript({ content: INJECT })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(e.message))

  try {
    const res = await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // The first page's own size, from the HTML: the autopager may have added
    // the next one before the first look (a one-column feed starts short).
    const firstPage = ((await res.text()).match(/class="thumb"/g) || []).length
    const version = await page.waitForFunction(() => window.__ibh && window.__ibh.version, null, { timeout: 15000 })
      .then(h => h.jsonValue(), () => null)
    check('script boots', !!version, version ? `v${version} on ${new URL(START).hostname}` : 'no window.__ibh')
    if (!version) return

    const shadowHosts = await page.evaluate(() => [...document.querySelectorAll('*')].filter(e => e.shadowRoot).length)
    check('panel mounted', shadowHosts >= 1, `${shadowHosts} shadow host(s)`)
    check('site search bar', await page.locator('#ibh-sitesearch').count() === 1)

    // Everything below works on the site's .image-list (Gelbooru 0.2 markup).
    if (!(await page.locator('.image-list').count())) {
      check('thumbnail list', false, 'no .image-list here: this site lays out its thumbnails another way')
    } else {
      const thumbs = await page.locator('.image-list span.thumb').count()
      const layout = await page.evaluate(() => getComputedStyle(document.querySelector('.image-list')).flexDirection)
      check('feed laid out', layout === 'column', `${thumbs} thumbnails, .image-list flex-direction: ${layout}`)

      // A tap on a thumbnail opens the post over the page; back closes it.
      await page.locator('.image-list span.thumb a').first().click()
      const opened = await logLine(page, /^modal: \w+ post \d+/)
      const modalShown = () => page.evaluate(() => {
        const host = [...document.querySelectorAll('*')].find(e => e.shadowRoot && e.shadowRoot.querySelector('.vlayer'))
        return !!host && host.style.display !== 'none'
      })
      check('modal opens', !!opened && await modalShown(), opened || 'no "modal:" log line')
      await page.goBack()
      await page.waitForTimeout(500)
      check('modal closes on back', !(await modalShown()), `still on ${page.url().replace(/^.*\?/, '?')}`)

      // Near the bottom, the next page is added under this one.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      const added = await logLine(page, /^autopager: page \d+ added/, 30000)
      const after = await page.locator('.image-list span.thumb').count()
      check('autopager', !!added && after > firstPage, `${added || 'no autopager line'}; first page ${firstPage}, now ${after} thumbnails`)
    }

    const scriptErrors = await page.evaluate(() => window.__ibh.log().filter(e => e.level === 'error' || e.level === 'warn').map(e => `${e.level}: ${e.msg}`))
    check('no page errors', !pageErrors.length, pageErrors.slice(0, 3).join(' | '))
    check('no errors in the script log', !scriptErrors.length, scriptErrors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
    console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
    process.exitCode = failed ? 1 : 0
  }
})().catch(e => { console.error(e.message.split('\n')[0]); process.exit(1) })
