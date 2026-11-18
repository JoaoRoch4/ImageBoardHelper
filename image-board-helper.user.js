// ==UserScript==
// @name         Image Board Helper
// @namespace    joao.imageboardhelper
// @version      2.1.1
// @description  For the phone, on Gelbooru boards (rule34.xxx, gelbooru.com and others): an in-page post viewer, sharp feed with columns, real video covers and scene previews, inline GIFs, favorites search, autopager, Watch later, downloads, and memory care
// @author       João
// @icon         https://raw.githubusercontent.com/JoaoRoch4/ImageBoardHelper/105fa38fc20327b5a6b067538c0cc880d2cdf196/src/logo.png
// @homepageURL  https://github.com/JoaoRoch4/ImageBoardHelper
// @supportURL   https://github.com/JoaoRoch4/ImageBoardHelper/issues
// @downloadURL  https://raw.githubusercontent.com/JoaoRoch4/ImageBoardHelper/main/image-board-helper.user.js
// @license      MIT
// @match        https://rule34.xxx/*
// @match        https://safebooru.org/*
// @match        https://xbooru.com/*
// @match        https://gelbooru.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        GM_getResourceURL
// @resource     h264dec https://raw.githubusercontent.com/JoaoRoch4/ImageBoardHelper/c1c4cc5cf7fbc409bd4db502dd5e186d76ac9fb4/wasm/h264dec.wasm
// @connect      *
// @inject-into  page
// @noframes
// ==/UserScript==

// Generated from src/ by `npm run build` (tools/build.mts): edit src/, not
// this file. Each module is here as written, its comments included, with the
// TypeScript types erased.

/*
 * Image Board Helper: a standalone layer over the pages of Gelbooru 0.2
 * boards (rule34.xxx, safebooru, xbooru), aimed at phones.
 * It works on the site's own markup (.image-list > span.thumb > a > img, or
 * gelbooru.com's .thumbnail-container > article.thumbnail-preview) and
 * calls only the site's own endpoints.
 *
 *   A. VIDEO COVERS AND GIFS
 *      A <video muted preload="metadata"> over each video thumbnail shows a
 *      real frame (the browser paints it and nothing is read back, so CORS
 *      never enters the picture, unlike grabbing it through a <canvas>). GIF
 *      thumbnails animate while on screen, a few at a time.
 *
 *   B. FEED AND SHARP THUMBNAILS
 *      An optional feed (columns, masonry or grid) where thumbnails become
 *      the sample; the original only where the box needs more pixels.
 *
 *   C. SCENE PREVIEW
 *      Drag across a video thumbnail, or hold it for a slideshow.
 *
 *   D. MEMORY MANAGEMENT
 *      What scrolls far away goes back to the thumbnail; hidden tabs park
 *      their videos; Free memory lets go of everything.
 *
 *   E. POST MODAL AND THE REST
 *      Tapping a thumbnail opens the post in an overlay (video with sound,
 *      GIF, image), with swipes, zoom, favorite and vote, tags, info and
 *      comments, downloads, Watch later, mass favorite, search bars,
 *      favorites search and an autopager.
 *
 * Grants: GM storage keeps the lists and a copy of the settings, and
 * GM_xmlhttpRequest saves files (the image hosts send no CORS headers, so a
 * page script cannot). The one dependency is an @resource: FFmpeg's H.264
 * decoder built to WebAssembly (wasm/, built from source by wasm/build.sh),
 * pinned to a commit and read through GM_getResourceURL. With any grant, this script's window is a wrapper:
 * window.__ibh goes on unsafeWindow. @inject-into page runs it in the page's
 * own context, where it has always been tested on these sites; its calls to
 * the site's endpoints carry the site's login. Nothing of the page's own
 * (fetch, history, navigator) is patched.
 */

(() => {
  "use strict";

  // src/core/site.ts
  const VERSION = '2.1.1'
  const SITE = location.hostname.replace(/^www\./, '')

  // The site's thumbnail list. Gelbooru 0.2 sites (rule34, safebooru, xbooru)
  // put their thumbnails in .image-list > span.thumb; gelbooru.com itself in
  // .thumbnail-container > article.thumbnail-preview. item: the list's own
  // children, a card or what holds one (on the Gelbooru 0.2 favorites, a bare
  // span around span.thumb and its Remove link). The rest is the same:
  // the card's <a> around an <img> with the tags in title or alt, the
  // paginator's a[alt="next"], the file layout. scriptHosts: other hosts the
  // site's own scripts come from, which blockAds lets through (gelbooru's
  // jQuery); adSlots: the site's own ad boxes, hidden with the shared ones;
  // theme: the site's own look among the themes (page/theme.ts), the default
  // one and what the panel and the post viewer wear under "Site's own". suggest: where
  // the site's own search box gets its tag suggestions, the typed word
  // appended (JSON: [{label: "tag (count)", value, type}], or gelbooru's
  // [{value, post_count, category}]).
  const SITE_PROFILES = {
    'gelbooru.com': {
      list: '.thumbnail-container', card: 'article.thumbnail-preview', item: 'article', scriptHosts: ['https://ajax.googleapis.com'],
      // Clickadu's 300x250 spots (in fixed-size wrappers), the footer one, ExoClick's video slider.
      adSlots: ['center:has([id^="__clb-spot_"])', 'div:has(> [id^="__clb-spot_"])', '[id^="__clb-spot_"]', '.footerAd2', '.exo_wrapper', '[id$="-msg-video-slider-content"]'],
      theme: 'gelbooru',   // the site's own blue
      suggest: '/index.php?page=autocomplete2&type=tag_query&limit=10&term=',
    },
    'safebooru.org': { suggest: '/autocomplete.php?q=' },
  }
  const PROFILE = { list: '.image-list', card: 'span.thumb', item: 'span', scriptHosts: [], adSlots: [], theme: 'normal',
    suggest: '/public/autocomplete.php?q=', ...SITE_PROFILES[SITE] }   // suggest: rule34's and xbooru's
  const LIST = PROFILE.list                 // the list of thumbnails
  const CARD = PROFILE.card                 // one thumbnail's wrapper, a child of the list
  const THUMB = `${LIST} ${CARD}`           // a card inside the list
  const ITEM = `${LIST} > ${PROFILE.item}`  // a child of the list: a card, or the span around one

  // src/core/config.ts
  // ═══════════════════════════════════════════════════════════
  // Persisted configuration
  // ═══════════════════════════════════════════════════════════

  const CFG_KEY = 'IBH_CFG'

  const DEFAULTS = {
    lang:           null,   // null = follow the browser language
    debug:          false,  // mirror the log into the browser console
    panel:          true,   // floating button and status panel
    videoCovers:    true,   // overlay the real video frame on the card
    thumbBadges:    true,   // video thumbnails: the duration (bottom right) and ⚠️ past the hardware decoder (top right) (needs reload)
    gifInline:      true,   // animate GIF cards while they are on screen
    gifMaxLive:     3,      // at most this many of them animating at once
    holdGif:        true,   // hold a GIF thumbnail: build it again, the other GIFs paused until it plays
    videoScrub:     true,   // scene preview on video thumbnails (needs reload)
    scrubMode:      'drag', // 'drag': finger position picks the scene; 'hold': hold for a slideshow
    holdVideo:      false,  // hold mode: the video itself plays (1×, Firefox's hardware decoder) instead of the slideshow
    previewSound:   false,  // hold mode: a video that plays (holdVideo, a short clip) plays with sound
    holdResume:     true,   // hold mode: a video that plays goes on where the last hold lifted, for a minute (⏮ on the card starts over)
    holdRub:        true,   // hold, then slide sideways to move the video forward or back: a thumbnail's playing hold (hold mode) and the post's player
    slideStep:      10,     // hold slideshow: jump between scenes, in % of the video
    slideDwell:     0.2,    // hold slideshow: seconds each scene stays once painted
    slideReel:      true,   // hold slideshow from keyframes only (MP4): one small read per scene, no seeking the file
    wasmDecode:     true,   // with slideReel, decode the keyframes in WebAssembly (FFmpeg's H.264) into a canvas
    seekReel:       true,   // modal seek bar: the nearest keyframe at once (WebAssembly), the exact frame when the finger rests
    playRate:       1,      // modal player speed, picked in its ⚙ (0.5 to 2), kept for every video
    seekStep:       5,      // modal player: seconds a double tap on a side jumps, picked in its ⚙
    doubleTapCenter: 'fullscreen', // modal: a double tap in the middle of a post: 'fullscreen' (a common player) or 'like' (Instagram: ♥ favorite + ▲)
    memorySaver:    true,   // release far off-screen images and removed videos (needs reload)
    urlCache:       true,   // remember which candidate URL worked for each file
    feedNav:        true,   // ⤒ ‹ › buttons: top of page, previous and next post in the feed (needs reload)
    holdRaw:        true,   // hold an image on site pages to load its original (raw) file in place
    favsButton:     true,   // 🔖 button next to ♥ and 🕒 on rule34: your favorites page
    bulkFavButton:  true,   // ♥ button next to 🕒 on site pages: a mode where each tapped post is favorited and upvoted
    doubleTapFav:   true,   // double tap a thumbnail on rule34: favorite and upvote it; a single tap opens the post a moment later
    doubleTapLike:  'heart', // that double tap: 'heart' (a ❤️ grows over the thumbnail and vanishes) or 'quiet' (no animation)
    likedBadge:     true,   // rule34: ❤️ in the top right of a favorite's thumbnail (the favorites index and the posts liked here); hold it to unfavorite
    favAutoIndex:   true,   // rule34: favoriting or unfavoriting a post here also adds it to or takes it out of the favorites index
    resBadge:       true,   // the size of the picture on show in the thumbnail's top left (the sample's, or the raw file's after a hold); before it loads, rule34's API with your key, a video's cover, an opened post's page
    freeButton:     true,   // trash-can button next to them: Free memory & cache in one tap
    redoButton:     true,   // ↻ button beside it: free memory, then redo every thumbnail
    eyeButton:      true,   // 👁 button beside ◐: hides the other floating buttons, and brings them back
    buttonsHidden:  false,  // set by the 👁 button (no panel switch): the floating buttons are hidden
    laterButton:    true,   // 🕒 button next to them on site pages: the Watch later list
    favSearch:      true,   // search bar on your own rule34 favorites page, results in the page's own list
    favAutopager:   true,   // search listings and favorites load the next page as you near the bottom
    siteSearch:     true,   // search bar on the site's listing pages: tags, kind, order, minimum score
    searchSuggest:  true,   // tag suggestions from the site while typing in the script's search bars
    videoModal:     true,   // open posts from site pages in an overlay: video, GIF, image (needs reload)
    rotateLandscape: true,  // in the modal player's fullscreen, lock wide videos to landscape
    modalPreload:   true,   // in the modal, have the next post loaded before the swipe
    appBridge:      false,  // ⬇ App and ⚡ 1080p through the app's own server (127.0.0.1:8745, its token) when it answers: the site's fast host, progress here
    playerButton:   true,   // ▶ Media Player, ⬇ App and ⚡ 1080p in a video post's ☰ menu: the video played, downloaded or converted by the user's QtMediaPlayer app
    copyLinkButton: true,   // 🔗 in the post's ☰ menu: copies the link to the post's own file (raw, not the sample)
    modalOriginal:  'zoom', // images in the modal: 'zoom' shows the sample and fetches the original on zoom; 'always'
    theme:          PROFILE.theme, // the site's pages, the panel and the post viewer: 'normal', 'gelbooru', 'oled', 'gray', 'qtmp' (the QtMediaPlayer app's) or 'site' (the site's own pages); the default is the site's: gelbooru on gelbooru.com
    blockAds:       true,   // only the site's own scripts and frames load: no ad networks, no popunders (needs reload)
    originalThumbs: false,  // the original where a thumbnail's box is wider than the sample (a desktop screen; needs reload)
    nativeFeed:     false,  // feed with sharp images on the site's own pages (applies at once)
    feedColumns:    1,      // its columns: 'auto' (by screen width) or 1-4
    feedLayout:     'masonry', // 'masonry': whole images in columns; 'grid': even square tiles
  }

  // The settings as stored: DEFAULTS' own shape, with the keys whose default
  // does not show every value they take.

  // Options that only take effect when the page loads.
  const NEEDS_RELOAD = new Set(['originalThumbs', 'memorySaver', 'feedNav', 'videoModal', 'videoScrub', 'blockAds', 'thumbBadges'])

  // Whether this page found the settings at all: a script that clears the
  // site's localStorage (one did, on its reset) takes them along, and the
  // copy in Violentmonkey's storage brings them back (restoreCfg).
  const CFG_FOUND = (() => { try { return localStorage.getItem(CFG_KEY) !== null } catch (e) { return true } })()
  const CFG = Object.assign({}, DEFAULTS, oldTheme(readJSON(CFG_KEY, {})))

  // Until 2.1.0 the theme was on or off (siteTheme): off is the site's own look now.
  function oldTheme(stored) {
    if (!stored || typeof stored !== 'object') return {}
    if (stored.siteTheme === false && stored.theme === undefined) stored.theme = 'site'
    delete stored.siteTheme
    return stored
  }

  /**
   * Whatever was stored under the key, unchecked (any): the caller knows its shape.
   */
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

  // src/core/strings.ts
  // Imports nothing, so tools/check-i18n.js loads it too.

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
      site: 'site', thumbnail: 'thumbnail',
      host: 'host', covers: 'covers',
      
      failed: 'failed', 
      notResolved: 'not resolved', cached: 'cached',
      coversFmt: (ok, bad, all) => `${ok} ok · ${bad} failed · ${all} videos`,
      tCovers: 'Video covers', tBadges: 'Duration and ⚠️ on video thumbnails', tGif: 'Animated GIFs in the grid', tGifMax: 'GIFs animating at once', tHoldGif: 'Hold a GIF to rebuild it',
      tScrub: 'Scene preview on video thumbnails',
      tScrubMode: 'scene preview gesture', modeDrag: 'Drag sideways', modeHold: 'Hold (slideshow)',
      tSlideStep: 'slideshow jump', tSlideDwell: 'time per scene', scenes: 'scenes', tSlideReel: 'Keyframes only (faster, MP4)', tWasmDecode: 'Decode keyframes in WebAssembly',
      tHoldVideo: 'Hold plays the video (hardware)', tPreviewSound: 'Sound when the hold plays the video', tHoldResume: 'Hold goes on where it stopped (1 min)', tHoldRub: 'Hold, then slide to move the video', resumeRestart: 'Start from the beginning', soundToggle: 'Hold sound: tap to switch', heavyMark: 'Past this phone’s hardware decoder (1080p60)',
      tMemory: 'Release off-screen memory',
      tUrlCache: 'Remember working file URLs',
      tNav: 'Top / previous / next buttons',
      navPrev: 'Previous post', navNext: 'Next post', navTop: 'Top of the page', navBottom: 'Bottom of the page',
      navPrevPage: 'Previous page', navNextPage: 'Next page',
      tHoldRaw: 'Hold an image for its raw file', rawFailed: 'No original file found', rawAlready: 'This image already is the original (the post has no sample)',
      tFavsBtn: 'Your-favorites shortcut button', navFavs: 'Your favorites',
      tBulkBtn: 'Mass-favorite button', navBulk: 'Mass favorite: each tapped post gets ♥ and ▲',
      bulkOn: 'Mass favorite on: tap posts to favorite and upvote them', bulkOff: 'Mass favorite off',
      tCopyBtn: 'Copy-link button in the post menu', copyLink: '🔗 Copy link', linkCopied: 'Link to the raw file copied', copyFailed: 'Could not copy the link',
      tPlayerBtn: 'Media Player buttons (▶ play, ⬇ download, ⚡ convert) in the post menu', appDlBtn: '⬇ App', appReduceBtn: '⚡ 1080p',
      bigVideo: 'Past this phone’s hardware decoder: ☰ → ⚡ 1080p converts it in the app',
      tAppBridge: 'Talk to the app directly (its server)', appToken: 'App token', appOk: 'App connected', appDown: 'App not answering (open it)',
      appBadToken: 'Wrong token', appNoStore: 'Needs Violentmonkey storage', appQueued: 'Downloading in the app',
      appReduceQueued: 'Downloading in the app, to convert', appSaved: 'Saved by the app', appFailed: 'The app’s download failed',
      appConverting: 'Converting in the app', appConverted: 'Converted by the app', appFits: 'Saved: it plays as it is',
      tRedoBtn: 'Redo-thumbnails shortcut button', navRedo: 'Free memory, then redo thumbnails', tDoubleTap: 'Double tap a thumbnail: favorite + upvote', tDoubleTapLike: 'Thumbnail like', likeHeart: 'With the ❤️ animation', likeQuiet: 'Quiet (no animation)',
      tLikedBadge: '❤️ on favorites’ thumbnails (hold it: unfavorite)', heartHint: 'Hold ❤️ to remove it from your favorites', unlikeFail: 'Could not unfavorite',
      tFavAutoIndex: 'Keep the favorites index up to date when liking', tResBadge: 'Resolution on thumbnails', apiKey: 'rule34 API key', apiSec: 'rule34 API (your key)', apiWarn: '⚠️ Paste your API key below to turn these on. rule34 → My Account → Options → API Access Credentials: copy the whole &api_key=…&user_id=… line.', apiPartial: 'once each picture loads',
      apiKeyHint: 'Paste &api_key=…&user_id=… (rule34 → My Account → Options)', apiKeySet: 'Key saved: resolutions from the API', apiKeyNone: 'No key: only videos and opened posts', apiKeyBad: 'Not a key: paste the whole &api_key=…&user_id=… line',
      tEyeBtn: '👁 button: hides the other buttons', eyeHide: 'Hide the buttons', eyeShow: 'Show the buttons',
      tFreeBtn: 'Free-memory shortcut button', navFree: 'Free memory & cache',
      tFavSearch: 'Search your favorites', tSiteSearch: 'Search bar on site pages', tSuggest: 'Tag suggestions while typing',
      savedPick: 'Favorite searches…', recentPick: 'Recent searches…', saveSearch: '☆ Favorite', savedSearch: '★ Favorite', savedAll: '(everything)',
      orPlaceholder: 'OR: tag tag tag · || new group',
      minScore: 'min. score', sitePlaceholder: 'search: tag -tag tag* ( a ~ b )', tPager: 'Autopager (searches and favorites)',
      pagerLoading: 'Loading the next page…', pagerEnd: 'End of the list', pagerFail: 'Could not load the next page — tap to retry',
      favPlaceholder: 'search favorites: tag -tag tag* a ~ b score:>10', favGo: 'Search', favClear: 'Clear',
      favKindAll: 'All types', favKindImage: 'Images', favKindVideo: 'Videos', favKindGif: 'GIFs', favKindAnimated: 'Animated (video or GIF)',
      favSortNew: 'Newest', favSortOld: 'Oldest', favSortScore: 'Score', favSortRandom: 'Random',
      favIndexed: 'favorites indexed', favNever: 'not indexed yet: the first search reads every page', favPartial: 'not all yet: the rest comes in on its own',
      favScanning: 'reading favorites, page', favResults: 'results', favMore: 'Show more',
      favUpdate: 'Update', favRebuild: 'Rebuild index', favScanFail: 'could not read the favorites page',
      tLaterBtn: 'Watch later button', navLater: 'Watch later', laterTitle: 'Watch later',
      dlBtn: '🦊⬇ Download raw', dlWait: 'The file is still loading', dlStart: 'Downloading…', dlBusy: 'Already downloading this post', dlDone: 'Downloaded: confirm in Firefox to save',
      dlFail: 'Download failed', dlOpened: 'Opened in a new tab: hold it to save',
      laterAdd: '🕒 Watch later', laterIn: '✓ In Watch later', laterAdded: 'Saved for later', laterRemoved: 'Removed from the list',
      laterEmpty: 'Nothing saved yet. Use 🕒 in a post’s ☰ menu.', laterOnDevice: 'kept by Violentmonkey, on this device',
      laterOnSite: 'kept in this site’s data (IndexedDB)',
      tModal: 'Open posts in a player over the page',
      tTheme: 'Theme: site pages, this panel and the post viewer', themeNormal: 'Normal (teal and neon)', themeGelbooru: 'Gelbooru (blue)',
      themeOled: 'OLED black', themeGray: 'Grey', themeQtmp: 'QtMediaPlayer (the app)', themeSite: 'The site\'s own pages',
      tSeekReel: 'Seek bar preview from keyframes (WebAssembly)',
      tAds: 'Block ads (only the site\'s own scripts load)',
      mClose: 'Close', mOpen: 'Open the post', mPrev: 'Previous post', mNext: 'Next post',
      mLoading: 'Loading…', mFail: 'Could not load it',
      mFav: 'Add to favorites', mUp: 'Upvote', mFull: 'Fullscreen', mFullExit: 'Exit fullscreen', mMenu: 'Tags and post page',
      tabTags: 'Tags', tabInfo: 'Info', tabComments: 'Comments', commentsMore: 'More comments', commentsNone: 'No comments', commentsHidden: 'hidden by your comment threshold', infoKind: 'Kind', infoRes: 'Resolution', infoFormat: 'Format', infoDuration: 'Duration',
      infoDrops: 'Dropped frames', infoDropsOf: 'of', infoAbove: 'above 1080p: mid-range phones decode it in software', infoLoading: 'loading…',
      kindVideo: 'Video', kindGif: 'GIF', kindImage: 'Image',
      tagOpened: 'Opened in a new tab', tagCopied: 'Copied', tagCopyFail: 'Could not copy', tagsNone: 'No tags', mTurn: 'Rotate the screen',
      mPlay: 'Play / pause', mMute: 'Sound on / off', mFavUp: 'Favorite and upvote', mGear: 'Speed and double tap',
      gearRate: 'Speed', gearStep: 'Double tap jumps', tPlayRate: 'Player speed', tSeekStep: 'Player double tap jump',
      tDoubleTapCenter: 'Double tap in the middle of a post', dtFullscreen: 'Fullscreen (common player)', dtLike: 'Like: ♥ favorite + ▲ (Instagram)',
      tRotate: 'Landscape in player fullscreen',
      tPreload: 'Next post loaded in the player',
      tModalOrig: 'original image in the player', origZoom: 'When zooming in (sample first, faster)', origAlways: 'Always (slower)',
      origLoading: 'Loading the original…', infoSample: 'sample',
      qualSampleTip: 'Showing the sample: tap for the original (raw)', qualRawTip: 'Showing the original (raw): tap for the sample',
      favAdded: 'Added to favorites', favAlready: 'Already in your favorites', favRemoved: 'Removed from favorites',
      favLogin: 'You are not logged in', favFail: 'Could not favorite', mTurnNo: 'This browser cannot turn the screen',
      voted: 'Upvoted', voteFail: 'Could not vote',
      tOriginal: 'Original thumbnails (heavy)',
      tFeed: 'Feed on site pages',
      tFeedCols: 'feed columns', tFeedLayout: 'feed layout', colsAuto: 'Automatic (by screen width)',
      layoutMasonry: 'Masonry (whole images)', layoutGrid: 'Grid (even tiles)',
      tDebug: 'Log to console',
      noteReload: 'reload',
      bTest: 'Test URLs', bClearHost: 'Clear host',
      bCopy: 'Copy log', bReload: 'Reload', bFree: 'Free memory & cache', bRedo: 'Redo thumbnails',
      
    },
    'pt-BR': {
      fixes: 'correções', log: 'log', language: 'idioma', auto: 'Automático',
      site: 'site', thumbnail: 'miniatura',
      host: 'host', covers: 'capas',
      
      failed: 'falhou', 
      notResolved: 'não resolvido', cached: 'cache',
      coversFmt: (ok, bad, all) => `${ok} ok · ${bad} falha · ${all} vídeos`,
      tCovers: 'Capa de vídeo', tBadges: 'Duração e ⚠️ nas miniaturas de vídeo', tGif: 'GIF animado na grade', tGifMax: 'GIFs animando ao mesmo tempo', tHoldGif: 'Segurar um GIF para reconstruí-lo',
      tScrub: 'Prévia de cenas nas miniaturas de vídeo',
      tScrubMode: 'gesto da prévia de cenas', modeDrag: 'Arrastar de lado', modeHold: 'Segurar (slideshow)',
      tSlideStep: 'pulo do slideshow', tSlideDwell: 'tempo por cena', scenes: 'cenas', tSlideReel: 'Só keyframes (mais rápido, MP4)', tWasmDecode: 'Decodificar keyframes em WebAssembly',
      tHoldVideo: 'Segurar toca o vídeo (hardware)', tPreviewSound: 'Som quando o segurar toca o vídeo', tHoldResume: 'Segurar continua de onde parou (1 min)', tHoldRub: 'Segurar e deslizar move o vídeo', resumeRestart: 'Recomeçar do início', soundToggle: 'Som do segurar: toque para trocar', heavyMark: 'Acima do decodificador de hardware do celular (1080p60)',
      tMemory: 'Liberar memória fora da tela',
      tUrlCache: 'Lembrar endereços que funcionaram',
      tNav: 'Botões topo / anterior / próximo',
      navPrev: 'Post anterior', navNext: 'Próximo post', navTop: 'Topo da página', navBottom: 'Fim da página',
      navPrevPage: 'Página anterior', navNextPage: 'Próxima página',
      tHoldRaw: 'Segurar a imagem para carregar a original (raw)', rawFailed: 'Arquivo original não encontrado', rawAlready: 'Esta imagem já é o original (o post não tem sample)',
      tFavsBtn: 'Botão de atalho para os seus favoritos', navFavs: 'Seus favoritos',
      tBulkBtn: 'Botão de favoritar em massa', navBulk: 'Favoritar em massa: cada post tocado ganha ♥ e ▲',
      bulkOn: 'Favoritar em massa ligado: toque nos posts para favoritar e votar', bulkOff: 'Favoritar em massa desligado',
      tCopyBtn: 'Botão de copiar link no menu do post', copyLink: '🔗 Copiar link', linkCopied: 'Link do arquivo raw copiado', copyFailed: 'Não deu para copiar o link',
      tPlayerBtn: 'Botões do Media Player (▶ tocar, ⬇ baixar, ⚡ converter) no menu do post', appDlBtn: '⬇ App', appReduceBtn: '⚡ 1080p',
      bigVideo: 'Grande demais para o decodificador do celular: ☰ → ⚡ 1080p converte no app',
      tAppBridge: 'Falar direto com o app (servidor dele)', appToken: 'Token do app', appOk: 'App conectado', appDown: 'App sem resposta (abra o app)',
      appBadToken: 'Token errado', appNoStore: 'Precisa do armazenamento do Violentmonkey', appQueued: 'Baixando no app',
      appReduceQueued: 'Baixando no app, para converter', appSaved: 'Salvo pelo app', appFailed: 'O download do app falhou',
      appConverting: 'Convertendo no app', appConverted: 'Convertido pelo app', appFits: 'Salvo: toca como está',
      tRedoBtn: 'Botão de atalho para refazer as miniaturas', navRedo: 'Limpar a memória e refazer as miniaturas', tDoubleTap: 'Toque duplo na miniatura: favoritar + votar', tDoubleTapLike: 'Curtida na miniatura', likeHeart: 'Com a animação do ❤️', likeQuiet: 'Discreta (sem animação)',
      tLikedBadge: '❤️ nas miniaturas dos favoritos (segurar: descurtir)', heartHint: 'Segure o ❤️ para tirar dos favoritos', unlikeFail: 'Não deu para descurtir',
      tFavAutoIndex: 'Manter o índice de favoritos em dia ao curtir', tResBadge: 'Resolução nas miniaturas', apiKey: 'Chave da API do rule34', apiSec: 'API do rule34 (sua chave)', apiWarn: '⚠️ Cole sua chave da API abaixo para ligar estas funções. rule34 → My Account → Options → API Access Credentials: copie a linha inteira &api_key=…&user_id=….', apiPartial: 'quando cada imagem carrega',
      apiKeyHint: 'Cole &api_key=…&user_id=… (rule34 → My Account → Options)', apiKeySet: 'Chave salva: resoluções pela API', apiKeyNone: 'Sem chave: só vídeos e posts abertos', apiKeyBad: 'Não é uma chave: cole a linha &api_key=…&user_id=… inteira',
      tEyeBtn: 'Botão 👁: oculta os outros botões', eyeHide: 'Ocultar os botões', eyeShow: 'Mostrar os botões',
      tFreeBtn: 'Botão de atalho para limpar a memória', navFree: 'Limpar memória e cache',
      tFavSearch: 'Buscar nos seus favoritos', tSiteSearch: 'Barra de busca nas páginas do site', tSuggest: 'Sugestões de tags ao digitar',
      savedPick: 'Buscas favoritas…', recentPick: 'Buscas recentes…', saveSearch: '☆ Favoritar', savedSearch: '★ Favorita', savedAll: '(tudo)',
      orPlaceholder: 'OU: tag tag tag · || novo grupo',
      minScore: 'score mín.', sitePlaceholder: 'buscar: tag -tag tag* ( a ~ b )', tPager: 'Autopager (buscas e favoritos)',
      pagerLoading: 'Carregando a próxima página…', pagerEnd: 'Fim da lista', pagerFail: 'Não deu para carregar a próxima página — toque para tentar de novo',
      favPlaceholder: 'buscar nos favoritos: tag -tag tag* a ~ b score:>10', favGo: 'Buscar', favClear: 'Limpar',
      favKindAll: 'Todos os tipos', favKindImage: 'Imagens', favKindVideo: 'Vídeos', favKindGif: 'GIFs', favKindAnimated: 'Animados (vídeo ou GIF)',
      favSortNew: 'Mais novos', favSortOld: 'Mais antigos', favSortScore: 'Score', favSortRandom: 'Aleatório',
      favIndexed: 'favoritos no índice', favNever: 'ainda sem índice: a primeira busca lê todas as páginas', favPartial: 'ainda não todos: o resto vem sozinho',
      favScanning: 'lendo favoritos, página', favResults: 'resultados', favMore: 'Mostrar mais',
      favUpdate: 'Atualizar', favRebuild: 'Refazer índice', favScanFail: 'não foi possível ler a página de favoritos',
      tLaterBtn: 'Botão Ver depois', navLater: 'Ver depois', laterTitle: 'Ver depois',
      dlBtn: '🦊⬇ Baixar raw', dlWait: 'O arquivo ainda está carregando', dlStart: 'Baixando…', dlBusy: 'Este post já está baixando', dlDone: 'Baixado: confirme no Firefox para salvar',
      dlFail: 'Falha no download', dlOpened: 'Aberto em outra aba: segure para salvar',
      laterAdd: '🕒 Ver depois', laterIn: '✓ Na lista', laterAdded: 'Salvo para ver depois', laterRemoved: 'Tirado da lista',
      laterEmpty: 'Nada salvo ainda. Use o 🕒 no menu ☰ de um post.', laterOnDevice: 'guardado pelo Violentmonkey, neste aparelho',
      laterOnSite: 'guardado nos dados deste site (IndexedDB)',
      tModal: 'Abrir posts num player sobre a página',
      tTheme: 'Tema: páginas do site, este painel e o post', themeNormal: 'Normal (verde-água e neon)', themeGelbooru: 'Gelbooru (azul)',
      themeOled: 'Preto OLED', themeGray: 'Cinza', themeQtmp: 'QtMediaPlayer (o app)', themeSite: 'Original do site',
      tSeekReel: 'Prévia da barra de busca por keyframes (WebAssembly)',
      tAds: 'Bloquear anúncios (só os scripts do próprio site carregam)',
      mClose: 'Fechar', mOpen: 'Abrir o post', mPrev: 'Post anterior', mNext: 'Próximo post',
      mLoading: 'Carregando…', mFail: 'Não foi possível carregar',
      mFav: 'Favoritar', mUp: 'Votar positivo', mFull: 'Tela cheia', mFullExit: 'Sair da tela cheia', mMenu: 'Tags e página do post',
      tabTags: 'Tags', tabInfo: 'Info', tabComments: 'Comentários', commentsMore: 'Mais comentários', commentsNone: 'Sem comentários', commentsHidden: 'ocultos pelo seu limite de score de comentários', infoKind: 'Tipo', infoRes: 'Resolução', infoFormat: 'Formato', infoDuration: 'Duração',
      infoDrops: 'Quadros perdidos', infoDropsOf: 'de', infoAbove: 'acima de 1080p: celulares intermediários decodificam em software', infoLoading: 'carregando…',
      kindVideo: 'Vídeo', kindGif: 'GIF', kindImage: 'Imagem',
      tagOpened: 'Aberto em outra aba', tagCopied: 'Copiado', tagCopyFail: 'Não foi possível copiar', tagsNone: 'Sem tags', mTurn: 'Girar a tela',
      mPlay: 'Tocar / pausar', mMute: 'Som liga / desliga', mFavUp: 'Favoritar e dar ▲', mGear: 'Velocidade e duplo toque',
      gearRate: 'Velocidade', gearStep: 'Duplo toque pula', tPlayRate: 'Velocidade do player', tSeekStep: 'Pulo do duplo toque no player',
      tDoubleTapCenter: 'Toque duplo no meio do post', dtFullscreen: 'Tela cheia (player comum)', dtLike: 'Curtir: ♥ favorito + ▲ (Instagram)',
      tRotate: 'Paisagem na tela cheia do player',
      tPreload: 'Próximo post carregado no player',
      tModalOrig: 'imagem original no player', origZoom: 'Ao dar zoom (sample antes, mais rápido)', origAlways: 'Sempre (mais lento)',
      origLoading: 'Carregando o original…', infoSample: 'sample',
      qualSampleTip: 'Mostrando o sample: toque para o original (raw)', qualRawTip: 'Mostrando o original (raw): toque para o sample',
      favAdded: 'Adicionado aos favoritos', favAlready: 'Já está nos favoritos', favRemoved: 'Removido dos favoritos',
      favLogin: 'Você não está logado', favFail: 'Não foi possível favoritar', mTurnNo: 'Este navegador não gira a tela',
      voted: 'Voto registrado', voteFail: 'Não foi possível votar',
      tOriginal: 'Miniatura original (pesado)',
      tFeed: 'Feed nas páginas do site',
      tFeedCols: 'colunas do feed', tFeedLayout: 'layout do feed', colsAuto: 'Automático (pela largura da tela)',
      layoutMasonry: 'Masonry (imagens inteiras)', layoutGrid: 'Grade (quadros iguais)',
      tDebug: 'Log no console',
      noteReload: 'recarregar',
      bTest: 'Testar URLs', bClearHost: 'Limpar host',
      bCopy: 'Copiar log', bReload: 'Recarregar', bFree: 'Limpar memória e cache', bRedo: 'Refazer miniaturas',
      
    },
  }

  // src/core/i18n.ts
  // The panel's language and its strings (t).

  /**
   * Active language: explicit choice first, otherwise the browser's.
   */
  function resolveLang() {
    if (CFG.lang && I18N[CFG.lang]) return CFG.lang
    return String(navigator.language || 'en').toLowerCase().startsWith('pt')
      ? 'pt-BR'
      : 'en'
  }

  let LANG = resolveLang()
  function setLang(v) { LANG = v }

  const t = key => {
    const value = I18N[LANG][key]
    return value === undefined ? I18N.en[key] : value
  }

  // src/core/log.ts
  // ═══════════════════════════════════════════════════════════
  // Log
  // ═══════════════════════════════════════════════════════════

  const LOG = []
  const LOG_MAX = 250
  let onLogEntry = null   // the panel subscribes here once mounted
  function setOnLogEntry(v) { onLogEntry = v }

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

  const dbg   = (m) => log('debug', m)
  const info  = (m) => log('info', m)
  const warn  = (m) => log('warn', m)
  const error = (m) => log('error', m)

  // Whatever was thrown or rejected, an Error or not: its message, or itself as text.
  const describeError = (e) => (e && (e).message ? (e).message : String(e))

  // A log entry as one line of text, as Copy log and the console's tail() give it.
  const logLine = (e) => `${new Date(e.t).toTimeString().slice(0, 8)} [${e.level}] ${e.msg}`

  // src/core/state.ts
  // ═══════════════════════════════════════════════════════════
  // State observed by the panel
  // ═══════════════════════════════════════════════════════════

  const STATE = {
    imageBase: null,
    baseCached: false,
    covers: { tracked: 0, ok: 0, failed: 0 },
  }

  let onStateChange = null
  function setOnStateChange(v) { onStateChange = v }
  const touch = () => { if (onStateChange) onStateChange() }

  // src/urls/url-cache.ts
  // ═══════════════════════════════════════════════════════════
  // URL cache
  //
  // Firefox's HTTP cache already keeps the bytes. What the script kept losing
  // was which candidate URL won: every re-upgrade (memory saver, modal unload)
  // walked the whole ladder again — jpg/png/jpeg, a dozen video hosts for a GIF
  // labelled as video, an .mp4 sniff on every modal open. This remembers the
  // winning URL per kind and file hash, and "nothing loads" for a day.
  //
  // Two places keep it: localStorage the newest URLCACHE_MAX, read in one go
  // before the first thumbnail, and the site's IndexedDB every entry, up to
  // URLIDX_MAX, read for the cards as they are scanned, before they scroll
  // in (urlPrefetch). Free memory keeps both: they are what brings the cards
  // back in one request each.
  // ═══════════════════════════════════════════════════════════

  const URLCACHE_KEY = `IBH_URLCACHE_${SITE}`
  const URLCACHE_MAX = 1500
  const URLCACHE_TTL = 30 * 24 * 60 * 60 * 1000   // a winning URL
  const URLCACHE_NEG_TTL = 24 * 60 * 60 * 1000    // "nothing loads": short, a CDN hiccup must not stick
  const urlStats = { hits: 0, misses: 0, healed: 0 }
  // An entry: u the winning URL (null: nothing loads), t when it was written,
  // and for a miss f when it was first seen and n how many times.
  // kind:hash -> entry
  let urlCache = null
  let urlCacheTimer = 0

  // The IndexedDB side. A database of its own: a new store in 'ibh' would
  // need a version change, which a tab still on an older version blocks. A
  // script that clears localStorage leaves it alone.
  const URLIDX_MAX = 20000
  const URL_KINDS = ['sample', 'orig', 'gif', 'video', 'poster']
  // When the last batch that reached IndexedDB was taken: newer entries in
  // localStorage may have missed it (a write cut short by leaving the page).
  const URLIDX_SYNC_KEY = `IBH_URLIDX_SYNC_${SITE}`
  let urlDbOpen = null
  const urlDirty = new Map()   // kind:hash -> entry to write, or null to delete, until the next flush
  const urlAsked = new Set()   // hashes already read, or being read, from IndexedDB
  const urlWanted = new Set()  // hashes for the next batched read
  let urlGen = 0               // bumped by a clear: reads started before it drop their answer
  const urlInFlight = new Set()   // hashes asked of IndexedDB, not answered yet
  let urlReading = null           // the batch in flight, or its URLIDX_WAIT_MS if that comes first
  // A card on screen at load is scanned and wanted in the same moment: its
  // upgrade, GIF or cover waits this long at most for IndexedDB's answer
  // (a few ms to tens on the phone) rather than walk a ladder it may know.
  const URLIDX_WAIT_MS = 400

  const expired = (entry) => Date.now() - entry.t >= (entry.u === null ? URLCACHE_NEG_TTL : URLCACHE_TTL)

  // Auto-delete: expired entries go on load and on every write, not only when
  // read again, so files never seen again do not linger.
  // Only called with the cache loaded.
  function dropExpired() {
    let n = 0
    for (const k of Object.keys(urlCache))
      if (expired(urlCache[k])) { delete urlCache[k]; n++ }
    return n
  }

  function loadUrlCache() {
    if (!urlCache) {
      urlCache = (readJSON(URLCACHE_KEY, {}) || {})
      if (dropExpired()) scheduleUrlFlush()
      syncUrlIndex(urlCache)
    }
    return urlCache
  }

  // An entry written: in memory now, in both stores at the next flush.
  function putUrl(key, entry) {
    urlCache[key] = entry
    urlDirty.set(key, entry)
    scheduleUrlFlush()
  }

  // A miss counts only when it repeats at least a minute later: a Wi-Fi
  // handoff fails every ladder in flight at once, and a single run of misses
  // must not hide a real file for a day.
  const MISS_CONFIRM_MS = 60 * 1000

  /**
   * A URL string, null for a confirmed miss, or undefined when nothing usable is cached.
   */
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

  /**
   * Record the outcome of a ladder. Only definitive ones: a winner, or "none loads".
   * @param previous  what cacheGet gave before the ladder
   */
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
          putUrl(key, { u: null, t: now, f: old.f || old.t, n: 2 })
        }
        return
      }
      putUrl(key, { u: null, t: now, f: now, n: 1 })
      return
    }
    if (previous && url !== previous) urlStats.healed++   // the cached one had stopped working
    // Same winner seen again recently: nothing new to save. Covers remount
    // often, and re-serialising the cache each time would cost while scrolling.
    if (old && old.u === url && now - old.t < URLCACHE_NEG_TTL) return
    putUrl(key, { u: url, t: now })
  }

  // The cached winner goes first; if it fails, the full ladder runs behind it.
  const cachedFirst = (urls, cached) => typeof cached === 'string' ? [cached, ...urls.filter(u => u !== cached)] : urls

  // One file's remembered miss gone from both stores, so its ladder runs
  // again (a GIF held to rebuild it). A winner stays: it is still the file.
  function forgetMiss(kind, hash) {
    if (!CFG.urlCache || !hash) return
    const key = `${kind}:${hash}`
    const entry = loadUrlCache()[key]
    if (entry && entry.u !== null) return
    delete urlCache[key]
    urlDirty.set(key, null)   // IndexedDB may hold it even when memory does not
    scheduleUrlFlush()
  }

  // Writes are batched: serialising the cache on every swap would stutter the scroll.
  function scheduleUrlFlush() {
    if (!urlCacheTimer) urlCacheTimer = setTimeout(flushUrlCache, 3000)
  }

  const newestFirst = (keys) => keys.sort((a, b) => urlCache[b].t - urlCache[a].t)

  const pickUrls = (keys) => (Object.fromEntries(keys.map(k => [k, urlCache[k]])))

  let lastLoggedHits = -1
  function flushUrlCache() {
    clearTimeout(urlCacheTimer)
    urlCacheTimer = 0
    if (!urlCache) return
    dropExpired()
    // localStorage takes the newest only. Memory keeps the rest: entries read
    // from IndexedDB for this page are old by date, and trimming them here
    // would drop them before their cards scroll in.
    const newest = newestFirst(Object.keys(urlCache)).slice(0, URLCACHE_MAX)
    if (!writeJSON(URLCACHE_KEY, pickUrls(newest))) {
      // Storage full: the newer half, once more.
      if (!writeJSON(URLCACHE_KEY, pickUrls(newest.slice(0, Math.floor(newest.length / 2))))) warn('url cache: could not save it')
    }
    flushUrlIndex()
    if (urlStats.hits !== lastLoggedHits) {
      lastLoggedHits = urlStats.hits
      dbg(`url cache: ${urlStats.hits} hits, ${urlStats.misses} misses, ${urlStats.healed} healed, ${Object.keys(urlCache).length} entries`)
    }
  }

  function clearUrlCache(missesOnly) {
    const c = loadUrlCache()
    let n = 0
    for (const k of Object.keys(c)) if (!missesOnly || c[k].u === null) { delete c[k]; n++ }
    clearUrlIndex(missesOnly)
    flushUrlCache()
    return n
  }

  // Resolves null where IndexedDB is not available (then localStorage alone,
  // as before 1.16.4).
  function urlDb() {
    if (!urlDbOpen) {
      urlDbOpen = new Promise(resolve => {
        try {
          const req = indexedDB.open('ibh-urls', 1)
          req.onupgradeneeded = () => {
            const store = req.result.createObjectStore('urls')
            store.createIndex('t', 't')   // the oldest go first past URLIDX_MAX
            store.createIndex('m', 'm')   // misses only (m: 1), for ↻ and their short life
          }
          req.onsuccess = () => {
            const db = req.result
            // Made by something else, without the store: left alone.
            if (!db.objectStoreNames.contains('urls')) { db.close(); resolve(null); return }
            // A later version may need it upgraded; the next call opens it again.
            db.onversionchange = () => { db.close(); urlDbOpen = null }
            resolve(db)
          }
          req.onerror = () => resolve(null)
        } catch (e) {
          resolve(null)
        }
      })
    }
    return urlDbOpen
  }

  // One transaction on the index store; resolves once it completes.
  /**
   * @returns false without IndexedDB or when it failed
   */
  async function urlTx(mode, work) {
    const db = await urlDb()
    if (!db) return false
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('urls', mode)
        work(tx.objectStore('urls'))
        tx.oncomplete = resolve
        tx.onerror = tx.onabort = () => reject(tx.error)
      })
      return true
    } catch (e) {
      dbg(`url index: ${mode} failed — ${describeError(e)}`)
      return false
    }
  }

  // A card's thumbnail, as the card is scanned: its entries come from
  // IndexedDB with the others of the same scan, in one transaction.
  function urlPrefetch(src) {
    if (!CFG.urlCache) return
    const hash = (thumbParts(src) || {}).hash
    if (!hash || urlAsked.has(hash)) return
    urlAsked.add(hash)
    urlInFlight.add(hash)
    urlWanted.add(hash)
    if (urlWanted.size > 1) return   // joins the batch already on its way
    // A microtask, not a timer: it still runs after the rest of this scan has
    // joined, and a timer waits behind the page's loading (~0.15 s measured).
    const batch = new Promise(resolve => queueMicrotask(() => readWanted().then(resolve)))
    const capped = Promise.race([batch, new Promise(resolve => setTimeout(resolve, URLIDX_WAIT_MS))])
    urlReading = capped
    capped.then(() => { if (urlReading === capped) urlReading = null })
  }

  // What to wait for before a ladder for this kind and hash: the read in
  // flight, when it may bring an entry memory does not have yet; else null.
  function urlPending(kind, hash) {
    if (!urlReading || !hash || !urlInFlight.has(hash)) return null
    return urlCache && urlCache[`${kind}:${hash}`] ? null : urlReading
  }

  async function readWanted() {
    const hashes = [...urlWanted]
    urlWanted.clear()
    try {
      await readUrls(hashes)
    } finally {
      for (const hash of hashes) urlInFlight.delete(hash)
    }
  }

  async function readUrls(hashes) {
    const gen = urlGen
    const found = []
    const ok = await urlTx('readonly', store => {
      for (const hash of hashes) {
        for (const kind of URL_KINDS) {
          const key = `${kind}:${hash}`
          const req = store.get(key)
          req.onsuccess = () => { if (req.result) found.push([key, req.result]) }
        }
      }
    })
    if (!ok || gen !== urlGen) return   // a clear came in between
    const c = loadUrlCache()
    let n = 0
    for (const [key, stored] of found) {
      // Written here since the read began, or newer in memory: that one stands.
      if (expired(stored) || urlDirty.has(key) || (c[key] && c[key].t >= stored.t)) continue
      const entry = { ...stored }
      delete entry.m   // the misses' index mark, IndexedDB's only
      c[key] = entry
      n++
    }
    if (n) dbg(`url index: ${n} entries from IndexedDB for ${hashes.length} thumbnails`)
  }

  // Pending writes in one transaction. The batch's time is noted once it is
  // in: what localStorage holds past it may not have reached IndexedDB.
  async function flushUrlIndex() {
    if (!urlDirty.size) return
    const batch = [...urlDirty]
    urlDirty.clear()
    const taken = Date.now()
    const ok = await urlTx('readwrite', store => {
      for (const [key, entry] of batch) {
        if (entry) store.put(entry.u === null ? { ...entry, m: 1 } : entry, key)
        else store.delete(key)
      }
    })
    if (ok) writeJSON(URLIDX_SYNC_KEY, taken)
  }

  // Once per page: localStorage entries newer than the last batch in go to
  // IndexedDB (all of them the first time, when nothing was ever sent), and
  // a moment later the index sweeps itself.
  function syncUrlIndex(c) {
    if (!CFG.urlCache) return
    const since = Number(readJSON(URLIDX_SYNC_KEY, 0)) || 0
    // >=: an entry written in the same millisecond the last batch was taken missed it.
    for (const [key, entry] of Object.entries(c)) if (entry.t >= since && !urlDirty.has(key)) urlDirty.set(key, entry)
    if (urlDirty.size) scheduleUrlFlush()
    setTimeout(sweepUrlIndex, 20000)
  }

  // Expired entries out (misses after a day, winners after 30), then the
  // oldest past URLIDX_MAX, one step after the other in one transaction.
  function sweepUrlIndex() {
    if (!CFG.urlCache) return
    const now = Date.now()
    let dropped = 0
    /**
     * Deletes what the cursor walks over, while drop() says so; then next().
     */
    const walk = (req, drop, next) => {
      req.onsuccess = () => {
        const cur = req.result
        if (!cur) { if (next) next(); return }
        if (!drop(cur.value)) { if (next) next(); return }
        cur.delete()
        dropped++
        cur.continue()
      }
    }
    urlTx('readwrite', store => {
      const byAge = store.index('t')
      const expiredMisses = (req) => {
        req.onsuccess = () => {
          const cur = req.result
          if (!cur) { oldOnes(); return }
          if (expired(cur.value)) { cur.delete(); dropped++ }
          cur.continue()
        }
      }
      // Older than a winner lives: every one of them has expired.
      const oldOnes = () => walk(byAge.openCursor(IDBKeyRange.upperBound(now - URLCACHE_TTL)), () => true, overCap)
      const overCap = () => {
        const count = store.count()
        count.onsuccess = () => {
          let over = count.result - URLIDX_MAX
          if (over > 0) walk(byAge.openCursor(), () => over-- > 0)
        }
      }
      expiredMisses(store.index('m').openCursor())
    }).then(ok => { if (ok && dropped) dbg(`url index: ${dropped} old entries dropped`) })
  }

  // For __ibh.urlIndex(): what the IndexedDB side holds; null without it.
  async function urlIndexStats() {
    let entries = 0
    let misses = 0
    const ok = await urlTx('readonly', store => {
      const all = store.count()
      all.onsuccess = () => { entries = all.result }
      const m = store.index('m').count()
      m.onsuccess = () => { misses = m.result }
    })
    return ok ? { entries, misses, max: URLIDX_MAX } : null
  }

  // The clear behind clearUrlCache: reads in flight drop their answer, and
  // writes not sent yet go too, or they would bring the cleared back.
  function clearUrlIndex(missesOnly) {
    urlGen++
    // A hash whose read this drops may be asked again. Cards already scanned
    // are not asked again: what they miss, their ladder writes back.
    urlAsked.clear()
    for (const [key, entry] of urlDirty) if (!missesOnly || (entry && entry.u === null)) urlDirty.delete(key)
    urlTx('readwrite', store => {
      if (!missesOnly) { store.clear(); return }
      const req = store.index('m').openCursor()
      req.onsuccess = () => {
        const cur = req.result
        if (!cur) return
        cur.delete()
        cur.continue()
      }
    })
  }

  // src/urls/hosts.ts
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

  /**
   * Pull DIR and HASH out of .../thumbnails/DIR/thumbnail_HASH.jpg or .../samples/DIR/sample_HASH.jpg
   */
  function thumbParts(thumbUrl) {
    if (!thumbUrl) return null
    const m = thumbUrl.replace(/\?.*$/, '')
      .match(/\/(?:thumbnails|samples)\/(.+)\/(?:thumbnail|sample)_([^/]+)\.(?:jpe?g|png)$/i)
    // rule34 serves paths like //thumbnails//2389/; keep DIR free of extra slashes.
    return m ? { dir: m[1].replace(/^\/+|\/+$/g, ''), hash: m[2] } : null
  }

  /**
   * URLs to try, most likely first.
   */
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

  // src/video/limits.ts
  // Imports nothing, so the tools load it too.

  // Past a mid-range hardware decoder (this phone's stops at 1920×1088, in
  // either orientation, and at 1080p60's 489,600 macroblocks a second): such
  // a video decodes on the CPU, slowly. Without fps only the size counts.
  // The same rule as the app's vreduce::fits (QtMediaPlayer's
  // src/reduce/probe.hpp, and its static_asserts are the cases to keep):
  // the rate rounded first, so a phone's 60.03 or 59.94 fits and 60.6
  // (61) doesn't. A rate measured while playing wobbles: its slack is where
  // it is measured (HOLD_FPS_SLACK), not here.
  const MB_PER_S = 489600
  const pastDecoder = (w, h, fps) => Math.max(w, h) > 1920 || Math.min(w, h) > 1088 ||
    (!!fps && Math.ceil(w / 16) * Math.ceil(h / 16) * Math.round(fps) > MB_PER_S)

  // src/post/app.ts
  // The app buttons hand the user's own QtMediaPlayer app
  // (com.example.qtmediaplayer) the video's link, as an intent link to the
  // app's filter for http(s) videos (ACTION_VIEW, BROWSABLE: Firefox opens
  // it). The app's extra MODE says what to do with it: play (▶ Media Player:
  // its FFmpeg plays what the hardware decoder can't, on the CPU), download
  // (⬇ App: its yt-dlp, into the phone's Download folder, in the background)
  // or reduce (⚡ 1080p: download, then convert with the app's own
  // VideoReducer engine, which reads local files only). An app without MODE
  // plays the link whatever it says. An intent cannot carry the site as
  // Referer, which rule34's fast host (api-cdn) wants, so the app gets the
  // origin host: slower, open to anyone. The title and position ride along.
  const APP = 'com.example.qtmediaplayer'
  async function sendToApp(mode) {
    const playing = modal.fileUrl || modal.video.currentSrc
    if (!playing) { flash(t('dlWait')); return }
    const title = `${SITE.split('.')[0]} ${postId(modal.link)}`
    // The app's server first (appBridge), within the tap's activation (the
    // timeout is short), so the intent link below still opens if it fails.
    if (mode !== 'play' && await appDownload(playing, mode === 'reduce', title)) return
    const u = new URL(portableUrl(playing))
    const ms = Math.round((modal.video.currentTime || 0) * 1000)
    if (mode === 'play') modal.video.pause()
    const extras = [
      `S.${APP}.extra.MODE=${mode}`,
      `S.android.intent.extra.TITLE=${encodeURIComponent(title)}`,
      `l.position=${ms}`,
    ]
    info(`external player: post ${postId(modal.link)} sent to QtMediaPlayer to ${mode}${mode === 'play' ? ` at ${mmss(ms / 1000)}` : ''}`)
    el('a', { href: `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.slice(0, -1)};type=video/*;package=${APP};${extras.join(';')};end` }).click()
  }

  // ── The app's server (appBridge) ──
  // ⬇ App and ⚡ 1080p through the app's own HTTP server on 127.0.0.1, the
  // contract in types/qtmediaplayer.d.ts: the download takes the file from
  // the site's fast host with the site as Referer, which an intent can't
  // send, and its progress shows here. Off by default: the script needs
  // nothing outside the site. Android freezes the app in the background, so
  // the timeout is short and the intent link stays behind it. The token is
  // kept with GM_setValue only: storeGet/storeSet fall back to the site's
  // IndexedDB, and IBH_CFG has copies in the site's storage, all readable by
  // the site's scripts.
  const APP_SERVER = 'http://127.0.0.1:8745'
  const APP_TIMEOUT_MS = 1500
  const APP_POLL_MS = 2000
  const APP_POLL_MISSES = 30   // a minute without an answer ends the following
  const appToken = () => (GM_STORE ? String(GM_getValue('appToken', '') || '') : '')
  function setAppToken(value) { if (GM_STORE) GM_setValue('appToken', String(value).trim()) }

  // One request to the app: { ok, status, json } or { ok: false, stage, error },
  // where stage is 'token' (401) or 'app' (not answering, or its own error).
  function appCall(method, route, body) {
    return new Promise(resolve => {
      const down = () => resolve({ ok: false, status: 0, json: null, stage: 'app', error: 'not answering' })
      if (!GM_XHR) { down(); return }
      GM_xmlhttpRequest({
        method,
        url: `${APP_SERVER}/${route}`,
        timeout: APP_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${appToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        data: body ? JSON.stringify(body) : undefined,
        onload: res => {
          let json = null
          try { json = JSON.parse(res.responseText) } catch (e) { /* not JSON */ }
          if (res.status === 401) resolve({ ok: false, status: 401, json, stage: 'token', error: 'wrong token' })
          else if (res.status >= 200 && res.status < 300 && json && json.ok) resolve({ ok: true, status: res.status, json })
          else resolve({ ok: false, status: res.status, json, stage: 'app', error: (json && json.error) || `HTTP ${res.status}` })
        },
        onerror: down,
        ontimeout: down,
      })
    })
  }

  // The panel's token field and the app's status (asked each time the panel
  // is built or opened).
  let appStatusRow = null
  function appControls() {
    const field = el('input', { class: 'apptoken', type: 'password', autocomplete: 'off', placeholder: t(GM_STORE ? 'appToken' : 'appNoStore') })
    field.disabled = !GM_STORE
    field.value = appToken()
    field.addEventListener('change', () => { setAppToken(field.value); refreshAppStatus() })
    appStatusRow = el('div', { class: 'lbl appstatus', text: '…' })
    refreshAppStatus()
    return el('div', { class: 'lang' }, [el('div', { class: 'lbl', text: t('appToken') }), field, appStatusRow])
  }

  async function refreshAppStatus() {
    const row = appStatusRow
    if (!row || !CFG.appBridge) return
    if (!GM_STORE) { row.textContent = t('appNoStore'); return }
    const r = await appCall('GET', 'v1/status')
    const status = (r.ok ? r.json : null)
    row.textContent = status ? `${t('appOk')} · ${status.version}` : t(r.stage === 'token' ? 'appBadToken' : 'appDown')
    if (status) dbg(`app server: ${status.app} ${status.version}, api ${status.api}`)
    else if (!r.ok) info(`app server: ${r.stage} ${r.error}`)
  }

  // ⬇ App or ⚡ 1080p by the app's server; false when it can't take it, and
  // the caller sends the intent link instead.
  async function appDownload(fileUrl, reduce, title) {
    if (!CFG.appBridge || !appToken()) return false
    const post = postId(modal.link)
    const body = { url: fileUrl, referer: `${location.origin}/`, title, reduce }
    const r = await appCall('POST', 'v1/download', body)
    if (!r.ok) { info(`app server: ${r.stage} ${r.error}; post ${post} goes by the intent link`); return false }
    const queued = r.json
    info(`app server: post ${post} queued as download ${queued.id}${reduce ? ', to convert' : ''}`)
    flash(t(reduce ? 'appReduceQueued' : 'appQueued'))
    followAppDownload(queued.id, post)
    return true
  }

  // Asks the app how a download goes until it (and its conversion) ends,
  // and says so on the page. The app answers while it downloads or converts
  // (a foreground service keeps it awake), so misses mean it went away.
  function followAppDownload(id, post) {
    let misses = 0
    let said = ''
    const say = (key, line) => { if (said === key) return; said = key; flash(t(key)); info(`app server: post ${post} ${line}`) }
    const tick = async () => {
      const r = await appCall('GET', `v1/download/${id}`)
      if (!r.ok) {
        if (r.status === 404 || ++misses > APP_POLL_MISSES) { info(`app server: lost download ${id} of post ${post} (${r.error})`); return }
        setTimeout(tick, APP_POLL_MS)
        return
      }
      misses = 0
      const s = r.json
      if (s.status === 'failed' || s.status === 'cancelled') { say('appFailed', `download ${s.status}${s.error ? ` — ${s.error}` : ''}`); return }
      if (s.status !== 'done') { setTimeout(tick, APP_POLL_MS); return }
      const c = s.reduce
      if (!c) { say('appSaved', `saved as ${s.file}`); return }
      if (c.status === 'fits') { say('appFits', `saved as ${s.file}, within the decoder`); return }
      if (c.status === 'done') { say('appConverted', 'converted to 1080p'); return }
      if (c.status === 'failed' || c.status === 'cancelled') { say('appFailed', `conversion ${c.status}`); return }
      if (c.status === 'running') say('appConverting', 'converting')
      setTimeout(tick, APP_POLL_MS)
    }
    setTimeout(tick, APP_POLL_MS)
  }

  // src/search/site-search.ts
  // ── Saved searches ──
  // Every search a bar runs is kept on its own among the recent ones; ☆
  // makes one a favorite. The favorites bar also keeps its last search, shown
  // again on the next visit until Clear. Stored with the lists as
  // { saved (the favorites), recent, favLast }.
  const RECENT_MAX = 15   // per bar

  // A search as a bar holds it (where: 'fav' or 'site'); active: the favorites
  // bar's last one is on show.
  async function searchStore() {
    const v = await storeGet('searches')
    const ok = v && typeof v === 'object' && !Array.isArray(v)
    return { saved: (ok && v.saved) || [], recent: (ok && v.recent) || [], favLast: (ok && v.favLast) || null }
  }

  // Nothing typed and no filter: not worth keeping.
  const emptySearch = (q) => !q.text.trim() && !orGroups(q.or).length && q.kind === 'all' && !q.min && q.sort === 'new'

  function addRecent(store, q) {
    if (emptySearch(q)) return
    const key = searchKey(q)
    store.recent = [q, ...store.recent.filter(other => searchKey(other) !== key)]
    const mine = store.recent.filter(other => other.where === q.where)
    if (mine.length > RECENT_MAX) store.recent = store.recent.filter(other => !mine.slice(RECENT_MAX).includes(other))
  }

  const searchKey = (q) => [q.where, q.text.trim().replace(/\s+/g, ' '), orGroups(q.or).map(g => g.join(' ')).join(' || '), q.kind, q.sort, String(q.min || '')].join('|')

  function searchLabel(q) {
    const kinds = { image: t('favKindImage'), video: t('favKindVideo'), gif: t('favKindGif'), animated: t('favKindAnimated') }
    const orders = { score: t('favSortScore'), random: t('favSortRandom'), old: t('favSortOld') }
    const or = orGroups(q.or)
    return [q.text.trim() || (or.length ? '' : t('savedAll')), or.map(g => `( ${g.join(' | ')} )`).join(' '), kinds[q.kind], q.min ? `≥ ${q.min}` : '', orders[q.sort] || '']
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
    // The ( a ~ b ) groups left after the kind go to the OR field, apart by ||.
    // The lookahead leaves the space after a group for the next one to start with.
    const groups = []
    rest = rest.replace(/ \( ([^()]+?) \)(?= )/g, (m, inner) => {
      if (!/ ~ /.test(` ${inner} `)) return m
      groups.push(orTags(inner).join(' '))
      return ''
    })
    const or = groups.join(' || ')
    let sort = 'new'
    rest = rest.replace(/ sort:score(?::desc)? /i, () => { sort = 'score'; return ' ' })
    rest = rest.replace(/ sort:random /i, () => { sort = 'random'; return ' ' })
    let min = ''
    rest = rest.replace(/ score:>=?(\d+) /i, (m, n) => { min = n; return ' ' })
    return { rest: rest.trim(), kind, sort, min, or }
  }

  function siteQuery({ rest, kind, sort, min, or }) {
    const either = orGroups(or).map(g => g.length > 1 ? `( ${g.join(' ~ ')} )` : g[0]).join(' ')
    return [rest, either, KIND_QUERY[kind] || '', min ? `score:>=${min}` : '', sort === 'score' ? 'sort:score' : sort === 'random' ? 'sort:random' : '']
      .filter(Boolean).join(' ')
  }

  // Idempotent: the observer calls it on every change of the page.
  // The home page's own search form (Gelbooru 0.2: a form with a tags field).
  const homeSearchForm = () => {
    if (new URLSearchParams(location.search).get('page')) return null   // not the home page
    const field = document.querySelector('form input[name="tags"]')
    return field ? field.closest('form') : null
  }

  function ensureSiteSearch() {
    const bar = document.getElementById('ibh-sitesearch')
    const home = homeSearchForm()
    const listing = new URLSearchParams(location.search).get('page') === 'post' && !!document.querySelector(LIST)
    const want = CFG.siteSearch && !onFavoritesPage() && (listing || !!home)
    if (!want) {
      if (bar) bar.remove()
      if (home) home.style.display = ''   // the site's own box comes back
      return
    }
    if (bar) return
    const now = readSiteQuery(new URLSearchParams(location.search).get('tags') || '')
    const input = el('input', { type: 'search', placeholder: t('sitePlaceholder'), enterkeyhint: 'search' })
    input.setAttribute('autocapitalize', 'off')
    input.setAttribute('autocomplete', 'off')
    attachSuggest(input)
    input.value = now.rest === 'all' ? '' : now.rest
    const or = orInput()
    or.value = now.or
    const kind = kindSelect()
    kind.value = now.kind
    const sort = el('select', { class: 'sort' })
    for (const [value, label] of [['new', t('favSortNew')], ['score', t('favSortScore')], ['random', t('favSortRandom')]]) sort.appendChild(el('option', { value, text: label }))
    sort.value = now.sort
    const min = minScoreInput()
    min.value = now.min
    const go = el('button', { type: 'button', text: t('favGo') })
    const read = () => ({ where: 'site', text: input.value, or: or.value, kind: kind.value, sort: sort.value, min: min.value })
    const saved = savedControls('site', read, q => {
      input.value = q.text; or.value = q.or || ''; kind.value = q.kind; sort.value = q.sort; min.value = q.min || ''
      submit()
    })
    const box = el('div', { id: 'ibh-sitesearch', class: 'ibh-search' }, [input, or, kind, sort, min, go, saved.star, saved.pick, saved.recentPick])
    if (home) {
      // In place of the home page's plain box, which hides.
      home.before(box)
      home.style.display = 'none'
    } else {
      const list = document.querySelector(LIST)   // no home box: a listing, so want found it
      list.before(box)
    }
    recordSiteSearch(read()).then(saved.reload)
    input.addEventListener('input', saved.sync)
    or.addEventListener('input', saved.sync)
    min.addEventListener('input', saved.sync)
    const submit = () => {
      const q = siteQuery({ rest: input.value, or: or.value, kind: kind.value, sort: sort.value, min: min.value })
      info(`site search: ${q || 'all'}`)
      location.href = `index.php?page=post&s=list&tags=${encodeURIComponent(q || 'all').replace(/%20/g, '+')}`
    }
    for (const field of [input, or, min]) field.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); submit() } })
    go.addEventListener('click', submit)
    // The kind and the order wait for Search or Enter: other fields may follow.
    kind.addEventListener('change', saved.sync)
    sort.addEventListener('change', saved.sync)
    dbg('site search bar added')
  }

  // src/video/mp4.ts
  // The MP4 reader: boxes, the video track's index, the H.264 decoder
  // configuration. Imports nothing, so the tools load it too.

  // MP4 boxes between start and end: [size u32][type], a size of 1 puts a
  // 64-bit size after the type, 0 runs to the end.
  function* mp4Boxes(b, start, end) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    let p = start
    while (p + 8 <= end) {
      let size = dv.getUint32(p)
      let head = 8
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); head = 16 } else if (size === 0) size = end - p
      if (size < head) return
      yield { type: String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]), start: p, body: p + head, end: p + size }
      p += size
    }
  }

  const mp4Child = (b, box, type) => {
    for (const c of mp4Boxes(b, box.body, box.end)) if (c.type === type) return c
    return null
  }

  // The video track of a moov box (b holds the box, moov its bounds): its
  // timing, its sample description, and where each sample sits in the file.
  function mp4VideoTrack(b, moov) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    const u32 = (p) => dv.getUint32(p)
    const u64 = (p) => Number(dv.getBigUint64(p))
    for (const trak of mp4Boxes(b, moov.body, moov.end)) {
      if (trak.type !== 'trak') continue
      const mdia = mp4Child(b, trak, 'mdia')
      const hdlr = mdia && mp4Child(b, mdia, 'hdlr')
      if (!hdlr || String.fromCharCode(...b.subarray(hdlr.body + 8, hdlr.body + 12)) !== 'vide') continue
      const tkhd = mp4Child(b, trak, 'tkhd')
      const mdhd = mp4Child(b, mdia, 'mdhd')   // there: it has an hdlr
      const minf = mp4Child(b, mdia, 'minf')
      const stbl = minf && mp4Child(b, minf, 'stbl')
      if (!tkhd || !mdhd || !stbl) return null
      const [stsd, stts, stss, stsz, stsc, stco, co64] = ['stsd', 'stts', 'stss', 'stsz', 'stsc', 'stco', 'co64'].map(t => mp4Child(b, stbl, t))
      const offsets = stco || co64
      if (!stsd || !stts || !stsz || !stsc || !offsets) return null
      const runs = []   // time to sample: [count, delta]
      for (let i = 0, n = u32(stts.body + 4); i < n; i++) runs.push([u32(stts.body + 8 + i * 8), u32(stts.body + 12 + i * 8)])
      const sync = []   // keyframes, 0-based; no table means every sample is one
      if (stss) for (let i = 0, n = u32(stss.body + 4); i < n; i++) sync.push(u32(stss.body + 8 + i * 4) - 1)
      const fixed = u32(stsz.body + 4)
      const count = u32(stsz.body + 8)
      const size = (k) => fixed || u32(stsz.body + 12 + k * 4)
      const chunks = u32(offsets.body + 4)
      // Without an stco, offsets is the co64.
      const chunkAt = (c) => (stco ? u32(stco.body + 8 + c * 4) : u64((co64).body + 8 + c * 8))
      const perChunk = []   // [first chunk (0-based), samples per chunk]
      for (let i = 0, n = u32(stsc.body + 4); i < n; i++) perChunk.push([u32(stsc.body + 8 + i * 12) - 1, u32(stsc.body + 12 + i * 12)])
      const v1 = b[mdhd.body] === 1
      const tv1 = b[tkhd.body] === 1
      return {
        timescale: u32(mdhd.body + (v1 ? 20 : 12)),
        duration: v1 ? u64(mdhd.body + 24) : u32(mdhd.body + 16),
        width: u32(tkhd.body + (tv1 ? 88 : 76)) >>> 16,
        height: u32(tkhd.body + (tv1 ? 92 : 80)) >>> 16,
        // Frames over seconds, from the sample table: exact, no decoding.
        samples: runs.reduce((sum, [count]) => sum + count, 0),
        stsd: b.slice(stsd.start, stsd.end),
        // The sample showing at time t (timescale units).
        sampleAt(t) {
          let k = 0
          let at = 0
          for (const [n, delta] of runs) {
            if (t < at + n * delta) return k + Math.floor((t - at) / delta)
            k += n
            at += n * delta
          }
          return Math.max(0, count - 1)
        },
        timeOf(k) {
          let at = 0
          for (const [n, delta] of runs) {
            if (k < n) return at + k * delta
            k -= n
            at += n * delta
          }
          return at
        },
        keyAtOrBefore(k) {
          if (!sync.length) return k
          let lo = 0
          let hi = sync.length - 1
          let best = sync[0]
          while (lo <= hi) {
            const mid = (lo + hi) >> 1
            if (sync[mid] <= k) { best = sync[mid]; lo = mid + 1 } else hi = mid - 1
          }
          return best
        },
        // [offset, size] of sample k in the file: its chunk, plus the samples before it in there.
        place(k) {
          let first = 0
          for (let i = 0; i < perChunk.length; i++) {
            const [chunk0, per] = perChunk[i]
            const inRun = ((i + 1 < perChunk.length ? perChunk[i + 1][0] : chunks) - chunk0) * per
            if (k < first + inRun) {
              const c = chunk0 + Math.floor((k - first) / per)
              let off = chunkAt(c)
              for (let j = first + (c - chunk0) * per; j < k; j++) off += size(j)
              return [off, size(k)]
            }
            first += inRun
          }
          return null
        },
      }
    }
    return null
  }

  // The decoder configuration (avcC) of an H.264 track, from its sample description.
  function avcConfig(stsd) {
    for (const entry of mp4Boxes(stsd, 16, stsd.length)) {   // past the box header, version and entry count
      if (entry.type !== 'avc1' && entry.type !== 'avc3') return null
      // A visual sample entry has 78 bytes of fields before its own boxes.
      for (const c of mp4Boxes(stsd, entry.body + 78, entry.end)) if (c.type === 'avcC') return stsd.slice(c.body, c.end)
    }
    return null
  }

  // src/scrub/h264.ts
  // ── Keyframe decoder (WebAssembly) ──
  // FFmpeg's H.264 decoder built to WebAssembly (wasm/h264dec.c, wasm/build.sh)
  // and shipped as an @resource, which Violentmonkey downloads once with the
  // script. Keyframes decode straight into a canvas, scaled down to the card:
  // no <video>, no hardware decoder slot, any size. The decoder's imports are
  // system calls it hardly uses (its logging is off), answered by stubs.
  // The decoder's exports (wasm/h264dec.c).
  let h264 = null          // the decoder's exports, once loaded
  let h264Loading = null
  let h264Broken = ''      // why it cannot load, after a first try: the <video> reel from then on

  function h264Decoder() {
    if (h264) return Promise.resolve(h264)
    if (!h264Loading) {
      h264Loading = (async () => {
        if (typeof GM_getResourceURL !== 'function') throw new Error('no GM_getResourceURL grant')
        const t0 = performance.now()
        const bytes = await (await fetch(GM_getResourceURL('h264dec'))).arrayBuffer()
        const mod = await WebAssembly.compile(bytes)
        let mem = null
        // Only called by the decoder, which runs once mem is set (start-up is _initialize, below).
        const view = () => new DataView(mem.buffer)
        const calls = {
          fd_write: (fd, iov, count, written) => {   // nothing to show: count the bytes as written
            let n = 0
            for (let i = 0; i < count; i++) n += view().getUint32(iov + i * 8 + 4, true)
            view().setUint32(written, n, true)
            return 0
          },
          environ_sizes_get: (count, size) => { view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0 },
          clock_time_get: (id, precision, out) => { view().setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true); return 0 },
          random_get: (buf, len) => { crypto.getRandomValues(new Uint8Array(mem.buffer, buf, len)); return 0 },
          proc_exit: code => { throw new Error(`decoder exited (${code})`) },
        }
        const imports = {}
        for (const imp of WebAssembly.Module.imports(mod)) {
          (imports[imp.module] = imports[imp.module] || {})[imp.name] = calls[imp.name] || (() => 0)
        }
        const x = (await WebAssembly.instantiate(mod, imports)).exports
        mem = x.memory
        if (x._initialize) x._initialize()   // the C library's own start-up
        info(`keyframe decoder: WebAssembly ready (${Math.round(bytes.byteLength / 1024)} KB in ${Math.round(performance.now() - t0)} ms)`)
        h264 = x
        return x
      })()
      h264Loading.catch(e => {
        h264Broken = describeError(e)
        warn(`keyframe decoder: ${h264Broken}; reels play in a <video>`)
      }).finally(() => { h264Loading = null })
    }
    return h264Loading
  }

  // Free memory lets go of it (its memory only grows): loaded again on the next hold.
  function dropH264() {
    if (h264) { try { h264.dec_close() } catch (e) { /* gone already */ } }
    h264 = null
  }

  // One AVCC sample in, an ImageData of at least maxW pixels across out.
  function decodeKeyframe(x, bytes, maxW) {
    const ptr = x.buf_alloc(bytes.length)
    new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes)
    const r = x.dec_frame(ptr, bytes.length, maxW)
    x.buf_free(ptr)
    if (r !== 0) throw new Error(`keyframe decode failed (${r})`)
    const w = x.dec_width()
    const h = x.dec_height()
    const at = x.dec_rgba()
    // A copy: the memory's buffer is replaced whenever it grows.
    return new ImageData(new Uint8ClampedArray(x.memory.buffer.slice(at, at + w * h * 4)), w, h)
  }

  // src/scrub/reel.ts
  // ── Keyframe reel ──
  // The hold slideshow without seeking the file: read the MP4's index (its
  // moov box), fetch only the keyframe at or before each scene, and pack
  // those frames into a small MP4 in memory. Played from a blob in one
  // <video>, every scene is a seek to one local keyframe: nothing more to
  // download, one frame to decode, one decoder. GM_xmlhttpRequest does the
  // Range reads (the hosts send no CORS headers). WebCodecs would decode the
  // keyframes directly, but on Firefox for Android it has no decoders (tried:
  // every codec unsupported). MP4 only: WebM, or anything unexpected, seeks.
  const REEL_HEAD = 256 * 1024    // first read: ftyp and, in most files made for streaming, the whole moov
  const REEL_MAX_MOOV = 8e6       // a bigger index is not worth reading for a preview
  const REEL_MAX_BYTES = 12e6     // keyframes past this are thinned out (4K frames run to MBs)
  const REEL_KEEP = 4             // reels kept for another hold on the same video
  const reels = new Map()         // URL and scene count -> reel, oldest first

  // A video's keyframes, one per scene.
  // a reel the WebAssembly decoder can open
  // a request in flight (GM_xmlhttpRequest's)

  // A Range read; `total` is the file size from Content-Range.
  /**
   * @param reqs  where the request goes, to abort it
   */
  function rangeRead(url, start, end, reqs) {
    return new Promise((resolve, reject) => {
      let req = null
      req = GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: 20000,
        headers: { Range: `bytes=${start}-${end}`, Referer: `${location.origin}/` },
        // A host ignoring Range sends the whole file: stop at its headers.
        onreadystatechange: r => {
          if (r.readyState >= 2 && r.status === 200 && req) { req.abort(); reject(new Error('no Range support')) }
        },
        onload: r => {
          if (r.status !== 206) { reject(Object.assign(new Error(`HTTP ${r.status}`), { status: r.status })); return }
          const m = (r.responseHeaders || '').match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i)
          resolve({ buf: new Uint8Array(r.response), total: m ? Number(m[1]) : null })
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
        onabort: () => reject(new Error('aborted')),
      })
      if (req && reqs) reqs.add(req)
    })
  }

  // A minimal MP4 around the keyframes: one video track, each sample a
  // second long and a keyframe, the source's sample description as it is.
  function reelBlob(track, frames) {
    const n = frames.length
    const ascii = (str) => Uint8Array.from(str, c => c.charCodeAt(0))
    const words = (...v) => {
      const out = new Uint8Array(v.length * 4)
      const dv = new DataView(out.buffer)
      v.forEach((x, i) => dv.setUint32(i * 4, x >>> 0))
      return out
    }
    const box = (type, ...parts) => {
      const out = new Uint8Array(8 + parts.reduce((sum, part) => sum + part.length, 0))
      new DataView(out.buffer).setUint32(0, out.length)
      out.set(ascii(type), 4)
      let at = 8
      for (const part of parts) { out.set(part, at); at += part.length }
      return out
    }
    const matrix = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]
    const ms = n * 1000
    const ftyp = box('ftyp', ascii('isom'), words(0x200), ascii('isomiso2avc1mp41'))
    const moovWith = (offsets) => box('moov',
      box('mvhd', words(0, 0, 0, 1000, ms, 0x10000, 0x1000000, 0, 0, ...matrix, 0, 0, 0, 0, 0, 0, 2)),
      box('trak',
        box('tkhd', words(3, 0, 0, 1, 0, ms, 0, 0, 0, 0, ...matrix, track.width * 0x10000, track.height * 0x10000)),
        box('mdia',
          box('mdhd', words(0, 0, 0, 1000, ms, 0x55c40000)),
          box('hdlr', words(0, 0), ascii('vide'), words(0, 0, 0), ascii('VideoHandler\0')),
          box('minf',
            box('vmhd', words(1, 0, 0)),
            box('dinf', box('dref', words(0, 1), box('url ', words(1)))),
            box('stbl', track.stsd,
              box('stts', words(0, 1, n, 1000)),
              box('stsc', words(0, 1, 1, 1, 1)),
              box('stsz', words(0, 0, n, ...frames.map(f => f.length))),
              box('stco', words(0, n, ...offsets)))))))
    // The offsets point past the moov, whose size does not depend on them.
    let at = ftyp.length + moovWith(frames.map(() => 0)).length + 8
    const offsets = frames.map(f => { const o = at; at += f.length; return o })
    const data = frames.reduce((sum, f) => sum + f.length, 0)
    return new Blob([ftyp, moovWith(offsets), words(8 + data), ascii('mdat'), ...frames], { type: 'video/mp4' })
  }

  // Reads the index and the keyframes for these scene fractions.
  async function buildReel(url, steps, reqs) {
    const t0 = performance.now()
    const head = await rangeRead(url, 0, REEL_HEAD - 1, reqs)
    const total = head.total || head.buf.length
    // The top-level boxes up to the moov: in the head, or after the media data.
    const boxAt = async (p) => {
      let b = head.buf
      let o = p
      if (p + 16 > b.length) { b = (await rangeRead(url, p, Math.min(total, p + 16) - 1, reqs)).buf; o = 0 }
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
      let size = dv.getUint32(o)
      if (size === 1) size = Number(dv.getBigUint64(o + 8))
      else if (size === 0) size = total - p
      return { type: String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), size }
    }
    let p = 0
    let moov = null
    for (let i = 0; p < total && i < 32 && !moov; i++) {
      const box = await boxAt(p)
      if (box.size < 8) break
      if (box.type === 'moov') moov = { at: p, size: box.size }
      p += box.size
    }
    if (!moov) throw new Error('no moov box')
    if (moov.size > REEL_MAX_MOOV) throw new Error(`index of ${Math.round(moov.size / 1e6)} MB`)
    // Whatever part of the moov the head missed: only the rest is read.
    let mb
    if (moov.at + moov.size <= head.buf.length) mb = head.buf.subarray(moov.at, moov.at + moov.size)
    else if (moov.at < head.buf.length) {
      const rest = (await rangeRead(url, head.buf.length, moov.at + moov.size - 1, reqs)).buf
      mb = new Uint8Array(moov.size)
      mb.set(head.buf.subarray(moov.at))
      mb.set(rest, head.buf.length - moov.at)
    } else mb = (await rangeRead(url, moov.at, moov.at + moov.size - 1, reqs)).buf
    const track = mp4VideoTrack(mb, { body: new DataView(mb.buffer, mb.byteOffset).getUint32(0) === 1 ? 16 : 8, end: mb.length })
    if (!track) throw new Error('no video track')
    let keys = []
    for (const f of steps) {
      const k = track.keyAtOrBefore(track.sampleAt(Math.floor(f * track.duration)))
      if (!keys.includes(k)) keys.push(k)
    }
    // Short clips can have one or two keyframes in the whole file: the reel
    // would repeat them, and the clip plays instead (playShow). Three or more
    // make a reel, even with fewer scenes than asked: each one shows at once,
    // while seeking took over a second a scene (8 keyframes for 20 scenes
    // went to seeking, half the scenes late). Past the hardware decoder any
    // keyframes beat decoding up to every scene on the CPU.
    const need = Math.min(steps.length, 3)
    if (keys.length < need && !pastDecoder(track.width, track.height, track.duration ? track.samples * track.timescale / track.duration : 0)) {
      throw Object.assign(new Error(`only ${keys.length} keyframes for ${steps.length} scenes`), { sparse: true, duration: track.duration / track.timescale })
    }
    let places = keys.map(k => track.place(k))
    if (places.some(pl => !pl)) throw new Error('a keyframe outside the chunk table')
    // Heavy frames (4K): every other one until they fit. None is null past the check above.
    while (keys.length > 2 && places.reduce((sum, pl) => sum + (pl)[1], 0) > REEL_MAX_BYTES) {
      keys = keys.filter((k, i) => i % 2 === 0)
      places = places.filter((pl, i) => i % 2 === 0)
    }
    const frames = await Promise.all((places).map(([off, size]) => rangeRead(url, off, off + size - 1, reqs).then(r => r.buf)))
    const secs = track.duration / track.timescale
    return {
      frames,
      track: { stsd: track.stsd, width: track.width, height: track.height },
      avcC: avcConfig(track.stsd),
      url: null,   // the <video> reel's blob, made when first played (reelUrl)
      scenes: keys.map(k => {
        const t = track.timeOf(k) / track.timescale
        return { t, f: secs ? t / secs : 0 }
      }),
      bytes: mb.length + frames.reduce((sum, f) => sum + f.length, 0),
      ms: Math.round(performance.now() - t0),
      width: track.width,
      height: track.height,
      duration: secs,
      fps: secs ? track.samples / secs : 0,
    }
  }

  // A reel for one of these URLs (the first the host has), kept for the next hold.
  /**
   * @param hash  the file's, to cache the host that has it
   */
  async function reelFor(urls, steps, reqs, hash) {
    for (const url of urls) {
      const key = `${url}|${steps.length}`
      const kept = reels.get(key)
      if (kept) {
        reels.delete(key)
        reels.set(key, kept)
        return { ...kept, ms: 0, kept: true }
      }
      try {
        const reel = await buildReel(url, steps, reqs)
        if (hash) cacheSet('video', hash, url)
        reels.set(key, reel)
        for (const [old, r] of reels) {
          if (reels.size <= REEL_KEEP) break
          if (r.url) URL.revokeObjectURL(r.url)
          reels.delete(old)
        }
        return reel
      } catch (e) {
        if (!(e).status || urls.indexOf(url) === urls.length - 1) throw e   // HTTP error: try the next host
      }
    }
    throw new Error('no host has the file')
  }

  // The reel slideshow's own parts: requests in flight, the scene timer, and
  // what shows the reel (a <video> or a canvas, in a holder over the card).

  function startReelShow(s) {
    if (typeof GM_xmlhttpRequest !== 'function') return false
    const pic = cardPicture(s.card)
    if (!pic) return false
    const hash = (thumbParts(pic.src) || {}).hash
    const cover = s.card.querySelector('video[data-ibh]')
    const known = (cover && cover.currentSrc) || (hash && cacheGet('video', hash))
    if (known && !/\.mp4(?:[?#]|$)/i.test(known)) return false   // WebM: seek
    const urls = known ? [known] : fileCandidates(pic.src, ['mp4'])
    if (!urls.length) return false
    freeForPreview(s.card)
    scrubUi(s)
    s.label.textContent = '…'
    s.dwell = (Number(CFG.slideDwell) || 0.2) * 1000
    s.stats.method = 'reel'
    s.reel = { reqs: new Set(), timer: 0, video: null, holder: null, borrowed: false }
    // Compiling the decoder takes about half a second: alongside the reads, not after them.
    if (CFG.wasmDecode && !h264Broken) h264Decoder().catch(() => { /* logged there */ })
    reelFor(urls, slideSteps(), s.reel.reqs, known ? null : hash).then(
      reel => { if (scrub === s) showReel(s, reel) },
      e => { if (scrub === s) reelFailed(s, e) })
    return true
  }

  const reelUrl = (reel) => reel.url || (reel.url = URL.createObjectURL(reelBlob(reel.track, reel.frames)))

  // One keyframe per scene, looping, over the thumbnail (and its cover):
  // decoded in WebAssembly when it can, else played from a small MP4.
  function showReel(s, reel) {
    (s.reel).info = reel   // set by startReelShow, cleared only once this hold is over
    markDuration(s.card, reel.duration)
    if (pastDecoder(reel.width, reel.height, reel.fps)) markPastDecoder(s.card, `${reel.width}x${reel.height} at ${Math.round(reel.fps)} fps`)
    s.stats.detail = `${reel.width}x${reel.height}, ${mmss(reel.duration)}, ${reel.scenes.length} keyframes, ` +
      `${Math.round(reel.bytes / 1024)} KB, ${reel.kept ? 'kept from before' : `read in ${reel.ms} ms`}`
    if (CFG.wasmDecode && reel.avcC && !h264Broken) showReelWasm(s, reel).catch(e => { if (scrub === s) wasmFailed(s, reel, e) })
    else showReelVideo(s, reel)
  }

  function showReelVideo(s, reel) {
    const r = s.reel
    borrowDecoder(s.card)
    r.borrowed = true
    r.holder = document.createElement('div')
    r.holder.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2'
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:4px;background:#000'
    r.video = v
    r.holder.appendChild(v)
    placeOverPicture(s.card, r.holder)
    let i = 0
    const show = () => { if (scrub === s) v.currentTime = i + 0.5 }   // inside sample i: that keyframe
    v.addEventListener('seeked', () => {
      if (scrub !== s) return
      const scene = reel.scenes[i]
      s.bar.style.width = `${scene.f * 100}%`
      s.label.textContent = `${mmss(scene.t)} / ${mmss(reel.duration)}`
      noteScene(s)
      i = (i + 1) % reel.scenes.length
      r.timer = setTimeout(show, s.dwell)
    })
    v.addEventListener('loadedmetadata', show, { once: true })
    v.onerror = () => { if (scrub === s) reelFailed(s, new Error('the reel would not play')) }
    v.src = reelUrl(reel)
  }

  // The decoder has one stream open at a time: the hold slideshow's reel or
  // the seek bar's. Opened again only when it changes.
  let h264Stream = null
  function openStream(x, reel) {
    if (h264Stream === reel) return
    h264Stream = null
    const cfg = x.buf_alloc(reel.avcC.length)
    new Uint8Array(x.memory.buffer, cfg, reel.avcC.length).set(reel.avcC)
    const opened = x.dec_open(cfg, reel.avcC.length)
    x.buf_free(cfg)
    if (opened !== 0) throw new Error(`the decoder refused the stream (${opened})`)
    h264Stream = reel
  }

  async function showReelWasm(s, reel) {
    const x = await h264Decoder()
    if (scrub !== s) return
    openStream(x, reel)
    s.stats.method = 'wasm reel'
    const r = s.reel   // the scrub is still on: endReel has not run
    const maxW = Math.round(s.card.getBoundingClientRect().width * (window.devicePixelRatio || 1))
    const times = []
    const decode = (i) => {
      const t0 = performance.now()
      const img = decodeKeyframe(x, reel.frames[i], maxW)
      times.push(performance.now() - t0)
      s.stats.wasm = `decoded in ${Math.round(times.reduce((a, b) => a + b, 0) / times.length)} ms (max ${Math.round(Math.max(...times))}) to ${img.width}x${img.height}`
      return img
    }
    let next = decode(0)   // a failure here falls back before anything is shown
    r.holder = document.createElement('div')
    r.holder.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2'
    const cv = document.createElement('canvas')
    cv.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:4px;background:#000'
    r.holder.appendChild(cv)
    placeOverPicture(s.card, r.holder)
    const ctx = cv.getContext('2d')   // a new canvas always has one
    let i = 0
    // Show this scene, then decode the next while it stays on screen.
    const show = () => {
      if (scrub !== s) return
      if (cv.width !== next.width || cv.height !== next.height) { cv.width = next.width; cv.height = next.height }
      ctx.putImageData(next, 0, 0)
      const scene = reel.scenes[i]
      s.bar.style.width = `${scene.f * 100}%`
      s.label.textContent = `${mmss(scene.t)} / ${mmss(reel.duration)}`
      noteScene(s)
      i = (i + 1) % reel.scenes.length
      const t0 = performance.now()
      try { next = decode(i) } catch (e) { wasmFailed(s, reel, e); return }
      r.timer = setTimeout(show, Math.max(0, s.dwell - (performance.now() - t0)))
    }
    show()
  }

  // The WebAssembly path failed on this video: the same reel in a <video>.
  function wasmFailed(s, reel, e) {
    const r = s.reel
    if (!r) return
    s.stats.wasm = `not decoded: ${describeError(e)}`
    clearTimeout(r.timer)
    if (r.holder) { r.holder.remove(); r.holder = null }
    s.stats.method = 'reel'
    showReelVideo(s, reel)
  }

  function endReel(s) {
    const r = s.reel
    if (!r) return
    s.reel = null
    clearTimeout(r.timer)
    for (const req of r.reqs) { try { req.abort() } catch (e) { /* done already */ } }
    if (r.video) { r.video.onerror = null; r.video.removeAttribute('src'); r.video.load() }   // the blob stays kept
    if (r.holder) r.holder.remove()
    if (r.borrowed) returnDecoder()
  }

  // Anything off (WebM behind an .mp4 name, an odd file, a host failing):
  // the slideshow seeks the file as before, or plays it when it is a short clip.
  // e.sparse: too few keyframes in a clip of e.duration seconds.
  function reelFailed(s, e) {
    s.stats.reelError = e.message
    endReel(s)
    if (!scrubSource(s)) { endScrub(); return }
    if (e.sparse && (e.duration) <= PLAY_MAX_S) playShow(s)   // buildReel sets both
    else chooseShow(s)
  }

  // src/modal/open.ts
  // Opening, closing and stepping the modal; the next post loaded ahead.

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
    modal.tabComments.textContent = t('tabComments')   // its count is per post
    if (!modal.sheet.hidden) renderSheet(link, seq)   // the menu follows the post
    modal.score.textContent = ''
    const list = modalLinks()
    modal.count.textContent = `${list.indexOf(link) + 1} / ${list.length}`
    modal.status.textContent = t('mLoading')
    modal.status.hidden = false

    let kind = thumbKind(thumb)
    const hash = (thumbParts(pic.src)).hash   // checked on the way in
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

  /** @param fromBack   the back button closed it: its history entry is gone already */
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
    markedCards('[data-ibh-cover]').forEach(card => { unmountCover(card); n.covers++ })
    markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach(card => { stopGif(card); n.gifs++ })
    originalQueue.length = 0
    markedImages('[data-ibh-orig]').forEach(el => {
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
    markedCards('[data-ibh-seen]').forEach(card => {
      if (CFG.videoCovers && isVideoCard(card)) mountCover(card)
      else if (CFG.gifInline && isGifCard(card)) playGif(card)
    })
  }

  /** @param dir   1 the next post, -1 the previous */
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
  // The post ahead: an image's winning probe (img, decoded once decoded), or
  // a video's metadata probe; release gives the download slot back, cancel
  // calls the race off.
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
      // release: set just above.
      a.cancel = raceImage(stages, cached, img => {
        (a.release)()
        a.img = img
        cacheSet(kind, hash, img.src, cached)
        const decoded = typeof img.decode === 'function' ? img.decode().catch(() => {}) : Promise.resolve()
        decoded.then(() => { if (ahead === a) a.decoded = true })
      }, () => {
        (a.release)()
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
  // img: set before decoded.
  function aheadReady(link) {
    return ahead && ahead.link === link && ahead.decoded && (ahead.img).naturalWidth ? (ahead.img).src : null
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
  // from an inline handler).
  function onSiteLinkClick(ev) {
    if (ev.defaultPrevented || ev.button !== 0) return
    // SITE_LINK ends in a: the link.
    const link = asElement(ev.target)?.closest(SITE_LINK)
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

  // src/diag.ts
  // ═══════════════════════════════════════════════════════════
  // On-demand diagnostics
  // ═══════════════════════════════════════════════════════════

  /** Test every candidate URL of the first video card and log the outcome. */
  function probeVideoUrls() {
    // Prefer a card that is on screen, so the result matches what you see.
    const cards = siteLinks().filter(isVideoCard)
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
      const done = (ok) => {
        v.src = ''
        log(ok ? 'info' : 'warn', `${ok ? 'OK  ' : 'FAIL'} ${url}`)
      }
      v.addEventListener('loadedmetadata', () => done(true), { once: true })
      v.addEventListener('error', () => done(false), { once: true })
      v.src = url
    })
  }

  /**
   * Put an upgraded element back to its thumbnail and clear its upgrade state.
   */
  function resetUpgrade(el) {
    if (el.dataset.ibhOrig === 'done' && el.dataset.ibhThumb) {
      const pic = pictureOf(el)
      if (pic) pic.set(el.dataset.ibhThumb)
    }
    delete el.dataset.ibhOrig
    delete el.dataset.ibhThumb
    if (el.dataset.ibhRaw) {
      delete el.dataset.ibhRaw
      delete el.dataset.ibhPreRaw
      delete el.dataset.ibhPreShown
      delete el.dataset.ibhRawMarked
      const badge = el.closest('a') && (el.closest('a')).querySelector('.ibh-rawbadge')   // the && just checked it
      if (badge) badge.remove()
    }
  }

  // Other tabs of the same site running the script hear the Free memory
  // button through this channel. Without any @grant there is no storage shared
  // between sites, so tabs of another site are out of reach; a hidden tab
  // parks its covers and GIFs by itself (see D).
  const tabChannel = 'BroadcastChannel' in window ? new BroadcastChannel('ibh') : null

  /**
   * Give back the memory this script holds on the page: decoded GIFs,
   * covers, upgraded images, keyframe reels, the site's Cache Storage. What
   * is on screen comes back at once from the browser's HTTP cache, which no
   * page script can reach; the URL cache and the image host are kept, since
   * they are what brings it back without walking the ladders again (they
   * hold no memory to speak of). Settings (IBH_CFG) and the site login are
   * left alone. `reason`: 'button' (this tab and every other tab of the
   * site), 'tab' (asked by another tab), 'redo' (this tab only, before Redo
   * thumbnails, which restarts the cards itself).
   */
  async function freeMemory(reason = 'button') {
    // The button frees every tab of this site running the script, not only this one.
    if (reason === 'button' && tabChannel) tabChannel.postMessage({ type: 'free-memory' })
    for (const r of reels.values()) if (r.url) URL.revokeObjectURL(r.url)   // kept keyframe reels
    reels.clear()
    dropH264()
    const n = { covers: 0, gifs: 0, images: 0, caches: 0 }
    // A preview in progress holds one or two videos; the shared one is dropped.
    if (scrub) endScrub()
    previewStop()
    setPreviewEl(null)
    dropAhead()
    favLookups.clear()
    postInfos.clear()
    coverQueue.clear()   // first, or each unmount hands its slot to a queued card
    markedCards('[data-ibh-cover]').forEach(card => { unmountCover(card); n.covers++ })
    // Animated GIFs keep every decoded frame; back to the still. Ones still
    // loading are dropped too.
    markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach(card => { stopGif(card); n.gifs++ })
    // Undo sample/original upgrades, queued and in flight included, and watch
    // again: what is on screen comes back from the HTTP cache, the rest only
    // when it scrolls in.
    setUpgradeGen(upgradeGen + 1)
    originalQueue.length = 0
    markedImages('[data-ibh-orig]').forEach(el => {
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
    if (!(modal && modal.open)) suspended.length = 0
    // What is on screen comes back now, freshly decoded, nearest the middle
    // first; the rest when it scrolls in. Not before ↻, which restarts every
    // card itself, nor under the modal or in a hidden tab, which bring their
    // cards back when they end. The options decide, as wherever a card comes
    // back (resumePage): a "video" that proved a GIF goes through mountCover,
    // which plays it only with inline GIFs on.
    if (reason !== 'redo' && !document.hidden && !(modal && modal.open)) {
      const seen = [...markedCards('[data-ibh-seen]')].sort((a, b) => fromMiddle(a) - fromMiddle(b))
      for (const card of seen) {
        if (CFG.videoCovers && isVideoCard(card)) mountCover(card)
        else if (CFG.gifInline && isGifCard(card)) playGif(card)   // past the limit it queues
      }
    }
    try {
      if (window.caches) {
        const keys = await caches.keys()
        await Promise.all(keys.map(k => caches.delete(k)))
        n.caches = keys.length
      }
    } catch (e) {
      warn(`could not clear Cache Storage — ${describeError(e)}`)
    }
    info(`freed ${n.covers} covers, ${n.gifs} GIFs, ${n.images} upgraded images${reason === 'tab' ? ' (asked by another tab)' : reason === 'redo' ? ' (before redoing the thumbnails)' : ''}; ` +
      `${n.caches} Cache Storage entries cleared; URL cache and image host kept`)
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
    markedImages('[data-ibh-orig]').forEach(el => {
      resetUpgrade(el)
      // observe() reports elements already on screen at once, so they upgrade now.
      if (originalViewport) originalViewport.observe(el)
      else upgradeToOriginal(el)
      n.images++
    })
    markedCards('[data-ibh-cover]').forEach(card => unmountCover(card))
    coverQueue.clear()
    markedCards('[data-ibh-gif]').forEach(card => { stopGif(card); delete card.dataset.ibhGif })
    // Forget which video cards turned out to be GIFs, so they get a fresh try.
    knownGifs.clear()
    markedCards('[data-ibh-kind]').forEach(card => { delete card.dataset.ibhKind })
    markedCards('[data-ibh-seen]').forEach(card => {
      if (CFG.videoCovers && isVideoCard(card)) { mountCover(card); n.covers++ }
      else if (CFG.gifInline && isGifCard(card)) { playGif(card); n.gifs++ }
    })
    // Pick up thumbnails added since the last scan (autopager, search results).
    scanCards(document)
    scanThumbs(document)
    info(`redo thumbnails: ${n.images} images re-queued, ${n.covers} covers and ${n.gifs} GIFs restarted, ${misses} cached misses dropped`)
    touch()
  }

  function logSnapshot() {
    info(`v${VERSION} on ${SITE} · ui=${LANG}`)
    dbg(`userAgent: ${navigator.userAgent}`)
  }

  // src/page/bulk.ts
  // ── Mass favorite ──
  // ♥ next to 🕒 turns a mode on where a tap on a thumbnail favorites and
  // upvotes the post on the spot (like the site's own heart does) instead of
  // opening it, and marks the thumbnail. Tap ♥ again to leave.
  const HEART_ICON = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'
  let bulkMode = false

  const wantsBulkButton = () => !!CFG.bulkFavButton && SITE === 'rule34.xxx' && !!userId() && !!document.querySelector(SITE_LINK)

  function setBulkMode(on) {
    bulkMode = on
    const heart = control('.bulkfab')
    if (heart) heart.classList.toggle('on', on)
    pageToast(t(on ? 'bulkOn' : 'bulkOff'))
    info(`mass favorite ${on ? 'on' : 'off'}`)
  }

  let pageToastTimer = 0
  function pageToast(text) {
    if (!shadow) return
    let toast = control('.pagetoast')
    if (!toast) { toast = el('div', { class: 'pagetoast' }); shadow.appendChild(toast) }
    toast.textContent = text
    toast.style.opacity = '1'
    clearTimeout(pageToastTimer)
    pageToastTimer = setTimeout(() => { toast.style.opacity = '0' }, 2200)
  }

  // A mark on the thumbnail: ♥ done, … working, ✕ failed.
  /**
   * @param tone    its background
   */
  function bulkBadge(link, text, tone, cls = 'ibh-bulkbadge') {
    let badge = link.querySelector(`.${cls}`)   // made below
    if (!badge) {
      badge = document.createElement('span')
      badge.className = cls
      badge.dataset.ibhUi = '1'   // the site theme leaves it alone
      if (getComputedStyle(link).position === 'static') link.style.position = 'relative'
      link.appendChild(badge)
    }
    badge.textContent = text
    badge.style.background = tone
    return badge
  }

  /** @param via  for the log */
  async function bulkFavorite(link, via = 'mass favorite') {
    const id = postId(link)
    if (link.dataset.ibhBulk) return   // done or in progress
    link.dataset.ibhBulk = '1'
    bulkBadge(link, '…', 'rgba(15, 20, 23, .85)')
    try {
      const { code } = await favoritePost(id, false)
      if (code === '2') { bulkBadge(link, '✕', '#b42318'); pageToast(t('favLogin')); delete link.dataset.ibhBulk; return }
      if (code !== '3' && code !== '1') throw new Error(`answer ${code.slice(0, 20)}`)
      await upvotePost(id)
      // The corner ❤️ (afterFavorite painted it) says it; without it, the ♥ badge.
      if (wantsLiked()) link.querySelector('.ibh-bulkbadge')?.remove()
      else bulkBadge(link, '♥', '#e5534b')
      info(`${via}: post ${id} ${code === '3' ? 'favorited' : 'was a favorite'}, upvoted`)
    } catch (e) {
      delete link.dataset.ibhBulk
      bulkBadge(link, '✕', '#b42318')
      warn(`${via}: post ${id} failed — ${describeError(e)}`)
    }
  }

  // Registered before the modal's click handler, so a tap favorites instead.
  function onBulkClick(ev) {
    if (!bulkMode || ev.button !== 0) return
    // SITE_LINK ends in a: the link.
    const link = asElement(ev.target)?.closest(SITE_LINK)
    if (!link) return
    ev.preventDefault()
    ev.stopImmediatePropagation()
    bulkFavorite(link)
  }

  // src/panel/nav.ts
  // The host is often mounted while the page is still parsing, before the
  // post list exists, so the buttons are added whenever the list shows up.
  // Runs on every mutation batch, so it only rebuilds when the set of buttons
  // the page needs has changed (e.g. the post list arrived after the host).
  function ensureFeedNav() {
    if (!shadow) return
    const feed = wantsFeedButtons()
    const free = !!CFG.freeButton
    const redo = !!CFG.redoButton
    const want = `${feed ? 'f' : ''}${free ? 'c' : ''}${redo ? 'r' : ''}`
    let nav = control('.feednav:not(.pagenav)')
    if (nav && nav.dataset.set !== want) { nav.remove(); nav = null }
    if (!nav && want) {
      nav = buildFeedNav(feed, free, redo)
      nav.dataset.set = want
      shadow.appendChild(nav)
      dbg(`buttons added: ${feed ? 'feed ' : ''}${free ? 'free' : ''}`.trim())
    }
    // Your favorites: top right, beside ♥ and 🕒.
    let favs = control('.favsfab')
    const wantFavs = !!CFG.favsButton && SITE === 'rule34.xxx' && !!userId()
    if (favs && !wantFavs) { favs.remove(); favs = null }
    if (!favs && wantFavs) {
      favs = iconButton('laterfab favsfab', t('navFavs'), BOOKMARK_ICON)
      favs.addEventListener('click', () => {
        info('going to your favorites')
        location.href = `index.php?page=favorites&s=view&id=${userId()}`
      })
      shadow.appendChild(favs)
    }
    // Top right, packed from the edge in this order (🕒, ♥, 🔖), whichever show.
    const packRight = () => {
      [control('.clockfab'), control('.bulkfab'), control('.favsfab')].filter(btn => btn !== null)
        .forEach((btn, i) => { btn.style.right = `${12 + i * 52}px` })
    }
    // Mass favorite: next to Watch later, top right.
    let heart = control('.bulkfab')
    if (heart && !wantsBulkButton()) { heart.remove(); heart = null; if (bulkMode) setBulkMode(false) }
    if (!heart && wantsBulkButton()) {
      heart = iconButton('laterfab bulkfab', t('navBulk'), HEART_ICON)
      heart.classList.toggle('on', bulkMode)
      heart.addEventListener('click', () => setBulkMode(!bulkMode))
      shadow.appendChild(heart)
    }
    // Watch later: a button of its own in the top-right corner.
    let clock = control('.clockfab')
    if (clock && !wantsLaterButton()) { clock.remove(); clock = null }
    if (!clock && wantsLaterButton()) {
      clock = iconButton('laterfab clockfab', t('navLater'), CLOCK_ICON)
      clock.addEventListener('click', () => showLater())
      shadow.appendChild(clock)
    }
    packRight()
    // 👁: bottom left, beside ◐ (in its place when the panel is off).
    let eye = control('.eyefab')
    if (eye && !CFG.eyeButton) { eye.remove(); eye = null }
    if (!eye && CFG.eyeButton) {
      eye = iconButton('eyefab', t('eyeHide'), EYE_ICON)
      eye.classList.toggle('solo', !CFG.panel)
      eye.addEventListener('click', () => setButtonsHidden(!CFG.buttonsHidden))
      shadow.appendChild(eye)
    }
    applyButtonsHidden()
    let pages = control('.pagenav')
    if (pages && !feed) { pages.remove(); pages = null }
    if (!pages && feed) { pages = buildPageNav(); shadow.appendChild(pages) }
    // The paginator comes after the post list in the page, so its state is
    // refreshed as the page fills in rather than fixed when the buttons appear.
    if (pages) {
      const prev = pages.querySelector('.pp')   // buildPageNav's buttons
      const next = pages.querySelector('.np')
      prev.disabled = !pageTarget(-1)
      next.disabled = !pageTarget(1)
    }
  }

  const wantsFeedButtons = () => CFG.feedNav && CFG.nativeFeed && !!document.querySelector(FEED_POST)

  // ‹ › buttons for the one-column feed: jump to the start of the previous or
  // next post, e.g. to skip a long comic without scrolling through it.
  const FEED_POST = THUMB

  /** @param dir   1 the next post, -1 the previous */
  function jumpPost(dir) {
    const posts = [...document.querySelectorAll(FEED_POST)]
    if (!posts.length) return
    // By position on screen, not page order: in columns the order runs down
    // each column. Next: the nearest post starting below the top edge.
    // Previous: the nearest starting above it (inside a long post that is its
    // own start, at a post's start it is the one before).
    let target = null
    let best = dir > 0 ? Infinity : -Infinity
    for (const post of posts) {
      const top = post.getBoundingClientRect().top
      if (dir > 0 ? top > 8 && top < best : top < -8 && top > best) { best = top; target = post }
    }
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
      const a = [...box.querySelectorAll('a')].find(x => want.test((x.textContent || '').trim()) || want.test(x.getAttribute('alt') || ''))
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

  // Material Design's "bookmark" icon, as path data.
  const BOOKMARK_ICON = 'M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z'

  // Material Design's "refresh" icon, as path data.
  const REDO_ICON = 'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z'

  // ↻: Free memory first, then every thumbnail starts over, failures
  // included (the URL cache forgets its misses and keeps its winners). Only
  // this tab: other tabs keep what they show.
  function redoButton() {
    const btn = iconButton('trash', t('navRedo'), REDO_ICON)   // the trash can's look
    btn.addEventListener('click', () => {
      btn.classList.add('on')
      btn.disabled = true
      freeMemory('redo').then(() => redoThumbs()).finally(() => {
        setTimeout(() => { btn.classList.remove('on'); btn.disabled = false }, 400)
        renderStatus()
      })
    })
    return btn
  }

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

  // Material Design's "visibility" and "visibility off" icons, as path data.
  const EYE_ICON = 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z'
  const EYE_OFF_ICON = 'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z'

  // 👁: hides every other floating button (◐ and the panel too) for a page
  // with nothing over it, and brings them back. Remembered across pages.
  function setButtonsHidden(hidden) {
    if (hidden) {
      if (bulkMode) setBulkMode(false)   // its ♥ goes away: no tap may favorite unseen
      if (panelOpen) togglePanel(false)
    }
    setCfg('buttonsHidden', hidden)
    applyButtonsHidden()
  }

  // The hiding is a class on the host, read by PANEL_CSS; without the eye
  // nothing stays hidden. Runs on every DOM change: only acts on a change.
  function applyButtonsHidden() {
    const eye = control('.eyefab')
    if (!eye) { if (panelHost) panelHost.classList.remove('ibh-clean'); return }
    const hidden = !!CFG.buttonsHidden
    if (eye.dataset.hidden === String(hidden)) return
    eye.dataset.hidden = String(hidden)
    ;(panelHost).classList.toggle('ibh-clean', hidden)   // the eye is in its shadow
    eye.title = t(hidden ? 'eyeShow' : 'eyeHide')
    const icon = eye.querySelector('path')   // iconButton's
    icon.setAttribute('d', hidden ? EYE_OFF_ICON : EYE_ICON)
  }

  // Material Design's "watch later" icon (a clock), as path data.
  const CLOCK_ICON = 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm4.2 14.2L11 13V7h1.5v5.2l4.5 2.7-.8 1.3z'

  /** @param d   the icon's path data */
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

  function buildFeedNav(feed, free, redo) {
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
    if (redo) second.push(redoButton())
    if (second.length) rows.push(el('div', { class: 'row' }, second))
    return el('div', { class: 'feednav' }, rows)
  }

  // « » page buttons: top left, across from 🕒 and ♥ on the right.
  function buildPageNav() {
    const prevPage = el('button', { class: 'pp', text: '«', title: t('navPrevPage') })
    const nextPage = el('button', { class: 'np', text: '»', title: t('navNextPage') })
    prevPage.addEventListener('click', () => goPage(-1))
    nextPage.addEventListener('click', () => goPage(1))
    return el('div', { class: 'feednav pagenav' }, [el('div', { class: 'row' }, [prevPage, nextPage])])
  }

  // src/page/feed-css.ts
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
      ${THUMB} a { display: block !important; position: relative; }
      ${LIST} > br { display: none !important; }
      /* Post page: the image carries width="850" and the video a fixed box. */
      #image, #gelcomVideoPlayer { max-width: 100% !important; height: auto !important; }`
    if (!auto && Number(cols) <= 1) return `
      ${LIST} { display: flex !important; flex-direction: column !important;
        flex-wrap: nowrap !important; align-items: stretch !important; gap: 14px !important; }
      ${ITEM} { display: block !important; width: 100% !important; max-width: none !important;
        height: auto !important; max-height: none !important; }
      ${THUMB} { display: block !important; width: 100vw !important; height: auto !important;
        max-width: none !important; max-height: none !important; min-height: 0 !important;
        margin: 0 calc(50% - 50vw) !important; }
      ${THUMB} img { display: block; width: 100% !important; height: auto !important;
        max-width: none !important; max-height: none !important; }` + common
    const item = `
      ${ITEM} { display: block !important; width: 100% !important; max-width: none !important;
        height: auto !important; max-height: none !important; margin: 0 !important; }
      ${THUMB} { display: block !important; width: 100% !important; height: auto !important;
        max-width: none !important; max-height: none !important; min-height: 0 !important; margin: 0 !important; }`
    if (CFG.feedLayout === 'grid') return `
      ${LIST} { display: grid !important; gap: 6px !important; grid-template-columns: ${auto
        ? `repeat(auto-fill, minmax(${FEED_COL_MIN}px, 1fr))` : `repeat(${Number(cols)}, minmax(0, 1fr))`} !important; }
      ${item}
      ${THUMB} img { display: block; width: 100% !important; height: auto !important;
        aspect-ratio: 1 / 1; object-fit: cover; max-width: none !important; max-height: none !important; }` + common
    return `
      ${LIST} { display: block !important; column-gap: 6px !important;
        ${auto ? `column-width: ${FEED_COL_MIN}px` : `column-count: ${Number(cols)}`} !important; }
      ${item}
      ${ITEM} { break-inside: avoid !important; margin-bottom: 6px !important; }
      ${THUMB} img { display: block; width: 100% !important; height: auto !important;
        max-width: none !important; max-height: none !important; }` + common
  }

  let feedCssShown = null

  // Keeps the feed's <style> in step with the options, putting it back if it
  // goes missing. Unchanged CSS is not rewritten (this runs on every DOM
  // change).
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
    const anchor = [...document.querySelectorAll(THUMB)]
      .find(el => el.getBoundingClientRect().bottom > 0)
    applyFeed()
    if (anchor) anchor.scrollIntoView({ block: 'start' })
    if (CFG.nativeFeed) scanThumbs(document)
    ensureFeedNav()
    info(`feed ${CFG.nativeFeed ? `on: ${CFG.feedColumns} columns, ${CFG.feedLayout}` : 'off'} (switched from the panel)`)
  }

  // src/page/theme.ts
  // ── Themes ──
  // One look for the site's pages, the panel and the post viewer, picked in
  // the panel (theme). Every colour the script paints with is a CSS variable
  // (--ibh-…) set on the page's root, and variables reach into the panel's
  // and the viewer's shadow DOM too: a new theme repaints all of it at once.
  // "site" leaves the site's pages as the site draws them; the panel and the
  // viewer then wear the site's own theme (PROFILE.theme). Colours that mean
  // something (the tag kinds, errors, warnings) stay the same in every theme.
  const THEMES = ['normal', 'gelbooru', 'oled', 'gray', 'qtmp', 'site']

  // The slate ground the script has always had; normal and gelbooru share it.
  const SLATE = {
    bg: '#182125', base: '#0f1417', baseRgb: '15, 20, 23', deep: '#0a0e10', surface: '#26363c', menu: '#1f2b30',
    edge: '#2a3a3f', edgeSoft: '#1c272b', text: '#e6eef0', text2: '#d7dee0', dim: '#7f9aa0', dim2: '#a8b8bb', faint: '#4e6469',
  }
  // Teal accents and neon green lines.
  const TEAL = {
    tint: '#16211f', accentEdge: '#234a45', accent: '#5eead4', accentHover: '#99f6e4', line: '#39ff14',
    accentDark: '#1d3b38', accentMid: '#2f7d72', glow: 'rgba(57, 255, 20, .35)',
  }

  const PALETTES = {
    normal: { ...SLATE, ...TEAL },
    // gelbooru.com's own blue on the same slate.
    gelbooru: {
      ...SLATE, tint: '#141f2c', accentEdge: '#23405f', accent: '#5aa9ff', accentHover: '#a9d0ff', line: '#2f8cff',
      accentDark: '#1b3552', accentMid: '#2f5f9e', glow: 'rgba(47, 140, 255, .35)',
    },
    // Pure black grounds, which an OLED screen leaves dark; normal's accents.
    oled: {
      ...TEAL, bg: '#000000', base: '#000000', baseRgb: '0, 0, 0', deep: '#000000', surface: '#151515', menu: '#101010',
      tint: '#0b1413', edge: '#262626', edgeSoft: '#161616', accentEdge: '#1f3d39',
      text: '#e6eef0', text2: '#d7dee0', dim: '#8a9a9e', dim2: '#a8b8bb', faint: '#56676b',
    },
    // Neutral greys, no hue at all.
    gray: {
      bg: '#202020', base: '#161616', baseRgb: '22, 22, 22', deep: '#111111', surface: '#2e2e2e', menu: '#262626',
      tint: '#1d1d1d', edge: '#3a3a3a', edgeSoft: '#262626', accentEdge: '#4a4a4a',
      text: '#ececec', text2: '#d6d6d6', dim: '#8e8e8e', dim2: '#b4b4b4', faint: '#5c5c5c',
      accent: '#d6d6d6', accentHover: '#ffffff', line: '#6e6e6e', accentDark: '#353535', accentMid: '#5a5a5a', glow: 'rgba(214, 214, 214, .3)',
    },
    // The QtMediaPlayer app's design system, Vulkanic Ashes (dark): grey ash
    // surfaces, white text and actions, the Vulkan blue-violet only as a fill
    // (a selection, an active control), never as text.
    qtmp: {
      bg: '#131313',          // ash-100, the ground
      base: '#131313', baseRgb: '19, 19, 19', deep: '#131313',
      surface: '#313131',     // ash-400, menus: the highest surface
      menu: '#313131',
      tint: '#1a1a1a',        // ash-200, dialogs and the rail
      edge: '#3e3e3e',        // ash-500, hairline edges
      edgeSoft: '#252525',    // ash-300
      accentEdge: '#384589',  // vulkan-indigo
      text: '#ffffff',        // secondaryColor
      text2: '#d0d0d0',       // railLabelColor
      dim: '#9a9a9a',         // secondaryTextColor
      dim2: '#bbbbbb',        // dimTextColor
      faint: '#888888',       // ash-800, progress and state
      accent: '#ffffff',      // secondaryColor: text and the one action that goes ahead
      accentHover: '#d6d6d6', // primaryPressedColor
      line: '#3e3e3e',        // ash-500
      accentDark: '#2d3b6a',  // vulkan-deep, activeColor: a selection under white text
      accentMid: '#384589',   // vulkan-indigo
      glow: 'rgba(56, 69, 137, .6)',
    },
  }

  // The palette as the root's variables: accentHover is --ibh-accent-hover.
  const variables = (palette) =>
    Object.entries(palette).map(([key, value]) => `--ibh-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}: ${value};`).join(' ')

  // The site's pages in the theme: backgrounds go transparent over the dark
  // page (images, videos and icons keep theirs), light text, accent links and
  // controls, the tag kinds in the tags menu's colours. All of it hangs on
  // html.ibh-theme, which applySiteTheme() sets unless the theme is "site".
  // The thumbnails' blue video frame is left alone.
  const THEME_CSS = `
    html.ibh-theme, html.ibh-theme body { background: var(--ibh-bg) !important; color: var(--ibh-text) !important; }
    html.ibh-theme body *:not(img):not(video):not(canvas):not(iframe):not(svg):not(path):not([data-ibh-ui]) {
      background-color: transparent !important; border-color: var(--ibh-line) !important; }
    html.ibh-theme body *:not(a):not(img):not(video):not(svg):not(path):not([data-ibh-ui]) { color: var(--ibh-text) !important; }
    html.ibh-theme a, html.ibh-theme a:visited, html.ibh-theme summary { color: var(--ibh-accent) !important; }
    html.ibh-theme a:hover { color: var(--ibh-accent-hover) !important; }
    html.ibh-theme li[class*="tag-type-artist"] a { color: #f2ac08 !important; }
    html.ibh-theme li[class*="tag-type-character"] a { color: #3fb950 !important; }
    html.ibh-theme li[class*="tag-type-copyright"] a { color: #c678dd !important; }
    html.ibh-theme li[class*="tag-type-metadata"] a { color: #e5534b !important; }
    /* Lines in the theme's line colour; controls stand on a lighter surface,
       accent text for the ones that act. */
    html.ibh-theme input, html.ibh-theme select, html.ibh-theme textarea, html.ibh-theme button {
      background-color: var(--ibh-surface) !important; color: var(--ibh-text) !important;
      border: 1px solid var(--ibh-line) !important; border-radius: 8px !important; }
    html.ibh-theme input:focus, html.ibh-theme select:focus, html.ibh-theme textarea:focus {
      border-color: var(--ibh-line) !important; outline: none !important; box-shadow: 0 0 0 2px var(--ibh-glow) !important; }
    html.ibh-theme input[type="submit"], html.ibh-theme input[type="button"], html.ibh-theme button {
      background-color: var(--ibh-accent-dark) !important; color: var(--ibh-accent) !important; border-color: var(--ibh-line) !important; font-weight: 600; }
    html.ibh-theme ::placeholder { color: var(--ibh-dim) !important; }
    html.ibh-theme #paginator a, html.ibh-theme #paginator b, html.ibh-theme .pagination a, html.ibh-theme .pagination b {
      display: inline-block; padding: 3px 9px; margin: 2px; border-radius: 8px;
      background-color: var(--ibh-surface) !important; border: 1px solid var(--ibh-line) !important; }
    html.ibh-theme #paginator b, html.ibh-theme .pagination b {
      background-color: var(--ibh-accent) !important; color: var(--ibh-base) !important; border-color: var(--ibh-accent) !important; }
    /* The sites' own suggestion lists (rule34's Awesomplete, gelbooru's jQuery UI) float over the page:
       they need a background back. :not(#ibh) adds an ID's weight, to outrank the broad rule above
       (two classes and eight :not()s); a class alone loses to it, !important or not. */
    html.ibh-theme .awesomplete > ul:not(#ibh), html.ibh-theme .awesomplete > ul:not(#ibh) *,
    html.ibh-theme .ui-autocomplete:not(#ibh), html.ibh-theme .ui-autocomplete:not(#ibh) * { background-color: var(--ibh-surface) !important; }
    html.ibh-theme .awesomplete > ul:not(#ibh) [aria-selected="true"],
    html.ibh-theme .ui-autocomplete:not(#ibh) .ui-state-active { background-color: var(--ibh-accent-dark) !important; }
    /* The mobile layout's ☰ menus float over the page (position: absolute);
       made transparent above, an open one would lay its links over the posts. */
    html.ibh-theme #navbar, html.ibh-theme #subnavbar { background-color: var(--ibh-surface) !important; box-shadow: 0 8px 18px rgba(0, 0, 0, .55); }
    html.ibh-theme #navbar li, html.ibh-theme #subnavbar li { border-color: var(--ibh-edge) !important; }
    html.ibh-theme ::selection { background: var(--ibh-accent-mid); }
    html.ibh-theme hr { border: none !important; border-top: 1px solid var(--ibh-line) !important; }
  `

  let applied = null

  // The theme's variables on the page's root, and html.ibh-theme unless the
  // site's own look was picked. Idempotent: the observer calls it on every
  // change of the page, and the panel when the theme changes.
  function applySiteTheme() {
    const name = THEMES.includes(CFG.theme) ? CFG.theme : PROFILE.theme
    const root = document.documentElement
    let style = document.getElementById('ibh-palette')
    if (name === applied && style && style.isConnected && root.classList.contains('ibh-theme') === (name !== 'site')) return
    if (!style) {
      style = document.createElement('style')
      style.id = 'ibh-palette'   // not data-ibh: injectPageCSS looks for that one
    }
    if (!style.isConnected) (document.head || root).appendChild(style)
    style.textContent = `:root { ${variables(PALETTES[name === 'site' ? PROFILE.theme : name])} }`
    root.classList.toggle('ibh-theme', name !== 'site')
    if (name !== applied) info(`theme: ${name}${name === 'site' ? ` (the site's own pages; panel and viewer in ${PROFILE.theme})` : ''}`)
    applied = name
  }

  // src/panel/panel.ts
  // ═══════════════════════════════════════════════════════════
  // Status panel
  // ═══════════════════════════════════════════════════════════

  // Set and cleared together: shadow is panelHost's shadow root.
  let panelHost = null
  function setPanelHost(v) { panelHost = v }
  let shadow = null
  function setShadow(v) { shadow = v }
  let logBox = null

  // The panel's own elements, found again by class in its shadow root. The
  // script makes each of them (mountPanel, ensureFeedNav, pageToast), so a
  // lookup is typed as what it made.
  function control(sel) {
    return shadow && (shadow.querySelector(sel))
  }
  let statusBox = null
  let panelOpen = false

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }

    .fab {
      position: fixed; left: 12px; bottom: 12px; z-index: 2147483000;
      width: 40px; height: 40px; border-radius: 50%;
      border: 1px solid var(--ibh-edge); background: var(--ibh-base); color: var(--ibh-accent);
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
      border: 1px solid var(--ibh-edge); background: rgba(var(--ibh-base-rgb), .8); color: var(--ibh-accent);
      font-size: 26px; line-height: 1; display: grid; place-items: center;
      padding: 0 0 3px; box-shadow: 0 4px 14px rgba(0,0,0,.5);
    }
    .feednav button:active { background: var(--ibh-tint); }
    .feednav button.on { background: var(--ibh-accent); color: var(--ibh-base); border-color: var(--ibh-accent); }
    .feednav button.trash { display: grid; place-items: center; padding: 0; }
    .feednav button.trash svg { width: 20px; height: 20px; fill: currentColor; }
    /* Top right, against the top edge (lower, they covered the site's
       search field). */
    .laterfab {
      position: fixed; top: 6px; right: 12px; z-index: 2147483000;
      width: 44px; height: 44px; border-radius: 50%; padding: 0; display: grid; place-items: center;
      border: 1px solid var(--ibh-edge); background: rgba(var(--ibh-base-rgb), .8); color: var(--ibh-accent);
      box-shadow: 0 4px 14px rgba(0,0,0,.5);
    }
    .laterfab:active { background: var(--ibh-tint); }
    .laterfab svg { width: 22px; height: 22px; fill: currentColor; }
    .laterfab.bulkfab { right: 64px; }
    .laterfab.favsfab { right: 116px; }
    .feednav.pagenav { top: 6px; bottom: auto; right: auto; left: 12px; }
    .laterfab.on { background: var(--ibh-accent); color: var(--ibh-base); border-color: var(--ibh-accent); }
    /* 👁: bottom left, beside ◐; in its place when the panel is off. */
    .eyefab {
      position: fixed; left: 60px; bottom: 12px; z-index: 2147483000;
      width: 40px; height: 40px; border-radius: 50%; padding: 0; display: grid; place-items: center;
      border: 1px solid var(--ibh-edge); background: rgba(var(--ibh-base-rgb), .8); color: var(--ibh-accent);
      box-shadow: 0 4px 14px rgba(0,0,0,.5);
    }
    .eyefab.solo { left: 12px; }
    .eyefab svg { width: 20px; height: 20px; fill: currentColor; }
    /* Hidden by the eye: every other button, and the eye fades. */
    :host(.ibh-clean) .fab, :host(.ibh-clean) .panel, :host(.ibh-clean) .feednav, :host(.ibh-clean) .laterfab { display: none !important; }
    :host(.ibh-clean) .eyefab { opacity: .4; box-shadow: none; }
    .pagetoast {
      position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%); z-index: 2147483000; max-width: 86vw;
      padding: 8px 14px; border-radius: 18px; background: rgba(var(--ibh-base-rgb), .92); color: var(--ibh-text2);
      font-size: 13px; text-align: center; pointer-events: none; transition: opacity .2s;
    }
    .panel:not([hidden]) ~ .laterfab, .panel:not([hidden]) ~ .bulkfab, .panel:not([hidden]) ~ .favsfab, .panel:not([hidden]) ~ .pagenav { display: none; }
    .feednav button:disabled { opacity: .35; }

    .panel {
      position: fixed; left: 12px; bottom: 60px; z-index: 2147483000;
      width: min(360px, calc(100vw - 24px)); max-height: 70vh;
      display: flex; flex-direction: column;
      background: var(--ibh-base); color: var(--ibh-text2);
      border: 1px solid var(--ibh-edge); border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,.6);
      font-size: 13px;
    }
    .panel[hidden] { display: none; }
    /* The floating buttons sit over the panel's bottom (they covered Reload):
       hidden while it is open. The nav is appended after the panel. */
    .panel:not([hidden]) ~ .feednav { display: none; }

    header {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; border-bottom: 1px solid var(--ibh-edge-soft);
    }
    header b { font-weight: 600; font-size: 13px; color: var(--ibh-text); }
    header span { color: var(--ibh-dim); font-size: 11px; }
    header button {
      margin-left: auto; background: none; border: 0;
      color: var(--ibh-dim); font-size: 18px; line-height: 1; padding: 0 4px;
    }

    .body { overflow-y: auto; padding: 4px 0; }

    .row { display: flex; align-items: baseline; gap: 8px; padding: 5px 12px; }
    .row .k { color: var(--ibh-dim); min-width: 104px; flex-shrink: 0; }
    .row .v { color: var(--ibh-text2); word-break: break-all; }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; }
    /* Scoped to .dot: log lines reuse the level names as classes. */
    .dot.ok   { background: #4ade80; }
    .dot.warn { background: #fbbf24; }
    .dot.bad  { background: #f87171; }
    .dot.idle { background: #475569; }

    .sec {
      padding: 8px 12px 4px; color: var(--ibh-faint); font-size: 11px;
      border-top: 1px solid var(--ibh-edge-soft); margin-top: 4px;
    }

    label.tog { display: flex; align-items: center; gap: 10px; padding: 7px 12px; }
    label.tog input { accent-color: var(--ibh-accent); width: 16px; height: 16px; }
    label.tog .note { margin-left: auto; color: var(--ibh-faint); font-size: 10px; }

    .apiwarn { margin: 4px 12px 6px; padding: 7px 9px; border-radius: 6px; font-size: 11px; line-height: 1.4;
      color: #f5d38a; background: rgba(245, 180, 60, .12); border: 1px solid rgba(245, 180, 60, .35); }
    .lang { padding: 4px 12px 8px; }
    .lang .lbl { color: var(--ibh-faint); font-size: 11px; padding-bottom: 4px; }
    .lang .appstatus { padding: 4px 0 0; }
    .lang select, .lang input.apptoken {
      width: 100%; box-sizing: border-box; padding: 7px 8px; font-size: 12px;
      background: var(--ibh-deep); color: var(--ibh-text2);
      border: 1px solid var(--ibh-accent-edge); border-radius: 6px;
    }

    .acts { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 12px; }
    .acts button {
      flex: 1 1 auto; padding: 7px 10px;
      background: var(--ibh-tint); color: var(--ibh-accent);
      border: 1px solid var(--ibh-accent-edge); border-radius: 6px; font-size: 12px;
    }

    .log {
      margin: 0 12px 12px; padding: 8px; max-height: 190px; overflow-y: auto;
      background: var(--ibh-deep); border: 1px solid var(--ibh-edge-soft); border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px; line-height: 1.5;
    }
    .log div { display: flex; gap: 6px; }
    .log .ts { color: #3c4d51; flex-shrink: 0; }
    .log .ts + span { min-width: 0; overflow-wrap: anywhere; }   /* long URLs wrap */
    .log .debug { color: var(--ibh-dim); }
    .log .info  { color: var(--ibh-dim2); }
    .log .warn  { color: #fbbf24; }
    .log .error { color: #f87171; }
  `

  /**
   * @param attrs   text and class set those; the rest are attributes
   */
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

  // Called by renderStatus, with the status box there.
  function drawStatus() {
    (statusBox).textContent = ''

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
    rows.forEach(r => (statusBox).appendChild(r))
  }

  function appendLogLine(entry) {
    if (!logBox) return
    const time = new Date(entry.t).toTimeString().slice(0, 8)
    logBox.appendChild(el('div', null, [
      el('span', { class: 'ts', text: time }),
      el('span', { class: entry.level, text: entry.msg }),
    ]))
    while (logBox.childElementCount > LOG_MAX) (logBox.firstElementChild).remove()   // past LOG_MAX: there is one
    logBox.scrollTop = logBox.scrollHeight
    if (entry.level === 'error' && shadow) {
      const fab = control('.fab')
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
  /**
   * @param choices   value and label
   */
  function choiceSelect(key, title, choices, then) {
    const sel = el('select')
    for (const [value, label] of choices) {
      const option = el('option', { value: String(value), text: label })
      if (String(CFG[key]) === String(value)) option.setAttribute('selected', '')
      sel.appendChild(option)
    }
    sel.addEventListener('change', () => {
      // One of the options above; its value fits the key, which is the caller's to match.
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
    body.appendChild(toggle('holdRub', t('tHoldRub')))   // also the post's player, whatever the mode
    if (CFG.scrubMode !== 'hold') return
    // The slideshow's own settings only matter without holdVideo.
    body.appendChild(toggle('holdVideo', t('tHoldVideo'), null, rebuildPanel))
    body.appendChild(toggle('previewSound', t('tPreviewSound')))
    body.appendChild(toggle('holdResume', t('tHoldResume')))
    if (CFG.holdVideo) return
    const num = (n) => n.toLocaleString(LANG)
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
      setCfg('lang', (sel.value) || null)   // the options are the languages, or '' for automatic
      setLang(resolveLang())
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
    body.appendChild(choiceSelect('theme', t('tTheme'), [['normal', t('themeNormal')], ['gelbooru', t('themeGelbooru')], ['oled', t('themeOled')],
      ['gray', t('themeGray')], ['qtmp', t('themeQtmp')], ['site', t('themeSite')]], applySiteTheme))
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
  function togglePanel(open) {
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

  function mountPanel() {
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
  function rebuildPanel() {
    if (panelHost) panelHost.remove()
    panelHost = null
    shadow = null
    mountPanel()
  }

  // src/post/votes.ts
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
      afterFavorite(id, fav)
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

  // doubleTapCenter 'like' (Instagram): a double tap in the middle pops a
  // heart and favorites the post, which upvotes it as the ♥ does. One already
  // in the favorites only gets the heart: a double tap never takes it back.
  function modalLike() {
    popHeart(modal.box, 110)
    if (modal.fav.classList.contains('on')) { dbg(`modal: double tap, post ${postId(modal.link)} already a favorite`); return }
    modalFavorite()
  }

  /**
   * The like's ❤️ over `parent` (positioned), `size` px tall at rest (LIKE_CSS).
   */
  function popHeart(parent, size) {
    const heart = el('div', { class: 'ibh-likeheart', 'data-ibh-ui': '', text: '❤️' })   // the site theme leaves it alone
    heart.style.fontSize = `${Math.round(size)}px`
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
    parent.appendChild(heart)
    heart.addEventListener('animationend', () => heart.remove(), { once: true })
    setTimeout(() => heart.remove(), 1500)   // no animation (reduced motion): it still goes
  }

  // A double tap in the middle of the video, or anywhere on an image or GIF.
  function centerDoubleTap() {
    if (CFG.doubleTapCenter === 'like') { modalLike(); return }
    dbg('modal: double tap in the middle, fullscreen')
    toggleModalFullscreen()
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

  // src/modal/gestures.ts
  // The modal's gestures: swipe between posts, pinch zoom, hold an image.

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

  function applyZoom() {
    const img = modal.image
    img.style.transform = zoom.scale === 1 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`
    if (zoom.scale > 1 && modal.isSample && !modal.keepSample) loadModalOriginal()
    // Zoomed, every drag pans the image; at 1x a tall image scrolls natively.
    if (!img.hidden) modal.stage.style.touchAction = zoom.scale > 1 || !modal.stage.classList.contains('tall') ? 'none' : 'pan-y'
  }

  function resetZoom() {
    zoom.scale = 1
    zoom.x = zoom.y = 0
    if (modal) applyZoom()
  }

  // Holding the image half a second opens the ☰ menu (tags, info). Measured
  // on touch events: Firefox for Android cancels the pointer during a long
  // press (see chipGestures). The click the release may send is swallowed,
  // or a hold on the bars around the picture would close the modal.
  const MODAL_HOLD_MS = 500

  function installImageHold(stage, img, box) {
    let hold = null
    let swallowUntil = 0
    const cancel = () => { if (hold) clearTimeout(hold.timer); hold = null }
    stage.addEventListener('touchstart', ev => {
      cancel()
      if (img.hidden || ev.touches.length !== 1 || !modal.sheet.hidden) return
      const finger = ev.touches[0]
      hold = { x: finger.clientX, y: finger.clientY, scale: zoom.scale, timer: 0 }
      hold.timer = setTimeout(() => {
        if (!hold || zoom.scale !== hold.scale) { hold = null; return }   // it became a pinch
        hold = null
        swallowUntil = Date.now() + 800
        if (navigator.vibrate) navigator.vibrate(15)
        toggleMenu()
        dbg('modal: image held, menu opened')
      }, MODAL_HOLD_MS)
    }, { passive: true })
    stage.addEventListener('touchmove', ev => {
      if (!hold) return
      const finger = ev.touches[0]
      if (ev.touches.length > 1 || Math.hypot(finger.clientX - hold.x, finger.clientY - hold.y) > 12) cancel()
    }, { passive: true })
    stage.addEventListener('touchend', cancel)
    stage.addEventListener('touchcancel', cancel)
    img.addEventListener('contextmenu', ev => ev.preventDefault())   // the hold is ours
    box.addEventListener('click', ev => {
      if (Date.now() > swallowUntil) return
      swallowUntil = 0
      ev.stopPropagation()
      ev.preventDefault()
    }, true)
  }

  function installImageZoom(stage, img) {
    const pts = new Map()   // pointer id -> where it is, and when it went down
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

    const end = (ev) => {
      const p = pts.get(ev.pointerId)
      pts.delete(ev.pointerId)
      if (pts.size < 2) pinch = null
      if (pts.size === 0) {
        pan = null
        if (zoom.scale < 1.05) resetZoom()   // let go near 1x: snap back
        // Double tap: fullscreen or a like, as on videos (doubleTapCenter; the
        // tap is the user gesture fullscreen needs); zoomed in, it first comes
        // back to 1x. Zoom is the pinch.
        if (ev.type === 'pointerup' && p && !zoom.multi && Date.now() - p.t < 250 &&
            Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 10) {
          const now = Date.now()
          if (now - lastTap.t < 300 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < 30) {
            if (zoom.scale > 1) resetZoom()
            else centerDoubleTap()
            lastTap.t = 0
          } else {
            lastTap = { t: now, x: ev.clientX, y: ev.clientY }
            // A single tap in fullscreen shows or hides the bar, once it is
            // clear no second tap (fullscreen) follows.
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

  // src/modal/media.ts
  // What the modal shows: the video, the image and its original, a GIF.

  /**
   * @param onMissing   no host has a video file
   * @param onFound     its metadata arrived
   */
  function showVideo(candidates, hash, onMissing, onFound) {
    const vcached = cacheGet('video', hash)
    const urls = cachedFirst(candidates, vcached)
    const seq = modal.seq
    // The phone decodes about four videos at once; the modal gets one of them.
    markedCards('[data-ibh-cover]').forEach(card => unmountCover(card))
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
      if (modal.seq === seq && CFG.playerButton) {
        modal.playerBtn.hidden = false
        modal.appDlBtn.hidden = false
        // The phone would decode it on the CPU, slowly: the app converts it.
        modal.appReduceBtn.hidden = !pastDecoder(v.videoWidth, v.videoHeight) && !(modal.link && modal.link.dataset.ibhBigVideo)
        if (!modal.appReduceBtn.hidden) flash(t('bigVideo'))
      }
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
  /**
   * @param cached   cacheGet's: tried first when it is a URL
   * @returns calls the race off
   */
  function raceImage(stages, cached, onWin, onFail, priority) {
    let done = false
    const probes = []
    const drop = (keep) => probes.forEach(pr => { if (pr !== keep) { pr.onload = pr.onerror = null; pr.removeAttribute('src') } })
    const win = (pr) => { if (done) return; done = true; drop(pr); onWin(pr) }
    const probe = (url, onError) => {
      const pr = new Image()
      pr.decoding = 'async'
      if (priority) pr.fetchPriority = priority
      probes.push(pr)
      pr.onload = () => win(pr)
      pr.onerror = onError
      pr.src = url
    }
    const runStage = (i) => {
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

  const isSampleUrl = (url) => /\/samples\//.test(url || '')

  // candidates: a list of URLs, or stages of them (see raceImage).
  function showImage(placeholder, candidates, kind, hash) {
    const stages = (Array.isArray(candidates[0]) ? candidates : [candidates])
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
      if (modal.isSample) { modal.sampleUrl = probe.src; setQuality('sample') }
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
  // The quality button, a small RAW square as on the cards: null hides it;
  // 'sample' leaves it unlit, 'loading' dims it, 'raw' lights it.
  function setQuality(state) {
    const btn = modal && modal.quality
    if (!btn) return
    btn.hidden = !state
    btn.textContent = 'RAW'
    btn.classList.toggle('raw', state === 'raw')
    btn.classList.toggle('loading', state === 'loading')
    btn.title = t(state === 'raw' ? 'qualRawTip' : 'qualSampleTip')
  }

  // The size of the picture on show, beside the quality square: it follows
  // every load of the viewer's image (the page's copy, the sample, the raw
  // file and back). null hides it, as for a video.
  function setRes(img) {
    const label = modal && modal.res
    if (!label) return
    const shown = !!img && !img.hidden && img.naturalWidth > 0
    label.hidden = !shown
    if (img && shown) label.textContent = `${img.naturalWidth}×${img.naturalHeight}`
  }

  function toggleQuality() {
    if (modal.isSample) {
      modal.keepSample = false
      loadModalOriginal()
      return
    }
    if (!modal.sampleUrl) return
    // Back to the sample, and the zoom no longer swaps it on its own.
    modal.keepSample = true
    modal.image.src = modal.sampleUrl
    modal.fileUrl = modal.sampleUrl
    modal.isSample = true
    setQuality('sample')
    dbg('modal: back to the sample')
  }

  function loadModalOriginal() {
    if (!modal.isSample || modal.origPending) return
    if (modal.rawUrl) {   // fetched before on this post: swap at once
      modal.image.src = modal.rawUrl
      modal.fileUrl = modal.rawUrl
      modal.isSample = false
      setQuality('raw')
      return
    }
    const link = modal.link
    const pic = link && cardPicture(link)
    const parts = pic && thumbParts(pic.src)
    if (!parts) return
    modal.origPending = true
    const seq = modal.seq
    const cached = knownOriginal(parts.hash)
    if (cached === null) return
    flash(t('origLoading'))
    setQuality('loading')
    raceImage([fileCandidates(pic.src, ORIGINAL_EXTS)], cached, probe => {
      cacheSet('orig', parts.hash, probe.src, cached)
      if (modal.seq !== seq) return
      const decoded = typeof probe.decode === 'function' ? probe.decode().catch(() => {}) : Promise.resolve()
      decoded.then(() => {
        if (modal.seq !== seq) return
        modal.image.src = probe.src
        modal.fileUrl = probe.src
        modal.rawUrl = probe.src
        modal.isSample = false
        modal.origPending = false
        setQuality('raw')
        info(`modal: original loaded (${probe.src.split('/').pop()})`)
      })
    }, () => { cacheSet('orig', parts.hash, null); modal.origPending = false; if (modal.seq === seq) setQuality('sample') }, 'high')
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
    const check = (ev) => {
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

  // A card without a link (scanCards falls back to the <img>'s parent) has
  // no href: '?' as for a link without an id, not a throw.
  const postId = (link) => (String((link).href || '').match(/id=(\d+)/) || [])[1] || '?'

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
  /**
   * @param asGif   shows it as a GIF once no video host has it
   */
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

  // src/modal/tags.ts
  // ── Tags menu ──
  // ☰ opens a sheet with the post's tags as a grid; a tap copies one, "Copy
  // all" the whole list, ready to paste in a search. The thumbnail's own tags
  // show at once; the post page replaces them with the full list by kind.
  const TAG_ORDER = ['artist', 'character', 'copyright', 'general', 'metadata']
  const tagRank = (type) => { const i = TAG_ORDER.indexOf(type); return i < 0 ? TAG_ORDER.length : i }

  // type: the site's tag-type-*, general when unknown
  function thumbTags(link) {
    return nativeTags(link).trim().split(/\s+/)
      .filter(name => name && !/^(score|rating):/i.test(name))
      .map(name => ({ name, type: 'general' }))
  }

  function toggleMenu() {
    const open = modal.sheet.hidden   // a boolean: nothing here sets 'until-found'
    modal.sheet.hidden = !open
    modal.menu.classList.toggle('on', open)
    if (open) renderSheet(modal.link, modal.seq)
  }

  function renderSheet(link, seq) {
    if (modal.sheetTab === 'info') renderInfo(link, seq)
    else if (modal.sheetTab === 'comments') renderComments(link, seq)
    else renderTags(link, seq)
  }

  function markTab(tab) {
    modal.sheetTab = tab
    modal.tabTags.classList.toggle('on', tab === 'tags')
    modal.tabInfo.classList.toggle('on', tab === 'info')
    modal.tabComments.classList.toggle('on', tab === 'comments')
    modal.tagList.hidden = tab !== 'tags'
    modal.infoList.hidden = tab !== 'info'
    modal.commentList.hidden = tab !== 'comments'
  }

  function showTab(tab) {
    markTab(tab)
    renderSheet(modal.link, modal.seq)
  }

  // The player's ⓘ: the sheet open on Info, or closed if it already shows it.
  function toggleInfo() {
    const open = !modal.sheet.hidden
    if (open && modal.sheetTab === 'info') toggleMenu()
    else if (open) showTab('info')
    else { markTab('info'); toggleMenu() }   // toggleMenu draws it
    dbg(`modal: info ${modal.sheet.hidden ? 'closed' : 'opened'} from the player`)
  }

  // Comments tab: read from the post page (already fetched for the heart and
  // Info), in the site's order, as text. Those under the account's comment
  // threshold stay hidden, as on the site.
  async function renderComments(link, seq) {
    modal.commentList.replaceChildren(el('div', { class: 'none', text: t('infoLoading') }))
    const info = await postInfo(postId(link))
    if (modal.seq !== seq || modal.sheetTab !== 'comments') return
    const page = (info && info.comments) || { list: [], total: 0, next: null }
    modal.tabComments.textContent = `${t('tabComments')} (${page.total})`
    modal.commentList.replaceChildren()
    if (!page.total) { modal.commentList.append(el('div', { class: 'none', text: t('commentsNone') })); return }
    appendComments(page, seq)
    dbg(`modal: ${page.total} comments for post ${postId(link)}`)
  }

  // The site's own call (its vote() in application.js): the answer is the
  // comment's new score. The site shows no trace of a past vote, so the
  // comments voted here are remembered on the device, like post votes.
  async function voteComment(c, btn) {
    if (btn.disabled) return
    btn.disabled = true
    try {
      const url = `/index.php?page=comment&id=${encodeURIComponent(postId(modal.link))}&s=vote&cid=${encodeURIComponent(c.id)}&vote=up`
      const res = await fetch(url, { credentials: 'same-origin' })
      const score = parseInt(await res.text(), 10)
      if (!res.ok || !Number.isFinite(score)) throw new Error(`HTTP ${res.status}`)
      c.score = score
      btn.textContent = `▲ ${score}`
      btn.classList.add('on')
      setMark('c', c.id, true)
      info(`modal: comment ${c.id} upvoted -> ${score}`)
    } catch (e) {
      flash(t('voteFail'))
      warn(`modal: comment vote failed — ${describeError(e)}`)
    } finally {
      btn.disabled = false
    }
  }

  // Adds a page of comments, and a button for the next one while there is.
  function appendComments(page, seq) {
    const cookie = readCookie('comment_threshold')
    const threshold = cookie === null ? NaN : Number(cookie)
    const shown = Number.isFinite(threshold) ? page.list.filter(c => c.score >= threshold) : page.list
    modal.commentList.append(...shown.map(c => {
      // The author opens their profile in a new tab; ▲ votes the comment up.
      const who = c.profile
        ? el('a', { class: 'who', href: c.profile, target: '_blank', rel: 'noopener', text: c.user || '?' })
        : el('b', { text: c.user || '?' })
      const up = el('button', { class: 'cvote', text: `▲ ${c.score}` })
      up.classList.toggle('on', hasMark('c', c.id))
      up.addEventListener('click', () => voteComment(c, up))
      return el('div', { class: 'cm' }, [
        el('div', { class: 'h' }, [who, ` · ${c.date} `, up]),
        el('div', { class: 'b', text: c.text }),
      ])
    }))
    if (shown.length < page.list.length) {
      modal.commentList.append(el('div', { class: 'none', text: `${page.list.length - shown.length} ${t('commentsHidden')}` }))
    }
    if (!page.next) return
    const more = el('button', { class: 'pill', text: t('commentsMore') })
    more.addEventListener('click', async () => {
      more.disabled = true
      more.textContent = t('infoLoading')
      try {
        // page.next: the button is only there with one.
        const res = await fetch(page.next, { credentials: 'same-origin' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const next = readComments(new DOMParser().parseFromString(await res.text(), 'text/html'), page.next)
        if (modal.seq !== seq || modal.sheetTab !== 'comments') return
        more.remove()
        appendComments(next, seq)
      } catch (e) {
        more.disabled = false
        more.textContent = t('commentsMore')
        warn(`modal: more comments failed — ${describeError(e)}`)
      }
    })
    modal.commentList.append(more)
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
    if (video && w && h && pastDecoder(w, h)) rows.push(['', t('infoAbove'), true])
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
  }

  // A tap copies the tag; a hold opens its search in a new tab. The tab opens
  // on release, not when the hold timer fires: a timer is not a user gesture,
  // and the popup blocker would stop window.open from it.
  const TAG_HOLD_MS = 450
  const tagSearchUrl = (name) => `/index.php?page=post&s=list&tags=${encodeURIComponent(name)}`

  // Measured on the phone (event log): Firefox for Android ends a long press
  // three ways — contextmenu then pointerup; contextmenu then pointercancel;
  // or pointercancel ~110 ms in, with no contextmenu, as soon as the finger
  // trembles (it takes the touch for a scroll of the sheet). Touch events go
  // on through all three, so a touch hold is measured on them: long enough,
  // the finger nearly still and the sheet not scrolled. Pointer events only
  // serve the mouse. The tab opens from touchend/pointerup, both user gestures.
  const HOLD_SLOP = 12   // px the finger may wander and still be holding

  // `url`: a link, or a function giving it at the moment of the hold (null:
  // not known yet). `what` names it in the log.
  function chipGestures(chip, url, onTap, what = 'tag search') {
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
    const finish = (ev) => {
      if (!down) return
      const held = Date.now() - down.t >= TAG_HOLD_MS && Math.abs(modal.sheet.scrollTop - down.scroll) < HOLD_SLOP
      reset()
      if (!held) return
      skipClick = true   // a click that may follow is not a copy
      if (ev.cancelable) ev.preventDefault()   // and stop it where we can
      const href = typeof url === 'function' ? url() : url
      if (!href) { flash(t('dlWait')); return }
      window.open(href, '_blank', 'noopener')
      flash(t('tagOpened'))
      dbg(`modal: ${what} opened in a new tab (${href})`)
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
    setIcon(modal.vfav, on ? PLAYER_ICON.heart : PLAYER_ICON.heartLine)
    modal.vfav.classList.toggle('on', on)
  }

  // What is known shows at once; the post page corrects it when it answers.
  // The site never shows a past vote, but its heart votes up as it favorites
  // (post_vote then toggleFav), so a favorite counts as upvoted.
  function applyMarks(link, seq) {
    const id = postId(link)
    const own = onOwnFavorites()
    if (own) setMark('f', id, true)
    const show = (fav) => {
      showFav(fav)
      modal.up.classList.toggle('on', fav || hasMark('v', id))
    }
    show(own || hasMark('f', id))
    if (own) return
    lookUpFavorite(id).then(fav => { if (fav !== null && modal.open && modal.seq === seq) show(fav) })
  }

  // The site's own vote links (post pages, comments) count too.
  function onSiteVoteClick(ev) {
    const a = asElement(ev.target)?.closest('a[onclick*="post_vote("]')
    const m = a && (a.getAttribute('onclick')).match(/post_vote\('(\d+)',\s*'up'\)/)   // the selector asked for it
    if (m) setMark('v', m[1], true)
  }

  // src/search/suggest.ts
  // ─── tag suggestions for the script's search bars (searchSuggest) ───
  // While a word is typed, the site's own suggestion endpoint (PROFILE.suggest,
  // the one its search box uses) is asked for it, through the page's fetch
  // with the login; a list under the field shows the tags with their post
  // counts, in their kind's colour, and a tap swaps the word for the tag (a
  // drag scrolls the list instead, and the page stays put under it). The
  // list's elements carry data-ibh-ui, so the dark theme's broad rules,
  // which clear every background, leave them alone.
  const SUGGEST_MS = 200
  const suggesting = new WeakSet()

  async function fetchSuggestions(term) {
    const res = await fetch(PROFILE.suggest + encodeURIComponent(term), { credentials: 'same-origin' })
    const list = await res.json()
    return (Array.isArray(list) ? list : []).slice(0, 10).flatMap(x => {
      const count = /\((\d+)\)\s*$/.exec(x.label || '')   // "tag (123)" on the Gelbooru 0.2 sites
      return x.value ? [{ value: String(x.value), count: Number(x.post_count ?? (count ? count[1] : 0)) || 0, kind: String(x.category || x.type || '') }] : []
    })
  }

  function attachSuggest(input) {
    if (!CFG.searchSuggest || suggesting.has(input)) return
    suggesting.add(input)
    const box = el('ul', { class: 'ibh-suggest', 'data-ibh-ui': '' })
    box.hidden = true
    let timer = 0
    let seq = 0
    const close = () => { seq++; box.hidden = true }
    // The word being typed: after the last space, its -, ~ or || prefix apart.
    const word = () => {
      const token = /\S*$/.exec(input.value)?.[0] ?? ''
      const m = /^(\|\||[-~]?)(.*)$/.exec(token) ?? ['', '', '']
      return { token, prefix: m[1] ?? '', term: (m[2] ?? '').replace(/\*+$/, '') }
    }
    const show = (items) => {
      if (!items.length) { close(); return }
      if (!box.isConnected) input.parentElement?.appendChild(box)
      box.style.left = `${input.offsetLeft}px`
      box.style.top = `${input.offsetTop + input.offsetHeight + 2}px`
      box.style.width = `${input.offsetWidth}px`
      box.replaceChildren(...items.map(it => el('li', { 'data-value': it.value, 'data-ibh-ui': '', class: it.kind ? `k-${it.kind}` : '' }, [
        el('span', { text: it.value.replace(/_/g, ' '), 'data-ibh-ui': '' }),
        el('small', { text: it.count ? it.count.toLocaleString() : '', 'data-ibh-ui': '' }),
      ])))
      box.hidden = false
    }
    input.addEventListener('input', () => {
      clearTimeout(timer)
      const { term } = word()
      if (term.length < 2) { close(); return }
      timer = setTimeout(() => {
        const mine = ++seq
        fetchSuggestions(term).then(items => {
          if (mine !== seq) return   // typed on meanwhile
          dbg(`search: ${items.length} suggestions for "${term}"`)
          show(items)
        }, e => { if (mine === seq) { dbg(`search: no suggestions for "${term}" (${describeError(e)})`); close() } })
      }, SUGGEST_MS)
    })
    const pick = (li) => {
      const { token, prefix } = word()
      input.value = `${input.value.slice(0, input.value.length - token.length)}${prefix}${li.dataset.value} `
      close()
      input.focus()
      dbg(`search: suggestion "${li.dataset.value}" picked`)
    }
    const itemAt = (ev) => asElement(ev.target)?.closest('li')
    // A finger on the list may be scrolling it, so the tag goes in when the
    // finger lifts, and only if it stayed nearly still and the list did not
    // scroll. Measured on touch events, as in chipGestures: Firefox for
    // Android cancels the pointer as soon as the list starts to scroll.
    let finger = null
    let touchedAt = 0
    box.addEventListener('touchstart', ev => {
      const t = ev.touches[0]
      touchedAt = Date.now()
      finger = ev.touches.length === 1 ? { x: t.clientX, y: t.clientY, top: box.scrollTop } : null
    }, { passive: true })
    box.addEventListener('touchmove', ev => {
      const t = ev.touches[0]
      if (finger && Math.hypot(t.clientX - finger.x, t.clientY - finger.y) > HOLD_SLOP) finger = null   // a scroll
    }, { passive: true })
    box.addEventListener('touchcancel', () => { finger = null })
    box.addEventListener('touchend', ev => {
      const li = itemAt(ev)
      const still = finger && Math.abs(box.scrollTop - finger.top) < HOLD_SLOP
      finger = null
      if (!li || !still) return
      ev.preventDefault()   // no mouse events or click after it: the list is gone, and they would land on what was under it
      pick(li)
    })
    // The mouse: mousedown would move the focus out of the field; click picks.
    box.addEventListener('mousedown', ev => ev.preventDefault())
    box.addEventListener('click', ev => {
      const li = itemAt(ev)
      if (li && Date.now() - touchedAt > 800) pick(li)   // a click that follows a touch was the touch's
    })
    input.addEventListener('blur', () => setTimeout(close, 150))
    input.addEventListener('keydown', ev => { if (ev.key === 'Escape') close() })
  }

  const orTags = (text) => String(text || '').trim().split(/[\s~()]+/).filter(Boolean)
  // The OR field's groups: || starts another one, and each must hold, so
  // a b || c d is (a or b) and (c or d).
  const orGroups = (text) => String(text || '').split('||').map(orTags).filter(g => g.length)

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

  // src/lists/favorites.ts
  // ── Favorites search ──
  // A search bar on your own favorites page. An index of every favorite (id,
  // thumbnail, tags, score) is read once from the favorites pages and kept
  // with the lists; later visits only read the first pages, until they
  // reach favorites already known (the site lists the newest first). Results
  // go into the page's own thumbnail list (LIST) as the site's own thumbnails, so the
  // feed, covers, the modal and its swipe all work on them as on any page.
  // (Another script with this feature empties the whole page to show its
  // results and clears localStorage on reset, which broke this one.)
  const FAV_PAGE = 50          // favorites per page on the site
  const FAV_SHOW = 60          // results added per step
  const FAV_GAP_MS = 250       // between page reads, one at a time
  const FAV_STALE_MS = 10 * 60 * 1000   // the index is refreshed in the background after this
  const FAV_SAVE_MS = 5000     // a long read is saved this often, so a reload goes on from there
  // next: where a read that a reload cut short goes on (a pid); absent once complete.
  let favIndex = null          // { user, updated, items: [[id, thumb, tags, score]] }, newest first
  let favEntries = null        // the items with their tags split, for searching
  function setFavEntries(v) { favEntries = v }
  let favScan = null           // the read in progress
  let favPage = null           // the page's own list content, put back on Clear
  let favResults = []
  let favShown = 0
  let favBarSync = null        // refreshes the ☆ button of the favorites bar
  let favBarReload = null      // refreshes its lists

  // The favorites bar's fields: ensureFavSearch builds it with all of them.
  const favFields = (bar) => ({
    text: bar.querySelector('input[type="search"]'),
    or: bar.querySelector('input.or'),
    kind: bar.querySelector('select.kind'),
    sort: bar.querySelector('select.sort'),
    min: bar.querySelector('input.min'),
  })

  // The favorites bar's search, remembered for the next visit (active: shown).
  async function rememberFavSearch(active) {
    const bar = document.getElementById('ibh-favsearch')
    if (!bar) return
    const store = await searchStore()
    const f = favFields(bar)
    store.favLast = { text: f.text.value, or: f.or.value, kind: f.kind.value, sort: f.sort.value, min: f.min.value, active }
    if (active) addRecent(store, { where: 'fav', ...store.favLast, active: undefined })   // one write for both
    await storeSet('searches', store)
    if (active && favBarReload) favBarReload()
  }

  // The favorites index lives in the site's IndexedDB, not in GM storage:
  // Violentmonkey hands a script its whole GM storage on every page it runs
  // on, and an index of 6,000 favorites is ~7 MB (2026-11-14). One an older
  // version kept in GM storage moves over once. Without IndexedDB it stays
  // in GM storage (and without GM storage, storeGet is IndexedDB already).
  async function favsGet() {
    const saved = await idbGet('favs')
    if (saved === undefined) return storeGet('favs')   // no IndexedDB
    if (saved || !GM_STORE) return saved
    const old = await storeGet('favs')
    if (old && await idbSet('favs', old)) {
      await storeSet('favs', null)
      info(`favorites: index moved from GM storage to IndexedDB (${old.items.length} favorites)`)
    }
    return old
  }

  async function favsSet(idx) {
    if (!(await idbSet('favs', idx))) await storeSet('favs', idx)
  }

  async function loadFavIndex() {
    if (favIndex && favIndex.user === userId()) return favIndex
    const saved = await favsGet()
    // Loaded twice at once (the restored search and the bar's status): the
    // first one in wins, so a read in progress and the searches share one index.
    if (favIndex && favIndex.user === userId()) return favIndex
    favIndex = saved && saved.user === userId() ? saved : { user: userId(), updated: 0, items: [] }
    favEntries = null
    return favIndex
  }

  // One page of favorites: ids, thumbnails and tags from the thumbnails, scores
  // from the page's inline script (posts[ID] = { … score: 'N' }).
  /**
   * @param pid   the first favorite of the page
   */
  async function readFavPage(pid) {
    const res = await fetch(`/index.php?page=favorites&s=view&id=${userId()}&pid=${pid}`, { credentials: 'same-origin' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const scores = new Map()
    for (const m of html.matchAll(/posts\[(\d+)\]\s*=\s*\{[^}]*?score['"]?\s*:\s*['"]?(-?\d+)/g)) scores.set(m[1], Number(m[2]))
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return [...doc.querySelectorAll('.thumb img[src]')].map(img => {
      const a = img.closest('a')
      const src = img.getAttribute('src')   // matched img[src]
      const id = ((a && a.getAttribute('href')) || '').match(/id=(\d+)/)?.[1] || (src.split('?')[1] || '')
      return [id, src, (img.getAttribute('title') || img.getAttribute('alt') || '').trim(), scores.has(id) ? scores.get(id) : null]
    }).filter(item => /^\d+$/.test(item[0]))
  }

  // Reads the favorites pages into the index. New favorites first, from the
  // top (pages are newest first) until a page holds known ones; then a read
  // a reload cut short goes on where it stopped (idx.next). full starts over.
  // A long read (6,000 favorites: 123 pages, ~2 min) is saved as it goes, so
  // a reload loses only its last seconds. Favorites removed above the stop
  // meanwhile shift the rest up, and that many may be missed until a rebuild.
  function updateFavIndex(full) {
    if (favScan) return favScan
    favScan = (async () => {
      const idx = await loadFavIndex()
      if (full || (!idx.items.length && idx.next === undefined)) Object.assign(idx, { items: [], next: 0, updated: 0 })
      const before = idx.items.length
      const known = new Set(idx.items.map(item => item[0]))
      /** @returns the ones not in the index yet */
      const unknown = (items) => {
        const added = items.filter(item => !known.has(item[0]))
        added.forEach(item => known.add(item[0]))
        return added
      }
      const read = async (pid) => {
        setFavStatus(`${t('favScanning')} ${Math.floor(pid / FAV_PAGE) + 1}…`)
        for (let tries = 0; ; tries++) {
          try { return await readFavPage(pid) } catch (e) {
            if (tries >= 2) throw e
            await new Promise(r => setTimeout(r, 1000 * (tries + 1)))
          }
        }
      }
      let saved = Date.now()
      try {
        if (idx.items.length) {
          const top = []
          for (let pid = 0; ; pid += FAV_PAGE) {
            const items = await read(pid)
            const added = unknown(items)
            top.push(...added)
            if (!items.length || added.length < items.length) break   // reached the index
            await new Promise(r => setTimeout(r, FAV_GAP_MS))
          }
          idx.items = [...top, ...idx.items]
        }
        while (idx.next !== undefined) {
          const items = await read(idx.next)
          if (!items.length) { delete idx.next; break }   // past the last page
          idx.items.push(...unknown(items))
          idx.next += FAV_PAGE
          favEntries = null   // a search meanwhile sees what came in
          if (Date.now() - saved > FAV_SAVE_MS) { await favsSet(idx); saved = Date.now() }
          await new Promise(r => setTimeout(r, FAV_GAP_MS))
        }
      } catch (e) {
        warn(`favorites: ${t('favScanFail')} — ${describeError(e)}`)
        setFavStatus(t('favScanFail'))
        if (idx.next !== undefined) await favsSet(idx)   // what was read stays: the next visit goes on from it
        return null
      } finally {
        favScan = null
      }
      idx.updated = Date.now()
      favEntries = null
      await favsSet(idx)
      info(`favorites: index ${full ? 'rebuilt' : 'updated'}, ${idx.items.length - before} new, ${idx.items.length} in all`)
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
    const fields = favFields(bar)
    const either = orGroups(fields.or.value).map(g => g.join(' ~ '))
    const text = `${fields.text.value} ${either.join(' ')}`.trim()
    let idx = await loadFavIndex()
    if (!idx.items.length) idx = (await updateFavIndex(true)) || idx
    else if (idx.next !== undefined || Date.now() - idx.updated > FAV_STALE_MS) {
      // The stored index answers now. New favorites come in behind it (one
      // page, usually) and the search runs again with them; the rest of a
      // read a reload cut short comes in too, without the rerun, which would
      // scroll back to the top a minute later.
      const had = idx.items.length
      const partial = idx.next !== undefined
      updateFavIndex(false).then(fresh => {
        if (fresh && !partial && fresh.items.length > had && favPage && bar.isConnected) searchFavs()
      })
    }
    // A full scan reads every page: the bar (and its "more" button) may have
    // gone meanwhile (favSearch switched off), and the page stays as it is.
    if (!bar.isConnected) { info('favorites search: the bar went while the index loaded'); return }
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
    const kind = fields.kind.value
    // kind: the select's other values are FavEntry's flags.
    const ofKind = (e) => kind === 'all' || (kind === 'image' ? !e.animated : e[(kind)])
    const min = Number(fields.min.value) || 0
    let found = favEntries.filter(e => ofKind(e) && (!min || (e.score != null && e.score >= min)) && match(e))
    const sort = fields.sort.value
    if (sort === 'old') found = found.reverse()
    else if (sort === 'score') found = [...found].sort((a, b) => (b.score ?? -1e9) - (a.score ?? -1e9))
    else if (sort === 'random') found = found.map(e => ([Math.random(), e])).sort((a, b) => a[0] - b[0]).map(pair => pair[1])
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

  // The site's own paginators, hidden while results stand in for the page:
  // divs of its HTML.
  const sitePaginators = () => (document.querySelectorAll('#paginator, .pagination'))

  function showFavResults(items) {
    const list = document.querySelector(LIST)
    if (!list) return
    if (!favPage) favPage = [...list.childNodes]   // put back on Clear
    favResults = items
    favShown = 0
    list.replaceChildren()
    sitePaginators().forEach(p => { p.style.display = 'none' })
    showMoreFavs()
    window.scrollTo({ top: list.getBoundingClientRect().top + window.scrollY - 80 })
  }

  function showMoreFavs() {
    const list = document.querySelector(LIST)
    if (!list) return
    const next = favResults.slice(favShown, favShown + FAV_SHOW)
    list.append(...next.map(favThumb))
    favShown += next.length
    // Made with the favorites bar, which searchFavs saw still there after its
    // last await, and its own click handler.
    const more = document.getElementById('ibh-favmore')
    more.hidden = favShown >= favResults.length
    more.textContent = `${t('favMore')} (${favResults.length - favShown})`
    setFavStatus(`${favResults.length} ${t('favResults')}`)
  }

  function clearFavSearch() {
    const list = document.querySelector(LIST)
    if (list && favPage) list.replaceChildren(...favPage)
    favPage = null
    favResults = []
    sitePaginators().forEach(p => { p.style.display = '' })
    const more = document.getElementById('ibh-favmore')
    if (more) more.hidden = true
    const bar = document.getElementById('ibh-favsearch')
    if (bar) { const f = favFields(bar); f.text.value = ''; f.or.value = '' }
    rememberFavSearch(false)
    if (favBarSync) favBarSync()
    setFavStatus()
  }

  function setFavStatus(text) {
    const st = document.querySelector('#ibh-favsearch .st')
    if (!st) return
    const line = st.firstChild   // ensureFavSearch puts a text node first
    if (text) { line.textContent = text; return }
    const idx = favIndex
    line.textContent = idx && idx.items.length
      ? `${idx.items.length} ${t('favIndexed')} · ${idx.next !== undefined ? t('favPartial') : new Date(idx.updated).toLocaleString(LANG)}`
      : t('favNever')
  }

  // Idempotent: the observer calls it on every change of the page.
  function ensureFavSearch() {
    const bar = document.getElementById('ibh-favsearch')
    const want = CFG.favSearch && SITE === 'rule34.xxx' && onOwnFavorites() && !!document.querySelector(LIST)
    if (!want) { if (bar) { clearFavSearch(); bar.remove(); document.getElementById('ibh-favmore')?.remove() } return }
    if (bar) return
    const list = document.querySelector(LIST)   // want found it
    const input = el('input', { type: 'search', placeholder: t('favPlaceholder'), enterkeyhint: 'search' })
    input.setAttribute('autocapitalize', 'off')
    input.setAttribute('autocomplete', 'off')
    attachSuggest(input)
    const or = orInput()
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
    const read = () => ({ where: 'fav', text: input.value, or: or.value, kind: kind.value, sort: sort.value, min: min.value })
    const saved = savedControls('fav', read, q => {
      input.value = q.text; or.value = q.or || ''; kind.value = q.kind; sort.value = q.sort; min.value = q.min || ''
      searchFavs()
    })
    const box = el('div', { id: 'ibh-favsearch', class: 'ibh-search' }, [input, or, kind, sort, min, go, clear, saved.star, saved.pick, saved.recentPick, st])
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
    or.addEventListener('input', saved.sync)
    or.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); or.blur(); searchFavs() } })
    min.addEventListener('input', saved.sync)
    // The last search comes back, results included, until Clear.
    searchStore().then(store => {
      const last = store.favLast
      if (!last || !last.active || !document.getElementById('ibh-favsearch')) return
      input.value = last.text || ''; or.value = last.or || ''; kind.value = last.kind || 'all'; sort.value = last.sort || 'new'; min.value = last.min || ''
      saved.sync()
      searchFavs()
    })
    loadFavIndex().then(idx => {
      setFavStatus()
      // New favorites since the last visit come in quietly (usually one page),
      // and a read a reload cut short goes on.
      if (idx.items.length && (idx.next !== undefined || Date.now() - idx.updated > FAV_STALE_MS)) updateFavIndex(false)
    })
    info('favorites search bar added')
  }

  // OR field: tags typed apart by spaces become one either-of group, the
  // site's ( a ~ b ~ c ), or a ~ b for the favorites search; || starts
  // another group: a b || c d is ( a ~ b ) ( c ~ d ).
  function orInput() {
    const field = el('input', { class: 'or', type: 'search', placeholder: t('orPlaceholder'), enterkeyhint: 'search' })
    field.setAttribute('autocapitalize', 'off')
    field.setAttribute('autocomplete', 'off')
    attachSuggest(field)
    return field
  }

  // src/lists/autopager.ts
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
    const want = CFG.favAutopager && (onFavoritesPage() || onListPage()) &&
      !!document.querySelector(LIST)
    if (!want) {
      if (pager) { pager.io.disconnect(); pager.sentinel.remove(); pager = null }
      return
    }
    if (pager && pager.sentinel.isConnected) return
    const sentinel = el('div', { id: 'ibh-pager' })
    const above = (document.getElementById('ibh-favmore') || document.querySelector(LIST))   // want found the list
    above.after(sentinel)
    sentinel.addEventListener('click', () => { if (pager && !pager.done) favPagerNext() })   // retry after a failure
    const next = pageTarget(1)
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) favPagerNext()
    }, { rootMargin: '1500px 0px' })
    pager = { next, busy: false, done: !next, page: 1, sentinel, io }
    if (!next) sentinel.textContent = t('pagerEnd')
    io.observe(sentinel)
    dbg(`autopager: watching the bottom of the page${next ? '' : ' (last page)'}`)
  }

  async function favPagerNext() {
    const p = pager
    // favPage: search results are on show, not the favorites pages.
    if (!p || p.busy || p.done || favPage) return
    p.busy = true
    p.sentinel.textContent = t('pagerLoading')
    try {
      const url = p.next   // not done: there is a next page
      const res = await fetch(url, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
      const src = doc.querySelector(LIST)
      const items = src ? [...src.children].filter(node => node.querySelector && node.querySelector('img')) : []
      const list = document.querySelector(LIST)
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
    // src: thumbParts found the hash in it.
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

  // src/lists/later.ts
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
    const title = modal.laterHead.querySelector('.lt')   // buildModal made it
    title.textContent = `🕒 ${t('laterTitle')} · ${list.length}`
    modal.laterNote.textContent = t(GM_STORE ? 'laterOnDevice' : 'laterOnSite')
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
            (modal.laterIO).unobserve(e.target)   // set while it observes: closeModal disconnects it first
            sharpenTile(e.target)   // it watches the tiles' images
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

  // src/storage/storage.ts
  // The settings' copies and the lists' storage: GM storage, the site's
  // IndexedDB, the move from the old storage bridge.

  function setCfg(key, value) {
    CFG[key] = value
    writeJSON(CFG_KEY, CFG)
    // The copies (see restoreCfg); not yet reachable this early in the boot.
    try { backupCfg() } catch (e) { /* the boot copy in restoreCfg covers it */ }
    info(`option ${key} = ${value}${NEEDS_RELOAD.has(key) ? ' (reload the page)' : ''}`)
  }

  // ── Storage ──
  // The lists (Watch later, the favorites index, saved searches) and a copy
  // of the settings live in Violentmonkey's storage, on the device, out of
  // reach of anything that clears the site's data. Where GM storage is
  // missing (another userscript manager), the site's IndexedDB holds them.
  const GM_STORE = typeof GM_getValue === 'function' && typeof GM_setValue === 'function'
  const STORE_KEYS = ['later', 'favs', 'cfg', 'searches']   // also what the storage bridge held (moveIn)
  // An empty list or object counts as nothing stored.
  const hasData = (v) => v != null && (typeof v !== 'object' || (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0))

  // A copy of the settings in Violentmonkey and in the site's IndexedDB:
  // both outlive localStorage.clear() (another script's reset cleared
  // localStorage and the settings with it).
  function backupCfg() {
    const copy = JSON.parse(JSON.stringify(CFG))
    idbSet('cfg', copy)
    if (GM_STORE && JSON.stringify(GM_getValue('cfg', null)) !== JSON.stringify(copy)) GM_setValue('cfg', copy)
  }

  // Settings gone from localStorage come back from a copy, and the page
  // reloads once so every option applies from the start. Settings still
  // there refresh the copies.
  async function restoreCfg() {
    if (CFG_FOUND) { backupCfg(); return }
    await storeReady()   // the first run may still be bringing the copy over
    let saved = GM_STORE ? GM_getValue('cfg', null) : null
    if (!hasData(saved)) saved = await idbGet('cfg')
    if (!hasData(saved) || typeof saved !== 'object') return
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

  // The stored value (null when there is none), unchecked; undefined without IndexedDB.
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

  // Without GM storage: IndexedDB, or localStorage where IndexedDB fails.
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

  // ── Moving in from the storage bridge ──
  // Up to 0.64 the lists lived in a second script, the storage bridge, and
  // Violentmonkey keeps each script's storage apart. Before the first read or
  // write, the first run asks the bridge for them (it answers while it is
  // installed) and takes what the site's own data held for the rest. Done for
  // good once the bridge has answered, or after a few loads without it.
  const BRIDGE_WAIT_MS = 1500
  const BRIDGE_TRIES = 3
  let movedIn = null
  function setMovedIn(v) { movedIn = v }

  // The bridge's value for each key that got an answer in time.
  function askBridge(keys) {
    return new Promise(resolve => {
      const got = {}
      const asked = new Map()   // request id -> key
      let seq = 0
      const ask = () => {
        for (const key of keys) {
          if (key in got) continue
          const id = `move-${++seq}`
          asked.set(id, key)
          window.dispatchEvent(new CustomEvent('ibh-store-request', { detail: JSON.stringify({ id, op: 'get', key }) }))
        }
      }
      const onReply = (ev) => {
        let msg
        try { msg = JSON.parse((ev).detail) } catch (e) { return }   // ibh-store-reply's
        const key = msg && asked.get(msg.id)
        if (key === undefined) return
        got[key] = msg.value
        if (Object.keys(got).length === keys.length) finish()
      }
      const finish = () => {
        clearTimeout(timer)
        window.removeEventListener('ibh-store-reply', onReply)
        window.removeEventListener('ibh-store-ready', ask)
        resolve(got)
      }
      const timer = setTimeout(finish, BRIDGE_WAIT_MS)
      window.addEventListener('ibh-store-reply', onReply)
      window.addEventListener('ibh-store-ready', ask)   // it loaded after this script: ask again
      ask()
    })
  }

  // Two copies of the same key, as they can differ when the bridge answers
  // only on a later load: everything from both, this script's own first.
  // Both are stored values, unchecked.
  function mergeStored(key, mine, theirs) {
    if (!hasData(mine)) return theirs
    const union = (a, b, id) => {
      const seen = new Set(a.map(id))
      return [...a, ...b.filter(x => !seen.has(id(x)))]
    }
    if (key === 'later') return union(mine, theirs, (item) => item.href).slice(0, LATER_MAX)
    if (key === 'searches') {
      return { saved: union(mine.saved || [], theirs.saved || [], searchKey), recent: union(mine.recent || [], theirs.recent || [], searchKey),
        favLast: mine.favLast || theirs.favLast || null }
    }
    // The favorites index is a copy of the site's list: the fuller one.
    if (key === 'favs') return (theirs.items || []).length > (mine.items || []).length ? theirs : mine
    return mine
  }

  async function moveIn() {
    const tries = GM_getValue('movedIn', 0)
    if (tries === true) return
    const bridge = await askBridge(STORE_KEYS)
    const answered = Object.keys(bridge).length > 0
    for (const key of STORE_KEYS) {
      const mine = GM_getValue(key, null)
      if (key === 'cfg' && hasData(mine)) continue   // the live settings are newer (backupCfg)
      let theirs = bridge[key]
      let from = 'the storage bridge'
      // The site's own data on the first try only: later ones look for the bridge.
      // (Not the favorites index: the site's IndexedDB is its home now, favsGet.)
      if (!hasData(theirs) && tries === 0 && key !== 'favs') { theirs = await siteGet(key); from = 'the site’s data' }
      if (!hasData(theirs)) continue
      GM_setValue(key, mergeStored(key, mine, theirs))
      info(`storage: ${key} moved in from ${from}`)
    }
    GM_setValue('movedIn', answered || tries + 1 >= BRIDGE_TRIES ? true : tries + 1)
    if (!answered) info(`storage: no storage bridge answered (load ${tries + 1} of ${BRIDGE_TRIES})`)
  }

  // Every read and write waits for it, so nothing written at load (a recent
  // search, the favorites index) lands before the bridge's copy.
  const storeReady = () => movedIn || (movedIn = (GM_STORE ? moveIn() : Promise.resolve())
    .catch(e => warn(`storage: moving in failed — ${describeError(e)}`)))

  // What was stored under the key (null when nothing was), unchecked.
  async function storeGet(key) {
    await storeReady()
    return GM_STORE ? GM_getValue(key, null) : siteGet(key)
  }

  async function storeSet(key, value) {
    await storeReady()
    if (GM_STORE) GM_setValue(key, value)
    else await siteSet(key, value)
  }

  // src/thumbs/marks.ts
  // The marks on a post's card: ❤️ on a favorite (hold it to unfavorite) and
  // the resolution, from rule34's API with the user's key; that API's gate
  // (r34Api) and its panel section.

  // ── Card marks: ❤️ on favorites, the resolution ──
  // likedBadge: a ❤️ in a favorite's top right, known from the favorites
  // index (read once a page, only its ids kept), the posts favorited here
  // (marks) and the user's own favorites page; holding it unfavorites the
  // post. favAutoIndex: a like or unlike made here goes into the index too,
  // so it stays right between reads. resBadge: the resolution in the top
  // left, from rule34's API with the user's key (GM storage only, like the
  // app's token), a video's cover or an opened post's page; remembered per
  // post, since a post's size never changes.
  const UNLIKE_HOLD_MS = 500
  let likedIds = null                   // the favorites index's ids
  const unliked = new Set()             // unfavorited on this page (the favorites page still lists them)
  let favIndexWrites = Promise.resolve()   // one index edit at a time: each reads, changes and writes it whole

  const wantsLiked = () => !!CFG.likedBadge && SITE === 'rule34.xxx' && !!userId()
  const isLiked = (id) => !unliked.has(id) && (hasMark('f', id) || !!likedIds?.has(id) || onOwnFavorites())
  const cardsOf = (id) => siteLinks().filter(a => postId(a) === id)

  function paintCardMarks(link) {
    paintLiked(link)
    paintRes(link)
    wantDims(link)
  }

  function repaintCards() {
    for (const link of siteLinks()) paintCardMarks(link)
  }

  function paintLiked(link) {
    const id = postId(link)
    const on = wantsLiked() && id !== '?' && isLiked(id)
    const had = link.querySelector('.ibh-liked')
    if (!on) {
      had?.remove()
      delete link.dataset.ibhLiked
      return
    }
    link.dataset.ibhLiked = '1'   // moves the other top-right badges aside (CARD_MARKS_CSS)
    if (had) return
    if (getComputedStyle(link).position === 'static') link.style.position = 'relative'
    link.appendChild(el('span', { class: 'ibh-liked', 'data-ibh-ui': '', role: 'button', title: t('heartHint'), text: '❤️' }))
  }

  // The index's ids, once the page has the user's id (its links) to match it to.
  async function loadLikedIds() {
    if (!wantsLiked() || likedIds) return
    const idx = favIndex && favIndex.user === userId() ? favIndex : await favsGet()
    if (!idx || idx.user !== userId()) return
    likedIds = new Set(idx.items.map(item => item[0]))
    let shown = 0
    for (const link of siteLinks()) {
      paintLiked(link)
      if (link.dataset.ibhLiked) shown++
    }
    info(`liked: ${likedIds.size} favorites in the index, ${shown} of them on this page`)
  }

  // favoritePost answered: the card's ❤️, and the index (favAutoIndex).
  function afterFavorite(id, fav) {
    if (fav) unliked.delete(id)
    else unliked.add(id)
    if (likedIds) fav ? likedIds.add(id) : likedIds.delete(id)
    const links = cardsOf(id)
    for (const link of links) {
      paintLiked(link)
      if (!fav) delete link.dataset.ibhBulk   // a double tap can favorite it again
    }
    if (CFG.favAutoIndex && SITE === 'rule34.xxx' && userId()) {
      favIndexWrites = favIndexWrites.then(() => indexFavorite(id, fav, links[0])).catch(e => warn(`favorites: index not updated — ${describeError(e)}`))
    }
  }

  /**
   * @param link   the card, for the index's thumbnail and tags
   */
  async function indexFavorite(id, fav, link) {
    // A read in progress picks the change up itself, or would add it twice.
    if (favScan) { dbg(`favorites: index being read, post ${id} left to it`); return }
    const idx = await loadFavIndex()
    // Never read: the first read builds it whole, and one item in it now
    // would stop that read at its first page (it reads until a known one).
    if (!idx.items.length && idx.next === undefined) return
    const at = idx.items.findIndex(item => item[0] === id)
    if (fav === at >= 0) return
    if (fav) {
      const img = link && link.querySelector('img')
      idx.items.unshift([id, (img && img.getAttribute('src')) || '', link ? nativeTags(link) : '', null])   // newest first, as the pages
    } else {
      idx.items.splice(at, 1)
    }
    setFavEntries(null)   // a search sees it
    await favsSet(idx)
    info(`favorites: post ${id} ${fav ? 'added to' : 'taken out of'} the index (${idx.items.length})`)
  }

  // Holding the ❤️: unfavorite. toggle=1 flips, so a post the index wrongly
  // thought a favorite comes back as added ('3'): flipped once more, it goes.
  async function unlikeFromCard(link) {
    const id = postId(link)
    try {
      let { code } = await favoritePost(id, true)
      if (code === '3') ({ code } = await favoritePost(id, true))
      if (code !== '4') {
        pageToast(`${t('unlikeFail')} (${code.slice(0, 20)})`)
        warn(`liked: post ${id} not unfavorited — answer ${code.slice(0, 20)}`)
        return
      }
      pageToast(t('favRemoved'))
      info(`liked: post ${id} unfavorited from its ❤️`)
    } catch (e) {
      pageToast(t('unlikeFail'))
      warn(`liked: post ${id} not unfavorited — ${describeError(e)}`)
    }
  }

  // The ❤️'s hold, on touch events like the raw hold (Firefox for Android
  // cancels the pointer during a long press). Its taps go nowhere: the
  // click handler runs before every other one on the cards.
  let heartHold = null

  function onHeartTouchStart(ev) {
    const badge = asElement(ev.target)?.closest('.ibh-liked')
    const link = (badge && badge.closest(SITE_LINK))   // SITE_LINK ends in a
    if (!link || ev.touches.length !== 1) return
    const finger = ev.touches[0]
    const hold = { link, x: finger.clientX, y: finger.clientY, fired: false, timer: 0 }
    hold.timer = setTimeout(() => {
      hold.fired = true
      if (navigator.vibrate) navigator.vibrate(15)
      unlikeFromCard(link)
    }, UNLIKE_HOLD_MS)
    heartHold = hold
  }

  function onHeartTouchMove(ev) {
    const finger = ev.touches[0]
    if (heartHold && !heartHold.fired && finger && Math.hypot(finger.clientX - heartHold.x, finger.clientY - heartHold.y) > 12) {
      clearTimeout(heartHold.timer)
      heartHold = null
    }
  }

  function onHeartTouchEnd() {
    if (heartHold && !heartHold.fired) clearTimeout(heartHold.timer)
  }

  function onHeartClick(ev) {
    if (!asElement(ev.target)?.closest('.ibh-liked')) return
    ev.preventDefault()
    ev.stopImmediatePropagation()
    if (!heartHold || !heartHold.fired) pageToast(t('heartHint'))   // a tap: how it works
    heartHold = null
  }

  // ── The resolution (resBadge) ──
  const DIMS_KEY = `IBH_DIMS_${SITE}`   // { id: "WxH" }, newest last
  const DIMS_MAX = 8000
  const DIMS_INFLIGHT = 2               // API requests at once
  // rule34's API (api.rule34.xxx) answers only with the user's key; every
  // call to it goes through r34Api, which makes none without one. The file
  // hosts (api-cdn*.rule34.xxx) are another thing: they serve images and
  // videos to anyone, key or not.
  const RULE34_API = 'https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1'
  let dims = null
  let dimsSaveTimer = 0
  const dimsQueue = []                  // post ids to ask the API for, in page order
  const dimsAsked = new Set()           // asked on this page
  let dimsLive = 0

  function loadDims() {
    if (!dims) dims = new Map(Object.entries(readJSON(DIMS_KEY, {})))
    return dims
  }

  function setDims(id, w, h) {
    if (id === '?' || !(w > 0 && h > 0)) return
    const map = loadDims()
    const size = `${w}x${h}`
    if (map.get(id) === size) return
    map.delete(id)
    map.set(id, size)
    while (map.size > DIMS_MAX) map.delete(map.keys().next().value)   // not empty
    clearTimeout(dimsSaveTimer)
    dimsSaveTimer = setTimeout(() => writeJSON(DIMS_KEY, Object.fromEntries(loadDims())), 2000)   // one write for a burst
    for (const link of cardsOf(id)) paintRes(link)
  }

  // The size of the picture a card shows: the sample the feed swapped in, or
  // the raw file a hold brought (0 forgets it). The badge says what is on
  // screen, so this comes before the post's own size.
  function setShown(link, w, h) {
    if (w > 0 && h > 0) link.dataset.ibhShown = `${w}x${h}`
    else delete link.dataset.ibhShown
    paintRes(link)
  }

  function paintRes(link) {
    const size = CFG.resBadge ? link.dataset.ibhShown || loadDims().get(postId(link)) : undefined
    let badge = link.querySelector('.ibh-res')
    if (!size) { badge?.remove(); return }
    if (!badge) {
      badge = el('span', { class: 'ibh-res', 'data-ibh-ui': '' })
      if (getComputedStyle(link).position === 'static') link.style.position = 'relative'
      link.appendChild(badge)
    }
    badge.textContent = size.replace('x', '×')
  }

  // The user's key, as rule34 shows it ("&api_key=…&user_id=…"), kept in GM
  // storage only: the site's own storage is read by the site's scripts.
  const apiKey = () => (GM_STORE ? String(GM_getValue('r34ApiKey', '') || '') : '')
  /**
   * The key from what was pasted, or '' to clear it; null when it isn't one.
   */
  function parseApiKey(raw) {
    const text = raw.trim()
    if (!text) return ''
    const key = text.match(/api_key=([0-9a-f]{32,})/i)
    const user = text.match(/user_id=(\d+)/)
    return key && user ? `&api_key=${key[1]}&user_id=${user[1]}` : null
  }

  function wantDims(link) {
    const id = postId(link)
    // Only rule34's API knows an image's size before it is opened, and it needs the key.
    if (!CFG.resBadge || SITE !== 'rule34.xxx' || !GM_XHR || apiRefused || id === '?' || dimsAsked.has(id) || loadDims().has(id) || !apiKey()) return
    dimsAsked.add(id)
    dimsQueue.push(id)
    pumpDims()
  }

  let apiRefused = false   // the API turned the key down: no more asking until a new key

  /**
   * One request to rule34's API, with the key; false (and nothing sent)
   * without a key, or once the API refused it. `done` gets the JSON, or null
   * for a failure or a refusal.
   * @param query   e.g. "&id=123"
   */
  function r34Api(query, done) {
    const key = apiKey()
    if (!key || apiRefused || !GM_XHR || SITE !== 'rule34.xxx') return false
    GM_xmlhttpRequest({
      method: 'GET',
      url: `${RULE34_API}${query}${key}`,
      timeout: 15000,
      onload: res => {
        let json = null
        try { json = JSON.parse(res.responseText) } catch (e) { /* a refusal is plain text */ }
        if (json === null && /authentication|api_key|access denied/i.test(res.responseText)) {
          apiRefused = true
          warn(`rule34 API: the key was refused — ${res.responseText.slice(0, 120)}`)
        }
        done(json)
      },
      onerror: () => done(null),
      ontimeout: () => done(null),
    })
    return true
  }

  function pumpDims() {
    while (dimsLive < DIMS_INFLIGHT && dimsQueue.length) {
      const id = dimsQueue.shift()   // not empty
      const sent = r34Api(`&id=${encodeURIComponent(id)}`, json => {
        dimsLive--
        const post = Array.isArray(json) ? json[0] : null
        if (post && typeof post === 'object' && 'width' in post && 'height' in post) setDims(id, Number(post.width), Number(post.height))
        pumpDims()
      })
      if (!sent) { dimsQueue.length = 0; return }   // no key, or refused: the rest would not go either
      dimsLive++
    }
  }

  // The panel's section for what rule34's API serves with the user's key:
  // the key's field first, a warning while there is none, then every option
  // that depends on it. Other sites have no key: their options stay plain.
  function apiSection(body) {
    if (SITE !== 'rule34.xxx') {
      body.appendChild(toggle('resBadge', t('tResBadge'), null, repaintCards))
      return
    }
    body.appendChild(el('div', { class: 'sec', text: t('apiSec') }))
    if (!apiKey()) body.appendChild(el('div', { class: 'apiwarn', text: t(GM_STORE ? 'apiWarn' : 'appNoStore') }))
    body.appendChild(apiKeyControls())
    body.appendChild(toggle('resBadge', t('tResBadge'), apiKey() ? null : t('apiPartial'), repaintCards))
  }

  // The key's field: saved as soon as a key is pasted.
  function apiKeyControls() {
    const field = el('input', { class: 'apptoken', type: 'password', autocomplete: 'off', placeholder: t(GM_STORE ? 'apiKeyHint' : 'appNoStore') })
    field.disabled = !GM_STORE
    field.value = apiKey()
    const keyUser = (key) => (key.match(/user_id=(\d+)/) || [])[1]
    const shown = (key) => (key ? `${t('apiKeySet')} (user ${keyUser(key)})` : t('apiKeyNone'))
    const status = el('div', { class: 'lbl appstatus', text: shown(apiKey()) })
    /** @param final  the field lost focus: a wrong text gets its message */
    const save = (final) => {
      const key = parseApiKey(field.value)
      if (key === null) { if (final) status.textContent = t('apiKeyBad'); return }
      // Pasting fires input at once; on the phone, change only comes when the
      // field loses focus, which closing the panel may never give it.
      if (key === apiKey() || (!key && !final)) return
      GM_setValue('r34ApiKey', key)
      field.value = key
      apiRefused = false
      dimsAsked.clear()   // the ones a refused key dropped are asked again
      status.textContent = shown(key)
      info(`resolution: API key ${key ? `saved (user ${keyUser(key)})` : 'cleared'}`)
      repaintCards()
      // The warning and the notes follow the key; a field still being typed
      // in keeps its focus until it is done.
      if (final || key) setTimeout(rebuildPanel, 0)
    }
    field.addEventListener('input', () => save(false))
    field.addEventListener('change', () => save(true))
    return el('div', { class: 'lang' }, [el('div', { class: 'lbl', text: t('apiKey') }), field, status])
  }

  // src/post/post.ts
  // What the script learns about a post and its user from the site's pages.

  // The logged-in user's id, or null. rule34 stopped letting scripts read its
  // user_id cookie (2026-11-14: logged in, document.cookie had none, though
  // it still goes with every request), so the page tells instead: a
  // listing's My Favorites link, or one's own favorites page, whose Remove
  // links only its owner gets. Once seen it is kept for the page's life:
  // search results replace those links. A post page shows neither.
  let pageUser = null
  const userId = () => (document.cookie.match(/(?:^|; )user_id=(\d+)/) || [])[1] || pageUser || (pageUser = userFromPage())

  function userFromPage() {
    const nav = document.querySelector('#my-favorites-container a[href*="id="]')
    const fromNav = ((nav && nav.getAttribute('href')) || '').match(/[?&]id=(\d+)/)
    if (fromNav) return fromNav[1]
    const q = new URLSearchParams(location.search)
    const own = q.get('page') === 'favorites' && /^\d+$/.test(q.get('id') || '') && document.querySelector('a[onclick*="favorites&s=delete"]')
    return own ? q.get('id') : null
  }

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
        .then(page => {
          // "Size: 1920x1080" in its statistics, for the resolution badge.
          const size = page && page.stats.map(st => st.text.match(/^Size:\s*(\d+)\s*x\s*(\d+)/i)).find(Boolean)
          if (size) setDims(id, Number(size[1]), Number(size[2]))
          return page
        })
        .catch(() => null)
      postInfos.set(id, p)
    }
    return p
  }

  // Comments of a post page: #comment-list > div#c<id>, author/date/score in
  // .col1, text in .col2 (<br> for its line breaks). Ten a page; the next ten
  // come from the "Next »" link of the comments' paginator (a cursor).
  /**
   * @param base  what the links are relative to
   */
  function readComments(doc, base = location.href) {
    const list = [...doc.querySelectorAll('#comment-list > div[id]')].filter(d => /^c\d+$/.test(d.id)).map(d => {
      const head = d.querySelector('.col1')
      const body = d.querySelector('.col2')
      if (body) body.querySelectorAll('br').forEach((br) => br.replaceWith('\n'))
      const headText = head ? (head.textContent || '').replace(/\s+/g, ' ') : ''
      const author = head && head.querySelector('a[href*="page=account"]')
      return {
        id: d.id.slice(1),   // c22197352 -> 22197352, for the vote
        user: ((author && author.textContent) || '').trim(),
        profile: author ? new URL(author.getAttribute('href'), base).href : null,   // matched a[href…]
        date: (headText.match(/Posted on (\S+ \S+)/) || [])[1] || '',
        score: Number((head && head.querySelector('[id^="sc"]') || {}).textContent) || 0,
        text: body ? (body.textContent || '').replace(/\n{3,}/g, '\n\n').trim() : '',
      }
    }).filter(c => c.text)
    const total = Number(((doc.querySelector('#comment-list') || {}).textContent || '').match(/(\d+) comments?/)?.[1]) || list.length
    const more = [...doc.querySelectorAll('#post-comments #paginator a')].find(a => /next/i.test(a.textContent || ''))
    const href = more && more.getAttribute('href')   // a link without one leads nowhere
    return { list, total, next: href ? new URL(href, base).href : null }
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
      const q = a && (a.getAttribute('href')).match(/[?&]tags=([^&]+)/)   // matched a[href…]
      if (q) tags.push({ name: decodeURIComponent(q[1].replace(/\+/g, ' ')), type })
    }
    // The sidebar's statistics: Id, Posted … by, Size, Source, Rating, Score.
    const stats = [...doc.querySelectorAll('#stats li')].map(li => {
      const text = (li.textContent || '').replace(/\s+/g, ' ').replace(/\(\s*vote.*$/i, '').trim()
      const link = li.querySelector('a[href^="http"]')
      return { text, href: link ? link.getAttribute('href') : null }
    }).filter(st => st.text)
    const comments = readComments(doc)
    // The sidebar's "Original image" link: the exact file, no guessing.
    const orig = [...doc.querySelectorAll('a[href*="/images/"]')].find(a => /original/i.test(a.textContent || ''))
    // The page links videos on api-cdn-mp4, the slow origin (0.4–0.6 MB/s
    // measured, against 6–7 MB/s for the same file on api-cdn, Cloudflare).
    const original = orig ? (orig.getAttribute('href')).replace(/([^:])\/\/+/g, '$1/').replace('//api-cdn-mp4.', '//api-cdn.') : null   // matched a[href…]
    return { fav: heart ? heart[1] === 'heart-added' : null, tags, stats, original, comments }
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

  // src/post/download.ts
  // ── Download ──
  // Saves the post's own file (the original image, the GIF, the video) as
  // SITE_ID.ext. A page script cannot read a file from the image hosts (they
  // send no CORS headers); GM_xmlhttpRequest can. Without it the file opens
  // in a new tab, to be saved with a long press (still inside the tap's user
  // activation, so the popup blocker lets it through).
  const GM_XHR = typeof GM_xmlhttpRequest === 'function'
  const downloading = new Set() // post ids in flight: a second tap does not start another
  const dlPercent = new Map()   // post id -> last progress, for the button
  const DL_DONE_MS = 1500       // the ✓ stays this long before the button comes back
  const BLOB_LIFE_MS = 120000   // how long Firefox gets to save the file
  const DL_STALL_MS = 60000     // a download that gets nothing for this long is given up (no cap on the whole)
  let dlDoneAt = { post: null, until: 0 }

  // Files come only from the site's own hosts (rule34.xxx, api-cdn.rule34.xxx…).
  function siteFile(url) {
    try {
      const u = new URL(url)
      return u.protocol === 'https:' && (u.hostname === SITE || u.hostname.endsWith(`.${SITE}`))
    } catch (e) {
      return false
    }
  }

  // GM_download on Firefox for Android shows the save prompt but revokes its
  // blob: link right away, so confirming saves nothing. Same path, done here:
  // fetch the file, hand Firefox a blob: link to save, and keep that link
  // alive long enough to confirm the prompt.
  function saveFile(url, name, done, progress) {
    let last = 0
    let heard = Date.now()   // the last time any bytes came
    let over = false
    const end = (ok, reason) => {
      if (over) return
      over = true
      clearInterval(watch)
      done(ok, reason)
    }
    // A big video on a slow line can take many minutes: only silence ends it.
    const watch = setInterval(() => {
      if (Date.now() - heard < DL_STALL_MS) return
      if (req && req.abort) req.abort()
      end(false, `nothing received for ${DL_STALL_MS / 1000} s`)
    }, 5000)
    const req = GM_xmlhttpRequest({
      // A big file takes a while: report how far it got, twice a second at most.
      onprogress: e => {
        heard = Date.now()
        if (!e.total || Date.now() - last < 500) return
        last = Date.now()
        progress(e.loaded, e.total)
      },
      method: 'GET',
      url,
      responseType: 'blob',
      // The video hosts refuse a request without the site as referrer (403),
      // which the browser sends when it plays the video and the extension not.
      headers: { Referer: `${location.origin}/` },
      onload: res => {
        if (res.status !== 200 || !res.response) { end(false, `HTTP ${res.status}`); return }
        const href = URL.createObjectURL(res.response)
        const a = document.createElement('a')
        a.href = href
        a.download = name
        a.style.display = 'none'
        ;(document.body || document.documentElement).appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(href), BLOB_LIFE_MS)
        end(true)
      },
      onerror: () => end(false, 'network error'),
      ontimeout: () => end(false, 'timeout'),
    })
  }

  // The button follows the post on screen: spinning with the progress while
  // it downloads (and disabled, the cooldown), ✓ for a moment once done.
  // The top bar's ⬇ counts every download in flight, from any post.
  function refreshDlButton() {
    const queue = modal && modal.dlq
    if (queue) {
      const known = [...downloading].map(p => dlPercent.get(p)).filter(v => v != null)
      const pct = known.length ? `${Math.round(known.reduce((a, b) => a + b, 0) / known.length)}%` : '…'
      queue.hidden = !downloading.size
      queue.textContent = downloading.size > 1 ? `⬇ ${downloading.size} · ${pct}` : `⬇ ${pct}`
    }
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

  function dlFinished(post, ok, reason) {
    downloading.delete(post)
    dlPercent.delete(post)
    if (ok) {
      dlDoneAt = { post, until: Date.now() + DL_DONE_MS }
      setTimeout(refreshDlButton, DL_DONE_MS)
    }
    refreshDlButton()
    if (modal && modal.open) flash(t(ok ? 'dlDone' : 'dlFail'))
    else pageToast(t(ok ? 'dlDone' : 'dlFail'))   // the modal closed meanwhile
    if (ok) info(`download: post ${post} fetched, handed to Firefox to save`)
    else warn(`download: post ${post} failed — ${reason}`)
  }

  // The post's own file, once it loaded: with the sample on screen, the
  // original, known from the cache or the post page's Original image link
  // (the sample only as a last resort).
  async function rawFileUrl() {
    const url = modal.fileUrl
    if (!url || !modal.isSample) return url
    const pic = cardPicture(modal.link)
    const hash = pic && (thumbParts(pic.src) || {}).hash
    const known = hash && knownOriginal(hash)
    if (typeof known === 'string') return known
    const page = await postInfo(postId(modal.link))
    return (page && page.original) || url
  }

  // A link that opens outside the site: rule34's fast host serves videos
  // only with the site as Referer (images it serves to anyone); its origin
  // host serves both.
  const portableUrl = (url) => url.replace(/:\/\/api-cdn\.rule34\.xxx\/(.*\.(?:mp4|webm)(?:[?#]|$))/i, '://api-cdn-mp4.rule34.xxx/$1')

  // 🔗: the raw file's link, on the clipboard.
  async function copyRawLink() {
    const raw = await rawFileUrl()
    if (!raw) { flash(t('dlWait')); return }
    const url = portableUrl(raw)
    try {
      await navigator.clipboard.writeText(url)
      flash(t('linkCopied'))
      info(`copied the file link of post ${postId(modal.link)}: ${url}`)
    } catch (e) {
      flash(t('copyFailed'))
      warn(`could not copy the file link — ${describeError(e)}`)
    }
  }

  async function modalDownload() {
    const url = await rawFileUrl()
    if (!url) { flash(t('dlWait')); return }
    const post = postId(modal.link)
    if (downloading.has(post)) { flash(t('dlBusy')); return }
    if (!GM_XHR || !siteFile(url)) {
      window.open(url, '_blank', 'noopener')
      flash(t('dlOpened'))
      info(`download: post ${post} opened in a new tab (${GM_XHR ? 'not on the site’s hosts' : 'no GM_xmlhttpRequest'})`)
      return
    }
    const ext = (url.split(/[?#]/)[0].match(/\.(\w+)$/) || [])[1] || 'bin'
    const name = `${SITE.split('.')[0]}_${post}.${ext}`
    downloading.add(post)
    refreshDlButton()
    info(`download: post ${post} as ${name}`)
    saveFile(url, name, (ok, reason) => dlFinished(post, ok, reason), (loaded, total) => {
      dlPercent.set(post, Math.round((loaded / total) * 100))
      refreshDlButton()
    })
  }

  // src/modal/modal.ts
  // ═══════════════════════════════════════════════════════════
  // E. Post modal on site pages
  //
  // Tapping a thumbnail on the site's own pages opens the post in an overlay
  // instead of leaving the page: videos play with sound, GIFs animate, images
  // show the original. Swipe sideways for the next/previous post, down to
  // close. Own Shadow DOM host, so it works with the panel off.
  // ═══════════════════════════════════════════════════════════

  const SITE_LINK = `${THUMB} a`
  const SWIPE_MIN = 60        // px sideways to change post
  const CONTROLS_BAND = 100   // bottom strip of the video: the player's own controls (the two-row capsule and its margin)

  // The post viewer: its elements (buildModal) and the post on show.
  // null until the first open builds it (buildModal); what can run before
  // then checks it (modal && …), and nothing sets it back.
  let modal = null

  const siteLinks = () => ([...document.querySelectorAll(SITE_LINK)])   // SITE_LINK ends in a

  // A like's ❤️ (popHeart): over the post or the thumbnail, it grows, shrinks
  // back, grows a little again and shrinks away to nothing, Instagram style.
  // In the modal's shadow root and in the page (injectPageCSS) alike.
  const LIKE_CSS = `
    .ibh-likeheart {
      position: absolute; left: 50%; top: 50%; z-index: 6; line-height: 1;
      filter: drop-shadow(0 2px 10px rgba(0, 0, 0, .5)); pointer-events: none; opacity: 0;
      transform: translate(-50%, -50%) scale(0); animation: ibh-likepop 1s ease-in-out forwards;
    }
    @keyframes ibh-likepop {
      20% { opacity: 1; transform: translate(-50%, -50%) scale(1.3); }
      38% { opacity: 1; transform: translate(-50%, -50%) scale(.85); }
      55% { opacity: 1; transform: translate(-50%, -50%) scale(1.1); }
      72% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      100% { opacity: 0; transform: translate(-50%, -50%) scale(0); }
    }`
  const MODAL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
    .m { position: fixed; inset: 0; z-index: 2147483600; background: rgba(0, 0, 0, .95); overflow: hidden; }
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
    /* The controls: a glass capsule floating over the bottom of the video,
       the seek bar on top and the buttons under it. */
    .vctl {
      position: absolute; left: 10px; right: 10px; bottom: 10px;
      display: flex; flex-direction: column; gap: 2px; padding: 4px 8px 4px 14px;
      border-radius: 20px; border: 1px solid rgba(255, 255, 255, .1);
      background: rgba(var(--ibh-base-rgb), .55); -webkit-backdrop-filter: blur(10px) saturate(1.2); backdrop-filter: blur(10px) saturate(1.2);
      box-shadow: 0 4px 18px rgba(0, 0, 0, .35); transition: opacity .25s, transform .25s;
    }
    .vctl.hide { opacity: 0; transform: translateY(16px); pointer-events: none; }
    .vctl button { width: 34px; height: 34px; border: none; background: transparent; color: var(--ibh-text); padding: 0; flex: none; }
    .vctl button svg, .vbig svg { width: 24px; height: 24px; fill: currentColor; }
    .vrow { display: flex; align-items: center; gap: 6px; height: 34px; }
    .vgap { flex: 1; }
    .vctl .vfav.on { color: #e5534b; }
    /* ⚙'s menu, over the capsule's right end: the speed and the double tap's jump. */
    .vmenu { position: absolute; right: 10px; bottom: ${CONTROLS_BAND}px; display: grid; gap: 10px; padding: 10px 12px;
      border-radius: 16px; border: 1px solid rgba(255, 255, 255, .1); background: rgba(var(--ibh-base-rgb), .8);
      -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); color: var(--ibh-text); font-size: 12px; }
    .vmenu { transition: opacity .2s, transform .2s, visibility 0s; }
    .vmenu[hidden] { display: grid !important; visibility: hidden; opacity: 0; transform: translateY(8px);
      transition: opacity .15s, transform .15s, visibility 0s .15s; }
    /* Android's "Remove animations": everything just shows and goes. */
    @media (prefers-reduced-motion: reduce) {
      .vctl, .bar, .side, .sheet, .sheet[hidden], .vmenu, .vmenu[hidden] { transition: none !important; }
    }
    .vmrow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; max-width: 250px; }
    .vmrow .lbl { width: 100%; opacity: .75; }
    .vmrow button { min-width: 42px; height: 30px; padding: 0 8px; border-radius: 15px; border: 1px solid rgba(255, 255, 255, .18);
      background: transparent; color: inherit; font-size: 13px; }
    .vmrow button.on { background: var(--ibh-accent); color: var(--ibh-base); border-color: var(--ibh-accent); }
    .vtime { color: var(--ibh-text2); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    /* Thin seek bar: played in the theme's teal (the range's own progress),
       downloaded in light grey (--buf, kept by the player), a thumb that
       grows while dragged; a tall input for the finger. */
    .vseek { flex: 1; min-width: 0; height: 24px; margin: 0; background: transparent; -moz-appearance: none; appearance: none; --buf: 0%; }
    .vseek::-moz-range-track { height: 4px; border-radius: 2px;
      background: linear-gradient(to right, rgba(255, 255, 255, .45) var(--buf), rgba(255, 255, 255, .16) var(--buf)); }
    .vseek::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--ibh-accent); }
    .vseek::-moz-range-thumb { width: 12px; height: 12px; border: none; border-radius: 50%; background: var(--ibh-accent); transition: transform .15s; }
    .vseek:active::-moz-range-thumb { transform: scale(1.6); }
    /* The big ▶ in the middle of a paused video. */
    .vbig {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 64px; height: 64px;
      border: 1px solid rgba(255, 255, 255, .14); background: rgba(var(--ibh-base-rgb), .5); color: #fff;
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); box-shadow: 0 4px 18px rgba(0, 0, 0, .35);
    }
    .vbig svg { width: 34px; height: 34px; margin-left: 4px; }
    .vprev {
      position: absolute; bottom: ${CONTROLS_BAND + 6}px; width: 160px; height: 90px;
      border: 1px solid var(--ibh-edge); border-radius: 6px; overflow: hidden; background: #000; pointer-events: none;
    }
    /* seekReel: the nearest keyframe, over the preview video until it reaches the exact frame. */
    .vprev canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transition: opacity .15s; }
    .vprev.exact canvas { opacity: 0; }
    .vprev span {
      position: absolute; left: 0; right: 0; bottom: 0; text-align: center; font-size: 11px;
      color: #fff; background: rgba(0, 0, 0, .55); padding: 1px 0;
    }
    /* Fullscreen shows only the post; a tap on an image brings the bar back. */
    .bar, .side { transition: opacity .25s; }
    .bar { transition: opacity .25s, transform .25s; }
    .m.clean .bar, .m.clean .side { opacity: 0; pointer-events: none; }
    .m.clean .bar { transform: translateY(-14px); }
    video { max-height: 100vh; }
    video { -webkit-touch-callout: none; user-select: none; }
    /* The whole image fits the screen, in either orientation; a comic
       (.stage.tall) goes full width and scrolls. */
    img { height: 100%; object-fit: contain; -webkit-user-drag: none; user-select: none; transform-origin: 0 0; }
    .stage.tall img { height: auto; }
    [hidden] { display: none !important; }
    .bar { position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center; gap: 8px; padding: 10px; pointer-events: none; }
    .bar > * { pointer-events: auto; }
    .count { margin-left: auto; color: var(--ibh-dim2); font-size: 13px; text-shadow: 0 1px 3px #000; }
    .dlq { padding: 4px 10px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, .12); background: rgba(var(--ibh-base-rgb), .7);
      color: var(--ibh-text); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .status { position: absolute; left: 0; right: 0; top: 50%; text-align: center; color: var(--ibh-dim2); font-size: 14px; pointer-events: none; }
    button, a.btn {
      width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center;
      border: 1px solid var(--ibh-edge); background: rgba(var(--ibh-base-rgb), .85); color: var(--ibh-accent);
      font-size: 20px; line-height: 1; text-decoration: none; padding: 0;
    }
    .side { position: absolute; top: 50%; transform: translateY(-50%); font-size: 26px; padding-bottom: 3px; }
    .prev { left: 6px; } .next { right: 6px; }
    button.on { background: var(--ibh-accent); color: var(--ibh-base); border-color: var(--ibh-accent); }
    button.up { width: auto; min-width: 42px; padding: 0 12px; border-radius: 21px; gap: 6px; display: flex; font-size: 16px; }
    .score { font-size: 13px; }
    ${LIKE_CSS}
    .badge {
      position: absolute; left: 50%; top: 64px; transform: translateX(-50%);
      padding: 6px 14px; border-radius: 16px; background: rgba(var(--ibh-base-rgb), .9); color: var(--ibh-accent);
      font-size: 15px; font-weight: 600; pointer-events: none;
    }
    .sheet {
      position: absolute; left: 0; right: 0; bottom: 0; max-height: 55%; overflow-y: auto; overscroll-behavior: contain;
      background: rgba(var(--ibh-base-rgb), .97); border-top: 1px solid var(--ibh-edge); border-radius: 14px 14px 0 0; padding: 10px 10px 18px;
      transition: transform .25s ease-out, visibility 0s;
    }
    /* Closed, it waits below the screen (invisible, out of reach) instead of
       display: none, so opening and closing slide; hidden keeps the state. */
    .sheet[hidden] { display: block !important; visibility: hidden; transform: translateY(calc(100% + 24px));
      transition: transform .2s ease-in, visibility 0s .2s; }
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
      display: inline-block; text-align: left; word-break: break-all; color: var(--ibh-text2);
    }
    button.t-artist { color: #f2ac08; border-color: #6b4e0a; }
    button.t-character { color: #3fb950; border-color: #1f5a2a; }
    button.t-copyright { color: #c678dd; border-color: #5a3566; }
    button.t-metadata { color: #e5534b; border-color: #66282a; }
    button.tag.copied { background: var(--ibh-accent); color: var(--ibh-base); border-color: var(--ibh-accent); }
    button.tag.held, button.pill.held { background: var(--ibh-accent-dark); border-color: var(--ibh-accent); }
    button.tag { user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
    .sheet .none { color: var(--ibh-faint); font-size: 13px; }
    button.quality { position: absolute; left: 12px; bottom: 16px; width: 32px; height: 32px; padding: 0;
      border-radius: 6px; font-size: 9px; font-weight: 700; letter-spacing: 0; }
    button.quality.raw { background: var(--ibh-accent-mid); color: #fff; border-color: var(--ibh-accent-mid); }
    button.quality.loading { opacity: .6; }
    .m.clean button.quality { opacity: 0; pointer-events: none; }
    /* The size of the picture on show: beside the quality square, or in its
       place on a post without a sample. */
    .res { position: absolute; left: 12px; bottom: 23px; pointer-events: none; padding: 0 5px; border-radius: 4px;
      font: 11px/18px ui-monospace, monospace; color: #fff; background: rgba(var(--ibh-base-rgb), .7); }
    button.quality:not([hidden]) + .res { left: 52px; }
    .m.clean .res { opacity: 0; }
    .tabs { display: flex; gap: 6px; margin-bottom: 10px; }
    button.tab { width: auto; height: 32px; border-radius: 16px; padding: 0 16px; font-size: 13px; }
    button.tab.on { background: var(--ibh-accent); color: var(--ibh-base); border-color: var(--ibh-accent); }
    .infolist { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: 13px; color: var(--ibh-text2); }
    .infolist[hidden], .commentlist[hidden] { display: none; }
    .commentlist { display: flex; flex-direction: column; gap: 12px; font-size: 13px; color: var(--ibh-text2); }
    .commentlist .h { color: var(--ibh-dim); font-size: 12px; margin-bottom: 3px; }
    .commentlist .h b, .commentlist .h a.who { color: var(--ibh-accent); font-weight: 600; text-decoration: none; }
    .commentlist button.cvote { width: auto; height: 24px; padding: 0 9px; border-radius: 12px; font-size: 12px;
      display: inline-flex; vertical-align: middle; margin-left: 4px; }
    .commentlist .b { white-space: pre-wrap; word-break: break-word; line-height: 1.4; }
    .commentlist .none { color: var(--ibh-dim); }
    .infolist .k { color: var(--ibh-dim); white-space: nowrap; }
    .infolist .v { word-break: break-word; }
    .infolist .v.warn { color: #f2ac08; }
    .infolist a { color: var(--ibh-accent); }
    .tagsbox[hidden] { display: none; }
    /* Watch later: a grid of the saved posts over the modal. */
    .laterview { display: none; position: absolute; inset: 0; overflow-y: auto; overscroll-behavior: contain;
      background: #0b0f11; padding: 10px; }
    .m.later-mode .laterview { display: block; }
    .m.later-mode .stage, .m.later-mode .bar, .m.later-mode .side, .m.later-mode .status, .m.later-mode .sheet { display: none; }
    .laterhead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .laterhead .lt { color: var(--ibh-text2); font-size: 16px; font-weight: 600; }
    .latergrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 6px; }
    .tile { position: relative; aspect-ratio: 1 / 1; border-radius: 8px; overflow: hidden; background: var(--ibh-base); border: 1px solid var(--ibh-edge); }
    .tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .tile .play { position: absolute; left: 6px; bottom: 6px; font-size: 13px; color: #fff; background: rgba(0,0,0,.6);
      border-radius: 10px; padding: 1px 7px; pointer-events: none; }
    .tile button.rm { position: absolute; top: 4px; right: 4px; width: 28px; height: 28px; font-size: 14px; }
    .laternote { color: var(--ibh-faint); font-size: 12px; margin-top: 14px; text-align: center; }
    .laternote a { color: var(--ibh-accent); }
    .latergrid .none { grid-column: 1 / -1; color: var(--ibh-dim); font-size: 14px; text-align: center; padding: 30px 10px; }
    .toast {
      position: absolute; left: 50%; bottom: 84px; transform: translateX(-50%);
      padding: 8px 14px; border-radius: 18px; background: rgba(var(--ibh-base-rgb), .92); color: var(--ibh-text2);
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
    // The big ▶ shows on a paused video; a tap on the video pauses (gestures).
    const playBtn = el('button', { class: 'vbig', title: t('mPlay') })
    setIcon(playBtn, PLAYER_ICON.play)
    const times = [el('span', { class: 'vtime', text: '0:00' }), el('span', { class: 'vtime', text: '0:00' })]   // where, and how long
    const seek = el('input', { class: 'vseek', type: 'range', min: '0', max: '1000', value: '0' })
    const muteBtn = el('button', { title: t('mMute') })
    setIcon(muteBtn, PLAYER_ICON.volume)
    // Bottom right, like YouTube: the way into fullscreen and back out of it,
    // where the top bar is hidden.
    const fsBtn = el('button', { class: 'vfs', title: t('mFull') })
    setFsIcon(fsBtn, false)
    // The second row: play/pause, ♥ (favorite and upvote), ⓘ (the Info tab), and on the right ⚙, sound, fullscreen.
    const playPause = el('button', { class: 'vplay', title: t('mPlay') })
    setIcon(playPause, PLAYER_ICON.play)
    const favUp = el('button', { class: 'vfav', title: t('mFavUp') })
    setIcon(favUp, PLAYER_ICON.heartLine)
    const infoBtn = el('button', { class: 'vinfo', title: t('tabInfo') })
    setIcon(infoBtn, PLAYER_ICON.info)
    const gear = el('button', { class: 'vgear', title: t('mGear') })
    setIcon(gear, PLAYER_ICON.gear)
    const gearMenu = el('div', { class: 'vmenu' })
    gearMenu.hidden = true
    const ctl = el('div', { class: 'vctl' }, [
      el('div', { class: 'vrow' }, [times[0], seek, times[1]]),
      el('div', { class: 'vrow' }, [playPause, favUp, infoBtn, el('span', { class: 'vgap' }), gear, muteBtn, fsBtn]),
    ])
    const prevBox = el('div', { class: 'vprev' }, [el('span')])
    prevBox.hidden = true
    const vwrap = el('div', { class: 'vwrap' }, [video, layer, playBtn, prevBox, gearMenu, ctl])
    const controls = installVideoControls(video, ctl, playBtn, times, seek, muteBtn, prevBox, vwrap, { playPause, gearMenu })
    installGearMenu(gear, gearMenu, video, vwrap, controls.poke)
    const stage = el('div', { class: 'stage' }, [vwrap, image])
    const close = el('button', { text: '✕', title: t('mClose') })
    const post = el('a', { class: 'btn', text: '↗', title: t('mOpen'), target: '_blank', rel: 'noopener' })   // a new tab
    const menu = el('button', { text: '☰', title: t('mMenu') })
    const tagList = el('div', { class: 'taglist' })
    const laterBtn = el('button', { class: 'pill', text: t('laterAdd') })
    const dlBtn = el('button', { class: 'pill', text: t('dlBtn') })
    const copyBtn = el('button', { class: 'pill', text: t('copyLink') })
    copyBtn.hidden = !CFG.copyLinkButton
    const playerBtn = el('button', { class: 'pill', text: '▶ Media Player' })
    playerBtn.hidden = true   // videos only (showVideo)
    const appDlBtn = el('button', { class: 'pill', text: t('appDlBtn') })
    appDlBtn.hidden = true    // with playerBtn
    const appReduceBtn = el('button', { class: 'pill', text: t('appReduceBtn') })
    appReduceBtn.hidden = true   // videos past the hardware decoder only
    const tabTags = el('button', { class: 'tab on', text: t('tabTags') })
    const tabInfo = el('button', { class: 'tab', text: t('tabInfo') })
    const tabComments = el('button', { class: 'tab', text: t('tabComments') })
    const infoList = el('div', { class: 'infolist' })
    infoList.hidden = true
    const commentList = el('div', { class: 'commentlist' })
    commentList.hidden = true
    const sheet = el('div', { class: 'sheet' }, [el('div', { class: 'sheethead' }, [post, laterBtn, dlBtn, copyBtn, playerBtn, appDlBtn, appReduceBtn]),
      el('div', { class: 'tabs' }, [tabTags, tabInfo, tabComments]), tagList, infoList, commentList])
    // Sample or raw, for an image that has a sample: tap to switch.
    const quality = el('button', { class: 'quality' })
    quality.hidden = true
    // The size of the picture on show (setRes), beside the quality square.
    const res = el('span', { class: 'res' })
    res.hidden = true
    const laterClose = el('button', { text: '✕', title: t('mClose') })
    const laterHead = el('div', { class: 'laterhead' }, [el('span', { class: 'lt' }), laterClose])
    const laterGrid = el('div', { class: 'latergrid' })
    const laterNote = el('div', { class: 'laternote' })
    const laterView = el('div', { class: 'laterview' }, [laterHead, laterGrid, laterNote])
    sheet.hidden = true
    const full = el('button', { text: '⛶', title: t('mFull') })
    const turn = el('button', { text: '↻', title: t('mTurn') })
    const count = el('span', { class: 'count' })
    const dlq = el('span', { class: 'dlq' })   // downloads in flight, from any post
    dlq.hidden = true
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
    const box = el('div', { class: 'm' }, [stage, status, el('div', { class: 'bar' }, [close, menu, full, turn, fav, up, count, dlq]), prev, next, quality, res, sheet, laterView, toast, badge])
    close.addEventListener('click', () => closeModal(false))
    full.addEventListener('click', () => toggleModalFullscreen())
    menu.addEventListener('click', () => toggleMenu())
    tabTags.addEventListener('click', () => showTab('tags'))
    tabInfo.addEventListener('click', () => showTab('info'))
    tabComments.addEventListener('click', () => showTab('comments'))
    // A tap outside the open menu only closes it: no step, no close, no pause.
    let swallowClick = 0
    box.addEventListener('pointerdown', ev => {
      if (sheet.hidden) return
      const path = ev.composedPath()
      if (path.includes(sheet) || path.includes(menu) || path.includes(infoBtn)) return   // ⓘ switches the tab itself
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
    playerBtn.addEventListener('click', () => sendToApp('play'))
    appDlBtn.addEventListener('click', () => sendToApp('download'))
    appReduceBtn.addEventListener('click', () => sendToApp('reduce'))
    // 🔗: a tap copies the file's link, a hold opens the file in a new tab.
    // The link is asked for as the finger lands, so it is there by the time
    // the hold ends (the tab must open within that gesture).
    let rawHref = null
    const askRaw = () => { rawHref = null; rawFileUrl().then(u => { rawHref = u }, () => {}) }
    copyBtn.addEventListener('touchstart', askRaw, { passive: true })
    copyBtn.addEventListener('pointerdown', ev => { if (ev.pointerType === 'mouse') askRaw() })
    chipGestures(copyBtn, () => rawHref, () => copyRawLink(), 'the post\'s file')
    laterClose.addEventListener('click', () => closeModal(false))
    quality.addEventListener('click', () => toggleQuality())
    image.addEventListener('load', () => setRes(image))   // every swap: the page's copy, sample, raw
    fsBtn.addEventListener('click', () => toggleModalFullscreen())
    turn.addEventListener('click', () => turnScreen())
    fav.addEventListener('click', modalFavorite)
    up.addEventListener('click', modalUpvote)
    // The player's ♥ only adds (with its upvote): taking a favorite back stays with the top ♥.
    favUp.addEventListener('click', () => {
      if (fav.classList.contains('on')) { flash(t('favAlready')); return }
      modalFavorite()
    })
    infoBtn.addEventListener('click', () => toggleInfo())
    prev.addEventListener('click', () => stepModal(-1))
    next.addEventListener('click', () => stepModal(1))
    // Tap on the empty area around the media closes. The image fills the
    // stage since it fits by object-fit, so its black bars count as empty too.
    stage.addEventListener('click', ev => {
      if (ev.target === stage || (ev.target === image && zoom.scale === 1 && !onImageContent(ev))) closeModal(false)
    })
    installModalSwipe(stage, video)
    installImageZoom(stage, image)
    installImageHold(stage, image, box)
    installVideoGestures(layer, video)
    root.append(style, box)
    // link: null until openModal sets it (showLater opens the list without one).
    modal = { host, root, box, stage, vwrap, video, image, controls, post, count, status, fav, up, vfav: favUp, gearMenu, dlq, score, toast, badge, turn, fsBtn, menu, sheet, tagList, laterBtn, dlBtn, playerBtn, appDlBtn, appReduceBtn, quality, res, tabTags, tabInfo, tabComments, infoList, commentList, sheetTab: 'tags', laterView, laterHead, laterGrid, laterNote, listLinks: null, turned: null, open: false, link: null, seq: 0 }
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
  // ids: f favorites, v upvoted posts, c upvoted comments
  let marks = null

  function loadMarks() {
    if (!marks) {
      const m = readJSON(MARKS_KEY, {})
      marks = { f: new Set(m.f || []), v: new Set(m.v || []), c: new Set(m.c || []) }   // c: upvoted comments
    }
    return marks
  }

  function setMark(kind, id, on) {
    const set = loadMarks()[kind]
    if (on === set.has(id)) return
    if (on) set.add(id)
    else set.delete(id)
    while (set.size > MARKS_MAX) set.delete(set.values().next().value)   // not empty
    // loadMarks() above filled marks.
    writeJSON(MARKS_KEY, { f: [...(marks).f], v: [...(marks).v], c: [...(marks).c] })
  }

  const hasMark = (kind, id) => loadMarks()[kind].has(id)

  function readCookie(name) {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
    return m ? m[1] : null
  }

  /**
   * Touches inside the panel are not page gestures.
   */
  function insidePanel(ev) {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : []
    return panelHost ? path.includes(panelHost) : false
  }

  // An event's target as an element (one with closest()), or null: a text
  // node, the document, the window, or no target outside a dispatch.
  function asElement(target) {
    return target && (target).closest ? (target) : null
  }

  // src/thumbs/memory.ts
  // ═══════════════════════════════════════════════════════════
  // D. Memory management
  //
  // Upgraded images stay decoded while the page lives, so a long feed keeps
  // every original it ever showed. Release what scrolled far away, unload
  // videos taken out of the page, and drop everything when the page is left.
  // ═══════════════════════════════════════════════════════════

  // Two screens of slack each way: far enough that a quick scroll back does
  // not refetch, close enough that a long feed keeps only a few originals.
  const FAR_MARGIN = '200% 0px'

  const farViewport = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        for (const e of entries) if (!e.isIntersecting) releaseFar(e.target)   // watchDistance's images
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

  // Called by farViewport itself.
  function releaseFar(el) {
    if (el.dataset.ibhOrig !== 'done') { (farViewport).unobserve(el); return }
    pinHeight(el)
    resetUpgrade(el)
    ;(farViewport).unobserve(el)
    if (originalViewport) originalViewport.observe(el)   // upgraded again when it comes back
    releasedCount++
    if (releasedCount % 10 === 1) dbg(`memory: released ${releasedCount} off-screen images so far`)
  }

  // Recount from the document. The decoders lent to a scene preview count too:
  // leaving them out let covers open past the phone's limit mid-preview.
  const liveDecoders = () => document.querySelectorAll('video[data-ibh]').length + decodersBorrowed

  // A <video> taken out of the page (search results replacing the list, a
  // card rebuilt) keeps its decoder until garbage collection, and the
  // live-cover count would never come back down. Unload them and recount
  // from what is actually in the document.
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
    setLiveCovers(liveDecoders())
    for (const card of coverQueue) if (!card.isConnected) coverQueue.delete(card)
    dbg(`memory: unloaded ${unloaded} videos removed from the page`)
  }

  // Leaving the page: release everything so the copy Firefox keeps for the
  // back button is light. Coming back from that copy, start the page over.
  function releaseAll() {
    coverQueue.clear()   // first, or each unmount hands its slot to a queued card
    markedCards('[data-ibh-cover]').forEach(card => unmountCover(card))
    markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach(card => stopGif(card))
    markedImages('[data-ibh-orig="done"]').forEach(el => {
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
    // A safety net: a GIF whose turn came while nextGif() had to wait (a
    // finger on a video card, the modal, a hidden tab) starts here at the latest.
    nextGif()
  }

  // A tab in the background decodes nothing, yet its covers and GIFs keep
  // their memory. Park them while hidden and bring them back on return.
  // GIFs still downloading go too: Android freezes Firefox in the background,
  // and a download cut there would leave the GIF marked as missing.
  const parked = []

  function onVisibilityChange() {
    if (modal && modal.open) return   // the modal already unloaded the page
    if (document.hidden) {
      parked.push(...coverQueue)
      coverQueue.clear()   // first, or each unmount hands its slot to a queued card
      markedCards('[data-ibh-cover]').forEach(card => { unmountCover(card); parked.push(card) })
      markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach(card => { stopGif(card); parked.push(card) })
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
    markedCards('[data-ibh-gif="playing"]').forEach(c => {
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
    window.addEventListener('pagehide', releaseAll)
    window.addEventListener('pageshow', ev => { if (ev.persisted) redoThumbs() })
    info('memory saver active: off-screen images, GIFs and covers are released (every 15 s, after scrolls, while hidden, before previews)')
  }

  // src/thumbs/feed.ts
  // ═══════════════════════════════════════════════════════════
  // B. Sharp thumbnails: feed samples and originals
  //
  // Swaps visible thumbnails for a sharper file: the sample in the feed (the
  // original when there is none) and, with originalThumbs, the original where
  // the box shows wider than the sample (upgradePlan). The thumbnail is always
  // .jpg, so the real extension is unknown: each one is tried in an off-screen
  // Image and the visible <img> only changes once one loads, so nothing
  // flickers. Originals cost several times the data and memory of the
  // sample, which is why originalThumbs ships off.
  // ═══════════════════════════════════════════════════════════

  const ORIGINAL_EXTS = ['jpg', 'png', 'jpeg']   // no gif: animated originals are heavy

  // In the one-column feed a 150 px thumbnail is stretched to the screen width.
  // The sample (about 850 px) is already sharp there and far lighter than the
  // original; posts too small to have a sample fall through to the original.
  const inFeed = (el) => CFG.nativeFeed && !!el.closest(LIST)

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
    const box = el.closest(THUMB) || el
    return (box.clientWidth || el.clientWidth || 0) * (window.devicePixelRatio || 1)
  }

  function upgradePlan(el, src) {
    if (thumbKind(el) === 'video') return { kind: 'poster', stages: [fileCandidates(src, ['jpg'])] }
    const originals = fileCandidates(src, ORIGINAL_EXTS)
    const sitePage = true
    const sampleDoes = sitePage && (!CFG.originalThumbs || displayPixels(el) <= SAMPLE_WIDTH * 1.1)
    if (sampleDoes && (inFeed(el) || CFG.originalThumbs)) return { kind: 'sample', stages: [sampleCandidates(src), originals] }
    return { kind: 'orig', stages: [originals] }
  }

  // Downloads already run on the browser's network threads; the slots shared
  // with GIFs (IMAGE_MAX_INFLIGHT, see B) cap how many the script starts at once.
  // Targets are the thumbnails (and samples) on the site's pages.
  const ORIGINAL_SELECTOR = 'img[src*="/thumbnails/"], img[src*="/samples/"]'
  const originalQueue = []
  let upgradeGen = 0   // bumped by freeMemory(): upgrades already in flight drop their result
  function setUpgradeGen(v) { upgradeGen = v }


  function pictureOf(el) {
    return imgPicture(el)
  }

  // The kind of post a thumbnail shows, taken from its link, which is what the
  // cover and GIF code treat as the card (the tags sit in title/alt).
  function thumbKind(el) {
    const card = el.closest('a') || el.parentElement
    if (card && isGifCard(card)) return 'gif'
    if (card && isVideoCard(card)) return 'video'
    return 'image'
  }

  /**
   * Returns true once the element needs no more watching.
   */
  function upgradeToOriginal(el) {
    if (el.dataset.ibhOrig) return true   // already queued, done or failed
    // Without originalThumbs, only feed images on site pages get upgraded.
    if (!CFG.originalThumbs && !inFeed(el)) return true
    if (thumbKind(el) === 'gif') return true   // inline GIFs have their own path
    // No picture yet: try on the next intersection.
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

  let pumpAfterRead = false
  function pumpOriginals() {
    const later = []   // their URLs may still come from IndexedDB
    while (imagesInflight < IMAGE_MAX_INFLIGHT && originalQueue.length) {
      const el = nextQueued()
      if (!el) break
      const pic = pictureOf(el)
      if (!pic) continue
      const plan = upgradePlan(el, pic.src)
      const ck = { kind: plan.kind, hash: (thumbParts(pic.src) || {}).hash }
      if (urlPending(ck.kind, ck.hash)) { later.push(el); continue }
      ck.cached = cacheGet(ck.kind, ck.hash)
      if (ck.cached === null) { el.dataset.ibhOrig = 'failed'; continue }   // known: nothing loads
      setImagesInflight(imagesInflight + 1)
      probeOriginal(el, pic.src, plan.stages, giveImageSlot, ck)
    }
    if (!later.length) return
    originalQueue.push(...later)
    if (!pumpAfterRead && urlReading) {
      pumpAfterRead = true
      urlReading.then(() => { pumpAfterRead = false; pumpOriginals() })
    }
  }

  // The candidates race (raceImage): a wrong extension costs nothing, where
  // trying them in turn held a download slot ~0.5 s per miss.
  // ck: where the winner is cached, and what cacheGet had for it.
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
      if (el.dataset.ibhRaw) { done(); return }   // held for the raw file meanwhile: keep it
      // The modal unloads the page while it is open: drop this upgrade and let
      // it run again when the modal closes.
      if (modal && modal.open) {
        delete el.dataset.ibhOrig
        suspended.push(el)
        done()
        return
      }
      // Out of the feed the thumbnail has no fixed box: pin its current size so
      // the full-resolution file does not blow up the page layout.
      if (!inFeed(el) && el.clientWidth) {
        el.style.width = `${el.clientWidth}px`
        el.style.height = `${el.clientHeight}px`
        el.style.objectFit = 'contain'
      }
      if (el.tagName === 'IMG') el.decoding = 'async'
      const pic = pictureOf(el)
      if (pic) pic.set((probe).src)   // already in cache and decoded, so this paints at once
      const link = el.closest(SITE_LINK)
      if (link) setShown(link, (probe).naturalWidth, (probe).naturalHeight)   // the badge: this file's size
      el.dataset.ibhThumb = from    // what freeMemory() and redoThumbs() put back
      el.dataset.ibhOrig = 'done'
      unpinHeight(el)
      watchDistance(el)   // released again once it is far off screen, see G
      dbg(`original: ${(probe).src}`)   // swap runs once the race won
      done()
    }
  }

  const originalViewport = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          // Scrolled in under the modal: wait for it to close (resumePage observes again).
          // The observer is this very one, and what it watches are scanThumbs' images.
          if (modal && modal.open) { (originalViewport).unobserve(e.target); suspended.push(e.target); continue }
          if (upgradeToOriginal(e.target)) (originalViewport).unobserve(e.target)
        }
      }, { rootMargin: '300px' })
    : null

  const watchedThumbs = new WeakSet()

  function scanThumbs(root) {
    if (!(CFG.originalThumbs || CFG.nativeFeed) || !root || !root.querySelectorAll) return
    const found = [...root.querySelectorAll(ORIGINAL_SELECTOR)]
    if (root.matches && root.matches(ORIGINAL_SELECTOR)) found.push(root)   // matched img[…]
    for (const el of found) {
      if (watchedThumbs.has(el)) continue
      watchedThumbs.add(el)
      urlPrefetch(el.getAttribute('src'))
      originalViewport ? originalViewport.observe(el) : upgradeToOriginal(el)
    }
  }

  // src/thumbs/covers.ts
  // ═══════════════════════════════════════════════════════════
  // A. Real video covers
  // ═══════════════════════════════════════════════════════════


  const tracked = new WeakSet()

  // The elements carrying one of this script's own data-ibh-* marks, typed as
  // what it marks: cards (a thumbnail's link) and, for data-ibh-orig, their
  // <img>. Only the selectors below are accepted, so a lookup can't claim a
  // type for a mark the script puts elsewhere.
  function markedCards(selector) {
    return document.querySelectorAll(selector)
  }
  function markedImages(selector) {
    return document.querySelectorAll(selector)
  }

  // A card is the link around a thumbnail (Gelbooru 0.2 markup). The kind
  // comes from the tags in the thumbnail's title or alt, or the site's own
  // .webm-thumb mark. "animated" alone may be either kind: it counts as video,
  // and the cover falls back to the GIF when no video host answers.
  const nativeTags = (card) => {
    const img = card.querySelector('img')
    return ` ${(img && (img.title || img.alt)) || ''} `
  }
  const NATIVE_GIF = /\s(gif|animated_gif)\s/i
  const NATIVE_VIDEO = /\s(video|mp4|webm|animated)\s/i
  const NATIVE_REAL_VIDEO = /\s(video|mp4|webm)\s/i   // "animated" alone may be a GIF
  const isVideoCard = (card) => !!card.querySelector('img.webm-thumb') ||   // the site's own video mark
    (NATIVE_VIDEO.test(nativeTags(card)) && !NATIVE_GIF.test(nativeTags(card)))
  const isGifCard = (card) => card.dataset.ibhKind === 'gif' || NATIVE_GIF.test(nativeTags(card))

  const cardPicture = (card) => { const img = card.querySelector('img'); return img ? imgPicture(img) : null }

  // On an <img>, the better file goes in srcset and src is left alone: the
  // browser paints the srcset candidate, while src keeps the site's thumbnail
  // URL for everything that reads it (Imagus and other hover-zoom tools match
  // on the thumbnail_ pattern). Setting the thumbnail back (or nothing) clears
  // srcset.
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

  // Firefox for Android decodes about four videos at once on a mid-range phone;
  // past that, new <video> elements sit at "metadata" forever or fail with a
  // decode error. Keep covers under the limit, with one decoder spare for the
  // viewer, and hand freed slots to cards still waiting on screen.
  const COVER_MAX_LIVE = 3
  const COVER_POINT = 0.35   // where in the video the cover frame is taken
  let liveCovers = 0
  function setLiveCovers(v) { liveCovers = v }
  const coverQueue = new Set()

  // A card element can be rebuilt (the autopager, a page restored from the
  // back button), so "this is a GIF" is remembered by file hash, not on it.
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
    if (!pic) return
    // Tags call some GIFs videos ("animated" alone). Once a file proved to be
    // a GIF, go straight to the GIF path.
    const parts = thumbParts(pic.src)
    const wait = parts && urlPending('video', parts.hash)
    if (wait) {   // its URL may still come from IndexedDB
      // A post opened meanwhile: resumePage() brings the cover back on close.
      wait.then(() => { if (card.isConnected && card.dataset.ibhSeen && !(modal && modal.open)) mountCover(card) })
      return
    }
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
      markDuration(card, v.duration)
      // Past a mid-range hardware decoder (this phone's stops at 1920×1088):
      // decoding a frame falls to the CPU, for a still the poster already
      // gives. Drop the cover and leave the picture (the feed upgrades it to
      // the full-size poster frame).
      setDims(postId(card), v.videoWidth, v.videoHeight)
      if (pastDecoder(v.videoWidth, v.videoHeight)) {
        markPastDecoder(card, `${v.videoWidth}x${v.videoHeight}`)
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
    const thumb = card.querySelector('img')
    if (thumb) {
      v.style.border = getComputedStyle(thumb).border
      v.style.boxSizing = 'border-box'
      v.style.borderRadius = '0'
    }

    if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
    // Sit right above the picture, under anything the site lays over it.
    const picEl = card.querySelector(':scope > img')
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
  function setImagesInflight(v) { imagesInflight = v }
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
  const gifsLive = () => markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').length

  // How far a card's middle sits from the middle of the screen, in px.
  const fromMiddle = (card) => Math.abs(card.getBoundingClientRect().top + card.offsetHeight / 2 - window.innerHeight / 2)

  function nextGif() {
    // Stopped to free memory (the modal, a scene preview, a hidden tab): those
    // bring their GIFs back themselves when they end.
    if (document.hidden || (modal && modal.open) || scrub) return
    const max = Number(CFG.gifMaxLive) || 3
    const waiting = [...gifQueue].filter(card => {
      if (card.isConnected && card.dataset.ibhSeen && !card.dataset.ibhGif) return true
      gifQueue.delete(card)
      return false
    })
    waiting.sort((a, b) => fromMiddle(a) - fromMiddle(b))
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
    const live = [...markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]')]
      .sort((a, b) => Math.abs(b.getBoundingClientRect().top - middle) - Math.abs(a.getBoundingClientRect().top - middle))
    // The farthest ones, past the limit.
    for (const card of live.splice(0, live.length - max)) {
      stopGif(card)
      gifQueue.add(card)
    }
    nextGif()
  }

  // A GIF still downloading, per card: stopGif cancels it, which hands its
  // download slot on at once. A GIF scrolled past used to keep its slot until
  // the whole file came (forever when the download stalled), and with all
  // three held no other GIF started.
  const gifLoads = new WeakMap()

  function playGif(card) {
    if (card.dataset.ibhGif) return   // loading, playing or failed
    if (gifRebuild && gifRebuild !== card) { gifQueue.add(card); return }   // after the held one
    if (gifsLive() >= (Number(CFG.gifMaxLive) || 3)) { gifQueue.add(card); return }   // waits its turn
    const pic = cardPicture(card)
    if (!pic) return
    const hash = (thumbParts(pic.src) || {}).hash
    // Its URL may still come from IndexedDB: in the queue until then.
    const wait = urlPending('gif', hash)
    if (wait) { gifQueue.add(card); wait.then(nextGif); return }
    const gcached = cacheGet('gif', hash)
    const urls = cachedFirst(fileCandidates(pic.src, ['gif']), gcached)
    if (!urls.length) { dbg('gif card outside the derivable pattern'); return }
    if (gcached === null) { card.dataset.ibhGif = 'failed'; return }   // known: no .gif for it

    card.dataset.ibhGif = 'loading'
    const probe = new Image()
    let i = 0
    let held = false   // a download slot, once takeImageSlot hands one over
    let live = true    // false once stopGif cancelled this load
    const release = () => { if (held) { held = false; giveImageSlot() } }
    gifLoads.set(card, () => {
      live = false
      probe.onload = probe.onerror = null
      probe.removeAttribute('src')   // Firefox drops the download
      release()
    })
    const tryNext = () => {
      if (i >= urls.length) {
        gifLoads.delete(card)
        release()
        card.dataset.ibhGif = 'failed'
        cacheSet('gif', hash, null)
        if (card.dataset.ibhKind === 'gif') { STATE.covers.failed++; touch() }
        dbg(`gif: no host answered for ${pic.src}`)
        if (gifRebuild === card) warn('gif: held to rebuild it, but no host answered')
        endGifRebuild(card)
        nextGif()   // its place goes to a waiting one
        return
      }
      probe.src = urls[i++]
    }
    probe.onload = () => {
      gifLoads.delete(card)
      release()
      cacheSet('gif', hash, probe.src, gcached)
      if (card.dataset.ibhGif !== 'loading') return
      card.dataset.ibhStill = pic.src
      // The card's <img> had a src when the probe started, and nothing in the
      // script takes either away (resets change srcset only).
      ;(cardPicture(card)).set(probe.src)
      card.dataset.ibhGif = 'playing'
      watchGif(card)
      endGifRebuild(card, GIF_REBUILD_GRACE_MS)
      if (card.dataset.ibhKind === 'gif') { STATE.covers.ok++; touch() }
      dbg(`gif: playing ${probe.src}`)
    }
    probe.onerror = tryNext
    takeImageSlot(() => {
      if (!live) { giveImageSlot(); return }   // stopped while it waited for the slot
      held = true
      tryNext()
    })
  }

  // An animated GIF keeps every decoded frame, and under memory pressure
  // Firefox drops it and shows a broken image. Watch the <img> after the swap;
  // when it breaks, free more memory and build the GIF again, twice at most.
  const GIF_RETRIES = 2

  function watchGif(card) {
    const img = card.querySelector('img')
    if (!img || img.dataset.ibhGifWatch) return
    img.dataset.ibhGifWatch = '1'
    const check = (ev) => {
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

  // holdGif: a GIF left broken or on its still is built again on a hold,
  // ahead of the others. Their decoded frames are what runs the phone out
  // of memory, so they stop and wait in the queue until this one plays (a
  // grace for its first frames, a cap for a download that stalls), and what
  // is off screen goes. Its retries, its failure and its remembered miss
  // start over.
  const GIF_REBUILD_GRACE_MS = 1000
  const GIF_REBUILD_MAX_MS = 10000
  let gifRebuild = null   // the held GIF, while the others wait for it
  let gifRebuildTimer = 0

  function rebuildGif(card) {
    const pic = cardPicture(card)
    if (!pic) return
    const freed = freeOffscreen(card)
    let paused = 0
    markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach(c => {
      if (c === card) return
      stopGif(c)
      gifQueue.add(c)   // back once the held one plays
      paused++
    })
    const was = card.dataset.ibhGif || 'still'
    stopGif(card)
    delete card.dataset.ibhGif   // stopGif leaves a failed one marked
    delete card.dataset.ibhGifRetries
    forgetMiss('gif', (thumbParts(pic.src) || {}).hash)
    gifRebuild = card
    clearTimeout(gifRebuildTimer)
    gifRebuildTimer = setTimeout(() => endGifRebuild(card), GIF_REBUILD_MAX_MS)
    info(`gif: held, rebuilding it (was ${was}); ${paused} other GIFs paused until it plays, freed ${freed.images} images, ${freed.gifs} GIFs, ${freed.covers} covers off screen`)
    playGif(card)
  }

  // The others' turn, `after` ms from now. Called when the held GIF plays,
  // fails or stops; a call for another card changes nothing.
  function endGifRebuild(card, after = 0) {
    if (gifRebuild !== card) return
    clearTimeout(gifRebuildTimer)
    gifRebuildTimer = setTimeout(() => {
      if (gifRebuild !== card) return
      gifRebuild = null
      nextGif()
    }, after)
  }

  // Release what is not on screen: upgraded images back to the thumbnail
  // (heights held), other GIFs stilled, covers closed. On screen means within
  // one screen of the viewport.
  function freeOffscreen(keep) {
    const n = { images: 0, gifs: 0, covers: 0 }
    const far = (el) => {
      const r = el.getBoundingClientRect()
      return r.bottom < -window.innerHeight || r.top > window.innerHeight * 2
    }
    markedImages('[data-ibh-orig="done"]').forEach(el => {
      if (!far(el)) return
      pinHeight(el)
      resetUpgrade(el)
      if (farViewport) farViewport.unobserve(el)
      if (originalViewport) originalViewport.observe(el)   // upgraded again when it comes back
      n.images++
    })
    markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach(card => {
      if (card !== keep && far(card)) { stopGif(card); n.gifs++ }
    })
    markedCards('[data-ibh-cover]').forEach(card => {
      if (far(card)) { unmountCover(card); n.covers++ }
    })
    return n
  }

  function stopGif(card) {
    endGifRebuild(card)
    gifQueue.delete(card)
    const cancel = gifLoads.get(card)
    if (cancel) { gifLoads.delete(card); cancel() }
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
          const card = e.target   // what trackCard observes
          if (e.isIntersecting) card.dataset.ibhSeen = '1'
          else delete card.dataset.ibhSeen
          // The page scrolls under the modal as it steps (H): keep it unloaded;
          // resumePage() brings back what is seen on close.
          if (modal && modal.open) continue
          if (isVideoCard(card) && card.dataset.ibhKind !== 'gif') {
            e.isIntersecting ? mountCover(card) : unmountCover(card)
          } else if (!e.isIntersecting) {
            stopGif(card)
          } else if (CFG.gifInline) {
            playGif(card)   // a "video" that proved a GIF is watched for its cover: inline GIFs may be off
          }
        }
      }, { rootMargin: '200px' })
    : null

  function trackCard(card) {
    if (tracked.has(card)) return
    tracked.add(card)
    urlPrefetch(card.querySelector('img')?.getAttribute('src'))
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
  const NATIVE_THUMB = `${THUMB} img`

  // A node of any kind, as a mutation brings it: only elements and documents
  // have these, checked before they are called.

  function scanCards(root) {
    if (!root || !root.querySelectorAll) return
    // The selector ends in img: these are images.
    const imgs = [...root.querySelectorAll(NATIVE_THUMB)]
    if (root.matches && root.matches(NATIVE_THUMB)) imgs.push(root)
    for (const img of imgs) {
      // Inside a card (the selector's THUMB), so it has a parent.
      const link = (img.closest('a') || img.parentElement)
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
      paintCardMarks(link)
    }
  }

  // src/scrub/scrub.ts
  // ═══════════════════════════════════════════════════════════
  // C. Scene preview
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
  // wanted: the seek to start once the one in flight lands; pending: the
  // fraction asked before the duration was known; rest: the finger-rest timer.
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
      // These run with st set for good (no narrowing reaches into them).
      v.addEventListener('seeked', () => {
        if ((st).wanted === null) return
        const t = (st).wanted
        ;(st).wanted = null
        seekTo(v, t)
      })
      // Asked before the duration was known: seek once it is.
      v.addEventListener('loadedmetadata', () => {
        if ((st).pending === null) return
        const p = (st).pending
        ;(st).pending = null
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
  function setPreviewEl(v) { previewEl = v }

  /**
   * @param hash   the file's, to cache the host that has it
   */
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
    setLiveCovers(liveCovers + 1)
    if (liveCovers <= COVER_MAX_LIVE) return
    const victim = [...markedCards('[data-ibh-cover]')].find(c => c !== card)
    if (!victim) return
    unmountCover(victim)   // its releaseCover sees the budget still full: nothing remounts
    if (victim.dataset.ibhSeen) coverQueue.add(victim)
  }

  function returnDecoder() {
    if (!decodersBorrowed) return
    decodersBorrowed--
    releaseCover()   // a queued cover takes the slot back
  }

  // Right above the picture, under anything the site lays over it.
  function placeOverPicture(card, node) {
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
    const picEl = card.querySelector(':scope > img')
    if (picEl) picEl.after(node)
    else card.appendChild(node)
  }

  // ── Scrubbing a thumbnail ──
  const SCRUB_SLOP = 8   // px of travel before a drag counts as a scrub or a scroll

  // A finger on a video card, from the touch to the lift. It starts with the
  // pointer's fields; scrubSource, scrubUi and the slideshow fill in the rest
  // before reading them.

  let scrub = null
  let scrubClickUntil = 0

  function onScrubDown(ev) {
    if (scrub || insidePanel(ev) || (modal && modal.open)) return
    if (ev.pointerType === 'mouse' && ev.button !== 0) return
    // A press on a hold chip (⏮, 🔊) is a tap on it (onScrubClick), not a hold.
    if (asElement(ev.target)?.closest('[data-ibh-chip], .ibh-liked')) return
    // data-ibh-video marks cards (trackCard).
    const card = asElement(ev.target)?.closest('[data-ibh-video]')
    if (!card || card.dataset.ibhKind === 'gif') return
    scrub = { card, id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, on: false, holdTimer: 0 }
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
    scrub.stats = { t0: performance.now(), method: null, first: null, last: 0, shown: 0, gaps: [] }
    // holdVideo: the video itself, unless its cover already knows it is past
    // the hardware decoder (then the slideshow below, as without the option).
    if (CFG.holdVideo && !scrub.card.dataset.ibhBigVideo) {
      if (!startScrub()) { dropScrub(); return }
      holdVideoShow(scrub)
      return
    }
    if (CFG.slideReel && startReelShow(scrub)) return
    if (!startScrub()) { dropScrub(); return }
    if (CFG.slideReel) chooseShow(scrub)   // WebM: no reel, but a short clip plays
    else seekShow(scrub)
  }


  // holdVideo: the video plays from its start at 1×, muted and looping, in a
  // <video>, which Firefox decodes on the phone's hardware decoder (the GPU
  // path) instead of the slideshow's keyframes on the CPU. One past that
  // decoder would play on the CPU and stutter: it gets the scenes instead,
  // by its size at once, or by its frame rate a second into playing (a
  // <video> doesn't tell its fps: frames counted over the time played).
  const HOLD_FPS_SLACK = 1.04

  function holdVideoShow(s) {
    const v = s.video
    // Past the decoder the slideshow is forced: from keyframes when the file
    // has an index to read (MP4), else by seeking the file.
    const tooHeavy = (what) => {
      markPastDecoder(s.card, what)
      info(`hold: ${what} is past the hardware decoder, the slideshow instead of the video`)
      if (!(CFG.slideReel && startReelShow(s))) seekShow(s)
    }
    const decide = () => {
      if (scrub !== s) return
      markDuration(s.card, v.duration)
      if (pastDecoder(v.videoWidth, v.videoHeight)) { tooHeavy(`${v.videoWidth}x${v.videoHeight}`); return }
      playShow(s, 1, 0)   // from 00:00, or where the last hold lifted (holdResume)
      const frames = () => (v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : 0)
      let start = null
      const measure = () => {
        if (scrub !== s || s.stats.method !== 'play') { v.removeEventListener('timeupdate', measure); return }
        if (v.paused || v.seeking) { start = null; return }   // a rub (holdRub): count again once it plays
        if (!start) { start = { f: frames(), t: v.currentTime }; return }
        const dt = v.currentTime - start.t
        if (dt < 0) { start = null; return }   // looped back: count again
        if (dt < 1) return
        v.removeEventListener('timeupdate', measure)
        const fps = (frames() - start.f) / dt
        s.stats.fps = fps
        // Frames counted over a second wobble by one or two: the rule gets
        // the rate with that slack taken off (1080p60 counted as 61 fits).
        if (!pastDecoder(v.videoWidth, v.videoHeight, fps / HOLD_FPS_SLACK)) return
        endPlayShow(s)
        tooHeavy(`${v.videoWidth}x${v.videoHeight} at ${Math.round(fps)} fps`)
      }
      v.addEventListener('timeupdate', measure)
    }
    if (v.readyState >= 1) decide()
    else v.addEventListener('loadedmetadata', decide, { once: true })
  }

  // The slideshow by seeking the file itself, two videos taking turns.
  function seekShow(s) {
    s.stats.method = 'seek'
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
    s.video.after(h)   // right above the first video
    const view = slideView(s, h, true)
    s.helper = view
    s.views.push(view)
    loadSlide(s, view)
  }

  function dropSlideHelper(s) {
    const view = s.helper
    if (!view) return
    s.helper = null
    view.v.removeEventListener('seeked', view.onSeeked)   // set by slideView
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
    noteScene(s)
  }

  // What a hold costs, for the log: the wait for the first scene, then
  // between scenes (the dwell is the floor).
  function noteScene(s) {
    const st = s.stats
    if (!st) return
    const now = performance.now()
    if (st.first === null) st.first = now - st.t0
    else st.gaps.push(now - st.last)
    st.last = now
    st.shown++
  }

  function logSlideStats(s) {
    const st = s.stats
    if (!st || !st.method) return
    const dwell = (Number(CFG.slideDwell) || 0.2) * 1000
    const avg = st.gaps.length ? Math.round(st.gaps.reduce((a, b) => a + b, 0) / st.gaps.length) : 0
    const late = st.gaps.filter(g => g > dwell + 300).length
    const shown = st.first === null ? `no scene in ${Math.round(performance.now() - st.t0)} ms`
      : st.method === 'play' ? `playing after ${Math.round(st.first)} ms at ${st.rate ?? PLAY_RATE}×${st.fps ? `, ${Math.round(st.fps)} fps` : ''}${st.sound ? `, ${st.sound}` : ''}` +
          (st.resumed !== undefined ? `, resumed at ${mmss(st.resumed)}` : '') + (st.kept !== undefined ? `, lifted at ${mmss(st.kept)}` : '') +
          (st.rubs ? `, rubbed ${st.rubs}×` : '')
        : `${st.shown} scenes, first after ${Math.round(st.first)} ms${avg ? `, then every ${avg} ms` : ''} (dwell ${dwell}), ${late} late`
    const v = s.video
    const what = (st.detail || (v ? `${v.videoWidth}x${v.videoHeight}, ${mmss(v.duration)}, ${s.shared ? 'own video' : 'its cover'}` : '')) +
      (st.wasm ? `, ${st.wasm}` : '')
    info(`slideshow (${st.method}) post ${postId(s.card)}: ${shown}${what ? `; ${what}` : ''}${st.reelError ? `; no reel: ${st.reelError}` : ''}`)
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

  // Short clips: few keyframes make poor scenes, and an exact seek decodes
  // everything up to it (an 11 s 1440x1708 clip showed nothing in 5 s).
  // Played muted and faster, the clip shows all of it in sequence, the way
  // a decoder works best. Past the hardware decoder, seeking stays.
  const PLAY_MAX_S = 30
  const PLAY_RATE = 2

  function chooseShow(s) {
    const v = s.video
    const decide = () => {
      if (scrub !== s) return
      markDuration(s.card, v.duration)
      if (v.duration <= PLAY_MAX_S && !pastDecoder(v.videoWidth, v.videoHeight) && !s.card.dataset.ibhBigVideo) playShow(s)
      else seekShow(s)
    }
    if (v.readyState >= 1) decide()
    else v.addEventListener('loadedmetadata', decide, { once: true })
  }

  /**
   * @param rate   PLAY_RATE for a short clip, 1 for holdVideo
   * @param from   s to start at; left out, where the video is (a cover keeps its last frame)
   */
  function playShow(s, rate = PLAY_RATE, from) {
    s.stats.method = 'play'
    s.stats.rate = rate
    const v = s.video
    // holdResume: a hold lifted less than a minute ago goes on from there.
    const resumed = resumePoint(s.card)
    if (resumed !== null) s.stats.resumed = resumed
    const at = resumed ?? from
    // A play() during the seek starts once the seek lands.
    if (at !== undefined && at !== v.currentTime) v.currentTime = at
    s.played = { rate: v.playbackRate, loop: v.loop, muted: v.muted }
    v.loop = true
    v.playbackRate = rate
    // previewSound: the hold started on a timer, not inside the touch, so the
    // browser allows sound only if the page was tapped before (its sticky
    // user activation). Refused, it plays muted as before.
    v.muted = !CFG.previewSound
    if (CFG.previewSound) s.stats.sound = 'with sound'
    soundChip(s.card)
    s.onPlayTime = () => {
      if (scrub !== s || !v.duration || s.rub?.active()) return   // a rub paints its own target
      s.bar.style.width = `${(v.currentTime / v.duration) * 100}%`
      s.label.textContent = `${mmss(v.currentTime)} / ${mmss(v.duration)} · ${rate}×`
    }
    v.addEventListener('timeupdate', s.onPlayTime)
    v.addEventListener('playing', () => { if (scrub === s) noteScene(s) }, { once: true })
    const go = () => {
      if (scrub !== s) return
      v.play().catch(e => {
        if (e.name !== 'NotAllowedError' || v.muted || scrub !== s) { dbg(`slideshow: play refused — ${describeError(e)}`); return }
        s.stats.sound = 'muted: sound blocked until the page is tapped'
        v.muted = true
        v.play().catch(e2 => dbg(`slideshow: play refused — ${describeError(e2)}`))
      })
    }
    if (v.readyState >= 2) go()
    else v.addEventListener('canplay', go, { once: true })
  }

  // The cover keeps the frame where the finger lifted, as after a scrub.
  function endPlayShow(s) {
    const v = s.video
    v.removeEventListener('timeupdate', s.onPlayTime)   // called while it is set
    s.onPlayTime = null
    v.pause()
    v.playbackRate = s.played.rate
    v.loop = s.played.loop
    v.muted = s.played.muted   // a cover goes back to muted: unmuted, it could not autoplay
  }

  // ── Resume a hold (holdResume) ──
  // Lifting the finger off a hold that plays the video keeps where it was for
  // a minute: holding the same post again plays on from there, sound and all.
  // Meanwhile the card shows two chips: ⏮ and that time (a tap drops the
  // spot, and the cover goes back to its own frame), and 🔊/🔇, which
  // switches previewSound. They go a minute after the last lift, and the
  // spot and the cover's lifted frame go with them.
  const RESUME_MS = 60000
  const resumes = new Map()   // post id -> where its hold lifted, and until when that counts

  /**
   * Where a hold on this card goes on from, if its last one lifted less than a minute ago.
   */
  function resumePoint(card) {
    if (!CFG.holdResume) return null
    const id = postId(card)
    const r = resumes.get(id)
    if (!r) return null
    if (Date.now() > r.until) { resumes.delete(id); return null }
    return r.t
  }

  // Called while the hold still plays (before endPlayShow). A fallback to the
  // slideshow already ended the playing, so it keeps nothing.
  function keepResume(s) {
    const id = postId(s.card)
    const t = s.video.currentTime
    // A hold that never got past its first second has nothing worth going back to.
    if (!CFG.holdResume || id === '?' || !(t >= 1)) return
    resumes.set(id, { t, until: Date.now() + RESUME_MS })
    s.stats.kept = t
  }

  /**
   * One of the hold's chips on a card, made on first use: ⏮ bottom left (where
   * the time label sits during a hold), 🔊/🔇 top left. A press on either is
   * a tap, not a hold (onScrubDown); the tap goes to onScrubClick, ahead of
   * the modal's handler.
   */
  function holdChip(card, kind) {
    const had = card.querySelector(`[data-ibh-chip="${kind}"]`)
    if (had) return had
    const chip = document.createElement('span')
    chip.dataset.ibhChip = kind
    chip.dataset.ibhUi = '1'   // painted by us: the site theme leaves it alone
    chip.setAttribute('role', 'button')
    const label = t(kind === 'resume' ? 'resumeRestart' : 'soundToggle')
    chip.title = label
    chip.setAttribute('aria-label', label)
    // About 32 px tall, a finger's width; z-index over the cover video and
    // the scrub's bar and label (3).
    chip.style.cssText = `position:absolute;${kind === 'resume' ? 'bottom:8px' : 'top:4px'};left:4px;` +
      'padding:6px 12px;border-radius:16px;font:15px/1.3 ui-monospace,monospace;color:#fff;' +
      'background:rgba(0,0,0,.65);z-index:4;cursor:pointer'
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
    card.appendChild(chip)
    return chip
  }

  function soundChip(card) {
    holdChip(card, 'sound').textContent = CFG.previewSound ? '🔊' : '🔇'
  }

  // After a playing hold: the chips, for a minute from this lift.
  function lingerChips(card) {
    const at = resumePoint(card)
    if (at !== null) holdChip(card, 'resume').textContent = `⏮ ${mmss(at)}`
    soundChip(card)
    clearTimeout(Number(card.dataset.ibhChipTimer))
    card.dataset.ibhChipTimer = String(setTimeout(() => {   // harmless on a card gone from the page
      removeChips(card)
      if (resumes.delete(postId(card))) coverBack(card)
    }, RESUME_MS))
  }

  function removeChips(card) {
    clearTimeout(Number(card.dataset.ibhChipTimer))
    delete card.dataset.ibhChipTimer
    for (const chip of card.querySelectorAll('[data-ibh-chip]')) chip.remove()
  }

  // The cover shows its own frame again (COVER_POINT), as before any hold.
  function coverBack(card) {
    const v = card.querySelector('video[data-ibh]')
    if (!v || v.readyState < 1 || !Number.isFinite(v.duration) || !(v.duration > 0)) return
    v.currentTime = v.duration * COVER_POINT
    dbg(`hold: post ${postId(card)}'s cover back to its own frame`)
  }

  // A tap on ⏮: the next hold on that post starts from 00:00, and its cover
  // leaves the frame where the finger lifted.
  function forgetResume(chip) {
    const card = chip.closest('[data-ibh-video]')
    chip.remove()
    if (!card) return
    resumes.delete(postId(card))
    coverBack(card)
    info(`hold: post ${postId(card)} starts from 00:00 again`)
  }

  // A tap on 🔊/🔇: previewSound flips for the holds from now on, and for one
  // playing (a tap is a user activation, so the browser lets it unmute).
  function flipSound() {
    setCfg('previewSound', !CFG.previewSound)
    for (const chip of document.querySelectorAll('[data-ibh-chip="sound"]')) chip.textContent = CFG.previewSound ? '🔊' : '🔇'
    if (scrub && scrub.onPlayTime) scrub.video.muted = !CFG.previewSound
  }

  // ── Rub: hold, then slide to move the video (holdRub) ──
  // On a thumbnail whose hold plays the video, and on the post's player once
  // a hold has started, sliding the finger sideways moves the video: to the
  // right forward, to the left back, from wherever it is. Where the finger
  // sits doesn't matter, only how far it slides: the width under the finger
  // (the card, the player) spans the whole video, at most RUB_SPAN_S. While
  // the finger moves, the video waits on the frame there (fastSeek: the
  // nearest keyframe, quick to decode); once it rests, the exact frame, and
  // the next slide starts from there.
  const RUB_SPAN_S = 120
  const RUB_REST_MS = 250

  // A finger rubbing one video; makeRub builds it.

  /**
   * @param x0   px, where the finger went down
   * @param width   px that span the whole video
   * @param hooks
   *   alive: the gesture still runs; begin: a rub starts (before the pause);
   *   paint: the target changed; rest: the finger rests on the exact frame;
   *   lift: the finger lifted mid-rub, the video on the exact frame
   */
  function makeRub(v, x0, width, hooks) {
    let active = false
    let count = 0
    let x = x0          // where the finger was when this rub began (or rested)
    let t = 0           // the video's time then
    let target = 0
    let asked = -1      // the last target handed to a seek
    let busy = false    // a seek in flight: the next waits for its seeked
    let still = 0
    const seek = () => {
      busy = true
      asked = target
      if (typeof v.fastSeek === 'function') v.fastSeek(target)
      else v.currentTime = target
    }
    // One seek at a time: a finger sends moves faster than seeks land, and
    // each queued seek would decode. When one lands, the newest target goes.
    const onSeeked = () => {
      busy = false
      if (active && hooks.alive() && asked !== target) seek()
    }
    v.addEventListener('seeked', onSeeked)
    /** @param at  px, where the finger rests */
    const rest = (at) => {
      if (!active || !hooks.alive()) return
      active = false
      x = at
      busy = true
      asked = target
      v.currentTime = target   // fastSeek stopped on a keyframe
      hooks.rest()
    }
    return {
      move(nx) {
        if (!Number.isFinite(v.duration) || !(v.duration > 0)) return
        if (!active) {
          if (Math.abs(nx - x) <= SCRUB_SLOP) return   // a resting finger trembles
          active = true
          count++
          x = nx
          t = v.currentTime
          hooks.begin()
          v.pause()
        }
        const span = Math.min(v.duration, RUB_SPAN_S)
        target = Math.min(v.duration - 0.05, Math.max(0, t + ((nx - x) / (width() || 1)) * span))
        hooks.paint(target)
        if (!busy) seek()
        clearTimeout(still)
        still = setTimeout(() => rest(nx), RUB_REST_MS)
      },
      end() {
        clearTimeout(still)
        v.removeEventListener('seeked', onSeeked)
        if (!active) return
        active = false
        v.currentTime = target
        if (hooks.lift) hooks.lift()
      },
      active: () => active,
      count: () => count,
    }
  }

  // The thumbnail's rub, made on the first move of a playing hold.
  function rubMove(s, x) {
    const v = s.video
    if (!s.rub) {
      s.rub = makeRub(v, s.x0, () => s.card.getBoundingClientRect().width, {
        alive: () => scrub === s,
        begin: () => { s.stats.rubs = (s.stats.rubs || 0) + 1 },
        paint: at => {
          s.bar.style.width = `${(at / v.duration) * 100}%`
          s.label.textContent = `${mmss(at)} / ${mmss(v.duration)}`
        },
        rest: () => {
          v.play().catch(e => {
            // Unmuted, it needs the page's user activation, as playShow found out.
            if (e.name !== 'NotAllowedError' || v.muted || scrub !== s) { dbg(`rub: play refused — ${describeError(e)}`); return }
            v.muted = true
            v.play().catch(e2 => dbg(`rub: play refused — ${describeError(e2)}`))
          })
        },
      })
    }
    s.rub.move(x)
  }

  // Called with a scrub under way.
  function startScrub() {
    if (!scrubSource(scrub)) return false
    scrubUi(scrub)
    return true
  }

  // The video a scrub seeks: the card's cover when loaded, else the shared preview.
  function scrubSource(s) {
    const { card } = s
    const pic = cardPicture(card)
    if (!pic) return false
    // freeForPreview() only once the preview will run: one that cannot start
    // never reaches endScrub(), which brings the paused GIFs back.
    const cover = card.querySelector('video[data-ibh]')
    if (cover && cover.readyState >= 1) {
      freeForPreview(card)
      s.video = cover   // already loaded: instant, and no extra decoder
      // Download the whole file from now on: these are a few MB, and every
      // part already downloaded answers a seek at once.
      cover.preload = 'auto'
    } else {
      const hash = (thumbParts(pic.src) || {}).hash
      const urls = cachedFirst(fileCandidates(pic.src, ['mp4', 'webm']), cacheGet('video', hash))
      if (!urls.length) return false
      freeForPreview(card)
      borrowDecoder(card)
      const holder = document.createElement('div')
      holder.style.cssText = 'position:absolute;inset:0;pointer-events:none'
      placeOverPicture(card, holder)
      s.holder = holder
      s.video = previewLoad(holder, urls, hash)
      s.shared = true
    }
    return true
  }

  // The progress bar and the time label over the card.
  function scrubUi(s) {
    if (s.bar) return
    const { card } = s
    // The time label takes the ⏮ chip's place, and the chips' minute stops
    // while the finger is down: the lift starts it again (lingerChips).
    card.querySelector('[data-ibh-chip="resume"]')?.remove()
    clearTimeout(Number(card.dataset.ibhChipTimer))
    // z-index: the card's cover video comes later in the DOM and would paint
    // over them otherwise (it did on site pages, where every video has one).
    s.bar = document.createElement('div')
    s.bar.style.cssText =
      `position:absolute;left:0;bottom:0;height:4px;width:0;background:var(--ibh-accent);pointer-events:none;z-index:3`
    s.label = document.createElement('div')
    s.label.style.cssText =
      'position:absolute;left:4px;bottom:8px;padding:1px 6px;border-radius:3px;font:12px/1.4 ' +
      'ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.6);pointer-events:none;z-index:3'
    // Painted by us: the site theme leaves them alone.
    s.bar.dataset.ibhUi = s.label.dataset.ibhUi = '1'
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
    card.appendChild(s.bar)
    card.appendChild(s.label)
    s.on = true
  }

  // Called with a scrub under way, once startScrub made its bar and label.
  function moveScrub(x) {
    const r = (scrub).card.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (x - r.left) / r.width))
    ;(scrub).bar.style.width = `${f * 100}%`
    const at = seekFraction((scrub).video, f)
    ;(scrub).label.textContent = at ? `${mmss(at.t)} / ${mmss(at.d)}` : '…'
  }

  // Lets go of a scrub that never showed anything. nextGif() waits while a
  // finger is down on a video card: a GIF whose turn came meanwhile starts now.
  function dropScrub() {
    scrub = null
    nextGif()
  }

  function endScrub() {
    const s = scrub
    scrub = null
    if (!s) return
    clearTimeout(s.holdTimer)
    if (!s.on) { nextGif(); return }
    if (s.tick) endSlideshow(s)
    if (s.rub) { s.rub.end(); s.rub = null }   // mid-rub, the cover and keepResume get the exact target
    if (s.onPlayTime) { keepResume(s); endPlayShow(s); lingerChips(s.card) }
    else removeChips(s.card)   // a slideshow or a drag: no chips (one a fallback left)
    if (s.stats) logSlideStats(s)
    endReel(s)
    s.bar.remove()
    s.label.remove()
    if (s.shared) { previewStop(); (s.holder).remove(); returnDecoder() }   // a shared preview has one
    afterPreview()
    nextGif()   // the paused ones first, then any whose turn came meanwhile
    // A cover keeps the frame where the finger stopped.
    dbg(`scrub: stopped at ${s.label.textContent}`)
  }

  function onScrubMove(ev) {
    if (!scrub || ev.pointerId !== scrub.id) return
    if (CFG.scrubMode === 'hold') {
      // Moving before the hold starts makes it a scroll. Once the hold plays
      // the video, a sideways slide moves it (holdRub); a slideshow ignores moves.
      if (!scrub.on) {
        if (Math.hypot(ev.clientX - scrub.x0, ev.clientY - scrub.y0) > SCRUB_SLOP) endScrub()
        return
      }
      if (CFG.holdRub && scrub.onPlayTime) rubMove(scrub, ev.clientX)
      return
    }
    if (!scrub.on) {
      const dx = Math.abs(ev.clientX - scrub.x0)
      const dy = Math.abs(ev.clientY - scrub.y0)
      if (dy > SCRUB_SLOP && dy > dx) { dropScrub(); return }   // a page scroll
      if (dx < SCRUB_SLOP) return
      if (!startScrub()) { dropScrub(); return }
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
    // The hold chips sit inside the card's link: a tap must not open the post.
    const chip = asElement(ev.target)?.closest('[data-ibh-chip]')
    if (chip) {
      ev.preventDefault()
      ev.stopImmediatePropagation()
      if (chip.dataset.ibhChip === 'sound') flipSound()
      else forgetResume(chip)
      return
    }
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
      if (CFG.scrubMode === 'hold' && asElement(ev.target)?.closest('[data-ibh-video]')) ev.preventDefault()
    }, true)
    // Belt and braces for the drag-and-drop that cancels a scrub on site pages.
    window.addEventListener('dragstart', ev => {
      if (asElement(ev.target)?.closest('[data-ibh-video]')) ev.preventDefault()
    }, true)
    info(`video scene preview active: ${CFG.scrubMode !== 'hold' ? 'drag sideways on a video thumbnail' : CFG.holdVideo ? 'hold a video thumbnail to play it (hardware)' : 'hold a video thumbnail for a slideshow'}`)
  }

  // src/modal/player.ts
  // On the modal video: drag sideways to move the video (holdRub: a rub, see
  // makeRub; a quick flick stays a swipe to the next post); hold the middle
  // third for 2x while the finger stays down, and slide from there to move
  // it too; double
  // tap on the right or left third to jump seekStep seconds (5, or what ⚙
  // picked) forward or back. The control strip is
  // left to the player. Turned, "left/right" follow the viewer, not the screen.
  const HOLD_FAST_MS = 600   // the user's pick (2026-11-15): 400 ms caught drags that started slowly
  const FLICK_MS = 300   // a sideways drag shorter than this is a swipe to the next post, not a rub
  const HOLD_RATE = 2
  const videoPress = { held: false }

  let badgeTimer = 0
  function showBadge(text, sticky) {
    modal.badge.textContent = text
    modal.badge.hidden = false
    clearTimeout(badgeTimer)
    if (!sticky) badgeTimer = setTimeout(() => { modal.badge.hidden = true }, 700)
  }

  // The player's rub: a sideways drag on the video, or a slide once a hold
  // started. A hold's 2× gives way to it, the time shows in the badge with
  // the seek bar up, and a resting or lifted finger plays on only when the
  // video was playing.
  function playerRub(video, press, layer) {
    let playing = false
    const box = modal.box
    return makeRub(video, press.x, () => layer.getBoundingClientRect().width, {
      alive: () => !!modal && modal.open && modal.box === box,
      begin: () => {
        playing = !video.paused
        video.playbackRate = press.rate
        dbg('modal: rub, the hold slides the video')
      },
      paint: at => {
        showBadge(`${mmss(at)} / ${mmss(video.duration)}`, true)
        modal.controls.poke()
      },
      rest: () => {
        showBadge(mmss(video.currentTime))
        if (playing) video.play().catch(e => dbg(`modal: rub, play refused — ${describeError(e)}`))
      },
      lift: () => { if (playing) video.play().catch(e => dbg(`modal: rub, play refused — ${describeError(e)}`)) },
    })
  }

  function installVideoGestures(layer, video) {
    let press = null
    let tap = null   // a first tap waiting to see whether a second one follows
    const viewerX = (ev) => {
      const r = layer.getBoundingClientRect()
      return Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width))
    }
    const release = () => {
      if (!press) return
      clearTimeout(press.timer)
      if (press.rub) {
        press.rub.end()
        if (press.rub.count()) info(`modal: rubbed ${press.rub.count()}×, left at ${mmss(video.currentTime)}`)
      }
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
      press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: Date.now(), fx, rate: video.playbackRate || 1, timer: 0 }
      dbg(`modal: video press at ${Math.round(fx * 100)}%`)
      // Only the middle third holds for 2x; the sides are for double taps and drags.
      if (fx < 0.35 || fx > 0.65) return
      press.timer = setTimeout(() => {
        if (!press) return
        // From here a slide moves the video. A paused one stays paused, at 1×.
        if (CFG.holdRub) press.rub = playerRub(video, press, layer)
        if (video.paused) {
          if (CFG.holdRub) videoPress.held = true
          dbg(`modal: hold on a paused video${CFG.holdRub ? ': a slide moves it' : ', ignored'}`)
          return
        }
        videoPress.held = true
        video.playbackRate = HOLD_RATE
        showBadge(`${HOLD_RATE}×`, true)
        dbg(`modal: hold, playing at ${HOLD_RATE}x`)
      }, HOLD_FAST_MS)
    })
    layer.addEventListener('pointermove', ev => {
      if (!press || ev.pointerId !== press.id) return
      if (videoPress.held || press.drag) { press.rub?.move(ev.clientX); return }
      const dx = ev.clientX - press.x
      const dy = ev.clientY - press.y
      if (Math.hypot(dx, dy) <= 10) return
      clearTimeout(press.timer)
      // Sideways: a rub from here (the stage still takes a quick flick as a
      // swipe, see pointerup). Down, or sideways with holdRub off: a swipe,
      // handled on the stage.
      if (CFG.holdRub && Math.abs(dx) > Math.abs(dy)) {
        press.drag = true
        press.rub = playerRub(video, press, layer)
        press.rub.move(ev.clientX)
        return
      }
      press = null
    })
    layer.addEventListener('pointercancel', () => { if (press) dbg('modal: video press cancelled by the browser'); release() })
    layer.addEventListener('pointerup', ev => {
      if (!press || ev.pointerId !== press.id) return
      const quickTap = !videoPress.held && Date.now() - press.t < 250 &&
        Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < 10
      const side = press.fx > 0.65 ? 1 : press.fx < 0.35 ? -1 : 0
      // A drag that took longer than a flick moved the video: the stage's
      // swipe skips it as it skips a hold (release clears this after it).
      if (press.drag && Date.now() - press.t >= FLICK_MS) videoPress.held = true
      release()
      if (!quickTap) return
      // Second tap within 300 ms: a double tap. On a side it seeks, in the
      // centre it toggles fullscreen (like YouTube); the pending single-tap
      // action is cancelled either way. The tap is the user gesture
      // fullscreen needs.
      if (tap && Date.now() - tap.t < 300) {
        clearTimeout(tap.timer)
        if (!side && !tap.side) centerDoubleTap()
        else if (side && side === tap.side) {
          const d = Number.isFinite(video.duration) ? video.duration : Infinity
          const step = Number(CFG.seekStep) || 5
          video.currentTime = Math.min(d, Math.max(0, video.currentTime + side * step))
          showBadge(side > 0 ? `+${step}s` : `−${step}s`)
          dbg(`modal: double tap, ${side > 0 ? '+' : '-'}${step}s`)
        }
        tap = null
        return
      }
      // A single tap plays or pauses, once it is clear no second tap follows.
      tap = { t: Date.now(), side, timer: 0 }
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

  const mmss = (sec) => Number.isFinite(sec) ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : '0:00'

  const CONTROLS_HIDE_MS = 2000

  // The seek bar's preview from keyframes (seekReel): this many, evenly spread.
  const SEEK_STEPS = Array.from({ length: 40 }, (_, i) => i / 40)

  // ⚙ on the player: its speed and how far a double tap on a side jumps,
  // both kept in the settings (playRate, seekStep), as rows of chips.
  const PLAY_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]
  const SEEK_JUMPS = [5, 10, 15, 30]

  function applyPlayRate(video) {
    const rate = Number(CFG.playRate) || 1
    video.defaultPlaybackRate = rate   // load() puts the speed back to this, so the next video keeps it
    video.playbackRate = rate
  }

  function installGearMenu(gear, menu, video, vwrap, poke) {
    const chips = []
    const mark = () => chips.forEach(c => c.button.classList.toggle('on', Number(CFG[c.key]) === c.value))
    /**
     * @param attr       the data- attribute that holds the value
     */
    const row = (label, key, attr, values, text, apply) => el('div', { class: 'vmrow' }, [el('span', { class: 'lbl', text: label }),
      ...values.map(value => {
        const button = el('button', { type: 'button', text: text(value), [`data-${attr}`]: String(value) })
        button.addEventListener('click', () => {
          setCfg(key, value)
          apply()
          mark()
          poke()
          dbg(`modal: ${key} set to ${value} from the player's ⚙`)
        })
        chips.push({ button, key, value })
        return button
      })])
    menu.append(
      row(t('gearRate'), 'playRate', 'rate', PLAY_RATES, v => `${v.toLocaleString(LANG)}×`, () => applyPlayRate(video)),
      row(t('gearStep'), 'seekStep', 'step', SEEK_JUMPS, v => `${v} s`, () => {}))
    gear.addEventListener('click', () => {
      menu.hidden = !menu.hidden
      if (!menu.hidden) mark()
      poke()
    })
    // A touch anywhere else on the video closes it.
    vwrap.addEventListener('pointerdown', ev => {
      const path = ev.composedPath()
      if (!menu.hidden && !path.includes(menu) && !path.includes(gear)) menu.hidden = true
    }, true)
  }

  // Returns { shown(), poke(), dropReel() }: the bar fades after 2 s without
  // interaction while playing, and stays up while paused or while the seek
  // bar is dragged.
  /**
   * @param times    where it plays, and how long it is
   */
  function installVideoControls(video, ctl, playBtn, times, seek, muteBtn, prevBox, vwrap, { playPause, gearMenu }) {
    let dragging = false
    let hideTimer = 0
    let muted = null   // the icons on show, so timeupdate does not rebuild them
    let paused = null
    const poke = () => {
      ctl.classList.remove('hide')
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        if (!dragging && !video.paused && gearMenu.hidden) ctl.classList.add('hide')
        else if (!gearMenu.hidden) poke()   // ⚙'s menu open: look again later
      }, CONTROLS_HIDE_MS)
    }
    const sync = () => {
      playBtn.hidden = !video.paused
      if (paused !== video.paused) { paused = video.paused; setIcon(playPause, paused ? PLAYER_ICON.play : PLAYER_ICON.pause) }
      if (muted !== video.muted) { muted = video.muted; setIcon(muteBtn, muted ? PLAYER_ICON.muted : PLAYER_ICON.volume) }
      times[1].textContent = mmss(video.duration)
      if (!dragging) times[0].textContent = mmss(video.currentTime)
      if (!dragging && video.duration) seek.value = String(Math.round((video.currentTime / video.duration) * 1000))
      // How far the download reaches from where it plays: the light part of the bar.
      const b = video.buffered
      let end = 0
      for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 0.5) end = Math.max(end, b.end(i))
      seek.style.setProperty('--buf', `${video.duration ? Math.min(100, (end / video.duration) * 100) : 0}%`)
    }
    for (const type of ['timeupdate', 'play', 'pause', 'volumechange', 'loadedmetadata', 'durationchange', 'emptied', 'progress']) {
      video.addEventListener(type, sync)
    }
    playBtn.addEventListener('click', () => { video.play().catch(() => {}) })
    playPause.addEventListener('click', () => {
      if (video.paused) video.play().catch(() => {})
      else video.pause()
      poke()
      dbg(`modal: ${video.paused ? 'paused' : 'playing'} from the player's button`)
    })
    muteBtn.addEventListener('click', () => { video.muted = !video.muted })

    // While the seek bar is dragged, only the preview box follows the finger;
    // the main video jumps once, on release. With seekReel, the box first
    // shows the nearest keyframe (a reel of SEEK_STEPS keyframes of this
    // video, decoded in WebAssembly to the box's size, each kept once
    // decoded), and the preview video, still seeking, takes over when it
    // reaches the exact frame.
    const PREV_W = 160
    // The keyframes of the video on show: x the decoder, frames those decoded
    // (by scene), f where the finger is, failed once either fails.
    let reel = null   // { src, reel, x, frames, canvas, f, failed } for the video on show
    let target = 0    // the time the finger asks for, in seconds
    const drawKeyframe = (f) => {
      const r = reel
      if (!r || !r.reel || r.failed) return
      const scenes = r.reel.scenes
      let i = 0
      for (let k = 1; k < scenes.length; k++) if (Math.abs(scenes[k].f - f) < Math.abs(scenes[i].f - f)) i = k
      let img = r.frames.get(i)
      if (!img) {
        try {
          // x comes with reel.
          openStream(r.x, r.reel)
          img = decodeKeyframe(r.x, r.reel.frames[i], Math.round(PREV_W * (window.devicePixelRatio || 1)))
        } catch (e) {
          r.failed = true
          dbg(`seek preview: keyframe not decoded (${describeError(e)}), the <video> preview alone`)
          return
        }
        r.frames.set(i, img)
      }
      if (!r.canvas) r.canvas = document.createElement('canvas')
      if (!r.canvas.isConnected) prevBox.insertBefore(r.canvas, prevBox.lastChild)   // over the preview video, under the time
      if (r.canvas.width !== img.width || r.canvas.height !== img.height) { r.canvas.width = img.width; r.canvas.height = img.height }
      (r.canvas.getContext('2d')).putImageData(img, 0, 0)   // a canvas of our own: it has one
    }
    const reelPreview = (f) => {
      if (!CFG.seekReel || !CFG.wasmDecode || h264Broken || typeof GM_xmlhttpRequest !== 'function') return
      const src = video.currentSrc
      if (!/\.mp4(?:[?#]|$)/i.test(src)) return   // WebM and the rest: the preview video alone
      if (!reel || reel.src !== src) {
        const mine = { src, reel: null, x: null, frames: new Map(), canvas: null, f, failed: false }
        reel = mine
        Promise.all([h264Decoder(), reelFor([src], SEEK_STEPS, new Set(), null)]).then(([x, built]) => {
          if (reel !== mine) return
          if (!built.avcC) throw new Error('not H.264')
          mine.x = x
          mine.reel = built   // it has an avcC
          info(`seek preview: wasm reel of ${built.scenes.length} scenes in ${built.ms} ms${built.kept ? ' (kept from before)' : ''}`)
          if (dragging) drawKeyframe(mine.f)   // where the finger is by now
        }).catch(e => {
          if (reel !== mine) return
          mine.failed = true
          dbg(`seek preview: no reel (${describeError(e)}), the <video> preview alone`)
        })
      }
      reel.f = f
      drawKeyframe(f)
    }
    seek.addEventListener('input', () => {
      dragging = true
      const f = Number(seek.value) / 1000
      if (prevBox.hidden && video.currentSrc) {
        prevBox.hidden = false
        const v = previewLoad(prevBox, [video.currentSrc], null)
        // The exact frame arrived: the preview video shows through the keyframe.
        if (!v.dataset.ibhSeekExact) {
          v.dataset.ibhSeekExact = '1'
          v.addEventListener('seeked', () => {
            if (prevBox.contains(v) && Math.abs(v.currentTime - target) < 0.6) prevBox.classList.add('exact')
          })
        }
      }
      const sr = seek.getBoundingClientRect()
      const wr = vwrap.getBoundingClientRect()
      const x = sr.left - wr.left + f * sr.width - PREV_W / 2
      prevBox.style.left = `${Math.min(wr.width - PREV_W - 4, Math.max(4, x))}px`
      const d = video.duration
      target = f * d
      prevBox.classList.remove('exact')
      reelPreview(f)
      if (previewEl && previewEl.isConnected) seekFraction(previewEl, f)
      ;(prevBox.lastChild).textContent = mmss(target)   // the time label, last of the box
      times[0].textContent = mmss(target)
      poke()
    })
    seek.addEventListener('change', () => {
      dragging = false
      const d = video.duration
      if (d) video.currentTime = (Number(seek.value) / 1000) * d
      previewStop()
      prevBox.hidden = true
      prevBox.classList.remove('exact')
      poke()
    })
    ctl.addEventListener('pointerdown', poke)
    video.addEventListener('play', poke)
    video.addEventListener('pause', () => { clearTimeout(hideTimer); ctl.classList.remove('hide') })
    video.addEventListener('emptied', () => { clearTimeout(hideTimer); ctl.classList.remove('hide') })
    // A new post or the modal closing: the decoded keyframes go (the reel
    // itself stays in the reel cache for a return).
    const dropReel = () => {
      if (reel && reel.canvas) reel.canvas.remove()
      reel = null
    }
    return { shown: () => !ctl.classList.contains('hide'), poke, dropReel }
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
    modal.sampleUrl = null    // the sample on show, to come back to from raw
    modal.rawUrl = null       // the original once fetched, to switch back instantly
    modal.keepSample = false  // chose the sample: zooming does not fetch the original
    setQuality(null)
    setRes(null)   // back on the next image's load; a video has none
    const v = modal.video
    v.pause()
    v.onerror = v.oncanplay = v.onloadedmetadata = null
    applyPlayRate(v)
    modal.gearMenu.hidden = true
    modal.badge.hidden = true
    modal.playerBtn.hidden = true
    modal.appDlBtn.hidden = true
    modal.appReduceBtn.hidden = true
    modal.controls.dropReel()
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

  // The player's other Material icons, in the same stroke.
  const PLAYER_ICON = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
    heartLine: 'M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z',
    info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
    gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z',
    volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    muted: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  }

  // A 24x24 icon from path data, as the button's only content.
  function setIcon(btn, d) {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
    btn.replaceChildren(svg)
  }

  function setFsIcon(btn, full) {
    setIcon(btn, full ? FS_ICON.exit : FS_ICON.enter)
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

  // src/thumbs/badges.ts
  // The small marks on a video card: its duration, ⚠️ past the decoder.

  // ⚠️ in the corner of a card whose video is past the hardware decoder,
  // found by its cover (size), its reel's index (size and fps) or a hold that
  // played it (fps measured). Kept on the card: the mark also skips the cover.
  /**
   * @param what   "3840x2160" or "1920x1080 at 120 fps", for the log and the title
   */
  function markPastDecoder(card, what) {
    if (card.dataset.ibhBigVideo === what) return
    card.dataset.ibhBigVideo = what
    dbg(`card: post ${postId(card)} marked past the hardware decoder (${what})`)
    const badge = cardBadge(card, 'ibh-heavy', 'top:3px;right:3px;font-size:11px;line-height:1;filter:drop-shadow(0 0 1px #000)')
    if (!badge) return
    badge.textContent = '⚠️'
    badge.title = `${t('heavyMark')}: ${what}`
  }

  // A video card's duration, small in its bottom right corner (thumbBadges).
  function markDuration(card, secs) {
    if (!Number.isFinite(secs) || secs <= 0) return
    const badge = cardBadge(card, 'ibh-dur', 'bottom:3px;right:3px;padding:0 3px;border-radius:3px;' +
      'font:10px/1.4 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.65)')
    if (badge) badge.textContent = mmss(secs)
  }

  // The card's badge of that class, made once (the observer comes back to the
  // same card); null with thumbBadges off. Painted by us: the theme skips it,
  // and z-index keeps it over the cover video and the slideshow's canvas.
  function cardBadge(card, cls, css) {
    if (!CFG.thumbBadges) return null
    const had = card.querySelector(`.${cls}`)
    if (had) return had
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
    const badge = el('span', { class: cls, 'data-ibh-ui': '' })
    badge.style.cssText = `position:absolute;z-index:4;pointer-events:none;${css}`
    card.appendChild(badge)
    return badge
  }

  // src/page/raw-hold.ts
  // ── Hold an image for its raw file ──
  // The feed shows the sample (as sharp as the screen can show); holding an
  // image half a second swaps in the original right there, for reading the
  // small print of a comic. Measured on touch events: Firefox for Android
  // cancels the pointer during a long press (see chipGestures). The release
  // does not open the post, and the long-press menu stays out of the way.
  // A GIF's thumbnail takes the same hold to be built again (holdGif).
  const RAW_HOLD_MS = 500
  let rawHold = null
  let rawClickUntil = 0

  // An image post's thumbnail on a site page (not a video or GIF: those have
  // their own hold, the scene preview, or play on their own).
  function rawTarget(target) {
    // The selectors end in img and in a.
    const img = asElement(target)?.closest(`${SITE_LINK} img`)
    const link = (img && img.closest(SITE_LINK))
    if (!link || link.dataset.ibhVideo || isVideoCard(link) || isGifCard(link)) return null
    return { img, link }   // the link was found from img
  }

  // A GIF post's thumbnail, by tag or found out (a card tagged "animated"
  // that no video host has).
  function gifTarget(target) {
    const img = asElement(target)?.closest(`${SITE_LINK} img`)
    const link = (img && img.closest(SITE_LINK))
    if (!link || !isGifCard(link)) return null
    return { img, link }
  }

  // What a hold on this target does: the raw file, or the GIF built again.
  function holdTarget(target) {
    const raw = CFG.holdRaw && rawTarget(target)
    if (raw) return { ...raw, gif: false }
    const gif = CFG.holdGif && gifTarget(target)
    return gif ? { ...gif, gif: true } : null
  }

  function onRawTouchStart(ev) {
    rawHold = null
    if (!(CFG.holdRaw || CFG.holdGif) || bulkMode || ev.touches.length !== 1 || (modal && modal.open)) return
    const hit = holdTarget(ev.target)
    if (!hit) return
    const finger = ev.touches[0]
    rawHold = { ...hit, x: finger.clientX, y: finger.clientY, scrollY: window.scrollY, fired: false, timer: 0 }
    rawHold.timer = setTimeout(() => {
      const h = rawHold
      if (!h || Math.abs(window.scrollY - h.scrollY) > 12) return   // the page scrolled: not a hold
      h.fired = true
      rawClickUntil = Date.now() + 800   // the click after the release opens nothing
      if (h.gif) rebuildGif(h.link)
      else loadRaw(h.img, h.link)
    }, RAW_HOLD_MS)
  }

  function cancelRawHold() {
    if (rawHold && !rawHold.fired) clearTimeout(rawHold.timer)
    rawHold = null
  }

  function onRawTouchMove(ev) {
    if (!rawHold || rawHold.fired) return
    const finger = ev.touches[0]
    if (ev.touches.length > 1 || Math.hypot(finger.clientX - rawHold.x, finger.clientY - rawHold.y) > 12) cancelRawHold()
  }

  function onRawClick(ev) {
    if (Date.now() > rawClickUntil) return
    rawClickUntil = 0
    ev.preventDefault()
    ev.stopImmediatePropagation()
  }

  function onRawContextMenu(ev) {
    if (holdTarget(ev.target)) ev.preventDefault()   // the hold is ours
  }

  // The download in flight per image, so a second hold can call it off.
  const rawLoads = new WeakMap()

  // The hold's mark: a small square in the card's top left, under the
  // resolution. RAW on the dark tone while the file comes, on the accent once
  // it shows; ✕ when it failed.
  function rawBadge(link, state) {
    const tone = state === 'raw' ? 'var(--ibh-accent-mid)' : state === 'failed' ? '#b42318' : 'rgba(var(--ibh-base-rgb), .85)'
    bulkBadge(link, state === 'failed' ? '✕' : 'RAW', tone, 'ibh-rawbadge').dataset.state = state
  }

  // A second hold undoes the first: back to what was on show (the sample, or
  // the thumbnail), or the download in flight called off.
  function undoRaw(img, link) {
    const cancel = rawLoads.get(img)
    if (cancel) { cancel(); rawLoads.delete(img) }
    const before = img.dataset.ibhPreRaw || ''
    if (img.dataset.ibhRaw === '1') {
      if (before) img.srcset = before
      else img.removeAttribute('srcset')
      if (img.dataset.ibhRawMarked) {
        // It had no upgrade of its own: let the feed give it the sample again.
        delete img.dataset.ibhOrig
        delete img.dataset.ibhThumb
        if (originalViewport) originalViewport.observe(img)
      }
      // The resolution goes back to what comes back: the sample's size, or
      // none for the thumbnail until the feed swaps the sample in again.
      const [w, h] = (img.dataset.ibhPreShown || '').split('x').map(Number)
      setShown(link, w || 0, h || 0)
    }
    delete img.dataset.ibhRaw
    delete img.dataset.ibhPreRaw
    delete img.dataset.ibhPreShown
    delete img.dataset.ibhRawMarked
    const badge = link.querySelector('.ibh-rawbadge')
    if (badge) badge.remove()
    if (navigator.vibrate) navigator.vibrate(15)
    info(`raw: post ${postId(link)} back to the ${before ? 'sample' : 'thumbnail'}`)
  }

  function loadRaw(img, link) {
    if (img.dataset.ibhRaw) { undoRaw(img, link); return }   // loading or loaded: a second hold undoes it
    const src = img.getAttribute('src')
    const parts = thumbParts(src)
    if (!parts) return
    const cached = knownOriginal(parts.hash)
    if (cached === null) { rawBadge(link, 'failed'); pageToast(t('rawFailed')); return }
    // A post without a sample already shows its original in the feed: the
    // same file again would change nothing (measured: 2 of 3 posts held).
    if (/\/images\//.test(img.getAttribute('srcset') || '')) {
      pageToast(t('rawAlready'))
      if (navigator.vibrate) navigator.vibrate(15)
      dbg(`raw: post ${postId(link)} already shows its original`)
      return
    }
    img.dataset.ibhRaw = 'loading'
    img.dataset.ibhPreRaw = img.getAttribute('srcset') || ''   // what comes back on a second hold
    rawBadge(link, 'loading')
    if (navigator.vibrate) navigator.vibrate(15)
    // src: thumbParts found the parts in it.
    rawLoads.set(img, raceImage([fileCandidates(src, ORIGINAL_EXTS)], cached, probe => {
      cacheSet('orig', parts.hash, probe.src, cached)
      const decoded = typeof probe.decode === 'function' ? probe.decode().catch(() => {}) : Promise.resolve()
      decoded.then(() => {
        if (!img.isConnected || img.dataset.ibhRaw !== 'loading') return
        const pic = pictureOf(img)
        if (!pic) return
        rawLoads.delete(img)
        // Release goes back to the thumbnail like any upgrade (see D).
        if (img.dataset.ibhOrig !== 'done') {
          img.dataset.ibhThumb = src
          img.dataset.ibhOrig = 'done'
          img.dataset.ibhRawMarked = '1'
          watchDistance(img)
        }
        pic.set(probe.src)
        img.dataset.ibhRaw = '1'
        img.dataset.ibhPreShown = link.dataset.ibhShown || ''   // the size a second hold brings back
        setShown(link, probe.naturalWidth, probe.naturalHeight)   // the badge: the raw file's size
        rawBadge(link, 'raw')
        info(`raw: post ${postId(link)} shows its original (${probe.src.split('/').pop()}, ${probe.naturalWidth}×${probe.naturalHeight})`)
      })
    }, () => {
      rawLoads.delete(img)
      delete img.dataset.ibhRaw
      delete img.dataset.ibhPreRaw
      cacheSet('orig', parts.hash, null)
      rawBadge(link, 'failed')
      pageToast(t('rawFailed'))
    }, 'high'))
  }

  // src/page/double-tap.ts
  // Double tap on a thumbnail: favorite and upvote it on the spot, as mass
  // favorite does, without the mode. A single tap still opens the post, only
  // a moment later: that is how long a second tap is waited for. Registered
  // after the scrub's and the raw hold's click guards, before the modal.
  const DOUBLE_TAP_MS = 300
  let pendingTap = null   // { link, timer }: a first tap waiting for a second
  let passTap = null      // the single tap going through to whatever opens the post

  const wantsDoubleTap = () => !!CFG.doubleTapFav && SITE === 'rule34.xxx' && !!userId()

  function onDoubleTapClick(ev) {
    if (ev.defaultPrevented || ev.button !== 0 || bulkMode) return
    // SITE_LINK ends in a: the link.
    const link = asElement(ev.target)?.closest(SITE_LINK)
    if (!link || link === passTap || !wantsDoubleTap()) return
    ev.preventDefault()
    ev.stopImmediatePropagation()
    if (pendingTap && pendingTap.link === link) {
      clearTimeout(pendingTap.timer)
      pendingTap = null
      // doubleTapLike 'heart': the ❤️ on every double tap, a favorite already
      // too (as in the player); 'quiet': only the ♥ badge bulkFavorite puts.
      if (CFG.doubleTapLike === 'heart') popHeart(link, Math.min(110, link.getBoundingClientRect().width * 0.5))
      bulkFavorite(link, 'double tap')
      return
    }
    if (pendingTap) clearTimeout(pendingTap.timer)   // a tap on another thumbnail replaces it
    pendingTap = { link, timer: setTimeout(() => { pendingTap = null; openTapped(link) }, DOUBLE_TAP_MS) }
  }

  // The single tap, replayed: the modal (or the link itself) takes it from here.
  function openTapped(link) {
    if (!link.isConnected) return
    passTap = link
    try { link.click() } finally { passTap = null }
  }

  // src/page/ads.ts
  // ─── Ads ───
  // Every script and frame these sites need is their own (checked on rule34,
  // xbooru and safebooru); the ads come from other hosts: ExoClick's
  // ad-provider.js, TrafficStars' ms.js, a popunder on a host that changes
  // name, an affiliate iframe. A Content-Security-Policy <meta> in the head,
  // in place before the parser reaches the body, keeps the browser from
  // loading them, and CSS hides the slots they would fill. (Firefox 158 no
  // longer fires beforescriptexecute, the other way to stop a script.)
  const SITE_DOMAIN = SITE.split('.').slice(-2).join('.')
  // challenges.cloudflare.com: Cloudflare's CAPTCHA page, which must keep working.
  const OWN_HOSTS = `'self' https://${SITE_DOMAIN} https://*.${SITE_DOMAIN} https://challenges.cloudflare.com`
  // One policy, no nonce (a nonce would turn 'unsafe-inline' off): inline for the
  // site's own scripts and onclick handlers, eval for WebAssembly too (the
  // keyframe decoder), moz-extension: for devtools extensions such as Eruda.
  const AD_POLICY = `script-src ${OWN_HOSTS} ${PROFILE.scriptHosts.join(' ')} 'unsafe-inline' 'unsafe-eval' blob: moz-extension:; frame-src ${OWN_HOSTS} blob:`
  // The sponsored link to an AI site sits in rule34's menu and above gelbooru's posts.
  const AD_SLOTS = ['.a_list', '#nativemlist', '#nativempost', 'ins[data-zoneid]', 'li:has(> a[href*="realxxx."])', 'a[href*="realxxx."]', ...PROFILE.adSlots].join(', ')
  const ADS_CSS = `${AD_SLOTS} { display: none !important; }`
  const adBlocked = new Map()   // host -> loads the policy stopped
  let adPolicyOn = false

  // The policy goes in once the head exists: the observer calls this first.
  function applyAdBlock() {
    if (!CFG.blockAds || adPolicyOn || !document.head) return
    adPolicyOn = true
    const meta = document.createElement('meta')
    meta.httpEquiv = 'Content-Security-Policy'
    meta.content = AD_POLICY
    document.head.prepend(meta)
    dbg('ads: policy in place, only the site\'s own scripts and frames load')
  }

  function installAdBlock() {
    if (!CFG.blockAds) return
    document.addEventListener('securitypolicyviolation', e => {
      if (!e.originalPolicy.includes('moz-extension:')) return   // a policy of the site's own, not this one
      let host = e.blockedURI
      try { host = new URL(e.blockedURI).host } catch (err) { /* 'inline' and such: keep it */ }
      adBlocked.set(host, (adBlocked.get(host) || 0) + 1)
      if (document.readyState === 'complete') dbg(`ads: blocked ${e.blockedURI}`)
    })
    window.addEventListener('load', () => {
      const total = [...adBlocked.values()].reduce((a, b) => a + b, 0)
      const hosts = [...adBlocked].map(([h, n]) => (n > 1 ? `${h} ×${n}` : h)).join(', ')
      info(`ads: blocked ${total} loads${hosts ? ` (${hosts})` : ''}, ${document.querySelectorAll(AD_SLOTS).length} slots hidden`)
    }, { once: true })
    applyAdBlock()
  }

  // src/page/page-css.ts
  // The site's own video frame, repeated so it also applies on pages whose
  // stylesheet lacks it (favorites), where the mark is added back.
  const NATIVE_MARK_CSS = `${LIST} img.webm-thumb { border: 3px solid rgb(0, 0, 255); box-sizing: border-box; }`

  const FAVSEARCH_CSS = `
    .ibh-search { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0 12px; position: relative; min-width: 0; max-width: 100%; }
    .ibh-search > * { min-width: 0; max-width: 100%; box-sizing: border-box; }
    .ibh-search select { text-overflow: ellipsis; }
    .ibh-suggest { position: absolute; z-index: 30; margin: 0 !important; padding: 4px 0 !important; list-style: none;
      max-height: 50vh; overflow-y: auto; overscroll-behavior: contain; user-select: none; -webkit-touch-callout: none;
      background: var(--ibh-menu) !important; border: 1px solid var(--ibh-line) !important;
      border-radius: 8px; box-shadow: 0 8px 18px rgba(0, 0, 0, .5); }
    .ibh-suggest[hidden] { display: none; }
    .ibh-suggest li { display: flex !important; justify-content: space-between; gap: 12px; padding: 9px 12px !important;
      font-size: 15px; color: var(--ibh-text) !important; background: transparent !important; }
    .ibh-suggest li small { opacity: .65; font-size: 12px; color: inherit !important; }
    .ibh-suggest li span { color: inherit !important; }
    .ibh-suggest li.k-artist { color: #f2ac08 !important; }
    .ibh-suggest li.k-character { color: #3fb950 !important; }
    .ibh-suggest li.k-copyright { color: #c678dd !important; }
    .ibh-search input[type="search"] { flex: 1 1 100%; min-width: 0; padding: 9px 10px; font-size: 15px; box-sizing: border-box; }
    .ibh-search input.min { width: 96px; padding: 7px 8px; font-size: 14px; box-sizing: border-box; }
    .ibh-search select, .ibh-search button { padding: 7px 12px; font-size: 14px; }
    .ibh-search .st { flex: 1 1 100%; font-size: 12px; opacity: .85; }
    /* A select is as wide as its longest option, and a recent search can run
       to 160 characters. Where the bar's box takes its width from what it
       holds (rule34's home page, centred in a flex column; a shrink-to-fit
       column), that one option widened the box past the screen on both
       sides: max-width does not stop it, since Firefox still counts the
       option when it measures the content. contain: inline-size measures
       the lists as if empty, and flex-basis 100% then fills the bar's line. */
    .ibh-search select.saved { flex: 1 1 100%; contain: inline-size; }
    .ibh-search select.saved[hidden] { display: none; }
    #ibh-favmore { display: block; margin: 14px auto; padding: 9px 18px; font-size: 14px; }
    #ibh-favmore[hidden] { display: none; }
    #ibh-pager { min-height: 1px; padding: 14px 0; text-align: center; font-size: 13px; opacity: .85; }
    .ibh-bulkbadge { position: absolute; top: 6px; right: 6px; z-index: 3; min-width: 26px; height: 26px; padding: 0 6px;
      border-radius: 13px; color: #fff; font: 600 15px/26px system-ui, sans-serif; text-align: center; pointer-events: none;
      box-shadow: 0 2px 8px rgba(0,0,0,.5); }
    /* The raw hold's mark: a small square in the top left, under the
       resolution when the card has one (its 14px line starts at 3px). */
    .ibh-rawbadge { position: absolute; top: 3px; left: 3px; z-index: 4; width: 22px; height: 22px; border-radius: 3px;
      color: #fff; font: 700 8px/22px system-ui, sans-serif; text-align: center; pointer-events: none;
      box-shadow: 0 1px 3px rgba(0,0,0,.5); }
    :has(> .ibh-res) > .ibh-rawbadge { top: 20px; }
    .ibh-rawbadge[data-state="failed"] { font-size: 12px; }
    ${LIST} a img { -webkit-touch-callout: none; }
  `

  // Two quick taps on a thumbnail are a double tap for the script, never the
  // browser's double-tap zoom (video cards set their own touch-action).
  const TAP_CSS = `${THUMB} a:not([data-ibh-video]) { touch-action: manipulation; }`

  // The site's title, centred: on the left it sat under the « » page buttons
  // in the top-left corner (two IDs outrank the site's own #site-title rule).
  const HEADER_CSS = '#header #site-title { text-align: center; padding-left: 0; }'

  // The card marks: ❤️ top right (big enough to hold), the resolution top
  // left; a favorite's other top-right badges step aside for the heart.
  const CARD_MARKS_CSS = `
    .ibh-liked { position: absolute; top: 1px; right: 1px; z-index: 5; padding: 3px; font-size: 16px; line-height: 1;
      filter: drop-shadow(0 0 2px rgba(0, 0, 0, .8)); cursor: pointer; user-select: none; -webkit-user-select: none;
      -webkit-touch-callout: none; }
    .ibh-res { position: absolute; top: 3px; left: 3px; z-index: 4; pointer-events: none; padding: 0 3px; border-radius: 3px;
      font: 10px/1.4 ui-monospace, monospace; color: #fff; background: rgba(0, 0, 0, .65); }
    [data-ibh-liked] .ibh-heavy { right: 26px !important; }
    [data-ibh-liked] .ibh-bulkbadge { right: 30px !important; }`

  function injectPageCSS() {
    if (document.querySelector('style[data-ibh]')) return
    const style = el('style', { 'data-ibh': '1' })
    style.textContent = NATIVE_MARK_CSS + THEME_CSS + FAVSEARCH_CSS + TAP_CSS + HEADER_CSS + LIKE_CSS + CARD_MARKS_CSS +
      (CFG.videoScrub ? SCRUB_CSS : '') + (CFG.blockAds ? ADS_CSS : '')
    ;(document.head || document.documentElement).appendChild(style)
  }

  // src/main.ts
  // ═══════════════════════════════════════════════════════════
  // Boot
  //
  // The modules only set up their own constants and state. Everything else
  // that runs while the page loads runs here, in the order the single file
  // had: the listeners and the IndexedDB open that sat between its sections
  // first, then the boot itself. The imports are every module, in that
  // file's order; tools/build.mts checks that nothing is read before it is set.
  // ═══════════════════════════════════════════════════════════


  window.addEventListener('pagehide', flushUrlCache)
  // Opened now, while the page loads: the first cards are scanned during
  // that, and their wait (URLIDX_WAIT_MS) would otherwise pay the ~0.1 s
  // an open costs.
  if (CFG.urlCache) urlDb()
  if (tabChannel) {
    tabChannel.onmessage = ev => {
      const msg = ev.data || {}
      if (msg.type === 'free-memory') {
        freeMemory('tab').then(n => (tabChannel).postMessage({ type: 'freed', n, page: location.pathname }))   // this very channel
      } else if (msg.type === 'freed') {
        const { n } = msg
        info(`another tab (${msg.page}) freed ${n.covers} covers, ${n.gifs} GIFs, ${n.images} upgraded images`)
      }
    }
  }

  // A tap anywhere outside the open panel closes it (the ◐ button toggles it itself).
  window.addEventListener('pointerdown', ev => {
    if (!panelOpen || !panelHost) return
    if (ev.composedPath().includes(panelHost)) return
    togglePanel(false)
  }, true)

  // One observer on the document finds new thumbnails (autopager, search
  // results) and keeps the page-level pieces in place.
  installAdBlock()
  new MutationObserver(records => {
    applyAdBlock()   // first: the policy must be in the head before the body's scripts
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue
        scanCards(node)
        scanThumbs(node)
      }
      if (CFG.memorySaver && r.removedNodes.length) onNodesRemoved(r.removedNodes)
    }
    if (panelHost && !panelHost.isConnected) { setPanelHost(null); setShadow(null) }
    if (!panelHost) mountPanel()
    ensureFeedNav()
    injectPageCSS()
    applySiteTheme()
    applyFeed()
    ensureFavSearch()
    ensureFavPager()
    ensureSiteSearch()
  }).observe(document, { childList: true, subtree: true })

  installMemorySaver()
  window.addEventListener('click', onHeartClick, true)  // first: a tap on a card's ❤️ opens nothing
  window.addEventListener('touchstart', onHeartTouchStart, { capture: true, passive: true })
  window.addEventListener('touchmove', onHeartTouchMove, { capture: true, passive: true })
  window.addEventListener('touchend', onHeartTouchEnd, true)
  window.addEventListener('touchcancel', onHeartTouchEnd, true)
  window.addEventListener('contextmenu', ev => { if (asElement(ev.target)?.closest('.ibh-liked')) ev.preventDefault() }, true)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { loadLikedIds() }, { once: true })
  else loadLikedIds()
  window.addEventListener('click', onBulkClick, true)   // before the modal: in mass favorite a tap favorites
  window.addEventListener('click', onRawClick, true)    // before the modal: the release of a raw hold
  window.addEventListener('touchstart', onRawTouchStart, { capture: true, passive: true })
  window.addEventListener('touchmove', onRawTouchMove, { capture: true, passive: true })
  window.addEventListener('touchend', () => { if (rawHold && !rawHold.fired) cancelRawHold() }, true)
  window.addEventListener('touchcancel', cancelRawHold, true)
  window.addEventListener('contextmenu', onRawContextMenu, true)
  installVideoScrub()   // before the modal: its click guard must run first
  window.addEventListener('click', onDoubleTapClick, true)   // after the guards, before the modal
  installVideoModal()
  logSnapshot()
  if (CFG.originalThumbs) info('original thumbnails on: visible thumbnails load the full file')
  if (CFG.nativeFeed) info(`feed on: ${CFG.feedColumns} columns, ${CFG.feedLayout}; site pages show samples`)

  storeReady()   // the first run brings the lists over from the storage bridge
  restoreCfg()

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

  // What __ibh.help() answers. The console functions return text or data
  // instead of printing it: MobiDevTools' REPL shows what a call returns, but
  // it never sees the page's console.
  const CONSOLE_HELP = [
    `Image Board Helper v${VERSION} · window.__ibh`,
    '  help()                 this list',
    '  tail(n, filter)        the last n log lines (20), only those matching filter (a regular expression)',
    '  log()                  the whole log (250 entries) as objects',
    '  version, cfg, state    the version, the settings, the live state',
    '  set(key, value)        changes a setting, as the panel does',
    '  probe()                tests the candidate URLs of the first video on screen (Test URLs)',
    '  free()                 frees memory and caches (Free memory & cache)',
    '  redo()                 starts every thumbnail over (Redo thumbnails)',
    '  clearHostCache()       resolves the image host again (Clear host)',
    '  urlCache(), clearUrlCache()   the cache of which address worked',
    '  await urlIndex()       its IndexedDB side: entries, misses, the cap',
    '  stored(), moveAgain()  the stored lists; merges the old storage bridge in again',
    '  gifs()                 inline GIFs: download slots, turn queue, card states, what holds them',
  ].join('\n')

  // Console access, useful when the panel is turned off. On the page's own
  // window: with GM grants, this script's window is a wrapper around it.
  ;(typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__ibh = {
    help: () => CONSOLE_HELP,
    // The last n log lines as text; with a filter, only the lines whose
    // message matches it (a regular expression, case-insensitive).
    tail: (n = 20, filter = '') => {
      const re = filter ? new RegExp(filter, 'i') : null
      return LOG.filter(e => !re || re.test(e.msg)).slice(-Math.max(1, n)).map(logLine).join('\n') || '(no matching lines)'
    },
    version: VERSION,
    cfg: CFG,
    state: STATE,
    log: () => LOG,
    probe: probeVideoUrls,
    clearHostCache,
    free: freeMemory,
    urlCache: () => ({ ...urlStats, entries: Object.keys(loadUrlCache()).length }),
    urlIndex: urlIndexStats,
    clearUrlCache,
    redo: redoThumbs,
    // Where the inline GIFs stand, for one stuck on its still: the three
    // download slots and who waits for one, the turn queue, each card's state,
    // and what makes nextGif() wait.
    gifs: () => {
      const cards = {}
      markedCards('[data-ibh-gif]').forEach(c => {
        const k = `${c.dataset.ibhGif}${c.dataset.ibhSeen ? ' on screen' : ''}`
        cards[k] = (cards[k] || 0) + 1
      })
      return {
        slots: `${imagesInflight}/${IMAGE_MAX_INFLIGHT}`, slotWaiters: imageWaiters.length,
        live: `${gifsLive()}/${Number(CFG.gifMaxLive) || 3}`, queued: gifQueue.size, cards,
        previewPaused: previewPaused.length, parked: parked.length,
        holding: [document.hidden && 'hidden tab', modal && modal.open && 'modal', scrub && 'finger on a video', gifRebuild && 'a held GIF rebuilding'].filter(Boolean),
      }
    },
    set: setCfg,
    // Size of each stored key (JSON characters) and the move-in state.
    stored: () => (GM_STORE ? Object.fromEntries([...STORE_KEYS.map(k => [k, JSON.stringify(GM_getValue(k, null)).length]), ['movedIn', GM_getValue('movedIn', 0)]]) : null),
    // Merges the storage bridge's lists in once more (a tab on an old
    // version wrote to it after the move): the bridge only, never site data.
    moveAgain: () => {
      if (!GM_STORE) return
      GM_setValue('movedIn', 1)
      setMovedIn(null)
      storeReady()
    },
  }
})();
