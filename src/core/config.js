/** @import { Lang } from './i18n' */

// ═══════════════════════════════════════════════════════════
// Persisted configuration
// ═══════════════════════════════════════════════════════════

export const CFG_KEY = 'IBH_CFG'

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
  resBadge:       true,   // the post's resolution in the thumbnail's top left (rule34's API with your key; videos and opened posts without it)
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
  siteTheme:      true,   // the modal's dark theme on the site's pages
  blockAds:       true,   // only the site's own scripts and frames load: no ad networks, no popunders (needs reload)
  originalThumbs: false,  // the original where a thumbnail's box is wider than the sample (a desktop screen; needs reload)
  nativeFeed:     false,  // feed with sharp images on the site's own pages (applies at once)
  feedColumns:    1,      // its columns: 'auto' (by screen width) or 1-4
  feedLayout:     'masonry', // 'masonry': whole images in columns; 'grid': even square tiles
}

// The settings as stored: DEFAULTS' own shape, with the two keys whose
// default does not show every value they take.
/** @typedef {Omit<typeof DEFAULTS, 'lang' | 'feedColumns'> & { lang: Lang | null, feedColumns: number | 'auto' }} Config */

// Options that only take effect when the page loads.
/** @type {Set<string>} */
export const NEEDS_RELOAD = new Set(['originalThumbs', 'memorySaver', 'feedNav', 'videoModal', 'videoScrub', 'blockAds', 'thumbBadges'])

// Whether this page found the settings at all: a script that clears the
// site's localStorage (one did, on its reset) takes them along, and the
// copy in Violentmonkey's storage brings them back (restoreCfg).
export const CFG_FOUND = (() => { try { return localStorage.getItem(CFG_KEY) !== null } catch (e) { return true } })()
/** @type {Config} */
export const CFG = Object.assign({}, DEFAULTS, readJSON(CFG_KEY, {}))

/**
 * Whatever was stored under the key, unchecked (any): the caller knows its shape.
 * @param {string} key
 * @param {unknown} fallback
 * @returns {any}
 */
export function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch (e) {
    return fallback
  }
}

/**
 * @param {string} key
 * @param {unknown} value
 */
export function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (e) {
    return false
  }
}
