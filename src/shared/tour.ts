/**
 * "How Sitka works" — a guided walkthrough built from the app's own interface,
 * so it always matches the real product. It follows the exact path a new user
 * takes: Home → set up → listen → see → ask → end → remember. A pointer moves
 * and clicks, text is typed, answers arrive word by word.
 *
 * Framework-free DOM + CSS animations, monochrome, no images. The renderer
 * mounts it inside a modal; the landing page mounts it in the hero.
 */

export interface TourOptions {
  /** called by Skip and by the final call to action */
  onDone?: () => void
  /** label for the final call to action (omit to hide it) */
  doneLabel?: string
  autoplay?: boolean
  /** show a Skip control in the bar (off when the host shows its own) */
  showSkip?: boolean
  /** loop back to the start after the outro (landing page) */
  loop?: boolean
}

type Chapter = 'Start' | 'Listen' | 'See' | 'Ask' | 'Remember'

interface Scene {
  chapter: Chapter
  caption: string
  /** seconds */
  duration: number
  build: (stage: HTMLElement) => void
}

const STYLE_ID = 'sitka-tour-css'
const CHAPTERS: Chapter[] = ['Start', 'Listen', 'See', 'Ask', 'Remember']

const CSS = `
.tour{--tb:var(--bg,#fff);--tt:var(--text,#1a1a1c);--t2x:var(--text-2,var(--t2,#62626a));--t3x:var(--text-3,var(--t3,#9c9ca3));--tsoft:var(--bg-soft,var(--soft,#f6f6f4));--tsofter:var(--bg-softer,var(--softer,#eeeeec));--tbd:var(--border,#e6e6e3);--tdanger:var(--danger,#c8443a);
  font-family:'Inter',-apple-system,'Segoe UI',Roboto,sans-serif;color:var(--tt);width:100%;max-width:100%;user-select:none;-webkit-user-select:none}
.tour *{box-sizing:border-box}
.tour-chapters{display:flex;gap:6px;margin:0 0 12px;flex-wrap:wrap}
.tour-ch{font:inherit;font-size:12px;font-weight:650;letter-spacing:.01em;color:var(--t3x);background:none;border:1px solid transparent;border-radius:20px;padding:5px 11px;cursor:pointer;transition:color .15s,background .15s}
.tour-ch:hover{color:var(--tt)}
.tour-ch.done{color:var(--t2x)}
.tour-ch.now{color:var(--tb);background:var(--tt)}
.tour-stage{position:relative;width:100%;aspect-ratio:16/10;overflow:hidden;border:1px solid var(--tbd);border-radius:16px;background:var(--tsoft);container-type:inline-size;font-size:clamp(8px,1.85cqw,14px);line-height:1.45;cursor:default}
.tour-stage::before{content:'';position:absolute;inset:0;background-image:radial-gradient(var(--tbd) 1px,transparent 1.2px);background-size:1.6em 1.6em;opacity:.5;pointer-events:none}
.tour.paused .tour-stage *{animation-play-state:paused!important}
.tour-caption{min-height:2.6em;margin:14px 2px 8px;font-size:15px;font-weight:600;letter-spacing:-.01em;color:var(--tt);animation:tIn .45s both}
.tour-bar{display:flex;align-items:center;gap:12px}
.tour-play{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;border:1px solid var(--tbd);background:var(--tb);color:var(--tt);cursor:pointer;flex:none}
.tour-play svg{width:14px;height:14px;display:block}
.tour-dots{display:flex;gap:5px;flex:1;align-items:center}
.tour-dot{flex:1;height:4px;border-radius:2px;background:var(--tbd);position:relative;overflow:hidden;cursor:pointer}
.tour-dot.done::after,.tour-dot.now::after{content:'';position:absolute;inset:0;background:var(--tt);transform-origin:left;transform:scaleX(1)}
.tour-dot.now::after{animation:tFill var(--dur,8s) linear both}
.tour.paused .tour-dot.now::after{animation-play-state:paused}
.tour-count{font-size:12px;font-weight:600;color:var(--t3x);font-variant-numeric:tabular-nums;flex:none}
.tour-skip{font:inherit;font-size:13px;font-weight:600;color:var(--t3x);background:none;border:none;cursor:pointer;padding:6px 2px}
.tour-skip:hover{color:var(--tt)}
@keyframes tFill{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes tIn{from{opacity:0;transform:translateY(.5em)}to{opacity:1;transform:none}}
@keyframes tFade{from{opacity:0}to{opacity:1}}
@keyframes tOut{to{opacity:0;visibility:hidden}}
@keyframes tPop{0%{opacity:0;transform:scale(.92)}60%{transform:scale(1.03)}100%{opacity:1;transform:none}}
@keyframes tWord{from{opacity:0;transform:translateY(.15em)}to{opacity:1;transform:none}}
@keyframes tChar{to{opacity:1}}
@keyframes tSelect{to{border-color:var(--tt);background:var(--tb);box-shadow:0 0 0 .18em var(--tsofter)}}
@keyframes tPress{0%,100%{transform:none}40%{transform:scale(.94)}}
@keyframes tBlink{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes tCaret{0%,100%{opacity:1}50%{opacity:0}}
@keyframes tBars{0%,100%{transform:scaleY(.25)}50%{transform:scaleY(1)}}
@keyframes tOrbit{to{transform:rotate(360deg)}}
@keyframes tDots{0%,80%,100%{opacity:.2}40%{opacity:1}}
@keyframes tRipple{0%{transform:scale(.2);opacity:.6}100%{transform:scale(1);opacity:0}}
@keyframes tFlash{0%{background:transparent}20%{background:var(--tsofter)}100%{background:transparent}}
@keyframes tCount{0%,49%{content:'1'}50%,100%{content:'2'}}
.t-scene{position:absolute;inset:0;animation:tFade .35s both}
.t-in{animation:tIn .5s both}
.t-pop{animation:tPop .5s both}
.t-w{display:inline-block;animation:tWord .3s both}
.t-c{opacity:0;animation:tChar .01s both}
.t-caret{display:inline-block;width:.08em;height:1.1em;background:var(--tt);vertical-align:-.15em;margin-left:.05em;animation:tCaret .9s steps(1) infinite}
.t-cur{position:absolute;left:0;top:0;width:1.4em;height:1.4em;z-index:5;pointer-events:none;filter:drop-shadow(0 .1em .2em rgba(0,0,0,.25));animation-timing-function:cubic-bezier(.4,0,.2,1)}
.t-cur svg{width:100%;height:100%;display:block}
.t-click{position:absolute;width:2.6em;height:2.6em;margin:-1.3em 0 0 -1.3em;border-radius:50%;border:.14em solid var(--tt);z-index:4;pointer-events:none;animation:tRipple .5s ease-out forwards;opacity:0}
.t-win{position:absolute;inset:6% 6% 6%;background:var(--tb);border:1px solid var(--tbd);border-radius:1em;box-shadow:0 1.2em 3em rgba(0,0,0,.08);overflow:hidden;display:flex;flex-direction:column}
.t-top{display:flex;align-items:center;gap:.6em;padding:.7em 1.1em;border-bottom:1px solid var(--tbd);font-weight:750;font-size:1.05em}
.t-top .t-mark{width:1.3em;height:1.3em}
.t-top .t-nav{margin-left:auto;display:flex;gap:1.2em;font-size:.8em;font-weight:600;color:var(--t2x)}
.t-top .t-nav .on{color:var(--tt);text-decoration:underline;text-underline-offset:.35em}
.t-top .t-av{width:1.6em;height:1.6em;border-radius:50%;background:var(--tt);color:var(--tb);display:grid;place-items:center;font-size:.7em;font-weight:750}
.t-mark{display:block;flex:none}
.t-mark.live circle:last-child{transform-box:view-box;transform-origin:32px 32px;animation:tOrbit 1.6s linear infinite}
.t-body{flex:1;min-height:0;display:flex;position:relative}
.t-rec{display:inline-flex;align-items:center;gap:.4em;font-size:.78em;font-weight:750;letter-spacing:.04em;color:var(--tdanger);background:color-mix(in srgb,var(--tdanger) 12%,transparent);padding:.25em .8em;border-radius:2em}
.t-rec i{width:.55em;height:.55em;border-radius:50%;background:currentColor;animation:tBlink 1.2s infinite}
.t-side{width:26%;border-right:1px solid var(--tbd);padding:1em .9em;display:flex;flex-direction:column;gap:.55em;font-size:.9em;color:var(--t2x)}
.t-side .t-new{border:1px solid var(--tbd);border-radius:.8em;padding:.6em .7em;display:flex;align-items:center;gap:.6em;color:var(--tt);margin-bottom:.4em}
.t-side .t-new i{width:1.7em;height:1.7em;border-radius:.5em;background:var(--tt);color:var(--tb);display:grid;place-items:center;font-style:normal;font-weight:700}
.t-side .t-new b{display:block;font-size:.9em}
.t-side .t-new small{display:block;font-size:.72em;color:var(--t3x)}
.t-side span{padding:.3em .4em;border-radius:.5em}
.t-side span.on{background:var(--tsofter);color:var(--tt);font-weight:650}
.t-main{flex:1;min-width:0;display:flex;flex-direction:column;position:relative}
.t-home{flex:1;padding:2em 2.4em;display:flex;flex-direction:column;gap:1em;max-width:40em;margin:0 auto;width:100%}
.t-home .t-mark{width:1.8em;height:1.8em}
.t-greet{font-size:1.8em;font-weight:800;letter-spacing:-.03em}
.t-greet-sub{color:var(--t2x);margin-top:-.7em}
.t-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:.7em}
.t-card{border:1px solid var(--tbd);border-radius:.9em;padding:.9em;background:var(--tb);display:flex;flex-direction:column;gap:.35em}
.t-card svg{width:1.3em;height:1.3em}
.t-card b{font-size:.92em}
.t-card span{font-size:.75em;color:var(--t2x);line-height:1.35}
.t-card.sel{animation:tSelect .35s both}
.t-recent{display:grid;grid-template-columns:repeat(3,1fr);gap:.7em}
.t-thumb{aspect-ratio:16/9;border-radius:.6em;background:linear-gradient(135deg,var(--tsofter),var(--tsoft));border:1px solid var(--tbd)}
.t-setup{flex:1;padding:1.4em 2.2em;display:flex;flex-direction:column;gap:1em;max-width:36em;margin:0 auto;width:100%}
.t-h{font-size:1.6em;font-weight:800;letter-spacing:-.03em}
.t-step{display:flex;gap:.8em}
.t-step i{flex:none;width:1.5em;height:1.5em;border-radius:50%;border:1px solid var(--tbd);display:grid;place-items:center;font-style:normal;font-size:.75em;font-weight:750;color:var(--t2x)}
.t-step > div{flex:1;min-width:0}
.t-step-t{font-weight:700;font-size:.95em;margin-bottom:.45em}
.t-chips{display:flex;gap:.45em;flex-wrap:wrap}
.t-chipx{border:1px solid var(--tbd);border-radius:2em;padding:.3em .8em;font-size:.82em;font-weight:600;color:var(--t2x)}
.t-chipx.sel{animation:tSelect .35s both;color:var(--tt)}
.t-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:.6em}
.t-tile{border:1px solid var(--tbd);border-radius:.8em;padding:.7em .8em;background:var(--tsoft);display:flex;flex-direction:column;gap:.3em}
.t-tile svg{width:1.25em;height:1.25em}
.t-tile b{font-size:.88em;font-weight:700}
.t-tile span{font-size:.72em;color:var(--t2x);line-height:1.3}
.t-tile.sel{animation:tSelect .35s both}
.t-foot{margin-top:auto;display:flex;align-items:center;gap:.8em;border-top:1px solid var(--tbd);padding-top:.9em;font-size:.85em;color:var(--t2x)}
.t-foot .t-mark{width:1.1em;height:1.1em}
.t-btn{margin-left:auto;background:var(--tt);color:var(--tb);font-weight:700;padding:.65em 1.5em;border-radius:.75em;font-size:1em}
.t-btn.press{animation:tPress .45s both}
.t-btn.danger{background:var(--tdanger)}
.t-hdr{display:flex;align-items:center;gap:.8em;padding:.8em 1.2em;border-bottom:1px solid var(--tbd)}
.t-hdr b{font-size:1.1em;font-weight:750;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.t-hdr .t-time{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85em;color:var(--t2x)}
.t-hdr .t-ghost{font-size:.8em;font-weight:600;color:var(--t2x)}
.t-hdr .t-btn{font-size:.8em;padding:.45em 1em}
.t-cols{flex:1;display:grid;grid-template-columns:1.15fr .85fr;min-height:0}
.t-left{border-right:1px solid var(--tbd);display:flex;flex-direction:column;min-height:0;position:relative}
.t-right{display:flex;flex-direction:column;min-height:0;position:relative}
.t-tabs{display:flex;gap:.4em;padding:.8em 1.2em .4em}
.t-tab{font-size:.82em;font-weight:650;padding:.3em .85em;border-radius:2em;color:var(--t2x)}
.t-tab.on{background:var(--tsofter);color:var(--tt)}
.t-lines{padding:.4em 1.3em;display:flex;flex-direction:column;gap:.65em;overflow:hidden}
.t-line{display:grid;grid-template-columns:2.6em 1fr;gap:.5em;font-size:.92em;border-radius:.4em;padding:.15em .3em;margin:0 -.3em}
.t-line .t-t{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.78em;color:var(--t3x);padding-top:.25em}
.t-line .t-x{color:var(--tt)}
.t-line.dim .t-x{color:var(--t2x)}
.t-line.flash{animation:tFlash 1.4s both}
.t-tag{display:inline-flex;align-items:center;gap:.35em;font-size:.7em;font-weight:750;letter-spacing:.05em;color:var(--t2x);border:1px solid var(--tbd);border-radius:.5em;padding:.12em .5em;margin-right:.45em;vertical-align:middle}
.t-listen{margin-top:auto;padding:.7em 1.3em .9em;display:flex;align-items:center;gap:.7em;color:var(--t3x);font-size:.85em}
.t-bars{display:flex;gap:.18em;align-items:center;height:1.2em}
.t-bars i{width:.22em;height:100%;border-radius:.1em;background:var(--tt);opacity:.6;transform-origin:center;animation:tBars 1s ease-in-out infinite}
.t-chead{display:flex;align-items:center;gap:.5em;padding:.8em 1.2em;border-bottom:1px solid var(--tbd);font-weight:650;font-size:.95em}
.t-chead svg{width:1em;height:1em}
.t-live{margin-left:auto;font-size:.7em;font-weight:750;letter-spacing:.05em;color:var(--tdanger);background:color-mix(in srgb,var(--tdanger) 12%,transparent);padding:.25em .7em;border-radius:2em}
.t-chat{flex:1;padding:.9em 1.2em;display:flex;flex-direction:column;gap:.85em;overflow:hidden;font-size:.9em}
.t-empty{margin:auto;text-align:center;color:var(--t3x);font-size:.9em;max-width:14em}
.t-empty b{display:block;color:var(--tt);font-weight:700;margin-bottom:.3em}
.t-user{align-self:flex-end;background:var(--tsofter);padding:.55em .9em;border-radius:1em;max-width:85%}
.t-ai{line-height:1.5}
.t-ai b{font-weight:700}
.t-chip{display:inline-flex;align-items:center;gap:.3em;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.78em;font-weight:650;border:1px solid var(--tbd);background:var(--tsoft);padding:.1em .5em;border-radius:.5em;vertical-align:middle;margin:0 .15em}
.t-chip svg{width:.7em;height:.7em}
.t-chip.press{animation:tPress .4s both}
.t-dots{display:inline-flex;align-items:center;gap:.5em;color:var(--t3x);font-size:.9em}
.t-dots .t-mark{width:1.1em;height:1.1em}
.t-dots i{width:.4em;height:.4em;border-radius:50%;background:var(--t3x);animation:tDots 1.2s infinite}
.t-dots i:nth-child(2){animation-delay:.2s}.t-dots i:nth-child(3){animation-delay:.4s}
.t-note{border:1px solid var(--tbd);background:var(--tsoft);border-radius:.9em;padding:.7em .9em;font-size:.95em;line-height:1.45}
.t-note small{display:flex;align-items:center;gap:.4em;font-size:.72em;font-weight:750;letter-spacing:.06em;text-transform:uppercase;color:var(--t3x);margin-bottom:.3em}
.t-note small svg{width:1em;height:1em}
.t-input{margin:auto 1.2em 1em;border:1px solid var(--tbd);border-radius:1em;padding:.65em .9em;color:var(--t3x);font-size:.9em;display:flex;align-items:center;min-height:2.6em;background:var(--tb)}
.t-input .t-typed{color:var(--tt)}
.t-input .t-ph{animation:tOut .2s both}
.t-input .t-send{margin-left:auto;width:1.7em;height:1.7em;border-radius:50%;background:var(--tsofter);display:grid;place-items:center;flex:none}
.t-input .t-send.on{background:var(--tt);color:var(--tb)}
.t-input .t-send svg{width:.9em;height:.9em}
.t-input .t-send.press{animation:tPress .4s both}
.t-board{margin:.9em 1.3em 0;aspect-ratio:16/7.5;border-radius:.7em;background:#1b1b1e;color:#f1f1f3;display:flex;align-items:center;justify-content:center;font-size:1.2em;font-style:italic;font-family:'Cambria Math','STIX Two Math','Times New Roman',serif;letter-spacing:.01em;position:relative;overflow:hidden;flex:none}
.t-board::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 30% 20%,rgba(255,255,255,.08),transparent 60%)}
.t-board .t-eye{position:absolute;right:.7em;top:.6em;display:inline-flex;align-items:center;gap:.4em;font:650 .55em 'Inter',sans-serif;font-style:normal;letter-spacing:.06em;color:#f1f1f3;background:rgba(255,255,255,.14);padding:.3em .7em;border-radius:2em}
.t-board .t-eye svg{width:1.4em;height:1.4em}
.t-board .t-eye .t-mark{width:1.3em;height:1.3em}
.t-session{flex:1;padding:1.3em 2em;display:flex;flex-direction:column;gap:.9em;max-width:38em;margin:0 auto;width:100%}
.t-title{font-size:1.5em;font-weight:800;letter-spacing:-.03em;position:relative;min-height:1.3em}
.t-title span{position:absolute;left:0;top:0;white-space:nowrap}
.t-title .old{animation:tOut .4s both;animation-delay:1.6s}
.t-title .new{opacity:0;animation:tIn .5s both;animation-delay:2s}
.t-meta{display:flex;gap:.6em;align-items:center;color:var(--t3x);font-size:.85em}
.t-pill{border:1px solid var(--tbd);border-radius:2em;padding:.15em .7em;font-weight:650;color:var(--t2x)}
.t-sum{font-size:.95em;line-height:1.55;color:var(--tt)}
.t-hl{display:flex;flex-wrap:wrap;gap:.5em}
.t-hl span{display:inline-flex;align-items:center;gap:.4em;border:1px solid var(--tbd);background:var(--tsoft);padding:.3em .8em;border-radius:2em;font-size:.82em;font-weight:600}
.t-hl span i{font-family:ui-monospace,Menlo,Consolas,monospace;font-style:normal;color:var(--t3x);font-size:.85em}
.t-overview{flex:1;padding:1.6em 2.2em;display:flex;flex-direction:column;gap:1em;max-width:36em;margin:0 auto;width:100%}
.t-modes{display:flex;gap:.5em}
.t-search{border:1px solid var(--tbd);border-radius:1em;padding:.8em 1em;display:flex;align-items:center;gap:.6em;font-size:.95em;background:var(--tb);min-height:2.8em}
.t-search svg{width:1em;height:1em;color:var(--t3x);flex:none}
.t-search .t-typed{color:var(--tt)}
.t-search .t-ph{color:var(--t3x);animation:tOut .2s both}
.t-answer{border:1px solid var(--tbd);border-radius:.9em;padding:.9em 1em;background:var(--tb);font-size:.92em;line-height:1.5}
.t-intro{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.8em;text-align:center;padding:2em}
.t-intro .t-mark{width:4.4em;height:4.4em}
.t-intro h3{font-size:2.2em;font-weight:800;letter-spacing:-.035em;margin:0}
.t-intro p{color:var(--t2x);font-size:1.05em;margin:0}
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
const MARK_LIVE = MARK.replace('t-mark', 't-mark live')
const I = {
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
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  broadcast:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.4 18.6a9.4 9.4 0 0 1 0-13.2M18.6 5.4a9.4 9.4 0 0 1 0 13.2"/></svg>',
  cursor:
    '<svg viewBox="0 0 24 24"><path d="M5 3l14 8.5-6.2 1.6L9.4 19 5 3z" fill="#1a1a1c" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>'
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

/** stack a second animation on an element (e.g. appear, then get selected) */
function then(node: HTMLElement, name: string, s: number, dur = 0.4): void {
  // The element may not be in the document yet, so its entrance animation is
  // read from the class it was given rather than from computed style.
  const base =
    node.style.animationName ||
    (node.classList.contains('t-pop') ? 'tPop' : node.classList.contains('t-in') ? 'tIn' : '')
  if (!base) {
    node.style.animation = `${name} ${dur}s ${s}s forwards`
    return
  }
  node.style.animationName = `${base}, ${name}`
  node.style.animationDuration = `${node.style.animationDuration || '.5s'}, ${dur}s`
  node.style.animationDelay = `${node.style.animationDelay || '0s'}, ${s}s`
  // the second animation must not fill backwards, or it would override the
  // entrance (e.g. a fade-out holding "visible" before its delay)
  node.style.animationFillMode = 'both, forwards'
}

/**
 * Text that arrives word by word from `start` seconds. `**bold**` is honoured.
 * Wraps naturally across lines, so nothing is ever clipped.
 */
function words(text: string, start: number, perWord = 0.075): DocumentFragment {
  const frag = document.createDocumentFragment()
  let t = start
  text.split(/(\*\*[^*]+\*\*)/).forEach((seg) => {
    if (!seg) return
    const bold = seg.startsWith('**')
    const body = bold ? seg.slice(2, -2) : seg
    body.split(/(\s+)/).forEach((w) => {
      if (!w) return
      if (/^\s+$/.test(w)) {
        frag.appendChild(document.createTextNode(' '))
        return
      }
      const span = el(bold ? 'b' : 'span', 't-w', w)
      span.style.animationDelay = `${t}s`
      t += perWord
      frag.appendChild(span)
    })
  })
  return frag
}
const wordsEnd = (text: string, start: number, perWord = 0.075): number =>
  start + text.replace(/\*\*/g, '').split(/\s+/).filter(Boolean).length * perWord

/** Text typed character by character into a field from `start`; returns when it finishes. */
function typed(target: HTMLElement, text: string, start: number, perChar = 0.045): number {
  const holder = el('span', 't-typed')
  let t = start
  for (const ch of text) {
    const c = el('span', 't-c', ch === ' ' ? '&nbsp;' : ch)
    c.style.animationDelay = `${t}s`
    t += perChar
    holder.appendChild(c)
  }
  const caret = el('span', 't-caret')
  caret.style.animationDelay = `${start}s`
  caret.style.opacity = '0'
  caret.style.animation = `tChar .01s ${start}s both, tCaret .9s steps(1) infinite, tOut .01s ${t + 0.6}s forwards`
  holder.appendChild(caret)
  target.appendChild(holder)
  return t
}

/** A pointer that travels between points (% of the stage) and clicks. */
interface Stop {
  x: number
  y: number
  t: number
  click?: boolean
}
let curSeq = 0
function pointer(stage: HTMLElement, stops: Stop[], total: number): void {
  const cur = el('div', 't-cur', I.cursor)
  const id = `tcur${++curSeq}`
  const frames = stops
    .map((s) => `${Math.min(100, Math.max(0, (s.t / total) * 100)).toFixed(2)}%{left:${s.x}%;top:${s.y}%}`)
    .join('')
  const style = el('style')
  style.textContent = `@keyframes ${id}{0%{left:${stops[0].x}%;top:${stops[0].y}%;opacity:0}${(stops[0].t / total) * 100 + 0.1}%{opacity:1}${frames}100%{left:${stops[stops.length - 1].x}%;top:${stops[stops.length - 1].y}%}}`
  stage.appendChild(style)
  cur.style.animation = `${id} ${total}s both`
  cur.style.animationTimingFunction = 'cubic-bezier(.4,0,.2,1)'
  stage.appendChild(cur)
  stops
    .filter((s) => s.click)
    .forEach((s) => {
      const r = el('div', 't-click')
      r.style.left = `${s.x}%`
      r.style.top = `${s.y}%`
      r.style.animationDelay = `${s.t}s`
      stage.appendChild(r)
    })
}

function win(stage: HTMLElement, opts: { rec?: boolean; nav?: boolean } = {}): HTMLElement {
  const scene = el('div', 't-scene')
  const w = el('div', 't-win')
  const top = el('div', 't-top', `${MARK}<span>Sitka</span>`)
  if (opts.nav) top.appendChild(el('span', 't-nav', '<span>Business</span><span class="on">Education</span>'))
  if (opts.rec) {
    const r = el('span', 't-rec', '<i></i>REC')
    r.style.marginLeft = 'auto'
    top.appendChild(at(r, 0.2, 't-pop'))
  } else top.appendChild(el('span', 't-av', 'M')).style.marginLeft = opts.nav ? '0' : 'auto'
  w.appendChild(top)
  const body = el('div', 't-body')
  w.appendChild(body)
  scene.appendChild(w)
  stage.appendChild(scene)
  return body
}

function sidebar(active: string): HTMLElement {
  const s = el('div', 't-side')
  s.appendChild(el('div', 't-new', '<i>+</i><span><b>New session</b><small>Screen, camera or audio</small></span>'))
  ;['Home', 'Overview', 'Events', 'Create', 'Library'].forEach((n) =>
    s.appendChild(el('span', n === active ? 'on' : '', n))
  )
  return s
}

function chatHeader(live: boolean): HTMLElement {
  return el('div', 't-chead', `${I.sparkle}<span>Ask Sitka</span>${live ? '<span class="t-live">● LIVE</span>' : ''}`)
}

function line(time: string, text: string, s: number, dim = false, animate = true): HTMLElement {
  const row = el('div', `t-line${dim ? ' dim' : ''}`)
  row.appendChild(el('span', 't-t', time))
  const x = el('span', 't-x')
  if (animate) x.appendChild(words(text, s + 0.15, 0.06))
  else x.textContent = text
  row.appendChild(x)
  at(row, s)
  return row
}

function inputBox(placeholder = 'Ask about this session…'): HTMLElement {
  return el('div', 't-input', `<span class="t-ph" style="animation:none">${placeholder}</span><span class="t-send">${I.send}</span>`)
}

const LECTURE = [
  ['0:05', 'Today we look at how to differentiate a function.'],
  ['0:12', 'Take y equals three x squared plus four.'],
  ['0:20', 'The power rule says: bring the exponent down, then reduce it by one.'],
  ['0:31', 'So the derivative is six x. The constant disappears.']
]

// ---------------- the journey ----------------

const SCENES: Scene[] = [
  {
    chapter: 'Start',
    caption: 'Sitka attends lectures, meetings and talks with you.',
    duration: 3.2,
    build(stage) {
      const s = el('div', 't-scene')
      const intro = el('div', 't-intro', `${MARK_LIVE}<h3>Sitka</h3><p>Attend once. Keep it forever.</p>`)
      at(intro, 0.1, 't-pop')
      s.appendChild(intro)
      stage.appendChild(s)
    }
  },
  {
    chapter: 'Start',
    caption: 'You sign in and land on Home. One tap starts a session.',
    duration: 6,
    build(stage) {
      const body = win(stage, { nav: true })
      body.appendChild(sidebar('Home'))
      const main = el('div', 't-main')
      const home = el('div', 't-home')
      home.appendChild(at(el('div', '', MARK_LIVE), 0.1))
      home.appendChild(at(el('div', 't-greet', 'Good morning.'), 0.2))
      home.appendChild(at(el('div', 't-greet-sub', 'Sitka attends with you — lectures, meetings, and events, understood live.'), 0.3))
      const cards = el('div', 't-cards')
      const defs: [string, string, string][] = [
        [I.screen, 'Start a live session', 'Transcript, AI and notes in real time.'],
        [I.broadcast, 'Host an event', 'A private AI for every seat in the room.'],
        [I.sparkle, 'Open Overview', 'Ask across everything you have attended.']
      ]
      defs.forEach(([ic, t, d], i) => {
        const c = el('div', 't-card', `${ic}<b>${t}</b><span>${d}</span>`)
        at(c, 0.5 + i * 0.12)
        if (i === 0) then(c, 'tSelect', 3.6, 0.35)
        cards.appendChild(c)
      })
      home.appendChild(cards)
      const rec = el('div', 't-recent')
      for (let i = 0; i < 3; i++) rec.appendChild(at(el('div', 't-thumb'), 0.9 + i * 0.1))
      home.appendChild(rec)
      main.appendChild(home)
      body.appendChild(main)
      pointer(stage, [{ x: 80, y: 85, t: 1.2 }, { x: 44, y: 47, t: 3.4, click: true }, { x: 44, y: 47, t: 6 }], 6)
    }
  },
  {
    chapter: 'Start',
    caption: 'Choose what Sitka should watch: your screen, the camera pointed at the board, or just the microphone.',
    duration: 9,
    build(stage) {
      const body = win(stage)
      const main = el('div', 't-main')
      const s = el('div', 't-setup')
      s.appendChild(at(el('div', 't-h', 'Attend a lecture'), 0.1))
      const st1 = el('div', 't-step', '<i>1</i><div><div class="t-step-t">This is a…</div></div>')
      const chips = el('div', 't-chips')
      ;['Lecture', 'Meeting', 'Presentation', 'Other'].forEach((c, i) => {
        const ch = el('span', 't-chipx', c)
        at(ch, 0.3 + i * 0.08)
        if (i === 0) then(ch, 'tSelect', 1.6, 0.35)
        chips.appendChild(ch)
      })
      st1.querySelector('div')!.appendChild(chips)
      s.appendChild(st1)
      const st2 = el('div', 't-step', '<i>2</i><div><div class="t-step-t">What should Sitka watch?</div></div>')
      const tiles = el('div', 't-tiles')
      const defs: [string, string, string][] = [
        [I.screen, 'Screen + audio', 'Slides, a call, a video — with the sound.'],
        [I.camera, 'Camera + audio', 'Point it at the board or the projector.'],
        [I.mic, 'Audio only', 'Just listen — in person, quick and simple.']
      ]
      defs.forEach(([ic, t, d], i) => {
        const tl = el('div', 't-tile', `${ic}<b>${t}</b><span>${d}</span>`)
        at(tl, 0.6 + i * 0.1)
        if (i === 0) then(tl, 'tSelect', 3.9, 0.35)
        tiles.appendChild(tl)
      })
      st2.querySelector('div')!.appendChild(tiles)
      s.appendChild(st2)
      const st3 = el(
        'div',
        't-step',
        '<i>3</i><div><div class="t-step-t">Anything Sitka should read first? <span style="color:var(--t3x);font-weight:500">optional</span></div><div class="t-chipx" style="display:inline-block">Add slides or notes</div></div>'
      )
      s.appendChild(at(st3, 0.9))
      const foot = el('div', 't-foot', `${MARK}<span>Watching your screen · lecture</span>`)
      const btn = el('span', 't-btn', 'Start')
      then(btn, 'tPress', 6.4, 0.45)
      foot.appendChild(btn)
      s.appendChild(at(foot, 1.1))
      main.appendChild(s)
      body.appendChild(main)
      pointer(
        stage,
        [
          { x: 70, y: 80, t: 0.6 },
          { x: 24, y: 34, t: 1.5, click: true },
          { x: 30, y: 57, t: 3.8, click: true },
          { x: 86, y: 87, t: 6.3, click: true },
          { x: 86, y: 87, t: 9 }
        ],
        9
      )
    }
  },
  {
    chapter: 'Listen',
    caption: 'Sitka listens and writes everything down, with the time it was said.',
    duration: 9.5,
    build(stage) {
      const body = win(stage, { rec: true })
      const main = el('div', 't-main')
      main.appendChild(
        el('div', 't-hdr', `<b>Session — Sep 9, 8:44 AM</b><span class="t-ghost">Mark</span><span class="t-ghost">Catch me up</span><span class="t-time" style="margin-left:auto">0:31</span><span class="t-btn danger">End session</span>`)
      )
      const cols = el('div', 't-cols')
      const left = el('div', 't-left')
      left.appendChild(el('div', 't-tabs', '<span class="t-tab on">Transcript</span><span class="t-tab">Notes</span><span class="t-tab">Materials</span>'))
      const lines = el('div', 't-lines')
      LECTURE.forEach(([t, x], i) => lines.appendChild(line(t, x, 0.5 + i * 2.1)))
      left.appendChild(lines)
      const listen = el('div', 't-listen', '<span class="t-bars"><i></i><i></i><i></i><i></i><i></i></span>Listening')
      listen.querySelectorAll('i').forEach((b, i) => ((b as HTMLElement).style.animationDelay = `${i * 0.12}s`))
      left.appendChild(listen)
      const right = el('div', 't-right')
      right.appendChild(chatHeader(true))
      const chat = el('div', 't-chat')
      chat.appendChild(at(el('div', 't-empty', '<b>Sitka is listening with you</b>Ask anything about what is being said or shown.'), 0.8))
      right.appendChild(chat)
      right.appendChild(inputBox())
      cols.append(left, right)
      main.appendChild(cols)
      body.appendChild(main)
    }
  },
  {
    chapter: 'See',
    caption: 'It reads the screen too: the whiteboard, slides, charts, tables — whatever the presenter shows.',
    duration: 9.5,
    build(stage) {
      const body = win(stage, { rec: true })
      const main = el('div', 't-main')
      main.appendChild(
        el('div', 't-hdr', `<b>Session — Sep 9, 8:44 AM</b><span class="t-ghost">Mark</span><span class="t-ghost">Catch me up</span><span class="t-time" style="margin-left:auto">0:38</span><span class="t-btn danger">End session</span>`)
      )
      const cols = el('div', 't-cols')
      const left = el('div', 't-left')
      const board = el('div', 't-board', 'Find dy/dx for y = 3x² + 4')
      const eye = el('span', 't-eye', `${MARK_LIVE}READING THE SCREEN`)
      board.appendChild(at(eye, 2.2, 't-pop'))
      then(eye, 'tOut', 6.2, 0.4)
      left.appendChild(at(board, 0.2))
      left.appendChild(el('div', 't-tabs', '<span class="t-tab on">Transcript</span><span class="t-tab">Notes · 2</span><span class="t-tab">Materials</span>'))
      const lines = el('div', 't-lines')
      lines.appendChild(line('0:31', 'So the derivative is six x. The constant disappears.', 0.3, true, false))
      const screen = el('div', 't-line dim')
      screen.appendChild(el('span', 't-t', '0:38'))
      const sx = el('span', 't-x', '<span class="t-tag">ON SCREEN</span>')
      sx.appendChild(words('Whiteboard: "Find dy/dx for y = 3x² + 4". A worked example of the power rule is being written underneath.', 4.6, 0.06))
      screen.appendChild(sx)
      lines.appendChild(at(screen, 4.4))
      lines.appendChild(line('0:44', 'Now let us try a harder one, with the chain rule.', 7.4, true))
      left.appendChild(lines)
      const right = el('div', 't-right')
      right.appendChild(chatHeader(true))
      const chat = el('div', 't-chat')
      chat.appendChild(at(el('div', 't-empty', '<b>Sitka is listening with you</b>Ask anything about what is being said or shown.'), 0.6))
      right.appendChild(chat)
      right.appendChild(inputBox())
      cols.append(left, right)
      main.appendChild(cols)
      body.appendChild(main)
    }
  },
  {
    chapter: 'Ask',
    caption: 'Ask anything, any time. Answers come from what was said and shown, and point to the exact moment.',
    duration: 15,
    build(stage) {
      const body = win(stage, { rec: true })
      const main = el('div', 't-main')
      main.appendChild(
        el('div', 't-hdr', `<b>Session — Sep 9, 8:44 AM</b><span class="t-ghost">Mark</span><span class="t-ghost">Catch me up</span><span class="t-time" style="margin-left:auto">0:52</span><span class="t-btn danger">End session</span>`)
      )
      const cols = el('div', 't-cols')
      cols.style.gridTemplateColumns = '.9fr 1.1fr'
      const left = el('div', 't-left')
      left.appendChild(at(el('div', 't-board', 'Find dy/dx for y = 3x² + 4'), 0.1))
      left.appendChild(el('div', 't-tabs', '<span class="t-tab on">Transcript</span><span class="t-tab">Notes · 3</span>'))
      const lines = el('div', 't-lines')
      const target = line('0:31', 'So the derivative is six x. The constant disappears.', 0.2, true, false)
      then(target, 'tFlash', 11.4, 1.4)
      lines.appendChild(target)
      lines.appendChild(line('0:44', 'Now let us try a harder one, with the chain rule.', 0.3, true, false))
      lines.appendChild(line('0:52', 'Take y equals e to the power of two x.', 9.5, true))
      left.appendChild(lines)
      const right = el('div', 't-right')
      right.appendChild(chatHeader(true))
      const chat = el('div', 't-chat')
      const q = 'what function is on the board?'
      const user = el('div', 't-user', q)
      chat.appendChild(at(user, 3.1, 't-pop'))
      const thinking = el('div', 't-dots', `${MARK_LIVE}Reading the screen <i></i><i></i><i></i>`)
      thinking.style.animation = 'tIn .35s 3.5s both, tOut .3s 5.4s forwards'
      chat.appendChild(thinking)
      const ai = el('div', 't-ai')
      const answer = 'The board shows **y = 3x² + 4** and asks for dy/dx. Using the power rule he explained, **dy/dx = 6x** — the constant 4 disappears.'
      ai.appendChild(words(answer, 5.6))
      const chip = el('span', 't-chip', `${I.play} 0:31`)
      at(chip, wordsEnd(answer, 5.6) + 0.2, 't-pop')
      then(chip, 'tPress', 11.3, 0.4)
      ai.appendChild(chip)
      chat.appendChild(ai)
      right.appendChild(chat)
      const input = inputBox()
      const ph = input.querySelector('.t-ph') as HTMLElement
      ph.style.animation = 'tOut .2s .9s both'
      const send = input.querySelector('.t-send') as HTMLElement
      const done = typed(input, q, 1.0, 0.05)
      input.insertBefore(input.lastElementChild!, send)
      send.style.animation = `tIn .01s ${done}s both`
      then(send, 'tPress', done + 0.35, 0.4)
      send.classList.add('on')
      const typedEl = input.querySelector('.t-typed') as HTMLElement
      typedEl.style.animation = `tOut .15s ${done + 0.7}s forwards`
      right.appendChild(input)
      cols.append(left, right)
      main.appendChild(cols)
      body.appendChild(main)
      pointer(
        stage,
        [
          { x: 62, y: 96, t: 0.2 },
          { x: 62, y: 88, t: 0.8, click: true },
          { x: 93, y: 88, t: done + 0.3, click: true },
          { x: 75, y: 55, t: 8.5 },
          { x: 75, y: 55, t: 11.2, click: true },
          { x: 75, y: 55, t: 15 }
        ],
        15
      )
    }
  },
  {
    chapter: 'Ask',
    caption: 'And Sitka speaks up on its own when something matters.',
    duration: 6,
    build(stage) {
      const body = win(stage, { rec: true })
      const main = el('div', 't-main')
      main.appendChild(
        el('div', 't-hdr', `<b>Session — Sep 9, 8:44 AM</b><span class="t-ghost">Mark</span><span class="t-ghost">Catch me up</span><span class="t-time" style="margin-left:auto">1:40</span><span class="t-btn danger">End session</span>`)
      )
      const cols = el('div', 't-cols')
      cols.style.gridTemplateColumns = '.9fr 1.1fr'
      const left = el('div', 't-left')
      left.appendChild(el('div', 't-board', 'Chain rule: y = e^(2x) → dy/dx = 2e^(2x)'))
      left.appendChild(el('div', 't-tabs', '<span class="t-tab on">Transcript</span><span class="t-tab">Notes · 4</span>'))
      const lines = el('div', 't-lines')
      lines.appendChild(line('1:15', 'Set u equals two x, and differentiate the outside first.', 0, true, false))
      lines.appendChild(line('1:30', 'Then multiply by du over dx, which is two.', 0, true, false))
      lines.appendChild(line('1:40', 'This one comes up in every exam, so make sure you have it.', 1.2, true))
      left.appendChild(lines)
      const right = el('div', 't-right')
      right.appendChild(chatHeader(true))
      const chat = el('div', 't-chat')
      chat.appendChild(el('div', 't-user', 'what function is on the board?'))
      chat.appendChild(
        el('div', 't-ai', `The board shows <b>y = 3x² + 4</b> and asks for dy/dx. Using the power rule, <b>dy/dx = 6x</b>. <span class="t-chip">${I.play} 0:31</span>`)
      )
      const note = el('div', 't-note', `<small>${I.sparkle}Sitka noticed</small>`)
      note.appendChild(words('He just said the chain rule comes up in **every exam** — worth a mark. Want a quick practice question on it?', 2.9, 0.06))
      chat.appendChild(at(note, 2.7, 't-pop'))
      right.appendChild(chat)
      right.appendChild(inputBox())
      cols.append(left, right)
      main.appendChild(cols)
      body.appendChild(main)
    }
  },
  {
    chapter: 'Remember',
    caption: 'When the session ends, Sitka names it, writes the summary and marks the moments worth revisiting.',
    duration: 11,
    build(stage) {
      const body = win(stage)
      const main = el('div', 't-main')
      const s = el('div', 't-session')
      s.appendChild(
        el('div', 't-title', '<span class="old">Session — Sep 9, 8:44 AM</span><span class="new">Basic differentiation rules</span>')
      )
      s.appendChild(at(el('div', 't-meta', '<span>Today at 8:44 AM</span><span class="t-pill">23 min</span><span class="t-pill">Lecture</span>'), 0.3))
      const sum = el('div', 't-sum')
      sum.appendChild(
        words(
          'A walkthrough of the power rule with worked examples, then the chain rule for exponential functions such as e^(2x). The session closes with a logarithmic example rewritten as a difference of logs.',
          2.6,
          0.06
        )
      )
      s.appendChild(sum)
      const hl = el('div', 't-hl')
      ;[
        ['0:20', 'Power rule'],
        ['0:52', 'Worked example'],
        ['1:15', 'Chain rule'],
        ['18:30', 'Logarithms']
      ].forEach(([t, l], i) => hl.appendChild(at(el('span', '', `<i>${t}</i>${l}`), 5.4 + i * 0.22, 't-pop')))
      s.appendChild(hl)
      s.appendChild(
        at(
          el('div', 't-tabs', '<span class="t-tab on">Transcript</span><span class="t-tab">Overview</span><span class="t-tab">Notes</span><span class="t-tab">Study</span>'),
          6.8
        )
      )
      const lines = el('div', 't-lines')
      lines.style.padding = '0'
      lines.appendChild(line('0:05', 'Today we look at how to differentiate a function.', 7.2, true, false))
      lines.appendChild(line('0:12', 'Take y equals three x squared plus four.', 7.4, true, false))
      s.appendChild(lines)
      main.appendChild(s)
      body.appendChild(main)
    }
  },
  {
    chapter: 'Remember',
    caption: 'Weeks later, ask across everything you have ever attended. Sitka finds the moment.',
    duration: 10,
    build(stage) {
      const body = win(stage, { nav: true })
      body.appendChild(sidebar('Overview'))
      const main = el('div', 't-main')
      const o = el('div', 't-overview')
      o.appendChild(at(el('div', 't-h', 'Overview'), 0.1))
      o.appendChild(
        at(el('div', 't-modes', '<span class="t-chipx sel" style="animation:none;color:var(--tt);border-color:var(--tt)">Ask</span><span class="t-chipx">Search</span><span class="t-chipx">Memory</span>'), 0.2)
      )
      const search = el('div', 't-search', `${I.search}<span class="t-ph" style="animation:none">Ask across everything…</span>`)
      const ph = search.querySelector('.t-ph') as HTMLElement
      ph.style.animation = 'tOut .2s 1s both'
      const done = typed(search, 'where did we cover the chain rule?', 1.1, 0.05)
      o.appendChild(at(search, 0.3))
      const ans = el('div', 't-answer')
      const text =
        'You covered it twice. First in **Basic differentiation rules**, where he introduced it with y = e^(2x) and said it comes up in every exam'
      ans.appendChild(words(text, done + 1.2, 0.06))
      const c1 = el('span', 't-chip', `${I.play} Basic differentiation rules · 1:15`)
      at(c1, wordsEnd(text, done + 1.2, 0.06) + 0.1, 't-pop')
      ans.appendChild(c1)
      const text2 = ' — and again in **Integration by parts**, applied in reverse'
      ans.appendChild(words(text2, wordsEnd(text, done + 1.2, 0.06) + 0.3, 0.06))
      const c2 = el('span', 't-chip', `${I.play} Integration by parts · 6:02`)
      at(c2, wordsEnd(text2, wordsEnd(text, done + 1.2, 0.06) + 0.3, 0.06) + 0.1, 't-pop')
      ans.appendChild(c2)
      const thinking = el('div', 't-dots', `${MARK_LIVE}Searching every session <i></i><i></i><i></i>`)
      thinking.style.animation = `tIn .3s ${done + 0.2}s both, tOut .3s ${done + 1.1}s forwards`
      o.appendChild(thinking)
      o.appendChild(at(ans, done + 1.1))
      main.appendChild(o)
      body.appendChild(main)
    }
  }
]

export function mountTour(root: HTMLElement, opts: TourOptions = {}): () => void {
  ensureStyles()
  root.innerHTML = ''
  const tour = el('div', 'tour')
  const chapters = el('div', 'tour-chapters')
  const chapterEls = CHAPTERS.map((c) => {
    const b = el('button', 'tour-ch', c)
    b.addEventListener('click', () => go(SCENES.findIndex((s) => s.chapter === c)))
    chapters.appendChild(b)
    return b
  })
  const stage = el('div', 'tour-stage')
  const caption = el('div', 'tour-caption')
  const bar = el('div', 'tour-bar')
  const play = el('button', 'tour-play', I.pause)
  play.setAttribute('aria-label', 'Pause')
  const dots = el('div', 'tour-dots')
  const dotEls = SCENES.map((_, i) => {
    const d = el('div', 'tour-dot')
    d.addEventListener('click', () => go(i))
    dots.appendChild(d)
    return d
  })
  const count = el('span', 'tour-count')
  bar.append(play, dots, count)
  if (opts.onDone && opts.showSkip !== false) {
    const skip = el('button', 'tour-skip', 'Skip')
    skip.addEventListener('click', () => opts.onDone?.())
    bar.appendChild(skip)
  }
  tour.append(chapters, stage, caption, bar)
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
    count.textContent = ''
    dotEls.forEach((d) => {
      d.classList.remove('now')
      d.classList.add('done')
    })
    chapterEls.forEach((c) => {
      c.classList.remove('now')
      c.classList.add('done')
    })
    const s = el('div', 't-scene')
    const end = el('div', 't-end')
    end.innerHTML = `${MARK_LIVE}<h3>Ready when you are.</h3><p>Start a session the next time you are in a lecture, a meeting or a talk. Sitka does the rest.</p>`
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
    s.appendChild(at(end, 0.1, 't-pop'))
    stage.appendChild(s)
    if (opts.loop && !paused) arm(6000)
  }

  function go(i: number): void {
    if (disposed) return
    clearTimer()
    if (i >= SCENES.length) {
      if (opts.loop && index === SCENES.length) {
        go(0)
        return
      }
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
    count.textContent = `${i + 1} / ${SCENES.length}`
    dotEls.forEach((d, j) => {
      d.classList.toggle('done', j < i)
      d.classList.toggle('now', j === i)
      d.style.setProperty('--dur', `${scene.duration}s`)
    })
    const ci = CHAPTERS.indexOf(scene.chapter)
    chapterEls.forEach((c, j) => {
      c.classList.toggle('done', j < ci)
      c.classList.toggle('now', j === ci)
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
    play.innerHTML = p ? I.play : I.pause
    play.setAttribute('aria-label', p ? 'Play' : 'Pause')
    if (p) {
      if (timer) remaining = Math.max(0, remaining - (Date.now() - startedAt))
      clearTimer()
    } else if (index >= 0 && index < SCENES.length) {
      arm(remaining)
    } else if (index === -1) {
      go(0)
    } else if (opts.loop) {
      arm(4000)
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

  if (paused) play.innerHTML = I.play
  go(0)

  return () => {
    disposed = true
    clearTimer()
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('visibilitychange', onVisibility)
    root.innerHTML = ''
  }
}
