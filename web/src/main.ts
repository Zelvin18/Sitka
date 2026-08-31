import { createClient } from '@supabase/supabase-js'
import './style.css'

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const sb = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } })

// ---------- event id from /e/<id> or ?e=<id> ----------
const pathMatch = /\/e\/([^/?#]+)/.exec(location.pathname)
const eventId = pathMatch ? pathMatch[1] : new URLSearchParams(location.search).get('e') || ''

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement

interface EventRow {
  id: string
  title: string
  status: 'waiting' | 'live' | 'ended'
  starts_at: string | null
  pre_event_chat: boolean
  materials_present: boolean
  live_voice: { enabled: boolean; languages: string[] }
}
interface SegRow {
  idx: number
  start_sec: number
  label: string
  text: string
}

let ev: EventRow | null = null
let attId: string | null = null
let persona: string | null = null
let myLang = 'English'
let joined = false
let listening = false

const LANG_CODES: Record<string, string> = {
  English: 'en', Shona: 'sn', Ndebele: 'nr', Swahili: 'sw', French: 'fr',
  Portuguese: 'pt', Spanish: 'es', German: 'de', Arabic: 'ar', Chinese: 'zh', Hindi: 'hi'
}

// ---------- markdown + timestamp chips (same renderer as the desktop app) ----------
const RE_FW = /【\s*((?:[a-fA-F0-9]{6,}@)?\d{1,2}:\d{2}(?::\d{2})?)\s*】/g
const RE_BR = /\[{1,2}\s*((?:[a-fA-F0-9]{6,}@)?\d{1,2}:\d{2}(?::\d{2})?)\s*\]{1,2}/g
const RE_CHIP = /\[\[((?:[a-fA-F0-9]{6,}@)?\d{1,2}:\d{2}(?::\d{2})?)\]\]/g
const normCites = (t: string): string => (t || '').replace(RE_FW, '[[$1]]').replace(RE_BR, '[[$1]]')
const escH = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function parseTs(ts: string): number | null {
  const p = ts.split(':').map(Number)
  if (p.some(isNaN)) return null
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2]
  if (p.length === 2) return p[0] * 60 + p[1]
  return null
}
function inlineMd(s: string): string {
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
  s = s.replace(RE_CHIP, (_m, body: string) => {
    const at = body.indexOf('@')
    const label = at >= 0 ? body.slice(at + 1) : body
    const sec = parseTs(label)
    if (sec === null || at >= 0) return label
    return `<button class="tchip" data-s="${sec}">${label}</button>`
  })
  return s
}
function rowCells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map((c) => c.trim())
}
function md(src: string): string {
  const lines = escH(normCites(src)).split(/\r?\n/)
  const out: string[] = []
  let i = 0
  let inCode = false
  let codeBuf: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let listBuf: string[] = []
  const flushList = (): void => {
    if (listType) {
      out.push(`<${listType}>${listBuf.join('')}</${listType}>`)
      listType = null
      listBuf = []
    }
  }
  while (i < lines.length) {
    const L = lines[i]
    if (/^```/.test(L)) {
      if (inCode) {
        out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`)
        codeBuf = []
        inCode = false
      } else {
        flushList()
        inCode = true
      }
      i++
      continue
    }
    if (inCode) {
      codeBuf.push(L)
      i++
      continue
    }
    if (
      /^\s*\|/.test(L) &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) &&
      lines[i + 1].includes('-')
    ) {
      flushList()
      const head = rowCells(L)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(rowCells(lines[i]))
        i++
      }
      out.push(
        `<div class="tw"><table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>'
      )
      continue
    }
    let m = /^(#{1,6})\s+(.*)$/.exec(L)
    if (m) {
      flushList()
      const lv = Math.min(m[1].length + 1, 4)
      out.push(`<h${lv}>${inlineMd(m[2])}</h${lv}>`)
      i++
      continue
    }
    m = /^\s*[-*+]\s+(.*)$/.exec(L)
    if (m) {
      if (listType !== 'ul') {
        flushList()
        listType = 'ul'
      }
      listBuf.push(`<li>${inlineMd(m[1])}</li>`)
      i++
      continue
    }
    m = /^\s*\d+[.)]\s+(.*)$/.exec(L)
    if (m) {
      if (listType !== 'ol') {
        flushList()
        listType = 'ol'
      }
      listBuf.push(`<li>${inlineMd(m[1])}</li>`)
      i++
      continue
    }
    if (!L.trim()) {
      flushList()
      i++
      continue
    }
    flushList()
    out.push(`<p>${inlineMd(L)}</p>`)
    i++
  }
  if (inCode) out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`)
  flushList()
  return out.join('')
}
function jumpToTime(sec: number): void {
  ;(document.querySelector('[data-pane=live]') as HTMLElement).click()
  setTimeout(() => {
    const segs = el('segs').children
    let best: Element | null = null
    for (let i = 0; i < segs.length; i++) {
      const s = parseFloat((segs[i] as HTMLElement).dataset.s || '')
      if (!isNaN(s) && s <= sec + 0.5) best = segs[i]
    }
    if (!best && segs.length) best = segs[0]
    if (!best) return
    best.scrollIntoView({ block: 'center', behavior: 'smooth' })
    best.classList.remove('flash')
    void (best as HTMLElement).offsetWidth
    best.classList.add('flash')
  }, 60)
}
document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest?.('.tchip') as HTMLElement | null
  if (t) jumpToTime(parseFloat(t.dataset.s || '0'))
})

