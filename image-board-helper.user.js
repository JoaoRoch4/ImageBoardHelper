// ==UserScript==
// @name         Image Board Helper
// @namespace    joao.imageboardhelper
// @version      1.20.0-snapshot.4
// @description  For the phone, on Gelbooru boards (rule34.xxx, gelbooru.com and others): an in-page post viewer, sharp feed with columns, real video covers and scene previews, inline GIFs, favorites search, autopager, Watch later, downloads, and memory care
// @author       João
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
// this file. esbuild joins the modules, not minified; their comments stay in src/.

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
  var __defProp = Object.defineProperty;
  var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

  // src/core/site.js
  var VERSION = "1.20.0-snapshot.4";
  var SITE = location.hostname.replace(/^www\./, "");
  var TEAL = { accent: "#5eead4", line: "#39ff14", dark: "#1d3b38", mid: "#2f7d72" };
  var SITE_PROFILES = {
    "gelbooru.com": {
      list: ".thumbnail-container",
      card: "article.thumbnail-preview",
      item: "article",
      scriptHosts: ["https://ajax.googleapis.com"],
      // Clickadu's 300x250 spots (in fixed-size wrappers), the footer one, ExoClick's video slider.
      adSlots: ['center:has([id^="__clb-spot_"])', 'div:has(> [id^="__clb-spot_"])', '[id^="__clb-spot_"]', ".footerAd2", ".exo_wrapper", '[id$="-msg-video-slider-content"]'],
      colors: { accent: "#5aa9ff", line: "#2f8cff", dark: "#1b3552", mid: "#2f5f9e" },
      // the site's own blue
      suggest: "/index.php?page=autocomplete2&type=tag_query&limit=10&term="
    },
    "safebooru.org": { suggest: "/autocomplete.php?q=" }
  };
  var PROFILE = {
    list: ".image-list",
    card: "span.thumb",
    item: "span",
    scriptHosts: [],
    adSlots: [],
    colors: TEAL,
    suggest: "/public/autocomplete.php?q=",
    ...SITE_PROFILES[SITE]
  };
  var { accent: ACCENT, line: LINE, dark: ACCENT_DARK, mid: ACCENT_MID } = PROFILE.colors;
  var LIST = PROFILE.list;
  var CARD = PROFILE.card;
  var THUMB = `${LIST} ${CARD}`;
  var ITEM = `${LIST} > ${PROFILE.item}`;

  // src/core/config.js
  var CFG_KEY = "IBH_CFG";
  var DEFAULTS = {
    lang: null,
    // null = follow the browser language
    debug: false,
    // mirror the log into the browser console
    panel: true,
    // floating button and status panel
    videoCovers: true,
    // overlay the real video frame on the card
    thumbBadges: true,
    // video thumbnails: the duration (bottom right) and ⚠️ past the hardware decoder (top right) (needs reload)
    gifInline: true,
    // animate GIF cards while they are on screen
    gifMaxLive: 3,
    // at most this many of them animating at once
    holdGif: true,
    // hold a GIF thumbnail: build it again, the other GIFs paused until it plays
    videoScrub: true,
    // scene preview on video thumbnails (needs reload)
    scrubMode: "drag",
    // 'drag': finger position picks the scene; 'hold': hold for a slideshow
    holdVideo: false,
    // hold mode: the video itself plays (1×, Firefox's hardware decoder) instead of the slideshow
    previewSound: false,
    // hold mode: a video that plays (holdVideo, a short clip) plays with sound
    holdResume: true,
    // hold mode: a video that plays goes on where the last hold lifted, for a minute (⏮ on the card starts over)
    holdRub: true,
    // hold, then slide sideways to move the video forward or back: a thumbnail's playing hold (hold mode) and the post's player
    slideStep: 10,
    // hold slideshow: jump between scenes, in % of the video
    slideDwell: 0.2,
    // hold slideshow: seconds each scene stays once painted
    slideReel: true,
    // hold slideshow from keyframes only (MP4): one small read per scene, no seeking the file
    wasmDecode: true,
    // with slideReel, decode the keyframes in WebAssembly (FFmpeg's H.264) into a canvas
    seekReel: true,
    // modal seek bar: the nearest keyframe at once (WebAssembly), the exact frame when the finger rests
    playRate: 1,
    // modal player speed, picked in its ⚙ (0.5 to 2), kept for every video
    seekStep: 5,
    // modal player: seconds a double tap on a side jumps, picked in its ⚙
    doubleTapCenter: "fullscreen",
    // modal: a double tap in the middle of a post: 'fullscreen' (a common player) or 'like' (Instagram: ♥ favorite + ▲)
    memorySaver: true,
    // release far off-screen images and removed videos (needs reload)
    urlCache: true,
    // remember which candidate URL worked for each file
    feedNav: true,
    // ⤒ ‹ › buttons: top of page, previous and next post in the feed (needs reload)
    holdRaw: true,
    // hold an image on site pages to load its original (raw) file in place
    favsButton: true,
    // 🔖 button next to ♥ and 🕒 on rule34: your favorites page
    bulkFavButton: true,
    // ♥ button next to 🕒 on site pages: a mode where each tapped post is favorited and upvoted
    doubleTapFav: true,
    // double tap a thumbnail on rule34: favorite and upvote it; a single tap opens the post a moment later
    doubleTapLike: "heart",
    // that double tap: 'heart' (a ❤️ grows over the thumbnail and vanishes) or 'quiet' (no animation)
    likedBadge: true,
    // rule34: ❤️ in the top right of a favorite's thumbnail (the favorites index and the posts liked here); hold it to unfavorite
    favAutoIndex: true,
    // rule34: favoriting or unfavoriting a post here also adds it to or takes it out of the favorites index
    resBadge: true,
    // the post's resolution in the thumbnail's top left (rule34's API with your key; videos and opened posts without it)
    freeButton: true,
    // trash-can button next to them: Free memory & cache in one tap
    redoButton: true,
    // ↻ button beside it: free memory, then redo every thumbnail
    eyeButton: true,
    // 👁 button beside ◐: hides the other floating buttons, and brings them back
    buttonsHidden: false,
    // set by the 👁 button (no panel switch): the floating buttons are hidden
    laterButton: true,
    // 🕒 button next to them on site pages: the Watch later list
    favSearch: true,
    // search bar on your own rule34 favorites page, results in the page's own list
    favAutopager: true,
    // search listings and favorites load the next page as you near the bottom
    siteSearch: true,
    // search bar on the site's listing pages: tags, kind, order, minimum score
    searchSuggest: true,
    // tag suggestions from the site while typing in the script's search bars
    videoModal: true,
    // open posts from site pages in an overlay: video, GIF, image (needs reload)
    rotateLandscape: true,
    // in the modal player's fullscreen, lock wide videos to landscape
    modalPreload: true,
    // in the modal, have the next post loaded before the swipe
    appBridge: false,
    // ⬇ App and ⚡ 1080p through the app's own server (127.0.0.1:8745, its token) when it answers: the site's fast host, progress here
    playerButton: true,
    // ▶ Media Player, ⬇ App and ⚡ 1080p in a video post's ☰ menu: the video played, downloaded or converted by the user's QtMediaPlayer app
    copyLinkButton: true,
    // 🔗 in the post's ☰ menu: copies the link to the post's own file (raw, not the sample)
    modalOriginal: "zoom",
    // images in the modal: 'zoom' shows the sample and fetches the original on zoom; 'always'
    siteTheme: true,
    // the modal's dark theme on the site's pages
    blockAds: true,
    // only the site's own scripts and frames load: no ad networks, no popunders (needs reload)
    originalThumbs: false,
    // the original where a thumbnail's box is wider than the sample (a desktop screen; needs reload)
    nativeFeed: false,
    // feed with sharp images on the site's own pages (applies at once)
    feedColumns: 1,
    // its columns: 'auto' (by screen width) or 1-4
    feedLayout: "masonry"
    // 'masonry': whole images in columns; 'grid': even square tiles
  };
  var NEEDS_RELOAD = /* @__PURE__ */ new Set(["originalThumbs", "memorySaver", "feedNav", "videoModal", "videoScrub", "blockAds", "thumbBadges"]);
  var CFG_FOUND = (() => {
    try {
      return localStorage.getItem(CFG_KEY) !== null;
    } catch (e) {
      return true;
    }
  })();
  var CFG = Object.assign({}, DEFAULTS, readJSON(CFG_KEY, {}));
  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  __name(readJSON, "readJSON");
  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }
  __name(writeJSON, "writeJSON");

  // src/core/strings.js
  var I18N = {
    en: {
      fixes: "fixes",
      log: "log",
      language: "language",
      auto: "Automatic",
      site: "site",
      thumbnail: "thumbnail",
      host: "host",
      covers: "covers",
      failed: "failed",
      notResolved: "not resolved",
      cached: "cached",
      /** @param {number} ok @param {number} bad @param {number} all */
      coversFmt: /* @__PURE__ */ __name((ok, bad, all) => `${ok} ok · ${bad} failed · ${all} videos`, "coversFmt"),
      tCovers: "Video covers",
      tBadges: "Duration and ⚠️ on video thumbnails",
      tGif: "Animated GIFs in the grid",
      tGifMax: "GIFs animating at once",
      tHoldGif: "Hold a GIF to rebuild it",
      tScrub: "Scene preview on video thumbnails",
      tScrubMode: "scene preview gesture",
      modeDrag: "Drag sideways",
      modeHold: "Hold (slideshow)",
      tSlideStep: "slideshow jump",
      tSlideDwell: "time per scene",
      scenes: "scenes",
      tSlideReel: "Keyframes only (faster, MP4)",
      tWasmDecode: "Decode keyframes in WebAssembly",
      tHoldVideo: "Hold plays the video (hardware)",
      tPreviewSound: "Sound when the hold plays the video",
      tHoldResume: "Hold goes on where it stopped (1 min)",
      tHoldRub: "Hold, then slide to move the video",
      resumeRestart: "Start from the beginning",
      soundToggle: "Hold sound: tap to switch",
      heavyMark: "Past this phone’s hardware decoder (1080p60)",
      tMemory: "Release off-screen memory",
      tUrlCache: "Remember working file URLs",
      tNav: "Top / previous / next buttons",
      navPrev: "Previous post",
      navNext: "Next post",
      navTop: "Top of the page",
      navBottom: "Bottom of the page",
      navPrevPage: "Previous page",
      navNextPage: "Next page",
      tHoldRaw: "Hold an image for its raw file",
      rawFailed: "No original file found",
      rawAlready: "This image already is the original (the post has no sample)",
      tFavsBtn: "Your-favorites shortcut button",
      navFavs: "Your favorites",
      tBulkBtn: "Mass-favorite button",
      navBulk: "Mass favorite: each tapped post gets ♥ and ▲",
      bulkOn: "Mass favorite on: tap posts to favorite and upvote them",
      bulkOff: "Mass favorite off",
      tCopyBtn: "Copy-link button in the post menu",
      copyLink: "🔗 Copy link",
      linkCopied: "Link to the raw file copied",
      copyFailed: "Could not copy the link",
      tPlayerBtn: "Media Player buttons (▶ play, ⬇ download, ⚡ convert) in the post menu",
      appDlBtn: "⬇ App",
      appReduceBtn: "⚡ 1080p",
      bigVideo: "Past this phone’s hardware decoder: ☰ → ⚡ 1080p converts it in the app",
      tAppBridge: "Talk to the app directly (its server)",
      appToken: "App token",
      appOk: "App connected",
      appDown: "App not answering (open it)",
      appBadToken: "Wrong token",
      appNoStore: "Needs Violentmonkey storage",
      appQueued: "Downloading in the app",
      appReduceQueued: "Downloading in the app, to convert",
      appSaved: "Saved by the app",
      appFailed: "The app’s download failed",
      appConverting: "Converting in the app",
      appConverted: "Converted by the app",
      appFits: "Saved: it plays as it is",
      tRedoBtn: "Redo-thumbnails shortcut button",
      navRedo: "Free memory, then redo thumbnails",
      tDoubleTap: "Double tap a thumbnail: favorite + upvote",
      tDoubleTapLike: "Thumbnail like",
      likeHeart: "With the ❤️ animation",
      likeQuiet: "Quiet (no animation)",
      tLikedBadge: "❤️ on favorites’ thumbnails (hold it: unfavorite)",
      heartHint: "Hold ❤️ to remove it from your favorites",
      unlikeFail: "Could not unfavorite",
      tFavAutoIndex: "Keep the favorites index up to date when liking",
      tResBadge: "Resolution on thumbnails",
      apiKey: "rule34 API key",
      apiSec: "rule34 API (your key)",
      apiWarn: "⚠️ Paste your API key below to turn these on. rule34 → My Account → Options → API Access Credentials: copy the whole &api_key=…&user_id=… line.",
      apiPartial: "videos only",
      apiKeyHint: "Paste &api_key=…&user_id=… (rule34 → My Account → Options)",
      apiKeySet: "Key saved: resolutions from the API",
      apiKeyNone: "No key: only videos and opened posts",
      apiKeyBad: "Not a key: paste the whole &api_key=…&user_id=… line",
      tEyeBtn: "👁 button: hides the other buttons",
      eyeHide: "Hide the buttons",
      eyeShow: "Show the buttons",
      tFreeBtn: "Free-memory shortcut button",
      navFree: "Free memory & cache",
      tFavSearch: "Search your favorites",
      tSiteSearch: "Search bar on site pages",
      tSuggest: "Tag suggestions while typing",
      savedPick: "Favorite searches…",
      recentPick: "Recent searches…",
      saveSearch: "☆ Favorite",
      savedSearch: "★ Favorite",
      savedAll: "(everything)",
      orPlaceholder: "OR: tag tag tag · || new group",
      minScore: "min. score",
      sitePlaceholder: "search: tag -tag tag* ( a ~ b )",
      tPager: "Autopager (searches and favorites)",
      pagerLoading: "Loading the next page…",
      pagerEnd: "End of the list",
      pagerFail: "Could not load the next page — tap to retry",
      favPlaceholder: "search favorites: tag -tag tag* a ~ b score:>10",
      favGo: "Search",
      favClear: "Clear",
      favKindAll: "All types",
      favKindImage: "Images",
      favKindVideo: "Videos",
      favKindGif: "GIFs",
      favKindAnimated: "Animated (video or GIF)",
      favSortNew: "Newest",
      favSortOld: "Oldest",
      favSortScore: "Score",
      favSortRandom: "Random",
      favIndexed: "favorites indexed",
      favNever: "not indexed yet: the first search reads every page",
      favPartial: "not all yet: the rest comes in on its own",
      favScanning: "reading favorites, page",
      favResults: "results",
      favMore: "Show more",
      favUpdate: "Update",
      favRebuild: "Rebuild index",
      favScanFail: "could not read the favorites page",
      tLaterBtn: "Watch later button",
      navLater: "Watch later",
      laterTitle: "Watch later",
      dlBtn: "🦊⬇ Download raw",
      dlWait: "The file is still loading",
      dlStart: "Downloading…",
      dlBusy: "Already downloading this post",
      dlDone: "Downloaded: confirm in Firefox to save",
      dlFail: "Download failed",
      dlOpened: "Opened in a new tab: hold it to save",
      laterAdd: "🕒 Watch later",
      laterIn: "✓ In Watch later",
      laterAdded: "Saved for later",
      laterRemoved: "Removed from the list",
      laterEmpty: "Nothing saved yet. Use 🕒 in a post’s ☰ menu.",
      laterOnDevice: "kept by Violentmonkey, on this device",
      laterOnSite: "kept in this site’s data (IndexedDB)",
      tModal: "Open posts in a player over the page",
      tTheme: "Dark theme on site pages",
      tSeekReel: "Seek bar preview from keyframes (WebAssembly)",
      tAds: "Block ads (only the site's own scripts load)",
      mClose: "Close",
      mOpen: "Open the post",
      mPrev: "Previous post",
      mNext: "Next post",
      mLoading: "Loading…",
      mFail: "Could not load it",
      mFav: "Add to favorites",
      mUp: "Upvote",
      mFull: "Fullscreen",
      mFullExit: "Exit fullscreen",
      mMenu: "Tags and post page",
      tabTags: "Tags",
      tabInfo: "Info",
      tabComments: "Comments",
      commentsMore: "More comments",
      commentsNone: "No comments",
      commentsHidden: "hidden by your comment threshold",
      infoKind: "Kind",
      infoRes: "Resolution",
      infoFormat: "Format",
      infoDuration: "Duration",
      infoDrops: "Dropped frames",
      infoDropsOf: "of",
      infoAbove: "above 1080p: mid-range phones decode it in software",
      infoLoading: "loading…",
      kindVideo: "Video",
      kindGif: "GIF",
      kindImage: "Image",
      tagOpened: "Opened in a new tab",
      tagCopied: "Copied",
      tagCopyFail: "Could not copy",
      tagsNone: "No tags",
      mTurn: "Rotate the screen",
      mPlay: "Play / pause",
      mMute: "Sound on / off",
      mFavUp: "Favorite and upvote",
      mGear: "Speed and double tap",
      gearRate: "Speed",
      gearStep: "Double tap jumps",
      tPlayRate: "Player speed",
      tSeekStep: "Player double tap jump",
      tDoubleTapCenter: "Double tap in the middle of a post",
      dtFullscreen: "Fullscreen (common player)",
      dtLike: "Like: ♥ favorite + ▲ (Instagram)",
      tRotate: "Landscape in player fullscreen",
      tPreload: "Next post loaded in the player",
      tModalOrig: "original image in the player",
      origZoom: "When zooming in (sample first, faster)",
      origAlways: "Always (slower)",
      origLoading: "Loading the original…",
      infoSample: "sample",
      qualSampleTip: "Showing the sample: tap for the original (raw)",
      qualRawTip: "Showing the original (raw): tap for the sample",
      favAdded: "Added to favorites",
      favAlready: "Already in your favorites",
      favRemoved: "Removed from favorites",
      favLogin: "You are not logged in",
      favFail: "Could not favorite",
      mTurnNo: "This browser cannot turn the screen",
      voted: "Upvoted",
      voteFail: "Could not vote",
      tOriginal: "Original thumbnails (heavy)",
      tFeed: "Feed on site pages",
      tFeedCols: "feed columns",
      tFeedLayout: "feed layout",
      colsAuto: "Automatic (by screen width)",
      layoutMasonry: "Masonry (whole images)",
      layoutGrid: "Grid (even tiles)",
      tDebug: "Log to console",
      noteReload: "reload",
      bTest: "Test URLs",
      bClearHost: "Clear host",
      bCopy: "Copy log",
      bReload: "Reload",
      bFree: "Free memory & cache",
      bRedo: "Redo thumbnails"
    },
    "pt-BR": {
      fixes: "correções",
      log: "log",
      language: "idioma",
      auto: "Automático",
      site: "site",
      thumbnail: "miniatura",
      host: "host",
      covers: "capas",
      failed: "falhou",
      notResolved: "não resolvido",
      cached: "cache",
      /** @param {number} ok @param {number} bad @param {number} all */
      coversFmt: /* @__PURE__ */ __name((ok, bad, all) => `${ok} ok · ${bad} falha · ${all} vídeos`, "coversFmt"),
      tCovers: "Capa de vídeo",
      tBadges: "Duração e ⚠️ nas miniaturas de vídeo",
      tGif: "GIF animado na grade",
      tGifMax: "GIFs animando ao mesmo tempo",
      tHoldGif: "Segurar um GIF para reconstruí-lo",
      tScrub: "Prévia de cenas nas miniaturas de vídeo",
      tScrubMode: "gesto da prévia de cenas",
      modeDrag: "Arrastar de lado",
      modeHold: "Segurar (slideshow)",
      tSlideStep: "pulo do slideshow",
      tSlideDwell: "tempo por cena",
      scenes: "cenas",
      tSlideReel: "Só keyframes (mais rápido, MP4)",
      tWasmDecode: "Decodificar keyframes em WebAssembly",
      tHoldVideo: "Segurar toca o vídeo (hardware)",
      tPreviewSound: "Som quando o segurar toca o vídeo",
      tHoldResume: "Segurar continua de onde parou (1 min)",
      tHoldRub: "Segurar e deslizar move o vídeo",
      resumeRestart: "Recomeçar do início",
      soundToggle: "Som do segurar: toque para trocar",
      heavyMark: "Acima do decodificador de hardware do celular (1080p60)",
      tMemory: "Liberar memória fora da tela",
      tUrlCache: "Lembrar endereços que funcionaram",
      tNav: "Botões topo / anterior / próximo",
      navPrev: "Post anterior",
      navNext: "Próximo post",
      navTop: "Topo da página",
      navBottom: "Fim da página",
      navPrevPage: "Página anterior",
      navNextPage: "Próxima página",
      tHoldRaw: "Segurar a imagem para carregar a original (raw)",
      rawFailed: "Arquivo original não encontrado",
      rawAlready: "Esta imagem já é o original (o post não tem sample)",
      tFavsBtn: "Botão de atalho para os seus favoritos",
      navFavs: "Seus favoritos",
      tBulkBtn: "Botão de favoritar em massa",
      navBulk: "Favoritar em massa: cada post tocado ganha ♥ e ▲",
      bulkOn: "Favoritar em massa ligado: toque nos posts para favoritar e votar",
      bulkOff: "Favoritar em massa desligado",
      tCopyBtn: "Botão de copiar link no menu do post",
      copyLink: "🔗 Copiar link",
      linkCopied: "Link do arquivo raw copiado",
      copyFailed: "Não deu para copiar o link",
      tPlayerBtn: "Botões do Media Player (▶ tocar, ⬇ baixar, ⚡ converter) no menu do post",
      appDlBtn: "⬇ App",
      appReduceBtn: "⚡ 1080p",
      bigVideo: "Grande demais para o decodificador do celular: ☰ → ⚡ 1080p converte no app",
      tAppBridge: "Falar direto com o app (servidor dele)",
      appToken: "Token do app",
      appOk: "App conectado",
      appDown: "App sem resposta (abra o app)",
      appBadToken: "Token errado",
      appNoStore: "Precisa do armazenamento do Violentmonkey",
      appQueued: "Baixando no app",
      appReduceQueued: "Baixando no app, para converter",
      appSaved: "Salvo pelo app",
      appFailed: "O download do app falhou",
      appConverting: "Convertendo no app",
      appConverted: "Convertido pelo app",
      appFits: "Salvo: toca como está",
      tRedoBtn: "Botão de atalho para refazer as miniaturas",
      navRedo: "Limpar a memória e refazer as miniaturas",
      tDoubleTap: "Toque duplo na miniatura: favoritar + votar",
      tDoubleTapLike: "Curtida na miniatura",
      likeHeart: "Com a animação do ❤️",
      likeQuiet: "Discreta (sem animação)",
      tLikedBadge: "❤️ nas miniaturas dos favoritos (segurar: descurtir)",
      heartHint: "Segure o ❤️ para tirar dos favoritos",
      unlikeFail: "Não deu para descurtir",
      tFavAutoIndex: "Manter o índice de favoritos em dia ao curtir",
      tResBadge: "Resolução nas miniaturas",
      apiKey: "Chave da API do rule34",
      apiSec: "API do rule34 (sua chave)",
      apiWarn: "⚠️ Cole sua chave da API abaixo para ligar estas funções. rule34 → My Account → Options → API Access Credentials: copie a linha inteira &api_key=…&user_id=….",
      apiPartial: "só vídeos",
      apiKeyHint: "Cole &api_key=…&user_id=… (rule34 → My Account → Options)",
      apiKeySet: "Chave salva: resoluções pela API",
      apiKeyNone: "Sem chave: só vídeos e posts abertos",
      apiKeyBad: "Não é uma chave: cole a linha &api_key=…&user_id=… inteira",
      tEyeBtn: "Botão 👁: oculta os outros botões",
      eyeHide: "Ocultar os botões",
      eyeShow: "Mostrar os botões",
      tFreeBtn: "Botão de atalho para limpar a memória",
      navFree: "Limpar memória e cache",
      tFavSearch: "Buscar nos seus favoritos",
      tSiteSearch: "Barra de busca nas páginas do site",
      tSuggest: "Sugestões de tags ao digitar",
      savedPick: "Buscas favoritas…",
      recentPick: "Buscas recentes…",
      saveSearch: "☆ Favoritar",
      savedSearch: "★ Favorita",
      savedAll: "(tudo)",
      orPlaceholder: "OU: tag tag tag · || novo grupo",
      minScore: "score mín.",
      sitePlaceholder: "buscar: tag -tag tag* ( a ~ b )",
      tPager: "Autopager (buscas e favoritos)",
      pagerLoading: "Carregando a próxima página…",
      pagerEnd: "Fim da lista",
      pagerFail: "Não deu para carregar a próxima página — toque para tentar de novo",
      favPlaceholder: "buscar nos favoritos: tag -tag tag* a ~ b score:>10",
      favGo: "Buscar",
      favClear: "Limpar",
      favKindAll: "Todos os tipos",
      favKindImage: "Imagens",
      favKindVideo: "Vídeos",
      favKindGif: "GIFs",
      favKindAnimated: "Animados (vídeo ou GIF)",
      favSortNew: "Mais novos",
      favSortOld: "Mais antigos",
      favSortScore: "Score",
      favSortRandom: "Aleatório",
      favIndexed: "favoritos no índice",
      favNever: "ainda sem índice: a primeira busca lê todas as páginas",
      favPartial: "ainda não todos: o resto vem sozinho",
      favScanning: "lendo favoritos, página",
      favResults: "resultados",
      favMore: "Mostrar mais",
      favUpdate: "Atualizar",
      favRebuild: "Refazer índice",
      favScanFail: "não foi possível ler a página de favoritos",
      tLaterBtn: "Botão Ver depois",
      navLater: "Ver depois",
      laterTitle: "Ver depois",
      dlBtn: "🦊⬇ Baixar raw",
      dlWait: "O arquivo ainda está carregando",
      dlStart: "Baixando…",
      dlBusy: "Este post já está baixando",
      dlDone: "Baixado: confirme no Firefox para salvar",
      dlFail: "Falha no download",
      dlOpened: "Aberto em outra aba: segure para salvar",
      laterAdd: "🕒 Ver depois",
      laterIn: "✓ Na lista",
      laterAdded: "Salvo para ver depois",
      laterRemoved: "Tirado da lista",
      laterEmpty: "Nada salvo ainda. Use o 🕒 no menu ☰ de um post.",
      laterOnDevice: "guardado pelo Violentmonkey, neste aparelho",
      laterOnSite: "guardado nos dados deste site (IndexedDB)",
      tModal: "Abrir posts num player sobre a página",
      tTheme: "Tema escuro nas páginas do site",
      tSeekReel: "Prévia da barra de busca por keyframes (WebAssembly)",
      tAds: "Bloquear anúncios (só os scripts do próprio site carregam)",
      mClose: "Fechar",
      mOpen: "Abrir o post",
      mPrev: "Post anterior",
      mNext: "Próximo post",
      mLoading: "Carregando…",
      mFail: "Não foi possível carregar",
      mFav: "Favoritar",
      mUp: "Votar positivo",
      mFull: "Tela cheia",
      mFullExit: "Sair da tela cheia",
      mMenu: "Tags e página do post",
      tabTags: "Tags",
      tabInfo: "Info",
      tabComments: "Comentários",
      commentsMore: "Mais comentários",
      commentsNone: "Sem comentários",
      commentsHidden: "ocultos pelo seu limite de score de comentários",
      infoKind: "Tipo",
      infoRes: "Resolução",
      infoFormat: "Formato",
      infoDuration: "Duração",
      infoDrops: "Quadros perdidos",
      infoDropsOf: "de",
      infoAbove: "acima de 1080p: celulares intermediários decodificam em software",
      infoLoading: "carregando…",
      kindVideo: "Vídeo",
      kindGif: "GIF",
      kindImage: "Imagem",
      tagOpened: "Aberto em outra aba",
      tagCopied: "Copiado",
      tagCopyFail: "Não foi possível copiar",
      tagsNone: "Sem tags",
      mTurn: "Girar a tela",
      mPlay: "Tocar / pausar",
      mMute: "Som liga / desliga",
      mFavUp: "Favoritar e dar ▲",
      mGear: "Velocidade e duplo toque",
      gearRate: "Velocidade",
      gearStep: "Duplo toque pula",
      tPlayRate: "Velocidade do player",
      tSeekStep: "Pulo do duplo toque no player",
      tDoubleTapCenter: "Toque duplo no meio do post",
      dtFullscreen: "Tela cheia (player comum)",
      dtLike: "Curtir: ♥ favorito + ▲ (Instagram)",
      tRotate: "Paisagem na tela cheia do player",
      tPreload: "Próximo post carregado no player",
      tModalOrig: "imagem original no player",
      origZoom: "Ao dar zoom (sample antes, mais rápido)",
      origAlways: "Sempre (mais lento)",
      origLoading: "Carregando o original…",
      infoSample: "sample",
      qualSampleTip: "Mostrando o sample: toque para o original (raw)",
      qualRawTip: "Mostrando o original (raw): toque para o sample",
      favAdded: "Adicionado aos favoritos",
      favAlready: "Já está nos favoritos",
      favRemoved: "Removido dos favoritos",
      favLogin: "Você não está logado",
      favFail: "Não foi possível favoritar",
      mTurnNo: "Este navegador não gira a tela",
      voted: "Voto registrado",
      voteFail: "Não foi possível votar",
      tOriginal: "Miniatura original (pesado)",
      tFeed: "Feed nas páginas do site",
      tFeedCols: "colunas do feed",
      tFeedLayout: "layout do feed",
      colsAuto: "Automático (pela largura da tela)",
      layoutMasonry: "Masonry (imagens inteiras)",
      layoutGrid: "Grade (quadros iguais)",
      tDebug: "Log no console",
      noteReload: "recarregar",
      bTest: "Testar URLs",
      bClearHost: "Limpar host",
      bCopy: "Copiar log",
      bReload: "Recarregar",
      bFree: "Limpar memória e cache",
      bRedo: "Refazer miniaturas"
    }
  };

  // src/core/i18n.js
  function resolveLang() {
    if (CFG.lang && I18N[CFG.lang]) return CFG.lang;
    return String(navigator.language || "en").toLowerCase().startsWith("pt") ? "pt-BR" : "en";
  }
  __name(resolveLang, "resolveLang");
  var LANG = resolveLang();
  function setLang(v) {
    LANG = v;
  }
  __name(setLang, "setLang");
  var t = /* @__PURE__ */ __name((key) => {
    const value = I18N[LANG][key];
    return value === void 0 ? I18N.en[key] : value;
  }, "t");

  // src/core/log.ts
  var LOG = [];
  var LOG_MAX = 250;
  var onLogEntry = null;
  function setOnLogEntry(v) {
    onLogEntry = v;
  }
  __name(setOnLogEntry, "setOnLogEntry");
  function log(level, msg) {
    const entry = { t: Date.now(), level, msg: String(msg) };
    LOG.push(entry);
    if (LOG.length > LOG_MAX) LOG.shift();
    if (CFG.debug || level === "error" || level === "warn") {
      const fn = level === "error" ? "error" : level === "warn" ? "warn" : "log";
      console[fn](`[IBH] ${msg}`);
    }
    if (onLogEntry) onLogEntry(entry);
  }
  __name(log, "log");
  var dbg = /* @__PURE__ */ __name((m) => log("debug", m), "dbg");
  var info = /* @__PURE__ */ __name((m) => log("info", m), "info");
  var warn = /* @__PURE__ */ __name((m) => log("warn", m), "warn");
  var error = /* @__PURE__ */ __name((m) => log("error", m), "error");
  var describeError = /* @__PURE__ */ __name((e) => e && e.message ? e.message : String(e), "describeError");
  var logLine = /* @__PURE__ */ __name((e) => `${new Date(e.t).toTimeString().slice(0, 8)} [${e.level}] ${e.msg}`, "logLine");

  // src/core/state.ts
  var STATE = {
    imageBase: null,
    baseCached: false,
    covers: { tracked: 0, ok: 0, failed: 0 }
  };
  var onStateChange = null;
  function setOnStateChange(v) {
    onStateChange = v;
  }
  __name(setOnStateChange, "setOnStateChange");
  var touch = /* @__PURE__ */ __name(() => {
    if (onStateChange) onStateChange();
  }, "touch");

  // src/urls/url-cache.js
  var URLCACHE_KEY = `IBH_URLCACHE_${SITE}`;
  var URLCACHE_MAX = 1500;
  var URLCACHE_TTL = 30 * 24 * 60 * 60 * 1e3;
  var URLCACHE_NEG_TTL = 24 * 60 * 60 * 1e3;
  var urlStats = { hits: 0, misses: 0, healed: 0 };
  var urlCache = null;
  var urlCacheTimer = 0;
  var URLIDX_MAX = 2e4;
  var URL_KINDS = ["sample", "orig", "gif", "video", "poster"];
  var URLIDX_SYNC_KEY = `IBH_URLIDX_SYNC_${SITE}`;
  var urlDbOpen = null;
  var urlDirty = /* @__PURE__ */ new Map();
  var urlAsked = /* @__PURE__ */ new Set();
  var urlWanted = /* @__PURE__ */ new Set();
  var urlGen = 0;
  var urlInFlight = /* @__PURE__ */ new Set();
  var urlReading = null;
  var URLIDX_WAIT_MS = 400;
  var expired = /* @__PURE__ */ __name((entry) => Date.now() - entry.t >= (entry.u === null ? URLCACHE_NEG_TTL : URLCACHE_TTL), "expired");
  function dropExpired() {
    let n = 0;
    for (const k of Object.keys(
      /** @type {UrlCache} */
      urlCache
    ))
      if (expired(
        /** @type {UrlCache} */
        urlCache[k]
      )) {
        delete /** @type {UrlCache} */
        urlCache[k];
        n++;
      }
    return n;
  }
  __name(dropExpired, "dropExpired");
  function loadUrlCache() {
    if (!urlCache) {
      urlCache = /** @type {UrlCache} */
      readJSON(URLCACHE_KEY, {}) || {};
      if (dropExpired()) scheduleUrlFlush();
      syncUrlIndex(urlCache);
    }
    return urlCache;
  }
  __name(loadUrlCache, "loadUrlCache");
  function putUrl(key, entry) {
    urlCache[key] = entry;
    urlDirty.set(key, entry);
    scheduleUrlFlush();
  }
  __name(putUrl, "putUrl");
  var MISS_CONFIRM_MS = 60 * 1e3;
  function cacheGet(kind, hash) {
    if (!CFG.urlCache || !hash) return void 0;
    const key = `${kind}:${hash}`;
    const entry = loadUrlCache()[key];
    if (entry && !expired(entry)) {
      if (entry.u === null && (entry.n || 1) < 2) {
        urlStats.misses++;
        return void 0;
      }
      urlStats.hits++;
      return entry.u;
    }
    if (entry) {
      delete /** @type {UrlCache} */
      urlCache[key];
      scheduleUrlFlush();
    }
    urlStats.misses++;
    return void 0;
  }
  __name(cacheGet, "cacheGet");
  function cacheSet(kind, hash, url, previous) {
    if (!CFG.urlCache || !hash) return;
    const key = `${kind}:${hash}`;
    const old = loadUrlCache()[key];
    const now = Date.now();
    if (url === null) {
      if (navigator.onLine === false) return;
      if (old && old.u === null) {
        if (!old.n || old.n < 2) {
          if (now - (old.f || old.t) < MISS_CONFIRM_MS) return;
          putUrl(key, { u: null, t: now, f: old.f || old.t, n: 2 });
        }
        return;
      }
      putUrl(key, { u: null, t: now, f: now, n: 1 });
      return;
    }
    if (previous && url !== previous) urlStats.healed++;
    if (old && old.u === url && now - old.t < URLCACHE_NEG_TTL) return;
    putUrl(key, { u: url, t: now });
  }
  __name(cacheSet, "cacheSet");
  var cachedFirst = /* @__PURE__ */ __name((urls, cached) => typeof cached === "string" ? [cached, ...urls.filter((u) => u !== cached)] : urls, "cachedFirst");
  function forgetMiss(kind, hash) {
    if (!CFG.urlCache || !hash) return;
    const key = `${kind}:${hash}`;
    const entry = loadUrlCache()[key];
    if (entry && entry.u !== null) return;
    delete /** @type {UrlCache} */
    urlCache[key];
    urlDirty.set(key, null);
    scheduleUrlFlush();
  }
  __name(forgetMiss, "forgetMiss");
  function scheduleUrlFlush() {
    if (!urlCacheTimer) urlCacheTimer = setTimeout(flushUrlCache, 3e3);
  }
  __name(scheduleUrlFlush, "scheduleUrlFlush");
  var newestFirst = /* @__PURE__ */ __name((keys) => keys.sort((a, b) => (
    /** @type {UrlCache} */
    urlCache[b].t - /** @type {UrlCache} */
    urlCache[a].t
  )), "newestFirst");
  var pickUrls = /* @__PURE__ */ __name((keys) => (
    /** @type {UrlCache} */
    Object.fromEntries(keys.map((k) => [
      k,
      /** @type {UrlCache} */
      urlCache[k]
    ]))
  ), "pickUrls");
  var lastLoggedHits = -1;
  function flushUrlCache() {
    clearTimeout(urlCacheTimer);
    urlCacheTimer = 0;
    if (!urlCache) return;
    dropExpired();
    const newest = newestFirst(Object.keys(urlCache)).slice(0, URLCACHE_MAX);
    if (!writeJSON(URLCACHE_KEY, pickUrls(newest))) {
      if (!writeJSON(URLCACHE_KEY, pickUrls(newest.slice(0, Math.floor(newest.length / 2))))) warn("url cache: could not save it");
    }
    flushUrlIndex();
    if (urlStats.hits !== lastLoggedHits) {
      lastLoggedHits = urlStats.hits;
      dbg(`url cache: ${urlStats.hits} hits, ${urlStats.misses} misses, ${urlStats.healed} healed, ${Object.keys(urlCache).length} entries`);
    }
  }
  __name(flushUrlCache, "flushUrlCache");
  function clearUrlCache(missesOnly) {
    const c = loadUrlCache();
    let n = 0;
    for (const k of Object.keys(c)) if (!missesOnly || c[k].u === null) {
      delete c[k];
      n++;
    }
    clearUrlIndex(missesOnly);
    flushUrlCache();
    return n;
  }
  __name(clearUrlCache, "clearUrlCache");
  function urlDb() {
    if (!urlDbOpen) {
      urlDbOpen = new Promise((resolve) => {
        try {
          const req = indexedDB.open("ibh-urls", 1);
          req.onupgradeneeded = () => {
            const store = req.result.createObjectStore("urls");
            store.createIndex("t", "t");
            store.createIndex("m", "m");
          };
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("urls")) {
              db.close();
              resolve(null);
              return;
            }
            db.onversionchange = () => {
              db.close();
              urlDbOpen = null;
            };
            resolve(db);
          };
          req.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    }
    return urlDbOpen;
  }
  __name(urlDb, "urlDb");
  async function urlTx(mode, work) {
    const db = await urlDb();
    if (!db) return false;
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("urls", mode);
        work(tx.objectStore("urls"));
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
      return true;
    } catch (e) {
      dbg(`url index: ${mode} failed — ${describeError(e)}`);
      return false;
    }
  }
  __name(urlTx, "urlTx");
  function urlPrefetch(src) {
    if (!CFG.urlCache) return;
    const hash = (thumbParts(src) || {}).hash;
    if (!hash || urlAsked.has(hash)) return;
    urlAsked.add(hash);
    urlInFlight.add(hash);
    urlWanted.add(hash);
    if (urlWanted.size > 1) return;
    const batch = new Promise((resolve) => queueMicrotask(() => readWanted().then(resolve)));
    const capped = Promise.race([batch, new Promise((resolve) => setTimeout(resolve, URLIDX_WAIT_MS))]);
    urlReading = /** @type {Promise<void>} */
    capped;
    capped.then(() => {
      if (urlReading === capped) urlReading = null;
    });
  }
  __name(urlPrefetch, "urlPrefetch");
  function urlPending(kind, hash) {
    if (!urlReading || !hash || !urlInFlight.has(hash)) return null;
    return urlCache && urlCache[`${kind}:${hash}`] ? null : urlReading;
  }
  __name(urlPending, "urlPending");
  async function readWanted() {
    const hashes = [...urlWanted];
    urlWanted.clear();
    try {
      await readUrls(hashes);
    } finally {
      for (const hash of hashes) urlInFlight.delete(hash);
    }
  }
  __name(readWanted, "readWanted");
  async function readUrls(hashes) {
    const gen = urlGen;
    const found = [];
    const ok = await urlTx("readonly", (store) => {
      for (const hash of hashes) {
        for (const kind of URL_KINDS) {
          const key = `${kind}:${hash}`;
          const req = store.get(key);
          req.onsuccess = () => {
            if (req.result) found.push([key, req.result]);
          };
        }
      }
    });
    if (!ok || gen !== urlGen) return;
    const c = loadUrlCache();
    let n = 0;
    for (const [key, stored] of found) {
      if (expired(stored) || urlDirty.has(key) || c[key] && c[key].t >= stored.t) continue;
      const entry = { ...stored };
      delete entry.m;
      c[key] = entry;
      n++;
    }
    if (n) dbg(`url index: ${n} entries from IndexedDB for ${hashes.length} thumbnails`);
  }
  __name(readUrls, "readUrls");
  async function flushUrlIndex() {
    if (!urlDirty.size) return;
    const batch = [...urlDirty];
    urlDirty.clear();
    const taken = Date.now();
    const ok = await urlTx("readwrite", (store) => {
      for (const [key, entry] of batch) {
        if (entry) store.put(entry.u === null ? { ...entry, m: 1 } : entry, key);
        else store.delete(key);
      }
    });
    if (ok) writeJSON(URLIDX_SYNC_KEY, taken);
  }
  __name(flushUrlIndex, "flushUrlIndex");
  function syncUrlIndex(c) {
    if (!CFG.urlCache) return;
    const since = Number(readJSON(URLIDX_SYNC_KEY, 0)) || 0;
    for (const [key, entry] of Object.entries(c)) if (entry.t >= since && !urlDirty.has(key)) urlDirty.set(key, entry);
    if (urlDirty.size) scheduleUrlFlush();
    setTimeout(sweepUrlIndex, 2e4);
  }
  __name(syncUrlIndex, "syncUrlIndex");
  function sweepUrlIndex() {
    if (!CFG.urlCache) return;
    const now = Date.now();
    let dropped = 0;
    const walk = /* @__PURE__ */ __name((req, drop, next) => {
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) {
          if (next) next();
          return;
        }
        if (!drop(cur.value)) {
          if (next) next();
          return;
        }
        cur.delete();
        dropped++;
        cur.continue();
      };
    }, "walk");
    urlTx("readwrite", (store) => {
      const byAge = store.index("t");
      const expiredMisses = /* @__PURE__ */ __name((req) => {
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) {
            oldOnes();
            return;
          }
          if (expired(cur.value)) {
            cur.delete();
            dropped++;
          }
          cur.continue();
        };
      }, "expiredMisses");
      const oldOnes = /* @__PURE__ */ __name(() => walk(byAge.openCursor(IDBKeyRange.upperBound(now - URLCACHE_TTL)), () => true, overCap), "oldOnes");
      const overCap = /* @__PURE__ */ __name(() => {
        const count = store.count();
        count.onsuccess = () => {
          let over = count.result - URLIDX_MAX;
          if (over > 0) walk(byAge.openCursor(), () => over-- > 0);
        };
      }, "overCap");
      expiredMisses(store.index("m").openCursor());
    }).then((ok) => {
      if (ok && dropped) dbg(`url index: ${dropped} old entries dropped`);
    });
  }
  __name(sweepUrlIndex, "sweepUrlIndex");
  async function urlIndexStats() {
    let entries = 0;
    let misses = 0;
    const ok = await urlTx("readonly", (store) => {
      const all = store.count();
      all.onsuccess = () => {
        entries = all.result;
      };
      const m = store.index("m").count();
      m.onsuccess = () => {
        misses = m.result;
      };
    });
    return ok ? { entries, misses, max: URLIDX_MAX } : null;
  }
  __name(urlIndexStats, "urlIndexStats");
  function clearUrlIndex(missesOnly) {
    urlGen++;
    urlAsked.clear();
    for (const [key, entry] of urlDirty) if (!missesOnly || entry && entry.u === null) urlDirty.delete(key);
    urlTx("readwrite", (store) => {
      if (!missesOnly) {
        store.clear();
        return;
      }
      const req = store.index("m").openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        cur.delete();
        cur.continue();
      };
    });
  }
  __name(clearUrlIndex, "clearUrlIndex");

  // src/urls/hosts.ts
  var HOSTS = {
    "rule34.xxx": {
      thumbsOnly: ["miami.rule34.xxx", "ny.rule34.xxx"],
      fallback: "https://wimg.rule34.xxx/images",
      // Video mirrors, fastest first. wimg answers 403 for video files. Order
      // measured from the phone's network (time to first byte / 1 MB):
      // api-cdn 0.4 s / 0.3 s, nymp4 0.9 / 1.7, api-cdn-us-mp4 1.0 / 1.8,
      // ahri2mp4 1.3 / 2.2, ws-cdn-video 1.5 / 2.7, api-cdn-mp4 1.9 / 2.9.
      videoHosts: [
        "https://api-cdn.rule34.xxx/images",
        "https://nymp4.rule34.xxx/images",
        "https://api-cdn-us-mp4.rule34.xxx/images",
        "https://ahri2mp4.rule34.xxx/images",
        "https://ws-cdn-video.rule34.xxx/images",
        "https://api-cdn-mp4.rule34.xxx/images"
      ]
    }
  };
  var HOST_CFG = HOSTS[SITE] || {};
  var HOST_KEY = `IBH_IMGBASE_${SITE}`;
  var HOST_TTL = 7 * 24 * 60 * 60 * 1e3;
  function imageBase() {
    const cached = readJSON(HOST_KEY, null);
    if (cached && Date.now() < cached.exp) {
      STATE.imageBase = cached.base;
      STATE.baseCached = true;
      return cached.base;
    }
    let base = null;
    const thumb = document.querySelector('img[src*="/thumbnails/"]');
    if (thumb) {
      try {
        const u = new URL(thumb.src);
        if ((HOST_CFG.thumbsOnly || []).includes(u.host)) {
          dbg(`${u.host} only serves thumbnails, skipping`);
        } else {
          base = `${u.protocol}//${u.host}/images`;
          dbg(`host detected on page: ${base}`);
        }
      } catch (e) {
        warn(`invalid thumbnail src: ${describeError(e)}`);
      }
    }
    if (!base && HOST_CFG.fallback) {
      base = HOST_CFG.fallback;
      dbg(`using fallback host: ${base}`);
    }
    STATE.baseCached = false;
    STATE.imageBase = base;
    if (base) writeJSON(HOST_KEY, { base, exp: Date.now() + HOST_TTL });
    touch();
    return base;
  }
  __name(imageBase, "imageBase");
  function clearHostCache() {
    try {
      localStorage.removeItem(HOST_KEY);
    } catch (e) {
    }
    clearUrlCache(false);
    STATE.imageBase = null;
    info("host cache cleared");
    imageBase();
  }
  __name(clearHostCache, "clearHostCache");
  function thumbParts(thumbUrl) {
    if (!thumbUrl) return null;
    const m = thumbUrl.replace(/\?.*$/, "").match(/\/(?:thumbnails|samples)\/(.+)\/(?:thumbnail|sample)_([^/]+)\.(?:jpe?g|png)$/i);
    return m ? { dir: m[1].replace(/^\/+|\/+$/g, ""), hash: m[2] } : null;
  }
  __name(thumbParts, "thumbParts");
  function fileCandidates(thumbUrl, exts) {
    const p = thumbParts(thumbUrl);
    if (!p) return [];
    const bases = [];
    const wantsVideo = exts.some((e) => e === "mp4" || e === "webm");
    if (wantsVideo) bases.push(...HOST_CFG.videoHosts || []);
    const resolved = imageBase();
    if (resolved) bases.push(resolved);
    try {
      bases.push(`${new URL(thumbUrl).origin}/images`);
    } catch (e) {
    }
    const out = [];
    for (const base of [...new Set(bases)]) {
      for (const ext of exts) out.push(`${base}/${p.dir}/${p.hash}.${ext}`);
    }
    return out;
  }
  __name(fileCandidates, "fileCandidates");

  // src/video/limits.ts
  var MB_PER_S = 489600;
  var pastDecoder = /* @__PURE__ */ __name((w, h, fps) => Math.max(w, h) > 1920 || Math.min(w, h) > 1088 || !!fps && Math.ceil(w / 16) * Math.ceil(h / 16) * Math.round(fps) > MB_PER_S, "pastDecoder");

  // src/post/app.js
  var APP = "com.example.qtmediaplayer";
  async function sendToApp(mode) {
    const playing = modal.fileUrl || modal.video.currentSrc;
    if (!playing) {
      flash(t("dlWait"));
      return;
    }
    const title = `${SITE.split(".")[0]} ${postId(modal.link)}`;
    if (mode !== "play" && await appDownload(playing, mode === "reduce", title)) return;
    const u = new URL(portableUrl(playing));
    const ms = Math.round((modal.video.currentTime || 0) * 1e3);
    if (mode === "play") modal.video.pause();
    const extras = [
      `S.${APP}.extra.MODE=${mode}`,
      `S.android.intent.extra.TITLE=${encodeURIComponent(title)}`,
      `l.position=${ms}`
    ];
    info(`external player: post ${postId(modal.link)} sent to QtMediaPlayer to ${mode}${mode === "play" ? ` at ${mmss(ms / 1e3)}` : ""}`);
    el("a", { href: `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.slice(0, -1)};type=video/*;package=${APP};${extras.join(";")};end` }).click();
  }
  __name(sendToApp, "sendToApp");
  var APP_SERVER = "http://127.0.0.1:8745";
  var APP_TIMEOUT_MS = 1500;
  var APP_POLL_MS = 2e3;
  var APP_POLL_MISSES = 30;
  var appToken = /* @__PURE__ */ __name(() => GM_STORE ? String(GM_getValue("appToken", "") || "") : "", "appToken");
  function setAppToken(value) {
    if (GM_STORE) GM_setValue("appToken", String(value).trim());
  }
  __name(setAppToken, "setAppToken");
  function appCall(method, route, body) {
    return new Promise((resolve) => {
      const down = /* @__PURE__ */ __name(() => resolve({ ok: false, status: 0, json: null, stage: "app", error: "not answering" }), "down");
      if (!GM_XHR) {
        down();
        return;
      }
      GM_xmlhttpRequest({
        method,
        url: `${APP_SERVER}/${route}`,
        timeout: APP_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${appToken()}`, ...body ? { "Content-Type": "application/json" } : {} },
        data: body ? JSON.stringify(body) : void 0,
        onload: /* @__PURE__ */ __name((res) => {
          let json = null;
          try {
            json = JSON.parse(res.responseText);
          } catch (e) {
          }
          if (res.status === 401) resolve({ ok: false, status: 401, json, stage: "token", error: "wrong token" });
          else if (res.status >= 200 && res.status < 300 && json && json.ok) resolve({ ok: true, status: res.status, json });
          else resolve({ ok: false, status: res.status, json, stage: "app", error: json && json.error || `HTTP ${res.status}` });
        }, "onload"),
        onerror: down,
        ontimeout: down
      });
    });
  }
  __name(appCall, "appCall");
  var appStatusRow = null;
  function appControls() {
    const field = el("input", { class: "apptoken", type: "password", autocomplete: "off", placeholder: t(GM_STORE ? "appToken" : "appNoStore") });
    field.disabled = !GM_STORE;
    field.value = appToken();
    field.addEventListener("change", () => {
      setAppToken(field.value);
      refreshAppStatus();
    });
    appStatusRow = el("div", { class: "lbl appstatus", text: "…" });
    refreshAppStatus();
    return el("div", { class: "lang" }, [el("div", { class: "lbl", text: t("appToken") }), field, appStatusRow]);
  }
  __name(appControls, "appControls");
  async function refreshAppStatus() {
    const row = appStatusRow;
    if (!row || !CFG.appBridge) return;
    if (!GM_STORE) {
      row.textContent = t("appNoStore");
      return;
    }
    const r = await appCall("GET", "v1/status");
    const status = (
      /** @type {AppStatus} */
      r.ok ? r.json : null
    );
    row.textContent = status ? `${t("appOk")} · ${status.version}` : t(r.stage === "token" ? "appBadToken" : "appDown");
    if (status) dbg(`app server: ${status.app} ${status.version}, api ${status.api}`);
    else if (!r.ok) info(`app server: ${r.stage} ${r.error}`);
  }
  __name(refreshAppStatus, "refreshAppStatus");
  async function appDownload(fileUrl, reduce, title) {
    if (!CFG.appBridge || !appToken()) return false;
    const post = postId(modal.link);
    const body = { url: fileUrl, referer: `${location.origin}/`, title, reduce };
    const r = await appCall("POST", "v1/download", body);
    if (!r.ok) {
      info(`app server: ${r.stage} ${r.error}; post ${post} goes by the intent link`);
      return false;
    }
    const queued = (
      /** @type {AppDownloadQueued} */
      r.json
    );
    info(`app server: post ${post} queued as download ${queued.id}${reduce ? ", to convert" : ""}`);
    flash(t(reduce ? "appReduceQueued" : "appQueued"));
    followAppDownload(queued.id, post);
    return true;
  }
  __name(appDownload, "appDownload");
  function followAppDownload(id, post) {
    let misses = 0;
    let said = "";
    const say = /* @__PURE__ */ __name((key, line) => {
      if (said === key) return;
      said = key;
      flash(t(key));
      info(`app server: post ${post} ${line}`);
    }, "say");
    const tick = /* @__PURE__ */ __name(async () => {
      const r = await appCall("GET", `v1/download/${id}`);
      if (!r.ok) {
        if (r.status === 404 || ++misses > APP_POLL_MISSES) {
          info(`app server: lost download ${id} of post ${post} (${r.error})`);
          return;
        }
        setTimeout(tick, APP_POLL_MS);
        return;
      }
      misses = 0;
      const s = (
        /** @type {AppDownloadState} */
        r.json
      );
      if (s.status === "failed" || s.status === "cancelled") {
        say("appFailed", `download ${s.status}${s.error ? ` — ${s.error}` : ""}`);
        return;
      }
      if (s.status !== "done") {
        setTimeout(tick, APP_POLL_MS);
        return;
      }
      const c = s.reduce;
      if (!c) {
        say("appSaved", `saved as ${s.file}`);
        return;
      }
      if (c.status === "fits") {
        say("appFits", `saved as ${s.file}, within the decoder`);
        return;
      }
      if (c.status === "done") {
        say("appConverted", "converted to 1080p");
        return;
      }
      if (c.status === "failed" || c.status === "cancelled") {
        say("appFailed", `conversion ${c.status}`);
        return;
      }
      if (c.status === "running") say("appConverting", "converting");
      setTimeout(tick, APP_POLL_MS);
    }, "tick");
    setTimeout(tick, APP_POLL_MS);
  }
  __name(followAppDownload, "followAppDownload");

  // src/search/site-search.js
  var RECENT_MAX = 15;
  async function searchStore() {
    const v = await storeGet("searches");
    const ok = v && typeof v === "object" && !Array.isArray(v);
    return { saved: ok && v.saved || [], recent: ok && v.recent || [], favLast: ok && v.favLast || null };
  }
  __name(searchStore, "searchStore");
  var emptySearch = /* @__PURE__ */ __name((q) => !q.text.trim() && !orGroups(q.or).length && q.kind === "all" && !q.min && q.sort === "new", "emptySearch");
  function addRecent(store, q) {
    if (emptySearch(q)) return;
    const key = searchKey(q);
    store.recent = [q, ...store.recent.filter((other) => searchKey(other) !== key)];
    const mine = store.recent.filter((other) => other.where === q.where);
    if (mine.length > RECENT_MAX) store.recent = store.recent.filter((other) => !mine.slice(RECENT_MAX).includes(other));
  }
  __name(addRecent, "addRecent");
  var searchKey = /* @__PURE__ */ __name((q) => [q.where, q.text.trim().replace(/\s+/g, " "), orGroups(q.or).map((g) => g.join(" ")).join(" || "), q.kind, q.sort, String(q.min || "")].join("|"), "searchKey");
  function searchLabel(q) {
    const kinds = { image: t("favKindImage"), video: t("favKindVideo"), gif: t("favKindGif"), animated: t("favKindAnimated") };
    const orders = { score: t("favSortScore"), random: t("favSortRandom"), old: t("favSortOld") };
    const or = orGroups(q.or);
    return [q.text.trim() || (or.length ? "" : t("savedAll")), or.map((g) => `( ${g.join(" | ")} )`).join(" "), kinds[q.kind], q.min ? `≥ ${q.min}` : "", orders[q.sort] || ""].filter(Boolean).join(" · ");
  }
  __name(searchLabel, "searchLabel");
  function savedControls(where, read, apply) {
    const pick = el("select", { class: "saved" });
    const recentPick = el("select", { class: "saved" });
    const star = el("button", { type: "button", class: "star" });
    let saved = [];
    let recent = [];
    const sync = /* @__PURE__ */ __name(() => {
      const on = saved.some((q) => searchKey(q) === searchKey(read()));
      star.textContent = t(on ? "savedSearch" : "saveSearch");
      star.classList.toggle("on", on);
    }, "sync");
    const fillOne = /* @__PURE__ */ __name((select, list, title) => {
      const mine = list.filter((q) => q.where === where);
      select.replaceChildren(el("option", { value: "", text: t(title) }), ...mine.map((q, i) => el("option", { value: String(i), text: searchLabel(q) })));
      select.hidden = !mine.length;
    }, "fillOne");
    const fill = /* @__PURE__ */ __name(() => {
      fillOne(pick, saved, "savedPick");
      fillOne(recentPick, recent, "recentPick");
      sync();
    }, "fill");
    const reload = /* @__PURE__ */ __name(async () => {
      const store = await searchStore();
      saved = store.saved;
      recent = store.recent;
      fill();
    }, "reload");
    const onPick = /* @__PURE__ */ __name((select, source) => select.addEventListener("change", () => {
      const q = source().filter((other) => other.where === where)[Number(select.value)];
      select.value = "";
      if (q) apply(q);
    }), "onPick");
    onPick(pick, () => saved);
    onPick(recentPick, () => recent);
    star.addEventListener("click", async () => {
      const store = await searchStore();
      const q = read();
      const i = store.saved.findIndex((other) => searchKey(other) === searchKey(q));
      if (i >= 0) store.saved.splice(i, 1);
      else store.saved.unshift(q);
      await storeSet("searches", store);
      info(`search ${i >= 0 ? "removed from" : "saved in"} the ${where} list: ${searchLabel(q)}`);
      saved = store.saved;
      fill();
    });
    reload();
    return { pick, recentPick, star, sync, reload };
  }
  __name(savedControls, "savedControls");
  async function recordSiteSearch(q) {
    if (emptySearch(q)) return;
    const store = await searchStore();
    addRecent(store, q);
    await storeSet("searches", store);
  }
  __name(recordSiteSearch, "recordSiteSearch");
  var KIND_QUERY = {
    image: "-animated -video -gif",
    video: "video",
    gif: "( gif ~ animated_gif )",
    animated: "( animated ~ video ~ gif )"
  };
  function readSiteQuery(tags) {
    let rest = ` ${tags.trim().replace(/\s+/g, " ")} `;
    let kind = "all";
    for (const [k, q] of Object.entries(KIND_QUERY)) {
      if (rest.includes(` ${q} `)) {
        kind = k;
        rest = rest.replace(` ${q} `, " ");
        break;
      }
    }
    const groups = [];
    rest = rest.replace(/ \( ([^()]+?) \)(?= )/g, (m, inner) => {
      if (!/ ~ /.test(` ${inner} `)) return m;
      groups.push(orTags(inner).join(" "));
      return "";
    });
    const or = groups.join(" || ");
    let sort = "new";
    rest = rest.replace(/ sort:score(?::desc)? /i, () => {
      sort = "score";
      return " ";
    });
    rest = rest.replace(/ sort:random /i, () => {
      sort = "random";
      return " ";
    });
    let min = "";
    rest = rest.replace(/ score:>=?(\d+) /i, (m, n) => {
      min = n;
      return " ";
    });
    return { rest: rest.trim(), kind, sort, min, or };
  }
  __name(readSiteQuery, "readSiteQuery");
  function siteQuery({ rest, kind, sort, min, or }) {
    const either = orGroups(or).map((g) => g.length > 1 ? `( ${g.join(" ~ ")} )` : g[0]).join(" ");
    return [rest, either, KIND_QUERY[kind] || "", min ? `score:>=${min}` : "", sort === "score" ? "sort:score" : sort === "random" ? "sort:random" : ""].filter(Boolean).join(" ");
  }
  __name(siteQuery, "siteQuery");
  var homeSearchForm = /* @__PURE__ */ __name(() => {
    if (new URLSearchParams(location.search).get("page")) return null;
    const field = document.querySelector('form input[name="tags"]');
    return field ? field.closest("form") : null;
  }, "homeSearchForm");
  function ensureSiteSearch() {
    const bar = document.getElementById("ibh-sitesearch");
    const home = homeSearchForm();
    const listing = new URLSearchParams(location.search).get("page") === "post" && !!document.querySelector(LIST);
    const want = CFG.siteSearch && !onFavoritesPage() && (listing || !!home);
    if (!want) {
      if (bar) bar.remove();
      if (home) home.style.display = "";
      return;
    }
    if (bar) return;
    const now = readSiteQuery(new URLSearchParams(location.search).get("tags") || "");
    const input = el("input", { type: "search", placeholder: t("sitePlaceholder"), enterkeyhint: "search" });
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocomplete", "off");
    attachSuggest(input);
    input.value = now.rest === "all" ? "" : now.rest;
    const or = orInput();
    or.value = now.or;
    const kind = kindSelect();
    kind.value = now.kind;
    const sort = el("select", { class: "sort" });
    for (const [value, label] of [["new", t("favSortNew")], ["score", t("favSortScore")], ["random", t("favSortRandom")]]) sort.appendChild(el("option", { value, text: label }));
    sort.value = now.sort;
    const min = minScoreInput();
    min.value = now.min;
    const go = el("button", { type: "button", text: t("favGo") });
    const read = /* @__PURE__ */ __name(() => ({ where: "site", text: input.value, or: or.value, kind: kind.value, sort: sort.value, min: min.value }), "read");
    const saved = savedControls("site", read, (q) => {
      input.value = q.text;
      or.value = q.or || "";
      kind.value = q.kind;
      sort.value = q.sort;
      min.value = q.min || "";
      submit();
    });
    const box = el("div", { id: "ibh-sitesearch", class: "ibh-search" }, [input, or, kind, sort, min, go, saved.star, saved.pick, saved.recentPick]);
    if (home) {
      home.before(box);
      home.style.display = "none";
    } else {
      const list = (
        /** @type {Element} */
        document.querySelector(LIST)
      );
      list.before(box);
    }
    recordSiteSearch(read()).then(saved.reload);
    input.addEventListener("input", saved.sync);
    or.addEventListener("input", saved.sync);
    min.addEventListener("input", saved.sync);
    const submit = /* @__PURE__ */ __name(() => {
      const q = siteQuery({ rest: input.value, or: or.value, kind: kind.value, sort: sort.value, min: min.value });
      info(`site search: ${q || "all"}`);
      location.href = `index.php?page=post&s=list&tags=${encodeURIComponent(q || "all").replace(/%20/g, "+")}`;
    }, "submit");
    for (const field of [input, or, min]) field.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submit();
      }
    });
    go.addEventListener("click", submit);
    kind.addEventListener("change", saved.sync);
    sort.addEventListener("change", saved.sync);
    dbg("site search bar added");
  }
  __name(ensureSiteSearch, "ensureSiteSearch");

  // src/video/mp4.ts
  function* mp4Boxes(b, start, end) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      let head = 8;
      if (size === 1) {
        size = Number(dv.getBigUint64(p + 8));
        head = 16;
      } else if (size === 0) size = end - p;
      if (size < head) return;
      yield { type: String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]), start: p, body: p + head, end: p + size };
      p += size;
    }
  }
  __name(mp4Boxes, "mp4Boxes");
  var mp4Child = /* @__PURE__ */ __name((b, box, type) => {
    for (const c of mp4Boxes(b, box.body, box.end)) if (c.type === type) return c;
    return null;
  }, "mp4Child");
  function mp4VideoTrack(b, moov) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const u32 = /* @__PURE__ */ __name((p) => dv.getUint32(p), "u32");
    const u64 = /* @__PURE__ */ __name((p) => Number(dv.getBigUint64(p)), "u64");
    for (const trak of mp4Boxes(b, moov.body, moov.end)) {
      if (trak.type !== "trak") continue;
      const mdia = mp4Child(b, trak, "mdia");
      const hdlr = mdia && mp4Child(b, mdia, "hdlr");
      if (!hdlr || String.fromCharCode(...b.subarray(hdlr.body + 8, hdlr.body + 12)) !== "vide") continue;
      const tkhd = mp4Child(b, trak, "tkhd");
      const mdhd = mp4Child(b, mdia, "mdhd");
      const minf = mp4Child(b, mdia, "minf");
      const stbl = minf && mp4Child(b, minf, "stbl");
      if (!tkhd || !mdhd || !stbl) return null;
      const [stsd, stts, stss, stsz, stsc, stco, co64] = ["stsd", "stts", "stss", "stsz", "stsc", "stco", "co64"].map((t2) => mp4Child(b, stbl, t2));
      const offsets = stco || co64;
      if (!stsd || !stts || !stsz || !stsc || !offsets) return null;
      const runs = [];
      for (let i = 0, n = u32(stts.body + 4); i < n; i++) runs.push([u32(stts.body + 8 + i * 8), u32(stts.body + 12 + i * 8)]);
      const sync = [];
      if (stss) for (let i = 0, n = u32(stss.body + 4); i < n; i++) sync.push(u32(stss.body + 8 + i * 4) - 1);
      const fixed = u32(stsz.body + 4);
      const count = u32(stsz.body + 8);
      const size = /* @__PURE__ */ __name((k) => fixed || u32(stsz.body + 12 + k * 4), "size");
      const chunks = u32(offsets.body + 4);
      const chunkAt = /* @__PURE__ */ __name((c) => stco ? u32(stco.body + 8 + c * 4) : u64(co64.body + 8 + c * 8), "chunkAt");
      const perChunk = [];
      for (let i = 0, n = u32(stsc.body + 4); i < n; i++) perChunk.push([u32(stsc.body + 8 + i * 12) - 1, u32(stsc.body + 12 + i * 12)]);
      const v1 = b[mdhd.body] === 1;
      const tv1 = b[tkhd.body] === 1;
      return {
        timescale: u32(mdhd.body + (v1 ? 20 : 12)),
        duration: v1 ? u64(mdhd.body + 24) : u32(mdhd.body + 16),
        width: u32(tkhd.body + (tv1 ? 88 : 76)) >>> 16,
        height: u32(tkhd.body + (tv1 ? 92 : 80)) >>> 16,
        // Frames over seconds, from the sample table: exact, no decoding.
        samples: runs.reduce((sum, [count2]) => sum + count2, 0),
        stsd: b.slice(stsd.start, stsd.end),
        // The sample showing at time t (timescale units).
        sampleAt(t2) {
          let k = 0;
          let at = 0;
          for (const [n, delta] of runs) {
            if (t2 < at + n * delta) return k + Math.floor((t2 - at) / delta);
            k += n;
            at += n * delta;
          }
          return Math.max(0, count - 1);
        },
        timeOf(k) {
          let at = 0;
          for (const [n, delta] of runs) {
            if (k < n) return at + k * delta;
            k -= n;
            at += n * delta;
          }
          return at;
        },
        keyAtOrBefore(k) {
          if (!sync.length) return k;
          let lo = 0;
          let hi = sync.length - 1;
          let best = sync[0];
          while (lo <= hi) {
            const mid = lo + hi >> 1;
            if (sync[mid] <= k) {
              best = sync[mid];
              lo = mid + 1;
            } else hi = mid - 1;
          }
          return best;
        },
        // [offset, size] of sample k in the file: its chunk, plus the samples before it in there.
        place(k) {
          let first = 0;
          for (let i = 0; i < perChunk.length; i++) {
            const [chunk0, per] = perChunk[i];
            const inRun = ((i + 1 < perChunk.length ? perChunk[i + 1][0] : chunks) - chunk0) * per;
            if (k < first + inRun) {
              const c = chunk0 + Math.floor((k - first) / per);
              let off = chunkAt(c);
              for (let j = first + (c - chunk0) * per; j < k; j++) off += size(j);
              return [off, size(k)];
            }
            first += inRun;
          }
          return null;
        }
      };
    }
    return null;
  }
  __name(mp4VideoTrack, "mp4VideoTrack");
  function avcConfig(stsd) {
    for (const entry of mp4Boxes(stsd, 16, stsd.length)) {
      if (entry.type !== "avc1" && entry.type !== "avc3") return null;
      for (const c of mp4Boxes(stsd, entry.body + 78, entry.end)) if (c.type === "avcC") return stsd.slice(c.body, c.end);
    }
    return null;
  }
  __name(avcConfig, "avcConfig");

  // src/scrub/h264.js
  var h264 = null;
  var h264Loading = null;
  var h264Broken = "";
  function h264Decoder() {
    if (h264) return Promise.resolve(h264);
    if (!h264Loading) {
      h264Loading = (async () => {
        if (typeof GM_getResourceURL !== "function") throw new Error("no GM_getResourceURL grant");
        const t0 = performance.now();
        const bytes = await (await fetch(GM_getResourceURL("h264dec"))).arrayBuffer();
        const mod = await WebAssembly.compile(bytes);
        let mem = null;
        const view = /* @__PURE__ */ __name(() => new DataView(
          /** @type {WebAssembly.Memory} */
          mem.buffer
        ), "view");
        const calls = {
          fd_write: /* @__PURE__ */ __name((fd, iov, count, written) => {
            let n = 0;
            for (let i = 0; i < count; i++) n += view().getUint32(iov + i * 8 + 4, true);
            view().setUint32(written, n, true);
            return 0;
          }, "fd_write"),
          environ_sizes_get: /* @__PURE__ */ __name((count, size) => {
            view().setUint32(count, 0, true);
            view().setUint32(size, 0, true);
            return 0;
          }, "environ_sizes_get"),
          clock_time_get: /* @__PURE__ */ __name((id, precision, out) => {
            view().setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true);
            return 0;
          }, "clock_time_get"),
          random_get: /* @__PURE__ */ __name((buf, len) => {
            crypto.getRandomValues(new Uint8Array(
              /** @type {WebAssembly.Memory} */
              mem.buffer,
              buf,
              len
            ));
            return 0;
          }, "random_get"),
          proc_exit: /* @__PURE__ */ __name((code) => {
            throw new Error(`decoder exited (${code})`);
          }, "proc_exit")
        };
        const imports = {};
        for (const imp of WebAssembly.Module.imports(mod)) {
          (imports[imp.module] = imports[imp.module] || {})[imp.name] = calls[imp.name] || (() => 0);
        }
        const x = (
          /** @type {H264} */
          /** @type {unknown} */
          (await WebAssembly.instantiate(mod, imports)).exports
        );
        mem = x.memory;
        if (x._initialize) x._initialize();
        info(`keyframe decoder: WebAssembly ready (${Math.round(bytes.byteLength / 1024)} KB in ${Math.round(performance.now() - t0)} ms)`);
        h264 = x;
        return x;
      })();
      h264Loading.catch((e) => {
        h264Broken = describeError(e);
        warn(`keyframe decoder: ${h264Broken}; reels play in a <video>`);
      }).finally(() => {
        h264Loading = null;
      });
    }
    return h264Loading;
  }
  __name(h264Decoder, "h264Decoder");
  function dropH264() {
    if (h264) {
      try {
        h264.dec_close();
      } catch (e) {
      }
    }
    h264 = null;
  }
  __name(dropH264, "dropH264");
  function decodeKeyframe(x, bytes, maxW) {
    const ptr = x.buf_alloc(bytes.length);
    new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
    const r = x.dec_frame(ptr, bytes.length, maxW);
    x.buf_free(ptr);
    if (r !== 0) throw new Error(`keyframe decode failed (${r})`);
    const w = x.dec_width();
    const h = x.dec_height();
    const at = x.dec_rgba();
    return new ImageData(new Uint8ClampedArray(x.memory.buffer.slice(at, at + w * h * 4)), w, h);
  }
  __name(decodeKeyframe, "decodeKeyframe");

  // src/scrub/reel.js
  var REEL_HEAD = 256 * 1024;
  var REEL_MAX_MOOV = 8e6;
  var REEL_MAX_BYTES = 12e6;
  var REEL_KEEP = 4;
  var reels = /* @__PURE__ */ new Map();
  function rangeRead(url, start, end, reqs) {
    return new Promise((resolve, reject) => {
      let req = null;
      req = GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        timeout: 2e4,
        headers: { Range: `bytes=${start}-${end}`, Referer: `${location.origin}/` },
        // A host ignoring Range sends the whole file: stop at its headers.
        onreadystatechange: /* @__PURE__ */ __name((r) => {
          if (r.readyState >= 2 && r.status === 200 && req) {
            req.abort();
            reject(new Error("no Range support"));
          }
        }, "onreadystatechange"),
        onload: /* @__PURE__ */ __name((r) => {
          if (r.status !== 206) {
            reject(Object.assign(new Error(`HTTP ${r.status}`), { status: r.status }));
            return;
          }
          const m = (r.responseHeaders || "").match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i);
          resolve({ buf: new Uint8Array(r.response), total: m ? Number(m[1]) : null });
        }, "onload"),
        onerror: /* @__PURE__ */ __name(() => reject(new Error("network error")), "onerror"),
        ontimeout: /* @__PURE__ */ __name(() => reject(new Error("timeout")), "ontimeout"),
        onabort: /* @__PURE__ */ __name(() => reject(new Error("aborted")), "onabort")
      });
      if (req && reqs) reqs.add(req);
    });
  }
  __name(rangeRead, "rangeRead");
  function reelBlob(track, frames) {
    const n = frames.length;
    const ascii = /* @__PURE__ */ __name((str) => Uint8Array.from(str, (c) => c.charCodeAt(0)), "ascii");
    const words = /* @__PURE__ */ __name((...v) => {
      const out = new Uint8Array(v.length * 4);
      const dv = new DataView(out.buffer);
      v.forEach((x, i) => dv.setUint32(i * 4, x >>> 0));
      return out;
    }, "words");
    const box = /* @__PURE__ */ __name((type, ...parts) => {
      const out = new Uint8Array(8 + parts.reduce((sum, part) => sum + part.length, 0));
      new DataView(out.buffer).setUint32(0, out.length);
      out.set(ascii(type), 4);
      let at2 = 8;
      for (const part of parts) {
        out.set(part, at2);
        at2 += part.length;
      }
      return out;
    }, "box");
    const matrix = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
    const ms = n * 1e3;
    const ftyp = box("ftyp", ascii("isom"), words(512), ascii("isomiso2avc1mp41"));
    const moovWith = /* @__PURE__ */ __name((offsets2) => box(
      "moov",
      box("mvhd", words(0, 0, 0, 1e3, ms, 65536, 16777216, 0, 0, ...matrix, 0, 0, 0, 0, 0, 0, 2)),
      box(
        "trak",
        box("tkhd", words(3, 0, 0, 1, 0, ms, 0, 0, 0, 0, ...matrix, track.width * 65536, track.height * 65536)),
        box(
          "mdia",
          box("mdhd", words(0, 0, 0, 1e3, ms, 1438908416)),
          box("hdlr", words(0, 0), ascii("vide"), words(0, 0, 0), ascii("VideoHandler\0")),
          box(
            "minf",
            box("vmhd", words(1, 0, 0)),
            box("dinf", box("dref", words(0, 1), box("url ", words(1)))),
            box(
              "stbl",
              track.stsd,
              box("stts", words(0, 1, n, 1e3)),
              box("stsc", words(0, 1, 1, 1, 1)),
              box("stsz", words(0, 0, n, ...frames.map((f) => f.length))),
              box("stco", words(0, n, ...offsets2))
            )
          )
        )
      )
    ), "moovWith");
    let at = ftyp.length + moovWith(frames.map(() => 0)).length + 8;
    const offsets = frames.map((f) => {
      const o = at;
      at += f.length;
      return o;
    });
    const data = frames.reduce((sum, f) => sum + f.length, 0);
    return new Blob([ftyp, moovWith(offsets), words(8 + data), ascii("mdat"), ...frames], { type: "video/mp4" });
  }
  __name(reelBlob, "reelBlob");
  async function buildReel(url, steps, reqs) {
    const t0 = performance.now();
    const head = await rangeRead(url, 0, REEL_HEAD - 1, reqs);
    const total = head.total || head.buf.length;
    const boxAt = /* @__PURE__ */ __name(async (p2) => {
      let b = head.buf;
      let o = p2;
      if (p2 + 16 > b.length) {
        b = (await rangeRead(url, p2, Math.min(total, p2 + 16) - 1, reqs)).buf;
        o = 0;
      }
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      let size = dv.getUint32(o);
      if (size === 1) size = Number(dv.getBigUint64(o + 8));
      else if (size === 0) size = total - p2;
      return { type: String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), size };
    }, "boxAt");
    let p = 0;
    let moov = null;
    for (let i = 0; p < total && i < 32 && !moov; i++) {
      const box = await boxAt(p);
      if (box.size < 8) break;
      if (box.type === "moov") moov = { at: p, size: box.size };
      p += box.size;
    }
    if (!moov) throw new Error("no moov box");
    if (moov.size > REEL_MAX_MOOV) throw new Error(`index of ${Math.round(moov.size / 1e6)} MB`);
    let mb;
    if (moov.at + moov.size <= head.buf.length) mb = head.buf.subarray(moov.at, moov.at + moov.size);
    else if (moov.at < head.buf.length) {
      const rest = (await rangeRead(url, head.buf.length, moov.at + moov.size - 1, reqs)).buf;
      mb = new Uint8Array(moov.size);
      mb.set(head.buf.subarray(moov.at));
      mb.set(rest, head.buf.length - moov.at);
    } else mb = (await rangeRead(url, moov.at, moov.at + moov.size - 1, reqs)).buf;
    const track = mp4VideoTrack(mb, { body: new DataView(mb.buffer, mb.byteOffset).getUint32(0) === 1 ? 16 : 8, end: mb.length });
    if (!track) throw new Error("no video track");
    let keys = [];
    for (const f of steps) {
      const k = track.keyAtOrBefore(track.sampleAt(Math.floor(f * track.duration)));
      if (!keys.includes(k)) keys.push(k);
    }
    const need = Math.min(steps.length, 3);
    if (keys.length < need && !pastDecoder(track.width, track.height, track.duration ? track.samples * track.timescale / track.duration : 0)) {
      throw Object.assign(new Error(`only ${keys.length} keyframes for ${steps.length} scenes`), { sparse: true, duration: track.duration / track.timescale });
    }
    let places = keys.map((k) => track.place(k));
    if (places.some((pl) => !pl)) throw new Error("a keyframe outside the chunk table");
    while (keys.length > 2 && places.reduce((sum, pl) => sum + /** @type {[number, number]} */
    pl[1], 0) > REEL_MAX_BYTES) {
      keys = keys.filter((k, i) => i % 2 === 0);
      places = places.filter((pl, i) => i % 2 === 0);
    }
    const frames = await Promise.all(
      /** @type {Array<[number, number]>} */
      places.map(([off, size]) => rangeRead(url, off, off + size - 1, reqs).then((r) => r.buf))
    );
    const secs = track.duration / track.timescale;
    return {
      frames,
      track: { stsd: track.stsd, width: track.width, height: track.height },
      avcC: avcConfig(track.stsd),
      url: null,
      // the <video> reel's blob, made when first played (reelUrl)
      scenes: keys.map((k) => {
        const t2 = track.timeOf(k) / track.timescale;
        return { t: t2, f: secs ? t2 / secs : 0 };
      }),
      bytes: mb.length + frames.reduce((sum, f) => sum + f.length, 0),
      ms: Math.round(performance.now() - t0),
      width: track.width,
      height: track.height,
      duration: secs,
      fps: secs ? track.samples / secs : 0
    };
  }
  __name(buildReel, "buildReel");
  async function reelFor(urls, steps, reqs, hash) {
    for (const url of urls) {
      const key = `${url}|${steps.length}`;
      const kept = reels.get(key);
      if (kept) {
        reels.delete(key);
        reels.set(key, kept);
        return { ...kept, ms: 0, kept: true };
      }
      try {
        const reel = await buildReel(url, steps, reqs);
        if (hash) cacheSet("video", hash, url);
        reels.set(key, reel);
        for (const [old, r] of reels) {
          if (reels.size <= REEL_KEEP) break;
          if (r.url) URL.revokeObjectURL(r.url);
          reels.delete(old);
        }
        return reel;
      } catch (e) {
        if (!/** @type {{ status?: number }} */
        e.status || urls.indexOf(url) === urls.length - 1) throw e;
      }
    }
    throw new Error("no host has the file");
  }
  __name(reelFor, "reelFor");
  function startReelShow(s) {
    if (typeof GM_xmlhttpRequest !== "function") return false;
    const pic = cardPicture(s.card);
    if (!pic) return false;
    const hash = (thumbParts(pic.src) || {}).hash;
    const cover = s.card.querySelector("video[data-ibh]");
    const known = cover && cover.currentSrc || hash && cacheGet("video", hash);
    if (known && !/\.mp4(?:[?#]|$)/i.test(known)) return false;
    const urls = known ? [known] : fileCandidates(pic.src, ["mp4"]);
    if (!urls.length) return false;
    freeForPreview(s.card);
    scrubUi(s);
    s.label.textContent = "…";
    s.dwell = (Number(CFG.slideDwell) || 0.2) * 1e3;
    s.stats.method = "reel";
    s.reel = { reqs: /* @__PURE__ */ new Set(), timer: 0, video: null, holder: null, borrowed: false };
    if (CFG.wasmDecode && !h264Broken) h264Decoder().catch(() => {
    });
    reelFor(urls, slideSteps(), s.reel.reqs, known ? null : hash).then(
      (reel) => {
        if (scrub === s) showReel(s, reel);
      },
      (e) => {
        if (scrub === s) reelFailed(s, e);
      }
    );
    return true;
  }
  __name(startReelShow, "startReelShow");
  var reelUrl = /* @__PURE__ */ __name((reel) => reel.url || (reel.url = URL.createObjectURL(reelBlob(reel.track, reel.frames))), "reelUrl");
  function showReel(s, reel) {
    s.reel.info = reel;
    markDuration(s.card, reel.duration);
    if (pastDecoder(reel.width, reel.height, reel.fps)) markPastDecoder(s.card, `${reel.width}x${reel.height} at ${Math.round(reel.fps)} fps`);
    s.stats.detail = `${reel.width}x${reel.height}, ${mmss(reel.duration)}, ${reel.scenes.length} keyframes, ${Math.round(reel.bytes / 1024)} KB, ${reel.kept ? "kept from before" : `read in ${reel.ms} ms`}`;
    if (CFG.wasmDecode && reel.avcC && !h264Broken) showReelWasm(
      s,
      /** @type {H264Reel} */
      reel
    ).catch((e) => {
      if (scrub === s) wasmFailed(s, reel, e);
    });
    else showReelVideo(s, reel);
  }
  __name(showReel, "showReel");
  function showReelVideo(s, reel) {
    const r = (
      /** @type {ReelShow} */
      s.reel
    );
    borrowDecoder(s.card);
    r.borrowed = true;
    r.holder = document.createElement("div");
    r.holder.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2";
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:4px;background:#000";
    r.video = v;
    r.holder.appendChild(v);
    placeOverPicture(s.card, r.holder);
    let i = 0;
    const show = /* @__PURE__ */ __name(() => {
      if (scrub === s) v.currentTime = i + 0.5;
    }, "show");
    v.addEventListener("seeked", () => {
      if (scrub !== s) return;
      const scene = reel.scenes[i];
      s.bar.style.width = `${scene.f * 100}%`;
      s.label.textContent = `${mmss(scene.t)} / ${mmss(reel.duration)}`;
      noteScene(s);
      i = (i + 1) % reel.scenes.length;
      r.timer = setTimeout(show, s.dwell);
    });
    v.addEventListener("loadedmetadata", show, { once: true });
    v.onerror = () => {
      if (scrub === s) reelFailed(s, new Error("the reel would not play"));
    };
    v.src = reelUrl(reel);
  }
  __name(showReelVideo, "showReelVideo");
  var h264Stream = null;
  function openStream(x, reel) {
    if (h264Stream === reel) return;
    h264Stream = null;
    const cfg = x.buf_alloc(reel.avcC.length);
    new Uint8Array(x.memory.buffer, cfg, reel.avcC.length).set(reel.avcC);
    const opened = x.dec_open(cfg, reel.avcC.length);
    x.buf_free(cfg);
    if (opened !== 0) throw new Error(`the decoder refused the stream (${opened})`);
    h264Stream = reel;
  }
  __name(openStream, "openStream");
  async function showReelWasm(s, reel) {
    const x = await h264Decoder();
    if (scrub !== s) return;
    openStream(x, reel);
    s.stats.method = "wasm reel";
    const r = (
      /** @type {ReelShow} */
      s.reel
    );
    const maxW = Math.round(s.card.getBoundingClientRect().width * (window.devicePixelRatio || 1));
    const times = [];
    const decode = /* @__PURE__ */ __name((i2) => {
      const t0 = performance.now();
      const img = decodeKeyframe(x, reel.frames[i2], maxW);
      times.push(performance.now() - t0);
      s.stats.wasm = `decoded in ${Math.round(times.reduce((a, b) => a + b, 0) / times.length)} ms (max ${Math.round(Math.max(...times))}) to ${img.width}x${img.height}`;
      return img;
    }, "decode");
    let next = decode(0);
    r.holder = document.createElement("div");
    r.holder.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2";
    const cv = document.createElement("canvas");
    cv.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:4px;background:#000";
    r.holder.appendChild(cv);
    placeOverPicture(s.card, r.holder);
    const ctx = (
      /** @type {CanvasRenderingContext2D} */
      cv.getContext("2d")
    );
    let i = 0;
    const show = /* @__PURE__ */ __name(() => {
      if (scrub !== s) return;
      if (cv.width !== next.width || cv.height !== next.height) {
        cv.width = next.width;
        cv.height = next.height;
      }
      ctx.putImageData(next, 0, 0);
      const scene = reel.scenes[i];
      s.bar.style.width = `${scene.f * 100}%`;
      s.label.textContent = `${mmss(scene.t)} / ${mmss(reel.duration)}`;
      noteScene(s);
      i = (i + 1) % reel.scenes.length;
      const t0 = performance.now();
      try {
        next = decode(i);
      } catch (e) {
        wasmFailed(s, reel, e);
        return;
      }
      r.timer = setTimeout(show, Math.max(0, s.dwell - (performance.now() - t0)));
    }, "show");
    show();
  }
  __name(showReelWasm, "showReelWasm");
  function wasmFailed(s, reel, e) {
    const r = s.reel;
    if (!r) return;
    s.stats.wasm = `not decoded: ${describeError(e)}`;
    clearTimeout(r.timer);
    if (r.holder) {
      r.holder.remove();
      r.holder = null;
    }
    s.stats.method = "reel";
    showReelVideo(s, reel);
  }
  __name(wasmFailed, "wasmFailed");
  function endReel(s) {
    const r = s.reel;
    if (!r) return;
    s.reel = null;
    clearTimeout(r.timer);
    for (const req of r.reqs) {
      try {
        req.abort();
      } catch (e) {
      }
    }
    if (r.video) {
      r.video.onerror = null;
      r.video.removeAttribute("src");
      r.video.load();
    }
    if (r.holder) r.holder.remove();
    if (r.borrowed) returnDecoder();
  }
  __name(endReel, "endReel");
  function reelFailed(s, e) {
    s.stats.reelError = e.message;
    endReel(s);
    if (!scrubSource(s)) {
      endScrub();
      return;
    }
    if (e.sparse && /** @type {number} */
    e.duration <= PLAY_MAX_S) playShow(s);
    else chooseShow(s);
  }
  __name(reelFailed, "reelFailed");

  // src/modal/open.js
  function openModal(link) {
    const thumb = link.querySelector("img");
    const pic = thumb && cardPicture(link);
    if (!pic || !thumbParts(pic.src)) {
      location.href = link.href;
      return;
    }
    if (!modal) buildModal();
    resetMedia();
    const seq = modal.seq;
    if (!modal.open) modal.dir = 1;
    const ready = aheadReady(link);
    modal.link = link;
    modal.post.href = link.href;
    modal.box.classList.remove("later-mode");
    applyMarks(link, seq);
    modal.tabComments.textContent = t("tabComments");
    if (!modal.sheet.hidden) renderSheet(link, seq);
    modal.score.textContent = "";
    const list = modalLinks();
    modal.count.textContent = `${list.indexOf(link) + 1} / ${list.length}`;
    modal.status.textContent = t("mLoading");
    modal.status.hidden = false;
    let kind = thumbKind(thumb);
    const hash = (
      /** @type {{ hash: string }} */
      thumbParts(pic.src).hash
    );
    const placeholder = ready || thumb.currentSrc || pic.src;
    const asGif = /* @__PURE__ */ __name(() => {
      link.dataset.ibhKind = "gif";
      info(`modal: post ${postId(link)} has no video file, showing it as a GIF`);
      showImage(placeholder, fileCandidates(pic.src, ["gif"]), "gif", hash);
    }, "asGif");
    if (kind === "video" && cacheGet("video", hash) === null) kind = "gif";
    if (kind === "video" && ambiguousAnimated(link)) {
      raceVideoAndGif(link, thumb, pic, hash, asGif);
    } else if (kind === "video") {
      showVideo(fileCandidates(pic.src, ["mp4", "webm"]), hash, asGif);
    } else if (kind === "gif") {
      showImage(placeholder, fileCandidates(pic.src, ["gif"]), "gif", hash);
    } else {
      if (CFG.modalOriginal === "always") showImage(placeholder, fileCandidates(pic.src, ORIGINAL_EXTS), "orig", hash);
      else showImage(placeholder, [sampleCandidates(pic.src), fileCandidates(pic.src, ORIGINAL_EXTS)], "sample", hash);
      sniffVideo(pic.src, link);
    }
    refreshLaterButton(link, seq);
    refreshDlButton();
    dropAhead();
    setTimeout(() => preloadAhead(seq), AHEAD_FALLBACK_MS);
    openShell();
    info(`modal: ${kind} post ${postId(link)}`);
  }
  __name(openModal, "openModal");
  function openShell() {
    if (modal.open) return;
    modal.open = true;
    suspendPage();
    if (!modal.host.isConnected) document.documentElement.appendChild(modal.host);
    modal.host.style.display = "";
    document.documentElement.style.setProperty("overflow", "hidden", "important");
    modal.scrollMode = history.scrollRestoration;
    history.scrollRestoration = "manual";
    history.pushState({ ibhModal: true }, "");
  }
  __name(openShell, "openShell");
  var modalLinks = /* @__PURE__ */ __name(() => modal && modal.listLinks || siteLinks(), "modalLinks");
  function closeModal(fromBack) {
    if (!modal || !modal.open) return;
    if (modal.root.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {
    });
    modal.open = false;
    modal.turned = null;
    modal.turn.classList.remove("on");
    closeMenu();
    modal.listLinks = null;
    modal.box.classList.remove("later-mode");
    if (modal.laterIO) {
      modal.laterIO.disconnect();
      modal.laterIO = null;
    }
    modal.laterGrid.replaceChildren();
    dropAhead();
    resetMedia();
    modal.host.style.display = "none";
    document.documentElement.style.removeProperty("overflow");
    const link = modal.link;
    let landed = false;
    const land = /* @__PURE__ */ __name(() => {
      if (landed) return;
      landed = true;
      if (link && link.isConnected) link.scrollIntoView({ block: "center" });
      history.scrollRestoration = modal.scrollMode || "auto";
      resumePage();
    }, "land");
    if (!fromBack && history.state && history.state.ibhModal) {
      window.addEventListener("popstate", () => setTimeout(land, 0), { once: true });
      setTimeout(land, 1e3);
      history.back();
    } else {
      setTimeout(land, 0);
    }
  }
  __name(closeModal, "closeModal");
  var suspended = [];
  function suspendPage() {
    const n = { covers: 0, gifs: 0, images: 0 };
    coverQueue.clear();
    markedCards("[data-ibh-cover]").forEach((card) => {
      unmountCover(card);
      n.covers++;
    });
    markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach((card) => {
      stopGif(card);
      n.gifs++;
    });
    originalQueue.length = 0;
    markedImages("[data-ibh-orig]").forEach((el2) => {
      const state = el2.dataset.ibhOrig;
      if (state === "failed") return;
      if (state === "done") {
        pinHeight(el2);
        resetUpgrade(el2);
        n.images++;
      } else delete el2.dataset.ibhOrig;
      if (farViewport) farViewport.unobserve(el2);
      if (originalViewport) originalViewport.unobserve(el2);
      suspended.push(el2);
    });
    dbg(`modal: page unloaded (${n.covers} covers, ${n.gifs} GIFs, ${n.images} images)`);
  }
  __name(suspendPage, "suspendPage");
  function resumePage() {
    for (const el2 of suspended.splice(0)) if (el2.isConnected && originalViewport) originalViewport.observe(el2);
    markedCards("[data-ibh-seen]").forEach((card) => {
      if (CFG.videoCovers && isVideoCard(card)) mountCover(card);
      else if (CFG.gifInline && isGifCard(card)) playGif(card);
    });
  }
  __name(resumePage, "resumePage");
  function stepModal(dir) {
    const list = modalLinks();
    const target = list[list.indexOf(modal.link) + dir];
    if (!target) return;
    if (!modal.listLinks && dir > 0 && list.indexOf(target) >= list.length - 3) favPagerNext();
    modal.dir = dir;
    openModal(target);
    target.scrollIntoView({ block: "center" });
  }
  __name(stepModal, "stepModal");
  var AHEAD_FALLBACK_MS = 4e3;
  var ahead = null;
  function preloadAhead(seq) {
    if (!CFG.modalPreload || !modal.open || modal.seq !== seq) return;
    const list = modalLinks();
    const link = list[list.indexOf(modal.link) + (modal.dir || 1)];
    if (!link || ahead && ahead.link === link) return;
    dropAhead();
    const thumb = link.querySelector("img");
    const pic = thumb && cardPicture(link);
    const parts = pic && thumbParts(pic.src);
    if (!parts) return;
    const a = ahead = { link };
    if (!onOwnFavorites()) lookUpFavorite(postId(link));
    let kind = thumbKind(thumb);
    if (kind === "video" && cacheGet("video", parts.hash) === null) kind = "gif";
    if (kind === "video") aheadVideo(a, pic.src, parts.hash);
    else aheadImage(a, pic.src, parts.hash, kind === "gif" ? "gif" : "orig");
    dbg(`modal: preloading ${kind} post ${postId(link)}`);
  }
  __name(preloadAhead, "preloadAhead");
  function aheadImage(a, src, hash, kind) {
    const sampleFirst = kind === "orig" && CFG.modalOriginal !== "always";
    if (sampleFirst) kind = "sample";
    const cached = kind === "orig" ? knownOriginal(hash) : cacheGet(kind, hash);
    if (cached === null) return;
    const stages = kind === "gif" ? [fileCandidates(src, ["gif"])] : sampleFirst ? [sampleCandidates(src), fileCandidates(src, ORIGINAL_EXTS)] : [fileCandidates(src, ORIGINAL_EXTS)];
    takeImageSlot(() => {
      if (ahead !== a) {
        giveImageSlot();
        return;
      }
      let held = true;
      a.release = () => {
        if (held) {
          held = false;
          giveImageSlot();
        }
      };
      a.cancel = raceImage(stages, cached, (img) => {
        a.release();
        a.img = img;
        cacheSet(kind, hash, img.src, cached);
        const decoded = typeof img.decode === "function" ? img.decode().catch(() => {
        }) : Promise.resolve();
        decoded.then(() => {
          if (ahead === a) a.decoded = true;
        });
      }, () => {
        a.release();
        cacheSet(kind, hash, null);
      });
    });
  }
  __name(aheadImage, "aheadImage");
  function aheadVideo(a, src, hash) {
    const cached = cacheGet("video", hash);
    const urls = cachedFirst(fileCandidates(src, ["mp4", "webm"]), cached);
    if (!urls.length) return;
    const v = a.video = document.createElement("video");
    v.muted = true;
    v.preload = "metadata";
    let i = 0;
    const stop = /* @__PURE__ */ __name(() => {
      v.onerror = v.onloadedmetadata = null;
      v.removeAttribute("src");
      v.load();
    }, "stop");
    v.onerror = () => {
      if (i < urls.length) {
        v.src = urls[i++];
        return;
      }
      if (!(v.error && (v.error.code === 3 || v.error.code === 2))) cacheSet("video", hash, null);
      stop();
    };
    v.onloadedmetadata = () => {
      cacheSet("video", hash, urls[i - 1], cached);
      stop();
    };
    v.src = urls[i++];
  }
  __name(aheadVideo, "aheadVideo");
  function aheadReady(link) {
    return ahead && ahead.link === link && ahead.decoded && /** @type {HTMLImageElement} */
    ahead.img.naturalWidth ? (
      /** @type {HTMLImageElement} */
      ahead.img.src
    ) : null;
  }
  __name(aheadReady, "aheadReady");
  function dropAhead() {
    if (!ahead) return;
    const a = ahead;
    ahead = null;
    if (a.cancel) a.cancel();
    if (a.img) {
      a.img.onload = a.img.onerror = null;
      a.img.removeAttribute("src");
    }
    if (a.video) {
      a.video.onerror = a.video.onloadedmetadata = null;
      a.video.removeAttribute("src");
      a.video.load();
    }
    if (a.release) a.release();
  }
  __name(dropAhead, "dropAhead");
  function onSiteLinkClick(ev) {
    if (ev.defaultPrevented || ev.button !== 0) return;
    const link = (
      /** @type {HTMLAnchorElement | null | undefined} */
      asElement(ev.target)?.closest(SITE_LINK)
    );
    if (!link) return;
    ev.preventDefault();
    ev.stopPropagation();
    openModal(link);
  }
  __name(onSiteLinkClick, "onSiteLinkClick");
  function installVideoModal() {
    if (!CFG.videoModal) return;
    window.addEventListener("click", onSiteLinkClick, true);
    window.addEventListener("click", onSiteVoteClick, true);
    window.addEventListener("resize", () => {
      if (modal && modal.open) {
        resetZoom();
        fitImage();
      }
    });
    window.addEventListener("popstate", () => {
      if (modal && modal.open) closeModal(true);
    });
    document.addEventListener("fullscreenchange", onFullscreenChange);
    if (screen.orientation) screen.orientation.addEventListener("change", onOrientationChange);
    info("post modal active: thumbnails on site pages open in place");
  }
  __name(installVideoModal, "installVideoModal");

  // src/diag.js
  function probeVideoUrls() {
    const cards = siteLinks().filter(isVideoCard);
    const card = cards.find((c) => c.dataset.ibhSeen) || cards[0];
    if (!card) {
      warn("no video card on screen to test");
      return;
    }
    const pic = cardPicture(card);
    if (!pic) {
      warn("video card has no picture yet");
      return;
    }
    const urls = fileCandidates(pic.src, ["mp4", "webm"]);
    info(`thumbnail: ${pic.src}`);
    if (!urls.length) {
      warn("no URL derivable from that thumbnail");
      return;
    }
    urls.forEach((url) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      const done = /* @__PURE__ */ __name((ok) => {
        v.src = "";
        log(ok ? "info" : "warn", `${ok ? "OK  " : "FAIL"} ${url}`);
      }, "done");
      v.addEventListener("loadedmetadata", () => done(true), { once: true });
      v.addEventListener("error", () => done(false), { once: true });
      v.src = url;
    });
  }
  __name(probeVideoUrls, "probeVideoUrls");
  function resetUpgrade(el2) {
    if (el2.dataset.ibhOrig === "done" && el2.dataset.ibhThumb) {
      const pic = pictureOf(el2);
      if (pic) pic.set(el2.dataset.ibhThumb);
    }
    delete el2.dataset.ibhOrig;
    delete el2.dataset.ibhThumb;
    if (el2.dataset.ibhRaw) {
      delete el2.dataset.ibhRaw;
      delete el2.dataset.ibhPreRaw;
      delete el2.dataset.ibhRawMarked;
      const badge = el2.closest("a") && /** @type {HTMLAnchorElement} */
      el2.closest("a").querySelector(".ibh-rawbadge");
      if (badge) badge.remove();
    }
  }
  __name(resetUpgrade, "resetUpgrade");
  var tabChannel = "BroadcastChannel" in window ? new BroadcastChannel("ibh") : null;
  async function freeMemory(reason = "button") {
    if (reason === "button" && tabChannel) tabChannel.postMessage({ type: "free-memory" });
    for (const r of reels.values()) if (r.url) URL.revokeObjectURL(r.url);
    reels.clear();
    dropH264();
    const n = { covers: 0, gifs: 0, images: 0, caches: 0 };
    if (scrub) endScrub();
    previewStop();
    setPreviewEl(null);
    dropAhead();
    favLookups.clear();
    postInfos.clear();
    coverQueue.clear();
    markedCards("[data-ibh-cover]").forEach((card) => {
      unmountCover(card);
      n.covers++;
    });
    markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach((card) => {
      stopGif(card);
      n.gifs++;
    });
    setUpgradeGen(upgradeGen + 1);
    originalQueue.length = 0;
    markedImages("[data-ibh-orig]").forEach((el2) => {
      if (el2.dataset.ibhOrig === "failed") return;
      if (el2.dataset.ibhOrig === "done") n.images++;
      resetUpgrade(el2);
      if (farViewport) farViewport.unobserve(el2);
      if (originalViewport) originalViewport.observe(el2);
    });
    parked.splice(0, parked.length, ...parked.filter((c) => c.isConnected));
    previewPaused.splice(0, previewPaused.length, ...previewPaused.filter((c) => c.isConnected));
    if (!(modal && modal.open)) suspended.length = 0;
    if (reason !== "redo" && !document.hidden && !(modal && modal.open)) {
      const seen = [...markedCards("[data-ibh-seen]")].sort((a, b) => fromMiddle(a) - fromMiddle(b));
      for (const card of seen) {
        if (CFG.videoCovers && isVideoCard(card)) mountCover(card);
        else if (CFG.gifInline && isGifCard(card)) playGif(card);
      }
    }
    try {
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
        n.caches = keys.length;
      }
    } catch (e) {
      warn(`could not clear Cache Storage — ${describeError(e)}`);
    }
    info(`freed ${n.covers} covers, ${n.gifs} GIFs, ${n.images} upgraded images${reason === "tab" ? " (asked by another tab)" : reason === "redo" ? " (before redoing the thumbnails)" : ""}; ${n.caches} Cache Storage entries cleared; URL cache and image host kept`);
    touch();
    return n;
  }
  __name(freeMemory, "freeMemory");
  function redoThumbs() {
    const n = { images: 0, covers: 0, gifs: 0 };
    const misses = clearUrlCache(true);
    markedImages("[data-ibh-orig]").forEach((el2) => {
      resetUpgrade(el2);
      if (originalViewport) originalViewport.observe(el2);
      else upgradeToOriginal(el2);
      n.images++;
    });
    markedCards("[data-ibh-cover]").forEach((card) => unmountCover(card));
    coverQueue.clear();
    markedCards("[data-ibh-gif]").forEach((card) => {
      stopGif(card);
      delete card.dataset.ibhGif;
    });
    knownGifs.clear();
    markedCards("[data-ibh-kind]").forEach((card) => {
      delete card.dataset.ibhKind;
    });
    markedCards("[data-ibh-seen]").forEach((card) => {
      if (CFG.videoCovers && isVideoCard(card)) {
        mountCover(card);
        n.covers++;
      } else if (CFG.gifInline && isGifCard(card)) {
        playGif(card);
        n.gifs++;
      }
    });
    scanCards(document);
    scanThumbs(document);
    info(`redo thumbnails: ${n.images} images re-queued, ${n.covers} covers and ${n.gifs} GIFs restarted, ${misses} cached misses dropped`);
    touch();
  }
  __name(redoThumbs, "redoThumbs");
  function logSnapshot() {
    info(`v${VERSION} on ${SITE} · ui=${LANG}`);
    dbg(`userAgent: ${navigator.userAgent}`);
  }
  __name(logSnapshot, "logSnapshot");

  // src/page/bulk.js
  var HEART_ICON = "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z";
  var bulkMode = false;
  var wantsBulkButton = /* @__PURE__ */ __name(() => !!CFG.bulkFavButton && SITE === "rule34.xxx" && !!userId() && !!document.querySelector(SITE_LINK), "wantsBulkButton");
  function setBulkMode(on) {
    bulkMode = on;
    const heart = control(".bulkfab");
    if (heart) heart.classList.toggle("on", on);
    pageToast(t(on ? "bulkOn" : "bulkOff"));
    info(`mass favorite ${on ? "on" : "off"}`);
  }
  __name(setBulkMode, "setBulkMode");
  var pageToastTimer = 0;
  function pageToast(text) {
    if (!shadow) return;
    let toast = control(".pagetoast");
    if (!toast) {
      toast = el("div", { class: "pagetoast" });
      shadow.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = "1";
    clearTimeout(pageToastTimer);
    pageToastTimer = setTimeout(() => {
      toast.style.opacity = "0";
    }, 2200);
  }
  __name(pageToast, "pageToast");
  function bulkBadge(link, text, tone, cls = "ibh-bulkbadge") {
    let badge = (
      /** @type {HTMLSpanElement | null} */
      link.querySelector(`.${cls}`)
    );
    if (!badge) {
      badge = document.createElement("span");
      badge.className = cls;
      badge.dataset.ibhUi = "1";
      if (getComputedStyle(link).position === "static") link.style.position = "relative";
      link.appendChild(badge);
    }
    badge.textContent = text;
    badge.style.background = tone;
  }
  __name(bulkBadge, "bulkBadge");
  async function bulkFavorite(link, via = "mass favorite") {
    const id = postId(link);
    if (link.dataset.ibhBulk) return;
    link.dataset.ibhBulk = "1";
    bulkBadge(link, "…", "rgba(15, 20, 23, .85)");
    try {
      const { code } = await favoritePost(id, false);
      if (code === "2") {
        bulkBadge(link, "✕", "#b42318");
        pageToast(t("favLogin"));
        delete link.dataset.ibhBulk;
        return;
      }
      if (code !== "3" && code !== "1") throw new Error(`answer ${code.slice(0, 20)}`);
      await upvotePost(id);
      if (wantsLiked()) link.querySelector(".ibh-bulkbadge")?.remove();
      else bulkBadge(link, "♥", "#e5534b");
      info(`${via}: post ${id} ${code === "3" ? "favorited" : "was a favorite"}, upvoted`);
    } catch (e) {
      delete link.dataset.ibhBulk;
      bulkBadge(link, "✕", "#b42318");
      warn(`${via}: post ${id} failed — ${describeError(e)}`);
    }
  }
  __name(bulkFavorite, "bulkFavorite");
  function onBulkClick(ev) {
    if (!bulkMode || ev.button !== 0) return;
    const link = (
      /** @type {HTMLAnchorElement | null | undefined} */
      asElement(ev.target)?.closest(SITE_LINK)
    );
    if (!link) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    bulkFavorite(link);
  }
  __name(onBulkClick, "onBulkClick");

  // src/panel/nav.js
  function ensureFeedNav() {
    if (!shadow) return;
    const feed = wantsFeedButtons();
    const free = !!CFG.freeButton;
    const redo = !!CFG.redoButton;
    const want = `${feed ? "f" : ""}${free ? "c" : ""}${redo ? "r" : ""}`;
    let nav = control(".feednav:not(.pagenav)");
    if (nav && nav.dataset.set !== want) {
      nav.remove();
      nav = null;
    }
    if (!nav && want) {
      nav = buildFeedNav(feed, free, redo);
      nav.dataset.set = want;
      shadow.appendChild(nav);
      dbg(`buttons added: ${feed ? "feed " : ""}${free ? "free" : ""}`.trim());
    }
    let favs = control(".favsfab");
    const wantFavs = !!CFG.favsButton && SITE === "rule34.xxx" && !!userId();
    if (favs && !wantFavs) {
      favs.remove();
      favs = null;
    }
    if (!favs && wantFavs) {
      favs = iconButton("laterfab favsfab", t("navFavs"), BOOKMARK_ICON);
      favs.addEventListener("click", () => {
        info("going to your favorites");
        location.href = `index.php?page=favorites&s=view&id=${userId()}`;
      });
      shadow.appendChild(favs);
    }
    const packRight = /* @__PURE__ */ __name(() => {
      [control(".clockfab"), control(".bulkfab"), control(".favsfab")].filter((btn) => btn !== null).forEach((btn, i) => {
        btn.style.right = `${12 + i * 52}px`;
      });
    }, "packRight");
    let heart = control(".bulkfab");
    if (heart && !wantsBulkButton()) {
      heart.remove();
      heart = null;
      if (bulkMode) setBulkMode(false);
    }
    if (!heart && wantsBulkButton()) {
      heart = iconButton("laterfab bulkfab", t("navBulk"), HEART_ICON);
      heart.classList.toggle("on", bulkMode);
      heart.addEventListener("click", () => setBulkMode(!bulkMode));
      shadow.appendChild(heart);
    }
    let clock = control(".clockfab");
    if (clock && !wantsLaterButton()) {
      clock.remove();
      clock = null;
    }
    if (!clock && wantsLaterButton()) {
      clock = iconButton("laterfab clockfab", t("navLater"), CLOCK_ICON);
      clock.addEventListener("click", () => showLater());
      shadow.appendChild(clock);
    }
    packRight();
    let eye = control(".eyefab");
    if (eye && !CFG.eyeButton) {
      eye.remove();
      eye = null;
    }
    if (!eye && CFG.eyeButton) {
      eye = iconButton("eyefab", t("eyeHide"), EYE_ICON);
      eye.classList.toggle("solo", !CFG.panel);
      eye.addEventListener("click", () => setButtonsHidden(!CFG.buttonsHidden));
      shadow.appendChild(eye);
    }
    applyButtonsHidden();
    let pages = control(".pagenav");
    if (pages && !feed) {
      pages.remove();
      pages = null;
    }
    if (!pages && feed) {
      pages = buildPageNav();
      shadow.appendChild(pages);
    }
    if (pages) {
      const prev = (
        /** @type {HTMLButtonElement} */
        pages.querySelector(".pp")
      );
      const next = (
        /** @type {HTMLButtonElement} */
        pages.querySelector(".np")
      );
      prev.disabled = !pageTarget(-1);
      next.disabled = !pageTarget(1);
    }
  }
  __name(ensureFeedNav, "ensureFeedNav");
  var wantsFeedButtons = /* @__PURE__ */ __name(() => CFG.feedNav && CFG.nativeFeed && !!document.querySelector(FEED_POST), "wantsFeedButtons");
  var FEED_POST = THUMB;
  function jumpPost(dir) {
    const posts = [...document.querySelectorAll(FEED_POST)];
    if (!posts.length) return;
    let target = null;
    let best = dir > 0 ? Infinity : -Infinity;
    for (const post of posts) {
      const top = post.getBoundingClientRect().top;
      if (dir > 0 ? top > 8 && top < best : top < -8 && top > best) {
        best = top;
        target = post;
      }
    }
    if (!target) return;
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY, behavior: "auto" });
    dbg(`feed: jumped to the ${dir > 0 ? "next" : "previous"} post`);
  }
  __name(jumpPost, "jumpPost");
  function pageTarget(dir, root = document, base = location.href) {
    const box = root.querySelector("#paginator, .pagination");
    if (box) {
      const want = dir > 0 ? /^(>|›|next)$/i : /^(<|‹|back|prev(ious)?)$/i;
      const a = [...box.querySelectorAll("a")].find((x) => want.test((x.textContent || "").trim()) || want.test(x.getAttribute("alt") || ""));
      if (a) {
        const href = a.getAttribute("href");
        if (href && href !== "#") return new URL(href, base).href;
        const m = (a.getAttribute("onclick") || "").match(/location\s*=\s*['"]([^'"]+)['"]/);
        if (m) return new URL(m[1], base).href;
      }
      if (box.querySelector("a")) return null;
    }
    const url = new URL(base);
    const pid = Number(url.searchParams.get("pid")) || 0;
    const per = root.querySelectorAll(FEED_POST).length;
    if (!per || dir < 0 && pid === 0) return null;
    url.searchParams.set("pid", String(Math.max(0, pid + dir * per)));
    return url.href;
  }
  __name(pageTarget, "pageTarget");
  function goPage(dir) {
    const target = pageTarget(dir);
    if (!target) return;
    info(`feed: ${dir > 0 ? "next" : "previous"} page`);
    location.href = target;
  }
  __name(goPage, "goPage");
  var TRASH_ICON = "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z";
  var BOOKMARK_ICON = "M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z";
  var REDO_ICON = "M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z";
  function redoButton() {
    const btn = iconButton("trash", t("navRedo"), REDO_ICON);
    btn.addEventListener("click", () => {
      btn.classList.add("on");
      btn.disabled = true;
      freeMemory("redo").then(() => redoThumbs()).finally(() => {
        setTimeout(() => {
          btn.classList.remove("on");
          btn.disabled = false;
        }, 400);
        renderStatus();
      });
    });
    return btn;
  }
  __name(redoButton, "redoButton");
  function trashButton() {
    const btn = el("button", { class: "trash", title: t("navFree") });
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", TRASH_ICON);
    svg.appendChild(path);
    btn.appendChild(svg);
    btn.addEventListener("click", () => {
      btn.classList.add("on");
      btn.disabled = true;
      freeMemory().finally(() => {
        setTimeout(() => {
          btn.classList.remove("on");
          btn.disabled = false;
        }, 400);
        renderStatus();
      });
    });
    return btn;
  }
  __name(trashButton, "trashButton");
  var EYE_ICON = "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z";
  var EYE_OFF_ICON = "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z";
  function setButtonsHidden(hidden) {
    if (hidden) {
      if (bulkMode) setBulkMode(false);
      if (panelOpen) togglePanel(false);
    }
    setCfg("buttonsHidden", hidden);
    applyButtonsHidden();
  }
  __name(setButtonsHidden, "setButtonsHidden");
  function applyButtonsHidden() {
    const eye = control(".eyefab");
    if (!eye) {
      if (panelHost) panelHost.classList.remove("ibh-clean");
      return;
    }
    const hidden = !!CFG.buttonsHidden;
    if (eye.dataset.hidden === String(hidden)) return;
    eye.dataset.hidden = String(hidden);
    panelHost.classList.toggle("ibh-clean", hidden);
    eye.title = t(hidden ? "eyeShow" : "eyeHide");
    const icon = (
      /** @type {SVGPathElement} */
      eye.querySelector("path")
    );
    icon.setAttribute("d", hidden ? EYE_OFF_ICON : EYE_ICON);
  }
  __name(applyButtonsHidden, "applyButtonsHidden");
  var CLOCK_ICON = "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm4.2 14.2L11 13V7h1.5v5.2l4.5 2.7-.8 1.3z";
  function iconButton(cls, title, d) {
    const btn = el("button", { class: cls, title });
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
    btn.appendChild(svg);
    return btn;
  }
  __name(iconButton, "iconButton");
  var wantsLaterButton = /* @__PURE__ */ __name(() => !!CFG.laterButton && !!CFG.videoModal && !!document.querySelector(SITE_LINK), "wantsLaterButton");
  function buildFeedNav(feed, free, redo) {
    const rows = [];
    if (feed) {
      const top = el("button", { text: "⤒", title: t("navTop") });
      const prev = el("button", { text: "‹", title: t("navPrev") });
      const next = el("button", { text: "›", title: t("navNext") });
      const bottom = el("button", { text: "⤓", title: t("navBottom") });
      top.addEventListener("click", () => {
        window.scrollTo({ top: 0, behavior: "auto" });
        dbg("feed: jumped to the top");
      });
      prev.addEventListener("click", () => jumpPost(-1));
      next.addEventListener("click", () => jumpPost(1));
      bottom.addEventListener("click", () => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
        dbg("feed: jumped to the bottom");
      });
      rows.push(el("div", { class: "row" }, [top, prev, next, bottom]));
    }
    const second = [];
    if (free) second.push(trashButton());
    if (redo) second.push(redoButton());
    if (second.length) rows.push(el("div", { class: "row" }, second));
    return el("div", { class: "feednav" }, rows);
  }
  __name(buildFeedNav, "buildFeedNav");
  function buildPageNav() {
    const prevPage = el("button", { class: "pp", text: "«", title: t("navPrevPage") });
    const nextPage = el("button", { class: "np", text: "»", title: t("navNextPage") });
    prevPage.addEventListener("click", () => goPage(-1));
    nextPage.addEventListener("click", () => goPage(1));
    return el("div", { class: "feednav pagenav" }, [el("div", { class: "row" }, [prevPage, nextPage])]);
  }
  __name(buildPageNav, "buildPageNav");

  // src/page/feed-css.js
  var FEED_COL_MIN = 170;
  function feedCss() {
    const cols = CFG.feedColumns;
    const auto = cols === "auto";
    const common = `
      ${THUMB} a { display: block !important; position: relative; }
      ${LIST} > br { display: none !important; }
      /* Post page: the image carries width="850" and the video a fixed box. */
      #image, #gelcomVideoPlayer { max-width: 100% !important; height: auto !important; }`;
    if (!auto && Number(cols) <= 1) return `
      ${LIST} { display: flex !important; flex-direction: column !important;
        flex-wrap: nowrap !important; align-items: stretch !important; gap: 14px !important; }
      ${ITEM} { display: block !important; width: 100% !important; max-width: none !important;
        height: auto !important; max-height: none !important; }
      ${THUMB} { display: block !important; width: 100vw !important; height: auto !important;
        max-width: none !important; max-height: none !important; min-height: 0 !important;
        margin: 0 calc(50% - 50vw) !important; }
      ${THUMB} img { display: block; width: 100% !important; height: auto !important;
        max-width: none !important; max-height: none !important; }` + common;
    const item = `
      ${ITEM} { display: block !important; width: 100% !important; max-width: none !important;
        height: auto !important; max-height: none !important; margin: 0 !important; }
      ${THUMB} { display: block !important; width: 100% !important; height: auto !important;
        max-width: none !important; max-height: none !important; min-height: 0 !important; margin: 0 !important; }`;
    if (CFG.feedLayout === "grid") return `
      ${LIST} { display: grid !important; gap: 6px !important; grid-template-columns: ${auto ? `repeat(auto-fill, minmax(${FEED_COL_MIN}px, 1fr))` : `repeat(${Number(cols)}, minmax(0, 1fr))`} !important; }
      ${item}
      ${THUMB} img { display: block; width: 100% !important; height: auto !important;
        aspect-ratio: 1 / 1; object-fit: cover; max-width: none !important; max-height: none !important; }` + common;
    return `
      ${LIST} { display: block !important; column-gap: 6px !important;
        ${auto ? `column-width: ${FEED_COL_MIN}px` : `column-count: ${Number(cols)}`} !important; }
      ${item}
      ${ITEM} { break-inside: avoid !important; margin-bottom: 6px !important; }
      ${THUMB} img { display: block; width: 100% !important; height: auto !important;
        max-width: none !important; max-height: none !important; }` + common;
  }
  __name(feedCss, "feedCss");
  var feedCssShown = null;
  function applyFeed() {
    const css = CFG.nativeFeed ? feedCss() : "";
    let style = document.querySelector("style[data-ibh-feed]");
    if (style && css === feedCssShown) return;
    if (!style) {
      style = el("style", { "data-ibh-feed": "1" });
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = css;
    feedCssShown = css;
  }
  __name(applyFeed, "applyFeed");
  function switchFeed() {
    const anchor = [...document.querySelectorAll(THUMB)].find((el2) => el2.getBoundingClientRect().bottom > 0);
    applyFeed();
    if (anchor) anchor.scrollIntoView({ block: "start" });
    if (CFG.nativeFeed) scanThumbs(document);
    ensureFeedNav();
    info(`feed ${CFG.nativeFeed ? `on: ${CFG.feedColumns} columns, ${CFG.feedLayout}` : "off"} (switched from the panel)`);
  }
  __name(switchFeed, "switchFeed");

  // src/page/theme.js
  var THEME_CSS = `
    html.ibh-theme, html.ibh-theme body { background: #182125 !important; color: #e6eef0 !important; }
    html.ibh-theme body *:not(img):not(video):not(canvas):not(iframe):not(svg):not(path):not([data-ibh-ui]) {
      background-color: transparent !important; border-color: ${LINE} !important; }
    html.ibh-theme body *:not(a):not(img):not(video):not(svg):not(path):not([data-ibh-ui]) { color: #e6eef0 !important; }
    html.ibh-theme a, html.ibh-theme a:visited, html.ibh-theme summary { color: ${ACCENT} !important; }
    html.ibh-theme a:hover { color: #99f6e4 !important; }
    html.ibh-theme li[class*="tag-type-artist"] a { color: #f2ac08 !important; }
    html.ibh-theme li[class*="tag-type-character"] a { color: #3fb950 !important; }
    html.ibh-theme li[class*="tag-type-copyright"] a { color: #c678dd !important; }
    html.ibh-theme li[class*="tag-type-metadata"] a { color: #e5534b !important; }
    /* Lines in neon green (${LINE}); controls stand on a lighter surface,
       teal text for the ones that act. */
    html.ibh-theme input, html.ibh-theme select, html.ibh-theme textarea, html.ibh-theme button {
      background-color: #26363c !important; color: #e6eef0 !important;
      border: 1px solid ${LINE} !important; border-radius: 8px !important; }
    html.ibh-theme input:focus, html.ibh-theme select:focus, html.ibh-theme textarea:focus {
      border-color: ${LINE} !important; outline: none !important; box-shadow: 0 0 0 2px rgba(57, 255, 20, .35) !important; }
    html.ibh-theme input[type="submit"], html.ibh-theme input[type="button"], html.ibh-theme button {
      background-color: ${ACCENT_DARK} !important; color: ${ACCENT} !important; border-color: ${LINE} !important; font-weight: 600; }
    html.ibh-theme ::placeholder { color: #7f9aa0 !important; }
    html.ibh-theme #paginator a, html.ibh-theme #paginator b, html.ibh-theme .pagination a, html.ibh-theme .pagination b {
      display: inline-block; padding: 3px 9px; margin: 2px; border-radius: 8px;
      background-color: #26363c !important; border: 1px solid ${LINE} !important; }
    html.ibh-theme #paginator b, html.ibh-theme .pagination b {
      background-color: ${ACCENT} !important; color: #0f1417 !important; border-color: ${ACCENT} !important; }
    /* The sites' own suggestion lists (rule34's Awesomplete, gelbooru's jQuery UI) float over the page:
       they need a background back. :not(#ibh) adds an ID's weight, to outrank the broad rule above
       (two classes and eight :not()s); a class alone loses to it, !important or not. */
    html.ibh-theme .awesomplete > ul:not(#ibh), html.ibh-theme .awesomplete > ul:not(#ibh) *,
    html.ibh-theme .ui-autocomplete:not(#ibh), html.ibh-theme .ui-autocomplete:not(#ibh) * { background-color: #26363c !important; }
    html.ibh-theme .awesomplete > ul:not(#ibh) [aria-selected="true"],
    html.ibh-theme .ui-autocomplete:not(#ibh) .ui-state-active { background-color: ${ACCENT_DARK} !important; }
    /* The mobile layout's ☰ menus float over the page (position: absolute);
       made transparent above, an open one would lay its links over the posts. */
    html.ibh-theme #navbar, html.ibh-theme #subnavbar { background-color: #26363c !important; box-shadow: 0 8px 18px rgba(0, 0, 0, .55); }
    html.ibh-theme #navbar li, html.ibh-theme #subnavbar li { border-color: #2f4a4f !important; }
    html.ibh-theme ::selection { background: ${ACCENT_MID}; }
    html.ibh-theme hr { border: none !important; border-top: 1px solid ${LINE} !important; }
  `;
  var themeOn = null;
  function applySiteTheme() {
    const on = !!CFG.siteTheme;
    if (on === themeOn && document.documentElement.classList.contains("ibh-theme") === on) return;
    themeOn = on;
    document.documentElement.classList.toggle("ibh-theme", on);
    dbg(`site theme ${on ? "on" : "off"}`);
  }
  __name(applySiteTheme, "applySiteTheme");

  // src/panel/panel.js
  var panelHost = null;
  function setPanelHost(v) {
    panelHost = v;
  }
  __name(setPanelHost, "setPanelHost");
  var shadow = null;
  function setShadow(v) {
    shadow = v;
  }
  __name(setShadow, "setShadow");
  var logBox = null;
  function control(sel) {
    return shadow && /** @type {Controls[K] | null} */
    shadow.querySelector(sel);
  }
  __name(control, "control");
  var statusBox = null;
  var panelOpen = false;
  var PANEL_CSS = `
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
  `;
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") node.textContent = v;
      else if (k === "class") node.className = v;
      else node.setAttribute(k, v);
    }
    if (children) children.forEach((c) => node.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return node;
  }
  __name(el, "el");
  var statusRow = /* @__PURE__ */ __name((key, value, tone) => el("div", { class: "row" }, [
    el("span", { class: `dot ${tone}` }),
    el("span", { class: "k", text: key }),
    el("span", { class: "v", text: String(value) })
  ]), "statusRow");
  var renderingStatus = false;
  function renderStatus() {
    if (!statusBox || renderingStatus) return;
    renderingStatus = true;
    try {
      drawStatus();
    } finally {
      renderingStatus = false;
    }
  }
  __name(renderStatus, "renderStatus");
  function drawStatus() {
    statusBox.textContent = "";
    const c = STATE.covers;
    const coverTone = c.tracked === 0 ? "idle" : c.failed > 0 ? "warn" : c.ok > 0 ? "ok" : "idle";
    const hostLabel = STATE.imageBase ? STATE.imageBase + (STATE.baseCached ? ` (${t("cached")})` : "") : t("notResolved");
    const rows = [
      statusRow(t("site"), SITE, "ok"),
      statusRow(t("host"), hostLabel, STATE.imageBase ? "ok" : "warn"),
      statusRow(t("covers"), t("coversFmt")(c.ok, c.failed, c.tracked), coverTone)
    ];
    rows.forEach((r) => (
      /** @type {HTMLDivElement} */
      statusBox.appendChild(r)
    ));
  }
  __name(drawStatus, "drawStatus");
  function appendLogLine(entry) {
    if (!logBox) return;
    const time = new Date(entry.t).toTimeString().slice(0, 8);
    logBox.appendChild(el("div", null, [
      el("span", { class: "ts", text: time }),
      el("span", { class: entry.level, text: entry.msg })
    ]));
    while (logBox.childElementCount > LOG_MAX) logBox.firstElementChild.remove();
    logBox.scrollTop = logBox.scrollHeight;
    if (entry.level === "error" && shadow) {
      const fab = control(".fab");
      if (fab) fab.dataset.alert = "1";
    }
  }
  __name(appendLogLine, "appendLogLine");
  function toggle(key, label, note, then) {
    const input = el("input", { type: "checkbox" });
    input.checked = !!CFG[key];
    input.addEventListener("change", () => {
      setCfg(key, input.checked);
      if (then) then();
      renderStatus();
    });
    const row = el("label", { class: "tog" }, [input, el("span", { text: label })]);
    if (note) row.appendChild(el("span", { class: "note", text: note }));
    return row;
  }
  __name(toggle, "toggle");
  function choiceSelect(key, title, choices, then) {
    const sel = el("select");
    for (const [value, label] of choices) {
      const option = el("option", { value: String(value), text: label });
      if (String(CFG[key]) === String(value)) option.setAttribute("selected", "");
      sel.appendChild(option);
    }
    sel.addEventListener("change", () => {
      const picked = (
        /** @type {[string | number, string]} */
        choices.find(([value]) => String(value) === sel.value)
      );
      setCfg(
        key,
        /** @type {any} */
        picked[0]
      );
      if (then) then();
    });
    return el("div", { class: "lang" }, [el("div", { class: "lbl", text: title }), sel]);
  }
  __name(choiceSelect, "choiceSelect");
  function scrubModeControls(body) {
    body.appendChild(choiceSelect(
      "scrubMode",
      t("tScrubMode"),
      [["drag", t("modeDrag")], ["hold", t("modeHold")]],
      rebuildPanel
    ));
    body.appendChild(toggle("holdRub", t("tHoldRub")));
    if (CFG.scrubMode !== "hold") return;
    body.appendChild(toggle("holdVideo", t("tHoldVideo"), null, rebuildPanel));
    body.appendChild(toggle("previewSound", t("tPreviewSound")));
    body.appendChild(toggle("holdResume", t("tHoldResume")));
    if (CFG.holdVideo) return;
    const num = /* @__PURE__ */ __name((n) => n.toLocaleString(LANG), "num");
    body.appendChild(choiceSelect(
      "slideStep",
      t("tSlideStep"),
      [5, 10, 20, 25].map((p) => [p, `${num(p)}% · ${Math.round(100 / p)} ${t("scenes")}`])
    ));
    body.appendChild(choiceSelect(
      "slideDwell",
      t("tSlideDwell"),
      [0.1, 0.2, 0.3, 0.5, 1].map((sec) => [sec, `${num(sec)} s`])
    ));
    body.appendChild(toggle("slideReel", t("tSlideReel")));
    body.appendChild(toggle("wasmDecode", t("tWasmDecode")));
  }
  __name(scrubModeControls, "scrubModeControls");
  function languageSelect() {
    const sel = el("select");
    for (const [value, label] of [["", t("auto")], ["pt-BR", "Português"], ["en", "English"]]) {
      const option = el("option", { value, text: label });
      if ((CFG.lang || "") === value) option.setAttribute("selected", "");
      sel.appendChild(option);
    }
    sel.addEventListener("change", () => {
      setCfg(
        "lang",
        /** @type {Lang | ''} */
        sel.value || null
      );
      setLang(resolveLang());
      rebuildPanel();
    });
    return el("div", { class: "lang" }, [sel]);
  }
  __name(languageSelect, "languageSelect");
  var actionButton = /* @__PURE__ */ __name((label, fn) => {
    const b = el("button", { text: label });
    b.addEventListener("click", fn);
    return b;
  }, "actionButton");
  function buildPanel() {
    const panel = el("div", { class: "panel" });
    if (!panelOpen) panel.setAttribute("hidden", "");
    const closeBtn = el("button", { text: "×" });
    closeBtn.addEventListener("click", () => togglePanel(false));
    panel.appendChild(el("header", null, [
      el("b", { text: "Image Board Helper" }),
      el("span", { text: `v${VERSION}` }),
      closeBtn
    ]));
    const body = el("div", { class: "body" });
    statusBox = el("div");
    body.appendChild(statusBox);
    body.appendChild(el("div", { class: "sec", text: t("fixes") }));
    body.appendChild(toggle("originalThumbs", t("tOriginal"), t("noteReload")));
    body.appendChild(toggle("nativeFeed", t("tFeed"), null, () => {
      switchFeed();
      rebuildPanel();
    }));
    if (CFG.nativeFeed) {
      body.appendChild(choiceSelect(
        "feedColumns",
        t("tFeedCols"),
        [["auto", t("colsAuto")], [1, "1"], [2, "2"], [3, "3"], [4, "4"]],
        switchFeed
      ));
      body.appendChild(choiceSelect(
        "feedLayout",
        t("tFeedLayout"),
        [["masonry", t("layoutMasonry")], ["grid", t("layoutGrid")]],
        switchFeed
      ));
    }
    body.appendChild(toggle("feedNav", t("tNav"), t("noteReload")));
    body.appendChild(toggle("bulkFavButton", t("tBulkBtn"), null, ensureFeedNav));
    body.appendChild(toggle("doubleTapFav", t("tDoubleTap"), null, rebuildPanel));
    if (CFG.doubleTapFav) body.appendChild(choiceSelect("doubleTapLike", t("tDoubleTapLike"), [["heart", t("likeHeart")], ["quiet", t("likeQuiet")]]));
    body.appendChild(toggle("likedBadge", t("tLikedBadge"), null, () => {
      loadLikedIds();
      repaintCards();
    }));
    body.appendChild(toggle("favAutoIndex", t("tFavAutoIndex")));
    body.appendChild(toggle("favsButton", t("tFavsBtn"), null, ensureFeedNav));
    body.appendChild(toggle("holdRaw", t("tHoldRaw")));
    body.appendChild(toggle("freeButton", t("tFreeBtn"), null, ensureFeedNav));
    body.appendChild(toggle("redoButton", t("tRedoBtn"), null, ensureFeedNav));
    body.appendChild(toggle("eyeButton", t("tEyeBtn"), null, ensureFeedNav));
    body.appendChild(toggle("laterButton", t("tLaterBtn"), null, ensureFeedNav));
    body.appendChild(toggle("favSearch", t("tFavSearch"), null, ensureFavSearch));
    body.appendChild(toggle("favAutopager", t("tPager"), null, ensureFavPager));
    body.appendChild(toggle("siteSearch", t("tSiteSearch"), null, ensureSiteSearch));
    body.appendChild(toggle("searchSuggest", t("tSuggest")));
    body.appendChild(toggle("videoModal", t("tModal"), t("noteReload")));
    body.appendChild(toggle("siteTheme", t("tTheme"), null, applySiteTheme));
    body.appendChild(toggle("blockAds", t("tAds"), t("noteReload")));
    body.appendChild(toggle("rotateLandscape", t("tRotate")));
    body.appendChild(toggle("modalPreload", t("tPreload")));
    body.appendChild(toggle("playerButton", t("tPlayerBtn")));
    body.appendChild(toggle("appBridge", t("tAppBridge"), null, rebuildPanel));
    if (CFG.appBridge) body.appendChild(appControls());
    body.appendChild(toggle("copyLinkButton", t("tCopyBtn")));
    body.appendChild(toggle("seekReel", t("tSeekReel")));
    const onScreen = /* @__PURE__ */ __name(() => {
      if (modal) applyPlayRate(modal.video);
    }, "onScreen");
    body.appendChild(choiceSelect("playRate", t("tPlayRate"), PLAY_RATES.map((r) => [r, `${r.toLocaleString(LANG)}×`]), onScreen));
    body.appendChild(choiceSelect("seekStep", t("tSeekStep"), SEEK_JUMPS.map((s) => [s, `${s} s`])));
    body.appendChild(choiceSelect("doubleTapCenter", t("tDoubleTapCenter"), [["fullscreen", t("dtFullscreen")], ["like", t("dtLike")]]));
    body.appendChild(choiceSelect("modalOriginal", t("tModalOrig"), [["zoom", t("origZoom")], ["always", t("origAlways")]]));
    body.appendChild(toggle("videoCovers", t("tCovers")));
    body.appendChild(toggle("thumbBadges", t("tBadges"), t("noteReload")));
    body.appendChild(toggle("gifInline", t("tGif")));
    body.appendChild(choiceSelect("gifMaxLive", t("tGifMax"), [1, 2, 3, 4, 6, 10].map((n) => [n, String(n)]), applyGifLimit));
    body.appendChild(toggle("holdGif", t("tHoldGif")));
    body.appendChild(toggle("videoScrub", t("tScrub"), t("noteReload")));
    scrubModeControls(body);
    body.appendChild(toggle("memorySaver", t("tMemory"), t("noteReload")));
    body.appendChild(toggle("urlCache", t("tUrlCache")));
    body.appendChild(toggle("debug", t("tDebug")));
    apiSection(body);
    body.appendChild(el("div", { class: "sec", text: t("language") }));
    body.appendChild(languageSelect());
    body.appendChild(el("div", { class: "sec", text: t("log") }));
    logBox = el("div", { class: "log" });
    LOG.forEach(appendLogLine);
    body.appendChild(logBox);
    body.appendChild(el("div", { class: "acts" }, [
      actionButton(t("bTest"), probeVideoUrls),
      actionButton(t("bClearHost"), () => {
        clearHostCache();
        renderStatus();
      }),
      actionButton(t("bRedo"), () => {
        redoThumbs();
        renderStatus();
      }),
      actionButton(t("bFree"), () => {
        freeMemory().then(renderStatus);
      }),
      actionButton(t("bCopy"), copyLog),
      actionButton(t("bReload"), () => location.reload())
    ]));
    panel.appendChild(body);
    return panel;
  }
  __name(buildPanel, "buildPanel");
  function copyLog() {
    const head = `Image Board Helper v${VERSION} · ${SITE}
UA: ${navigator.userAgent}
host: ${STATE.imageBase}

`;
    const body = LOG.map(logLine).join("\n");
    navigator.clipboard.writeText(head + body).then(() => info("log copied")).catch((e) => error(`could not copy the log — ${describeError(e)}`));
  }
  __name(copyLog, "copyLog");
  function togglePanel(open) {
    panelOpen = open == null ? !panelOpen : open;
    const panel = control(".panel");
    if (!panel) return;
    panel.hidden = !panelOpen;
    if (panelOpen) {
      renderStatus();
      refreshAppStatus();
      const fab = control(".fab");
      if (fab) delete fab.dataset.alert;
    }
  }
  __name(togglePanel, "togglePanel");
  function mountPanel() {
    const nav = wantsFeedButtons() || CFG.freeButton || CFG.redoButton || CFG.laterButton || CFG.bulkFavButton || CFG.favsButton || CFG.eyeButton;
    if (!CFG.panel && !nav) return;
    if (panelHost && panelHost.isConnected) return;
    if (!document.body) return;
    panelHost = el("div");
    panelHost.style.cssText = "all:initial;position:static";
    shadow = panelHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);
    if (CFG.panel) {
      const fab = el("button", { class: "fab", text: "◐", title: "Image Board Helper" });
      fab.addEventListener("click", () => togglePanel());
      shadow.appendChild(fab);
      shadow.appendChild(buildPanel());
    }
    document.body.appendChild(panelHost);
    ensureFeedNav();
    if (CFG.panel) {
      setOnLogEntry(appendLogLine);
      setOnStateChange(() => {
        if (panelOpen) renderStatus();
      });
      if (panelOpen) renderStatus();
    }
    dbg("panel mounted");
  }
  __name(mountPanel, "mountPanel");
  function rebuildPanel() {
    if (panelHost) panelHost.remove();
    panelHost = null;
    shadow = null;
    mountPanel();
  }
  __name(rebuildPanel, "rebuildPanel");

  // src/post/votes.js
  async function favoritePost(id, remove) {
    const res = await fetch(`/public/addfav.php?id=${encodeURIComponent(id)}${remove ? "&toggle=1" : ""}`, { credentials: "same-origin" });
    const code = (await res.text()).trim().replace(/"/g, "");
    if (code === "3" || code === "1" || code === "4") {
      const fav = code !== "4";
      setMark("f", id, fav);
      favLookups.set(id, Promise.resolve(fav));
      afterFavorite(id, fav);
    }
    return { code, status: res.status };
  }
  __name(favoritePost, "favoritePost");
  async function upvotePost(id) {
    const res = await fetch(`/index.php?page=post&s=vote&id=${encodeURIComponent(id)}&type=up`, { credentials: "same-origin" });
    const score = parseInt(await res.text(), 10);
    if (!res.ok || !Number.isFinite(score)) return null;
    setMark("v", id, true);
    return score;
  }
  __name(upvotePost, "upvotePost");
  async function modalFavorite() {
    const id = postId(modal.link);
    const remove = modal.fav.classList.contains("on");
    try {
      const { code, status } = await favoritePost(id, remove);
      const res = { status };
      if (code === "3" || code === "1" || code === "4") {
        const fav = code !== "4";
        showFav(fav);
        flash(t(code === "3" ? "favAdded" : code === "1" ? "favAlready" : "favRemoved"));
        if (code === "3") modalUpvote(true);
      } else {
        flash(code === "2" ? t("favLogin") : `${t("favFail")} (${res.status} ${code.slice(0, 20)})`);
      }
      info(`modal: ${remove ? "unfavorite" : "favorite"} post ${id} -> ${code.slice(0, 20)}`);
    } catch (e) {
      flash(t("favFail"));
      warn(`modal: favorite failed — ${describeError(e)}`);
    }
  }
  __name(modalFavorite, "modalFavorite");
  function modalLike() {
    popHeart(modal.box, 110);
    if (modal.fav.classList.contains("on")) {
      dbg(`modal: double tap, post ${postId(modal.link)} already a favorite`);
      return;
    }
    modalFavorite();
  }
  __name(modalLike, "modalLike");
  function popHeart(parent, size) {
    const heart = el("div", { class: "ibh-likeheart", "data-ibh-ui": "", text: "❤️" });
    heart.style.fontSize = `${Math.round(size)}px`;
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    parent.appendChild(heart);
    heart.addEventListener("animationend", () => heart.remove(), { once: true });
    setTimeout(() => heart.remove(), 1500);
  }
  __name(popHeart, "popHeart");
  function centerDoubleTap() {
    if (CFG.doubleTapCenter === "like") {
      modalLike();
      return;
    }
    dbg("modal: double tap in the middle, fullscreen");
    toggleModalFullscreen();
  }
  __name(centerDoubleTap, "centerDoubleTap");
  async function modalUpvote(quiet) {
    quiet = quiet === true;
    const id = postId(modal.link);
    try {
      const res = await fetch(`/index.php?page=post&s=vote&id=${encodeURIComponent(id)}&type=up`, { credentials: "same-origin" });
      const score = parseInt(await res.text(), 10);
      if (res.ok && Number.isFinite(score)) {
        if (postId(modal.link) === id) {
          modal.score.textContent = String(score);
          modal.up.classList.add("on");
        }
        setMark("v", id, true);
        if (!quiet) flash(t("voted"));
      } else if (!quiet) {
        flash(`${t("voteFail")} (${res.status})`);
      }
      info(`modal: upvote post ${id} -> ${Number.isFinite(score) ? score : res.status}`);
    } catch (e) {
      flash(t("voteFail"));
      warn(`modal: upvote failed — ${describeError(e)}`);
    }
  }
  __name(modalUpvote, "modalUpvote");

  // src/modal/gestures.js
  function installModalSwipe(stage, video) {
    let start = null;
    stage.addEventListener("pointerdown", (ev) => {
      const r = video.hidden ? null : video.getBoundingClientRect();
      const onControls = r && ev.clientY > r.bottom - CONTROLS_BAND && ev.clientY <= r.bottom;
      start = onControls ? null : { x: ev.clientX, y: ev.clientY, t: Date.now(), top: stage.scrollTop };
    });
    stage.addEventListener("pointercancel", () => {
      start = null;
    });
    stage.addEventListener("pointerup", (ev) => {
      if (!start) return;
      if (zoom.scale > 1 || zoom.multi || videoPress.held) {
        start = null;
        return;
      }
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      const quick = Date.now() - start.t < 600;
      const wasAtTop = start.top <= 0;
      start = null;
      if (!quick) return;
      if (Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) stepModal(dx < 0 ? 1 : -1);
      else if (dy > 90 && dy > Math.abs(dx) * 1.5 && wasAtTop) closeModal(false);
    });
  }
  __name(installModalSwipe, "installModalSwipe");
  var zoom = { scale: 1, x: 0, y: 0, multi: false };
  var ZOOM_MAX = 6;
  function applyZoom() {
    const img = modal.image;
    img.style.transform = zoom.scale === 1 ? "" : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
    if (zoom.scale > 1 && modal.isSample && !modal.keepSample) loadModalOriginal();
    if (!img.hidden) modal.stage.style.touchAction = zoom.scale > 1 || !modal.stage.classList.contains("tall") ? "none" : "pan-y";
  }
  __name(applyZoom, "applyZoom");
  function resetZoom() {
    zoom.scale = 1;
    zoom.x = zoom.y = 0;
    if (modal) applyZoom();
  }
  __name(resetZoom, "resetZoom");
  var MODAL_HOLD_MS = 500;
  function installImageHold(stage, img, box) {
    let hold = null;
    let swallowUntil = 0;
    const cancel = /* @__PURE__ */ __name(() => {
      if (hold) clearTimeout(hold.timer);
      hold = null;
    }, "cancel");
    stage.addEventListener("touchstart", (ev) => {
      cancel();
      if (img.hidden || ev.touches.length !== 1 || !modal.sheet.hidden) return;
      const finger = ev.touches[0];
      hold = { x: finger.clientX, y: finger.clientY, scale: zoom.scale, timer: 0 };
      hold.timer = setTimeout(() => {
        if (!hold || zoom.scale !== hold.scale) {
          hold = null;
          return;
        }
        hold = null;
        swallowUntil = Date.now() + 800;
        if (navigator.vibrate) navigator.vibrate(15);
        toggleMenu();
        dbg("modal: image held, menu opened");
      }, MODAL_HOLD_MS);
    }, { passive: true });
    stage.addEventListener("touchmove", (ev) => {
      if (!hold) return;
      const finger = ev.touches[0];
      if (ev.touches.length > 1 || Math.hypot(finger.clientX - hold.x, finger.clientY - hold.y) > 12) cancel();
    }, { passive: true });
    stage.addEventListener("touchend", cancel);
    stage.addEventListener("touchcancel", cancel);
    img.addEventListener("contextmenu", (ev) => ev.preventDefault());
    box.addEventListener("click", (ev) => {
      if (Date.now() > swallowUntil) return;
      swallowUntil = 0;
      ev.stopPropagation();
      ev.preventDefault();
    }, true);
  }
  __name(installImageHold, "installImageHold");
  function installImageZoom(stage, img) {
    const pts = /* @__PURE__ */ new Map();
    let pinch = null;
    let pan = null;
    let lastTap = { t: 0, x: 0, y: 0 };
    const origin = /* @__PURE__ */ __name(() => {
      const r = img.getBoundingClientRect();
      return { left: r.left - zoom.x, top: r.top - zoom.y };
    }, "origin");
    const mid = /* @__PURE__ */ __name(() => {
      const [a, b] = [...pts.values()];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
    }, "mid");
    stage.addEventListener("pointerdown", (ev) => {
      if (img.hidden) return;
      pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, t: Date.now() });
      if (pts.size === 2) {
        zoom.multi = true;
        const m = mid();
        const o = origin();
        pinch = { d: m.d, scale: zoom.scale, cx: (m.x - o.left - zoom.x) / zoom.scale, cy: (m.y - o.top - zoom.y) / zoom.scale, o };
        pan = null;
      } else if (pts.size === 1 && zoom.scale > 1) {
        pan = { x: ev.clientX, y: ev.clientY, zx: zoom.x, zy: zoom.y };
      }
    });
    stage.addEventListener("pointermove", (ev) => {
      const p = pts.get(ev.pointerId);
      if (!p) return;
      p.x = ev.clientX;
      p.y = ev.clientY;
      if (pinch && pts.size >= 2) {
        const m = mid();
        zoom.scale = Math.min(ZOOM_MAX, Math.max(1, pinch.scale * (m.d / pinch.d)));
        zoom.x = m.x - pinch.o.left - pinch.cx * zoom.scale;
        zoom.y = m.y - pinch.o.top - pinch.cy * zoom.scale;
        applyZoom();
      } else if (pan) {
        zoom.x = pan.zx + (ev.clientX - pan.x);
        zoom.y = pan.zy + (ev.clientY - pan.y);
        applyZoom();
      }
    });
    const end = /* @__PURE__ */ __name((ev) => {
      const p = pts.get(ev.pointerId);
      pts.delete(ev.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) {
        pan = null;
        if (zoom.scale < 1.05) resetZoom();
        if (ev.type === "pointerup" && p && !zoom.multi && Date.now() - p.t < 250 && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 10) {
          const now = Date.now();
          if (now - lastTap.t < 300 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < 30) {
            if (zoom.scale > 1) resetZoom();
            else centerDoubleTap();
            lastTap.t = 0;
          } else {
            lastTap = { t: now, x: ev.clientX, y: ev.clientY };
            const tapAt = now;
            setTimeout(() => {
              if (lastTap.t === tapAt && modal.root.fullscreenElement) setCleanUi(!modal.box.classList.contains("clean"));
            }, 320);
          }
        }
        setTimeout(() => {
          zoom.multi = false;
        }, 0);
      }
    }, "end");
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
  }
  __name(installImageZoom, "installImageZoom");

  // src/modal/media.js
  function showVideo(candidates, hash, onMissing, onFound) {
    const vcached = cacheGet("video", hash);
    const urls = cachedFirst(candidates, vcached);
    const seq = modal.seq;
    markedCards("[data-ibh-cover]").forEach((card) => unmountCover(card));
    coverQueue.clear();
    modal.image.hidden = true;
    modal.video.hidden = false;
    modal.vwrap.hidden = false;
    modal.stage.classList.remove("tall");
    modal.stage.style.touchAction = "none";
    const v = modal.video;
    let i = 0;
    v.onerror = () => {
      if (i < urls.length) {
        v.src = urls[i++];
        return;
      }
      const missing = !(v.error && (v.error.code === 3 || v.error.code === 2));
      if (missing) cacheSet("video", hash, null);
      if (missing && onMissing && modal.seq === seq) {
        onMissing();
        return;
      }
      modal.status.textContent = t("mFail");
    };
    v.oncanplay = () => {
      modal.status.hidden = true;
      preloadAhead(seq);
    };
    v.onloadedmetadata = () => {
      cacheSet("video", hash, urls[i - 1], vcached);
      if (modal.seq === seq) modal.fileUrl = urls[i - 1];
      if (modal.seq === seq && CFG.playerButton) {
        modal.playerBtn.hidden = false;
        modal.appDlBtn.hidden = false;
        modal.appReduceBtn.hidden = !pastDecoder(v.videoWidth, v.videoHeight) && !(modal.link && modal.link.dataset.ibhBigVideo);
        if (!modal.appReduceBtn.hidden) flash(t("bigVideo"));
      }
      if (modal.seq === seq && !modal.sheet.hidden && modal.sheetTab === "info") renderInfo(modal.link, seq);
      fitFullscreenOrientation();
      if (onFound) onFound();
    };
    v.muted = false;
    v.src = urls[i++];
    const played = v.play();
    if (played && played.catch) {
      played.catch((e) => {
        if (e.name !== "NotAllowedError") return;
        dbg("modal: sound blocked by the autoplay policy, playing muted");
        v.muted = true;
        v.play().catch(() => {
        });
      });
    }
  }
  __name(showVideo, "showVideo");
  function raceImage(stages, cached, onWin, onFail, priority) {
    let done = false;
    const probes = [];
    const drop = /* @__PURE__ */ __name((keep) => probes.forEach((pr) => {
      if (pr !== keep) {
        pr.onload = pr.onerror = null;
        pr.removeAttribute("src");
      }
    }), "drop");
    const win = /* @__PURE__ */ __name((pr) => {
      if (done) return;
      done = true;
      drop(pr);
      onWin(pr);
    }, "win");
    const probe = /* @__PURE__ */ __name((url, onError) => {
      const pr = new Image();
      pr.decoding = "async";
      if (priority) pr.fetchPriority = priority;
      probes.push(pr);
      pr.onload = () => win(pr);
      pr.onerror = onError;
      pr.src = url;
    }, "probe");
    const runStage = /* @__PURE__ */ __name((i) => {
      if (done) return;
      const list = (stages[i] || []).filter((url) => url !== cached);
      if (i >= stages.length) {
        done = true;
        onFail();
        return;
      }
      if (!list.length) {
        runStage(i + 1);
        return;
      }
      let failed = 0;
      list.forEach((url) => probe(url, () => {
        if (++failed === list.length) runStage(i + 1);
      }));
    }, "runStage");
    if (typeof cached === "string") probe(cached, () => runStage(0));
    else runStage(0);
    return () => {
      done = true;
      drop(null);
    };
  }
  __name(raceImage, "raceImage");
  function knownOriginal(hash) {
    const orig = cacheGet("orig", hash);
    if (orig !== void 0) return orig;
    const page = cacheGet("sample", hash);
    return typeof page === "string" && page.includes("/images/") ? page : void 0;
  }
  __name(knownOriginal, "knownOriginal");
  var isSampleUrl = /* @__PURE__ */ __name((url) => /\/samples\//.test(url || ""), "isSampleUrl");
  function showImage(placeholder, candidates, kind, hash) {
    const stages = (
      /** @type {string[][]} */
      Array.isArray(candidates[0]) ? candidates : [candidates]
    );
    const icached = kind === "orig" ? knownOriginal(hash) : cacheGet(kind, hash);
    const seq = modal.seq;
    modal.video.hidden = true;
    modal.vwrap.hidden = true;
    fitFullscreenOrientation();
    modal.image.hidden = false;
    const img = modal.image;
    img.onload = fitImage;
    img.src = placeholder;
    modal.status.hidden = true;
    if (icached === null) return;
    modal.cancelLoad = raceImage(stages, icached, (probe) => {
      cacheSet(kind, hash, probe.src, icached);
      if (modal.seq !== seq) return;
      modal.fileUrl = probe.src;
      modal.isSample = isSampleUrl(probe.src);
      if (modal.isSample) {
        modal.sampleUrl = probe.src;
        setQuality("sample");
      }
      if (!modal.sheet.hidden && modal.sheetTab === "info") setTimeout(() => renderInfo(modal.link, seq), 50);
      const decoded = typeof probe.decode === "function" ? probe.decode().catch(() => {
      }) : Promise.resolve();
      decoded.then(() => {
        if (modal.seq !== seq) return;
        img.src = probe.src;
        if (kind === "gif") watchModalGif(img, probe.src, seq);
        preloadAhead(seq);
      });
    }, () => cacheSet(kind, hash, null), "high");
  }
  __name(showImage, "showImage");
  function setQuality(state) {
    const btn = modal && modal.quality;
    if (!btn) return;
    btn.hidden = !state;
    btn.textContent = state === "raw" ? "RAW" : state === "loading" ? "RAW…" : "SAMPLE";
    btn.classList.toggle("raw", state === "raw");
    btn.title = t(state === "raw" ? "qualRawTip" : "qualSampleTip");
  }
  __name(setQuality, "setQuality");
  function toggleQuality() {
    if (modal.isSample) {
      modal.keepSample = false;
      loadModalOriginal();
      return;
    }
    if (!modal.sampleUrl) return;
    modal.keepSample = true;
    modal.image.src = modal.sampleUrl;
    modal.fileUrl = modal.sampleUrl;
    modal.isSample = true;
    setQuality("sample");
    dbg("modal: back to the sample");
  }
  __name(toggleQuality, "toggleQuality");
  function loadModalOriginal() {
    if (!modal.isSample || modal.origPending) return;
    if (modal.rawUrl) {
      modal.image.src = modal.rawUrl;
      modal.fileUrl = modal.rawUrl;
      modal.isSample = false;
      setQuality("raw");
      return;
    }
    const link = modal.link;
    const pic = link && cardPicture(link);
    const parts = pic && thumbParts(pic.src);
    if (!parts) return;
    modal.origPending = true;
    const seq = modal.seq;
    const cached = knownOriginal(parts.hash);
    if (cached === null) return;
    flash(t("origLoading"));
    setQuality("loading");
    raceImage([fileCandidates(pic.src, ORIGINAL_EXTS)], cached, (probe) => {
      cacheSet("orig", parts.hash, probe.src, cached);
      if (modal.seq !== seq) return;
      const decoded = typeof probe.decode === "function" ? probe.decode().catch(() => {
      }) : Promise.resolve();
      decoded.then(() => {
        if (modal.seq !== seq) return;
        modal.image.src = probe.src;
        modal.fileUrl = probe.src;
        modal.rawUrl = probe.src;
        modal.isSample = false;
        modal.origPending = false;
        setQuality("raw");
        info(`modal: original loaded (${probe.src.split("/").pop()})`);
      });
    }, () => {
      cacheSet("orig", parts.hash, null);
      modal.origPending = false;
      if (modal.seq === seq) setQuality("sample");
    }, "high");
  }
  __name(loadModalOriginal, "loadModalOriginal");
  function onImageContent(ev) {
    const img = modal.image;
    if (!img.naturalWidth) return true;
    const r = img.getBoundingClientRect();
    const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    const left = r.left + (r.width - w) / 2;
    const top = r.top + (r.height - h) / 2;
    return ev.clientX >= left && ev.clientX <= left + w && ev.clientY >= top && ev.clientY <= top + h;
  }
  __name(onImageContent, "onImageContent");
  var COMIC_RATIO = 2.2;
  function fitImage() {
    const img = modal.image;
    if (img.hidden || !img.naturalWidth) return;
    const ratio = img.naturalHeight / img.naturalWidth;
    const stage = modal.stage;
    const tall = ratio > COMIC_RATIO && stage.clientWidth * ratio > stage.clientHeight;
    stage.classList.toggle("tall", tall);
    applyZoom();
  }
  __name(fitImage, "fitImage");
  function watchModalGif(img, url, seq) {
    let tries = 0;
    const check = /* @__PURE__ */ __name((ev) => {
      if (modal.seq !== seq) {
        img.removeEventListener("error", check);
        img.removeEventListener("load", check);
        return;
      }
      if (ev.type !== "error" && img.naturalWidth > 0) return;
      if (tries >= GIF_RETRIES) {
        warn("modal: gif still broken after rebuilding");
        return;
      }
      tries++;
      info(`modal: gif broken, rebuilding (try ${tries})`);
      img.removeAttribute("src");
      setTimeout(() => {
        if (modal.seq === seq) img.src = url;
      }, 400);
    }, "check");
    img.addEventListener("error", check);
    img.addEventListener("load", check);
  }
  __name(watchModalGif, "watchModalGif");
  function sniffVideo(src, link) {
    const seq = modal.seq;
    const hash = (thumbParts(src) || {}).hash;
    const known = cacheGet("video", hash);
    if (known === null) return;
    if (typeof known === "string") {
      info(`modal: post ${postId(link)} is an untagged video (cached)`);
      showVideo(fileCandidates(src, ["mp4", "webm"]), hash);
      return;
    }
    const urls = fileCandidates(src, ["mp4"]).slice(0, 2);
    if (!urls.length) return;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "metadata";
    let i = 0;
    const done = /* @__PURE__ */ __name(() => {
      v.onerror = v.onloadedmetadata = null;
      v.removeAttribute("src");
      v.load();
    }, "done");
    v.onerror = () => {
      const network = v.error && v.error.code === 2;
      if (i < urls.length) {
        v.src = urls[i++];
        return;
      }
      done();
      if (!network) cacheSet("video", hash, null);
    };
    v.onloadedmetadata = () => {
      cacheSet("video", hash, urls[i - 1]);
      done();
      if (modal.seq !== seq || !modal.open) return;
      info(`modal: post ${postId(link)} is an untagged video`);
      showVideo(fileCandidates(src, ["mp4", "webm"]), hash);
    };
    v.src = urls[i++];
  }
  __name(sniffVideo, "sniffVideo");
  var postId = /* @__PURE__ */ __name((link) => (String(
    /** @type {HTMLAnchorElement} */
    link.href || ""
  ).match(/id=(\d+)/) || [])[1] || "?", "postId");
  function ambiguousAnimated(link) {
    if (link.querySelector("img.webm-thumb")) return false;
    const tags = nativeTags(link);
    return /\sanimated\s/i.test(tags) && !NATIVE_REAL_VIDEO.test(tags) && !NATIVE_GIF.test(tags);
  }
  __name(ambiguousAnimated, "ambiguousAnimated");
  function raceVideoAndGif(link, thumb, pic, hash, asGif) {
    const seq = modal.seq;
    let settled = false;
    const probe = new Image();
    const gifs = cachedFirst(fileCandidates(pic.src, ["gif"]), cacheGet("gif", hash));
    let i = 0;
    const stopProbe = /* @__PURE__ */ __name(() => {
      probe.onload = probe.onerror = null;
      probe.removeAttribute("src");
    }, "stopProbe");
    probe.onerror = () => {
      if (!settled && i < gifs.length) probe.src = gifs[i++];
    };
    probe.onload = () => {
      if (settled || modal.seq !== seq) return;
      settled = true;
      cacheSet("gif", hash, probe.src);
      cacheSet("video", hash, null);
      const v = modal.video;
      v.onerror = v.oncanplay = v.onloadedmetadata = null;
      v.pause();
      v.removeAttribute("src");
      v.load();
      link.dataset.ibhKind = "gif";
      info(`modal: post ${postId(link)} is a GIF (answered before the video)`);
      showImage(thumb.currentSrc || pic.src, [probe.src], "gif", hash);
      stopProbe();
    };
    showVideo(
      fileCandidates(pic.src, ["mp4", "webm"]),
      hash,
      () => {
        if (!settled) {
          settled = true;
          stopProbe();
          asGif();
        }
      },
      () => {
        if (!settled) {
          settled = true;
          stopProbe();
        }
      }
    );
    if (gifs.length) probe.src = gifs[i++];
  }
  __name(raceVideoAndGif, "raceVideoAndGif");

  // src/modal/tags.js
  var TAG_ORDER = ["artist", "character", "copyright", "general", "metadata"];
  var tagRank = /* @__PURE__ */ __name((type) => {
    const i = TAG_ORDER.indexOf(type);
    return i < 0 ? TAG_ORDER.length : i;
  }, "tagRank");
  function thumbTags(link) {
    return nativeTags(link).trim().split(/\s+/).filter((name) => name && !/^(score|rating):/i.test(name)).map((name) => ({ name, type: "general" }));
  }
  __name(thumbTags, "thumbTags");
  function toggleMenu() {
    const open = (
      /** @type {boolean} */
      modal.sheet.hidden
    );
    modal.sheet.hidden = !open;
    modal.menu.classList.toggle("on", open);
    if (open) renderSheet(modal.link, modal.seq);
  }
  __name(toggleMenu, "toggleMenu");
  function renderSheet(link, seq) {
    if (modal.sheetTab === "info") renderInfo(link, seq);
    else if (modal.sheetTab === "comments") renderComments(link, seq);
    else renderTags(link, seq);
  }
  __name(renderSheet, "renderSheet");
  function markTab(tab) {
    modal.sheetTab = tab;
    modal.tabTags.classList.toggle("on", tab === "tags");
    modal.tabInfo.classList.toggle("on", tab === "info");
    modal.tabComments.classList.toggle("on", tab === "comments");
    modal.tagList.hidden = tab !== "tags";
    modal.infoList.hidden = tab !== "info";
    modal.commentList.hidden = tab !== "comments";
  }
  __name(markTab, "markTab");
  function showTab(tab) {
    markTab(tab);
    renderSheet(modal.link, modal.seq);
  }
  __name(showTab, "showTab");
  function toggleInfo() {
    const open = !modal.sheet.hidden;
    if (open && modal.sheetTab === "info") toggleMenu();
    else if (open) showTab("info");
    else {
      markTab("info");
      toggleMenu();
    }
    dbg(`modal: info ${modal.sheet.hidden ? "closed" : "opened"} from the player`);
  }
  __name(toggleInfo, "toggleInfo");
  async function renderComments(link, seq) {
    modal.commentList.replaceChildren(el("div", { class: "none", text: t("infoLoading") }));
    const info2 = await postInfo(postId(link));
    if (modal.seq !== seq || modal.sheetTab !== "comments") return;
    const page = info2 && info2.comments || { list: [], total: 0, next: null };
    modal.tabComments.textContent = `${t("tabComments")} (${page.total})`;
    modal.commentList.replaceChildren();
    if (!page.total) {
      modal.commentList.append(el("div", { class: "none", text: t("commentsNone") }));
      return;
    }
    appendComments(page, seq);
    dbg(`modal: ${page.total} comments for post ${postId(link)}`);
  }
  __name(renderComments, "renderComments");
  async function voteComment(c, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const url = `/index.php?page=comment&id=${encodeURIComponent(postId(modal.link))}&s=vote&cid=${encodeURIComponent(c.id)}&vote=up`;
      const res = await fetch(url, { credentials: "same-origin" });
      const score = parseInt(await res.text(), 10);
      if (!res.ok || !Number.isFinite(score)) throw new Error(`HTTP ${res.status}`);
      c.score = score;
      btn.textContent = `▲ ${score}`;
      btn.classList.add("on");
      setMark("c", c.id, true);
      info(`modal: comment ${c.id} upvoted -> ${score}`);
    } catch (e) {
      flash(t("voteFail"));
      warn(`modal: comment vote failed — ${describeError(e)}`);
    } finally {
      btn.disabled = false;
    }
  }
  __name(voteComment, "voteComment");
  function appendComments(page, seq) {
    const cookie = readCookie("comment_threshold");
    const threshold = cookie === null ? NaN : Number(cookie);
    const shown = Number.isFinite(threshold) ? page.list.filter((c) => c.score >= threshold) : page.list;
    modal.commentList.append(...shown.map((c) => {
      const who = c.profile ? el("a", { class: "who", href: c.profile, target: "_blank", rel: "noopener", text: c.user || "?" }) : el("b", { text: c.user || "?" });
      const up = el("button", { class: "cvote", text: `▲ ${c.score}` });
      up.classList.toggle("on", hasMark("c", c.id));
      up.addEventListener("click", () => voteComment(c, up));
      return el("div", { class: "cm" }, [
        el("div", { class: "h" }, [who, ` · ${c.date} `, up]),
        el("div", { class: "b", text: c.text })
      ]);
    }));
    if (shown.length < page.list.length) {
      modal.commentList.append(el("div", { class: "none", text: `${page.list.length - shown.length} ${t("commentsHidden")}` }));
    }
    if (!page.next) return;
    const more = el("button", { class: "pill", text: t("commentsMore") });
    more.addEventListener("click", async () => {
      more.disabled = true;
      more.textContent = t("infoLoading");
      try {
        const res = await fetch(
          /** @type {string} */
          page.next,
          { credentials: "same-origin" }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = readComments(
          new DOMParser().parseFromString(await res.text(), "text/html"),
          /** @type {string} */
          page.next
        );
        if (modal.seq !== seq || modal.sheetTab !== "comments") return;
        more.remove();
        appendComments(next, seq);
      } catch (e) {
        more.disabled = false;
        more.textContent = t("commentsMore");
        warn(`modal: more comments failed — ${describeError(e)}`);
      }
    });
    modal.commentList.append(more);
  }
  __name(appendComments, "appendComments");
  async function renderInfo(link, seq) {
    const v = modal.video;
    const img = modal.image;
    const video = !v.hidden;
    const url = modal.fileUrl;
    const rows = [];
    const kind = video ? t("kindVideo") : /\.gif(\?|$)/i.test(url || "") ? t("kindGif") : t("kindImage");
    rows.push([t("infoKind"), kind]);
    const w = video ? v.videoWidth : url ? img.naturalWidth : 0;
    const h = video ? v.videoHeight : url ? img.naturalHeight : 0;
    rows.push([t("infoRes"), w && h ? `${w} × ${h}` : t("infoLoading")]);
    if (video && w && h && pastDecoder(w, h)) rows.push(["", t("infoAbove"), true]);
    rows.push([t("infoFormat"), url ? `${((url.split(/[?#]/)[0].match(/\.(\w+)$/) || [])[1] || "?").toUpperCase()}${modal.isSample ? ` (${t("infoSample")})` : ""}` : t("infoLoading")]);
    if (video) rows.push([t("infoDuration"), Number.isFinite(v.duration) ? mmss(v.duration) : t("infoLoading")]);
    if (video && typeof v.getVideoPlaybackQuality === "function") {
      const q = v.getVideoPlaybackQuality();
      if (q.totalVideoFrames >= 30) {
        const pct = Math.round(q.droppedVideoFrames / q.totalVideoFrames * 100);
        rows.push([t("infoDrops"), `${pct}% (${q.droppedVideoFrames} ${t("infoDropsOf")} ${q.totalVideoFrames})`, pct >= 10]);
      }
    }
    if (modal.seq !== seq || modal.sheetTab !== "info") return;
    fillInfo(rows, []);
    const info2 = await postInfo(postId(link));
    if (modal.seq !== seq || modal.sheetTab !== "info" || !info2 || !info2.stats) return;
    fillInfo(rows, info2.stats);
  }
  __name(renderInfo, "renderInfo");
  function fillInfo(rows, stats) {
    const cells = [];
    for (const [k, value, warn2] of rows) cells.push(el("span", { class: "k", text: k }), el("span", { class: warn2 ? "v warn" : "v", text: value }));
    for (const st of stats) {
      const m = st.text.match(/^([^:]{1,20}):\s*(.*)$/);
      const k = m ? m[1] : "";
      const value = m ? m[2] : st.text;
      const cell = st.href ? el("span", { class: "v" }, [el("a", { href: st.href, target: "_blank", rel: "noopener", text: value })]) : el("span", { class: "v", text: value });
      cells.push(el("span", { class: "k", text: k }), cell);
    }
    modal.infoList.replaceChildren(...cells);
  }
  __name(fillInfo, "fillInfo");
  function closeMenu() {
    modal.sheet.hidden = true;
    modal.menu.classList.remove("on");
  }
  __name(closeMenu, "closeMenu");
  function renderTags(link, seq) {
    fillTags(thumbTags(link));
    postInfo(postId(link)).then((info2) => {
      if (!info2 || !info2.tags.length || modal.seq !== seq || modal.sheet.hidden) return;
      fillTags(info2.tags);
      dbg(`modal: tags menu, ${info2.tags.length} tags from the post page`);
    });
  }
  __name(renderTags, "renderTags");
  function fillTags(tags) {
    const sorted = [...tags].sort((a, b) => tagRank(a.type) - tagRank(b.type));
    modal.tagList.replaceChildren(...sorted.map((tag) => {
      const chip = el("button", { class: `tag t-${tag.type}`, text: tag.name });
      chipGestures(chip, tagSearchUrl(tag.name), () => copyText(tag.name, chip));
      return chip;
    }));
    if (!sorted.length) modal.tagList.append(el("span", { class: "none", text: t("tagsNone") }));
  }
  __name(fillTags, "fillTags");
  var TAG_HOLD_MS = 450;
  var tagSearchUrl = /* @__PURE__ */ __name((name) => `/index.php?page=post&s=list&tags=${encodeURIComponent(name)}`, "tagSearchUrl");
  var HOLD_SLOP = 12;
  function chipGestures(chip, url, onTap, what = "tag search") {
    let down = null;
    let skipClick = false;
    const reset = /* @__PURE__ */ __name(() => {
      if (down) clearTimeout(down.timer);
      down = null;
      chip.classList.remove("held");
    }, "reset");
    const start = /* @__PURE__ */ __name((x, y) => {
      skipClick = false;
      down = { x, y, t: Date.now(), scroll: modal.sheet.scrollTop, timer: setTimeout(() => chip.classList.add("held"), TAG_HOLD_MS) };
    }, "start");
    const moved = /* @__PURE__ */ __name((x, y) => down && Math.hypot(x - down.x, y - down.y) > HOLD_SLOP, "moved");
    const finish = /* @__PURE__ */ __name((ev) => {
      if (!down) return;
      const held = Date.now() - down.t >= TAG_HOLD_MS && Math.abs(modal.sheet.scrollTop - down.scroll) < HOLD_SLOP;
      reset();
      if (!held) return;
      skipClick = true;
      if (ev.cancelable) ev.preventDefault();
      const href = typeof url === "function" ? url() : url;
      if (!href) {
        flash(t("dlWait"));
        return;
      }
      window.open(href, "_blank", "noopener");
      flash(t("tagOpened"));
      dbg(`modal: ${what} opened in a new tab (${href})`);
    }, "finish");
    chip.addEventListener("touchstart", (ev) => start(ev.touches[0].clientX, ev.touches[0].clientY), { passive: true });
    chip.addEventListener("touchmove", (ev) => {
      if (moved(ev.touches[0].clientX, ev.touches[0].clientY)) reset();
    }, { passive: true });
    chip.addEventListener("touchend", finish);
    chip.addEventListener("touchcancel", reset);
    chip.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType === "mouse") start(ev.clientX, ev.clientY);
    });
    chip.addEventListener("pointermove", (ev) => {
      if (ev.pointerType === "mouse" && moved(ev.clientX, ev.clientY)) reset();
    });
    chip.addEventListener("pointerup", (ev) => {
      if (ev.pointerType === "mouse") finish(ev);
    });
    chip.addEventListener("contextmenu", (ev) => ev.preventDefault());
    chip.addEventListener("click", () => {
      if (skipClick) {
        skipClick = false;
        return;
      }
      onTap();
    });
  }
  __name(chipGestures, "chipGestures");
  async function copyText(text, chip) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      const field = document.createElement("textarea");
      field.value = text;
      field.style.cssText = "position:fixed;opacity:0";
      document.documentElement.appendChild(field);
      field.select();
      try {
        ok = document.execCommand("copy");
      } catch (e2) {
      }
      field.remove();
    }
    flash(ok ? `${t("tagCopied")}: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}` : t("tagCopyFail"));
    if (ok) {
      chip.classList.add("copied");
      setTimeout(() => chip.classList.remove("copied"), 600);
    }
    dbg(`modal: copy ${ok ? "done" : "failed"} (${text.length} chars)`);
  }
  __name(copyText, "copyText");
  function showFav(on) {
    modal.fav.textContent = on ? "♥" : "♡";
    modal.fav.classList.toggle("on", on);
    setIcon(modal.vfav, on ? PLAYER_ICON.heart : PLAYER_ICON.heartLine);
    modal.vfav.classList.toggle("on", on);
  }
  __name(showFav, "showFav");
  function applyMarks(link, seq) {
    const id = postId(link);
    const own = onOwnFavorites();
    if (own) setMark("f", id, true);
    const show = /* @__PURE__ */ __name((fav) => {
      showFav(fav);
      modal.up.classList.toggle("on", fav || hasMark("v", id));
    }, "show");
    show(own || hasMark("f", id));
    if (own) return;
    lookUpFavorite(id).then((fav) => {
      if (fav !== null && modal.open && modal.seq === seq) show(fav);
    });
  }
  __name(applyMarks, "applyMarks");
  function onSiteVoteClick(ev) {
    const a = asElement(ev.target)?.closest('a[onclick*="post_vote("]');
    const m = a && /** @type {string} */
    a.getAttribute("onclick").match(/post_vote\('(\d+)',\s*'up'\)/);
    if (m) setMark("v", m[1], true);
  }
  __name(onSiteVoteClick, "onSiteVoteClick");

  // src/search/suggest.js
  var SUGGEST_MS = 200;
  var suggesting = /* @__PURE__ */ new WeakSet();
  async function fetchSuggestions(term) {
    const res = await fetch(PROFILE.suggest + encodeURIComponent(term), { credentials: "same-origin" });
    const list = await res.json();
    return (Array.isArray(list) ? list : []).slice(0, 10).flatMap((x) => {
      const count = /\((\d+)\)\s*$/.exec(x.label || "");
      return x.value ? [{ value: String(x.value), count: Number(x.post_count ?? (count ? count[1] : 0)) || 0, kind: String(x.category || x.type || "") }] : [];
    });
  }
  __name(fetchSuggestions, "fetchSuggestions");
  function attachSuggest(input) {
    if (!CFG.searchSuggest || suggesting.has(input)) return;
    suggesting.add(input);
    const box = el("ul", { class: "ibh-suggest", "data-ibh-ui": "" });
    box.hidden = true;
    let timer = 0;
    let seq = 0;
    const close = /* @__PURE__ */ __name(() => {
      seq++;
      box.hidden = true;
    }, "close");
    const word = /* @__PURE__ */ __name(() => {
      const token = /\S*$/.exec(input.value)?.[0] ?? "";
      const m = /^(\|\||[-~]?)(.*)$/.exec(token) ?? ["", "", ""];
      return { token, prefix: m[1] ?? "", term: (m[2] ?? "").replace(/\*+$/, "") };
    }, "word");
    const show = /* @__PURE__ */ __name((items) => {
      if (!items.length) {
        close();
        return;
      }
      if (!box.isConnected) input.parentElement?.appendChild(box);
      box.style.left = `${input.offsetLeft}px`;
      box.style.top = `${input.offsetTop + input.offsetHeight + 2}px`;
      box.style.width = `${input.offsetWidth}px`;
      box.replaceChildren(...items.map((it) => el("li", { "data-value": it.value, "data-ibh-ui": "", class: it.kind ? `k-${it.kind}` : "" }, [
        el("span", { text: it.value.replace(/_/g, " "), "data-ibh-ui": "" }),
        el("small", { text: it.count ? it.count.toLocaleString() : "", "data-ibh-ui": "" })
      ])));
      box.hidden = false;
    }, "show");
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const { term } = word();
      if (term.length < 2) {
        close();
        return;
      }
      timer = setTimeout(() => {
        const mine = ++seq;
        fetchSuggestions(term).then((items) => {
          if (mine !== seq) return;
          dbg(`search: ${items.length} suggestions for "${term}"`);
          show(items);
        }, (e) => {
          if (mine === seq) {
            dbg(`search: no suggestions for "${term}" (${describeError(e)})`);
            close();
          }
        });
      }, SUGGEST_MS);
    });
    const pick = /* @__PURE__ */ __name((li) => {
      const { token, prefix } = word();
      input.value = `${input.value.slice(0, input.value.length - token.length)}${prefix}${li.dataset.value} `;
      close();
      input.focus();
      dbg(`search: suggestion "${li.dataset.value}" picked`);
    }, "pick");
    const itemAt = /* @__PURE__ */ __name((ev) => asElement(ev.target)?.closest("li"), "itemAt");
    let finger = null;
    let touchedAt = 0;
    box.addEventListener("touchstart", (ev) => {
      const t2 = ev.touches[0];
      touchedAt = Date.now();
      finger = ev.touches.length === 1 ? { x: t2.clientX, y: t2.clientY, top: box.scrollTop } : null;
    }, { passive: true });
    box.addEventListener("touchmove", (ev) => {
      const t2 = ev.touches[0];
      if (finger && Math.hypot(t2.clientX - finger.x, t2.clientY - finger.y) > HOLD_SLOP) finger = null;
    }, { passive: true });
    box.addEventListener("touchcancel", () => {
      finger = null;
    });
    box.addEventListener("touchend", (ev) => {
      const li = itemAt(ev);
      const still = finger && Math.abs(box.scrollTop - finger.top) < HOLD_SLOP;
      finger = null;
      if (!li || !still) return;
      ev.preventDefault();
      pick(li);
    });
    box.addEventListener("mousedown", (ev) => ev.preventDefault());
    box.addEventListener("click", (ev) => {
      const li = itemAt(ev);
      if (li && Date.now() - touchedAt > 800) pick(li);
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") close();
    });
  }
  __name(attachSuggest, "attachSuggest");
  var orTags = /* @__PURE__ */ __name((text) => String(text || "").trim().split(/[\s~()]+/).filter(Boolean), "orTags");
  var orGroups = /* @__PURE__ */ __name((text) => String(text || "").split("||").map(orTags).filter((g) => g.length), "orGroups");
  function minScoreInput() {
    const min = el("input", { class: "min", type: "number", min: "0", step: "1", inputmode: "numeric", placeholder: t("minScore") });
    min.title = t("minScore");
    return min;
  }
  __name(minScoreInput, "minScoreInput");
  function kindSelect() {
    const kind = el("select", { class: "kind" });
    for (const [value, label] of [
      ["all", t("favKindAll")],
      ["image", t("favKindImage")],
      ["video", t("favKindVideo")],
      ["gif", t("favKindGif")],
      ["animated", t("favKindAnimated")]
    ]) {
      kind.appendChild(el("option", { value, text: label }));
    }
    return kind;
  }
  __name(kindSelect, "kindSelect");

  // src/lists/favorites.js
  var FAV_PAGE = 50;
  var FAV_SHOW = 60;
  var FAV_GAP_MS = 250;
  var FAV_STALE_MS = 10 * 60 * 1e3;
  var FAV_SAVE_MS = 5e3;
  var favIndex = null;
  var favEntries = null;
  function setFavEntries(v) {
    favEntries = v;
  }
  __name(setFavEntries, "setFavEntries");
  var favScan = null;
  var favPage = null;
  var favResults = [];
  var favShown = 0;
  var favBarSync = null;
  var favBarReload = null;
  var favFields = /* @__PURE__ */ __name((bar) => ({
    text: (
      /** @type {HTMLInputElement} */
      bar.querySelector('input[type="search"]')
    ),
    or: (
      /** @type {HTMLInputElement} */
      bar.querySelector("input.or")
    ),
    kind: (
      /** @type {HTMLSelectElement} */
      bar.querySelector("select.kind")
    ),
    sort: (
      /** @type {HTMLSelectElement} */
      bar.querySelector("select.sort")
    ),
    min: (
      /** @type {HTMLInputElement} */
      bar.querySelector("input.min")
    )
  }), "favFields");
  async function rememberFavSearch(active) {
    const bar = document.getElementById("ibh-favsearch");
    if (!bar) return;
    const store = await searchStore();
    const f = favFields(bar);
    store.favLast = { text: f.text.value, or: f.or.value, kind: f.kind.value, sort: f.sort.value, min: f.min.value, active };
    if (active) addRecent(store, { where: "fav", ...store.favLast, active: void 0 });
    await storeSet("searches", store);
    if (active && favBarReload) favBarReload();
  }
  __name(rememberFavSearch, "rememberFavSearch");
  async function favsGet() {
    const saved = await idbGet("favs");
    if (saved === void 0) return storeGet("favs");
    if (saved || !GM_STORE) return saved;
    const old = await storeGet("favs");
    if (old && await idbSet("favs", old)) {
      await storeSet("favs", null);
      info(`favorites: index moved from GM storage to IndexedDB (${old.items.length} favorites)`);
    }
    return old;
  }
  __name(favsGet, "favsGet");
  async function favsSet(idx) {
    if (!await idbSet("favs", idx)) await storeSet("favs", idx);
  }
  __name(favsSet, "favsSet");
  async function loadFavIndex() {
    if (favIndex && favIndex.user === userId()) return favIndex;
    const saved = await favsGet();
    if (favIndex && favIndex.user === userId()) return favIndex;
    favIndex = saved && saved.user === userId() ? saved : { user: userId(), updated: 0, items: [] };
    favEntries = null;
    return favIndex;
  }
  __name(loadFavIndex, "loadFavIndex");
  async function readFavPage(pid) {
    const res = await fetch(`/index.php?page=favorites&s=view&id=${userId()}&pid=${pid}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const scores = /* @__PURE__ */ new Map();
    for (const m of html.matchAll(/posts\[(\d+)\]\s*=\s*\{[^}]*?score['"]?\s*:\s*['"]?(-?\d+)/g)) scores.set(m[1], Number(m[2]));
    const doc = new DOMParser().parseFromString(html, "text/html");
    return [...doc.querySelectorAll(".thumb img[src]")].map((img) => {
      const a = img.closest("a");
      const src = (
        /** @type {string} */
        img.getAttribute("src")
      );
      const id = (a && a.getAttribute("href") || "").match(/id=(\d+)/)?.[1] || (src.split("?")[1] || "");
      return (
        /** @type {FavItem} */
        [id, src, (img.getAttribute("title") || img.getAttribute("alt") || "").trim(), scores.has(id) ? scores.get(id) : null]
      );
    }).filter((item) => /^\d+$/.test(item[0]));
  }
  __name(readFavPage, "readFavPage");
  function updateFavIndex(full) {
    if (favScan) return favScan;
    favScan = (async () => {
      const idx = await loadFavIndex();
      if (full || !idx.items.length && idx.next === void 0) Object.assign(idx, { items: [], next: 0, updated: 0 });
      const before = idx.items.length;
      const known = new Set(idx.items.map((item) => item[0]));
      const unknown = /* @__PURE__ */ __name((items) => {
        const added = items.filter((item) => !known.has(item[0]));
        added.forEach((item) => known.add(item[0]));
        return added;
      }, "unknown");
      const read = /* @__PURE__ */ __name(async (pid) => {
        setFavStatus(`${t("favScanning")} ${Math.floor(pid / FAV_PAGE) + 1}…`);
        for (let tries = 0; ; tries++) {
          try {
            return await readFavPage(pid);
          } catch (e) {
            if (tries >= 2) throw e;
            await new Promise((r) => setTimeout(r, 1e3 * (tries + 1)));
          }
        }
      }, "read");
      let saved = Date.now();
      try {
        if (idx.items.length) {
          const top = [];
          for (let pid = 0; ; pid += FAV_PAGE) {
            const items = await read(pid);
            const added = unknown(items);
            top.push(...added);
            if (!items.length || added.length < items.length) break;
            await new Promise((r) => setTimeout(r, FAV_GAP_MS));
          }
          idx.items = [...top, ...idx.items];
        }
        while (idx.next !== void 0) {
          const items = await read(idx.next);
          if (!items.length) {
            delete idx.next;
            break;
          }
          idx.items.push(...unknown(items));
          idx.next += FAV_PAGE;
          favEntries = null;
          if (Date.now() - saved > FAV_SAVE_MS) {
            await favsSet(idx);
            saved = Date.now();
          }
          await new Promise((r) => setTimeout(r, FAV_GAP_MS));
        }
      } catch (e) {
        warn(`favorites: ${t("favScanFail")} — ${describeError(e)}`);
        setFavStatus(t("favScanFail"));
        if (idx.next !== void 0) await favsSet(idx);
        return null;
      } finally {
        favScan = null;
      }
      idx.updated = Date.now();
      favEntries = null;
      await favsSet(idx);
      info(`favorites: index ${full ? "rebuilt" : "updated"}, ${idx.items.length - before} new, ${idx.items.length} in all`);
      setFavStatus();
      return idx;
    })();
    return favScan;
  }
  __name(updateFavIndex, "updateFavIndex");
  function favMatcher(word) {
    const score = word.match(/^score:(>=|<=|>|<|=)?(-?\d+)$/);
    if (score) {
      const n = Number(score[2]);
      const op = score[1] || ">=";
      return (e) => e.score != null && (op === ">" ? e.score > n : op === "<" ? e.score < n : op === "<=" ? e.score <= n : op === "=" ? e.score === n : e.score >= n);
    }
    if (word.includes("*")) {
      const re = new RegExp(`^${word.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      return (e) => e.tags.some((tag) => re.test(tag));
    }
    return (e) => e.set.has(word);
  }
  __name(favMatcher, "favMatcher");
  function favQuery(text) {
    const words = text.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const groups = [];
    words.forEach((word, i) => {
      if (word === "~") return;
      const neg = word.startsWith("-") && word.length > 1;
      const matcher = favMatcher(neg ? word.slice(1) : word);
      if (!neg && words[i - 1] === "~" && groups.length && !groups[groups.length - 1].neg) groups[groups.length - 1].any.push(matcher);
      else groups.push({ neg, any: [matcher] });
    });
    return (e) => groups.every((g) => g.any.some((m) => m(e)) !== g.neg);
  }
  __name(favQuery, "favQuery");
  async function searchFavs() {
    const bar = document.getElementById("ibh-favsearch");
    if (!bar) return;
    const fields = favFields(bar);
    const either = orGroups(fields.or.value).map((g) => g.join(" ~ "));
    const text = `${fields.text.value} ${either.join(" ")}`.trim();
    let idx = await loadFavIndex();
    if (!idx.items.length) idx = await updateFavIndex(true) || idx;
    else if (idx.next !== void 0 || Date.now() - idx.updated > FAV_STALE_MS) {
      const had = idx.items.length;
      const partial = idx.next !== void 0;
      updateFavIndex(false).then((fresh) => {
        if (fresh && !partial && fresh.items.length > had && favPage && bar.isConnected) searchFavs();
      });
    }
    if (!bar.isConnected) {
      info("favorites search: the bar went while the index loaded");
      return;
    }
    if (!favEntries) {
      favEntries = idx.items.map(([id, thumb, tags, score]) => {
        const list = tags.toLowerCase().split(/\s+/);
        const spaced = ` ${tags} `;
        const video = NATIVE_REAL_VIDEO.test(spaced);
        const gif = NATIVE_GIF.test(spaced);
        const animated = video || gif || /\sanimated\s/i.test(spaced);
        return { item: [id, thumb, tags], tags: list, set: new Set(list), score, video, gif, animated };
      });
    }
    const match = favQuery(text);
    const kind = fields.kind.value;
    const ofKind = /* @__PURE__ */ __name((e) => kind === "all" || (kind === "image" ? !e.animated : e[
      /** @type {'video' | 'gif' | 'animated'} */
      kind
    ]), "ofKind");
    const min = Number(fields.min.value) || 0;
    let found = favEntries.filter((e) => ofKind(e) && (!min || e.score != null && e.score >= min) && match(e));
    const sort = fields.sort.value;
    if (sort === "old") found = found.reverse();
    else if (sort === "score") found = [...found].sort((a, b) => (b.score ?? -1e9) - (a.score ?? -1e9));
    else if (sort === "random") found = found.map((e) => (
      /** @type {[number, FavEntry]} */
      [Math.random(), e]
    )).sort((a, b) => a[0] - b[0]).map((pair) => pair[1]);
    showFavResults(found.map((e) => e.item));
    rememberFavSearch(true);
    if (favBarSync) favBarSync();
    info(`favorites: "${text.trim()}" (${kind}, ${sort}${min ? `, score >= ${min}` : ""}) -> ${found.length} of ${favEntries.length}`);
  }
  __name(searchFavs, "searchFavs");
  function favThumb([id, thumb, tags]) {
    const span = document.createElement("span");
    span.className = "thumb";
    span.id = `s${id}`;
    const a = document.createElement("a");
    a.id = `p${id}`;
    a.href = `index.php?page=post&s=view&id=${id}`;
    const img = document.createElement("img");
    img.src = thumb;
    img.title = img.alt = tags;
    img.className = "preview";
    a.appendChild(img);
    span.appendChild(a);
    return span;
  }
  __name(favThumb, "favThumb");
  var sitePaginators = /* @__PURE__ */ __name(() => (
    /** @type {NodeListOf<HTMLElement>} */
    document.querySelectorAll("#paginator, .pagination")
  ), "sitePaginators");
  function showFavResults(items) {
    const list = document.querySelector(LIST);
    if (!list) return;
    if (!favPage) favPage = [...list.childNodes];
    favResults = items;
    favShown = 0;
    list.replaceChildren();
    sitePaginators().forEach((p) => {
      p.style.display = "none";
    });
    showMoreFavs();
    window.scrollTo({ top: list.getBoundingClientRect().top + window.scrollY - 80 });
  }
  __name(showFavResults, "showFavResults");
  function showMoreFavs() {
    const list = document.querySelector(LIST);
    if (!list) return;
    const next = favResults.slice(favShown, favShown + FAV_SHOW);
    list.append(...next.map(favThumb));
    favShown += next.length;
    const more = (
      /** @type {HTMLElement} */
      document.getElementById("ibh-favmore")
    );
    more.hidden = favShown >= favResults.length;
    more.textContent = `${t("favMore")} (${favResults.length - favShown})`;
    setFavStatus(`${favResults.length} ${t("favResults")}`);
  }
  __name(showMoreFavs, "showMoreFavs");
  function clearFavSearch() {
    const list = document.querySelector(LIST);
    if (list && favPage) list.replaceChildren(...favPage);
    favPage = null;
    favResults = [];
    sitePaginators().forEach((p) => {
      p.style.display = "";
    });
    const more = document.getElementById("ibh-favmore");
    if (more) more.hidden = true;
    const bar = document.getElementById("ibh-favsearch");
    if (bar) {
      const f = favFields(bar);
      f.text.value = "";
      f.or.value = "";
    }
    rememberFavSearch(false);
    if (favBarSync) favBarSync();
    setFavStatus();
  }
  __name(clearFavSearch, "clearFavSearch");
  function setFavStatus(text) {
    const st = document.querySelector("#ibh-favsearch .st");
    if (!st) return;
    const line = (
      /** @type {Text} */
      st.firstChild
    );
    if (text) {
      line.textContent = text;
      return;
    }
    const idx = favIndex;
    line.textContent = idx && idx.items.length ? `${idx.items.length} ${t("favIndexed")} · ${idx.next !== void 0 ? t("favPartial") : new Date(idx.updated).toLocaleString(LANG)}` : t("favNever");
  }
  __name(setFavStatus, "setFavStatus");
  function ensureFavSearch() {
    const bar = document.getElementById("ibh-favsearch");
    const want = CFG.favSearch && SITE === "rule34.xxx" && onOwnFavorites() && !!document.querySelector(LIST);
    if (!want) {
      if (bar) {
        clearFavSearch();
        bar.remove();
        document.getElementById("ibh-favmore")?.remove();
      }
      return;
    }
    if (bar) return;
    const list = (
      /** @type {Element} */
      document.querySelector(LIST)
    );
    const input = el("input", { type: "search", placeholder: t("favPlaceholder"), enterkeyhint: "search" });
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocomplete", "off");
    attachSuggest(input);
    const or = orInput();
    const kind = kindSelect();
    const sort = el("select", { class: "sort" });
    for (const [value, label] of [["new", t("favSortNew")], ["old", t("favSortOld")], ["score", t("favSortScore")], ["random", t("favSortRandom")]]) {
      sort.appendChild(el("option", { value, text: label }));
    }
    const min = minScoreInput();
    const go = el("button", { type: "button", text: t("favGo") });
    const clear = el("button", { type: "button", text: t("favClear") });
    const update = el("a", { href: "#", text: t("favUpdate") });
    const rebuild = el("a", { href: "#", text: t("favRebuild") });
    const st = el("div", { class: "st" }, [document.createTextNode(""), " · ", update, " · ", rebuild]);
    const read = /* @__PURE__ */ __name(() => ({ where: "fav", text: input.value, or: or.value, kind: kind.value, sort: sort.value, min: min.value }), "read");
    const saved = savedControls("fav", read, (q) => {
      input.value = q.text;
      or.value = q.or || "";
      kind.value = q.kind;
      sort.value = q.sort;
      min.value = q.min || "";
      searchFavs();
    });
    const box = el("div", { id: "ibh-favsearch", class: "ibh-search" }, [input, or, kind, sort, min, go, clear, saved.star, saved.pick, saved.recentPick, st]);
    favBarSync = saved.sync;
    favBarReload = saved.reload;
    list.before(box);
    const more = el("button", { type: "button", id: "ibh-favmore" });
    more.hidden = true;
    list.after(more);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        input.blur();
        searchFavs();
      }
    });
    go.addEventListener("click", () => searchFavs());
    sort.addEventListener("change", () => {
      if (favPage) searchFavs();
    });
    kind.addEventListener("change", () => searchFavs());
    min.addEventListener("change", () => searchFavs());
    min.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        min.blur();
      }
    });
    clear.addEventListener("click", () => clearFavSearch());
    more.addEventListener("click", () => showMoreFavs());
    update.addEventListener("click", (ev) => {
      ev.preventDefault();
      updateFavIndex(false);
    });
    rebuild.addEventListener("click", (ev) => {
      ev.preventDefault();
      updateFavIndex(true);
    });
    input.addEventListener("input", saved.sync);
    or.addEventListener("input", saved.sync);
    or.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        or.blur();
        searchFavs();
      }
    });
    min.addEventListener("input", saved.sync);
    searchStore().then((store) => {
      const last = store.favLast;
      if (!last || !last.active || !document.getElementById("ibh-favsearch")) return;
      input.value = last.text || "";
      or.value = last.or || "";
      kind.value = last.kind || "all";
      sort.value = last.sort || "new";
      min.value = last.min || "";
      saved.sync();
      searchFavs();
    });
    loadFavIndex().then((idx) => {
      setFavStatus();
      if (idx.items.length && (idx.next !== void 0 || Date.now() - idx.updated > FAV_STALE_MS)) updateFavIndex(false);
    });
    info("favorites search bar added");
  }
  __name(ensureFavSearch, "ensureFavSearch");
  function orInput() {
    const field = el("input", { class: "or", type: "search", placeholder: t("orPlaceholder"), enterkeyhint: "search" });
    field.setAttribute("autocapitalize", "off");
    field.setAttribute("autocomplete", "off");
    attachSuggest(field);
    return field;
  }
  __name(orInput, "orInput");

  // src/lists/autopager.js
  var pager = null;
  var onListPage = /* @__PURE__ */ __name(() => {
    const q = new URLSearchParams(location.search);
    return q.get("page") === "post" && q.get("s") === "list";
  }, "onListPage");
  var onFavoritesPage = /* @__PURE__ */ __name(() => {
    const q = new URLSearchParams(location.search);
    return q.get("page") === "favorites" && q.get("s") === "view" && !!q.get("id");
  }, "onFavoritesPage");
  function ensureFavPager() {
    const want = CFG.favAutopager && (onFavoritesPage() || onListPage()) && !!document.querySelector(LIST);
    if (!want) {
      if (pager) {
        pager.io.disconnect();
        pager.sentinel.remove();
        pager = null;
      }
      return;
    }
    if (pager && pager.sentinel.isConnected) return;
    const sentinel = el("div", { id: "ibh-pager" });
    const above = (
      /** @type {Element} */
      document.getElementById("ibh-favmore") || document.querySelector(LIST)
    );
    above.after(sentinel);
    sentinel.addEventListener("click", () => {
      if (pager && !pager.done) favPagerNext();
    });
    const next = pageTarget(1);
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) favPagerNext();
    }, { rootMargin: "1500px 0px" });
    pager = { next, busy: false, done: !next, page: 1, sentinel, io };
    if (!next) sentinel.textContent = t("pagerEnd");
    io.observe(sentinel);
    dbg(`autopager: watching the bottom of the page${next ? "" : " (last page)"}`);
  }
  __name(ensureFavPager, "ensureFavPager");
  async function favPagerNext() {
    const p = pager;
    if (!p || p.busy || p.done || favPage) return;
    p.busy = true;
    p.sentinel.textContent = t("pagerLoading");
    try {
      const url = (
        /** @type {string} */
        p.next
      );
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const src = doc.querySelector(LIST);
      const items = src ? [...src.children].filter((node) => node.querySelector && node.querySelector("img")) : [];
      const list = document.querySelector(LIST);
      if (!items.length || !list) {
        p.done = true;
        p.sentinel.textContent = t("pagerEnd");
        info(`autopager: end of the list at ${url.replace(/^.*\?/, "?")}`);
        return;
      }
      list.append(...items.map((node) => document.adoptNode(node)));
      p.page++;
      p.next = pageTarget(1, doc, url);
      info(`autopager: page ${p.page} added (${items.length} posts)`);
      if (!p.next) {
        p.done = true;
        p.sentinel.textContent = t("pagerEnd");
        return;
      }
      p.sentinel.textContent = "";
    } catch (e) {
      warn(`autopager: next favorites page failed — ${describeError(e)}`);
      p.sentinel.textContent = t("pagerFail");
      return;
    } finally {
      p.busy = false;
    }
    if (p.sentinel.getBoundingClientRect().top < window.innerHeight + 1500) setTimeout(favPagerNext, 300);
  }
  __name(favPagerNext, "favPagerNext");
  function sharpenTile(img) {
    const src = img.getAttribute("src");
    const hash = (thumbParts(src) || {}).hash;
    if (!hash) return;
    const tags = ` ${img.dataset.tags || ""} `;
    const video = !!img.dataset.webm || NATIVE_REAL_VIDEO.test(tags);
    const kind = video ? "poster" : "sample";
    const cached = cacheGet(kind, hash);
    if (cached === null) return;
    const urls = cachedFirst(video ? fileCandidates(
      /** @type {string} */
      src,
      ["jpg"]
    ) : sampleCandidates(
      /** @type {string} */
      src
    ), cached);
    if (!urls.length) return;
    takeImageSlot(() => {
      const probe = new Image();
      probe.decoding = "async";
      let i = 0;
      let held = true;
      const release = /* @__PURE__ */ __name(() => {
        if (held) {
          held = false;
          giveImageSlot();
        }
      }, "release");
      probe.onerror = () => {
        if (i < urls.length) {
          probe.src = urls[i++];
          return;
        }
        release();
        cacheSet(kind, hash, null);
      };
      probe.onload = () => {
        release();
        cacheSet(kind, hash, probe.src, cached);
        if (img.isConnected) img.src = probe.src;
      };
      probe.src = urls[i++];
    });
  }
  __name(sharpenTile, "sharpenTile");

  // src/lists/later.js
  var LATER_MAX = 500;
  async function laterList() {
    const list = await storeGet("later");
    return Array.isArray(list) ? list : [];
  }
  __name(laterList, "laterList");
  function laterItem(link) {
    const img = link.querySelector("img");
    return {
      site: SITE,
      href: link.href,
      thumb: img && img.getAttribute("src") || "",
      // the thumbnail, not an upgrade in srcset
      tags: nativeTags(link).trim(),
      webm: !!link.querySelector("img.webm-thumb"),
      added: Date.now()
    };
  }
  __name(laterItem, "laterItem");
  function laterLink(item) {
    const a = document.createElement("a");
    a.href = item.href;
    const img = document.createElement("img");
    img.src = item.thumb;
    img.title = item.tags;
    if (item.webm) img.className = "webm-thumb";
    a.appendChild(img);
    return a;
  }
  __name(laterLink, "laterLink");
  async function toggleLaterHere() {
    const link = modal.link;
    if (!link) return;
    const list = await laterList();
    const i = list.findIndex((item) => item.href === link.href);
    if (i >= 0) list.splice(i, 1);
    else list.unshift(laterItem(link));
    list.length = Math.min(list.length, LATER_MAX);
    await storeSet("later", list);
    setLaterButton(i < 0);
    flash(t(i < 0 ? "laterAdded" : "laterRemoved"));
    info(`later: ${i < 0 ? "saved" : "removed"} post ${postId(link)} (${list.length} in the list)`);
  }
  __name(toggleLaterHere, "toggleLaterHere");
  function setLaterButton(saved) {
    modal.laterBtn.textContent = t(saved ? "laterIn" : "laterAdd");
    modal.laterBtn.classList.toggle("on", saved);
  }
  __name(setLaterButton, "setLaterButton");
  function refreshLaterButton(link, seq) {
    setLaterButton(false);
    laterList().then((list) => {
      if (modal.seq === seq) setLaterButton(list.some((item) => item.href === link.href));
    });
  }
  __name(refreshLaterButton, "refreshLaterButton");
  async function showLater() {
    if (!modal) buildModal();
    resetMedia();
    modal.box.classList.add("later-mode");
    openShell();
    await renderLater();
  }
  __name(showLater, "showLater");
  async function renderLater() {
    const list = (await laterList()).filter((item) => item.site === SITE);
    const title = (
      /** @type {Element} */
      modal.laterHead.querySelector(".lt")
    );
    title.textContent = `🕒 ${t("laterTitle")} · ${list.length}`;
    modal.laterNote.textContent = t(GM_STORE ? "laterOnDevice" : "laterOnSite");
    if (!list.length) {
      modal.laterGrid.replaceChildren(el("div", { class: "none", text: t("laterEmpty") }));
      return;
    }
    const links = list.map(laterLink);
    if (modal.laterIO) modal.laterIO.disconnect();
    modal.laterIO = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        modal.laterIO.unobserve(e.target);
        sharpenTile(
          /** @type {HTMLImageElement} */
          e.target
        );
      }
    }, { root: modal.laterView, rootMargin: "300px" }) : null;
    modal.laterGrid.replaceChildren(...list.map((item, i) => {
      const img = el("img", { src: item.thumb, alt: "" });
      img.loading = "lazy";
      img.dataset.tags = item.tags;
      if (item.webm) img.dataset.webm = "1";
      if (modal.laterIO) modal.laterIO.observe(img);
      const rm = el("button", { class: "rm", text: "✕", title: t("laterRemoved") });
      const tile = el("div", { class: "tile" }, [img, rm]);
      if (item.webm || /\s(video|mp4|webm|animated|gif)\s/i.test(` ${item.tags} `)) tile.appendChild(el("span", { class: "play", text: "▶" }));
      tile.addEventListener("click", (ev) => {
        if (ev.target === rm) return;
        modal.listLinks = links;
        modal.dir = 1;
        openModal(links[i]);
      });
      rm.addEventListener("click", async () => {
        const all = await laterList();
        await storeSet("later", all.filter((other) => other.href !== item.href));
        info(`later: removed post ${postId(links[i])} from the list`);
        renderLater();
      });
      return tile;
    }));
    dbg(`later: list shown, ${list.length} posts`);
  }
  __name(renderLater, "renderLater");

  // src/storage/storage.js
  function setCfg(key, value) {
    CFG[key] = value;
    writeJSON(CFG_KEY, CFG);
    try {
      backupCfg();
    } catch (e) {
    }
    info(`option ${key} = ${value}${NEEDS_RELOAD.has(key) ? " (reload the page)" : ""}`);
  }
  __name(setCfg, "setCfg");
  var GM_STORE = typeof GM_getValue === "function" && typeof GM_setValue === "function";
  var STORE_KEYS = ["later", "favs", "cfg", "searches"];
  var hasData = /* @__PURE__ */ __name((v) => v != null && (typeof v !== "object" || (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)), "hasData");
  function backupCfg() {
    const copy = JSON.parse(JSON.stringify(CFG));
    idbSet("cfg", copy);
    if (GM_STORE && JSON.stringify(GM_getValue("cfg", null)) !== JSON.stringify(copy)) GM_setValue("cfg", copy);
  }
  __name(backupCfg, "backupCfg");
  async function restoreCfg() {
    if (CFG_FOUND) {
      backupCfg();
      return;
    }
    await storeReady();
    let saved = GM_STORE ? GM_getValue("cfg", null) : null;
    if (!hasData(saved)) saved = await idbGet("cfg");
    if (!hasData(saved) || typeof saved !== "object") return;
    try {
      if (sessionStorage.getItem("IBH_CFG_RESTORED")) return;
      sessionStorage.setItem("IBH_CFG_RESTORED", "1");
    } catch (e) {
      return;
    }
    writeJSON(CFG_KEY, saved);
    warn("settings were missing from localStorage (cleared by another script?); restored from their copy, reloading");
    location.reload();
  }
  __name(restoreCfg, "restoreCfg");
  var idbOpen = null;
  function idb() {
    if (!idbOpen) {
      idbOpen = new Promise((resolve, reject) => {
        const req = indexedDB.open("ibh", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("kv");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return idbOpen;
  }
  __name(idb, "idb");
  async function idbGet(key) {
    try {
      const db = await idb();
      return await new Promise((resolve, reject) => {
        const req = db.transaction("kv").objectStore("kv").get(key);
        req.onsuccess = () => resolve(req.result === void 0 ? null : req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return void 0;
    }
  }
  __name(idbGet, "idbGet");
  async function idbSet(key, value) {
    try {
      const db = await idb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      return true;
    } catch (e) {
      return false;
    }
  }
  __name(idbSet, "idbSet");
  async function siteGet(key) {
    const value = await idbGet(key);
    const local = readJSON(`IBH_${key}`, null);
    if (value === void 0) return local;
    if (value === null && local !== null && await idbSet(key, local)) {
      try {
        localStorage.removeItem(`IBH_${key}`);
      } catch (e) {
      }
      return local;
    }
    return value;
  }
  __name(siteGet, "siteGet");
  async function siteSet(key, value) {
    if (!await idbSet(key, value)) writeJSON(`IBH_${key}`, value);
  }
  __name(siteSet, "siteSet");
  var BRIDGE_WAIT_MS = 1500;
  var BRIDGE_TRIES = 3;
  var movedIn = null;
  function setMovedIn(v) {
    movedIn = v;
  }
  __name(setMovedIn, "setMovedIn");
  function askBridge(keys) {
    return new Promise((resolve) => {
      const got = {};
      const asked = /* @__PURE__ */ new Map();
      let seq = 0;
      const ask = /* @__PURE__ */ __name(() => {
        for (const key of keys) {
          if (key in got) continue;
          const id = `move-${++seq}`;
          asked.set(id, key);
          window.dispatchEvent(new CustomEvent("ibh-store-request", { detail: JSON.stringify({ id, op: "get", key }) }));
        }
      }, "ask");
      const onReply = /* @__PURE__ */ __name((ev) => {
        let msg;
        try {
          msg = JSON.parse(
            /** @type {CustomEvent<string>} */
            ev.detail
          );
        } catch (e) {
          return;
        }
        const key = msg && asked.get(msg.id);
        if (key === void 0) return;
        got[key] = msg.value;
        if (Object.keys(got).length === keys.length) finish();
      }, "onReply");
      const finish = /* @__PURE__ */ __name(() => {
        clearTimeout(timer);
        window.removeEventListener("ibh-store-reply", onReply);
        window.removeEventListener("ibh-store-ready", ask);
        resolve(got);
      }, "finish");
      const timer = setTimeout(finish, BRIDGE_WAIT_MS);
      window.addEventListener("ibh-store-reply", onReply);
      window.addEventListener("ibh-store-ready", ask);
      ask();
    });
  }
  __name(askBridge, "askBridge");
  function mergeStored(key, mine, theirs) {
    if (!hasData(mine)) return theirs;
    const union = /* @__PURE__ */ __name((a, b, id) => {
      const seen = new Set(a.map(id));
      return [...a, ...b.filter((x) => !seen.has(id(x)))];
    }, "union");
    if (key === "later") return union(mine, theirs, (item) => item.href).slice(0, LATER_MAX);
    if (key === "searches") {
      return {
        saved: union(mine.saved || [], theirs.saved || [], searchKey),
        recent: union(mine.recent || [], theirs.recent || [], searchKey),
        favLast: mine.favLast || theirs.favLast || null
      };
    }
    if (key === "favs") return (theirs.items || []).length > (mine.items || []).length ? theirs : mine;
    return mine;
  }
  __name(mergeStored, "mergeStored");
  async function moveIn() {
    const tries = GM_getValue("movedIn", 0);
    if (tries === true) return;
    const bridge = await askBridge(STORE_KEYS);
    const answered = Object.keys(bridge).length > 0;
    for (const key of STORE_KEYS) {
      const mine = GM_getValue(key, null);
      if (key === "cfg" && hasData(mine)) continue;
      let theirs = bridge[key];
      let from = "the storage bridge";
      if (!hasData(theirs) && tries === 0 && key !== "favs") {
        theirs = await siteGet(key);
        from = "the site’s data";
      }
      if (!hasData(theirs)) continue;
      GM_setValue(key, mergeStored(key, mine, theirs));
      info(`storage: ${key} moved in from ${from}`);
    }
    GM_setValue("movedIn", answered || tries + 1 >= BRIDGE_TRIES ? true : tries + 1);
    if (!answered) info(`storage: no storage bridge answered (load ${tries + 1} of ${BRIDGE_TRIES})`);
  }
  __name(moveIn, "moveIn");
  var storeReady = /* @__PURE__ */ __name(() => movedIn || (movedIn = (GM_STORE ? moveIn() : Promise.resolve()).catch((e) => warn(`storage: moving in failed — ${describeError(e)}`))), "storeReady");
  async function storeGet(key) {
    await storeReady();
    return GM_STORE ? GM_getValue(key, null) : siteGet(key);
  }
  __name(storeGet, "storeGet");
  async function storeSet(key, value) {
    await storeReady();
    if (GM_STORE) GM_setValue(key, value);
    else await siteSet(key, value);
  }
  __name(storeSet, "storeSet");

  // src/thumbs/marks.js
  var UNLIKE_HOLD_MS = 500;
  var likedIds = null;
  var unliked = /* @__PURE__ */ new Set();
  var favIndexWrites = Promise.resolve();
  var wantsLiked = /* @__PURE__ */ __name(() => !!CFG.likedBadge && SITE === "rule34.xxx" && !!userId(), "wantsLiked");
  var isLiked = /* @__PURE__ */ __name((id) => !unliked.has(id) && (hasMark("f", id) || !!likedIds?.has(id) || onOwnFavorites()), "isLiked");
  var cardsOf = /* @__PURE__ */ __name((id) => siteLinks().filter((a) => postId(a) === id), "cardsOf");
  function paintCardMarks(link) {
    paintLiked(link);
    paintRes(link);
    wantDims(link);
  }
  __name(paintCardMarks, "paintCardMarks");
  function repaintCards() {
    for (const link of siteLinks()) paintCardMarks(link);
  }
  __name(repaintCards, "repaintCards");
  function paintLiked(link) {
    const id = postId(link);
    const on = wantsLiked() && id !== "?" && isLiked(id);
    const had = link.querySelector(".ibh-liked");
    if (!on) {
      had?.remove();
      delete link.dataset.ibhLiked;
      return;
    }
    link.dataset.ibhLiked = "1";
    if (had) return;
    if (getComputedStyle(link).position === "static") link.style.position = "relative";
    link.appendChild(el("span", { class: "ibh-liked", "data-ibh-ui": "", role: "button", title: t("heartHint"), text: "❤️" }));
  }
  __name(paintLiked, "paintLiked");
  async function loadLikedIds() {
    if (!wantsLiked() || likedIds) return;
    const idx = favIndex && favIndex.user === userId() ? favIndex : await favsGet();
    if (!idx || idx.user !== userId()) return;
    likedIds = new Set(idx.items.map((item) => item[0]));
    let shown = 0;
    for (const link of siteLinks()) {
      paintLiked(link);
      if (link.dataset.ibhLiked) shown++;
    }
    info(`liked: ${likedIds.size} favorites in the index, ${shown} of them on this page`);
  }
  __name(loadLikedIds, "loadLikedIds");
  function afterFavorite(id, fav) {
    if (fav) unliked.delete(id);
    else unliked.add(id);
    if (likedIds) fav ? likedIds.add(id) : likedIds.delete(id);
    const links = cardsOf(id);
    for (const link of links) {
      paintLiked(link);
      if (!fav) delete link.dataset.ibhBulk;
    }
    if (CFG.favAutoIndex && SITE === "rule34.xxx" && userId()) {
      favIndexWrites = favIndexWrites.then(() => indexFavorite(id, fav, links[0])).catch((e) => warn(`favorites: index not updated — ${describeError(e)}`));
    }
  }
  __name(afterFavorite, "afterFavorite");
  async function indexFavorite(id, fav, link) {
    if (favScan) {
      dbg(`favorites: index being read, post ${id} left to it`);
      return;
    }
    const idx = await loadFavIndex();
    if (!idx.items.length && idx.next === void 0) return;
    const at = idx.items.findIndex((item) => item[0] === id);
    if (fav === at >= 0) return;
    if (fav) {
      const img = link && link.querySelector("img");
      idx.items.unshift([id, img && img.getAttribute("src") || "", link ? nativeTags(link) : "", null]);
    } else {
      idx.items.splice(at, 1);
    }
    setFavEntries(null);
    await favsSet(idx);
    info(`favorites: post ${id} ${fav ? "added to" : "taken out of"} the index (${idx.items.length})`);
  }
  __name(indexFavorite, "indexFavorite");
  async function unlikeFromCard(link) {
    const id = postId(link);
    try {
      let { code } = await favoritePost(id, true);
      if (code === "3") ({ code } = await favoritePost(id, true));
      if (code !== "4") {
        pageToast(`${t("unlikeFail")} (${code.slice(0, 20)})`);
        warn(`liked: post ${id} not unfavorited — answer ${code.slice(0, 20)}`);
        return;
      }
      pageToast(t("favRemoved"));
      info(`liked: post ${id} unfavorited from its ❤️`);
    } catch (e) {
      pageToast(t("unlikeFail"));
      warn(`liked: post ${id} not unfavorited — ${describeError(e)}`);
    }
  }
  __name(unlikeFromCard, "unlikeFromCard");
  var heartHold = null;
  function onHeartTouchStart(ev) {
    const badge = asElement(ev.target)?.closest(".ibh-liked");
    const link = (
      /** @type {HTMLAnchorElement | null | undefined} */
      badge && badge.closest(SITE_LINK)
    );
    if (!link || ev.touches.length !== 1) return;
    const finger = ev.touches[0];
    const hold = { link, x: finger.clientX, y: finger.clientY, fired: false, timer: 0 };
    hold.timer = setTimeout(() => {
      hold.fired = true;
      if (navigator.vibrate) navigator.vibrate(15);
      unlikeFromCard(link);
    }, UNLIKE_HOLD_MS);
    heartHold = hold;
  }
  __name(onHeartTouchStart, "onHeartTouchStart");
  function onHeartTouchMove(ev) {
    const finger = ev.touches[0];
    if (heartHold && !heartHold.fired && finger && Math.hypot(finger.clientX - heartHold.x, finger.clientY - heartHold.y) > 12) {
      clearTimeout(heartHold.timer);
      heartHold = null;
    }
  }
  __name(onHeartTouchMove, "onHeartTouchMove");
  function onHeartTouchEnd() {
    if (heartHold && !heartHold.fired) clearTimeout(heartHold.timer);
  }
  __name(onHeartTouchEnd, "onHeartTouchEnd");
  function onHeartClick(ev) {
    if (!asElement(ev.target)?.closest(".ibh-liked")) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (!heartHold || !heartHold.fired) pageToast(t("heartHint"));
    heartHold = null;
  }
  __name(onHeartClick, "onHeartClick");
  var DIMS_KEY = `IBH_DIMS_${SITE}`;
  var DIMS_MAX = 8e3;
  var DIMS_INFLIGHT = 2;
  var RULE34_API = "https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1";
  var dims = null;
  var dimsSaveTimer = 0;
  var dimsQueue = [];
  var dimsAsked = /* @__PURE__ */ new Set();
  var dimsLive = 0;
  function loadDims() {
    if (!dims) dims = new Map(Object.entries(readJSON(DIMS_KEY, {})));
    return dims;
  }
  __name(loadDims, "loadDims");
  function setDims(id, w, h) {
    if (id === "?" || !(w > 0 && h > 0)) return;
    const map = loadDims();
    const size = `${w}x${h}`;
    if (map.get(id) === size) return;
    map.delete(id);
    map.set(id, size);
    while (map.size > DIMS_MAX) map.delete(
      /** @type {string} */
      map.keys().next().value
    );
    clearTimeout(dimsSaveTimer);
    dimsSaveTimer = setTimeout(() => writeJSON(DIMS_KEY, Object.fromEntries(loadDims())), 2e3);
    for (const link of cardsOf(id)) paintRes(link);
  }
  __name(setDims, "setDims");
  function paintRes(link) {
    const size = CFG.resBadge ? loadDims().get(postId(link)) : void 0;
    let badge = (
      /** @type {HTMLElement | null} */
      link.querySelector(".ibh-res")
    );
    if (!size) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = el("span", { class: "ibh-res", "data-ibh-ui": "" });
      if (getComputedStyle(link).position === "static") link.style.position = "relative";
      link.appendChild(badge);
    }
    badge.textContent = size.replace("x", "×");
  }
  __name(paintRes, "paintRes");
  var apiKey = /* @__PURE__ */ __name(() => GM_STORE ? String(GM_getValue("r34ApiKey", "") || "") : "", "apiKey");
  function parseApiKey(raw) {
    const text = raw.trim();
    if (!text) return "";
    const key = text.match(/api_key=([0-9a-f]{32,})/i);
    const user = text.match(/user_id=(\d+)/);
    return key && user ? `&api_key=${key[1]}&user_id=${user[1]}` : null;
  }
  __name(parseApiKey, "parseApiKey");
  function wantDims(link) {
    const id = postId(link);
    if (!CFG.resBadge || SITE !== "rule34.xxx" || !GM_XHR || apiRefused || id === "?" || dimsAsked.has(id) || loadDims().has(id) || !apiKey()) return;
    dimsAsked.add(id);
    dimsQueue.push(id);
    pumpDims();
  }
  __name(wantDims, "wantDims");
  var apiRefused = false;
  function r34Api(query, done) {
    const key = apiKey();
    if (!key || apiRefused || !GM_XHR || SITE !== "rule34.xxx") return false;
    GM_xmlhttpRequest({
      method: "GET",
      url: `${RULE34_API}${query}${key}`,
      timeout: 15e3,
      onload: /* @__PURE__ */ __name((res) => {
        let json = null;
        try {
          json = JSON.parse(res.responseText);
        } catch (e) {
        }
        if (json === null && /authentication|api_key|access denied/i.test(res.responseText)) {
          apiRefused = true;
          warn(`rule34 API: the key was refused — ${res.responseText.slice(0, 120)}`);
        }
        done(json);
      }, "onload"),
      onerror: /* @__PURE__ */ __name(() => done(null), "onerror"),
      ontimeout: /* @__PURE__ */ __name(() => done(null), "ontimeout")
    });
    return true;
  }
  __name(r34Api, "r34Api");
  function pumpDims() {
    while (dimsLive < DIMS_INFLIGHT && dimsQueue.length) {
      const id = (
        /** @type {string} */
        dimsQueue.shift()
      );
      const sent = r34Api(`&id=${encodeURIComponent(id)}`, (json) => {
        dimsLive--;
        const post = Array.isArray(json) ? json[0] : null;
        if (post && typeof post === "object" && "width" in post && "height" in post) setDims(id, Number(post.width), Number(post.height));
        pumpDims();
      });
      if (!sent) {
        dimsQueue.length = 0;
        return;
      }
      dimsLive++;
    }
  }
  __name(pumpDims, "pumpDims");
  function apiSection(body) {
    if (SITE !== "rule34.xxx") {
      body.appendChild(toggle("resBadge", t("tResBadge"), null, repaintCards));
      return;
    }
    body.appendChild(el("div", { class: "sec", text: t("apiSec") }));
    if (!apiKey()) body.appendChild(el("div", { class: "apiwarn", text: t(GM_STORE ? "apiWarn" : "appNoStore") }));
    body.appendChild(apiKeyControls());
    body.appendChild(toggle("resBadge", t("tResBadge"), apiKey() ? null : t("apiPartial"), repaintCards));
  }
  __name(apiSection, "apiSection");
  function apiKeyControls() {
    const field = el("input", { class: "apptoken", type: "password", autocomplete: "off", placeholder: t(GM_STORE ? "apiKeyHint" : "appNoStore") });
    field.disabled = !GM_STORE;
    field.value = apiKey();
    const keyUser = /* @__PURE__ */ __name((key) => (key.match(/user_id=(\d+)/) || [])[1], "keyUser");
    const shown = /* @__PURE__ */ __name((key) => key ? `${t("apiKeySet")} (user ${keyUser(key)})` : t("apiKeyNone"), "shown");
    const status = el("div", { class: "lbl appstatus", text: shown(apiKey()) });
    const save = /* @__PURE__ */ __name((final) => {
      const key = parseApiKey(field.value);
      if (key === null) {
        if (final) status.textContent = t("apiKeyBad");
        return;
      }
      if (key === apiKey() || !key && !final) return;
      GM_setValue("r34ApiKey", key);
      field.value = key;
      apiRefused = false;
      dimsAsked.clear();
      status.textContent = shown(key);
      info(`resolution: API key ${key ? `saved (user ${keyUser(key)})` : "cleared"}`);
      repaintCards();
      if (final || key) setTimeout(rebuildPanel, 0);
    }, "save");
    field.addEventListener("input", () => save(false));
    field.addEventListener("change", () => save(true));
    return el("div", { class: "lang" }, [el("div", { class: "lbl", text: t("apiKey") }), field, status]);
  }
  __name(apiKeyControls, "apiKeyControls");

  // src/post/post.js
  var pageUser = null;
  var userId = /* @__PURE__ */ __name(() => (document.cookie.match(/(?:^|; )user_id=(\d+)/) || [])[1] || pageUser || (pageUser = userFromPage()), "userId");
  function userFromPage() {
    const nav = document.querySelector('#my-favorites-container a[href*="id="]');
    const fromNav = (nav && nav.getAttribute("href") || "").match(/[?&]id=(\d+)/);
    if (fromNav) return fromNav[1];
    const q = new URLSearchParams(location.search);
    const own = q.get("page") === "favorites" && /^\d+$/.test(q.get("id") || "") && document.querySelector('a[onclick*="favorites&s=delete"]');
    return own ? q.get("id") : null;
  }
  __name(userFromPage, "userFromPage");
  var onOwnFavorites = /* @__PURE__ */ __name(() => {
    const q = new URLSearchParams(location.search);
    return q.get("page") === "favorites" && !!userId() && q.get("id") === userId();
  }, "onOwnFavorites");
  var postInfos = /* @__PURE__ */ new Map();
  function postInfo(id) {
    let p = postInfos.get(id);
    if (!p) {
      p = fetch(`/index.php?page=post&s=view&id=${encodeURIComponent(id)}`, { credentials: "same-origin" }).then((res) => res.ok ? res.text() : null).then((html) => html ? readPostPage(html) : null).then((page) => {
        const size = page && page.stats.map((st) => st.text.match(/^Size:\s*(\d+)\s*x\s*(\d+)/i)).find(Boolean);
        if (size) setDims(id, Number(size[1]), Number(size[2]));
        return page;
      }).catch(() => null);
      postInfos.set(id, p);
    }
    return p;
  }
  __name(postInfo, "postInfo");
  function readComments(doc, base = location.href) {
    const list = [...doc.querySelectorAll("#comment-list > div[id]")].filter((d) => /^c\d+$/.test(d.id)).map((d) => {
      const head = d.querySelector(".col1");
      const body = d.querySelector(".col2");
      if (body) body.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
      const headText = head ? (head.textContent || "").replace(/\s+/g, " ") : "";
      const author = head && head.querySelector('a[href*="page=account"]');
      return {
        id: d.id.slice(1),
        // c22197352 -> 22197352, for the vote
        user: (author && author.textContent || "").trim(),
        profile: author ? new URL(
          /** @type {string} */
          author.getAttribute("href"),
          base
        ).href : null,
        // matched a[href…]
        date: (headText.match(/Posted on (\S+ \S+)/) || [])[1] || "",
        score: Number((head && head.querySelector('[id^="sc"]') || {}).textContent) || 0,
        text: body ? (body.textContent || "").replace(/\n{3,}/g, "\n\n").trim() : ""
      };
    }).filter((c) => c.text);
    const total = Number(((doc.querySelector("#comment-list") || {}).textContent || "").match(/(\d+) comments?/)?.[1]) || list.length;
    const more = [...doc.querySelectorAll("#post-comments #paginator a")].find((a) => /next/i.test(a.textContent || ""));
    const href = more && more.getAttribute("href");
    return { list, total, next: href ? new URL(href, base).href : null };
  }
  __name(readComments, "readComments");
  function readPostPage(html) {
    const heart = html.match(/id="heart-img"[^>]*src="[^"]*\/(heart(?:-added)?)\.svg"/);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const tags = [];
    for (const li of doc.querySelectorAll('li[class*="tag-type-"]')) {
      const type = (li.className.match(/tag-type-([a-z]+)/) || [])[1] || "general";
      const a = [...li.querySelectorAll('a[href*="tags="]')].pop();
      const q = a && /** @type {string} */
      a.getAttribute("href").match(/[?&]tags=([^&]+)/);
      if (q) tags.push({ name: decodeURIComponent(q[1].replace(/\+/g, " ")), type });
    }
    const stats = [...doc.querySelectorAll("#stats li")].map((li) => {
      const text = (li.textContent || "").replace(/\s+/g, " ").replace(/\(\s*vote.*$/i, "").trim();
      const link = li.querySelector('a[href^="http"]');
      return { text, href: link ? link.getAttribute("href") : null };
    }).filter((st) => st.text);
    const comments = readComments(doc);
    const orig = [...doc.querySelectorAll('a[href*="/images/"]')].find((a) => /original/i.test(a.textContent || ""));
    const original = orig ? (
      /** @type {string} */
      orig.getAttribute("href").replace(/([^:])\/\/+/g, "$1/").replace("//api-cdn-mp4.", "//api-cdn.")
    ) : null;
    return { fav: heart ? heart[1] === "heart-added" : null, tags, stats, original, comments };
  }
  __name(readPostPage, "readPostPage");
  var favLookups = /* @__PURE__ */ new Map();
  function lookUpFavorite(id) {
    if (!userId()) return Promise.resolve(null);
    let p = favLookups.get(id);
    if (!p) {
      p = postInfo(id).then((info2) => {
        if (!info2 || info2.fav === null) return null;
        setMark("f", id, info2.fav);
        dbg(`modal: post ${id} ${info2.fav ? "is" : "is not"} a favorite (from the post page)`);
        return info2.fav;
      });
      favLookups.set(id, p);
    }
    return p;
  }
  __name(lookUpFavorite, "lookUpFavorite");

  // src/post/download.js
  var GM_XHR = typeof GM_xmlhttpRequest === "function";
  var downloading = /* @__PURE__ */ new Set();
  var dlPercent = /* @__PURE__ */ new Map();
  var DL_DONE_MS = 1500;
  var BLOB_LIFE_MS = 12e4;
  var DL_STALL_MS = 6e4;
  var dlDoneAt = { post: null, until: 0 };
  function siteFile(url) {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && (u.hostname === SITE || u.hostname.endsWith(`.${SITE}`));
    } catch (e) {
      return false;
    }
  }
  __name(siteFile, "siteFile");
  function saveFile(url, name, done, progress) {
    let last = 0;
    let heard = Date.now();
    let over = false;
    const end = /* @__PURE__ */ __name((ok, reason) => {
      if (over) return;
      over = true;
      clearInterval(watch);
      done(ok, reason);
    }, "end");
    const watch = setInterval(() => {
      if (Date.now() - heard < DL_STALL_MS) return;
      if (req && req.abort) req.abort();
      end(false, `nothing received for ${DL_STALL_MS / 1e3} s`);
    }, 5e3);
    const req = GM_xmlhttpRequest({
      // A big file takes a while: report how far it got, twice a second at most.
      onprogress: /* @__PURE__ */ __name((e) => {
        heard = Date.now();
        if (!e.total || Date.now() - last < 500) return;
        last = Date.now();
        progress(e.loaded, e.total);
      }, "onprogress"),
      method: "GET",
      url,
      responseType: "blob",
      // The video hosts refuse a request without the site as referrer (403),
      // which the browser sends when it plays the video and the extension not.
      headers: { Referer: `${location.origin}/` },
      onload: /* @__PURE__ */ __name((res) => {
        if (res.status !== 200 || !res.response) {
          end(false, `HTTP ${res.status}`);
          return;
        }
        const href = URL.createObjectURL(res.response);
        const a = document.createElement("a");
        a.href = href;
        a.download = name;
        a.style.display = "none";
        (document.body || document.documentElement).appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(href), BLOB_LIFE_MS);
        end(true);
      }, "onload"),
      onerror: /* @__PURE__ */ __name(() => end(false, "network error"), "onerror"),
      ontimeout: /* @__PURE__ */ __name(() => end(false, "timeout"), "ontimeout")
    });
  }
  __name(saveFile, "saveFile");
  function refreshDlButton() {
    const queue = modal && modal.dlq;
    if (queue) {
      const known = [...downloading].map((p) => dlPercent.get(p)).filter((v) => v != null);
      const pct = known.length ? `${Math.round(known.reduce((a, b) => a + b, 0) / known.length)}%` : "…";
      queue.hidden = !downloading.size;
      queue.textContent = downloading.size > 1 ? `⬇ ${downloading.size} · ${pct}` : `⬇ ${pct}`;
    }
    const btn = modal && modal.dlBtn;
    if (!btn) return;
    const post = modal.link && postId(modal.link);
    if (downloading.has(post)) {
      btn.disabled = true;
      const pct = dlPercent.get(post);
      btn.replaceChildren(el("span", { class: "spin" }), document.createTextNode(pct == null ? t("dlStart") : `${pct}%`));
    } else if (dlDoneAt.post === post && Date.now() < dlDoneAt.until) {
      btn.disabled = true;
      btn.textContent = "✓";
    } else {
      btn.disabled = false;
      btn.textContent = t("dlBtn");
    }
  }
  __name(refreshDlButton, "refreshDlButton");
  function dlFinished(post, ok, reason) {
    downloading.delete(post);
    dlPercent.delete(post);
    if (ok) {
      dlDoneAt = { post, until: Date.now() + DL_DONE_MS };
      setTimeout(refreshDlButton, DL_DONE_MS);
    }
    refreshDlButton();
    if (modal && modal.open) flash(t(ok ? "dlDone" : "dlFail"));
    else pageToast(t(ok ? "dlDone" : "dlFail"));
    if (ok) info(`download: post ${post} fetched, handed to Firefox to save`);
    else warn(`download: post ${post} failed — ${reason}`);
  }
  __name(dlFinished, "dlFinished");
  async function rawFileUrl() {
    const url = modal.fileUrl;
    if (!url || !modal.isSample) return url;
    const pic = cardPicture(modal.link);
    const hash = pic && (thumbParts(pic.src) || {}).hash;
    const known = hash && knownOriginal(hash);
    if (typeof known === "string") return known;
    const page = await postInfo(postId(modal.link));
    return page && page.original || url;
  }
  __name(rawFileUrl, "rawFileUrl");
  var portableUrl = /* @__PURE__ */ __name((url) => url.replace(/:\/\/api-cdn\.rule34\.xxx\/(.*\.(?:mp4|webm)(?:[?#]|$))/i, "://api-cdn-mp4.rule34.xxx/$1"), "portableUrl");
  async function copyRawLink() {
    const raw = await rawFileUrl();
    if (!raw) {
      flash(t("dlWait"));
      return;
    }
    const url = portableUrl(raw);
    try {
      await navigator.clipboard.writeText(url);
      flash(t("linkCopied"));
      info(`copied the file link of post ${postId(modal.link)}: ${url}`);
    } catch (e) {
      flash(t("copyFailed"));
      warn(`could not copy the file link — ${describeError(e)}`);
    }
  }
  __name(copyRawLink, "copyRawLink");
  async function modalDownload() {
    const url = await rawFileUrl();
    if (!url) {
      flash(t("dlWait"));
      return;
    }
    const post = postId(modal.link);
    if (downloading.has(post)) {
      flash(t("dlBusy"));
      return;
    }
    if (!GM_XHR || !siteFile(url)) {
      window.open(url, "_blank", "noopener");
      flash(t("dlOpened"));
      info(`download: post ${post} opened in a new tab (${GM_XHR ? "not on the site’s hosts" : "no GM_xmlhttpRequest"})`);
      return;
    }
    const ext = (url.split(/[?#]/)[0].match(/\.(\w+)$/) || [])[1] || "bin";
    const name = `${SITE.split(".")[0]}_${post}.${ext}`;
    downloading.add(post);
    refreshDlButton();
    info(`download: post ${post} as ${name}`);
    saveFile(url, name, (ok, reason) => dlFinished(post, ok, reason), (loaded, total) => {
      dlPercent.set(post, Math.round(loaded / total * 100));
      refreshDlButton();
    });
  }
  __name(modalDownload, "modalDownload");

  // src/modal/modal.js
  var SITE_LINK = `${THUMB} a`;
  var SWIPE_MIN = 60;
  var CONTROLS_BAND = 100;
  var modal = (
    /** @type {any} */
    null
  );
  var siteLinks = /* @__PURE__ */ __name(() => (
    /** @type {HTMLAnchorElement[]} */
    [...document.querySelectorAll(SITE_LINK)]
  ), "siteLinks");
  var LIKE_CSS = `
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
    }`;
  var MODAL_CSS = `
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
      background: rgba(12, 18, 21, .55); -webkit-backdrop-filter: blur(10px) saturate(1.2); backdrop-filter: blur(10px) saturate(1.2);
      box-shadow: 0 4px 18px rgba(0, 0, 0, .35); transition: opacity .25s, transform .25s;
    }
    .vctl.hide { opacity: 0; transform: translateY(16px); pointer-events: none; }
    .vctl button { width: 34px; height: 34px; border: none; background: transparent; color: #e6eef0; padding: 0; flex: none; }
    .vctl button svg, .vbig svg { width: 24px; height: 24px; fill: currentColor; }
    .vrow { display: flex; align-items: center; gap: 6px; height: 34px; }
    .vgap { flex: 1; }
    .vctl .vfav.on { color: #e5534b; }
    /* ⚙'s menu, over the capsule's right end: the speed and the double tap's jump. */
    .vmenu { position: absolute; right: 10px; bottom: ${CONTROLS_BAND}px; display: grid; gap: 10px; padding: 10px 12px;
      border-radius: 16px; border: 1px solid rgba(255, 255, 255, .1); background: rgba(12, 18, 21, .8);
      -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); color: #e6eef0; font-size: 12px; }
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
    .vmrow button.on { background: ${ACCENT}; color: #0f1417; border-color: ${ACCENT}; }
    .vtime { color: #d7dee0; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    /* Thin seek bar: played in the theme's teal (the range's own progress),
       downloaded in light grey (--buf, kept by the player), a thumb that
       grows while dragged; a tall input for the finger. */
    .vseek { flex: 1; min-width: 0; height: 24px; margin: 0; background: transparent; -moz-appearance: none; appearance: none; --buf: 0%; }
    .vseek::-moz-range-track { height: 4px; border-radius: 2px;
      background: linear-gradient(to right, rgba(255, 255, 255, .45) var(--buf), rgba(255, 255, 255, .16) var(--buf)); }
    .vseek::-moz-range-progress { height: 4px; border-radius: 2px; background: ${ACCENT}; }
    .vseek::-moz-range-thumb { width: 12px; height: 12px; border: none; border-radius: 50%; background: ${ACCENT}; transition: transform .15s; }
    .vseek:active::-moz-range-thumb { transform: scale(1.6); }
    /* The big ▶ in the middle of a paused video. */
    .vbig {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 64px; height: 64px;
      border: 1px solid rgba(255, 255, 255, .14); background: rgba(12, 18, 21, .5); color: #fff;
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); box-shadow: 0 4px 18px rgba(0, 0, 0, .35);
    }
    .vbig svg { width: 34px; height: 34px; margin-left: 4px; }
    .vprev {
      position: absolute; bottom: ${CONTROLS_BAND + 6}px; width: 160px; height: 90px;
      border: 1px solid #2a3a3f; border-radius: 6px; overflow: hidden; background: #000; pointer-events: none;
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
    .count { margin-left: auto; color: #a8b8bb; font-size: 13px; text-shadow: 0 1px 3px #000; }
    .dlq { padding: 4px 10px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, .12); background: rgba(12, 18, 21, .7);
      color: #e6eef0; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .status { position: absolute; left: 0; right: 0; top: 50%; text-align: center; color: #a8b8bb; font-size: 14px; pointer-events: none; }
    button, a.btn {
      width: 42px; height: 42px; border-radius: 50%; display: grid; place-items: center;
      border: 1px solid #2a3a3f; background: rgba(15, 20, 23, .85); color: ${ACCENT};
      font-size: 20px; line-height: 1; text-decoration: none; padding: 0;
    }
    .side { position: absolute; top: 50%; transform: translateY(-50%); font-size: 26px; padding-bottom: 3px; }
    .prev { left: 6px; } .next { right: 6px; }
    button.on { background: ${ACCENT}; color: #0f1417; border-color: ${ACCENT}; }
    button.up { width: auto; min-width: 42px; padding: 0 12px; border-radius: 21px; gap: 6px; display: flex; font-size: 16px; }
    .score { font-size: 13px; }
    ${LIKE_CSS}
    .badge {
      position: absolute; left: 50%; top: 64px; transform: translateX(-50%);
      padding: 6px 14px; border-radius: 16px; background: rgba(15, 20, 23, .9); color: ${ACCENT};
      font-size: 15px; font-weight: 600; pointer-events: none;
    }
    .sheet {
      position: absolute; left: 0; right: 0; bottom: 0; max-height: 55%; overflow-y: auto; overscroll-behavior: contain;
      background: rgba(10, 14, 16, .97); border-top: 1px solid #2a3a3f; border-radius: 14px 14px 0 0; padding: 10px 10px 18px;
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
      display: inline-block; text-align: left; word-break: break-all; color: #d7dee0;
    }
    button.t-artist { color: #f2ac08; border-color: #6b4e0a; }
    button.t-character { color: #3fb950; border-color: #1f5a2a; }
    button.t-copyright { color: #c678dd; border-color: #5a3566; }
    button.t-metadata { color: #e5534b; border-color: #66282a; }
    button.tag.copied { background: ${ACCENT}; color: #0f1417; border-color: ${ACCENT}; }
    button.tag.held, button.pill.held { background: ${ACCENT_DARK}; border-color: ${ACCENT}; }
    button.tag { user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
    .sheet .none { color: #4e6469; font-size: 13px; }
    button.quality { position: absolute; left: 12px; bottom: 16px; width: auto; height: 32px; padding: 0 12px;
      border-radius: 16px; font-size: 12px; font-weight: 700; letter-spacing: .5px; }
    button.quality.raw { background: ${ACCENT_MID}; color: #fff; border-color: ${ACCENT_MID}; }
    .m.clean button.quality { opacity: 0; pointer-events: none; }
    .tabs { display: flex; gap: 6px; margin-bottom: 10px; }
    button.tab { width: auto; height: 32px; border-radius: 16px; padding: 0 16px; font-size: 13px; }
    button.tab.on { background: ${ACCENT}; color: #0f1417; border-color: ${ACCENT}; }
    .infolist { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: 13px; color: #d7dee0; }
    .infolist[hidden], .commentlist[hidden] { display: none; }
    .commentlist { display: flex; flex-direction: column; gap: 12px; font-size: 13px; color: #d7dee0; }
    .commentlist .h { color: #7f9aa0; font-size: 12px; margin-bottom: 3px; }
    .commentlist .h b, .commentlist .h a.who { color: ${ACCENT}; font-weight: 600; text-decoration: none; }
    .commentlist button.cvote { width: auto; height: 24px; padding: 0 9px; border-radius: 12px; font-size: 12px;
      display: inline-flex; vertical-align: middle; margin-left: 4px; }
    .commentlist .b { white-space: pre-wrap; word-break: break-word; line-height: 1.4; }
    .commentlist .none { color: #7f9aa0; }
    .infolist .k { color: #7f9aa0; white-space: nowrap; }
    .infolist .v { word-break: break-word; }
    .infolist .v.warn { color: #f2ac08; }
    .infolist a { color: ${ACCENT}; }
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
    .laternote a { color: ${ACCENT}; }
    .latergrid .none { grid-column: 1 / -1; color: #7f9aa0; font-size: 14px; text-align: center; padding: 30px 10px; }
    .toast {
      position: absolute; left: 50%; bottom: 84px; transform: translateX(-50%);
      padding: 8px 14px; border-radius: 18px; background: rgba(15, 20, 23, .92); color: #d7dee0;
      font-size: 13px; pointer-events: none; transition: opacity .2s;
    }
  `;
  function buildModal() {
    const host = el("div");
    host.style.cssText = "all:initial;position:static";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = MODAL_CSS;
    const video = document.createElement("video");
    video.controls = false;
    video.loop = true;
    video.playsInline = true;
    const image = document.createElement("img");
    image.draggable = false;
    const layer = el("div", { class: "vlayer" });
    const playBtn = el("button", { class: "vbig", title: t("mPlay") });
    setIcon(playBtn, PLAYER_ICON.play);
    const times = [el("span", { class: "vtime", text: "0:00" }), el("span", { class: "vtime", text: "0:00" })];
    const seek = el("input", { class: "vseek", type: "range", min: "0", max: "1000", value: "0" });
    const muteBtn = el("button", { title: t("mMute") });
    setIcon(muteBtn, PLAYER_ICON.volume);
    const fsBtn = el("button", { class: "vfs", title: t("mFull") });
    setFsIcon(fsBtn, false);
    const playPause = el("button", { class: "vplay", title: t("mPlay") });
    setIcon(playPause, PLAYER_ICON.play);
    const favUp = el("button", { class: "vfav", title: t("mFavUp") });
    setIcon(favUp, PLAYER_ICON.heartLine);
    const infoBtn = el("button", { class: "vinfo", title: t("tabInfo") });
    setIcon(infoBtn, PLAYER_ICON.info);
    const gear = el("button", { class: "vgear", title: t("mGear") });
    setIcon(gear, PLAYER_ICON.gear);
    const gearMenu = el("div", { class: "vmenu" });
    gearMenu.hidden = true;
    const ctl = el("div", { class: "vctl" }, [
      el("div", { class: "vrow" }, [times[0], seek, times[1]]),
      el("div", { class: "vrow" }, [playPause, favUp, infoBtn, el("span", { class: "vgap" }), gear, muteBtn, fsBtn])
    ]);
    const prevBox = el("div", { class: "vprev" }, [el("span")]);
    prevBox.hidden = true;
    const vwrap = el("div", { class: "vwrap" }, [video, layer, playBtn, prevBox, gearMenu, ctl]);
    const controls = installVideoControls(video, ctl, playBtn, times, seek, muteBtn, prevBox, vwrap, { playPause, gearMenu });
    installGearMenu(gear, gearMenu, video, vwrap, controls.poke);
    const stage = el("div", { class: "stage" }, [vwrap, image]);
    const close = el("button", { text: "✕", title: t("mClose") });
    const post = el("a", { class: "btn", text: "↗", title: t("mOpen"), target: "_blank", rel: "noopener" });
    const menu = el("button", { text: "☰", title: t("mMenu") });
    const tagList = el("div", { class: "taglist" });
    const laterBtn = el("button", { class: "pill", text: t("laterAdd") });
    const dlBtn = el("button", { class: "pill", text: t("dlBtn") });
    const copyBtn = el("button", { class: "pill", text: t("copyLink") });
    copyBtn.hidden = !CFG.copyLinkButton;
    const playerBtn = el("button", { class: "pill", text: "▶ Media Player" });
    playerBtn.hidden = true;
    const appDlBtn = el("button", { class: "pill", text: t("appDlBtn") });
    appDlBtn.hidden = true;
    const appReduceBtn = el("button", { class: "pill", text: t("appReduceBtn") });
    appReduceBtn.hidden = true;
    const tabTags = el("button", { class: "tab on", text: t("tabTags") });
    const tabInfo = el("button", { class: "tab", text: t("tabInfo") });
    const tabComments = el("button", { class: "tab", text: t("tabComments") });
    const infoList = el("div", { class: "infolist" });
    infoList.hidden = true;
    const commentList = el("div", { class: "commentlist" });
    commentList.hidden = true;
    const sheet = el("div", { class: "sheet" }, [
      el("div", { class: "sheethead" }, [post, laterBtn, dlBtn, copyBtn, playerBtn, appDlBtn, appReduceBtn]),
      el("div", { class: "tabs" }, [tabTags, tabInfo, tabComments]),
      tagList,
      infoList,
      commentList
    ]);
    const quality = el("button", { class: "quality" });
    quality.hidden = true;
    const laterClose = el("button", { text: "✕", title: t("mClose") });
    const laterHead = el("div", { class: "laterhead" }, [el("span", { class: "lt" }), laterClose]);
    const laterGrid = el("div", { class: "latergrid" });
    const laterNote = el("div", { class: "laternote" });
    const laterView = el("div", { class: "laterview" }, [laterHead, laterGrid, laterNote]);
    sheet.hidden = true;
    const full = el("button", { text: "⛶", title: t("mFull") });
    const turn = el("button", { text: "↻", title: t("mTurn") });
    const count = el("span", { class: "count" });
    const dlq = el("span", { class: "dlq" });
    dlq.hidden = true;
    const status = el("div", { class: "status" });
    const fav = el("button", { text: "♡", title: t("mFav") });
    const score = el("span", { class: "score" });
    const up = el("button", { class: "up", title: t("mUp") }, [el("span", { text: "▲" }), score]);
    const toast = el("div", { class: "toast" });
    toast.style.opacity = "0";
    const badge = el("div", { class: "badge" });
    badge.hidden = true;
    const prev = el("button", { class: "side prev", text: "‹", title: t("mPrev") });
    const next = el("button", { class: "side next", text: "›", title: t("mNext") });
    const box = el("div", { class: "m" }, [stage, status, el("div", { class: "bar" }, [close, menu, full, turn, fav, up, count, dlq]), prev, next, quality, sheet, laterView, toast, badge]);
    close.addEventListener("click", () => closeModal(false));
    full.addEventListener("click", () => toggleModalFullscreen());
    menu.addEventListener("click", () => toggleMenu());
    tabTags.addEventListener("click", () => showTab("tags"));
    tabInfo.addEventListener("click", () => showTab("info"));
    tabComments.addEventListener("click", () => showTab("comments"));
    let swallowClick = 0;
    box.addEventListener("pointerdown", (ev) => {
      if (sheet.hidden) return;
      const path = ev.composedPath();
      if (path.includes(sheet) || path.includes(menu) || path.includes(infoBtn)) return;
      closeMenu();
      swallowClick = Date.now() + 600;
      ev.stopPropagation();
      ev.preventDefault();
    }, true);
    box.addEventListener("click", (ev) => {
      if (Date.now() > swallowClick) return;
      swallowClick = 0;
      ev.stopPropagation();
      ev.preventDefault();
    }, true);
    laterBtn.addEventListener("click", () => toggleLaterHere());
    dlBtn.addEventListener("click", () => modalDownload());
    playerBtn.addEventListener("click", () => sendToApp("play"));
    appDlBtn.addEventListener("click", () => sendToApp("download"));
    appReduceBtn.addEventListener("click", () => sendToApp("reduce"));
    let rawHref = null;
    const askRaw = /* @__PURE__ */ __name(() => {
      rawHref = null;
      rawFileUrl().then((u) => {
        rawHref = u;
      }, () => {
      });
    }, "askRaw");
    copyBtn.addEventListener("touchstart", askRaw, { passive: true });
    copyBtn.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType === "mouse") askRaw();
    });
    chipGestures(copyBtn, () => rawHref, () => copyRawLink(), "the post's file");
    laterClose.addEventListener("click", () => closeModal(false));
    quality.addEventListener("click", () => toggleQuality());
    fsBtn.addEventListener("click", () => toggleModalFullscreen());
    turn.addEventListener("click", () => turnScreen());
    fav.addEventListener("click", modalFavorite);
    up.addEventListener("click", modalUpvote);
    favUp.addEventListener("click", () => {
      if (fav.classList.contains("on")) {
        flash(t("favAlready"));
        return;
      }
      modalFavorite();
    });
    infoBtn.addEventListener("click", () => toggleInfo());
    prev.addEventListener("click", () => stepModal(-1));
    next.addEventListener("click", () => stepModal(1));
    stage.addEventListener("click", (ev) => {
      if (ev.target === stage || ev.target === image && zoom.scale === 1 && !onImageContent(ev)) closeModal(false);
    });
    installModalSwipe(stage, video);
    installImageZoom(stage, image);
    installImageHold(stage, image, box);
    installVideoGestures(layer, video);
    root.append(style, box);
    modal = { host, root, box, stage, vwrap, video, image, controls, post, count, status, fav, up, vfav: favUp, gearMenu, dlq, score, toast, badge, turn, fsBtn, menu, sheet, tagList, laterBtn, dlBtn, playerBtn, appDlBtn, appReduceBtn, quality, tabTags, tabInfo, tabComments, infoList, commentList, sheetTab: "tags", laterView, laterHead, laterGrid, laterNote, listLinks: null, turned: null, open: false, link: (
      /** @type {any} */
      null
    ), seq: 0 };
  }
  __name(buildModal, "buildModal");
  var toastTimer = 0;
  function flash(text) {
    modal.toast.textContent = text;
    modal.toast.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      modal.toast.style.opacity = "0";
    }, 1800);
  }
  __name(flash, "flash");
  var MARKS_KEY = `IBH_MARKS_${SITE}`;
  var MARKS_MAX = 5e3;
  var marks = null;
  function loadMarks() {
    if (!marks) {
      const m = readJSON(MARKS_KEY, {});
      marks = { f: new Set(m.f || []), v: new Set(m.v || []), c: new Set(m.c || []) };
    }
    return marks;
  }
  __name(loadMarks, "loadMarks");
  function setMark(kind, id, on) {
    const set = loadMarks()[kind];
    if (on === set.has(id)) return;
    if (on) set.add(id);
    else set.delete(id);
    while (set.size > MARKS_MAX) set.delete(
      /** @type {string} */
      set.values().next().value
    );
    writeJSON(MARKS_KEY, { f: [.../** @type {Marks} */
    marks.f], v: [.../** @type {Marks} */
    marks.v], c: [.../** @type {Marks} */
    marks.c] });
  }
  __name(setMark, "setMark");
  var hasMark = /* @__PURE__ */ __name((kind, id) => loadMarks()[kind].has(id), "hasMark");
  function readCookie(name) {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return m ? m[1] : null;
  }
  __name(readCookie, "readCookie");
  function insidePanel(ev) {
    const path = typeof ev.composedPath === "function" ? ev.composedPath() : [];
    return panelHost ? path.includes(panelHost) : false;
  }
  __name(insidePanel, "insidePanel");
  function asElement(target) {
    return target && /** @type {Partial<Element>} */
    target.closest ? (
      /** @type {Element} */
      target
    ) : null;
  }
  __name(asElement, "asElement");

  // src/thumbs/memory.js
  var FAR_MARGIN = "200% 0px";
  var farViewport = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const e of entries) if (!e.isIntersecting) releaseFar(
      /** @type {HTMLImageElement} */
      e.target
    );
  }, { rootMargin: FAR_MARGIN }) : null;
  function watchDistance(el2) {
    if (CFG.memorySaver && farViewport) farViewport.observe(el2);
  }
  __name(watchDistance, "watchDistance");
  function pinHeight(el2) {
    if (el2.tagName !== "IMG" || !el2.clientHeight) return;
    el2.style.setProperty("height", `${el2.clientHeight}px`, "important");
    el2.dataset.ibhPinned = "1";
  }
  __name(pinHeight, "pinHeight");
  function unpinHeight(el2) {
    if (!el2.dataset.ibhPinned) return;
    el2.style.removeProperty("height");
    delete el2.dataset.ibhPinned;
  }
  __name(unpinHeight, "unpinHeight");
  var releasedCount = 0;
  function releaseFar(el2) {
    if (el2.dataset.ibhOrig !== "done") {
      farViewport.unobserve(el2);
      return;
    }
    pinHeight(el2);
    resetUpgrade(el2);
    farViewport.unobserve(el2);
    if (originalViewport) originalViewport.observe(el2);
    releasedCount++;
    if (releasedCount % 10 === 1) dbg(`memory: released ${releasedCount} off-screen images so far`);
  }
  __name(releaseFar, "releaseFar");
  var liveDecoders = /* @__PURE__ */ __name(() => document.querySelectorAll("video[data-ibh]").length + decodersBorrowed, "liveDecoders");
  function onNodesRemoved(nodes) {
    let unloaded = 0;
    for (const node of nodes) {
      if (node.nodeType !== 1) continue;
      const vids = node.matches && node.matches("video[data-ibh]") ? [
        /** @type {HTMLVideoElement} */
        node
      ] : node.querySelectorAll ? [...node.querySelectorAll("video[data-ibh]")] : [];
      for (const v of vids) {
        if (!v.currentSrc) continue;
        v.removeAttribute("src");
        v.load();
        unloaded++;
      }
    }
    if (!unloaded) return;
    setLiveCovers(liveDecoders());
    for (const card of coverQueue) if (!card.isConnected) coverQueue.delete(card);
    dbg(`memory: unloaded ${unloaded} videos removed from the page`);
  }
  __name(onNodesRemoved, "onNodesRemoved");
  function releaseAll() {
    coverQueue.clear();
    markedCards("[data-ibh-cover]").forEach((card) => unmountCover(card));
    markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach((card) => stopGif(card));
    markedImages('[data-ibh-orig="done"]').forEach((el2) => {
      resetUpgrade(el2);
      if (farViewport) farViewport.unobserve(el2);
      if (originalViewport) originalViewport.observe(el2);
    });
  }
  __name(releaseAll, "releaseAll");
  var SWEEP_MS = 15e3;
  var SWEEP_GAP_MS = 2e3;
  var sweepAt = 0;
  function sweep(why) {
    if (document.hidden || modal && modal.open || scrub) return;
    if (why === "scroll" && Date.now() - sweepAt < SWEEP_GAP_MS) return;
    sweepAt = Date.now();
    const n = freeOffscreen(null);
    if (n.images || n.gifs || n.covers) dbg(`memory: ${why} sweep freed ${n.images} images, ${n.gifs} GIFs, ${n.covers} covers`);
    nextGif();
  }
  __name(sweep, "sweep");
  var parked = [];
  function onVisibilityChange() {
    if (modal && modal.open) return;
    if (document.hidden) {
      parked.push(...coverQueue);
      coverQueue.clear();
      markedCards("[data-ibh-cover]").forEach((card) => {
        unmountCover(card);
        parked.push(card);
      });
      markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach((card) => {
        stopGif(card);
        parked.push(card);
      });
      if (parked.length) dbg(`memory: tab hidden, parked ${parked.length} covers and GIFs`);
      return;
    }
    for (const card of parked.splice(0)) {
      if (!card.isConnected || !card.dataset.ibhSeen) continue;
      if (CFG.videoCovers && isVideoCard(card)) mountCover(card);
      else if (CFG.gifInline && isGifCard(card)) playGif(card);
    }
    sweep("return");
  }
  __name(onVisibilityChange, "onVisibilityChange");
  var previewPaused = [];
  function freeForPreview(card) {
    if (!CFG.memorySaver) return;
    const n = freeOffscreen(card);
    markedCards('[data-ibh-gif="playing"]').forEach((c) => {
      if (c === card) return;
      stopGif(c);
      previewPaused.push(c);
      n.gifs++;
    });
    if (n.images || n.gifs || n.covers) dbg(`memory: preview freed ${n.images} images, ${n.gifs} GIFs, ${n.covers} covers`);
  }
  __name(freeForPreview, "freeForPreview");
  function afterPreview() {
    for (const c of previewPaused.splice(0)) {
      if (c.isConnected && c.dataset.ibhSeen && CFG.gifInline) playGif(c);
    }
  }
  __name(afterPreview, "afterPreview");
  function installMemorySaver() {
    if (!CFG.memorySaver) return;
    setInterval(() => sweep("timed"), SWEEP_MS);
    window.addEventListener("scrollend", () => sweep("scroll"), { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", releaseAll);
    window.addEventListener("pageshow", (ev) => {
      if (ev.persisted) redoThumbs();
    });
    info("memory saver active: off-screen images, GIFs and covers are released (every 15 s, after scrolls, while hidden, before previews)");
  }
  __name(installMemorySaver, "installMemorySaver");

  // src/thumbs/feed.js
  var ORIGINAL_EXTS = ["jpg", "png", "jpeg"];
  var inFeed = /* @__PURE__ */ __name((el2) => CFG.nativeFeed && !!el2.closest(LIST), "inFeed");
  function sampleCandidates(src) {
    const p = thumbParts(src);
    if (!p) return [];
    const bases = [imageBase()];
    try {
      bases.push(`${new URL(src).origin}/images`);
    } catch (e) {
    }
    return [...new Set(
      /** @type {string[]} */
      bases.filter(Boolean)
    )].map((b) => `${b.replace(/\/images$/, "/samples")}/${p.dir}/sample_${p.hash}.jpg`);
  }
  __name(sampleCandidates, "sampleCandidates");
  var SAMPLE_WIDTH = 850;
  function displayPixels(el2) {
    const box = el2.closest(THUMB) || el2;
    return (box.clientWidth || el2.clientWidth || 0) * (window.devicePixelRatio || 1);
  }
  __name(displayPixels, "displayPixels");
  function upgradePlan(el2, src) {
    if (thumbKind(el2) === "video") return { kind: "poster", stages: [fileCandidates(src, ["jpg"])] };
    const originals = fileCandidates(src, ORIGINAL_EXTS);
    const sitePage = true;
    const sampleDoes = sitePage && (!CFG.originalThumbs || displayPixels(el2) <= SAMPLE_WIDTH * 1.1);
    if (sampleDoes && (inFeed(el2) || CFG.originalThumbs)) return { kind: "sample", stages: [sampleCandidates(src), originals] };
    return { kind: "orig", stages: [originals] };
  }
  __name(upgradePlan, "upgradePlan");
  var ORIGINAL_SELECTOR = 'img[src*="/thumbnails/"], img[src*="/samples/"]';
  var originalQueue = [];
  var upgradeGen = 0;
  function setUpgradeGen(v) {
    upgradeGen = v;
  }
  __name(setUpgradeGen, "setUpgradeGen");
  function pictureOf(el2) {
    return imgPicture(el2);
  }
  __name(pictureOf, "pictureOf");
  function thumbKind(el2) {
    const card = el2.closest("a") || el2.parentElement;
    if (card && isGifCard(card)) return "gif";
    if (card && isVideoCard(card)) return "video";
    return "image";
  }
  __name(thumbKind, "thumbKind");
  function upgradeToOriginal(el2) {
    if (el2.dataset.ibhOrig) return true;
    if (!CFG.originalThumbs && !inFeed(el2)) return true;
    if (thumbKind(el2) === "gif") return true;
    const pic = pictureOf(el2);
    if (!pic || !thumbParts(pic.src)) return false;
    el2.dataset.ibhOrig = "queued";
    originalQueue.push(el2);
    pumpOriginals();
    return true;
  }
  __name(upgradeToOriginal, "upgradeToOriginal");
  function nextQueued() {
    const h = window.innerHeight;
    const near = [];
    for (const el2 of originalQueue) {
      if (!el2.isConnected) continue;
      const r = el2.getBoundingClientRect();
      const d = r.bottom < 0 ? -r.bottom : r.top > h ? r.top - h : 0;
      if (d > h * 2) {
        delete el2.dataset.ibhOrig;
        if (originalViewport) originalViewport.observe(el2);
        continue;
      }
      near.push([d, el2]);
    }
    originalQueue.length = 0;
    if (!near.length) return null;
    near.sort((a, b) => a[0] - b[0]);
    originalQueue.push(...near.slice(1).map((pair) => pair[1]));
    return near[0][1];
  }
  __name(nextQueued, "nextQueued");
  var pumpAfterRead = false;
  function pumpOriginals() {
    const later = [];
    while (imagesInflight < IMAGE_MAX_INFLIGHT && originalQueue.length) {
      const el2 = nextQueued();
      if (!el2) break;
      const pic = pictureOf(el2);
      if (!pic) continue;
      const plan = upgradePlan(el2, pic.src);
      const ck = { kind: plan.kind, hash: (thumbParts(pic.src) || {}).hash };
      if (urlPending(ck.kind, ck.hash)) {
        later.push(el2);
        continue;
      }
      ck.cached = cacheGet(ck.kind, ck.hash);
      if (ck.cached === null) {
        el2.dataset.ibhOrig = "failed";
        continue;
      }
      setImagesInflight(imagesInflight + 1);
      probeOriginal(el2, pic.src, plan.stages, giveImageSlot, ck);
    }
    if (!later.length) return;
    originalQueue.push(...later);
    if (!pumpAfterRead && urlReading) {
      pumpAfterRead = true;
      urlReading.then(() => {
        pumpAfterRead = false;
        pumpOriginals();
      });
    }
  }
  __name(pumpOriginals, "pumpOriginals");
  function probeOriginal(el2, from, stages, done, ck) {
    const gen = upgradeGen;
    let probe = null;
    raceImage(stages, ck ? ck.cached : void 0, (winner) => {
      probe = winner;
      if (gen !== upgradeGen) {
        done();
        return;
      }
      if (ck) cacheSet(ck.kind, ck.hash, probe.src, ck.cached);
      const decoded = typeof probe.decode === "function" ? probe.decode().catch(() => {
      }) : Promise.resolve();
      decoded.then(swap);
    }, () => {
      if (gen !== upgradeGen) {
        done();
        return;
      }
      el2.dataset.ibhOrig = "failed";
      if (ck) cacheSet(ck.kind, ck.hash, null);
      dbg(`original: nothing loaded for ${from}`);
      done();
    });
    const swap = /* @__PURE__ */ __name(() => {
      if (gen !== upgradeGen) {
        done();
        return;
      }
      if (el2.dataset.ibhRaw) {
        done();
        return;
      }
      if (modal && modal.open) {
        delete el2.dataset.ibhOrig;
        suspended.push(el2);
        done();
        return;
      }
      if (!inFeed(el2) && el2.clientWidth) {
        el2.style.width = `${el2.clientWidth}px`;
        el2.style.height = `${el2.clientHeight}px`;
        el2.style.objectFit = "contain";
      }
      if (el2.tagName === "IMG") el2.decoding = "async";
      const pic = pictureOf(el2);
      if (pic) pic.set(
        /** @type {HTMLImageElement} */
        probe.src
      );
      el2.dataset.ibhThumb = from;
      el2.dataset.ibhOrig = "done";
      unpinHeight(el2);
      watchDistance(el2);
      dbg(`original: ${/** @type {HTMLImageElement} */
      probe.src}`);
      done();
    }, "swap");
  }
  __name(probeOriginal, "probeOriginal");
  var originalViewport = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      if (modal && modal.open) {
        originalViewport.unobserve(e.target);
        suspended.push(
          /** @type {HTMLImageElement} */
          e.target
        );
        continue;
      }
      if (upgradeToOriginal(
        /** @type {HTMLImageElement} */
        e.target
      )) originalViewport.unobserve(e.target);
    }
  }, { rootMargin: "300px" }) : null;
  var watchedThumbs = /* @__PURE__ */ new WeakSet();
  function scanThumbs(root) {
    if (!(CFG.originalThumbs || CFG.nativeFeed) || !root || !root.querySelectorAll) return;
    const found = [...root.querySelectorAll(ORIGINAL_SELECTOR)];
    if (root.matches && root.matches(ORIGINAL_SELECTOR)) found.push(
      /** @type {HTMLImageElement} */
      root
    );
    for (const el2 of found) {
      if (watchedThumbs.has(el2)) continue;
      watchedThumbs.add(el2);
      urlPrefetch(el2.getAttribute("src"));
      originalViewport ? originalViewport.observe(el2) : upgradeToOriginal(el2);
    }
  }
  __name(scanThumbs, "scanThumbs");

  // src/thumbs/covers.js
  var tracked = /* @__PURE__ */ new WeakSet();
  function markedCards(selector) {
    return (
      /** @type {NodeListOf<HTMLElement>} */
      document.querySelectorAll(selector)
    );
  }
  __name(markedCards, "markedCards");
  function markedImages(selector) {
    return (
      /** @type {NodeListOf<HTMLImageElement>} */
      document.querySelectorAll(selector)
    );
  }
  __name(markedImages, "markedImages");
  var nativeTags = /* @__PURE__ */ __name((card) => {
    const img = card.querySelector("img");
    return ` ${img && (img.title || img.alt) || ""} `;
  }, "nativeTags");
  var NATIVE_GIF = /\s(gif|animated_gif)\s/i;
  var NATIVE_VIDEO = /\s(video|mp4|webm|animated)\s/i;
  var NATIVE_REAL_VIDEO = /\s(video|mp4|webm)\s/i;
  var isVideoCard = /* @__PURE__ */ __name((card) => !!card.querySelector("img.webm-thumb") || // the site's own video mark
  NATIVE_VIDEO.test(nativeTags(card)) && !NATIVE_GIF.test(nativeTags(card)), "isVideoCard");
  var isGifCard = /* @__PURE__ */ __name((card) => card.dataset.ibhKind === "gif" || NATIVE_GIF.test(nativeTags(card)), "isGifCard");
  var cardPicture = /* @__PURE__ */ __name((card) => {
    const img = card.querySelector("img");
    return img ? imgPicture(img) : null;
  }, "cardPicture");
  function imgPicture(img) {
    if (!img.src) return null;
    return {
      src: img.src,
      set: /* @__PURE__ */ __name((url) => {
        if (!url || url === img.src) img.removeAttribute("srcset");
        else img.srcset = url.replace(/ /g, "%20").replace(/,/g, "%2C");
      }, "set")
    };
  }
  __name(imgPicture, "imgPicture");
  var COVER_MAX_LIVE = 3;
  var COVER_POINT = 0.35;
  var liveCovers = 0;
  function setLiveCovers(v) {
    liveCovers = v;
  }
  __name(setLiveCovers, "setLiveCovers");
  var coverQueue = /* @__PURE__ */ new Set();
  var knownGifs = /* @__PURE__ */ new Set();
  function releaseCover() {
    liveCovers = Math.max(0, liveCovers - 1);
    for (const card of coverQueue) {
      if (liveCovers >= COVER_MAX_LIVE) break;
      coverQueue.delete(card);
      if (card.isConnected && card.dataset.ibhSeen) mountCover(card);
    }
  }
  __name(releaseCover, "releaseCover");
  function mountCover(card) {
    if (card.dataset.ibhCover || card.dataset.ibhBigVideo) return;
    const pic = cardPicture(card);
    if (!pic) return;
    const parts = thumbParts(pic.src);
    const wait = parts && urlPending("video", parts.hash);
    if (wait) {
      wait.then(() => {
        if (card.isConnected && card.dataset.ibhSeen && !(modal && modal.open)) mountCover(card);
      });
      return;
    }
    const vcached = parts ? cacheGet("video", parts.hash) : void 0;
    if (parts && (knownGifs.has(parts.hash) || vcached === null)) card.dataset.ibhKind = "gif";
    if (card.dataset.ibhKind === "gif") {
      if (CFG.gifInline) playGif(card);
      return;
    }
    if (liveCovers >= COVER_MAX_LIVE) {
      coverQueue.add(card);
      return;
    }
    const urls = cachedFirst(fileCandidates(pic.src, ["mp4", "webm"]), vcached);
    if (!urls.length) {
      dbg("video card outside the derivable pattern");
      return;
    }
    card.dataset.ibhCover = "1";
    liveCovers++;
    const v = document.createElement("video");
    v.dataset.ibh = "1";
    v.muted = true;
    v.playsInline = true;
    v.preload = "metadata";
    v.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:4px;pointer-events:none;opacity:0;transition:opacity .2s";
    const giveUp = /* @__PURE__ */ __name(() => {
      v.remove();
      delete card.dataset.ibhCover;
      releaseCover();
    }, "giveUp");
    let i = 0;
    let networkError = false;
    const tryNext = /* @__PURE__ */ __name(() => {
      if (card.dataset.ibhBigVideo) return;
      if (v.error && v.error.code === 3) {
        giveUp();
        dbg(`cover: no decoder free for ${pic.src}`);
        return;
      }
      if (v.error && v.error.code === 2) networkError = true;
      if (i >= urls.length) {
        giveUp();
        if (networkError || navigator.onLine === false) {
          dbg(`cover: network error for ${pic.src}, will retry`);
          return;
        }
        card.dataset.ibhKind = "gif";
        if (parts) {
          knownGifs.add(parts.hash);
          cacheSet("video", parts.hash, null);
        }
        const marked = card.querySelector("img[data-ibh-mark]");
        if (marked) {
          marked.classList.remove("webm-thumb");
          delete marked.dataset.ibhMark;
        }
        dbg(`no video host answered for ${pic.src}; trying it as a GIF`);
        if (CFG.gifInline) playGif(card);
        else {
          STATE.covers.failed++;
          touch();
        }
        return;
      }
      v.src = urls[i++];
    }, "tryNext");
    let seekingCover = false;
    const reveal = /* @__PURE__ */ __name(() => {
      if (v.style.opacity === "1") return;
      v.style.opacity = "1";
      STATE.covers.ok++;
      touch();
    }, "reveal");
    v.addEventListener("loadedmetadata", () => {
      if (parts) cacheSet("video", parts.hash, urls[i - 1], vcached);
      markDuration(card, v.duration);
      setDims(postId(card), v.videoWidth, v.videoHeight);
      if (pastDecoder(v.videoWidth, v.videoHeight)) {
        markPastDecoder(card, `${v.videoWidth}x${v.videoHeight}`);
        dbg(`cover: ${v.videoWidth}x${v.videoHeight} is past the hardware decoder, poster kept instead`);
        v.removeAttribute("src");
        v.load();
        giveUp();
        return;
      }
      if (Number.isFinite(v.duration) && v.duration > 0) {
        seekingCover = true;
        v.currentTime = v.duration * COVER_POINT;
      }
    }, { once: true });
    v.addEventListener("seeked", reveal, { once: true });
    v.addEventListener("loadeddata", () => {
      if (!seekingCover) reveal();
    }, { once: true });
    v.addEventListener("error", tryNext);
    tryNext();
    const thumb = card.querySelector("img");
    if (thumb) {
      v.style.border = getComputedStyle(thumb).border;
      v.style.boxSizing = "border-box";
      v.style.borderRadius = "0";
    }
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    const picEl = card.querySelector(":scope > img");
    if (picEl) picEl.after(v);
    else card.appendChild(v);
  }
  __name(mountCover, "mountCover");
  function unmountCover(card) {
    coverQueue.delete(card);
    const v = card.querySelector("video[data-ibh]");
    if (!v) return;
    v.removeAttribute("src");
    v.load();
    v.remove();
    delete card.dataset.ibhCover;
    releaseCover();
  }
  __name(unmountCover, "unmountCover");
  var IMAGE_MAX_INFLIGHT = 3;
  var imagesInflight = 0;
  function setImagesInflight(v) {
    imagesInflight = v;
  }
  __name(setImagesInflight, "setImagesInflight");
  var imageWaiters = [];
  function takeImageSlot(start) {
    if (imagesInflight < IMAGE_MAX_INFLIGHT) {
      imagesInflight++;
      start();
    } else imageWaiters.push(start);
  }
  __name(takeImageSlot, "takeImageSlot");
  function giveImageSlot() {
    imagesInflight = Math.max(0, imagesInflight - 1);
    const next = imageWaiters.shift();
    if (next) {
      imagesInflight++;
      next();
    } else pumpOriginals();
  }
  __name(giveImageSlot, "giveImageSlot");
  var gifQueue = /* @__PURE__ */ new Set();
  var gifsLive = /* @__PURE__ */ __name(() => markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').length, "gifsLive");
  var fromMiddle = /* @__PURE__ */ __name((card) => Math.abs(card.getBoundingClientRect().top + card.offsetHeight / 2 - window.innerHeight / 2), "fromMiddle");
  function nextGif() {
    if (document.hidden || modal && modal.open || scrub) return;
    const max = Number(CFG.gifMaxLive) || 3;
    const waiting = [...gifQueue].filter((card) => {
      if (card.isConnected && card.dataset.ibhSeen && !card.dataset.ibhGif) return true;
      gifQueue.delete(card);
      return false;
    });
    waiting.sort((a, b) => fromMiddle(a) - fromMiddle(b));
    for (const card of waiting) {
      if (gifsLive() >= max) break;
      gifQueue.delete(card);
      playGif(card);
    }
  }
  __name(nextGif, "nextGif");
  function applyGifLimit() {
    const max = Number(CFG.gifMaxLive) || 3;
    const middle = window.innerHeight / 2;
    const live = [...markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]')].sort((a, b) => Math.abs(b.getBoundingClientRect().top - middle) - Math.abs(a.getBoundingClientRect().top - middle));
    for (const card of live.splice(0, live.length - max)) {
      stopGif(card);
      gifQueue.add(card);
    }
    nextGif();
  }
  __name(applyGifLimit, "applyGifLimit");
  var gifLoads = /* @__PURE__ */ new WeakMap();
  function playGif(card) {
    if (card.dataset.ibhGif) return;
    if (gifRebuild && gifRebuild !== card) {
      gifQueue.add(card);
      return;
    }
    if (gifsLive() >= (Number(CFG.gifMaxLive) || 3)) {
      gifQueue.add(card);
      return;
    }
    const pic = cardPicture(card);
    if (!pic) return;
    const hash = (thumbParts(pic.src) || {}).hash;
    const wait = urlPending("gif", hash);
    if (wait) {
      gifQueue.add(card);
      wait.then(nextGif);
      return;
    }
    const gcached = cacheGet("gif", hash);
    const urls = cachedFirst(fileCandidates(pic.src, ["gif"]), gcached);
    if (!urls.length) {
      dbg("gif card outside the derivable pattern");
      return;
    }
    if (gcached === null) {
      card.dataset.ibhGif = "failed";
      return;
    }
    card.dataset.ibhGif = "loading";
    const probe = new Image();
    let i = 0;
    let held = false;
    let live = true;
    const release = /* @__PURE__ */ __name(() => {
      if (held) {
        held = false;
        giveImageSlot();
      }
    }, "release");
    gifLoads.set(card, () => {
      live = false;
      probe.onload = probe.onerror = null;
      probe.removeAttribute("src");
      release();
    });
    const tryNext = /* @__PURE__ */ __name(() => {
      if (i >= urls.length) {
        gifLoads.delete(card);
        release();
        card.dataset.ibhGif = "failed";
        cacheSet("gif", hash, null);
        if (card.dataset.ibhKind === "gif") {
          STATE.covers.failed++;
          touch();
        }
        dbg(`gif: no host answered for ${pic.src}`);
        if (gifRebuild === card) warn("gif: held to rebuild it, but no host answered");
        endGifRebuild(card);
        nextGif();
        return;
      }
      probe.src = urls[i++];
    }, "tryNext");
    probe.onload = () => {
      gifLoads.delete(card);
      release();
      cacheSet("gif", hash, probe.src, gcached);
      if (card.dataset.ibhGif !== "loading") return;
      card.dataset.ibhStill = pic.src;
      cardPicture(card).set(probe.src);
      card.dataset.ibhGif = "playing";
      watchGif(card);
      endGifRebuild(card, GIF_REBUILD_GRACE_MS);
      if (card.dataset.ibhKind === "gif") {
        STATE.covers.ok++;
        touch();
      }
      dbg(`gif: playing ${probe.src}`);
    };
    probe.onerror = tryNext;
    takeImageSlot(() => {
      if (!live) {
        giveImageSlot();
        return;
      }
      held = true;
      tryNext();
    });
  }
  __name(playGif, "playGif");
  var GIF_RETRIES = 2;
  function watchGif(card) {
    const img = card.querySelector("img");
    if (!img || img.dataset.ibhGifWatch) return;
    img.dataset.ibhGifWatch = "1";
    const check = /* @__PURE__ */ __name((ev) => {
      if (card.dataset.ibhGif !== "playing" || !img.srcset) return;
      if (ev.type === "error" || img.naturalWidth === 0) gifBroken(card);
    }, "check");
    img.addEventListener("error", check);
    img.addEventListener("load", check);
  }
  __name(watchGif, "watchGif");
  function gifBroken(card) {
    const tries = Number(card.dataset.ibhGifRetries || 0);
    if (tries >= GIF_RETRIES) {
      stopGif(card);
      card.dataset.ibhGif = "failed";
      warn("gif: still broken after rebuilding, left as a still");
      return;
    }
    card.dataset.ibhGifRetries = String(tries + 1);
    const freed = freeOffscreen(card);
    info(`gif: broken, freed ${freed.images} images, ${freed.gifs} GIFs, ${freed.covers} covers; rebuilding (try ${tries + 1})`);
    stopGif(card);
    setTimeout(() => {
      if (card.isConnected && card.dataset.ibhSeen) playGif(card);
    }, 400);
  }
  __name(gifBroken, "gifBroken");
  var GIF_REBUILD_GRACE_MS = 1e3;
  var GIF_REBUILD_MAX_MS = 1e4;
  var gifRebuild = null;
  var gifRebuildTimer = 0;
  function rebuildGif(card) {
    const pic = cardPicture(card);
    if (!pic) return;
    const freed = freeOffscreen(card);
    let paused = 0;
    markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach((c) => {
      if (c === card) return;
      stopGif(c);
      gifQueue.add(c);
      paused++;
    });
    const was = card.dataset.ibhGif || "still";
    stopGif(card);
    delete card.dataset.ibhGif;
    delete card.dataset.ibhGifRetries;
    forgetMiss("gif", (thumbParts(pic.src) || {}).hash);
    gifRebuild = card;
    clearTimeout(gifRebuildTimer);
    gifRebuildTimer = setTimeout(() => endGifRebuild(card), GIF_REBUILD_MAX_MS);
    info(`gif: held, rebuilding it (was ${was}); ${paused} other GIFs paused until it plays, freed ${freed.images} images, ${freed.gifs} GIFs, ${freed.covers} covers off screen`);
    playGif(card);
  }
  __name(rebuildGif, "rebuildGif");
  function endGifRebuild(card, after = 0) {
    if (gifRebuild !== card) return;
    clearTimeout(gifRebuildTimer);
    gifRebuildTimer = setTimeout(() => {
      if (gifRebuild !== card) return;
      gifRebuild = null;
      nextGif();
    }, after);
  }
  __name(endGifRebuild, "endGifRebuild");
  function freeOffscreen(keep) {
    const n = { images: 0, gifs: 0, covers: 0 };
    const far = /* @__PURE__ */ __name((el2) => {
      const r = el2.getBoundingClientRect();
      return r.bottom < -window.innerHeight || r.top > window.innerHeight * 2;
    }, "far");
    markedImages('[data-ibh-orig="done"]').forEach((el2) => {
      if (!far(el2)) return;
      pinHeight(el2);
      resetUpgrade(el2);
      if (farViewport) farViewport.unobserve(el2);
      if (originalViewport) originalViewport.observe(el2);
      n.images++;
    });
    markedCards('[data-ibh-gif="playing"], [data-ibh-gif="loading"]').forEach((card) => {
      if (card !== keep && far(card)) {
        stopGif(card);
        n.gifs++;
      }
    });
    markedCards("[data-ibh-cover]").forEach((card) => {
      if (far(card)) {
        unmountCover(card);
        n.covers++;
      }
    });
    return n;
  }
  __name(freeOffscreen, "freeOffscreen");
  function stopGif(card) {
    endGifRebuild(card);
    gifQueue.delete(card);
    const cancel = gifLoads.get(card);
    if (cancel) {
      gifLoads.delete(card);
      cancel();
    }
    const state = card.dataset.ibhGif;
    if (state === "playing" && card.dataset.ibhStill) {
      const pic = cardPicture(card);
      if (pic) pic.set(card.dataset.ibhStill);
    }
    if (state === "playing" || state === "loading") {
      delete card.dataset.ibhGif;
      setTimeout(nextGif, 0);
    }
  }
  __name(stopGif, "stopGif");
  var viewport = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      const card = (
        /** @type {HTMLElement} */
        e.target
      );
      if (e.isIntersecting) card.dataset.ibhSeen = "1";
      else delete card.dataset.ibhSeen;
      if (modal && modal.open) continue;
      if (isVideoCard(card) && card.dataset.ibhKind !== "gif") {
        e.isIntersecting ? mountCover(card) : unmountCover(card);
      } else if (!e.isIntersecting) {
        stopGif(card);
      } else if (CFG.gifInline) {
        playGif(card);
      }
    }
  }, { rootMargin: "200px" }) : null;
  function trackCard(card) {
    if (tracked.has(card)) return;
    tracked.add(card);
    urlPrefetch(card.querySelector("img")?.getAttribute("src"));
    if (CFG.videoScrub && isVideoCard(card)) {
      card.dataset.ibhVideo = "1";
      card.setAttribute("draggable", "false");
      const img = card.querySelector("img");
      if (img) img.draggable = false;
    }
    const video = CFG.videoCovers && isVideoCard(card);
    const gif = CFG.gifInline && isGifCard(card);
    if (!video && !gif) return;
    if (video) {
      STATE.covers.tracked++;
      touch();
    }
    if (viewport) viewport.observe(card);
    else {
      card.dataset.ibhSeen = "1";
      video ? mountCover(card) : playGif(card);
    }
  }
  __name(trackCard, "trackCard");
  var NATIVE_THUMB = `${THUMB} img`;
  function scanCards(root) {
    if (!root || !root.querySelectorAll) return;
    const imgs = (
      /** @type {HTMLImageElement[]} */
      [...root.querySelectorAll(NATIVE_THUMB)]
    );
    if (root.matches && root.matches(NATIVE_THUMB)) imgs.push(
      /** @type {HTMLImageElement} */
      root
    );
    for (const img of imgs) {
      const link = (
        /** @type {HTMLElement} */
        img.closest("a") || img.parentElement
      );
      const tags = nativeTags(link);
      if (!img.classList.contains("webm-thumb") && NATIVE_REAL_VIDEO.test(tags) && !NATIVE_GIF.test(tags)) {
        img.classList.add("webm-thumb");
        img.dataset.ibhMark = "1";
      }
      if (getComputedStyle(link).display === "inline") link.style.display = "inline-block";
      trackCard(link);
      paintCardMarks(link);
    }
  }
  __name(scanCards, "scanCards");

  // src/scrub/scrub.js
  var EXACT_SEEK_MAX_S = 60;
  var REST_MS = 180;
  var seekState = /* @__PURE__ */ new WeakMap();
  var isBuffered = /* @__PURE__ */ __name((v, t2) => {
    for (let i = 0; i < v.buffered.length; i++) if (t2 >= v.buffered.start(i) && t2 <= v.buffered.end(i)) return true;
    return false;
  }, "isBuffered");
  function seekFraction(v, f, now = false) {
    let st = seekState.get(v);
    if (!st) {
      st = { wanted: null, pending: null, rest: 0 };
      seekState.set(v, st);
      v.addEventListener("seeked", () => {
        if (
          /** @type {SeekState} */
          st.wanted === null
        ) return;
        const t3 = (
          /** @type {number} */
          /** @type {SeekState} */
          st.wanted
        );
        st.wanted = null;
        seekTo(v, t3);
      });
      v.addEventListener("loadedmetadata", () => {
        if (
          /** @type {SeekState} */
          st.pending === null
        ) return;
        const p = (
          /** @type {number} */
          /** @type {SeekState} */
          st.pending
        );
        st.pending = null;
        seekFraction(v, p, true);
      });
    }
    const d = v.duration;
    if (!Number.isFinite(d) || d <= 0) {
      st.pending = f;
      return null;
    }
    const t2 = f * d;
    clearTimeout(st.rest);
    if (v.seeking) st.wanted = t2;
    else if (now || isBuffered(v, t2)) seekTo(v, t2);
    else st.rest = setTimeout(() => {
      if (v.seeking) st.wanted = t2;
      else seekTo(v, t2);
    }, REST_MS);
    return { t: t2, d };
  }
  __name(seekFraction, "seekFraction");
  function seekTo(v, t2) {
    if (v.duration > EXACT_SEEK_MAX_S && typeof v.fastSeek === "function") v.fastSeek(t2);
    else v.currentTime = t2;
  }
  __name(seekTo, "seekTo");
  var previewEl = null;
  function setPreviewEl(v) {
    previewEl = v;
  }
  __name(setPreviewEl, "setPreviewEl");
  function previewLoad(container, urls, hash) {
    if (!previewEl) {
      previewEl = document.createElement("video");
      previewEl.muted = true;
      previewEl.playsInline = true;
      previewEl.preload = "auto";
      previewEl.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;background:#000";
    }
    const v = previewEl;
    let i = 0;
    v.onerror = () => {
      if (i < urls.length) v.src = urls[i++];
    };
    v.onloadedmetadata = () => {
      if (hash) cacheSet("video", hash, urls[i - 1]);
    };
    v.src = urls[i++];
    container.insertBefore(v, container.firstChild);
    return v;
  }
  __name(previewLoad, "previewLoad");
  function previewStop() {
    if (!previewEl) return;
    previewEl.onerror = previewEl.onloadedmetadata = null;
    previewEl.removeAttribute("src");
    previewEl.load();
    previewEl.remove();
  }
  __name(previewStop, "previewStop");
  var decodersBorrowed = 0;
  function borrowDecoder(card) {
    decodersBorrowed++;
    setLiveCovers(liveCovers + 1);
    if (liveCovers <= COVER_MAX_LIVE) return;
    const victim = [...markedCards("[data-ibh-cover]")].find((c) => c !== card);
    if (!victim) return;
    unmountCover(victim);
    if (victim.dataset.ibhSeen) coverQueue.add(victim);
  }
  __name(borrowDecoder, "borrowDecoder");
  function returnDecoder() {
    if (!decodersBorrowed) return;
    decodersBorrowed--;
    releaseCover();
  }
  __name(returnDecoder, "returnDecoder");
  function placeOverPicture(card, node) {
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    const picEl = card.querySelector(":scope > img");
    if (picEl) picEl.after(node);
    else card.appendChild(node);
  }
  __name(placeOverPicture, "placeOverPicture");
  var SCRUB_SLOP = 8;
  var scrub = null;
  var scrubClickUntil = 0;
  function onScrubDown(ev) {
    if (scrub || insidePanel(ev) || modal && modal.open) return;
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    if (asElement(ev.target)?.closest("[data-ibh-chip], .ibh-liked")) return;
    const card = (
      /** @type {HTMLElement | null | undefined} */
      asElement(ev.target)?.closest("[data-ibh-video]")
    );
    if (!card || card.dataset.ibhKind === "gif") return;
    scrub = /** @type {Scrub} */
    { card, id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, on: false, holdTimer: 0 };
    if (CFG.scrubMode === "hold") scrub.holdTimer = setTimeout(startSlideshow, HOLD_MS);
  }
  __name(onScrubDown, "onScrubDown");
  var HOLD_MS = 200;
  var SLIDE_WAIT_MS = 1e3;
  var SLIDE_TICK_MS = 50;
  function slideSteps() {
    const n = Math.max(2, Math.round(100 / (Number(CFG.slideStep) || 10)));
    return Array.from({ length: n }, (_, i) => i / n);
  }
  __name(slideSteps, "slideSteps");
  function startSlideshow() {
    if (!scrub || scrub.on) return;
    scrub.stats = { t0: performance.now(), method: null, first: null, last: 0, shown: 0, gaps: [] };
    if (CFG.holdVideo && !scrub.card.dataset.ibhBigVideo) {
      if (!startScrub()) {
        dropScrub();
        return;
      }
      holdVideoShow(scrub);
      return;
    }
    if (CFG.slideReel && startReelShow(scrub)) return;
    if (!startScrub()) {
      dropScrub();
      return;
    }
    if (CFG.slideReel) chooseShow(scrub);
    else seekShow(scrub);
  }
  __name(startSlideshow, "startSlideshow");
  var HOLD_FPS_SLACK = 1.04;
  function holdVideoShow(s) {
    const v = s.video;
    const tooHeavy = /* @__PURE__ */ __name((what) => {
      markPastDecoder(s.card, what);
      info(`hold: ${what} is past the hardware decoder, the slideshow instead of the video`);
      if (!(CFG.slideReel && startReelShow(s))) seekShow(s);
    }, "tooHeavy");
    const decide = /* @__PURE__ */ __name(() => {
      if (scrub !== s) return;
      markDuration(s.card, v.duration);
      if (pastDecoder(v.videoWidth, v.videoHeight)) {
        tooHeavy(`${v.videoWidth}x${v.videoHeight}`);
        return;
      }
      playShow(s, 1, 0);
      const frames = /* @__PURE__ */ __name(() => v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : 0, "frames");
      let start = null;
      const measure = /* @__PURE__ */ __name(() => {
        if (scrub !== s || s.stats.method !== "play") {
          v.removeEventListener("timeupdate", measure);
          return;
        }
        if (v.paused || v.seeking) {
          start = null;
          return;
        }
        if (!start) {
          start = { f: frames(), t: v.currentTime };
          return;
        }
        const dt = v.currentTime - start.t;
        if (dt < 0) {
          start = null;
          return;
        }
        if (dt < 1) return;
        v.removeEventListener("timeupdate", measure);
        const fps = (frames() - start.f) / dt;
        s.stats.fps = fps;
        if (!pastDecoder(v.videoWidth, v.videoHeight, fps / HOLD_FPS_SLACK)) return;
        endPlayShow(s);
        tooHeavy(`${v.videoWidth}x${v.videoHeight} at ${Math.round(fps)} fps`);
      }, "measure");
      v.addEventListener("timeupdate", measure);
    }, "decide");
    if (v.readyState >= 1) decide();
    else v.addEventListener("loadedmetadata", decide, { once: true });
  }
  __name(holdVideoShow, "holdVideoShow");
  function seekShow(s) {
    s.stats.method = "seek";
    const base = s.video;
    s.steps = slideSteps();
    s.dwell = (Number(CFG.slideDwell) || 0.2) * 1e3;
    s.step = 0;
    s.views = [slideView(s, base, false)];
    s.queue = [];
    s.front = null;
    s.shownAt = 0;
    s.label.textContent = "…";
    loadSlide(s, s.views[0]);
    const withSrc = /* @__PURE__ */ __name(() => {
      if (scrub === s) addSlideHelper(s);
    }, "withSrc");
    if (base.readyState >= 1) withSrc();
    else base.addEventListener("loadedmetadata", withSrc, { once: true });
    s.tick = setInterval(() => tickSlide(s), SLIDE_TICK_MS);
  }
  __name(seekShow, "seekShow");
  function slideView(s, v, helper) {
    const view = { v, helper, f: 0, ready: false, slow: false, since: 0 };
    view.onSeeked = () => setTimeout(() => {
      if (v.seeking) return;
      view.ready = true;
      view.slow = false;
      tickSlide(s);
    }, 0);
    v.addEventListener("seeked", view.onSeeked);
    return view;
  }
  __name(slideView, "slideView");
  function loadSlide(s, view) {
    view.f = s.steps[s.step++ % s.steps.length];
    view.ready = false;
    view.since = Date.now();
    s.queue.push(view);
    seekFraction(view.v, view.f, true);
  }
  __name(loadSlide, "loadSlide");
  function addSlideHelper(s) {
    const src = s.video.currentSrc;
    if (!src) return;
    borrowDecoder(s.card);
    const h = document.createElement("video");
    h.muted = true;
    h.playsInline = true;
    h.preload = "metadata";
    h.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:4px;pointer-events:none;opacity:0";
    h.onerror = () => {
      if (scrub === s) dropSlideHelper(s);
    };
    h.src = src;
    s.video.after(h);
    const view = slideView(s, h, true);
    s.helper = view;
    s.views.push(view);
    loadSlide(s, view);
  }
  __name(addSlideHelper, "addSlideHelper");
  function dropSlideHelper(s) {
    const view = s.helper;
    if (!view) return;
    s.helper = null;
    view.v.removeEventListener(
      "seeked",
      /** @type {() => void} */
      view.onSeeked
    );
    view.v.onerror = null;
    view.v.removeAttribute("src");
    view.v.load();
    view.v.remove();
    returnDecoder();
    s.views = s.views.filter((o) => o !== view);
    s.queue = s.queue.filter((o) => o !== view);
    if (s.front === view) s.front = null;
    if (!s.queue.length) loadSlide(s, s.views[0]);
  }
  __name(dropSlideHelper, "dropSlideHelper");
  function showSlide(s, view) {
    if (s.helper) s.helper.v.style.opacity = view === s.helper ? "1" : "0";
    const d = view.v.duration;
    s.bar.style.width = `${view.f * 100}%`;
    s.label.textContent = `${mmss(view.f * d)} / ${mmss(d)}`;
    noteScene(s);
  }
  __name(showSlide, "showSlide");
  function noteScene(s) {
    const st = s.stats;
    if (!st) return;
    const now = performance.now();
    if (st.first === null) st.first = now - st.t0;
    else st.gaps.push(now - st.last);
    st.last = now;
    st.shown++;
  }
  __name(noteScene, "noteScene");
  function logSlideStats(s) {
    const st = s.stats;
    if (!st || !st.method) return;
    const dwell = (Number(CFG.slideDwell) || 0.2) * 1e3;
    const avg = st.gaps.length ? Math.round(st.gaps.reduce((a, b) => a + b, 0) / st.gaps.length) : 0;
    const late = st.gaps.filter((g) => g > dwell + 300).length;
    const shown = st.first === null ? `no scene in ${Math.round(performance.now() - st.t0)} ms` : st.method === "play" ? `playing after ${Math.round(st.first)} ms at ${st.rate ?? PLAY_RATE}×${st.fps ? `, ${Math.round(st.fps)} fps` : ""}${st.sound ? `, ${st.sound}` : ""}` + (st.resumed !== void 0 ? `, resumed at ${mmss(st.resumed)}` : "") + (st.kept !== void 0 ? `, lifted at ${mmss(st.kept)}` : "") + (st.rubs ? `, rubbed ${st.rubs}×` : "") : `${st.shown} scenes, first after ${Math.round(st.first)} ms${avg ? `, then every ${avg} ms` : ""} (dwell ${dwell}), ${late} late`;
    const v = s.video;
    const what = (st.detail || (v ? `${v.videoWidth}x${v.videoHeight}, ${mmss(v.duration)}, ${s.shared ? "own video" : "its cover"}` : "")) + (st.wasm ? `, ${st.wasm}` : "");
    info(`slideshow (${st.method}) post ${postId(s.card)}: ${shown}${what ? `; ${what}` : ""}${st.reelError ? `; no reel: ${st.reelError}` : ""}`);
  }
  __name(logSlideStats, "logSlideStats");
  function tickSlide(s) {
    if (scrub !== s) return;
    const now = Date.now();
    if (now - s.shownAt >= s.dwell) {
      const i = s.queue.findIndex((o) => o.ready);
      if (i >= 0) {
        const view = s.queue[i];
        const overtaken = s.queue.splice(0, i + 1).slice(0, i);
        const prev = s.front;
        showSlide(s, view);
        s.front = view;
        s.shownAt = now;
        for (const o of overtaken) {
          loadSlide(s, o);
          o.slow = true;
        }
        if (prev && prev !== view && !s.queue.includes(prev)) loadSlide(s, prev);
      } else if (s.queue.length && (s.queue[0].slow || now - s.queue[0].since > SLIDE_WAIT_MS) && s.front && !s.queue.includes(s.front)) {
        loadSlide(s, s.front);
      }
    }
    if (!s.queue.length && s.front && now - s.shownAt >= s.dwell) loadSlide(s, s.front);
  }
  __name(tickSlide, "tickSlide");
  function endSlideshow(s) {
    clearInterval(s.tick);
    for (const view of s.views || []) view.v.removeEventListener(
      "seeked",
      /** @type {() => void} */
      view.onSeeked
    );
    const helper = s.helper;
    if (!helper) return;
    if (s.front === helper && !s.shared) seekFraction(s.video, helper.f, true);
    s.queue = [];
    s.helper = null;
    helper.v.onerror = null;
    helper.v.removeAttribute("src");
    helper.v.load();
    helper.v.remove();
    returnDecoder();
  }
  __name(endSlideshow, "endSlideshow");
  var PLAY_MAX_S = 30;
  var PLAY_RATE = 2;
  function chooseShow(s) {
    const v = s.video;
    const decide = /* @__PURE__ */ __name(() => {
      if (scrub !== s) return;
      markDuration(s.card, v.duration);
      if (v.duration <= PLAY_MAX_S && !pastDecoder(v.videoWidth, v.videoHeight) && !s.card.dataset.ibhBigVideo) playShow(s);
      else seekShow(s);
    }, "decide");
    if (v.readyState >= 1) decide();
    else v.addEventListener("loadedmetadata", decide, { once: true });
  }
  __name(chooseShow, "chooseShow");
  function playShow(s, rate = PLAY_RATE, from) {
    s.stats.method = "play";
    s.stats.rate = rate;
    const v = s.video;
    const resumed = resumePoint(s.card);
    if (resumed !== null) s.stats.resumed = resumed;
    const at = resumed ?? from;
    if (at !== void 0 && at !== v.currentTime) v.currentTime = at;
    s.played = { rate: v.playbackRate, loop: v.loop, muted: v.muted };
    v.loop = true;
    v.playbackRate = rate;
    v.muted = !CFG.previewSound;
    if (CFG.previewSound) s.stats.sound = "with sound";
    soundChip(s.card);
    s.onPlayTime = () => {
      if (scrub !== s || !v.duration || s.rub?.active()) return;
      s.bar.style.width = `${v.currentTime / v.duration * 100}%`;
      s.label.textContent = `${mmss(v.currentTime)} / ${mmss(v.duration)} · ${rate}×`;
    };
    v.addEventListener("timeupdate", s.onPlayTime);
    v.addEventListener("playing", () => {
      if (scrub === s) noteScene(s);
    }, { once: true });
    const go = /* @__PURE__ */ __name(() => {
      if (scrub !== s) return;
      v.play().catch((e) => {
        if (e.name !== "NotAllowedError" || v.muted || scrub !== s) {
          dbg(`slideshow: play refused — ${describeError(e)}`);
          return;
        }
        s.stats.sound = "muted: sound blocked until the page is tapped";
        v.muted = true;
        v.play().catch((e2) => dbg(`slideshow: play refused — ${describeError(e2)}`));
      });
    }, "go");
    if (v.readyState >= 2) go();
    else v.addEventListener("canplay", go, { once: true });
  }
  __name(playShow, "playShow");
  function endPlayShow(s) {
    const v = s.video;
    v.removeEventListener(
      "timeupdate",
      /** @type {() => void} */
      s.onPlayTime
    );
    s.onPlayTime = null;
    v.pause();
    v.playbackRate = s.played.rate;
    v.loop = s.played.loop;
    v.muted = s.played.muted;
  }
  __name(endPlayShow, "endPlayShow");
  var RESUME_MS = 6e4;
  var resumes = /* @__PURE__ */ new Map();
  function resumePoint(card) {
    if (!CFG.holdResume) return null;
    const id = postId(card);
    const r = resumes.get(id);
    if (!r) return null;
    if (Date.now() > r.until) {
      resumes.delete(id);
      return null;
    }
    return r.t;
  }
  __name(resumePoint, "resumePoint");
  function keepResume(s) {
    const id = postId(s.card);
    const t2 = s.video.currentTime;
    if (!CFG.holdResume || id === "?" || !(t2 >= 1)) return;
    resumes.set(id, { t: t2, until: Date.now() + RESUME_MS });
    s.stats.kept = t2;
  }
  __name(keepResume, "keepResume");
  function holdChip(card, kind) {
    const had = (
      /** @type {HTMLElement | null} */
      card.querySelector(`[data-ibh-chip="${kind}"]`)
    );
    if (had) return had;
    const chip = document.createElement("span");
    chip.dataset.ibhChip = kind;
    chip.dataset.ibhUi = "1";
    chip.setAttribute("role", "button");
    const label = t(kind === "resume" ? "resumeRestart" : "soundToggle");
    chip.title = label;
    chip.setAttribute("aria-label", label);
    chip.style.cssText = `position:absolute;${kind === "resume" ? "bottom:8px" : "top:4px"};left:4px;padding:6px 12px;border-radius:16px;font:15px/1.3 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.65);z-index:4;cursor:pointer`;
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    card.appendChild(chip);
    return chip;
  }
  __name(holdChip, "holdChip");
  function soundChip(card) {
    holdChip(card, "sound").textContent = CFG.previewSound ? "🔊" : "🔇";
  }
  __name(soundChip, "soundChip");
  function lingerChips(card) {
    const at = resumePoint(card);
    if (at !== null) holdChip(card, "resume").textContent = `⏮ ${mmss(at)}`;
    soundChip(card);
    clearTimeout(Number(card.dataset.ibhChipTimer));
    card.dataset.ibhChipTimer = String(setTimeout(() => {
      removeChips(card);
      if (resumes.delete(postId(card))) coverBack(card);
    }, RESUME_MS));
  }
  __name(lingerChips, "lingerChips");
  function removeChips(card) {
    clearTimeout(Number(card.dataset.ibhChipTimer));
    delete card.dataset.ibhChipTimer;
    for (const chip of card.querySelectorAll("[data-ibh-chip]")) chip.remove();
  }
  __name(removeChips, "removeChips");
  function coverBack(card) {
    const v = card.querySelector("video[data-ibh]");
    if (!v || v.readyState < 1 || !Number.isFinite(v.duration) || !(v.duration > 0)) return;
    v.currentTime = v.duration * COVER_POINT;
    dbg(`hold: post ${postId(card)}'s cover back to its own frame`);
  }
  __name(coverBack, "coverBack");
  function forgetResume(chip) {
    const card = (
      /** @type {HTMLElement | null} */
      chip.closest("[data-ibh-video]")
    );
    chip.remove();
    if (!card) return;
    resumes.delete(postId(card));
    coverBack(card);
    info(`hold: post ${postId(card)} starts from 00:00 again`);
  }
  __name(forgetResume, "forgetResume");
  function flipSound() {
    setCfg("previewSound", !CFG.previewSound);
    for (const chip of document.querySelectorAll('[data-ibh-chip="sound"]')) chip.textContent = CFG.previewSound ? "🔊" : "🔇";
    if (scrub && scrub.onPlayTime) scrub.video.muted = !CFG.previewSound;
  }
  __name(flipSound, "flipSound");
  var RUB_SPAN_S = 120;
  var RUB_REST_MS = 250;
  function makeRub(v, x0, width, hooks) {
    let active = false;
    let count = 0;
    let x = x0;
    let t2 = 0;
    let target = 0;
    let asked = -1;
    let busy = false;
    let still = 0;
    const seek = /* @__PURE__ */ __name(() => {
      busy = true;
      asked = target;
      if (typeof v.fastSeek === "function") v.fastSeek(target);
      else v.currentTime = target;
    }, "seek");
    const onSeeked = /* @__PURE__ */ __name(() => {
      busy = false;
      if (active && hooks.alive() && asked !== target) seek();
    }, "onSeeked");
    v.addEventListener("seeked", onSeeked);
    const rest = /* @__PURE__ */ __name((at) => {
      if (!active || !hooks.alive()) return;
      active = false;
      x = at;
      busy = true;
      asked = target;
      v.currentTime = target;
      hooks.rest();
    }, "rest");
    return {
      move(nx) {
        if (!Number.isFinite(v.duration) || !(v.duration > 0)) return;
        if (!active) {
          if (Math.abs(nx - x) <= SCRUB_SLOP) return;
          active = true;
          count++;
          x = nx;
          t2 = v.currentTime;
          hooks.begin();
          v.pause();
        }
        const span = Math.min(v.duration, RUB_SPAN_S);
        target = Math.min(v.duration - 0.05, Math.max(0, t2 + (nx - x) / (width() || 1) * span));
        hooks.paint(target);
        if (!busy) seek();
        clearTimeout(still);
        still = setTimeout(() => rest(nx), RUB_REST_MS);
      },
      end() {
        clearTimeout(still);
        v.removeEventListener("seeked", onSeeked);
        if (!active) return;
        active = false;
        v.currentTime = target;
        if (hooks.lift) hooks.lift();
      },
      active: /* @__PURE__ */ __name(() => active, "active"),
      count: /* @__PURE__ */ __name(() => count, "count")
    };
  }
  __name(makeRub, "makeRub");
  function rubMove(s, x) {
    const v = s.video;
    if (!s.rub) {
      s.rub = makeRub(v, s.x0, () => s.card.getBoundingClientRect().width, {
        alive: /* @__PURE__ */ __name(() => scrub === s, "alive"),
        begin: /* @__PURE__ */ __name(() => {
          s.stats.rubs = (s.stats.rubs || 0) + 1;
        }, "begin"),
        paint: /* @__PURE__ */ __name((at) => {
          s.bar.style.width = `${at / v.duration * 100}%`;
          s.label.textContent = `${mmss(at)} / ${mmss(v.duration)}`;
        }, "paint"),
        rest: /* @__PURE__ */ __name(() => {
          v.play().catch((e) => {
            if (e.name !== "NotAllowedError" || v.muted || scrub !== s) {
              dbg(`rub: play refused — ${describeError(e)}`);
              return;
            }
            v.muted = true;
            v.play().catch((e2) => dbg(`rub: play refused — ${describeError(e2)}`));
          });
        }, "rest")
      });
    }
    s.rub.move(x);
  }
  __name(rubMove, "rubMove");
  function startScrub() {
    if (!scrubSource(
      /** @type {Scrub} */
      scrub
    )) return false;
    scrubUi(
      /** @type {Scrub} */
      scrub
    );
    return true;
  }
  __name(startScrub, "startScrub");
  function scrubSource(s) {
    const { card } = s;
    const pic = cardPicture(card);
    if (!pic) return false;
    const cover = card.querySelector("video[data-ibh]");
    if (cover && cover.readyState >= 1) {
      freeForPreview(card);
      s.video = cover;
      cover.preload = "auto";
    } else {
      const hash = (thumbParts(pic.src) || {}).hash;
      const urls = cachedFirst(fileCandidates(pic.src, ["mp4", "webm"]), cacheGet("video", hash));
      if (!urls.length) return false;
      freeForPreview(card);
      borrowDecoder(card);
      const holder = document.createElement("div");
      holder.style.cssText = "position:absolute;inset:0;pointer-events:none";
      placeOverPicture(card, holder);
      s.holder = holder;
      s.video = previewLoad(holder, urls, hash);
      s.shared = true;
    }
    return true;
  }
  __name(scrubSource, "scrubSource");
  function scrubUi(s) {
    if (s.bar) return;
    const { card } = s;
    card.querySelector('[data-ibh-chip="resume"]')?.remove();
    clearTimeout(Number(card.dataset.ibhChipTimer));
    s.bar = document.createElement("div");
    s.bar.style.cssText = `position:absolute;left:0;bottom:0;height:4px;width:0;background:${ACCENT};pointer-events:none;z-index:3`;
    s.label = document.createElement("div");
    s.label.style.cssText = "position:absolute;left:4px;bottom:8px;padding:1px 6px;border-radius:3px;font:12px/1.4 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.6);pointer-events:none;z-index:3";
    s.bar.dataset.ibhUi = s.label.dataset.ibhUi = "1";
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    card.appendChild(s.bar);
    card.appendChild(s.label);
    s.on = true;
  }
  __name(scrubUi, "scrubUi");
  function moveScrub(x) {
    const r = (
      /** @type {Scrub} */
      scrub.card.getBoundingClientRect()
    );
    const f = Math.min(1, Math.max(0, (x - r.left) / r.width));
    scrub.bar.style.width = `${f * 100}%`;
    const at = seekFraction(
      /** @type {Scrub} */
      scrub.video,
      f
    );
    scrub.label.textContent = at ? `${mmss(at.t)} / ${mmss(at.d)}` : "…";
  }
  __name(moveScrub, "moveScrub");
  function dropScrub() {
    scrub = null;
    nextGif();
  }
  __name(dropScrub, "dropScrub");
  function endScrub() {
    const s = scrub;
    scrub = null;
    if (!s) return;
    clearTimeout(s.holdTimer);
    if (!s.on) {
      nextGif();
      return;
    }
    if (s.tick) endSlideshow(s);
    if (s.rub) {
      s.rub.end();
      s.rub = null;
    }
    if (s.onPlayTime) {
      keepResume(s);
      endPlayShow(s);
      lingerChips(s.card);
    } else removeChips(s.card);
    if (s.stats) logSlideStats(s);
    endReel(s);
    s.bar.remove();
    s.label.remove();
    if (s.shared) {
      previewStop();
      s.holder.remove();
      returnDecoder();
    }
    afterPreview();
    nextGif();
    dbg(`scrub: stopped at ${s.label.textContent}`);
  }
  __name(endScrub, "endScrub");
  function onScrubMove(ev) {
    if (!scrub || ev.pointerId !== scrub.id) return;
    if (CFG.scrubMode === "hold") {
      if (!scrub.on) {
        if (Math.hypot(ev.clientX - scrub.x0, ev.clientY - scrub.y0) > SCRUB_SLOP) endScrub();
        return;
      }
      if (CFG.holdRub && scrub.onPlayTime) rubMove(scrub, ev.clientX);
      return;
    }
    if (!scrub.on) {
      const dx = Math.abs(ev.clientX - scrub.x0);
      const dy = Math.abs(ev.clientY - scrub.y0);
      if (dy > SCRUB_SLOP && dy > dx) {
        dropScrub();
        return;
      }
      if (dx < SCRUB_SLOP) return;
      if (!startScrub()) {
        dropScrub();
        return;
      }
    }
    moveScrub(ev.clientX);
  }
  __name(onScrubMove, "onScrubMove");
  function onScrubUp(ev) {
    if (!scrub || ev.pointerId !== scrub.id) return;
    if (scrub.on && ev.type === "pointerup") scrubClickUntil = Date.now() + 400;
    endScrub();
  }
  __name(onScrubUp, "onScrubUp");
  function onScrubClick(ev) {
    const chip = (
      /** @type {HTMLElement | null | undefined} */
      asElement(ev.target)?.closest("[data-ibh-chip]")
    );
    if (chip) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (chip.dataset.ibhChip === "sound") flipSound();
      else forgetResume(chip);
      return;
    }
    if (Date.now() > scrubClickUntil) return;
    scrubClickUntil = 0;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }
  __name(onScrubClick, "onScrubClick");
  var SCRUB_CSS = "[data-ibh-video] { touch-action: pan-y pinch-zoom; }[data-ibh-video], [data-ibh-video] img { -webkit-user-drag: none; user-select: none; -webkit-touch-callout: none; }";
  function installVideoScrub() {
    if (!CFG.videoScrub) return;
    window.addEventListener("pointerdown", onScrubDown, true);
    window.addEventListener("pointermove", onScrubMove, true);
    window.addEventListener("pointerup", onScrubUp, true);
    window.addEventListener("pointercancel", onScrubUp, true);
    window.addEventListener("click", onScrubClick, true);
    window.addEventListener("contextmenu", (ev) => {
      if (CFG.scrubMode === "hold" && asElement(ev.target)?.closest("[data-ibh-video]")) ev.preventDefault();
    }, true);
    window.addEventListener("dragstart", (ev) => {
      if (asElement(ev.target)?.closest("[data-ibh-video]")) ev.preventDefault();
    }, true);
    info(`video scene preview active: ${CFG.scrubMode !== "hold" ? "drag sideways on a video thumbnail" : CFG.holdVideo ? "hold a video thumbnail to play it (hardware)" : "hold a video thumbnail for a slideshow"}`);
  }
  __name(installVideoScrub, "installVideoScrub");

  // src/modal/player.js
  var HOLD_FAST_MS = 600;
  var FLICK_MS = 300;
  var HOLD_RATE = 2;
  var videoPress = { held: false };
  var badgeTimer = 0;
  function showBadge(text, sticky) {
    modal.badge.textContent = text;
    modal.badge.hidden = false;
    clearTimeout(badgeTimer);
    if (!sticky) badgeTimer = setTimeout(() => {
      modal.badge.hidden = true;
    }, 700);
  }
  __name(showBadge, "showBadge");
  function playerRub(video, press, layer) {
    let playing = false;
    const box = modal.box;
    return makeRub(video, press.x, () => layer.getBoundingClientRect().width, {
      alive: /* @__PURE__ */ __name(() => !!modal && modal.open && modal.box === box, "alive"),
      begin: /* @__PURE__ */ __name(() => {
        playing = !video.paused;
        video.playbackRate = press.rate;
        dbg("modal: rub, the hold slides the video");
      }, "begin"),
      paint: /* @__PURE__ */ __name((at) => {
        showBadge(`${mmss(at)} / ${mmss(video.duration)}`, true);
        modal.controls.poke();
      }, "paint"),
      rest: /* @__PURE__ */ __name(() => {
        showBadge(mmss(video.currentTime));
        if (playing) video.play().catch((e) => dbg(`modal: rub, play refused — ${describeError(e)}`));
      }, "rest"),
      lift: /* @__PURE__ */ __name(() => {
        if (playing) video.play().catch((e) => dbg(`modal: rub, play refused — ${describeError(e)}`));
      }, "lift")
    });
  }
  __name(playerRub, "playerRub");
  function installVideoGestures(layer, video) {
    let press = null;
    let tap = null;
    const viewerX = /* @__PURE__ */ __name((ev) => {
      const r = layer.getBoundingClientRect();
      return Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    }, "viewerX");
    const release = /* @__PURE__ */ __name(() => {
      if (!press) return;
      clearTimeout(press.timer);
      if (press.rub) {
        press.rub.end();
        if (press.rub.count()) info(`modal: rubbed ${press.rub.count()}×, left at ${mmss(video.currentTime)}`);
      }
      if (videoPress.held) {
        video.playbackRate = press.rate;
        modal.badge.hidden = true;
        dbg("modal: hold released, back to normal speed");
      }
      press = null;
      setTimeout(() => {
        videoPress.held = false;
      }, 0);
    }, "release");
    layer.addEventListener("contextmenu", (ev) => ev.preventDefault());
    layer.addEventListener("pointerdown", (ev) => {
      if (press) return;
      const fx = viewerX(ev);
      press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: Date.now(), fx, rate: video.playbackRate || 1, timer: 0 };
      dbg(`modal: video press at ${Math.round(fx * 100)}%`);
      if (fx < 0.35 || fx > 0.65) return;
      press.timer = setTimeout(() => {
        if (!press) return;
        if (CFG.holdRub) press.rub = playerRub(video, press, layer);
        if (video.paused) {
          if (CFG.holdRub) videoPress.held = true;
          dbg(`modal: hold on a paused video${CFG.holdRub ? ": a slide moves it" : ", ignored"}`);
          return;
        }
        videoPress.held = true;
        video.playbackRate = HOLD_RATE;
        showBadge(`${HOLD_RATE}×`, true);
        dbg(`modal: hold, playing at ${HOLD_RATE}x`);
      }, HOLD_FAST_MS);
    });
    layer.addEventListener("pointermove", (ev) => {
      if (!press || ev.pointerId !== press.id) return;
      if (videoPress.held || press.drag) {
        press.rub?.move(ev.clientX);
        return;
      }
      const dx = ev.clientX - press.x;
      const dy = ev.clientY - press.y;
      if (Math.hypot(dx, dy) <= 10) return;
      clearTimeout(press.timer);
      if (CFG.holdRub && Math.abs(dx) > Math.abs(dy)) {
        press.drag = true;
        press.rub = playerRub(video, press, layer);
        press.rub.move(ev.clientX);
        return;
      }
      press = null;
    });
    layer.addEventListener("pointercancel", () => {
      if (press) dbg("modal: video press cancelled by the browser");
      release();
    });
    layer.addEventListener("pointerup", (ev) => {
      if (!press || ev.pointerId !== press.id) return;
      const quickTap = !videoPress.held && Date.now() - press.t < 250 && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < 10;
      const side = press.fx > 0.65 ? 1 : press.fx < 0.35 ? -1 : 0;
      if (press.drag && Date.now() - press.t >= FLICK_MS) videoPress.held = true;
      release();
      if (!quickTap) return;
      if (tap && Date.now() - tap.t < 300) {
        clearTimeout(tap.timer);
        if (!side && !tap.side) centerDoubleTap();
        else if (side && side === tap.side) {
          const d = Number.isFinite(video.duration) ? video.duration : Infinity;
          const step = Number(CFG.seekStep) || 5;
          video.currentTime = Math.min(d, Math.max(0, video.currentTime + side * step));
          showBadge(side > 0 ? `+${step}s` : `−${step}s`);
          dbg(`modal: double tap, ${side > 0 ? "+" : "-"}${step}s`);
        }
        tap = null;
        return;
      }
      tap = { t: Date.now(), side, timer: 0 };
      tap.timer = setTimeout(() => {
        tap = null;
        if (!modal.controls.shown()) {
          modal.controls.poke();
          return;
        }
        if (video.paused) {
          video.play().catch(() => {
          });
          showBadge("▶");
        } else {
          video.pause();
          showBadge("❚❚");
        }
        modal.controls.poke();
        dbg(`modal: tap, ${video.paused ? "paused" : "playing"}`);
      }, 300);
    });
  }
  __name(installVideoGestures, "installVideoGestures");
  var mmss = /* @__PURE__ */ __name((sec) => Number.isFinite(sec) ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}` : "0:00", "mmss");
  var CONTROLS_HIDE_MS = 2e3;
  var SEEK_STEPS = Array.from({ length: 40 }, (_, i) => i / 40);
  var PLAY_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  var SEEK_JUMPS = [5, 10, 15, 30];
  function applyPlayRate(video) {
    const rate = Number(CFG.playRate) || 1;
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
  }
  __name(applyPlayRate, "applyPlayRate");
  function installGearMenu(gear, menu, video, vwrap, poke) {
    const chips = [];
    const mark = /* @__PURE__ */ __name(() => chips.forEach((c) => c.button.classList.toggle("on", Number(CFG[c.key]) === c.value)), "mark");
    const row = /* @__PURE__ */ __name((label, key, attr, values, text, apply) => el("div", { class: "vmrow" }, [
      el("span", { class: "lbl", text: label }),
      ...values.map((value) => {
        const button = el("button", { type: "button", text: text(value), [`data-${attr}`]: String(value) });
        button.addEventListener("click", () => {
          setCfg(key, value);
          apply();
          mark();
          poke();
          dbg(`modal: ${key} set to ${value} from the player's ⚙`);
        });
        chips.push({ button, key, value });
        return button;
      })
    ]), "row");
    menu.append(
      row(t("gearRate"), "playRate", "rate", PLAY_RATES, (v) => `${v.toLocaleString(LANG)}×`, () => applyPlayRate(video)),
      row(t("gearStep"), "seekStep", "step", SEEK_JUMPS, (v) => `${v} s`, () => {
      })
    );
    gear.addEventListener("click", () => {
      menu.hidden = !menu.hidden;
      if (!menu.hidden) mark();
      poke();
    });
    vwrap.addEventListener("pointerdown", (ev) => {
      const path = ev.composedPath();
      if (!menu.hidden && !path.includes(menu) && !path.includes(gear)) menu.hidden = true;
    }, true);
  }
  __name(installGearMenu, "installGearMenu");
  function installVideoControls(video, ctl, playBtn, times, seek, muteBtn, prevBox, vwrap, { playPause, gearMenu }) {
    let dragging = false;
    let hideTimer = 0;
    let muted = null;
    let paused = null;
    const poke = /* @__PURE__ */ __name(() => {
      ctl.classList.remove("hide");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!dragging && !video.paused && gearMenu.hidden) ctl.classList.add("hide");
        else if (!gearMenu.hidden) poke();
      }, CONTROLS_HIDE_MS);
    }, "poke");
    const sync = /* @__PURE__ */ __name(() => {
      playBtn.hidden = !video.paused;
      if (paused !== video.paused) {
        paused = video.paused;
        setIcon(playPause, paused ? PLAYER_ICON.play : PLAYER_ICON.pause);
      }
      if (muted !== video.muted) {
        muted = video.muted;
        setIcon(muteBtn, muted ? PLAYER_ICON.muted : PLAYER_ICON.volume);
      }
      times[1].textContent = mmss(video.duration);
      if (!dragging) times[0].textContent = mmss(video.currentTime);
      if (!dragging && video.duration) seek.value = String(Math.round(video.currentTime / video.duration * 1e3));
      const b = video.buffered;
      let end = 0;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 0.5) end = Math.max(end, b.end(i));
      seek.style.setProperty("--buf", `${video.duration ? Math.min(100, end / video.duration * 100) : 0}%`);
    }, "sync");
    for (const type of ["timeupdate", "play", "pause", "volumechange", "loadedmetadata", "durationchange", "emptied", "progress"]) {
      video.addEventListener(type, sync);
    }
    playBtn.addEventListener("click", () => {
      video.play().catch(() => {
      });
    });
    playPause.addEventListener("click", () => {
      if (video.paused) video.play().catch(() => {
      });
      else video.pause();
      poke();
      dbg(`modal: ${video.paused ? "paused" : "playing"} from the player's button`);
    });
    muteBtn.addEventListener("click", () => {
      video.muted = !video.muted;
    });
    const PREV_W = 160;
    let reel = null;
    let target = 0;
    const drawKeyframe = /* @__PURE__ */ __name((f) => {
      const r = reel;
      if (!r || !r.reel || r.failed) return;
      const scenes = r.reel.scenes;
      let i = 0;
      for (let k = 1; k < scenes.length; k++) if (Math.abs(scenes[k].f - f) < Math.abs(scenes[i].f - f)) i = k;
      let img = r.frames.get(i);
      if (!img) {
        try {
          openStream(
            /** @type {H264} */
            r.x,
            r.reel
          );
          img = decodeKeyframe(
            /** @type {H264} */
            r.x,
            r.reel.frames[i],
            Math.round(PREV_W * (window.devicePixelRatio || 1))
          );
        } catch (e) {
          r.failed = true;
          dbg(`seek preview: keyframe not decoded (${describeError(e)}), the <video> preview alone`);
          return;
        }
        r.frames.set(i, img);
      }
      if (!r.canvas) r.canvas = document.createElement("canvas");
      if (!r.canvas.isConnected) prevBox.insertBefore(r.canvas, prevBox.lastChild);
      if (r.canvas.width !== img.width || r.canvas.height !== img.height) {
        r.canvas.width = img.width;
        r.canvas.height = img.height;
      }
      r.canvas.getContext("2d").putImageData(img, 0, 0);
    }, "drawKeyframe");
    const reelPreview = /* @__PURE__ */ __name((f) => {
      if (!CFG.seekReel || !CFG.wasmDecode || h264Broken || typeof GM_xmlhttpRequest !== "function") return;
      const src = video.currentSrc;
      if (!/\.mp4(?:[?#]|$)/i.test(src)) return;
      if (!reel || reel.src !== src) {
        const mine = { src, reel: null, x: null, frames: /* @__PURE__ */ new Map(), canvas: null, f, failed: false };
        reel = mine;
        Promise.all([h264Decoder(), reelFor([src], SEEK_STEPS, /* @__PURE__ */ new Set(), null)]).then(([x, built]) => {
          if (reel !== mine) return;
          if (!built.avcC) throw new Error("not H.264");
          mine.x = x;
          mine.reel = /** @type {H264Reel} */
          built;
          info(`seek preview: wasm reel of ${built.scenes.length} scenes in ${built.ms} ms${built.kept ? " (kept from before)" : ""}`);
          if (dragging) drawKeyframe(mine.f);
        }).catch((e) => {
          if (reel !== mine) return;
          mine.failed = true;
          dbg(`seek preview: no reel (${describeError(e)}), the <video> preview alone`);
        });
      }
      reel.f = f;
      drawKeyframe(f);
    }, "reelPreview");
    seek.addEventListener("input", () => {
      dragging = true;
      const f = Number(seek.value) / 1e3;
      if (prevBox.hidden && video.currentSrc) {
        prevBox.hidden = false;
        const v = previewLoad(prevBox, [video.currentSrc], null);
        if (!v.dataset.ibhSeekExact) {
          v.dataset.ibhSeekExact = "1";
          v.addEventListener("seeked", () => {
            if (prevBox.contains(v) && Math.abs(v.currentTime - target) < 0.6) prevBox.classList.add("exact");
          });
        }
      }
      const sr = seek.getBoundingClientRect();
      const wr = vwrap.getBoundingClientRect();
      const x = sr.left - wr.left + f * sr.width - PREV_W / 2;
      prevBox.style.left = `${Math.min(wr.width - PREV_W - 4, Math.max(4, x))}px`;
      const d = video.duration;
      target = f * d;
      prevBox.classList.remove("exact");
      reelPreview(f);
      if (previewEl && previewEl.isConnected) seekFraction(previewEl, f);
      prevBox.lastChild.textContent = mmss(target);
      times[0].textContent = mmss(target);
      poke();
    });
    seek.addEventListener("change", () => {
      dragging = false;
      const d = video.duration;
      if (d) video.currentTime = Number(seek.value) / 1e3 * d;
      previewStop();
      prevBox.hidden = true;
      prevBox.classList.remove("exact");
      poke();
    });
    ctl.addEventListener("pointerdown", poke);
    video.addEventListener("play", poke);
    video.addEventListener("pause", () => {
      clearTimeout(hideTimer);
      ctl.classList.remove("hide");
    });
    video.addEventListener("emptied", () => {
      clearTimeout(hideTimer);
      ctl.classList.remove("hide");
    });
    const dropReel = /* @__PURE__ */ __name(() => {
      if (reel && reel.canvas) reel.canvas.remove();
      reel = null;
    }, "dropReel");
    return { shown: /* @__PURE__ */ __name(() => !ctl.classList.contains("hide"), "shown"), poke, dropReel };
  }
  __name(installVideoControls, "installVideoControls");
  function setCleanUi(clean) {
    modal.box.classList.toggle("clean", clean);
  }
  __name(setCleanUi, "setCleanUi");
  function resetMedia() {
    modal.seq++;
    modal.fileUrl = null;
    if (modal.cancelLoad) {
      modal.cancelLoad();
      modal.cancelLoad = null;
    }
    modal.isSample = false;
    modal.origPending = false;
    modal.sampleUrl = null;
    modal.rawUrl = null;
    modal.keepSample = false;
    setQuality(null);
    const v = modal.video;
    v.pause();
    v.onerror = v.oncanplay = v.onloadedmetadata = null;
    applyPlayRate(v);
    modal.gearMenu.hidden = true;
    modal.badge.hidden = true;
    modal.playerBtn.hidden = true;
    modal.appDlBtn.hidden = true;
    modal.appReduceBtn.hidden = true;
    modal.controls.dropReel();
    if (!modal.root.fullscreenElement) setCleanUi(false);
    v.removeAttribute("src");
    v.load();
    modal.image.onerror = null;
    modal.image.removeAttribute("src");
    modal.stage.scrollTop = 0;
    resetZoom();
  }
  __name(resetMedia, "resetMedia");
  function toggleModalFullscreen() {
    if (modal.root.fullscreenElement) {
      document.exitFullscreen().catch(() => {
      });
      return;
    }
    if (!modal.box.requestFullscreen) return;
    modal.box.requestFullscreen().catch((e) => dbg(`modal: fullscreen refused — ${describeError(e)}`));
  }
  __name(toggleModalFullscreen, "toggleModalFullscreen");
  function turnScreen() {
    const orientation = screen.orientation;
    if (!orientation || !orientation.lock) {
      flash(t("mTurnNo"));
      return;
    }
    const portrait = String(orientation.type).startsWith("portrait");
    modal.turned = portrait ? "landscape" : "portrait";
    modal.turn.classList.add("on");
    info(`modal: screen turned to ${modal.turned}`);
    if (modal.root.fullscreenElement) fitFullscreenOrientation();
    else toggleModalFullscreen();
  }
  __name(turnScreen, "turnScreen");
  var FS_ICON = {
    enter: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
    exit: "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"
  };
  var PLAYER_ICON = {
    play: "M8 5v14l11-7z",
    pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
    heart: "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z",
    heartLine: "M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z",
    info: "M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z",
    gear: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z",
    volume: "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z",
    muted: "M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"
  };
  function setIcon(btn, d) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
    btn.replaceChildren(svg);
  }
  __name(setIcon, "setIcon");
  function setFsIcon(btn, full) {
    setIcon(btn, full ? FS_ICON.exit : FS_ICON.enter);
    btn.title = t(full ? "mFullExit" : "mFull");
  }
  __name(setFsIcon, "setFsIcon");
  function fitFullscreenOrientation() {
    const orientation = screen.orientation;
    if (!orientation) return;
    const v = modal.video;
    const full = !!modal.root.fullscreenElement;
    if (full && modal.turned && orientation.lock) {
      orientation.lock(modal.turned).catch((e) => dbg(`modal: orientation lock refused — ${describeError(e)}`));
    } else if (full && CFG.rotateLandscape && !v.hidden && v.videoWidth > v.videoHeight && orientation.lock) {
      orientation.lock("landscape").then(
        () => dbg("modal: fullscreen locked to landscape"),
        (e) => dbg(`modal: orientation lock refused — ${describeError(e)}`)
      );
    } else {
      try {
        if (orientation.unlock) orientation.unlock();
      } catch (e) {
      }
    }
  }
  __name(fitFullscreenOrientation, "fitFullscreenOrientation");
  function onFullscreenChange() {
    if (!modal || !modal.open) return;
    const v = modal.video;
    const inside = modal.root.fullscreenElement;
    if (inside === v && modal.box.requestFullscreen) {
      modal.box.requestFullscreen().then(
        () => dbg("modal: fullscreen moved to the modal"),
        (e) => dbg(`modal: could not move fullscreen — ${describeError(e)}`)
      );
      return;
    }
    dbg(`modal: fullscreen ${inside ? "on" : "off"}`);
    if (!inside) {
      modal.turned = null;
      modal.turn.classList.remove("on");
    }
    setFsIcon(modal.fsBtn, !!inside);
    setCleanUi(!!inside);
    fitFullscreenOrientation();
  }
  __name(onFullscreenChange, "onFullscreenChange");
  function onOrientationChange() {
    if (!modal || !modal.open || !modal.root.fullscreenElement) return;
    if (modal.turned) {
      if (!String(screen.orientation.type).startsWith(modal.turned)) fitFullscreenOrientation();
      return;
    }
    const v = modal.video;
    if (CFG.rotateLandscape && !v.hidden && v.videoWidth > v.videoHeight && String(screen.orientation.type).startsWith("portrait")) {
      dbg("modal: fullscreen video went back to portrait, locking landscape again");
      fitFullscreenOrientation();
    }
  }
  __name(onOrientationChange, "onOrientationChange");

  // src/thumbs/badges.js
  function markPastDecoder(card, what) {
    if (card.dataset.ibhBigVideo === what) return;
    card.dataset.ibhBigVideo = what;
    dbg(`card: post ${postId(card)} marked past the hardware decoder (${what})`);
    const badge = cardBadge(card, "ibh-heavy", "top:3px;right:3px;font-size:11px;line-height:1;filter:drop-shadow(0 0 1px #000)");
    if (!badge) return;
    badge.textContent = "⚠️";
    badge.title = `${t("heavyMark")}: ${what}`;
  }
  __name(markPastDecoder, "markPastDecoder");
  function markDuration(card, secs) {
    if (!Number.isFinite(secs) || secs <= 0) return;
    const badge = cardBadge(card, "ibh-dur", "bottom:3px;right:3px;padding:0 3px;border-radius:3px;font:10px/1.4 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.65)");
    if (badge) badge.textContent = mmss(secs);
  }
  __name(markDuration, "markDuration");
  function cardBadge(card, cls, css) {
    if (!CFG.thumbBadges) return null;
    const had = (
      /** @type {HTMLElement | null} */
      card.querySelector(`.${cls}`)
    );
    if (had) return had;
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    const badge = el("span", { class: cls, "data-ibh-ui": "" });
    badge.style.cssText = `position:absolute;z-index:4;pointer-events:none;${css}`;
    card.appendChild(badge);
    return badge;
  }
  __name(cardBadge, "cardBadge");

  // src/page/raw-hold.js
  var RAW_HOLD_MS = 500;
  var rawHold = null;
  var rawClickUntil = 0;
  function rawTarget(target) {
    const img = (
      /** @type {HTMLImageElement | null | undefined} */
      asElement(target)?.closest(`${SITE_LINK} img`)
    );
    const link = (
      /** @type {HTMLAnchorElement | null | undefined} */
      img && img.closest(SITE_LINK)
    );
    if (!link || link.dataset.ibhVideo || isVideoCard(link) || isGifCard(link)) return null;
    return (
      /** @type {{ img: HTMLImageElement, link: HTMLAnchorElement }} */
      { img, link }
    );
  }
  __name(rawTarget, "rawTarget");
  function gifTarget(target) {
    const img = (
      /** @type {HTMLImageElement | null | undefined} */
      asElement(target)?.closest(`${SITE_LINK} img`)
    );
    const link = (
      /** @type {HTMLAnchorElement | null | undefined} */
      img && img.closest(SITE_LINK)
    );
    if (!link || !isGifCard(link)) return null;
    return (
      /** @type {{ img: HTMLImageElement, link: HTMLAnchorElement }} */
      { img, link }
    );
  }
  __name(gifTarget, "gifTarget");
  function holdTarget(target) {
    const raw = CFG.holdRaw && rawTarget(target);
    if (raw) return { ...raw, gif: false };
    const gif = CFG.holdGif && gifTarget(target);
    return gif ? { ...gif, gif: true } : null;
  }
  __name(holdTarget, "holdTarget");
  function onRawTouchStart(ev) {
    rawHold = null;
    if (!(CFG.holdRaw || CFG.holdGif) || bulkMode || ev.touches.length !== 1 || modal && modal.open) return;
    const hit = holdTarget(ev.target);
    if (!hit) return;
    const finger = ev.touches[0];
    rawHold = { ...hit, x: finger.clientX, y: finger.clientY, scrollY: window.scrollY, fired: false, timer: 0 };
    rawHold.timer = setTimeout(() => {
      const h = rawHold;
      if (!h || Math.abs(window.scrollY - h.scrollY) > 12) return;
      h.fired = true;
      rawClickUntil = Date.now() + 800;
      if (h.gif) rebuildGif(h.link);
      else loadRaw(h.img, h.link);
    }, RAW_HOLD_MS);
  }
  __name(onRawTouchStart, "onRawTouchStart");
  function cancelRawHold() {
    if (rawHold && !rawHold.fired) clearTimeout(rawHold.timer);
    rawHold = null;
  }
  __name(cancelRawHold, "cancelRawHold");
  function onRawTouchMove(ev) {
    if (!rawHold || rawHold.fired) return;
    const finger = ev.touches[0];
    if (ev.touches.length > 1 || Math.hypot(finger.clientX - rawHold.x, finger.clientY - rawHold.y) > 12) cancelRawHold();
  }
  __name(onRawTouchMove, "onRawTouchMove");
  function onRawClick(ev) {
    if (Date.now() > rawClickUntil) return;
    rawClickUntil = 0;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }
  __name(onRawClick, "onRawClick");
  function onRawContextMenu(ev) {
    if (holdTarget(ev.target)) ev.preventDefault();
  }
  __name(onRawContextMenu, "onRawContextMenu");
  var rawLoads = /* @__PURE__ */ new WeakMap();
  function undoRaw(img, link) {
    const cancel = rawLoads.get(img);
    if (cancel) {
      cancel();
      rawLoads.delete(img);
    }
    const before = img.dataset.ibhPreRaw || "";
    if (img.dataset.ibhRaw === "1") {
      if (before) img.srcset = before;
      else img.removeAttribute("srcset");
      if (img.dataset.ibhRawMarked) {
        delete img.dataset.ibhOrig;
        delete img.dataset.ibhThumb;
        if (originalViewport) originalViewport.observe(img);
      }
    }
    delete img.dataset.ibhRaw;
    delete img.dataset.ibhPreRaw;
    delete img.dataset.ibhRawMarked;
    const badge = link.querySelector(".ibh-rawbadge");
    if (badge) badge.remove();
    if (navigator.vibrate) navigator.vibrate(15);
    info(`raw: post ${postId(link)} back to the ${before ? "sample" : "thumbnail"}`);
  }
  __name(undoRaw, "undoRaw");
  function loadRaw(img, link) {
    if (img.dataset.ibhRaw) {
      undoRaw(img, link);
      return;
    }
    const src = img.getAttribute("src");
    const parts = thumbParts(src);
    if (!parts) return;
    const cached = knownOriginal(parts.hash);
    if (cached === null) {
      bulkBadge(link, "✕", "#b42318", "ibh-rawbadge");
      pageToast(t("rawFailed"));
      return;
    }
    if (/\/images\//.test(img.getAttribute("srcset") || "")) {
      pageToast(t("rawAlready"));
      if (navigator.vibrate) navigator.vibrate(15);
      dbg(`raw: post ${postId(link)} already shows its original`);
      return;
    }
    img.dataset.ibhRaw = "loading";
    img.dataset.ibhPreRaw = img.getAttribute("srcset") || "";
    bulkBadge(link, "RAW…", "rgba(15, 20, 23, .85)", "ibh-rawbadge");
    if (navigator.vibrate) navigator.vibrate(15);
    rawLoads.set(img, raceImage([fileCandidates(
      /** @type {string} */
      src,
      ORIGINAL_EXTS
    )], cached, (probe) => {
      cacheSet("orig", parts.hash, probe.src, cached);
      const decoded = typeof probe.decode === "function" ? probe.decode().catch(() => {
      }) : Promise.resolve();
      decoded.then(() => {
        if (!img.isConnected || img.dataset.ibhRaw !== "loading") return;
        const pic = pictureOf(img);
        if (!pic) return;
        rawLoads.delete(img);
        if (img.dataset.ibhOrig !== "done") {
          img.dataset.ibhThumb = /** @type {string} */
          src;
          img.dataset.ibhOrig = "done";
          img.dataset.ibhRawMarked = "1";
          watchDistance(img);
        }
        pic.set(probe.src);
        img.dataset.ibhRaw = "1";
        bulkBadge(link, "RAW", ACCENT_MID, "ibh-rawbadge");
        info(`raw: post ${postId(link)} shows its original (${probe.src.split("/").pop()})`);
      });
    }, () => {
      rawLoads.delete(img);
      delete img.dataset.ibhRaw;
      delete img.dataset.ibhPreRaw;
      cacheSet("orig", parts.hash, null);
      bulkBadge(link, "✕", "#b42318", "ibh-rawbadge");
      pageToast(t("rawFailed"));
    }, "high"));
  }
  __name(loadRaw, "loadRaw");

  // src/page/double-tap.js
  var DOUBLE_TAP_MS = 300;
  var pendingTap = null;
  var passTap = null;
  var wantsDoubleTap = /* @__PURE__ */ __name(() => !!CFG.doubleTapFav && SITE === "rule34.xxx" && !!userId(), "wantsDoubleTap");
  function onDoubleTapClick(ev) {
    if (ev.defaultPrevented || ev.button !== 0 || bulkMode) return;
    const link = (
      /** @type {HTMLAnchorElement | null | undefined} */
      asElement(ev.target)?.closest(SITE_LINK)
    );
    if (!link || link === passTap || !wantsDoubleTap()) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (pendingTap && pendingTap.link === link) {
      clearTimeout(pendingTap.timer);
      pendingTap = null;
      if (CFG.doubleTapLike === "heart") popHeart(link, Math.min(110, link.getBoundingClientRect().width * 0.5));
      bulkFavorite(link, "double tap");
      return;
    }
    if (pendingTap) clearTimeout(pendingTap.timer);
    pendingTap = { link, timer: setTimeout(() => {
      pendingTap = null;
      openTapped(link);
    }, DOUBLE_TAP_MS) };
  }
  __name(onDoubleTapClick, "onDoubleTapClick");
  function openTapped(link) {
    if (!link.isConnected) return;
    passTap = link;
    try {
      link.click();
    } finally {
      passTap = null;
    }
  }
  __name(openTapped, "openTapped");

  // src/page/ads.js
  var SITE_DOMAIN = SITE.split(".").slice(-2).join(".");
  var OWN_HOSTS = `'self' https://${SITE_DOMAIN} https://*.${SITE_DOMAIN} https://challenges.cloudflare.com`;
  var AD_POLICY = `script-src ${OWN_HOSTS} ${PROFILE.scriptHosts.join(" ")} 'unsafe-inline' 'unsafe-eval' blob: moz-extension:; frame-src ${OWN_HOSTS} blob:`;
  var AD_SLOTS = [".a_list", "#nativemlist", "#nativempost", "ins[data-zoneid]", 'li:has(> a[href*="realxxx."])', 'a[href*="realxxx."]', ...PROFILE.adSlots].join(", ");
  var ADS_CSS = `${AD_SLOTS} { display: none !important; }`;
  var adBlocked = /* @__PURE__ */ new Map();
  var adPolicyOn = false;
  function applyAdBlock() {
    if (!CFG.blockAds || adPolicyOn || !document.head) return;
    adPolicyOn = true;
    const meta = document.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = AD_POLICY;
    document.head.prepend(meta);
    dbg("ads: policy in place, only the site's own scripts and frames load");
  }
  __name(applyAdBlock, "applyAdBlock");
  function installAdBlock() {
    if (!CFG.blockAds) return;
    document.addEventListener("securitypolicyviolation", (e) => {
      if (!e.originalPolicy.includes("moz-extension:")) return;
      let host = e.blockedURI;
      try {
        host = new URL(e.blockedURI).host;
      } catch (err) {
      }
      adBlocked.set(host, (adBlocked.get(host) || 0) + 1);
      if (document.readyState === "complete") dbg(`ads: blocked ${e.blockedURI}`);
    });
    window.addEventListener("load", () => {
      const total = [...adBlocked.values()].reduce((a, b) => a + b, 0);
      const hosts = [...adBlocked].map(([h, n]) => n > 1 ? `${h} ×${n}` : h).join(", ");
      info(`ads: blocked ${total} loads${hosts ? ` (${hosts})` : ""}, ${document.querySelectorAll(AD_SLOTS).length} slots hidden`);
    }, { once: true });
    applyAdBlock();
  }
  __name(installAdBlock, "installAdBlock");

  // src/page/page-css.js
  var NATIVE_MARK_CSS = `${LIST} img.webm-thumb { border: 3px solid rgb(0, 0, 255); box-sizing: border-box; }`;
  var FAVSEARCH_CSS = `
    .ibh-search { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0 12px; position: relative; }
    .ibh-suggest { position: absolute; z-index: 30; margin: 0 !important; padding: 4px 0 !important; list-style: none;
      max-height: 50vh; overflow-y: auto; overscroll-behavior: contain; user-select: none; -webkit-touch-callout: none;
      background: #1f2b30 !important; border: 1px solid ${LINE} !important;
      border-radius: 8px; box-shadow: 0 8px 18px rgba(0, 0, 0, .5); }
    .ibh-suggest[hidden] { display: none; }
    .ibh-suggest li { display: flex !important; justify-content: space-between; gap: 12px; padding: 9px 12px !important;
      font-size: 15px; color: #e6eef0 !important; background: transparent !important; }
    .ibh-suggest li small { opacity: .65; font-size: 12px; color: inherit !important; }
    .ibh-suggest li span { color: inherit !important; }
    .ibh-suggest li.k-artist { color: #f2ac08 !important; }
    .ibh-suggest li.k-character { color: #3fb950 !important; }
    .ibh-suggest li.k-copyright { color: #c678dd !important; }
    .ibh-search input[type="search"] { flex: 1 1 100%; min-width: 0; padding: 9px 10px; font-size: 15px; box-sizing: border-box; }
    .ibh-search input.min { width: 96px; padding: 7px 8px; font-size: 14px; box-sizing: border-box; }
    .ibh-search select, .ibh-search button { padding: 7px 12px; font-size: 14px; }
    .ibh-search .st { flex: 1 1 100%; font-size: 12px; opacity: .85; }
    .ibh-search select.saved { flex: 1 1 100%; }
    .ibh-search select.saved[hidden] { display: none; }
    #ibh-favmore { display: block; margin: 14px auto; padding: 9px 18px; font-size: 14px; }
    #ibh-favmore[hidden] { display: none; }
    #ibh-pager { min-height: 1px; padding: 14px 0; text-align: center; font-size: 13px; opacity: .85; }
    .ibh-bulkbadge, .ibh-rawbadge { position: absolute; top: 6px; right: 6px; z-index: 3; min-width: 26px; height: 26px; padding: 0 6px;
      border-radius: 13px; color: #fff; font: 600 15px/26px system-ui, sans-serif; text-align: center; pointer-events: none;
      box-shadow: 0 2px 8px rgba(0,0,0,.5); }
    .ibh-rawbadge { right: auto; left: 6px; font-size: 12px; }
    ${LIST} a img { -webkit-touch-callout: none; }
  `;
  var TAP_CSS = `${THUMB} a:not([data-ibh-video]) { touch-action: manipulation; }`;
  var HEADER_CSS = "#header #site-title { text-align: center; padding-left: 0; }";
  var CARD_MARKS_CSS = `
    .ibh-liked { position: absolute; top: 1px; right: 1px; z-index: 5; padding: 3px; font-size: 16px; line-height: 1;
      filter: drop-shadow(0 0 2px rgba(0, 0, 0, .8)); cursor: pointer; user-select: none; -webkit-user-select: none;
      -webkit-touch-callout: none; }
    .ibh-res { position: absolute; top: 3px; left: 3px; z-index: 4; pointer-events: none; padding: 0 3px; border-radius: 3px;
      font: 10px/1.4 ui-monospace, monospace; color: #fff; background: rgba(0, 0, 0, .65); }
    [data-ibh-liked] .ibh-heavy { right: 26px !important; }
    [data-ibh-liked] .ibh-bulkbadge, [data-ibh-liked] .ibh-rawbadge { right: 30px !important; }`;
  function injectPageCSS() {
    if (document.querySelector("style[data-ibh]")) return;
    const style = el("style", { "data-ibh": "1" });
    style.textContent = NATIVE_MARK_CSS + THEME_CSS + FAVSEARCH_CSS + TAP_CSS + HEADER_CSS + LIKE_CSS + CARD_MARKS_CSS + (CFG.videoScrub ? SCRUB_CSS : "") + (CFG.blockAds ? ADS_CSS : "");
    (document.head || document.documentElement).appendChild(style);
  }
  __name(injectPageCSS, "injectPageCSS");

  // src/main.js
  window.addEventListener("pagehide", flushUrlCache);
  if (CFG.urlCache) urlDb();
  if (tabChannel) {
    tabChannel.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.type === "free-memory") {
        freeMemory("tab").then((n) => (
          /** @type {BroadcastChannel} */
          tabChannel.postMessage({ type: "freed", n, page: location.pathname })
        ));
      } else if (msg.type === "freed") {
        const { n } = msg;
        info(`another tab (${msg.page}) freed ${n.covers} covers, ${n.gifs} GIFs, ${n.images} upgraded images`);
      }
    };
  }
  window.addEventListener("pointerdown", (ev) => {
    if (!panelOpen || !panelHost) return;
    if (ev.composedPath().includes(panelHost)) return;
    togglePanel(false);
  }, true);
  installAdBlock();
  new MutationObserver((records) => {
    applyAdBlock();
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        scanCards(node);
        scanThumbs(node);
      }
      if (CFG.memorySaver && r.removedNodes.length) onNodesRemoved(r.removedNodes);
    }
    if (panelHost && !panelHost.isConnected) {
      setPanelHost(null);
      setShadow(null);
    }
    if (!panelHost) mountPanel();
    ensureFeedNav();
    injectPageCSS();
    applySiteTheme();
    applyFeed();
    ensureFavSearch();
    ensureFavPager();
    ensureSiteSearch();
  }).observe(document, { childList: true, subtree: true });
  installMemorySaver();
  window.addEventListener("click", onHeartClick, true);
  window.addEventListener("touchstart", onHeartTouchStart, { capture: true, passive: true });
  window.addEventListener("touchmove", onHeartTouchMove, { capture: true, passive: true });
  window.addEventListener("touchend", onHeartTouchEnd, true);
  window.addEventListener("touchcancel", onHeartTouchEnd, true);
  window.addEventListener("contextmenu", (ev) => {
    if (asElement(ev.target)?.closest(".ibh-liked")) ev.preventDefault();
  }, true);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => {
    loadLikedIds();
  }, { once: true });
  else loadLikedIds();
  window.addEventListener("click", onBulkClick, true);
  window.addEventListener("click", onRawClick, true);
  window.addEventListener("touchstart", onRawTouchStart, { capture: true, passive: true });
  window.addEventListener("touchmove", onRawTouchMove, { capture: true, passive: true });
  window.addEventListener("touchend", () => {
    if (rawHold && !rawHold.fired) cancelRawHold();
  }, true);
  window.addEventListener("touchcancel", cancelRawHold, true);
  window.addEventListener("contextmenu", onRawContextMenu, true);
  installVideoScrub();
  window.addEventListener("click", onDoubleTapClick, true);
  installVideoModal();
  logSnapshot();
  if (CFG.originalThumbs) info("original thumbnails on: visible thumbnails load the full file");
  if (CFG.nativeFeed) info(`feed on: ${CFG.feedColumns} columns, ${CFG.feedLayout}; site pages show samples`);
  storeReady();
  restoreCfg();
  var boot = /* @__PURE__ */ __name(() => {
    injectPageCSS();
    mountPanel();
    ensureFeedNav();
    scanCards(document);
    scanThumbs(document);
    imageBase();
  }, "boot");
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
  var CONSOLE_HELP = [
    `Image Board Helper v${VERSION} · window.__ibh`,
    "  help()                 this list",
    "  tail(n, filter)        the last n log lines (20), only those matching filter (a regular expression)",
    "  log()                  the whole log (250 entries) as objects",
    "  version, cfg, state    the version, the settings, the live state",
    "  set(key, value)        changes a setting, as the panel does",
    "  probe()                tests the candidate URLs of the first video on screen (Test URLs)",
    "  free()                 frees memory and caches (Free memory & cache)",
    "  redo()                 starts every thumbnail over (Redo thumbnails)",
    "  clearHostCache()       resolves the image host again (Clear host)",
    "  urlCache(), clearUrlCache()   the cache of which address worked",
    "  await urlIndex()       its IndexedDB side: entries, misses, the cap",
    "  stored(), moveAgain()  the stored lists; merges the old storage bridge in again",
    "  gifs()                 inline GIFs: download slots, turn queue, card states, what holds them"
  ].join("\n");
  (typeof unsafeWindow !== "undefined" ? unsafeWindow : window).__ibh = {
    help: /* @__PURE__ */ __name(() => CONSOLE_HELP, "help"),
    // The last n log lines as text; with a filter, only the lines whose
    // message matches it (a regular expression, case-insensitive).
    tail: /* @__PURE__ */ __name((n = 20, filter = "") => {
      const re = filter ? new RegExp(filter, "i") : null;
      return LOG.filter((e) => !re || re.test(e.msg)).slice(-Math.max(1, n)).map(logLine).join("\n") || "(no matching lines)";
    }, "tail"),
    version: VERSION,
    cfg: CFG,
    state: STATE,
    log: /* @__PURE__ */ __name(() => LOG, "log"),
    probe: probeVideoUrls,
    clearHostCache,
    free: freeMemory,
    urlCache: /* @__PURE__ */ __name(() => ({ ...urlStats, entries: Object.keys(loadUrlCache()).length }), "urlCache"),
    urlIndex: urlIndexStats,
    clearUrlCache,
    redo: redoThumbs,
    // Where the inline GIFs stand, for one stuck on its still: the three
    // download slots and who waits for one, the turn queue, each card's state,
    // and what makes nextGif() wait.
    gifs: /* @__PURE__ */ __name(() => {
      const cards = {};
      markedCards("[data-ibh-gif]").forEach((c) => {
        const k = `${c.dataset.ibhGif}${c.dataset.ibhSeen ? " on screen" : ""}`;
        cards[k] = (cards[k] || 0) + 1;
      });
      return {
        slots: `${imagesInflight}/${IMAGE_MAX_INFLIGHT}`,
        slotWaiters: imageWaiters.length,
        live: `${gifsLive()}/${Number(CFG.gifMaxLive) || 3}`,
        queued: gifQueue.size,
        cards,
        previewPaused: previewPaused.length,
        parked: parked.length,
        holding: [document.hidden && "hidden tab", modal && modal.open && "modal", scrub && "finger on a video", gifRebuild && "a held GIF rebuilding"].filter(Boolean)
      };
    }, "gifs"),
    set: setCfg,
    // Size of each stored key (JSON characters) and the move-in state.
    stored: /* @__PURE__ */ __name(() => GM_STORE ? Object.fromEntries([...STORE_KEYS.map((k) => [k, JSON.stringify(GM_getValue(k, null)).length]), ["movedIn", GM_getValue("movedIn", 0)]]) : null, "stored"),
    // Merges the storage bridge's lists in once more (a tab on an old
    // version wrote to it after the move): the bridge only, never site data.
    moveAgain: /* @__PURE__ */ __name(() => {
      if (!GM_STORE) return;
      GM_setValue("movedIn", 1);
      setMovedIn(null);
      storeReady();
    }, "moveAgain")
  };
})();
