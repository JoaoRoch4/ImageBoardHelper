// Development helper, not part of the userscript: a stand-in for VideoReducer's
// `vreduce` in tools/video-reducer.test.mts. It speaks vreduce's output
// contract: one JSON progress line per tick, then {"done":true,…} and exit 0,
// or {"error":…,"stage":…,"http":…} and exit 1; SIGTERM exits 143 with no
// final line.
//
//   fake-vreduce.mts stream --url U --referer R --out FILE
//   fake-vreduce.mts file IN OUT
//   fake-vreduce.mts probe PATH
//
// The behaviour comes from a path segment of the source (…/slow/…,
// …/fail-input/…, …/fail-encode/…), else from $FAKE_VREDUCE, else "ok": a
// tick every 100 ms (slow: 1 s), 64 KB written per tick, 10 ticks for a
// 10 s video at speed 0.8. Signals received go to $FAKE_VREDUCE_LOG.
// TypeScript that Node runs as it is (it strips the types); tsc -p tools checks it.

import * as fs from 'node:fs'

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? '' : '' }
const cmd = args[0]
const source = cmd === 'stream' ? flag('--url') : args[1] ?? ''
const out = cmd === 'stream' ? flag('--out') : args[2] ?? ''
const mode = /\/(ok|slow|fail-input|fail-encode)\//.exec(source)?.[1] ?? process.env.FAKE_VREDUCE ?? 'ok'
const note = (line: string) => { if (process.env.FAKE_VREDUCE_LOG) fs.appendFileSync(process.env.FAKE_VREDUCE_LOG, `${line}\n`) }
const print = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(o)}\n`)

process.on('SIGTERM', () => { note(`SIGTERM ${source}`); process.exit(143) })

if (cmd === 'probe') {
  print({ w: 2560, h: 1440, fps: 60, dur: 10, codec: 'h264', fits: false, out_w: 1920, out_h: 1080, out_fps: 60 })
  process.exit(0)
}

const DUR = 10
const tickMs = mode === 'slow' ? 1000 : 100
let ticks = 0
fs.writeFileSync(out, '')
const timer = setInterval(() => {
  ticks++
  fs.appendFileSync(out, Buffer.alloc(64 * 1024, ticks))
  print({ pos: ticks, dur: DUR, speed: 0.8, fps: 48, skip: 'none', bytes: ticks * 64 * 1024 })
  if (mode.startsWith('fail-') && ticks === 3) {
    clearInterval(timer)
    print({ error: 'HTTP error 403', stage: mode.slice('fail-'.length), http: 403 })
    process.exit(1)
  }
  if (ticks === DUR) {
    clearInterval(timer)
    print({ done: true, out, dur: DUR, speed: 0.8 })
    process.exit(0)
  }
}, tickMs)