// ---------- voice (Listen) ----------
let voiceList: SpeechSynthesisVoice[] = []
const refreshVoices = (): void => {
  if (window.speechSynthesis) voiceList = window.speechSynthesis.getVoices() || []
}
refreshVoices()
if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = refreshVoices
function pickVoice(): SpeechSynthesisVoice | null {
  const code = LANG_CODES[myLang] || 'en'
  if (!voiceList.length) refreshVoices()
  return (
    voiceList.find((v) => v.lang?.toLowerCase().startsWith(code) && v.localService) ??
    voiceList.find((v) => v.lang?.toLowerCase().startsWith(code)) ??
    null
  )
}
let speakQ: string[] = []
let speakingNow = false
function speakNext(): void {
  if (!listening || speakQ.length === 0) {
    speakingNow = false
    return
  }
  speakingNow = true
  const u = new SpeechSynthesisUtterance(speakQ.shift())
  const v = pickVoice()
  if (v) u.voice = v
  u.lang = v?.lang || LANG_CODES[myLang] || 'en'
  u.rate = 1.05
  u.onend = speakNext
  u.onerror = speakNext
  window.speechSynthesis.speak(u)
}
function speakText(text: string): void {
  if (!listening || !window.speechSynthesis || !text) return
  speakQ.push(text)
  while (speakQ.length > 3) speakQ.shift()
  if (!speakingNow) speakNext()
}
let resumeTimer: number | null = null
function listenLabel(): void {
  const b = el('listenbtn')
  b.classList.toggle('on', listening)
  const icon = listening
    ? '<svg class="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/></svg>'
    : '<svg class="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 5 7 9H3.5v6H7l4.5 4z"/><path d="M15 9.2a4 4 0 0 1 0 5.6M17.7 6.6a7.6 7.6 0 0 1 0 10.8"/></svg>'
  b.innerHTML = icon + '<span>' + (listening ? 'Stop listening' : 'Listen in ' + myLang) + '</span>'
}
function setupListen(): void {
  const vc = ev?.live_voice
  const active =
    !!vc?.enabled && (myLang.toLowerCase() === 'english' || (vc.languages || []).includes(myLang))
  if (!active) return
  const b = el('listenbtn')
  b.classList.remove('hidden')
  listenLabel()
  b.onclick = () => {
    if (!listening) {
      if (!window.speechSynthesis) {
        el('voicenote').textContent = 'This browser cannot speak — live captions only.'
        el('voicenote').classList.remove('hidden')
        return
      }
      const unlock = new SpeechSynthesisUtterance(' ')
      unlock.volume = 0
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(unlock)
      refreshVoices()
      listening = true
      el('voicenote').textContent = pickVoice()
        ? 'Speaking each new line in ' + myLang + '.'
        : "Trying this device's " + myLang + " voice — if you hear nothing it isn't installed (captions still live)."
      el('voicenote').classList.remove('hidden')
      if (resumeTimer) clearInterval(resumeTimer)
      resumeTimer = window.setInterval(() => {
        if (listening && window.speechSynthesis) window.speechSynthesis.resume()
      }, 5000)
    } else {
      listening = false
      speakQ = []
      speakingNow = false
      if (resumeTimer) {
        clearInterval(resumeTimer)
        resumeTimer = null
      }
      if (window.speechSynthesis) window.speechSynthesis.cancel()
      el('voicenote').classList.add('hidden')
    }
    listenLabel()
  }
}

