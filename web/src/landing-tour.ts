/**
 * Landing page: the product plays inside the laptop in the hero, and sections
 * reveal as they scroll into view.
 */
import { mountTour } from '../../src/shared/tour'

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
