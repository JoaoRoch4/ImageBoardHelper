import { SITE } from '../core/site'
import { readJSON, writeJSON } from '../core/config'
import { dbg, describeError, info, warn } from '../core/log'
import { STATE, touch } from '../core/state'
import { clearUrlCache } from './url-cache'

// ═══════════════════════════════════════════════════════════
// Image server resolution
//
// Several boorus serve thumbnails and files from different hosts, and some
// mirrors only carry thumbnails. Deriving the file from the thumbnail host
// gives a silent 404. Resolve the host once, skipping known mirrors.
// ═══════════════════════════════════════════════════════════

type HostConfig = { thumbsOnly: string[], fallback: string, videoHosts: string[] }
const HOSTS: Record<string, HostConfig> = {
  'rule34.xxx': {
    thumbsOnly: ['miami.rule34.xxx', 'ny.rule34.xxx'],
    fallback: 'https://wimg.rule34.xxx/images',
    // Video mirrors, fastest first. wimg answers 403 for video files. Order
    // measured from the phone's network (time to first byte / 1 MB):
    // api-cdn 0.4 s / 0.3 s, nymp4 0.9 / 1.7, api-cdn-us-mp4 1.0 / 1.8,
    // ahri2mp4 1.3 / 2.2, ws-cdn-video 1.5 / 2.7, api-cdn-mp4 1.9 / 2.9.
    videoHosts: [
      'https://api-cdn.rule34.xxx/images',
      'https://nymp4.rule34.xxx/images',
      'https://api-cdn-us-mp4.rule34.xxx/images',
      'https://ahri2mp4.rule34.xxx/images',
      'https://ws-cdn-video.rule34.xxx/images',
      'https://api-cdn-mp4.rule34.xxx/images',
    ],
  },
}

const HOST_CFG: Partial<HostConfig> = HOSTS[SITE] || {}
const HOST_KEY = `IBH_IMGBASE_${SITE}`
const HOST_TTL = 7 * 24 * 60 * 60 * 1000

export function imageBase(): string | null {
  const cached = readJSON(HOST_KEY, null)
  if (cached && Date.now() < cached.exp) {
    STATE.imageBase = cached.base
    STATE.baseCached = true
    return cached.base
  }

  let base: string | null = null
  const thumb = document.querySelector('img[src*="/thumbnails/"]')
  if (thumb) {
    try {
      const u = new URL(thumb.src)
      if ((HOST_CFG.thumbsOnly || []).includes(u.host)) {
        dbg(`${u.host} only serves thumbnails, skipping`)
      } else {
        base = `${u.protocol}//${u.host}/images`
        dbg(`host detected on page: ${base}`)
      }
    } catch (e) {
      warn(`invalid thumbnail src: ${describeError(e)}`)
    }
  }

  if (!base && HOST_CFG.fallback) {
    base = HOST_CFG.fallback
    dbg(`using fallback host: ${base}`)
  }

  STATE.baseCached = false
  STATE.imageBase = base
  if (base) writeJSON(HOST_KEY, { base, exp: Date.now() + HOST_TTL })
  touch()
  return base
}

export function clearHostCache() {
  try { localStorage.removeItem(HOST_KEY) } catch (e) { /* ignore */ }
  clearUrlCache(false)   // the host is part of every cached URL
  STATE.imageBase = null
  info('host cache cleared')
  imageBase()
}

/**
 * Pull DIR and HASH out of .../thumbnails/DIR/thumbnail_HASH.jpg or .../samples/DIR/sample_HASH.jpg
 */
export function thumbParts(thumbUrl: string | null | undefined): { dir: string, hash: string } | null {
  if (!thumbUrl) return null
  const m = thumbUrl.replace(/\?.*$/, '')
    .match(/\/(?:thumbnails|samples)\/(.+)\/(?:thumbnail|sample)_([^/]+)\.(?:jpe?g|png)$/i)
  // rule34 serves paths like //thumbnails//2389/; keep DIR free of extra slashes.
  return m ? { dir: m[1].replace(/^\/+|\/+$/g, ''), hash: m[2] } : null
}

/**
 * URLs to try, most likely first.
 */
export function fileCandidates(thumbUrl: string, exts: string[]): string[] {
  const p = thumbParts(thumbUrl)
  if (!p) return []

  const bases = []
  const wantsVideo = exts.some(e => e === 'mp4' || e === 'webm')
  if (wantsVideo) bases.push(...(HOST_CFG.videoHosts || []))
  const resolved = imageBase()
  if (resolved) bases.push(resolved)
  try { bases.push(`${new URL(thumbUrl).origin}/images`) } catch (e) { /* ignore */ }

  const out = []
  for (const base of [...new Set(bases)]) {
    for (const ext of exts) out.push(`${base}/${p.dir}/${p.hash}.${ext}`)
  }
  return out
}
