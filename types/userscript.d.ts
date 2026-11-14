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
  responseText: string   // the body as text (responseType unset or 'text')
  responseHeaders: string
}
declare function GM_xmlhttpRequest(details: {
  method?: string
  url: string
  headers?: Record<string, string>
  data?: string          // the request body
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

// DOM lookups typed by their selector, as the DOM types already do for a bare
// tag name: the tag of the selector's last compound names the element
// ('#stats li' and 'input[type="search"]' are an HTMLLIElement and an
// HTMLInputElement). Anything the parse can't vouch for is a plain Element: a
// selector only known as a string, a list whose parts differ, no tag, or
// parentheses (':has(> img)' would read as an img).
type SelectorTrim<S extends string> = S extends ` ${infer R}` ? SelectorTrim<R> : S extends `${infer R} ` ? SelectorTrim<R> : S
type SelectorLast<S extends string> =
  S extends `${string}>${infer R}` ? SelectorLast<R> :
  S extends `${string}+${infer R}` ? SelectorLast<R> :
  S extends `${string}~${infer R}` ? SelectorLast<R> :
  S extends `${string} ${infer R}` ? SelectorLast<R> : S
type SelectorTag<C extends string> =
  C extends `${infer T}[${string}` ? SelectorTag<T> :
  C extends `${infer T}:${string}` ? SelectorTag<T> :
  C extends `${infer T}.${string}` ? SelectorTag<T> :
  C extends `${infer T}#${string}` ? SelectorTag<T> : C
type TagElement<T extends string> =
  T extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[T] :
  T extends keyof SVGElementTagNameMap ? SVGElementTagNameMap[T] : Element
type SelectorElement<S extends string> =
  {} extends Record<S, 1> ? Element :   // not a literal: string, or a template with a hole
  S extends `${string}(${string}` ? Element :
  S extends `${infer A},${infer B}` ? SelectorElement<A> | SelectorElement<B> :
  TagElement<SelectorTag<SelectorLast<SelectorTrim<S>>>>
interface ParentNode {
  querySelector<S extends string>(selectors: S): SelectorElement<S> | null
  querySelectorAll<S extends string>(selectors: S): NodeListOf<SelectorElement<S>>
}
interface Element {
  closest<S extends string>(selectors: S): SelectorElement<S> | null
}

interface Window {
  __ibh: unknown
}

// Screen orientation lock: Firefox for Android has it (in fullscreen), but
// TypeScript 5's DOM types dropped it, and the LSP runs TypeScript 5.
interface ScreenOrientation {
  lock(orientation: string): Promise<void>
}
