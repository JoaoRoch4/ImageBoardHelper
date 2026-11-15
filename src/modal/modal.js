/** @import { VideoControls } from './player' */
import { ACCENT, ACCENT_DARK, ACCENT_MID, SITE, THUMB } from '../core/site'
import { CFG, readJSON, writeJSON } from '../core/config'
import { t } from '../core/i18n'
import { copyRawLink, modalDownload, rawFileUrl } from '../post/download'
import { sendToApp } from '../post/app'
import { toggleLaterHere } from '../lists/later'
import { chipGestures, closeMenu, showTab, toggleInfo, toggleMenu } from './tags'
import { modalFavorite, modalUpvote } from '../post/votes'
import { installImageHold, installImageZoom, installModalSwipe, zoom } from './gestures'
import { PLAYER_ICON, installGearMenu, installVideoControls, installVideoGestures, setFsIcon, setIcon, toggleModalFullscreen, turnScreen } from './player'
import { onImageContent, toggleQuality } from './media'
import { closeModal, stepModal } from './open'
import { el, panelHost } from '../panel/panel'

// ═══════════════════════════════════════════════════════════
// E. Post modal on site pages
//
// Tapping a thumbnail on the site's own pages opens the post in an overlay
// instead of leaving the page: videos play with sound, GIFs animate, images
// show the original. Swipe sideways for the next/previous post, down to
// close. Own Shadow DOM host, so it works with the panel off.
// ═══════════════════════════════════════════════════════════

export const SITE_LINK = `${THUMB} a`
export const SWIPE_MIN = 60        // px sideways to change post
export const CONTROLS_BAND = 100   // bottom strip of the video: the player's own controls (the two-row capsule and its margin)

/**
 * The post viewer: its elements (buildModal) and the post on show.
 * @typedef {object} Modal
 * @property {HTMLDivElement} host
 * @property {ShadowRoot} root
 * @property {HTMLDivElement} box
 * @property {HTMLDivElement} stage
 * @property {HTMLDivElement} vwrap
 * @property {HTMLVideoElement} video
 * @property {HTMLImageElement} image
 * @property {VideoControls} controls
 * @property {HTMLAnchorElement} post
 * @property {HTMLSpanElement} count
 * @property {HTMLDivElement} status
 * @property {HTMLButtonElement} fav
 * @property {HTMLButtonElement} up
 * @property {HTMLButtonElement} vfav
 * @property {HTMLDivElement} gearMenu
 * @property {HTMLSpanElement} dlq
 * @property {HTMLSpanElement} score
 * @property {HTMLDivElement} toast
 * @property {HTMLDivElement} badge
 * @property {HTMLButtonElement} turn
 * @property {HTMLButtonElement} fsBtn
 * @property {HTMLButtonElement} menu
 * @property {HTMLDivElement} sheet
 * @property {HTMLDivElement} tagList
 * @property {HTMLButtonElement} laterBtn
 * @property {HTMLButtonElement} dlBtn
 * @property {HTMLButtonElement} playerBtn
 * @property {HTMLButtonElement} appDlBtn
 * @property {HTMLButtonElement} appReduceBtn
 * @property {HTMLButtonElement} quality
 * @property {HTMLButtonElement} tabTags
 * @property {HTMLButtonElement} tabInfo
 * @property {HTMLButtonElement} tabComments
 * @property {HTMLDivElement} infoList
 * @property {HTMLDivElement} commentList
 * @property {string} sheetTab          'tags', 'info' or 'comments'
 * @property {HTMLDivElement} laterView
 * @property {HTMLDivElement} laterHead
 * @property {HTMLDivElement} laterGrid
 * @property {HTMLDivElement} laterNote
 * @property {HTMLAnchorElement[] | null} listLinks   the Watch later list being stepped through, instead of the page's
 * @property {string | null} turned    the orientation turnScreen locked
 * @property {boolean} open
 * @property {HTMLAnchorElement} link  the post on show; typed non-null, but null until a post opens
 *   (the Watch later list opens the modal without one, and what runs there checks it)
 * @property {number} seq              bumped by every new post: loads of an older one drop their result
 * @property {number} [dir]            the direction of travel, for the preload
 * @property {IntersectionObserver | null} [laterIO]
 * @property {string | null} [fileUrl]     the post's own file, once it loaded
 * @property {(() => void) | null} [cancelLoad]
 * @property {boolean} [isSample]
 * @property {boolean} [origPending]
 * @property {string | null} [sampleUrl]
 * @property {string | null} [rawUrl]
 * @property {boolean} [keepSample]
 * @property {ScrollRestoration} [scrollMode]   the page's own, while the modal holds it
 */
