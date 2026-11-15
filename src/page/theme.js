import { ACCENT, ACCENT_DARK, ACCENT_MID, LINE } from '../core/site'
import { CFG } from '../core/config'
import { dbg } from '../core/log'

// The modal's look on the site's own pages: dark slate background, light
// text, teal links and controls, tag kinds in the tags menu's colours. All
// of it hangs on html.ibh-theme, which applySiteTheme() sets with the
// option on.
// Backgrounds go transparent over the dark page (images, videos and icons
// keep theirs); the thumbnails' blue video frame is left alone.
export const THEME_CSS = `
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
  `

/** @type {boolean | null} */
let themeOn = null

export function applySiteTheme() {
  const on = !!CFG.siteTheme
  if (on === themeOn && document.documentElement.classList.contains('ibh-theme') === on) return
  themeOn = on
  document.documentElement.classList.toggle('ibh-theme', on)
  dbg(`site theme ${on ? 'on' : 'off'}`)
}
