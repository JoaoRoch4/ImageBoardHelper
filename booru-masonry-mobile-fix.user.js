// ==UserScript==
// @name         Booru Masonry — Mobile Fix
// @namespace    joao.booru.masonry.mobilefix
// @version      0.3.0
// @description  Gestos de toque, miniaturas nítidas, capa real de vídeo e conserto do visualizador Fancybox no Booru Masonry
// @author       João
// @license      MIT
// @match        https://yande.re/*
// @match        https://konachan.com/*
// @match        https://konachan.net/*
// @match        https://danbooru.donmai.us/*
// @match        https://gelbooru.com/*
// @match        https://rule34.xxx/*
// @match        https://lolibooru.moe/*
// @match        https://www.sakugabooru.com/*
// @match        https://safebooru.org/*
// @match        https://tbib.org/*
// @match        https://xbooru.com/*
// @match        https://realbooru.com/*
// @match        https://booru.allthefallen.moe/*
// @match        https://aibooru.online/*
// @match        https://rule34hentai.net/*
// @match        https://rule34.paheal.net/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * QUATRO CORREÇÕES, UM ARQUIVO
 *
 * 1. MINIATURA NÍTIDA
 *    O getImgSrc do Masonry só troca previewUrl por sampleUrl quando
 *    `isThumbSampleUrl || (num != 0 && num < 7)`. Com colunas em "Automático",
 *    num vale 0, a condição falha e você fica preso na miniatura pequena.
 *    Ligamos a opção isThumbSampleUrl no localStorage antes do app ler as
 *    configurações — assim ele mesmo escolhe a URL grande, por site, sem
 *    ninguém derivar URL na mão. É a mesma opção que existe em Configurações.
 *
 * 2. CAPA DE VÍDEO
 *    Vídeo é excluído da troca acima (sampleUrl de um vídeo é o .mp4, que não
 *    entra num <img>). Em vez de canvas + CORS, sobrepomos um <video muted
 *    preload="metadata"> posicionado sobre o card: o navegador desenha o frame
 *    real, sem exportar pixel nenhum, então não há problema de CORS.
 *    Um IntersectionObserver garante que só cards visíveis abram decoder.
 *
 * 3. FANCYBOX
 *    fancyboxShow monta os itens com `src: e.jpegUrl || e.fileUrl`, mas vários
 *    adaptadores devolvem fileUrl:"" de propósito — a URL só existe depois do
 *    fetch de detalhe, que só o visualizador nativo dispara. Interceptamos
 *    Fancybox.show, preenchemos os src vazios e instalamos o fallback de
 *    extensão (.jpeg→.jpg→.png→.gif) que o visualizador nativo tem e ele não.
 *
 * 4. GESTOS
 *    Teclas sintéticas na window (o Masonry escuta keyup: A/←, D/→, F) e
 *    cliques nos botões da barra, achados pelo `d` do <path> do ícone.
 *
 * DEPENDE DE: "Monitorar eventos de teclado" ligado nas configurações do
 * Masonry, senão os swipes de navegação não fazem nada.
 */

