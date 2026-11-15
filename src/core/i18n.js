// The panel's language and its strings (t).
import { CFG } from './config'
import { I18N } from './strings'

/** @typedef {keyof typeof I18N} Lang */
/** @typedef {typeof I18N.en} Strings */

/**
 * Active language: explicit choice first, otherwise the browser's.
 * @returns {Lang}
 */
export function resolveLang() {
  if (CFG.lang && I18N[CFG.lang]) return CFG.lang
  return String(navigator.language || 'en').toLowerCase().startsWith('pt')
    ? 'pt-BR'
    : 'en'
}

export let LANG = resolveLang()
/** @param {typeof LANG} v */
export function setLang(v) { LANG = v }

/** @type {<K extends keyof Strings>(key: K) => Strings[K]} */
export const t = key => {
  const value = I18N[LANG][key]
  return value === undefined ? I18N.en[key] : value
}
