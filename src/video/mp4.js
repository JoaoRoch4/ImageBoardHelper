// The MP4 reader: boxes, the video track's index, the H.264 decoder
// configuration. Imports nothing, so the tools load it too.
// MP4 boxes between start and end: [size u32][type], a size of 1 puts a
// 64-bit size after the type, 0 runs to the end.
/** @typedef {{ type: string, start: number, body: number, end: number }} Mp4Box */
/**
 * @param {Uint8Array} b
 * @param {number} start
 * @param {number} end
 * @returns {Generator<Mp4Box>}
 */
export function* mp4Boxes(b, start, end) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let p = start
  while (p + 8 <= end) {
    let size = dv.getUint32(p)
    let head = 8
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); head = 16 } else if (size === 0) size = end - p
    if (size < head) return
    yield { type: String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]), start: p, body: p + head, end: p + size }
    p += size
  }
}

/**
 * @param {Uint8Array} b
 * @param {Pick<Mp4Box, 'body' | 'end'>} box
 * @param {string} type
 */
export const mp4Child = (b, box, type) => {
  for (const c of mp4Boxes(b, box.body, box.end)) if (c.type === type) return c
  return null
}

// The video track of a moov box (b holds the box, moov its bounds): its
// timing, its sample description, and where each sample sits in the file.
/**
 * @param {Uint8Array} b
 * @param {Pick<Mp4Box, 'body' | 'end'>} moov
 */
export function mp4VideoTrack(b, moov) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  /** @param {number} p */
  const u32 = p => dv.getUint32(p)
  /** @param {number} p */
  const u64 = p => Number(dv.getBigUint64(p))
  for (const trak of mp4Boxes(b, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue
    const mdia = mp4Child(b, trak, 'mdia')
    const hdlr = mdia && mp4Child(b, mdia, 'hdlr')
    if (!hdlr || String.fromCharCode(...b.subarray(hdlr.body + 8, hdlr.body + 12)) !== 'vide') continue
    const tkhd = mp4Child(b, trak, 'tkhd')
    const mdhd = mp4Child(b, /** @type {Mp4Box} */ (mdia), 'mdhd')   // there: it has an hdlr
    const minf = mp4Child(b, /** @type {Mp4Box} */ (mdia), 'minf')
    const stbl = minf && mp4Child(b, minf, 'stbl')
    if (!tkhd || !mdhd || !stbl) return null
    const [stsd, stts, stss, stsz, stsc, stco, co64] = ['stsd', 'stts', 'stss', 'stsz', 'stsc', 'stco', 'co64'].map(t => mp4Child(b, stbl, t))
    const offsets = stco || co64
    if (!stsd || !stts || !stsz || !stsc || !offsets) return null
    /** @type {Array<[number, number]>} */
    const runs = []   // time to sample: [count, delta]
    for (let i = 0, n = u32(stts.body + 4); i < n; i++) runs.push([u32(stts.body + 8 + i * 8), u32(stts.body + 12 + i * 8)])
    /** @type {number[]} */
    const sync = []   // keyframes, 0-based; no table means every sample is one
    if (stss) for (let i = 0, n = u32(stss.body + 4); i < n; i++) sync.push(u32(stss.body + 8 + i * 4) - 1)
    const fixed = u32(stsz.body + 4)
    const count = u32(stsz.body + 8)
    /** @param {number} k */
    const size = k => fixed || u32(stsz.body + 12 + k * 4)
    const chunks = u32(offsets.body + 4)
    // Without an stco, offsets is the co64.
    /** @param {number} c */
    const chunkAt = c => (stco ? u32(stco.body + 8 + c * 4) : u64(/** @type {Mp4Box} */ (co64).body + 8 + c * 8))
    /** @type {Array<[number, number]>} */
    const perChunk = []   // [first chunk (0-based), samples per chunk]
    for (let i = 0, n = u32(stsc.body + 4); i < n; i++) perChunk.push([u32(stsc.body + 8 + i * 12) - 1, u32(stsc.body + 12 + i * 12)])
    const v1 = b[mdhd.body] === 1
    const tv1 = b[tkhd.body] === 1
    return {
      timescale: u32(mdhd.body + (v1 ? 20 : 12)),
      duration: v1 ? u64(mdhd.body + 24) : u32(mdhd.body + 16),
      width: u32(tkhd.body + (tv1 ? 88 : 76)) >>> 16,
      height: u32(tkhd.body + (tv1 ? 92 : 80)) >>> 16,
      // Frames over seconds, from the sample table: exact, no decoding.
      samples: runs.reduce((sum, [count]) => sum + count, 0),
      stsd: b.slice(stsd.start, stsd.end),
      /**
       * The sample showing at time t (timescale units).
       * @param {number} t
       */
      sampleAt(t) {
        let k = 0
        let at = 0
        for (const [n, delta] of runs) {
          if (t < at + n * delta) return k + Math.floor((t - at) / delta)
          k += n
          at += n * delta
        }
        return Math.max(0, count - 1)
      },
      /** @param {number} k */
      timeOf(k) {
        let at = 0
        for (const [n, delta] of runs) {
          if (k < n) return at + k * delta
          k -= n
          at += n * delta
        }
        return at
      },
      /** @param {number} k */
      keyAtOrBefore(k) {
        if (!sync.length) return k
        let lo = 0
        let hi = sync.length - 1
        let best = sync[0]
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (sync[mid] <= k) { best = sync[mid]; lo = mid + 1 } else hi = mid - 1
        }
        return best
      },
      /**
       * [offset, size] of sample k in the file: its chunk, plus the samples before it in there.
       * @param {number} k
       * @returns {[number, number] | null}
       */
      place(k) {
        let first = 0
        for (let i = 0; i < perChunk.length; i++) {
          const [chunk0, per] = perChunk[i]
          const inRun = ((i + 1 < perChunk.length ? perChunk[i + 1][0] : chunks) - chunk0) * per
          if (k < first + inRun) {
            const c = chunk0 + Math.floor((k - first) / per)
            let off = chunkAt(c)
            for (let j = first + (c - chunk0) * per; j < k; j++) off += size(j)
            return [off, size(k)]
          }
          first += inRun
        }
        return null
      },
    }
  }
  return null
}

// The decoder configuration (avcC) of an H.264 track, from its sample description.
/**
 * @param {Uint8Array} stsd
 * @returns {Uint8Array | null}
 */
export function avcConfig(stsd) {
  for (const entry of mp4Boxes(stsd, 16, stsd.length)) {   // past the box header, version and entry count
    if (entry.type !== 'avc1' && entry.type !== 'avc3') return null
    // A visual sample entry has 78 bytes of fields before its own boxes.
    for (const c of mp4Boxes(stsd, entry.body + 78, entry.end)) if (c.type === 'avcC') return stsd.slice(c.body, c.end)
  }
  return null
}