// ---------- badge / views ----------
function setBadge(mode: 'live' | 'soon' | 'ended'): void {
  const b = el('livebadge')
  if (mode === 'live') {
    b.className = 'live on'
    b.innerHTML = '<span class="ldot"></span>LIVE'
  } else if (mode === 'soon') {
    b.className = 'live soon'
    b.innerHTML = '<span class="ldot"></span>SOON'
  } else {
    b.className = 'live soon'
    b.textContent = 'ENDED'
  }
}

const translatedForMe = (): boolean => {
  const vc = ev?.live_voice
  return (
    myLang.toLowerCase() !== 'english' && !!vc?.enabled && (vc.languages || []).includes(myLang)
  )
}

// ---------- captions ----------
const segEls = new Map<number, HTMLElement>()
function upsertSeg(row: SegRow, translated?: string): void {
  el('livewait').style.display = 'none'
  const existing = segEls.get(row.idx)
  if (existing) {
    if (translated) (existing.children[1] as HTMLElement).textContent = translated
    return
  }
  const d = document.createElement('div')
  d.className = 'seg'
  d.dataset.s = String(row.start_sec)
  d.innerHTML = '<span class="ts"></span><span class="segtext"></span>'
  ;(d.children[0] as HTMLElement).textContent = row.label
  ;(d.children[1] as HTMLElement).textContent = translated ?? row.text
  // keep transcript ordered by idx even when rows arrive out of order
  const wrap = el('segs')
  let before: HTMLElement | null = null
  for (const [idx, node] of segEls) {
    if (idx > row.idx && (!before || idx < Number(before.dataset.i))) before = node
  }
  d.dataset.i = String(row.idx)
  if (before) wrap.insertBefore(d, before)
  else wrap.appendChild(d)
  segEls.set(row.idx, d)
  const pane = el('pane-live')
  if (pane.classList.contains('sel')) pane.scrollTop = pane.scrollHeight
  // English listeners speak originals; translated listeners speak on translation arrival
  if (!translatedForMe()) speakText(row.text)
  else if (translated) speakText(translated)
}
function applyTranslation(idx: number, text: string): void {
  const node = segEls.get(idx)
  if (node) {
    ;(node.children[1] as HTMLElement).textContent = text
    speakText(text)
  } else {
    pendingTranslations.set(idx, text)
  }
}
const pendingTranslations = new Map<number, string>()

// ---------- stage view ----------
let stageTimer: number | null = null
let stageSeen = false
let stageBusy = false
const stageUrl = (): string =>
  `${SUPA_URL}/storage/v1/object/public/stage/${eventId}.jpg`
