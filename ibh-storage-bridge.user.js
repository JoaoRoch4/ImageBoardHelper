// ==UserScript==
// @name         Image Board Helper — storage bridge
// @namespace    joao.imageboardhelper
// @version      1.0.0
// @description  Keeps Image Board Helper's lists (Watch later) in Violentmonkey's own storage, on the device, instead of the site's data
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

  window.addEventListener('ibh-store-request', ev => {
    let msg
    try { msg = JSON.parse(ev.detail) } catch (e) { return }
    if (!msg || !KEYS.has(msg.key)) return
    if (msg.op === 'set') GM_setValue(msg.key, msg.value)
    const value = GM_getValue(msg.key, null)
    window.dispatchEvent(new CustomEvent('ibh-store-reply', { detail: JSON.stringify({ id: msg.id, value }) }))
  })

  // For a main script that asked before this one loaded.
  window.dispatchEvent(new CustomEvent('ibh-store-ready'))
})()
