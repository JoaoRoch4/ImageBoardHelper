import type { Scrub } from './scrub'
import type { H264 } from './h264'
import { CFG } from '../core/config'
import { describeError } from '../core/log'
import { fileCandidates, thumbParts } from '../urls/hosts'
import { cacheGet, cacheSet } from '../urls/url-cache'
import { pastDecoder } from '../video/limits'
import { markDuration, markPastDecoder } from '../thumbs/badges'
import { cardPicture } from '../thumbs/covers'
import { PLAY_MAX_S, borrowDecoder, chooseShow, endScrub, noteScene, placeOverPicture, playShow, returnDecoder, scrub, scrubSource, scrubUi, slideSteps } from './scrub'
import { avcConfig, mp4VideoTrack } from '../video/mp4'
import { decodeKeyframe, h264Broken, h264Decoder } from './h264'
import { freeForPreview } from '../thumbs/memory'
import { mmss } from '../modal/player'

// ── Keyframe reel ──
// The hold slideshow without seeking the file: read the MP4's index (its
// moov box), fetch only the keyframe at or before each scene, and pack
// those frames into a small MP4 in memory. Played from a blob in one
// <video>, every scene is a seek to one local keyframe: nothing more to
// download, one frame to decode, one decoder. GM_xmlhttpRequest does the
// Range reads (the hosts send no CORS headers). WebCodecs would decode the
// keyframes directly, but on Firefox for Android it has no decoders (tried:
// every codec unsupported). MP4 only: WebM, or anything unexpected, seeks.
const REEL_HEAD = 256 * 1024    // first read: ftyp and, in most files made for streaming, the whole moov
const REEL_MAX_MOOV = 8e6       // a bigger index is not worth reading for a preview
const REEL_MAX_BYTES = 12e6     // keyframes past this are thinned out (4K frames run to MBs)
const REEL_KEEP = 4             // reels kept for another hold on the same video
export const reels: Map<string, Reel> = new Map()         // URL and scene count -> reel, oldest first

// A video's keyframes, one per scene.
export type Reel = {
  frames: Array<Uint8Array<ArrayBuffer>>,   // each keyframe, an AVCC sample
  track: { stsd: Uint8Array, width: number, height: number },   // what reelBlob needs of the source's track
  avcC: Uint8Array | null,   // the H.264 decoder configuration; null for another codec
  url: string | null,   // the <video> reel's blob, made when first played (reelUrl)
  scenes: Array<{ t: number, f: number }>,   // each keyframe's time (s) and place in the video (0-1)
  bytes: number,   // read for it
  ms: number,   // spent reading it
  width: number,
  height: number,
  duration: number,   // s
  fps: number,   // frames a second, from the index (0 unknown)
  kept?: boolean,   // kept from an earlier hold
}
export type H264Reel = Reel & { avcC: Uint8Array }   // a reel the WebAssembly decoder can open
export type Abortable = { abort(): void }   // a request in flight (GM_xmlhttpRequest's)

// A Range read; `total` is the file size from Content-Range.
/**
 * @param reqs  where the request goes, to abort it
 */
function rangeRead(url: string, start: number, end: number, reqs?: Set<Abortable>): Promise<{ buf: Uint8Array<ArrayBuffer>, total: number | null }> {
  return new Promise((resolve, reject) => {
    let req: Abortable | null = null
    req = GM_xmlhttpRequest({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { Range: `bytes=${start}-${end}`, Referer: `${location.origin}/` },
      // A host ignoring Range sends the whole file: stop at its headers.
      onreadystatechange: r => {
        if (r.readyState >= 2 && r.status === 200 && req) { req.abort(); reject(new Error('no Range support')) }
      },
      onload: r => {
        if (r.status !== 206) { reject(Object.assign(new Error(`HTTP ${r.status}`), { status: r.status })); return }
        const m = (r.responseHeaders || '').match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i)
        resolve({ buf: new Uint8Array(r.response), total: m ? Number(m[1]) : null })
      },
      onerror: () => reject(new Error('network error')),
      ontimeout: () => reject(new Error('timeout')),
      onabort: () => reject(new Error('aborted')),
    })
    if (req && reqs) reqs.add(req)
  })
}

