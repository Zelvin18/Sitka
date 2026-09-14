/**
 * Recap, second take. Same data as /r/<id>, a different page: a dark stage
 * with the recording, chapters that fill as it plays, the summary as a lead,
 * the words as paragraphs lit while they are spoken, and Sitka in a dock.
 */
import { createClient } from '@supabase/supabase-js'
import { md, parseTs as parseChipTs } from './mdlite'
import { fixWebmDuration } from '../../src/shared/webmDuration'
import { installFocusGuard } from '../../src/shared/focusGuard'
import { playProgressively } from '../../src/shared/progressive'

installFocusGuard()

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string
const sb = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } })

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
// every recap link opens here: /r/<id> as shared everywhere, and /r2/<id>
const m = /\/r2?\/([^/?#]+)/.exec(location.pathname)
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
  // A recap shared before the flag existed says nothing about its recording:
  // look in the owner's folder once, and play it if the parts are there.
  let hasParts = Boolean(rc.has_recording && rc.owner)
  if (!hasParts && rc.owner) {
    try {
      const { data: files } = await sb.storage.from('recordings').list(`${rc.owner}/${pageId}`, { limit: 5 })
      hasParts = (files ?? []).some((f) => /^part-\d+\.webm$/.test(f.name))
    } catch {
      hasParts = false
    }
  }
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
    video: hasParts ? 'parts' : null,
    kindWord: 'session',
    materials: '',
    live: false
  }
}

// ---------- state ----------
let data: Loaded
const video = (): HTMLVideoElement => el('video') as HTMLVideoElement
let mediaReady = false
let pendingSeek: number | null = null
/** the stage is on screen: the person is watching, so the words must not pull the page away */
let stageVisible = true
let lineEls: { sec: number; node: HTMLElement }[] = []
let chapterEls: { sec: number; node: HTMLElement }[] = []
let momentEls: { sec: number; node: HTMLElement }[] = []
let unfolded = false
let readLang = 'English'
const originals = new Map<HTMLElement, string>()
let translateRun = 0

