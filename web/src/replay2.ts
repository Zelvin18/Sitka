/**
 * Recap, second take. Same data as /r/<id>, a different page: a dark stage
 * with the recording, chapters that fill as it plays, the summary as a lead,
 * the words as paragraphs lit while they are spoken, and Sitka in a dock.
 */
import { createClient } from '@supabase/supabase-js'
import { md, parseTs as parseChipTs } from './mdlite'
import { fixWebmDuration } from '../../src/shared/webmDuration'
import { installFocusGuard } from '../../src/shared/focusGuard'

installFocusGuard()

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const sb = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } })

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const m = /\/r2\/([^/?#]+)/.exec(location.pathname)
const pageId = m ? m[1] : ''

// ---------- shapes ----------
interface Line {
  sec: number
  text: string
}
interface Loaded {
  title: string
  dateIso: string | null
  durationMs: number
  summary: string
  highlights: { time: string; label: string }[]
  notes: string
  lines: Line[]
  owner: string | null
  sessionId: string
  video: 'public' | 'parts' | null
  kindWord: string
  materials: string
  live: boolean
}

const fmt = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0 ? `${h}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`
}
const fmtLen = (ms: number): string => {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${Math.max(1, min)} min`
  const h = Math.floor(min / 60)
  const r = min % 60
  return r ? `${h} hr ${r} min` : `${h} hr`
}
const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ---------- loading ----------
async function loadEvent(): Promise<Loaded | null> {
  const { data } = await sb
    .from('events')
    .select('title,replay,starts_at,owner,session_id,materials_text,status')
    .eq('id', pageId)
    .single()
  const r = (data?.replay ?? null) as {
    enabled?: boolean
    title?: string
    summary?: string
    highlights?: { time: string; label: string }[]
    durationMs?: number
    video?: boolean | 'parts'
  } | null
  if (!data || !r?.enabled) return null
  const { data: segs } = await sb
    .from('segments')
    .select('idx,start_sec,text')
    .eq('event_id', pageId)
    .order('idx', { ascending: true })
  const lines = ((segs ?? []) as { start_sec: number; text: string }[])
    .map((s) => ({ sec: Number(s.start_sec), text: String(s.text || '').trim() }))
    .filter((l) => l.text && !/^[\s.。…,\-–—]*$/.test(l.text))
  return {
    title: r.title || (data.title as string) || 'Event recap',
    dateIso: (data.starts_at as string) || null,
    durationMs: r.durationMs || 0,
    summary: r.summary || '',
    highlights: r.highlights || [],
    notes: '',
    lines,
    owner: (data.owner as string) || null,
    sessionId: (data.session_id as string) || '',
    video: r.video === true ? 'public' : r.video === 'parts' ? 'parts' : null,
    kindWord: 'live event',
    materials: ((data.materials_text as string) || '').slice(0, 10000),
    live: data.status === 'live'
  }
}

async function loadRecap(): Promise<Loaded | null> {
  const { data } = await sb.from('recaps').select('*').eq('id', pageId).single()
  const rc = data as {
    enabled: boolean
    owner?: string | null
    has_recording?: boolean | null
    title: string
    summary: string
    highlights: { time: string; label: string }[]
    notes: string
    transcript: { start: number; text: string }[]
    duration_ms: number
    session_at: string | null
  } | null
  if (!rc || !rc.enabled) return null
  return {
    title: rc.title || 'Session recap',
    dateIso: rc.session_at,
    durationMs: rc.duration_ms || 0,
    summary: rc.summary || '',
    highlights: rc.highlights || [],
    notes: rc.notes || '',
    lines: (rc.transcript || [])
      .map((s) => ({ sec: Number(s.start) || 0, text: String(s.text || '').trim() }))
      .filter((l) => l.text),
    owner: rc.owner ?? null,
    sessionId: pageId,
    video: rc.has_recording && rc.owner ? 'parts' : null,
    kindWord: 'session',
    materials: '',
    live: false
  }
}

// ---------- state ----------
let data: Loaded
const video = (): HTMLVideoElement => el('video') as HTMLVideoElement
let mediaReady = false
let mediaLoading = false
let pendingSeek: number | null = null
let lineEls: { sec: number; node: HTMLElement }[] = []
let chapterEls: { sec: number; node: HTMLElement }[] = []
let momentEls: { sec: number; node: HTMLElement }[] = []
let unfolded = false
let readLang = 'English'
const originals = new Map<HTMLElement, string>()
let translateRun = 0

// ---------- the recording ----------
async function loadMedia(): Promise<boolean> {
  if (mediaReady) return true
  if (mediaLoading || !data.video) return false
  mediaLoading = true
  const big = el('playbig')
  big.classList.add('busy')
  const v = video()
  try {
    if (data.video === 'public') {
      v.src = `${SUPA_URL}/storage/v1/object/public/replays/${pageId}.webm`
    } else {
      const dir = `${data.owner}/${data.sessionId}`
      const { data: files, error } = await sb.storage.from('recordings').list(dir, { limit: 1000 })
      if (error) throw error
      const parts = (files ?? [])
        .map((f) => f.name)
        .filter((n) => /^part-\d+\.webm$/.test(n))
        .sort()
      const paths = parts.length ? parts.map((n) => `${dir}/${n}`) : [`${dir}.webm`]
      const blobs: Blob[] = []
      for (let i = 0; i < paths.length; i++) {
        el('playtext').textContent = `Loading · ${i + 1} of ${paths.length}`
        const { data: blob, error: e2 } = await sb.storage.from('recordings').download(paths[i])
        if (e2 || !blob) throw e2 ?? new Error('missing part')
        blobs.push(blob)
      }
      const whole = await fixWebmDuration(new Blob(blobs, { type: 'video/webm' }), data.durationMs).catch(
        () => new Blob(blobs, { type: 'video/webm' })
      )
      v.src = URL.createObjectURL(whole)
    }
    v.hidden = false
    mediaReady = true
    el('stage').classList.add('hasvideo')
    return true
  } catch {
    el('playtext').textContent = 'The recording could not be loaded'
    el('playsub').textContent = 'The owner may have removed it, or their storage rules need updating.'
    big.classList.add('dim')
    return false
  } finally {
    big.classList.remove('busy')
    mediaLoading = false
  }
}

async function play(at?: number): Promise<void> {
  const v = video()
  if (!mediaReady) {
    pendingSeek = at ?? null
    const ok = await loadMedia()
    if (!ok) return
  } else if (at !== undefined) {
    v.currentTime = at
  }
  void v.play().catch(() => undefined)
}

function wireMedia(): void {
  const v = video()
  const stage = el('stage')
  v.onloadedmetadata = () => {
    stage.classList.toggle('audio', v.videoWidth === 0)
    if (!Number.isFinite(v.duration)) {
      // stitched parts may not know their length: find the end once
      v.currentTime = 1e101
      v.ontimeupdate = () => {
        v.ontimeupdate = onTime
        v.currentTime = pendingSeek ?? 0
        pendingSeek = null
      }
      return
    }
    el('tlen').textContent = ' / ' + fmt(v.duration)
    if (pendingSeek !== null) {
      v.currentTime = pendingSeek
      pendingSeek = null
    }
  }
  v.ontimeupdate = onTime
  v.onplay = () => {
    stage.classList.add('playing')
    stage.classList.remove('paused')
    setPlayIcons(true)
  }
  v.onpause = () => {
    stage.classList.add('paused')
    setPlayIcons(false)
  }
  v.onended = () => {
    stage.classList.remove('playing')
    setPlayIcons(false)
  }
  el('playbig').onclick = () => void play()
  el('pp').onclick = () => (v.paused ? void play() : v.pause())
  el('mp').onclick = () => (v.paused ? void play() : v.pause())
  el('back10').onclick = () => {
    if (mediaReady) v.currentTime = Math.max(0, v.currentTime - 10)
  }
  const track = el('track')
  const seekFromEvent = (e: MouseEvent | TouchEvent): void => {
    if (!mediaReady || !Number.isFinite(v.duration)) return
    const rect = track.getBoundingClientRect()
    const x = 'touches' in e ? e.touches[0].clientX : e.clientX
    const p = Math.min(1, Math.max(0, (x - rect.left) / rect.width))
    v.currentTime = p * v.duration
  }
  track.onclick = seekFromEvent
  track.addEventListener('touchmove', seekFromEvent, { passive: true })
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
      if (e.key === 'Escape') (t as HTMLInputElement).blur()
      return
    }
    if (e.key === ' ') {
      e.preventDefault()
      v.paused ? void play() : v.pause()
    } else if (e.key === 'ArrowLeft' && mediaReady) v.currentTime = Math.max(0, v.currentTime - 10)
    else if (e.key === 'ArrowRight' && mediaReady) v.currentTime = v.currentTime + 10
    else if (e.key === '/') {
      e.preventDefault()
      ;(el('ask') as HTMLInputElement).focus()
    } else if (e.key === 'Escape') el('sheet').classList.remove('open')
  })
}

function setPlayIcons(playing: boolean): void {
  const play = '<path d="M8 5.5v13l11-6.5z"/>'
  const pause = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>'
  el('ppi').innerHTML = playing ? pause : play
  el('mpi').innerHTML = playing ? pause : play
}

let lastLine: HTMLElement | null = null
let lastChapter: HTMLElement | null = null
function onTime(): void {
  const v = video()
  const t = v.currentTime
  const len = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : data.durationMs / 1000
  const p = len > 0 ? Math.min(1, t / len) : 0
  el('fill').style.width = `${p * 100}%`
  el('knob').style.left = `${p * 100}%`
  el('mbar').style.width = `${p * 100}%`
  el('tnow').textContent = fmt(t)
  el('mtime').textContent = fmt(t)
  // the spoken line
  let best: HTMLElement | null = null
  for (const l of lineEls) {
    if (l.sec <= t + 0.3) best = l.node
    else break
  }
  if (best !== lastLine) {
    lastLine?.classList.remove('now')
    best?.classList.add('now')
    lastLine = best
    if (best && (el('follow') as HTMLInputElement).checked && !unfoldedByUser()) revealAround(best)
    if (best && (el('follow') as HTMLInputElement).checked) {
      const r = best.getBoundingClientRect()
      if (r.top < 120 || r.bottom > window.innerHeight - 140) best.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }
  // chapters
  let ch: HTMLElement | null = null
  let done = 0
  chapterEls.forEach((c, i) => {
    if (c.sec <= t + 0.3) {
      ch = c.node
      done = i
    }
  })
  if (ch !== lastChapter) {
    chapterEls.forEach((c, i) => {
      c.node.classList.toggle('now', c.node === ch)
      c.node.classList.toggle('done', i < done)
    })
    lastChapter = ch
    if (ch) {
      const total = chapterEls.length
      el('cfill').style.height = total > 1 ? `${(done / (total - 1)) * 100}%` : '0%'
    }
  }
  momentEls.forEach((mm) => mm.node.classList.toggle('now', Math.abs(mm.sec - t) < 20))
}

// ---------- the words ----------
function renderStory(lines: Line[]): void {
  const story = el('story')
  story.innerHTML = ''
  lineEls = []
  if (lines.length === 0) {
    story.innerHTML = '<div class="empty">No words were captured for this session.</div>'
    story.classList.remove('folded')
    return
  }
  // paragraphs: a new one every ~45 seconds or ~70 words
  let para: HTMLElement | null = null
  let paraStart = 0
  let words = 0
  for (const l of lines) {
    if (!para || l.sec - paraStart > 45 || words > 70) {
      para = document.createElement('div')
      para.className = 'para'
      const pt = document.createElement('span')
      pt.className = 'pt'
      pt.textContent = fmt(l.sec)
      pt.onclick = () => void play(l.sec)
      const body = document.createElement('p')
      body.style.margin = '0'
      para.append(pt, body)
      story.appendChild(para)
      paraStart = l.sec
      words = 0
    }
    const span = document.createElement('span')
    span.className = 'l'
    span.textContent = l.text
    span.onclick = () => void play(l.sec)
    const body = para.children[1] as HTMLElement
    body.appendChild(span)
    body.appendChild(document.createTextNode(' '))
    lineEls.push({ sec: l.sec, node: span })
    words += l.text.split(/\s+/).length
  }
  const paras = story.querySelectorAll('.para').length
  el('unfold').hidden = paras <= 4
  if (paras <= 4) story.classList.remove('folded')
}
let userUnfolded = false
const unfoldedByUser = (): boolean => userUnfolded
function revealAround(node: HTMLElement): void {
  // while folded, the paragraph being spoken is always inside the visible part
  const story = el('story')
  if (!story.classList.contains('folded')) return
  const para = node.closest('.para') as HTMLElement | null
  if (!para) return
  const all = Array.from(story.querySelectorAll('.para')) as HTMLElement[]
  const i = all.indexOf(para)
  all.forEach((p, k) => p.classList.toggle('dim', k < i - 1))
}
function wireStory(): void {
  el('unfold').onclick = () => {
    unfolded = !unfolded
    userUnfolded = unfolded
    el('story').classList.toggle('folded', !unfolded)
    el('story').querySelectorAll('.para').forEach((p) => p.classList.remove('dim'))
    el('unfold').textContent = unfolded ? 'Fold the story' : 'Read the whole story'
  }
  const search = el('search') as HTMLInputElement
  search.oninput = () => {
    const q = search.value.trim().toLowerCase()
    const story = el('story')
    if (q) {
      story.classList.remove('folded')
      story.querySelectorAll('.para').forEach((p) => p.classList.remove('dim'))
    } else if (!unfolded) story.classList.add('folded')
    let hits = 0
    for (const l of lineEls) {
      const hit = Boolean(q) && (l.node.textContent || '').toLowerCase().includes(q)
      l.node.classList.toggle('hit', hit)
      if (hit) hits++
    }
    story.querySelectorAll('.para').forEach((p) => {
      const any = !q || p.querySelector('.l.hit')
      ;(p as HTMLElement).style.display = any ? '' : 'none'
    })
    el('unfold').hidden = Boolean(q) || story.querySelectorAll('.para').length <= 4
    if (q && hits === 0) search.style.borderColor = 'var(--danger)'
    else search.style.borderColor = ''
  }
}

// ---------- chapters and moments ----------
function renderChapters(d: Loaded): void {
  const ul = el('chapters')
  chapterEls = []
  let items = d.highlights
    .map((h) => ({ sec: parseChipTs(h.time) ?? 0, label: h.label }))
    .filter((h) => h.label)
    .sort((a, b) => a.sec - b.sec)
  if (items.length === 0 && d.lines.length > 0) {
    // no moments yet: every five minutes, opened with its first words
    const step = 300
    const last = d.lines[d.lines.length - 1].sec
    for (let t = 0; t <= last; t += step) {
      const first = d.lines.find((l) => l.sec >= t)
      if (first) items.push({ sec: t, label: first.text.slice(0, 60) + (first.text.length > 60 ? '…' : '') })
    }
  }
  items = items.slice(0, 40)
  for (const it of items) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="ct">${fmt(it.sec)}</span>${esc(it.label)}`
    li.onclick = () => void play(it.sec)
    ul.appendChild(li)
    chapterEls.push({ sec: it.sec, node: li })
  }
  if (items.length === 0) ul.innerHTML += '<li style="cursor:default;color:var(--t3)">Chapters appear once the summary is written.</li>'
}
function renderMoments(d: Loaded): void {
  momentEls = []
  if (d.highlights.length === 0) return
  el('momsec').hidden = false
  const box = el('moments')
  box.innerHTML = ''
  for (const h of d.highlights) {
    const sec = parseChipTs(h.time) ?? 0
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'moment'
    b.innerHTML = `<span class="mt">${fmt(sec)}</span><span class="ml">${esc(h.label)}</span>`
    b.onclick = () => void play(sec)
    box.appendChild(b)
    momentEls.push({ sec, node: b })
  }
}

