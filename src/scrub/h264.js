import { describeError, info, warn } from '../core/log'

// ── Keyframe decoder (WebAssembly) ──
// FFmpeg's H.264 decoder built to WebAssembly (wasm/h264dec.c, wasm/build.sh)
// and shipped as an @resource, which Violentmonkey downloads once with the
// script. Keyframes decode straight into a canvas, scaled down to the card:
// no <video>, no hardware decoder slot, any size. The decoder's imports are
// system calls it hardly uses (its logging is off), answered by stubs.
/**
 * The decoder's exports (wasm/h264dec.c).
 * @typedef {object} H264
 * @property {WebAssembly.Memory} memory
 * @property {() => void} [_initialize]
 * @property {(size: number) => number} buf_alloc
 * @property {(ptr: number) => void} buf_free
 * @property {(cfg: number, size: number) => number} dec_open      0 when it took the stream
 * @property {(ptr: number, size: number, maxW: number) => number} dec_frame   0 when it decoded
 * @property {() => number} dec_width
 * @property {() => number} dec_height
 * @property {() => number} dec_rgba     where the last frame's pixels are
 * @property {() => void} dec_close
 */
/** @type {H264 | null} */
let h264 = null          // the decoder's exports, once loaded
/** @type {Promise<H264> | null} */
let h264Loading = null
export let h264Broken = ''      // why it cannot load, after a first try: the <video> reel from then on

/** @returns {Promise<H264>} */
export function h264Decoder() {
  if (h264) return Promise.resolve(h264)
  if (!h264Loading) {
    h264Loading = (async () => {
      if (typeof GM_getResourceURL !== 'function') throw new Error('no GM_getResourceURL grant')
      const t0 = performance.now()
      const bytes = await (await fetch(GM_getResourceURL('h264dec'))).arrayBuffer()
      const mod = await WebAssembly.compile(bytes)
      /** @type {WebAssembly.Memory | null} */
      let mem = null
      // Only called by the decoder, which runs once mem is set (start-up is _initialize, below).
      const view = () => new DataView(/** @type {WebAssembly.Memory} */ (mem).buffer)
      /** @type {Record<string, (...args: number[]) => number>} */
      const calls = {
        fd_write: (fd, iov, count, written) => {   // nothing to show: count the bytes as written
          let n = 0
          for (let i = 0; i < count; i++) n += view().getUint32(iov + i * 8 + 4, true)
          view().setUint32(written, n, true)
          return 0
        },
        environ_sizes_get: (count, size) => { view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0 },
        clock_time_get: (id, precision, out) => { view().setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true); return 0 },
        random_get: (buf, len) => { crypto.getRandomValues(new Uint8Array(/** @type {WebAssembly.Memory} */ (mem).buffer, buf, len)); return 0 },
        proc_exit: code => { throw new Error(`decoder exited (${code})`) },
      }
      /** @type {WebAssembly.Imports} */
      const imports = {}
      for (const imp of WebAssembly.Module.imports(mod)) {
        (imports[imp.module] = imports[imp.module] || {})[imp.name] = calls[imp.name] || (() => 0)
      }
      const x = /** @type {H264} */ (/** @type {unknown} */ ((await WebAssembly.instantiate(mod, imports)).exports))
      mem = x.memory
      if (x._initialize) x._initialize()   // the C library's own start-up
      info(`keyframe decoder: WebAssembly ready (${Math.round(bytes.byteLength / 1024)} KB in ${Math.round(performance.now() - t0)} ms)`)
      h264 = x
      return x
    })()
    h264Loading.catch(e => {
      h264Broken = describeError(e)
      warn(`keyframe decoder: ${h264Broken}; reels play in a <video>`)
    }).finally(() => { h264Loading = null })
  }
  return h264Loading
}

// Free memory lets go of it (its memory only grows): loaded again on the next hold.
export function dropH264() {
  if (h264) { try { h264.dec_close() } catch (e) { /* gone already */ } }
  h264 = null
}

// One AVCC sample in, an ImageData of at least maxW pixels across out.
/**
 * @param {H264} x
 * @param {Uint8Array} bytes
 * @param {number} maxW
 */
export function decodeKeyframe(x, bytes, maxW) {
  const ptr = x.buf_alloc(bytes.length)
  new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes)
  const r = x.dec_frame(ptr, bytes.length, maxW)
  x.buf_free(ptr)
  if (r !== 0) throw new Error(`keyframe decode failed (${r})`)
  const w = x.dec_width()
  const h = x.dec_height()
  const at = x.dec_rgba()
  // A copy: the memory's buffer is replaced whenever it grows.
  return new ImageData(new Uint8ClampedArray(x.memory.buffer.slice(at, at + w * h * 4)), w, h)
}
