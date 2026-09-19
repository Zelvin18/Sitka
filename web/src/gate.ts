/**
 * The sign-in card's small behaviours, which used to sit inline in app.html.
 * They live here because the Chrome extension forbids inline scripts: inside
 * it, app.html is the side panel, the viewer and the engine, and the card
 * must switch between "sign in" and "create account" there too.
 */
const $ = (id: string): HTMLElement | null => document.getElementById(id)

// Sign in / Create account: one form, two moods. The buttons app-entry.ts
// wires (gsignin, gsignup, gforgot) keep their ids; only what is shown changes.
;(() => {
  if (!$('gtab-in')) return
  let mode: 'in' | 'up' = 'in'
  const show = (id: string, on: boolean): void => {
    $(id)?.classList.toggle('hidden', !on)
  }
  function setMode(m: 'in' | 'up'): void {
    mode = m
    const up = m === 'up'
    $('gtab-in')?.classList.toggle('on', !up)
    $('gtab-up')?.classList.toggle('on', up)
    const title = $('gtitle')
    if (title) title.textContent = up ? 'Create your account.' : 'Welcome back.'
    const sub = $('gsubtitle')
    if (sub) sub.textContent = up ? 'Free to start. Your sessions stay yours.' : 'Sign in to open your workspace.'
    show('gsignin', !up)
    show('gsignup', up)
    show('gname', up)
    show('gnamelabel', up)
    show('gforgot', !up)
    show('gterms', up)
    const sw = $('gswitch')
    if (sw) {
      sw.innerHTML = up
        ? 'Already have an account? <button type="button" id="gto-in">Sign in</button>'
        : 'New to Sitca? <button type="button" id="gto-up">Create an account</button>'
    }
    $('gpassword')?.setAttribute('autocomplete', up ? 'new-password' : 'current-password')
    const err = $('gerr')
    if (err) err.textContent = ''
    const link = $('gto-in') || $('gto-up')
    link?.addEventListener('click', () => setMode(mode === 'in' ? 'up' : 'in'))
  }
  $('gtab-in')?.addEventListener('click', () => setMode('in'))
  $('gtab-up')?.addEventListener('click', () => setMode('up'))
  $('gto-up')?.addEventListener('click', () => setMode('up'))
  $('geye')?.addEventListener('click', () => {
    const p = $('gpassword') as HTMLInputElement | null
    if (!p) return
    const reveal = p.type === 'password'
    p.type = reveal ? 'text' : 'password'
    const eye = $('geye')
    if (eye) eye.textContent = reveal ? 'Hide' : 'Show'
  })
  // a recap being kept by someone without an account starts on Create account; the app keeps it once they are in
  if (location.hash === '#create' || location.hash.indexOf('#keep=') === 0) setMode('up')
})()

// Loading words move on as the wait grows, and settle on the last line.
;(() => {
  document.querySelectorAll<HTMLElement>('[data-words]').forEach((el) => {
    const words = (el.getAttribute('data-words') || '').split('|')
    let i = 0
    let t: number | null = null
    const tick = (): void => {
      if (i >= words.length - 1) return
      i++
      el.textContent = words[i]
      el.classList.remove('lw')
      void el.offsetWidth
      el.classList.add('lw')
    }
    const stop = (): void => {
      if (t) window.clearInterval(t)
      t = null
    }
    const start = (): void => {
      stop()
      i = 0
      el.textContent = words[0]
      t = window.setInterval(tick, 2400)
    }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((es) => es.forEach((e) => (e.isIntersecting ? start() : stop()))).observe(el)
    } else start()
  })
})()