// ---------- read in your language ----------
const LANGS = ['English', 'Shona', 'Ndebele', 'Swahili', 'French', 'Portuguese', 'Spanish', 'German', 'Arabic', 'Chinese', 'Hindi']
async function translateBatch(texts: string[], lang: string): Promise<string[] | null> {
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keys: {},
        system: `You translate into ${lang}. The user sends numbered lines. Reply with ONLY the translated lines, one per line, keeping the same numbers in the form "N: text". No notes, no extra lines.`,
        messages: [{ role: 'user', content: texts.map((t, i) => `${i + 1}: ${t}`).join('\n') }],
        maxTokens: 2000
      })
    })
    if (!r.ok) return null
    const j = await r.json()
    const out: string[] = new Array(texts.length).fill('')
    for (const line of String(j.text || '').split('\n')) {
      const mm = /^\s*(\d+)\s*[:.)-]\s*(.*)$/.exec(line)
      if (!mm) continue
      const i = Number(mm[1]) - 1
      if (i >= 0 && i < texts.length) out[i] = mm[2].trim()
    }
    return out
  } catch {
    return null
  }
}
async function applyLanguage(lang: string): Promise<void> {
  readLang = lang
  try {
    localStorage.setItem('sitka-replay-lang', lang)
  } catch {
    /* ignore */
  }
  const run = ++translateRun
  const lead = el('lead')
  const nodes = lineEls.map((l) => l.node)
  for (const n of [...nodes, lead]) if (!originals.has(n)) originals.set(n, n.textContent || '')
  if (lang === 'English') {
    for (const n of [...nodes, lead]) n.textContent = originals.get(n) ?? n.textContent
    return
  }
  if (!lead.classList.contains('pending') && (originals.get(lead) || '').trim()) {
    const s = await translateBatch([originals.get(lead) || ''], lang)
    if (run !== translateRun) return
    if (s && s[0]) lead.textContent = s[0]
  }
  for (let i = 0; i < nodes.length; i += 40) {
    if (run !== translateRun) return
    const slice = nodes.slice(i, i + 40)
    const out = await translateBatch(slice.map((n) => originals.get(n) || ''), lang)
    if (run !== translateRun || !out) return
    slice.forEach((n, k) => {
      if (out[k]) n.textContent = out[k]
    })
  }
}
function wireLang(): void {
  const sel = el('lang') as HTMLSelectElement
  sel.innerHTML = LANGS.map((l) => `<option>${l}</option>`).join('')
  let saved = ''
  try {
    saved = localStorage.getItem('sitka-replay-lang') || ''
    if (!saved) {
      const att = JSON.parse(localStorage.getItem('sitka-att-' + pageId) || 'null') as { lang?: string } | null
      if (att?.lang) saved = att.lang
    }
  } catch {
    /* ignore */
  }
  if (saved && LANGS.includes(saved)) sel.value = saved
  el('langwrap').hidden = false
  sel.onchange = () => void applyLanguage(sel.value)
  if (sel.value && sel.value !== 'English') void applyLanguage(sel.value)
}