// A minimal MP4 around the keyframes: one video track, each sample a
// second long and a keyframe, the source's sample description as it is.
function reelBlob(track: Reel['track'], frames: Reel['frames']) {
  const n = frames.length
  const ascii = (str: string) => Uint8Array.from(str, c => c.charCodeAt(0))
  const words = (...v: number[]) => {
    const out = new Uint8Array(v.length * 4)
    const dv = new DataView(out.buffer)
    v.forEach((x, i) => dv.setUint32(i * 4, x >>> 0))
    return out
  }
  const box = (type: string, ...parts: Uint8Array[]) => {
    const out = new Uint8Array(8 + parts.reduce((sum, part) => sum + part.length, 0))
    new DataView(out.buffer).setUint32(0, out.length)
    out.set(ascii(type), 4)
    let at = 8
    for (const part of parts) { out.set(part, at); at += part.length }
    return out
  }
  const matrix = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]
  const ms = n * 1000
  const ftyp = box('ftyp', ascii('isom'), words(0x200), ascii('isomiso2avc1mp41'))
  const moovWith = (offsets: number[]) => box('moov',
    box('mvhd', words(0, 0, 0, 1000, ms, 0x10000, 0x1000000, 0, 0, ...matrix, 0, 0, 0, 0, 0, 0, 2)),
    box('trak',
      box('tkhd', words(3, 0, 0, 1, 0, ms, 0, 0, 0, 0, ...matrix, track.width * 0x10000, track.height * 0x10000)),
      box('mdia',
        box('mdhd', words(0, 0, 0, 1000, ms, 0x55c40000)),
        box('hdlr', words(0, 0), ascii('vide'), words(0, 0, 0), ascii('VideoHandler\0')),
        box('minf',
          box('vmhd', words(1, 0, 0)),
          box('dinf', box('dref', words(0, 1), box('url ', words(1)))),
          box('stbl', track.stsd,
            box('stts', words(0, 1, n, 1000)),
            box('stsc', words(0, 1, 1, 1, 1)),
            box('stsz', words(0, 0, n, ...frames.map(f => f.length))),
            box('stco', words(0, n, ...offsets)))))))
  // The offsets point past the moov, whose size does not depend on them.
  let at = ftyp.length + moovWith(frames.map(() => 0)).length + 8
  const offsets = frames.map(f => { const o = at; at += f.length; return o })
  const data = frames.reduce((sum, f) => sum + f.length, 0)
  return new Blob([ftyp, moovWith(offsets), words(8 + data), ascii('mdat'), ...frames], { type: 'video/mp4' })
}