function pollStage(): void {
  if (stageBusy) return
  stageBusy = true
  fetch(stageUrl() + '?t=' + Date.now())
    .then((r) => {
      if (!r.ok) throw new Error('nf')
      return r.blob()
    })
    .then((b) => {
      const u = URL.createObjectURL(b)
      const img = el('stageimg') as HTMLImageElement
      const old = img.dataset.u
      img.src = u
      ;(el('stagefullimg') as HTMLImageElement).src = u
      img.dataset.u = u
      if (old) URL.revokeObjectURL(old)
      if (!stageSeen) {
        stageSeen = true
        el('stagecard').classList.remove('hidden')
      }
    })
    .catch(() => {
      if (stageSeen) {
        stageSeen = false
        el('stagecard').classList.add('hidden')
        el('stagefull').classList.add('hidden')
      }
    })
    .then(() => {
      stageBusy = false
    })
}
function startStage(): void {
  if (!stageTimer) {
    pollStage()
    stageTimer = window.setInterval(pollStage, 2500)
  }
}
function stopStage(): void {
  if (stageTimer) {
    clearInterval(stageTimer)
    stageTimer = null
  }
}
el('stageexpbtn').onclick = (e) => {
  e.stopPropagation()
  el('stagefull').classList.remove('hidden')
}
el('stageimg').onclick = () => el('stagefull').classList.remove('hidden')
el('stageclose').onclick = () => el('stagefull').classList.add('hidden')
el('stagefull').onclick = (e) => {
  if (e.target === el('stagefull') || e.target === el('stagefullimg'))
    el('stagefull').classList.add('hidden')
}

// ---------- save this moment (one tap: caption + slide snapshot) ----------
interface Moment {
  t: string
  text: string
  img: string | null
  at: number
}
const momKey = 'sitka-moments-' + eventId
let moments: Moment[] = []
try {
  moments = JSON.parse(localStorage.getItem(momKey) || '[]') as Moment[]
} catch {
  moments = []
}
function persistMoments(): void {
  try {
    localStorage.setItem(momKey, JSON.stringify(moments.slice(-40)))
  } catch {
    /* storage full/private mode — moments stay in memory */
  }
}
function lastCaption(): { t: string; text: string } | null {
  const w = el('segs')
  const d = w.lastElementChild as HTMLElement | null
  if (!d) return null
  return {
    t: (d.children[0] as HTMLElement).textContent || '',
    text: (d.children[1] as HTMLElement).textContent || ''
  }
}
function stageSnap(): string | null {
  if (!stageSeen) return null
  try {
    const img = el('stageimg') as HTMLImageElement
    const w = Math.min(640, img.naturalWidth || 640)
    const h = Math.round((w * (img.naturalHeight || 360)) / (img.naturalWidth || 640))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.getContext('2d')?.drawImage(img, 0, 0, w, h)
    return c.toDataURL('image/jpeg', 0.6)
  } catch {
    return null
  }
}
el('savebtn').onclick = () => {
  const cap = lastCaption()
  moments.push({
    t: cap?.t || '',
    text: cap?.text || '(moment saved before the talk began)',
    img: stageSnap(),
    at: Date.now()
  })
  persistMoments()
  const span = el('savebtn').querySelector('span')
  if (span) {
    span.textContent = 'Saved — it will be in your pack'
    setTimeout(() => {
      span.textContent = 'Save this moment'
    }, 1600)
  }
}

// ---------- tappable captions: explain / define / why-for-me ----------
let sheetSeg: { t: string; text: string } | null = null
el('segs').addEventListener('click', (e) => {
  const d = (e.target as HTMLElement).closest?.('.seg') as HTMLElement | null
  if (!d) return
  sheetSeg = {
    t: (d.children[0] as HTMLElement).textContent || '',
    text: (d.children[1] as HTMLElement).textContent || ''
  }
  el('sheetquote').textContent = '[' + sheetSeg.t + '] ' + sheetSeg.text
  el('sheetwrap').classList.remove('hidden')
})
el('sheetwrap').onclick = (e) => {
  if (e.target === el('sheetwrap')) el('sheetwrap').classList.add('hidden')
}
function sheetAsk(prefix: string): void {
  if (!sheetSeg) return
  el('sheetwrap').classList.add('hidden')
  ;(document.querySelector('[data-pane=ask]') as HTMLElement).click()
  ask(prefix + ' — the speaker just said: "' + sheetSeg.text + '" (at ' + sheetSeg.t + ')')
}
el('sh-explain').onclick = () => sheetAsk('Explain this simply')
el('sh-define').onclick = () => sheetAsk('Define the technical terms in this')
el('sh-why').onclick = () => sheetAsk('Why does this matter for someone like me?')

