/**
 * Landing page: the film plays in the hero (its sound on request), and the
 * sections reveal as they scroll into view.
 */
// A refreshed page starts at its top. Browsers put a reloaded page back
// where it was scrolled, which lands people mid-section with no bearings.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
window.addEventListener('pageshow', () => window.scrollTo(0, 0))

// the advert plays quietly on its own; one press brings the sound (and starts over)
const vid = document.getElementById('herovid') as HTMLVideoElement | null
const sound = document.getElementById('herosound') as HTMLButtonElement | null
if (vid && sound) {
  sound.addEventListener('click', () => {
    if (vid.muted) {
      vid.muted = false
      vid.currentTime = 0
      void vid.play().catch(() => undefined)
      sound.classList.add('playing')
      ;(sound.lastElementChild as HTMLElement).textContent = 'Mute'
    } else {
      vid.muted = true
      sound.classList.remove('playing')
      ;(sound.lastElementChild as HTMLElement).textContent = 'Sound'
    }
  })
  vid.addEventListener('click', () => {
    if (vid.paused) void vid.play().catch(() => undefined)
    else vid.pause()
  })
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
