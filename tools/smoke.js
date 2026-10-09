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
    // A drag on the list scrolls it: lifting the finger after it picks nothing.
    const dragged = listed && await page.evaluate(() => {
      const li = document.querySelector('.ibh-suggest li')
      const r = li.getBoundingClientRect()
      const at = (type, dy) => {
        const touch = new Touch({ identifier: 1, target: li, clientX: r.left + 20, clientY: r.top + 10 + dy })
        const touches = type === 'touchend' ? [] : [touch]
        li.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: [touch] }))
      }
      at('touchstart', 0); at('touchmove', 40); at('touchend', 40)
      return { value: document.querySelector('#ibh-sitesearch input[type="search"]').value, open: !document.querySelector('.ibh-suggest').hidden }
    })
    check('suggestion list drags without picking', !!dragged && dragged.value === 'red_eyes blo' && dragged.open, JSON.stringify(dragged))
    // A tap picks when the finger lifts; the mouse picks on click.
    if (listed) {
      const first = page.locator('.ibh-suggest li').first()
      suggestion = await first.getAttribute('data-value') || ''
      await first.tap()
      typed = await bar.inputValue()
    }
    check('search suggestions', listed && typed === `red_eyes ${suggestion} `, listed ? `tapped "${suggestion}": "${typed}"` : 'no suggestion list')
    let clicked = ''
    if (listed) {
      await page.waitForTimeout(900)   // a click right after a touch counts as the touch's
      await bar.type('bl', { delay: 60 })
      const next = await page.waitForSelector('.ibh-suggest:not([hidden]) li', { timeout: 10000 }).catch(() => null)
      const tag = next && await next.getAttribute('data-value')
      if (next) await next.click()
      clicked = tag && (await bar.inputValue()).endsWith(` ${tag} `) ? tag : `none: "${await bar.inputValue()}"`
    }
    check('suggestion picked by mouse', listed && !clicked.startsWith('none'), clicked)
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
      // The Gelbooru 0.2 favorites put each card in a bare span (with its Remove link). The feed has to
      // size that span too: with no width of its own there, the post came out half as wide (1.10.0–1.11.0).
      if (SITE.thumb === 'span.thumb') {
        const sized = await page.evaluate(list => {
          const span = document.createElement('span')
          span.append(document.querySelector(`${list} span.thumb`).cloneNode(true))
          document.querySelector(list).append(span)
          const feed = document.querySelector('style[data-ibh-feed]')
          const rules = feed ? [...feed.sheet.cssRules] : []
          const hits = rules.filter(r => r.selectorText && span.matches(r.selectorText) && r.style.width === '100%').map(r => r.selectorText)
          span.remove()
          return hits
        }, SITE.list)
        check('favorites wrapper sized by the feed', sized.length > 0, sized.join(', ') || 'no feed rule gives the bare span a width')
      }

      // With the video reducer off (the default) the script never calls 127.0.0.1: every GM request is recorded.
      await page.evaluate(() => {
        const orig = window.GM_xmlhttpRequest
        window.__gmUrls = []
        window.GM_xmlhttpRequest = d => { window.__gmUrls.push(String(d.url)); return orig(d) }
      })
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
      // Its second row: play/pause, ♥ (favorite and upvote), ⓘ (the Info tab), ⚙ (speed and the
      // double tap's jump, both kept in the settings). Clicked in the page: the post may be an image.
      const extras = await page.evaluate(() => {
        const root = [...document.querySelectorAll('*')].find(e => e.shadowRoot && e.shadowRoot.querySelector('.vlayer')).shadowRoot
        const q = s => root.querySelector(s)
        const out = { buttons: ['.vplay', '.vfav', '.vinfo', '.vgear'].filter(s => q(`.vctl ${s} svg`)).length }
        q('.vgear').click()
        out.menu = !!q('.vmenu') && !q('.vmenu').hidden
        q('.vmenu [data-rate="1.5"]').click()
        q('.vmenu [data-step="10"]').click()
        out.rate = q('video').playbackRate
        out.cfg = [window.__ibh.cfg.playRate, window.__ibh.cfg.seekStep]
        q('.vmenu [data-rate="1"]').click()
        q('.vmenu [data-step="5"]').click()
        q('.vgear').click()
        out.closed = q('.vmenu').hidden
        q('.vinfo').click()
        out.info = !q('.sheet').hidden && q('.tabs .tab.on').textContent
        q('.vinfo').click()
        out.infoClosed = q('.sheet').hidden
        out.cone = q('.pill .cone') && q('.pill .cone').naturalWidth   // VLC's button, inline PNG
        return out
      })
      check('player extras', extras.buttons === 4 && extras.menu && extras.rate === 1.5 && String(extras.cfg) === '1.5,10' && extras.closed &&
        extras.info === 'Info' && extras.infoClosed && extras.cone === 29, JSON.stringify(extras))
      // A download goes on across posts: the top bar's ⬇ shows it from any post, and goes once it ends.
      // GM_xmlhttpRequest is swapped for one that reports 50% and waits for the test to finish it.
      const dl = await page.evaluate(async () => {
        const root = [...document.querySelectorAll('*')].find(e => e.shadowRoot && e.shadowRoot.querySelector('.vlayer')).shadowRoot
        const q = s => root.querySelector(s)
        const wait = ms => new Promise(r => setTimeout(r, ms))
        let req = null
        window.GM_xmlhttpRequest = d => { req = d; setTimeout(() => d.onprogress({ loaded: 50, total: 100 }), 10); return { abort() {} } }
        ;[...root.querySelectorAll('.sheethead button')].find(b => b.textContent.startsWith('⬇')).click()
        for (let i = 0; i < 100 && !req; i++) await wait(100)
        await wait(300)
        const out = { asked: !!req, first: !q('.dlq').hidden && q('.dlq').textContent }
        q('.side.next').click()
        await wait(800)
        out.afterStep = !q('.dlq').hidden && q('.dlq').textContent
        if (req) req.onload({ status: 200, response: new Blob(['x']) })
        await wait(100)
        out.gone = q('.dlq').hidden
        return out
      })
      check('downloads across posts', dl.asked && /50%/.test(dl.first) && /50%/.test(dl.afterStep) && dl.gone, JSON.stringify(dl))
      // Holding 🔗 opens the post's file in a new tab (window.open is caught here; the hold is ≥ 450 ms).
      const held = await page.evaluate(async () => {
        const root = [...document.querySelectorAll('*')].find(e => e.shadowRoot && e.shadowRoot.querySelector('.vlayer')).shadowRoot
        const btn = [...root.querySelectorAll('.sheethead button')].find(b => b.textContent.startsWith('🔗'))
        let opened = null
        const open = window.open
        window.open = u => { opened = u; return null }
        const touch = type => {
          const t = new Touch({ identifier: 2, target: btn, clientX: 5, clientY: 5 })
          const now = type === 'touchend' ? [] : [t]
          btn.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: now, targetTouches: now, changedTouches: [t] }))
        }
        touch('touchstart')
        await new Promise(r => setTimeout(r, 1500))
        touch('touchend')
        window.open = open
        return opened
      })
      // The sheet slides up from below and back (closed it waits off screen, invisible); the capsule and
      // the top bar move as they fade.
      const motion = await page.evaluate(async () => {
        const root = [...document.querySelectorAll('*')].find(e => e.shadowRoot && e.shadowRoot.querySelector('.vlayer')).shadowRoot
        const cs = s => getComputedStyle(root.querySelector(s))
        const menu = [...root.querySelectorAll('.bar button')].find(b => b.textContent === '☰')
        const state = () => [cs('.sheet').visibility, cs('.sheet').transform === 'none' ? 'in place' : 'moved']
        menu.click()
        await new Promise(r => setTimeout(r, 450))
        const open = state()
        menu.click()
        await new Promise(r => setTimeout(r, 450))
        return { open, closed: state(), capsule: cs('.vctl').transitionProperty, bar: cs('.bar').transitionProperty }
      })
      check('sheet and bars slide', String(motion.open) === 'visible,in place' && String(motion.closed) === 'hidden,moved' &&
        /transform/.test(motion.capsule) && /transform/.test(motion.bar), JSON.stringify(motion))
      check('hold copy link opens the file', typeof held === 'string' && /^https:\/\//.test(held), String(held))
      await page.goBack()
      await page.waitForTimeout(500)
      check('modal closes on back', !(await modalShown()), `still on ${page.url().replace(/^.*\?/, '?')}`)
      const local = await page.evaluate(() => window.__gmUrls.filter(u => u.startsWith('http://127.0.0.1')))
      check('reducer off: no requests to 127.0.0.1', !local.length, local.join(', '))

      // Near the bottom, the next page is added under this one.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      const added = await logLine(page, /^autopager: page \d+ added/, 30000)
      const after = await page.locator(`${SITE.list} ${SITE.thumb}`).count()
      check('autopager', !!added && after > firstPage, `${added || 'no autopager line'}; first page ${firstPage}, now ${after} thumbnails`)
    }

    const scriptErrors = await page.evaluate(() => window.__ibh.log().filter(e => e.level === 'error' || e.level === 'warn').map(e => `${e.level}: ${e.msg}`))
    check('no page errors', !pageErrors.length, pageErrors.slice(0, 3).join(' | '))
    check('no errors in the script log', !scriptErrors.length, scriptErrors.slice(0, 3).join(' | '))

    // The OR field: || starts another group, and the bar reads the groups back from the address.
    const orField = page.locator('#ibh-sitesearch input.or')
    if (await orField.count()) {
      await page.locator('#ibh-sitesearch input[type="search"]').first().fill('')
      await orField.fill('red_eyes blue_eyes || smile blush')
      // Picking an order or a kind waits for Search (or Enter): other fields may follow.
      const before = page.url()
      await page.locator('#ibh-sitesearch select.sort').selectOption('score')
      await page.locator('#ibh-sitesearch select.kind').selectOption('image')
      await page.waitForTimeout(1500)
      const stayed = page.url() === before
      await Promise.all([page.waitForURL(u => u.href.includes('smile'), { timeout: 30000 }), orField.press('Enter')])
      const tags = new URL(page.url()).searchParams.get('tags') || ''
      const back = await page.locator('#ibh-sitesearch input.or').inputValue({ timeout: 30000 })
      check('order and kind wait for Search', stayed && tags.endsWith(' -animated -video -gif sort:score'), `${stayed ? 'stayed' : 'left at once'}; tags=${tags}`)
      check('OR groups', tags === '( red_eyes ~ blue_eyes ) ( smile ~ blush ) -animated -video -gif sort:score' && back === 'red_eyes blue_eyes || smile blush', `tags=${tags}; read back "${back}"`)
    }

    // The video reducer's token: typed in the panel, kept with GM_setValue only, never in the site's storage.
    const panelToken = async (pg, value) => pg.evaluate(async value => {
      const panelRoot = () => [...document.querySelectorAll('*')].map(e => e.shadowRoot).find(r => r && r.querySelector('.panel'))
      const label = [...panelRoot().querySelectorAll('label.tog')].find(l => l.textContent.startsWith('Convert videos past the decoder'))
      if (!label) return { error: 'no video reducer switch in the panel' }
      if (!label.querySelector('input').checked) label.querySelector('input').click()
      await new Promise(r => setTimeout(r, 300))
      const field = panelRoot().querySelector('input.reducertoken')   // the switch rebuilt the panel: a new shadow root
      if (!field) return { error: 'no token field' }
      if (!field.disabled) { field.value = value; field.dispatchEvent(new Event('change')) }
      return { disabled: field.disabled, placeholder: field.placeholder, type: field.type }
    }, value)
    const tokenField = await panelToken(page, 'abc123')
    const kept = await page.evaluate(() => ({
      gm: window.GM_getValue('reducerToken', null),
      site: Object.keys(localStorage).some(k => String(localStorage.getItem(k)).includes('abc123')),
    }))
    check('token kept in GM only', !tokenField.error && tokenField.type === 'password' && kept.gm === 'abc123' && !kept.site, JSON.stringify({ ...tokenField, ...kept }))
    // Without Violentmonkey's storage the field is off: nothing is kept anywhere.
    const bare = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true })
    await bare.addInitScript({ content: INJECT.replace('window.GM_setValue = (k, v) => { store.set(k, JSON.stringify(v)) }', '') })
    const page2 = await bare.newPage()
    await page2.goto(START, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page2.waitForFunction(() => !!window.__ibh, null, { timeout: 30000 })
    const off = await panelToken(page2, 'xyz789')
    check('no GM storage: no token kept', !off.error && off.disabled && off.placeholder === 'Needs Violentmonkey storage', JSON.stringify(off))
    await bare.close()
  } catch (e) {
    // A step that throws stops the run: a failure, not a pass.
    check('smoke ran to the end', false, e.message.split('\n')[0])
  } finally {
    await browser.close()
    console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
    process.exitCode = failed ? 1 : 0
  }
})().catch(e => { console.error(e.message.split('\n')[0]); process.exit(1) })
