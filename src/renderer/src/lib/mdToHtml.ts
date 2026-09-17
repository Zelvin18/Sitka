/**
 * Small Markdown → HTML converter for exports (Word, PDF, standalone pages).
 * Covers what Sitca writes: headings, paragraphs, bullets, numbered lists,
 * tables, fenced code, bold, italic, inline code and links.
 */
import { deckTemplate, docTemplate, toHex } from './pdf'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(s: string): string {
  let out = esc(s)
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
  // [[M:SS]] citations become plain timestamps outside the app
  out = out.replace(/\[\[(?:[a-fA-F0-9-]{6,}@)?(\d{1,2}:\d{2}(?::\d{2})?)\]\]/g, '($1)')
  return out
}

export function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null
  let table: string[][] | null = null
  let code: { lang: string; lines: string[] } | null = null

  const flushPara = (): void => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const flushList = (): void => {
    if (list) out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`)
    list = null
  }
  const flushTable = (): void => {
    if (table && table.length) {
      const [head, ...rows] = table
      out.push(
        '<table><thead><tr>' +
          head.map((c) => `<th>${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>'
      )
    }
    table = null
  }
  const flushAll = (): void => {
    flushPara()
    flushList()
    flushTable()
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (code) {
      if (/^```/.test(line)) {
        out.push(`<pre><code class="lang-${esc(code.lang)}">${esc(code.lines.join('\n'))}</code></pre>`)
        code = null
      } else code.lines.push(raw)
      continue
    }
    const fence = line.match(/^```\s*([\w+-]*)/)
    if (fence) {
      flushAll()
      code = { lang: fence[1] || '', lines: [] }
      continue
    }
    if (!line.trim()) {
      flushAll()
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.+)$/)
    if (h) {
      flushAll()
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara()
      flushList()
      if (/^\s*\|?\s*:?-{2,}/.test(line)) continue // separator row
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
      if (!table) table = []
      table.push(cells)
      continue
    }
    const ul = line.match(/^\s*[-*•]\s+(.+)$/)
    if (ul) {
      flushPara()
      flushTable()
      if (!list || list.type !== 'ul') {
        flushList()
        list = { type: 'ul', items: [] }
      }
      list.items.push(ul[1])
      continue
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (ol) {
      flushPara()
      flushTable()
      if (!list || list.type !== 'ol') {
        flushList()
        list = { type: 'ol', items: [] }
      }
      list.items.push(ol[1])
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushAll()
      out.push('<hr>')
      continue
    }
    flushList()
    flushTable()
    para.push(line.trim())
  }
  flushAll()
  if (code) out.push(`<pre><code>${esc((code as { lines: string[] }).lines.join('\n'))}</code></pre>`)
  return out.join('\n')
}

