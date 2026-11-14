#!/usr/bin/env node
// Development helper, not part of the userscript.
//
// Inline GIFs that must not get stuck as still thumbnails, in a headless
// Firefox (Playwright) with the network faked: a safebooru-like listing is
// served from here, GIF downloads either answer at once or never answer
// (a stalled download), so no site and no phone are involved.
//
//   node tools/gif-test.js
//
// Each case is a way a GIF card stayed on its still until the page was
// reloaded or a post opened and closed (2026-11-14):
//   - downloads of GIFs scrolled past kept the three download slots;
//   - a GIF waiting its turn missed its wake-up while a finger was down on a
//     video card (nextGif skips during a scrub, and nobody called it after);
//   - a scene preview that could not start paused the GIFs on screen for good.
// And two buttons that must bring the GIFs on screen back at once (1.16.4):
// Redo thumbnails (↻) and Free memory & cache (🗑), never with inline GIFs off.

'use strict'
const fs = require('fs')
const path = require('path')
const { firefox } = require('playwright')

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'image-board-helper.user.js'), 'utf8')
const ORIGIN = 'https://safebooru.org'
const LISTING = `${ORIGIN}/index.php?page=post&s=list&tags=all`

// A 1×1 GIF with two frames (black, white), looping.
const hex = (/** @type {string[]} */ ...parts) => Buffer.from(parts.join(''), 'hex')
// One frame: 0.1 s delay, a 1×1 image, LZW (min code size 2) of a single pixel.
const frame = (/** @type {string} */ lzw) => hex('21f904000a000000', '2c', '00000000', '01000100', '00', '02', '02', lzw, '00')
const GIF = Buffer.concat([
  hex('474946383961', '01000100', '800000'),   // GIF89a, 1×1, a 2-colour global palette
  hex('000000', 'ffffff'),
  hex('21ff0b', Buffer.from('NETSCAPE2.0').toString('hex'), '0301000000'),   // loop forever
  frame('4401'),   // clear, index 0, end
  frame('4c01'),   // clear, index 1, end
  hex('3b'),
])
// A 1×1 PNG for the thumbnails (Firefox goes by the bytes, not the .jpg).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