// ---------- ask ----------
function wireAsk(d: Loaded): void {
  const transcript = d.lines
    .map((l) => `[${fmt(l.sec)}] ${l.text}`)
    .join('\n')
    .slice(0, 90000)
  const system = (): string =>
    [
      `You are Sitka, answering questions about a recorded ${d.kindWord}: "${d.title}".`,
      'Ground every answer in the transcript (and materials) below; if something was not covered, say so plainly.',
      'Talking to the reader, call it "the session", never "the transcript".',
      'When you reference a specific moment, cite it inline as [[M:SS]] using a timestamp from the transcript — plain ASCII double square brackets, one moment, never a range. These become tap-to-play links.',
      'Cite a moment when the reader would want to jump to it; a summary reads as prose.',
      'Keep answers short and direct by default; use markdown structure only when it genuinely helps.',
      readLang !== 'English' ? `Always answer in ${readLang}.` : '',
      d.materials ? `\nMaterials:\n${d.materials}` : '',
      `\nTranscript:\n${transcript || '(no transcript captured)'}`
    ]
      .filter(Boolean)
      .join('\n')
  const history: { role: 'user' | 'assistant'; content: string }[] = []
  let asking = false
  const input = el('ask') as HTMLInputElement
  const send = el('asksend') as HTMLButtonElement
  input.oninput = () => {
    send.disabled = !input.value.trim()
  }
  const bubble = (cls: string, html: string, text?: string): HTMLElement => {
    const b = document.createElement('div')
    b.className = cls
    if (text !== undefined) b.textContent = text
    else b.innerHTML = html
    el('chat').appendChild(b)
    el('chat').scrollTop = el('chat').scrollHeight
    return b
  }
  el('chat').addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest?.('.tchip') as HTMLElement | null
    if (!chip) return
    const sec = Number(chip.dataset.s)
    if (Number.isFinite(sec)) void play(sec)
  })
  el('notes').addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest?.('.tchip') as HTMLElement | null
    if (!chip) return
    const sec = Number(chip.dataset.s)
    if (Number.isFinite(sec)) void play(sec)
  })
  el('sheetx').onclick = () => el('sheet').classList.remove('open')
  ;(el('dock') as HTMLFormElement).onsubmit = async (e) => {
    e.preventDefault()
    const q = input.value.trim()
    if (!q || asking) return
    asking = true
    input.value = ''
    send.disabled = true
    el('sheet').classList.add('open')
    bubble('bub-u', '', q)
    const typing = bubble('typing', '<svg class="mark mark-live" viewBox="0 0 64 64" fill="currentColor" style="width:14px;height:14px"><circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" stroke-width="9"/><circle cx="46.1" cy="17.9" r="9"/></svg>Reading the session')
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keys: {},
          system: system(),
          messages: [...history.slice(-8), { role: 'user', content: q }],
          maxTokens: 1000
        })
      })
      const j = await r.json()
      typing.remove()
      if (!r.ok) {
        bubble('err-note', '', j.error === 'missing-key' ? 'Asking is not enabled on this deployment yet.' : j.error || 'Could not answer — try again.')
      } else {
        bubble('bub-a md', md(j.text || ''))
        history.push({ role: 'user', content: q }, { role: 'assistant', content: j.text || '' })
      }
    } catch {
      typing.remove()
      bubble('err-note', '', 'Connection problem — try again.')
    } finally {
      asking = false
    }
  }
}

