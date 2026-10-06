// ==UserScript==
// @name         Image Board Helper
// @namespace    joao.imageboardhelper
// @version      0.57.1
// @description  Touch gestures, sharp thumbnails, real video covers and a Fancybox repair for Booru Masonry, with a status panel and log
// @author       João
// @homepageURL  https://github.com/JoaoRoch4/ImageBoardHelper
// @supportURL   https://github.com/JoaoRoch4/ImageBoardHelper/issues
// @downloadURL  https://raw.githubusercontent.com/JoaoRoch4/ImageBoardHelper/main/image-board-helper.user.js
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
// @inject-into  page
// @noframes
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
 *      unlike grabbing the frame through a <canvas>. GIF cards get the same
 *      treatment: the original .gif replaces the still while on screen.
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
 *   E. ORIGINAL THUMBNAILS (optional, off by default)
 *      Swaps visible thumbnails, on Masonry cards and on the site's own pages,
 *      for the original file, probing jpg/png/jpeg off-screen first. Sharper
 *      than the sample, at several times the data and memory.
 *
 *   G. MEMORY MANAGEMENT
 *      Images that scroll two screens away go back to the thumbnail and are
 *      upgraded again on return; videos removed by Masonry are unloaded; the
 *      page releases everything when it is left.
 *
 *   H. POST MODAL
 *      On the site's own pages, tapping a thumbnail opens the post in an
 *      overlay (video with sound, GIF, original image); swipe sideways for the
 *      next post, down or the back button to close.
 *
 * WHY @grant none: intercepting window.Fancybox and overriding
 * navigator.userAgent both require the page's own realm. Any @grant puts the
 * script in a sandbox where `window` is not the page's window, and both stop
 * working silently. That is why the options live in the panel instead of
 * GM_registerMenuCommand. @inject-into page makes the same choice explicit:
 * the default "auto" silently falls back to the sandbox when a site's CSP
 * blocks page scripts, which would break both features without a trace.
 *
 * REQUIRES: "Listen for keyboard events" enabled in Masonry's settings,
 * otherwise the navigation swipes do nothing.
 */

