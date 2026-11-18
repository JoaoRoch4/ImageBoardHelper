import { PROFILE } from '../core/site'
import { CFG } from '../core/config'
import { info } from '../core/log'

// ── Themes ──
// One look for the site's pages, the panel and the post viewer, picked in
// the panel (theme). Every colour the script paints with is a CSS variable
// (--ibh-…) set on the page's root, and variables reach into the panel's
// and the viewer's shadow DOM too: a new theme repaints all of it at once.
// "site" leaves the site's pages as the site draws them; the panel and the
// viewer then wear the site's own theme (PROFILE.theme). Colours that mean
// something (the tag kinds, errors, warnings) stay the same in every theme.
export type ThemeName = 'normal' | 'gelbooru' | 'oled' | 'gray' | 'qtmp' | 'site'
export const THEMES: ThemeName[] = ['normal', 'gelbooru', 'oled', 'gray', 'qtmp', 'site']

type Palette = {
  bg: string,          // the site's pages
  base: string,        // the panel's and the viewer's ground; also text on an accent fill
  baseRgb: string,     // base as "r, g, b", for the see-through grounds: rgba(var(--ibh-base-rgb), .8)
  deep: string,        // below base: the panel's sheet
  surface: string,     // controls on the site's pages
  menu: string,        // the search bar's suggestion list
  tint: string,        // the panel's buttons: base with a touch of the accent
  edge: string,        // borders in the panel and the viewer
  edgeSoft: string,    // the panel's separators
  accentEdge: string,  // a border in the accent's hue
  text: string,
  text2: string,       // the panel's and the viewer's body text
  dim: string,         // secondary text
  dim2: string,        // a step brighter than dim
  faint: string,       // the faintest text: hints, empty states
  accent: string,      // links and active controls
  accentHover: string,
  line: string,        // the lines on the site's pages
  accentDark: string,  // a button's or a selected item's fill under accent text
  accentMid: string,   // the text selection, the RAW badge
  glow: string,        // a focused field's ring
}

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

const PALETTES: Record<Exclude<ThemeName, 'site'>, Palette> = {
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
const variables = (palette: Palette) =>
  Object.entries(palette).map(([key, value]) => `--ibh-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}: ${value};`).join(' ')

// The site's pages in the theme: backgrounds go transparent over the dark
// page (images, videos and icons keep theirs), light text, accent links and
// controls, the tag kinds in the tags menu's colours. All of it hangs on
// html.ibh-theme, which applySiteTheme() sets unless the theme is "site".
// The thumbnails' blue video frame is left alone.
export const THEME_CSS = `
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

let applied: ThemeName | null = null

// The theme's variables on the page's root, and html.ibh-theme unless the
// site's own look was picked. Idempotent: the observer calls it on every
// change of the page, and the panel when the theme changes.
export function applySiteTheme() {
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