// null until the first open builds it (buildModal); what can run before
// then checks it (modal && …), and nothing sets it back.
/** @type {Modal} */
export let modal = /** @type {any} */ (null)

/** @returns {HTMLAnchorElement[]} */
export const siteLinks = () => /** @type {HTMLAnchorElement[]} */ ([...document.querySelectorAll(SITE_LINK)])   // SITE_LINK ends in a

// A like's ❤️ (popHeart): over the post or the thumbnail, it grows, shrinks
// back, grows a little again and shrinks away to nothing, Instagram style.
// In the modal's shadow root and in the page (injectPageCSS) alike.
export const LIKE_CSS = `
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
  `

export function buildModal() {
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
  const box = el('div', { class: 'm' }, [stage, status, el('div', { class: 'bar' }, [close, menu, full, turn, fav, up, count, dlq]), prev, next, quality, sheet, laterView, toast, badge])
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
  /** @type {string | null | undefined} */
  let rawHref = null
  const askRaw = () => { rawHref = null; rawFileUrl().then(u => { rawHref = u }, () => {}) }
  copyBtn.addEventListener('touchstart', askRaw, { passive: true })
  copyBtn.addEventListener('pointerdown', ev => { if (ev.pointerType === 'mouse') askRaw() })
  chipGestures(copyBtn, () => rawHref, () => copyRawLink(), 'the post\'s file')
  laterClose.addEventListener('click', () => closeModal(false))
  quality.addEventListener('click', () => toggleQuality())
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
  modal = { host, root, box, stage, vwrap, video, image, controls, post, count, status, fav, up, vfav: favUp, gearMenu, dlq, score, toast, badge, turn, fsBtn, menu, sheet, tagList, laterBtn, dlBtn, playerBtn, appDlBtn, appReduceBtn, quality, tabTags, tabInfo, tabComments, infoList, commentList, sheetTab: 'tags', laterView, laterHead, laterGrid, laterNote, listLinks: null, turned: null, open: false, link: /** @type {any} */ (null), seq: 0 }
}

let toastTimer = 0
/** @param {string} text */
export function flash(text) {
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
/** @typedef {{ f: Set<string>, v: Set<string>, c: Set<string> }} Marks  ids: f favorites, v upvoted posts, c upvoted comments */
/** @type {Marks | null} */
let marks = null

/** @returns {Marks} */
function loadMarks() {
  if (!marks) {
    const m = readJSON(MARKS_KEY, {})
    marks = { f: new Set(m.f || []), v: new Set(m.v || []), c: new Set(m.c || []) }   // c: upvoted comments
  }
  return marks
}

/**
 * @param {keyof Marks} kind
 * @param {string} id
 * @param {boolean} on
 */
export function setMark(kind, id, on) {
  const set = loadMarks()[kind]
  if (on === set.has(id)) return
  if (on) set.add(id)
  else set.delete(id)
  while (set.size > MARKS_MAX) set.delete(/** @type {string} */ (set.values().next().value))   // not empty
  // loadMarks() above filled marks.
  writeJSON(MARKS_KEY, { f: [.../** @type {Marks} */ (marks).f], v: [.../** @type {Marks} */ (marks).v], c: [.../** @type {Marks} */ (marks).c] })
}

/** @param {keyof Marks} kind @param {string} id */
export const hasMark = (kind, id) => loadMarks()[kind].has(id)

/** @param {string} name */
export function readCookie(name) {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return m ? m[1] : null
}

/**
 * Touches inside the panel are not page gestures.
 * @param {Event} ev
 */
export function insidePanel(ev) {
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : []
  return panelHost ? path.includes(panelHost) : false
}

// An event's target as an element (one with closest()), or null: a text
// node, the document, the window, or no target outside a dispatch.
/**
 * @param {EventTarget | null} target
 * @returns {Element | null}
 */
export function asElement(target) {
  return target && /** @type {Partial<Element>} */ (target).closest ? /** @type {Element} */ (target) : null
}