// ---------- the recording ----------
// The recording starts loading the moment the page opens, all parts at
// once, so the stage shows the first frame within seconds rather than a
// black box. Play then happens inside the tap itself, which browsers allow;
// a play started after a long download is the one they refuse.
let mediaPromise: Promise<boolean> | null = null
/** the forms of the recording still worth trying, first one loaded */
let candidates: Blob[] = []
let candidateAt = 0
/** what arrived: parts, size, first bytes — shown when nothing will open */
let mediaDiag = ''
function tryNextCandidate(): boolean {
  const v = video()
  candidateAt++
  if (candidateAt >= candidates.length) return false
  console.warn('[recap] retrying with form', candidateAt, candidates[candidateAt].size)
  if (v.src.startsWith('blob:')) URL.revokeObjectURL(v.src)
  v.src = URL.createObjectURL(candidates[candidateAt])
  v.load()
  return true
}
function loadMedia(): Promise<boolean> {
  if (mediaReady) return Promise.resolve(true)
  if (mediaPromise) return mediaPromise
  if (!data.video) return Promise.resolve(false)
  const big = el('playbig')
  big.classList.add('busy')
  el('playtext').textContent = 'Fetching the recording'
  const v = video()
  mediaPromise = (async () => {
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
        // Streaming first: the first part plays within seconds while the rest
        // arrive. Only when the browser cannot stream this file is the whole
        // thing fetched and stitched as before.
        const fetchPart = async (i: number): Promise<ArrayBuffer> => {
          const { data: blob, error: e2 } = await sb.storage.from('recordings').download(paths[i])
          if (e2 || !blob) throw e2 ?? new Error('missing part')
          return blob.arrayBuffer()
        }
        v.hidden = false
        const streamed = await playProgressively(v, paths.length, fetchPart, {
          durationSec: data.durationMs ? data.durationMs / 1000 : undefined,
          lookahead: 3,
          onProgress: (n, total) => {
            if (n < total) el('playsub').textContent = `Ready · ${n} of ${total} parts in`
            else el('playsub').textContent = data.durationMs ? fmtLen(data.durationMs) : 'Ready'
          }
        })
        if (streamed) {
          mediaReady = true
          el('stage').classList.add('hasvideo')
          el('playtext').textContent = 'Play'
          console.info('[recap] streaming', paths.length, 'parts')
          return true
        }
        v.removeAttribute('src')
        let done = 0
        const blobs = await Promise.all(
          paths.map(async (p) => {
            const { data: blob, error: e2 } = await sb.storage.from('recordings').download(p)
            if (e2 || !blob) throw e2 ?? new Error('missing part')
            done++
            el('playtext').textContent = `Fetching · ${done} of ${paths.length}`
            return blob
          })
        )
        // Three ways to open the same bytes, tried in turn if the browser
        // refuses one: the file with its length written in, the plain
        // joined parts, and the first part alone. Whichever opens, plays.
        const raw = new Blob(blobs, { type: 'video/webm' })
        // What did we actually receive? A WebM starts 1A 45 DF A3. If the first
        // part does not, the header is found further in and the file is
        // opened from there; and the finding is written down for the pill.
        const headBytes = new Uint8Array(await blobs[0].slice(0, 8).arrayBuffer())
        const hex = Array.from(headBytes)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ')
        const total = blobs.reduce((n, b) => n + b.size, 0)
        mediaDiag = `${paths.length} part${paths.length === 1 ? '' : 's'} · ${(total / 1048576).toFixed(1)} MB · starts ${hex}`
        console.info('[recap] recording', mediaDiag)
        const isWebm = headBytes[0] === 0x1a && headBytes[1] === 0x45 && headBytes[2] === 0xdf && headBytes[3] === 0xa3
        let repaired: Blob | null = null
        if (!isWebm) {
          const scan = new Uint8Array(await raw.slice(0, 4 * 1024 * 1024).arrayBuffer())
          for (let i = 0; i < scan.length - 4; i++) {
            if (scan[i] === 0x1a && scan[i + 1] === 0x45 && scan[i + 2] === 0xdf && scan[i + 3] === 0xa3) {
              repaired = raw.slice(i, raw.size, 'video/webm')
              mediaDiag += ` · header found at ${i}`
              break
            }
          }
          if (!repaired) mediaDiag += ' · no WebM header anywhere in the first 4 MB'
        }
        const patched = isWebm ? await fixWebmDuration(raw, data.durationMs).catch(() => raw) : raw
        candidates = []
        if (repaired) candidates.push(repaired)
        if (patched !== raw) candidates.push(patched)
        candidates.push(raw, blobs[0])
        v.src = URL.createObjectURL(candidates[0])
      }
      v.hidden = false
      mediaReady = true
      el('stage').classList.add('hasvideo')
      el('playtext').textContent = 'Play'
      el('playsub').textContent = data.durationMs ? fmtLen(data.durationMs) : 'Ready'
      // the first frame becomes the picture behind the title, once the
      // browser knows the file well enough to seek in it
      v.addEventListener(
        'loadedmetadata',
        () => {
          if (pendingSeek === null && Number.isFinite(v.duration)) v.currentTime = 0.1
        },
        { once: true }
      )
      v.load()
      return true
    } catch {
      el('playtext').textContent = 'The recording could not be loaded'
      el('playsub').textContent = 'The owner may have removed it, or their storage rules need updating.'
      big.classList.add('dim')
      return false
    } finally {
      big.classList.remove('busy')
    }
  })()
  return mediaPromise
}

/**
 * Play from `at` (or from where it is). When the recording is already in
 * hand this runs inside the tap and always works; while it is still coming
 * the request is kept and honoured the moment it lands.
 */
function refused(err: unknown): void {
  // The browser said no. Say why on the pill, and hand the recording its own
  // controls, which a browser always honours from a direct tap.
  const v = video()
  const name = err instanceof Error ? err.name : String(err)
  console.error('[recap] play refused', name, err)
  el('playtext').textContent = 'Tap the recording to play'
  el('playsub').textContent =
    name === 'NotAllowedError'
      ? 'The browser wants the tap on the player itself.'
      : name === 'NotSupportedError'
        ? 'This browser cannot play this recording.'
        : name.slice(0, 60)
  v.controls = true
  el('bar').style.display = 'none'
}

