import { SITE } from '../core/site'
import { CFG } from '../core/config'
import { t } from '../core/i18n'
import { dbg, info } from '../core/log'
import { flash, modal } from '../modal/modal'
import { GM_STORE } from '../storage/storage'
import { GM_XHR, portableUrl } from './download'
import { mmss } from '../modal/player'
import { postId } from '../modal/media'
import { el } from '../panel/panel'

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
export async function sendToApp(mode: 'play' | 'download' | 'reduce') {
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
function setAppToken(value: string) { if (GM_STORE) GM_setValue('appToken', String(value).trim()) }

// One request to the app: { ok, status, json } or { ok: false, stage, error },
// where stage is 'token' (401) or 'app' (not answering, or its own error).
function appCall(method: 'GET' | 'POST', route: string, body?: AppDownloadRequest): Promise<{ ok: boolean, status: number, json: any, stage?: string, error?: string }> {
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
let appStatusRow: HTMLDivElement | null = null
export function appControls() {
  const field = el('input', { class: 'apptoken', type: 'password', autocomplete: 'off', placeholder: t(GM_STORE ? 'appToken' : 'appNoStore') })
  field.disabled = !GM_STORE
  field.value = appToken()
  field.addEventListener('change', () => { setAppToken(field.value); refreshAppStatus() })
  appStatusRow = el('div', { class: 'lbl appstatus', text: '…' })
  refreshAppStatus()
  return el('div', { class: 'lang' }, [el('div', { class: 'lbl', text: t('appToken') }), field, appStatusRow])
}

export async function refreshAppStatus() {
  const row = appStatusRow
  if (!row || !CFG.appBridge) return
  if (!GM_STORE) { row.textContent = t('appNoStore'); return }
  const r = await appCall('GET', 'v1/status')
  const status = (r.ok ? r.json : null) as AppStatus
  row.textContent = status ? `${t('appOk')} · ${status.version}` : t(r.stage === 'token' ? 'appBadToken' : 'appDown')
  if (status) dbg(`app server: ${status.app} ${status.version}, api ${status.api}`)
  else if (!r.ok) info(`app server: ${r.stage} ${r.error}`)
}

// ⬇ App or ⚡ 1080p by the app's server; false when it can't take it, and
// the caller sends the intent link instead.
async function appDownload(fileUrl: string, reduce: boolean, title: string) {
  if (!CFG.appBridge || !appToken()) return false
  const post = postId(modal.link)
  const body: AppDownloadRequest = { url: fileUrl, referer: `${location.origin}/`, title, reduce }
  const r = await appCall('POST', 'v1/download', body)
  if (!r.ok) { info(`app server: ${r.stage} ${r.error}; post ${post} goes by the intent link`); return false }
  const queued = r.json as AppDownloadQueued
  info(`app server: post ${post} queued as download ${queued.id}${reduce ? ', to convert' : ''}`)
  flash(t(reduce ? 'appReduceQueued' : 'appQueued'))
  followAppDownload(queued.id, post)
  return true
}

// Asks the app how a download goes until it (and its conversion) ends,
// and says so on the page. The app answers while it downloads or converts
// (a foreground service keeps it awake), so misses mean it went away.
function followAppDownload(id: number, post: string) {
  let misses = 0
  let said = ''
  const say = (key: 'appFailed' | 'appSaved' | 'appFits' | 'appConverted' | 'appConverting', line: string) => { if (said === key) return; said = key; flash(t(key)); info(`app server: post ${post} ${line}`) }
  const tick = async () => {
    const r = await appCall('GET', `v1/download/${id}`)
    if (!r.ok) {
      if (r.status === 404 || ++misses > APP_POLL_MISSES) { info(`app server: lost download ${id} of post ${post} (${r.error})`); return }
      setTimeout(tick, APP_POLL_MS)
      return
    }
    misses = 0
    const s = r.json as AppDownloadState
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
