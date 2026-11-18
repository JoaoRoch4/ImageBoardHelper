import type { Config } from '../core/config'
import type { Lang } from '../core/i18n'
import type { LogEntry } from '../core/log'
import { ACCENT, SITE, VERSION } from '../core/site'
import { CFG } from '../core/config'
import { LANG, resolveLang, setLang, t } from '../core/i18n'
import { LOG, LOG_MAX, dbg, describeError, error, info, logLine, setOnLogEntry } from '../core/log'
import { STATE, setOnStateChange } from '../core/state'
import { clearHostCache } from '../urls/hosts'
import { applyGifLimit } from '../thumbs/covers'
import { modal } from '../modal/modal'
import { setCfg } from '../storage/storage'
import { appControls, refreshAppStatus } from '../post/app'
import { ensureFavSearch } from '../lists/favorites'
import { apiSection, loadLikedIds, repaintCards } from '../thumbs/marks'
import { ensureSiteSearch } from '../search/site-search'
import { ensureFavPager } from '../lists/autopager'
import { PLAY_RATES, SEEK_JUMPS, applyPlayRate } from '../modal/player'
import { freeMemory, probeVideoUrls, redoThumbs } from '../diag'
import { ensureFeedNav, wantsFeedButtons } from './nav'
import { switchFeed } from '../page/feed-css'
import { applySiteTheme } from '../page/theme'

// ═══════════════════════════════════════════════════════════
// Status panel
// ═══════════════════════════════════════════════════════════

// Set and cleared together: shadow is panelHost's shadow root.
export let panelHost: HTMLDivElement | null = null
export function setPanelHost(v: typeof panelHost) { panelHost = v }
export let shadow: ShadowRoot | null = null
export function setShadow(v: typeof shadow) { shadow = v }
let logBox: HTMLDivElement | null = null

// The panel's own elements, found again by class in its shadow root. The
// script makes each of them (mountPanel, ensureFeedNav, pageToast), so a
// lookup is typed as what it made.
export type Controls = { '.fab': HTMLButtonElement, '.panel': HTMLDivElement, '.feednav:not(.pagenav)': HTMLDivElement,
  '.pagenav': HTMLDivElement, '.pagetoast': HTMLDivElement, '.favsfab': HTMLButtonElement,
  '.bulkfab': HTMLButtonElement, '.clockfab': HTMLButtonElement, '.eyefab': HTMLButtonElement }
export function control<K extends keyof Controls>(sel: K): Controls[K] | null {
  return shadow && (shadow.querySelector(sel) as Controls[K] | null)
}
let statusBox: HTMLDivElement | null = null
export let panelOpen = false

