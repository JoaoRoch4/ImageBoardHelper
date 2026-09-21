// ==UserScript==
// @name         Image Board Helper
// @namespace    joao.imageboardhelper
// @version      0.7.0
// @description  Touch gestures, sharp thumbnails, real video covers and a Fancybox repair for Booru Masonry, with a status panel and log
// @author       João
// @homepageURL  https://github.com/JoaoRoch4/ImageBoardHelper
// @source       https://github.com/JoaoRoch4/ImageBoardHelper
// @supportURL   https://github.com/JoaoRoch4/ImageBoardHelper/issues
// @license      MIT
// @match        https://yande.re/*
// @match        https://konachan.com/*
// @match        https://konachan.net/*
// @match        https://danbooru.donmai.us/*
// @match        https://gelbooru.com/*
// @match        https://rule34.xxx/*
// @match        https://lolibooru.moe/*
// @match        https://www.sakugabooru.com/*
// @match        https://safebooru.org/*
// @match        https://tbib.org/*
// @match        https://xbooru.com/*
// @match        https://realbooru.com/*
// @match        https://booru.allthefallen.moe/*
// @match        https://aibooru.online/*
// @match        https://rule34hentai.net/*
// @match        https://rule34.paheal.net/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * A companion layer for the "Yande.re Masonry" userscript, aimed at phones.
 * It never modifies that script: it talks to it through public surfaces only.
 *
 *   A. SHARP THUMBNAILS
 *      Masonry's getImgSrc only swaps previewUrl for sampleUrl when
 *      `isThumbSampleUrl || (columns != 0 && columns < 7)`. With columns set to
 *      "Automatic" the value is 0, the condition never passes, and you are left
 *      with the small thumbnail stretched — and automatic is the default. We
 *      enable isThumbSampleUrl before the app reads its settings, so the app
 *      itself picks the large URL, per site.
 *
 *   B. VIDEO COVERS
 *      Video posts are excluded from that swap, because a video's sampleUrl is
 *      the .mp4 itself and will not render inside an <img>. We overlay a
 *      <video muted preload="metadata"> on the card: the browser paints the
 *      real frame and nothing is read back, so CORS never enters the picture —
 *      unlike grabbing the frame through a <canvas>.
 *
 *   C. FANCYBOX
 *      fancyboxShow builds items as `src: e.jpegUrl || e.fileUrl`, but several
 *      adapters return fileUrl:"" on purpose: the URL only exists after the
 *      detail fetch, which only the native viewer triggers. We intercept
 *      Fancybox.show and fill the empty src values.
 *
 *   D. GESTURES
 *      Masonry listens for keyup on window (A/left, D/right, F). We dispatch
 *      synthetic key events and click toolbar buttons, located by the `d`
 *      attribute of the icon <path>.
 *
 * WHY @grant none: intercepting window.Fancybox and overriding
 * navigator.userAgent both require the page's own realm. Any @grant puts the
 * script in a sandbox where `window` is not the page's window, and both stop
 * working silently. That is why the options live in the panel instead of
 * GM_registerMenuCommand.
 *
 * REQUIRES: "Listen for keyboard events" enabled in Masonry's settings,
 * otherwise the navigation swipes do nothing.
 */

