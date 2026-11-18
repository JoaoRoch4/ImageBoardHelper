// The panel's language and its strings (t).
import { CFG } from './config'
import { I18N } from './strings'

export type Lang = keyof typeof I18N
export type Strings = typeof I18N.en

/**
 * Active language: explicit choice first, otherwise the browser's.
 */
export function resolveLang(): Lang {
  if (CFG.lang && I18N[CFG.lang]) return CFG.lang
  return String(navigator.language || 'en').toLowerCase().startsWith('pt')
    ? 'pt-BR'
    : 'en'
}

export let LANG = resolveLang()
export function setLang(v: typeof LANG) { LANG = v }

export const t: <K extends keyof Strings>(key: K) => Strings[K] = key => {
  const value = I18N[LANG][key]
  return value === undefined ? I18N.en[key] : value
}