const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }

    .fab {
      position: fixed; left: 12px; bottom: 12px; z-index: 2147483000;
      width: 40px; height: 40px; border-radius: 50%;
      border: 1px solid #2a3a3f; background: #0f1417; color: ${ACCENT};
      font-size: 17px; line-height: 1; display: grid; place-items: center;
      box-shadow: 0 4px 14px rgba(0,0,0,.5);
    }
    .fab[data-alert="1"] { color: #fca5a5; border-color: #7f1d1d; }

    .feednav {
      position: fixed; right: 12px; bottom: 12px; z-index: 2147483000;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
    }
    .feednav .row { display: flex; gap: 8px; }
    .feednav button {
      width: 44px; height: 44px; border-radius: 50%;
      border: 1px solid #2a3a3f; background: rgba(15, 20, 23, .8); color: ${ACCENT};
      font-size: 26px; line-height: 1; display: grid; place-items: center;
      padding: 0 0 3px; box-shadow: 0 4px 14px rgba(0,0,0,.5);
    }
    .feednav button:active { background: #16211f; }
    .feednav button.on { background: ${ACCENT}; color: #0f1417; border-color: ${ACCENT}; }
    .feednav button.trash { display: grid; place-items: center; padding: 0; }
    .feednav button.trash svg { width: 20px; height: 20px; fill: currentColor; }
    /* Top right, against the top edge (lower, they covered the site's
       search field). */
    .laterfab {
      position: fixed; top: 6px; right: 12px; z-index: 2147483000;
      width: 44px; height: 44px; border-radius: 50%; padding: 0; display: grid; place-items: center;
      border: 1px solid #2a3a3f; background: rgba(15, 20, 23, .8); color: ${ACCENT};
      box-shadow: 0 4px 14px rgba(0,0,0,.5);
    }
    .laterfab:active { background: #16211f; }
    .laterfab svg { width: 22px; height: 22px; fill: currentColor; }
    .laterfab.bulkfab { right: 64px; }
    .laterfab.favsfab { right: 116px; }
    .feednav.pagenav { top: 6px; bottom: auto; right: auto; left: 12px; }
    .laterfab.on { background: ${ACCENT}; color: #0f1417; border-color: ${ACCENT}; }
    /* 👁: bottom left, beside ◐; in its place when the panel is off. */
    .eyefab {
      position: fixed; left: 60px; bottom: 12px; z-index: 2147483000;
      width: 40px; height: 40px; border-radius: 50%; padding: 0; display: grid; place-items: center;
      border: 1px solid #2a3a3f; background: rgba(15, 20, 23, .8); color: ${ACCENT};
      box-shadow: 0 4px 14px rgba(0,0,0,.5);
    }
    .eyefab.solo { left: 12px; }
    .eyefab svg { width: 20px; height: 20px; fill: currentColor; }
    /* Hidden by the eye: every other button, and the eye fades. */
    :host(.ibh-clean) .fab, :host(.ibh-clean) .panel, :host(.ibh-clean) .feednav, :host(.ibh-clean) .laterfab { display: none !important; }
    :host(.ibh-clean) .eyefab { opacity: .4; box-shadow: none; }
    .pagetoast {
      position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%); z-index: 2147483000; max-width: 86vw;
      padding: 8px 14px; border-radius: 18px; background: rgba(15, 20, 23, .92); color: #d7dee0;
      font-size: 13px; text-align: center; pointer-events: none; transition: opacity .2s;
    }
    .panel:not([hidden]) ~ .laterfab, .panel:not([hidden]) ~ .bulkfab, .panel:not([hidden]) ~ .favsfab, .panel:not([hidden]) ~ .pagenav { display: none; }
    .feednav button:disabled { opacity: .35; }

    .panel {
      position: fixed; left: 12px; bottom: 60px; z-index: 2147483000;
      width: min(360px, calc(100vw - 24px)); max-height: 70vh;
      display: flex; flex-direction: column;
      background: #0f1417; color: #d7dee0;
      border: 1px solid #2a3a3f; border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,.6);
      font-size: 13px;
    }
    .panel[hidden] { display: none; }
    /* The floating buttons sit over the panel's bottom (they covered Reload):
       hidden while it is open. The nav is appended after the panel. */
    .panel:not([hidden]) ~ .feednav { display: none; }

    header {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; border-bottom: 1px solid #1c272b;
    }
    header b { font-weight: 600; font-size: 13px; color: #e8f0f1; }
    header span { color: #62777d; font-size: 11px; }
    header button {
      margin-left: auto; background: none; border: 0;
      color: #62777d; font-size: 18px; line-height: 1; padding: 0 4px;
    }

    .body { overflow-y: auto; padding: 4px 0; }

    .row { display: flex; align-items: baseline; gap: 8px; padding: 5px 12px; }
    .row .k { color: #7c9297; min-width: 104px; flex-shrink: 0; }
    .row .v { color: #d7dee0; word-break: break-all; }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; }
    /* Scoped to .dot: log lines reuse the level names as classes. */
    .dot.ok   { background: #4ade80; }
    .dot.warn { background: #fbbf24; }
    .dot.bad  { background: #f87171; }
    .dot.idle { background: #475569; }

    .sec {
      padding: 8px 12px 4px; color: #4e6469; font-size: 11px;
      border-top: 1px solid #1c272b; margin-top: 4px;
    }

    label.tog { display: flex; align-items: center; gap: 10px; padding: 7px 12px; }
    label.tog input { accent-color: ${ACCENT}; width: 16px; height: 16px; }
    label.tog .note { margin-left: auto; color: #4e6469; font-size: 10px; }

    .apiwarn { margin: 4px 12px 6px; padding: 7px 9px; border-radius: 6px; font-size: 11px; line-height: 1.4;
      color: #f5d38a; background: rgba(245, 180, 60, .12); border: 1px solid rgba(245, 180, 60, .35); }
    .lang { padding: 4px 12px 8px; }
    .lang .lbl { color: #4e6469; font-size: 11px; padding-bottom: 4px; }
    .lang .appstatus { padding: 4px 0 0; }
    .lang select, .lang input.apptoken {
      width: 100%; box-sizing: border-box; padding: 7px 8px; font-size: 12px;
      background: #0a0e10; color: #d7dee0;
      border: 1px solid #234a45; border-radius: 6px;
    }

    .acts { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 12px; }
    .acts button {
      flex: 1 1 auto; padding: 7px 10px;
      background: #16211f; color: ${ACCENT};
      border: 1px solid #234a45; border-radius: 6px; font-size: 12px;
    }

    .log {
      margin: 0 12px 12px; padding: 8px; max-height: 190px; overflow-y: auto;
      background: #0a0e10; border: 1px solid #1c272b; border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px; line-height: 1.5;
    }
    .log div { display: flex; gap: 6px; }
    .log .ts { color: #3c4d51; flex-shrink: 0; }
    .log .ts + span { min-width: 0; overflow-wrap: anywhere; }   /* long URLs wrap */
    .log .debug { color: #6b8085; }
    .log .info  { color: #a8b8bb; }
    .log .warn  { color: #fbbf24; }
    .log .error { color: #f87171; }
  `

/**
 * @param attrs   text and class set those; the rest are attributes
 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string> | null, children?: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v
    else if (k === 'class') node.className = v
    else node.setAttribute(k, v)
  }
  // Children are nodes or plain strings (as text).
  if (children) children.forEach(c => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c))
  return node
}

const statusRow = (key: string, value: string, tone: 'ok' | 'warn' | 'idle') => el('div', { class: 'row' }, [
  el('span', { class: `dot ${tone}` }),
  el('span', { class: 'k', text: key }),
  el('span', { class: 'v', text: String(value) }),
])

let renderingStatus = false   // guard: anything below that calls touch() must not re-enter

export function renderStatus() {
  if (!statusBox || renderingStatus) return
  renderingStatus = true
  try { drawStatus() } finally { renderingStatus = false }
}

// Called by renderStatus, with the status box there.
function drawStatus() {
  (statusBox as HTMLDivElement).textContent = ''

  const c = STATE.covers
  const coverTone = c.tracked === 0 ? 'idle' : c.failed > 0 ? 'warn' : c.ok > 0 ? 'ok' : 'idle'
  const hostLabel = STATE.imageBase
    ? STATE.imageBase + (STATE.baseCached ? ` (${t('cached')})` : '')
    : t('notResolved')

  const rows = [
    statusRow(t('site'), SITE, 'ok'),
    statusRow(t('host'), hostLabel, STATE.imageBase ? 'ok' : 'warn'),
    statusRow(t('covers'), t('coversFmt')(c.ok, c.failed, c.tracked), coverTone),
  ]
  rows.forEach(r => (statusBox as HTMLDivElement).appendChild(r))
}

function appendLogLine(entry: LogEntry) {
  if (!logBox) return
  const time = new Date(entry.t).toTimeString().slice(0, 8)
  logBox.appendChild(el('div', null, [
    el('span', { class: 'ts', text: time }),
    el('span', { class: entry.level, text: entry.msg }),
  ]))
  while (logBox.childElementCount > LOG_MAX) (logBox.firstElementChild as Element).remove()   // past LOG_MAX: there is one
  logBox.scrollTop = logBox.scrollHeight
  if (entry.level === 'error' && shadow) {
    const fab = control('.fab')
    if (fab) fab.dataset.alert = '1'
  }
}

// `then` runs after the change, for options that apply at once.
export type BoolKey = { [K in keyof Config]: Config[K] extends boolean ? K : never }[keyof Config]
export function toggle(key: BoolKey, label: string, note?: string | null, then?: () => void) {
  const input = el('input', { type: 'checkbox' })
  input.checked = !!CFG[key]
  input.addEventListener('change', () => {
    setCfg(key, input.checked)
    if (then) then()
    renderStatus()
  })
  const row = el('label', { class: 'tog' }, [input, el('span', { text: label })])
  if (note) row.appendChild(el('span', { class: 'note', text: note }))
  return row
}

// Gesture for the scene preview on thumbnails: drag sideways, or hold.
// A labelled select bound to a config key; `then` runs after the change.
/**
 * @param choices   value and label
 */
function choiceSelect(key: keyof Config, title: string, choices: Array<[string | number, string]>, then?: () => void) {
  const sel = el('select')
  for (const [value, label] of choices) {
    const option = el('option', { value: String(value), text: label })
    if (String(CFG[key]) === String(value)) option.setAttribute('selected', '')
    sel.appendChild(option)
  }
  sel.addEventListener('change', () => {
    // One of the options above; its value fits the key, which is the caller's to match.
    const picked = choices.find(([value]) => String(value) === sel.value) as [string | number, string]
    setCfg(key, picked[0] as any)   // keeps numbers as numbers
    if (then) then()
  })
  return el('div', { class: 'lang' }, [el('div', { class: 'lbl', text: title }), sel])
}

// Gesture for the scene preview on thumbnails; the slideshow's jump and
// seconds only show in hold mode, so switching modes redraws the panel.
function scrubModeControls(body: HTMLElement) {
  body.appendChild(choiceSelect('scrubMode', t('tScrubMode'),
    [['drag', t('modeDrag')], ['hold', t('modeHold')]], rebuildPanel))
  body.appendChild(toggle('holdRub', t('tHoldRub')))   // also the post's player, whatever the mode
  if (CFG.scrubMode !== 'hold') return
  // The slideshow's own settings only matter without holdVideo.
  body.appendChild(toggle('holdVideo', t('tHoldVideo'), null, rebuildPanel))
  body.appendChild(toggle('previewSound', t('tPreviewSound')))
  body.appendChild(toggle('holdResume', t('tHoldResume')))
  if (CFG.holdVideo) return
  const num = (n: number) => n.toLocaleString(LANG)
  body.appendChild(choiceSelect('slideStep', t('tSlideStep'),
    [5, 10, 20, 25].map(p => [p, `${num(p)}% · ${Math.round(100 / p)} ${t('scenes')}`])))
  body.appendChild(choiceSelect('slideDwell', t('tSlideDwell'),
    [0.1, 0.2, 0.3, 0.5, 1].map(sec => [sec, `${num(sec)} s`])))
  body.appendChild(toggle('slideReel', t('tSlideReel')))
  body.appendChild(toggle('wasmDecode', t('tWasmDecode')))
}

function languageSelect() {
  const sel = el('select')
  for (const [value, label] of [['', t('auto')], ['pt-BR', 'Português'], ['en', 'English']]) {
    const option = el('option', { value, text: label })
    if ((CFG.lang || '') === value) option.setAttribute('selected', '')
    sel.appendChild(option)
  }
  sel.addEventListener('change', () => {
    setCfg('lang', (sel.value as Lang | '') || null)   // the options are the languages, or '' for automatic
    setLang(resolveLang())
    rebuildPanel()   // labels are baked at build time, so rebuild
  })
  return el('div', { class: 'lang' }, [sel])
}

const actionButton = (label: string, fn: () => void) => {
  const b = el('button', { text: label })
  b.addEventListener('click', fn)
  return b
}

function buildPanel() {
  const panel = el('div', { class: 'panel' })
  if (!panelOpen) panel.setAttribute('hidden', '')

  const closeBtn = el('button', { text: '×' })
  closeBtn.addEventListener('click', () => togglePanel(false))
  panel.appendChild(el('header', null, [
    el('b', { text: 'Image Board Helper' }),
    el('span', { text: `v${VERSION}` }),
    closeBtn,
  ]))

  const body = el('div', { class: 'body' })
  statusBox = el('div')
  body.appendChild(statusBox)

  body.appendChild(el('div', { class: 'sec', text: t('fixes') }))
  body.appendChild(toggle('originalThumbs', t('tOriginal'), t('noteReload')))
  body.appendChild(toggle('nativeFeed', t('tFeed'), null, () => { switchFeed(); rebuildPanel() }))
  if (CFG.nativeFeed) {
    body.appendChild(choiceSelect('feedColumns', t('tFeedCols'),
      [['auto', t('colsAuto')], [1, '1'], [2, '2'], [3, '3'], [4, '4']], switchFeed))
    body.appendChild(choiceSelect('feedLayout', t('tFeedLayout'),
      [['masonry', t('layoutMasonry')], ['grid', t('layoutGrid')]], switchFeed))
  }
  body.appendChild(toggle('feedNav', t('tNav'), t('noteReload')))
  body.appendChild(toggle('bulkFavButton', t('tBulkBtn'), null, ensureFeedNav))
  body.appendChild(toggle('doubleTapFav', t('tDoubleTap'), null, rebuildPanel))
  if (CFG.doubleTapFav) body.appendChild(choiceSelect('doubleTapLike', t('tDoubleTapLike'), [['heart', t('likeHeart')], ['quiet', t('likeQuiet')]]))
  body.appendChild(toggle('likedBadge', t('tLikedBadge'), null, () => { loadLikedIds(); repaintCards() }))
  body.appendChild(toggle('favAutoIndex', t('tFavAutoIndex')))
  body.appendChild(toggle('favsButton', t('tFavsBtn'), null, ensureFeedNav))
  body.appendChild(toggle('holdRaw', t('tHoldRaw')))
  body.appendChild(toggle('freeButton', t('tFreeBtn'), null, ensureFeedNav))
  body.appendChild(toggle('redoButton', t('tRedoBtn'), null, ensureFeedNav))
  body.appendChild(toggle('eyeButton', t('tEyeBtn'), null, ensureFeedNav))
  body.appendChild(toggle('laterButton', t('tLaterBtn'), null, ensureFeedNav))
  body.appendChild(toggle('favSearch', t('tFavSearch'), null, ensureFavSearch))
  body.appendChild(toggle('favAutopager', t('tPager'), null, ensureFavPager))
  body.appendChild(toggle('siteSearch', t('tSiteSearch'), null, ensureSiteSearch))
  body.appendChild(toggle('searchSuggest', t('tSuggest')))
  body.appendChild(toggle('videoModal', t('tModal'), t('noteReload')))
  body.appendChild(toggle('siteTheme', t('tTheme'), null, applySiteTheme))
  body.appendChild(toggle('blockAds', t('tAds'), t('noteReload')))
  body.appendChild(toggle('rotateLandscape', t('tRotate')))
  body.appendChild(toggle('modalPreload', t('tPreload')))
  body.appendChild(toggle('playerButton', t('tPlayerBtn')))
  body.appendChild(toggle('appBridge', t('tAppBridge'), null, rebuildPanel))
  if (CFG.appBridge) body.appendChild(appControls())
  body.appendChild(toggle('copyLinkButton', t('tCopyBtn')))
  body.appendChild(toggle('seekReel', t('tSeekReel')))
  const onScreen = () => { if (modal) applyPlayRate(modal.video) }
  body.appendChild(choiceSelect('playRate', t('tPlayRate'), PLAY_RATES.map(r => [r, `${r.toLocaleString(LANG)}×`]), onScreen))
  body.appendChild(choiceSelect('seekStep', t('tSeekStep'), SEEK_JUMPS.map(s => [s, `${s} s`])))
  body.appendChild(choiceSelect('doubleTapCenter', t('tDoubleTapCenter'), [['fullscreen', t('dtFullscreen')], ['like', t('dtLike')]]))
  body.appendChild(choiceSelect('modalOriginal', t('tModalOrig'), [['zoom', t('origZoom')], ['always', t('origAlways')]]))
  body.appendChild(toggle('videoCovers', t('tCovers')))
  body.appendChild(toggle('thumbBadges', t('tBadges'), t('noteReload')))
  body.appendChild(toggle('gifInline', t('tGif')))
  body.appendChild(choiceSelect('gifMaxLive', t('tGifMax'), [1, 2, 3, 4, 6, 10].map(n => [n, String(n)]), applyGifLimit))
  body.appendChild(toggle('holdGif', t('tHoldGif')))
  body.appendChild(toggle('videoScrub', t('tScrub'), t('noteReload')))
  scrubModeControls(body)
  body.appendChild(toggle('memorySaver', t('tMemory'), t('noteReload')))
  body.appendChild(toggle('urlCache', t('tUrlCache')))
  body.appendChild(toggle('debug', t('tDebug')))

  apiSection(body)

  body.appendChild(el('div', { class: 'sec', text: t('language') }))
  body.appendChild(languageSelect())

  body.appendChild(el('div', { class: 'sec', text: t('log') }))
  logBox = el('div', { class: 'log' })
  LOG.forEach(appendLogLine)
  body.appendChild(logBox)

  body.appendChild(el('div', { class: 'acts' }, [
    actionButton(t('bTest'), probeVideoUrls),
    actionButton(t('bClearHost'), () => { clearHostCache(); renderStatus() }),
    actionButton(t('bRedo'), () => { redoThumbs(); renderStatus() }),
    actionButton(t('bFree'), () => { freeMemory().then(renderStatus) }),
    actionButton(t('bCopy'), copyLog),
    actionButton(t('bReload'), () => location.reload()),
  ]))

  panel.appendChild(body)
  return panel
}

function copyLog() {
  const head = `Image Board Helper v${VERSION} · ${SITE}\n` +
    `UA: ${navigator.userAgent}\n` +
    `host: ${STATE.imageBase}\n\n`
  const body = LOG.map(logLine).join('\n')

  navigator.clipboard.writeText(head + body)
    .then(() => info('log copied'))
    .catch(e => error(`could not copy the log — ${describeError(e)}`))
}

/** @param open   leave it out to switch */
export function togglePanel(open?: boolean) {
  panelOpen = open == null ? !panelOpen : open
  const panel = control('.panel')
  if (!panel) return
  panel.hidden = !panelOpen
  if (panelOpen) {
    renderStatus()
    refreshAppStatus()
    const fab = control('.fab')
    if (fab) delete fab.dataset.alert
  }
}

export function mountPanel() {
  const nav = wantsFeedButtons() || CFG.freeButton || CFG.redoButton || CFG.laterButton || CFG.bulkFavButton || CFG.favsButton || CFG.eyeButton
  if (!CFG.panel && !nav) return
  if (panelHost && panelHost.isConnected) return
  if (!document.body) return

  // Shadow DOM isolates us from the site's aggressive CSS
  // (html, body { ... !important } plus a global box-sizing reset).
  panelHost = el('div')
  panelHost.style.cssText = 'all:initial;position:static'
  shadow = panelHost.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = PANEL_CSS
  shadow.appendChild(style)

  if (CFG.panel) {
    const fab = el('button', { class: 'fab', text: '◐', title: 'Image Board Helper' })
    fab.addEventListener('click', () => togglePanel())
    shadow.appendChild(fab)
    shadow.appendChild(buildPanel())
  }
  document.body.appendChild(panelHost)
  ensureFeedNav()
  if (CFG.panel) {
    setOnLogEntry(appendLogLine)
    setOnStateChange(() => { if (panelOpen) renderStatus() })
    if (panelOpen) renderStatus()
  }
  dbg('panel mounted')
}

/** Labels are baked when the panel is built, so switching language rebuilds it. */
export function rebuildPanel() {
  if (panelHost) panelHost.remove()
  panelHost = null
  shadow = null
  mountPanel()
}
