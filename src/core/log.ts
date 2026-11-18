import { CFG } from './config'

// ═══════════════════════════════════════════════════════════
// Log
// ═══════════════════════════════════════════════════════════

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogEntry = { t: number, level: LogLevel, msg: string }
export const LOG: LogEntry[] = []
export const LOG_MAX = 250
export let onLogEntry: ((entry: LogEntry) => void) | null = null   // the panel subscribes here once mounted
export function setOnLogEntry(v: typeof onLogEntry) { onLogEntry = v }

export function log(level: LogLevel, msg: unknown) {
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

export const dbg   = (m: string) => log('debug', m)
export const info  = (m: string) => log('info', m)
export const warn  = (m: string) => log('warn', m)
export const error = (m: string) => log('error', m)

// Whatever was thrown or rejected, an Error or not: its message, or itself as text.
export const describeError = (e: unknown) => (e && (e as Partial<Error>).message ? (e as Error).message : String(e))

// A log entry as one line of text, as Copy log and the console's tail() give it.
export const logLine = (e: LogEntry) => `${new Date(e.t).toTimeString().slice(0, 8)} [${e.level}] ${e.msg}`
