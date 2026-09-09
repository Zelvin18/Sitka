/**
 * "How Sitka works" — a one-minute animated walkthrough built from the app's
 * own interface, so it always matches the real product. Framework-free DOM +
 * CSS animations: the renderer mounts it inside a modal, the landing page
 * mounts it in a section. Monochrome, no images, nothing to download.
 */

export interface TourOptions {
  /** called by Skip and by the final "Start using Sitka" button */
  onDone?: () => void
  /** label for the final call to action (omit to hide it) */
  doneLabel?: string
  autoplay?: boolean
}

interface Scene {
  caption: string
  /** seconds; Infinity holds until the viewer acts */
  duration: number
  build: (stage: HTMLElement) => void
}

const STYLE_ID = 'sitka-tour-css'

const CSS = `
.tour{--tb:var(--bg,#fff);--tt:var(--text,#1a1a1c);--t2x:var(--text-2,var(--t2,#62626a));--t3x:var(--text-3,var(--t3,#9c9ca3));--tsoft:var(--bg-soft,var(--soft,#f6f6f4));--tsofter:var(--bg-softer,var(--softer,#eeeeec));--tbd:var(--border,#e6e6e3);--tdanger:var(--danger,#c8443a);
  font-family:'Inter',-apple-system,'Segoe UI',Roboto,sans-serif;color:var(--tt);width:100%;max-width:100%;user-select:none;-webkit-user-select:none}
.tour *{box-sizing:border-box}
.tour-stage{position:relative;width:100%;aspect-ratio:16/10;overflow:hidden;border:1px solid var(--tbd);border-radius:16px;background:var(--tsoft);container-type:inline-size;font-size:clamp(8px,1.85cqw,14px);line-height:1.45}
.tour.paused .tour-stage *{animation-play-state:paused!important}
.tour-caption{min-height:2.6em;margin:14px 2px 8px;font-size:15px;font-weight:600;letter-spacing:-.01em;color:var(--tt);animation:tIn .45s both}
.tour-bar{display:flex;align-items:center;gap:12px}
.tour-play{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;border:1px solid var(--tbd);background:var(--tb);color:var(--tt);cursor:pointer;flex:none}
.tour-play svg{width:14px;height:14px;display:block}
.tour-dots{display:flex;gap:6px;flex:1;align-items:center}
.tour-dot{flex:1;height:4px;border-radius:2px;background:var(--tbd);position:relative;overflow:hidden;cursor:pointer}
.tour-dot.done::after,.tour-dot.now::after{content:'';position:absolute;inset:0;background:var(--tt);transform-origin:left;transform:scaleX(1)}
.tour-dot.now::after{animation:tFill var(--dur,8s) linear both}
.tour.paused .tour-dot.now::after{animation-play-state:paused}
.tour-skip{font:inherit;font-size:13px;font-weight:600;color:var(--t3x);background:none;border:none;cursor:pointer;padding:6px 2px}
.tour-skip:hover{color:var(--tt)}
@keyframes tFill{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes tIn{from{opacity:0;transform:translateY(.5em)}to{opacity:1;transform:none}}
@keyframes tPop{0%{opacity:0;transform:scale(.92)}60%{transform:scale(1.03)}100%{opacity:1;transform:none}}
@keyframes tType{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
@keyframes tSelect{to{border-color:var(--tt);background:var(--tb);box-shadow:0 0 0 .18em var(--tsofter)}}
@keyframes tPress{0%,100%{transform:none}40%{transform:scale(.94)}}
@keyframes tBlink{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes tBars{0%,100%{transform:scaleY(.25)}50%{transform:scaleY(1)}}
@keyframes tOrbit{to{transform:rotate(360deg)}}
@keyframes tSwap{0%{opacity:1}45%{opacity:0;transform:translateY(-.3em)}55%{opacity:0;transform:translateY(.3em)}100%{opacity:1;transform:none}}
@keyframes tDots{0%,80%,100%{opacity:.2}40%{opacity:1}}
.t-in{animation:tIn .5s both}
.t-pop{animation:tPop .5s both}
.t-type{animation:tType 1.3s steps(36) both}
.t-hide{opacity:0}
.t-win{position:absolute;inset:6%;background:var(--tb);border:1px solid var(--tbd);border-radius:1em;box-shadow:0 1.2em 3em rgba(0,0,0,.08);overflow:hidden;display:flex;flex-direction:column}
.t-top{display:flex;align-items:center;gap:.6em;padding:.7em 1.1em;border-bottom:1px solid var(--tbd);font-weight:750;font-size:1.05em}
.t-top .t-mark{width:1.3em;height:1.3em}
.t-mark{display:block;flex:none}
.t-mark.live circle:last-child{transform-box:view-box;transform-origin:32px 32px;animation:tOrbit 1.6s linear infinite}
.t-body{flex:1;min-height:0;display:flex}
.t-rec{margin-left:auto;display:inline-flex;align-items:center;gap:.4em;font-size:.78em;font-weight:750;letter-spacing:.04em;color:var(--tdanger);background:color-mix(in srgb,var(--tdanger) 12%,transparent);padding:.25em .8em;border-radius:2em}
.t-rec i{width:.55em;height:.55em;border-radius:50%;background:currentColor;animation:tBlink 1.2s infinite}
.t-setup{flex:1;padding:1.6em 2.2em;display:flex;flex-direction:column;gap:1.2em;max-width:34em;margin:0 auto}
.t-h{font-size:1.7em;font-weight:800;letter-spacing:-.03em}
.t-sub{color:var(--t2x);font-size:.95em;margin-top:-.6em}
.t-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:.7em}
.t-tile{border:1px solid var(--tbd);border-radius:.9em;padding:.9em .9em .8em;background:var(--tsoft);display:flex;flex-direction:column;gap:.35em}
.t-tile svg{width:1.35em;height:1.35em}
.t-tile b{font-size:.95em;font-weight:700}
.t-tile span{font-size:.78em;color:var(--t2x);line-height:1.35}
.t-tile.sel{animation:tSelect .4s both}
.t-btn{align-self:flex-start;background:var(--tt);color:var(--tb);font-weight:700;padding:.75em 1.6em;border-radius:.8em;font-size:1em}
.t-btn.press{animation:tPress .5s both}
.t-cols{flex:1;display:grid;grid-template-columns:1.15fr .85fr;min-height:0}
.t-left{border-right:1px solid var(--tbd);display:flex;flex-direction:column;min-height:0}
.t-right{display:flex;flex-direction:column;min-height:0}
.t-tabs{display:flex;gap:.4em;padding:.9em 1.2em .5em}
.t-tab{font-size:.85em;font-weight:650;padding:.35em .9em;border-radius:2em;color:var(--t2x)}
.t-tab.on{background:var(--tsofter);color:var(--tt)}
.t-lines{padding:.4em 1.4em;display:flex;flex-direction:column;gap:.7em;overflow:hidden}
.t-line{display:grid;grid-template-columns:2.6em 1fr;gap:.6em;font-size:.95em}
.t-line .t-t{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.78em;color:var(--t3x);padding-top:.25em}
.t-line .t-x{color:var(--tt)}
.t-line.dim .t-x{color:var(--t2x)}
.t-tag{display:inline-flex;align-items:center;gap:.35em;font-size:.72em;font-weight:750;letter-spacing:.05em;color:var(--t2x);border:1px solid var(--tbd);border-radius:.5em;padding:.15em .55em;margin-right:.5em;vertical-align:middle}
.t-listen{margin-top:auto;padding:.8em 1.4em 1em;display:flex;align-items:center;gap:.7em;color:var(--t3x);font-size:.85em}
.t-bars{display:flex;gap:.18em;align-items:center;height:1.2em}
.t-bars i{width:.22em;height:100%;border-radius:.1em;background:var(--tt);opacity:.6;transform-origin:center;animation:tBars 1s ease-in-out infinite}
.t-chead{display:flex;align-items:center;gap:.5em;padding:.9em 1.2em;border-bottom:1px solid var(--tbd);font-weight:650;font-size:.95em}
.t-chead svg{width:1em;height:1em}
.t-live{margin-left:auto;font-size:.7em;font-weight:750;letter-spacing:.05em;color:var(--tdanger);background:color-mix(in srgb,var(--tdanger) 12%,transparent);padding:.25em .7em;border-radius:2em}
.t-chat{flex:1;padding:1em 1.2em;display:flex;flex-direction:column;gap:.9em;overflow:hidden;font-size:.92em}
.t-empty{margin:auto;text-align:center;color:var(--t3x);font-size:.9em;max-width:14em}
.t-empty b{display:block;color:var(--tt);font-weight:700;margin-bottom:.3em}
.t-user{align-self:flex-end;background:var(--tsofter);padding:.6em .9em;border-radius:1em;max-width:85%}
.t-ai{line-height:1.5}
.t-ai b{font-weight:700}
.t-chip{display:inline-flex;align-items:center;gap:.3em;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.78em;font-weight:650;border:1px solid var(--tbd);background:var(--tsoft);padding:.1em .5em;border-radius:.5em;vertical-align:middle;margin-left:.2em}
.t-chip svg{width:.7em;height:.7em}
.t-dots{display:inline-flex;align-items:center;gap:.5em;color:var(--t3x);font-size:.9em}
.t-dots i{width:.4em;height:.4em;border-radius:50%;background:var(--t3x);animation:tDots 1.2s infinite}
.t-dots i:nth-child(2){animation-delay:.2s}.t-dots i:nth-child(3){animation-delay:.4s}
.t-note{border:1px solid var(--tbd);background:var(--tsoft);border-radius:.9em;padding:.7em .9em;font-size:.95em;line-height:1.45}
.t-note small{display:flex;align-items:center;gap:.4em;font-size:.72em;font-weight:750;letter-spacing:.06em;text-transform:uppercase;color:var(--t3x);margin-bottom:.3em}
.t-note small svg{width:1em;height:1em}
.t-input{margin:auto 1.2em 1em;border:1px solid var(--tbd);border-radius:1em;padding:.7em .9em;color:var(--t3x);font-size:.9em;display:flex;align-items:center}
.t-input i{margin-left:auto;width:1.6em;height:1.6em;border-radius:50%;background:var(--tsofter)}
.t-board{margin:1em 1.4em 0;aspect-ratio:16/8;border-radius:.7em;background:#1b1b1e;color:#f1f1f3;display:flex;align-items:center;justify-content:center;font-size:1.25em;font-style:italic;font-family:'Cambria Math','STIX Two Math','Times New Roman',serif;letter-spacing:.01em;position:relative;overflow:hidden}
.t-board::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 30% 20%,rgba(255,255,255,.08),transparent 60%)}
.t-board .t-eye{position:absolute;right:.7em;top:.6em;display:inline-flex;align-items:center;gap:.4em;font:650 .55em 'Inter',sans-serif;font-style:normal;letter-spacing:.06em;color:#f1f1f3;background:rgba(255,255,255,.14);padding:.3em .7em;border-radius:2em}
.t-board .t-eye svg{width:1.4em;height:1.4em}
.t-session{flex:1;padding:1.6em 2em;display:flex;flex-direction:column;gap:1em;max-width:36em;margin:0 auto;width:100%}
.t-title{font-size:1.6em;font-weight:800;letter-spacing:-.03em;position:relative;min-height:1.3em}
.t-title span{position:absolute;left:0;top:0;white-space:nowrap}
.t-title .old{animation:tSwap 1.1s both;animation-delay:1.4s}
.t-title .new{opacity:0;animation:tIn .5s both;animation-delay:1.95s}
.t-meta{display:flex;gap:.6em;align-items:center;color:var(--t3x);font-size:.85em}
.t-pill{border:1px solid var(--tbd);border-radius:2em;padding:.15em .7em;font-weight:650;color:var(--t2x)}
.t-sum{font-size:.98em;line-height:1.55;color:var(--tt)}
.t-hl{display:flex;flex-wrap:wrap;gap:.5em}
.t-hl span{display:inline-flex;align-items:center;gap:.4em;border:1px solid var(--tbd);background:var(--tsoft);padding:.35em .8em;border-radius:2em;font-size:.85em;font-weight:600}
.t-hl span i{font-family:ui-monospace,Menlo,Consolas,monospace;font-style:normal;color:var(--t3x);font-size:.85em}
.t-search{margin-top:auto;border:1px solid var(--tbd);border-radius:1em;padding:.8em 1em;display:flex;align-items:center;gap:.6em;font-size:.95em;background:var(--tb)}
.t-search svg{width:1em;height:1em;color:var(--t3x)}
.t-search .q{color:var(--tt)}
.t-search .ph{color:var(--t3x)}
.t-end{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1em;text-align:center;padding:2em}
.t-end .t-mark{width:4.2em;height:4.2em}
.t-end h3{font-size:1.9em;font-weight:800;letter-spacing:-.03em;margin:0}
.t-end p{color:var(--t2x);font-size:1em;max-width:26em;margin:0}
.t-end-btns{display:flex;gap:.7em;margin-top:.4em}
.t-end-btns button{font:inherit;font-size:1em;font-weight:650;padding:.7em 1.4em;border-radius:.8em;border:1px solid var(--tbd);background:var(--tb);color:var(--tt);cursor:pointer}
.t-end-btns button.pri{background:var(--tt);color:var(--tb);border-color:var(--tt)}
@media(prefers-reduced-motion:reduce){.tour-stage *{animation-duration:.01s!important;animation-delay:0s!important}}
`

