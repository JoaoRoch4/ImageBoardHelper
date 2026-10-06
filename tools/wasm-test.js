#!/usr/bin/env node
// Development helper, not part of the userscript.
//
// Decodes the scene keyframes of a local MP4 with wasm/h264dec.wasm, through
// the userscript's own MP4 reader, and times each decode (split into the
// decoder and the colour conversion). With an output folder it also writes
// the first three pictures as PPM, to compare against ffmpeg.
//
//   node tools/wasm-test.js <file.mp4> [scenes=10] [maxWidth=0] [ppm folder]

'use strict'
const fs = require('fs')
const path = require('path')
const src = fs.readFileSync(path.join(__dirname, '..', 'image-board-helper.user.js'), 'utf8')
const block = src.slice(src.indexOf('  // MP4 boxes between start and end'), src.indexOf('  // A minimal MP4 around the keyframes'))
const { mp4Boxes, mp4VideoTrack } = new Function(block + '\nreturn { mp4Boxes, mp4Child, mp4VideoTrack }')()
const [file, n = '10', maxW = '0', outDir] = process.argv.slice(2)
if (!file) { console.error('usage: node tools/wasm-test.js <file.mp4> [scenes] [maxWidth] [ppm folder]'); process.exit(1) }

// The avcC record inside the stsd box: entry header 8 + visual sample entry 78.
function avcC(stsd) {
  const entry = { body: 16, end: stsd.length }
  for (const e of mp4Boxes(stsd, entry.body, entry.end)) {
    if (e.type !== 'avc1' && e.type !== 'avc3') return null
    for (const c of mp4Boxes(stsd, e.body + 78, e.end)) if (c.type === 'avcC') return stsd.slice(c.body, c.end)
  }
  return null
}

;(async () => {
  const bytes = new Uint8Array(fs.readFileSync(file))
  let moov = null
  for (const b of mp4Boxes(bytes, 0, bytes.length)) if (b.type === 'moov') { moov = b; break }
  const track = mp4VideoTrack(bytes, moov)
  const cfg = avcC(track.stsd)
  console.log(`${file.split('/').pop()}: ${track.width}x${track.height}, avcC ${cfg ? cfg.length + ' B' : 'missing'}`)
  const wasm = fs.readFileSync(path.join(__dirname, '..', 'wasm', 'h264dec.wasm'))
  const mod = await WebAssembly.compile(wasm)
  console.log('imports:', WebAssembly.Module.imports(mod).map(i => `${i.module}.${i.name}`).join(', '))
  let mem
  const stub = new Proxy({}, { get: (_, name) => (...args) => {
    if (name === 'fd_write') { const dv = new DataView(mem.buffer); let n = 0; for (let i = 0; i < args[2]; i++) n += dv.getUint32(args[1] + i * 8 + 4, true); dv.setUint32(args[3], n, true); return 0 }
    if (name === 'environ_sizes_get') { const dv = new DataView(mem.buffer); dv.setUint32(args[0], 0, true); dv.setUint32(args[1], 0, true); return 0 }
    if (name === 'clock_time_get') { new DataView(mem.buffer).setBigUint64(args[2], BigInt(Math.round(performance.now() * 1e6)), true); return 0 }
    if (name === 'proc_exit') throw new Error('proc_exit ' + args[0])
    return 0
  } })
  const imports = {}
  for (const i of WebAssembly.Module.imports(mod)) imports[i.module] = stub
  const t0 = performance.now()
  const inst = await WebAssembly.instantiate(mod, imports)
  const x = inst.exports
  mem = x.memory
  if (x._initialize) x._initialize()
  console.log(`instantiate ${Math.round(performance.now() - t0)} ms, wasm ${Math.round(wasm.length / 1024)} KB`)
  const copy = data => { const ptr = x.buf_alloc(data.length); new Uint8Array(mem.buffer, ptr, data.length).set(data); return ptr }
  const cp = copy(cfg)
  console.log('dec_open:', x.dec_open(cp, cfg.length))
  x.buf_free(cp)
  const steps = Array.from({ length: Number(n) }, (_, i) => i / Number(n))
  const keys = [...new Set(steps.map(f => track.keyAtOrBefore(track.sampleAt(Math.floor(f * track.duration)))))]
  const times = []
  for (const [i, k] of keys.entries()) {
    const [off, size] = track.place(k)
    const ptr = copy(bytes.subarray(off, off + size))
    const t = performance.now()
    const r = x.dec_frame(ptr, size, Number(maxW))
    const ms = performance.now() - t
    x.buf_free(ptr)
    times.push(ms)
    const w = x.dec_width(), h = x.dec_height()
    if (r === 0 && i < 3 && outDir) {
      const px = new Uint8Array(mem.buffer, x.dec_rgba(), w * h * 4)
      const rgb = Buffer.alloc(w * h * 3)
      for (let j = 0, o = 0; j < px.length; j += 4) { rgb[o++] = px[j]; rgb[o++] = px[j + 1]; rgb[o++] = px[j + 2] }
      fs.writeFileSync(`${outDir}/wasm-${i}.ppm`, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), rgb]))
    }
    console.log(`key ${i} (sample ${k}, ${(track.timeOf(k) / track.timescale).toFixed(3)} s, ${Math.round(size / 1024)} KB): r=${r} ${w}x${h} in ${ms.toFixed(1)} ms (decode ${(x.dec_decode_us() / 1000).toFixed(1)}, convert ${(x.dec_convert_us() / 1000).toFixed(1)})`)
  }
  console.log(`decode avg ${(times.reduce((a, b) => a + b) / times.length).toFixed(1)} ms, max ${Math.max(...times).toFixed(1)} ms`)
})().catch(e => { console.error('FAIL', e.stack); process.exit(1) })
