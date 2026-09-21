import type React from 'react'

/**
 * A press on the picture plays or pauses it, the way every video app does.
 * A press on the player's own bar (the bottom strip, where the browser
 * draws its controls) is left to the browser, so nothing toggles twice.
 *
 * On a phone, a player with controls already does this itself: its big
 * play button sits in the middle of the picture, and a tap there reaches
 * this handler too. Toggling again would pause the film the moment it
 * starts — so on touch screens the player's own controls have the say.
 */
export function tapToPlay(e: React.MouseEvent<HTMLVideoElement>): void {
  const v = e.currentTarget
  if (v.controls) {
    if (window.matchMedia('(pointer: coarse)').matches) return
    const r = v.getBoundingClientRect()
    if (e.clientY > r.bottom - 60) return
  }
  if (v.paused) void v.play().catch(() => undefined)
  else v.pause()
}