const MARK =
  '<svg class="t-mark" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true"><circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" stroke-width="9"/><circle cx="46.1" cy="17.9" r="9"/></svg>'
const ICON = {
  screen:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  camera:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="M15.5 10.5 21 7.5v9l-5.5-3z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4"/></svg>',
  sparkle:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M6.5 17.5 9 15M15 9l2.5-2.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/></svg>'
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const s = document.createElement('style')
  s.id = STYLE_ID
  s.textContent = CSS
  document.head.appendChild(s)
}

function el(tag: string, cls?: string, html?: string): HTMLElement {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (html !== undefined) n.innerHTML = html
  return n
}

/** entrance animation after `s` seconds */
function at<T extends HTMLElement>(node: T, s: number, cls = 't-in'): T {
  node.classList.add(cls)
  node.style.animationDelay = `${s}s`
  return node
}

function win(stage: HTMLElement, rec = false): HTMLElement {
  const w = el('div', 't-win')
  const top = el('div', 't-top', `${MARK}<span>Sitka</span>`)
  if (rec) top.appendChild(at(el('span', 't-rec', '<i></i>REC'), 0.2, 't-pop'))
  w.appendChild(top)
  const body = el('div', 't-body')
  w.appendChild(body)
  stage.appendChild(w)
  return body
}

