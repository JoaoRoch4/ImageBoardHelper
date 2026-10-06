// Declarations for the type check only (npm run typecheck); the userscript
// stays plain JavaScript.

// The Violentmonkey APIs the userscript is granted (@grant). Stored values
// are whatever was stored, so reads are untyped.
declare function GM_getValue(key: string, defaultValue?: unknown): any
declare function GM_setValue(key: string, value: unknown): void
interface GMResponse {
  status: number
  readyState: number
  response: any
  responseHeaders: string
}
declare function GM_xmlhttpRequest(details: {
  method?: string
  url: string
  headers?: Record<string, string>
  responseType?: 'text' | 'json' | 'blob' | 'arraybuffer' | 'document'
  timeout?: number
  onload?: (res: GMResponse) => void
  onreadystatechange?: (res: GMResponse) => void
  onerror?: (err: unknown) => void
  ontimeout?: () => void
  onabort?: () => void
  onprogress?: (e: { loaded: number; total: number }) => void
}): { abort(): void }
declare function GM_getResourceURL(name: string, isBlobUrl?: boolean): string
declare const unsafeWindow: Window & typeof globalThis

// What the DOM types call a plain Element is, here, the HTML element the
// script looked for: loosened once instead of casts all over the code.
interface ParentNode {
  querySelector(selectors: string): any
  querySelectorAll(selectors: string): NodeListOf<any>
}
interface Element {
  readonly dataset: DOMStringMap
  src: string
}
interface EventTarget {
  closest?(selectors: string): Element | null
}
interface Window {
  __ibh: unknown
}
