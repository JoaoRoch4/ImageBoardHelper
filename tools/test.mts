#!/usr/bin/env node
// Development helper, not part of the userscript.
//
// Opens a booru page (rule34 by default) in Playwright's headless Firefox
// with the userscript injected, the GM functions stubbed in memory as in
// tools/smoke.js, and reports what came back: a Cloudflare challenge, or
// the script's version, thumbnails and last log lines, plus a screenshot.
//
//   node tools/test.mts [URL] [--wait S] [--log N] [--eval EXPR] [--shot FILE] [--solve] [--firefox PACKAGE]
//
// The browser poses as the phone's Firefox (user agent, 360 px screen at
// DPR 2, touch) and keeps a profile in ~/.cache/ibh-test/profile. When
// Cloudflare answers with a challenge, the same browser is started visible
// on a virtual screen (Xvfb), shown in the phone's Firefox through noVNC
// (on 127.0.0.1 only, with a one-time password) for the user to solve; the
// pass Cloudflare then sets stays in the profile for the next runs.
// --solve opens that view even without a challenge; --firefox picks the
// phone's Firefox for it (default: the one the phone MCP last connected to).
// Needs: dnf install xorg-x11-server-Xvfb x11vnc novnc python3-websockify.
// TypeScript that Node runs as it is (it strips the types); tsc -p tools checks it.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { parseArgs } from 'node:util'
import { firefox } from 'playwright'
import type { BrowserContext, Page } from 'playwright'

const REPO = path.resolve(import.meta.dirname, '..')
const SCRIPT = fs.readFileSync(path.join(REPO, 'image-board-helper.user.js'), 'utf8')
const PHONE_UA = 'Mozilla/5.0 (Android 16; Mobile; rv:158.0) Gecko/158.0 Firefox/158.0'
const WORK = path.join(os.homedir(), '.cache', 'ibh-test')
const PROFILE = path.join(WORK, 'profile')   // cookies kept between runs: a solved challenge carries over
const RISH = path.join(os.homedir(), '.local', 'bin', 'rish')
const DISPLAY = ':99'
const VNC_PORT = 5999
const WEB_PORT = 6080

// What Violentmonkey would provide, in memory, and the feed on as the phone
// has it. @noframes by hand: init scripts run in every frame.
const INJECT = `if (window.top === window) {
  const store = new Map()
  window.GM_getValue = (k, d) => (store.has(k) ? JSON.parse(store.get(k)) : d)
  window.GM_setValue = (k, v) => { store.set(k, JSON.stringify(v)) }
  window.GM_xmlhttpRequest = d => setTimeout(() => d.onerror && d.onerror(new Error('stub')), 0)
  window.unsafeWindow = window
  try { if (!localStorage.getItem('IBH_CFG')) localStorage.setItem('IBH_CFG', JSON.stringify({ nativeFeed: true })) } catch (e) {}
  ${SCRIPT}
}`

// A Cloudflare challenge page instead of the site: its title, or its pieces.
// (Page code goes as strings: the tools are type-checked without the DOM.)
const CHALLENGE = `/just a moment|um momento|attention required/i.test(document.title) ||
  !!document.querySelector('#challenge-running, #challenge-form, .cf-turnstile, script[src*="challenge-platform"]')`

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const portOpen = (port: number) => new Promise<boolean>(resolve => {
  const sock = net.connect(port, '127.0.0.1')
  sock.on('connect', () => { sock.destroy(); resolve(true) })
  sock.on('error', () => resolve(false))
})

// Polls until check() holds: services start slowly under proot (websockify ~3 s).
async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(300)
  }
  throw new Error(`${what} did not start in ${ms / 1000} s`)
}

// The Firefox the phone MCP last connected to (Beta or Nightly).
function phoneFirefox() {
  try { return fs.readFileSync(path.join(os.homedir(), '.cache', 'ibh-mcp', 'firefox-app'), 'utf8').trim() || 'org.mozilla.fenix' } catch (e) { return 'org.mozilla.fenix' }
}

// A virtual screen, a VNC server on it and noVNC in front, all on 127.0.0.1.
async function startView(procs: ChildProcess[]) {
  const password = randomBytes(4).toString('hex')   // one-time: x11vnc reads at most 8 characters
  const pwFile = path.join(WORK, 'vnc.pass')
  fs.mkdirSync(WORK, { recursive: true })
  spawnSync('x11vnc', ['-storepasswd', password, pwFile], { stdio: 'ignore' })
  procs.push(spawn('Xvfb', [DISPLAY, '-screen', '0', '420x880x24', '-nolisten', 'tcp'], { stdio: 'ignore' }))
  await waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${DISPLAY.slice(1)}`), 'Xvfb')
  procs.push(spawn('x11vnc', ['-display', DISPLAY, '-localhost', '-rfbport', String(VNC_PORT), '-rfbauth', pwFile, '-forever', '-shared', '-quiet'], { stdio: 'ignore' }))
  await waitFor(() => portOpen(VNC_PORT), 'x11vnc')
  procs.push(spawn('websockify', ['--web', '/usr/share/novnc', `127.0.0.1:${WEB_PORT}`, `127.0.0.1:${VNC_PORT}`], { stdio: 'ignore' }))
  await waitFor(() => portOpen(WEB_PORT), 'websockify')
  return `http://127.0.0.1:${WEB_PORT}/vnc.html?autoconnect=1&resize=scale&password=${password}`
}