// Reads the index and the keyframes for these scene fractions.
async function buildReel(url: string, steps: number[], reqs: Set<Abortable>): Promise<Reel> {
  const t0 = performance.now()
  const head = await rangeRead(url, 0, REEL_HEAD - 1, reqs)
  const total = head.total || head.buf.length
  // The top-level boxes up to the moov: in the head, or after the media data.
  const boxAt = async (p: number) => {
    let b = head.buf
    let o = p
    if (p + 16 > b.length) { b = (await rangeRead(url, p, Math.min(total, p + 16) - 1, reqs)).buf; o = 0 }
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    let size = dv.getUint32(o)
    if (size === 1) size = Number(dv.getBigUint64(o + 8))
    else if (size === 0) size = total - p
    return { type: String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), size }
  }
  let p = 0
  let moov: { at: number, size: number } | null = null
  for (let i = 0; p < total && i < 32 && !moov; i++) {
    const box = await boxAt(p)
    if (box.size < 8) break
    if (box.type === 'moov') moov = { at: p, size: box.size }
    p += box.size
  }
  if (!moov) throw new Error('no moov box')
  if (moov.size > REEL_MAX_MOOV) throw new Error(`index of ${Math.round(moov.size / 1e6)} MB`)
  // Whatever part of the moov the head missed: only the rest is read.
  let mb
  if (moov.at + moov.size <= head.buf.length) mb = head.buf.subarray(moov.at, moov.at + moov.size)
  else if (moov.at < head.buf.length) {
    const rest = (await rangeRead(url, head.buf.length, moov.at + moov.size - 1, reqs)).buf
    mb = new Uint8Array(moov.size)
    mb.set(head.buf.subarray(moov.at))
    mb.set(rest, head.buf.length - moov.at)
  } else mb = (await rangeRead(url, moov.at, moov.at + moov.size - 1, reqs)).buf
  const track = mp4VideoTrack(mb, { body: new DataView(mb.buffer, mb.byteOffset).getUint32(0) === 1 ? 16 : 8, end: mb.length })
  if (!track) throw new Error('no video track')
  let keys: number[] = []
  for (const f of steps) {
    const k = track.keyAtOrBefore(track.sampleAt(Math.floor(f * track.duration)))
    if (!keys.includes(k)) keys.push(k)
  }
  // Short clips can have one or two keyframes in the whole file: the reel
  // would repeat them, and the clip plays instead (playShow). Three or more
  // make a reel, even with fewer scenes than asked: each one shows at once,
  // while seeking took over a second a scene (8 keyframes for 20 scenes
  // went to seeking, half the scenes late). Past the hardware decoder any
  // keyframes beat decoding up to every scene on the CPU.
  const need = Math.min(steps.length, 3)
  if (keys.length < need && !pastDecoder(track.width, track.height, track.duration ? track.samples * track.timescale / track.duration : 0)) {
    throw Object.assign(new Error(`only ${keys.length} keyframes for ${steps.length} scenes`), { sparse: true, duration: track.duration / track.timescale })
  }
  let places = keys.map(k => track.place(k))
  if (places.some(pl => !pl)) throw new Error('a keyframe outside the chunk table')
  // Heavy frames (4K): every other one until they fit. None is null past the check above.
  while (keys.length > 2 && places.reduce((sum, pl) => sum + (pl as [number, number])[1], 0) > REEL_MAX_BYTES) {
    keys = keys.filter((k, i) => i % 2 === 0)
    places = places.filter((pl, i) => i % 2 === 0)
  }
  const frames = await Promise.all((places as Array<[number, number]>).map(([off, size]) => rangeRead(url, off, off + size - 1, reqs).then(r => r.buf)))
  const secs = track.duration / track.timescale
  return {
    frames,
    track: { stsd: track.stsd, width: track.width, height: track.height },
    avcC: avcConfig(track.stsd),
    url: null,   // the <video> reel's blob, made when first played (reelUrl)
    scenes: keys.map(k => {
      const t = track.timeOf(k) / track.timescale
      return { t, f: secs ? t / secs : 0 }
    }),
    bytes: mb.length + frames.reduce((sum, f) => sum + f.length, 0),
    ms: Math.round(performance.now() - t0),
    width: track.width,
    height: track.height,
    duration: secs,
    fps: secs ? track.samples / secs : 0,
  }
}

// A reel for one of these URLs (the first the host has), kept for the next hold.
/**
 * @param hash  the file's, to cache the host that has it
 */
export async function reelFor(urls: string[], steps: number[], reqs: Set<Abortable>, hash: string | null | undefined): Promise<Reel> {
  for (const url of urls) {
    const key = `${url}|${steps.length}`
    const kept = reels.get(key)
    if (kept) {
      reels.delete(key)
      reels.set(key, kept)
      return { ...kept, ms: 0, kept: true }
    }
    try {
      const reel = await buildReel(url, steps, reqs)
      if (hash) cacheSet('video', hash, url)
      reels.set(key, reel)
      for (const [old, r] of reels) {
        if (reels.size <= REEL_KEEP) break
        if (r.url) URL.revokeObjectURL(r.url)
        reels.delete(old)
      }
      return reel
    } catch (e) {
      if (!(e as { status?: number }).status || urls.indexOf(url) === urls.length - 1) throw e   // HTTP error: try the next host
    }
  }
  throw new Error('no host has the file')
}

