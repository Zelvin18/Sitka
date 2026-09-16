/**
 * A PowerPoint file from a deck, with no dependencies: the OOXML parts a
 * .pptx needs, written by hand and packed with the ZIP writer. Each slide is
 * drawn as shapes and text boxes in one of the five deck styles from pdf.ts,
 * so the PowerPoint looks like the PDF and the web page of the same deck.
 * Speaker notes go into proper notes pages.
 */
import { deckTemplate, toHex, type DeckTemplate, type PdfSlide } from './pdf'
import { zip, type ZipEntry } from './zip'
import { deckDesign, pointMark, type Paint, type Shape } from '@shared/deckDesign'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// 16:9, in EMU (914400 per inch)
const SW = 12192000
const SH = 6858000
const IN = 914400

const NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const clr = (c: [number, number, number]): string => toHex(c).slice(1).toUpperCase()

/** a filled shape: a rectangle or an ellipse, solid or translucent */
function shape(id: number, name: string, kind: 'rect' | 'ellipse', x: number, y: number, w: number, h: number, fill: string, alpha = 1): string {
  const a = alpha < 1 ? `<a:alpha val="${Math.round(alpha * 100000)}"/>` : ''
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm><a:prstGeom prst="${kind}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}">${a}</a:srgbClr></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`
}
/** a filled rectangle */
function rect(id: number, name: string, x: number, y: number, w: number, h: number, fill: string): string {
  return shape(id, name, 'rect', x, y, w, h, fill)
}
/** the colour a design's paint names, in this style */
function paintOf(t: DeckTemplate, paint: Paint): string {
  switch (paint) {
    case 'accent':
      return clr(t.accent)
    case 'ink':
      return clr(t.ink)
    case 'bg':
      return clr(t.bg)
    case 'titleBg':
      return clr(t.titleBg)
    case 'titleInk':
      return clr(t.titleInk)
    case 'muted':
      return clr(t.muted)
    case 'white':
      return 'FFFFFF'
    default:
      return '000000'
  }
}
/** the design's shapes for a slide, drawn behind everything else */
function decorations(t: DeckTemplate, list: Shape[], from: number): { xml: string; next: number } {
  let id = from
  const xml = list
    .map((s, k) => {
      const fill = paintOf(t, s.paint)
      if (s.kind === 'circle') {
        const r = (s.r ?? 0.1) * SH
        return shape(id++, `Shape ${k + 1}`, 'ellipse', s.x * SW - r, s.y * SH - r, r * 2, r * 2, fill, s.alpha)
      }
      return shape(id++, `Shape ${k + 1}`, 'rect', s.x * SW, s.y * SH, (s.w ?? 0) * SW, (s.h ?? 0) * SH, fill, s.alpha)
    })
    .join('')
  return { xml, next: id }
}

interface Para {
  text: string
  size: number
  bold?: boolean
  color: string
  font: string
  bullet?: string
  bulletColor?: string
  spaceBefore?: number
  align?: 'l' | 'ctr'
  /** a short run set before the text in the accent colour, e.g. "01" */
  lead?: { text: string; color: string }
}

/** a text box holding paragraphs */
function textBox(id: number, name: string, x: number, y: number, w: number, h: number, paras: Para[], anchor: 't' | 'ctr' | 'b' = 't'): string {
  const body = paras
    .map((p) => {
      const bullet = p.bullet
        ? `<a:pPr marL="342900" indent="-342900" algn="${p.align ?? 'l'}"${p.spaceBefore ? ` ><a:spcBef><a:spcPts val="${p.spaceBefore * 100}"/></a:spcBef` : ''}><a:buClr><a:srgbClr val="${p.bulletColor ?? p.color}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="${esc(p.bullet)}"/></a:pPr>`
        : `<a:pPr algn="${p.align ?? 'l'}">${p.spaceBefore ? `<a:spcBef><a:spcPts val="${p.spaceBefore * 100}"/></a:spcBef>` : ''}</a:pPr>`
      // the bold marks of the markdown become real bold runs
      const runs = p.text.split(/\*\*/).map((t, i) => ({ t, b: i % 2 === 1 }))
      const lead = p.lead
        ? `<a:r><a:rPr lang="en-US" sz="${Math.round(p.size * 100)}" b="1" dirty="0"><a:solidFill><a:srgbClr val="${p.lead.color}"/></a:solidFill><a:latin typeface="${p.font}"/><a:cs typeface="${p.font}"/></a:rPr><a:t>${esc(p.lead.text)}  </a:t></a:r>`
        : ''
      const rs =
        lead +
        runs
          .filter((r) => r.t)
          .map(
            (r) =>
              `<a:r><a:rPr lang="en-US" sz="${Math.round(p.size * 100)}"${p.bold || r.b ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${p.color}"/></a:solidFill><a:latin typeface="${p.font}"/><a:cs typeface="${p.font}"/></a:rPr><a:t>${esc(r.t)}</a:t></a:r>`
          )
          .join('')
      return `<a:p>${bullet}${rs}</a:p>`
    })
    .join('')
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`
}

function slideXml(t: DeckTemplate, s: PdfSlide, index: number, total: number, subtitle?: string, deckTitle?: string): string {
  const font = t.serif ? 'Georgia' : 'Calibri'
  const design = deckDesign(t.id)
  const shapes: string[] = []
  let id = 2
  const bg = index === 0 ? clr(t.titleBg) : clr(t.bg)
  const m = 0.7 * IN
  // the design's shapes go on first; the words sit over them
  const deco = decorations(t, index === 0 ? design.title : design.content, id)
  shapes.push(deco.xml)
  id = deco.next
  if (index === 0) {
    const sub = subtitle ?? s.bullets[0] ?? ''
    const light = t.id === 'midnight' ? clr(t.muted) : 'FFFFFF'
    if (t.id === 'bold') {
      // the title on the panel, the subtitle beside it
      const panelW = SW * 0.45
      shapes.push(textBox(id++, 'Title', 0.6 * IN, 0.8 * IN, panelW - 1.2 * IN, SH * 0.82 - 1.4 * IN, [{ text: s.title, size: s.title.length > 40 ? 34 : 44, bold: true, color: 'FFFFFF', font }], 'ctr'))
      shapes.push(textBox(id++, 'Foot', 0.6 * IN, SH * 0.84, panelW - 1.2 * IN, SH * 0.12, [{ text: (deckTitle ?? s.title).toUpperCase(), size: 11, bold: true, color: 'FFFFFF', font }], 'ctr'))
      if (sub) shapes.push(textBox(id++, 'Subtitle', panelW + 0.7 * IN, SH * 0.36, SW - panelW - 1.4 * IN, SH * 0.3, [{ text: sub, size: 20, color: clr(t.ink), font }], 'ctr'))
    } else {
      shapes.push(
        textBox(id++, 'Title', m, SH * 0.3, SW - m * 2 - (t.id === 'mono' ? 2.5 * IN : 0), SH * 0.36, [{ text: s.title, size: s.title.length > 40 ? 40 : 52, bold: true, color: clr(t.titleInk), font }], 'b')
      )
      if (sub) shapes.push(textBox(id++, 'Subtitle', m, SH * 0.68, SW - m * 2, SH * 0.14, [{ text: sub, size: 18, color: light, font }], 't'))
      if (t.bar !== 'none') shapes.push(rect(id++, 'Mark', m, SH * 0.66, 0.7 * IN, 0.05 * IN, t.id === 'midnight' ? clr(t.accent) : t.id === 'mono' ? clr(t.titleInk) : 'FFFFFF'))
    }
  } else {
    const titleColor = t.id === 'ocean' ? 'FFFFFF' : clr(t.ink)
    const ink = clr(t.ink)
    const accent = clr(t.accent)
    const mark = (k: number): Pick<Para, 'bullet' | 'bulletColor' | 'lead'> =>
      design.marker === 'number'
        ? { lead: { text: pointMark('number', k, t.bullet), color: accent } }
        : { bullet: pointMark(design.marker, k, t.bullet), bulletColor: accent }
    const bullets = (size: number): Para[] => s.bullets.map((b, k) => ({ text: b, size, color: ink, font, spaceBefore: 10, ...mark(k) }))
    if (t.slide === 'split') {
      const panelW = SW * 0.36
      shapes.push(textBox(id++, 'Title', 0.5 * IN, 0.6 * IN, panelW - IN, SH * 0.86 - 1.2 * IN, [{ text: s.title, size: 30, bold: true, color: 'FFFFFF', font }], 'ctr'))
      shapes.push(textBox(id++, 'Panel number', 0.5 * IN, SH * 0.87, panelW - IN, SH * 0.12, [{ text: String(index).padStart(2, '0'), size: 20, bold: true, color: 'FFFFFF', font }], 'ctr'))
      shapes.push(textBox(id++, 'Body', panelW + 0.6 * IN, 0.8 * IN, SW - panelW - m - 0.6 * IN, SH - 1.6 * IN, bullets(20), 'ctr'))
    } else if (t.slide === 'number') {
      if (t.bar === 'left') shapes.push(rect(id++, 'Bar', 0, 0, 0.14 * IN, SH, accent))
      shapes.push(textBox(id++, 'Big number', SW - m - 4.2 * IN, 0.2 * IN, 4.2 * IN, 3.2 * IN, [{ text: String(index).padStart(2, '0'), size: 150, bold: true, color: '2A2A2E', font, align: 'ctr' }], 't'))
      const left = m + 0.2 * IN
      shapes.push(textBox(id++, 'Title', left, 0.55 * IN, SW - left - m - 4 * IN, 1.3 * IN, [{ text: s.title, size: s.title.length > 50 ? 26 : 32, bold: true, color: titleColor, font }], 'b'))
      shapes.push(textBox(id++, 'Body', left, 2.25 * IN, SW - left - m, SH - 2.25 * IN - 0.8 * IN, bullets(20), 't'))
    } else if (t.slide === 'cards') {
      // the title in the band at the head; the points on cards beneath
      const left = m
      shapes.push(textBox(id++, 'Title', left, 0.25 * IN, SW - left - m, SH * 0.2 - 0.5 * IN, [{ text: s.title, size: s.title.length > 50 ? 24 : 30, bold: true, color: titleColor, font }], 'ctr'))
      const cols = s.bullets.length > 1 ? 2 : 1
      const gap = 0.2 * IN
      const top = SH * 0.2 + 0.45 * IN
      const cardW = (SW - left - m - gap * (cols - 1)) / cols
      const rows = Math.ceil(s.bullets.length / cols)
      const cardH = Math.min(1.5 * IN, (SH - top - 0.7 * IN - gap * (rows - 1)) / Math.max(1, rows))
      s.bullets.forEach((b, k) => {
        const x = left + (k % cols) * (cardW + gap)
        const y = top + Math.floor(k / cols) * (cardH + gap)
        shapes.push(rect(id++, `Card ${k + 1}`, x, y, cardW, cardH, 'EDF2F8'))
        shapes.push(rect(id++, `Card bar ${k + 1}`, x, y, 0.06 * IN, cardH, accent))
        shapes.push(textBox(id++, `Card text ${k + 1}`, x + 0.25 * IN, y + 0.15 * IN, cardW - 0.45 * IN, cardH - 0.3 * IN, [{ text: b, size: 16, color: ink, font }], 'ctr'))
      })
    } else if (t.slide === 'centered') {
      shapes.push(textBox(id++, 'Title', SW * 0.1, 0.7 * IN, SW * 0.8, 1.5 * IN, [{ text: s.title, size: s.title.length > 50 ? 26 : 32, bold: true, color: titleColor, font, align: 'ctr' }], 'b'))
      shapes.push(rect(id++, 'Rule', SW / 2 - 0.35 * IN, 2.3 * IN, 0.7 * IN, 0.04 * IN, accent))
      shapes.push(textBox(id++, 'Body', SW * 0.15, 2.6 * IN, SW * 0.7, SH - 2.6 * IN - 0.8 * IN, s.bullets.map((b) => ({ text: b, size: 19, color: ink, font, align: 'ctr' as const, spaceBefore: 12 })), 't'))
    } else {
      // Studio: a black square carrying the number, the title beside it
      const tile = 0.85 * IN
      const left = m
      if (design.numberTile) {
        shapes.push(rect(id++, 'Number tile', left, 0.55 * IN, tile, tile, ink))
        shapes.push(textBox(id++, 'Number', left, 0.55 * IN, tile, tile, [{ text: String(index).padStart(2, '0'), size: 22, bold: true, color: clr(t.bg), font, align: 'ctr' }], 'ctr'))
      }
      const tx = design.numberTile ? left + tile + 0.3 * IN : left
      shapes.push(textBox(id++, 'Title', tx, 0.55 * IN, SW - tx - m, tile, [{ text: s.title, size: s.title.length > 50 ? 24 : 30, bold: true, color: titleColor, font }], 'ctr'))
      shapes.push(textBox(id++, 'Body', left, 1.85 * IN, SW - left - m, SH * 0.88 - 1.85 * IN - 0.2 * IN, bullets(20), 't'))
      if (design.footer) shapes.push(textBox(id++, 'Footer', left, SH * 0.895, SW * 0.6, 0.35 * IN, [{ text: (deckTitle ?? '').toUpperCase(), size: 9, bold: true, color: clr(t.muted), font }], 'ctr'))
    }
    if (t.numbered) shapes.push(textBox(id++, 'Number', SW - m - 1.5 * IN, SH - 0.55 * IN, 1.5 * IN, 0.35 * IN, [{ text: `${index} / ${total - 1}`, size: 10, color: t.id === 'bold' ? ink : clr(t.muted), font, align: 'ctr' }], 'ctr'))
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS_P}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

function notesXml(n: number, text: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes ${NS_P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder ${n}"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder ${n}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(text)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`
}

