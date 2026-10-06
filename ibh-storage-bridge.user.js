// ==UserScript==
// @name         Image Board Helper — storage bridge
// @namespace    joao.imageboardhelper
// @version      1.6.0
// @description  Keeps Image Board Helper's lists (Watch later, the favorites index) and a copy of its settings in Violentmonkey's own storage, on the device, and saves files for its Download button
// @author       João
// @homepageURL  https://github.com/JoaoRoch4/ImageBoardHelper
// @downloadURL  https://raw.githubusercontent.com/JoaoRoch4/ImageBoardHelper/masonry-companion/ibh-storage-bridge.user.js
// @license      MIT
// @match        https://rule34.xxx/*
// @match        https://safebooru.org/*
// @match        https://tbib.org/*
// @match        https://xbooru.com/*
// @match        https://realbooru.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      *
// @noframes
// ==/UserScript==

// Why a second script: the main one needs @grant none (it patches the page's
// own objects), and GM storage exists only for scripts with a @grant. This one
// holds the storage and answers the main script through events on window.
// Messages travel as JSON strings, which cross between the page and the
// extension's sandbox as they are.
(() => {
  'use strict'

  const KEYS = new Set(['later', 'favs', 'cfg', 'searches'])   // what the main script may read and write

  // Any script on the page can send these events, an ad's included: files
  // come only from the site's own hosts (rule34.xxx, api-cdn.rule34.xxx…).
  const SITE = location.hostname.replace(/^www\./, '')
  const siteFile = url => {
    try {
      const u = new URL(url)
      return u.protocol === 'https:' && (u.hostname === SITE || u.hostname.endsWith(`.${SITE}`))
    } catch (e) {
      return false
    }
  }

  // GM_download on Firefox for Android shows the save prompt but revokes its
  // blob: link right away, so confirming saves nothing. Same path, done here:
  // fetch the file (the extension is not bound by CORS), hand Firefox a blob:
  // link to save, and keep that link alive long enough to confirm the prompt.
  const BLOB_LIFE_MS = 120000

  function saveFile(url, name, done, progress) {
    let last = 0
    GM_xmlhttpRequest({
      // A big file takes a while: report how far it got, twice a second at most.
      onprogress: e => {
        if (!e.total || Date.now() - last < 500) return
        last = Date.now()
        progress(e.loaded, e.total)
      },
      method: 'GET',
      url,
      responseType: 'blob',
      timeout: 180000,
      // The video hosts refuse a request without the site as referrer (403),
      // which the browser sends when it plays the video and the extension not.
      headers: { Referer: `${location.origin}/` },
      onload: res => {
        if (res.status !== 200 || !res.response) { done(false, `HTTP ${res.status}`); return }
        const href = URL.createObjectURL(res.response)
        const a = document.createElement('a')
        a.href = href
        a.download = name
        a.style.display = 'none'
        ;(document.body || document.documentElement).appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(href), BLOB_LIFE_MS)
        done(true)
      },
      onerror: () => done(false, 'network error'),
      ontimeout: () => done(false, 'timeout'),
    })
  }

  const reply = (id, value) =>
    window.dispatchEvent(new CustomEvent('ibh-store-reply', { detail: JSON.stringify({ id, value }) }))

  window.addEventListener('ibh-store-request', ev => {
    let msg
    try { msg = JSON.parse(ev.detail) } catch (e) { return }
    if (!msg) return
    // A file for the modal's Download button. A page script cannot save a
    // file from another domain (no CORS on the image hosts); the extension
    // can. Accepted at once, the outcome follows in its own event.
    if (msg.op === 'download' && msg.value && siteFile(msg.value.url)) {
      const done = (ok, error) => window.dispatchEvent(new CustomEvent('ibh-download-done',
        { detail: JSON.stringify({ id: msg.id, ok, error: error || null }) }))
      const progress = (loaded, total) => window.dispatchEvent(new CustomEvent('ibh-download-progress',
        { detail: JSON.stringify({ id: msg.id, loaded, total }) }))
      saveFile(msg.value.url, String(msg.value.name || 'download').replace(/[\\/:*?"<>|]/g, '_'), done, progress)
      reply(msg.id, 'started')
      return
    }
    if (!KEYS.has(msg.key)) return
    if (msg.op === 'set') GM_setValue(msg.key, msg.value)
    reply(msg.id, GM_getValue(msg.key, null))
  })

  // For a main script that asked before this one loaded.
  window.dispatchEvent(new CustomEvent('ibh-store-ready'))
})()