;(function () {
  'use strict'

  const CFG = {
    sharpThumbs: true,   // força a opção "miniatura usa imagem grande"
    videoCovers: true,   // sobrepõe o frame real do vídeo no card
    fixFancybox: true,   // conserta o visualizador alternativo
    gestures: true,

    swipeMin: 60,        // px mínimos pra contar como swipe
    swipeMaxMs: 600,
    tapSlop: 10,
    doubleTapMs: 300,
    pinchIn: 1.25,
    pinchOut: 0.80,
    frameAt: 1.0,        // segundo do vídeo mostrado como capa
  }

  const ICON = {
    close:   'M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z',
    zoomIn:  'M15.5,14L20.5,19L19,20.5L14,15.5V14.71L13.73,14.43C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.43,13.73L14.71,14H15.5M9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14M12,10H10V12H9V10H7V9H9V7H10V9H12V10Z',
    zoomOut: 'M15.5,14H14.71L14.43,13.73C15.41,12.59 16,11.11 16,9.5A6.5,6.5 0 0,0 9.5,3A6.5,6.5 0 0,0 3,9.5A6.5,6.5 0 0,0 9.5,16C11.11,16 12.59,15.41 13.73,14.43L14,14.71V15.5L19,20.5L20.5,19L15.5,14M9.5,14C7,14 5,12 5,9.5C5,7 7,5 9.5,5C12,5 14,7 14,9.5C14,12 12,14 9.5,14M7,9H12V10H7V9Z',
    video:   'M17,10.5V7A1,1 0 0,0 16,6H4A1,1 0 0,0 3,7V17A1,1 0 0,0 4,18H16A1,1 0 0,0 17,17V13.5L21,17.5V6.5L17,10.5Z',
  }

  // ═══════════════════════════════════════════════════════════
  // 1. Miniatura nítida — roda antes do app ler o localStorage
  // ═══════════════════════════════════════════════════════════

  if (CFG.sharpThumbs) {
    try {
      const KEY = 'YM_APP_SETTINGS'
      const s = JSON.parse(localStorage.getItem(KEY) || '{}')
      if (s.isThumbSampleUrl !== true) {
        s.isThumbSampleUrl = true
        localStorage.setItem(KEY, JSON.stringify(s))
      }
    } catch (err) {
      console.warn('[MobileFix] não consegui ajustar as configurações:', err)
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Derivação de URL — com resolução do servidor de imagens
  //
  // Vários boorus servem miniatura e arquivo de hosts diferentes, e alguns
  // mirrors só têm miniatura. Derivar o arquivo do host da miniatura dá 404
  // calado. Resolvemos o host uma vez, ignorando os mirrors conhecidos, e
  // guardamos o resultado por uma semana.
  // ═══════════════════════════════════════════════════════════

  const HOSTS = {
    'rule34.xxx': {
      thumbsOnly: ['miami.rule34.xxx', 'ny.rule34.xxx'],
      fallback: 'https://wimg.rule34.xxx/images',
      videoHost: 'https://api-cdn-mp4.rule34.xxx/images',
    },
  }

  const SITE = location.hostname.replace(/^www\./, '')
  const HOST_CFG = HOSTS[SITE] || {}
  const HOST_TTL = 7 * 24 * 60 * 60 * 1000

  function imageBase() {
    const KEY = `jmf_imgbase_${SITE}`
    try {
      const c = JSON.parse(localStorage.getItem(KEY) || 'null')
      if (c && Date.now() < c.exp) return c.base
    } catch (err) { /* cache inválido, resolve de novo */ }

    let base = null
    const thumb = document.querySelector('img[src*="/thumbnails/"]')
    if (thumb) {
      try {
        const u = new URL(thumb.src)
        if (!(HOST_CFG.thumbsOnly || []).includes(u.host)) {
          base = `${u.protocol}//${u.host}/images`
        }
      } catch (err) { /* src estranho, cai no fallback */ }
    }
    if (!base) base = HOST_CFG.fallback || null
    if (base) {
      try {
        localStorage.setItem(KEY, JSON.stringify({ base, exp: Date.now() + HOST_TTL }))
      } catch (err) { /* sem storage, resolve toda vez */ }
    }
    return base
  }

  /** Extrai DIR e HASH de .../thumbnails/DIR/thumbnail_HASH.jpg */
  function thumbParts(thumbUrl) {
    if (!thumbUrl) return null
    const m = thumbUrl.replace(/\?.*$/, '')
      .match(/\/thumbnails\/(.+)\/thumbnail_([^/]+)\.(?:jpe?g|png)$/i)
    return m ? { dir: m[1], hash: m[2] } : null
  }

  /** Lista de URLs a tentar, da mais provável à menos. */
  function fileCandidates(thumbUrl, exts) {
    const p = thumbParts(thumbUrl)
    if (!p) return []

    const bases = []
    if (exts.some(e => e === 'mp4' || e === 'webm') && HOST_CFG.videoHost) {
      bases.push(HOST_CFG.videoHost)
    }
    const resolved = imageBase()
    if (resolved) bases.push(resolved)
    try { bases.push(`${new URL(thumbUrl).origin}/images`) } catch (err) { /* ignora */ }

    const out = []
    for (const base of [...new Set(bases)]) {
      for (const ext of exts) out.push(`${base}/${p.dir}/${p.hash}.${ext}`)
    }
    return out
  }

  // Mesma escada de extensões que o visualizador nativo usa no onImageLoadError.
  function nextExtension(url) {
    if (!url) return null
    if (/\.jpeg(\?|$)/i.test(url)) return url.replace(/\.jpeg(\?|$)/i, '.jpg$1')
    if (/\.jpg(\?|$)/i.test(url))  return url.replace(/\.jpg(\?|$)/i, '.png$1')
    if (/\.png(\?|$)/i.test(url))  return url.replace(/\.png(\?|$)/i, '.gif$1')
    return null
  }

  // ═══════════════════════════════════════════════════════════
  // 2. Capa real de vídeo
  // ═══════════════════════════════════════════════════════════

  const videoCards = new WeakSet()

  function isVideoCard(card) {
    const p = card.querySelector('.posts-image-type path')
    return !!p && p.getAttribute('d') === ICON.video
  }

  function mountCover(card) {
    if (card.dataset.jcover) return
    const img = card.querySelector('img')
    if (!img || !img.src) return
    const urls = fileCandidates(img.src, ['mp4', 'webm'])
    if (!urls.length) return    // site fora do padrão derivável

    card.dataset.jcover = '1'
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'metadata'      // só o cabeçalho, não o arquivo inteiro
    v.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;' +
      'object-fit:cover;border-radius:4px;pointer-events:none;' +
      'opacity:0;transition:opacity .2s'

    // Percorre os hosts candidatos até um responder, em vez de desistir
    // no primeiro 404 — era isso que fazia a capa sumir em silêncio.
    let i = 0
    const tryNext = () => {
      if (i >= urls.length) { v.remove(); delete card.dataset.jcover; return }
      v.src = `${urls[i++]}#t=${CFG.frameAt}`   // fragmento: pula pro frame
    }
    // Só revela quando há frame desenhado, senão pisca um retângulo preto.
    v.addEventListener('loadeddata', () => { v.style.opacity = '1' })
    v.addEventListener('error', tryNext)
    tryNext()

    if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
    card.appendChild(v)
  }

  function unmountCover(card) {
    const v = card.querySelector('video[style*="object-fit"]')
    if (!v) return
    v.src = ''                  // devolve o decoder; o Android tem poucos
    v.remove()
    delete card.dataset.jcover
  }

  // Abrir decoder só pro que está na tela mantém o celular vivo.
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        for (const e of entries) {
          e.isIntersecting ? mountCover(e.target) : unmountCover(e.target)
        }
      }, { rootMargin: '200px' })
    : null

  function trackCard(card) {
    if (!CFG.videoCovers || videoCards.has(card)) return
    if (!isVideoCard(card)) return
    videoCards.add(card)
    io ? io.observe(card) : mountCover(card)
  }

  function scanCards(root) {
    if (!root.querySelectorAll) return
    root.querySelectorAll('.posts-image-card').forEach(trackCard)
  }

  // O Masonry troca documentElement e body inteiros; o document nunca muda.
  new MutationObserver(records => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue
        if (node.classList && node.classList.contains('posts-image-card')) trackCard(node)
        else scanCards(node)
      }
    }
  }).observe(document, { childList: true, subtree: true })

  // ═══════════════════════════════════════════════════════════
  // 3. Conserto do Fancybox
  // ═══════════════════════════════════════════════════════════

  /**
   * Preenche os src vazios por derivação de URL. É instantâneo e sem rede,
   * e cobre a família booru.org. Sites cuja URL só existe após o fetch de
   * detalhe (sankaku, anime-pictures, kusowanka…) continuam precisando do
   * patch no script original — ver nota no fim do arquivo.
   */
  function repairItems(items) {
    if (!Array.isArray(items)) return
    for (const it of items) {
      if (it && !it.src && it.thumb) {
        const [guess] = fileCandidates(it.thumb, ['jpeg', 'jpg', 'png'])
        if (guess) {
          it.src = guess
          if (!it.downloadSrc) it.downloadSrc = guess
        }
      }
    }
  }

  /**
   * O visualizador nativo tenta .jpeg→.jpg→.png→.gif quando a imagem 404.
   * O Fancybox não tenta nada. Replicamos isso no <img> renderizado.
   */
  function installExtensionFallback(root) {
    root.addEventListener('error', ev => {
      const img = ev.target
      if (!img || img.tagName !== 'IMG') return
      const tries = Number(img.dataset.jtries || 0)
      if (tries >= 3) return
      const next = nextExtension(img.src)
      if (!next) return
      img.dataset.jtries = String(tries + 1)
      img.src = next
    }, true)   // captura: o evento de erro de <img> não borbulha
  }

  function wrapFancybox(FB) {
    if (!FB || FB.__jwrapped || typeof FB.show !== 'function') return FB
    const origShow = FB.show.bind(FB)
    FB.show = function (items, opts) {
      try { repairItems(items) } catch (err) { console.warn('[MobileFix]', err) }
      const inst = origShow(items, opts)
      // O container só existe depois do show.
      requestAnimationFrame(() => {
        const box = document.querySelector('.fancybox__container')
        if (box && !box.dataset.jfallback) {
          box.dataset.jfallback = '1'
          installExtensionFallback(box)
        }
      })
      return inst
    }
    FB.__jwrapped = true
    return FB
  }

  if (CFG.fixFancybox) {
    // A lib é carregada sob demanda; esperamos a atribuição em window.Fancybox.
    let held = window.Fancybox
    if (held) wrapFancybox(held)
    try {
      Object.defineProperty(window, 'Fancybox', {
        configurable: true,
        get: () => held,
        set(v) { held = wrapFancybox(v) },
      })
    } catch (err) {
      console.warn('[MobileFix] não consegui interceptar o Fancybox:', err)
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 4. Gestos
  // ═══════════════════════════════════════════════════════════

  const pressKey = key =>
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))

  function clickToolbarIcon(name) {
    const path = document.querySelector(`.img-detail-toolbar path[d="${ICON[name]}"]`)
    const btn = path && path.closest('button')
    if (!btn) return false
    btn.click()   // funciona mesmo com display:none — o handler do Vue dispara
    return true
  }

  const detailOpen = () => !!document.querySelector('.img_detail_cont')
  const zoomOn     = () => !!document.querySelector('.img_scale_scroll')
  const videoOpen  = () => !!document.querySelector('.img_detail_cont .dplayer')

  const pts = new Map()
  let pinchStart = 0
  let pinchDone = false
  let lastTap = 0
  let swallowClickUntil = 0

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

  function onDown(ev) {
    if (ev.pointerType === 'mouse') return   // no desktop o teclado já resolve
    pts.set(ev.pointerId, {
      ox: ev.clientX, oy: ev.clientY, ot: Date.now(),   // origem fixa
      x: ev.clientX, y: ev.clientY,                      // posição corrente
    })
    if (pts.size === 2) {
      const [a, b] = [...pts.values()]
      pinchStart = dist(a, b)
      pinchDone = false
    }
  }

  function onMove(ev) {
    const p = pts.get(ev.pointerId)
    if (!p) return
    p.x = ev.clientX
    p.y = ev.clientY

    if (pts.size !== 2 || pinchDone || !pinchStart || !detailOpen()) return
    const [a, b] = [...pts.values()]
    const ratio = dist(a, b) / pinchStart
    if (ratio >= CFG.pinchIn && !zoomOn()) {
      pinchDone = true
      clickToolbarIcon('zoomIn')
    } else if (ratio <= CFG.pinchOut && zoomOn()) {
      pinchDone = true
      clickToolbarIcon('zoomOut')
    }
  }

  function onUp(ev) {
    const p = pts.get(ev.pointerId)
    const hadPinch = pinchDone
    pts.delete(ev.pointerId)
    if (pts.size < 2) pinchStart = 0
    if (pts.size === 0) pinchDone = false

    if (!p || hadPinch || !detailOpen() || videoOpen()) return

    const dx = ev.clientX - p.ox
    const dy = ev.clientY - p.oy
    const adx = Math.abs(dx)
    const ady = Math.abs(dy)
    const dt = Date.now() - p.ot

    if (adx < CFG.tapSlop && ady < CFG.tapSlop && dt < 250) {
      const now = Date.now()
      if (now - lastTap < CFG.doubleTapMs) {
        lastTap = 0
        swallowClickUntil = now + 400
        pressKey('f')                     // toque duplo favorita
      } else {
        lastTap = now                     // toque simples: deixa o app tratar
      }
      return
    }

    if (dt > CFG.swipeMaxMs || zoomOn()) return   // com lupa, arrasto é pan

    if (adx > ady && adx >= CFG.swipeMin) {
      swallowClickUntil = Date.now() + 400
      pressKey(dx < 0 ? 'd' : 'a')
    } else if (dy >= CFG.swipeMin && ady > adx) {
      swallowClickUntil = Date.now() + 400
      clickToolbarIcon('close')
    }
  }

  function onCancel(ev) {
    pts.delete(ev.pointerId)
    if (pts.size < 2) pinchStart = 0
    if (pts.size === 0) pinchDone = false
  }

  // Depois do swipe o navegador ainda emite um click, que o app leria como
  // toque na imagem. Descartamos esse clique fantasma.
  function onClickCapture(ev) {
    if (Date.now() < swallowClickUntil) {
      ev.stopPropagation()
      ev.preventDefault()
    }
  }

  if (CFG.gestures) {
    // Listeners na window sobrevivem ao replaceDocument() do Masonry.
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
    window.addEventListener('click', onClickCapture, true)

    // Sem isto o navegador captura o arrasto horizontal como navegação
    // do histórico e o swipe nunca chega até aqui.
    const css = '.img_detail_cont { touch-action: pan-y; }'
    const inject = () => {
      const el = document.createElement('style')
      el.textContent = css
      document.head.appendChild(el)
    }
    document.head ? inject()
                  : document.addEventListener('DOMContentLoaded', inject, { once: true })
  }

  console.info('[MobileFix] ativo — thumbs grandes, capa de vídeo, Fancybox e gestos')
})()

/*
 * LIMITE CONHECIDO — Fancybox em sites de detalhe tardio
 *
 * Em sankaku, anime-pictures, allgirl, hentaibooru e kusowanka a URL do
 * arquivo não existe na listagem e não é derivável da miniatura: ela só sai
 * do fetch de detalhe. Daqui de fora não dá pra escrever em store.imageList,
 * então nesses sites a correção precisa ser no script original — troque
 * showImgModal por:
 *
 *   async function showImgModal(index) {
 *     if (settings.useFancybox) {
 *       const img = store.imageList[index]
 *       if (!img.fileUrl) await handlePostDetail({ value: img })
 *       fancyboxShow(store.imageList, index)
 *       return
 *     }
 *     store.imageSelectedIndex = index
 *     store.showImageSelected = true
 *   }
 */