const THEME = (name: string, font: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${name}"><a:themeElements><a:clrScheme name="Sitka"><a:dk1><a:srgbClr val="111113"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="2F5BFF"/></a:accent1><a:accent2><a:srgbClr val="1F9D55"/></a:accent2><a:accent3><a:srgbClr val="FF4F1F"/></a:accent3><a:accent4><a:srgbClr val="0B2A4A"/></a:accent4><a:accent5><a:srgbClr val="C2603D"/></a:accent5><a:accent6><a:srgbClr val="6E6E76"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Sitka"><a:majorFont><a:latin typeface="${font}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${font}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

const TX_STYLES = `<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600" algn="l"><a:buChar char="•"/><a:defRPr sz="2000"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles>`

const MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${NS_P}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>${TX_STYLES}</p:sldMaster>`

const LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${NS_P} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`

const NOTES_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster ${NS_P}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1143000" y="685800"/><a:ext cx="4572000" cy="2571750"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4343400"/><a:ext cx="5486400" cy="4114800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`

const rels = (items: { id: string; type: string; target: string }[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map((r) => `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${r.type}" Target="${r.target}"/>`)
    .join('')}</Relationships>`

/** The .pptx bytes for a deck. */
export function deckToPptx(title: string, subtitle: string | undefined, slides: PdfSlide[], templateId?: string | null): Uint8Array {
  const t = deckTemplate(templateId)
  const font = t.serif ? 'Georgia' : 'Calibri'
  const entries: ZipEntry[] = []
  const n = slides.length
  const withNotes = slides.map((s, i) => Boolean(s.notes && s.notes.trim()) && i >= 0)

  const types = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
  ]
  for (let i = 1; i <= n; i++) {
    types.push(`<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    if (withNotes[i - 1]) types.push(`<Override PartName="/ppt/notesSlides/notesSlide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`)
  }
  entries.push({ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${types.join('')}</Types>` })
  entries.push({
    name: '_rels/.rels',
    data: rels([
      { id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' },
      { id: 'rId2', type: 'metadata/core-properties', target: 'docProps/core.xml' },
      { id: 'rId3', type: 'extended-properties', target: 'docProps/app.xml' }
    ]).replace('officeDocument/2006/relationships/metadata/core-properties', 'package/2006/relationships/metadata/core-properties')
  })
  const now = new Date().toISOString()
  entries.push({
    name: 'docProps/core.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>Sitka</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
  })
  entries.push({
    name: 'docProps/app.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Sitka</Application><Slides>${n}</Slides></Properties>`
  })

  // the presentation and its parts
  const slideIds = slides.map((_s, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join('')
  entries.push({
    name: 'ppt/presentation.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation ${NS_P} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="${SW}" cy="${SH}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>`
  })
  entries.push({
    name: 'ppt/_rels/presentation.xml.rels',
    data: rels([
      { id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
      { id: 'rId2', type: 'notesMaster', target: 'notesMasters/notesMaster1.xml' },
      { id: 'rId3', type: 'theme', target: 'theme/theme1.xml' },
      ...slides.map((_s, i) => ({ id: `rId${10 + i}`, type: 'slide', target: `slides/slide${i + 1}.xml` }))
    ])
  })
  entries.push({ name: 'ppt/theme/theme1.xml', data: THEME('Sitka', font) })
  entries.push({ name: 'ppt/theme/theme2.xml', data: THEME('Sitka notes', font) })
  entries.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: MASTER })
  entries.push({
    name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    data: rels([
      { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: 'theme', target: '../theme/theme1.xml' }
    ])
  })
  entries.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: LAYOUT })
  entries.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]) })
  entries.push({ name: 'ppt/notesMasters/notesMaster1.xml', data: NOTES_MASTER })
  entries.push({ name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: rels([{ id: 'rId1', type: 'theme', target: '../theme/theme2.xml' }]) })

  slides.forEach((s, i) => {
    const k = i + 1
    entries.push({ name: `ppt/slides/slide${k}.xml`, data: slideXml(t, s, i, n, subtitle, title) })
    const r = [{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }]
    if (withNotes[i]) {
      r.push({ id: 'rId2', type: 'notesSlide', target: `../notesSlides/notesSlide${k}.xml` })
      entries.push({ name: `ppt/notesSlides/notesSlide${k}.xml`, data: notesXml(k, s.notes ?? '') })
      entries.push({
        name: `ppt/notesSlides/_rels/notesSlide${k}.xml.rels`,
        data: rels([
          { id: 'rId1', type: 'notesMaster', target: '../notesMasters/notesMaster1.xml' },
          { id: 'rId2', type: 'slide', target: `../slides/slide${k}.xml` }
        ])
      })
    }
    entries.push({ name: `ppt/slides/_rels/slide${k}.xml.rels`, data: rels(r) })
  })
  return zip(entries)
}