// The phone's Firefox opens a link, through Android's am (rish, uid shell).
function openOnPhone(url: string, app = phoneFirefox()) {
  spawnSync(RISH, ['-c', `am start -a android.intent.action.VIEW -d '${url}' ${app}`], { stdio: 'ignore', timeout: 60000 })
  return app
}

async function openBrowser(visible: boolean): Promise<{ context: BrowserContext; page: Page }> {
  fs.mkdirSync(PROFILE, { recursive: true })
  const env = Object.fromEntries(Object.entries({ ...process.env, DISPLAY }).filter((e): e is [string, string] => e[1] !== undefined))
  const context = await firefox.launchPersistentContext(PROFILE, {
    // Visible: kiosk, no tab strip or address bar for a stray tap to close the page.
    headless: !visible, ...(visible ? { env, args: ['-kiosk'] } : {}),
    viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, userAgent: PHONE_UA, locale: 'pt-BR',
  })
  await context.addInitScript({ content: INJECT })
  return { context, page: context.pages()[0] ?? await context.newPage() }
}

async function main() {
  const { values: opt, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      wait: { type: 'string', default: '8' },          // seconds to let the page and the script settle
      log: { type: 'string', default: '15' },          // last log lines to print
      eval: { type: 'string' },                        // a JS expression to evaluate in the page
      shot: { type: 'string', default: path.join(WORK, 'shot.png') },
      solve: { type: 'boolean', default: false },      // open the visible browser on the phone even without a challenge
      'solve-wait': { type: 'string', default: '300' }, // seconds to wait for the challenge to be solved
      firefox: { type: 'string' },                     // the phone's Firefox for the view: org.mozilla.firefox_beta, org.mozilla.fenix…
    },
  })
  const url = positionals[0] ?? 'https://rule34.xxx/index.php?page=post&s=list&tags=all'
  const wait = Number(opt.wait) * 1000
  const procs: ChildProcess[] = []
  const errors: string[] = []
  let { context, page } = await openBrowser(false)
  page.on('pageerror', e => errors.push(e.message))
  try {
    let res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(wait)

    if (opt.solve || await page.evaluate(CHALLENGE)) {
      // The same browser, visible on the virtual screen, shown on the phone.
      console.log(opt.solve ? 'opening the browser on the phone (--solve)' : 'Cloudflare challenge: opening the browser on the phone to be solved')
      await context.close()
      const address = await startView(procs)
      ;({ context, page } = await openBrowser(true))
      page.on('pageerror', e => errors.push(e.message))
      // Shown at once: a challenge page keeps loading on purpose, so waiting
      // for it first would leave the user looking at nothing.
      const loading = page.goto(url, { waitUntil: 'commit', timeout: 60000 }).then(r => { res = r }, e => console.log(`navigation: ${e.message.split('\n')[0]}`))
      const solveWait = Number(opt['solve-wait'])
      console.log(`shown in ${openOnPhone(address, opt.firefox)}: ${address.split('?')[0]}; waiting up to ${solveWait} s`)
      await loading
      // The page in front: another tab if this one closed, or the address again.
      const current = async () => {
        if (!page.isClosed()) return page
        page = context.pages().at(-1) ?? await context.newPage()
        if (page.url() === 'about:blank') res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
        console.log(`the page closed; now on ${page.url()}`)
        return page
      }
      const challenged = async () => { try { return !!await (await current()).evaluate(CHALLENGE) } catch (e) { return true } }   // mid-navigation: ask again
      const end = Date.now() + solveWait * 1000
      while (Date.now() < end && await challenged()) await sleep(2000)
      if (await challenged()) { console.log('still a challenge: gave up waiting'); return 2 }
      page = await current()
      if (opt.solve) await page.waitForTimeout(Math.min(solveWait, 60) * 1000)   // nothing to solve: time to look around
      console.log(opt.solve ? 'done' : 'past the challenge (the pass stays in the profile)')
      await page.waitForTimeout(wait)
    }

    fs.mkdirSync(path.dirname(opt.shot), { recursive: true })
    await page.screenshot({ path: opt.shot })
    console.log(`${res ? res.status() : '?'} ${page.url()}\ntitle: ${await page.title()}\nscreenshot: ${opt.shot}`)
    const version = await page.evaluate('window.__ibh && window.__ibh.version')
    if (!version) { console.log('the script did not start (no window.__ibh)'); return 1 }
    console.log(`script v${version}, ${await page.evaluate("document.querySelectorAll('.image-list span.thumb').length")} thumbnails`)
    console.log(await page.evaluate(`window.__ibh.tail(${Number(opt.log) || 15})`))
    if (opt.eval) console.log('eval:', JSON.stringify(await page.evaluate(`(${opt.eval})`), null, 2))
    if (errors.length) console.log(`page errors:\n  ${errors.slice(0, 5).join('\n  ')}`)
    return 0
  } finally {
    await context.close().catch(() => {})
    for (const p of procs.reverse()) p.kill()
  }
}

// Exits explicitly: a closed page can leave Playwright's pipe holding the event loop open.
main().then(code => process.exit(code), e => { console.error(e.message); process.exit(1) })
