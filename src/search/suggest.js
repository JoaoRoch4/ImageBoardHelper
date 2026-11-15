import { PROFILE } from '../core/site'
import { CFG } from '../core/config'
import { t } from '../core/i18n'
import { dbg, describeError } from '../core/log'
import { asElement } from '../modal/modal'
import { HOLD_SLOP } from '../modal/tags'
import { el } from '../panel/panel'

// ─── tag suggestions for the script's search bars (searchSuggest) ───
// While a word is typed, the site's own suggestion endpoint (PROFILE.suggest,
// the one its search box uses) is asked for it, through the page's fetch
// with the login; a list under the field shows the tags with their post
// counts, in their kind's colour, and a tap swaps the word for the tag (a
// drag scrolls the list instead, and the page stays put under it). The
// list's elements carry data-ibh-ui, so the dark theme's broad rules,
// which clear every background, leave them alone.
const SUGGEST_MS = 200
/** @type {WeakSet<HTMLInputElement>} */
const suggesting = new WeakSet()

/** @typedef {{ value: string, count: number, kind: string }} Suggestion */
/**
 * @param {string} term
 * @returns {Promise<Suggestion[]>}
 */
async function fetchSuggestions(term) {
  const res = await fetch(PROFILE.suggest + encodeURIComponent(term), { credentials: 'same-origin' })
  const list = await res.json()
  return (Array.isArray(list) ? list : []).slice(0, 10).flatMap(x => {
    const count = /\((\d+)\)\s*$/.exec(x.label || '')   // "tag (123)" on the Gelbooru 0.2 sites
    return x.value ? [{ value: String(x.value), count: Number(x.post_count ?? (count ? count[1] : 0)) || 0, kind: String(x.category || x.type || '') }] : []
  })
}

/** @param {HTMLInputElement} input */
export function attachSuggest(input) {
  if (!CFG.searchSuggest || suggesting.has(input)) return
  suggesting.add(input)
  const box = el('ul', { class: 'ibh-suggest', 'data-ibh-ui': '' })
  box.hidden = true
  let timer = 0
  let seq = 0
  const close = () => { seq++; box.hidden = true }
  // The word being typed: after the last space, its -, ~ or || prefix apart.
  const word = () => {
    const token = /\S*$/.exec(input.value)?.[0] ?? ''
    const m = /^(\|\||[-~]?)(.*)$/.exec(token) ?? ['', '', '']
    return { token, prefix: m[1] ?? '', term: (m[2] ?? '').replace(/\*+$/, '') }
  }
  /** @param {Suggestion[]} items */
  const show = items => {
    if (!items.length) { close(); return }
    if (!box.isConnected) input.parentElement?.appendChild(box)
    box.style.left = `${input.offsetLeft}px`
    box.style.top = `${input.offsetTop + input.offsetHeight + 2}px`
    box.style.width = `${input.offsetWidth}px`
    box.replaceChildren(...items.map(it => el('li', { 'data-value': it.value, 'data-ibh-ui': '', class: it.kind ? `k-${it.kind}` : '' }, [
      el('span', { text: it.value.replace(/_/g, ' '), 'data-ibh-ui': '' }),
      el('small', { text: it.count ? it.count.toLocaleString() : '', 'data-ibh-ui': '' }),
    ])))
    box.hidden = false
  }
  input.addEventListener('input', () => {
    clearTimeout(timer)
    const { term } = word()
    if (term.length < 2) { close(); return }
    timer = setTimeout(() => {
      const mine = ++seq
      fetchSuggestions(term).then(items => {
        if (mine !== seq) return   // typed on meanwhile
        dbg(`search: ${items.length} suggestions for "${term}"`)
        show(items)
      }, e => { if (mine === seq) { dbg(`search: no suggestions for "${term}" (${describeError(e)})`); close() } })
    }, SUGGEST_MS)
  })
  /** @param {HTMLElement} li */
  const pick = li => {
    const { token, prefix } = word()
    input.value = `${input.value.slice(0, input.value.length - token.length)}${prefix}${li.dataset.value} `
    close()
    input.focus()
    dbg(`search: suggestion "${li.dataset.value}" picked`)
  }
  /** @param {Event} ev */
  const itemAt = ev => asElement(ev.target)?.closest('li')
  // A finger on the list may be scrolling it, so the tag goes in when the
  // finger lifts, and only if it stayed nearly still and the list did not
  // scroll. Measured on touch events, as in chipGestures: Firefox for
  // Android cancels the pointer as soon as the list starts to scroll.
  /** @type {{ x: number, y: number, top: number } | null} */
  let finger = null
  let touchedAt = 0
  box.addEventListener('touchstart', ev => {
    const t = ev.touches[0]
    touchedAt = Date.now()
    finger = ev.touches.length === 1 ? { x: t.clientX, y: t.clientY, top: box.scrollTop } : null
  }, { passive: true })
  box.addEventListener('touchmove', ev => {
    const t = ev.touches[0]
    if (finger && Math.hypot(t.clientX - finger.x, t.clientY - finger.y) > HOLD_SLOP) finger = null   // a scroll
  }, { passive: true })
  box.addEventListener('touchcancel', () => { finger = null })
  box.addEventListener('touchend', ev => {
    const li = itemAt(ev)
    const still = finger && Math.abs(box.scrollTop - finger.top) < HOLD_SLOP
    finger = null
    if (!li || !still) return
    ev.preventDefault()   // no mouse events or click after it: the list is gone, and they would land on what was under it
    pick(li)
  })
  // The mouse: mousedown would move the focus out of the field; click picks.
  box.addEventListener('mousedown', ev => ev.preventDefault())
  box.addEventListener('click', ev => {
    const li = itemAt(ev)
    if (li && Date.now() - touchedAt > 800) pick(li)   // a click that follows a touch was the touch's
  })
  input.addEventListener('blur', () => setTimeout(close, 150))
  input.addEventListener('keydown', ev => { if (ev.key === 'Escape') close() })
}

/** @param {string | undefined} text */
export const orTags = text => String(text || '').trim().split(/[\s~()]+/).filter(Boolean)
// The OR field's groups: || starts another one, and each must hold, so
// a b || c d is (a or b) and (c or d).
/** @param {string | undefined} text */
export const orGroups = text => String(text || '').split('||').map(orTags).filter(g => g.length)

export function minScoreInput() {
  const min = el('input', { class: 'min', type: 'number', min: '0', step: '1', inputmode: 'numeric', placeholder: t('minScore') })
  min.title = t('minScore')
  return min
}

export function kindSelect() {
  const kind = el('select', { class: 'kind' })
  for (const [value, label] of [['all', t('favKindAll')], ['image', t('favKindImage')], ['video', t('favKindVideo')],
    ['gif', t('favKindGif')], ['animated', t('favKindAnimated')]]) {
    kind.appendChild(el('option', { value, text: label }))
  }
  return kind
}
