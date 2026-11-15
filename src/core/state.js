// ═══════════════════════════════════════════════════════════
// State observed by the panel
// ═══════════════════════════════════════════════════════════

/** @type {{ imageBase: string | null, baseCached: boolean, covers: { tracked: number, ok: number, failed: number } }} */
export const STATE = {
  imageBase: null,
  baseCached: false,
  covers: { tracked: 0, ok: 0, failed: 0 },
}

/** @type {(() => void) | null} */
export let onStateChange = null
/** @param {typeof onStateChange} v */
export function setOnStateChange(v) { onStateChange = v }
export const touch = () => { if (onStateChange) onStateChange() }
