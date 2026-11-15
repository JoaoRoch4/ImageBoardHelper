import { CFG } from './config'

// ═══════════════════════════════════════════════════════════
// Log
// ═══════════════════════════════════════════════════════════

/** @typedef {'debug' | 'info' | 'warn' | 'error'} LogLevel */
/** @typedef {{ t: number, level: LogLevel, msg: string }} LogEntry */
/** @type {LogEntry[]} */
export const LOG = []
export const LOG_MAX = 250
/** @type {((entry: LogEntry) => void) | null} */
export let onLogEntry = null   // the panel subscribes here once mounted
/** @param {typeof onLogEntry} v */
export function setOnLogEntry(v) { onLogEntry = v }

/**
 * @param {LogLevel} level
 * @param {unknown} msg
 */
export function log(level, msg) {
  const entry = { t: Date.now(), level, msg: String(msg) }
  LOG.push(entry)
  if (LOG.length > LOG_MAX) LOG.shift()

  // Errors and warnings always reach the console; the rest only in debug.
  if (CFG.debug || level === 'error' || level === 'warn') {
    const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'
    console[fn](`[IBH] ${msg}`)
  }
  if (onLogEntry) onLogEntry(entry)
}

/** @param {string} m */
export const dbg   = m => log('debug', m)
/** @param {string} m */
export const info  = m => log('info', m)
/** @param {string} m */
export const warn  = m => log('warn', m)
/** @param {string} m */
export const error = m => log('error', m)

/** @param {any} e  whatever was thrown or rejected */
export const describeError = e => (e && e.message ? e.message : String(e))

// A log entry as one line of text, as Copy log and the console's tail() give it.
/** @param {LogEntry} e */
export const logLine = e => `${new Date(e.t).toTimeString().slice(0, 8)} [${e.level}] ${e.msg}`