// ---------- wake lock (screen stays on during the live talk) ----------
let wakeLock: { release: () => Promise<void> } | null = null
async function keepAwake(): Promise<void> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<never> } }
    if (nav.wakeLock) wakeLock = await nav.wakeLock.request('screen')
  } catch {
    /* not supported / denied — fine */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ev?.status === 'live') void keepAwake()
})

// ---------- view transitions ----------
function goLiveView(): void {
  el('wait').classList.add('hidden')
  el('main').classList.remove('hidden')
  el('prenotice').classList.add('hidden')
  el('livenotice').classList.remove('hidden')
  el('catchup').classList.remove('hidden')
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('off'))
  el('savebtn').classList.remove('hidden')
  startStage()
  void keepAwake()
}
function goPreView(): void {
  el('wait').classList.add('hidden')
  el('main').classList.remove('hidden')
  el('prenotice').classList.remove('hidden')
  el('livenotice').classList.add('hidden')
  el('catchup').classList.add('hidden')
  document.querySelectorAll('.tab').forEach((t) => {
    if ((t as HTMLElement).dataset.pane !== 'ask') t.classList.add('off')
  })
  ;(document.querySelector('[data-pane=ask]') as HTMLElement).click()
}
function onEnded(): void {
  setBadge('ended')
  stopStage()
  el('takewait').textContent = 'The event has ended — grab your personalized pack below.'
}
function applyEventState(): void {
  if (!ev || !joined) return
  if (ev.status === 'live') {
    setBadge('live')
    goLiveView()
  } else if (ev.status === 'ended') {
    el('wait').classList.add('hidden')
    el('main').classList.remove('hidden')
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('off'))
    onEnded()
  } else {
    setBadge('soon')
    if (ev.starts_at) {
      const dt = new Date(ev.starts_at)
      el('waitmsg').textContent =
        'Starts around ' +
        dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) +
        ' — waiting for the host…'
    }
    if (ev.materials_present && ev.pre_event_chat) goPreView()
  }
}

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((t) => {
  ;(t as HTMLElement).onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('sel'))
    document.querySelectorAll('.pane').forEach((x) => x.classList.remove('sel'))
    t.classList.add('sel')
    const pane = (t as HTMLElement).dataset.pane
    el('pane-' + pane).classList.add('sel')
    el('askrow').style.display = pane === 'ask' ? 'flex' : 'none'
    if (pane === 'live') {
      const p = el('pane-live')
      p.scrollTop = p.scrollHeight
    }
  }
})

// ---------- ask / chat ----------
function bubble(cls: string, text: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  d.textContent = text
  el('chat').appendChild(d)
  el('pane-ask').scrollTop = el('pane-ask').scrollHeight
  return d
}
function aiBubble(text: string): HTMLElement {
  const d = document.createElement('div')
  d.className = 'bub-a md'
  d.innerHTML = md(text)
  el('chat').appendChild(d)
  el('pane-ask').scrollTop = el('pane-ask').scrollHeight
  return d
}

const pendingAsks = new Map<string, { typing: HTMLElement; onAnswer?: (a: string) => void }>()
function resolveAsk(id: string, status: string, answer: string | null): void {
  const p = pendingAsks.get(id)
  if (!p) return
  pendingAsks.delete(id)
  p.typing.remove()
  if (p.onAnswer) {
    p.onAnswer(status === 'answered' && answer ? answer : '')
    return
  }
  if (status === 'answered' && answer) aiBubble(answer)
  else bubble('notice err', answer || 'Something went wrong — try again.')
}
async function submitAsk(
  kind: 'ask' | 'catchup' | 'pack',
  question: string,
  typing: HTMLElement,
  onAnswer?: (a: string) => void
): Promise<void> {
  const id = crypto.randomUUID()
  pendingAsks.set(id, { typing, onAnswer })
  const { error } = await sb.from('asks').insert({
    id,
    event_id: eventId,
    attendee_id: attId,
    kind,
    question,
    status: 'pending'
  })
  if (error) {
    resolveAsk(id, 'error', 'Connection problem — try again.')
    return
  }
  // fallback poll in case the realtime update is missed
  let tries = 0
  const poll = window.setInterval(async () => {
    if (!pendingAsks.has(id) || ++tries > 36) {
      clearInterval(poll)
      if (pendingAsks.has(id)) resolveAsk(id, 'error', 'No answer arrived — is the host app running?')
      return
    }
    const { data } = await sb.from('asks').select('status,answer').eq('id', id).single()
    if (data && data.status !== 'pending') {
      clearInterval(poll)
      resolveAsk(id, data.status, data.answer)
    }
  }, 5000)
}