function play(at?: number): void {
  const v = video()
  if (mediaReady) {
    if (at !== undefined) v.currentTime = at
    v.play().catch(refused)
    return
  }
  pendingSeek = at ?? pendingSeek
  void loadMedia().then((ok) => {
    if (!ok) return
    if (pendingSeek !== null) v.currentTime = pendingSeek
    pendingSeek = null
    v.play().catch(refused)
  })
}

function wireMedia(): void {
  const v = video()
  const stage = el('stage')
  // Whatever the browser says about the file, the page says too, in plain
  // words on the pill, so a failure is never a silent black box.
  v.addEventListener('error', () => {
    const code = v.error?.code
    // a form the browser cannot open: try the next one before saying so
    if ((code === 4 || code === 3) && tryNextCandidate()) return
    const why =
      code === 4
        ? 'This browser cannot decode this recording.'
        : code === 3
          ? 'The recording is damaged partway through.'
          : code === 2
            ? 'The connection dropped while loading.'
            : 'The recording could not be opened.'
    el('playtext').textContent = 'Could not play'
    el('playsub').textContent = why + (mediaDiag ? ` · ${mediaDiag}` : '')
    el('playbig').classList.add('dim')
    console.error('[recap] media error', code, v.error?.message, mediaDiag)
  })
  // a picture is a picture once a frame has decoded; only then is "audio only" decided
  v.addEventListener('loadeddata', () => {
    stage.classList.toggle('audio', v.videoWidth === 0)
    stage.classList.add('hasvideo')
  })
  v.addEventListener('resize', () => stage.classList.toggle('audio', v.videoWidth === 0))
  v.onloadedmetadata = () => {
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
    // the words follow the voice only when the reader is down among them;
    // while the stage is on screen the page stays exactly where it is
    if (best && (el('follow') as HTMLInputElement).checked && !stageVisible) {
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
    const onScreen = l.text.startsWith('[On screen] ')
    span.className = onScreen ? 'l screen' : 'l'
    // the words as words: bold kept as bold, stray markdown marks removed
    const raw = onScreen ? l.text.slice('[On screen] '.length) : l.text
    span.innerHTML = esc(raw)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/__(.+?)__/g, '<b>$1</b>')
      .replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$|[.,;:!?])/g, '$1<i>$2</i>')
      .replace(/\*\*|__|`/g, '')
    span.onclick = () => play(l.sec)
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
    li.onclick = () => {
      chapterEls.forEach((c) => c.node.classList.toggle('now', c.node === li))
      play(it.sec)
      el('stage').scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
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
  // The brief sent with a question is built for that question: the lines
  // that share its words, with a little around them, capped small. A whole
  // hour of words on every "hi" is what made replies take half a minute —
  // the free models refuse prompts that big and the request limps through
  // the fallbacks. A small brief answers in a second or two.
  const STOP = new Set(
    'what which when where about that this there their they them then than with from into your have been were was does did has had the and for are but not you our its his her she him can could would should will just like more most some such very also only into onto over under after before earlier later show shown showed said say tell explain please hello hi thanks thank'.split(' ')
  )
  const excerptFor = (q: string): string => {
    const words = q
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4 && !STOP.has(w))
    const lines = d.lines
    const keep = new Set<number>()
    if (words.length > 0) {
      lines.forEach((l, i) => {
        const t = l.text.toLowerCase()
        if (words.some((w) => t.includes(w))) {
          for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 2); k++) keep.add(k)
        }
      })
    }
    // a general question, or nothing matched: the shape of the session instead
    if (keep.size < 12) {
      const step = Math.max(1, Math.floor(lines.length / 60))
      for (let i = 0; i < lines.length; i += step) keep.add(i)
    }
    let out = ''
    for (const i of [...keep].sort((a, b) => a - b)) {
      const line = `[${fmt(lines[i].sec)}] ${lines[i].text}\n`
      if (out.length + line.length > 14000) break
      out += line
    }
    return out
  }
  const system = (q: string): string =>
    [
      `You are Sitka, answering questions about a recorded ${d.kindWord}: "${d.title}".`,
      d.summary ? `Summary of the session: ${d.summary}` : '',
      'Ground every answer in the excerpt (and materials) below; if something was not covered there, say so plainly rather than guessing.',
      'Talking to the reader, call it "the session", never "the transcript" or "the excerpt".',
      'When you reference a specific moment, cite it inline as [[M:SS]] using a timestamp from the excerpt — plain ASCII double square brackets, one moment, never a range. These become tap-to-play links.',
      'Cite a moment when the reader would want to jump to it; a summary reads as prose.',
      'Keep answers short and direct; a greeting gets one friendly line.',
      readLang !== 'English' ? `Always answer in ${readLang}.` : '',
      d.materials ? `\nMaterials:\n${d.materials.slice(0, 4000)}` : '',
      `\nExcerpt of the session (each line starts with its time):\n${excerptFor(q) || '(no words captured)'}`
    ]
      .filter(Boolean)
      .join('\n')
  // The conversation survives a reload, a closed sheet, or coming back later:
  // it is kept on this device for this recap, and drawn again on open.
  const CHAT_KEY = 'sitka-recap-chat-' + pageId
  let history: { role: 'user' | 'assistant'; content: string }[] = []
  try {
    const saved = JSON.parse(sessionStorage.getItem(CHAT_KEY) || localStorage.getItem(CHAT_KEY) || '[]')
    if (Array.isArray(saved)) history = saved.slice(-20)
  } catch {
    history = []
  }
  const remember = (): void => {
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(history.slice(-20)))
    } catch {
      /* private mode */
    }
  }
  let asking = false
  const input = el('ask') as HTMLInputElement
  const send = el('asksend') as HTMLButtonElement
  input.oninput = () => {
    send.disabled = !input.value.trim()
  }
  // a tap on the box brings the conversation back, when there is one
  input.onfocus = () => {
    if (history.length > 0) el('sheet').classList.add('open')
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
  // the mark in the dock reopens the conversation; a count shows there is one
  el('openchat').onclick = () => {
    if (history.length === 0) {
      ;(el('ask') as HTMLInputElement).focus()
      return
    }
    el('sheet').classList.toggle('open')
  }
  const countBadge = (): void => {
    const n = el('chatn')
    const k = Math.floor(history.length / 2)
    n.textContent = String(k)
    n.hidden = k === 0
  }
  // what was said before, back on screen
  for (const turn of history) {
    if (turn.role === 'user') bubble('bub-u', '', turn.content)
    else bubble('bub-a md', md(turn.content))
  }
  countBadge()
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
          system: system(q),
          messages: [...history.slice(-6), { role: 'user', content: q }],
          maxTokens: 700,
          fast: true
        })
      })
      const j = await r.json()
      typing.remove()
      if (!r.ok) {
        bubble('err-note', '', j.error === 'missing-key' ? 'Asking is not enabled on this deployment yet.' : j.error || 'Could not answer — try again.')
      } else {
        bubble('bub-a md', md(j.text || ''))
        history.push({ role: 'user', content: q }, { role: 'assistant', content: j.text || '' })
        countBadge()
        remember()
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
  // light or dark: remembered on this device
  const root = document.documentElement
  const sun =
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
  const moon = '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z"/>'
  const applyTheme = (t: string): void => {
    if (t === 'light') root.setAttribute('data-theme', 'light')
    else root.removeAttribute('data-theme')
    el('themei').innerHTML = t === 'light' ? moon : sun
    el('theme').title = t === 'light' ? 'Switch to dark' : 'Switch to light'
  }
  let theme = 'dark'
  try {
    theme = localStorage.getItem('sitka-recap-theme') || 'dark'
  } catch {
    /* ignore */
  }
  applyTheme(theme)
  el('theme').onclick = () => {
    theme = theme === 'light' ? 'dark' : 'light'
    try {
      localStorage.setItem('sitka-recap-theme', theme)
    } catch {
      /* ignore */
    }
    applyTheme(theme)
  }
  const io = new IntersectionObserver(
    (entries) => {
      stageVisible = entries[0]?.isIntersecting ?? true
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
  } else {
    if (d.durationMs) el('playsub').textContent = fmtLen(d.durationMs)
    // fetch it now, so the first frame is on the stage before anyone taps
    void loadMedia()
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