/** A complete, printable HTML page around a document body. */
export function documentPage(title: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font-family:Georgia,'Times New Roman',serif;max-width:720px;margin:48px auto;padding:0 24px;color:#1a1a1c;line-height:1.55;font-size:15px}
h1{font-family:Inter,-apple-system,'Segoe UI',sans-serif;font-size:28px;letter-spacing:-.02em;margin:0 0 18px}
h2{font-family:Inter,-apple-system,'Segoe UI',sans-serif;font-size:18px;margin:28px 0 8px}
h3{font-family:Inter,-apple-system,'Segoe UI',sans-serif;font-size:15px;margin:20px 0 6px}
p{margin:0 0 10px}ul,ol{margin:0 0 10px;padding-left:22px}li{margin:2px 0}
table{border-collapse:collapse;margin:8px 0 14px;width:100%;font-size:14px}th,td{border:1px solid #d8d8d4;padding:6px 9px;text-align:left}th{background:#f4f4f2}
code{font-family:Consolas,Menlo,monospace;font-size:13px;background:#f2f2f0;padding:1px 4px;border-radius:3px}
pre{background:#f4f4f2;padding:12px 14px;border-radius:6px;overflow:auto}pre code{background:none;padding:0}
hr{border:none;border-top:1px solid #d8d8d4;margin:20px 0}
@media print{body{margin:0;max-width:none}}
</style></head><body>${bodyHtml}</body></html>`
}

/** Word opens HTML saved with a .doc extension as a normal document; the style sets its faces and colours. */
export function wordDocument(title: string, bodyHtml: string, templateId?: string | null): string {
  const t = docTemplate(templateId)
  const font = t.serif ? 'Georgia,"Times New Roman",serif' : 'Calibri,Arial,sans-serif'
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${esc(title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>body{font-family:${font};font-size:11pt;line-height:1.45;color:${toHex(t.ink)}}h1{font-size:22pt;color:${toHex(t.ink)}}h2{font-size:14pt;margin-top:16pt;color:${toHex(t.accent)}${t.caps ? ';text-transform:uppercase;letter-spacing:.06em;font-size:11pt' : ''}}h3{font-size:12pt}table{border-collapse:collapse}th{background:${toHex(t.tableHead)};color:${toHex(t.accent)}}th,td{border:1px solid ${toHex(t.rule)};padding:4pt 6pt}blockquote{border-left:3pt solid ${toHex(t.accent)};margin:8pt 0;padding-left:10pt;color:${toHex(t.muted)}}</style>
</head><body><h1>${esc(title)}</h1>${bodyHtml}</body></html>`
}

export interface DeckSlideLike {
  title: string
  bullets: string[]
  notes?: string
}

/** A self-contained slide deck in its style: arrow keys, click, or swipe; prints one slide per page. */
export function deckPage(title: string, subtitle: string | undefined, slides: DeckSlideLike[], templateId?: string | null): string {
  const t = deckTemplate(templateId)
  const font = t.serif ? 'Georgia,"Times New Roman",serif' : "Inter,-apple-system,'Segoe UI',sans-serif"
  const slideHtml = slides
    .map(
      (s, i) => `<section class="slide${i === 0 ? ' title' : ` lay-${t.slide}`}">
  <div class="n">${i + 1} / ${slides.length}</div>
  ${i > 0 && t.slide === 'number' ? `<div class="big">${String(i).padStart(2, '0')}</div>` : ''}
  <div class="head"><h1>${esc(s.title)}</h1>${i === 0 && subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}</div>
  ${s.bullets.length ? `<ul>${s.bullets.map((b) => `<li>${inline(b)}</li>`).join('')}</ul>` : ''}
  ${s.notes ? `<aside class="notes">${esc(s.notes)}</aside>` : ''}
</section>`
    )
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:${toHex(t.bg)};color:${toHex(t.ink)};font-family:${font}}
.slide{display:none;position:relative;width:100vw;height:100vh;padding:7vh 9vw;flex-direction:column;justify-content:center;background:${toHex(t.bg)}}
.slide.on{display:flex}
.slide.title{background:${toHex(t.titleBg)};color:${toHex(t.titleInk)}}
${t.bar === 'left' ? `.slide:not(.title){border-left:14px solid ${toHex(t.accent)}}` : t.bar === 'top' ? `.slide:not(.title){border-top:14px solid ${toHex(t.accent)}}` : ''}
.slide h1{font-size:clamp(28px,5.2vw,64px);letter-spacing:-.03em;margin:0 0 4vh;line-height:1.05;color:${t.id === 'ocean' ? toHex(t.accent) : 'inherit'}}
${t.bar === 'under' ? `.slide:not(.title) h1::after{content:'';display:block;width:64px;height:4px;background:${toHex(t.accent)};margin-top:2vh}` : ''}
.slide.title h1{font-size:clamp(36px,7vw,92px);color:inherit}
.sub{font-size:clamp(16px,2.2vw,28px);color:${t.id === 'midnight' ? toHex(t.muted) : 'inherit'};opacity:.85;margin:0}
ul{margin:0;padding-left:1.2em;font-size:clamp(17px,2.4vw,32px);line-height:1.45;list-style:none}li{margin:.35em 0;position:relative}li::before{content:'${t.bullet}';position:absolute;left:-1.2em;color:${toHex(t.accent)}}
.n{position:absolute;right:3vw;bottom:3vh;font-size:14px;color:${toHex(t.muted)}}
/* the layouts */
.lay-split{flex-direction:row;padding:0;align-items:stretch}
.lay-split .head{flex:0 0 36%;background:${toHex(t.accent)};color:#fff;display:flex;align-items:center;padding:6vh 4vw}
.lay-split .head h1{color:#fff;margin:0;font-size:clamp(26px,3.6vw,48px)}
.lay-split ul{flex:1;display:flex;flex-direction:column;justify-content:center;padding:6vh 6vw 6vh 8vw;margin:0}
.lay-number .big{position:absolute;right:4vw;top:2vh;font-size:clamp(120px,24vw,340px);font-weight:800;line-height:1;color:rgba(255,255,255,.07);letter-spacing:-.04em;pointer-events:none}
.lay-cards ul{display:grid;grid-template-columns:1fr 1fr;gap:1.6vw;padding:0;font-size:clamp(15px,1.9vw,24px)}
.lay-cards li{margin:0;padding:2.4vh 2vw 2.4vh 2.6vw;background:rgba(11,61,110,.07);border-radius:14px;border-left:6px solid ${toHex(t.accent)}}
.lay-cards li::before{content:none}
.lay-centered{align-items:center;text-align:center}
.lay-centered h1{text-align:center}
.lay-centered h1::after{margin:2vh auto 0}
.lay-centered ul{padding:0;max-width:70vw}
.lay-centered li{padding:0}.lay-centered li::before{content:none}
.notes{display:none}
.brand{position:absolute;left:3vw;bottom:3vh;font-size:13px;color:#6e6e76;letter-spacing:.12em;text-transform:uppercase}
@media print{html,body{background:#fff;color:#111}.slide{display:flex;page-break-after:always;height:100vh}.sub,.n,.brand{color:#666}.notes{display:block;margin-top:auto;font-size:12px;color:#555;border-top:1px solid #ddd;padding-top:8px}}
</style></head><body>
${slideHtml}
<div class="brand">Made with Sitca</div>
<script>
var i=0,s=document.querySelectorAll('.slide');function show(k){i=Math.max(0,Math.min(s.length-1,k));s.forEach(function(el,j){el.classList.toggle('on',j===i)})}
show(0);document.addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key===' '||e.key==='PageDown')show(i+1);if(e.key==='ArrowLeft'||e.key==='PageUp')show(i-1);if(e.key==='Home')show(0);if(e.key==='End')show(s.length-1)});
document.addEventListener('click',function(e){show(e.clientX>innerWidth/2?i+1:i-1)});
var x0=null;document.addEventListener('touchstart',function(e){x0=e.touches[0].clientX});document.addEventListener('touchend',function(e){if(x0===null)return;var dx=e.changedTouches[0].clientX-x0;if(Math.abs(dx)>40)show(dx<0?i+1:i-1);x0=null});
</script></body></html>`
}
