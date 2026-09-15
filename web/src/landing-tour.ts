/**
 * Landing page: the product plays inside the laptop in the hero, and sections
 * reveal as they scroll into view.
 */
import { mountTour } from '../../src/shared/tour'
// A refreshed page starts at its top. Browsers put a reloaded page back
// where it was scrolled, which lands people mid-section with no bearings.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
window.addEventListener('pageshow', () => window.scrollTo(0, 0))

const root = document.getElementById('tour')
if (root) {
  mountTour(root, { autoplay: true, loop: true })
}

const revealed = document.querySelectorAll<HTMLElement>('.rv')
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('in')
          io.unobserve(e.target)
        }
      })
    },
    { threshold: 0.15 }
  )
  revealed.forEach((n) => io.observe(n))
} else {
  revealed.forEach((n) => n.classList.add('in'))
}