;(function () {
  'use strict'

  const VERSION = '0.57.1'
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
    gifInline:      true,   // animate GIF cards while they are on screen
    gifMaxLive:     3,      // at most this many of them animating at once
    videoScrub:     true,   // scene preview on video thumbnails (needs reload)
    scrubMode:      'drag', // 'drag': finger position picks the scene; 'hold': hold for a slideshow
    slideStep:      10,     // hold slideshow: jump between scenes, in % of the video
    slideDwell:     0.2,    // hold slideshow: seconds each scene stays once painted
    memorySaver:    true,   // release far off-screen images and removed videos (needs reload)
    urlCache:       true,   // remember which candidate URL worked for each file
    feedNav:        true,   // ⤒ ‹ › buttons: top of page, previous and next post in the feed (needs reload)
    bulkFavButton:  true,   // ♥ button next to 🕒 on site pages: a mode where each tapped post is favorited and upvoted
    freeButton:     true,   // trash-can button next to them: Free memory & cache in one tap
    laterButton:    true,   // 🕒 button next to them on site pages: the Watch later list
    favSearch:      true,   // search bar on your own rule34 favorites page, results in the page's own list
    favAutopager:   true,   // search listings and favorites load the next page as you near the bottom
    siteSearch:     true,   // search bar on the site's listing pages: tags, kind, order, minimum score
    videoModal:     true,   // open posts from site pages in an overlay: video, GIF, image (needs reload)
    rotateLandscape: true,  // in the modal player's fullscreen, lock wide videos to landscape
    modalPreload:   true,   // in the modal, have the next post loaded before the swipe
    modalOriginal:  'zoom', // images in the modal: 'zoom' shows the sample and fetches the original on zoom; 'always'
    siteTheme:      true,   // the modal's dark theme on the site's own pages (not Masonry)
    fixFancybox:    true,   // fill empty src in the alternate viewer
    gestures:       true,   // swipe, double tap and pinch
    originalThumbs: false,  // swap visible thumbnails for the original file (heavy, needs reload)
    nativeFeed:     false,  // feed with sharp images on the site's own pages (applies at once)
    feedColumns:    1,      // its columns: 'auto' (by screen width) or 1-4
    feedLayout:     'masonry', // 'masonry': whole images in columns; 'grid': even square tiles
    forceRule34Api: true,   // rule34 on Masonry: API path, account filters applied here; automatic, no panel entry (needs reload)
  }

  // Options that only take effect when the app boots.
  const NEEDS_RELOAD = new Set(['sharpThumbs', 'forceRule34Api', 'originalThumbs', 'memorySaver', 'feedNav', 'videoModal', 'videoScrub'])

  // Whether this page found the settings at all: a script that clears the
  // site's localStorage (one did, on its reset) takes them along, and the
  // copy kept by the storage bridge brings them back (restoreCfg).
  const CFG_FOUND = (() => { try { return localStorage.getItem(CFG_KEY) !== null } catch (e) { return true } })()
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
    // The copies (see restoreCfg); not yet reachable this early in the boot.
    try { backupCfg() } catch (e) { /* the boot copy in restoreCfg covers it */ }
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
      tSharp: 'Large thumbnails', tCovers: 'Video covers', tGif: 'Animated GIFs in the grid', tGifMax: 'GIFs animating at once',
      tScrub: 'Scene preview on video thumbnails',
      tScrubMode: 'scene preview gesture', modeDrag: 'Drag sideways', modeHold: 'Hold (slideshow)',
      tSlideStep: 'slideshow jump', tSlideDwell: 'time per scene', scenes: 'scenes',
      tMemory: 'Release off-screen memory',
      tUrlCache: 'Remember working file URLs',
      tNav: 'Top / previous / next buttons',
      navPrev: 'Previous post', navNext: 'Next post', navTop: 'Top of the page', navBottom: 'Bottom of the page',
      navPrevPage: 'Previous page', navNextPage: 'Next page',
      tBulkBtn: 'Mass-favorite button', navBulk: 'Mass favorite: each tapped post gets ♥ and ▲',
      bulkOn: 'Mass favorite on: tap posts to favorite and upvote them', bulkOff: 'Mass favorite off',
      tFreeBtn: 'Free-memory shortcut button', navFree: 'Free memory & cache',
      tFavSearch: 'Search your favorites', tSiteSearch: 'Search bar on site pages',
      savedPick: 'Favorite searches…', recentPick: 'Recent searches…', saveSearch: '☆ Favorite', savedSearch: '★ Favorite', savedAll: '(everything)',
      minScore: 'min. score', sitePlaceholder: 'search: tag -tag tag* ( a ~ b )', tPager: 'Autopager (searches and favorites)',
      pagerLoading: 'Loading the next page…', pagerEnd: 'End of the list', pagerFail: 'Could not load the next page — tap to retry',
      favPlaceholder: 'search favorites: tag -tag tag* a ~ b score:>10', favGo: 'Search', favClear: 'Clear',
      favKindAll: 'All types', favKindImage: 'Images', favKindVideo: 'Videos', favKindGif: 'GIFs', favKindAnimated: 'Animated (video or GIF)',
      favSortNew: 'Newest', favSortOld: 'Oldest', favSortScore: 'Score', favSortRandom: 'Random',
      favIndexed: 'favorites indexed', favNever: 'not indexed yet: the first search reads every page',
      favScanning: 'reading favorites, page', favResults: 'results', favMore: 'Show more',
      favUpdate: 'Update', favRebuild: 'Rebuild index', favScanFail: 'could not read the favorites page',
      tLaterBtn: 'Watch later button', navLater: 'Watch later', laterTitle: 'Watch later',
      dlBtn: '⬇ Download', dlWait: 'The file is still loading', dlStart: 'Downloading…', dlBusy: 'Already downloading this post', dlDone: 'Downloaded: confirm in Firefox to save',
      dlFail: 'Download failed', dlOpened: 'Opened in a new tab: hold it to save',
      laterAdd: '🕒 Watch later', laterIn: '✓ In Watch later', laterAdded: 'Saved for later', laterRemoved: 'Removed from the list',
      laterEmpty: 'Nothing saved yet. Use 🕒 in a post’s ☰ menu.', laterOnDevice: 'kept by Violentmonkey, on this device',
      laterOnSite: 'Kept in this site’s data (IndexedDB). Tap to install the storage bridge and keep it in Violentmonkey',
      tModal: 'Open posts in a player over the page',
      tTheme: 'Dark theme on site pages',
      mClose: 'Close', mOpen: 'Open the post', mPrev: 'Previous post', mNext: 'Next post',
      mLoading: 'Loading…', mFail: 'Could not load it',
      mFav: 'Add to favorites', mUp: 'Upvote', mFull: 'Fullscreen', mFullExit: 'Exit fullscreen', mMenu: 'Tags and post page',
      tabTags: 'Tags', tabInfo: 'Info', infoKind: 'Kind', infoRes: 'Resolution', infoFormat: 'Format', infoDuration: 'Duration',
      infoDrops: 'Dropped frames', infoDropsOf: 'of', infoAbove: 'above 1080p: mid-range phones decode it in software', infoLoading: 'loading…',
      kindVideo: 'Video', kindGif: 'GIF', kindImage: 'Image',
      tagsCopyAll: 'Copy all', tagOpened: 'Opened in a new tab', tagCopied: 'Copied', tagCopyFail: 'Could not copy', tagsNone: 'No tags', mTurn: 'Rotate the screen',
      mPlay: 'Play / pause', mMute: 'Sound on / off',
      tRotate: 'Landscape in player fullscreen',
      tPreload: 'Next post loaded in the player',
      tModalOrig: 'original image in the player', origZoom: 'When zooming in (sample first, faster)', origAlways: 'Always (slower)',
      origLoading: 'Loading the original…', infoSample: 'sample',
      favAdded: 'Added to favorites', favAlready: 'Already in your favorites', favRemoved: 'Removed from favorites',
      favLogin: 'You are not logged in', favFail: 'Could not favorite', mTurnNo: 'This browser cannot turn the screen',
      voted: 'Upvoted', voteFail: 'Could not vote',
      tFancybox: 'Repair Fancybox', tGestures: 'Touch gestures',
      tOriginal: 'Original thumbnails (heavy)',
      tFeed: 'Feed on site pages',
      tFeedCols: 'feed columns', tFeedLayout: 'feed layout', colsAuto: 'Automatic (by screen width)',
      layoutMasonry: 'Masonry (whole images)', layoutGrid: 'Grid (even tiles)',
      tDebug: 'Log to console',
      noteReload: 'reload',
      bTest: 'Test URLs', bClearHost: 'Clear host',
      bCopy: 'Copy log', bReload: 'Reload', bFree: 'Free memory & cache', bRedo: 'Redo thumbnails',
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
      tSharp: 'Miniatura grande', tCovers: 'Capa de vídeo', tGif: 'GIF animado na grade', tGifMax: 'GIFs animando ao mesmo tempo',
      tScrub: 'Prévia de cenas nas miniaturas de vídeo',
      tScrubMode: 'gesto da prévia de cenas', modeDrag: 'Arrastar de lado', modeHold: 'Segurar (slideshow)',
      tSlideStep: 'pulo do slideshow', tSlideDwell: 'tempo por cena', scenes: 'cenas',
      tMemory: 'Liberar memória fora da tela',
      tUrlCache: 'Lembrar endereços que funcionaram',
      tNav: 'Botões topo / anterior / próximo',
      navPrev: 'Post anterior', navNext: 'Próximo post', navTop: 'Topo da página', navBottom: 'Fim da página',
      navPrevPage: 'Página anterior', navNextPage: 'Próxima página',
      tBulkBtn: 'Botão de favoritar em massa', navBulk: 'Favoritar em massa: cada post tocado ganha ♥ e ▲',
      bulkOn: 'Favoritar em massa ligado: toque nos posts para favoritar e votar', bulkOff: 'Favoritar em massa desligado',
      tFreeBtn: 'Botão de atalho para limpar a memória', navFree: 'Limpar memória e cache',
      tFavSearch: 'Buscar nos seus favoritos', tSiteSearch: 'Barra de busca nas páginas do site',
      savedPick: 'Buscas favoritas…', recentPick: 'Buscas recentes…', saveSearch: '☆ Favoritar', savedSearch: '★ Favorita', savedAll: '(tudo)',
      minScore: 'score mín.', sitePlaceholder: 'buscar: tag -tag tag* ( a ~ b )', tPager: 'Autopager (buscas e favoritos)',
      pagerLoading: 'Carregando a próxima página…', pagerEnd: 'Fim da lista', pagerFail: 'Não deu para carregar a próxima página — toque para tentar de novo',
      favPlaceholder: 'buscar nos favoritos: tag -tag tag* a ~ b score:>10', favGo: 'Buscar', favClear: 'Limpar',
      favKindAll: 'Todos os tipos', favKindImage: 'Imagens', favKindVideo: 'Vídeos', favKindGif: 'GIFs', favKindAnimated: 'Animados (vídeo ou GIF)',
      favSortNew: 'Mais novos', favSortOld: 'Mais antigos', favSortScore: 'Score', favSortRandom: 'Aleatório',
      favIndexed: 'favoritos no índice', favNever: 'ainda sem índice: a primeira busca lê todas as páginas',
      favScanning: 'lendo favoritos, página', favResults: 'resultados', favMore: 'Mostrar mais',
      favUpdate: 'Atualizar', favRebuild: 'Refazer índice', favScanFail: 'não foi possível ler a página de favoritos',
      tLaterBtn: 'Botão Ver depois', navLater: 'Ver depois', laterTitle: 'Ver depois',
      dlBtn: '⬇ Baixar', dlWait: 'O arquivo ainda está carregando', dlStart: 'Baixando…', dlBusy: 'Este post já está baixando', dlDone: 'Baixado: confirme no Firefox para salvar',
      dlFail: 'Falha no download', dlOpened: 'Aberto em outra aba: segure para salvar',
      laterAdd: '🕒 Ver depois', laterIn: '✓ Na lista', laterAdded: 'Salvo para ver depois', laterRemoved: 'Tirado da lista',
      laterEmpty: 'Nada salvo ainda. Use o 🕒 no menu ☰ de um post.', laterOnDevice: 'guardado pelo Violentmonkey, neste aparelho',
      laterOnSite: 'Guardado nos dados deste site (IndexedDB). Toque para instalar a ponte de armazenamento e guardar no Violentmonkey',
      tModal: 'Abrir posts num player sobre a página',
      tTheme: 'Tema escuro nas páginas do site',
      mClose: 'Fechar', mOpen: 'Abrir o post', mPrev: 'Post anterior', mNext: 'Próximo post',
      mLoading: 'Carregando…', mFail: 'Não foi possível carregar',
      mFav: 'Favoritar', mUp: 'Votar positivo', mFull: 'Tela cheia', mFullExit: 'Sair da tela cheia', mMenu: 'Tags e página do post',
      tabTags: 'Tags', tabInfo: 'Info', infoKind: 'Tipo', infoRes: 'Resolução', infoFormat: 'Formato', infoDuration: 'Duração',
      infoDrops: 'Quadros perdidos', infoDropsOf: 'de', infoAbove: 'acima de 1080p: celulares intermediários decodificam em software', infoLoading: 'carregando…',
      kindVideo: 'Vídeo', kindGif: 'GIF', kindImage: 'Imagem',
      tagsCopyAll: 'Copiar todas', tagOpened: 'Aberto em outra aba', tagCopied: 'Copiado', tagCopyFail: 'Não foi possível copiar', tagsNone: 'Sem tags', mTurn: 'Girar a tela',
      mPlay: 'Tocar / pausar', mMute: 'Som liga / desliga',
      tRotate: 'Paisagem na tela cheia do player',
      tPreload: 'Próximo post carregado no player',
      tModalOrig: 'imagem original no player', origZoom: 'Ao dar zoom (sample antes, mais rápido)', origAlways: 'Sempre (mais lento)',
      origLoading: 'Carregando o original…', infoSample: 'sample',
      favAdded: 'Adicionado aos favoritos', favAlready: 'Já está nos favoritos', favRemoved: 'Removido dos favoritos',
      favLogin: 'Você não está logado', favFail: 'Não foi possível favoritar', mTurnNo: 'Este navegador não gira a tela',
      voted: 'Voto registrado', voteFail: 'Não foi possível votar',
      tFancybox: 'Consertar Fancybox', tGestures: 'Gestos de toque',
      tOriginal: 'Miniatura original (pesado)',
      tFeed: 'Feed nas páginas do site',
      tFeedCols: 'colunas do feed', tFeedLayout: 'layout do feed', colsAuto: 'Automático (pela largura da tela)',
      layoutMasonry: 'Masonry (imagens inteiras)', layoutGrid: 'Grade (quadros iguais)',
      tDebug: 'Log no console',
      noteReload: 'recarregar',
      bTest: 'Testar URLs', bClearHost: 'Limpar host',
      bCopy: 'Copiar log', bReload: 'Recarregar', bFree: 'Limpar memória e cache', bRedo: 'Refazer miniaturas',
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

  // notify=false when the panel itself is reading: touch() re-renders the
  // panel, which would read again and loop until the stack overflows.
  function readMasonryState(notify = true) {
    const s = masonrySettings()
    STATE.credential = !!s.credentialQuery
    STATE.columns = s.selectedColumn == null ? '0' : s.selectedColumn
    STATE.thumbMode = s.isThumbSampleUrl ? 'large' : 'small'
    if (notify) touch()
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
      // Video mirrors, fastest first. wimg answers 403 for video files. Order
      // measured from the phone's network (time to first byte / 1 MB):
      // api-cdn 0.4 s / 0.3 s, nymp4 0.9 / 1.7, api-cdn-us-mp4 1.0 / 1.8,
      // ahri2mp4 1.3 / 2.2, ws-cdn-video 1.5 / 2.7, api-cdn-mp4 1.9 / 2.9.
      videoHosts: [
        'https://api-cdn.rule34.xxx/images',
        'https://nymp4.rule34.xxx/images',
        'https://api-cdn-us-mp4.rule34.xxx/images',
        'https://ahri2mp4.rule34.xxx/images',
        'https://ws-cdn-video.rule34.xxx/images',
        'https://api-cdn-mp4.rule34.xxx/images',
      ],
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
    clearUrlCache(false)   // the host is part of every cached URL
    STATE.imageBase = null
    info('host cache cleared')
    imageBase()
  }

  /** Pull DIR and HASH out of .../thumbnails/DIR/thumbnail_HASH.jpg or .../samples/DIR/sample_HASH.jpg */
  function thumbParts(thumbUrl) {
    if (!thumbUrl) return null
    const m = thumbUrl.replace(/\?.*$/, '')
      .match(/\/(?:thumbnails|samples)\/(.+)\/(?:thumbnail|sample)_([^/]+)\.(?:jpe?g|png)$/i)
    // rule34 serves paths like //thumbnails//2389/; keep DIR free of extra slashes.
    return m ? { dir: m[1].replace(/^\/+|\/+$/g, ''), hash: m[2] } : null
  }

  /** URLs to try, most likely first. */
  function fileCandidates(thumbUrl, exts) {
    const p = thumbParts(thumbUrl)
    if (!p) return []

    const bases = []
    const wantsVideo = exts.some(e => e === 'mp4' || e === 'webm')
    if (wantsVideo) bases.push(...(HOST_CFG.videoHosts || []))
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
  // URL cache
  //
  // Firefox's HTTP cache already keeps the bytes. What the script kept losing
  // was which candidate URL won: every re-upgrade (memory saver, modal unload)
  // walked the whole ladder again — jpg/png/jpeg, a dozen video hosts for a GIF
  // labelled as video, an .mp4 sniff on every modal open. This remembers the
  // winning URL per kind and file hash, and "nothing loads" for a day.
  // ═══════════════════════════════════════════════════════════

  const URLCACHE_KEY = `IBH_URLCACHE_${SITE}`
  const URLCACHE_MAX = 1500
  const URLCACHE_TTL = 30 * 24 * 60 * 60 * 1000   // a winning URL
  const URLCACHE_NEG_TTL = 24 * 60 * 60 * 1000    // "nothing loads": short, a CDN hiccup must not stick
  const urlStats = { hits: 0, misses: 0, healed: 0 }
  let urlCache = null
  let urlCacheTimer = 0

  const expired = entry => Date.now() - entry.t >= (entry.u === null ? URLCACHE_NEG_TTL : URLCACHE_TTL)

  // Auto-delete: expired entries go on load and on every write, not only when
  // read again, so files never seen again do not linger.
  function dropExpired() {
    let n = 0
    for (const k of Object.keys(urlCache)) if (expired(urlCache[k])) { delete urlCache[k]; n++ }
    return n
  }

  function loadUrlCache() {
    if (!urlCache) {
      urlCache = readJSON(URLCACHE_KEY, {}) || {}
      if (dropExpired()) scheduleUrlFlush()
    }
    return urlCache
  }

  // A miss counts only when it repeats at least a minute later: a Wi-Fi
  // handoff fails every ladder in flight at once, and a single run of misses
  // must not hide a real file for a day.
  const MISS_CONFIRM_MS = 60 * 1000

  /** A URL string, null for a confirmed miss, or undefined when nothing usable is cached. */
  function cacheGet(kind, hash) {
    if (!CFG.urlCache || !hash) return undefined
    const key = `${kind}:${hash}`
    const entry = loadUrlCache()[key]
    if (entry && !expired(entry)) {
      if (entry.u === null && (entry.n || 1) < 2) { urlStats.misses++; return undefined }   // unconfirmed miss
      urlStats.hits++
      return entry.u
    }
    if (entry) { delete urlCache[key]; scheduleUrlFlush() }
    urlStats.misses++
    return undefined
  }

  /** Record the outcome of a ladder. Only definitive ones: a winner, or "none loads". */
  function cacheSet(kind, hash, url, previous) {
    if (!CFG.urlCache || !hash) return
    const key = `${kind}:${hash}`
    const old = loadUrlCache()[key]
    const now = Date.now()
    if (url === null) {
      if (navigator.onLine === false) return   // offline: says nothing about the file
      if (old && old.u === null) {
        // Second miss: confirmed once it comes a minute or more after the first.
        if (!old.n || old.n < 2) {
          if (now - (old.f || old.t) < MISS_CONFIRM_MS) return
          urlCache[key] = { u: null, t: now, f: old.f || old.t, n: 2 }
          scheduleUrlFlush()
        }
        return
      }
      urlCache[key] = { u: null, t: now, f: now, n: 1 }
      scheduleUrlFlush()
      return
    }
    if (previous && url !== previous) urlStats.healed++   // the cached one had stopped working
    // Same winner seen again recently: nothing new to save. Covers remount
    // often, and re-serialising the cache each time would cost while scrolling.
    if (old && old.u === url && now - old.t < URLCACHE_NEG_TTL) return
    urlCache[key] = { u: url, t: now }
    scheduleUrlFlush()
  }

  // The cached winner goes first; if it fails, the full ladder runs behind it.
  const cachedFirst = (urls, cached) => typeof cached === 'string' ? [cached, ...urls.filter(u => u !== cached)] : urls

  // Writes are batched: serialising the cache on every swap would stutter the scroll.
  function scheduleUrlFlush() {
    if (!urlCacheTimer) urlCacheTimer = setTimeout(flushUrlCache, 3000)
  }

  const newestFirst = keys => keys.sort((a, b) => urlCache[b].t - urlCache[a].t)

  let lastLoggedHits = -1
  function flushUrlCache() {
    clearTimeout(urlCacheTimer)
    urlCacheTimer = 0
    if (!urlCache) return
    dropExpired()
    const keys = Object.keys(urlCache)
    if (keys.length > URLCACHE_MAX) for (const k of newestFirst(keys).slice(URLCACHE_MAX)) delete urlCache[k]
    if (!writeJSON(URLCACHE_KEY, urlCache)) {
      // Storage full: keep the newer half and try once more.
      const all = newestFirst(Object.keys(urlCache))
      for (const k of all.slice(Math.floor(all.length / 2))) delete urlCache[k]
      if (!writeJSON(URLCACHE_KEY, urlCache)) warn('url cache: could not save it')
    }
    if (urlStats.hits !== lastLoggedHits) {
      lastLoggedHits = urlStats.hits
      dbg(`url cache: ${urlStats.hits} hits, ${urlStats.misses} misses, ${urlStats.healed} healed, ${Object.keys(urlCache).length} entries`)
    }
  }

  function clearUrlCache(missesOnly) {
    const c = loadUrlCache()
    let n = 0
    for (const k of Object.keys(c)) if (!missesOnly || c[k].u === null) { delete c[k]; n++ }
    flushUrlCache()
    return n
  }

  window.addEventListener('pagehide', flushUrlCache)

  // ═══════════════════════════════════════════════════════════
  // B. Real video covers
  // ═══════════════════════════════════════════════════════════

  const ICON = {
    close:   'M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z',
    zoomIn:  'M15.5,14L20.5,19L19,20.5L14,15.5V14.71L13.73,14.43C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.43,13.73L14.71,14H15.5M9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14M12,10H10V12H9V10H7V9H9V7H10V9H12V10Z',
    zoomOut: 'M15.5,14H14.71L14.43,13.73C15.41,12.59 16,11.11 16,9.5A6.5,6.5 0 0,0 9.5,3A6.5,6.5 0 0,0 3,9.5A6.5,6.5 0 0,0 9.5,16C11.11,16 12.59,15.41 13.73,14.43L14,14.71V15.5L19,20.5L20.5,19L15.5,14M9.5,14C7,14 5,12 5,9.5C5,7 7,5 9.5,5C12,5 14,7 14,9.5C14,12 12,14 9.5,14M7,9H12V10H7V9Z',
    video:   'M17,10.5V7A1,1 0 0,0 16,6H4A1,1 0 0,0 3,7V17A1,1 0 0,0 4,18H16A1,1 0 0,0 17,17V13.5L21,17.5V6.5L17,10.5Z',
    gif:     'M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3M10 10.5H7.5V13.5H8.5V12H10V13.7C10 14.4 9.5 15 8.7 15H7.3C6.5 15 6 14.3 6 13.7V10.4C6 9.7 6.5 9 7.3 9H8.6C9.5 9 10 9.7 10 10.3V10.5M13 15H11.5V9H13V15M17.5 10.5H16V11.5H17.5V13H16V15H14.5V9H17.5V10.5Z',
  }

  const tracked = new WeakSet()

  // A card can carry several type icons (parent/children ones come first on
  // yande.re and konachan), so look at all of them, not just the first.
  const hasTypeIcon = (card, d) =>
    [...card.querySelectorAll('.posts-image-type path')].some(p => p.getAttribute('d') === d)
  // Site pages (Gelbooru 0.2 markup) have no icons; the tags sit in the
  // thumbnail's title or alt. "animated" alone may be either kind: it counts as
  // video, and the cover falls back to the GIF when no video host answers.
  const isMasonryCard = card => card.classList.contains('posts-image-card')
  const nativeTags = card => {
    const img = card.querySelector('img')
    return ` ${(img && (img.title || img.alt)) || ''} `
  }
  const NATIVE_GIF = /\s(gif|animated_gif)\s/i
  const NATIVE_VIDEO = /\s(video|mp4|webm|animated)\s/i
  const NATIVE_REAL_VIDEO = /\s(video|mp4|webm)\s/i   // "animated" alone may be a GIF
  const isVideoCard = card => isMasonryCard(card)
    ? hasTypeIcon(card, ICON.video)
    : !!card.querySelector('img.webm-thumb') ||   // the site's own video mark
      (NATIVE_VIDEO.test(nativeTags(card)) && !NATIVE_GIF.test(nativeTags(card)))
  const isGifCard = card => card.dataset.ibhKind === 'gif' || (isMasonryCard(card)
    ? hasTypeIcon(card, ICON.gif)
    : NATIVE_GIF.test(nativeTags(card)))

  // Masonry's default layout draws cards with Vuetify's <v-img>: a div with a
  // background-image and no <img> at all. Only the "virtual" and "justified"
  // layouts use <img>. Read and replace the picture through either one.
  function cardPicture(card) {
    const img = card.querySelector('img')
    if (img) return imgPicture(img)
    const bg = card.querySelector('.v-image__image')
    const m = bg && bg.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/)
    return m ? { src: m[1], set: url => { bg.style.backgroundImage = `url("${url}")` } } : null
  }

  // On an <img>, the better file goes in srcset and src is left alone: the
  // browser paints the srcset candidate, while src keeps the site's thumbnail
  // URL for everything that reads it — Imagus and other hover-zoom tools match
  // on the thumbnail_ pattern, and Masonry's Vue only ever rewrites src.
  // Setting the thumbnail back (or nothing) clears srcset.
  function imgPicture(img) {
    if (!img.src) return null
    return {
      src: img.src,
      set: url => {
        if (!url || url === img.src) img.removeAttribute('srcset')
        else img.srcset = url.replace(/ /g, '%20').replace(/,/g, '%2C')   // srcset splits on both
      },
    }
  }

  // <v-img> only paints its background once the thumbnail has loaded, so a
  // card can be on screen with no picture yet. Look again a few times.
  function whenPictured(card, fn, tries = 0) {
    if (cardPicture(card)) return fn(card)
    if (tries >= 8 || !card.dataset.ibhSeen) return
    setTimeout(() => whenPictured(card, fn, tries + 1), 500)
  }

  // Firefox for Android decodes about four videos at once on a mid-range phone;
  // past that, new <video> elements sit at "metadata" forever or fail with a
  // decode error. Keep covers under the limit, with one decoder spare for the
  // viewer, and hand freed slots to cards still waiting on screen.
  const COVER_MAX_LIVE = 3
  const COVER_POINT = 0.35   // where in the video the cover frame is taken
  let liveCovers = 0
  const coverQueue = new Set()

  // Masonry rebuilds card elements as the list grows, so a "this is a GIF"
  // mark on the element gets lost. Remember it by file hash instead.
  const knownGifs = new Set()

  function releaseCover() {
    liveCovers = Math.max(0, liveCovers - 1)
    for (const card of coverQueue) {
      if (liveCovers >= COVER_MAX_LIVE) break
      coverQueue.delete(card)
      if (card.isConnected && card.dataset.ibhSeen) mountCover(card)
    }
  }

  function mountCover(card) {
    if (card.dataset.ibhCover || card.dataset.ibhBigVideo) return
    const pic = cardPicture(card)
    if (!pic) { whenPictured(card, mountCover); return }
    // Masonry's rule34 scraper labels posts as video by tag, so some GIFs carry
    // the video icon. Once a file proved to be one, go straight to the GIF path.
    const parts = thumbParts(pic.src)
    const vcached = parts ? cacheGet('video', parts.hash) : undefined
    // Known not to be a video (no host has it): straight to the GIF path.
    if (parts && (knownGifs.has(parts.hash) || vcached === null)) card.dataset.ibhKind = 'gif'
    if (card.dataset.ibhKind === 'gif') { if (CFG.gifInline) playGif(card); return }
    if (liveCovers >= COVER_MAX_LIVE) { coverQueue.add(card); return }

    const urls = cachedFirst(fileCandidates(pic.src, ['mp4', 'webm']), vcached)
    if (!urls.length) { dbg('video card outside the derivable pattern'); return }

    card.dataset.ibhCover = '1'
    liveCovers++
    const v = document.createElement('video')
    v.dataset.ibh = '1'
    v.muted = true
    v.playsInline = true
    v.preload = 'metadata'   // headers only, not the whole file
    v.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
      'border-radius:4px;pointer-events:none;opacity:0;transition:opacity .2s'

    const giveUp = () => {
      v.remove()
      delete card.dataset.ibhCover
      releaseCover()
    }

    // Walk the candidate hosts until one answers, instead of giving up on the
    // first 404 — that was what made covers vanish without a trace.
    let i = 0
    let networkError = false
    const tryNext = () => {
      if (card.dataset.ibhBigVideo) return   // dropped on purpose (past the decoder), not a failure
      // A decode error means the file was there but no decoder was free; other
      // hosts would fail the same way. The next time the card scrolls in retries.
      if (v.error && v.error.code === 3) {
        giveUp()
        dbg(`cover: no decoder free for ${pic.src}`)
        return
      }
      if (v.error && v.error.code === 2) networkError = true   // MEDIA_ERR_NETWORK: says nothing about the file
      if (i >= urls.length) {
        giveUp()
        // A dropped connection fails every host: not proof it is a GIF.
        if (networkError || navigator.onLine === false) { dbg(`cover: network error for ${pic.src}, will retry`); return }
        card.dataset.ibhKind = 'gif'
        if (parts) { knownGifs.add(parts.hash); cacheSet('video', parts.hash, null) }
        // A video mark we added ourselves does not belong on a GIF.
        const marked = card.querySelector('img[data-ibh-mark]')
        if (marked) { marked.classList.remove('webm-thumb'); delete marked.dataset.ibhMark }
        dbg(`no video host answered for ${pic.src}; trying it as a GIF`)
        if (CFG.gifInline) playGif(card)
        else { STATE.covers.failed++; touch() }
        return
      }
      v.src = urls[i++]
    }

    // The cover is the frame at 35% of the video: past intros and title cards,
    // and the duration is known as soon as the metadata arrives. Reveal only
    // once that frame is painted, otherwise a black rectangle (or frame 0) flashes.
    let seekingCover = false
    const reveal = () => {
      if (v.style.opacity === '1') return
      v.style.opacity = '1'
      STATE.covers.ok++
      touch()
    }
    v.addEventListener('loadedmetadata', () => {
      if (parts) cacheSet('video', parts.hash, urls[i - 1], vcached)
      // Past a mid-range hardware decoder (this phone's stops at 1920×1088):
      // decoding a frame falls to the CPU, for a still the poster already
      // gives. Drop the cover and leave the picture (the feed upgrades it to
      // the full-size poster frame).
      if (Math.max(v.videoWidth, v.videoHeight) > 1920 || Math.min(v.videoWidth, v.videoHeight) > 1088) {
        card.dataset.ibhBigVideo = `${v.videoWidth}x${v.videoHeight}`
        dbg(`cover: ${v.videoWidth}x${v.videoHeight} is past the hardware decoder, poster kept instead`)
        v.removeAttribute('src')
        v.load()
        giveUp()
        return
      }
      if (Number.isFinite(v.duration) && v.duration > 0) {
        seekingCover = true
        v.currentTime = v.duration * COVER_POINT
      }
    }, { once: true })
    v.addEventListener('seeked', reveal, { once: true })
    v.addEventListener('loadeddata', () => { if (!seekingCover) reveal() }, { once: true })   // unknown duration
    v.addEventListener('error', tryNext)
    tryNext()

    // Site pages mark videos with a border on the thumbnail (rule34: 3px blue
    // .webm-thumb); give the cover the same border so the mark stays visible.
    if (!isMasonryCard(card)) {
      const thumb = card.querySelector('img')
      if (thumb) {
        v.style.border = getComputedStyle(thumb).border
        v.style.boxSizing = 'border-box'
        v.style.borderRadius = '0'
      }
    }

    if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
    // Sit right above the picture. Masonry's type icon and action buttons are
    // absolutely positioned with no z-index and come later in the card, so they
    // keep painting on top; appending at the end used to hide the video icon.
    const picEl = card.querySelector(':scope > .v-image, :scope > img')
    if (picEl) picEl.after(v)
    else card.appendChild(v)
  }

  function unmountCover(card) {
    coverQueue.delete(card)
    const v = card.querySelector('video[data-ibh]')
    if (!v) return
    v.removeAttribute('src')
    v.load()   // hand the decoder back; Android has few of them
    v.remove()
    delete card.dataset.ibhCover
    releaseCover()
  }

  // At most three image downloads at a time, GIFs and upgrades together: fewer
  // files half-loaded and decoding at once, and each one finishes sooner on a
  // slow connection. A GIF waiting for a slot goes before queued upgrades.
  const IMAGE_MAX_INFLIGHT = 3
  let imagesInflight = 0
  const imageWaiters = []

  function takeImageSlot(start) {
    if (imagesInflight < IMAGE_MAX_INFLIGHT) { imagesInflight++; start() }
    else imageWaiters.push(start)
  }

  function giveImageSlot() {
    imagesInflight = Math.max(0, imagesInflight - 1)
    const next = imageWaiters.shift()
    if (next) { imagesInflight++; next() }
    else pumpOriginals()
  }

  // GIF cards show a still (sample or thumbnail .jpg). While on screen, swap in
  // the original .gif, probed off-screen first; put the still back on the way
  // out, because animated GIFs hold every decoded frame in memory.
  // Every animated GIF keeps all its frames decoded: past a few at once the
  // phone runs out of memory and Firefox drops them (the broken-GIF rebuild,
  // see watchGif). Cards past the limit wait as stills, nearest the middle of
  // the screen first, and take the place of one that scrolls away.
  const gifQueue = new Set()
  const gifsLive = () => document.querySelectorAll('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').length

  function nextGif() {
    // Stopped to free memory (the modal, a scene preview, a hidden tab): those
    // bring their GIFs back themselves when they end.
    if (document.hidden || (modal && modal.open) || scrub) return
    const max = Number(CFG.gifMaxLive) || 3
    const middle = window.innerHeight / 2
    const waiting = [...gifQueue].filter(card => {
      if (card.isConnected && card.dataset.ibhSeen && !card.dataset.ibhGif) return true
      gifQueue.delete(card)
      return false
    })
    waiting.sort((a, b) => {
      const da = Math.abs(a.getBoundingClientRect().top + a.offsetHeight / 2 - middle)
      const db = Math.abs(b.getBoundingClientRect().top + b.offsetHeight / 2 - middle)
      return da - db
    })
    for (const card of waiting) {
      if (gifsLive() >= max) break
      gifQueue.delete(card)
      playGif(card)
    }
  }

  // The panel changed the limit: stop the GIFs farthest from the middle past
  // it, or start waiting ones in the room it made.
  function applyGifLimit() {
    const max = Number(CFG.gifMaxLive) || 3
    const middle = window.innerHeight / 2
    const live = [...document.querySelectorAll('[data-ibh-gif="playing"], [data-ibh-gif="loading"]')]
      .sort((a, b) => Math.abs(b.getBoundingClientRect().top - middle) - Math.abs(a.getBoundingClientRect().top - middle))
    while (live.length > max) {
      const card = live.shift()
      stopGif(card)
      gifQueue.add(card)
    }
    nextGif()
  }

  function playGif(card) {
    if (card.dataset.ibhGif) return   // loading, playing or failed
    if (gifsLive() >= (Number(CFG.gifMaxLive) || 3)) { gifQueue.add(card); return }   // waits its turn
    const pic = cardPicture(card)
    if (!pic) { whenPictured(card, playGif); return }
    const hash = (thumbParts(pic.src) || {}).hash
    const gcached = cacheGet('gif', hash)
    const urls = cachedFirst(fileCandidates(pic.src, ['gif']), gcached)
    if (!urls.length) { dbg('gif card outside the derivable pattern'); return }
    if (gcached === null) { card.dataset.ibhGif = 'failed'; return }   // known: no .gif for it

    card.dataset.ibhGif = 'loading'
    const probe = new Image()
    let i = 0
    let held = true
    const release = () => { if (held) { held = false; giveImageSlot() } }
    const tryNext = () => {
      if (card.dataset.ibhGif !== 'loading') { release(); return }   // scrolled away meanwhile
      if (i >= urls.length) {
        release()
        card.dataset.ibhGif = 'failed'
        cacheSet('gif', hash, null)
        if (card.dataset.ibhKind === 'gif') { STATE.covers.failed++; touch() }
        dbg(`gif: no host answered for ${pic.src}`)
        nextGif()   // its place goes to a waiting one
        return
      }
      probe.src = urls[i++]
    }
    probe.onload = () => {
      release()
      cacheSet('gif', hash, probe.src, gcached)
      if (card.dataset.ibhGif !== 'loading') return
      card.dataset.ibhStill = pic.src
      cardPicture(card).set(probe.src)
      card.dataset.ibhGif = 'playing'
      watchGif(card)
      if (card.dataset.ibhKind === 'gif') { STATE.covers.ok++; touch() }
      dbg(`gif: playing ${probe.src}`)
    }
    probe.onerror = tryNext
    takeImageSlot(tryNext)
  }

  // An animated GIF keeps every decoded frame, and under memory pressure
  // Firefox drops it and shows a broken image. Watch the <img> after the swap;
  // when it breaks, free more memory and build the GIF again, twice at most.
  // A CSS background (Masonry's default <v-img> layout) gives no such signal.
  const GIF_RETRIES = 2

  function watchGif(card) {
    const img = card.querySelector('img')
    if (!img || img.dataset.ibhGifWatch) return
    img.dataset.ibhGifWatch = '1'
    const check = ev => {
      if (card.dataset.ibhGif !== 'playing' || !img.srcset) return   // stopped or back to the still
      // "load" with no width is how a broken decode shows up.
      if (ev.type === 'error' || img.naturalWidth === 0) gifBroken(card)
    }
    img.addEventListener('error', check)
    img.addEventListener('load', check)
  }

  function gifBroken(card) {
    const tries = Number(card.dataset.ibhGifRetries || 0)
    if (tries >= GIF_RETRIES) {
      stopGif(card)
      card.dataset.ibhGif = 'failed'
      warn('gif: still broken after rebuilding, left as a still')
      return
    }
    card.dataset.ibhGifRetries = String(tries + 1)
    const freed = freeOffscreen(card)
    info(`gif: broken, freed ${freed.images} images, ${freed.gifs} GIFs, ${freed.covers} covers; rebuilding (try ${tries + 1})`)
    stopGif(card)
    // A beat for the freed memory to be reclaimed before decoding again.
    setTimeout(() => { if (card.isConnected && card.dataset.ibhSeen) playGif(card) }, 400)
  }

  // Release what is not on screen: upgraded images back to the thumbnail
  // (heights held), other GIFs stilled, covers closed. On screen means within
  // one screen of the viewport.
  function freeOffscreen(keep) {
    const n = { images: 0, gifs: 0, covers: 0 }
    const far = el => {
      const r = el.getBoundingClientRect()
      return r.bottom < -window.innerHeight || r.top > window.innerHeight * 2
    }
    document.querySelectorAll('[data-ibh-orig="done"]').forEach(el => {
      if (!far(el)) return
      pinHeight(el)
      resetUpgrade(el)
      if (farViewport) farViewport.unobserve(el)
      if (originalViewport) originalViewport.observe(el)   // upgraded again when it comes back
      n.images++
    })
    document.querySelectorAll('[data-ibh-gif="playing"]').forEach(card => {
      if (card !== keep && far(card)) { stopGif(card); n.gifs++ }
    })
    document.querySelectorAll('[data-ibh-cover]').forEach(card => {
      if (far(card)) { unmountCover(card); n.covers++ }
    })
    return n
  }

  function stopGif(card) {
    gifQueue.delete(card)
    const state = card.dataset.ibhGif
    if (state === 'playing' && card.dataset.ibhStill) {
      const pic = cardPicture(card)
      if (pic) pic.set(card.dataset.ibhStill)
    }
    if (state === 'playing' || state === 'loading') {
      delete card.dataset.ibhGif
      setTimeout(nextGif, 0)   // after the caller's own stops, e.g. a page-wide release
    }
  }

  // Opening decoders only for what is on screen keeps the phone alive.
  const viewport = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        for (const e of entries) {
          const card = e.target
          if (e.isIntersecting) card.dataset.ibhSeen = '1'
          else delete card.dataset.ibhSeen
          // The page scrolls under the modal as it steps (H): keep it unloaded;
          // resumePage() brings back what is seen on close.
          if (modal && modal.open) continue
          if (isVideoCard(card) && card.dataset.ibhKind !== 'gif') {
            e.isIntersecting ? mountCover(card) : unmountCover(card)
          } else {
            e.isIntersecting ? playGif(card) : stopGif(card)
          }
        }
      }, { rootMargin: '200px' })
    : null

  function trackCard(card) {
    if (tracked.has(card)) return
    tracked.add(card)
    if (!STATE.masonry && isMasonryCard(card)) { STATE.masonry = true; touch() }
    if (CFG.videoScrub && isVideoCard(card)) {
      card.dataset.ibhVideo = '1'   // scrub target, see F
      // On site pages the thumbnail is an <img> in a link, and a sideways drag
      // starts the browser's drag-and-drop, which cancels the touch mid-scrub.
      card.setAttribute('draggable', 'false')
      const img = card.querySelector('img')
      if (img) img.draggable = false
    }
    const video = CFG.videoCovers && isVideoCard(card)
    const gif = CFG.gifInline && isGifCard(card)
    if (!video && !gif) return
    if (video) { STATE.covers.tracked++; touch() }
    if (viewport) viewport.observe(card)
    else { card.dataset.ibhSeen = '1'; video ? mountCover(card) : playGif(card) }
  }

  // On site pages the link around each thumbnail plays the part of the card.
  const NATIVE_THUMB = '.image-list span.thumb img'

  function scanCards(root) {
    if (!root || !root.querySelectorAll) return
    root.querySelectorAll('.posts-image-card').forEach(trackCard)
    const imgs = [...root.querySelectorAll(NATIVE_THUMB)]
    if (root.matches && root.matches(NATIVE_THUMB)) imgs.push(root)
    for (const img of imgs) {
      const link = img.closest('a') || img.parentElement
      // The search list marks videos with .webm-thumb (a blue frame), but
      // favorites leave it out. Put the site's own mark back on real videos.
      const tags = nativeTags(link)
      if (!img.classList.contains('webm-thumb') && NATIVE_REAL_VIDEO.test(tags) && !NATIVE_GIF.test(tags)) {
        img.classList.add('webm-thumb')
        img.dataset.ibhMark = '1'
      }
      // Inline links have no box of their own; the cover needs one to sit on.
      if (getComputedStyle(link).display === 'inline') link.style.display = 'inline-block'
      trackCard(link)
    }
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
  // E. Original thumbnails (optional, off by default)
  //
  // Swaps visible thumbnails — on Masonry cards and on the site's own pages —
  // for the original file. The thumbnail is always .jpg, so the real extension
  // is unknown: each one is tried in an off-screen Image and the visible <img>
  // only changes once one loads, so nothing flickers. Originals cost several
  // times the data and memory of the sample, which is why this ships off.
  // ═══════════════════════════════════════════════════════════

  const ORIGINAL_EXTS = ['jpg', 'png', 'jpeg']   // no gif: animated originals are heavy

  // In the one-column feed a 150 px thumbnail is stretched to the screen width.
  // The sample (about 850 px) is already sharp there and far lighter than the
  // original; posts too small to have a sample fall through to the original.
  const inFeed = el => CFG.nativeFeed && !!el.closest('.image-list')

  function sampleCandidates(src) {
    const p = thumbParts(src)
    if (!p) return []
    const bases = [imageBase()]
    try { bases.push(`${new URL(src).origin}/images`) } catch (e) { /* ignore */ }
    return [...new Set(bases.filter(Boolean))]
      .map(b => `${b.replace(/\/images$/, '/samples')}/${p.dir}/sample_${p.hash}.jpg`)
  }

  // What an upgrade fetches, and under which cache kind. Candidates come in
  // stages for raceImage: samples before originals, so a big original never
  // loads beside a sample that exists.
  //
  // On the site's pages the sample (850 px wide on Gelbooru 0.2) is taken
  // whenever it covers the image's width on screen in device pixels: as
  // sharp as the screen can show, comics legible, at a fraction of the size
  // (measured: a comic page 705 KB against a 51 MB PNG original, another 2 MB
  // against 31 MB). originalThumbs then only fetches the original where the
  // box is wider than the sample (a desktop screen).
  const SAMPLE_WIDTH = 850

  function displayPixels(el) {
    const box = el.closest('.image-list span.thumb') || el
    return (box.clientWidth || el.clientWidth || 0) * (window.devicePixelRatio || 1)
  }

  function upgradePlan(el, src) {
    if (thumbKind(el) === 'video') return { kind: 'poster', stages: [fileCandidates(src, ['jpg'])] }
    const originals = fileCandidates(src, ORIGINAL_EXTS)
    const sitePage = !isCard(el)
    const sampleDoes = sitePage && (!CFG.originalThumbs || displayPixels(el) <= SAMPLE_WIDTH * 1.1)
    if (sampleDoes && (inFeed(el) || CFG.originalThumbs)) return { kind: 'sample', stages: [sampleCandidates(src), originals] }
    return { kind: 'orig', stages: [originals] }
  }

  // Downloads already run on the browser's network threads; the slots shared
  // with GIFs (IMAGE_MAX_INFLIGHT, see B) cap how many the script starts at once.
  // Targets are Masonry cards (either layout) or <img> on the site's own pages.
  const ORIGINAL_SELECTOR = '.posts-image-card, img[src*="/thumbnails/"], img[src*="/samples/"]'
  const originalQueue = []
  let upgradeGen = 0   // bumped by freeMemory(): upgrades already in flight drop their result

  const isCard = el => el.classList.contains('posts-image-card')

  function pictureOf(el) {
    if (isCard(el)) return cardPicture(el)
    return imgPicture(el)
  }

  // Native pages put the tags in title/alt; Masonry marks videos with an icon.
  // The kind of post an element shows. A native <img> takes it from its link,
  // which is what the cover and GIF code treat as the card.
  function thumbKind(el) {
    const card = isCard(el) ? el : (el.closest('a') || el.parentElement)
    if (card && isGifCard(card)) return 'gif'
    if (card && isVideoCard(card)) return 'video'
    return 'image'
  }

  /** Returns true once the element needs no more watching. */
  function upgradeToOriginal(el) {
    if (el.dataset.ibhOrig) return true   // already queued, done or failed
    // Without originalThumbs, only feed images on site pages get upgraded.
    if (!CFG.originalThumbs && !inFeed(el)) return true
    // The detail viewer owns zoom and pan; leave its image alone.
    if (el.closest('.img_detail_cont, .fancybox__container')) return true
    if (thumbKind(el) === 'gif') return true   // inline GIFs have their own path
    // Masonry may not have painted the picture yet; try on the next intersection.
    const pic = pictureOf(el)
    if (!pic || !thumbParts(pic.src)) return false
    el.dataset.ibhOrig = 'queued'
    originalQueue.push(el)
    pumpOriginals()
    return true
  }


  // The queued image nearest the screen goes next. One scrolled two screens
  // away goes back to waiting (the observer queues it again when it comes
  // near), so a fast scroll does not spend the download slots on what it
  // passed by.
  function nextQueued() {
    const h = window.innerHeight
    const near = []
    for (const el of originalQueue) {
      if (!el.isConnected) continue
      const r = el.getBoundingClientRect()
      const d = r.bottom < 0 ? -r.bottom : r.top > h ? r.top - h : 0
      if (d > h * 2) {
        delete el.dataset.ibhOrig
        if (originalViewport) originalViewport.observe(el)
        continue
      }
      near.push([d, el])
    }
    originalQueue.length = 0
    if (!near.length) return null
    near.sort((a, b) => a[0] - b[0])
    originalQueue.push(...near.slice(1).map(pair => pair[1]))
    return near[0][1]
  }

  function pumpOriginals() {
    while (imagesInflight < IMAGE_MAX_INFLIGHT && originalQueue.length) {
      const el = nextQueued()
      if (!el) break
      const pic = pictureOf(el)
      if (!pic) continue
      const plan = upgradePlan(el, pic.src)
      const ck = { kind: plan.kind, hash: (thumbParts(pic.src) || {}).hash }
      ck.cached = cacheGet(ck.kind, ck.hash)
      if (ck.cached === null) { el.dataset.ibhOrig = 'failed'; continue }   // known: nothing loads
      imagesInflight++
      probeOriginal(el, pic.src, plan.stages, giveImageSlot, ck)
    }
  }

  // The candidates race (raceImage): a wrong extension costs nothing, where
  // trying them in turn held a download slot ~0.5 s per miss.
  function probeOriginal(el, from, stages, done, ck) {
    const gen = upgradeGen
    let probe = null
    raceImage(stages, ck ? ck.cached : undefined, winner => {
      probe = winner
      if (gen !== upgradeGen) { done(); return }   // memory freed meanwhile: start over later
      if (ck) cacheSet(ck.kind, ck.hash, probe.src, ck.cached)   // the URL works, whatever happens to the swap
      // Decode off the main thread before swapping, so the new image appears in
      // one go instead of stalling the scroll while a large file is decoded.
      const decoded = typeof probe.decode === 'function' ? probe.decode().catch(() => {}) : Promise.resolve()
      decoded.then(swap)
    }, () => {
      if (gen !== upgradeGen) { done(); return }
      el.dataset.ibhOrig = 'failed'
      if (ck) cacheSet(ck.kind, ck.hash, null)
      dbg(`original: nothing loaded for ${from}`)
      done()
    })
    const swap = () => {
      if (gen !== upgradeGen) { done(); return }   // memory freed meanwhile: the element was reset
      // The modal unloads the page while it is open: drop this upgrade and let
      // it run again when the modal closes.
      if (modal && modal.open) {
        delete el.dataset.ibhOrig
        suspended.push(el)
        done()
        return
      }
      // Off Masonry the thumbnail has no fixed box: pin its current size so the
      // full-resolution file does not blow up the page layout.
      if (!isCard(el) && !inFeed(el) && el.clientWidth) {
        el.style.width = `${el.clientWidth}px`
        el.style.height = `${el.clientHeight}px`
        el.style.objectFit = 'contain'
      }
      if (el.tagName === 'IMG') el.decoding = 'async'
      const pic = pictureOf(el)
      if (pic) pic.set(probe.src)   // already in cache and decoded, so this paints at once
      el.dataset.ibhThumb = from    // what freeMemory() and redoThumbs() put back
      el.dataset.ibhOrig = 'done'
      unpinHeight(el)
      watchDistance(el)   // released again once it is far off screen, see G
      dbg(`original: ${probe.src}`)
      done()
    }
  }

  const originalViewport = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          // Scrolled in under the modal: wait for it to close (resumePage observes again).
          if (modal && modal.open) { originalViewport.unobserve(e.target); suspended.push(e.target); continue }
          if (upgradeToOriginal(e.target)) originalViewport.unobserve(e.target)
        }
      }, { rootMargin: '300px' })
    : null

  const watchedThumbs = new WeakSet()

  function scanThumbs(root) {
    if (!(CFG.originalThumbs || CFG.nativeFeed) || !root || !root.querySelectorAll) return
    const found = [...root.querySelectorAll(ORIGINAL_SELECTOR)]
    if (root.matches && root.matches(ORIGINAL_SELECTOR)) found.push(root)
    for (const el of found) {
      // An <img> inside a card is handled through the card.
      if (!isCard(el) && el.closest('.posts-image-card')) continue
      if (watchedThumbs.has(el)) continue
      watchedThumbs.add(el)
      originalViewport ? originalViewport.observe(el) : upgradeToOriginal(el)
    }
  }

  // ═══════════════════════════════════════════════════════════
  // F. Scene preview
  //
  // Drag a finger sideways across a video thumbnail to see its scenes (left
  // edge = start, right edge = end), and drag the modal's seek bar to see the
  // frame under the finger. Both use the same tools: a card's own cover when
  // it is loaded, otherwise one small shared preview <video>, so previews
  // never cost more than one decoder.
  // ═══════════════════════════════════════════════════════════

  // Seeking under a finger. Measured on the phone: a seek into a part of the
  // file not downloaded yet took 4-5 s (about 500 KB/s, and Firefox fetches a
  // large chunk per seek). So:
  //  - a target already buffered is seeked at once;
  //  - otherwise wait until the finger rests (180 ms) and fetch only that spot,
  //    instead of queuing a download for every position the finger crossed;
  //  - one seek in flight at a time, keeping only the latest target.
  // Clips up to a minute seek exactly (short clips have sparse keyframes, so
  // fastSeek barely changed the frame); longer ones use fastSeek.
  const EXACT_SEEK_MAX_S = 60
  const REST_MS = 180
  const seekState = new WeakMap()

  const isBuffered = (v, t) => {
    for (let i = 0; i < v.buffered.length; i++) if (t >= v.buffered.start(i) && t <= v.buffered.end(i)) return true
    return false
  }

  // `now`: no finger moving (the slideshow), so the rest wait is only a delay.
  function seekFraction(v, f, now = false) {
    let st = seekState.get(v)
    if (!st) {
      st = { wanted: null, pending: null, rest: 0 }
      seekState.set(v, st)
      v.addEventListener('seeked', () => {
        if (st.wanted === null) return
        const t = st.wanted
        st.wanted = null
        seekTo(v, t)
      })
      // Asked before the duration was known: seek once it is.
      v.addEventListener('loadedmetadata', () => {
        if (st.pending === null) return
        const p = st.pending
        st.pending = null
        seekFraction(v, p, true)
      })
    }
    const d = v.duration
    if (!Number.isFinite(d) || d <= 0) { st.pending = f; return null }
    const t = f * d
    clearTimeout(st.rest)
    if (v.seeking) st.wanted = t
    else if (now || isBuffered(v, t)) seekTo(v, t)
    else st.rest = setTimeout(() => { if (v.seeking) st.wanted = t; else seekTo(v, t) }, REST_MS)
    return { t, d }
  }

  function seekTo(v, t) {
    if (v.duration > EXACT_SEEK_MAX_S && typeof v.fastSeek === 'function') v.fastSeek(t)
    else v.currentTime = t   // exact: decodes from the keyframe up to this frame
  }

  // The shared preview video.
  let previewEl = null

  function previewLoad(container, urls, hash) {
    if (!previewEl) {
      previewEl = document.createElement('video')
      previewEl.muted = true
      previewEl.playsInline = true
      previewEl.preload = 'auto'
      previewEl.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;background:#000'
    }
    const v = previewEl
    let i = 0
    v.onerror = () => { if (i < urls.length) v.src = urls[i++] }   // walk the hosts, like covers
    v.onloadedmetadata = () => { if (hash) cacheSet('video', hash, urls[i - 1]) }
    v.src = urls[i++]
    container.insertBefore(v, container.firstChild)
    return v
  }

  function previewStop() {
    if (!previewEl) return
    previewEl.onerror = previewEl.onloadedmetadata = null
    previewEl.removeAttribute('src')
    previewEl.load()   // hand the decoder back
    previewEl.remove()
  }

  // The preview needs a decoder of its own on the page. With every cover slot
  // taken, close the cover of another card and queue it to come back.
  // A count: the slideshow borrows a second decoder for its helper video.
  let decodersBorrowed = 0

  function borrowDecoder(card) {
    decodersBorrowed++
    liveCovers++
    if (liveCovers <= COVER_MAX_LIVE) return
    const victim = [...document.querySelectorAll('[data-ibh-cover]')].find(c => c !== card)
    if (!victim) return
    unmountCover(victim)   // its releaseCover sees the budget still full: nothing remounts
    if (victim.dataset.ibhSeen) coverQueue.add(victim)
  }

  function returnDecoder() {
    if (!decodersBorrowed) return
    decodersBorrowed--
    releaseCover()   // a queued cover takes the slot back
  }

  // Right above the picture: Masonry's icons and buttons come later in the
  // card with no z-index, so they keep painting on top.
  function placeOverPicture(card, node) {
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
    const picEl = card.querySelector(':scope > .v-image, :scope > img')
    if (picEl) picEl.after(node)
    else card.appendChild(node)
  }

  // ── Scrubbing a thumbnail ──
  const SCRUB_SLOP = 8   // px of travel before a drag counts as a scrub or a scroll
  let scrub = null
  let scrubClickUntil = 0

  function onScrubDown(ev) {
    if (scrub || detailOpen() || insidePanel(ev) || (modal && modal.open)) return
    if (ev.pointerType === 'mouse' && ev.button !== 0) return
    const card = ev.target.closest && ev.target.closest('[data-ibh-video]')
    if (!card || card.dataset.ibhKind === 'gif') return
    scrub = { card, id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, on: false }
    // Hold mode: a still finger for HOLD_MS starts the slideshow.
    if (CFG.scrubMode === 'hold') scrub.holdTimer = setTimeout(startSlideshow, HOLD_MS)
  }

  // ── Hold for a slideshow ──
  // The scenes step from 00:00 through the video and loop, each shown for a
  // moment once painted; lifting the finger stops it.
  // Two videos take turns, like double buffering: while one shows a scene, the
  // other, hidden, is already seeking and downloading the next. Each <video>
  // fetches and decodes on the browser's own threads, so the two load in
  // parallel, and a swap only flips the helper's opacity.
  const HOLD_MS = 200
  const SLIDE_WAIT_MS = 1000   // a scene still loading after this lets the other video go ahead
  const SLIDE_TICK_MS = 50

  // Scene positions for a jump of `slideStep` %, from the start of the video:
  // 10% gives 0%, 10% … 90%, and 25% gives 0%, 25%, 50%, 75%.
  function slideSteps() {
    const n = Math.max(2, Math.round(100 / (Number(CFG.slideStep) || 10)))
    return Array.from({ length: n }, (_, i) => i / n)
  }

  function startSlideshow() {
    if (!scrub || scrub.on) return
    if (!startScrub()) { scrub = null; return }
    const s = scrub
    const base = s.video
    // Read here, so a change in the panel applies to the next hold.
    s.steps = slideSteps()
    s.dwell = (Number(CFG.slideDwell) || 0.2) * 1000
    s.step = 0   // always from 00:00
    s.views = [slideView(s, base, false)]
    s.queue = []        // views seeking a scene, in the order they will show
    s.front = null      // the view on screen
    s.shownAt = 0
    s.label.textContent = '…'
    loadSlide(s, s.views[0])
    // The helper needs the host the first video settled on.
    const withSrc = () => { if (scrub === s) addSlideHelper(s) }
    if (base.readyState >= 1) withSrc()
    else base.addEventListener('loadedmetadata', withSrc, { once: true })
    s.tick = setInterval(() => tickSlide(s), SLIDE_TICK_MS)
  }

  function slideView(s, v, helper) {
    const view = { v, helper, f: 0, ready: false, slow: false, since: 0 }
    // Ready once its own seek landed. A stale seek ending makes seekFraction
    // start the wanted one right away, so look after the other listeners ran.
    view.onSeeked = () => setTimeout(() => {
      if (v.seeking) return
      view.ready = true
      view.slow = false
      tickSlide(s)   // swap now if the dwell is over, not on the next tick
    }, 0)
    v.addEventListener('seeked', view.onSeeked)
    return view
  }

  // Hand a view the next scene to fetch.
  function loadSlide(s, view) {
    view.f = s.steps[s.step++ % s.steps.length]
    view.ready = false
    view.since = Date.now()
    s.queue.push(view)
    seekFraction(view.v, view.f, true)
  }

  function addSlideHelper(s) {
    const src = s.video.currentSrc
    if (!src) return
    borrowDecoder(s.card)
    const h = document.createElement('video')
    h.muted = true
    h.playsInline = true
    // Only the ranges it seeks to: the first video already downloads the whole
    // file, and a second full download of the same file halves the speed of both.
    h.preload = 'metadata'
    h.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
      'border-radius:4px;pointer-events:none;opacity:0'
    h.onerror = () => { if (scrub === s) dropSlideHelper(s) }   // no decoder free: carry on with one
    h.src = src
    s.video.after(h)   // right above the first video, still under Masonry's icons
    const view = slideView(s, h, true)
    s.helper = view
    s.views.push(view)
    loadSlide(s, view)
  }

  function dropSlideHelper(s) {
    const view = s.helper
    if (!view) return
    s.helper = null
    view.v.removeEventListener('seeked', view.onSeeked)
    view.v.onerror = null
    view.v.removeAttribute('src')
    view.v.load()   // hand the decoder back
    view.v.remove()
    returnDecoder()
    s.views = s.views.filter(o => o !== view)
    s.queue = s.queue.filter(o => o !== view)
    if (s.front === view) s.front = null
    if (!s.queue.length) loadSlide(s, s.views[0])
  }

  function showSlide(s, view) {
    if (s.helper) s.helper.v.style.opacity = view === s.helper ? '1' : '0'
    const d = view.v.duration
    s.bar.style.width = `${view.f * 100}%`
    s.label.textContent = `${mmss(view.f * d)} / ${mmss(d)}`
  }

  function tickSlide(s) {
    if (scrub !== s) return
    const now = Date.now()
    if (now - s.shownAt >= s.dwell) {
      // The first view ready shows, even past a slower one still seeking.
      const i = s.queue.findIndex(o => o.ready)
      if (i >= 0) {
        const view = s.queue[i]
        const overtaken = s.queue.splice(0, i + 1).slice(0, i)
        const prev = s.front
        showSlide(s, view)
        s.front = view
        s.shownAt = now
        // Its scene was skipped: aim it further on. It stays busy until the
        // seek in flight lands, so the next scene does not wait for it.
        for (const o of overtaken) { loadSlide(s, o); o.slow = true }
        if (prev && prev !== view && !s.queue.includes(prev)) loadSlide(s, prev)   // just hidden: fetch the scene after next
      } else if (s.queue.length && (s.queue[0].slow || now - s.queue[0].since > SLIDE_WAIT_MS) &&
                 s.front && !s.queue.includes(s.front)) {
        // The scene in line is slow to load (that video stays busy until its
        // seek lands): the video on screen fetches the next one meanwhile.
        loadSlide(s, s.front)
      }
    }
    // A single video (no helper yet, or none free) fetches the next scene after the dwell.
    if (!s.queue.length && s.front && now - s.shownAt >= s.dwell) loadSlide(s, s.front)
  }

  function endSlideshow(s) {
    clearInterval(s.tick)
    for (const view of s.views || []) view.v.removeEventListener('seeked', view.onSeeked)
    const helper = s.helper
    if (!helper) return
    // A cover keeps the last scene shown, even one the helper was showing.
    if (s.front === helper && !s.shared) seekFraction(s.video, helper.f, true)
    s.queue = []
    s.helper = null
    helper.v.onerror = null
    helper.v.removeAttribute('src')
    helper.v.load()
    helper.v.remove()
    returnDecoder()
  }

  function startScrub() {
    const { card } = scrub
    const pic = cardPicture(card)
    if (!pic) return false
    freeForPreview(card)
    const cover = card.querySelector('video[data-ibh]')
    if (cover && cover.readyState >= 1) {
      scrub.video = cover   // already loaded: instant, and no extra decoder
      // Download the whole file from now on: these are a few MB, and every
      // part already downloaded answers a seek at once.
      cover.preload = 'auto'
    } else {
      const hash = (thumbParts(pic.src) || {}).hash
      const urls = cachedFirst(fileCandidates(pic.src, ['mp4', 'webm']), cacheGet('video', hash))
      if (!urls.length) return false
      borrowDecoder(card)
      const holder = document.createElement('div')
      holder.style.cssText = 'position:absolute;inset:0;pointer-events:none'
      placeOverPicture(card, holder)
      scrub.holder = holder
      scrub.video = previewLoad(holder, urls, hash)
      scrub.shared = true
    }
    // z-index: the card's cover video comes later in the DOM and would paint
    // over them otherwise (it did on site pages, where every video has one).
    scrub.bar = document.createElement('div')
    scrub.bar.style.cssText =
      'position:absolute;left:0;bottom:0;height:4px;width:0;background:#5eead4;pointer-events:none;z-index:3'
    scrub.label = document.createElement('div')
    scrub.label.style.cssText =
      'position:absolute;left:4px;bottom:8px;padding:1px 6px;border-radius:3px;font:12px/1.4 ' +
      'ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.6);pointer-events:none;z-index:3'
    // Painted by us: the site theme leaves them alone.
    scrub.bar.dataset.ibhUi = scrub.label.dataset.ibhUi = '1'
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
    card.appendChild(scrub.bar)
    card.appendChild(scrub.label)
    scrub.on = true
    return true
  }

  function moveScrub(x) {
    const r = scrub.card.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (x - r.left) / r.width))
    scrub.bar.style.width = `${f * 100}%`
    const at = seekFraction(scrub.video, f)
    scrub.label.textContent = at ? `${mmss(at.t)} / ${mmss(at.d)}` : '…'
  }

  function endScrub() {
    const s = scrub
    scrub = null
    if (!s) return
    clearTimeout(s.holdTimer)
    if (!s.on) return
    if (s.tick) endSlideshow(s)
    s.bar.remove()
    s.label.remove()
    if (s.shared) { previewStop(); s.holder.remove(); returnDecoder() }
    afterPreview()
    // A cover keeps the frame where the finger stopped.
    dbg(`scrub: stopped at ${s.label.textContent}`)
  }

  function onScrubMove(ev) {
    if (!scrub || ev.pointerId !== scrub.id) return
    if (CFG.scrubMode === 'hold') {
      // Moving before the hold starts makes it a scroll; once it runs, ignore moves.
      if (!scrub.on && Math.hypot(ev.clientX - scrub.x0, ev.clientY - scrub.y0) > SCRUB_SLOP) endScrub()
      return
    }
    if (!scrub.on) {
      const dx = Math.abs(ev.clientX - scrub.x0)
      const dy = Math.abs(ev.clientY - scrub.y0)
      if (dy > SCRUB_SLOP && dy > dx) { scrub = null; return }   // a page scroll
      if (dx < SCRUB_SLOP) return
      if (!startScrub()) { scrub = null; return }
    }
    moveScrub(ev.clientX)
  }

  function onScrubUp(ev) {
    if (!scrub || ev.pointerId !== scrub.id) return
    // After a scrub, the click that follows must not open the post or the modal.
    if (scrub.on && ev.type === 'pointerup') scrubClickUntil = Date.now() + 400
    endScrub()
  }

  // Registered before the modal's click handler, so stopping it here wins.
  function onScrubClick(ev) {
    if (Date.now() > scrubClickUntil) return
    scrubClickUntil = 0
    ev.preventDefault()
    ev.stopImmediatePropagation()
  }

  // The browser hands sideways drags on video cards to the page; vertical
  // scrolling and pinch zoom stay with it.
  const SCRUB_CSS = '[data-ibh-video] { touch-action: pan-y pinch-zoom; }' +
    '[data-ibh-video], [data-ibh-video] img { -webkit-user-drag: none; user-select: none; -webkit-touch-callout: none; }'

  function installVideoScrub() {
    if (!CFG.videoScrub) return
    window.addEventListener('pointerdown', onScrubDown, true)
    window.addEventListener('pointermove', onScrubMove, true)
    window.addEventListener('pointerup', onScrubUp, true)
    window.addEventListener('pointercancel', onScrubUp, true)
    window.addEventListener('click', onScrubClick, true)
    // Hold mode: the long press is ours, so the browser's long-press menu stays out.
    window.addEventListener('contextmenu', ev => {
      if (CFG.scrubMode === 'hold' && ev.target.closest && ev.target.closest('[data-ibh-video]')) ev.preventDefault()
    }, true)
    // Belt and braces for the drag-and-drop that cancels a scrub on site pages.
    window.addEventListener('dragstart', ev => {
      if (ev.target.closest && ev.target.closest('[data-ibh-video]')) ev.preventDefault()
    }, true)
    info(`video scene preview active: ${CFG.scrubMode === 'hold' ? 'hold a video thumbnail for a slideshow' : 'drag sideways on a video thumbnail'}`)
  }

  // ═══════════════════════════════════════════════════════════
  // G. Memory management
  //
  // Upgraded images stay decoded while the page lives, so a long feed keeps
  // every original it ever showed. Release what scrolled far away, unload
  // videos Masonry throws out when it rebuilds the grid, and drop everything
  // when the page is left.
  // ═══════════════════════════════════════════════════════════

  // Two screens of slack each way: far enough that a quick scroll back does
  // not refetch, close enough that a long feed keeps only a few originals.
  const FAR_MARGIN = '200% 0px'

  const farViewport = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        for (const e of entries) if (!e.isIntersecting) releaseFar(e.target)
      }, { rootMargin: FAR_MARGIN })
    : null

  function watchDistance(el) {
    if (CFG.memorySaver && farViewport) farViewport.observe(el)
  }

  // Going back to the thumbnail must not change the height of something above
  // the viewport, or the page jumps. Hold the current height until the better
  // file is back (inline !important beats the feed's height:auto !important).
  function pinHeight(el) {
    if (el.tagName !== 'IMG' || !el.clientHeight) return
    el.style.setProperty('height', `${el.clientHeight}px`, 'important')
    el.dataset.ibhPinned = '1'
  }

  function unpinHeight(el) {
    if (!el.dataset.ibhPinned) return
    el.style.removeProperty('height')
    delete el.dataset.ibhPinned
  }

  let releasedCount = 0

  function releaseFar(el) {
    if (el.dataset.ibhOrig !== 'done') { farViewport.unobserve(el); return }
    pinHeight(el)
    resetUpgrade(el)
    farViewport.unobserve(el)
    if (originalViewport) originalViewport.observe(el)   // upgraded again when it comes back
    releasedCount++
    if (releasedCount % 10 === 1) dbg(`memory: released ${releasedCount} off-screen images so far`)
  }

  // Recount from the document. The decoders lent to a scene preview count too:
  // leaving them out let covers open past the phone's limit mid-preview.
  const liveDecoders = () => document.querySelectorAll('video[data-ibh]').length + decodersBorrowed

  // Masonry rebuilds the grid without reloading the page. A removed <video>
  // keeps its decoder until garbage collection, and the live-cover count never
  // came back down, so covers stopped once it sat at the cap. Unload them and
  // recount from what is actually in the document.
  function onNodesRemoved(nodes) {
    let unloaded = 0
    for (const node of nodes) {
      if (node.nodeType !== 1) continue
      const vids = node.matches && node.matches('video[data-ibh]')
        ? [node]
        : (node.querySelectorAll ? [...node.querySelectorAll('video[data-ibh]')] : [])
      for (const v of vids) {
        if (!v.currentSrc) continue   // already unloaded: one of our own unmounts
        v.removeAttribute('src')
        v.load()
        unloaded++
      }
    }
    if (!unloaded) return
    liveCovers = liveDecoders()
    for (const card of coverQueue) if (!card.isConnected) coverQueue.delete(card)
    dbg(`memory: unloaded ${unloaded} videos removed from the page`)
  }

  // Masonry changes page with history.pushState. What it learned about the
  // old page (which video cards were GIFs) is of no use on the new one.
  function onLocationChange() {
    knownGifs.clear()
    for (const card of coverQueue) if (!card.isConnected) coverQueue.delete(card)
    liveCovers = liveDecoders()
    dbg(`memory: page changed to ${location.pathname}${location.search.slice(0, 60)}`)
  }

  // Leaving the page: release everything so the copy Firefox keeps for the
  // back button is light. Coming back from that copy, start the page over.
  function releaseAll() {
    coverQueue.clear()   // first, or each unmount hands its slot to a queued card
    document.querySelectorAll('[data-ibh-cover]').forEach(card => unmountCover(card))
    document.querySelectorAll('[data-ibh-gif="playing"]').forEach(card => stopGif(card))
    document.querySelectorAll('[data-ibh-orig="done"]').forEach(el => {
      resetUpgrade(el)
      if (farViewport) farViewport.unobserve(el)
      if (originalViewport) originalViewport.observe(el)
    })
  }

  // ── Constant cleanup ──
  // The observers release what scrolls away, but cards also move when the
  // grid reflows, and a GIF or cover can stay alive off screen. Sweep with
  // freeOffscreen() every 15 s and whenever a scroll ends.
  const SWEEP_MS = 15000
  const SWEEP_GAP_MS = 2000   // scroll sweeps no closer than this
  let sweepAt = 0

  function sweep(why) {
    // The modal and a preview run their own cleanup; a hidden tab is parked.
    if (document.hidden || (modal && modal.open) || scrub) return
    if (why === 'scroll' && Date.now() - sweepAt < SWEEP_GAP_MS) return
    sweepAt = Date.now()
    const n = freeOffscreen(null)
    if (n.images || n.gifs || n.covers) dbg(`memory: ${why} sweep freed ${n.images} images, ${n.gifs} GIFs, ${n.covers} covers`)
  }

  // A tab in the background decodes nothing, yet its covers and GIFs keep
  // their memory. Park them while hidden and bring them back on return.
  const parked = []

  function onVisibilityChange() {
    if (modal && modal.open) return   // the modal already unloaded the page
    if (document.hidden) {
      parked.push(...coverQueue)
      coverQueue.clear()   // first, or each unmount hands its slot to a queued card
      document.querySelectorAll('[data-ibh-cover]').forEach(card => { unmountCover(card); parked.push(card) })
      document.querySelectorAll('[data-ibh-gif="playing"]').forEach(card => { stopGif(card); parked.push(card) })
      if (parked.length) dbg(`memory: tab hidden, parked ${parked.length} covers and GIFs`)
      return
    }
    for (const card of parked.splice(0)) {
      if (!card.isConnected || !card.dataset.ibhSeen) continue   // scrolled away: the observer handles it
      if (CFG.videoCovers && isVideoCard(card)) mountCover(card)
      else if (CFG.gifInline && isGifCard(card)) playGif(card)
    }
    sweep('return')
  }

  // A scene preview decodes a whole video, the slideshow two: free memory
  // before it starts. Off-screen work goes, and GIFs on screen stop (an
  // animated GIF holds every frame decoded) until the preview ends.
  const previewPaused = []

  function freeForPreview(card) {
    if (!CFG.memorySaver) return
    const n = freeOffscreen(card)
    document.querySelectorAll('[data-ibh-gif="playing"]').forEach(c => {
      if (c === card) return
      stopGif(c)
      previewPaused.push(c)
      n.gifs++
    })
    if (n.images || n.gifs || n.covers) dbg(`memory: preview freed ${n.images} images, ${n.gifs} GIFs, ${n.covers} covers`)
  }

  function afterPreview() {
    for (const c of previewPaused.splice(0)) {
      if (c.isConnected && c.dataset.ibhSeen && CFG.gifInline) playGif(c)
    }
  }

  function installMemorySaver() {
    if (!CFG.memorySaver) return
    setInterval(() => sweep('timed'), SWEEP_MS)
    window.addEventListener('scrollend', () => sweep('scroll'), { passive: true })
    document.addEventListener('visibilitychange', onVisibilityChange)
    for (const name of ['pushState', 'replaceState']) {
      const orig = history[name]
      history[name] = function (...args) {
        const before = location.href
        const out = orig.apply(this, args)
        if (location.href !== before) onLocationChange()
        return out
      }
    }
    window.addEventListener('popstate', onLocationChange)
    window.addEventListener('pagehide', releaseAll)
    window.addEventListener('pageshow', ev => { if (ev.persisted) redoThumbs() })
    info('memory saver active: off-screen images, GIFs and covers are released (every 15 s, after scrolls, while hidden, before previews)')
  }

  // ═══════════════════════════════════════════════════════════
  // H. Post modal on site pages
  //
  // Tapping a thumbnail on the site's own pages opens the post in an overlay
  // instead of leaving the page: videos play with sound, GIFs animate, images
  // show the original. Swipe sideways for the next/previous post, down to
  // close. Own Shadow DOM host, so it works with the panel off. Masonry has its
  // own viewer.
  // ═══════════════════════════════════════════════════════════

  const SITE_LINK = '.image-list span.thumb a'
  const SWIPE_MIN = 60        // px sideways to change post
  const CONTROLS_BAND = 48    // bottom strip of the video: the player's own controls
  let modal = null

  const siteLinks = () => [...document.querySelectorAll(SITE_LINK)]

  const MODAL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
    .m { position: fixed; inset: 0; z-index: 2147483600; background: rgba(0, 0, 0, .95); }
    .stage {
      position: absolute; inset: 0; overflow-y: auto; overscroll-behavior: contain;
      display: flex; flex-direction: column; justify-content: center;
    }
    .stage.tall { justify-content: flex-start; }
    video, img { display: block; width: 100%; background: #000; }
    .vwrap { position: relative; }
    .m:fullscreen { background: #000; }
    /* Gestures go to this layer over the video; the bottom strip holds the
       player's own controls. Firefox's native controls swallowed touches and
       hid their bar behind the layer, worst in fullscreen. */
    .vlayer { position: absolute; left: 0; right: 0; top: 0; bottom: ${CONTROLS_BAND}px;
      -webkit-touch-callout: none; user-select: none; }
    .vctl {
      position: absolute; left: 0; right: 0; bottom: 0; height: ${CONTROLS_BAND}px;
      display: flex; align-items: center; gap: 8px; padding: 0 8px;
      background: linear-gradient(transparent, rgba(0, 0, 0, .45));
      opacity: .8; transition: opacity .3s;
    }
    .vctl.hide { opacity: 0; pointer-events: none; }
    .vctl button { width: 36px; height: 36px; border: none; background: transparent; font-size: 17px; }
    .vctl .vfs { display: flex; align-items: center; justify-content: center; color: #fff; padding: 0; }
    .vctl .vfs svg { width: 26px; height: 26px; fill: currentColor; }
    .vtime { color: #d7dee0; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .vseek { flex: 1; min-width: 0; accent-color: #5eead4; }
    .vprev {
      position: absolute; bottom: ${CONTROLS_BAND + 6}px; width: 160px; height: 90px;
      border: 1px solid #2a3a3f; border-radius: 6px; overflow: hidden; background: #000; pointer-events: none;
    }
    .vprev span {
      position: absolute; left: 0; right: 0; bottom: 0; text-align: center; font-size: 11px;
      color: #fff; background: rgba(0, 0, 0, .55); padding: 1px 0;
    }
    /* Fullscreen shows only the post; a tap on an image brings the bar back. */
    .bar, .side { transition: opacity .2s; }
    .m.clean .bar, .m.clean .side { opacity: 0; pointer-events: none; }
    video { max-height: 100vh; }
    video { -webkit-touch-callout: none; user-select: none; }
    /* The whole image fits the screen, in either orientation; a comic
       (.stage.tall) goes full width and scrolls. */
    img { height: 100%; object-fit: contain; -webkit-user-drag: none; user-select: none; transform-origin: 0 0; }
    .stage.tall img { height: auto; }
    [hidden] { display: none !important; }
    .bar { position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center; gap: 8px; padding: 10px; pointer-events: none; }
    .bar > * { pointer-events: auto; }
    .count { margin-left: auto; color: #a8b8bb; font-size: 13px; text-shadow: 0 1px 3px #000; }
    .status { position: absolute; left: 0; right: 0; top: 50%; text-align: center; color: #a8b8bb; font-size: 14px; pointer-events: none; }
    button, a.btn {
      width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center;
      border: 1px solid #2a3a3f; background: rgba(15, 20, 23, .85); color: #5eead4;
      font-size: 20px; line-height: 1; text-decoration: none; padding: 0;
    }
    .side { position: absolute; top: 50%; transform: translateY(-50%); font-size: 26px; padding-bottom: 3px; }
    .prev { left: 6px; } .next { right: 6px; }
    button.on { background: #5eead4; color: #0f1417; border-color: #5eead4; }
    button.up { width: auto; min-width: 42px; padding: 0 12px; border-radius: 21px; gap: 6px; display: flex; font-size: 16px; }
    .score { font-size: 13px; }
    .badge {
      position: absolute; left: 50%; top: 64px; transform: translateX(-50%);
      padding: 6px 14px; border-radius: 16px; background: rgba(15, 20, 23, .9); color: #5eead4;
      font-size: 15px; font-weight: 600; pointer-events: none;
    }
    .sheet {
      position: absolute; left: 0; right: 0; bottom: 0; max-height: 55%; overflow-y: auto; overscroll-behavior: contain;
      background: rgba(10, 14, 16, .97); border-top: 1px solid #2a3a3f; border-radius: 14px 14px 0 0; padding: 10px 10px 18px;
    }
    .sheethead { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
    button.pill { width: auto; height: 36px; border-radius: 18px; padding: 0 14px; font-size: 13px; }
    button.pill:disabled { opacity: .85; }
    /* Download in progress: the button spins until the file is fetched. */
    .spin { display: inline-block; width: 12px; height: 12px; margin-right: 7px; vertical-align: -2px;
      border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
      animation: ibh-spin .8s linear infinite; }
    @keyframes ibh-spin { to { transform: rotate(360deg); } }
    .taglist { display: flex; flex-wrap: wrap; gap: 6px; }
    button.tag {
      width: auto; height: auto; border-radius: 14px; padding: 6px 10px; font-size: 13px; line-height: 1.3;
      display: inline-block; text-align: left; word-break: break-all; color: #d7dee0;
    }
    button.t-artist { color: #f2ac08; border-color: #6b4e0a; }
    button.t-character { color: #3fb950; border-color: #1f5a2a; }
    button.t-copyright { color: #c678dd; border-color: #5a3566; }
    button.t-metadata { color: #e5534b; border-color: #66282a; }
    button.tag.copied { background: #5eead4; color: #0f1417; border-color: #5eead4; }
    button.tag.held { background: #1d3b38; border-color: #5eead4; }
    button.tag { user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
    .sheet .none { color: #4e6469; font-size: 13px; }
    .tabs { display: flex; gap: 6px; margin-bottom: 10px; }
    button.tab { width: auto; height: 32px; border-radius: 16px; padding: 0 16px; font-size: 13px; }
    button.tab.on { background: #5eead4; color: #0f1417; border-color: #5eead4; }
    .infolist { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: 13px; color: #d7dee0; }
    .infolist[hidden] { display: none; }
    .infolist .k { color: #7f9aa0; white-space: nowrap; }
    .infolist .v { word-break: break-word; }
    .infolist .v.warn { color: #f2ac08; }
    .infolist a { color: #5eead4; }
    .tagsbox[hidden] { display: none; }
    /* Watch later: a grid of the saved posts over the modal. */
    .laterview { display: none; position: absolute; inset: 0; overflow-y: auto; overscroll-behavior: contain;
      background: #0b0f11; padding: 10px; }
    .m.later-mode .laterview { display: block; }
    .m.later-mode .stage, .m.later-mode .bar, .m.later-mode .side, .m.later-mode .status, .m.later-mode .sheet { display: none; }
    .laterhead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .laterhead .lt { color: #d7dee0; font-size: 16px; font-weight: 600; }
    .latergrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 6px; }
    .tile { position: relative; aspect-ratio: 1 / 1; border-radius: 8px; overflow: hidden; background: #0f1417; border: 1px solid #2a3a3f; }
    .tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .tile .play { position: absolute; left: 6px; bottom: 6px; font-size: 13px; color: #fff; background: rgba(0,0,0,.6);
      border-radius: 10px; padding: 1px 7px; pointer-events: none; }
    .tile button.rm { position: absolute; top: 4px; right: 4px; width: 28px; height: 28px; font-size: 14px; }
    .laternote { color: #4e6469; font-size: 12px; margin-top: 14px; text-align: center; }
    .laternote a { color: #5eead4; }
    .latergrid .none { grid-column: 1 / -1; color: #7f9aa0; font-size: 14px; text-align: center; padding: 30px 10px; }
    .toast {
      position: absolute; left: 50%; bottom: 84px; transform: translateX(-50%);
      padding: 8px 14px; border-radius: 18px; background: rgba(15, 20, 23, .92); color: #d7dee0;
      font-size: 13px; pointer-events: none; transition: opacity .2s;
    }
  `

  function buildModal() {
    const host = el('div')
    host.style.cssText = 'all:initial;position:static'
    const root = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = MODAL_CSS
    const video = document.createElement('video')
    video.controls = false   // the player's own controls, below
    video.loop = true
    video.playsInline = true
    const image = document.createElement('img')
    image.draggable = false
    const layer = el('div', { class: 'vlayer' })
    const playBtn = el('button', { text: '❚❚', title: t('mPlay') })
    const time = el('span', { class: 'vtime', text: '0:00 / 0:00' })
    const seek = el('input', { class: 'vseek', type: 'range', min: '0', max: '1000', value: '0' })
    const muteBtn = el('button', { text: '🔊', title: t('mMute') })
    // Bottom right, like YouTube: the way into fullscreen and back out of it,
    // where the top bar is hidden.
    const fsBtn = el('button', { class: 'vfs', title: t('mFull') })
    setFsIcon(fsBtn, false)
    const ctl = el('div', { class: 'vctl' }, [playBtn, time, seek, muteBtn, fsBtn])
    const prevBox = el('div', { class: 'vprev' }, [el('span')])
    prevBox.hidden = true
    const vwrap = el('div', { class: 'vwrap' }, [video, layer, prevBox, ctl])
    const controls = installVideoControls(video, ctl, playBtn, time, seek, muteBtn, prevBox, vwrap)
    const stage = el('div', { class: 'stage' }, [vwrap, image])
    const close = el('button', { text: '✕', title: t('mClose') })
    const post = el('a', { class: 'btn', text: '↗', title: t('mOpen'), target: '_blank', rel: 'noopener' })   // a new tab
    const menu = el('button', { text: '☰', title: t('mMenu') })
    const tagAll = el('button', { class: 'pill', text: t('tagsCopyAll') })
    const tagList = el('div', { class: 'taglist' })
    const laterBtn = el('button', { class: 'pill', text: t('laterAdd') })
    const dlBtn = el('button', { class: 'pill', text: t('dlBtn') })
    const tabTags = el('button', { class: 'tab on', text: t('tabTags') })
    const tabInfo = el('button', { class: 'tab', text: t('tabInfo') })
    const infoList = el('div', { class: 'infolist' })
    infoList.hidden = true
    const sheet = el('div', { class: 'sheet' }, [el('div', { class: 'sheethead' }, [post, laterBtn, dlBtn, tagAll]),
      el('div', { class: 'tabs' }, [tabTags, tabInfo]), tagList, infoList])
    const laterClose = el('button', { text: '✕', title: t('mClose') })
    const laterHead = el('div', { class: 'laterhead' }, [el('span', { class: 'lt' }), laterClose])
    const laterGrid = el('div', { class: 'latergrid' })
    const laterNote = el('div', { class: 'laternote' })
    const laterView = el('div', { class: 'laterview' }, [laterHead, laterGrid, laterNote])
    sheet.hidden = true
    const full = el('button', { text: '⛶', title: t('mFull') })
    const turn = el('button', { text: '↻', title: t('mTurn') })
    const count = el('span', { class: 'count' })
    const status = el('div', { class: 'status' })
    const fav = el('button', { text: '♡', title: t('mFav') })
    const score = el('span', { class: 'score' })
    const up = el('button', { class: 'up', title: t('mUp') }, [el('span', { text: '▲' }), score])
    const toast = el('div', { class: 'toast' })
    toast.style.opacity = '0'
    const badge = el('div', { class: 'badge' })
    badge.hidden = true
    const prev = el('button', { class: 'side prev', text: '‹', title: t('mPrev') })
    const next = el('button', { class: 'side next', text: '›', title: t('mNext') })
    const box = el('div', { class: 'm' }, [stage, status, el('div', { class: 'bar' }, [close, menu, full, turn, fav, up, count]), prev, next, sheet, laterView, toast, badge])
    close.addEventListener('click', () => closeModal(false))
    full.addEventListener('click', () => toggleModalFullscreen())
    menu.addEventListener('click', () => toggleMenu())
    tabTags.addEventListener('click', () => showTab('tags'))
    tabInfo.addEventListener('click', () => showTab('info'))
    // A tap outside the open menu only closes it: no step, no close, no pause.
    let swallowClick = 0
    box.addEventListener('pointerdown', ev => {
      if (sheet.hidden) return
      const path = ev.composedPath()
      if (path.includes(sheet) || path.includes(menu)) return
      closeMenu()
      swallowClick = Date.now() + 600
      ev.stopPropagation()
      ev.preventDefault()
    }, true)
    box.addEventListener('click', ev => {
      if (Date.now() > swallowClick) return
      swallowClick = 0
      ev.stopPropagation()
      ev.preventDefault()
    }, true)
    laterBtn.addEventListener('click', () => toggleLaterHere())
    dlBtn.addEventListener('click', () => modalDownload())
    laterClose.addEventListener('click', () => closeModal(false))
    fsBtn.addEventListener('click', () => toggleModalFullscreen())
    turn.addEventListener('click', () => turnScreen())
    fav.addEventListener('click', modalFavorite)
    up.addEventListener('click', modalUpvote)
    prev.addEventListener('click', () => stepModal(-1))
    next.addEventListener('click', () => stepModal(1))
    // Tap on the empty area around the media closes. The image fills the
    // stage since it fits by object-fit, so its black bars count as empty too.
    stage.addEventListener('click', ev => {
      if (ev.target === stage || (ev.target === image && zoom.scale === 1 && !onImageContent(ev))) closeModal(false)
    })
    installModalSwipe(stage, video)
    installImageZoom(stage, image)
    installVideoGestures(layer, video)
    root.append(style, box)
    modal = { host, root, box, stage, vwrap, video, image, controls, post, count, status, fav, up, score, toast, badge, turn, fsBtn, menu, sheet, tagList, tagAll, laterBtn, dlBtn, tabTags, tabInfo, infoList, sheetTab: 'tags', laterView, laterHead, laterGrid, laterNote, listLinks: null, turned: null, open: false, link: null, seq: 0 }
  }

  let toastTimer = 0
  function flash(text) {
    modal.toast.textContent = text
    modal.toast.style.opacity = '1'
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { modal.toast.style.opacity = '0' }, 1800)
  }

  // ── Favorite and vote state ──
  // The post page tells whether the post is a favorite: its heart icon is
  // heart-added.svg then, heart.svg otherwise. Votes leave no trace on the site
  // (the vote link only updates the score), so the ones made from the modal or
  // from the site's own vote links are remembered here, per site.
  const MARKS_KEY = `IBH_MARKS_${SITE}`   // { f: [favorite ids], v: [upvoted ids] }
  const MARKS_MAX = 5000                   // per kind; the oldest go first
  let marks = null

  function loadMarks() {
    if (!marks) {
      const m = readJSON(MARKS_KEY, {})
      marks = { f: new Set(m.f || []), v: new Set(m.v || []) }
    }
    return marks
  }

  function setMark(kind, id, on) {
    const set = loadMarks()[kind]
    if (on === set.has(id)) return
    if (on) set.add(id)
    else set.delete(id)
    while (set.size > MARKS_MAX) set.delete(set.values().next().value)
    writeJSON(MARKS_KEY, { f: [...marks.f], v: [...marks.v] })
  }

  const hasMark = (kind, id) => loadMarks()[kind].has(id)
  const userId = () => (document.cookie.match(/(?:^|; )user_id=(\d+)/) || [])[1] || null

  // The viewer's own favorites page: every post on it is a favorite.
  const onOwnFavorites = () => {
    const q = new URLSearchParams(location.search)
    return q.get('page') === 'favorites' && !!userId() && q.get('id') === userId()
  }

  // The post page, fetched once per post while the page lives (the swipe
  // ahead warms it), gives the favorite state (its heart icon) and the tags
  // with their kind (its sidebar). Only the parsed facts are kept.
  const postInfos = new Map()   // id -> Promise<{ fav, tags } | null>

  function postInfo(id) {
    let p = postInfos.get(id)
    if (!p) {
      p = fetch(`/index.php?page=post&s=view&id=${encodeURIComponent(id)}`, { credentials: 'same-origin' })
        .then(res => (res.ok ? res.text() : null))
        .then(html => (html ? readPostPage(html) : null))
        .catch(() => null)
      postInfos.set(id, p)
    }
    return p
  }

  function readPostPage(html) {
    const heart = html.match(/id="heart-img"[^>]*src="[^"]*\/(heart(?:-added)?)\.svg"/)
    // An inert document: no scripts run, no images load.
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const tags = []
    for (const li of doc.querySelectorAll('li[class*="tag-type-"]')) {
      const type = (li.className.match(/tag-type-([a-z]+)/) || [])[1] || 'general'
      // The search link carries the tag as typed in a search (underscores).
      const a = [...li.querySelectorAll('a[href*="tags="]')].pop()
      const q = a && a.getAttribute('href').match(/[?&]tags=([^&]+)/)
      if (q) tags.push({ name: decodeURIComponent(q[1].replace(/\+/g, ' ')), type })
    }
    // The sidebar's statistics: Id, Posted … by, Size, Source, Rating, Score.
    const stats = [...doc.querySelectorAll('#stats li')].map(li => {
      const text = li.textContent.replace(/\s+/g, ' ').replace(/\(\s*vote.*$/i, '').trim()
      const link = li.querySelector('a[href^="http"]')
      return { text, href: link ? link.getAttribute('href') : null }
    }).filter(st => st.text)
    // The sidebar's "Original image" link: the exact file, no guessing.
    const orig = [...doc.querySelectorAll('a[href*="/images/"]')].find(a => /original/i.test(a.textContent))
    // The page links videos on api-cdn-mp4, the slow origin (0.4–0.6 MB/s
    // measured, against 6–7 MB/s for the same file on api-cdn, Cloudflare).
    const original = orig ? orig.getAttribute('href').replace(/([^:])\/\/+/g, '$1/').replace('//api-cdn-mp4.', '//api-cdn.') : null
    return { fav: heart ? heart[1] === 'heart-added' : null, tags, stats, original }
  }

  const favLookups = new Map()   // id -> Promise<true | false | null>

  function lookUpFavorite(id) {
    if (!userId()) return Promise.resolve(null)   // logged out: the page has no state to give
    let p = favLookups.get(id)
    if (!p) {
      p = postInfo(id).then(info => {
        if (!info || info.fav === null) return null
        setMark('f', id, info.fav)
        dbg(`modal: post ${id} ${info.fav ? 'is' : 'is not'} a favorite (from the post page)`)
        return info.fav
      })
      favLookups.set(id, p)
    }
    return p
  }

  // ── Storage shared with the bridge ──
  // The lists live in Violentmonkey's storage, on the device, when the storage
  // bridge (ibh-storage-bridge.user.js) is installed: a second script with the
  // @grant this one cannot have. They talk through events on window, as JSON
  // strings. Without the bridge, the site's own localStorage holds them.
  const STORE_TIMEOUT_MS = 700
  const BRIDGE_URL = 'https://raw.githubusercontent.com/JoaoRoch4/ImageBoardHelper/main/ibh-storage-bridge.user.js'
  let storeBridge = null   // unknown until it answers, or stays silent once
  const storeWaiters = new Map()
  let storeSeq = 0

  window.addEventListener('ibh-store-reply', ev => {
    let msg
    try { msg = JSON.parse(ev.detail) } catch (e) { return }
    const waiter = msg && storeWaiters.get(msg.id)
    if (!waiter) return
    storeWaiters.delete(msg.id)
    clearTimeout(waiter.timer)
    storeBridge = true
    waiter.resolve(msg.value)
  })
  // Loaded after a first silent try: use it from now on.
  window.addEventListener('ibh-store-ready', () => { storeBridge = true })

  // Resolves with the stored value, or undefined when no bridge answered.
  function bridgeCall(op, key, value) {
    return new Promise(resolve => {
      if (storeBridge === false) { resolve(undefined); return }
      const id = ++storeSeq
      const timer = setTimeout(() => {
        storeWaiters.delete(id)
        if (storeBridge === null) { storeBridge = false; info('storage bridge not installed: lists kept in the site’s data') }
        resolve(undefined)
      }, STORE_TIMEOUT_MS)
      storeWaiters.set(id, { resolve, timer })
      window.dispatchEvent(new CustomEvent('ibh-store-request', { detail: JSON.stringify({ id, op, key, value }) }))
    })
  }

  // ── Download ──
  // Saves the post's own file (the original image, the GIF, the video) as
  // SITE_ID.ext. Only the storage bridge can save a file from the image hosts;
  // without it the file opens in a new tab, to be saved with a long press (still
  // inside the tap's user activation, so the popup blocker lets it through).
  const downloads = new Map()   // bridge id -> post id, for the outcome
  const downloading = new Set() // post ids in flight: a second tap does not start another
  const dlPercent = new Map()   // post id -> last progress, for the button
  const DL_DONE_MS = 1500       // the ✓ stays this long before the button comes back
  let dlDoneAt = { post: null, until: 0 }

  // The button follows the post on screen: spinning with the progress while
  // it downloads (and disabled, the cooldown), ✓ for a moment once done.
  function refreshDlButton() {
    const btn = modal && modal.dlBtn
    if (!btn) return
    const post = modal.link && postId(modal.link)
    if (downloading.has(post)) {
      btn.disabled = true
      const pct = dlPercent.get(post)
      btn.replaceChildren(el('span', { class: 'spin' }), document.createTextNode(pct == null ? t('dlStart') : `${pct}%`))
    } else if (dlDoneAt.post === post && Date.now() < dlDoneAt.until) {
      btn.disabled = true
      btn.textContent = '✓'
    } else {
      btn.disabled = false
      btn.textContent = t('dlBtn')
    }
  }

  window.addEventListener('ibh-download-progress', ev => {
    let msg
    try { msg = JSON.parse(ev.detail) } catch (e) { return }
    const post = downloads.get(msg.id)
    if (post === undefined) return
    dlPercent.set(post, Math.round((msg.loaded / msg.total) * 100))
    refreshDlButton()
  })

  window.addEventListener('ibh-download-done', ev => {
    let msg
    try { msg = JSON.parse(ev.detail) } catch (e) { return }
    const post = downloads.get(msg.id)
    if (post === undefined) return
    downloads.delete(msg.id)
    downloading.delete(post)
    dlPercent.delete(post)
    if (msg.ok) {
      dlDoneAt = { post, until: Date.now() + DL_DONE_MS }
      setTimeout(refreshDlButton, DL_DONE_MS)
    }
    refreshDlButton()
    if (modal && modal.open) flash(t(msg.ok ? 'dlDone' : 'dlFail'))
    if (msg.ok) info(`download: post ${post} fetched, handed to Firefox to save`)
    else warn(`download: post ${post} failed — ${msg.error}`)
  })

  async function modalDownload() {
    let url = modal.fileUrl
    if (!url) { flash(t('dlWait')); return }
    // The sample is on screen: save the original. Known from the cache or
    // the post page's Original image link; the sample only as a last resort.
    if (modal.isSample) {
      const pic = cardPicture(modal.link)
      const hash = pic && (thumbParts(pic.src) || {}).hash
      const known = hash && knownOriginal(hash)
      const info = typeof known === 'string' ? null : await postInfo(postId(modal.link))
      url = (typeof known === 'string' && known) || (info && info.original) || url
    }
    const post = postId(modal.link)
    if (downloading.has(post)) { flash(t('dlBusy')); return }
    const ext = (url.split(/[?#]/)[0].match(/\.(\w+)$/) || [])[1] || 'bin'
    const name = `${SITE.split('.')[0]}_${post}.${ext}`
    const id = storeSeq + 1   // the id bridgeCall is about to use
    downloads.set(id, post)
    const started = await bridgeCall('download', null, { url, name })
    if (started === undefined) {
      downloads.delete(id)
      window.open(url, '_blank', 'noopener')
      flash(t('dlOpened'))
      info(`download: no storage bridge, post ${post} opened in a new tab`)
      return
    }
    downloading.add(post)
    refreshDlButton()
    info(`download: post ${post} as ${name}`)
  }

  // A copy of the settings in the site's IndexedDB, which localStorage.clear()
  // leaves alone (another script's reset cleared localStorage and the
  // settings with it), and in Violentmonkey when the storage bridge is there.
  function backupCfg() {
    const copy = JSON.parse(JSON.stringify(CFG))
    idbSet('cfg', copy)
    bridgeCall('set', 'cfg', copy)
  }

  // Settings gone from localStorage come back from a copy, and the page
  // reloads once so every option applies from the start. Settings still
  // there refresh the copies. Run a moment after load, once the bridge is up.
  async function restoreCfg() {
    if (CFG_FOUND) { backupCfg(); return }
    let saved = await idbGet('cfg')
    if (!saved || typeof saved !== 'object' || !Object.keys(saved).length) saved = await bridgeCall('get', 'cfg')
    if (!saved || typeof saved !== 'object' || !Object.keys(saved).length) return
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
  let idbOpen = null

  function idb() {
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

  async function idbGet(key) {
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

  async function idbSet(key, value) {
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

  // Without the bridge: IndexedDB, or localStorage where IndexedDB fails.
  // What an older version left in localStorage moves into IndexedDB.
  async function siteGet(key) {
    const value = await idbGet(key)
    const local = readJSON(`IBH_${key}`, null)
    if (value === undefined) return local
    if (value === null && local !== null && await idbSet(key, local)) {
      try { localStorage.removeItem(`IBH_${key}`) } catch (e) { /* ignore */ }
      return local
    }
    return value
  }

  async function siteSet(key, value) {
    if (!(await idbSet(key, value))) writeJSON(`IBH_${key}`, value)
  }

  async function storeGet(key) {
    const value = await bridgeCall('get', key)
    if (value === undefined) return siteGet(key)
    const local = await siteGet(key)
    // First time with the bridge: move what the site's data held into it.
    if (local && (value === null || (Array.isArray(value) && !value.length))) {
      await bridgeCall('set', key, local)
      info(`storage: ${key} moved into Violentmonkey`)
      return local
    }
    return value
  }

  async function storeSet(key, value) {
    if ((await bridgeCall('set', key, value)) === undefined) await siteSet(key, value)
  }

  // ── Watch later ──
  // Posts saved from the ☰ menu, newest first, opened from the 🕒 button in
  // the same modal: a tap opens one, and the swipe walks the list. Each item
  // keeps what the modal needs to show it off the page it came from: the post
  // link, its thumbnail and its tags (they tell a video or a GIF apart).
  const LATER_MAX = 500

  async function laterList() {
    const list = await storeGet('later')
    return Array.isArray(list) ? list : []
  }

  function laterItem(link) {
    const img = link.querySelector('img')
    return {
      site: SITE,
      href: link.href,
      thumb: (img && img.getAttribute('src')) || '',   // the thumbnail, not an upgrade in srcset
      tags: nativeTags(link).trim(),
      webm: !!link.querySelector('img.webm-thumb'),
      added: Date.now(),
    }
  }

  // A detached stand-in for a page thumbnail, which is what the modal reads.
  function laterLink(item) {
    const a = document.createElement('a')
    a.href = item.href
    const img = document.createElement('img')
    img.src = item.thumb
    img.title = item.tags
    if (item.webm) img.className = 'webm-thumb'
    a.appendChild(img)
    return a
  }

  async function toggleLaterHere() {
    const link = modal.link
    if (!link) return
    const list = await laterList()
    const i = list.findIndex(item => item.href === link.href)
    if (i >= 0) list.splice(i, 1)
    else list.unshift(laterItem(link))
    list.length = Math.min(list.length, LATER_MAX)
    await storeSet('later', list)
    setLaterButton(i < 0)
    flash(t(i < 0 ? 'laterAdded' : 'laterRemoved'))
    info(`later: ${i < 0 ? 'saved' : 'removed'} post ${postId(link)} (${list.length} in the list)`)
  }

  function setLaterButton(saved) {
    modal.laterBtn.textContent = t(saved ? 'laterIn' : 'laterAdd')
    modal.laterBtn.classList.toggle('on', saved)
  }

  function refreshLaterButton(link, seq) {
    setLaterButton(false)
    laterList().then(list => {
      if (modal.seq === seq) setLaterButton(list.some(item => item.href === link.href))
    })
  }

  async function showLater() {
    if (!modal) buildModal()
    resetMedia()
    modal.box.classList.add('later-mode')
    openShell()
    await renderLater()
  }

  async function renderLater() {
    const list = (await laterList()).filter(item => item.site === SITE)
    modal.laterHead.querySelector('.lt').textContent = `🕒 ${t('laterTitle')} · ${list.length}`
    // Without the bridge, the note is the way to install it: Violentmonkey
    // opens its install page for a .user.js link. (@require would paste the
    // bridge into this script, under its @grant none, without the storage.)
    if (storeBridge) modal.laterNote.textContent = t('laterOnDevice')
    else modal.laterNote.replaceChildren(el('a', { href: BRIDGE_URL, target: '_blank', rel: 'noopener', text: t('laterOnSite') }))
    if (!list.length) {
      modal.laterGrid.replaceChildren(el('div', { class: 'none', text: t('laterEmpty') }))
      return
    }
    const links = list.map(laterLink)
    if (modal.laterIO) modal.laterIO.disconnect()
    // Sharp pictures for the tiles that scroll into view (see sharpenTile).
    modal.laterIO = 'IntersectionObserver' in window
      ? new IntersectionObserver(entries => {
          for (const e of entries) {
            if (!e.isIntersecting) continue
            modal.laterIO.unobserve(e.target)
            sharpenTile(e.target)
          }
        }, { root: modal.laterView, rootMargin: '300px' })
      : null
    modal.laterGrid.replaceChildren(...list.map((item, i) => {
      const img = el('img', { src: item.thumb, alt: '' })
      img.loading = 'lazy'
      img.dataset.tags = item.tags
      if (item.webm) img.dataset.webm = '1'
      if (modal.laterIO) modal.laterIO.observe(img)
      const rm = el('button', { class: 'rm', text: '✕', title: t('laterRemoved') })
      const tile = el('div', { class: 'tile' }, [img, rm])
      if (item.webm || /\s(video|mp4|webm|animated|gif)\s/i.test(` ${item.tags} `)) tile.appendChild(el('span', { class: 'play', text: '▶' }))
      tile.addEventListener('click', ev => {
        if (ev.target === rm) return
        modal.listLinks = links
        modal.dir = 1
        openModal(links[i])
      })
      rm.addEventListener('click', async () => {
        const all = await laterList()
        await storeSet('later', all.filter(other => other.href !== item.href))
        info(`later: removed post ${postId(links[i])} from the list`)
        renderLater()
      })
      return tile
    }))
    dbg(`later: list shown, ${list.length} posts`)
  }

  // ── Favorites search ──
  // A search bar on your own favorites page. An index of every favorite (id,
  // thumbnail, tags, score) is read once from the favorites pages and kept by
  // the storage bridge; later visits only read the first pages, until they
  // reach favorites already known (the site lists the newest first). Results
  // go into the page's own .image-list as the site's own thumbnails, so the
  // feed, covers, the modal and its swipe all work on them as on any page.
  // (Another script with this feature empties the whole page to show its
  // results and clears localStorage on reset, which broke this one.)
  const FAV_PAGE = 50          // favorites per page on the site
  const FAV_SHOW = 60          // results added per step
  const FAV_GAP_MS = 250       // between page reads, one at a time
  const FAV_STALE_MS = 10 * 60 * 1000   // the index is refreshed in the background after this
  let favIndex = null          // { user, updated, items: [[id, thumb, tags, score]] }, newest first
  let favEntries = null        // the items with their tags split, for searching
  let favScan = null           // the read in progress
  let favPage = null           // the page's own list content, put back on Clear
  let favResults = []
  let favShown = 0
  let favBarSync = null        // refreshes the ☆ button of the favorites bar
  let favBarReload = null      // refreshes its lists

  // The favorites bar's search, remembered for the next visit (active: shown).
  async function rememberFavSearch(active) {
    const bar = document.getElementById('ibh-favsearch')
    if (!bar) return
    const store = await searchStore()
    store.favLast = { text: bar.querySelector('input[type="search"]').value, kind: bar.querySelector('select.kind').value,
      sort: bar.querySelector('select.sort').value, min: bar.querySelector('input.min').value, active }
    if (active) addRecent(store, { where: 'fav', ...store.favLast, active: undefined })   // one write for both
    await storeSet('searches', store)
    if (active && favBarReload) favBarReload()
  }

  async function loadFavIndex() {
    if (favIndex && favIndex.user === userId()) return favIndex
    const saved = await storeGet('favs')
    favIndex = saved && saved.user === userId() ? saved : { user: userId(), updated: 0, items: [] }
    favEntries = null
    return favIndex
  }

  // One page of favorites: ids, thumbnails and tags from the thumbnails, scores
  // from the page's inline script (posts[ID] = { … score: 'N' }).
  async function readFavPage(pid) {
    const res = await fetch(`/index.php?page=favorites&s=view&id=${userId()}&pid=${pid}`, { credentials: 'same-origin' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const scores = new Map()
    for (const m of html.matchAll(/posts\[(\d+)\]\s*=\s*\{[^}]*?score['"]?\s*:\s*['"]?(-?\d+)/g)) scores.set(m[1], Number(m[2]))
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return [...doc.querySelectorAll('.thumb img[src]')].map(img => {
      const a = img.closest('a')
      const id = ((a && a.getAttribute('href')) || '').match(/id=(\d+)/)?.[1] || (img.getAttribute('src').split('?')[1] || '')
      return [id, img.getAttribute('src'), (img.getAttribute('title') || img.getAttribute('alt') || '').trim(), scores.has(id) ? scores.get(id) : null]
    }).filter(item => /^\d+$/.test(item[0]))
  }

  // Reads the favorites pages into the index: all of them (full), or only
  // until a page holds favorites already known.
  function updateFavIndex(full) {
    if (favScan) return favScan
    favScan = (async () => {
      const idx = await loadFavIndex()
      const known = new Set(full ? [] : idx.items.map(item => item[0]))
      const fresh = []
      try {
        for (let pid = 0; ; pid += FAV_PAGE) {
          setFavStatus(`${t('favScanning')} ${pid / FAV_PAGE + 1}…`)
          let items = null
          for (let tries = 0; !items; tries++) {
            try { items = await readFavPage(pid) } catch (e) {
              if (tries >= 2) throw e
              await new Promise(r => setTimeout(r, 1000 * (tries + 1)))
            }
          }
          if (!items.length) break
          const added = items.filter(item => !known.has(item[0]))
          added.forEach(item => known.add(item[0]))
          fresh.push(...added)
          if (!full && added.length < items.length) break   // reached the index
          await new Promise(r => setTimeout(r, FAV_GAP_MS))
        }
      } catch (e) {
        warn(`favorites: ${t('favScanFail')} — ${describeError(e)}`)
        setFavStatus(t('favScanFail'))
        return null
      } finally {
        favScan = null
      }
      idx.items = full ? fresh : [...fresh, ...idx.items]
      idx.updated = Date.now()
      favEntries = null
      await storeSet('favs', idx)
      info(`favorites: index ${full ? 'rebuilt' : 'updated'}, ${fresh.length} new, ${idx.items.length} in all`)
      setFavStatus()
      return idx
    })()
    return favScan
  }

  // tag, -tag, tag* (wildcard), a ~ b (either), score:>10 (also >=, <, <=, =).
  function favMatcher(word) {
    const score = word.match(/^score:(>=|<=|>|<|=)?(-?\d+)$/)
    if (score) {
      const n = Number(score[2])
      const op = score[1] || '>='
      return e => e.score != null && (op === '>' ? e.score > n : op === '<' ? e.score < n
        : op === '<=' ? e.score <= n : op === '=' ? e.score === n : e.score >= n)
    }
    if (word.includes('*')) {
      const re = new RegExp(`^${word.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
      return e => e.tags.some(tag => re.test(tag))
    }
    return e => e.set.has(word)
  }

  function favQuery(text) {
    const words = text.toLowerCase().trim().split(/\s+/).filter(Boolean)
    const groups = []   // every group must hold: one of `any`, or none of it when negated
    words.forEach((word, i) => {
      if (word === '~') return
      const neg = word.startsWith('-') && word.length > 1
      const matcher = favMatcher(neg ? word.slice(1) : word)
      if (!neg && words[i - 1] === '~' && groups.length && !groups[groups.length - 1].neg) groups[groups.length - 1].any.push(matcher)
      else groups.push({ neg, any: [matcher] })
    })
    return e => groups.every(g => g.any.some(m => m(e)) !== g.neg)
  }

  async function searchFavs() {
    const bar = document.getElementById('ibh-favsearch')
    if (!bar) return
    const text = bar.querySelector('input').value
    let idx = await loadFavIndex()
    if (!idx.items.length) idx = (await updateFavIndex(true)) || idx
    else if (Date.now() - idx.updated > FAV_STALE_MS) idx = (await updateFavIndex(false)) || idx
    if (!favEntries) {
      favEntries = idx.items.map(([id, thumb, tags, score]) => {
        const list = tags.toLowerCase().split(/\s+/)
        // The kind, from the tags as the covers read it (an untagged video
        // passes for an image here too).
        const spaced = ` ${tags} `
        const video = NATIVE_REAL_VIDEO.test(spaced)
        const gif = NATIVE_GIF.test(spaced)
        const animated = video || gif || /\sanimated\s/i.test(spaced)
        return { item: [id, thumb, tags], tags: list, set: new Set(list), score, video, gif, animated }
      })
    }
    const match = favQuery(text)
    const kind = bar.querySelector('select.kind').value
    const ofKind = e => kind === 'all' || (kind === 'image' ? !e.animated : e[kind])
    const min = Number(bar.querySelector('input.min').value) || 0
    let found = favEntries.filter(e => ofKind(e) && (!min || (e.score != null && e.score >= min)) && match(e))
    const sort = bar.querySelector('select.sort').value
    if (sort === 'old') found = found.reverse()
    else if (sort === 'score') found = [...found].sort((a, b) => (b.score ?? -1e9) - (a.score ?? -1e9))
    else if (sort === 'random') found = found.map(e => [Math.random(), e]).sort((a, b) => a[0] - b[0]).map(pair => pair[1])
    showFavResults(found.map(e => e.item))
    rememberFavSearch(true)
    if (favBarSync) favBarSync()
    info(`favorites: "${text.trim()}" (${kind}, ${sort}${min ? `, score >= ${min}` : ''}) -> ${found.length} of ${favEntries.length}`)
  }

  // The site's own thumbnail markup, so every feature treats it like one.
  function favThumb([id, thumb, tags]) {
    const span = document.createElement('span')
    span.className = 'thumb'
    span.id = `s${id}`
    const a = document.createElement('a')
    a.id = `p${id}`
    a.href = `index.php?page=post&s=view&id=${id}`
    const img = document.createElement('img')
    img.src = thumb
    img.title = img.alt = tags
    img.className = 'preview'
    a.appendChild(img)
    span.appendChild(a)
    return span
  }

  function showFavResults(items) {
    const list = document.querySelector('.image-list')
    if (!list) return
    if (!favPage) favPage = [...list.childNodes]   // put back on Clear
    favResults = items
    favShown = 0
    list.replaceChildren()
    document.querySelectorAll('#paginator, .pagination').forEach(p => { p.style.display = 'none' })
    showMoreFavs()
    window.scrollTo({ top: list.getBoundingClientRect().top + window.scrollY - 80 })
  }

  function showMoreFavs() {
    const list = document.querySelector('.image-list')
    if (!list) return
    const next = favResults.slice(favShown, favShown + FAV_SHOW)
    list.append(...next.map(favThumb))
    favShown += next.length
    const more = document.getElementById('ibh-favmore')
    more.hidden = favShown >= favResults.length
    more.textContent = `${t('favMore')} (${favResults.length - favShown})`
    setFavStatus(`${favResults.length} ${t('favResults')}`)
  }

  function clearFavSearch() {
    const list = document.querySelector('.image-list')
    if (list && favPage) list.replaceChildren(...favPage)
    favPage = null
    favResults = []
    document.querySelectorAll('#paginator, .pagination').forEach(p => { p.style.display = '' })
    const more = document.getElementById('ibh-favmore')
    if (more) more.hidden = true
    const bar = document.getElementById('ibh-favsearch')
    if (bar) bar.querySelector('input').value = ''
    rememberFavSearch(false)
    if (favBarSync) favBarSync()
    setFavStatus()
  }

  function setFavStatus(text) {
    const st = document.querySelector('#ibh-favsearch .st')
    if (!st) return
    if (text) { st.firstChild.textContent = text; return }
    const idx = favIndex
    st.firstChild.textContent = idx && idx.items.length
      ? `${idx.items.length} ${t('favIndexed')} · ${new Date(idx.updated).toLocaleString(LANG)}`
      : t('favNever')
  }

  // Idempotent: the observer calls it on every change of the page.
  function ensureFavSearch() {
    const bar = document.getElementById('ibh-favsearch')
    const want = CFG.favSearch && SITE === 'rule34.xxx' && onOwnFavorites() && !!document.querySelector('.image-list')
    if (!want) { if (bar) { clearFavSearch(); bar.remove(); document.getElementById('ibh-favmore')?.remove() } return }
    if (bar) return
    const list = document.querySelector('.image-list')
    const input = el('input', { type: 'search', placeholder: t('favPlaceholder'), enterkeyhint: 'search' })
    input.setAttribute('autocapitalize', 'off')
    input.setAttribute('autocomplete', 'off')
    const kind = kindSelect()
    const sort = el('select', { class: 'sort' })
    for (const [value, label] of [['new', t('favSortNew')], ['old', t('favSortOld')], ['score', t('favSortScore')], ['random', t('favSortRandom')]]) {
      sort.appendChild(el('option', { value, text: label }))
    }
    const min = minScoreInput()
    const go = el('button', { type: 'button', text: t('favGo') })
    const clear = el('button', { type: 'button', text: t('favClear') })
    const update = el('a', { href: '#', text: t('favUpdate') })
    const rebuild = el('a', { href: '#', text: t('favRebuild') })
    const st = el('div', { class: 'st' }, [document.createTextNode(''), ' · ', update, ' · ', rebuild])
    const read = () => ({ where: 'fav', text: input.value, kind: kind.value, sort: sort.value, min: min.value })
    const saved = savedControls('fav', read, q => {
      input.value = q.text; kind.value = q.kind; sort.value = q.sort; min.value = q.min || ''
      searchFavs()
    })
    const box = el('div', { id: 'ibh-favsearch', class: 'ibh-search' }, [input, kind, sort, min, go, clear, saved.star, saved.pick, saved.recentPick, st])
    favBarSync = saved.sync
    favBarReload = saved.reload
    list.before(box)
    const more = el('button', { type: 'button', id: 'ibh-favmore' })
    more.hidden = true
    list.after(more)
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); searchFavs() } })
    go.addEventListener('click', () => searchFavs())
    sort.addEventListener('change', () => { if (favPage) searchFavs() })
    kind.addEventListener('change', () => searchFavs())   // a kind alone is a search: every video, every GIF…
    min.addEventListener('change', () => searchFavs())
    min.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); min.blur() } })
    clear.addEventListener('click', () => clearFavSearch())
    more.addEventListener('click', () => showMoreFavs())
    update.addEventListener('click', ev => { ev.preventDefault(); updateFavIndex(false) })
    rebuild.addEventListener('click', ev => { ev.preventDefault(); updateFavIndex(true) })
    input.addEventListener('input', saved.sync)
    min.addEventListener('input', saved.sync)
    // The last search comes back, results included, until Clear.
    searchStore().then(store => {
      const last = store.favLast
      if (!last || !last.active || !document.getElementById('ibh-favsearch')) return
      input.value = last.text || ''; kind.value = last.kind || 'all'; sort.value = last.sort || 'new'; min.value = last.min || ''
      saved.sync()
      searchFavs()
    })
    loadFavIndex().then(idx => {
      setFavStatus()
      // New favorites since the last visit come in quietly (usually one page).
      if (idx.items.length && Date.now() - idx.updated > FAV_STALE_MS) updateFavIndex(false)
    })
    info('favorites search bar added')
  }

  function minScoreInput() {
    const min = el('input', { class: 'min', type: 'number', min: '0', step: '1', inputmode: 'numeric', placeholder: t('minScore') })
    min.title = t('minScore')
    return min
  }

  function kindSelect() {
    const kind = el('select', { class: 'kind' })
    for (const [value, label] of [['all', t('favKindAll')], ['image', t('favKindImage')], ['video', t('favKindVideo')],
      ['gif', t('favKindGif')], ['animated', t('favKindAnimated')]]) {
      kind.appendChild(el('option', { value, text: label }))
    }
    return kind
  }

  // ── Mass favorite ──
  // ♥ next to 🕒 turns a mode on where a tap on a thumbnail favorites and
  // upvotes the post on the spot (like the site's own heart does) instead of
  // opening it, and marks the thumbnail. Tap ♥ again to leave.
  const HEART_ICON = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'
  let bulkMode = false

  const wantsBulkButton = () => !!CFG.bulkFavButton && SITE === 'rule34.xxx' && !!userId() && !!document.querySelector(SITE_LINK)

  function setBulkMode(on) {
    bulkMode = on
    const heart = shadow && shadow.querySelector('.bulkfab')
    if (heart) heart.classList.toggle('on', on)
    pageToast(t(on ? 'bulkOn' : 'bulkOff'))
    info(`mass favorite ${on ? 'on' : 'off'}`)
  }

  let pageToastTimer = 0
  function pageToast(text) {
    if (!shadow) return
    let toast = shadow.querySelector('.pagetoast')
    if (!toast) { toast = el('div', { class: 'pagetoast' }); shadow.appendChild(toast) }
    toast.textContent = text
    toast.style.opacity = '1'
    clearTimeout(pageToastTimer)
    pageToastTimer = setTimeout(() => { toast.style.opacity = '0' }, 2200)
  }

  // A mark on the thumbnail: ♥ done, … working, ✕ failed.
  function bulkBadge(link, text, tone) {
    let badge = link.querySelector('.ibh-bulkbadge')
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'ibh-bulkbadge'
      badge.dataset.ibhUi = '1'   // the site theme leaves it alone
      if (getComputedStyle(link).position === 'static') link.style.position = 'relative'
      link.appendChild(badge)
    }
    badge.textContent = text
    badge.style.background = tone
  }

  async function bulkFavorite(link) {
    const id = postId(link)
    if (link.dataset.ibhBulk) return   // done or in progress
    link.dataset.ibhBulk = '1'
    bulkBadge(link, '…', 'rgba(15, 20, 23, .85)')
    try {
      const { code } = await favoritePost(id, false)
      if (code === '2') { bulkBadge(link, '✕', '#b42318'); pageToast(t('favLogin')); delete link.dataset.ibhBulk; return }
      if (code !== '3' && code !== '1') throw new Error(`answer ${code.slice(0, 20)}`)
      await upvotePost(id)
      bulkBadge(link, '♥', '#e5534b')
      info(`mass favorite: post ${id} ${code === '3' ? 'favorited' : 'was a favorite'}, upvoted`)
    } catch (e) {
      delete link.dataset.ibhBulk
      bulkBadge(link, '✕', '#b42318')
      warn(`mass favorite: post ${id} failed — ${describeError(e)}`)
    }
  }

  // Registered before the modal's click handler, so a tap favorites instead.
  function onBulkClick(ev) {
    if (!bulkMode || ev.button !== 0) return
    const link = ev.target.closest && ev.target.closest(SITE_LINK)
    if (!link) return
    ev.preventDefault()
    ev.stopImmediatePropagation()
    bulkFavorite(link)
  }

  // ── Saved searches ──
  // Every search a bar runs is kept on its own among the recent ones; ☆
  // makes one a favorite. The favorites bar also keeps its last search, shown
  // again on the next visit until Clear. Stored with the lists as
  // { saved (the favorites), recent, favLast }.
  const RECENT_MAX = 15   // per bar

  async function searchStore() {
    const v = await storeGet('searches')
    const ok = v && typeof v === 'object' && !Array.isArray(v)
    return { saved: (ok && v.saved) || [], recent: (ok && v.recent) || [], favLast: (ok && v.favLast) || null }
  }

  // Nothing typed and no filter: not worth keeping.
  const emptySearch = q => !q.text.trim() && q.kind === 'all' && !q.min && q.sort === 'new'

  function addRecent(store, q) {
    if (emptySearch(q)) return
    const key = searchKey(q)
    store.recent = [q, ...store.recent.filter(other => searchKey(other) !== key)]
    const mine = store.recent.filter(other => other.where === q.where)
    if (mine.length > RECENT_MAX) store.recent = store.recent.filter(other => !mine.slice(RECENT_MAX).includes(other))
  }

  const searchKey = q => [q.where, q.text.trim().replace(/\s+/g, ' '), q.kind, q.sort, String(q.min || '')].join('|')

  function searchLabel(q) {
    const kinds = { image: t('favKindImage'), video: t('favKindVideo'), gif: t('favKindGif'), animated: t('favKindAnimated') }
    return [q.text.trim() || t('savedAll'), kinds[q.kind], q.min ? `≥ ${q.min}` : '', q.sort === 'score' ? t('favSortScore') : '']
      .filter(Boolean).join(' · ')
  }

  // The two pick lists (favorites, recent) and the ☆ button for a bar:
  // read() gives its search, apply() fills it in and runs it.
  function savedControls(where, read, apply) {
    const pick = el('select', { class: 'saved' })
    const recentPick = el('select', { class: 'saved' })
    const star = el('button', { type: 'button', class: 'star' })
    let saved = []
    let recent = []
    const sync = () => {
      const on = saved.some(q => searchKey(q) === searchKey(read()))
      star.textContent = t(on ? 'savedSearch' : 'saveSearch')
      star.classList.toggle('on', on)
    }
    const fillOne = (select, list, title) => {
      const mine = list.filter(q => q.where === where)
      select.replaceChildren(el('option', { value: '', text: t(title) }), ...mine.map((q, i) => el('option', { value: String(i), text: searchLabel(q) })))
      select.hidden = !mine.length
    }
    const fill = () => {
      fillOne(pick, saved, 'savedPick')
      fillOne(recentPick, recent, 'recentPick')
      sync()
    }
    const reload = async () => { const store = await searchStore(); saved = store.saved; recent = store.recent; fill() }
    const onPick = (select, source) => select.addEventListener('change', () => {
      const q = source().filter(other => other.where === where)[Number(select.value)]
      select.value = ''
      if (q) apply(q)
    })
    onPick(pick, () => saved)
    onPick(recentPick, () => recent)
    star.addEventListener('click', async () => {
      const store = await searchStore()
      const q = read()
      const i = store.saved.findIndex(other => searchKey(other) === searchKey(q))
      if (i >= 0) store.saved.splice(i, 1)
      else store.saved.unshift(q)
      await storeSet('searches', store)
      info(`search ${i >= 0 ? 'removed from' : 'saved in'} the ${where} list: ${searchLabel(q)}`)
      saved = store.saved
      fill()
    })
    reload()
    return { pick, recentPick, star, sync, reload }
  }

  // A search the site bar finds in the address (typed, or a tag link) is a recent one.
  async function recordSiteSearch(q) {
    if (emptySearch(q)) return
    const store = await searchStore()
    addRecent(store, q)
    await storeSet('searches', store)
  }

  // ── Search bar on site pages ──
  // The favorites bar's look on the site's listing pages, built on the site's
  // own search: the kind becomes tags, the minimum score score:>=N, the order
  // sort:score, and the bar reads them back from the address, so it always
  // shows the search on screen.
  const KIND_QUERY = {
    image: '-animated -video -gif',
    video: 'video',
    gif: '( gif ~ animated_gif )',
    animated: '( animated ~ video ~ gif )',
  }

  function readSiteQuery(tags) {
    let rest = ` ${tags.trim().replace(/\s+/g, ' ')} `
    let kind = 'all'
    for (const [k, q] of Object.entries(KIND_QUERY)) {
      if (rest.includes(` ${q} `)) { kind = k; rest = rest.replace(` ${q} `, ' '); break }
    }
    let sort = 'new'
    rest = rest.replace(/ sort:score(?::desc)? /i, () => { sort = 'score'; return ' ' })
    let min = ''
    rest = rest.replace(/ score:>=?(\d+) /i, (m, n) => { min = n; return ' ' })
    return { rest: rest.trim(), kind, sort, min }
  }

  function siteQuery({ rest, kind, sort, min }) {
    return [rest, KIND_QUERY[kind] || '', min ? `score:>=${min}` : '', sort === 'score' ? 'sort:score' : '']
      .filter(Boolean).join(' ')
  }

  // Idempotent: the observer calls it on every change of the page.
  function ensureSiteSearch() {
    const bar = document.getElementById('ibh-sitesearch')
    const want = CFG.siteSearch && !onFavoritesPage() && !document.querySelector('.v-application') &&
      new URLSearchParams(location.search).get('page') === 'post' && !!document.querySelector('.image-list')
    if (!want) { if (bar) bar.remove(); return }
    if (bar) return
    const now = readSiteQuery(new URLSearchParams(location.search).get('tags') || '')
    const input = el('input', { type: 'search', placeholder: t('sitePlaceholder'), enterkeyhint: 'search' })
    input.setAttribute('autocapitalize', 'off')
    input.setAttribute('autocomplete', 'off')
    input.value = now.rest === 'all' ? '' : now.rest
    const kind = kindSelect()
    kind.value = now.kind
    const sort = el('select', { class: 'sort' })
    for (const [value, label] of [['new', t('favSortNew')], ['score', t('favSortScore')]]) sort.appendChild(el('option', { value, text: label }))
    sort.value = now.sort
    const min = minScoreInput()
    min.value = now.min
    const go = el('button', { type: 'button', text: t('favGo') })
    const read = () => ({ where: 'site', text: input.value, kind: kind.value, sort: sort.value, min: min.value })
    const saved = savedControls('site', read, q => {
      input.value = q.text; kind.value = q.kind; sort.value = q.sort; min.value = q.min || ''
      submit()
    })
    const box = el('div', { id: 'ibh-sitesearch', class: 'ibh-search' }, [input, kind, sort, min, go, saved.star, saved.pick, saved.recentPick])
    document.querySelector('.image-list').before(box)
    recordSiteSearch(read()).then(saved.reload)
    input.addEventListener('input', saved.sync)
    min.addEventListener('input', saved.sync)
    const submit = () => {
      const q = siteQuery({ rest: input.value, kind: kind.value, sort: sort.value, min: min.value })
      info(`site search: ${q || 'all'}`)
      location.href = `index.php?page=post&s=list&tags=${encodeURIComponent(q || 'all').replace(/%20/g, '+')}`
    }
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); submit() } })
    min.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); submit() } })
    go.addEventListener('click', submit)
    kind.addEventListener('change', submit)
    sort.addEventListener('change', submit)
    dbg('site search bar added')
  }

  // ── Autopager ──
  // Search listings and favorites fetch the next page as the bottom nears
  // and append its thumbnails, the site's own nodes, to the list. The
  // observer treats them like any thumbnail (covers, feed, modal and swipe).
  // The next address comes from the paginator of each page fetched; the
  // favorites paginator navigates from onclick handlers with no real href,
  // which is why autopager extensions find no next page there.
  let pager = null   // { next, busy, done, io, sentinel }

  const onListPage = () => {
    const q = new URLSearchParams(location.search)
    return q.get('page') === 'post' && q.get('s') === 'list'
  }

  const onFavoritesPage = () => {
    const q = new URLSearchParams(location.search)
    return q.get('page') === 'favorites' && q.get('s') === 'view' && !!q.get('id')
  }

  // Idempotent: the observer calls it on every change of the page.
  function ensureFavPager() {
    const want = CFG.favAutopager && (onFavoritesPage() || onListPage()) && !document.querySelector('.v-application') &&
      !!document.querySelector('.image-list')
    if (!want) {
      if (pager) { pager.io.disconnect(); pager.sentinel.remove(); pager = null }
      return
    }
    if (pager && pager.sentinel.isConnected) return
    const sentinel = el('div', { id: 'ibh-pager' })
    ;(document.getElementById('ibh-favmore') || document.querySelector('.image-list')).after(sentinel)
    sentinel.addEventListener('click', () => { if (pager && !pager.done) favPagerNext() })   // retry after a failure
    const next = pageTarget(1)
    pager = { next, busy: false, done: !next, page: 1, sentinel }
    if (!next) sentinel.textContent = t('pagerEnd')
    pager.io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) favPagerNext()
    }, { rootMargin: '1500px 0px' })
    pager.io.observe(sentinel)
    dbg(`autopager: watching the bottom of the page${next ? '' : ' (last page)'}`)
  }

  async function favPagerNext() {
    const p = pager
    // favPage: search results are on show, not the favorites pages.
    if (!p || p.busy || p.done || favPage) return
    p.busy = true
    p.sentinel.textContent = t('pagerLoading')
    try {
      const url = p.next
      const res = await fetch(url, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
      const src = doc.querySelector('.image-list')
      const items = src ? [...src.children].filter(node => node.querySelector && node.querySelector('img')) : []
      const list = document.querySelector('.image-list')
      if (!items.length || !list) {
        p.done = true
        p.sentinel.textContent = t('pagerEnd')
        info(`autopager: end of the list at ${url.replace(/^.*\?/, '?')}`)
        return
      }
      list.append(...items.map(node => document.adoptNode(node)))
      p.page++
      p.next = pageTarget(1, doc, url)
      info(`autopager: page ${p.page} added (${items.length} posts)`)
      if (!p.next) { p.done = true; p.sentinel.textContent = t('pagerEnd'); return }
      p.sentinel.textContent = ''
    } catch (e) {
      warn(`autopager: next favorites page failed — ${describeError(e)}`)
      p.sentinel.textContent = t('pagerFail')
      return
    } finally {
      p.busy = false
    }
    // Still near the bottom (a short page): the observer will not fire again.
    if (p.sentinel.getBoundingClientRect().top < window.innerHeight + 1500) setTimeout(favPagerNext, 300)
  }

  // The site's thumbnail is small and blurry stretched over a tile. Swap in
  // the sample (images, GIFs: their still) or the full-size poster frame
  // (videos), from the same download slots and URL cache as the page; the
  // thumbnail stays when there is none.
  function sharpenTile(img) {
    const src = img.getAttribute('src')
    const hash = (thumbParts(src) || {}).hash
    if (!hash) return
    const tags = ` ${img.dataset.tags || ''} `
    const video = !!img.dataset.webm || NATIVE_REAL_VIDEO.test(tags)
    const kind = video ? 'poster' : 'sample'
    const cached = cacheGet(kind, hash)
    if (cached === null) return   // known: nothing better exists
    const urls = cachedFirst(video ? fileCandidates(src, ['jpg']) : sampleCandidates(src), cached)
    if (!urls.length) return
    takeImageSlot(() => {
      const probe = new Image()
      probe.decoding = 'async'
      let i = 0
      let held = true
      const release = () => { if (held) { held = false; giveImageSlot() } }
      probe.onerror = () => {
        if (i < urls.length) { probe.src = urls[i++]; return }
        release()
        cacheSet(kind, hash, null)
      }
      probe.onload = () => {
        release()
        cacheSet(kind, hash, probe.src, cached)
        if (img.isConnected) img.src = probe.src   // a tile in our own Shadow DOM: no Imagus to keep happy
      }
      probe.src = urls[i++]
    })
  }

  // ── Tags menu ──
  // ☰ opens a sheet with the post's tags as a grid; a tap copies one, "Copy
  // all" the whole list, ready to paste in a search. The thumbnail's own tags
  // show at once; the post page replaces them with the full list by kind.
  const TAG_ORDER = ['artist', 'character', 'copyright', 'general', 'metadata']
  const tagRank = type => { const i = TAG_ORDER.indexOf(type); return i < 0 ? TAG_ORDER.length : i }

  function thumbTags(link) {
    return nativeTags(link).trim().split(/\s+/)
      .filter(name => name && !/^(score|rating):/i.test(name))
      .map(name => ({ name, type: 'general' }))
  }

  function toggleMenu() {
    const open = modal.sheet.hidden
    modal.sheet.hidden = !open
    modal.menu.classList.toggle('on', open)
    if (open) renderSheet(modal.link, modal.seq)
  }

  function renderSheet(link, seq) {
    if (modal.sheetTab === 'info') renderInfo(link, seq)
    else renderTags(link, seq)
  }

  function showTab(tab) {
    modal.sheetTab = tab
    modal.tabTags.classList.toggle('on', tab === 'tags')
    modal.tabInfo.classList.toggle('on', tab === 'info')
    modal.tagList.hidden = modal.tagAll.hidden = tab !== 'tags'
    modal.infoList.hidden = tab !== 'info'
    renderSheet(modal.link, modal.seq)
  }

  // Info tab: what the file says (kind, size, format, length), how playback
  // is going here (frames dropped so far, measured by the video itself), and
  // the post page's statistics. Redrawn when the file's metadata arrives.
  // (MediaCapabilities was no use: Firefox for Android answers "smooth,
  // power efficient" even for 4K on a phone whose decoder stops at 1088p.)
  async function renderInfo(link, seq) {
    const v = modal.video
    const img = modal.image
    const video = !v.hidden
    const url = modal.fileUrl
    const rows = []
    const kind = video ? t('kindVideo') : /\.gif(\?|$)/i.test(url || '') ? t('kindGif') : t('kindImage')
    rows.push([t('infoKind'), kind])
    const w = video ? v.videoWidth : (url ? img.naturalWidth : 0)
    const h = video ? v.videoHeight : (url ? img.naturalHeight : 0)
    rows.push([t('infoRes'), w && h ? `${w} × ${h}` : t('infoLoading')])
    // A typical mid-range hardware decoder stops at 1920×1088 (this phone's does).
    if (video && w && h && (Math.max(w, h) > 1920 || Math.min(w, h) > 1088)) rows.push(['', t('infoAbove'), true])
    rows.push([t('infoFormat'), url ? `${((url.split(/[?#]/)[0].match(/\.(\w+)$/) || [])[1] || '?').toUpperCase()}${modal.isSample ? ` (${t('infoSample')})` : ''}` : t('infoLoading')])
    if (video) rows.push([t('infoDuration'), Number.isFinite(v.duration) ? mmss(v.duration) : t('infoLoading')])
    if (video && typeof v.getVideoPlaybackQuality === 'function') {
      const q = v.getVideoPlaybackQuality()
      if (q.totalVideoFrames >= 30) {
        const pct = Math.round((q.droppedVideoFrames / q.totalVideoFrames) * 100)
        rows.push([t('infoDrops'), `${pct}% (${q.droppedVideoFrames} ${t('infoDropsOf')} ${q.totalVideoFrames})`, pct >= 10])
      }
    }
    if (modal.seq !== seq || modal.sheetTab !== 'info') return
    fillInfo(rows, [])
    const info = await postInfo(postId(link))
    if (modal.seq !== seq || modal.sheetTab !== 'info' || !info || !info.stats) return
    fillInfo(rows, info.stats)
  }

  function fillInfo(rows, stats) {
    const cells = []
    for (const [k, value, warn] of rows) cells.push(el('span', { class: 'k', text: k }), el('span', { class: warn ? 'v warn' : 'v', text: value }))
    for (const st of stats) {
      const m = st.text.match(/^([^:]{1,20}):\s*(.*)$/)
      const k = m ? m[1] : ''
      const value = m ? m[2] : st.text
      const cell = st.href
        ? el('span', { class: 'v' }, [el('a', { href: st.href, target: '_blank', rel: 'noopener', text: value })])
        : el('span', { class: 'v', text: value })
      cells.push(el('span', { class: 'k', text: k }), cell)
    }
    modal.infoList.replaceChildren(...cells)
  }

  function closeMenu() {
    modal.sheet.hidden = true
    modal.menu.classList.remove('on')
  }

  function renderTags(link, seq) {
    fillTags(thumbTags(link))
    postInfo(postId(link)).then(info => {
      if (!info || !info.tags.length || modal.seq !== seq || modal.sheet.hidden) return
      fillTags(info.tags)
      dbg(`modal: tags menu, ${info.tags.length} tags from the post page`)
    })
  }

  function fillTags(tags) {
    const sorted = [...tags].sort((a, b) => tagRank(a.type) - tagRank(b.type))
    modal.tagList.replaceChildren(...sorted.map(tag => {
      const chip = el('button', { class: `tag t-${tag.type}`, text: tag.name })
      chipGestures(chip, tagSearchUrl(tag.name), () => copyText(tag.name, chip))
      return chip
    }))
    if (!sorted.length) modal.tagList.append(el('span', { class: 'none', text: t('tagsNone') }))
    modal.tagAll.onclick = () => copyText(sorted.map(tag => tag.name).join(' '), modal.tagAll)
  }

  // A tap copies the tag; a hold opens its search in a new tab. The tab opens
  // on release, not when the hold timer fires: a timer is not a user gesture,
  // and the popup blocker would stop window.open from it.
  const TAG_HOLD_MS = 450
  const tagSearchUrl = name => `/index.php?page=post&s=list&tags=${encodeURIComponent(name)}`

  // Measured on the phone (event log): Firefox for Android ends a long press
  // three ways — contextmenu then pointerup; contextmenu then pointercancel;
  // or pointercancel ~110 ms in, with no contextmenu, as soon as the finger
  // trembles (it takes the touch for a scroll of the sheet). Touch events go
  // on through all three, so a touch hold is measured on them: long enough,
  // the finger nearly still and the sheet not scrolled. Pointer events only
  // serve the mouse. The tab opens from touchend/pointerup, both user gestures.
  const HOLD_SLOP = 12   // px the finger may wander and still be holding

  function chipGestures(chip, url, onTap) {
    let down = null
    let skipClick = false
    const reset = () => {
      if (down) clearTimeout(down.timer)
      down = null
      chip.classList.remove('held')
    }
    const start = (x, y) => {
      skipClick = false
      // Lit once held long enough, so the finger knows it can let go.
      down = { x, y, t: Date.now(), scroll: modal.sheet.scrollTop, timer: setTimeout(() => chip.classList.add('held'), TAG_HOLD_MS) }
    }
    const moved = (x, y) => down && Math.hypot(x - down.x, y - down.y) > HOLD_SLOP
    const finish = ev => {
      if (!down) return
      const held = Date.now() - down.t >= TAG_HOLD_MS && Math.abs(modal.sheet.scrollTop - down.scroll) < HOLD_SLOP
      reset()
      if (!held) return
      skipClick = true   // a click that may follow is not a copy
      if (ev.cancelable) ev.preventDefault()   // and stop it where we can
      window.open(url, '_blank', 'noopener')
      flash(t('tagOpened'))
      dbg(`modal: tag search opened in a new tab (${url})`)
    }
    chip.addEventListener('touchstart', ev => start(ev.touches[0].clientX, ev.touches[0].clientY), { passive: true })
    chip.addEventListener('touchmove', ev => { if (moved(ev.touches[0].clientX, ev.touches[0].clientY)) reset() }, { passive: true })
    chip.addEventListener('touchend', finish)
    chip.addEventListener('touchcancel', reset)
    chip.addEventListener('pointerdown', ev => { if (ev.pointerType === 'mouse') start(ev.clientX, ev.clientY) })
    chip.addEventListener('pointermove', ev => { if (ev.pointerType === 'mouse' && moved(ev.clientX, ev.clientY)) reset() })
    chip.addEventListener('pointerup', ev => { if (ev.pointerType === 'mouse') finish(ev) })
    chip.addEventListener('contextmenu', ev => ev.preventDefault())   // the hold is ours
    chip.addEventListener('click', () => {
      if (skipClick) { skipClick = false; return }
      onTap()
    })
  }

  async function copyText(text, chip) {
    let ok = false
    try {
      await navigator.clipboard.writeText(text)   // the tap is the user gesture it needs
      ok = true
    } catch (e) {
      // Older path: a selected text field and the copy command.
      const field = document.createElement('textarea')
      field.value = text
      field.style.cssText = 'position:fixed;opacity:0'
      document.documentElement.appendChild(field)
      field.select()
      try { ok = document.execCommand('copy') } catch (e2) { /* not allowed */ }
      field.remove()
    }
    flash(ok ? `${t('tagCopied')}: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}` : t('tagCopyFail'))
    if (ok) {
      chip.classList.add('copied')
      setTimeout(() => chip.classList.remove('copied'), 600)
    }
    dbg(`modal: copy ${ok ? 'done' : 'failed'} (${text.length} chars)`)
  }

  function showFav(on) {
    modal.fav.textContent = on ? '♥' : '♡'
    modal.fav.classList.toggle('on', on)
  }

  // What is known shows at once; the post page corrects it when it answers.
  // The site never shows a past vote, but its heart votes up as it favorites
  // (post_vote then toggleFav), so a favorite counts as upvoted.
  function applyMarks(link, seq) {
    const id = postId(link)
    const own = onOwnFavorites()
    if (own) setMark('f', id, true)
    const show = fav => {
      showFav(fav)
      modal.up.classList.toggle('on', fav || hasMark('v', id))
    }
    show(own || hasMark('f', id))
    if (own) return
    lookUpFavorite(id).then(fav => { if (fav !== null && modal.open && modal.seq === seq) show(fav) })
  }

  // The site's own vote links (post pages, comments) count too.
  function onSiteVoteClick(ev) {
    const a = ev.target.closest && ev.target.closest('a[onclick*="post_vote("]')
    const m = a && a.getAttribute('onclick').match(/post_vote\('(\d+)',\s*'up'\)/)
    if (m) setMark('v', m[1], true)
  }

  // The same endpoints the post page calls, so the site's login cookie goes
  // along. Answers decoded from the site's own addFav/toggleFav: 3 added,
  // 1 already there, 2 not logged in, 4 removed (toggle only). A lit heart
  // pressed again removes the favorite, like the site's own heart.
  // The site's answer: '3' added, '1' already there, '2' logged out, '4' removed.
  async function favoritePost(id, remove) {
    const res = await fetch(`/public/addfav.php?id=${encodeURIComponent(id)}${remove ? '&toggle=1' : ''}`, { credentials: 'same-origin' })
    const code = (await res.text()).trim().replace(/"/g, '')   // toggle answers in JSON
    if (code === '3' || code === '1' || code === '4') {
      const fav = code !== '4'
      setMark('f', id, fav)
      favLookups.set(id, Promise.resolve(fav))
    }
    return { code, status: res.status }
  }

  // The new score, or null.
  async function upvotePost(id) {
    const res = await fetch(`/index.php?page=post&s=vote&id=${encodeURIComponent(id)}&type=up`, { credentials: 'same-origin' })
    const score = parseInt(await res.text(), 10)
    if (!res.ok || !Number.isFinite(score)) return null
    setMark('v', id, true)
    return score
  }

  async function modalFavorite() {
    const id = postId(modal.link)
    const remove = modal.fav.classList.contains('on')
    try {
      const { code, status } = await favoritePost(id, remove)
      const res = { status }
      if (code === '3' || code === '1' || code === '4') {
        const fav = code !== '4'
        showFav(fav)
        flash(t(code === '3' ? 'favAdded' : code === '1' ? 'favAlready' : 'favRemoved'))
        // The site's own heart votes up as it favorites; do the same, so a
        // favorite always counts as upvoted (see applyMarks).
        if (code === '3') modalUpvote(true)
      } else {
        flash(code === '2' ? t('favLogin') : `${t('favFail')} (${res.status} ${code.slice(0, 20)})`)
      }
      info(`modal: ${remove ? 'unfavorite' : 'favorite'} post ${id} -> ${code.slice(0, 20)}`)
    } catch (e) {
      flash(t('favFail'))
      warn(`modal: favorite failed — ${describeError(e)}`)
    }
  }

  // Answers with the new score as plain text, which the post page shows.
  // `quiet` (from the heart): no toast of its own, the heart's one stays.
  async function modalUpvote(quiet) {
    quiet = quiet === true   // as a click handler it gets the event
    const id = postId(modal.link)
    try {
      const res = await fetch(`/index.php?page=post&s=vote&id=${encodeURIComponent(id)}&type=up`, { credentials: 'same-origin' })
      const score = parseInt(await res.text(), 10)
      if (res.ok && Number.isFinite(score)) {
        if (postId(modal.link) === id) {   // still on that post
          modal.score.textContent = String(score)
          modal.up.classList.add('on')
        }
        setMark('v', id, true)
        if (!quiet) flash(t('voted'))
      } else if (!quiet) {
        flash(`${t('voteFail')} (${res.status})`)
      }
      info(`modal: upvote post ${id} -> ${Number.isFinite(score) ? score : res.status}`)
    } catch (e) {
      flash(t('voteFail'))
      warn(`modal: upvote failed — ${describeError(e)}`)
    }
  }

  function installModalSwipe(stage, video) {
    let start = null
    stage.addEventListener('pointerdown', ev => {
      const r = video.hidden ? null : video.getBoundingClientRect()
      // Drags on the video's own controls are seeks, not swipes.
      const onControls = r && ev.clientY > r.bottom - CONTROLS_BAND && ev.clientY <= r.bottom
      start = onControls ? null : { x: ev.clientX, y: ev.clientY, t: Date.now(), top: stage.scrollTop }
    })
    stage.addEventListener('pointercancel', () => { start = null })
    stage.addEventListener('pointerup', ev => {
      if (!start) return
      // A pinch, a drag on a zoomed image, or the end of a 2x hold is not a swipe.
      if (zoom.scale > 1 || zoom.multi || videoPress.held) { start = null; return }
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      const quick = Date.now() - start.t < 600
      const wasAtTop = start.top <= 0
      start = null
      if (!quick) return
      if (Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) stepModal(dx < 0 ? 1 : -1)
      // Down closes, but inside a tall image only from its top: otherwise it is scrolling.
      else if (dy > 90 && dy > Math.abs(dx) * 1.5 && wasAtTop) closeModal(false)
    })
  }

  // Pinch zoom on the modal image. The stage takes touches itself (touch-action),
  // which also turns off the browser's zoom, and that one would scale the
  // whole page anyway. transform-origin is the image's top-left, so its screen
  // position is its layout position plus the translation.
  const zoom = { scale: 1, x: 0, y: 0, multi: false }
  const ZOOM_MAX = 6
  const ZOOM_DOUBLE_TAP = 2.5

  function applyZoom() {
    const img = modal.image
    img.style.transform = zoom.scale === 1 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`
    if (zoom.scale > 1 && modal.isSample) loadModalOriginal()
    // Zoomed, every drag pans the image; at 1x a tall image scrolls natively.
    if (!img.hidden) modal.stage.style.touchAction = zoom.scale > 1 || !modal.stage.classList.contains('tall') ? 'none' : 'pan-y'
  }

  function resetZoom() {
    zoom.scale = 1
    zoom.x = zoom.y = 0
    if (modal) applyZoom()
  }

  function installImageZoom(stage, img) {
    const pts = new Map()
    let pinch = null
    let pan = null
    let lastTap = { t: 0, x: 0, y: 0 }
    // Layout top-left of the image on screen, transform taken out.
    const origin = () => { const r = img.getBoundingClientRect(); return { left: r.left - zoom.x, top: r.top - zoom.y } }
    const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) } }

    stage.addEventListener('pointerdown', ev => {
      if (img.hidden) return
      pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, t: Date.now() })
      if (pts.size === 2) {
        zoom.multi = true
        const m = mid()
        // The image point under the fingers' midpoint stays under it.
        const o = origin()
        pinch = { d: m.d, scale: zoom.scale, cx: (m.x - o.left - zoom.x) / zoom.scale, cy: (m.y - o.top - zoom.y) / zoom.scale, o }
        pan = null
      } else if (pts.size === 1 && zoom.scale > 1) {
        pan = { x: ev.clientX, y: ev.clientY, zx: zoom.x, zy: zoom.y }
      }
    })

    stage.addEventListener('pointermove', ev => {
      const p = pts.get(ev.pointerId)
      if (!p) return
      p.x = ev.clientX
      p.y = ev.clientY
      if (pinch && pts.size >= 2) {
        const m = mid()
        zoom.scale = Math.min(ZOOM_MAX, Math.max(1, pinch.scale * (m.d / pinch.d)))
        zoom.x = m.x - pinch.o.left - pinch.cx * zoom.scale
        zoom.y = m.y - pinch.o.top - pinch.cy * zoom.scale
        applyZoom()
      } else if (pan) {
        zoom.x = pan.zx + (ev.clientX - pan.x)
        zoom.y = pan.zy + (ev.clientY - pan.y)
        applyZoom()
      }
    })

    const end = ev => {
      const p = pts.get(ev.pointerId)
      pts.delete(ev.pointerId)
      if (pts.size < 2) pinch = null
      if (pts.size === 0) {
        pan = null
        if (zoom.scale < 1.05) resetZoom()   // let go near 1x: snap back
        // Double tap: zoom in on that spot, or back to 1x.
        if (ev.type === 'pointerup' && p && !zoom.multi && Date.now() - p.t < 250 &&
            Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 10) {
          const now = Date.now()
          if (now - lastTap.t < 300 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < 30) {
            if (zoom.scale > 1) resetZoom()
            else {
              const o = origin()
              zoom.scale = ZOOM_DOUBLE_TAP
              zoom.x = ev.clientX - o.left - (ev.clientX - o.left) * ZOOM_DOUBLE_TAP
              zoom.y = ev.clientY - o.top - (ev.clientY - o.top) * ZOOM_DOUBLE_TAP
              applyZoom()
            }
            lastTap.t = 0
          } else {
            lastTap = { t: now, x: ev.clientX, y: ev.clientY }
            // A single tap in fullscreen shows or hides the bar, once it is
            // clear no second tap (zoom) follows.
            const tapAt = now
            setTimeout(() => {
              if (lastTap.t === tapAt && modal.root.fullscreenElement) setCleanUi(!modal.box.classList.contains('clean'))
            }, 320)
          }
        }
        // Cleared after the swipe handler (registered first) has seen it.
        setTimeout(() => { zoom.multi = false }, 0)
      }
    }
    stage.addEventListener('pointerup', end)
    stage.addEventListener('pointercancel', end)
  }

  // On the modal video: hold for 2x while the finger stays down; double tap on
  // the right or left third to jump 5 s forward or back. The control strip is
  // left to the player. Turned, "left/right" follow the viewer, not the screen.
  const HOLD_FAST_MS = 400
  const HOLD_RATE = 2
  const SEEK_STEP = 5
  const videoPress = { held: false }

  let badgeTimer = 0
  function showBadge(text, sticky) {
    modal.badge.textContent = text
    modal.badge.hidden = false
    clearTimeout(badgeTimer)
    if (!sticky) badgeTimer = setTimeout(() => { modal.badge.hidden = true }, 700)
  }

  function installVideoGestures(layer, video) {
    let press = null
    let tap = null   // a first tap waiting to see whether a second one follows
    const viewerX = ev => {
      const r = layer.getBoundingClientRect()
      return Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width))
    }
    const release = () => {
      if (!press) return
      clearTimeout(press.timer)
      if (videoPress.held) {
        video.playbackRate = press.rate
        modal.badge.hidden = true
        dbg('modal: hold released, back to normal speed')
      }
      press = null
      // Cleared after the swipe handler on the stage has seen this pointerup.
      setTimeout(() => { videoPress.held = false }, 0)
    }

    // A long press would open the browser's media menu and cancel the hold.
    layer.addEventListener('contextmenu', ev => ev.preventDefault())

    layer.addEventListener('pointerdown', ev => {
      if (press) return
      const fx = viewerX(ev)
      press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: Date.now(), fx, rate: video.playbackRate || 1 }
      dbg(`modal: video press at ${Math.round(fx * 100)}%`)
      press.timer = setTimeout(() => {
        if (!press) return
        if (video.paused) { dbg('modal: hold ignored, video is paused'); return }
        videoPress.held = true
        video.playbackRate = HOLD_RATE
        showBadge(`${HOLD_RATE}×`, true)
        dbg(`modal: hold, playing at ${HOLD_RATE}x`)
      }, HOLD_FAST_MS)
    })
    layer.addEventListener('pointermove', ev => {
      if (!press || videoPress.held || ev.pointerId !== press.id) return
      if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 10) {   // a swipe, handled on the stage
        clearTimeout(press.timer)
        press = null
      }
    })
    layer.addEventListener('pointercancel', () => { if (press) dbg('modal: video press cancelled by the browser'); release() })
    layer.addEventListener('pointerup', ev => {
      if (!press || ev.pointerId !== press.id) return
      const quickTap = !videoPress.held && Date.now() - press.t < 250 &&
        Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < 10
      const side = press.fx > 0.65 ? 1 : press.fx < 0.35 ? -1 : 0
      release()
      if (!quickTap) return
      // Second tap within 300 ms: a double tap. On a side it seeks, in the
      // centre it toggles fullscreen (like YouTube); the pending single-tap
      // action is cancelled either way. The tap is the user gesture
      // fullscreen needs.
      if (tap && Date.now() - tap.t < 300) {
        clearTimeout(tap.timer)
        if (!side && !tap.side) {
          dbg('modal: double tap in the centre, fullscreen')
          toggleModalFullscreen()
        } else if (side && side === tap.side) {
          const d = Number.isFinite(video.duration) ? video.duration : Infinity
          video.currentTime = Math.min(d, Math.max(0, video.currentTime + side * SEEK_STEP))
          showBadge(side > 0 ? `+${SEEK_STEP}s` : `−${SEEK_STEP}s`)
          dbg(`modal: double tap, ${side > 0 ? '+' : '-'}${SEEK_STEP}s`)
        }
        tap = null
        return
      }
      // A single tap plays or pauses, once it is clear no second tap follows.
      tap = { t: Date.now(), side }
      tap.timer = setTimeout(() => {
        tap = null
        // Controls hidden: the tap only brings them back.
        if (!modal.controls.shown()) { modal.controls.poke(); return }
        if (video.paused) { video.play().catch(() => {}); showBadge('▶') }
        else { video.pause(); showBadge('❚❚') }
        modal.controls.poke()
        dbg(`modal: tap, ${video.paused ? 'paused' : 'playing'}`)
      }, 300)
    })
  }

  const mmss = sec => Number.isFinite(sec) ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : '0:00'

  const CONTROLS_HIDE_MS = 2000

  // Returns { shown(), poke() }: the bar fades after 2 s without interaction
  // while playing, and stays up while paused or while the seek bar is dragged.
  function installVideoControls(video, ctl, playBtn, time, seek, muteBtn, prevBox, vwrap) {
    let dragging = false
    let hideTimer = 0
    const poke = () => {
      ctl.classList.remove('hide')
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => { if (!dragging && !video.paused) ctl.classList.add('hide') }, CONTROLS_HIDE_MS)
    }
    const sync = () => {
      playBtn.textContent = video.paused ? '▶' : '❚❚'
      muteBtn.textContent = video.muted ? '🔇' : '🔊'
      time.textContent = `${mmss(video.currentTime)} / ${mmss(video.duration)}`
      if (!dragging && video.duration) seek.value = String(Math.round((video.currentTime / video.duration) * 1000))
    }
    for (const type of ['timeupdate', 'play', 'pause', 'volumechange', 'loadedmetadata', 'durationchange', 'emptied']) {
      video.addEventListener(type, sync)
    }
    playBtn.addEventListener('click', () => { if (video.paused) video.play().catch(() => {}); else video.pause() })
    muteBtn.addEventListener('click', () => { video.muted = !video.muted })
    // While the seek bar is dragged, only the preview box follows the finger;
    // the main video jumps once, on release.
    const PREV_W = 160
    seek.addEventListener('input', () => {
      dragging = true
      const f = Number(seek.value) / 1000
      if (prevBox.hidden && video.currentSrc) {
        prevBox.hidden = false
        previewLoad(prevBox, [video.currentSrc], null)
      }
      const sr = seek.getBoundingClientRect()
      const wr = vwrap.getBoundingClientRect()
      const x = sr.left - wr.left + f * sr.width - PREV_W / 2
      prevBox.style.left = `${Math.min(wr.width - PREV_W - 4, Math.max(4, x))}px`
      if (previewEl && previewEl.isConnected) seekFraction(previewEl, f)
      const d = video.duration
      prevBox.lastChild.textContent = mmss(f * d)
      time.textContent = `${mmss(f * d)} / ${mmss(d)}`
      poke()
    })
    seek.addEventListener('change', () => {
      dragging = false
      const d = video.duration
      if (d) video.currentTime = (Number(seek.value) / 1000) * d
      previewStop()
      prevBox.hidden = true
      poke()
    })
    ctl.addEventListener('pointerdown', poke)
    video.addEventListener('play', poke)
    video.addEventListener('pause', () => { clearTimeout(hideTimer); ctl.classList.remove('hide') })
    video.addEventListener('emptied', () => { clearTimeout(hideTimer); ctl.classList.remove('hide') })
    return { shown: () => !ctl.classList.contains('hide'), poke }
  }

  // In fullscreen the bar and side buttons hide; a single tap on an image
  // toggles them. Video keeps its own controls visible either way.
  function setCleanUi(clean) {
    modal.box.classList.toggle('clean', clean)
  }

  // Stop whatever is showing and invalidate loads still in flight (seq).
  function resetMedia() {
    modal.seq++
    modal.fileUrl = null   // the post's own file, once it loaded (Download)
    if (modal.cancelLoad) { modal.cancelLoad(); modal.cancelLoad = null }   // probes of the post left behind
    modal.isSample = false
    modal.origPending = false
    const v = modal.video
    v.pause()
    v.onerror = v.oncanplay = v.onloadedmetadata = null
    v.playbackRate = 1
    modal.badge.hidden = true
    if (!modal.root.fullscreenElement) setCleanUi(false)
    v.removeAttribute('src')
    v.load()   // hand the decoder back
    modal.image.onerror = null
    modal.image.removeAttribute('src')
    modal.stage.scrollTop = 0
    resetZoom()
  }

  // The player's own fullscreen button turns the screen for a wide video,
  // which Firefox allows only in fullscreen (Screen Orientation API). Outside
  // fullscreen nothing is turned.
  // Fullscreen on the wrapper (video + gesture layer), from the ⛶ button.
  // Fullscreen goes to the whole modal, for any kind of post: the bar, swipes,
  // zoom and the video's gesture layer all come along.
  function toggleModalFullscreen() {
    if (modal.root.fullscreenElement) { document.exitFullscreen().catch(() => {}); return }
    if (!modal.box.requestFullscreen) return
    modal.box.requestFullscreen().catch(e => dbg(`modal: fullscreen refused — ${describeError(e)}`))
  }

  // ↻ turns the screen to the other orientation, for any post, and keeps it
  // for the next ones; pressed again it turns back, and leaving fullscreen
  // (or closing) returns to the automatic rule. Firefox locks
  // the orientation only in fullscreen, so the press enters it first (the tap
  // is the user gesture fullscreen needs).
  function turnScreen() {
    const orientation = screen.orientation
    if (!orientation || !orientation.lock) { flash(t('mTurnNo')); return }
    const portrait = String(orientation.type).startsWith('portrait')
    modal.turned = portrait ? 'landscape' : 'portrait'
    modal.turn.classList.add('on')
    info(`modal: screen turned to ${modal.turned}`)
    if (modal.root.fullscreenElement) fitFullscreenOrientation()
    else toggleModalFullscreen()   // its fullscreenchange applies the turn
  }

  // Material Design's fullscreen icons (the ones YouTube uses), as path data.
  const FS_ICON = {
    enter: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
    exit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
  }

  function setFsIcon(btn, full) {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', full ? FS_ICON.exit : FS_ICON.enter)
    svg.appendChild(path)
    btn.replaceChildren(svg)
    btn.title = t(full ? 'mFullExit' : 'mFull')
  }

  // Landscape only while fullscreen shows a wide video, unless ↻ chose an
  // orientation; anything else unlocks.
  function fitFullscreenOrientation() {
    const orientation = screen.orientation
    if (!orientation) return
    const v = modal.video
    const full = !!modal.root.fullscreenElement
    if (full && modal.turned && orientation.lock) {
      orientation.lock(modal.turned).catch(e => dbg(`modal: orientation lock refused — ${describeError(e)}`))
    } else if (full && CFG.rotateLandscape && !v.hidden && v.videoWidth > v.videoHeight && orientation.lock) {
      orientation.lock('landscape').then(
        () => dbg('modal: fullscreen locked to landscape'),
        e => dbg(`modal: orientation lock refused — ${describeError(e)}`))
    } else {
      try { if (orientation.unlock) orientation.unlock() } catch (e) { /* not locked */ }
    }
  }

  function onFullscreenChange() {
    if (!modal || !modal.open) return
    const v = modal.video
    const orientation = screen.orientation
    // Inside our Shadow DOM the document sees the host; the root sees which
    // element inside it is fullscreen.
    const inside = modal.root.fullscreenElement
    // The native controls' button makes the bare <video> fullscreen, which
    // leaves the gesture layer behind. Hand fullscreen to the whole modal;
    // the tap on that button still counts as the user gesture it needs.
    if (inside === v && modal.box.requestFullscreen) {
      modal.box.requestFullscreen().then(
        () => dbg('modal: fullscreen moved to the modal'),
        e => dbg(`modal: could not move fullscreen — ${describeError(e)}`))
      return   // the next fullscreenchange does the orientation
    }
    dbg(`modal: fullscreen ${inside ? 'on' : 'off'}`)
    if (!inside) { modal.turned = null; modal.turn.classList.remove('on') }   // the lock went with it
    setFsIcon(modal.fsBtn, !!inside)
    setCleanUi(!!inside)
    fitFullscreenOrientation()
  }

  // Firefox for Android keeps its own orientation rules for video fullscreen,
  // and with the modal (not a <video>) fullscreen it sometimes drops the lock
  // and goes back to portrait. Put landscape back whenever that happens.
  function onOrientationChange() {
    if (!modal || !modal.open || !modal.root.fullscreenElement) return
    if (modal.turned) {
      if (!String(screen.orientation.type).startsWith(modal.turned)) fitFullscreenOrientation()
      return
    }
    const v = modal.video
    if (CFG.rotateLandscape && !v.hidden && v.videoWidth > v.videoHeight &&
        String(screen.orientation.type).startsWith('portrait')) {
      dbg('modal: fullscreen video went back to portrait, locking landscape again')
      fitFullscreenOrientation()
    }
  }

  function showVideo(candidates, hash, onMissing, onFound) {
    const vcached = cacheGet('video', hash)
    const urls = cachedFirst(candidates, vcached)
    const seq = modal.seq
    // The phone decodes about four videos at once; the modal gets one of them.
    document.querySelectorAll('[data-ibh-cover]').forEach(card => unmountCover(card))
    coverQueue.clear()
    modal.image.hidden = true
    modal.video.hidden = false
    modal.vwrap.hidden = false
    modal.stage.classList.remove('tall')
    modal.stage.style.touchAction = 'none'   // all drags are ours; the controls still work
    const v = modal.video
    let i = 0
    v.onerror = () => {
      if (i < urls.length) { v.src = urls[i++]; return }   // walk the hosts, like covers
      // No decoder free (3) or a network drop (2) is not "missing".
      const missing = !(v.error && (v.error.code === 3 || v.error.code === 2))
      if (missing) cacheSet('video', hash, null)
      // No host has a video file: posts tagged "animated" but not "gif" are
      // often GIFs, so try that before showing the failure.
      if (missing && onMissing && modal.seq === seq) { onMissing(); return }
      modal.status.textContent = t('mFail')
    }
    v.oncanplay = () => { modal.status.hidden = true; preloadAhead(seq) }
    v.onloadedmetadata = () => {
      cacheSet('video', hash, urls[i - 1], vcached)
      if (modal.seq === seq) modal.fileUrl = urls[i - 1]
      if (modal.seq === seq && !modal.sheet.hidden && modal.sheetTab === 'info') renderInfo(modal.link, seq)
      fitFullscreenOrientation()   // swiped onto a wide video while fullscreen
      if (onFound) onFound()
    }
    v.muted = false   // with sound, even if the previous video was muted from the controls
    v.src = urls[i++]
    // The tap that opened the modal is a user gesture, which is what lets the
    // browser play with sound. If its autoplay policy still blocks audio, play
    // muted rather than not at all: the controls' speaker button unmutes.
    const played = v.play()
    if (played && played.catch) {
      played.catch(e => {
        if (e.name !== 'NotAllowedError') return
        dbg('modal: sound blocked by the autoplay policy, playing muted')
        v.muted = true
        v.play().catch(() => {})
      })
    }
  }

  // Show what the page already has at once, then the better file when it loads.
  // Loads candidate URLs at once and keeps the first that loads, dropping the
  // rest: a wrong extension (404) then costs nothing, where trying them in
  // turn cost ~0.5 s each (measured on rule34: .jpeg came after two misses).
  // Stages run in order (samples, then originals), so a big original is not
  // fetched beside a sample that exists. A known winner goes alone first.
  // Returns a cancel function.
  // priority: 'high' for what is on screen now (the modal), the browser's
  // default otherwise.
  function raceImage(stages, cached, onWin, onFail, priority) {
    let done = false
    const probes = []
    const drop = keep => probes.forEach(pr => { if (pr !== keep) { pr.onload = pr.onerror = null; pr.removeAttribute('src') } })
    const win = pr => { if (done) return; done = true; drop(pr); onWin(pr) }
    const probe = (url, onError) => {
      const pr = new Image()
      pr.decoding = 'async'
      if (priority) pr.fetchPriority = priority
      probes.push(pr)
      pr.onload = () => win(pr)
      pr.onerror = onError
      pr.src = url
    }
    const runStage = i => {
      if (done) return
      const list = (stages[i] || []).filter(url => url !== cached)
      if (i >= stages.length) { done = true; onFail(); return }
      if (!list.length) { runStage(i + 1); return }
      let failed = 0
      list.forEach(url => probe(url, () => { if (++failed === list.length) runStage(i + 1) }))
    }
    if (typeof cached === 'string') probe(cached, () => runStage(0))
    else runStage(0)
    return () => { done = true; drop(null) }
  }

  // What the page already found for a post: its 'sample' winner is the
  // original itself when the post has no sample (an /images/ URL).
  function knownOriginal(hash) {
    const orig = cacheGet('orig', hash)
    if (orig !== undefined) return orig
    const page = cacheGet('sample', hash)
    return typeof page === 'string' && page.includes('/images/') ? page : undefined
  }

  const isSampleUrl = url => /\/samples\//.test(url || '')

  // candidates: a list of URLs, or stages of them (see raceImage).
  function showImage(placeholder, candidates, kind, hash) {
    const stages = Array.isArray(candidates[0]) ? candidates : [candidates]
    const icached = kind === 'orig' ? knownOriginal(hash) : cacheGet(kind, hash)
    const seq = modal.seq
    modal.video.hidden = true
    modal.vwrap.hidden = true
    fitFullscreenOrientation()   // an image in fullscreen: no landscape lock
    modal.image.hidden = false
    const img = modal.image
    img.onload = fitImage
    img.src = placeholder
    modal.status.hidden = true
    if (icached === null) return   // known: nothing better than the placeholder
    modal.cancelLoad = raceImage(stages, icached, probe => {
      cacheSet(kind, hash, probe.src, icached)
      if (modal.seq !== seq) return   // the user moved on
      modal.fileUrl = probe.src
      modal.isSample = isSampleUrl(probe.src)   // the original comes on zoom (modalOriginal)
      if (!modal.sheet.hidden && modal.sheetTab === 'info') setTimeout(() => renderInfo(modal.link, seq), 50)   // once swapped in
      const decoded = typeof probe.decode === 'function' ? probe.decode().catch(() => {}) : Promise.resolve()
      decoded.then(() => {
        if (modal.seq !== seq) return
        img.src = probe.src
        if (kind === 'gif') watchModalGif(img, probe.src, seq)
        preloadAhead(seq)
      })
    }, () => cacheSet(kind, hash, null), 'high')
  }

  // Zoomed into a sample: fetch the original and swap it in, the zoom kept
  // (same picture, same box, more pixels).
  function loadModalOriginal() {
    if (!modal.isSample || modal.origPending) return
    const link = modal.link
    const pic = link && cardPicture(link)
    const parts = pic && thumbParts(pic.src)
    if (!parts) return
    modal.origPending = true
    const seq = modal.seq
    const cached = knownOriginal(parts.hash)
    if (cached === null) return
    flash(t('origLoading'))
    raceImage([fileCandidates(pic.src, ORIGINAL_EXTS)], cached, probe => {
      cacheSet('orig', parts.hash, probe.src, cached)
      if (modal.seq !== seq) return
      const decoded = typeof probe.decode === 'function' ? probe.decode().catch(() => {}) : Promise.resolve()
      decoded.then(() => {
        if (modal.seq !== seq) return
        modal.image.src = probe.src
        modal.fileUrl = probe.src
        modal.isSample = false
        info(`modal: original loaded on zoom (${probe.src.split('/').pop()})`)
      })
    }, () => cacheSet('orig', parts.hash, null), 'high')
  }

  // Whether a tap falls on the picture itself, not on the bars object-fit
  // leaves around it inside the <img> box.
  function onImageContent(ev) {
    const img = modal.image
    if (!img.naturalWidth) return true
    const r = img.getBoundingClientRect()
    const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight)
    const w = img.naturalWidth * scale
    const h = img.naturalHeight * scale
    const left = r.left + (r.width - w) / 2
    const top = r.top + (r.height - h) / 2
    return ev.clientX >= left && ev.clientX <= left + w && ev.clientY >= top && ev.clientY <= top + h
  }

  // A comic (much taller than wide) goes full width and scrolls, vertical drags
  // scrolling it; anything else fits whole in the screen. Measured from the
  // file's own shape, and again when the screen turns: the old test (taller
  // than the screen at full width) cut the top and bottom off an ordinary
  // portrait image once the screen was in landscape.
  const COMIC_RATIO = 2.2   // height / width

  function fitImage() {
    const img = modal.image
    if (img.hidden || !img.naturalWidth) return
    const ratio = img.naturalHeight / img.naturalWidth
    const stage = modal.stage
    const tall = ratio > COMIC_RATIO && stage.clientWidth * ratio > stage.clientHeight
    stage.classList.toggle('tall', tall)
    applyZoom()   // sets touch-action for the tall/short and zoom state
  }

  // The modal's GIF can break the same way; the page is already unloaded, so
  // just decode it again, twice at most.
  function watchModalGif(img, url, seq) {
    let tries = 0
    const check = ev => {
      if (modal.seq !== seq) { img.removeEventListener('error', check); img.removeEventListener('load', check); return }
      if (ev.type !== 'error' && img.naturalWidth > 0) return
      if (tries >= GIF_RETRIES) { warn('modal: gif still broken after rebuilding'); return }
      tries++
      info(`modal: gif broken, rebuilding (try ${tries})`)
      img.removeAttribute('src')
      setTimeout(() => { if (modal.seq === seq) img.src = url }, 400)
    }
    img.addEventListener('error', check)
    img.addEventListener('load', check)
  }

  // Some videos carry no video tag and no .webm-thumb, so they look like images.
  // While the image shows, check quietly whether the post has an .mp4; if it
  // does, turn the modal into the video. No delay on the tap itself.
  function sniffVideo(src, link) {
    const seq = modal.seq
    const hash = (thumbParts(src) || {}).hash
    const known = cacheGet('video', hash)
    if (known === null) return   // checked before: not a video
    if (typeof known === 'string') {
      info(`modal: post ${postId(link)} is an untagged video (cached)`)
      showVideo(fileCandidates(src, ['mp4', 'webm']), hash)
      return
    }
    const urls = fileCandidates(src, ['mp4']).slice(0, 2)
    if (!urls.length) return
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'metadata'
    let i = 0
    const done = () => { v.onerror = v.onloadedmetadata = null; v.removeAttribute('src'); v.load() }
    v.onerror = () => {
      const network = v.error && v.error.code === 2
      if (i < urls.length) { v.src = urls[i++]; return }
      done()
      if (!network) cacheSet('video', hash, null)
    }
    v.onloadedmetadata = () => {
      cacheSet('video', hash, urls[i - 1])
      done()
      if (modal.seq !== seq || !modal.open) return
      info(`modal: post ${postId(link)} is an untagged video`)
      showVideo(fileCandidates(src, ['mp4', 'webm']), hash)
    }
    v.src = urls[i++]
  }

  const postId = link => (link.href.match(/id=(\d+)/) || [])[1] || '?'

  // Only the "animated" tag, nothing else to go by: no gif, no video/mp4/webm,
  // no .webm-thumb mark from the site. Those may be either kind.
  function ambiguousAnimated(link) {
    if (link.querySelector('img.webm-thumb')) return false
    const tags = nativeTags(link)
    return /\sanimated\s/i.test(tags) && !NATIVE_REAL_VIDEO.test(tags) && !NATIVE_GIF.test(tags)
  }

  // Load the video and probe the .gif at the same time; whichever answers
  // first wins and the other is cancelled. A post has a single file, so a
  // .gif that loads means it is a GIF. Waiting for every video host to say
  // "missing" first cost about 3 s per GIF.
  function raceVideoAndGif(link, thumb, pic, hash, asGif) {
    const seq = modal.seq
    let settled = false
    const probe = new Image()
    const gifs = cachedFirst(fileCandidates(pic.src, ['gif']), cacheGet('gif', hash))
    let i = 0
    const stopProbe = () => { probe.onload = probe.onerror = null; probe.removeAttribute('src') }
    probe.onerror = () => { if (!settled && i < gifs.length) probe.src = gifs[i++] }
    probe.onload = () => {
      if (settled || modal.seq !== seq) return
      settled = true
      cacheSet('gif', hash, probe.src)
      cacheSet('video', hash, null)
      const v = modal.video
      v.onerror = v.oncanplay = v.onloadedmetadata = null
      v.pause()
      v.removeAttribute('src')
      v.load()   // cancel the video download and free the decoder
      link.dataset.ibhKind = 'gif'
      info(`modal: post ${postId(link)} is a GIF (answered before the video)`)
      showImage(thumb.currentSrc || pic.src, [probe.src], 'gif', hash)
      stopProbe()
    }
    showVideo(fileCandidates(pic.src, ['mp4', 'webm']), hash,
      () => { if (!settled) { settled = true; stopProbe(); asGif() } },
      () => { if (!settled) { settled = true; stopProbe() } })
    if (gifs.length) probe.src = gifs[i++]
  }

  function openModal(link) {
    const thumb = link.querySelector('img')
    const pic = thumb && cardPicture(link)
    if (!pic || !thumbParts(pic.src)) { location.href = link.href; return }   // nothing derivable: go to the post
    if (!modal) buildModal()
    resetMedia()
    const seq = modal.seq
    if (!modal.open) modal.dir = 1
    // The preloaded file, already decoded, shows at once instead of the thumbnail.
    const ready = aheadReady(link)

    modal.link = link
    modal.post.href = link.href
    modal.box.classList.remove('later-mode')
    applyMarks(link, seq)
    if (!modal.sheet.hidden) renderSheet(link, seq)   // the menu follows the post
    modal.score.textContent = ''
    const list = modalLinks()
    modal.count.textContent = `${list.indexOf(link) + 1} / ${list.length}`
    modal.status.textContent = t('mLoading')
    modal.status.hidden = false

    let kind = thumbKind(thumb)
    const hash = thumbParts(pic.src).hash
    const placeholder = ready || thumb.currentSrc || pic.src
    const asGif = () => {
      link.dataset.ibhKind = 'gif'   // the page's cover/GIF code agrees from now on
      info(`modal: post ${postId(link)} has no video file, showing it as a GIF`)
      showImage(placeholder, fileCandidates(pic.src, ['gif']), 'gif', hash)
    }
    // Known from an earlier try: no video file for it.
    if (kind === 'video' && cacheGet('video', hash) === null) kind = 'gif'
    if (kind === 'video' && ambiguousAnimated(link)) {
      raceVideoAndGif(link, thumb, pic, hash, asGif)
    } else if (kind === 'video') {
      showVideo(fileCandidates(pic.src, ['mp4', 'webm']), hash, asGif)
    } else if (kind === 'gif') {
      showImage(placeholder, fileCandidates(pic.src, ['gif']), 'gif', hash)
    } else {
      // The sample first (a few hundred KB, sharp at screen size), or the
      // original straight away; a post without a sample gets its original.
      if (CFG.modalOriginal === 'always') showImage(placeholder, fileCandidates(pic.src, ORIGINAL_EXTS), 'orig', hash)
      else showImage(placeholder, [sampleCandidates(pic.src), fileCandidates(pic.src, ORIGINAL_EXTS)], 'sample', hash)
      sniffVideo(pic.src, link)
    }
    refreshLaterButton(link, seq)
    refreshDlButton()
    // Only now: the preloaded image stays referenced until the modal shows it.
    dropAhead()
    // A post that never finishes loading must not hold the next one back.
    setTimeout(() => preloadAhead(seq), AHEAD_FALLBACK_MS)

    openShell()
    info(`modal: ${kind} post ${postId(link)}`)
  }

  // Shows the modal over the page (a post, or the Watch later list).
  function openShell() {
    if (modal.open) return
    modal.open = true
    suspendPage()
    if (!modal.host.isConnected) document.documentElement.appendChild(modal.host)
    modal.host.style.display = ''
    document.documentElement.style.setProperty('overflow', 'hidden', 'important')
    // An entry for the back button to close the modal instead of the page.
    // Leaving it, the browser would put back the scroll it saved for the
    // page, undoing the scroll that followed the modal: we place it ourselves.
    modal.scrollMode = history.scrollRestoration
    history.scrollRestoration = 'manual'
    history.pushState({ ibhModal: true }, '')
  }

  // The posts the modal steps through: the page's, or the Watch later list's.
  const modalLinks = () => (modal && modal.listLinks) || siteLinks()

  function closeModal(fromBack) {
    if (!modal || !modal.open) return
    if (modal.root.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {})
    modal.open = false
    modal.turned = null   // its fullscreenchange comes after open is false
    modal.turn.classList.remove('on')
    closeMenu()
    modal.listLinks = null
    modal.box.classList.remove('later-mode')
    if (modal.laterIO) { modal.laterIO.disconnect(); modal.laterIO = null }
    modal.laterGrid.replaceChildren()   // its decoded pictures go with it
    dropAhead()
    resetMedia()
    modal.host.style.display = 'none'
    document.documentElement.style.removeProperty('overflow')
    // Leave the page on the post last shown, once the history step is over
    // (the back runs after this function), then bring back what is on screen.
    const link = modal.link
    let landed = false
    const land = () => {
      if (landed) return
      landed = true
      if (link && link.isConnected) link.scrollIntoView({ block: 'center' })
      history.scrollRestoration = modal.scrollMode || 'auto'
      resumePage()
    }
    if (!fromBack && history.state && history.state.ibhModal) {
      window.addEventListener('popstate', () => setTimeout(land, 0), { once: true })
      setTimeout(land, 1000)   // should the popstate never come, the page still comes back
      history.back()
    } else {
      setTimeout(land, 0)
    }
  }

  // While the modal is open the page underneath is invisible, so it gives its
  // memory to the modal: covers closed, GIFs stilled, upgraded images back to
  // the thumbnail (heights held so the layout does not move), pending
  // upgrades dropped. resumePage() brings back what is on screen on close.
  const suspended = []

  function suspendPage() {
    const n = { covers: 0, gifs: 0, images: 0 }
    coverQueue.clear()   // first, or each unmount hands its slot to a queued card
    document.querySelectorAll('[data-ibh-cover]').forEach(card => { unmountCover(card); n.covers++ })
    document.querySelectorAll('[data-ibh-gif="playing"]').forEach(card => { stopGif(card); n.gifs++ })
    originalQueue.length = 0
    document.querySelectorAll('[data-ibh-orig]').forEach(el => {
      const state = el.dataset.ibhOrig
      if (state === 'failed') return
      if (state === 'done') { pinHeight(el); resetUpgrade(el); n.images++ }
      else delete el.dataset.ibhOrig   // queued: start over later
      if (farViewport) farViewport.unobserve(el)
      if (originalViewport) originalViewport.unobserve(el)   // or it would upgrade again under the modal
      suspended.push(el)
    })
    dbg(`modal: page unloaded (${n.covers} covers, ${n.gifs} GIFs, ${n.images} images)`)
  }

  function resumePage() {
    // observe() reports what is already on screen at once, so that upgrades now.
    for (const el of suspended.splice(0)) if (el.isConnected && originalViewport) originalViewport.observe(el)
    document.querySelectorAll('[data-ibh-seen]').forEach(card => {
      if (CFG.videoCovers && isVideoCard(card)) mountCover(card)
      else if (CFG.gifInline && isGifCard(card)) playGif(card)
    })
  }

  function stepModal(dir) {
    const list = modalLinks()
    const target = list[list.indexOf(modal.link) + dir]
    if (!target) return
    if (!modal.listLinks && dir > 0 && list.indexOf(target) >= list.length - 3) favPagerNext()   // see the autopager
    modal.dir = dir   // the preload follows the direction of travel
    openModal(target)
    // The page follows underneath, so far down the list it is already there
    // on close, with the site's paginator in reach. Nothing loads meanwhile:
    // the observers hold off while the modal is open.
    target.scrollIntoView({ block: 'center' })
  }

  // ── Next post ready ──
  // Once the post on screen has loaded, fetch the next one in the direction
  // of travel: an image or GIF downloaded and decoded (held, so the swipe
  // paints it at once), a video's host found and its header read (the swipe
  // then skips the host walk; the decoder is handed back right away). One
  // post ahead only, dropped as soon as the modal moves on or closes.
  const AHEAD_FALLBACK_MS = 4000
  let ahead = null

  function preloadAhead(seq) {
    if (!CFG.modalPreload || !modal.open || modal.seq !== seq) return
    const list = modalLinks()
    const link = list[list.indexOf(modal.link) + (modal.dir || 1)]
    if (!link || (ahead && ahead.link === link)) return
    dropAhead()
    const thumb = link.querySelector('img')
    const pic = thumb && cardPicture(link)
    const parts = pic && thumbParts(pic.src)
    if (!parts) return
    const a = ahead = { link }
    if (!onOwnFavorites()) lookUpFavorite(postId(link))   // its heart is right on the swipe
    let kind = thumbKind(thumb)
    if (kind === 'video' && cacheGet('video', parts.hash) === null) kind = 'gif'
    if (kind === 'video') aheadVideo(a, pic.src, parts.hash)
    else aheadImage(a, pic.src, parts.hash, kind === 'gif' ? 'gif' : 'orig')
    dbg(`modal: preloading ${kind} post ${postId(link)}`)
  }

  function aheadImage(a, src, hash, kind) {
    const sampleFirst = kind === 'orig' && CFG.modalOriginal !== 'always'
    if (sampleFirst) kind = 'sample'
    const cached = kind === 'orig' ? knownOriginal(hash) : cacheGet(kind, hash)
    if (cached === null) return   // known: nothing loads
    const stages = kind === 'gif' ? [fileCandidates(src, ['gif'])]
      : sampleFirst ? [sampleCandidates(src), fileCandidates(src, ORIGINAL_EXTS)] : [fileCandidates(src, ORIGINAL_EXTS)]
    // Same three download slots as the page (B).
    takeImageSlot(() => {
      if (ahead !== a) { giveImageSlot(); return }   // the modal moved on while it waited
      let held = true
      a.release = () => { if (held) { held = false; giveImageSlot() } }
      a.cancel = raceImage(stages, cached, img => {
        a.release()
        a.img = img
        cacheSet(kind, hash, img.src, cached)
        const decoded = typeof img.decode === 'function' ? img.decode().catch(() => {}) : Promise.resolve()
        decoded.then(() => { if (ahead === a) a.decoded = true })
      }, () => {
        a.release()
        cacheSet(kind, hash, null)
      })
    })
  }

  function aheadVideo(a, src, hash) {
    const cached = cacheGet('video', hash)
    const urls = cachedFirst(fileCandidates(src, ['mp4', 'webm']), cached)
    if (!urls.length) return
    const v = a.video = document.createElement('video')
    v.muted = true
    v.preload = 'metadata'
    let i = 0
    const stop = () => { v.onerror = v.onloadedmetadata = null; v.removeAttribute('src'); v.load() }
    v.onerror = () => {
      if (i < urls.length) { v.src = urls[i++]; return }
      // No host has it: the swipe goes straight to the GIF. A decode error or a
      // network drop says nothing about the file.
      if (!(v.error && (v.error.code === 3 || v.error.code === 2))) cacheSet('video', hash, null)
      stop()
    }
    v.onloadedmetadata = () => { cacheSet('video', hash, urls[i - 1], cached); stop() }
    v.src = urls[i++]
  }

  // The preloaded image for this post, if it is downloaded and decoded.
  function aheadReady(link) {
    return ahead && ahead.link === link && ahead.decoded && ahead.img.naturalWidth ? ahead.img.src : null
  }

  function dropAhead() {
    if (!ahead) return
    const a = ahead
    ahead = null
    if (a.cancel) a.cancel()
    if (a.img) { a.img.onload = a.img.onerror = null; a.img.removeAttribute('src') }
    if (a.video) { a.video.onerror = a.video.onloadedmetadata = null; a.video.removeAttribute('src'); a.video.load() }
    if (a.release) a.release()
  }

  // Capture on window: runs before the link's own onclick (favorites navigate
  // from an inline handler) and survives Masonry replacing the body.
  function onSiteLinkClick(ev) {
    if (ev.defaultPrevented || ev.button !== 0) return
    const link = ev.target.closest && ev.target.closest(SITE_LINK)
    if (!link) return
    ev.preventDefault()
    ev.stopPropagation()
    openModal(link)
  }

  function installVideoModal() {
    if (!CFG.videoModal) return
    window.addEventListener('click', onSiteLinkClick, true)
    window.addEventListener('click', onSiteVoteClick, true)
    // The screen turned (↻, a wide video, the phone itself): fit the image again.
    window.addEventListener('resize', () => { if (modal && modal.open) { resetZoom(); fitImage() } })
    window.addEventListener('popstate', () => { if (modal && modal.open) closeModal(true) })
    document.addEventListener('fullscreenchange', onFullscreenChange)
    if (screen.orientation) screen.orientation.addEventListener('change', onOrientationChange)
    info('post modal active: thumbnails on site pages open in place')
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
      dbg('rule34: no API credential in Masonry, keeping the scraper (it keeps the account filters itself)')
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
      installAccountFilters()
      info('rule34 API path unlocked; account filters applied by the script')
    } catch (e) {
      error(`could not unlock the rule34 API path — ${describeError(e)}`)
    }
  }

  // The API answers without the session cookie, so the account's own filters
  // would be lost. The site keeps them in cookies the page can read:
  // tag_blacklist, post_threshold and filter_ai. Masonry's booru client calls
  // the API with the page's fetch (it runs in page mode), so the answer is
  // filtered here before it parses it: what the site would hide stays hidden.
  const AI_TAGS = ['ai_generated', 'ai_assisted']

  function readCookie(name) {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
    return m ? m[1] : null
  }

  function accountFilters() {
    let raw = readCookie('tag_blacklist') || ''
    // Stored encoded twice (spaces come back as %20 after one pass).
    for (let i = 0; i < 2; i++) { try { raw = decodeURIComponent(raw) } catch (e) { break } }
    const words = raw.split(/\s+/).filter(Boolean)
    const tags = new Set(words.filter(w => !w.includes(':')))
    const ratings = new Set(words.filter(w => w.startsWith('rating:')).map(w => w.slice(7, 8)))   // e, q, s
    if (readCookie('filter_ai') === '1') AI_TAGS.forEach(tag => tags.add(tag))
    return { tags, ratings, threshold: Number(readCookie('post_threshold')) || 0 }
  }

  function accountHides(post, f) {
    if (f.threshold && Number(post.score) < f.threshold) return true
    if (f.ratings.size && post.rating && f.ratings.has(String(post.rating)[0])) return true
    return String(post.tags || '').split(/\s+/).some(tag => f.tags.has(tag))
  }

  function installAccountFilters() {
    const pageFetch = window.fetch
    window.fetch = async function (input, init) {
      const res = await pageFetch.apply(this, arguments)
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (!/\/\/api\.rule34\.xxx\/index\.php\?.*s=post&q=index/.test(url) || !/json=1/.test(url)) return res
      try {
        const posts = await res.clone().json()
        if (!Array.isArray(posts)) return res
        const f = accountFilters()
        const kept = posts.filter(post => !accountHides(post, f))
        if (kept.length === posts.length) return res
        info(`rule34 API: account filters hid ${posts.length - kept.length} of ${posts.length} posts`)
        return new Response(JSON.stringify(kept), { status: res.status, statusText: res.statusText, headers: res.headers })
      } catch (e) {
        return res   // not the JSON we expected: hand it over untouched
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // On-demand diagnostics
  // ═══════════════════════════════════════════════════════════

  /** Test every candidate URL of the first video card and log the outcome. */
  function probeVideoUrls() {
    // Prefer a card that is on screen, so the result matches what you see.
    const cards = [...document.querySelectorAll('.posts-image-card')].filter(isVideoCard)
    const card = cards.find(c => c.dataset.ibhSeen) || cards[0]
    if (!card) { warn('no video card on screen to test'); return }
    const pic = cardPicture(card)
    if (!pic) { warn('video card has no picture yet'); return }

    const urls = fileCandidates(pic.src, ['mp4', 'webm'])
    info(`thumbnail: ${pic.src}`)
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

  /** Put an upgraded element back to its thumbnail and clear its upgrade state. */
  function resetUpgrade(el) {
    if (el.dataset.ibhOrig === 'done' && el.dataset.ibhThumb) {
      const pic = pictureOf(el)
      if (pic) pic.set(el.dataset.ibhThumb)
    }
    delete el.dataset.ibhOrig
    delete el.dataset.ibhThumb
  }

  // Other tabs of the same site running the script hear the Free memory
  // button through this channel. Without any @grant there is no storage shared
  // between sites, so tabs of another site are out of reach; a hidden tab
  // parks its covers and GIFs by itself (see G).
  const tabChannel = 'BroadcastChannel' in window ? new BroadcastChannel('ibh') : null
  if (tabChannel) {
    tabChannel.onmessage = ev => {
      const msg = ev.data || {}
      if (msg.type === 'free-memory') {
        freeMemory(true).then(n => tabChannel.postMessage({ type: 'freed', n, page: location.pathname }))
      } else if (msg.type === 'freed') {
        const { n } = msg
        info(`another tab (${msg.page}) freed ${n.covers} covers, ${n.gifs} GIFs, ${n.images} upgraded images`)
      }
    }
  }

  /**
   * Give back the memory this script holds on the page and drop its caches.
   * The browser's HTTP cache is out of reach for any page script; settings
   * (IBH_CFG), Masonry's settings and the site login are left alone.
   */
  async function freeMemory(fromOtherTab = false) {
    // The button frees every tab of this site running the script, not only this one.
    if (!fromOtherTab && tabChannel) tabChannel.postMessage({ type: 'free-memory' })
    const n = { covers: 0, gifs: 0, images: 0, caches: 0 }
    // A preview in progress holds one or two videos; the shared one is dropped.
    if (scrub) endScrub()
    previewStop()
    previewEl = null
    dropAhead()
    favLookups.clear()
    postInfos.clear()
    coverQueue.clear()   // first, or each unmount hands its slot to a queued card
    document.querySelectorAll('[data-ibh-cover]').forEach(card => { unmountCover(card); n.covers++ })
    // Animated GIFs keep every decoded frame; back to the still. Ones still
    // loading are dropped too.
    document.querySelectorAll('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach(card => { stopGif(card); n.gifs++ })
    // Undo sample/original upgrades, queued and in flight included, and watch
    // again: what is on screen comes back from the HTTP cache, the rest only
    // when it scrolls in.
    upgradeGen++
    originalQueue.length = 0
    document.querySelectorAll('[data-ibh-orig]').forEach(el => {
      if (el.dataset.ibhOrig === 'failed') return
      if (el.dataset.ibhOrig === 'done') n.images++
      resetUpgrade(el)
      if (farViewport) farViewport.unobserve(el)
      if (originalViewport) originalViewport.observe(el)
    })
    // Lists that would keep removed cards alive (parked ones still on the
    // page stay, so a hidden tab gets its covers back on return).
    parked.splice(0, parked.length, ...parked.filter(c => c.isConnected))
    previewPaused.splice(0, previewPaused.length, ...previewPaused.filter(c => c.isConnected))
    knownGifs.clear()
    if (!(modal && modal.open)) suspended.length = 0
    try { localStorage.removeItem(HOST_KEY) } catch (e) { /* ignore */ }
    const urls = clearUrlCache(false)
    STATE.imageBase = null
    try {
      if (window.caches) {
        const keys = await caches.keys()
        await Promise.all(keys.map(k => caches.delete(k)))
        n.caches = keys.length
      }
    } catch (e) {
      warn(`could not clear Cache Storage — ${describeError(e)}`)
    }
    imageBase()
    info(`freed ${n.covers} covers, ${n.gifs} GIFs, ${n.images} upgraded images${fromOtherTab ? ' (asked by another tab)' : ''}; host cache, ` +
      `${urls} cached URLs and ${n.caches} Cache Storage entries cleared (browser HTTP cache untouched)`)
    touch()
    return n
  }

  /**
   * Start every thumbnail over, failures included: upgrades go back to the
   * thumbnail and are queued again, covers and GIFs are dropped, and whatever
   * is on screen is processed again right away.
   */
  function redoThumbs() {
    const n = { images: 0, covers: 0, gifs: 0 }
    const misses = clearUrlCache(true)   // the point is retrying what failed
    document.querySelectorAll('[data-ibh-orig]').forEach(el => {
      resetUpgrade(el)
      // observe() reports elements already on screen at once, so they upgrade now.
      if (originalViewport) originalViewport.observe(el)
      else upgradeToOriginal(el)
      n.images++
    })
    document.querySelectorAll('[data-ibh-cover]').forEach(card => unmountCover(card))
    coverQueue.clear()
    document.querySelectorAll('[data-ibh-gif]').forEach(card => { stopGif(card); delete card.dataset.ibhGif })
    // Forget which video cards turned out to be GIFs, so they get a fresh try.
    knownGifs.clear()
    document.querySelectorAll('[data-ibh-kind]').forEach(card => { delete card.dataset.ibhKind })
    document.querySelectorAll('[data-ibh-seen]').forEach(card => {
      if (CFG.videoCovers && isVideoCard(card)) { mountCover(card); n.covers++ }
      else if (CFG.gifInline && isGifCard(card)) { playGif(card); n.gifs++ }
    })
    // Pick up elements Masonry rebuilt since the last scan.
    scanCards(document)
    scanThumbs(document)
    info(`redo thumbnails: ${n.images} images re-queued, ${n.covers} covers and ${n.gifs} GIFs restarted, ${misses} cached misses dropped`)
    touch()
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

    .feednav {
      position: fixed; right: 12px; bottom: 12px; z-index: 2147483000;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
    }
    .feednav .row { display: flex; gap: 8px; }
    .feednav button {
      width: 44px; height: 44px; border-radius: 50%;
      border: 1px solid #2a3a3f; background: rgba(15, 20, 23, .8); color: #5eead4;
      font-size: 26px; line-height: 1; display: grid; place-items: center;
      padding: 0 0 3px; box-shadow: 0 4px 14px rgba(0,0,0,.5);
    }
    .feednav button:active { background: #16211f; }
    .feednav button.on { background: #5eead4; color: #0f1417; border-color: #5eead4; }
    .feednav button.trash { display: grid; place-items: center; padding: 0; }
    .feednav button.trash svg { width: 20px; height: 20px; fill: currentColor; }
    /* Top right, below the site's own header icons (gear, menu). */
    .laterfab {
      position: fixed; top: 72px; right: 12px; z-index: 2147483000;
      width: 44px; height: 44px; border-radius: 50%; padding: 0; display: grid; place-items: center;
      border: 1px solid #2a3a3f; background: rgba(15, 20, 23, .8); color: #5eead4;
      box-shadow: 0 4px 14px rgba(0,0,0,.5);
    }
    .laterfab:active { background: #16211f; }
    .laterfab svg { width: 22px; height: 22px; fill: currentColor; }
    .laterfab.bulkfab { right: 64px; }
    .laterfab.on { background: #5eead4; color: #0f1417; border-color: #5eead4; }
    .pagetoast {
      position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%); z-index: 2147483000; max-width: 86vw;
      padding: 8px 14px; border-radius: 18px; background: rgba(15, 20, 23, .92); color: #d7dee0;
      font-size: 13px; text-align: center; pointer-events: none; transition: opacity .2s;
    }
    .panel:not([hidden]) ~ .laterfab, .panel:not([hidden]) ~ .bulkfab { display: none; }
    .feednav button:disabled { opacity: .35; }
    .feednav.raised { bottom: 76px; }

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
    label.tog input { accent-color: #5eead4; width: 16px; height: 16px; }
    label.tog .note { margin-left: auto; color: #4e6469; font-size: 10px; }

    .lang { padding: 4px 12px 8px; }
    .lang .lbl { color: #4e6469; font-size: 11px; padding-bottom: 4px; }
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
    .log .ts + span { min-width: 0; overflow-wrap: anywhere; }   /* long URLs wrap */
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
    // Children are nodes or plain strings (as text).
    if (children) children.forEach(c => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c))
    return node
  }

  const statusRow = (key, value, tone) => el('div', { class: 'row' }, [
    el('span', { class: `dot ${tone}` }),
    el('span', { class: 'k', text: key }),
    el('span', { class: 'v', text: String(value) }),
  ])

  let renderingStatus = false   // guard: anything below that calls touch() must not re-enter

  function renderStatus() {
    if (!statusBox || renderingStatus) return
    renderingStatus = true
    try { drawStatus() } finally { renderingStatus = false }
  }

  function drawStatus() {
    readMasonryState(false)
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

  // `then` runs after the change, for options that apply at once.
  function toggle(key, label, note, then) {
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
  function choiceSelect(key, title, choices, then) {
    const sel = el('select')
    for (const [value, label] of choices) {
      const option = el('option', { value: String(value), text: label })
      if (String(CFG[key]) === String(value)) option.setAttribute('selected', '')
      sel.appendChild(option)
    }
    sel.addEventListener('change', () => {
      const picked = choices.find(([value]) => String(value) === sel.value)
      setCfg(key, picked[0])   // keeps numbers as numbers
      if (then) then()
    })
    return el('div', { class: 'lang' }, [el('div', { class: 'lbl', text: title }), sel])
  }

  // Gesture for the scene preview on thumbnails; the slideshow's jump and
  // seconds only show in hold mode, so switching modes redraws the panel.
  function scrubModeControls(body) {
    body.appendChild(choiceSelect('scrubMode', t('tScrubMode'),
      [['drag', t('modeDrag')], ['hold', t('modeHold')]], rebuildPanel))
    if (CFG.scrubMode !== 'hold') return
    const num = n => n.toLocaleString(LANG)
    body.appendChild(choiceSelect('slideStep', t('tSlideStep'),
      [5, 10, 20, 25].map(p => [p, `${num(p)}% · ${Math.round(100 / p)} ${t('scenes')}`])))
    body.appendChild(choiceSelect('slideDwell', t('tSlideDwell'),
      [0.1, 0.2, 0.3, 0.5, 1].map(sec => [sec, `${num(sec)} s`])))
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
    body.appendChild(toggle('freeButton', t('tFreeBtn'), null, ensureFeedNav))
    body.appendChild(toggle('laterButton', t('tLaterBtn'), null, ensureFeedNav))
    body.appendChild(toggle('favSearch', t('tFavSearch'), null, ensureFavSearch))
    body.appendChild(toggle('favAutopager', t('tPager'), null, ensureFavPager))
    body.appendChild(toggle('siteSearch', t('tSiteSearch'), null, ensureSiteSearch))
    body.appendChild(toggle('videoModal', t('tModal'), t('noteReload')))
    body.appendChild(toggle('siteTheme', t('tTheme'), null, applySiteTheme))
    body.appendChild(toggle('rotateLandscape', t('tRotate')))
    body.appendChild(toggle('modalPreload', t('tPreload')))
    body.appendChild(choiceSelect('modalOriginal', t('tModalOrig'), [['zoom', t('origZoom')], ['always', t('origAlways')]]))
    body.appendChild(toggle('videoCovers', t('tCovers')))
    body.appendChild(toggle('gifInline', t('tGif')))
    body.appendChild(choiceSelect('gifMaxLive', t('tGifMax'), [1, 2, 3, 4, 6, 10].map(n => [n, String(n)]), applyGifLimit))
    body.appendChild(toggle('videoScrub', t('tScrub'), t('noteReload')))
    scrubModeControls(body)
    body.appendChild(toggle('memorySaver', t('tMemory'), t('noteReload')))
    body.appendChild(toggle('urlCache', t('tUrlCache')))
    body.appendChild(toggle('fixFancybox', t('tFancybox')))
    body.appendChild(toggle('gestures', t('tGestures')))
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
      `host: ${STATE.imageBase} · thumbnails: ${STATE.thumbMode} · ` +
      `columns: ${STATE.columns}\n\n`
    const body = LOG.map(e =>
      `${new Date(e.t).toTimeString().slice(0, 8)} [${e.level}] ${e.msg}`).join('\n')

    navigator.clipboard.writeText(head + body)
      .then(() => info('log copied'))
      .catch(e => error(`could not copy the log — ${describeError(e)}`))
  }

  // A tap anywhere outside the open panel closes it (the ◐ button toggles it itself).
  window.addEventListener('pointerdown', ev => {
    if (!panelOpen || !panelHost) return
    if (ev.composedPath().includes(panelHost)) return
    togglePanel(false)
  }, true)

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
    const nav = wantsFeedButtons() || CFG.freeButton || CFG.laterButton || CFG.bulkFavButton
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
      onLogEntry = appendLogLine
      onStateChange = () => { if (panelOpen) renderStatus() }
      if (panelOpen) renderStatus()
    }
    dbg('panel mounted')
  }

  // The host is often mounted while the page is still parsing, before the
  // post list exists, so the buttons are added whenever the list shows up.
  // Runs on every mutation batch, so it only rebuilds when the set of buttons
  // the page needs has changed (e.g. the post list arrived after the host).
  function ensureFeedNav() {
    if (!shadow) return
    const feed = wantsFeedButtons()
    const free = !!CFG.freeButton
    const want = `${feed ? 'f' : ''}${free ? 'c' : ''}`
    let nav = shadow.querySelector('.feednav')
    if (nav && nav.dataset.set !== want) { nav.remove(); nav = null }
    if (!nav && want) {
      nav = buildFeedNav(feed, free)
      nav.dataset.set = want
      shadow.appendChild(nav)
      dbg(`buttons added: ${feed ? 'feed ' : ''}${free ? 'free' : ''}`.trim())
    }
    // Mass favorite: next to Watch later, top right.
    let heart = shadow.querySelector('.bulkfab')
    if (heart && !wantsBulkButton()) { heart.remove(); heart = null; if (bulkMode) setBulkMode(false) }
    if (!heart && wantsBulkButton()) {
      heart = iconButton('laterfab bulkfab', t('navBulk'), HEART_ICON)
      heart.classList.toggle('on', bulkMode)
      heart.addEventListener('click', () => setBulkMode(!bulkMode))
      shadow.appendChild(heart)
    }
    // Watch later: a button of its own in the top-right corner.
    let clock = shadow.querySelector('.clockfab')
    if (clock && !wantsLaterButton()) { clock.remove(); clock = null }
    if (!clock && wantsLaterButton()) {
      clock = iconButton('laterfab clockfab', t('navLater'), CLOCK_ICON)
      clock.addEventListener('click', () => showLater())
      shadow.appendChild(clock)
    }
    // Masonry's refresh button sits in the same corner; stay above it.
    if (nav) nav.classList.toggle('raised', !!document.querySelector('.v-application'))
    // The paginator comes after the post list in the page, so its state is
    // refreshed as the page fills in rather than fixed when the buttons appear.
    const pp = nav && nav.querySelector('.pp')
    if (pp) {
      pp.disabled = !pageTarget(-1)
      nav.querySelector('.np').disabled = !pageTarget(1)
    }
  }

  const wantsFeedButtons = () => CFG.feedNav && CFG.nativeFeed && !!document.querySelector(FEED_POST)

  // ‹ › buttons for the one-column feed: jump to the start of the previous or
  // next post, e.g. to skip a long comic without scrolling through it.
  const FEED_POST = '.image-list span.thumb'

  function jumpPost(dir) {
    const posts = [...document.querySelectorAll(FEED_POST)]
    if (!posts.length) return
    // By position on screen, not page order: in columns the order runs down
    // each column. Next: the nearest post starting below the top edge.
    // Previous: the nearest starting above it (inside a long post that is its
    // own start, at a post's start it is the one before).
    const tops = posts.map(p => p.getBoundingClientRect().top)
    let target = null
    let best = dir > 0 ? Infinity : -Infinity
    tops.forEach((top, i) => {
      if (dir > 0 ? top > 8 && top < best : top < -8 && top > best) { best = top; target = posts[i] }
    })
    if (!target) return
    // Instant, not smooth: smooth-scrolling past a 7000px comic takes ages.
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY, behavior: 'auto' })
    dbg(`feed: jumped to the ${dir > 0 ? 'next' : 'previous'} post`)
  }

  // The site's own pagination link for the next (dir 1) or previous page.
  // Favorites put the address in an onclick (href is just "#"). Without a
  // usable link, step pid by the number of posts on this page.
  // Of this page, or of a page the autopager fetched (root, at base).
  function pageTarget(dir, root = document, base = location.href) {
    const box = root.querySelector('#paginator, .pagination')
    if (box) {
      const want = dir > 0 ? /^(>|›|next)$/i : /^(<|‹|back|prev(ious)?)$/i
      const a = [...box.querySelectorAll('a')].find(x => want.test(x.textContent.trim()) || want.test(x.getAttribute('alt') || ''))
      if (a) {
        const href = a.getAttribute('href')
        if (href && href !== '#') return new URL(href, base).href
        const m = (a.getAttribute('onclick') || '').match(/location\s*=\s*['"]([^'"]+)['"]/)
        if (m) return new URL(m[1], base).href
      }
      if (box.querySelector('a')) return null   // paginator present but no such link: first or last page
    }
    const url = new URL(base)
    const pid = Number(url.searchParams.get('pid')) || 0
    const per = root.querySelectorAll(FEED_POST).length
    if (!per || (dir < 0 && pid === 0)) return null
    url.searchParams.set('pid', String(Math.max(0, pid + dir * per)))
    return url.href
  }

  function goPage(dir) {
    const target = pageTarget(dir)
    if (!target) return
    info(`feed: ${dir > 0 ? 'next' : 'previous'} page`)
    location.href = target
  }

  // Material Design's "delete" icon (a trash can), as path data.
  const TRASH_ICON = 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z'

  function trashButton() {
    const btn = el('button', { class: 'trash', title: t('navFree') })
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', TRASH_ICON)
    svg.appendChild(path)
    btn.appendChild(svg)
    // Lit while freeing, so the tap shows it was taken.
    btn.addEventListener('click', () => {
      btn.classList.add('on')
      btn.disabled = true
      freeMemory().finally(() => {
        setTimeout(() => { btn.classList.remove('on'); btn.disabled = false }, 400)
        renderStatus()
      })
    })
    return btn
  }

  // Material Design's "watch later" icon (a clock), as path data.
  const CLOCK_ICON = 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm4.2 14.2L11 13V7h1.5v5.2l4.5 2.7-.8 1.3z'

  function iconButton(cls, title, d) {
    const btn = el('button', { class: cls, title })
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
    btn.appendChild(svg)
    return btn
  }

  // The list opens in the post modal, which exists on the site's own pages.
  const wantsLaterButton = () => !!CFG.laterButton && !!CFG.videoModal && !!document.querySelector(SITE_LINK)

  function buildFeedNav(feed, free) {
    const rows = []
    if (feed) {
      const top = el('button', { text: '⤒', title: t('navTop') })
      const prev = el('button', { text: '‹', title: t('navPrev') })
      const next = el('button', { text: '›', title: t('navNext') })
      const bottom = el('button', { text: '⤓', title: t('navBottom') })
      top.addEventListener('click', () => { window.scrollTo({ top: 0, behavior: 'auto' }); dbg('feed: jumped to the top') })
      prev.addEventListener('click', () => jumpPost(-1))
      next.addEventListener('click', () => jumpPost(1))
      bottom.addEventListener('click', () => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' })
        dbg('feed: jumped to the bottom')
      })
      rows.push(el('div', { class: 'row' }, [top, prev, next, bottom]))
    }
    const second = []
    if (free) second.push(trashButton())
    if (feed) {
      const prevPage = el('button', { class: 'pp', text: '«', title: t('navPrevPage') })
      const nextPage = el('button', { class: 'np', text: '»', title: t('navNextPage') })
      prevPage.addEventListener('click', () => goPage(-1))
      nextPage.addEventListener('click', () => goPage(1))
      second.push(prevPage, nextPage)
    }
    if (second.length) rows.push(el('div', { class: 'row' }, second))
    return el('div', { class: 'feednav' }, rows)
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
  // The site injects .thumb { width/max-height: <thumbnail size> !important }
  // from the account's thumbnail setting; max-height has to be lifted too, or
  // a tall image overflows its 250px box and covers the next post.
  // One-column feed on Gelbooru 0.2 site pages: every thumbnail takes the full
  // screen width. Favorites wrap each thumb in an extra span with the Remove
  // link. calc(50% - 50vw) is the negative margin that cancels whatever side
  // padding the site puts around the centred column (5px on rule34).
  // Built from the options and kept in a <style> of its own, so the panel
  // switches apply at once instead of on the next load. One column takes the
  // full screen width; more columns are either masonry (CSS columns, each
  // image whole, order running down each column) or a grid of even square
  // tiles (cropped to fill). Automatic fits as many 170px columns as the
  // screen holds.
  const FEED_COL_MIN = 170

  function feedCss() {
    const cols = CFG.feedColumns
    const auto = cols === 'auto'
    const common = `
      .image-list span.thumb a { display: block !important; position: relative; }
      .image-list > br { display: none !important; }
      /* Post page: the image carries width="850" and the video a fixed box. */
      #image, #gelcomVideoPlayer { max-width: 100% !important; height: auto !important; }`
    if (!auto && Number(cols) <= 1) return `
      .image-list { display: flex !important; flex-direction: column !important;
        flex-wrap: nowrap !important; align-items: stretch !important; gap: 14px !important; }
      .image-list > span { display: block !important; width: 100% !important; max-width: none !important;
        height: auto !important; max-height: none !important; }
      .image-list span.thumb { display: block !important; width: 100vw !important; height: auto !important;
        max-width: none !important; max-height: none !important; min-height: 0 !important;
        margin: 0 calc(50% - 50vw) !important; }
      .image-list span.thumb img { display: block; width: 100% !important; height: auto !important;
        max-width: none !important; max-height: none !important; }` + common
    const item = `
      .image-list > span { display: block !important; width: 100% !important; max-width: none !important;
        height: auto !important; max-height: none !important; margin: 0 !important; }
      .image-list span.thumb { display: block !important; width: 100% !important; height: auto !important;
        max-width: none !important; max-height: none !important; min-height: 0 !important; margin: 0 !important; }`
    if (CFG.feedLayout === 'grid') return `
      .image-list { display: grid !important; gap: 6px !important; grid-template-columns: ${auto
        ? `repeat(auto-fill, minmax(${FEED_COL_MIN}px, 1fr))` : `repeat(${Number(cols)}, minmax(0, 1fr))`} !important; }
      ${item}
      .image-list span.thumb img { display: block; width: 100% !important; height: auto !important;
        aspect-ratio: 1 / 1; object-fit: cover; max-width: none !important; max-height: none !important; }` + common
    return `
      .image-list { display: block !important; column-gap: 6px !important;
        ${auto ? `column-width: ${FEED_COL_MIN}px` : `column-count: ${Number(cols)}`} !important; }
      ${item}
      .image-list > span { break-inside: avoid !important; margin-bottom: 6px !important; }
      .image-list span.thumb img { display: block; width: 100% !important; height: auto !important;
        max-width: none !important; max-height: none !important; }` + common
  }

  let feedCssShown = null

  // Keeps the feed's <style> in step with the options; Masonry rewrites
  // <head>, so it is put back when it goes missing. Unchanged CSS is not
  // rewritten (this runs on every DOM change).
  function applyFeed() {
    const css = CFG.nativeFeed ? feedCss() : ''
    let style = document.querySelector('style[data-ibh-feed]')
    if (style && css === feedCssShown) return
    if (!style) {
      style = el('style', { 'data-ibh-feed': '1' })
      ;(document.head || document.documentElement).appendChild(style)
    }
    style.textContent = css
    feedCssShown = css
  }

  // The panel switch: the layout changes under the reader, so keep the post
  // at the top of the screen in place, and start the sharp images the feed
  // shows (scanThumbs skips what it already watches).
  function switchFeed() {
    const anchor = [...document.querySelectorAll('.image-list span.thumb')]
      .find(el => el.getBoundingClientRect().bottom > 0)
    applyFeed()
    if (anchor) anchor.scrollIntoView({ block: 'start' })
    if (CFG.nativeFeed) scanThumbs(document)
    ensureFeedNav()
    info(`feed ${CFG.nativeFeed ? `on: ${CFG.feedColumns} columns, ${CFG.feedLayout}` : 'off'} (switched from the panel)`)
  }

  // The modal's look on the site's own pages: dark slate background, light
  // text, teal links and controls, tag kinds in the tags menu's colours. All
  // of it hangs on html.ibh-theme, which applySiteTheme() sets only off
  // Masonry (it has its own interface) and only with the option on.
  // Backgrounds go transparent over the dark page (images, videos and icons
  // keep theirs); the thumbnails' blue video frame is left alone.
  const THEME_CSS = `
    html.ibh-theme, html.ibh-theme body { background: #182125 !important; color: #e6eef0 !important; }
    html.ibh-theme body *:not(img):not(video):not(canvas):not(iframe):not(svg):not(path):not([data-ibh-ui]) {
      background-color: transparent !important; border-color: #39ff14 !important; }
    html.ibh-theme body *:not(a):not(img):not(video):not(svg):not(path):not([data-ibh-ui]) { color: #e6eef0 !important; }
    html.ibh-theme a, html.ibh-theme a:visited, html.ibh-theme summary { color: #5eead4 !important; }
    html.ibh-theme a:hover { color: #99f6e4 !important; }
    html.ibh-theme li[class*="tag-type-artist"] a { color: #f2ac08 !important; }
    html.ibh-theme li[class*="tag-type-character"] a { color: #3fb950 !important; }
    html.ibh-theme li[class*="tag-type-copyright"] a { color: #c678dd !important; }
    html.ibh-theme li[class*="tag-type-metadata"] a { color: #e5534b !important; }
    /* Lines in neon green (#39ff14); controls stand on a lighter surface,
       teal text for the ones that act. */
    html.ibh-theme input, html.ibh-theme select, html.ibh-theme textarea, html.ibh-theme button {
      background-color: #26363c !important; color: #e6eef0 !important;
      border: 1px solid #39ff14 !important; border-radius: 8px !important; }
    html.ibh-theme input:focus, html.ibh-theme select:focus, html.ibh-theme textarea:focus {
      border-color: #39ff14 !important; outline: none !important; box-shadow: 0 0 0 2px rgba(57, 255, 20, .35) !important; }
    html.ibh-theme input[type="submit"], html.ibh-theme input[type="button"], html.ibh-theme button {
      background-color: #1d3b38 !important; color: #5eead4 !important; border-color: #39ff14 !important; font-weight: 600; }
    html.ibh-theme ::placeholder { color: #7f9aa0 !important; }
    html.ibh-theme #paginator a, html.ibh-theme #paginator b, html.ibh-theme .pagination a, html.ibh-theme .pagination b {
      display: inline-block; padding: 3px 9px; margin: 2px; border-radius: 8px;
      background-color: #26363c !important; border: 1px solid #39ff14 !important; }
    html.ibh-theme #paginator b, html.ibh-theme .pagination b {
      background-color: #5eead4 !important; color: #0f1417 !important; border-color: #5eead4 !important; }
    html.ibh-theme .awesomplete > ul, html.ibh-theme .awesomplete > ul * { background-color: #26363c !important; }
    html.ibh-theme .awesomplete > ul [aria-selected="true"] { background-color: #1d3b38 !important; }
    html.ibh-theme ::selection { background: #2f7d72; }
    html.ibh-theme hr { border: none !important; border-top: 1px solid #39ff14 !important; }
  `

  let themeOn = null

  function applySiteTheme() {
    const on = !!CFG.siteTheme && !document.querySelector('.v-application')   // not on Masonry
    if (on === themeOn && document.documentElement.classList.contains('ibh-theme') === on) return
    themeOn = on
    document.documentElement.classList.toggle('ibh-theme', on)
    // Masonry swaps the whole <html>: the old one may still carry the class.
    dbg(`site theme ${on ? 'on' : 'off'}`)
  }

  // The site's own video frame, repeated so it also applies on pages whose
  // stylesheet lacks it (favorites), where the mark is added back.
  const NATIVE_MARK_CSS = '.image-list img.webm-thumb { border: 3px solid rgb(0, 0, 255); box-sizing: border-box; }'

  const FAVSEARCH_CSS = `
    .ibh-search { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0 12px; }
    .ibh-search input[type="search"] { flex: 1 1 100%; min-width: 0; padding: 9px 10px; font-size: 15px; box-sizing: border-box; }
    .ibh-search input.min { width: 96px; padding: 7px 8px; font-size: 14px; box-sizing: border-box; }
    .ibh-search select, .ibh-search button { padding: 7px 12px; font-size: 14px; }
    .ibh-search .st { flex: 1 1 100%; font-size: 12px; opacity: .85; }
    .ibh-search select.saved { flex: 1 1 100%; }
    .ibh-search select.saved[hidden] { display: none; }
    #ibh-favmore { display: block; margin: 14px auto; padding: 9px 18px; font-size: 14px; }
    #ibh-favmore[hidden] { display: none; }
    #ibh-pager { min-height: 1px; padding: 14px 0; text-align: center; font-size: 13px; opacity: .85; }
    .ibh-bulkbadge { position: absolute; top: 6px; right: 6px; z-index: 3; min-width: 26px; height: 26px; padding: 0 6px;
      border-radius: 13px; color: #fff; font: 600 15px/26px system-ui, sans-serif; text-align: center; pointer-events: none;
      box-shadow: 0 2px 8px rgba(0,0,0,.5); }
  `

  function injectPageCSS() {
    if (document.querySelector('style[data-ibh]')) return
    const style = el('style', { 'data-ibh': '1' })
    style.textContent = '.img_detail_cont { touch-action: pan-y; }' + NATIVE_MARK_CSS + THEME_CSS + FAVSEARCH_CSS +
      (CFG.videoScrub ? SCRUB_CSS : '')
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
        scanThumbs(node)
      }
      if (CFG.memorySaver && r.removedNodes.length) onNodesRemoved(r.removedNodes)
    }
    if (panelHost && !panelHost.isConnected) { panelHost = null; shadow = null }
    if (!panelHost) mountPanel()
    ensureFeedNav()
    injectPageCSS()
    applySiteTheme()
    applyFeed()
    ensureFavSearch()
    ensureFavPager()
    ensureSiteSearch()
  }).observe(document, { childList: true, subtree: true })

  applySharpThumbs()
  applyRule34ApiUnlock()
  hookFancybox()
  installGestures()
  installMemorySaver()
  window.addEventListener('click', onBulkClick, true)   // before the modal: in mass favorite a tap favorites
  installVideoScrub()   // before the modal: its click guard must run first
  installVideoModal()
  logSnapshot()
  if (CFG.originalThumbs) info('original thumbnails on: visible thumbnails load the full file')
  if (CFG.nativeFeed) info(`feed on: ${CFG.feedColumns} columns, ${CFG.feedLayout}; site pages show samples`)

  setTimeout(restoreCfg, 2000)   // after the storage bridge has loaded

  const boot = () => {
    injectPageCSS()
    mountPanel()
    ensureFeedNav()
    scanCards(document)
    scanThumbs(document)
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
    free: freeMemory,
    urlCache: () => ({ ...urlStats, entries: Object.keys(loadUrlCache()).length }),
    clearUrlCache,
    redo: redoThumbs,
    set: setCfg,
  }
})()
