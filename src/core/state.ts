// ═══════════════════════════════════════════════════════════
// State observed by the panel
// ═══════════════════════════════════════════════════════════

export const STATE: { imageBase: string | null, baseCached: boolean, covers: { tracked: number, ok: number, failed: number } } = {
  imageBase: null,
  baseCached: false,
  covers: { tracked: 0, ok: 0, failed: 0 },
}

export let onStateChange: (() => void) | null = null
export function setOnStateChange(v: typeof onStateChange) { onStateChange = v }
export const touch = () => { if (onStateChange) onStateChange() }
