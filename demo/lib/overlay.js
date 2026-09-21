// Injected into every page the recorder opens. Draws the pointer (Playwright's
// video has none), a press ripple, and the caption strip the finished video
// carries. The pointer's place survives navigations through sessionStorage,
// so it never jumps between scenes.
;(() => {
  if (window.__demo) return
  const S = 'demo.cursor'
  let x = 720
  let y = 450
  try {
    const p = JSON.parse(sessionStorage.getItem(S) || 'null')
    if (p) ({ x, y } = p)
  } catch {
    /* fresh */
  }
  const root = document.createElement('div')
  root.id = '__demo'
  root.setAttribute('style', 'position:fixed;inset:0;pointer-events:none;z-index:2147483647')
  root.innerHTML = `
    <style>
      #__demo .cur{position:absolute;left:0;top:0;width:22px;height:30px;transform:translate(${x}px,${y}px);filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.45));will-change:transform}
      #__demo .rip{position:absolute;width:34px;height:34px;border-radius:50%;background:rgba(20,20,22,.22);transform:translate(-50%,-50%) scale(.3);opacity:0;pointer-events:none}
      #__demo .rip.go{animation:__rip .42s ease-out}
      @keyframes __rip{0%{transform:translate(-50%,-50%) scale(.3);opacity:.9}100%{transform:translate(-50%,-50%) scale(1.4);opacity:0}}
      #__demo .cap{position:absolute;left:50%;bottom:6%;transform:translateX(-50%) translateY(12px);max-width:78%;padding:12px 22px;border-radius:14px;background:rgba(20,20,22,.82);color:#fff;font:600 24px/1.3 Inter,'Segoe UI',system-ui,sans-serif;letter-spacing:-.01em;text-align:center;opacity:0;transition:opacity .28s ease,transform .28s ease;backdrop-filter:blur(10px);box-shadow:0 12px 34px rgba(0,0,0,.35)}
      #__demo .cap.on{opacity:1;transform:translateX(-50%) translateY(0)}
      #__demo .chip{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.96);padding:14px 26px;border-radius:999px;background:rgba(20,20,22,.86);color:#fff;font:600 22px Inter,'Segoe UI',system-ui,sans-serif;opacity:0;transition:opacity .3s ease,transform .3s ease;box-shadow:0 12px 34px rgba(0,0,0,.35)}
      #__demo .chip.on{opacity:1;transform:translate(-50%,-50%) scale(1)}
      #__demo .fade{position:absolute;inset:0;background:#000;opacity:0;transition:opacity .35s ease}
      #__demo .fade.on{opacity:1}
    </style>
    <div class="fade"></div>
    <div class="cap"></div>
    <div class="chip"></div>
    <svg class="cur" viewBox="0 0 22 30"><path d="M2 2l6 21 3.6-6.9L19 21.4z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`
  const attach = () => {
    if (!root.isConnected) (document.body || document.documentElement).appendChild(root)
  }
  attach()
  new MutationObserver(attach).observe(document.documentElement, { childList: true })
  const cur = root.querySelector('.cur')
  const cap = root.querySelector('.cap')
  const chip = root.querySelector('.chip')
  const fade = root.querySelector('.fade')
  const save = () => sessionStorage.setItem(S, JSON.stringify({ x, y }))
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  window.__demo = {
    at: () => ({ x, y }),
    // a glide with a slight arc, the way a hand moves a mouse
    move(tx, ty, ms) {
      return new Promise((resolve) => {
        const sx = x
        const sy = y
        const dx = tx - sx
        const dy = ty - sy
        const bend = Math.min(40, Math.hypot(dx, dy) * 0.12) * (Math.random() < 0.5 ? -1 : 1)
        const t0 = performance.now()
        const step = (now) => {
          const t = Math.min(1, (now - t0) / ms)
          const e = ease(t)
          const arc = Math.sin(Math.PI * t) * bend
          x = sx + dx * e - (dy / (Math.hypot(dx, dy) || 1)) * arc
          y = sy + dy * e + (dx / (Math.hypot(dx, dy) || 1)) * arc
          cur.style.transform = `translate(${x}px,${y}px)`
          if (t < 1) requestAnimationFrame(step)
          else {
            x = tx
            y = ty
            cur.style.transform = `translate(${x}px,${y}px)`
            save()
            resolve()
          }
        }
        requestAnimationFrame(step)
      })
    },
    press() {
      const r = document.createElement('div')
      r.className = 'rip go'
      r.style.left = x + 2 + 'px'
      r.style.top = y + 2 + 'px'
      root.appendChild(r)
      cur.style.transform = `translate(${x}px,${y}px) scale(.9)`
      setTimeout(() => (cur.style.transform = `translate(${x}px,${y}px)`), 90)
      setTimeout(() => r.remove(), 500)
    },
    caption(text) {
      if (!text) {
        cap.classList.remove('on')
        return
      }
      cap.textContent = text
      cap.classList.add('on')
    },
    chip(text) {
      if (!text) {
        chip.classList.remove('on')
        return
      }
      chip.textContent = text
      chip.classList.add('on')
    },
    fade(on) {
      fade.classList.toggle('on', Boolean(on))
    },
    hide(on) {
      cur.style.display = on ? 'none' : ''
    }
  }
})()
