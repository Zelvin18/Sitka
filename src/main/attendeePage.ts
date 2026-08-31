/**
 * The mobile page served to attendees who scan the event QR code.
 * Self-contained: inline CSS + vanilla JS, no installs, no accounts.
 * Design language mirrors the desktop app: monochrome, stroke icons, no emojis.
 */
export function attendeeHtml(eventTitle: string): string {
  const title = eventTitle.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<title>${title} — Sitka Live</title>
<style>
:root{--bg:#fff;--soft:#f6f6f4;--softer:#eeeeec;--text:#1a1a1c;--t2:#62626a;--t3:#9c9ca3;--border:#e6e6e3;--danger:#c8443a;--shadow:rgba(20,20,22,.10)}
@media(prefers-color-scheme:dark){:root{--bg:#161618;--soft:#1f1f22;--softer:#28282c;--text:#ededf0;--t2:#a3a3ab;--t3:#6e6e76;--border:#2e2e33;--shadow:rgba(0,0,0,.45)}}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{height:100%}
body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);font-size:15px;line-height:1.5;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
.hidden{display:none!important}
button{font-family:inherit;cursor:pointer}
svg.ic{flex-shrink:0}

/* ---------- header ---------- */
header{padding:calc(10px + env(safe-area-inset-top)) 18px 10px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg)}
.brand{display:flex;align-items:center;gap:8px;font-weight:750;font-size:14.5px;letter-spacing:-.01em}
.dot{width:8px;height:8px;border-radius:50%;background:var(--text)}
.live{margin-left:auto;display:flex;align-items:center;gap:5px;font-size:10.5px;font-weight:800;letter-spacing:.09em}
.live.on{color:var(--danger)}
.live.soon{color:var(--t3)}
.ldot{width:7px;height:7px;border-radius:50%;background:currentColor}
.live.on .ldot{animation:blip 1.5s ease infinite}
@keyframes blip{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.8)}}
.evtitle{font-size:12.5px;color:var(--t2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ---------- join / waiting ---------- */
.center{flex:1;display:flex;flex-direction:column;justify-content:center;padding:24px;overflow-y:auto;animation:fadeup .5s ease}
@keyframes fadeup{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.hero-art{position:relative;height:130px;margin-bottom:8px;flex-shrink:0}
.ring{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border:1.5px solid var(--border);border-radius:50%}
.r1{width:52px;height:52px}
.r2{width:94px;height:94px;opacity:.65}
.r3{width:138px;height:138px;opacity:.35}
.cdot{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:12px;height:12px;background:var(--text);border-radius:50%;z-index:1}
.rippling .ring{animation:ripple 2.6s ease-out infinite}
.rippling .r2{animation-delay:.35s}
.rippling .r3{animation-delay:.7s}
@keyframes ripple{0%{transform:translate(-50%,-50%) scale(.92);opacity:.9}70%{opacity:.25}100%{transform:translate(-50%,-50%) scale(1.12);opacity:.55}}
h1{font-size:23px;letter-spacing:-.02em;margin-bottom:6px;font-weight:750}
.sub{color:var(--t2);margin-bottom:20px;font-size:14px}
.label{font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.07em;color:var(--t3);margin:16px 0 8px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{padding:9px 15px;border:1.5px solid var(--border);border-radius:20px;background:var(--bg);color:var(--text);font-size:13.5px;font-weight:550;transition:all .15s ease}
.chip.sel{border-color:var(--text);background:var(--softer)}
select{width:100%;padding:12px 13px;border:1.5px solid var(--border);border-radius:12px;background:var(--bg);color:var(--text);font-size:15px;appearance:none;-webkit-appearance:none}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:14px;border:none;border-radius:14px;background:var(--text);color:var(--bg);font-size:15px;font-weight:650;margin-top:22px;transition:transform .1s ease}
.btn:active{transform:scale(.98)}
.btn:disabled{opacity:.4}
.btn2{background:var(--soft);color:var(--text);border:1px solid var(--border)}
.consent{font-size:11.5px;color:var(--t3);text-align:center;margin-top:18px}
.checkbig{width:52px;height:52px;border-radius:50%;background:var(--softer);display:flex;align-items:center;justify-content:center;margin:0 auto 14px}

/* ---------- main panes ---------- */
.pane{flex:1;overflow-y:auto;padding:14px 16px;display:none}
.pane.sel{display:block;animation:fadeup .3s ease}
#pane-live{padding-top:0}
.livehead{position:sticky;top:0;z-index:5;background:var(--bg);padding:12px 0 8px}

/* stage view */
.stagecard{position:relative;border-radius:16px;overflow:hidden;background:#000;aspect-ratio:16/9;margin-bottom:10px;box-shadow:0 10px 28px var(--shadow)}
.stagecard img{width:100%;height:100%;object-fit:contain;display:block}
.stagetag{position:absolute;top:8px;left:8px;display:flex;align-items:center;gap:5px;font-size:9.5px;font-weight:800;letter-spacing:.09em;color:#fff;background:rgba(0,0,0,.45);padding:4px 9px;border-radius:20px;backdrop-filter:blur(6px)}
.stagetag .ldot{width:6px;height:6px;background:var(--danger);animation:blip 1.5s ease infinite}
.stageexp{position:absolute;right:8px;bottom:8px;width:32px;height:32px;border-radius:10px;border:none;background:rgba(0,0,0,.45);color:#fff;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px)}
#stagefull{position:fixed;inset:0;background:#000;z-index:60;display:flex;align-items:center;justify-content:center}
#stagefull img{max-width:100%;max-height:100%}
#stagefull .xbtn{position:absolute;top:calc(12px + env(safe-area-inset-top));right:14px;width:38px;height:38px;border-radius:50%;border:none;background:rgba(255,255,255,.14);color:#fff;display:flex;align-items:center;justify-content:center}

/* listen pill */
.listen{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:12px;border:1px solid var(--border);border-radius:14px;background:var(--soft);color:var(--text);font-size:14px;font-weight:650;transition:all .15s ease}
.listen.on{background:var(--text);color:var(--bg);border-color:var(--text)}

/* captions */
.seg{display:flex;gap:10px;margin-bottom:10px;animation:segin .35s ease}
@keyframes segin{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
.ts{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--t3);padding-top:3.5px;min-width:38px;text-align:right}
.segtext{color:var(--t2)}
.waiting{color:var(--t3);font-size:13px;padding:8px 0}

/* chat */
.bub-u{background:var(--softer);border-radius:16px 16px 5px 16px;padding:10px 14px;margin:10px 0 10px auto;max-width:85%;width:fit-content;white-space:pre-wrap}
.bub-a{margin:12px 0;white-space:pre-wrap}
.inputrow{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--border);flex-shrink:0;background:var(--bg)}
.inputrow textarea{flex:1;border:1.5px solid var(--border);border-radius:18px;padding:10px 15px;font:inherit;background:var(--bg);color:var(--text);resize:none;max-height:90px}
.send{width:40px;height:40px;border-radius:50%;border:none;background:var(--text);color:var(--bg);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.notice{background:var(--soft);border:1px solid var(--border);border-radius:14px;padding:12px 14px;font-size:13.5px;color:var(--t2);margin:10px 0}
.err{border-color:rgba(200,68,58,.4);color:var(--danger)}
.qbox{border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:12px;background:var(--soft);animation:fadeup .3s ease}
.qbox b{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.small{font-size:12.5px;color:var(--t3)}
textarea.qta{width:100%;border:1.5px solid var(--border);border-radius:14px;padding:12px;font:inherit;background:var(--bg);color:var(--text);resize:none}
.typing{color:var(--t3);font-size:13px;animation:pulse 1.2s infinite;margin:10px 0}
@keyframes pulse{50%{opacity:.4}}

/* rich AI answers (markdown) */
.md{white-space:normal}
.md p{margin:0 0 8px}
.md p:last-child{margin-bottom:0}
.md h2,.md h3,.md h4{margin:14px 0 6px;letter-spacing:-.01em;font-weight:700}
.md h2{font-size:16.5px}
.md h3{font-size:15px}
.md h4{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--t3)}
.md h2:first-child,.md h3:first-child,.md h4:first-child{margin-top:2px}
.md ul,.md ol{margin:0 0 8px;padding-left:20px}
.md li{margin:0 0 4px}
.md code{font-family:ui-monospace,monospace;font-size:12.5px;background:var(--softer);padding:1px 5px;border-radius:5px}
.md pre{background:var(--soft);border:1px solid var(--border);border-radius:10px;padding:10px 12px;overflow-x:auto;margin:0 0 8px}
.md pre code{background:none;padding:0;font-size:12px}
.md .tw{overflow-x:auto;margin:0 0 8px;border:1px solid var(--border);border-radius:10px}
.md table{border-collapse:collapse;font-size:13px;min-width:100%}
.md th,.md td{padding:7px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.md th{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--t3);background:var(--soft);white-space:nowrap}
.md tr:last-child td{border-bottom:none}
.tchip{display:inline-flex;align-items:center;padding:1px 8px;margin:0 1px;border:1px solid var(--border);border-radius:12px;background:var(--soft);color:var(--text);font-size:11px;font-family:ui-monospace,monospace;font-weight:650;vertical-align:baseline;line-height:1.5;transition:background .12s ease}
.tchip:active{background:var(--softer);border-color:var(--text)}
.seg{border-radius:8px}
.seg.flash{animation:segflash 1.8s ease}
@keyframes segflash{0%,50%{background:var(--softer)}100%{background:transparent}}

/* take-home */
.tkcard{border:1px solid var(--border);border-radius:16px;padding:15px;margin-top:12px;background:var(--soft)}
.tkcard h2{font-size:12px;font-weight:750;text-transform:uppercase;letter-spacing:.07em;color:var(--t3);margin-bottom:8px}
.tkcard li{margin:0 0 7px 18px;color:var(--t2)}
.tkcard .segtext{color:var(--t2)}

/* ---------- dock nav ---------- */
.navwrap{flex-shrink:0;padding:8px 12px calc(8px + env(safe-area-inset-bottom));background:var(--bg)}
.tabs{display:flex;background:var(--soft);border:1px solid var(--border);border-radius:22px;padding:5px;box-shadow:0 8px 26px var(--shadow)}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 0 6px;border:none;background:none;border-radius:17px;color:var(--t3);font-size:10.5px;font-weight:650;transition:color .15s ease}
.tab svg{width:20px;height:20px}
.tab.sel{background:var(--bg);color:var(--text);box-shadow:0 2px 10px var(--shadow)}
.tab.off{opacity:.3;pointer-events:none}
</style>
</head>
<body>
<header>
  <div class="brand"><span class="dot"></span>Sitka <span class="live soon" id="livebadge"><span class="ldot"></span>LIVE</span></div>
  <div class="evtitle">${title}</div>
</header>

<div id="join" class="center">
  <div class="hero-art rippling"><span class="ring r1"></span><span class="ring r2"></span><span class="ring r3"></span><span class="cdot"></span></div>
  <h1 style="text-align:center">Join this event</h1>
  <div class="sub" style="text-align:center">Your own AI companion for this talk — ask anything, privately, at your level.</div>
  <div class="label">I am a…</div>
  <div class="chips" id="personas"></div>
  <div class="label">My language — AI answers, captions &amp; voice</div>
  <select id="lang">
    <option>English</option><option>Shona</option><option>Ndebele</option><option>Swahili</option>
    <option>French</option><option>Portuguese</option><option>Spanish</option><option>German</option>
    <option>Arabic</option><option>Chinese</option><option>Hindi</option>
  </select>
  <button class="btn" id="joinbtn">Join event</button>
  <div class="consent">This event is captured and AI-assisted by the host's Sitka. Your questions stay private to you; questions you submit to the speaker are shared with the host.</div>
</div>

<div id="wait" class="center hidden" style="text-align:center">
  <div class="hero-art rippling"><span class="ring r1"></span><span class="ring r2"></span><span class="ring r3"></span><span class="cdot"></span></div>
  <div class="checkbig"><svg class="ic" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5 10 18 19.5 6.5"/></svg></div>
  <h1>You're in</h1>
  <div class="sub" id="waitmsg">Waiting for the host to start the event…</div>
  <div class="waiting">This page will come alive by itself — keep it open.</div>
</div>

<div id="main" class="hidden" style="display:flex;flex-direction:column;flex:1;min-height:0">
  <div class="pane sel" id="pane-live">
    <div class="livehead">
      <div class="stagecard hidden" id="stagecard">
        <img id="stageimg" alt="Live stage">
        <span class="stagetag"><span class="ldot"></span>STAGE</span>
        <button class="stageexp" id="stageexpbtn" aria-label="Fullscreen"><svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg></button>
      </div>
      <button class="listen hidden" id="listenbtn"></button>
      <div class="small hidden" id="voicenote" style="margin-top:8px"></div>
    </div>
    <div class="waiting" id="livewait">Waiting for the talk…</div>
    <div id="segs"></div>
  </div>
  <div class="pane" id="pane-ask">
    <div class="notice hidden" id="prenotice"><b>The event hasn't started yet</b> — but the host has briefed me. Ask what it's about, who's speaking, or what to prepare.</div>
    <div class="notice" id="livenotice">Ask about anything being said — it answers for <b>you</b>. Or tap <b>Catch me up</b> if you just arrived.</div>
    <button class="btn btn2" style="margin:0 0 6px" id="catchup"><svg class="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 1.9"/></svg>Catch me up</button>
    <div id="chat"></div>
  </div>
  <div class="pane" id="pane-q">
    <div class="notice">Send a question to the speaker. Sitka first checks whether it was already answered.</div>
    <textarea id="qtext" rows="3" class="qta" placeholder="Your question for the speaker…"></textarea>
    <button class="btn" id="qsend">Check &amp; submit</button>
    <div id="qresult"></div>
  </div>
  <div class="pane" id="pane-take">
    <h1 style="font-size:19px">Your take-home pack</h1>
    <div class="sub" id="takewait">It will be ready when the event ends — or tap below for a snapshot now.</div>
    <button class="btn btn2" style="margin:0" id="takebtn">Get my pack</button>
    <div id="takebody"></div>
  </div>
  <div class="inputrow" id="askrow" style="display:none">
    <textarea id="asktext" rows="1" placeholder="Ask about this talk…"></textarea>
    <button class="send" id="asksend"><svg class="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button>
  </div>
  <div class="navwrap">
    <div class="tabs">
      <button class="tab sel" data-pane="live"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.4 18.6a9.4 9.4 0 0 1 0-13.2M18.6 5.4a9.4 9.4 0 0 1 0 13.2"/></svg><span>Live</span></button>
      <button class="tab" data-pane="ask"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.6 0-3.1-.4-4.4-1.2L3 20l1.2-5.1A8.5 8.5 0 1 1 21 11.5z"/></svg><span>Ask</span></button>
      <button class="tab" data-pane="q"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg><span>Speaker</span></button>
      <button class="tab" data-pane="take"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4.2L5.5 20.5v-16a1 1 0 0 1 1-1z"/></svg><span>Take-home</span></button>
    </div>
  </div>
</div>

<div id="stagefull" class="hidden">
  <img id="stagefullimg" alt="Live stage">
  <button class="xbtn" id="stageclose" aria-label="Close"><svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
</div>

<script>
var attId=null,persona=null,ended=false,myLang='English',listening=false;
var LANG_CODES={'English':'en','Shona':'sn','Ndebele':'nr','Swahili':'sw','French':'fr','Portuguese':'pt','Spanish':'es','German':'de','Arabic':'ar','Chinese':'zh','Hindi':'hi'};
function el(id){return document.getElementById(id)}
function ico(paths,size){return '<svg class="ic" width="'+(size||17)+'" height="'+(size||17)+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+paths+'</svg>'}
var IC_SPK='<path d="M11.5 5 7 9H3.5v6H7l4.5 4z"/><path d="M15 9.2a4 4 0 0 1 0 5.6M17.7 6.6a7.6 7.6 0 0 1 0 10.8"/>';
var IC_STOP='<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/>';
var IC_CHECK='<path d="M4.5 12.5 10 18 19.5 6.5"/>';

// ---------- markdown + timestamp chips (mirrors the desktop AiText renderer) ----------
var RE_FW=/【\\s*((?:[a-fA-F0-9]{6,}@)?\\d{1,2}:\\d{2}(?::\\d{2})?)\\s*】/g;
var RE_BR=/\\[{1,2}\\s*((?:[a-fA-F0-9]{6,}@)?\\d{1,2}:\\d{2}(?::\\d{2})?)\\s*\\]{1,2}/g;
var RE_CHIP=/\\[\\[((?:[a-fA-F0-9]{6,}@)?\\d{1,2}:\\d{2}(?::\\d{2})?)\\]\\]/g;
function normCites(t){return (t||'').replace(RE_FW,'[[$1]]').replace(RE_BR,'[[$1]]')}
function escH(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function parseTs(ts){
  var p=ts.split(':').map(Number);
  if(p.some(isNaN))return null;
  if(p.length===3)return p[0]*3600+p[1]*60+p[2];
  if(p.length===2)return p[0]*60+p[1];
  return null;
}
function inlineMd(s){
  s=s.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  s=s.replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>');
  s=s.replace(/(^|[^*])\\*([^*\\n]+)\\*/g,'$1<i>$2</i>');
  s=s.replace(RE_CHIP,function(_m,body){
    var at=body.indexOf('@');
    var label=at>=0?body.slice(at+1):body;
    var sec=parseTs(label);
    if(sec===null||at>=0)return label;
    return '<button class="tchip" data-s="'+sec+'">'+label+'</button>';
  });
  return s;
}
function rowCells(L){
  var t=L.trim();
  if(t.charAt(0)==='|')t=t.slice(1);
  if(t.charAt(t.length-1)==='|')t=t.slice(0,-1);
  return t.split('|').map(function(c){return c.trim()});
}
function md(src){
  var lines=escH(normCites(src)).split(/\\r?\\n/);
  var out=[],i=0,inCode=false,codeBuf=[],listType=null,listBuf=[],m;
  function flushList(){
    if(listType){out.push('<'+listType+'>'+listBuf.join('')+'</'+listType+'>');listType=null;listBuf=[]}
  }
  while(i<lines.length){
    var L=lines[i];
    if(/^\`\`\`/.test(L)){
      if(inCode){out.push('<pre><code>'+codeBuf.join('\\n')+'</code></pre>');codeBuf=[];inCode=false}
      else{flushList();inCode=true}
      i++;continue;
    }
    if(inCode){codeBuf.push(L);i++;continue}
    if(/^\\s*\\|/.test(L)&&i+1<lines.length&&/^\\s*\\|?[\\s:|-]+\\|?\\s*$/.test(lines[i+1])&&lines[i+1].indexOf('-')>=0){
      flushList();
      var head=rowCells(L),rows=[];
      i+=2;
      while(i<lines.length&&/^\\s*\\|/.test(lines[i])){rows.push(rowCells(lines[i]));i++}
      var h='<div class="tw"><table><thead><tr>'+head.map(function(c){return '<th>'+inlineMd(c)+'</th>'}).join('')+'</tr></thead><tbody>';
      h+=rows.map(function(r){return '<tr>'+r.map(function(c){return '<td>'+inlineMd(c)+'</td>'}).join('')+'</tr>'}).join('');
      out.push(h+'</tbody></table></div>');
      continue;
    }
    if(m=/^(#{1,6})\\s+(.*)$/.exec(L)){
      flushList();
      var lv=Math.min(m[1].length+1,4);
      out.push('<h'+lv+'>'+inlineMd(m[2])+'</h'+lv+'>');
      i++;continue;
    }
    if(m=/^\\s*[-*+]\\s+(.*)$/.exec(L)){
      if(listType!=='ul'){flushList();listType='ul'}
      listBuf.push('<li>'+inlineMd(m[1])+'</li>');
      i++;continue;
    }
    if(m=/^\\s*\\d+[.)]\\s+(.*)$/.exec(L)){
      if(listType!=='ol'){flushList();listType='ol'}
      listBuf.push('<li>'+inlineMd(m[1])+'</li>');
      i++;continue;
    }
    if(!L.trim()){flushList();i++;continue}
    flushList();
    out.push('<p>'+inlineMd(L)+'</p>');
    i++;
  }
  if(inCode)out.push('<pre><code>'+codeBuf.join('\\n')+'</code></pre>');
  flushList();
  return out.join('');
}
// Tapping a timestamp chip jumps the Live captions to that moment.
function jumpToTime(sec){
  document.querySelector('[data-pane=live]').click();
  setTimeout(function(){
    var segs=el('segs').children,best=null,i;
    for(i=0;i<segs.length;i++){
      var s=parseFloat(segs[i].dataset.s);
      if(!isNaN(s)&&s<=sec+0.5)best=segs[i];
    }
    if(!best&&segs.length)best=segs[0];
    if(!best)return;
    best.scrollIntoView({block:'center',behavior:'smooth'});
    best.classList.remove('flash');
    void best.offsetWidth;
    best.classList.add('flash');
  },60);
}
document.addEventListener('click',function(e){
  var t=e.target;
  while(t&&t!==document&&!(t.classList&&t.classList.contains('tchip')))t=t.parentNode;
  if(t&&t.classList&&t.classList.contains('tchip'))jumpToTime(parseFloat(t.dataset.s));
});

function setBadge(mode){
  var b=el('livebadge');
  if(mode==='live'){b.className='live on';b.innerHTML='<span class="ldot"></span>LIVE'}
  else if(mode==='soon'){b.className='live soon';b.innerHTML='<span class="ldot"></span>SOON'}
  else{b.className='live soon';b.textContent='ENDED'}
}
setBadge('soon');

// ---------- voice (Listen) ----------
// Voices load asynchronously on phones — cache them and refresh on the event.
var voiceList=[];
function refreshVoices(){if(window.speechSynthesis)voiceList=window.speechSynthesis.getVoices()||[]}
refreshVoices();
if(window.speechSynthesis)window.speechSynthesis.onvoiceschanged=refreshVoices;
function pickVoice(){
  var code=LANG_CODES[myLang]||'en';
  if(!voiceList.length)refreshVoices();
  var i;
  for(i=0;i<voiceList.length;i++){if(voiceList[i].lang&&voiceList[i].lang.toLowerCase().indexOf(code)===0&&voiceList[i].localService)return voiceList[i]}
  for(i=0;i<voiceList.length;i++){if(voiceList[i].lang&&voiceList[i].lang.toLowerCase().indexOf(code)===0)return voiceList[i]}
  return null;
}
// Own queue: speak one line at a time, drop backlog so audio stays near-live.
var speakQ=[],speakingNow=false;
function speakNext(){
  if(!listening||speakQ.length===0){speakingNow=false;return}
  speakingNow=true;
  var u=new SpeechSynthesisUtterance(speakQ.shift());
  var v=pickVoice();if(v)u.voice=v;
  u.lang=(v&&v.lang)||LANG_CODES[myLang]||'en';
  u.rate=1.05;
  u.onend=speakNext;u.onerror=speakNext;
  window.speechSynthesis.speak(u);
}
function speakText(text){
  if(!listening||!window.speechSynthesis||!text)return;
  speakQ.push(text);
  while(speakQ.length>3)speakQ.shift();
  if(!speakingNow)speakNext();
}
var resumeTimer=null;
function listenLabel(){
  var b=el('listenbtn');
  b.classList.toggle('on',listening);
  b.innerHTML=(listening?ico(IC_STOP):ico(IC_SPK))+'<span>'+(listening?'Stop listening':'Listen in '+myLang)+'</span>';
}
function setupListen(){
  var b=el('listenbtn');
  b.classList.remove('hidden');
  listenLabel();
  b.onclick=function(){
    if(!listening){
      if(!window.speechSynthesis){
        el('voicenote').textContent='This browser cannot speak — live captions only.';
        el('voicenote').classList.remove('hidden');
        return;
      }
      // Phones only allow speech that starts from a tap — unlock inside the gesture.
      var unlock=new SpeechSynthesisUtterance(' ');unlock.volume=0;
      window.speechSynthesis.cancel();window.speechSynthesis.speak(unlock);
      refreshVoices();
      listening=true;
      el('voicenote').textContent=pickVoice()
        ?'Speaking each new line in '+myLang+'.'
        :"Trying this device's "+myLang+" voice — if you hear nothing it isn't installed (captions still live).";
      el('voicenote').classList.remove('hidden');
      if(resumeTimer)clearInterval(resumeTimer);
      resumeTimer=setInterval(function(){if(listening&&window.speechSynthesis)window.speechSynthesis.resume()},5000);
    } else {
      listening=false;speakQ=[];speakingNow=false;
      if(resumeTimer){clearInterval(resumeTimer);resumeTimer=null}
      if(window.speechSynthesis)window.speechSynthesis.cancel();
      el('voicenote').classList.add('hidden');
    }
    listenLabel();
  };
}

// ---------- live stage view ----------
var stageTimer=null,stageSeen=false,stageBusy=false;
function pollStage(){
  if(stageBusy)return;stageBusy=true;
  fetch('/frame?t='+Date.now()).then(function(r){
    if(!r.ok)throw new Error('nf');
    return r.blob();
  }).then(function(b){
    var u=URL.createObjectURL(b);
    var img=el('stageimg');
    var old=img.dataset.u;
    img.src=u;el('stagefullimg').src=u;img.dataset.u=u;
    if(old)URL.revokeObjectURL(old);
    if(!stageSeen){stageSeen=true;el('stagecard').classList.remove('hidden')}
  }).catch(function(){
    if(stageSeen){stageSeen=false;el('stagecard').classList.add('hidden');el('stagefull').classList.add('hidden')}
  }).then(function(){stageBusy=false});
}
function startStage(){if(!stageTimer){pollStage();stageTimer=setInterval(pollStage,2500)}}
function stopStage(){if(stageTimer){clearInterval(stageTimer);stageTimer=null}}
el('stageexpbtn').onclick=function(e){e.stopPropagation();el('stagefull').classList.remove('hidden')};
el('stageimg').onclick=function(){el('stagefull').classList.remove('hidden')};
el('stageclose').onclick=function(){el('stagefull').classList.add('hidden')};
el('stagefull').onclick=function(e){if(e.target===el('stagefull')||e.target===el('stagefullimg'))el('stagefull').classList.add('hidden')};

// ---------- join ----------
var personas=['Student','Business owner','Investor','Developer','Expert','Just curious'];
var pwrap=el('personas');
personas.forEach(function(p){var b=document.createElement('button');b.className='chip';b.textContent=p;b.onclick=function(){persona=p;[].forEach.call(pwrap.children,function(c){c.classList.remove('sel')});b.classList.add('sel')};pwrap.appendChild(b)});
function post(path,body){return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json()})}

el('joinbtn').onclick=function(){
  var lang=el('lang').value;
  myLang=lang;
  el('joinbtn').disabled=true;
  post('/join',{persona:persona||'Curious attendee',lang:lang}).then(function(r){
    attId=r.attendeeId;
    el('join').classList.add('hidden');
    el('wait').classList.remove('hidden');
    connect();
  }).catch(function(){el('joinbtn').disabled=false;alert('Could not join — check the Wi-Fi and try again.')});
};

function goLiveView(){
  el('wait').classList.add('hidden');
  el('main').classList.remove('hidden');
  el('prenotice').classList.add('hidden');
  el('livenotice').classList.remove('hidden');
  el('catchup').classList.remove('hidden');
  [].forEach.call(document.querySelectorAll('.tab'),function(t){t.classList.remove('off')});
  startStage();
}
function goPreView(){
  // Event not started, but the host allows Q&A on their materials.
  el('wait').classList.add('hidden');
  el('main').classList.remove('hidden');
  el('prenotice').classList.remove('hidden');
  el('livenotice').classList.add('hidden');
  el('catchup').classList.add('hidden');
  [].forEach.call(document.querySelectorAll('.tab'),function(t){
    if(t.dataset.pane!=='ask')t.classList.add('off');
  });
  document.querySelector('[data-pane=ask]').click();
}
function connect(){
  var es=new EventSource('/events?att='+attId);
  es.addEventListener('init',function(e){
    var d=JSON.parse(e.data);
    if(d.voice&&d.voice.active){setupListen()}
    if(d.waiting){
      setBadge('soon');
      if(d.startsAt){var dt=new Date(d.startsAt);el('waitmsg').textContent='Starts around '+dt.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+' — waiting for the host…'}
      if(d.preChat){goPreView()}
    } else {
      setBadge('live');
      goLiveView();addSegs(d.segments);if(d.ended)onEnded();
    }
  });
  es.addEventListener('live',function(){
    setBadge('live');
    goLiveView();
    document.querySelector('[data-pane=live]').click();
  });
  es.addEventListener('segments',function(e){goLiveView();addSegs(JSON.parse(e.data))});
  es.addEventListener('ended',onEnded);
}
function addSegs(items){
  if(!items||!items.length)return;
  el('livewait').style.display='none';
  var wrap=el('segs');
  items.forEach(function(s){
    var d=document.createElement('div');d.className='seg';
    d.dataset.s=s.s;
    d.innerHTML='<span class="ts"></span><span class="segtext"></span>';
    d.children[0].textContent=s.t;d.children[1].textContent=s.text;
    wrap.appendChild(d);
    speakText(s.text);
  });
  var pane=el('pane-live');
  if(pane.classList.contains('sel'))pane.scrollTop=pane.scrollHeight;
}
function onEnded(){
  ended=true;setBadge('ended');stopStage();
  el('takewait').textContent='The event has ended — grab your personalized pack below.';
}

[].forEach.call(document.querySelectorAll('.tab'),function(t){
  t.onclick=function(){
    [].forEach.call(document.querySelectorAll('.tab'),function(x){x.classList.remove('sel')});
    [].forEach.call(document.querySelectorAll('.pane'),function(x){x.classList.remove('sel')});
    t.classList.add('sel');
    el('pane-'+t.dataset.pane).classList.add('sel');
    el('askrow').style.display=t.dataset.pane==='ask'?'flex':'none';
    if(t.dataset.pane==='live'){var p=el('pane-live');p.scrollTop=p.scrollHeight}
  };
});

function bubble(cls,text){var d=document.createElement('div');d.className=cls;d.textContent=text;el('chat').appendChild(d);el('pane-ask').scrollTop=el('pane-ask').scrollHeight;return d}
function aiBubble(text){var d=document.createElement('div');d.className='bub-a md';d.innerHTML=md(text);el('chat').appendChild(d);el('pane-ask').scrollTop=el('pane-ask').scrollHeight;return d}
var busy=false;
function ask(q){
  if(busy||!q.trim())return;
  busy=true;bubble('bub-u',q);
  var t=bubble('typing','Sitka is thinking…');
  post('/ask',{attendeeId:attId,question:q}).then(function(r){
    t.remove();
    if(r.answer)aiBubble(r.answer);else bubble('notice err',r.error||'Something went wrong.');
  }).catch(function(){t.remove();bubble('notice err','Connection problem — try again.')})
  .then(function(){busy=false});
}
el('asksend').onclick=function(){var v=el('asktext').value;el('asktext').value='';ask(v)};
el('asktext').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();el('asksend').click()}});
el('catchup').onclick=function(){
  if(busy)return;busy=true;
  var t=bubble('typing','Catching you up…');
  post('/catchup',{attendeeId:attId}).then(function(r){t.remove();if(r.answer)aiBubble(r.answer);else bubble('notice err',r.error||'Try again shortly.')})
  .catch(function(){t.remove();bubble('notice err','Connection problem — try again.')})
  .then(function(){busy=false});
  document.querySelector('[data-pane=ask]').click();
};

el('qsend').onclick=function(){submitQuestion(false)};
function submitQuestion(force){
  var text=el('qtext').value;if(!text.trim())return;
  el('qsend').disabled=true;el('qresult').innerHTML='<div class="waiting">Checking…</div>';
  post('/question',{attendeeId:attId,text:text,force:force}).then(function(r){
    el('qsend').disabled=false;
    if(r.alreadyAnswered){
      el('qresult').innerHTML='';
      var d=document.createElement('div');d.className='qbox';
      d.innerHTML='<b>The speaker covered this at '+r.alreadyAnswered.at+'</b><div class="segtext"></div><button class="btn btn2" style="margin-top:10px" id="forceq">Submit anyway</button>';
      d.querySelector('.segtext').textContent=r.alreadyAnswered.answer;
      el('qresult').appendChild(d);
      d.querySelector('#forceq').onclick=function(){submitQuestion(true)};
    } else if(r.submitted){
      el('qtext').value='';
      el('qresult').innerHTML='';
      var ok=document.createElement('div');ok.className='qbox';
      ok.innerHTML='<b>'+ico(IC_CHECK,15)+'Sent to the host</b><div class="small"></div>';
      ok.querySelector('.small').textContent='Submitted as: “'+r.refined+'”';
      el('qresult').appendChild(ok);
    } else {
      el('qresult').innerHTML='<div class="notice err">'+(r.error||'Could not submit.')+'</div>';
    }
  }).catch(function(){el('qsend').disabled=false;el('qresult').innerHTML='<div class="notice err">Connection problem — try again.</div>'});
}

el('takebtn').onclick=function(){
  el('takebtn').disabled=true;el('takebody').innerHTML='<div class="waiting">Preparing your pack…</div>';
  fetch('/pack?att='+attId).then(function(r){return r.json()}).then(function(p){
    el('takebtn').disabled=false;
    if(p.error){el('takebody').innerHTML='<div class="notice err">'+p.error+'</div>';return}
    var h='<div class="tkcard"><h2>Summary</h2><div class="segtext md">'+md(p.summary)+'</div></div>';
    if(p.takeaways&&p.takeaways.length){h+='<div class="tkcard"><h2>Key takeaways</h2><ul class="md">'+p.takeaways.map(function(t){return '<li>'+inlineMd(escH(normCites(t)))+'</li>'}).join('')+'</ul></div>'}
    if(p.moments&&p.moments.length){h+='<div class="tkcard"><h2>Key moments</h2><ul class="md">'+p.moments.map(function(t){return '<li>'+inlineMd(escH(normCites(t)))+'</li>'}).join('')+'</ul></div>'}
    if(p.myChat&&p.myChat.length){h+='<div class="tkcard"><h2>Your questions</h2>'+p.myChat.map(function(m){return m.role==='user'?'<div class="bub-u">'+esc(m.content)+'</div>':'<div class="bub-a md">'+md(m.content)+'</div>'}).join('')+'</div>'}
    el('takebody').innerHTML=h;
  }).catch(function(){el('takebtn').disabled=false;el('takebody').innerHTML='<div class="notice err">Connection problem — try again.</div>'});
};
function esc(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML}
</script>
</body>
</html>`
}