// ---------- header behaviour ----------
function wireHeader(): void {
  const hdr = el('hdr')
  const mini = el('mini')
  const io = new IntersectionObserver(
    (entries) => {
      const stageVisible = entries[0]?.isIntersecting ?? true
      hdr.classList.toggle('solid', !stageVisible)
      mini.classList.toggle('on', !stageVisible && mediaReady)
    },
    { threshold: 0.15 }
  )
  io.observe(el('stage'))
}

// ---------- boot ----------
async function boot(): Promise<void> {
  if (!pageId) {
    el('loading').classList.add('hidden')
    el('notfound').classList.remove('hidden')
    return
  }
  let d: Loaded | null = null
  try {
    d = (await loadEvent()) ?? (await loadRecap())
  } catch {
    d = null
  }
  if (!d) {
    el('loading').classList.add('hidden')
    el('notfound').classList.remove('hidden')
    return
  }
  data = d
  document.title = `${d.title} — Sitka`
  el('title').textContent = d.title
  el('kicker').innerHTML = d.live ? '<span class="ldot"></span>Happening now' : d.kindWord === 'live event' ? 'Event recap' : 'Session recap'
  el('htag').textContent = 'RECAP'
  const bits: string[] = []
  if (d.dateIso) bits.push(fmtDate(d.dateIso))
  if (d.durationMs) bits.push(fmtLen(d.durationMs))
  bits.push(`${d.lines.length} lines`)
  el('meta').innerHTML = bits.map((b) => `<span>${esc(b)}</span>`).join('')
  el('mt').textContent = d.title
  if (d.durationMs) el('tlen').textContent = ' / ' + fmt(d.durationMs / 1000)

  const lead = el('lead')
  if (d.summary) lead.textContent = d.summary
  else {
    lead.textContent = 'Sitka is writing the summary. It appears here in a moment.'
    lead.classList.add('pending')
  }
  if (d.notes.trim()) {
    el('notesec').hidden = false
    el('notes').innerHTML = md(d.notes)
  }
  renderChapters(d)
  renderMoments(d)
  renderStory(d.lines)
  wireStory()
  wireMedia()
  wireHeader()
  wireLang()
  wireAsk(d)

  const big = el('playbig')
  if (!d.video) {
    big.classList.add('dim')
    el('playtext').textContent = 'No recording to play'
    el('playsub').textContent = 'The recording stays with the person who captured it.'
    big.onclick = null
  } else if (d.durationMs) {
    el('playsub').textContent = `${fmtLen(d.durationMs)} · loads when you tap`
  }

  el('loading').classList.add('hidden')
  el('main').classList.remove('hidden')
  el('dock').classList.remove('hidden')

  // the summary may still be on its way: keep asking for a while
  if (!d.summary && d.kindWord === 'live event') {
    let ticks = 0
    const t = window.setInterval(async () => {
      ticks++
      const fresh = await loadEvent().catch(() => null)
      if (fresh?.summary) {
        data = fresh
        lead.textContent = fresh.summary
        lead.classList.remove('pending')
        if (fresh.highlights.length) {
          el('chapters').innerHTML = '<span class="fill" id="cfill"></span>'
          renderChapters(fresh)
          renderMoments(fresh)
        }
        clearInterval(t)
      }
      if (ticks > 80) clearInterval(t)
    }, 15000)
  }
  // for the owners' dashboard
  void sb
    .from('usage_events')
    .insert({ name: 'recap_open', props: { kind: d.kindWord, version: 2 }, platform: 'recap', ua: navigator.userAgent.slice(0, 200) })
    .then(() => undefined, () => undefined)
}
void boot()
