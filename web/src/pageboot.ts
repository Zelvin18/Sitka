/**
 * The few things the static pages used to do in inline scripts, which the
 * Content-Security-Policy no longer allows (no script runs on these pages
 * that is not one of the site's own files):
 *
 *  - the web font, fetched without blocking the page, switched on when it lands;
 *  - a picture marked `data-reveal` fades in once it has loaded;
 *  - a loading line with `data-words="a|b|c"` steps through its words.
 */
for (const l of Array.from(document.querySelectorAll('link[data-font]')) as HTMLLinkElement[]) {
  if (l.sheet) l.media = 'all'
  else l.addEventListener('load', () => (l.media = 'all'), { once: true })
}

for (const img of Array.from(document.querySelectorAll('img[data-reveal]')) as HTMLImageElement[]) {
  if (img.complete && img.naturalWidth > 0) img.classList.add('in')
  else img.addEventListener('load', () => img.classList.add('in'), { once: true })
}

for (const el of Array.from(document.querySelectorAll('[data-words]')) as HTMLElement[]) {
  const words = (el.getAttribute('data-words') || '').split('|')
  let i = 0
  const t = window.setInterval(() => {
    if (i >= words.length - 1) {
      window.clearInterval(t)
      return
    }
    i++
    el.textContent = words[i]
    el.classList.remove('lw')
    void el.offsetWidth
    el.classList.add('lw')
  }, 2400)
}
