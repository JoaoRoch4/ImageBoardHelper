// Imports nothing, so the tools load it too.

// Where a rub takes the video (makeRub), the same rule as the app's
// PreviewRub (QtMediaPlayer's src/previewrub.cpp, targetAt; its
// tests/tst_previewrub.cpp has the cases to keep, here in
// tools/rub.test.mts). The user's request of 2026-11-18: the sensitivity
// follows the finger, the span's ends and the video's length. From where
// a slide starts, the way to the span's right edge is what is left of the
// video, and the way to its left edge what came before, so both ends are
// always in reach (until 2.1.1 the span was the whole video, at most
// 2 min). Short of the very end, where a player stops instead of showing
// a frame.
const END_MARGIN_S = 0.05

/**
 * @param from      px from the span's left edge, where this slide started
 * @param t0        s, the video's time then
 * @param x         px from the span's left edge, the finger now
 * @param width     px, the span's width
 * @param duration  s
 * @returns s, within the video
 */
export function rubTarget(from: number, t0: number, x: number, width: number, duration: number): number {
  let t = t0
  if (x >= from) {
    const room = width - from
    if (room > 0) t = t0 + Math.min(1, (x - from) / room) * (duration - t0)
  } else if (from > 0) {
    t = t0 - Math.min(1, (from - x) / from) * t0
  }
  return Math.min(Math.max(0, duration - END_MARGIN_S), Math.max(0, t))
}