// The reel slideshow's own parts: requests in flight, the scene timer, and
// what shows the reel (a <video> or a canvas, in a holder over the card).
export type ReelShow = { reqs: Set<Abortable>, timer: number, video: HTMLVideoElement | null, holder: HTMLElement | null, borrowed: boolean, info?: Reel }

export function startReelShow(s: Scrub) {
  if (typeof GM_xmlhttpRequest !== 'function') return false
  const pic = cardPicture(s.card)
  if (!pic) return false
  const hash = (thumbParts(pic.src) || {}).hash
  const cover = s.card.querySelector('video[data-ibh]')
  const known = (cover && cover.currentSrc) || (hash && cacheGet('video', hash))
  if (known && !/\.mp4(?:[?#]|$)/i.test(known)) return false   // WebM: seek
  const urls = known ? [known] : fileCandidates(pic.src, ['mp4'])
  if (!urls.length) return false
  freeForPreview(s.card)
  scrubUi(s)
  s.label.textContent = '…'
  s.dwell = (Number(CFG.slideDwell) || 0.2) * 1000
  s.stats.method = 'reel'
  s.reel = { reqs: new Set(), timer: 0, video: null, holder: null, borrowed: false }
  // Compiling the decoder takes about half a second: alongside the reads, not after them.
  if (CFG.wasmDecode && !h264Broken) h264Decoder().catch(() => { /* logged there */ })
  reelFor(urls, slideSteps(), s.reel.reqs, known ? null : hash).then(
    reel => { if (scrub === s) showReel(s, reel) },
    e => { if (scrub === s) reelFailed(s, e) })
  return true
}

const reelUrl = (reel: Reel) => reel.url || (reel.url = URL.createObjectURL(reelBlob(reel.track, reel.frames)))

// One keyframe per scene, looping, over the thumbnail (and its cover):
// decoded in WebAssembly when it can, else played from a small MP4.
function showReel(s: Scrub, reel: Reel) {
  (s.reel as ReelShow).info = reel   // set by startReelShow, cleared only once this hold is over
  markDuration(s.card, reel.duration)
  if (pastDecoder(reel.width, reel.height, reel.fps)) markPastDecoder(s.card, `${reel.width}x${reel.height} at ${Math.round(reel.fps)} fps`)
  s.stats.detail = `${reel.width}x${reel.height}, ${mmss(reel.duration)}, ${reel.scenes.length} keyframes, ` +
    `${Math.round(reel.bytes / 1024)} KB, ${reel.kept ? 'kept from before' : `read in ${reel.ms} ms`}`
  if (CFG.wasmDecode && reel.avcC && !h264Broken) showReelWasm(s, reel as H264Reel).catch(e => { if (scrub === s) wasmFailed(s, reel, e) })
  else showReelVideo(s, reel)
}

function showReelVideo(s: Scrub, reel: Reel) {
  const r = s.reel as ReelShow
  borrowDecoder(s.card)
  r.borrowed = true
  r.holder = document.createElement('div')
  r.holder.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2'
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  v.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:4px;background:#000'
  r.video = v
  r.holder.appendChild(v)
  placeOverPicture(s.card, r.holder)
  let i = 0
  const show = () => { if (scrub === s) v.currentTime = i + 0.5 }   // inside sample i: that keyframe
  v.addEventListener('seeked', () => {
    if (scrub !== s) return
    const scene = reel.scenes[i]
    s.bar.style.width = `${scene.f * 100}%`
    s.label.textContent = `${mmss(scene.t)} / ${mmss(reel.duration)}`
    noteScene(s)
    i = (i + 1) % reel.scenes.length
    r.timer = setTimeout(show, s.dwell)
  })
  v.addEventListener('loadedmetadata', show, { once: true })
  v.onerror = () => { if (scrub === s) reelFailed(s, new Error('the reel would not play')) }
  v.src = reelUrl(reel)
}

// The decoder has one stream open at a time: the hold slideshow's reel or
// the seek bar's. Opened again only when it changes.
let h264Stream: H264Reel | null = null
export function openStream(x: H264, reel: H264Reel) {
  if (h264Stream === reel) return
  h264Stream = null
  const cfg = x.buf_alloc(reel.avcC.length)
  new Uint8Array(x.memory.buffer, cfg, reel.avcC.length).set(reel.avcC)
  const opened = x.dec_open(cfg, reel.avcC.length)
  x.buf_free(cfg)
  if (opened !== 0) throw new Error(`the decoder refused the stream (${opened})`)
  h264Stream = reel
}

async function showReelWasm(s: Scrub, reel: H264Reel) {
  const x = await h264Decoder()
  if (scrub !== s) return
  openStream(x, reel)
  s.stats.method = 'wasm reel'
  const r = s.reel as ReelShow   // the scrub is still on: endReel has not run
  const maxW = Math.round(s.card.getBoundingClientRect().width * (window.devicePixelRatio || 1))
  const times: number[] = []
  const decode = (i: number) => {
    const t0 = performance.now()
    const img = decodeKeyframe(x, reel.frames[i], maxW)
    times.push(performance.now() - t0)
    s.stats.wasm = `decoded in ${Math.round(times.reduce((a, b) => a + b, 0) / times.length)} ms (max ${Math.round(Math.max(...times))}) to ${img.width}x${img.height}`
    return img
  }
  let next = decode(0)   // a failure here falls back before anything is shown
  r.holder = document.createElement('div')
  r.holder.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2'
  const cv = document.createElement('canvas')
  cv.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:4px;background:#000'
  r.holder.appendChild(cv)
  placeOverPicture(s.card, r.holder)
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D   // a new canvas always has one
  let i = 0
  // Show this scene, then decode the next while it stays on screen.
  const show = () => {
    if (scrub !== s) return
    if (cv.width !== next.width || cv.height !== next.height) { cv.width = next.width; cv.height = next.height }
    ctx.putImageData(next, 0, 0)
    const scene = reel.scenes[i]
    s.bar.style.width = `${scene.f * 100}%`
    s.label.textContent = `${mmss(scene.t)} / ${mmss(reel.duration)}`
    noteScene(s)
    i = (i + 1) % reel.scenes.length
    const t0 = performance.now()
    try { next = decode(i) } catch (e) { wasmFailed(s, reel, e); return }
    r.timer = setTimeout(show, Math.max(0, s.dwell - (performance.now() - t0)))
  }
  show()
}

// The WebAssembly path failed on this video: the same reel in a <video>.
function wasmFailed(s: Scrub, reel: Reel, e: unknown) {
  const r = s.reel
  if (!r) return
  s.stats.wasm = `not decoded: ${describeError(e)}`
  clearTimeout(r.timer)
  if (r.holder) { r.holder.remove(); r.holder = null }
  s.stats.method = 'reel'
  showReelVideo(s, reel)
}

export function endReel(s: Scrub) {
  const r = s.reel
  if (!r) return
  s.reel = null
  clearTimeout(r.timer)
  for (const req of r.reqs) { try { req.abort() } catch (e) { /* done already */ } }
  if (r.video) { r.video.onerror = null; r.video.removeAttribute('src'); r.video.load() }   // the blob stays kept
  if (r.holder) r.holder.remove()
  if (r.borrowed) returnDecoder()
}

// Anything off (WebM behind an .mp4 name, an odd file, a host failing):
// the slideshow seeks the file as before, or plays it when it is a short clip.
// e.sparse: too few keyframes in a clip of e.duration seconds.
function reelFailed(s: Scrub, e: Error & { sparse?: boolean, duration?: number }) {
  s.stats.reelError = e.message
  endReel(s)
  if (!scrubSource(s)) { endScrub(); return }
  if (e.sparse && (e.duration as number) <= PLAY_MAX_S) playShow(s)   // buildReel sets both
  else chooseShow(s)
}