let busy = false
function ask(q: string): void {
  if (busy || !q.trim() || !attId) return
  busy = true
  bubble('bub-u', q)
  const typing = bubble('typing', 'Sitka is thinking…')
  void submitAsk('ask', q.slice(0, 600), typing).finally(() => {
    busy = false
  })
}
;(el('asksend') as HTMLButtonElement).onclick = () => {
  const v = (el('asktext') as HTMLTextAreaElement).value
  ;(el('asktext') as HTMLTextAreaElement).value = ''
  ask(v)
}
el('asktext').addEventListener('keydown', (e) => {
  const ke = e as KeyboardEvent
  if (ke.key === 'Enter' && !ke.shiftKey) {
    e.preventDefault()
    ;(el('asksend') as HTMLButtonElement).click()
  }
})
el('catchup').onclick = () => {
  if (busy || !attId) return
  busy = true
  const typing = bubble('typing', 'Catching you up…')
  void submitAsk('catchup', '', typing).finally(() => {
    busy = false
  })
  ;(document.querySelector('[data-pane=ask]') as HTMLElement).click()
}

// ---------- speaker questions ----------
const pendingQs = new Set<string>()
function renderQuestionResult(row: {
  id: string
  status: string
  refined: string | null
  answered_at_label: string | null
  answer: string | null
  text: string
}): void {
  if (!pendingQs.has(row.id)) return
  if (row.status === 'checking') return
  pendingQs.delete(row.id)
  ;(el('qsend') as HTMLButtonElement).disabled = false
  el('qresult').innerHTML = ''
  if (row.status === 'already_answered' && row.answer) {
    const d = document.createElement('div')
    d.className = 'qbox'
    d.innerHTML =
      '<b>The speaker covered this at ' +
      escH(row.answered_at_label || '') +
      '</b><div class="segtext"></div><button class="btn btn2" style="margin-top:10px" id="forceq">Submit anyway</button>'
    ;(d.querySelector('.segtext') as HTMLElement).textContent = row.answer
    el('qresult').appendChild(d)
    ;(d.querySelector('#forceq') as HTMLButtonElement).onclick = () =>
      submitQuestion(row.text, true)
  } else if (row.status === 'submitted') {
    ;(el('qtext') as HTMLTextAreaElement).value = ''
    const ok = document.createElement('div')
    ok.className = 'qbox'
    ok.innerHTML =
      '<b><svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5 10 18 19.5 6.5"/></svg>Sent to the host</b><div class="small"></div>'
    ;(ok.querySelector('.small') as HTMLElement).textContent =
      'Submitted as: “' + (row.refined || row.text) + '”'
    el('qresult').appendChild(ok)
  } else {
    el('qresult').innerHTML = '<div class="notice err">Could not submit — try again.</div>'
  }
}
function submitQuestion(text: string, force: boolean): void {
  if (!text.trim() || !attId) return
  ;(el('qsend') as HTMLButtonElement).disabled = true
  el('qresult').innerHTML = '<div class="waiting">Checking…</div>'
  const id = crypto.randomUUID()
  pendingQs.add(id)
  void sb
    .from('speaker_questions')
    .insert({
      id,
      event_id: eventId,
      attendee_id: attId,
      text: text.slice(0, 500),
      force,
      status: 'checking'
    })
    .then(({ error }) => {
      if (error) {
        pendingQs.delete(id)
        ;(el('qsend') as HTMLButtonElement).disabled = false
        el('qresult').innerHTML = '<div class="notice err">Connection problem — try again.</div>'
        return
      }
      let tries = 0
      const poll = window.setInterval(async () => {
        if (!pendingQs.has(id) || ++tries > 24) {
          clearInterval(poll)
          if (pendingQs.has(id)) {
            pendingQs.delete(id)
            ;(el('qsend') as HTMLButtonElement).disabled = false
            el('qresult').innerHTML =
              '<div class="notice err">No response — is the host app running?</div>'
          }
          return
        }
        const { data } = await sb.from('speaker_questions').select('*').eq('id', id).single()
        if (data && data.status !== 'checking') {
          clearInterval(poll)
          renderQuestionResult(data)
        }
      }, 5000)
    })
}
;(el('qsend') as HTMLButtonElement).onclick = () =>
  submitQuestion((el('qtext') as HTMLTextAreaElement).value, false)

