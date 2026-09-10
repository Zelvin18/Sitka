/**
 * What attending feels like — a short looping picture story shown on the join
 * screen: the QR is scanned, the presenter's screen appears with captions, a
 * private question is answered, the room talks, the pack arrives. Plain DOM
 * and CSS, monochrome, no images.
 */

const MARK =
  '<svg class="at-mark" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true"><circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" stroke-width="9"/><circle cx="46.1" cy="17.9" r="9"/></svg>'

interface Scene {
  caption: string
  seconds: number
  html: string
}

const SCENES: Scene[] = [
  {
    caption: 'Scan the code on the screen. No app, no account.',
    seconds: 5,
    html: `
      <div class="at-phone">
        <div class="at-cam"><div class="at-qr"><i></i><i></i><i></i><i></i></div><div class="at-scan"></div></div>
        <div class="at-toast at-in" style="animation-delay:2.4s">${MARK}Joining <b>Opportunities in AI</b>…</div>
      </div>`
  },
  {
    caption: "The presenter's screen, live, with every word written down.",
    seconds: 7,
    html: `
      <div class="at-phone">
        <div class="at-stage at-in"><span class="at-eq">Find dy/dx for y = 3x² + 4</span><span class="at-tag">LIVE</span></div>
        <div class="at-line at-in" style="animation-delay:1s"><span>0:12</span><span>Take y equals three x squared plus four.</span></div>
        <div class="at-line at-in" style="animation-delay:2.6s"><span>0:20</span><span>Bring the exponent down, then reduce it by one.</span></div>
        <div class="at-line at-in" style="animation-delay:4.2s"><span>0:31</span><span>So the derivative is six x.</span></div>
      </div>`
  },
  {
    caption: 'Ask anything, privately. The answer is yours alone.',
    seconds: 7,
    html: `
      <div class="at-phone">
        <div class="at-stage small"><span class="at-eq">Find dy/dx for y = 3x² + 4</span><span class="at-tag">LIVE</span></div>
        <div class="at-q at-in" style="animation-delay:.8s">what's on the board?</div>
        <div class="at-dots at-in" style="animation-delay:1.8s;animation-name:atIn,atOut;animation-duration:.3s,.3s;animation-delay:1.8s,3.2s"><i></i><i></i><i></i></div>
        <div class="at-a at-in" style="animation-delay:3.4s">It asks for dy/dx of <b>y = 3x² + 4</b>. By the power rule, <b>dy/dx = 6x</b>. <span class="at-chip">0:31</span></div>
      </div>`
  },
  {
    caption: 'Talk with the room. Send a question to the speaker.',
    seconds: 6,
    html: `
      <div class="at-phone">
        <div class="at-rm at-in" style="animation-delay:.4s"><b>Kelvin</b><span>Is this in the exam?</span></div>
        <div class="at-rm me at-in" style="animation-delay:1.6s"><b>You</b><span>He said every exam, twice</span></div>
        <div class="at-rm host at-in" style="animation-delay:3s"><b>Host</b><span>Yes — and the chain rule next week.</span></div>
      </div>`
  },
  {
    caption: 'When it ends, your take-home pack is already written.',
    seconds: 6,
    html: `
      <div class="at-phone">
        <div class="at-pack at-in"><small>Your take-home pack</small><b>Basic differentiation rules</b>
          <ul><li>Power rule: bring the exponent down, reduce by one</li><li>Constants disappear when differentiated</li><li>Chain rule comes up in every exam</li></ul></div>
      </div>`
  }
]

export function mountAttendTour(root: HTMLElement): () => void {
  root.innerHTML = ''
  const stage = document.createElement('div')
  stage.className = 'at-stage-wrap'
  const caption = document.createElement('div')
  caption.className = 'at-caption'
  const dots = document.createElement('div')
  dots.className = 'at-dots-row'
  const dotEls = SCENES.map(() => {
    const d = document.createElement('i')
    dots.appendChild(d)
    return d
  })
  root.append(stage, caption, dots)
  let i = -1
  let timer: number | null = null
  let disposed = false
  const go = (n: number): void => {
    if (disposed) return
    i = n % SCENES.length
    const s = SCENES[i]
    stage.innerHTML = s.html
    caption.textContent = s.caption
    caption.classList.remove('at-in')
    void caption.offsetWidth
    caption.classList.add('at-in')
    dotEls.forEach((d, j) => d.classList.toggle('on', j === i))
    timer = window.setTimeout(() => go(i + 1), s.seconds * 1000)
  }
  const onVis = (): void => {
    if (document.hidden) {
      if (timer) clearTimeout(timer)
      timer = null
    } else if (!timer) go(i + 1)
  }
  document.addEventListener('visibilitychange', onVis)
  go(0)
  return () => {
    disposed = true
    if (timer) clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVis)
  }
}
