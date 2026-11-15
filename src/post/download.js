import { SITE } from '../core/site'
import { t } from '../core/i18n'
import { describeError, info, warn } from '../core/log'
import { thumbParts } from '../urls/hosts'
import { cardPicture } from '../thumbs/covers'
import { flash, modal } from '../modal/modal'
import { postInfo } from './post'
import { pageToast } from '../page/bulk'
import { knownOriginal, postId } from '../modal/media'
import { el } from '../panel/panel'

// ── Download ──
// Saves the post's own file (the original image, the GIF, the video) as
// SITE_ID.ext. A page script cannot read a file from the image hosts (they
// send no CORS headers); GM_xmlhttpRequest can. Without it the file opens
// in a new tab, to be saved with a long press (still inside the tap's user
// activation, so the popup blocker lets it through).
export const GM_XHR = typeof GM_xmlhttpRequest === 'function'
/** @type {Set<string>} */
const downloading = new Set() // post ids in flight: a second tap does not start another
/** @type {Map<string, number>} */
const dlPercent = new Map()   // post id -> last progress, for the button
const DL_DONE_MS = 1500       // the ✓ stays this long before the button comes back
const BLOB_LIFE_MS = 120000   // how long Firefox gets to save the file
const DL_STALL_MS = 60000     // a download that gets nothing for this long is given up (no cap on the whole)
/** @type {{ post: string | null, until: number }} */
let dlDoneAt = { post: null, until: 0 }

// Files come only from the site's own hosts (rule34.xxx, api-cdn.rule34.xxx…).
/** @param {string} url */
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
/**
 * @param {string} url
 * @param {string} name
 * @param {(ok: boolean, error?: string) => void} done
 * @param {(loaded: number, total: number) => void} progress
 */
function saveFile(url, name, done, progress) {
  let last = 0
  let heard = Date.now()   // the last time any bytes came
  let over = false
  /** @param {boolean} ok @param {string} [reason] */
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
export function refreshDlButton() {
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

/**
 * @param {string} post
 * @param {boolean} ok
 * @param {string} [reason]
 */
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
/** @returns {Promise<string | null | undefined>} */
export async function rawFileUrl() {
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
/** @param {string} url */
export const portableUrl = url => url.replace(/:\/\/api-cdn\.rule34\.xxx\/(.*\.(?:mp4|webm)(?:[?#]|$))/i, '://api-cdn-mp4.rule34.xxx/$1')

// 🔗: the raw file's link, on the clipboard.
export async function copyRawLink() {
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

export async function modalDownload() {
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
