// Imports nothing, so the tools load it too.
// Past a mid-range hardware decoder (this phone's stops at 1920×1088, in
// either orientation, and at 1080p60's 489,600 macroblocks a second): such
// a video decodes on the CPU, slowly. Without fps only the size counts.
// The same rule as the app's vreduce::fits (QtMediaPlayer's
// src/reduce/probe.hpp, and its static_asserts are the cases to keep):
// the rate rounded first, so a phone's 60.03 or 59.94 fits and 60.6
// (61) doesn't. A rate measured while playing wobbles: its slack is where
// it is measured (HOLD_FPS_SLACK), not here.
const MB_PER_S = 489600
/** @param {number} w @param {number} h @param {number} [fps] */
export const pastDecoder = (w, h, fps) => Math.max(w, h) > 1920 || Math.min(w, h) > 1088 ||
  (!!fps && Math.ceil(w / 16) * Math.ceil(h / 16) * Math.round(fps) > MB_PER_S)