// ---------- take-home pack ----------
interface Pack {
  summary?: string
  takeaways?: string[]
  moments?: string[]
}
const myChat: { role: string; content: string }[] = []
;(el('takebtn') as HTMLButtonElement).onclick = () => {
  if (!attId) return
  ;(el('takebtn') as HTMLButtonElement).disabled = true
  el('takebody').innerHTML = '<div class="waiting">Preparing your pack…</div>'
  const typing = document.createElement('div') // invisible placeholder
  void submitAsk('pack', '', typing, (answer) => {
    ;(el('takebtn') as HTMLButtonElement).disabled = false
    if (!answer) {
      el('takebody').innerHTML = '<div class="notice err">Could not build the pack — try again.</div>'
      return
    }
    let p: Pack = {}
    try {
      p = JSON.parse(answer) as Pack
    } catch {
      p = { summary: answer }
    }
    let h = ''
    if (moments.length > 0) {
      h += `<div class="tkcard"><h2>My saved moments</h2>${moments
        .map(
          (m) =>
            `<div class="mom">${m.img ? `<img src="${m.img}" alt="Saved slide">` : ''}<div><span class="ts">${escH(m.t)}</span> <span class="segtext">${escH(m.text)}</span></div></div>`
        )
        .join('')}</div>`
    }
    h += `<div class="tkcard"><h2>Summary</h2><div class="segtext md">${md(p.summary || '')}</div></div>`
    if (p.takeaways?.length)
      h += `<div class="tkcard"><h2>Key takeaways</h2><ul class="md">${p.takeaways.map((t) => `<li>${inlineMd(escH(normCites(t)))}</li>`).join('')}</ul></div>`
    if (p.moments?.length)
      h += `<div class="tkcard"><h2>Key moments</h2><ul class="md">${p.moments.map((t) => `<li>${inlineMd(escH(normCites(t)))}</li>`).join('')}</ul></div>`
    if (myChat.length)
      h += `<div class="tkcard"><h2>Your questions</h2>${myChat
        .map((m) =>
          m.role === 'user'
            ? `<div class="bub-u">${escH(m.content)}</div>`
            : `<div class="bub-a md">${md(m.content)}</div>`
        )
        .join('')}</div>`
    el('takebody').innerHTML = h
  })
}

// ---------- join + realtime ----------
const personas = ['Student', 'Business owner', 'Investor', 'Developer', 'Expert', 'Just curious']
const pwrap = el('personas')
personas.forEach((p) => {
  const b = document.createElement('button')
  b.className = 'chip'
  b.textContent = p
  b.onclick = () => {
    persona = p
    Array.from(pwrap.children).forEach((c) => c.classList.remove('sel'))
    b.classList.add('sel')
  }
  pwrap.appendChild(b)
})