;(function () {
  'use strict'

  const VERSION = '0.7.0'
  const SITE = location.hostname.replace(/^www\./, '')

  // ═══════════════════════════════════════════════════════════
  // Persisted configuration
  // ═══════════════════════════════════════════════════════════

  const CFG_KEY = 'IBH_CFG'

  const DEFAULTS = {
    lang:           null,   // null = follow the browser language
    debug:          false,  // mirror the log into the browser console
    panel:          true,   // floating button and status panel
    sharpThumbs:    true,   // enable "thumbnail uses large image" (needs reload)
    videoCovers:    true,   // overlay the real video frame on the card
    fixFancybox:    true,   // fill empty src in the alternate viewer
    gestures:       true,   // swipe, double tap and pinch
    forceRule34Api: false,  // see applyRule34ApiUnlock (needs reload)
  }

  // Options that only take effect when the app boots.
  const NEEDS_RELOAD = new Set(['sharpThumbs', 'forceRule34Api'])

  const CFG = Object.assign({}, DEFAULTS, readJSON(CFG_KEY, {}))

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : fallback
    } catch (e) {
      return fallback
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
      return true
    } catch (e) {
      return false
    }
  }

  function setCfg(key, value) {
    CFG[key] = value
    writeJSON(CFG_KEY, CFG)
    info(`option ${key} = ${value}${NEEDS_RELOAD.has(key) ? ' (reload the page)' : ''}`)
  }

  // ═══════════════════════════════════════════════════════════
  // Interface strings
  //
  // Only the panel chrome is translated. Log lines stay in English on purpose:
  // they are meant to be pasted into issues and read by whoever is debugging,
  // and mixed-language bug reports are worse than English-only ones.
  // ═══════════════════════════════════════════════════════════

  const I18N = {
    en: {
      fixes: 'fixes', log: 'log', language: 'language', auto: 'Automatic',
      site: 'site', gallery: 'gallery', thumbnail: 'thumbnail',
      columns: 'columns', host: 'host', covers: 'covers',
      fancybox: 'fancybox', credential: 'credential', lastGesture: 'last gesture',
      notDetected: 'not detected', active: 'active', waiting: 'waiting',
      failed: 'failed', disabled: 'off',
      largeImage: 'large image', smallThumb: 'small thumbnail',
      notResolved: 'not resolved', cached: 'cached',
      filled: 'filled', empty: 'empty',
      coversFmt: (ok, bad, all) => `${ok} ok · ${bad} failed · ${all} videos`,
      tSharp: 'Large thumbnails', tCovers: 'Video covers',
      tFancybox: 'Repair Fancybox', tGestures: 'Touch gestures',
      tApi: 'Force API (loses filters)', tDebug: 'Log to console',
      noteReload: 'reload',
      bTest: 'Test URLs', bClearHost: 'Clear host',
      bCopy: 'Copy log', bReload: 'Reload',
      gNext: 'swipe left → next', gPrev: 'swipe right → previous',
      gClose: 'swipe down → close', gFav: 'double tap → favorite',
      gZoomIn: 'pinch out → zoom in', gZoomOut: 'pinch in → zoom out',
    },
    'pt-BR': {
      fixes: 'correções', log: 'log', language: 'idioma', auto: 'Automático',
      site: 'site', gallery: 'galeria', thumbnail: 'miniatura',
      columns: 'colunas', host: 'host', covers: 'capas',
      fancybox: 'fancybox', credential: 'credencial', lastGesture: 'último gesto',
      notDetected: 'não detectado', active: 'ativo', waiting: 'aguardando',
      failed: 'falhou', disabled: 'desligado',
      largeImage: 'imagem grande', smallThumb: 'miniatura pequena',
      notResolved: 'não resolvido', cached: 'cache',
      filled: 'preenchida', empty: 'vazia',
      coversFmt: (ok, bad, all) => `${ok} ok · ${bad} falha · ${all} vídeos`,
      tSharp: 'Miniatura grande', tCovers: 'Capa de vídeo',
      tFancybox: 'Consertar Fancybox', tGestures: 'Gestos de toque',
      tApi: 'Forçar API (perde filtros)', tDebug: 'Log no console',
      noteReload: 'recarregar',
      bTest: 'Testar URLs', bClearHost: 'Limpar host',
      bCopy: 'Copiar log', bReload: 'Recarregar',
      gNext: 'swipe ← → próxima', gPrev: 'swipe → → anterior',
      gClose: 'swipe ↓ → fechar', gFav: 'toque duplo → favoritar',
      gZoomIn: 'pinça abrir → zoom+', gZoomOut: 'pinça fechar → zoom−',
    },
  }

  /** Active language: explicit choice first, otherwise the browser's. */
  function resolveLang() {
    if (CFG.lang && I18N[CFG.lang]) return CFG.lang
    return String(navigator.language || 'en').toLowerCase().startsWith('pt')
      ? 'pt-BR'
      : 'en'
  }

  let LANG = resolveLang()

  const t = key => {
    const value = I18N[LANG][key]
    return value === undefined ? I18N.en[key] : value
  }

  // ═══════════════════════════════════════════════════════════
  // Log
  // ═══════════════════════════════════════════════════════════

  const LOG = []
  const LOG_MAX = 250
  let onLogEntry = null   // the panel subscribes here once mounted

  function log(level, msg) {
    const entry = { t: Date.now(), level, msg: String(msg) }
    LOG.push(entry)
    if (LOG.length > LOG_MAX) LOG.shift()

    // Errors and warnings always reach the console; the rest only in debug.
    if (CFG.debug || level === 'error' || level === 'warn') {
      const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'
      console[fn](`[IBH] ${msg}`)
    }
    if (onLogEntry) onLogEntry(entry)
  }

  const dbg   = m => log('debug', m)
  const info  = m => log('info', m)
  const warn  = m => log('warn', m)
  const error = m => log('error', m)

  const describeError = e => (e && e.message ? e.message : String(e))

  // ═══════════════════════════════════════════════════════════
  // State observed by the panel
  // ═══════════════════════════════════════════════════════════

  const STATE = {
    masonry: false,        // flips once a card shows up
    thumbMode: null,       // 'large' | 'small'
    columns: null,
    credential: false,
    imageBase: null,
    baseCached: false,
    covers: { tracked: 0, ok: 0, failed: 0 },
    fancybox: 'waiting',   // waiting | active | failed | disabled
    lastGesture: null,     // i18n key, so the label follows the language
    gestureCount: 0,
  }

  let onStateChange = null
  const touch = () => { if (onStateChange) onStateChange() }

  // ═══════════════════════════════════════════════════════════
  // Reading Masonry's own settings
  // ═══════════════════════════════════════════════════════════

  const MASONRY_KEY = 'YM_APP_SETTINGS'
  const masonrySettings = () => readJSON(MASONRY_KEY, {})

  function readMasonryState() {
    const s = masonrySettings()
    STATE.credential = !!s.credentialQuery
    STATE.columns = s.selectedColumn == null ? '0' : s.selectedColumn
    STATE.thumbMode = s.isThumbSampleUrl ? 'large' : 'small'
    touch()
  }

  // ═══════════════════════════════════════════════════════════
  // A. Sharp thumbnails
  // ═══════════════════════════════════════════════════════════

  function applySharpThumbs() {
    if (!CFG.sharpThumbs) { dbg('sharp thumbnails disabled'); return }
    const s = masonrySettings()
    if (s.isThumbSampleUrl === true) { dbg('large thumbnails already enabled'); return }

    // Record why thumbnails were coming in small.
    if (s.selectedColumn === '0' || s.selectedColumn == null) {
      dbg('columns set to automatic: getImgSrc can never reach sampleUrl')
    }
    s.isThumbSampleUrl = true
    if (writeJSON(MASONRY_KEY, s)) info('enabled "thumbnail uses large image"')
    else warn('could not write Masonry settings')
  }

  // ═══════════════════════════════════════════════════════════
  // Image server resolution
  //
  // Several boorus serve thumbnails and files from different hosts, and some
  // mirrors only carry thumbnails. Deriving the file from the thumbnail host
  // gives a silent 404. Resolve the host once, skipping known mirrors.
  // ═══════════════════════════════════════════════════════════

  const HOSTS = {
    'rule34.xxx': {
      thumbsOnly: ['miami.rule34.xxx', 'ny.rule34.xxx'],
      fallback: 'https://wimg.rule34.xxx/images',
      videoHost: 'https://api-cdn-mp4.rule34.xxx/images',
    },
  }

  const HOST_CFG = HOSTS[SITE] || {}
  const HOST_KEY = `IBH_IMGBASE_${SITE}`
  const HOST_TTL = 7 * 24 * 60 * 60 * 1000

  function imageBase() {
    const cached = readJSON(HOST_KEY, null)
    if (cached && Date.now() < cached.exp) {
      STATE.imageBase = cached.base
      STATE.baseCached = true
      return cached.base
    }

    let base = null
    const thumb = document.querySelector('img[src*="/thumbnails/"]')
    if (thumb) {
      try {
        const u = new URL(thumb.src)
        if ((HOST_CFG.thumbsOnly || []).includes(u.host)) {
          dbg(`${u.host} only serves thumbnails, skipping`)
        } else {
          base = `${u.protocol}//${u.host}/images`
          dbg(`host detected on page: ${base}`)
        }
      } catch (e) {
        warn(`invalid thumbnail src: ${describeError(e)}`)
      }
    }

    if (!base && HOST_CFG.fallback) {
      base = HOST_CFG.fallback
      dbg(`using fallback host: ${base}`)
    }

    STATE.baseCached = false
    STATE.imageBase = base
    if (base) writeJSON(HOST_KEY, { base, exp: Date.now() + HOST_TTL })
    touch()
    return base
  }

  function clearHostCache() {
    try { localStorage.removeItem(HOST_KEY) } catch (e) { /* ignore */ }
    STATE.imageBase = null
    info('host cache cleared')
    imageBase()
  }

  /** Pull DIR and HASH out of .../thumbnails/DIR/thumbnail_HASH.jpg */
  function thumbParts(thumbUrl) {
    if (!thumbUrl) return null
    const m = thumbUrl.replace(/\?.*$/, '')
      .match(/\/thumbnails\/(.+)\/thumbnail_([^/]+)\.(?:jpe?g|png)$/i)
    return m ? { dir: m[1], hash: m[2] } : null
  }

  /** URLs to try, most likely first. */
  function fileCandidates(thumbUrl, exts) {
    const p = thumbParts(thumbUrl)
    if (!p) return []

    const bases = []
    const wantsVideo = exts.some(e => e === 'mp4' || e === 'webm')
    if (wantsVideo && HOST_CFG.videoHost) bases.push(HOST_CFG.videoHost)
    const resolved = imageBase()
    if (resolved) bases.push(resolved)
    try { bases.push(`${new URL(thumbUrl).origin}/images`) } catch (e) { /* ignore */ }

    const out = []
    for (const base of [...new Set(bases)]) {
      for (const ext of exts) out.push(`${base}/${p.dir}/${p.hash}.${ext}`)
    }
    return out
  }

  // ═══════════════════════════════════════════════════════════
  // B. Real video covers
  // ═══════════════════════════════════════════════════════════

  const ICON = {
    close:   'M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z',
    zoomIn:  'M15.5,14L20.5,19L19,20.5L14,15.5V14.71L13.73,14.43C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.43,13.73L14.71,14H15.5M9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14M12,10H10V12H9V10H7V9H9V7H10V9H12V10Z',
    zoomOut: 'M15.5,14H14.71L14.43,13.73C15.41,12.59 16,11.11 16,9.5A6.5,6.5 0 0,0 9.5,3A6.5,6.5 0 0,0 3,9.5A6.5,6.5 0 0,0 9.5,16C11.11,16 12.59,15.41 13.73,14.43L14,14.71V15.5L19,20.5L20.5,19L15.5,14M9.5,14C7,14 5,12 5,9.5C5,7 7,5 9.5,5C12,5 14,7 14,9.5C14,12 12,14 9.5,14M7,9H12V10H7V9Z',
    video:   'M17,10.5V7A1,1 0 0,0 16,6H4A1,1 0 0,0 3,7V17A1,1 0 0,0 4,18H16A1,1 0 0,0 17,17V13.5L21,17.5V6.5L17,10.5Z',
  }

  const tracked = new WeakSet()

  const isVideoCard = card => {
    const p = card.querySelector('.posts-image-type path')
    return !!p && p.getAttribute('d') === ICON.video
  }

  function mountCover(card) {
    if (card.dataset.ibhCover) return
    const img = card.querySelector('img')
    if (!img || !img.src) return

    const urls = fileCandidates(img.src, ['mp4', 'webm'])
    if (!urls.length) { dbg('video card outside the derivable pattern'); return }

    card.dataset.ibhCover = '1'
    const v = document.createElement('video')
    v.dataset.ibh = '1'
    v.muted = true
    v.playsInline = true
    v.preload = 'metadata'   // headers only, not the whole file
    v.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
      'border-radius:4px;pointer-events:none;opacity:0;transition:opacity .2s'

    // Walk the candidate hosts until one answers, instead of giving up on the
    // first 404 — that was what made covers vanish without a trace.
    let i = 0
    const tryNext = () => {
      if (i >= urls.length) {
        v.remove()
        delete card.dataset.ibhCover
        STATE.covers.failed++
        dbg(`no host answered for ${img.src}`)
        touch()
        return
      }
      v.src = `${urls[i++]}#t=1`   // media fragment: jump straight to the frame
    }

    // Only reveal once a frame is painted, otherwise a black rectangle flashes.
    v.addEventListener('loadeddata', () => {
      v.style.opacity = '1'
      STATE.covers.ok++
      touch()
    }, { once: true })
    v.addEventListener('error', tryNext)
    tryNext()

    if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
    card.appendChild(v)
  }

  function unmountCover(card) {
    const v = card.querySelector('video[data-ibh]')
    if (!v) return
    v.src = ''   // hand the decoder back; Android has few of them
    v.remove()
    delete card.dataset.ibhCover
  }

  // Opening decoders only for what is on screen keeps the phone alive.
  const viewport = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        for (const e of entries) {
          e.isIntersecting ? mountCover(e.target) : unmountCover(e.target)
        }
      }, { rootMargin: '200px' })
    : null

  function trackCard(card) {
    if (tracked.has(card)) return
    tracked.add(card)
    if (!STATE.masonry) { STATE.masonry = true; touch() }
    if (!CFG.videoCovers || !isVideoCard(card)) return
    STATE.covers.tracked++
    touch()
    viewport ? viewport.observe(card) : mountCover(card)
  }

  function scanCards(root) {
    if (!root || !root.querySelectorAll) return
    root.querySelectorAll('.posts-image-card').forEach(trackCard)
  }

  // ═══════════════════════════════════════════════════════════
  // C. Fancybox repair
  // ═══════════════════════════════════════════════════════════

  /** The extension ladder from the native onImageLoadError, which Fancybox lacks. */
  function nextExtension(url) {
    if (!url) return null
    if (/\.jpeg(\?|$)/i.test(url)) return url.replace(/\.jpeg(\?|$)/i, '.jpg$1')
    if (/\.jpg(\?|$)/i.test(url))  return url.replace(/\.jpg(\?|$)/i, '.png$1')
    if (/\.png(\?|$)/i.test(url))  return url.replace(/\.png(\?|$)/i, '.gif$1')
    return null
  }

  function repairItems(items) {
    if (!Array.isArray(items)) return 0
    let fixed = 0
    for (const it of items) {
      if (!it || it.src || !it.thumb) continue
      const [guess] = fileCandidates(it.thumb, ['jpeg', 'jpg', 'png'])
      if (!guess) continue
      it.src = guess
      if (!it.downloadSrc) it.downloadSrc = guess
      fixed++
    }
    return fixed
  }

  function installExtensionFallback(root) {
    root.addEventListener('error', ev => {
      const img = ev.target
      if (!img || img.tagName !== 'IMG') return
      const tries = Number(img.dataset.ibhTries || 0)
      if (tries >= 3) return
      const next = nextExtension(img.src)
      if (!next) return
      img.dataset.ibhTries = String(tries + 1)
      dbg(`fancybox: trying ${next}`)
      img.src = next
    }, true)   // capture: <img> error events do not bubble
  }

  function wrapFancybox(FB) {
    if (!FB || FB.__ibhWrapped || typeof FB.show !== 'function') return FB
    const origShow = FB.show.bind(FB)

    FB.show = function (items, opts) {
      try {
        const n = repairItems(items)
        if (n) info(`fancybox: filled ${n} empty src`)
      } catch (e) {
        error(`fancybox: failed to repair items — ${describeError(e)}`)
      }
      const instance = origShow(items, opts)
      requestAnimationFrame(() => {
        const box = document.querySelector('.fancybox__container')
        if (box && !box.dataset.ibhFallback) {
          box.dataset.ibhFallback = '1'
          installExtensionFallback(box)
        }
      })
      return instance
    }

    FB.__ibhWrapped = true
    STATE.fancybox = 'active'
    touch()
    info('fancybox intercepted')
    return FB
  }

  function hookFancybox() {
    if (!CFG.fixFancybox) { STATE.fancybox = 'disabled'; return }
    let held = window.Fancybox
    if (held) { wrapFancybox(held); return }
    try {
      // The library is loaded on demand; wait for the assignment on window.
      Object.defineProperty(window, 'Fancybox', {
        configurable: true,
        get: () => held,
        set(v) { held = wrapFancybox(v) },
      })
      dbg('waiting for window.Fancybox')
    } catch (e) {
      STATE.fancybox = 'failed'
      error(`could not intercept Fancybox — ${describeError(e)}`)
    }
  }

  // ═══════════════════════════════════════════════════════════
  // D. Gestures
  // ═══════════════════════════════════════════════════════════

  const GESTURE = {
    swipeMin: 60,      // minimum travel, in px, to count as a swipe
    swipeMaxMs: 600,
    tapSlop: 10,
    doubleTapMs: 300,
    pinchIn: 1.25,
    pinchOut: 0.80,
  }

  const pressKey = key =>
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))

  function clickToolbarIcon(name) {
    const path = document.querySelector(`.img-detail-toolbar path[d="${ICON[name]}"]`)
    const btn = path && path.closest('button')
    if (!btn) { dbg(`toolbar button ${name} not found`); return false }
    btn.click()   // works even with display:none — the Vue handler still fires
    return true
  }

  const detailOpen = () => !!document.querySelector('.img_detail_cont')
  const zoomOn     = () => !!document.querySelector('.img_scale_scroll')
  const videoOpen  = () => !!document.querySelector('.img_detail_cont .dplayer')

  const pointers = new Map()
  let pinchStart = 0
  let pinchDone = false
  let lastTap = 0
  let swallowClickUntil = 0

  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

  /** Store the i18n key, so the panel label follows the chosen language. */
  function noteGesture(key) {
    STATE.lastGesture = key
    STATE.gestureCount++
    dbg(`gesture: ${key}`)
    touch()
  }

  /** Touches inside the panel are not gallery gestures. */
  function insidePanel(ev) {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : []
    return panelHost ? path.includes(panelHost) : false
  }

  function onPointerDown(ev) {
    if (ev.pointerType === 'mouse') return   // on desktop the keyboard already works
    if (insidePanel(ev)) return
    pointers.set(ev.pointerId, {
      ox: ev.clientX, oy: ev.clientY, ot: Date.now(),   // origin, never mutated
      x: ev.clientX, y: ev.clientY,                      // current position
    })
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinchStart = distance(a, b)
      pinchDone = false
    }
  }

  function onPointerMove(ev) {
    const p = pointers.get(ev.pointerId)
    if (!p) return
    p.x = ev.clientX
    p.y = ev.clientY

    if (pointers.size !== 2 || pinchDone || !pinchStart || !detailOpen()) return
    const [a, b] = [...pointers.values()]
    const ratio = distance(a, b) / pinchStart

    if (ratio >= GESTURE.pinchIn && !zoomOn()) {
      pinchDone = true
      noteGesture('gZoomIn')
      clickToolbarIcon('zoomIn')
    } else if (ratio <= GESTURE.pinchOut && zoomOn()) {
      pinchDone = true
      noteGesture('gZoomOut')
      clickToolbarIcon('zoomOut')
    }
  }

  function onPointerUp(ev) {
    const p = pointers.get(ev.pointerId)
    const hadPinch = pinchDone
    pointers.delete(ev.pointerId)
    if (pointers.size < 2) pinchStart = 0
    if (pointers.size === 0) pinchDone = false

    if (!p || hadPinch || !detailOpen() || videoOpen()) return

    const dx = ev.clientX - p.ox
    const dy = ev.clientY - p.oy
    const adx = Math.abs(dx)
    const ady = Math.abs(dy)
    const dt = Date.now() - p.ot

    if (adx < GESTURE.tapSlop && ady < GESTURE.tapSlop && dt < 250) {
      const now = Date.now()
      if (now - lastTap < GESTURE.doubleTapMs) {
        lastTap = 0
        swallowClickUntil = now + 400
        noteGesture('gFav')
        pressKey('f')
      } else {
        lastTap = now   // single tap: let the app handle it
      }
      return
    }

    if (dt > GESTURE.swipeMaxMs) return
    if (zoomOn()) return   // with the magnifier on, dragging means panning

    if (adx > ady && adx >= GESTURE.swipeMin) {
      swallowClickUntil = Date.now() + 400
      noteGesture(dx < 0 ? 'gNext' : 'gPrev')
      pressKey(dx < 0 ? 'd' : 'a')
    } else if (dy >= GESTURE.swipeMin && ady > adx) {
      swallowClickUntil = Date.now() + 400
      noteGesture('gClose')
      clickToolbarIcon('close')
    }
  }

  function onPointerCancel(ev) {
    pointers.delete(ev.pointerId)
    if (pointers.size < 2) pinchStart = 0
    if (pointers.size === 0) pinchDone = false
  }

  // After a swipe the browser still emits a click, which the app would read as
  // a tap on the image. Drop that ghost click.
  function onClickCapture(ev) {
    if (Date.now() < swallowClickUntil) {
      ev.stopPropagation()
      ev.preventDefault()
    }
  }

  function installGestures() {
    if (!CFG.gestures) { dbg('gestures disabled'); return }
    // Listeners on window survive Masonry's replaceDocument().
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerCancel, true)
    window.addEventListener('click', onClickCapture, true)
    info('gestures active')
  }

  // ═══════════════════════════════════════════════════════════
  // Optional: unlock the API path on rule34
  //
  //   isRule34Firefox() = hostname == "rule34.xxx"
  //                       && (UA contains "Firefox" || !credentialQuery)
  //
  // Because of the ||, Firefox falls into the HTML scraper even with an API
  // credential, and that adapter comes before the API one in fetchPostsActions.
  // Removing "Firefox" from the userAgent makes the first half false, so the
  // list reaches booruAction, which uses the API and returns a ready file_url.
  //
  // OFF BY DEFAULT, on purpose: the scraper sends the session cookie
  // (credentials: "include") and honours the account blacklist, filter_ai and
  // post_threshold. The API goes to api.rule34.xxx, a different host, with no
  // cookie — you gain a correct URL and lose your account filters.
  // ═══════════════════════════════════════════════════════════

  function applyRule34ApiUnlock() {
    if (!CFG.forceRule34Api || SITE !== 'rule34.xxx') return
    if (!masonrySettings().credentialQuery) {
      warn('API path requested without a credential; keeping the scraper')
      return
    }
    try {
      // Replace only the word "Firefox": the app's isMobile check and the
      // download headers read the rest of the string and stay correct.
      const ua = navigator.userAgent.replace(/Firefox/g, 'Fx')
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        get: () => ua,
      })
      info('rule34 API path unlocked (no session cookie)')
    } catch (e) {
      error(`could not unlock the rule34 API path — ${describeError(e)}`)
    }
  }

  // ═══════════════════════════════════════════════════════════
  // On-demand diagnostics
  // ═══════════════════════════════════════════════════════════

  /** Test every candidate URL of the first video card and log the outcome. */
  function probeVideoUrls() {
    const card = [...document.querySelectorAll('.posts-image-card')].find(isVideoCard)
    if (!card) { warn('no video card on screen to test'); return }
    const img = card.querySelector('img')
    if (!img) { warn('video card has no <img>'); return }

    const urls = fileCandidates(img.src, ['mp4', 'webm'])
    info(`thumbnail: ${img.src}`)
    if (!urls.length) { warn('no URL derivable from that thumbnail'); return }

    urls.forEach(url => {
      const v = document.createElement('video')
      v.preload = 'metadata'
      v.muted = true
      const done = ok => {
        v.src = ''
        log(ok ? 'info' : 'warn', `${ok ? 'OK  ' : 'FAIL'} ${url}`)
      }
      v.addEventListener('loadedmetadata', () => done(true), { once: true })
      v.addEventListener('error', () => done(false), { once: true })
      v.src = url
    })
  }

  function logSnapshot() {
    info(`v${VERSION} on ${SITE} · ui=${LANG}`)
    dbg(`userAgent: ${navigator.userAgent}`)
    readMasonryState()
    dbg(`columns: ${STATE.columns} · thumbnails: ${STATE.thumbMode}`)
    dbg(`API credential: ${STATE.credential ? 'filled' : 'empty'}`)
  }

  // ═══════════════════════════════════════════════════════════
  // Status panel
  // ═══════════════════════════════════════════════════════════

  let panelHost = null
  let shadow = null
  let logBox = null
  let statusBox = null
  let panelOpen = false

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }

    .fab {
      position: fixed; left: 12px; bottom: 12px; z-index: 2147483000;
      width: 40px; height: 40px; border-radius: 50%;
      border: 1px solid #2a3a3f; background: #0f1417; color: #5eead4;
      font-size: 17px; line-height: 1; display: grid; place-items: center;
      box-shadow: 0 4px 14px rgba(0,0,0,.5);
    }
    .fab[data-alert="1"] { color: #fca5a5; border-color: #7f1d1d; }

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
    .ok   { background: #4ade80; }
    .warn { background: #fbbf24; }
    .bad  { background: #f87171; }
    .idle { background: #475569; }

    .sec {
      padding: 8px 12px 4px; color: #4e6469; font-size: 11px;
      border-top: 1px solid #1c272b; margin-top: 4px;
    }

    label.tog { display: flex; align-items: center; gap: 10px; padding: 7px 12px; }
    label.tog input { accent-color: #5eead4; width: 16px; height: 16px; }
    label.tog .note { margin-left: auto; color: #4e6469; font-size: 10px; }

    .lang { padding: 4px 12px 8px; }
    .lang select {
      width: 100%; padding: 7px 8px; font-size: 12px;
      background: #0a0e10; color: #d7dee0;
      border: 1px solid #234a45; border-radius: 6px;
    }

    .acts { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 12px; }
    .acts button {
      flex: 1 1 auto; padding: 7px 10px;
      background: #16211f; color: #5eead4;
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
    .log .debug { color: #6b8085; }
    .log .info  { color: #a8b8bb; }
    .log .warn  { color: #fbbf24; }
    .log .error { color: #f87171; }
  `

  function el(tag, attrs, children) {
    const node = document.createElement(tag)
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') node.textContent = v
      else if (k === 'class') node.className = v
      else node.setAttribute(k, v)
    }
    if (children) children.forEach(c => node.appendChild(c))
    return node
  }

  const statusRow = (key, value, tone) => el('div', { class: 'row' }, [
    el('span', { class: `dot ${tone}` }),
    el('span', { class: 'k', text: key }),
    el('span', { class: 'v', text: String(value) }),
  ])

  function renderStatus() {
    if (!statusBox) return
    readMasonryState()
    statusBox.textContent = ''

    const c = STATE.covers
    const coverTone = c.tracked === 0 ? 'idle' : c.failed > 0 ? 'warn' : c.ok > 0 ? 'ok' : 'idle'
    const hostLabel = STATE.imageBase
      ? STATE.imageBase + (STATE.baseCached ? ` (${t('cached')})` : '')
      : t('notResolved')

    const rows = [
      statusRow(t('site'), SITE, 'ok'),
      statusRow(t('gallery'), STATE.masonry ? t('active') : t('notDetected'),
        STATE.masonry ? 'ok' : 'idle'),
      statusRow(t('thumbnail'),
        STATE.thumbMode === 'large' ? t('largeImage') : t('smallThumb'),
        STATE.thumbMode === 'large' ? 'ok' : 'warn'),
      statusRow(t('columns'), STATE.columns == null ? '—' : STATE.columns, 'idle'),
      statusRow(t('host'), hostLabel, STATE.imageBase ? 'ok' : 'warn'),
      statusRow(t('covers'), t('coversFmt')(c.ok, c.failed, c.tracked), coverTone),
      statusRow(t('fancybox'), t(STATE.fancybox),
        STATE.fancybox === 'active' ? 'ok' : STATE.fancybox === 'failed' ? 'bad' : 'idle'),
      statusRow(t('credential'), STATE.credential ? t('filled') : t('empty'),
        STATE.credential ? 'ok' : 'idle'),
      statusRow(t('lastGesture'), STATE.lastGesture ? t(STATE.lastGesture) : '—',
        STATE.gestureCount ? 'ok' : 'idle'),
    ]
    rows.forEach(r => statusBox.appendChild(r))
  }

  function appendLogLine(entry) {
    if (!logBox) return
    const time = new Date(entry.t).toTimeString().slice(0, 8)
    logBox.appendChild(el('div', null, [
      el('span', { class: 'ts', text: time }),
      el('span', { class: entry.level, text: entry.msg }),
    ]))
    while (logBox.childElementCount > LOG_MAX) logBox.firstElementChild.remove()
    logBox.scrollTop = logBox.scrollHeight
    if (entry.level === 'error' && shadow) {
      const fab = shadow.querySelector('.fab')
      if (fab) fab.dataset.alert = '1'
    }
  }

  function toggle(key, label, note) {
    const input = el('input', { type: 'checkbox' })
    input.checked = !!CFG[key]
    input.addEventListener('change', () => {
      setCfg(key, input.checked)
      renderStatus()
    })
    const row = el('label', { class: 'tog' }, [input, el('span', { text: label })])
    if (note) row.appendChild(el('span', { class: 'note', text: note }))
    return row
  }

  function languageSelect() {
    const sel = el('select')
    for (const [value, label] of [['', t('auto')], ['pt-BR', 'Português'], ['en', 'English']]) {
      const option = el('option', { value, text: label })
      if ((CFG.lang || '') === value) option.setAttribute('selected', '')
      sel.appendChild(option)
    }
    sel.addEventListener('change', () => {
      setCfg('lang', sel.value || null)
      LANG = resolveLang()
      rebuildPanel()   // labels are baked at build time, so rebuild
    })
    return el('div', { class: 'lang' }, [sel])
  }

  const actionButton = (label, fn) => {
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
    body.appendChild(toggle('sharpThumbs', t('tSharp'), t('noteReload')))
    body.appendChild(toggle('videoCovers', t('tCovers')))
    body.appendChild(toggle('fixFancybox', t('tFancybox')))
    body.appendChild(toggle('gestures', t('tGestures')))
    body.appendChild(toggle('forceRule34Api', t('tApi'), t('noteReload')))
    body.appendChild(toggle('debug', t('tDebug')))

    body.appendChild(el('div', { class: 'sec', text: t('language') }))
    body.appendChild(languageSelect())

    body.appendChild(el('div', { class: 'sec', text: t('log') }))
    logBox = el('div', { class: 'log' })
    LOG.forEach(appendLogLine)
    body.appendChild(logBox)

    body.appendChild(el('div', { class: 'acts' }, [
      actionButton(t('bTest'), probeVideoUrls),
      actionButton(t('bClearHost'), () => { clearHostCache(); renderStatus() }),
      actionButton(t('bCopy'), copyLog),
      actionButton(t('bReload'), () => location.reload()),
    ]))

    panel.appendChild(body)
    return panel
  }

  function copyLog() {
    const head = `Image Board Helper v${VERSION} · ${SITE}\n` +
      `UA: ${navigator.userAgent}\n` +
      `host: ${STATE.imageBase} · thumbnails: ${STATE.thumbMode} · ` +
      `columns: ${STATE.columns}\n\n`
    const body = LOG.map(e =>
      `${new Date(e.t).toTimeString().slice(0, 8)} [${e.level}] ${e.msg}`).join('\n')

    navigator.clipboard.writeText(head + body)
      .then(() => info('log copied'))
      .catch(e => error(`could not copy the log — ${describeError(e)}`))
  }

  function togglePanel(open) {
    panelOpen = open == null ? !panelOpen : open
    const panel = shadow && shadow.querySelector('.panel')
    if (!panel) return
    panel.hidden = !panelOpen
    if (panelOpen) {
      renderStatus()
      const fab = shadow.querySelector('.fab')
      if (fab) delete fab.dataset.alert
    }
  }

  function mountPanel() {
    if (!CFG.panel) return
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

    const fab = el('button', { class: 'fab', text: '◐', title: 'Image Board Helper' })
    fab.addEventListener('click', () => togglePanel())
    shadow.appendChild(fab)
    shadow.appendChild(buildPanel())

    document.body.appendChild(panelHost)
    onLogEntry = appendLogLine
    onStateChange = () => { if (panelOpen) renderStatus() }
    if (panelOpen) renderStatus()
    dbg('panel mounted')
  }

  /** Labels are baked when the panel is built, so switching language rebuilds it. */
  function rebuildPanel() {
    if (panelHost) panelHost.remove()
    panelHost = null
    shadow = null
    mountPanel()
  }

  // ═══════════════════════════════════════════════════════════
  // Boot
  // ═══════════════════════════════════════════════════════════

  // Without this the browser claims the horizontal drag as history navigation
  // and the swipe never reaches our listeners.
  function injectPageCSS() {
    if (document.querySelector('style[data-ibh]')) return
    const style = el('style', { 'data-ibh': '1' })
    style.textContent = '.img_detail_cont { touch-action: pan-y; }'
    ;(document.head || document.documentElement).appendChild(style)
  }

  // Masonry swaps documentElement and body wholesale; document itself never
  // changes. The same observer finds new cards and remounts the panel.
  new MutationObserver(records => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue
        if (node.classList && node.classList.contains('posts-image-card')) trackCard(node)
        else scanCards(node)
      }
    }
    if (panelHost && !panelHost.isConnected) { panelHost = null; shadow = null }
    if (!panelHost) mountPanel()
    injectPageCSS()
  }).observe(document, { childList: true, subtree: true })

  applySharpThumbs()
  applyRule34ApiUnlock()
  hookFancybox()
  installGestures()
  logSnapshot()

  const boot = () => {
    injectPageCSS()
    mountPanel()
    scanCards(document)
    imageBase()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }

  // Console access, useful when the panel is turned off.
  window.__ibh = {
    version: VERSION,
    cfg: CFG,
    state: STATE,
    log: () => LOG,
    probe: probeVideoUrls,
    clearHostCache,
    set: setCfg,
  }
})()