function chatHeader(live: boolean): HTMLElement {
  return el('div', 't-chead', `${ICON.sparkle}<span>Ask Sitka</span>${live ? '<span class="t-live">● LIVE</span>' : ''}`)
}

function line(time: string, text: string, s: number, dim = false, type = true): HTMLElement {
  const row = el('div', `t-line${dim ? ' dim' : ''}`)
  row.appendChild(el('span', 't-t', time))
  const x = el('span', 't-x', text)
  row.appendChild(x)
  at(row, s)
  if (type) at(x, s, 't-type')
  return row
}

// ---------------- scenes ----------------

const LECTURE = [
  ['0:05', 'Today we look at how to differentiate a function.'],
  ['0:12', 'Take y equals three x squared plus four.'],
  ['0:20', 'The power rule says: bring the exponent down, then reduce it by one.'],
  ['0:31', 'So the derivative is six x. The constant disappears.'],
  ['0:44', 'Now let us try a harder one, with a chain rule.']
]

const SCENES: Scene[] = [
  {
    caption: 'Start a session. Sitka can watch a shared screen, the camera pointed at the board, or just listen.',
    duration: 8,
    build(stage) {
      const body = win(stage)
      const s = el('div', 't-setup')
      s.appendChild(at(el('div', 't-h', 'Attend a lecture'), 0.1))
      s.appendChild(at(el('div', 't-sub', 'What should Sitka watch?'), 0.25))
      const tiles = el('div', 't-tiles')
      const defs: [string, string, string][] = [
        [ICON.screen, 'Screen + audio', 'Slides, a call, a video — with the sound.'],
        [ICON.camera, 'Camera + audio', 'Point it at the board or the projector.'],
        [ICON.mic, 'Audio only', 'Just listen — in person, quick and simple.']
      ]
      defs.forEach(([icon, title, desc], i) => {
        const t = el('div', 't-tile', `${icon}<b>${title}</b><span>${desc}</span>`)
        at(t, 0.4 + i * 0.15)
        if (i === 0) {
          t.style.animationName = 'tIn, tSelect'
          t.style.animationDuration = '.5s, .4s'
          t.style.animationDelay = '0.4s, 2.2s'
          t.style.animationFillMode = 'both, both'
        }
        tiles.appendChild(t)
      })
      s.appendChild(tiles)
      const b = el('div', 't-btn', 'Start')
      b.style.animationName = 'tIn, tPress'
      b.style.animationDuration = '.5s, .5s'
      b.style.animationDelay = '0.9s, 4.6s'
      b.style.animationFillMode = 'both, both'
      s.appendChild(b)
      body.appendChild(s)
      const rec = el('span', 't-rec', '<i></i>REC')
      rec.style.position = 'absolute'
      rec.style.right = '1.1em'
      rec.style.top = '.55em'
      at(rec, 5.4, 't-pop')
      body.parentElement!.appendChild(rec)
    }
  },
  {
    caption: 'Sitka listens and writes everything down, with the time it was said.',
    duration: 10,
    build(stage) {
      const body = win(stage, true)
      const cols = el('div', 't-cols')
      const left = el('div', 't-left')
      left.appendChild(
        el('div', 't-tabs', '<span class="t-tab on">Transcript</span><span class="t-tab">Notes</span><span class="t-tab">Materials</span>')
      )
      const lines = el('div', 't-lines')
      LECTURE.forEach(([t, x], i) => lines.appendChild(line(t, x, 0.6 + i * 1.8)))
      left.appendChild(lines)
      const listen = el('div', 't-listen', '<span class="t-bars"><i></i><i></i><i></i><i></i><i></i></span>Listening')
      listen.querySelectorAll('i').forEach((b, i) => ((b as HTMLElement).style.animationDelay = `${i * 0.12}s`))
      left.appendChild(listen)
      const right = el('div', 't-right')
      right.appendChild(chatHeader(true))
      const chat = el('div', 't-chat')
      chat.appendChild(
        at(el('div', 't-empty', '<b>Sitka is listening with you</b>Ask anything about what is being said or shown.'), 0.8)
      )
      right.appendChild(chat)
      right.appendChild(el('div', 't-input', 'Ask about this session…<i></i>'))
      cols.append(left, right)
      body.appendChild(cols)
    }
  },
  {
    caption: 'It reads what is on the screen too: slides, the whiteboard, charts and tables.',
    duration: 10,
    build(stage) {
      const body = win(stage, true)
      const cols = el('div', 't-cols')
      const left = el('div', 't-left')
      const board = el('div', 't-board', 'Find dy/dx for y = 3x² + 4')
      const eye = el('span', 't-eye', `${ICON.eye}READING`)
      at(eye, 2.4, 't-pop')
      board.appendChild(eye)
      left.appendChild(at(board, 0.2))
      left.appendChild(
        el('div', 't-tabs', '<span class="t-tab on">Transcript</span><span class="t-tab">Notes · 2</span><span class="t-tab">Materials</span>')
      )
      const lines = el('div', 't-lines')
      lines.appendChild(line('0:31', 'So the derivative is six x. The constant disappears.', 0.4, true, false))
      const screen = line('0:38', '', 4.2, true, false)
      screen.querySelector('.t-x')!.innerHTML =
        '<span class="t-tag">ON SCREEN</span>Whiteboard: "Find dy/dx for y = 3x² + 4". A worked example of the power rule is about to be written underneath.'
      at(screen.querySelector('.t-x') as HTMLElement, 4.2, 't-type')
      lines.appendChild(screen)
      lines.appendChild(line('0:44', 'Now let us try a harder one, with a chain rule.', 7.2, true))
      left.appendChild(lines)
      const right = el('div', 't-right')
      right.appendChild(chatHeader(true))
      const chat = el('div', 't-chat')
      chat.appendChild(
        at(el('div', 't-empty', '<b>Sitka is listening with you</b>Ask anything about what is being said or shown.'), 0.6)
      )
      right.appendChild(chat)
      right.appendChild(el('div', 't-input', 'Ask about this session…<i></i>'))
      cols.append(left, right)
      body.appendChild(cols)
    }
  },
  {
    caption: 'Ask anything, any time. Every answer points to the exact moment it came from.',
    duration: 12,
    build(stage) {
      const body = win(stage, true)
      const cols = el('div', 't-cols')
      cols.style.gridTemplateColumns = '.8fr 1.2fr'
      const left = el('div', 't-left')
      left.appendChild(at(el('div', 't-board', 'Find dy/dx for y = 3x² + 4'), 0.1))
      left.appendChild(el('div', 't-tabs', '<span class="t-tab on">Transcript</span><span class="t-tab">Notes · 3</span>'))
      const lines = el('div', 't-lines')
      lines.appendChild(line('0:44', 'Now let us try a harder one, with a chain rule.', 0.2, true, false))
      lines.appendChild(line('0:52', 'Take y equals e to the power of two x.', 5.5, true))
      left.appendChild(lines)
      const right = el('div', 't-right')
      right.appendChild(chatHeader(true))
      const chat = el('div', 't-chat')
      chat.appendChild(at(el('div', 't-user', 'what function is on the board?'), 0.6, 't-pop'))
      const thinking = el('div', 't-dots', `${MARK.replace('t-mark', 't-mark live')}Reading the screen <i></i><i></i><i></i>`)
      ;(thinking.querySelector('.t-mark') as HTMLElement).style.width = '1.1em'
      ;(thinking.querySelector('.t-mark') as HTMLElement).style.height = '1.1em'
      thinking.style.animationName = 'tIn, tIn'
      thinking.style.animationDuration = '.4s, .4s'
      thinking.style.animationDelay = '1.6s, 3.4s'
      thinking.style.animationDirection = 'normal, reverse'
      thinking.style.animationFillMode = 'both, both'
      chat.appendChild(thinking)
      const ai = el(
        'div',
        't-ai',
        'The board shows <b>y = 3x² + 4</b> and asks for dy/dx. Using the power rule he explained, <b>dy/dx = 6x</b> — the constant 4 disappears.'
      )
      at(ai, 3.8)
      const inner = ai.innerHTML
      ai.innerHTML = `<span class="t-type" style="animation-delay:3.8s;animation-duration:2.2s">${inner}</span>`
      const chip = el('span', 't-chip', `${ICON.play} 0:20`)
      at(chip, 6.0, 't-pop')
      ai.appendChild(chip)
      chat.appendChild(ai)
      const note = el(
        'div',
        't-note',
        `<small>${ICON.sparkle}Sitka noticed</small>He has moved on to the chain rule — that is the method the next example needs.`
      )
      at(note, 8.6, 't-pop')
      chat.appendChild(note)
      right.appendChild(chat)
      right.appendChild(el('div', 't-input', 'Ask about this session…<i></i>'))
      cols.append(left, right)
      body.appendChild(cols)
    }
  },
  {
    caption: 'When it ends, Sitka names it, summarises it, and remembers every moment for you.',
    duration: 11,
    build(stage) {
      const body = win(stage)
      const s = el('div', 't-session')
      const title = el(
        'div',
        't-title',
        '<span class="old">Session — Sep 9, 8:44 AM</span><span class="new">Basic differentiation rules</span>'
      )
      s.appendChild(title)
      s.appendChild(at(el('div', 't-meta', '<span>Today at 8:44 AM</span><span class="t-pill">23 min</span>'), 0.3))
      const sum = el(
        'div',
        't-sum',
        'A walkthrough of the power rule with worked examples, then the chain rule for exponential functions such as e^(2x). The session closes with a logarithmic example rewritten as a difference of logs.'
      )
      at(sum, 2.6)
      sum.innerHTML = `<span class="t-type" style="animation-delay:2.6s;animation-duration:2.4s">${sum.innerHTML}</span>`
      s.appendChild(sum)
      const hl = el('div', 't-hl')
      ;[
        ['0:20', 'Power rule'],
        ['4:11', 'Worked example'],
        ['7:25', 'Chain rule'],
        ['18:30', 'Logarithms']
      ].forEach(([t, l], i) => hl.appendChild(at(el('span', '', `<i>${t}</i>${l}`), 5.2 + i * 0.25, 't-pop')))
      s.appendChild(hl)
      const search = el('div', 't-search', `${ICON.search}<span class="ph">Ask across everything…</span>`)
      at(search, 7.0)
      const q = el('span', 'q t-type', 'where did we cover the chain rule?')
      q.style.animationDelay = '8s'
      q.style.animationDuration = '1.6s'
      search.appendChild(q)
      ;(search.querySelector('.ph') as HTMLElement).style.animation = 'tIn .3s reverse both'
      ;(search.querySelector('.ph') as HTMLElement).style.animationDelay = '8s'
      s.appendChild(search)
      body.appendChild(s)
    }
  }
]