const storeKey = 'sitka-att-' + eventId
async function join(newJoin: boolean): Promise<void> {
  if (newJoin) {
    attId = crypto.randomUUID()
    const { error } = await sb.from('attendees').insert({
      id: attId,
      event_id: eventId,
      persona: persona || 'Curious attendee',
      lang: myLang
    })
    if (error) {
      ;(el('joinbtn') as HTMLButtonElement).disabled = false
      alert('Could not join — check your connection and try again.')
      return
    }
    try {
      localStorage.setItem(storeKey, JSON.stringify({ id: attId, persona, lang: myLang }))
    } catch {
      /* private mode */
    }
  }
  joined = true
  el('join').classList.add('hidden')
  el('loading').classList.add('hidden')
  el('wait').classList.remove('hidden')
  setupListen()

  // history: restore my previous Q&A after a refresh
  const { data: prevAsks } = await sb
    .from('asks')
    .select('kind,question,answer,status')
    .eq('attendee_id', attId)
    .eq('kind', 'ask')
    .order('created_at', { ascending: true })
  for (const a of prevAsks ?? []) {
    if (a.status !== 'answered' || !a.answer) continue
    bubble('bub-u', a.question)
    aiBubble(a.answer)
    myChat.push({ role: 'user', content: a.question }, { role: 'assistant', content: a.answer })
  }

  // live data: subscribe first, then load the backlog (dedupe by idx)
  const wantTrans = translatedForMe()
  sb.channel('ev-' + eventId)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'segments', filter: 'event_id=eq.' + eventId },
      (payload) => {
        const row = payload.new as SegRow
        upsertSeg(row, pendingTranslations.get(row.idx))
        pendingTranslations.delete(row.idx)
      }
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'translations', filter: 'event_id=eq.' + eventId },
      (payload) => {
        const row = payload.new as { lang: string; idx: number; text: string }
        if (wantTrans && row.lang === myLang) applyTranslation(row.idx, row.text)
      }
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'events', filter: 'id=eq.' + eventId },
      (payload) => {
        ev = payload.new as EventRow
        applyEventState()
      }
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'asks', filter: 'attendee_id=eq.' + attId },
      (payload) => {
        const row = payload.new as { id: string; kind: string; question: string; status: string; answer: string | null }
        if (row.kind === 'ask' && row.status === 'answered' && row.answer) {
          myChat.push({ role: 'user', content: row.question }, { role: 'assistant', content: row.answer })
        }
        resolveAsk(row.id, row.status, row.answer)
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'speaker_questions',
        filter: 'attendee_id=eq.' + attId
      },
      (payload) => {
        renderQuestionResult(payload.new as Parameters<typeof renderQuestionResult>[0])
      }
    )
    .subscribe()

  const { data: segRows } = await sb
    .from('segments')
    .select('idx,start_sec,label,text')
    .eq('event_id', eventId)
    .order('idx', { ascending: true })
  let transMap = new Map<number, string>()
  if (wantTrans) {
    const { data: tr } = await sb
      .from('translations')
      .select('idx,text')
      .eq('event_id', eventId)
      .eq('lang', myLang)
    transMap = new Map((tr ?? []).map((r) => [r.idx as number, r.text as string]))
  }
  const wasListening = listening
  listening = false // don't speak the whole backlog
  for (const row of segRows ?? []) upsertSeg(row as SegRow, transMap.get((row as SegRow).idx))
  listening = wasListening

  applyEventState()
}

;(el('joinbtn') as HTMLButtonElement).onclick = () => {
  myLang = (el('lang') as HTMLSelectElement).value
  ;(el('joinbtn') as HTMLButtonElement).disabled = true
  void join(true)
}

// ---------- boot ----------
async function boot(): Promise<void> {
  if (!eventId) {
    el('loading').classList.add('hidden')
    el('notfound').classList.remove('hidden')
    return
  }
  const { data } = await sb.from('events').select('*').eq('id', eventId).single()
  if (!data) {
    el('loading').classList.add('hidden')
    el('notfound').classList.remove('hidden')
    return
  }
  ev = data as EventRow
  el('evtitle').textContent = ev.title
  document.title = ev.title + ' — Sitka Live'
  setBadge(ev.status === 'live' ? 'live' : ev.status === 'ended' ? 'ended' : 'soon')

  let saved: { id: string; persona: string | null; lang: string } | null = null
  try {
    saved = JSON.parse(localStorage.getItem(storeKey) || 'null')
  } catch {
    /* ignore */
  }
  if (saved?.id) {
    attId = saved.id
    persona = saved.persona
    myLang = saved.lang || 'English'
    el('loading').classList.add('hidden')
    void join(false)
  } else {
    el('loading').classList.add('hidden')
    el('join').classList.remove('hidden')
  }
}
void boot()