// One card per entry: [hash, tags]. A hash starting with "hang" never answers.
// Cards sit 1200 px apart, so one scroll shows one card (viewport 780 px).
/** @param {Array<[string, string]>} cards */
function listing(cards) {
  const spans = cards.map(([hash, tags], i) =>
    `<span class="thumb" id="s${i + 1}" style="display:block;height:1200px">` +
    `<a id="p${i + 1}" href="index.php?page=post&amp;s=view&amp;id=${i + 1}">` +
    `<img src="${hash.startsWith('odd') ? `${ORIGIN}/odd/${hash}.jpg` : `${ORIGIN}/thumbnails/1/thumbnail_${hash}.jpg`}"` +
    ` alt=" ${tags} " title=" ${tags} " class="preview" width="150" height="150"></a></span>`).join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>test</title></head><body><div class="image-list">${spans}</div></body></html>`
}

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

// Opens the fake listing with these cards and this config in a fresh context.
/** @param {import('playwright').Browser} browser @param {Array<[string, string]>} cards @param {object} cfg @param {number} [latency] ms for every image-server answer, as a real network takes */
async function open(browser, cards, cfg, latency = 0) {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true })
  // No autopager: every page of this fake site is the same list, and a second
  // copy of the cards would share their ids.
  await context.addInitScript({ content: inject({ blockAds: false, videoCovers: false, favAutopager: false, scrubMode: 'drag', ...cfg }) })
  const asked = []
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== ORIGIN) return route.abort()
    if (url.pathname === '/index.php') return route.fulfill({ contentType: 'text/html', body: listing(cards) })
    if (latency && /\/(images|samples)\//.test(url.pathname)) await new Promise(r => setTimeout(r, latency))
    if (/\.jpe?g$/.test(url.pathname) && !/\/images\//.test(url.pathname)) return route.fulfill({ contentType: 'image/png', body: PNG })
    if (/\/images\/.+\.gif$/.test(url.pathname)) {
      asked.push(path.basename(url.pathname))
      if (path.basename(url.pathname).startsWith('hang')) return undefined   // never answers
      return route.fulfill({ contentType: 'image/gif', body: GIF })
    }
    return route.fulfill({ status: 404, body: '' })
  })
  const page = await context.newPage()
  // Downloads the browser gave up on: a GIF scrolled past must really be dropped.
  const dropped = []
  page.on('requestfailed', r => dropped.push(path.basename(new URL(r.url()).pathname)))
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(LISTING, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__ibh && window.__ibh.version, null, { timeout: 15000 })
  return { context, page, asked, dropped, errors }
}

// Scrolls so card n (1-based) is at the top, then lets the observers run.
/** @param {import('playwright').Page} page @param {number} n */
async function showCard(page, n) {
  await page.evaluate(i => window.scrollTo(0, document.getElementById(`s${i}`).offsetTop), n)
  await page.waitForTimeout(400)
}

/** @param {import('playwright').Page} page @param {number} n */
const gifState = (page, n) => page.evaluate(i => document.getElementById(`p${i}`).dataset.ibhGif || '', n)

/** @param {import('playwright').Page} page @param {number} n @param {number} ms */
const becomesPlaying = (page, n, ms) => page.waitForFunction(
  i => document.getElementById(`p${i}`).dataset.ibhGif === 'playing', n, { timeout: ms }).then(() => true, () => false)

// The script's own account of its GIFs (__ibh.gifs()) and its last GIF log lines.
/** @param {import('playwright').Page} page */
const gifsReport = page => page.evaluate(() =>
  `${window.__ibh.gifs ? JSON.stringify(window.__ibh.gifs()) : '(no gifs())'} ${[...document.querySelectorAll('.image-list a')].map(a =>
    `${a.id}:${a.dataset.ibhGif || '-'}${a.dataset.ibhSeen ? '+seen' : ''}`).join(' ')}\n${window.__ibh.tail(12, 'gif|scrub')}`)

// Taps one of the floating page buttons, in the script's shadow root: 'free'
// (the trash can, Free memory) or 'redo' (↻, Free memory and redo the thumbnails).
/** @param {import('playwright').Page} page @param {'free' | 'redo'} which */
const tapNavButton = (page, which) => page.evaluate(w => {
  const host = [...document.querySelectorAll('*')].find(e => e.shadowRoot && e.shadowRoot.querySelector('.feednav'))
  const row = host && [...host.shadowRoot.querySelectorAll('.feednav .row')].pop()
  const buttons = row ? [...row.querySelectorAll('button')] : []
  const btn = buttons[w === 'free' ? 0 : 1]
  if (btn) btn.click()
  return !!btn
}, which)

// How many cards show their animated .gif, every 200 ms for ms: [time, count] pairs.
/** @param {import('playwright').Page} page @param {number} ms */
const gifTimeline = (page, ms) => page.evaluate(total => new Promise(resolve => {
  const out = []
  const start = performance.now()
  const tick = () => {
    const shown = [...document.querySelectorAll('.image-list img')].filter(img => /\.gif/.test(img.currentSrc || '')).length
    out.push([Math.round(performance.now() - start), shown])
    if (performance.now() - start >= total) resolve(out)
    else setTimeout(tick, 200)
  }
  tick()
}), ms)

// Fires a pointer event at the middle of card n, the way a finger would.
/** @param {import('playwright').Page} page @param {number} n @param {string} type @param {number} dx */
const pointer = (page, n, type, dx = 0) => page.evaluate(([i, t, d]) => {
  const card = document.getElementById(`p${i}`)
  const r = card.getBoundingClientRect()
  card.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: r.left + r.width / 2 + d, clientY: r.top + r.height / 2 }))
}, [n, type, dx])

;(async () => {
  const browser = await firefox.launch({ headless: true })
  try {
    // 1. Three stalled downloads scrolled past must not hold the three
    //    download slots: the fourth GIF has to start.
    {
      const { context, page, asked, dropped } = await open(browser,
        [['hang1', 'animated_gif'], ['hang2', 'animated_gif'], ['hang3', 'animated_gif'], ['ok4', 'animated_gif']],
        { gifMaxLive: 2 })
      for (const n of [1, 2, 3, 4]) await showCard(page, n)
      const played = await becomesPlaying(page, 4, 5000)
      check('GIF after three stalled ones scrolled past starts', played,
        `card 4 is "${await gifState(page, 4)}", asked: ${asked.join(' ')}`)
      const hung = ['hang1.gif', 'hang2.gif', 'hang3.gif']
      check('their downloads are dropped', hung.every(f => dropped.includes(f)), `dropped: ${dropped.join(' ') || 'none'}`)
      await context.close()
    }

    // 2. A GIF waiting its turn starts once the finger lifts from a video
    //    card, though the slot freed up while the finger was down.
    {
      const { context, page } = await open(browser,
        [['vid1', 'video'], ['ok2', 'animated_gif'], ['ok3', 'animated_gif']],
        { gifMaxLive: 1 })
      // Cards 1–3 on one screen: shrink the spacing for this case.
      await page.addStyleTag({ content: 'span.thumb { height: 200px !important }' })
      await showCard(page, 1)
      const first = await becomesPlaying(page, 2, 5000)
      const queued = await gifState(page, 3)
      await pointer(page, 1, 'pointerdown')
      // Card 2 leaves the screen while the finger is down: its slot frees.
      await page.evaluate(() => { document.getElementById('s2').style.display = 'none' })
      await page.waitForTimeout(300)
      await pointer(page, 1, 'pointercancel')
      const played = await becomesPlaying(page, 3, 3000)
      check('queued GIF starts after a touch on a video card', first && queued === '' && played,
        `card 2 played: ${first}, card 3 "${queued}" then "${await gifState(page, 3)}", ${await gifsReport(page)}`)
      await context.close()
    }

    // 3. A scene preview that cannot start (no file to derive from the
    //    thumbnail) must leave the GIFs on screen playing.
    {
      const { context, page } = await open(browser,
        [['odd1', 'video'], ['ok2', 'animated_gif']],
        { gifMaxLive: 2 })
      await page.addStyleTag({ content: 'span.thumb { height: 200px !important }' })
      await showCard(page, 1)
      const before = await becomesPlaying(page, 2, 5000)
      await pointer(page, 1, 'pointerdown')
      await pointer(page, 1, 'pointermove', 40)   // sideways: a scrub
      await pointer(page, 1, 'pointerup', 40)
      const after = await becomesPlaying(page, 2, 3000)
      check('GIF keeps playing after a scrub that could not start', before && after,
        `card 2 before: ${before}, after: "${await gifState(page, 2)}"`)
      await context.close()
    }

    // 4–5. The page buttons with GIFs on screen: ↻ (Free memory, then redo
    //      every thumbnail) and the trash can (Free memory) must bring the
    //      GIFs on screen back, and soon.
    for (const which of /** @type {const} */ (['redo', 'free'])) {
      const { context, page } = await open(browser,
        [['ok1', 'animated_gif'], ['ok2', 'animated_gif'], ['ok3', 'animated_gif']],
        { gifMaxLive: 2 }, 300)
      await page.addStyleTag({ content: 'span.thumb { height: 200px !important }' })
      await showCard(page, 1)
      const before = await becomesPlaying(page, 1, 5000) && await becomesPlaying(page, 2, 5000)
      const tapped = await tapNavButton(page, which)
      const timeline = await gifTimeline(page, 6000)
      const back = timeline.find(([ms, n]) => ms > 0 && n >= 2)
      check(`${which === 'redo' ? '↻' : 'trash can'}: the GIFs on screen come back`, before && tapped && !!back,
        `${back ? `2 playing again after ${back[0]} ms` : 'not back in 6 s'}; timeline ${timeline.map(([ms, n]) => `${ms}:${n}`).join(' ')}\n${await gifsReport(page)}`)
      await context.close()
    }

    // 6. Inline GIFs off, video covers on: a card tagged "animated" alone is
    //    taken for a video, turns out a GIF when no video host has it, and
    //    must stay a still through the trash can and a scroll away and back.
    {
      const { context, page, asked } = await open(browser,
        [['anim1', 'animated'], ['x2', 'tagme'], ['x3', 'tagme']],
        { videoCovers: true, gifInline: false })
      await showCard(page, 1)
      const isGif = await page.waitForFunction(() => document.getElementById('p1').dataset.ibhKind === 'gif', null, { timeout: 8000 })
        .then(() => true, () => false)
      const askedBefore = asked.join(' ') || 'none'   // must be none, or the case tests nothing
      const tapped = await tapNavButton(page, 'free')
      await page.waitForTimeout(1500)
      const afterFree = await gifState(page, 1)
      check('GIFs off: the trash can leaves a GIF card on its still', isGif && askedBefore === 'none' && tapped && afterFree === '',
        `kind gif: ${isGif}, asked before: ${askedBefore}, card 1 after: "${afterFree}"`)
      await showCard(page, 3)
      await showCard(page, 1)
      await page.waitForTimeout(1000)
      const afterScroll = await gifState(page, 1)
      check('GIFs off: scrolled away and back, it stays on its still', isGif && afterScroll === '',
        `card 1 after: "${afterScroll}", asked: ${asked.join(' ') || 'none'}`)
      await context.close()
    }
  } finally {
    await browser.close()
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
