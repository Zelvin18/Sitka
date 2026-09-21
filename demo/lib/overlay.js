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
      #__demo .cur{position:absolute;left:0;top:0;width:13px;height:19px;transform:translate(${x}px,${y}px);filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.45));will-change:transform}
      #__demo .rip{position:absolute;width:26px;height:26px;border-radius:50%;background:rgba(20,20,22,.22);transform:translate(-50%,-50%) scale(.3);opacity:0;pointer-events:none}
      #__demo .rip.go{animation:__rip .42s ease-out}
      @keyframes __rip{0%{transform:translate(-50%,-50%) scale(.3);opacity:.9}100%{transform:translate(-50%,-50%) scale(1.4);opacity:0}}
      #__demo .cap{position:absolute;left:50%;bottom:6%;transform:translateX(-50%) translateY(12px);max-width:78%;padding:12px 22px;border-radius:14px;background:rgba(20,20,22,.82);color:#fff;font:600 24px/1.3 Inter,'Segoe UI',system-ui,sans-serif;letter-spacing:-.01em;text-align:center;opacity:0;transition:opacity .28s ease,transform .28s ease;backdrop-filter:blur(10px);box-shadow:0 12px 34px rgba(0,0,0,.35)}
      #__demo .cap.on{opacity:1;transform:translateX(-50%) translateY(0)}
      #__demo .chip{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.96);padding:14px 26px;border-radius:999px;background:rgba(20,20,22,.86);color:#fff;font:600 22px Inter,'Segoe UI',system-ui,sans-serif;opacity:0;transition:opacity .3s ease,transform .3s ease;box-shadow:0 12px 34px rgba(0,0,0,.35)}
      #__demo .chip.on{opacity:1;transform:translate(-50%,-50%) scale(1)}
      #__demo .fade{position:absolute;inset:0;background:#000;opacity:0;transition:opacity .35s ease}
      #__demo .fade.on{opacity:1}
    </style>
    <style>
      #__demo .gpop{position:absolute;left:50%;top:50%;width:520px;height:600px;transform:translate(-50%,-50%) scale(.98);border-radius:10px;overflow:hidden;background:#fff;box-shadow:0 30px 90px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.12);opacity:0;transition:opacity .2s ease,transform .2s ease;pointer-events:auto;display:none;flex-direction:column}
      #__demo .gpop.on{display:flex;opacity:1;transform:translate(-50%,-50%) scale(1)}
      #__demo .gpop .bar{height:38px;background:#f1f3f4;display:flex;align-items:center;gap:8px;padding:0 12px;font:12.5px 'Segoe UI',system-ui,sans-serif;color:#3c4043;border-bottom:1px solid #dadce0}
      #__demo .gpop .bar .lock{width:12px;height:12px;border-radius:3px;border:1.5px solid #5f6368;border-top-width:3px}
      #__demo .gpop .bar .x{margin-left:auto;font-size:16px;color:#5f6368}
      #__demo .gbody{flex:1;padding:30px 30px 10px;font-family:'Google Sans',Roboto,'Segoe UI',system-ui,sans-serif;color:#1f1f1f;display:flex;flex-direction:column;transition:opacity .25s}
      #__demo .gl{font-size:20px;font-weight:500;display:flex;align-items:center;gap:8px;color:#3c4043}
      #__demo .glm{width:20px;height:20px;border-radius:6px;background:#4a6cf7;display:inline-block}
      #__demo .gbody h1{font-size:24px;font-weight:400;margin:22px 0 6px}
      #__demo .gs{font-size:15px;color:#444746}
      #__demo .gs b{font-weight:500;color:#1f1f1f}
      #__demo .glist{margin-top:26px}
      #__demo .gacct{display:flex;align-items:center;gap:16px;padding:12px 8px;border-top:1px solid #e3e3e3;cursor:pointer;border-radius:8px}
      #__demo .gacct:hover{background:#f6f8fa}
      #__demo .gacct:last-child{border-bottom:1px solid #e3e3e3}
      #__demo .gav{width:36px;height:36px;border-radius:50%;background:#1e88e5;color:#fff;display:grid;place-items:center;font-weight:500;flex:none}
      #__demo .gav.o{background:#f0f4f9;border:1px solid #c4c7c5}
      #__demo .gt{display:flex;flex-direction:column;gap:2px}
      #__demo .gt b{font-weight:500;font-size:14px}
      #__demo .gt span{font-size:13.5px;color:#444746}
      #__demo .gfoot{margin-top:auto;display:flex;justify-content:space-between;font-size:12px;color:#444746;padding-top:20px}
    </style>
    <div class="fade"></div>
    <div class="gpop"><div class="bar"><span class="lock"></span><span>Sign in with your account</span><span class="x">✕</span></div><div class="gbody"><div class="gl"><span class="glm"></span>Accounts</div><h1>Choose an account</h1><div class="gs">to continue to <b>Sitca</b></div><div class="glist"><div class="gacct" id="daniel"><div class="gav">D</div><div class="gt"><b>Daniel Mwangi</b><span>daniel.mwangi@example.com</span></div></div><div class="gacct"><div class="gav o"><svg width="20" height="20" viewBox="0 0 24 24" fill="#444746"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-3.3 0-10 1.7-10 5v3h20v-3c0-3.3-6.7-5-10-5z"/></svg></div><div class="gt"><b>Use another account</b></div></div></div><div class="gfoot"><span>English (United States)</span><span>Help · Privacy · Terms</span></div></div></div>
    <div class="cap"></div>
    <div class="chip"></div>
    <svg class="cur" viewBox="0 0 22 30"><path d="M2 2l6 21 3.6-6.9L19 21.4z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`
  const attach = () => {
    if (!root.isConnected) (document.body || document.documentElement).appendChild(root)
  }
  attach()
  new MutationObserver(attach).observe(document.documentElement, { childList: true })
  root.querySelector('#daniel').addEventListener('click', () => {
    root.querySelector('.gbody').style.opacity = '0.4'
    setTimeout(() => window.postMessage('sitca-demo:chosen', '*'), 300)
  })
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
      r.style.left = x + 1 + 'px'
      r.style.top = y + 1 + 'px'
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
    popup(on) {
      const g = root.querySelector('.gpop')
      if (!on) {
        g.classList.remove('on')
        return
      }
      g.querySelector('.gbody').style.opacity = ''
      requestAnimationFrame(() => g.classList.add('on'))
    },
    hide(on) {
      cur.style.display = on ? 'none' : ''
    }
  }
})()