export function mountTour(root: HTMLElement, opts: TourOptions = {}): () => void {
  ensureStyles()
  root.innerHTML = ''
  const tour = el('div', 'tour')
  const stage = el('div', 'tour-stage')
  const caption = el('div', 'tour-caption')
  const bar = el('div', 'tour-bar')
  const play = el('button', 'tour-play', ICON.pause)
  play.setAttribute('aria-label', 'Pause')
  const dots = el('div', 'tour-dots')
  const dotEls = SCENES.map((_, i) => {
    const d = el('div', 'tour-dot')
    d.addEventListener('click', () => go(i))
    dots.appendChild(d)
    return d
  })
  bar.append(play, dots)
  if (opts.onDone) {
    const skip = el('button', 'tour-skip', 'Skip')
    skip.addEventListener('click', () => opts.onDone?.())
    bar.appendChild(skip)
  }
  tour.append(stage, caption, bar)
  root.appendChild(tour)

  let index = -1
  let timer: ReturnType<typeof setTimeout> | null = null
  let startedAt = 0
  let remaining = 0
  let paused = !(opts.autoplay ?? true)
  let disposed = false

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const arm = (ms: number): void => {
    clearTimer()
    if (!Number.isFinite(ms)) return
    startedAt = Date.now()
    remaining = ms
    timer = setTimeout(() => go(index + 1), ms)
  }

  function showEnd(): void {
    stage.innerHTML = ''
    caption.textContent = ''
    dotEls.forEach((d) => d.classList.remove('now'))
    dotEls.forEach((d) => d.classList.add('done'))
    const end = el('div', 't-end')
    end.innerHTML = `${MARK.replace('t-mark', 't-mark live')}<h3>Ready when you are.</h3><p>Start a session the next time you are in a lecture, a meeting or a talk. Sitka does the rest.</p>`
    const btns = el('div', 't-end-btns')
    const replay = el('button', '', 'Watch again')
    replay.addEventListener('click', () => go(0))
    btns.appendChild(replay)
    if (opts.onDone && opts.doneLabel) {
      const done = el('button', 'pri', opts.doneLabel)
      done.addEventListener('click', () => opts.onDone?.())
      btns.appendChild(done)
    }
    end.appendChild(btns)
    stage.appendChild(at(end, 0.1, 't-pop'))
  }

  function go(i: number): void {
    if (disposed) return
    clearTimer()
    if (i >= SCENES.length) {
      index = SCENES.length
      showEnd()
      return
    }
    index = i
    const scene = SCENES[i]
    stage.innerHTML = ''
    scene.build(stage)
    caption.textContent = scene.caption
    caption.style.animation = 'none'
    void caption.offsetWidth
    caption.style.animation = ''
    dotEls.forEach((d, j) => {
      d.classList.toggle('done', j < i)
      d.classList.toggle('now', j === i)
      d.style.setProperty('--dur', `${scene.duration}s`)
    })
    if (paused) {
      remaining = scene.duration * 1000
      tour.classList.add('paused')
    } else {
      arm(scene.duration * 1000)
    }
  }

  function setPaused(p: boolean): void {
    paused = p
    tour.classList.toggle('paused', p)
    play.innerHTML = p ? ICON.play : ICON.pause
    play.setAttribute('aria-label', p ? 'Play' : 'Pause')
    if (p) {
      if (timer) remaining = Math.max(0, remaining - (Date.now() - startedAt))
      clearTimer()
    } else if (index >= 0 && index < SCENES.length) {
      arm(remaining)
    } else if (index === -1) {
      go(0)
    }
  }
  play.addEventListener('click', () => setPaused(!paused))
  stage.addEventListener('click', () => setPaused(!paused))
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === ' ' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault()
      setPaused(!paused)
    }
  }
  const onVisibility = (): void => {
    if (document.hidden && !paused) setPaused(true)
  }
  document.addEventListener('keydown', onKey)
  document.addEventListener('visibilitychange', onVisibility)

  if (paused) {
    play.innerHTML = ICON.play
    go(0)
  } else {
    go(0)
  }

  return () => {
    disposed = true
    clearTimer()
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('visibilitychange', onVisibility)
    root.innerHTML = ''
  }
}
