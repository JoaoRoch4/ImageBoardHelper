// ==UserScript==
// @name         Image Board Helper — storage bridge
// @namespace    joao.imageboardhelper
// @version      1.1.0
// @description  Keeps Image Board Helper's lists (Watch later) in Violentmonkey's own storage, on the device, and saves files for its Download button
// @author       João
// @homepageURL  https://github.com/JoaoRoch4/ImageBoardHelper
// @downloadURL  https://raw.githubusercontent.com/JoaoRoch4/ImageBoardHelper/main/ibh-storage-bridge.user.js
// @license      MIT
// @match        https://rule34.xxx/*
// @match        https://safebooru.org/*
// @match        https://tbib.org/*
// @match        https://xbooru.com/*
// @match        https://realbooru.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_download
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

  const KEYS = new Set(['later'])   // what the main script may read and write

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
      GM_download({
        url: msg.value.url,
        name: String(msg.value.name || 'download').replace(/[\\/:*?"<>|]/g, '_'),
        onload: () => done(true),
        onerror: e => done(false, (e && (e.error || e.details)) || 'error'),
        ontimeout: () => done(false, 'timeout'),
      })
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
