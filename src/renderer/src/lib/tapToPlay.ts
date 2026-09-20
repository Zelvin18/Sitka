import type React from 'react'

/**
 * A press on the picture plays or pauses it, the way every video app does.
 * A press on the player's own bar (the bottom strip, where the browser
 * draws its controls) is left to the browser, so nothing toggles twice.
 */
export function tapToPlay(e: React.MouseEvent<HTMLVideoElement>): void {
  const v = e.currentTarget
  if (v.controls) {
    const r = v.getBoundingClientRect()
    if (e.clientY > r.bottom - 60) return
  }
  if (v.paused) void v.play().catch(() => undefined)
  else v.pause()
}
