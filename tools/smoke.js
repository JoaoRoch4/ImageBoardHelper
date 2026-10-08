#!/usr/bin/env node
// Development helper, not part of the userscript.
//
// Smoke test in a headless Firefox (Playwright), without the phone: loads a
// safebooru listing with the userscript injected (the GM functions stubbed
// in memory) and checks that it boots, mounts the panel and the search bar,
// lays out the feed, hides the buttons with 👁, blocks other hosts' scripts
// and frames (blockAds), opens and closes the modal and runs the autopager,
// with no page errors. rule34 answers a headless
// browser with a CAPTCHA; safebooru has the same Gelbooru 0.2 markup. Same
// engine as the phone (Gecko), not the same browser: touch, video decoding
// and Violentmonkey itself still need the device.
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

// What each site's page holds, written down here apart from the script so
// the test does not trust the code it tests: the thumbnail list, one card,
// how a card shows in the raw HTML, and the other hosts its own scripts
// come from (allowed by blockAds).
const PROFILES = [
  // knownErrors: the site's own page errors, which happen without the script too.
  // adSlots: the site's ad boxes, which must end up hidden; accent: the theme's link colour there.
  { host: /(^|\.)gelbooru\.com$/, list: '.thumbnail-container', thumb: 'article.thumbnail-preview', inHtml: /class="thumbnail-preview"/g, scriptHosts: ['ajax.googleapis.com'],
    knownErrors: [/^\$ is not defined$/],   // an inline script of theirs runs before their jQuery
    adSlots: ['[id^="__clb-spot_"]', '.footerAd2', 'a[href*="realxxx."]'], accent: 'rgb(90, 169, 255)' },
]
const SITE = PROFILES.find(p => p.host.test(new URL(START).hostname)) ||
  { list: '.image-list', thumb: 'span.thumb', inHtml: /class="thumb"/g, scriptHosts: [], knownErrors: [],   // Gelbooru 0.2
    adSlots: ['.a_list', 'ins[data-zoneid]'], accent: 'rgb(94, 234, 212)' }

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
  page.on('pageerror', e => { if (!SITE.knownErrors.some(re => re.test(e.message))) pageErrors.push(e.message) })
  // Scripts and frames asked from other hosts: with blockAds, none should be.
  const domain = new URL(START).hostname.split('.').slice(-2).join('.')
  const outside = []
  page.on('request', r => {
    const kind = r.resourceType() === 'script' ? 'script' : r.isNavigationRequest() && r.frame() !== page.mainFrame() ? 'frame' : null
    const host = new URL(r.url()).hostname
    if (kind && host !== domain && !host.endsWith(`.${domain}`) && !SITE.scriptHosts.includes(host)) outside.push(`${kind} ${host}`)
  })

  try {
    const res = await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // The first page's own size, from the HTML: the autopager may have added
    // the next one before the first look (a one-column feed starts short).
    const firstPage = ((await res.text()).match(SITE.inHtml) || []).length
    const version = await page.waitForFunction(() => window.__ibh && window.__ibh.version, null, { timeout: 15000 })
      .then(h => h.jsonValue(), () => null)
    check('script boots', !!version, version ? `v${version} on ${new URL(START).hostname}` : 'no window.__ibh')
    if (!version) return

    const shadowHosts = await page.evaluate(() => [...document.querySelectorAll('*')].filter(e => e.shadowRoot).length)
    check('panel mounted', shadowHosts >= 1, `${shadowHosts} shadow host(s)`)
    check('site search bar', await page.locator('#ibh-sitesearch').count() === 1)
    // Tag suggestions: typing in the bar asks the site; a tap swaps the word being typed.
    const bar = page.locator('#ibh-sitesearch input[type="search"]').first()
    await bar.click()
    await bar.fill('')
    await bar.type('red_eyes blo', { delay: 60 })
    const listed = await page.waitForSelector('.ibh-suggest li', { timeout: 10000 }).then(() => true, () => false)
    let suggestion = ''
    let typed = ''
    if (listed) {
      const first = page.locator('.ibh-suggest li').first()
      suggestion = await first.getAttribute('data-value') || ''
      await first.click()
      typed = await bar.inputValue()
    }
    check('search suggestions', listed && typed === `red_eyes ${suggestion} `, listed ? `picked "${suggestion}": "${typed}"` : 'no suggestion list')
    await bar.fill('')
    // The theme gives the sites' own suggestion lists a background (it clears every other one).
    const lists = await page.evaluate(() => {
      const make = html => { const d = document.createElement('div'); d.innerHTML = html; document.body.appendChild(d); return d }
      const aw = make('<div class="awesomplete"><ul><li>x</li></ul></div>')
      const ui = make('<ul class="ui-menu ui-autocomplete"><li class="ui-menu-item"><div class="ui-menu-item-wrapper">x</div></li></ul>')
      const bg = e => getComputedStyle(e).backgroundColor
      const out = { awesomplete: bg(aw.querySelector('ul')), jqueryUi: bg(ui.querySelector('ul')) }
      aw.remove(); ui.remove()
      return out
    })
    check('suggestion lists opaque', !Object.values(lists).includes('rgba(0, 0, 0, 0)'), JSON.stringify(lists))
    // Ads: no script or frame from another host was even asked for, ExoClick's
    // queue is still the page's plain array (its script never ran), and
    // WebAssembly still compiles under the policy (the keyframe decoder).
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {})
    const ads = await page.evaluate(async () => ({
      queue: window.AdProvider === undefined ? 'absent' : Array.isArray(window.AdProvider) ? 'a plain array' : 'replaced by its script',
      wasm: await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(() => 'compiles', e => e.message),
    }))
    const adLine = await logLine(page, /^ads: blocked/, 5000)
    // A script high in the <head> can be asked for before the policy is in
    // place (the parser reached it first); then it must at least be blocked.
    const unblocked = outside.filter(o => !(adLine || '').includes(o.split(' ')[1]))
    // The ad boxes take no room, and the theme's links wear the site's accent.
    const boxes = await page.evaluate(sels => sels.map(sel => [...document.querySelectorAll(sel)].filter(e => e.getBoundingClientRect().height > 0).length), SITE.adSlots)
    check('ad boxes hidden', boxes.every(n => n === 0), SITE.adSlots.map((sel, i) => `${sel}: ${boxes[i]} visible`).join(', '))
    const linkColor = await page.evaluate(list => { const a = [...document.querySelectorAll('a')].find(x => !x.closest(list) && x.getBoundingClientRect().height > 0); return a ? getComputedStyle(a).color : null }, SITE.list)
    check('theme accent', linkColor === SITE.accent, `links ${linkColor}, expected ${SITE.accent}`)
    check('ads blocked', !unblocked.length && !/replaced/.test(ads.queue) && ads.wasm === 'compiles',
      `${adLine || 'no "ads:" log line'}; asked from other hosts: ${outside.join(', ') || 'nothing'}${outside.length ? ` (blocked: ${outside.length - unblocked.length})` : ''}; ExoClick queue ${ads.queue}; WebAssembly ${ads.wasm}`)
    // The console helpers return text (an on-phone console shows only that).
    const consoleHelp = await page.evaluate(() => ({ help: window.__ibh.help(), tail: window.__ibh.tail(3).split('\n').length, none: window.__ibh.tail(5, '^no such line$') }))
    check('console help() and tail()', consoleHelp.help.includes('tail(n, filter)') && consoleHelp.tail === 3 && consoleHelp.none === '(no matching lines)',
      `help ${consoleHelp.help.split('\n').length} lines, tail(3) ${consoleHelp.tail} lines, unmatched filter: ${consoleHelp.none}`)

    // 👁 hides the other floating buttons, and a second tap brings them back.
    const fabShown = () => page.evaluate(() => {
      const host = [...document.querySelectorAll('*')].find(e => e.shadowRoot && e.shadowRoot.querySelector('.eyefab'))
      const other = host && host.shadowRoot.querySelector('.fab, .feednav, .laterfab')
      return other ? getComputedStyle(other).display !== 'none' : null
    })
    await page.locator('.eyefab').click()
    const hidden = (await fabShown()) === false
    await page.locator('.eyefab').click()
    const back = (await fabShown()) === true
    check('eye button', hidden && back, `${hidden ? 'hid' : 'did not hide'} the other buttons, ${back ? 'brought them back' : 'left them hidden'}`)

    // Everything below works on the site's thumbnail list.
    if (!(await page.locator(SITE.list).count())) {
      check('thumbnail list', false, `no ${SITE.list} here: this site lays out its thumbnails another way`)
    } else {
      const thumbs = await page.locator(`${SITE.list} ${SITE.thumb}`).count()
      const layout = await page.evaluate(list => getComputedStyle(document.querySelector(list)).flexDirection, SITE.list)
      check('feed laid out', layout === 'column', `${thumbs} thumbnails, ${SITE.list} flex-direction: ${layout}`)

      // A tap on a thumbnail opens the post over the page; back closes it.
      await page.locator(`${SITE.list} ${SITE.thumb} a`).first().click()
      const opened = await logLine(page, /^modal: \w+ post \d+/)
      const modalShown = () => page.evaluate(() => {
        const host = [...document.querySelectorAll('*')].find(e => e.shadowRoot && e.shadowRoot.querySelector('.vlayer'))
        return !!host && host.style.display !== 'none'
      })
      check('modal opens', !!opened && await modalShown(), opened || 'no "modal:" log line')
      // The video player's glass capsule: two times around the seek bar, SVG
      // icons (no emoji), the big ▶ for a paused video, a blurred background.
      const player = await page.evaluate(() => {
        const root = [...document.querySelectorAll('*')].find(e => e.shadowRoot && e.shadowRoot.querySelector('.vlayer')).shadowRoot
        const ctl = root.querySelector('.vctl')
        return {
          times: ctl.querySelectorAll('.vtime').length,
          svgButtons: [...ctl.querySelectorAll('button')].filter(b => b.querySelector('svg')).length,
          emoji: /[\u{1F300}-\u{1FAFF}]/u.test(ctl.textContent),
          bigPlay: !!root.querySelector('.vbig svg'),
          blur: [...root.querySelectorAll('style')].some(s => s.textContent.includes('backdrop-filter')),
          seekReel: window.__ibh.cfg.seekReel,
        }
      })
      check('player capsule', player.times === 2 && player.svgButtons >= 2 && !player.emoji && player.bigPlay && player.blur && player.seekReel === true,
        `${player.times} times, ${player.svgButtons} SVG buttons, emoji ${player.emoji}, big play ${player.bigPlay}, blur ${player.blur}, seekReel ${player.seekReel}`)
      await page.goBack()
      await page.waitForTimeout(500)
      check('modal closes on back', !(await modalShown()), `still on ${page.url().replace(/^.*\?/, '?')}`)

      // Near the bottom, the next page is added under this one.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      const added = await logLine(page, /^autopager: page \d+ added/, 30000)
      const after = await page.locator(`${SITE.list} ${SITE.thumb}`).count()
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
