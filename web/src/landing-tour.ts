/**
 * Landing page: the one-minute walkthrough, started only when it scrolls into
 * view so the page stays light and the animation begins when someone is
 * actually looking.
 */
import { mountTour } from '../../src/shared/tour'

const root = document.getElementById('tour')
if (root) {
  let started = false
  const start = (): void => {
    if (started) return
    started = true
    mountTour(root, { autoplay: true })
  }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          start()
          io.disconnect()
        }
      },
      { threshold: 0.35 }
    )
    io.observe(root)
  } else {
    start()
  }
}
