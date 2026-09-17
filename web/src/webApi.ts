/**
 * Cloud backend for the full Sitca web app.
 * Implements the complete window.sitka surface (the Electron preload API)
 * against Supabase (data + storage) and the /api AI proxies, so the untouched
 * desktop renderer runs online. The signed-in user's browser tab is the brain:
 * it captures, transcribes, answers attendees, and stores everything here.
 */
import type { RealtimeChannel, SupabaseClient, User } from '@supabase/supabase-js'
import type { SitkaApi } from '../../src/preload/index'
import {
  memorySystemPrompt,
  memoryTranscript,
  mergeMemory,
  type MemoryExtraction
} from '../../src/shared/memoryLogic'
import { SAMPLE_TITLE, sampleDurationMs, sampleSegments } from '../../src/shared/sample'
import {
  createSystemPrompt,
  createUserPrompt,
  finishCreation,
  type SessionContext
} from '../../src/shared/createLogic'
import { DESCRIBE_ASK, DESCRIBE_SCREEN, READ_PICTURE, READ_PICTURE_ASK, cleanDescription } from '../../src/shared/visionLogic'
import { ON_SCREEN_PREFIX, REWRITE_VERSION } from '../../src/shared/types'
import { personNote } from '../../src/shared/person'
import { joinMaterials, materialsBlock } from '../../src/shared/materialsLogic'
import { foldAttachments } from '../../src/shared/attachLogic'
import {
  AUDIENCE_QUESTION_SYSTEM,
  JUDGE_ANSWER_SYSTEM,
  STUDIO_HINT_SYSTEM,
  audienceQuestionUser,
  judgeAnswerUser,
  parseAudienceQuestion,
  parseVerdict
} from '../../src/shared/studioLogic'
import { fixWebmDuration } from '../../src/shared/webmDuration'
import { mediaType } from '../../src/shared/progressive'
import { defragmentMp4, isFragmentedMp4 } from '../../src/shared/mp4'
import { createStore, type Where } from './store'
import type {
  AiStreamEvent,
  AskRequest,
  BrainAskRequest,
  BrainConversation,
  BrainSearchHit,
  BrainStats,
  ChatMessage,
  CoachBrief,
  CoachProject,
  CoachRehearsal,
  CoachScores,
  CreateRequest,
  Creation,
  EventReport,
  Slide,
  MemoryObject,
  OrgMember,
  OrgRole,
  OrgSpace,
  OrgSpaceKind,
  Organization,
  ScheduledEvent,
  Space,
  SpaceAskRequest,
  SpaceInsight,
  SpaceMaterial,
  SessionData,
  SessionMaterial,
  SessionMeta,
  SessionNotes,
  Settings,
  SimDifficulty,
  StudyPack,
  TranscribeResult,
  TranscriptSegment
} from '../../src/shared/types'

const ALL_LANGS = [
  'Shona', 'Ndebele', 'Nyankole', 'Swahili', 'French', 'Portuguese',
  'Spanish', 'German', 'Arabic', 'Chinese', 'Hindi'
]

// ---------- small helpers ----------
function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}
/**
 * The part of a session a question needs. Sending an hour of words on every
 * "what did she say about X" is what made answers slow: the free models
 * refuse prompts that big and the request limps through the fallbacks. Kept:
 * every line that mentions a word from the question, with its neighbours; the
 * most recent minutes, so "now" means now; and, when little matched, an even
 * spread so the shape of the session is present. A short session goes whole.
 */
const EXCERPT_STOP = new Set(
  'what which when where about that this there their they them then than with from into your have been were was does did has had the and for are but not you our its his her she him can could would should will just like more most some such very also only onto over under after before earlier later show shown showed said say tell explain please hello thanks thank lecturer lecture speaker session talk mean means meant'.split(' ')
)
function excerptFor(segments: TranscriptSegment[], question: string, live: boolean): string {
  const whole = transcriptBlock(segments)
  if (whole.length <= 16000) return whole
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !EXCERPT_STOP.has(w))
  const keep = new Set<number>()
  if (words.length > 0) {
    segments.forEach((seg, i) => {
      const t = seg.text.toLowerCase()
      if (words.some((w) => t.includes(w))) {
        for (let k = Math.max(0, i - 2); k <= Math.min(segments.length - 1, i + 2); k++) keep.add(k)
      }
    })
  }
  // the last few minutes are always present: "now" has to mean now
  const tail = live ? 40 : 12
  for (let i = Math.max(0, segments.length - tail); i < segments.length; i++) keep.add(i)
  // little matched: the shape of the whole session, evenly
  if (keep.size < 30) {
    const step = Math.max(1, Math.floor(segments.length / 80))
    for (let i = 0; i < segments.length; i += step) keep.add(i)
  }
  const lines: string[] = []
  let size = 0
  for (const i of [...keep].sort((a, b) => a - b)) {
    const line = transcriptBlock([segments[i]]) + '\n'
    if (size + line.length > 16000) break
    lines.push(line)
    size += line.length
  }
  return lines.join('')
}
function transcriptBlock(segments: TranscriptSegment[]): string {
  if (segments.length === 0) return '(No speech has been transcribed yet.)'
  return segments.map((s) => `[${formatTime(s.start)}] ${s.text.trim()}`).join('\n')
}
function extractJson<T>(text: string): T | null {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(text.slice(a, b + 1)) as T
  } catch {
    return null
  }
}
function uid(): string {
  return crypto.randomUUID()
}
function downloadText(name: string, text: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  a.download = name
  a.click()
}

export async function installWebApi(sb: SupabaseClient): Promise<void> {
  const { data: sess } = await sb.auth.getSession()
  const user: User = sess!.session!.user

  // Recordings live in Cloudflare R2, everything else in Supabase. The store
  // hides the difference, and keeps reading recordings made before the move.
  const store = createStore(sb)
  /** Where a session's recording is kept. Older sessions never say, and are in Supabase. */
  const whereOf = (m?: { store?: 'r2' | 'sb' }): Where => (m?.store === 'r2' ? 'r2' : 'sb')

  // ---------- what people do, for the owners' dashboard ----------
  // Named events only: which feature, when, roughly where. Never the words
  // someone said or asked. Sent in small batches, and a failure is ignored:
  // the dashboard must never slow the app or break it.
  const UA = navigator.userAgent.slice(0, 200)
  let usageQueue: { user_id: string; name: string; props: Record<string, unknown>; platform: string; ua: string }[] = []
  let usageTimer = 0
  const flushUsage = (): void => {
    usageTimer = 0
    if (usageQueue.length === 0) return
    const batch = usageQueue.splice(0, 50)
    void sb
      .from('usage_events')
      .insert(batch)
      .then(() => undefined, () => undefined)
  }
  function track(name: string, props: Record<string, unknown> = {}): void {
    usageQueue.push({ user_id: user.id, name, props, platform: 'web', ua: UA })
    if (!usageTimer) usageTimer = window.setTimeout(flushUsage, 1500)
  }
  function reportError(page: string, message: string, stack?: string): void {
    void sb
      .from('client_errors')
      .insert({ user_id: user.id, page, message: message.slice(0, 2000), stack: (stack || '').slice(0, 4000), ua: UA })
      .then(() => undefined, () => undefined)
  }
  window.addEventListener('pagehide', flushUsage)
  ;(window as unknown as { sitkaTrack: typeof track }).sitkaTrack = track
  ;(window as unknown as { sitkaReportError: typeof reportError }).sitkaReportError = reportError
  window.addEventListener('error', (e) => reportError(location.pathname, e.message || 'error', e.error?.stack))
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | string | undefined
    reportError(location.pathname, typeof r === 'string' ? r : r?.message || 'unhandled rejection', typeof r === 'object' ? r?.stack : undefined)
  })
  track('app_open', { path: location.pathname, w: window.innerWidth })
  // owners see a link to the dashboard in Settings
  void sb
    .rpc('is_admin')
    .then((r) => {
      ;(window as unknown as { sitkaIsAdmin?: boolean }).sitkaIsAdmin = r.data === true
    }, () => undefined)

  // ---------- storage health: saving must never fail silently ----------
  let bannerShown = false
  function storageProblem(reason: string): void {
    console.error('[sitka] storage problem:', reason)
    track('db_error', { reason: reason.slice(0, 120) })
    reportError(location.pathname, 'Save failed: ' + reason)
    if (bannerShown) return
    bannerShown = true
    const bar = document.createElement('div')
    bar.id = 'sitka-storage-banner'
    bar.setAttribute(
      'style',
      'position:fixed;left:0;right:0;top:0;z-index:9999;background:#1a1a1c;color:#fff;font:600 13px -apple-system,Segoe UI,Roboto,sans-serif;padding:11px 16px;display:flex;gap:14px;align-items:center;justify-content:center;flex-wrap:wrap;box-shadow:0 4px 16px rgba(0,0,0,.25)'
    )
    const msg = document.createElement('span')
    msg.textContent = 'Sitca cannot save to your database: ' + reason
    const hint = document.createElement('span')
    hint.setAttribute('style', 'font-weight:500;opacity:.8')
    hint.textContent = /does not exist|relation|schema cache|not find/i.test(reason)
      ? 'Run the setup scripts in Supabase (supabase/*.sql), then reload.'
      : 'Check your connection, then reload.'
    const close = document.createElement('button')
    close.textContent = 'Reload'
    close.setAttribute(
      'style',
      'border:1px solid rgba(255,255,255,.4);background:none;color:#fff;border-radius:8px;padding:5px 12px;font:inherit;cursor:pointer'
    )
    close.onclick = () => location.reload()
    bar.append(msg, hint, close)
    document.body.appendChild(bar)
  }
  // The setup probe and the platform-key check run side by side, and the
  // probe never holds the workspace back: a missing table shows a banner.
  let platform = { chat: false, stt: false }
  // Asked twice before anything is said: the first request of a page load is
  // the one most likely to be cut off by a connection still waking up, and a
  // blank error message is that, not a missing table.
  const probeOnce = async (): Promise<string | null> => {
    try {
      const probe = await sb.from('sessions').select('id', { count: 'exact', head: true })
      return probe.error ? probe.error.message || 'no reply' : null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }
  void (async () => {
    const first = await probeOnce()
    if (!first) return
    await new Promise((r) => setTimeout(r, 2500))
    const second = await probeOnce()
    if (second) storageProblem(second)
  })()
  try {
    // a few seconds at most: the workspace waits on this, nothing else should
    const r = await fetch('/api/health', { signal: AbortSignal.timeout(6000) })
    if (r.ok) platform = { ...platform, ...(await r.json()) }
  } catch {
    /* offline or slow — user keys still work, and the platform keys are checked again on first use */
  }

  // ---------- settings (AI keys live only in this browser) ----------
  const SETTINGS_KEY = 'sitka-web-settings'
  // The interface treats a non-empty key as "AI available". When the
  // deployment's platform keys cover the user, expose this placeholder so
  // every AI feature lights up; it is stripped before any real use.
  const PLATFORM = 'platform-managed'
  const real = (k: string): string => (k === PLATFORM ? '' : k)
  function storedSettings(): Settings {
    const base: Settings = {
      anthropicApiKey: '',
      openaiApiKey: '',
      groqApiKey: '',
      supabaseUrl: '',
      supabaseServiceKey: '',
      webAppUrl: location.origin
    }
    try {
      const s = { ...base, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') as Partial<Settings>) }
      s.anthropicApiKey = real(s.anthropicApiKey)
      s.openaiApiKey = real(s.openaiApiKey)
      s.groqApiKey = real(s.groqApiKey)
      return s
    } catch {
      return base
    }
  }
  function getSettings(): Settings {
    const s = storedSettings()
    if (!s.anthropicApiKey && !s.groqApiKey && platform.chat) s.groqApiKey = PLATFORM
    if (!s.openaiApiKey && !s.groqApiKey && platform.stt) s.groqApiKey = PLATFORM
    return s
  }

  /**
   * Download one object of a recording, surviving a broken browser cache
   * (Chrome's ERR_CACHE_READ_FAILURE) and a flaky connection: three tries,
   * from whichever store that recording was made in.
   */
  async function fetchObject(path: string, where: Where): Promise<ArrayBuffer | null> {
    return store.download(path, where)
  }

  // ---------- links written before the address changed ----------
  // A session remembers its recap link as text. Ones written under the old
  // address still open (the old address forwards), but what people see should
  // be the address they know.
  function freshLinks(meta: SessionMeta): void {
    const fix = (u?: string): string | undefined => (u && u.includes('sitka-blue.vercel.app') ? u.replace('sitka-blue.vercel.app', 'sitcaai.vercel.app') : u)
    meta.replayUrl = fix(meta.replayUrl)
    meta.recapUrl = fix(meta.recapUrl)
  }

  // ---------- a session's banner: a small file with a link ----------
  // A picture kept inside the session row would travel with every listing
  // of the library; the file lives in the public picture bucket (with the
  // live-screen frames and event banners) and the row keeps only its link.
  const bannerPath = (id: string): string => `session-${id}-banner.jpg`
  async function storeBanner(id: string, dataUrl: string): Promise<string | null> {
    const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl)
    if (!m) return null
    const bin = atob(m[1])
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const path = bannerPath(id)
    const { error } = await sb.storage
      .from('stage')
      .upload(path, new Blob([bytes], { type: 'image/jpeg' }), { upsert: true, contentType: 'image/jpeg', cacheControl: '3600' })
    if (error) {
      reportError(location.pathname, 'banner upload failed: ' + error.message)
      return null
    }
    return `${sb.storage.from('stage').getPublicUrl(path).data.publicUrl}?v=${Date.now()}`
  }
  // Banners saved the old way (the picture inside the row) move out one at a
  // time, as the library sees them; the row is the lighter for it.
  const movingBanner = new Set<string>()
  function moveBannerOut(meta: SessionMeta): void {
    const b = meta.banner
    if (!b || !b.startsWith('data:') || movingBanner.has(meta.id) || meta.readOnly || meta.sample) return
    movingBanner.add(meta.id)
    void (async () => {
      try {
        const url = await storeBanner(meta.id, b)
        if (!url) return
        const d = cache.get(meta.id) ?? (await loadSession(meta.id))
        if (!d) return
        d.meta.banner = url
        await patchSession(meta.id, { meta: d.meta })
        emitSession(d.meta)
      } catch {
        /* next time */
      } finally {
        movingBanner.delete(meta.id)
      }
    })()
  }

  // ---------- one whole file per recording ----------
  // Parts are what the recorder uploads while it runs. Once a session is over
  // and every part is in the cloud, they are joined into one file with its
  // length written in, so any player, on any phone, can play it natively and
  // start within a second or two. Runs once; a second call is a no-op.
  const consolidating = new Set<string>()
  async function consolidateRecording(id: string): Promise<void> {
    if (consolidating.has(id)) return
    consolidating.add(id)
    try {
      const d = cache.get(id) ?? (await loadSession(id))
      if (!d || d.meta.whole || d.meta.readOnly || d.meta.sample) return
      if ((await localParts(id)).length > 0) return // not all in the cloud yet
      const bytes = await api.readVideo(id, 'video')
      if (!bytes || bytes.byteLength < 5000) return
      const kind = mediaType(bytes.subarray(0, 12))
      // The recorder writes MP4 in fragments with an empty header, which a
      // player must read to the end before showing a frame. Rewritten with
      // the index first, it starts in a second however long the session ran.
      let flat = kind === 'video/mp4' ? flatten(bytes) : null
      if (flat && !(await playable(flat, kind))) {
        // the rewrite is not one this browser opens: the recording is kept as it was
        reportError(location.pathname, `flattened recording failed its check (${id}, ${Math.round(bytes.byteLength / 1e6)} MB)`)
        flat = null
      }
      const blob = new Blob([(flat ?? bytes).buffer as ArrayBuffer], { type: kind })
      const where: Where = (await store.ready()) ? 'r2' : whereOf(d.meta)
      const { error } = await store.upload(videoPath(id), blob, kind)
      if (error) {
        console.warn('Sitca: whole-file upload failed', error)
        return
      }
      d.meta.store = where
      d.meta.whole = true
      d.meta.flat = kind !== 'video/mp4' || Boolean(flat)
      d.meta.rewrite = REWRITE_VERSION
      await patchSession(id, { meta: d.meta })
      emitSession(d.meta)
    } catch (err) {
      console.warn('Sitca: could not consolidate the recording', err)
    } finally {
      consolidating.delete(id)
    }
  }

  // ---------- a phone-playable copy of an older recording ----------
  // Recordings made before the MP4 change are WebM, which iPhones refuse
  // outright. This plays such a recording once, in this tab, and re-records
  // it as MP4 through the browser's own encoder, then stores that as the
  // whole file every player tries first. It takes as long as the recording
  // and runs in the background of this tab; progress is announced as it goes.
  const converting = new Set<string>()
  async function convertForPhones(id: string): Promise<{ ok: boolean; error?: string }> {
    if (converting.has(id)) return { ok: false, error: 'Already being prepared.' }
    const d = cache.get(id) ?? (await loadSession(id))
    if (!d) return { ok: false, error: 'Session not found.' }
    if (d.meta.mime === 'video/mp4') return { ok: true }
    const mime = ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4'].find((m) =>
      MediaRecorder.isTypeSupported(m)
    )
    if (!mime) return { ok: false, error: 'This browser cannot write MP4. Use Chrome or Edge on a laptop.' }
    converting.add(id)
    const announce = (pct: number, done = false, error?: string): void => {
      window.dispatchEvent(new CustomEvent('sitka:convert', { detail: { id, pct, done, error } }))
    }
    try {
      const bytes = await api.readVideo(id, 'video')
      if (!bytes || bytes.byteLength < 5000) return { ok: false, error: 'No recording to prepare.' }
      const src = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'video/webm' }))
      const v = document.createElement('video')
      v.src = src
      v.muted = false
      v.volume = 0
      v.playsInline = true
      v.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none'
      document.body.appendChild(v)
      await new Promise<void>((resolve, reject) => {
        v.onloadedmetadata = () => resolve()
        v.onerror = () => reject(new Error('This recording could not be opened.'))
      })
      // picture from the element, sound through a silent audio graph
      const ctx = new AudioContext()
      const source = ctx.createMediaElementSource(v)
      const dest = ctx.createMediaStreamDestination()
      source.connect(dest)
      const cap = (v as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream()
      const stream = new MediaStream([...cap.getVideoTracks(), ...dest.stream.getAudioTracks()])
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 900_000, audioBitsPerSecond: 96_000 })
      const out: Blob[] = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) out.push(e.data)
      }
      const finished = new Promise<void>((resolve) => {
        rec.onstop = () => resolve()
      })
      const total = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : (d.meta.durationMs || 0) / 1000
      const tick = window.setInterval(() => announce(total ? Math.min(99, Math.round((v.currentTime / total) * 100)) : 0), 1000)
      rec.start(3000)
      await v.play()
      await new Promise<void>((resolve) => {
        v.onended = () => resolve()
      })
      rec.stop()
      await finished
      clearInterval(tick)
      v.remove()
      URL.revokeObjectURL(src)
      await ctx.close().catch(() => undefined)
      let whole = new Blob(out, { type: 'video/mp4' })
      if (whole.size < 5000) return { ok: false, error: 'The prepared file came out empty.' }
      // index first, so phones start it at once
      const flatBytes = flatten(new Uint8Array(await whole.arrayBuffer()))
      if (flatBytes && (await playable(flatBytes, 'video/mp4'))) whole = new Blob([flatBytes.buffer as ArrayBuffer], { type: 'video/mp4' })
      const where: Where = (await store.ready()) ? 'r2' : whereOf(d.meta)
      d.meta.rewrite = REWRITE_VERSION
      const { error } = await store.upload(videoPath(id), whole, 'video/mp4')
      if (error) return { ok: false, error: 'Could not store the prepared file: ' + error }
      d.meta.store = where
      d.meta.whole = true
      d.meta.flat = true
      d.meta.mime = 'video/mp4'
      await patchSession(id, { meta: d.meta })
      emitSession(d.meta)
      announce(100, true)
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      announce(0, true, msg)
      return { ok: false, error: msg }
    } finally {
      converting.delete(id)
    }
  }

  /** A key frame as stored in sessions.slides; `read` = captioned by a model that saw it. */
  interface StoredSlide {
    time: number
    text: string
    path: string
    read?: boolean
  }

  // A message is plain text, or text with images (frames of the screen).
  type ChatPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string }
  interface ChatMsg {
    role: 'user' | 'assistant'
    content: string | ChatPart[]
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  /**
   * One AI call with the server's fallback chain behind it. `vision` says
   * whether attached images were actually seen. Busy or rate-limited answers
   * are retried here a couple of times before the caller ever sees an error.
   */
  async function aiChatFull(
    system: string,
    messages: ChatMsg[],
    maxTokens = 2000,
    requireVision = false,
    fast = false
  ): Promise<{ text: string; vision: boolean }> {
    const k = storedSettings()
    let lastError = 'AI error'
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(attempt === 1 ? 1500 : 5000)
      let r: Response
      try {
        r = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            keys: { anthropicApiKey: k.anthropicApiKey, groqApiKey: k.groqApiKey },
            system,
            messages,
            maxTokens,
            requireVision,
            fast
          })
        })
      } catch {
        lastError = 'Sitca could not reach its AI — check the connection.'
        continue
      }
      const j = (await r.json().catch(() => ({}))) as { text?: string; vision?: boolean; error?: string }
      if (r.ok) return { text: j.text || '', vision: Boolean(j.vision) }
      lastError = j.error || `AI error (HTTP ${r.status})`
      if (r.status === 400 || r.status === 401 || r.status === 403) break // nothing a retry can fix
      // A gateway timeout: the model was still writing when the server's
      // minute ran out. The same again would end the same way, so the second
      // try asks for less and of a quicker model.
      if (r.status === 504 || r.status === 502) {
        maxTokens = Math.max(1200, Math.floor(maxTokens * 0.6))
        fast = true
        lastError = 'That was a big one and the AI ran out of time. Try again with fewer sessions, or a shorter ask.'
      }
    }
    throw new Error(lastError)
  }
  async function aiChat(system: string, messages: ChatMsg[], maxTokens = 2000): Promise<string> {
    return (await aiChatFull(system, messages, maxTokens)).text
  }
  function hasChatKey(): boolean {
    const k = storedSettings()
    return Boolean(k.anthropicApiKey || k.groqApiKey) || platform.chat
  }
  function hasSttKey(): boolean {
    const k = storedSettings()
    return Boolean(k.openaiApiKey || k.groqApiKey) || platform.stt
  }

  // ---------- event emitters ----------
  const aiListeners = new Set<(e: AiStreamEvent) => void>()
  const markListeners = new Set<(p: { sessionId: string; time: number }) => void>()
  const confListeners = new Set<() => void>()
  const sessListeners = new Set<(m: SessionMeta) => void>()
  const emitAi = (e: AiStreamEvent): void => aiListeners.forEach((cb) => cb(e))
  const emitConf = (): void => confListeners.forEach((cb) => cb())
  const emitSession = (m: SessionMeta): void => sessListeners.forEach((cb) => cb(m))

  // ---------- session store (Supabase rows, cached per open session) ----------
  const cache = new Map<string, SessionData>()
  interface Row {
    id: string
    meta: SessionMeta
    transcript: TranscriptSegment[]
    chat: ChatMessage[]
    notes: SessionNotes | null
    study: StudyPack | null
    marks: number[]
    report: EventReport | null
    thumb: string | null
  }
  function rowToData(r: Row): SessionData {
    return {
      meta: r.meta,
      segments: r.transcript || [],
      chat: r.chat || [],
      notes: r.notes || null,
      study: r.study || null,
      marks: r.marks || [],
      report: r.report || null
    }
  }
  async function loadSession(id: string): Promise<SessionData | null> {
    const c = cache.get(id)
    if (c) return c
    const { data } = await sb.from('sessions').select('*').eq('id', id).single()
    const row = (data as Row | null) ?? readBackups().find((b) => b.id === id) ?? null
    if (!row) {
      // Not mine: it may be shared with me through an organisation space.
      // That path returns transcript, notes, study and slides — never the
      // owner's chat or recording.
      const { data: shared } = await sb.rpc('sitka_space_session', { p_id: id })
      const s = (Array.isArray(shared) ? shared[0] : shared) as
        | { id: string; owner: string; meta: SessionMeta; transcript: TranscriptSegment[]; notes: SessionNotes | null; study: StudyPack | null }
        | undefined
      if (!s || s.owner === user.id) return null
      const d: SessionData = {
        meta: { ...s.meta, readOnly: true },
        segments: s.transcript || [],
        chat: [],
        notes: s.notes || null,
        study: s.study || null,
        marks: [],
        report: null
      }
      cache.set(id, d)
      return d
    }
    const d = rowToData(row)
    cache.set(id, d)
    return d
  }
  // Local safety net: if the database refuses a write, keep the session's text
  // (meta, transcript, chat, notes) in this browser so it still shows up.
  const BACKUP_PREFIX = 'sitka-backup-'
  function backupSession(id: string): void {
    const d = cache.get(id)
    if (!d) return
    try {
      localStorage.setItem(
        BACKUP_PREFIX + id,
        JSON.stringify({
          id,
          meta: d.meta,
          transcript: d.segments,
          chat: d.chat,
          notes: d.notes,
          study: d.study,
          marks: d.marks,
          report: d.report,
          thumb: null
        })
      )
    } catch {
      /* storage full — nothing more we can do locally */
    }
  }
  function readBackups(): Row[] {
    const out: Row[] = []
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith(BACKUP_PREFIX)) {
          out.push(JSON.parse(localStorage.getItem(k) || 'null') as Row)
        }
      }
    } catch {
      /* ignore */
    }
    return out.filter(Boolean)
  }

  // A phone changing from Wi-Fi to data, or a lift, drops requests for a few
  // seconds ("Load failed" on iPhone, "Failed to fetch" elsewhere). A save is
  // retried before anyone hears about it; the banner is for problems that stay.
  const isNetworkError = (msg: string): boolean =>
    /load failed|failed to fetch|network|timed? ?out|ECONN|ENOTFOUND|aborted/i.test(msg)
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const dropAllCache = (): void => {
    allCache = null
  }
  async function patchSession(id: string, patch: Record<string, unknown>): Promise<void> {
    dropAllCache()
    const delays = [0, 1200, 3000, 7000]
    let lastError = ''
    for (const d of delays) {
      if (d) await wait(d)
      try {
        const { error } = await sb
          .from('sessions')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('id', id)
        if (!error) return
        lastError = error.message
        if (!isNetworkError(lastError)) break
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        if (!isNetworkError(lastError)) break
      }
    }
    storageProblem(lastError)
    backupSession(id)
  }

  // ---------- the recording never leaves the device until the cloud has it ----------
  // Every chunk the recorder produces is written to IndexedDB first. Chunks are
  // grouped into ~8MB parts that upload in order during the recording; a part
  // is only forgotten locally once the cloud confirms it. Anything that fails
  // (offline, a closed tab, a storage error) retries on its own, and a session
  // cut off mid-way is recovered on the next visit.
  interface LocalChunk {
    sessionId: string
    seq: number
    at: number
    buf: ArrayBuffer
  }
  interface LocalPart {
    sessionId: string
    partNo: number
    fromSeq: number
    toSeq: number
  }
  const DB_NAME = 'sitka-recordings'
  let dbPromise: Promise<IDBDatabase | null> | null = null
  function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => {
          const db = req.result
          db.createObjectStore('chunks', { keyPath: ['sessionId', 'seq'] }).createIndex('bySession', 'sessionId')
          db.createObjectStore('parts', { keyPath: ['sessionId', 'partNo'] }).createIndex('bySession', 'sessionId')
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
    return dbPromise
  }
  async function idb<T>(
    store: 'chunks' | 'parts',
    mode: IDBTransactionMode,
    run: (s: IDBObjectStore) => IDBRequest<T> | void
  ): Promise<T | undefined> {
    const db = await openDb()
    if (!db) return undefined
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(store, mode)
        const req = run(tx.objectStore(store))
        let out: T | undefined
        if (req) req.onsuccess = () => (out = req.result)
        tx.oncomplete = () => resolve(out)
        tx.onerror = () => resolve(undefined)
        tx.onabort = () => resolve(undefined)
      } catch {
        resolve(undefined)
      }
    })
  }
  const localChunks = async (sessionId: string): Promise<LocalChunk[]> =>
    ((await idb<LocalChunk[]>('chunks', 'readonly', (s) => s.index('bySession').getAll(sessionId))) ?? []).sort(
      (a, b) => a.seq - b.seq
    )
  const localParts = async (sessionId: string): Promise<LocalPart[]> =>
    ((await idb<LocalPart[]>('parts', 'readonly', (s) => s.index('bySession').getAll(sessionId))) ?? []).sort(
      (a, b) => a.partNo - b.partNo
    )
  const allLocalParts = async (): Promise<LocalPart[]> =>
    (await idb<LocalPart[]>('parts', 'readonly', (s) => s.getAll())) ?? []
  async function forgetPart(p: LocalPart): Promise<void> {
    await idb('chunks', 'readwrite', (s) => {
      s.delete(IDBKeyRange.bound([p.sessionId, p.fromSeq], [p.sessionId, p.toSeq]))
    })
    await idb('parts', 'readwrite', (s) => {
      s.delete([p.sessionId, p.partNo])
    })
  }
  async function forgetSession(sessionId: string): Promise<void> {
    await idb('chunks', 'readwrite', (s) => {
      s.delete(IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]))
    })
    await idb('parts', 'readwrite', (s) => {
      s.delete(IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]))
    })
  }

  interface RecBuf {
    parts: number
    seq: number
    chunks: { seq: number; buf: ArrayBuffer }[]
    bytes: number
    thumbDone: boolean
    chain: Promise<void>
    /** 'video/mp4' or 'video/webm', read off the first chunk */
    kind?: string
  }
  const recBuf = new Map<string, RecBuf>()
  const PART_BYTES = 8 * 1024 * 1024
  let recordingState: { id: string; startedAt: number } | null = null
  /** parts whose data lives only in memory because IndexedDB was unavailable */
  const memParts = new Map<string, ArrayBuffer[]>()
  /** sessions whose upload has failed at least once since it last succeeded */
  const uploadTrouble = new Set<string>()
  // Closing the tab while a recording is still going up would strand the last
  // parts on this device. The browser asks first, the way it does mid-session.
  window.addEventListener('beforeunload', (e) => {
    if (recordingState || memParts.size > 0) {
      e.preventDefault()
      e.returnValue = ''
    }
  })

  function videoPath(id: string): string {
    return `${user.id}/${id}.webm`
  }
  function partPath(id: string, n: number): string {
    return `${user.id}/${id}/part-${String(n).padStart(4, '0')}.webm`
  }
  const partKey = (id: string, n: number): string => `${id}:${n}`

  /** Upload one part from local storage (or memory). True once the cloud has it. */
  async function uploadPart(p: LocalPart): Promise<boolean> {
    const chunks = (await localChunks(p.sessionId)).filter((c) => c.seq >= p.fromSeq && c.seq <= p.toSeq)
    const bufs = chunks.length > 0 ? chunks.map((c) => c.buf) : (memParts.get(partKey(p.sessionId, p.partNo)) ?? [])
    if (bufs.length === 0) {
      await forgetPart(p) // nothing to send: the record is stale
      return true
    }
    // labelled by what the recording is (MP4 or WebM): phones refuse a file
    // whose label lies about its format. Only the first part carries the
    // header, so the session remembers the kind for the rest.
    const sniffed = mediaType(new Uint8Array(bufs[0].slice(0, 12)))
    const kind =
      sniffed !== 'application/octet-stream'
        ? sniffed
        : recBuf.get(p.sessionId)?.kind ??
          cache.get(p.sessionId)?.meta.mime ??
          (await loadSession(p.sessionId))?.meta.mime ??
          'video/webm'
    const blob = new Blob(bufs, { type: kind })
    const { error } = await store.upload(partPath(p.sessionId, p.partNo), blob, kind)
    if (error) {
      console.error('Sitca: part upload failed', p.sessionId, p.partNo, error)
      // said once per session, so a blocked network shows up in the operations view
      if (!uploadTrouble.has(p.sessionId)) {
        uploadTrouble.add(p.sessionId)
        track('upload_error', { reason: error.slice(0, 120), part: p.partNo })
        reportError(location.pathname, 'Recording upload failed: ' + error)
      }
      return false
    }
    uploadTrouble.delete(p.sessionId)
    const b = recBuf.get(p.sessionId)
    if (p.partNo === 0 && (!b || !b.thumbDone)) {
      if (b) b.thumbDone = true
      const thumb = await makeThumb(blob)
      if (thumb) await patchSession(p.sessionId, { thumb })
    }
    memParts.delete(partKey(p.sessionId, p.partNo))
    await forgetPart(p)
    return true
  }

  function flushPart(id: string, force: boolean): void {
    const b = recBuf.get(id)
    if (!b || b.chunks.length === 0) return
    if (!force && b.bytes < PART_BYTES) return
    const chunks = b.chunks
    const partNo = b.parts
    const part: LocalPart = { sessionId: id, partNo, fromSeq: chunks[0].seq, toSeq: chunks[chunks.length - 1].seq }
    b.chunks = []
    b.bytes = 0
    b.parts++
    memParts.set(partKey(id, partNo), chunks.map((c) => c.buf))
    b.chain = b.chain.then(async () => {
      await idb('parts', 'readwrite', (s) => {
        s.put(part)
      })
      const ok = await uploadPart(part).catch(() => false)
      if (!ok) schedulePendingUploads()
    })
  }

  // ---- retry anything the cloud does not have yet ----
  let pendingTimer: number | null = null
  let pendingBusy = false
  function schedulePendingUploads(delayMs = 20000): void {
    if (pendingTimer !== null) return
    pendingTimer = window.setTimeout(() => {
      pendingTimer = null
      void retryPendingUploads()
    }, delayMs)
  }
  /** Returns how many parts are still waiting. */
  async function retryPendingUploads(onlySession?: string): Promise<number> {
    if (pendingBusy) return -1
    pendingBusy = true
    let left = 0
    try {
      const parts = (await allLocalParts()).filter((p) => !onlySession || p.sessionId === onlySession)
      const active = recordingState?.id
      for (const p of parts) {
        // the live recording's own chain handles its parts; only retry finished ones,
        // and never touch a session another tab is recording right now
        if (p.sessionId === active || liveInAnotherTab(p.sessionId)) continue
        const ok = navigator.onLine ? await uploadPart(p).catch(() => false) : false
        if (!ok) left++
      }
      // sessions that were waiting on uploads: tell them when they are complete
      const done = new Set(parts.map((p) => p.sessionId))
      for (const sid of done) {
        if (sid === active) continue
        const remaining = (await localParts(sid)).length
        const d = cache.get(sid) ?? (await loadSession(sid))
        if (d && !d.meta.readOnly && Boolean(d.meta.recordingPending) !== remaining > 0) {
          d.meta.recordingPending = remaining > 0 ? true : undefined
          if (!remaining) delete d.meta.recordingPending
          await patchSession(sid, { meta: d.meta })
          emitSession(d.meta)
        }
      }
    } finally {
      pendingBusy = false
    }
    if (left > 0) schedulePendingUploads(60000)
    return left
  }
  window.addEventListener('online', () => schedulePendingUploads(1500))

  /**
   * A session left in "recording" by a closed tab or a crash: close it out
   * from what the device kept, then upload and analyse it like any other.
   */
  /** True while another tab of this browser is recording this session. */
  function liveInAnotherTab(sessionId: string): boolean {
    try {
      const b = JSON.parse(localStorage.getItem('sitka.live') || 'null') as {
        sessionId?: string
        beat?: number
      } | null
      return Boolean(b && b.sessionId === sessionId && Date.now() - (b.beat || 0) < 15000)
    } catch {
      return false
    }
  }

  async function recoverInterrupted(): Promise<void> {
    try {
      const rows = await allSessions()
      for (const r of rows) {
        if (r.meta.status !== 'recording' || r.id === recordingState?.id) continue
        // A session that is live in another tab is not interrupted. Recovering
        // it from here once wrote its last minutes over its first ones and
        // called it finished while it was still going.
        if (liveInAnotherTab(r.id)) continue
        const chunks = await localChunks(r.id)
        const lastAt = chunks.length ? chunks[chunks.length - 1].at : 0
        if (lastAt && Date.now() - lastAt < 90000) continue // still being written to
        const parts = await localParts(r.id)
        // chunks that never made it into a part become the final part —
        // numbered after everything the cloud already holds, never over it
        const covered = new Set<number>()
        for (const p of parts) for (let s = p.fromSeq; s <= p.toSeq; s++) covered.add(s)
        const loose = chunks.filter((c) => !covered.has(c.seq))
        if (loose.length > 0) {
          let maxNo = parts.length ? Math.max(...parts.map((p) => p.partNo)) : -1
          const listing = await store.list(`${user.id}/${r.id}`)
          for (const f of listing.objects) {
            const m = /^part-(\d+)\.webm$/.exec(f.name)
            if (m) maxNo = Math.max(maxNo, Number(m[1]))
          }
          const partNo = maxNo + 1
          await idb('parts', 'readwrite', (s) => {
            s.put({ sessionId: r.id, partNo, fromSeq: loose[0].seq, toSeq: loose[loose.length - 1].seq } as LocalPart)
          })
        }
        const d = await loadSession(r.id)
        if (!d) continue
        d.meta.status = 'complete'
        if (!d.meta.durationMs || d.meta.durationMs <= 0) {
          d.meta.durationMs = lastAt > d.meta.createdAt ? lastAt - d.meta.createdAt : 0
        }
        // pending only when this device still holds parts the cloud lacks;
        // a session whose every part had landed is simply complete
        if ((await localParts(r.id)).length > 0) d.meta.recordingPending = true
        else delete d.meta.recordingPending
        await patchSession(r.id, { meta: d.meta })
        emitSession(d.meta)
        if (hasChatKey() && d.segments.length > 2) void analyzeWebSession(r.id)
      }
      void retryPendingUploads()
    } catch (err) {
      console.error('Sitca: recovery failed', err)
    }
  }

  async function makeThumb(blob: Blob): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const v = document.createElement('video')
        v.muted = true
        v.src = URL.createObjectURL(blob)
        const done = (out: string | null): void => {
          URL.revokeObjectURL(v.src)
          resolve(out)
        }
        v.onloadeddata = () => {
          v.currentTime = Math.min(1.2, (v.duration || 2) / 2)
        }
        v.onseeked = () => {
          if (!v.videoWidth) {
            done(null) // audio-only recording: no picture to thumbnail
            return
          }
          try {
            const c = document.createElement('canvas')
            const scale = Math.min(1, 480 / (v.videoWidth || 480))
            c.width = Math.round((v.videoWidth || 480) * scale)
            c.height = Math.round((v.videoHeight || 270) * scale)
            c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height)
            done(c.toDataURL('image/jpeg', 0.72))
          } catch {
            done(null)
          }
        }
        v.onerror = () => done(null)
        setTimeout(() => done(null), 8000)
      } catch {
        resolve(null)
      }
    })
  }

  /** the person's given name, for prompts that speak to them */
  const person = (): string => {
    const meta = (user.user_metadata ?? {}) as { full_name?: string; name?: string }
    return personNote(meta.full_name || meta.name || '')
  }

  // ---------- ask prompts (mirrors the desktop ai.ts) ----------
  function askSystemPrompt(live: boolean): string {
    return [
      person(),
      'You are Sitca, an AI assistant that is attending a live session (a lecture, meeting, presentation, or event) together with the user.',
      live
        ? 'The session is happening RIGHT NOW. The transcript below covers everything captured so far, up to the present moment. When the user asks about "now" or "currently", focus on the most recent parts of the transcript.'
        : 'The session has ended. The transcript below covers the full recording.',
      '',
      'Rules:',
      '- Answer every question. Look in the session first: when the session covers it, answer from what was said and shown, and never present your own knowledge as the speaker\'s words.',
      '- When the session does not cover the question, or the question is about something else entirely, never refuse. Say so in one friendly clause, such as "That was not part of this session, but here is the short answer:", then answer properly from your own knowledge. Be as helpful as a good tutor would be. Keep it to a few clear sentences unless the user asks for more.',
      '- Lines beginning with "[On screen]" are what Sitca read from the presenter\'s screen — slides, the whiteboard, documents, charts. Treat them as part of the session. When the user asks what is shown, written, on the board, on the slide or on the screen, answer from those lines and from any attached image of the screen, quoting the text and equations exactly as they appear. If neither shows it, say the screen has not been read yet.',
      '- Drawing what was on screen: when the user asks to see, redraw, reproduce or copy a table, chart, graph or diagram that was shown, rebuild it from the [On screen] lines and any attached image. A table becomes a markdown table with every value. A chart becomes a ```chart block — lines "type: bar" (or line), "title: …", "labels: Q1, Q2, Q3", then one line per series like "Sales: 10, 20, 30". A diagram or process becomes a ```flow block with one connection per line, like "Input -> Model -> Output". Use only values you can actually read; if a value is not legible, say so instead of inventing it.',
      '- A question that starts in the session and reaches beyond it (background, a definition, why something is so, how it compares) gets both: what the speaker said, then the wider explanation, kept apart so the user knows which is which.',
      '- When the user asks what YOU think — your opinion, a critique, whether something is right or a good idea, whether you agree, what you would add or challenge — give a genuine, reasoned point of view: strengths, weaknesses, counter-arguments, and your own assessment, drawing on your broader knowledge as well as the session. Never say you cannot have or express an opinion. Make clear what is your view and what the speaker said.',
      '- When you reference a specific moment, cite it inline with the exact format [[M:SS]] or [[H:MM:SS]] using a single timestamp that appears in the transcript (for example [[12:37]]). Never cite a range — cite the moment it starts. The app turns these into clickable links that jump the recording to that moment.',
      '- Citations must use plain ASCII double square brackets exactly as shown: [[ and ]]. Never use fullwidth brackets like 【 】, single brackets, or parentheses around a citation.',
      '- When the user asks "when was X discussed" or wants to find a moment, give the timestamp citation(s) plus a one-line description of each.',
      '- Match the length of your answer to the question. A simple or specific question gets a short, direct answer of one to three sentences — no headings, no lists, no preamble. Only produce long, structured answers when the user asks for notes, a summary, a study guide, or detail.',
      '- Formatting: plain sentences, **bold** for key terms, "-" bullets for genuine lists, and numbered lists for steps. Use markdown headings (## or ###) only in long structured answers like notes or study guides. Use a markdown table only when the user explicitly asks for a table or comparison.',
      '- Maths must be readable by a beginner. Put each equation on its own line. Write powers with superscript characters (x², x³, eⁿ) or x^n, roots as √x, fractions as (top)/(bottom) or with \\frac{top}{bottom}, derivatives as dy/dx, multiplication as 3x or 2·x. Never use LaTeX delimiters like \\( \\) \\[ \\] or $ $. The first time a symbol appears, say what it stands for in words.',
      '- The user is not a programmer. Never answer with programming code (Python, matplotlib, JavaScript, HTML) unless they explicitly ask for code. To show a chart use a ```chart block, for a diagram a ```flow block, for a table a markdown table — never a script that would draw one.',
      '- Do not end answers with offers like "let me know if you want more" — just answer.',
      '- Talking to the user, call it "the session", never "the transcript": say "earlier in the session" or "the speaker said", not "the transcript shows" or "according to the transcript". The word transcript is for you, not for them.',
      '- Use judgement about when a moment citation helps. In conversation, cite when the user would want to jump to that moment: a specific claim, a figure, a decision, "when was X said". Do NOT cite inside anything the user will keep or share — a ```document block, a summary, notes, the main topics, a study guide, an outline — unless they ask for the moments. A summary reads as prose, not as a list of timestamps.',
      '- When the user asks you to write, draft, design or develop a document — a report, letter, plan, memo, proposal, agenda, study notes, one-pager, a set of slides in outline — produce the whole document inside one fenced block that starts with ```document, whose first line is "Title: <the title>" and whose body is markdown (headings, paragraphs, lists, tables). The app shows it as a document the user can open, copy and download. Keep any words outside the block to one short sentence.',
      '',
      'Transcript of the session (each line is prefixed with its start time):'
    ].join('\n')
  }
  function attendeeSystemPrompt(
    persona: string,
    lang: string,
    segments: TranscriptSegment[],
    materials: string,
    preEvent: boolean
  ): string {
    return [
      preEvent
        ? 'You are Sitca, a personal AI companion for an audience member of an upcoming live event. The event has NOT started yet, but the host has shared preparation materials (below) — answer from those, and say clearly when something will only be known once the event begins.'
        : 'You are Sitca, a personal AI companion for one audience member at a live event. You have been listening to the event with them; the transcript so far is below.',
      `This attendee describes themself as: "${persona}". Calibrate every answer to that perspective and knowledge level — the same talk means different things to different people.`,
      lang && lang.toLowerCase() !== 'english'
        ? `Respond ENTIRELY in ${lang}, even though the source material is in another language.`
        : '',
      'Rules:',
      '- Ground every answer in the provided material; if something was not covered, say so plainly instead of guessing.',
      '- When asked what YOU think — an opinion, a critique, whether the speaker is right, what you would challenge — give a genuine, reasoned point of view drawing on your broader knowledge as well as the talk. Never say you cannot have an opinion; make clear what is your view and what the speaker said.',
      '- When you reference a specific moment of the talk, cite it inline with the exact format [[M:SS]] using a single timestamp that appears in the transcript (for example [[12:37]]). Plain ASCII double square brackets only. The app turns these into tappable links.',
      '- Match the length of your answer to the question: short and direct by default; structure only for catch-ups and summaries.',
      '- Formatting: **bold** for key terms, "-" bullets for genuine lists, "## " headings only in long answers, tables only for comparisons. This renders on a phone — keep it tight.',
      '- The user is not a programmer. Never answer with programming code (Python, matplotlib, JavaScript, HTML) unless they explicitly ask for code. To show a chart use a ```chart block, for a diagram a ```flow block, for a table a markdown table — never a script that would draw one.',
      '- Do not end answers with offers like "let me know if you want more" — just answer.',
      materials ? `\nEvent materials shared by the host:\n${materials.slice(0, 14000)}` : '',
      preEvent ? '' : `\nTranscript so far:\n${transcriptBlock(segments)}`
    ]
      .filter(Boolean)
      .join('\n')
  }

  // ---------- live audience (this tab is the conference brain) ----------
  interface ConfPoll {
    id: string
    question: string
    options: string[]
    counts: number[]
    total: number
    status: 'open' | 'closed'
  }
  interface Conf {
    eventId: string
    sessionId: string
    url: string
    workTimer: number
    statsTimer: number
    answering: Set<string>
    attendeeLangs: Map<string, string>
    attendeeCount: number
    askCount: number
    questions: { topic: string; items: { text: string; at: number; votes?: number }[] }[]
    reactions: { landed: number; lost: number; recentLost: number }
    poll: ConfPoll | null
    translated: Map<string, number>
    frameBusy: boolean
  }
  let conf: Conf | null = null
  /** Online events are always reachable; this tracks which one the Events page presents as armed. */
  let armedId: string | null = null

  async function eventMaterialsText(eventId: string): Promise<string> {
    const { data } = await sb.from('events').select('materials_text').eq('id', eventId).single()
    return (data?.materials_text as string) || ''
  }

  // ---------- after a session: title, summary, highlights, then memory ----------
  // Failures are written to meta.analysisError so the session page can say what
  // went wrong and offer a retry, instead of showing "generating summary…" forever.
  // One analysis per session at a time: opening the page right after the
  // session ends joins the run already in progress instead of starting another.
  const analysisRuns = new Map<string, Promise<void>>()
  function analyzeWebSession(id: string): Promise<void> {
    const running = analysisRuns.get(id)
    if (running) return running
    const run = analyzeWebSessionNow(id).finally(() => analysisRuns.delete(id))
    analysisRuns.set(id, run)
    return run
  }
  async function analyzeWebSessionNow(id: string): Promise<void> {
    const d = await loadSession(id)
    if (!d) return
    try {
      const kindFocus =
        d.meta.kind === 'meeting'
          ? 'Focus on decisions made, action items, and who committed to what.'
          : d.meta.kind === 'lecture'
            ? 'Focus on the core concepts taught and what is most likely to be examined.'
            : 'Focus on the key messages and the moments that mattered.'
      const system = [
        'You analyze a timestamped transcript of a recorded session (lecture, meeting, presentation, or event).',
        kindFocus,
        'Return ONLY a JSON object, no prose and no code fences, with this exact shape:',
        '{"title": string, "summary": string, "highlights": [{"time": "M:SS", "label": string}]}',
        '- "title": a short, specific title for the session based on what it was about (max 8 words, no quotes inside).',
        '- "summary": 2-4 sentences capturing what the session was about and its most important points.',
        '- "highlights": 3-8 key moments worth revisiting, each with "time" copied exactly from a timestamp in the transcript (like "12:37") and a short label (max 10 words).'
      ].join('\n')
      const materials = await sessionMaterialsBlock(id)
      const ask = async (): Promise<{
        title?: string
        summary?: string
        highlights?: { time: string; label: string }[]
      } | null> => {
        const out = await aiChat(system, [
          {
            role: 'user',
            content: materials
              ? `${materials}\n\nTranscript:\n${transcriptBlock(d.segments)}`
              : transcriptBlock(d.segments)
          }
        ])
        return extractJson(out)
      }
      // The summary is written automatically; a model that answers with prose
      // instead of JSON gets a second chance before this counts as a failure.
      let parsed = await ask()
      if (!parsed?.summary) parsed = await ask()
      if (!parsed?.summary) throw new Error('The model did not return a usable summary.')
      // Like the desktop app: the session is named after what it was about.
      if (parsed.title && String(parsed.title).trim()) {
        d.meta.title = String(parsed.title).trim().slice(0, 80)
      }
      d.meta.summary = parsed.summary
      d.meta.highlights = (parsed.highlights ?? []).slice(0, 10)
      d.meta.analyzed = true
      delete d.meta.analysisError
      await patchSession(id, { meta: d.meta })
      emitSession(d.meta)
      // The event recap gets the summary and the moments as soon as they exist,
      // and so does a shared session recap: its title, summary and moments
      // follow the session rather than freezing at the moment it was shared.
      await syncReplayText(d.meta).catch(() => undefined)
      await sb
        .from('recaps')
        .update({
          title: d.meta.title,
          summary: d.meta.summary ?? '',
          highlights: d.meta.highlights ?? [],
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .then(() => undefined, () => undefined)
      // Memory: decisions, promises, people and concepts, pinned to their moments.
      await rememberSession(d.meta, d.segments).catch(() => undefined)
    } catch (err) {
      d.meta.analysisError = err instanceof Error ? err.message : String(err)
      console.error('Sitca: session analysis failed', d.meta.analysisError)
      await patchSession(id, { meta: d.meta })
      emitSession(d.meta)
    }
  }

  // ---------- session materials: slides, notes, readings the user shared ----------
  interface StoredMaterial extends SessionMaterial {
    text: string
  }
  async function readMaterials(sessionId: string): Promise<StoredMaterial[]> {
    const { data } = await sb.from('sessions').select('materials').eq('id', sessionId).single()
    return ((data?.materials as StoredMaterial[] | null) ?? []).filter(Boolean)
  }
  const stripText = (all: StoredMaterial[]): SessionMaterial[] =>
    all.map(({ id, name, chars, addedAt }) => ({ id, name, chars, addedAt }))
  /** The prompt section for a session's materials, or '' when there are none. */
  async function sessionMaterialsBlock(sessionId: string | null | undefined): Promise<string> {
    if (!sessionId) return ''
    try {
      return materialsBlock(await readMaterials(sessionId))
    } catch {
      return ''
    }
  }
  function confSegments(): TranscriptSegment[] {
    if (!conf) return []
    return cache.get(conf.sessionId)?.segments ?? []
  }

  async function confAnswerAsk(row: {
    id: string
    attendee_id: string
    kind: string
    question: string
  }): Promise<void> {
    if (!conf) return
    const c = conf
    try {
      const { data: att } = await sb
        .from('attendees')
        .select('persona,lang')
        .eq('id', row.attendee_id)
        .single()
      const persona = (att?.persona as string) || 'Curious attendee'
      const lang = (att?.lang as string) || 'English'
      const segments = confSegments()
      let answer: string
      if (row.kind === 'pack') {
        const system = [
          'Create a take-home pack for an audience member from this event transcript.',
          lang.toLowerCase() !== 'english' ? `Write EVERYTHING in ${lang}.` : '',
          'Return ONLY JSON: {"summary": string, "takeaways": [string]} — summary is 3-5 sentences; takeaways are 4-7 short bullet points.'
        ]
          .filter(Boolean)
          .join('\n')
        const out = await aiChat(system, [{ role: 'user', content: transcriptBlock(segments) }])
        const parsed = extractJson<{ summary?: string; takeaways?: string[] }>(out)
        answer = JSON.stringify({
          summary: parsed?.summary ?? 'Summary unavailable.',
          takeaways: Array.isArray(parsed?.takeaways) ? parsed.takeaways.map(String) : [],
          moments: []
        })
      } else {
        const question =
          row.kind === 'catchup'
            ? 'Catch me up: in a few short bullets, what has happened so far? End with one line on what is being discussed right now.'
            : row.question
        const { data: prior } = await sb
          .from('asks')
          .select('question,answer')
          .eq('attendee_id', row.attendee_id)
          .eq('kind', 'ask')
          .eq('status', 'answered')
          .order('created_at', { ascending: false })
          .limit(4)
        const history = (prior ?? [])
          .reverse()
          .flatMap((p) => [
            { role: 'user' as const, content: p.question as string },
            { role: 'assistant' as const, content: (p.answer as string) || '' }
          ])
        const materials =
          joinMaterials(await eventMaterialsText(c.eventId), await sessionMaterialsBlock(c.sessionId)) ?? ''
        answer = await aiChat(attendeeSystemPrompt(persona, lang, segments, materials, false), [
          ...history,
          { role: 'user', content: question }
        ])
      }
      await sb
        .from('asks')
        .update({ status: 'answered', answer, answered_at: new Date().toISOString() })
        .eq('id', row.id)
      c.askCount++
    } catch {
      await sb
        .from('asks')
        .update({ status: 'error', answer: 'Sitca could not answer — try again.' })
        .eq('id', row.id)
    } finally {
      c.answering.delete(row.id)
    }
  }

  async function confReviewQuestion(row: {
    id: string
    text: string
    force: boolean
  }): Promise<void> {
    if (!conf) return
    const c = conf
    try {
      if (row.force) {
        await sb
          .from('speaker_questions')
          .update({ status: 'submitted', refined: row.text, topic: 'General' })
          .eq('id', row.id)
        emitConf()
        return
      }
      const system = [
        'An audience member wants to submit a question to the speaker of a live event. You are given the transcript so far.',
        'Return ONLY JSON: {"answeredAt": "M:SS" | null, "answer": string | null, "refined": string, "topic": string}',
        '- If the speaker already clearly addressed this question, set answeredAt to the transcript timestamp where, and answer to a 1-2 sentence summary. Otherwise both null.',
        '- refined: the question rewritten to be clear and concise. topic: a 2-4 word topic label.'
      ].join('\n')
      const out = await aiChat(system, [
        { role: 'user', content: `Question: ${row.text}\n\nTranscript:\n${transcriptBlock(confSegments())}` }
      ])
      const review = extractJson<{
        answeredAt?: string | null
        answer?: string | null
        refined?: string
        topic?: string
      }>(out)
      if (review?.answeredAt && review.answer) {
        await sb
          .from('speaker_questions')
          .update({
            status: 'already_answered',
            answered_at_label: review.answeredAt,
            answer: review.answer,
            refined: review.refined ?? row.text,
            topic: review.topic ?? 'General'
          })
          .eq('id', row.id)
      } else {
        await sb
          .from('speaker_questions')
          .update({
            status: 'submitted',
            refined: review?.refined ?? row.text,
            topic: review?.topic ?? 'General'
          })
          .eq('id', row.id)
        emitConf()
      }
    } catch {
      await sb.from('speaker_questions').update({ status: 'error' }).eq('id', row.id)
    } finally {
      c.answering.delete(row.id)
    }
  }

  async function confPollWork(): Promise<void> {
    if (!conf || !hasChatKey()) return
    const c = conf
    const [{ data: asks }, { data: qs }] = await Promise.all([
      sb.from('asks').select('id,attendee_id,kind,question').eq('event_id', c.eventId).eq('status', 'pending').limit(4),
      sb.from('speaker_questions').select('id,text,force').eq('event_id', c.eventId).eq('status', 'checking').limit(4)
    ])
    for (const row of (asks ?? []) as { id: string; attendee_id: string; kind: string; question: string }[]) {
      if (c.answering.size >= 2 || c.answering.has(row.id)) continue
      c.answering.add(row.id)
      void confAnswerAsk(row)
    }
    for (const row of (qs ?? []) as { id: string; text: string; force: boolean }[]) {
      if (c.answering.has(row.id)) continue
      c.answering.add(row.id)
      void confReviewQuestion(row)
    }
  }

  // ---------- host side of the live video: one direct connection per phone ----------
  interface RtcHost {
    channel: RealtimeChannel
    peers: Map<string, RTCPeerConnection>
    stream: MediaStream
  }
  let rtc: RtcHost | null = null
  // Beyond this, phones keep the still frames: direct connections cost the
  // host's upload for every viewer. Larger rooms need a media server.
  const RTC_MAX_PEERS = 12
  async function rtcOfferTo(id: string): Promise<void> {
    const r = rtc
    if (!r) return
    r.peers.get(id)?.close()
    r.peers.delete(id)
    if (r.peers.size >= RTC_MAX_PEERS) return
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    r.peers.set(id, pc)
    for (const t of r.stream.getVideoTracks()) {
      const sender = pc.addTrack(t, r.stream)
      const p = sender.getParameters()
      if (p.encodings && p.encodings.length > 0) {
        p.encodings[0].maxBitrate = 900_000
        p.encodings[0].maxFramerate = 15
        void sender.setParameters(p).catch(() => undefined)
      }
    }
    pc.onicecandidate = (e) => {
      if (e.candidate)
        void r.channel.send({
          type: 'broadcast',
          event: 'ice',
          payload: { id, from: 'host', candidate: e.candidate.toJSON() }
        })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        pc.close()
        if (r.peers.get(id) === pc) r.peers.delete(id)
      }
    }
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      void r.channel.send({ type: 'broadcast', event: 'offer', payload: { id, sdp: pc.localDescription } })
    } catch {
      pc.close()
      r.peers.delete(id)
    }
  }
  async function stopRtcHost(): Promise<void> {
    const r = rtc
    if (!r) return
    rtc = null
    try {
      await r.channel.send({ type: 'broadcast', event: 'bye', payload: {} })
    } catch {
      /* the room is already gone */
    }
    r.peers.forEach((pc) => pc.close())
    r.peers.clear()
    void sb.removeChannel(r.channel)
  }

  async function confPollStats(): Promise<void> {
    if (!conf) return
    const c = conf
    // the heartbeat: attendees' phones watch it, and treat a host silent for
    // minutes as gone
    void sb.from('events').update({ host_seen: new Date().toISOString() }).eq('id', c.eventId).then(() => undefined, () => undefined)
    const { data: atts } = await sb.from('attendees').select('id,lang').eq('event_id', c.eventId)
    const prev = c.attendeeCount
    c.attendeeCount = atts?.length ?? c.attendeeCount
    for (const a of atts ?? []) c.attendeeLangs.set(a.id as string, (a.lang as string) || 'English')
    const { data: subs } = await sb
      .from('speaker_questions')
      .select('id,refined,text,topic,created_at')
      .eq('event_id', c.eventId)
      .eq('status', 'submitted')
      .order('created_at', { ascending: true })
    // upvote counts per question
    const qids = (subs ?? []).map((q) => q.id as string)
    const voteCount = new Map<string, number>()
    if (qids.length > 0) {
      const { data: qv } = await sb
        .from('question_votes')
        .select('question_id')
        .in('question_id', qids)
      for (const v of qv ?? []) {
        const k = v.question_id as string
        voteCount.set(k, (voteCount.get(k) ?? 0) + 1)
      }
    }
    const byTopic = new Map<string, { text: string; at: number; votes: number }[]>()
    for (const q of subs ?? []) {
      const topic = (q.topic as string) || 'General'
      const list = byTopic.get(topic) ?? []
      list.push({
        text: (q.refined as string) || (q.text as string),
        at: new Date(q.created_at as string).getTime(),
        votes: voteCount.get(q.id as string) ?? 0
      })
      byTopic.set(topic, list)
    }
    c.questions = [...byTopic.entries()]
      .map(([topic, items]) => ({ topic, items: items.sort((a, b) => b.votes - a.votes) }))
      .sort(
        (a, b) =>
          b.items.reduce((n, i) => n + i.votes, 0) + b.items.length -
          (a.items.reduce((n, i) => n + i.votes, 0) + a.items.length)
      )

    // reactions: totals + "lost" in the last 3 minutes (the pulse signal)
    const { data: reacts } = await sb
      .from('reactions')
      .select('kind,at')
      .eq('event_id', c.eventId)
    let landed = 0
    let lost = 0
    let recentLost = 0
    const cutoff = Date.now() - 180000
    for (const r of reacts ?? []) {
      if (r.kind === 'landed') landed++
      else {
        lost++
        if (new Date(r.at as string).getTime() > cutoff) recentLost++
      }
    }
    c.reactions = { landed, lost, recentLost }

    // latest poll + live tallies
    const { data: pollRows } = await sb
      .from('polls')
      .select('*')
      .eq('event_id', c.eventId)
      .order('created_at', { ascending: false })
      .limit(1)
    if (pollRows && pollRows.length > 0) {
      const p = pollRows[0]
      const options = (p.options as string[]) ?? []
      const counts = options.map(() => 0)
      const { data: pv } = await sb.from('poll_votes').select('choice').eq('poll_id', p.id)
      for (const v of pv ?? []) {
        const idx = Number(v.choice)
        if (idx >= 0 && idx < counts.length) counts[idx]++
      }
      c.poll = {
        id: p.id as string,
        question: p.question as string,
        options,
        counts,
        total: (pv ?? []).length,
        status: (p.status as 'open' | 'closed') ?? 'open'
      }
    } else {
      c.poll = null
    }
    if (c.attendeeCount !== prev) emitConf()
  }

  async function confPushSegments(newSegs: TranscriptSegment[], startIdx: number): Promise<void> {
    if (!conf) return
    const c = conf
    const rows = newSegs.map((s, i) => ({
      event_id: c.eventId,
      idx: startIdx + i,
      start_sec: s.start,
      label: formatTime(s.start),
      text: s.text
    }))
    await sb.from('segments').insert(rows)
    // translations for the languages attendees actually joined with
    const { data: ev } = await sb.from('events').select('live_voice').eq('id', c.eventId).single()
    const vc = (ev?.live_voice as { enabled: boolean; languages: string[] }) ?? {
      enabled: true,
      languages: ALL_LANGS
    }
    if (!vc.enabled) return
    const all = confSegments()
    const langs = new Set<string>()
    for (const lang of c.attendeeLangs.values()) {
      if (lang.toLowerCase() !== 'english' && vc.languages.includes(lang)) langs.add(lang)
    }
    for (const lang of langs) {
      const done = c.translated.get(lang) ?? 0
      if (done >= all.length) continue
      const fresh = all.slice(done)
      const from = done
      c.translated.set(lang, all.length)
      try {
        const system = [
          `Translate each numbered line of live speech into ${lang}. Natural spoken style; keep names and numbers exact.`,
          `Return ONLY JSON: {"lines": [string]} with exactly ${fresh.length} entries, in order.`
        ].join('\n')
        const out = await aiChat(system, [
          { role: 'user', content: fresh.map((s, i) => `${i + 1}. ${s.text}`).join('\n') }
        ])
        const parsed = extractJson<{ lines?: unknown[] }>(out)
        if (!parsed || !Array.isArray(parsed.lines)) continue
        const trows = fresh
          .map((_s, i) => ({ line: parsed.lines![i], idx: from + i }))
          .filter((r) => typeof r.line === 'string' && (r.line as string).trim())
          .map((r) => ({ event_id: c.eventId, lang, idx: r.idx, text: (r.line as string).trim() }))
        if (trows.length > 0) await sb.from('translations').insert(trows)
      } catch {
        /* skip batch */
      }
    }
  }

  async function generateProxyBriefs(
    evId: string,
    segments: TranscriptSegment[],
    sessionId?: string
  ): Promise<void> {
    try {
      const { data: rows } = await sb
        .from('proxies')
        .select('attendee_id,request')
        .eq('event_id', evId)
        .eq('status', 'pending')
        .limit(40)
      if (!rows || rows.length === 0) return
      const materials =
        joinMaterials(await eventMaterialsText(evId), await sessionMaterialsBlock(sessionId)) ?? ''
      for (const p of rows) {
        try {
          const system = [
            'You attended a live event on behalf of someone who could not be there. Write their personal brief.',
            `They told you what they care about:\n"${p.request}"`,
            'Structure: open with 2-3 sentences on the event overall; then "## What happened about your topics" — address EACH thing they asked for, in prose they can keep, or say plainly it was not covered (answer from the materials if you can); end with "## Worth knowing anyway" — 2-3 bullets of other important moments.',
            'Be specific and grounded — never invent coverage that did not happen. This is a document to keep, not a player: never write timestamps or clock times ([12:34], "at 12:34"); say what was said, not when.',
            materials ? `\nEvent materials:\n${materials.slice(0, 8000)}` : ''
          ]
            .filter(Boolean)
            .join('\n')
          const brief = await aiChat(
            system,
            [{ role: 'user', content: transcriptBlock(segments) }],
            2200
          )
          await sb
            .from('proxies')
            .update({ status: 'ready', brief })
            .eq('attendee_id', p.attendee_id)
        } catch {
          await sb.from('proxies').update({ status: 'error' }).eq('attendee_id', p.attendee_id)
        }
      }
    } catch {
      /* proxies table missing or offline — feature stays dormant */
    }
  }

  // ---------- the event recap: shared with the room the moment the event ends ----------
  // The recap page (/r/<eventId>) reads the transcript from the segments table,
  // the summary from events.replay once analysis has written it, and the
  // recording straight from the parts uploaded while recording (wave11.sql
  // opens them to readers while the recap is on). Nothing is copied.
  const replayUrlFor = (eventId: string): string => `${location.origin}/r/${eventId}`

  async function readReplay(eventId: string): Promise<Record<string, unknown> | null> {
    const { data } = await sb.from('events').select('replay').eq('id', eventId).single()
    return (data?.replay as Record<string, unknown> | null) ?? null
  }

  async function writeReplay(eventId: string, patch: Record<string, unknown>): Promise<void> {
    const current = (await readReplay(eventId)) ?? {}
    await sb
      .from('events')
      .update({ replay: { ...current, ...patch }, updated_at: new Date().toISOString() })
      .eq('id', eventId)
  }

  /** Switch the recap on with what is known right now; the summary follows. */
  async function openReplay(meta: SessionMeta): Promise<void> {
    if (!meta.eventId) return
    await writeReplay(meta.eventId, {
      enabled: true,
      auto: true,
      title: meta.title,
      summary: meta.summary ?? '',
      highlights: meta.highlights ?? [],
      durationMs: meta.durationMs,
      video: 'parts',
      publishedAt: Date.now()
    })
  }

  /** After analysis: the summary, the moments and the final title reach the recap. */
  async function syncReplayText(meta: SessionMeta): Promise<void> {
    if (!meta.eventId || !meta.hosted) return
    const current = await readReplay(meta.eventId)
    if (!current || current.enabled !== true) return
    await writeReplay(meta.eventId, {
      title: meta.title,
      summary: meta.summary ?? '',
      highlights: meta.highlights ?? [],
      durationMs: meta.durationMs
    })
  }

  /**
   * A write the room depends on, tried a few times before giving up. Used for
   * the two words that change what every attendee's phone shows: live, ended.
   */
  async function setEventStatus(eventId: string, status: 'live' | 'ended', extra: Record<string, unknown> = {}): Promise<string | null> {
    let last = ''
    for (const delay of [0, 1200, 3000]) {
      if (delay) await wait(delay)
      const { error } = await sb
        .from('events')
        .update({ status, ...extra, updated_at: new Date().toISOString() })
        .eq('id', eventId)
      if (!error) return null
      last = error.message
      if (!isNetworkError(last)) break
    }
    reportError(location.pathname, `event ${status} write failed: ${last}`)
    return last
  }

  async function endConf(sessionId: string): Promise<void> {
    if (!conf || conf.sessionId !== sessionId) {
      // The room was started in an earlier page of this tab (a reload, a
      // crash) so nothing here remembers it: the event row still does, and
      // the attendees are still on it. End it from the row.
      const d = cache.get(sessionId) ?? (await loadSession(sessionId))
      const eid = d?.meta.eventId
      if (!eid || !d?.meta.hosted) return
      const err = await setEventStatus(eid, 'ended')
      if (err) return
      d.meta.replayUrl = replayUrlFor(eid)
      await openReplay(d.meta).catch(() => undefined)
      return
    }
    const c = conf
    clearInterval(c.workTimer)
    clearInterval(c.statsTimer)
    // The word every phone in the room is waiting for goes first, on its own;
    // the report is bookkeeping and must never stand between the host's tap
    // and the attendees' screens.
    await setEventStatus(c.eventId, 'ended')
    const report: EventReport = {
      joined: c.attendeeCount,
      peak: c.attendeeCount,
      aiAsks: c.askCount,
      questions: c.questions,
      agenda: cache.get(sessionId)?.meta.agenda,
      endedAt: Date.now()
    }
    const d = cache.get(sessionId)
    if (d) d.report = report
    await patchSession(sessionId, { report }).catch((err) =>
      reportError(location.pathname, `event report write failed: ${err instanceof Error ? err.message : String(err)}`)
    )
    // The room gets its recap link straight away.
    if (d) {
      d.meta.replayUrl = replayUrlFor(c.eventId)
      await openReplay(d.meta).catch(() => undefined)
    }
    void generateProxyBriefs(c.eventId, d?.segments ?? [], c.sessionId)
    conf = null
  }

  // ---------- events table mapping ----------
  interface EvRow {
    id: string
    title: string
    status: string
    starts_at: string | null
    agenda: string[]
    pre_event_chat: boolean
    materials: { name: string; chars: number; text?: string }[]
    live_voice: { enabled: boolean; languages: string[] }
    session_id: string | null
    updated_at: string
    banner?: string | null
  }
  function evRowToScheduled(r: EvRow): ScheduledEvent {
    return {
      id: r.id,
      title: r.title,
      startsAt: r.starts_at ? new Date(r.starts_at).getTime() : undefined,
      createdAt: new Date(r.updated_at).getTime(),
      agenda: r.agenda || [],
      materials: (r.materials || []).map((m) => ({ name: m.name, chars: m.chars })),
      preEventChat: r.pre_event_chat !== false,
      liveVoice: r.live_voice ?? { enabled: true, languages: ALL_LANGS },
      sessionId: r.session_id ?? undefined,
      banner: r.banner ?? undefined
    }
  }
  function eventUrl(id: string): string {
    return `${location.origin}/e/${id}`
  }
  async function saveEventMaterials(
    id: string,
    materials: { name: string; chars: number; text: string }[]
  ): Promise<ScheduledEvent | null> {
    const materialsText = materials.map((m) => `--- ${m.name} ---\n${m.text}`).join('\n\n')
    await sb
      .from('events')
      .update({
        materials,
        materials_text: materialsText || null,
        materials_present: materials.length > 0,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
    const { data } = await sb.from('events').select('*').eq('id', id).single()
    return data ? evRowToScheduled(data as EvRow) : null
  }
  function pickTextFile(): Promise<{ name: string; text: string } | null> {
    return new Promise((resolve) => {
      const inp = document.createElement('input')
      inp.type = 'file'
      inp.accept = '.txt,.md,.csv,.json,.vtt,.srt'
      inp.onchange = () => {
        const f = inp.files?.[0]
        if (!f) {
          resolve(null)
          return
        }
        const r = new FileReader()
        r.onload = () => resolve({ name: f.name, text: String(r.result || '') })
        r.onerror = () => resolve(null)
        r.readAsText(f)
      }
      inp.oncancel = () => resolve(null)
      inp.click()
    })
  }

  // ---------- brain (library intelligence, ranked client-side) ----------
  function tokenize(q: string): string[] {
    return q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2)
  }
  // Everything the library's mind needs, kept for a minute: the same rows
  // are asked for by a search, then a question, then the stats, one after
  // another, and each is a heavy read (every transcript). The pictures are
  // left out: nothing here looks at them.
  let allCache: { at: number; rows: Row[] } | null = null
  async function allSessions(): Promise<Row[]> {
    if (allCache && Date.now() - allCache.at < 60_000) return allCache.rows
    const { data, error } = await sb
      .from('sessions')
      .select('id,meta,transcript,chat,notes,study,marks,report')
      .order('created_at', { ascending: false })
    if (error) storageProblem(error.message)
    const rows = ((data as Row[]) || []).slice()
    // merge local backups the database never received; drop ones it now has
    const have = new Set(rows.map((r) => r.id))
    for (const b of readBackups()) {
      if (have.has(b.id)) {
        try {
          localStorage.removeItem(BACKUP_PREFIX + b.id)
        } catch {
          /* ignore */
        }
      } else {
        rows.push(b)
      }
    }
    allCache = { at: Date.now(), rows }
    return rows
  }
  function rankHits(rows: Row[], query: string, limit: number): BrainSearchHit[] {
    const toks = tokenize(query)
    if (toks.length === 0) return []
    const hits: (BrainSearchHit & { score: number })[] = []
    for (const r of rows) {
      for (const seg of r.transcript || []) {
        const lower = seg.text.toLowerCase()
        let score = 0
        for (const t of toks) if (lower.includes(t)) score++
        if (score > 0) {
          hits.push({
            sessionId: r.id,
            sessionTitle: r.meta.title,
            time: seg.start,
            snippet: seg.text.slice(0, 180),
            score
          })
        }
      }
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit).map(({ score: _s, ...h }) => h)
  }

  // ---------- memory store (decisions, promises, people, concepts) ----------
  async function loadMemory(): Promise<MemoryObject[]> {
    const { data } = await sb.from('memory_objects').select('data').order('updated_at', { ascending: false })
    return ((data ?? []) as { data: MemoryObject }[]).map((r) => r.data)
  }
  async function saveMemoryList(list: MemoryObject[], previousIds: Set<string>): Promise<void> {
    const rows = list.map((o) => ({
      id: o.id,
      owner: user.id,
      data: o,
      updated_at: new Date(o.updatedAt).toISOString()
    }))
    if (rows.length > 0) await sb.from('memory_objects').upsert(rows)
    const gone = [...previousIds].filter((id) => !list.some((o) => o.id === id))
    if (gone.length > 0) await sb.from('memory_objects').delete().in('id', gone)
  }
  async function rememberSession(meta: SessionMeta, segments: TranscriptSegment[]): Promise<void> {
    if (segments.length < 6 || !hasChatKey()) return
    try {
      const existing = await loadMemory()
      const today = new Date().toISOString().slice(0, 10)
      const out = await aiChat(
        memorySystemPrompt(meta.kind, existing, today),
        [{ role: 'user', content: memoryTranscript(segments) }],
        2500
      )
      const parsed = extractJson<MemoryExtraction>(out)
      if (!parsed) return
      const merged = mergeMemory(existing, parsed, { id: meta.id, title: meta.title }, uid)
      await saveMemoryList(merged, new Set(existing.map((o) => o.id)))
    } catch {
      /* memory is best-effort — the session itself is already saved */
    }
  }

  // ---------- coach store ----------
  interface CoachRow {
    id: string
    data: CoachProject & { materialTexts?: { name: string; text: string }[] }
    sim: ChatMessage[]
  }
  async function loadCoach(id: string): Promise<CoachRow | null> {
    const { data } = await sb.from('coach_projects').select('*').eq('id', id).single()
    return (data as CoachRow) || null
  }
  async function saveCoach(row: CoachRow): Promise<void> {
    await sb
      .from('coach_projects')
      .update({ data: row.data, sim: row.sim, updated_at: new Date().toISOString() })
      .eq('id', row.id)
  }
  function coachContext(p: CoachRow['data']): string {
    const mats = (p.materialTexts || []).map((m) => `--- ${m.name} ---\n${m.text}`).join('\n\n')
    return [
      `Presentation: "${p.title}". Goal: ${p.goal || 'not specified'}. Audience: ${p.audience || 'general'}.`,
      mats ? `Materials:\n${mats.slice(0, 12000)}` : '(No materials uploaded yet.)'
    ].join('\n')
  }

  // ---------- the API ----------
  const api: SitkaApi = {
    getSettings: async () => getSettings(),
    getProfile: async () => {
      const meta = (user.user_metadata ?? {}) as { full_name?: string; name?: string; welcomed_at?: string }
      const given = (meta.full_name || meta.name || '').trim()
      const name = given || user.email?.split('@')[0] || 'You'
      return { name, email: user.email ?? undefined, cloud: true, needsName: !given, needsWelcome: !meta.welcomed_at }
    },
    markWelcomed: async () => {
      const { data } = await sb.auth.updateUser({ data: { welcomed_at: new Date().toISOString() } })
      if (data.user) user.user_metadata = data.user.user_metadata
    },
    setProfileName: async (name: string) => {
      const clean = name.trim().slice(0, 80)
      if (!clean) return null
      const { data, error } = await sb.auth.updateUser({ data: { full_name: clean } })
      if (error || !data.user) return null
      user.user_metadata = data.user.user_metadata
      return { name: clean, email: user.email ?? undefined, cloud: true }
    },
    signOut: async () => {
      await sb.auth.signOut()
      // the next person to sign in on this browser starts at the home page
      try {
        sessionStorage.removeItem('sitka.view')
        localStorage.removeItem('sitka.space')
      } catch {
        /* ignore */
      }
      location.href = '/app'
    },
    deleteAccount: async (confirmEmail: string) => {
      // the server removes everything that was theirs, then the account; the
      // browser forgets what it kept and goes back to the front door
      const { data } = await sb.auth.getSession()
      const t = data.session?.access_token
      if (!t) return { error: 'Sign in again first.' }
      let r: Response
      try {
        r = await fetch('/api/account', {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${t}` },
          body: JSON.stringify({ confirm: confirmEmail })
        })
      } catch {
        return { error: 'Could not reach the server. Check your connection and try again.' }
      }
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; failures?: string[] }
      if (r.status === 400 || r.status === 401) return { error: j.error || 'Not allowed.' }
      if (!r.ok && r.status !== 207) return { error: j.error || `The server answered ${r.status}.` }
      try {
        localStorage.clear()
        sessionStorage.clear()
        indexedDB.deleteDatabase(DB_NAME)
      } catch {
        /* ignore */
      }
      await sb.auth.signOut().catch(() => undefined)
      location.href = '/?bye=1'
      return { ok: true }
    },
    setSettings: async (s: Settings) => {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          ...s,
          anthropicApiKey: real(s.anthropicApiKey.trim()),
          openaiApiKey: real(s.openaiApiKey.trim()),
          groqApiKey: real(s.groqApiKey.trim())
        })
      )
    },

    listSources: async () => [
      {
        id: 'browser-screen',
        name: 'Your screen — the browser will ask which one',
        thumbnail:
          'data:image/svg+xml;utf8,' +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" rx="12" fill="#26262a"/><rect x="40" y="34" width="240" height="92" rx="8" fill="none" stroke="#8a8a92" stroke-width="3"/><rect x="130" y="138" width="60" height="8" rx="4" fill="#8a8a92"/></svg>'
          ),
        kind: 'screen' as const
      }
    ],

    getThumb: async (id: string) => {
      const { data } = await sb.from('sessions').select('thumb').eq('id', id).single()
      return (data?.thumb as string) || null
    },

    createSession: async (title, kind, hosted, agenda, eventId, space, audioOnly, spaceId) => {
      track('session_start', { kind, hosted: Boolean(hosted), audio: Boolean(audioOnly), space: space ?? null })
      const meta: SessionMeta = {
        id: uid(),
        title: title || 'Untitled session',
        createdAt: Date.now(),
        durationMs: 0,
        status: 'recording',
        kind,
        hosted,
        agenda,
        eventId,
        space,
        audioOnly: audioOnly || undefined,
        spaceId: spaceId || undefined
      }
      const { error } = await sb.from('sessions').insert({
        id: meta.id,
        owner: user.id,
        meta,
        transcript: [],
        chat: [],
        marks: [],
        ...(spaceId ? { space_id: spaceId } : {})
      })
      if (error) storageProblem(error.message)
      cache.set(meta.id, {
        meta,
        segments: [],
        chat: [],
        notes: null,
        study: null,
        marks: [],
        report: null
      })
      if (error) backupSession(meta.id)
      recBuf.set(meta.id, {
        parts: 0,
        seq: 0,
        chunks: [],
        bytes: 0,
        thumbDone: false,
        chain: Promise.resolve()
      })
      return meta
    },

    hostCoverage: async (id: string) => {
      const d = await loadSession(id)
      if (!d || !d.meta.agenda?.length || !hasChatKey()) return { covered: [] }
      try {
        const system = [
          'You are checking which planned agenda topics a live speaker has already covered, from the transcript so far.',
          `Agenda:\n${d.meta.agenda.map((a, i) => `${i + 1}. ${a}`).join('\n')}`,
          `Return ONLY JSON: {"covered": [boolean]} with exactly ${d.meta.agenda.length} entries, in agenda order.`
        ].join('\n')
        const out = await aiChat(system, [{ role: 'user', content: transcriptBlock(d.segments) }])
        const parsed = extractJson<{ covered?: unknown[] }>(out)
        if (parsed && Array.isArray(parsed.covered)) {
          return { covered: parsed.covered.map(Boolean) }
        }
      } catch {
        /* quiet */
      }
      return { covered: [] }
    },

    reportInsights: async (id: string) => {
      const d = await loadSession(id)
      if (!d?.report) return { error: 'No audience report for this session.' }
      if (d.report.insights) return { report: d.report }
      try {
        const system = [
          'You are analyzing a hosted live event for the speaker: transcript + audience data.',
          'Return ONLY JSON: {"overview": string, "coverage": [{"topic": string, "covered": boolean, "note": string}], "followUps": [string]}',
          '- overview: 3-4 sentences on how the event went, grounded in the data.',
          '- coverage: one entry per agenda topic (empty array if no agenda).',
          '- followUps: 3-5 concrete follow-up actions for the host.'
        ].join('\n')
        const userMsg = [
          `Agenda: ${(d.report.agenda ?? []).join('; ') || '(none)'}`,
          `Attendees joined: ${d.report.joined}. AI questions asked privately: ${d.report.aiAsks}.`,
          `Audience questions: ${d.report.questions.map((g) => `${g.topic}: ${g.items.map((i) => i.text).join(' | ')}`).join(' // ') || '(none)'}`,
          `Transcript:\n${transcriptBlock(d.segments)}`
        ].join('\n')
        const out = await aiChat(system, [{ role: 'user', content: userMsg }])
        const parsed = extractJson<EventReport['insights']>(out)
        if (parsed) {
          d.report.insights = parsed
          await patchSession(id, { report: d.report })
        }
        return { report: d.report }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },

    // The list needs only the metadata: transcripts and chats stay in the
    // database until a session is opened, which is what makes the workspace
    // appear at once.
    listSessions: async () => {
      const { data, error } = await sb
        .from('sessions')
        .select('id,meta')
        .order('created_at', { ascending: false })
      if (error) storageProblem(error.message)
      const rows = ((data as { id: string; meta: SessionMeta }[]) || []).map((r) => r.meta)
      const have = new Set(rows.map((m) => m.id))
      for (const b of readBackups()) if (!have.has(b.id)) rows.push(b.meta)
      // one old-style banner moves out per listing; the rest follow on later listings
      const old = rows.find((m) => m.banner && m.banner.startsWith('data:'))
      if (old) moveBannerOut(old)
      // the sample lecture of earlier versions had no recording to play: it goes
      for (const m of rows) if (m.sample) void api.deleteSession(m.id).catch(() => undefined)
      for (const m of rows) freshLinks(m)
      return rows.filter((m) => !m.sample)
    },

    getSession: async (id: string) => {
      const d = await loadSession(id)
      if (d) freshLinks(d.meta)
      // A shared recap follows its session: opening the session refreshes
      // the recap's title, summary and moments, so an old share never keeps
      // a stale name.
      if (d?.meta.recapUrl) {
        void (async () => {
          const thumb = await api.getThumb(id).catch(() => null)
          await sb
            .from('recaps')
            .update({
              title: d.meta.title,
              summary: d.meta.summary ?? '',
              highlights: d.meta.highlights ?? [],
              has_recording: !d.meta.readOnly && !d.meta.sample,
              ...(thumb ? { thumb } : {}),
              updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .then(() => undefined, () => undefined)
        })()
      }
      return d
    },

    deleteSession: async (id: string) => {
      // A hosted event's recap dies with its session: the page closes and the
      // public copy of the recording, if one was made, is removed. The parts
      // below go too, so the recap's own player has nothing left to read.
      const evId = cache.get(id)?.meta.eventId ?? (await loadSession(id))?.meta.eventId
      if (evId) {
        await sb
          .from('events')
          .update({ replay: { enabled: false }, updated_at: new Date().toISOString() })
          .eq('id', evId)
          .then(() => undefined, () => undefined)
        await sb.storage.from('replays').remove([`${evId}.webm`]).catch(() => undefined)
      }
      await sb.from('sessions').delete().eq('id', id)
      cache.delete(id)
      await forgetSession(id)
      await sb.storage.from('stage').remove([bannerPath(id)]).catch(() => undefined)
      // A session started before the move to Cloudflare can have left files in
      // both stores. Clear both, so nothing survives its session and keeps
      // costing: the parts, the whole file, and the frames read off the screen.
      for (const where of ['r2', 'sb'] as Where[]) {
        const parts = await store.listIn(`${user.id}/${id}`, where)
        const slides = await store.listIn(`${user.id}/${id}-slides`, where)
        await store.remove(
          [
            ...parts.map((f) => `${user.id}/${id}/${f.name}`),
            ...slides.map((f) => `${user.id}/${id}-slides/${f.name}`),
            videoPath(id)
          ],
          where
        )
      }
    },

    // ---------- session materials ----------
    listSessionMaterials: async (sessionId: string) => stripText(await readMaterials(sessionId)),
    addSessionMaterial: async (sessionId: string, name: string, text: string) => {
      const all = await readMaterials(sessionId)
      const clean = text.slice(0, 200000)
      all.push({ id: uid(), name, text: clean, chars: clean.length, addedAt: Date.now() })
      const { error } = await sb
        .from('sessions')
        .update({ materials: all, updated_at: new Date().toISOString() })
        .eq('id', sessionId)
      if (error) {
        throw new Error(
          /column .* does not exist/i.test(error.message)
            ? 'Materials are not set up yet — run supabase/wave8.sql in the Supabase SQL editor.'
            : error.message
        )
      }
      return stripText(all)
    },
    removeSessionMaterial: async (sessionId: string, materialId: string) => {
      const all = (await readMaterials(sessionId)).filter((m) => m.id !== materialId)
      await sb
        .from('sessions')
        .update({ materials: all, updated_at: new Date().toISOString() })
        .eq('id', sessionId)
      return stripText(all)
    },
    extractMaterial: async (name: string, bytes: ArrayBuffer) => {
      const ext = (name.split('.').pop() ?? '').toLowerCase()
      if (['txt', 'md', 'csv', 'json', 'vtt', 'srt'].includes(ext)) {
        return { name, text: new TextDecoder().decode(bytes).slice(0, 200000) }
      }
      if (ext === 'pdf') {
        try {
          // pdf.js from a CDN, loaded only when a PDF is actually dropped in.
          const url = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.min.mjs'
          const pdfjs = (await import(/* @vite-ignore */ url)) as {
            GlobalWorkerOptions: { workerSrc: string }
            getDocument: (o: { data: ArrayBuffer }) => {
              promise: Promise<{
                numPages: number
                getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: { str?: string }[] }> }>
              }>
            }
          }
          pdfjs.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.worker.min.mjs'
          const doc = await pdfjs.getDocument({ data: bytes }).promise
          const pages: string[] = []
          for (let i = 1; i <= Math.min(doc.numPages, 300); i++) {
            const page = await doc.getPage(i)
            const content = await page.getTextContent()
            pages.push(content.items.map((it) => it.str ?? '').join(' '))
          }
          const text = pages.join('\n\n').trim()
          if (!text) return { error: `No readable text in ${name} (a scanned PDF?). Paste the text instead.` }
          return { name, text: text.slice(0, 200000) }
        } catch {
          return { error: 'Could not read this PDF here — paste its text instead.' }
        }
      }
      return { error: `Use a PDF, TXT, MD or CSV file, or paste the text.` }
    },

    readImage: async (dataUrl: string) => {
      if (!hasChatKey()) return { text: '', error: 'Reading pictures needs an AI key in Settings.' }
      try {
        // only a model that can see the picture may write down what it says
        const out = await aiChatFull(
          READ_PICTURE,
          [{ role: 'user', content: [{ type: 'image', dataUrl }, { type: 'text', text: READ_PICTURE_ASK }] }],
          1500,
          true
        )
        if (!out.vision) return { text: '', error: 'No model that can read pictures is available right now.' }
        return { text: out.text.trim() }
      } catch (err) {
        return { text: '', error: err instanceof Error ? err.message : String(err) }
      }
    },

    // ---------- visual memory: key frames of the screen ----------
    addSlide: async (sessionId: string, time: number, dataUrl: string) => {
      if (!hasChatKey()) return { text: '' }
      const m = dataUrl.match(/^data:image\/jpeg;base64,(.+)$/)
      if (!m) return { text: '' }
      try {
        // requireVision: a frame is only ever described by a model that can
        // see it. Without one, nothing is stored — never an invented caption.
        const out = await aiChatFull(
          DESCRIBE_SCREEN,
          [
            {
              role: 'user',
              content: [
                { type: 'image', dataUrl },
                { type: 'text', text: DESCRIBE_ASK }
              ]
            }
          ],
          600,
          true
        )
        if (!out.vision) return { text: '' }
        const text = cleanDescription(out.text)
        if (!text) return { text: '' }
        const bin = atob(m[1])
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const path = `${user.id}/${sessionId}-slides/${String(Math.round(time * 10)).padStart(7, '0')}.jpg`
        await store.upload(path, new Blob([bytes], { type: 'image/jpeg' }), 'image/jpeg')
        const d = await loadSession(sessionId)
        if (d) {
          d.segments.push({ start: time, end: time + 1, text: ON_SCREEN_PREFIX + text })
          d.segments.sort((a, b) => a.start - b.start)
          const { data: row } = await sb.from('sessions').select('slides').eq('id', sessionId).single()
          const slides = ((row?.slides as StoredSlide[] | null) ?? []).concat({
            time,
            text,
            path,
            read: true
          })
          await patchSession(sessionId, { transcript: d.segments, slides })
        }
        return { text }
      } catch (err) {
        return { text: '', error: err instanceof Error ? err.message : String(err) }
      }
    },
    listSlides: async (sessionId: string): Promise<Slide[]> => {
      const { data: row } = await sb.from('sessions').select('slides').eq('id', sessionId).single()
      const stored = (row?.slides as StoredSlide[] | null) ?? []
      if (stored.length === 0) return []
      // Frames follow their session: newer ones are in Cloudflare, older ones
      // still in Supabase. Ask the folder which, then sign them all at once.
      const folder = await store.list(`${user.id}/${sessionId}-slides`)
      const paths = stored.map((s) => s.path)
      const signed = await store.urls(paths, folder.where)
      const urlByPath = new Map(paths.map((p, i) => [p, signed[i]]))
      // Frames captioned before a vision model was available carry guesses.
      // They are re-read by a model that can actually see them, a few per
      // visit, and the transcript's "[On screen]" line is corrected too.
      const unread = stored.filter((s) => !s.read && urlByPath.get(s.path)).slice(0, 6)
      if (unread.length > 0 && hasChatKey()) {
        let changed = false
        const d = await loadSession(sessionId)
        for (const s of unread) {
          try {
            const blob = await (await fetch(urlByPath.get(s.path)!)).blob()
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const fr = new FileReader()
              fr.onload = () => resolve(String(fr.result))
              fr.onerror = () => reject(fr.error)
              fr.readAsDataURL(blob)
            })
            const out = await aiChatFull(
              DESCRIBE_SCREEN,
              [
                {
                  role: 'user',
                  content: [
                    { type: 'image', dataUrl },
                    { type: 'text', text: DESCRIBE_ASK }
                  ]
                }
              ],
              600,
              true
            )
            if (!out.vision) break // still no sight: try again another time
            s.text = cleanDescription(out.text) || s.text
            s.read = true
            changed = true
            if (d) {
              const seg = d.segments.find(
                (g) => Math.abs(g.start - s.time) < 0.6 && g.text.startsWith(ON_SCREEN_PREFIX)
              )
              if (seg) seg.text = ON_SCREEN_PREFIX + s.text
            }
          } catch {
            break
          }
        }
        if (changed) {
          await patchSession(sessionId, d ? { transcript: d.segments, slides: stored } : { slides: stored })
        }
      }
      return stored
        .map((s) => ({ time: s.time, text: s.text, image: urlByPath.get(s.path) ?? '' }))
        .filter((s) => s.image)
        .sort((a, b) => a.time - b.time)
    },

    // ---------- Create: documents, presentations, code ----------
    listCreations: async (): Promise<Creation[]> => {
      const { data } = await sb
        .from('creations')
        .select('data')
        .eq('owner', user.id)
        .order('updated_at', { ascending: false })
      return ((data ?? []) as { data: Creation }[]).map((r) => r.data)
    },
    saveCreation: async (c: Creation) => {
      await sb
        .from('creations')
        .upsert({ id: c.id, owner: user.id, data: c, updated_at: new Date().toISOString() })
    },
    deleteCreation: async (id: string) => {
      await sb.from('creations').delete().eq('id', id)
    },
    generateCreation: async (req: CreateRequest) => {
      if (!hasChatKey()) return { error: 'missing-key' }
      try {
        const contexts: SessionContext[] = []
        for (const id of req.sessionIds) {
          const d = await loadSession(id)
          if (d) contexts.push({ title: d.meta.title, segments: d.segments })
        }
        // a long piece, but not so long that the server's minute runs out
        // on a big model: about four thousand words is the ceiling
        const raw = await aiChat(
          createSystemPrompt(req.kind),
          [{ role: 'user', content: createUserPrompt(req, contexts) }],
          req.kind === 'code' ? 6000 : 5000
        )
        let existing: Creation | undefined
        if (req.previous) {
          const { data } = await sb
            .from('creations')
            .select('data')
            .eq('id', req.previous.id)
            .single()
          existing = (data?.data as Creation | undefined) ?? undefined
        }
        const creation = finishCreation(req, raw, existing)
        if (!creation.id) creation.id = uid()
        const { error } = await sb
          .from('creations')
          .upsert({ id: creation.id, owner: user.id, data: creation, updated_at: new Date().toISOString() })
        if (error && /relation .* does not exist/i.test(error.message)) {
          return { error: 'Create is not set up yet — run supabase/wave7.sql in the Supabase SQL editor.' }
        }
        return { creation }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
    saveTextFile: async (name: string, content: string) => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 4000)
      return { ok: true }
    },
    saveBinaryFile: async (name: string, bytes: ArrayBuffer) => {
      const type = name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([bytes], { type }))
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 4000)
      return { ok: true }
    },

    saveChat: async (id, chat) => {
      const d = await loadSession(id)
      if (d) d.chat = chat
      await patchSession(id, { chat })
    },

    appendChunk: async (id, chunk) => {
      const b = recBuf.get(id)
      if (!b) return
      const seq = b.seq++
      if (seq === 0) {
        // the first chunk says which format the recorder chose; the session keeps it
        b.kind = mediaType(new Uint8Array(chunk.slice(0, 12)))
        const d = cache.get(id)
        if (d && b.kind !== 'application/octet-stream') d.meta.mime = b.kind
      }
      // The device keeps it first; the cloud gets it next.
      await idb('chunks', 'readwrite', (s) => {
        s.put({ sessionId: id, seq, at: Date.now(), buf: chunk } as LocalChunk)
      })
      b.chunks.push({ seq, buf: chunk })
      b.bytes += chunk.byteLength
      flushPart(id, false)
    },

    retryUploads: async (sessionId: string) => {
      const left = await retryPendingUploads(sessionId)
      const pending = left < 0 ? (await localParts(sessionId)).length : left
      // nothing left on this device: the flag comes off the row too, so the
      // notice does not return on the next open
      if (pending === 0) {
        const d = cache.get(sessionId) ?? (await loadSession(sessionId))
        if (d?.meta.recordingPending) {
          delete d.meta.recordingPending
          await patchSession(sessionId, { meta: d.meta })
          emitSession(d.meta)
          if (!d.meta.whole) void consolidateRecording(sessionId)
        }
      }
      return { pending }
    },

    // The whole recording as one file, played natively over range requests:
    // the fastest start on every device, phones included, with no streaming
    // engine in the way. Made once, after the session, from the parts.
    videoUrl: async (id: string) => {
      const d = cache.get(id) ?? (await loadSession(id))
      if (!d) return null
      if (!d.meta.whole) {
        // an older session: make the whole file in the background for next time
        void consolidateRecording(id)
        return null
      }
      // A whole file still in the recorder's fragmented form makes a player
      // read all of it before the first frame. The parts stream instead: the
      // first is playing within seconds however long the session ran.
      // (a recording whose container was never noted is treated the same: only WebM is safe unflattened)
      if (d.meta.mime !== 'video/webm' && !d.meta.flat) return null
      // A whole file made by an older rewriter (an iPhone's edit list left
      // at nothing, which players read as no sound at all) is made again in
      // the background from the parts; until then the parts play.
      if (d.meta.mime === 'video/mp4' && (d.meta.rewrite ?? 0) < REWRITE_VERSION && !d.meta.readOnly && !d.meta.sample) {
        d.meta.whole = false
        void consolidateRecording(id)
        return null
      }
      return store.url(videoPath(id), whereOf(d.meta))
    },

    convertForPhones: (id: string) => convertForPhones(id),

    // The parts of a recording as links, in order, so the player can stream
    // them one after another instead of waiting for the whole file.
    listVideoParts: async (id: string) => {
      const listing = await store.list(`${user.id}/${id}`)
      const names = listing.objects
        .map((f) => f.name)
        .filter((n) => /^part-\d+\.webm$/.test(n))
        .sort()
      if (names.length === 0) return []
      // parts still on this device (not uploaded yet) mean the cloud is incomplete: stitch instead
      if ((await localParts(id)).length > 0) return []
      const urls = (await store.urls(names.map((n) => `${user.id}/${id}/${n}`), listing.where)).filter(
        (u) => Boolean(u)
      )
      return urls.length === names.length ? urls : []
    },
    listVideoPartsSized: async (id: string) => {
      const listing = await store.list(`${user.id}/${id}`)
      const objs = listing.objects.filter((f) => /^part-\d+\.webm$/.test(f.name)).sort((a, b) => (a.name < b.name ? -1 : 1))
      if (objs.length === 0) return []
      if ((await localParts(id)).length > 0) return []
      const urls = await store.urls(objs.map((o) => `${user.id}/${id}/${o.name}`), listing.where)
      const out = objs.map((o, i) => ({ url: urls[i] ?? '', size: Number(o.size ?? 0) }))
      return out.every((p) => p.url && p.size > 0) ? out : []
    },

    readVideo: async (id, file = 'video') => {
      if (file === 'reel') return null
      // Parts live in the cloud, or still on this device, or both: stitch them in order.
      const listing = await store.list(`${user.id}/${id}`)
      const cloud = new Map<number, string>()
      for (const f of listing.objects) {
        const m = /^part-(\d+)\.webm$/.exec(f.name)
        if (m) cloud.set(Number(m[1]), f.name)
      }
      const local = await localParts(id)
      const localBy = new Map(local.map((p) => [p.partNo, p]))
      const chunks = local.length > 0 ? await localChunks(id) : []
      const partNos = [...new Set([...cloud.keys(), ...localBy.keys()])].sort((a, b) => a - b)
      if (partNos.length > 0) {
        const buffers: ArrayBuffer[] = []
        for (const n of partNos) {
          const name = cloud.get(n)
          if (name) {
            const buf = await fetchObject(`${user.id}/${id}/${name}`, listing.where)
            if (buf) {
              buffers.push(buf)
              continue
            }
          }
          const p = localBy.get(n)
          if (p) {
            for (const c of chunks) if (c.seq >= p.fromSeq && c.seq <= p.toSeq) buffers.push(c.buf)
            const mem = memParts.get(partKey(id, n))
            if (mem && !chunks.some((c) => c.seq >= p.fromSeq && c.seq <= p.toSeq)) buffers.push(...mem)
          }
        }
        const total = buffers.reduce((n, b) => n + b.byteLength, 0)
        if (total > 0) {
          const out = new Uint8Array(total)
          let at = 0
          for (const b of buffers) {
            out.set(new Uint8Array(b), at)
            at += b.byteLength
          }
          // The stitched file has no length in its header, which hides the
          // timeline on phones. Write the session's length in.
          const durationMs = cache.get(id)?.meta.durationMs ?? (await loadSession(id))?.meta.durationMs
          if (file === 'video' && durationMs) {
            try {
              // only a WebM has the length written in; an MP4 is left as it is
              if (mediaType(out.subarray(0, 12)) !== 'video/webm') return out
              const fixed = await fixWebmDuration(
                new Blob([out.buffer as ArrayBuffer], { type: 'video/webm' }),
                durationMs
              )
              return new Uint8Array(await fixed.arrayBuffer())
            } catch {
              /* the plain file still plays */
            }
          }
          return out
        }
      }
      // Legacy single-file recordings.
      const whole =
        (await fetchObject(videoPath(id), 'r2')) ?? (await fetchObject(videoPath(id), 'sb'))
      if (!whole) {
        console.error('Sitca: no recording found for session', id)
        return null
      }
      return new Uint8Array(whole)
    },

    setRecordingState: async (state) => {
      recordingState = state
    },

    markNow: async () => {
      if (!recordingState) return
      const time = (Date.now() - recordingState.startedAt) / 1000
      const d = await loadSession(recordingState.id)
      if (!d) return
      d.marks.push(time)
      await patchSession(recordingState.id, { marks: d.marks })
      markListeners.forEach((cb) => cb({ sessionId: recordingState!.id, time }))
    },
    onSessionMarked: (cb) => {
      markListeners.add(cb)
      return () => markListeners.delete(cb)
    },

    generateReel: async () => ({ error: 'Highlight reels are not available on the web version yet — use the desktop app.' }),
    saveReel: async () => ({ error: 'Not available on the web version.' }),

    prepareSession: async (id: string) => (await loadSession(id))?.meta ?? null,

    renameSession: async (id, title) => {
      const d = await loadSession(id)
      if (!d) return null
      d.meta.title = title
      await patchSession(id, { meta: d.meta })
      emitSession(d.meta)
      return d.meta
    },

    setSessionBanner: async (id, banner) => {
      const d = await loadSession(id)
      if (!d) return null
      if (banner) {
        const url = await storeBanner(id, banner)
        if (!url) return null
        d.meta.banner = url
      } else {
        delete d.meta.banner
        await sb.storage.from('stage').remove([bannerPath(id)]).catch(() => undefined)
      }
      await patchSession(id, { meta: d.meta })
      emitSession(d.meta)
      return d.meta
    },

    exportSession: async (id, kind) => {
      const text = await api.getExportText(id, kind)
      if (!text) return { error: 'Nothing to export yet.' }
      const d = await loadSession(id)
      downloadText(`${(d?.meta.title || 'sitka').replace(/[^\w-]+/g, '-')}-${kind}.md`, text)
      return { ok: true }
    },

    getExportText: async (id, kind) => {
      const d = await loadSession(id)
      if (!d) return null
      if (kind === 'transcript') {
        if (d.segments.length === 0) return null
        return `# ${d.meta.title} — transcript\n\n${d.segments.map((s) => `**[${formatTime(s.start)}]** ${s.text.trim()}`).join('\n\n')}`
      }
      if (kind === 'notes') {
        if (!d.notes) return null
        const moments = d.notes.moments
          .map((m) => `- ${m.kind === 'important' ? 'Important' : 'Question'} [${m.time}] ${m.label}`)
          .join('\n')
        return `# ${d.meta.title} — notes\n\n${d.notes.markdown}\n\n## Moments\n${moments}`
      }
      if (kind === 'study') {
        if (!d.study) return null
        return [
          `# ${d.meta.title} — study pack`,
          '## Key concepts',
          ...d.study.concepts.map((c) => `- **${c.term}** — ${c.definition}`),
          '## Flashcards',
          ...d.study.flashcards.map((f) => `- Q: ${f.front}\n  A: ${f.back}`),
          '## Quiz',
          ...d.study.quiz.map(
            (q, i) =>
              `${i + 1}. ${q.question}\n${q.options.map((o, j) => `   ${j === q.answerIndex ? '✓' : '-'} ${o}`).join('\n')}\n   _${q.explanation}_`
          )
        ].join('\n\n')
      }
      // overview
      const parts = [`# ${d.meta.title}`]
      if (d.meta.summary) parts.push(d.meta.summary)
      if (d.meta.highlights?.length) {
        parts.push('## Key moments', ...d.meta.highlights.map((h) => `- [${h.time}] ${h.label}`))
      }
      if (d.marks.length) {
        parts.push('## Your marks', ...d.marks.map((m) => `- [${formatTime(m)}]`))
      }
      return parts.length > 1 ? parts.join('\n\n') : null
    },

    createSampleSession: async () => {
      // One sample per workspace: reuse it if it already exists.
      const existing = (await api.listSessions()).find((s) => s.sample)
      if (existing) return existing
      const meta = await api.createSession(SAMPLE_TITLE, 'lecture', false)
      meta.audioOnly = true
      meta.sample = true
      recBuf.delete(meta.id)
      const d = cache.get(meta.id)
      if (d) d.segments = sampleSegments()
      await patchSession(meta.id, { meta, transcript: sampleSegments() })
      // Finalize like a real session: names it, summarises, extracts memory.
      recBuf.set(meta.id, { parts: 0, seq: 0, chunks: [], bytes: 0, thumbDone: true, chain: Promise.resolve() })
      return api.finalizeSession(meta.id, sampleDurationMs())
    },

    finalizeSession: async (id, durationMs) => {
      recordingState = null
      const d = await loadSession(id)
      if (!d) return null
      d.meta.durationMs = durationMs
      d.meta.status = 'complete'
      track('session_end', {
        kind: d.meta.kind,
        minutes: Math.round(durationMs / 60000),
        hosted: Boolean(d.meta.hosted),
        audio: Boolean(d.meta.audioOnly),
        captions: d.segments.length
      })
      await endConf(id).catch((err) =>
        reportError(location.pathname, `end of event failed: ${err instanceof Error ? err.message : String(err)}`)
      )
      if (d.meta.hosted && d.meta.eventId) d.meta.replayUrl = replayUrlFor(d.meta.eventId)

      // Flush the tail of the recording and wait for every part to land.
      const b = recBuf.get(id)
      if (b) {
        flushPart(id, true)
        await b.chain
        recBuf.delete(id)
        // Anything the cloud refused stays on this device and keeps retrying;
        // the session says so until the last part lands.
        let left = await retryPendingUploads(id)
        if (left < 0) left = (await localParts(id)).length
        if (left > 0) d.meta.recordingPending = true
        else delete d.meta.recordingPending
        // every part is up: join them into the one whole file players start fastest from
        if (left === 0) void consolidateRecording(id)
      }
      await patchSession(id, { meta: d.meta })
      backupSession(id) // belt-and-braces: text survives even if the row write above failed
      emitSession(d.meta)

      // analysis in the background
      if (hasChatKey() && d.segments.length > 2) void analyzeWebSession(id)
      return d.meta
    },

    reanalyzeSession: async (id: string) => {
      if (!hasChatKey()) return null
      await analyzeWebSession(id)
      return (await loadSession(id))?.meta ?? null
    },

    transcribeChunk: async (id, chunk, offsetSec, mime = 'audio/webm') => {
      if (!hasSttKey()) return { error: 'missing-key' }
      try {
        const bytes = new Uint8Array(chunk)
        let bin = ''
        const step = 0x8000
        for (let i = 0; i < bytes.length; i += step) {
          bin += String.fromCharCode(...bytes.subarray(i, i + step))
        }
        const k = storedSettings()
        const body = JSON.stringify({
          keys: { openaiApiKey: k.openaiApiKey, groqApiKey: k.groqApiKey },
          audioB64: btoa(bin),
          mime: (mime || 'audio/webm').split(';')[0],
          offsetSec
        })
        // a dropped request is tried again before it counts as a problem
        let r: Response | null = null
        let lastErr = ''
        for (const d of [0, 1500, 4000]) {
          if (d) await wait(d)
          try {
            r = await fetch('/api/transcribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body
            })
            break
          } catch (err) {
            lastErr = err instanceof Error ? err.message : String(err)
            if (!isNetworkError(lastErr)) throw err
          }
        }
        if (!r) {
          track('stt_error', { reason: 'network' })
          return { error: 'Connection dropped for a moment. Still listening.' }
        }
        const j = await r.json()
        if (!r.ok) {
          track('stt_error', { reason: String(j.error || r.status).slice(0, 80) })
          return { error: j.error || 'Transcription failed.' }
        }
        const segments: TranscriptSegment[] = j.segments || []
        if (segments.length > 0) {
          const d = await loadSession(id)
          if (d) {
            const startIdx = d.segments.length
            d.segments.push(...segments)
            await patchSession(id, { transcript: d.segments })
            if (conf?.sessionId === id) void confPushSegments(segments, startIdx)
          }
        }
        return { segments }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },

    askAi: async (req: AskRequest) => {
      track('ask', {
        live: req.live,
        host: Boolean(req.host),
        screen: Boolean(req.frame),
        files: req.attachments?.length ?? 0
      })
      try {
        const d = await loadSession(req.sessionId)
        const segments = d?.segments ?? []
        let system: string
        if (req.host) {
          system = [
            'You are the host co-pilot for a live event — the speaker glances at you mid-talk.',
            'Be extremely terse: 1-3 short sentences, no headings, no fluff. Reference moments as [[M:SS]] when useful.',
            `Audience right now: ${conf?.attendeeCount ?? 0} connected, ${conf?.questions.reduce((n, g) => n + g.items.length, 0) ?? 0} questions waiting${conf?.questions[0] ? ` (top topic: ${conf.questions[0].topic})` : ''}.`,
            d?.meta.agenda?.length ? `Planned agenda: ${d.meta.agenda.join('; ')}` : '',
            `\nTranscript so far:\n${transcriptBlock(segments)}`
          ]
            .filter(Boolean)
            .join('\n')
        } else {
          const materials = await sessionMaterialsBlock(req.sessionId)
          // The latest reading of the screen is repeated up front so "what is
          // on the board?" is answered even when the transcript is long.
          const lastScreen = [...segments].reverse().find((s) => s.text.startsWith(ON_SCREEN_PREFIX))
          const screenNow =
            req.live && lastScreen
              ? `\nMost recent reading of the screen (at ${formatTime(lastScreen.start)}): ${lastScreen.text.slice(ON_SCREEN_PREFIX.length)}\n`
              : ''
          const lang = storedSettings().answerLanguage
          const langRule = lang
            ? `\n- Always answer in ${lang}, whatever language the session or the question is in, unless the user explicitly asks for another language.\n`
            : ''
          // the part of the session this question needs, not the whole hour
          system = `${askSystemPrompt(req.live)}${langRule}\n${materials ? materials + '\n\n' : ''}${screenNow}${excerptFor(segments, req.question, req.live)}`
        }
        const history: ChatMsg[] = req.history
          .slice(-10)
          .map((m) => ({ role: m.role, content: m.content }))
        // Live sessions attach the current screen so Sitca can read what is
        // being presented — graphs, slides, diagrams — not only what is said.
        // Anything the user attached with + comes too: documents as text ahead
        // of the question, pictures as images after the screen.
        const folded = foldAttachments(req.question, req.attachments)
        const parts: ({ type: 'image'; dataUrl: string } | { type: 'text'; text: string })[] = []
        const notes: string[] = []
        if (req.frame && !req.host) {
          parts.push({ type: 'image', dataUrl: req.frame })
          notes.push(
            '(The first image is what is currently on screen in the live session. Read it carefully: when asked what is written or shown, quote it exactly as it appears — equations, labels, names, values.)'
          )
        }
        for (const img of folded.images) parts.push({ type: 'image', dataUrl: img })
        if (folded.images.length > 0) notes.push(folded.imageNote)
        const last: ChatMsg =
          parts.length > 0
            ? {
                role: 'user',
                content: [...parts, { type: 'text', text: `${notes.join('\n')}\n\n${folded.question}` }]
              }
            : { role: 'user', content: folded.question }
        // no picture to read: the quick models answer first
        const text = (await aiChatFull(system, [...history, last], 2000, false, parts.length === 0)).text
        emitAi({ requestId: req.requestId, type: 'delta', text })
        emitAi({ requestId: req.requestId, type: 'done' })
      } catch (err) {
        emitAi({
          requestId: req.requestId,
          type: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
      }
    },

    askBrain: async (req: BrainAskRequest) => {
      track('ask_overview', {})
      try {
        const rows = await allSessions()
        const hits = rankHits(rows, req.question, 40)
        const titleById = new Map(rows.map((r) => [r.id, r.meta.title]))
        const context =
          hits.length > 0
            ? hits
                .map((h) => `[[${h.sessionId.slice(0, 8)}@${formatTime(h.time)}]] (${h.sessionTitle}) ${h.snippet}`)
                .join('\n')
            : '(No matching moments found in the library.)'
        const idMap = new Map(rows.map((r) => [r.id.slice(0, 8), r.id]))
        const system = [
          'You are Sitca Overview — the intelligence over EVERYTHING this user has attended and recorded.',
          person(),
          `Their library: ${rows.length} sessions — ${rows.map((r) => `"${r.meta.title}"`).slice(0, 20).join(', ')}.`,
          'Relevant moments retrieved from their sessions are below; each is tagged [[<id>@M:SS]].',
          'Rules: ground answers in the retrieved moments; cite them EXACTLY as [[<id>@M:SS]] (plain ASCII double brackets, ONE time, never a range) so the app renders clickable links into those recordings. If the library does not cover something, say so.',
          'Talking to the user, call each one "the session" (by its title), never "the transcript".',
          'Cite a moment when the user would want to jump to it: a specific claim, a figure, a decision, "when was X said". Do NOT cite inside anything they will keep or share — a ```document block, a summary, notes, the main topics — unless they ask for the moments; a summary reads as prose.',
          'When asked to write, draft, design or develop a document (report, letter, plan, memo, proposal, notes, one-pager), put the whole document in one fenced block starting with ```document whose first line is "Title: <the title>" and whose body is markdown. The app shows it as a document the user can open, copy and download.',
          'When the user asks what YOU think — an opinion, a critique, whether an idea holds up, what you would challenge or add — give a genuine, reasoned point of view drawing on your broader knowledge as well as their library. Never say you cannot have an opinion; make clear what is your assessment versus what was said.',
          'Keep answers direct; structure only when genuinely helpful.',
          `\nRetrieved moments:\n${context}`
        ].join('\n')
        const history = req.history.slice(-10).map((m) => ({ role: m.role, content: m.content }))
        let text = await aiChat(system, [...history, { role: 'user', content: req.question }])
        // expand 8-char ids back to full session ids for the citation chips
        text = text.replace(/\[\[([a-fA-F0-9]{8})@/g, (_m, short: string) => `[[${idMap.get(short.toLowerCase()) ?? short}@`)
        emitAi({ requestId: req.requestId, type: 'delta', text })
        emitAi({ requestId: req.requestId, type: 'done' })
      } catch (err) {
        emitAi({
          requestId: req.requestId,
          type: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
      }
    },

    // ---------- organisations: a university or a company, with spaces inside ----------
    listOrgs: async (): Promise<Organization[]> => {
      const { data: rows, error } = await sb
        .from('organizations')
        .select('id,name,kind,owner,code,lead_code,created_at')
        .order('created_at', { ascending: true })
      if (error || !rows) return []
      const ids = rows.map((r) => r.id as string)
      if (ids.length === 0) return []
      const [{ data: members }, { data: spaces }] = await Promise.all([
        sb.from('org_members').select('org_id,user_id,role').in('org_id', ids),
        sb.from('org_spaces').select('id,org_id').in('org_id', ids)
      ])
      return rows.map((r) => {
        const mine = (members ?? []).find((m) => m.org_id === r.id && m.user_id === user.id)
        const role = ((mine?.role as OrgRole) ?? 'member') as OrgRole
        const lead = role === 'owner' || role === 'lead'
        return {
          id: r.id as string,
          name: r.name as string,
          kind: r.kind as Space,
          role,
          code: lead ? (r.code as string) : undefined,
          leadCode: role === 'owner' ? (r.lead_code as string) : undefined,
          members: (members ?? []).filter((m) => m.org_id === r.id).length,
          spaces: (spaces ?? []).filter((s) => s.org_id === r.id).length,
          createdAt: new Date(r.created_at as string).getTime()
        }
      })
    },
    createOrg: async (name: string, kind: Space) => {
      const clean = name.trim()
      if (!clean) return { error: 'Give the organisation a name.' }
      // up to five of one's own, for now
      const { count } = await sb.from('organizations').select('id', { count: 'exact', head: true }).eq('owner', user.id)
      if ((count ?? 0) >= 5) return { error: 'You have set up five organisations, the most for now.' }
      const code = (): string =>
        Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('')
      const id = uid()
      const { error } = await sb.from('organizations').insert({
        id,
        name: clean,
        kind,
        owner: user.id,
        code: code(),
        lead_code: code()
      })
      if (error) {
        return {
          error: /relation .* does not exist/i.test(error.message)
            ? 'Organisations are not set up yet — run supabase/wave9.sql in the Supabase SQL editor.'
            : error.message
        }
      }
      const profile = await api.getProfile()
      await sb.from('org_members').insert({
        org_id: id,
        user_id: user.id,
        role: 'owner',
        name: profile.name,
        email: profile.email ?? ''
      })
      const org = (await api.listOrgs()).find((o) => o.id === id)
      return org ? { org } : { error: 'The organisation was created but could not be read back.' }
    },
    joinOrg: async (code: string) => {
      const { data, error } = await sb.rpc('sitka_join_org', { p_code: code.trim() })
      if (error) return { error: error.message.replace(/^.*?:\s*/, '') || 'Could not join.' }
      const row = (Array.isArray(data) ? data[0] : data) as { id: string } | null
      if (!row) return { error: 'No organisation has that code.' }
      const org = (await api.listOrgs()).find((o) => o.id === row.id)
      return org ? { org } : { error: 'Joined, but the organisation could not be read back.' }
    },
    leaveOrg: async (orgId: string) => {
      await sb.from('org_members').delete().eq('org_id', orgId).eq('user_id', user.id)
    },
    deleteOrg: async (orgId: string) => {
      // The row goes and the database takes its members, spaces and materials
      // with it. Sessions filed in its spaces are untouched: they belong to
      // the people who recorded them and simply stop being filed anywhere.
      const { error, count } = await sb.from('organizations').delete({ count: 'exact' }).eq('id', orgId)
      if (error) return { error: error.message }
      if (!count) return { error: 'Only the owner can delete an organisation.' }
      track('org_deleted', { org: orgId })
      return {}
    },
    listOrgMembers: async (orgId: string): Promise<OrgMember[]> => {
      const { data } = await sb
        .from('org_members')
        .select('user_id,name,email,role,joined_at')
        .eq('org_id', orgId)
        .order('joined_at', { ascending: true })
      return (data ?? []).map((m) => ({
        userId: m.user_id as string,
        name: (m.name as string) || (m.email as string).split('@')[0] || 'Member',
        email: m.email as string,
        role: m.role as OrgRole,
        joinedAt: new Date(m.joined_at as string).getTime()
      }))
    },
    listSpaces: async (orgId: string): Promise<OrgSpace[]> => {
      const { data: spaces } = await sb
        .from('org_spaces')
        .select('id,org_id,name,kind,description,created_at,created_by')
        .eq('org_id', orgId)
        .order('created_at', { ascending: true })
      if (!spaces || spaces.length === 0) return []
      const ids = spaces.map((s) => s.id as string)
      const [{ data: mats }, sessionCounts] = await Promise.all([
        sb.from('org_materials').select('space_id').in('space_id', ids),
        Promise.all(
          ids.map(async (sid) => {
            const { data } = await sb.rpc('sitka_space_sessions', { p_space: sid })
            return [sid, Array.isArray(data) ? data.length : 0] as const
          })
        )
      ])
      const sessionsBy = new Map(sessionCounts)
      return spaces.map((s) => ({
        id: s.id as string,
        orgId: s.org_id as string,
        name: s.name as string,
        kind: s.kind as OrgSpaceKind,
        description: (s.description as string) || '',
        sessions: sessionsBy.get(s.id as string) ?? 0,
        materials: (mats ?? []).filter((m) => m.space_id === s.id).length,
        createdAt: new Date(s.created_at as string).getTime(),
        mine: s.created_by === user.id
      }))
    },
    createSpace: async (orgId: string, name: string, kind: OrgSpaceKind, description: string) => {
      const clean = name.trim()
      if (!clean) return { error: 'Give it a name.' }
      const id = uid()
      const { error } = await sb.from('org_spaces').insert({
        id,
        org_id: orgId,
        name: clean,
        kind,
        description: description.trim(),
        created_by: user.id
      })
      if (error) {
        return {
          error: /row-level security/i.test(error.message)
            ? 'Only leads and the owner can create spaces here.'
            : error.message
        }
      }
      const space = (await api.listSpaces(orgId)).find((s) => s.id === id)
      return space ? { space } : { error: 'Created, but could not be read back.' }
    },
    deleteSpace: async (spaceId: string) => {
      // the database allows this only for the space's creator or the organisation's owner
      const { error, count } = await sb.from('org_spaces').delete({ count: 'exact' }).eq('id', spaceId)
      if (error) throw new Error(error.message)
      if (!count) throw new Error('Only the owner of the organisation and its leads can delete this.')
    },
    listSpaceMaterials: async (spaceId: string): Promise<SpaceMaterial[]> => {
      const { data } = await sb
        .from('org_materials')
        .select('id,name,chars,added_by_name,created_at')
        .eq('space_id', spaceId)
        .order('created_at', { ascending: true })
      return (data ?? []).map((m) => ({
        id: m.id as string,
        name: m.name as string,
        chars: m.chars as number,
        addedBy: (m.added_by_name as string) || '',
        addedAt: new Date(m.created_at as string).getTime()
      }))
    },
    addSpaceMaterial: async (spaceId: string, name: string, text: string) => {
      const clean = text.slice(0, 200000)
      const profile = await api.getProfile()
      const { error } = await sb.from('org_materials').insert({
        id: uid(),
        space_id: spaceId,
        name,
        text: clean,
        chars: clean.length,
        added_by: user.id,
        added_by_name: profile.name
      })
      if (error) {
        throw new Error(
          /row-level security/i.test(error.message)
            ? 'Only leads and the owner can add materials here.'
            : error.message
        )
      }
      return api.listSpaceMaterials(spaceId)
    },
    removeSpaceMaterial: async (spaceId: string, materialId: string) => {
      await sb.from('org_materials').delete().eq('id', materialId)
      return api.listSpaceMaterials(spaceId)
    },
    listSpaceSessions: async (spaceId: string): Promise<SessionMeta[]> => {
      const { data } = await sb.rpc('sitka_space_sessions', { p_space: spaceId })
      const rows = (Array.isArray(data) ? data : []) as { id: string; meta: SessionMeta }[]
      return rows.map((r) => r.meta).filter((m) => m && m.status === 'complete')
    },
    assignSessionToSpace: async (sessionId: string, spaceId: string | null) => {
      const d = await loadSession(sessionId)
      if (!d || d.meta.readOnly) return
      d.meta.spaceId = spaceId ?? undefined
      await patchSession(sessionId, { meta: d.meta, space_id: spaceId })
      emitSession(d.meta)
    },
    askSpace: async (req: SpaceAskRequest) => {
      try {
        const [{ data: spaceRow }, { data: mats }, { data: sessRows }] = await Promise.all([
          sb.from('org_spaces').select('name,kind,description').eq('id', req.spaceId).single(),
          sb.from('org_materials').select('name,text').eq('space_id', req.spaceId),
          sb.rpc('sitka_space_sessions', { p_space: req.spaceId })
        ])
        const space = spaceRow as { name: string; kind: string; description: string } | null
        const sessions = (Array.isArray(sessRows) ? sessRows : []) as { id: string; meta: SessionMeta }[]
        // Newest sessions first, trimmed so a whole term still fits one request.
        const ids = sessions.filter((s) => s.meta?.status === 'complete').slice(0, 12).map((s) => s.id)
        const full = await Promise.all(
          ids.map(async (id) => {
            const { data } = await sb.rpc('sitka_space_session', { p_id: id })
            const s = (Array.isArray(data) ? data[0] : data) as { meta: SessionMeta; transcript: TranscriptSegment[] } | undefined
            return s ? { title: s.meta.title, segments: s.transcript || [] } : null
          })
        )
        const per = Math.floor(70000 / Math.max(1, ids.length))
        const sessionsBlock = full
          .filter((s): s is { title: string; segments: TranscriptSegment[] } => Boolean(s))
          .map((s) => {
            const id8 = ids[full.indexOf(s)]?.slice(0, 8) ?? ''
            let t = s.segments.map((seg) => `[[${id8}@${formatTime(seg.start)}]] ${seg.text.trim()}`).join('\n')
            if (t.length > per) t = t.slice(0, per) + '\n… (trimmed)'
            return `=== "${s.title}" ===\n${t}`
          })
          .join('\n\n')
        const materials = materialsBlock(
          ((mats ?? []) as { name: string; text: string }[]).map((m) => ({ name: m.name, text: m.text })),
          30000
        )
        const noun = space?.kind === 'course' ? 'course' : space?.kind === 'team' ? 'team' : 'project'
        const system = [
          `You are Sitca for the ${noun} "${space?.name ?? ''}"${space?.description ? ` — ${space.description}` : ''}.`,
          person(),
          noun === 'course'
            ? 'You are the teaching assistant for this course: you answer from what the lecturer actually taught in these sessions and from the materials they shared, in the terms they used. This is what will be examined.'
            : 'You are the memory of this team: you answer from what was actually said in these meetings and from the shared materials — decisions, reasons, promises and who made them.',
          'Rules:',
          '- Ground answers in the sessions and materials below. If something was not covered, say so plainly.',
          '- Cite moments as [[<id>@M:SS]] exactly as they appear below (plain ASCII double brackets); the app turns them into links into the recording.',
          '- When asked what you think, give a reasoned view and make clear it is yours rather than the speaker’s.',
          '- Keep answers direct; use headings, lists or a table only when they genuinely help.',
          materials || '',
          `\nSessions (newest first):\n${sessionsBlock || '(No sessions in this space yet.)'}`
        ]
          .filter(Boolean)
          .join('\n')
        const history: ChatMsg[] = req.history.slice(-10).map((m) => ({ role: m.role, content: m.content }))
        let text = await aiChat(system, [...history, { role: 'user', content: req.question }])
        const idMap = new Map(ids.map((id) => [id.slice(0, 8).toLowerCase(), id]))
        text = text.replace(/\[\[([a-fA-F0-9]{8})@/g, (_m, short: string) => `[[${idMap.get(short.toLowerCase()) ?? short}@`)
        emitAi({ requestId: req.requestId, type: 'delta', text })
        emitAi({ requestId: req.requestId, type: 'done' })
      } catch (err) {
        emitAi({ requestId: req.requestId, type: 'error', error: err instanceof Error ? err.message : String(err) })
      }
    },
    spaceInsights: async (spaceId: string): Promise<SpaceInsight[]> => {
      const { data } = await sb.rpc('sitka_space_insights', { p_space: spaceId })
      const rows = (Array.isArray(data) ? data : []) as {
        session_id: string
        meta: SessionMeta
        created_at: string
        lost: number
        asks: number
        questions: string[]
      }[]
      return rows.map((r) => ({
        sessionId: r.session_id,
        title: r.meta?.title ?? 'Session',
        createdAt: r.meta?.createdAt ?? new Date(r.created_at).getTime(),
        durationMs: r.meta?.durationMs ?? 0,
        lost: Number(r.lost) || 0,
        asks: Number(r.asks) || 0,
        questions: Array.isArray(r.questions) ? r.questions.map(String) : []
      }))
    },

    searchLibrary: async (query: string) => rankHits(await allSessions(), query, 24),

    brainStats: async (): Promise<BrainStats> => {
      const rows = await allSessions()
      let words = 0
      let moments = 0
      let totalMs = 0
      for (const r of rows) {
        totalMs += r.meta.durationMs || 0
        for (const s of r.transcript || []) words += s.text.split(/\s+/).length
        moments += r.notes?.moments?.length ?? 0
      }
      return { sessions: rows.length, totalMs, words, moments }
    },

    listBrainChats: async () => {
      const { data } = await sb
        .from('brain_chats')
        .select('data')
        .order('updated_at', { ascending: false })
      return ((data ?? []) as { data: BrainConversation }[]).map((r) => r.data)
    },
    saveBrainChat: async (conv: BrainConversation) => {
      await sb.from('brain_chats').upsert({
        id: conv.id,
        owner: user.id,
        data: conv,
        updated_at: new Date().toISOString()
      })
    },
    deleteBrainChat: async (id: string) => {
      await sb.from('brain_chats').delete().eq('id', id)
    },

    // ---------- live audience ----------
    startConference: async (sessionId: string) => {
      try {
        const d = await loadSession(sessionId)
        if (!d) return { error: 'Session not found.' }
        let eventId = d.meta.eventId
        if (!eventId) {
          eventId = uid()
          const { error } = await sb.from('events').insert({
            id: eventId,
            owner: user.id,
            title: d.meta.title,
            status: 'live',
            agenda: d.meta.agenda ?? [],
            pre_event_chat: true,
            materials_present: false,
            live_voice: { enabled: true, languages: ALL_LANGS },
            session_id: sessionId
          })
          if (error) return { error: error.message }
          d.meta.eventId = eventId
          await patchSession(sessionId, { meta: d.meta })
        } else {
          const err = await setEventStatus(eventId, 'live', { session_id: sessionId })
          if (err) return { error: 'The event could not be set live: ' + err }
        }
        if (conf) {
          clearInterval(conf.workTimer)
          clearInterval(conf.statsTimer)
        }
        conf = {
          eventId,
          sessionId,
          url: eventUrl(eventId),
          answering: new Set(),
          attendeeLangs: new Map(),
          attendeeCount: 0,
          askCount: 0,
          questions: [],
          reactions: { landed: 0, lost: 0, recentLost: 0 },
          poll: null,
          translated: new Map(),
          frameBusy: false,
          workTimer: window.setInterval(() => void confPollWork(), 3000),
          statsTimer: window.setInterval(() => void confPollStats(), 5000)
        }
        return { url: conf.url }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
    endEventNow: async (id) => {
      // the host has tapped End: the room hears it before anything else is
      // wound down. The room's own state is kept for the report that follows.
      if (conf && conf.sessionId === id) await setEventStatus(conf.eventId, 'ended')
    },
    stopConference: async () => {
      if (conf) {
        clearInterval(conf.workTimer)
        clearInterval(conf.statsTimer)
        await setEventStatus(conf.eventId, 'ended')
        conf = null
      }
    },
    conferenceStatus: async () => {
      if (conf) {
        return {
          running: true,
          url: conf.url,
          ended: false,
          eventId: conf.eventId,
          attendees: conf.attendeeCount,
          recentAsks: conf.askCount,
          questions: conf.questions,
          reactions: conf.reactions,
          poll: conf.poll ?? undefined
        }
      }
      if (armedId) {
        const { count } = await sb
          .from('attendees')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', armedId)
        return {
          running: true,
          waiting: true,
          eventId: armedId,
          url: eventUrl(armedId),
          attendees: count ?? 0
        }
      }
      return { running: false }
    },
    // ---------- memory ----------
    listMemory: async () => loadMemory(),
    updateMemory: async (id, patch) => {
      const { data } = await sb.from('memory_objects').select('data').eq('id', id).single()
      if (!data) return null
      const obj = data.data as MemoryObject
      if (patch.status) obj.status = patch.status
      obj.updatedAt = Date.now()
      await sb
        .from('memory_objects')
        .update({ data: obj, updated_at: new Date().toISOString() })
        .eq('id', id)
      return obj
    },
    deleteMemory: async (id: string) => {
      await sb.from('memory_objects').delete().eq('id', id)
    },

    // ---------- Room's Mind: what the audience is privately struggling with ----------
    roomMind: async (sessionId: string) => {
      if (!conf || conf.sessionId !== sessionId || !hasChatKey()) return { themes: [] }
      try {
        const { data: asks } = await sb
          .from('asks')
          .select('question,created_at')
          .eq('event_id', conf.eventId)
          .eq('kind', 'ask')
          .order('created_at', { ascending: false })
          .limit(40)
        const recent = (asks ?? []).filter(
          (a) => Date.now() - new Date(a.created_at as string).getTime() < 20 * 60000
        )
        if (recent.length < 3) return { themes: [] }
        const system = [
          'You are analyzing the PRIVATE questions a live audience is asking their AI companions during a talk — the speaker cannot see them individually. Your job: reveal what the room is collectively struggling with or curious about, without exposing anyone.',
          'Cluster the questions into at most 4 themes.',
          'Return ONLY JSON: {"themes": [{"topic": "2-5 word label", "count": <number of questions in this theme>}]}',
          'Order by count, largest first. Merge near-duplicates. No theme for a single stray question unless there are no better clusters.'
        ].join('\n')
        const out = await aiChat(system, [
          { role: 'user', content: recent.map((a, i) => `${i + 1}. ${a.question}`).join('\n') }
        ])
        const parsed = extractJson<{ themes?: { topic?: string; count?: number }[] }>(out)
        return {
          themes: (parsed?.themes ?? [])
            .filter((t) => t.topic)
            .map((t) => ({ topic: String(t.topic), count: Math.max(1, Number(t.count) || 1) }))
            .slice(0, 4)
        }
      } catch {
        return { themes: [] }
      }
    },
    roomRecap: async (sessionId: string, topic: string) => {
      if (!hasChatKey()) return { error: 'missing-key' }
      try {
        const d = await loadSession(sessionId)
        if (!d) return { error: 'Session not found.' }
        const system = [
          `A live audience is collectively struggling with: "${topic}". Using the transcript, write a crystal-clear recap of that point in 3-5 short sentences, as if explaining it fresh to someone who just got lost.`,
          'Plain text, no markdown headings, no preamble — it may be read aloud by the speaker or pushed to every attendee phone.'
        ].join('\n')
        const text = await aiChat(system, [
          { role: 'user', content: transcriptBlock(d.segments.slice(-80)) }
        ])
        return { text: text.trim() }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
    pushRoomNote: async (text: string) => {
      if (!conf) return { error: 'Go live first.' }
      const { error } = await sb.from('room_notes').insert({
        id: uid(),
        event_id: conf.eventId,
        text: text.trim().slice(0, 1200)
      })
      return error ? { error: error.message } : {}
    },

    publishReplay: async (sessionId: string, enable: boolean) => {
      const d = await loadSession(sessionId)
      if (!d) return { error: 'Session not found.' }
      const evId = d.meta.eventId
      if (!evId) return { error: 'Only sessions hosted as events can be published as replays.' }
      if (!enable) {
        await sb
          .from('events')
          .update({
            replay: { enabled: false },
            updated_at: new Date().toISOString()
          })
          .eq('id', evId)
        // the public copy, if one was ever made, goes with it
        await sb.storage.from('replays').remove([`${evId}.webm`]).catch(() => undefined)
        delete d.meta.replayUrl
        await patchSession(sessionId, { meta: d.meta })
        emitSession(d.meta)
        return { enabled: false }
      }
      // Nothing is copied. The recap opens the host's own recording, wherever
      // it already is, for as long as the replay stays switched on. That keeps
      // one copy of a lecture instead of two, and makes publishing instant
      // however long the session ran.
      const hasVideo = d.meta.whole === true || (await store.list(`${user.id}/${sessionId}`)).objects.length > 0
      if (!hasVideo) {
        void consolidateRecording(sessionId)
      }
      await sb
        .from('events')
        .update({
          replay: {
            enabled: true,
            title: d.meta.title,
            summary: d.meta.summary ?? '',
            highlights: d.meta.highlights ?? [],
            durationMs: d.meta.durationMs,
            video: hasVideo,
            publishedAt: Date.now()
          },
          updated_at: new Date().toISOString()
        })
        .eq('id', evId)
      d.meta.replayUrl = replayUrlFor(evId)
      await patchSession(sessionId, { meta: d.meta })
      emitSession(d.meta)
      return { enabled: true, url: replayUrlFor(evId) }
    },
    publishRecap: async (sessionId: string, enable: boolean) => {
      const d = await loadSession(sessionId)
      if (!d) return { error: 'Session not found.' }
      if (!enable) {
        const { error } = await sb
          .from('recaps')
          .update({ enabled: false, updated_at: new Date().toISOString() })
          .eq('id', sessionId)
        if (error) return { error: 'Could not stop sharing: ' + error.message }
        delete d.meta.recapUrl
        await patchSession(sessionId, { meta: d.meta })
        emitSession(d.meta)
        return { enabled: false }
      }
      if (d.segments.length === 0) {
        return { error: 'Nothing to share yet — this session has no transcript.' }
      }
      const thumb = await api.getThumb(sessionId).catch(() => null)
      const { error } = await sb.from('recaps').upsert({
        id: sessionId,
        owner: user.id,
        thumb: thumb ?? null,
        title: d.meta.title,
        summary: d.meta.summary ?? '',
        highlights: d.meta.highlights ?? [],
        notes: d.notes?.markdown ?? '',
        transcript: d.segments,
        duration_ms: d.meta.durationMs,
        session_at: new Date(d.meta.createdAt).toISOString(),
        enabled: true,
        // recorded on the website: the parts are in the cloud and the recap can play them
        has_recording: !d.meta.readOnly && !d.meta.sample,
        updated_at: new Date().toISOString()
      })
      if (error) {
        return {
          error: /relation .* does not exist/i.test(error.message)
            ? 'Sharing is not set up yet — run supabase/wave6.sql in the Supabase SQL editor.'
            : 'Could not share: ' + error.message
        }
      }
      const url = `${location.origin}/r/${sessionId}`
      d.meta.recapUrl = url
      await patchSession(sessionId, { meta: d.meta })
      emitSession(d.meta)
      return { enabled: true, url }
    },
    launchPoll: async (question: string, options: string[]) => {
      if (!conf) return { error: 'Go live first.' }
      const cleanOpts = options.map((o) => o.trim()).filter(Boolean).slice(0, 6)
      if (!question.trim() || cleanOpts.length < 2) {
        return { error: 'A poll needs a question and at least two options.' }
      }
      // close any open poll first — one at a time keeps the room focused
      await sb.from('polls').update({ status: 'closed' }).eq('event_id', conf.eventId).eq('status', 'open')
      const { error } = await sb.from('polls').insert({
        id: uid(),
        event_id: conf.eventId,
        question: question.trim().slice(0, 200),
        options: cleanOpts,
        status: 'open'
      })
      if (error) return { error: error.message }
      void confPollStats()
      return {}
    },
    closePoll: async () => {
      if (!conf) return
      await sb.from('polls').update({ status: 'closed' }).eq('event_id', conf.eventId).eq('status', 'open')
      void confPollStats()
    },
    // ---------- the room chat: attendees talking, the host listening and joining in ----------
    listRoomMessages: async (eventId?: string) => {
      // the live event by default; any past event by id, so a host can
      // read the room again after it ended
      const evId = eventId ?? conf?.eventId
      if (!evId) return []
      const { data } = await sb
        .from('room_messages')
        .select('id,name,host,text,created_at')
        .eq('event_id', evId)
        .order('created_at', { ascending: false })
        .limit(80)
      return (data ?? [])
        .reverse()
        .map((r) => ({
          id: r.id as string,
          name: (r.name as string) || 'Guest',
          host: Boolean(r.host),
          text: r.text as string,
          at: new Date(r.created_at as string).getTime()
        }))
    },
    sendRoomMessage: async (text: string) => {
      if (!conf) return { error: 'Go live first.' }
      const t = text.trim().slice(0, 600)
      if (!t) return {}
      const { error } = await sb.from('room_messages').insert({
        id: uid(),
        event_id: conf.eventId,
        attendee_id: null,
        name: 'Host',
        host: true,
        text: t
      })
      return error
        ? { error: /relation|does not exist/i.test(error.message) ? 'Run supabase/wave10.sql to enable the room chat.' : error.message }
        : {}
    },
    // ---------- live video to attendees (direct connections, small rooms) ----------
    startVideoBroadcast: async (source: unknown) => {
      const stream = source as MediaStream
      if (!conf || !stream || typeof RTCPeerConnection === 'undefined') return
      if (rtc) await stopRtcHost()
      const channel = sb.channel('rtc-' + conf.eventId, { config: { broadcast: { self: false } } })
      rtc = { channel, peers: new Map(), stream }
      channel.on('broadcast', { event: 'want' }, ({ payload }) => {
        const p = payload as { id?: string }
        if (p.id) void rtcOfferTo(String(p.id))
      })
      channel.on('broadcast', { event: 'answer' }, ({ payload }) => {
        const p = payload as { id: string; sdp: RTCSessionDescriptionInit }
        const pc = rtc?.peers.get(p.id)
        if (pc && pc.signalingState === 'have-local-offer') void pc.setRemoteDescription(p.sdp).catch(() => undefined)
      })
      channel.on('broadcast', { event: 'ice' }, ({ payload }) => {
        const p = payload as { id: string; from: string; candidate: RTCIceCandidateInit }
        if (p.from !== 'attendee') return
        void rtc?.peers.get(p.id)?.addIceCandidate(p.candidate).catch(() => undefined)
      })
      channel.subscribe()
    },
    stopVideoBroadcast: async () => stopRtcHost(),
    pushStageFrame: async (dataUrl: string) => {
      if (!conf || conf.frameBusy) return {}
      const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl)
      if (!m) return {}
      conf.frameBusy = true
      try {
        const bin = atob(m[1])
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const { error } = await sb.storage
          .from('stage')
          .upload(`${conf.eventId}.jpg`, new Blob([bytes], { type: 'image/jpeg' }), {
            upsert: true,
            contentType: 'image/jpeg',
            cacheControl: '0'
          })
        if (error) {
          return {
            error: /bucket|not found/i.test(error.message)
              ? 'the "stage" storage bucket is missing — run supabase/schema.sql'
              : /policy|security/i.test(error.message)
                ? 'the storage policy is missing — run supabase/host-upgrade.sql'
                : error.message
          }
        }
        return {}
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      } finally {
        if (conf) conf.frameBusy = false
      }
    },
    onConferenceUpdate: (cb) => {
      confListeners.add(cb)
      return () => confListeners.delete(cb)
    },

    // ---------- events ----------
    listEvents: async () => {
      const { data } = await sb
        .from('events')
        .select('*')
        .eq('owner', user.id)
        .order('starts_at', { ascending: false, nullsFirst: false })
      const rows = (data ?? []) as (EvRow & { status: string })[]
      const events = rows.map(evRowToScheduled)
      // A shared link works the moment an event exists — default the armed
      // presentation to the newest event that has not ended yet.
      if (!armedId) {
        armedId = rows.find((r) => r.status !== 'ended' && !r.session_id)?.id ?? null
      }
      const status = conf
        ? { running: true, url: conf.url, waiting: false, eventId: conf.eventId }
        : armedId
          ? { running: true, waiting: true, eventId: armedId, url: eventUrl(armedId) }
          : { running: false }
      return { events, status }
    },
    createEvent: async (title, startsAt, agenda) => {
      const id = uid()
      const { error } = await sb.from('events').insert({
        id,
        owner: user.id,
        title: title.trim() || 'Live event',
        status: 'waiting',
        starts_at: startsAt ? new Date(startsAt).toISOString() : null,
        agenda: agenda.filter(Boolean).slice(0, 12),
        pre_event_chat: true,
        materials_present: false,
        live_voice: { enabled: true, languages: ALL_LANGS }
      })
      if (error) return { error: error.message }
      const { data } = await sb.from('events').select('*').eq('id', id).single()
      return { url: eventUrl(id), event: data ? evRowToScheduled(data as EvRow) : undefined }
    },
    updateEvent: async (id, patch) => {
      const upd: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (patch.title !== undefined) upd.title = patch.title
      if (patch.startsAt !== undefined)
        upd.starts_at = patch.startsAt ? new Date(patch.startsAt).toISOString() : null
      if (patch.agenda !== undefined) upd.agenda = patch.agenda.filter(Boolean).slice(0, 12)
      if (patch.preEventChat !== undefined) upd.pre_event_chat = patch.preEventChat
      if (patch.liveVoice !== undefined) upd.live_voice = patch.liveVoice
      await sb.from('events').update(upd).eq('id', id)
      const { data } = await sb.from('events').select('*').eq('id', id).single()
      return data ? evRowToScheduled(data as EvRow) : null
    },
    deleteEvent: async (id: string) => {
      await sb.from('events').delete().eq('id', id)
      if (armedId === id) armedId = null
    },
    unfileSpaceSession: async (id: string) => {
      const { error } = await sb.rpc('sitka_unfile_session', { p_id: id })
      if (error) throw new Error(error.message)
      const d = cache.get(id)
      if (d) {
        delete d.meta.spaceId
        emitSession(d.meta)
      }
    },
    setEventBanner: async (id, dataUrl) => {
      const eventId = id ?? conf?.eventId ?? armedId
      if (!eventId) return null
      let banner: string | null = null
      if (dataUrl) {
        const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl)
        if (!m) return null
        const bin = atob(m[1])
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        // the same public bucket the live screen goes to; the name keeps it apart
        const path = `${eventId}-banner.jpg`
        const { error } = await sb.storage
          .from('stage')
          .upload(path, new Blob([bytes], { type: 'image/jpeg' }), { upsert: true, contentType: 'image/jpeg', cacheControl: '60' })
        if (error) throw new Error(error.message)
        banner = `${sb.storage.from('stage').getPublicUrl(path).data.publicUrl}?v=${Date.now()}`
      }
      await sb.from('events').update({ banner, updated_at: new Date().toISOString() }).eq('id', eventId)
      const { data } = await sb.from('events').select('*').eq('id', eventId).single()
      return data ? evRowToScheduled(data as EvRow) : null
    },
    armEvent: async (id: string) => {
      // Online events are always armed — the link works the moment it exists.
      const { data } = await sb.from('events').select('id').eq('id', id).single()
      if (!data) return { error: 'Event not found.' }
      armedId = id
      return { url: eventUrl(id) }
    },
    addMaterialFile: async (id: string) => {
      const picked = await pickTextFile()
      if (!picked) return { canceled: true }
      const { data } = await sb.from('events').select('materials').eq('id', id).single()
      const materials = ((data?.materials ?? []) as { name: string; chars: number; text: string }[]).concat({
        name: picked.name,
        chars: picked.text.length,
        text: picked.text
      })
      const event = await saveEventMaterials(id, materials)
      return event ? { event } : { error: 'Could not save material.' }
    },
    addMaterialText: async (id, name, text) => {
      const { data } = await sb.from('events').select('materials').eq('id', id).single()
      const materials = ((data?.materials ?? []) as { name: string; chars: number; text: string }[]).concat({
        name: name || 'Pasted notes',
        chars: text.length,
        text
      })
      const event = await saveEventMaterials(id, materials)
      return event ? { event } : { error: 'Could not save material.' }
    },
    removeMaterial: async (id, index) => {
      const { data } = await sb.from('events').select('materials').eq('id', id).single()
      const materials = ((data?.materials ?? []) as { name: string; chars: number; text: string }[]).filter(
        (_m, i) => i !== index
      )
      const event = await saveEventMaterials(id, materials)
      return event ? { event } : { error: 'Could not remove material.' }
    },
    saveQr: async (dataUrl: string, title: string) => {
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `${title.replace(/[^\w-]+/g, '-')}-qr.png`
      a.click()
      return { ok: true }
    },

    checkNudge: async (id, userQuestions, priorNudges) => {
      if (!hasChatKey()) return {}
      try {
        const d = await loadSession(id)
        if (!d || d.segments.length < 6) return {}
        const system = [
          'You quietly watch a live session alongside a user and occasionally surface ONE proactive nudge — something genuinely worth flagging (a term they may not know, a connection, something the speaker stressed).',
          'Return ONLY JSON: {"nudge": string | null}. Return null unless something truly earns an interruption. One short sentence, no markdown.',
          priorNudges.length ? `Already nudged (never repeat): ${priorNudges.join(' | ')}` : '',
          userQuestions.length ? `Their recent questions (their interests): ${userQuestions.join(' | ')}` : ''
        ]
          .filter(Boolean)
          .join('\n')
        const out = await aiChat(system, [
          { role: 'user', content: transcriptBlock(d.segments.slice(-40)) }
        ])
        const parsed = extractJson<{ nudge?: string | null }>(out)
        return parsed?.nudge ? { nudge: parsed.nudge } : {}
      } catch {
        return {}
      }
    },

    updateNotes: async (id: string) => {
      if (!hasChatKey()) return { error: 'missing-key' }
      try {
        const d = await loadSession(id)
        if (!d || d.segments.length === 0) return { notes: d?.notes ?? null }
        const system = [
          'You maintain live, organized notes for a session (lecture, meeting, or presentation) as it happens.',
          'You are given the timestamped transcript so far, and the previous version of the notes (which may be empty).',
          'Rewrite the notes so they cover everything discussed so far. Notes are NOT a transcript copy: organize by topic with "## " headings, short "-" bullets, key definitions in **bold**, and concrete examples where given.',
          'Also detect notable moments:',
          '- kind "important": points the speaker emphasized, stressed, repeated, or flagged.',
          '- kind "question": actual questions asked aloud during the session, quoted or closely paraphrased.',
          'Each moment needs "time" copied exactly from a transcript timestamp (like "12:37") and a short "label" (max 12 words).',
          'Return ONLY a JSON object, no prose and no code fences:',
          '{"notes": "<markdown string>", "moments": [{"time": "M:SS", "label": string, "kind": "important" | "question"}]}',
          'Keep the moments list complete for the whole session so far (carry earlier moments forward, do not drop them).'
        ].join('\n')
        const materials = await sessionMaterialsBlock(id)
        const out = await aiChat(system, [
          {
            role: 'user',
            content: `${materials ? materials + '\n\n' : ''}Previous notes:\n${d.notes?.markdown ?? '(none)'}\n\nTranscript:\n${transcriptBlock(d.segments)}`
          }
        ])
        const parsed = extractJson<{ notes?: string; moments?: SessionNotes['moments'] }>(out)
        if (!parsed?.notes) return { error: 'Could not update notes.' }
        const notes: SessionNotes = {
          markdown: parsed.notes,
          moments: Array.isArray(parsed.moments) ? parsed.moments : [],
          updatedAt: Date.now()
        }
        d.notes = notes
        await patchSession(id, { notes })
        return { notes }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },

    generateStudy: async (id: string) => {
      if (!hasChatKey()) return { error: 'missing-key' }
      try {
        const d = await loadSession(id)
        if (!d || d.segments.length < 3) return { error: 'Not enough transcript to build a study pack.' }
        const system = [
          'Build a study pack from this session transcript.',
          'Return ONLY JSON:',
          '{"concepts": [{"term": string, "definition": string}], "flashcards": [{"front": string, "back": string}], "quiz": [{"question": string, "options": [string], "answerIndex": number, "explanation": string}]}',
          '- 5-10 concepts (the ideas that matter), 6-12 flashcards, 4-8 quiz questions with exactly 4 options each.',
          '- Everything must come from the transcript content.'
        ].join('\n')
        const materials = await sessionMaterialsBlock(id)
        const out = await aiChat(
          system,
          [
            {
              role: 'user',
              content: materials
                ? `${materials}\n\nTranscript:\n${transcriptBlock(d.segments)}`
                : transcriptBlock(d.segments)
            }
          ],
          3000
        )
        const parsed = extractJson<Omit<StudyPack, 'generatedAt'>>(out)
        if (!parsed?.concepts) return { error: 'Could not build the study pack.' }
        const study: StudyPack = {
          concepts: parsed.concepts ?? [],
          flashcards: parsed.flashcards ?? [],
          quiz: parsed.quiz ?? [],
          generatedAt: Date.now()
        }
        d.study = study
        await patchSession(id, { study })
        return { study }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },

    // ---------- coach ----------
    listCoachProjects: async () => {
      const { data } = await sb
        .from('coach_projects')
        .select('data')
        .order('updated_at', { ascending: false })
      return ((data ?? []) as { data: CoachProject }[]).map((r) => r.data)
    },
    createCoachProject: async (title, goal, audience, when) => {
      const project: CoachProject = {
        id: uid(),
        title,
        goal,
        audience,
        when: when ?? undefined,
        createdAt: Date.now(),
        rehearsals: []
      }
      await sb.from('coach_projects').insert({ id: project.id, owner: user.id, data: project, sim: [] })
      return project
    },
    updateCoachProject: async (id, patch) => {
      const row = await loadCoach(id)
      if (!row) return null
      if (patch.eventId !== undefined) row.data.eventId = patch.eventId ?? undefined
      if (patch.when !== undefined) row.data.when = patch.when ?? undefined
      await saveCoach(row)
      return row.data
    },
    deleteCoachProject: async (id: string) => {
      await sb.from('coach_projects').delete().eq('id', id)
    },
    coachAddMaterialFile: async (id: string) => {
      const picked = await pickTextFile()
      if (!picked) return { canceled: true }
      const row = await loadCoach(id)
      if (!row) return { error: 'Project not found.' }
      row.data.materialTexts = (row.data.materialTexts ?? []).concat(picked)
      row.data.materials = row.data.materialTexts.map((m) => ({ name: m.name, chars: m.text.length }))
      await saveCoach(row)
      return { project: row.data }
    },
    coachAddMaterialText: async (id, name, text) => {
      const row = await loadCoach(id)
      if (!row) return { error: 'Project not found.' }
      row.data.materialTexts = (row.data.materialTexts ?? []).concat({ name: name || 'Pasted notes', text })
      row.data.materials = row.data.materialTexts.map((m) => ({ name: m.name, chars: m.text.length }))
      await saveCoach(row)
      return { project: row.data }
    },
    coachRemoveMaterial: async (id, index) => {
      const row = await loadCoach(id)
      if (!row) return { error: 'Project not found.' }
      row.data.materialTexts = (row.data.materialTexts ?? []).filter((_m, i) => i !== index)
      row.data.materials = row.data.materialTexts.map((m) => ({ name: m.name, chars: m.text.length }))
      await saveCoach(row)
      return { project: row.data }
    },
    coachBrief: async (id: string) => {
      if (!hasChatKey()) return { error: 'missing-key' }
      const row = await loadCoach(id)
      if (!row) return { error: 'Project not found.' }
      try {
        const system = [
          'You are a world-class presentation coach preparing a speaker.',
          'From their goal, audience and materials, produce a preparation brief.',
          'Return ONLY JSON: {"structure": [string], "keyMessage": string, "weakAreas": [string], "expectedQuestions": [string]}',
          '- structure: 4-7 sections for the talk in order. - keyMessage: the ONE sentence the audience must remember.',
          '- weakAreas: 2-4 likely weak spots to rehearse. - expectedQuestions: 4-6 questions this audience will probably ask.'
        ].join('\n')
        const out = await aiChat(system, [{ role: 'user', content: coachContext(row.data) }])
        const brief = extractJson<CoachBrief>(out)
        if (!brief?.keyMessage) return { error: 'Could not build the brief.' }
        row.data.brief = brief
        await saveCoach(row)
        return { project: row.data }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
    coachStt: async (chunk, offsetSec, mime) => api.transcribeChunk('__coach__', chunk, offsetSec, mime),
    coachScore: async (id, segments, durationSec) => {
      if (!hasChatKey()) return { error: 'missing-key' }
      const row = await loadCoach(id)
      if (!row) return { error: 'Project not found.' }
      try {
        const system = [
          'You are scoring a spoken rehearsal of a presentation against its goal, audience and materials.',
          person(),
          'Return ONLY JSON: {"scores": {"content": n, "clarity": n, "structure": n, "confidence": n, "timing": n, "overall": n}, "feedback": [string], "summary": string}',
          '- Every score is 0-100 (be honest, not kind). - feedback: 3-6 specific, actionable notes. - summary: 2 sentences.'
        ].join('\n')
        const out = await aiChat(system, [
          {
            role: 'user',
            content: `${coachContext(row.data)}\n\nRehearsal (${Math.round(durationSec)}s):\n${transcriptBlock(segments)}`
          }
        ])
        const parsed = extractJson<{ scores?: CoachScores; feedback?: string[]; summary?: string }>(out)
        if (!parsed?.scores) return { error: 'Could not score the rehearsal.' }
        const clamp = (n: unknown): number => Math.max(0, Math.min(100, Math.round(Number(n) || 0)))
        const scores: CoachScores = {
          content: clamp(parsed.scores.content),
          clarity: clamp(parsed.scores.clarity),
          structure: clamp(parsed.scores.structure),
          confidence: clamp(parsed.scores.confidence),
          timing: clamp(parsed.scores.timing),
          overall: clamp(parsed.scores.overall)
        }
        const rehearsal: CoachRehearsal = {
          id: uid(),
          at: Date.now(),
          durationSec,
          scores,
          feedback: parsed.feedback ?? [],
          summary: parsed.summary ?? ''
        }
        row.data.rehearsals.push(rehearsal)
        await saveCoach(row)
        return { rehearsal, project: row.data }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
    coachSimAsk: async (req) => {
      try {
        const row = await loadCoach(req.projectId)
        if (!row) throw new Error('Project not found.')
        const styles: Record<SimDifficulty, string> = {
          friendly: 'You are warm and encouraging; your questions are genuine and easy.',
          professional: 'You are a sharp professional; fair but probing questions.',
          challenging: 'You are skeptical; you push on weak points and vague claims.',
          grilling: 'You are relentless; you interrogate every assumption and number.'
        }
        const system = [
          `You are simulating an audience member (${req.persona}) in a Q&A after this presentation. ${styles[req.difficulty]}`,
          'When the presenter answers, judge it before your next question, starting a line with exactly one of: "✓ Strong:", "△ Needs work:", "✗ Doesn\'t hold:" followed by the reason in one or two sentences: what exactly was missing, vague, wrong, or at odds with their own materials.',
          'Whenever the verdict is not "Strong", add a line starting with exactly "A strong answer:" and give the answer the presenter should have given, in two or three sentences, drawn from their materials and goal, with the numbers and specifics that were missing. A verdict without the better answer teaches nothing.',
          'Stay in character. One question at a time. Keep everything tight: the verdict, the strong answer when needed, the next question.',
          coachContext(row.data)
        ].join('\n')
        const history = req.history.slice(-12).map((m) => ({ role: m.role, content: m.content }))
        const text = await aiChat(system, [...history, { role: 'user', content: req.question }])
        emitAi({ requestId: req.requestId, type: 'delta', text })
        emitAi({ requestId: req.requestId, type: 'done' })
      } catch (err) {
        emitAi({
          requestId: req.requestId,
          type: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
      }
    },
    coachAudienceQuestion: async (id, segments, asked) => {
      if (!hasChatKey()) return { error: 'missing-key' }
      try {
        const row = await loadCoach(id)
        if (!row) return { error: 'Project not found.' }
        const out = await aiChatFull(
          AUDIENCE_QUESTION_SYSTEM,
          [{ role: 'user', content: audienceQuestionUser(coachContext(row.data), segments, asked) }],
          300,
          false,
          true
        )
        return parseAudienceQuestion(extractJson(out.text)) ?? {}
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
    coachJudgeAnswer: async (id, persona, question, answer) => {
      if (!hasChatKey()) return { error: 'missing-key' }
      try {
        const row = await loadCoach(id)
        if (!row) return { error: 'Project not found.' }
        const out = await aiChatFull(
          [JUDGE_ANSWER_SYSTEM, person()].join('\n'),
          [{ role: 'user', content: judgeAnswerUser(coachContext(row.data), persona, question, answer) }],
          600,
          false,
          true
        )
        return parseVerdict(extractJson(out.text)) ?? {}
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
    coachHint: async (id, segments) => {
      if (!hasChatKey() || segments.length < 3) return {}
      try {
        const row = await loadCoach(id)
        if (!row) return {}
        const system = [STUDIO_HINT_SYSTEM, person(), '', `Goal: ${row.data.goal} — audience: ${row.data.audience}.`].join('\n')
        const out = await aiChat(system, [
          { role: 'user', content: transcriptBlock(segments.slice(-20)) }
        ])
        const parsed = extractJson<{ hint?: string | null }>(out)
        return parsed?.hint ? { hint: parsed.hint } : {}
      } catch {
        return {}
      }
    },
    coachGetSim: async (id: string) => (await loadCoach(id))?.sim ?? [],
    getSpaceChat: async (spaceId: string) => {
      // the database first; a browser without the table yet keeps it locally
      const { data, error } = await sb.from('space_chats').select('messages').eq('space_id', spaceId).eq('user_id', user.id).maybeSingle()
      if (!error && data?.messages) return data.messages as ChatMessage[]
      try {
        return JSON.parse(localStorage.getItem(`sitka-space-chat-${spaceId}`) || '[]') as ChatMessage[]
      } catch {
        return []
      }
    },
    saveSpaceChat: async (spaceId: string, chat: ChatMessage[]) => {
      try {
        localStorage.setItem(`sitka-space-chat-${spaceId}`, JSON.stringify(chat.slice(-60)))
      } catch {
        /* full or private */
      }
      await sb
        .from('space_chats')
        .upsert({ space_id: spaceId, user_id: user.id, messages: chat.slice(-60), updated_at: new Date().toISOString() })
        .then(() => undefined, () => undefined)
    },
    coachSaveSim: async (id, chat) => {
      const row = await loadCoach(id)
      if (!row) return
      row.sim = chat
      await saveCoach(row)
    },

    onAiStream: (cb) => {
      aiListeners.add(cb)
      return () => aiListeners.delete(cb)
    },
    onSessionUpdated: (cb) => {
      sessListeners.add(cb)
      return () => sessListeners.delete(cb)
    }
  }

  ;(window as unknown as { sitka: SitkaApi; sitkaWeb: boolean }).sitka = api
  ;(window as unknown as { sitkaWeb: boolean }).sitkaWeb = true

  // Close out anything a crash left open, and finish uploads the cloud is missing.
  // Once soon after opening, and once more two minutes on, for a session whose
  // last chunk was too fresh to be sure about the first time.
  setTimeout(() => void recoverInterrupted(), 2500)
  setTimeout(() => void recoverInterrupted(), 120000)

  // ---------- recordings made before the move ----------
  // Sessions recorded while recordings lived in Supabase are carried over to
  // Cloudflare in the background, one at a time, so they load as fast as new
  // ones and stop counting against the small Supabase allowance. Each file is
  // copied, the copy is checked against the original's size, and only then is
  // the original removed. Whatever is not finished carries on next time the
  // app opens. Left to laptops: a phone should not hold a whole lecture in
  // memory for this.
  /** A fragmented MP4 rewritten plain; anything else, or a failure, is null. */
  function flatten(bytes: Uint8Array): Uint8Array | null {
    try {
      if (!isFragmentedMp4(bytes)) return null
      const t0 = performance.now()
      const out = defragmentMp4(bytes)
      if (out) console.info('[sitka] recording rewritten with its index first', Math.round(out.byteLength / 1e6), 'MB in', Math.round(performance.now() - t0), 'ms')
      return out
    } catch {
      return null
    }
  }
  /**
   * Whether this browser can open a file: its length read within a few
   * seconds, and a positive one. A rewritten recording is checked this way
   * before it is stored as the file every player tries first; one that
   * fails the check is stored as it was recorded, and streamed instead.
   */
  function playable(bytes: Uint8Array, kind: string): Promise<boolean> {
    return new Promise((resolve) => {
      let v: HTMLVideoElement | null = document.createElement('video')
      const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: kind }))
      const done = (ok: boolean): void => {
        if (!v) return
        v.removeAttribute('src')
        v.load()
        v = null
        URL.revokeObjectURL(url)
        resolve(ok)
      }
      const timer = setTimeout(() => done(false), 8000)
      v.muted = true
      v.preload = 'metadata'
      v.onloadedmetadata = () => {
        clearTimeout(timer)
        done(Boolean(v && Number.isFinite(v.duration) && v.duration > 0))
      }
      v.onerror = () => {
        clearTimeout(timer)
        done(false)
      }
      v.src = url
    })
  }

  // ---------- whole files made before the rewrite ----------
  // A recording joined into one file before this change is still in fragments
  // and still slow to start. On a laptop, with time to spare, each such file is
  // fetched, rewritten and put back, one at a time, largest last.
  const FLATTEN_AT = 'sitka.flattened-at.' + user.id
  async function flattenOldRecordings(): Promise<void> {
    if (window.innerWidth < 900) return
    const last = Number(localStorage.getItem(FLATTEN_AT) || 0)
    if (Date.now() - last < 6 * 3600 * 1000) return
    if (!(await store.ready())) return
    const { data } = await sb.from('sessions').select('id,meta').order('created_at', { ascending: false })
    const all = ((data as { id: string; meta: SessionMeta }[] | null) ?? []).filter(
      (r) => !r.meta.readOnly && !r.meta.sample && r.meta.status === 'complete'
    )
    // a whole file in fragments: rewritten in place
    const rows = all.filter((r) => r.meta.whole && !r.meta.flat && r.meta.mime !== 'video/webm')
    // no whole file yet, or one made by the old rewriter: made again from the
    // parts, so a phone opening it later starts in a second instead of a minute
    const unmade = all.filter(
      (r) => !r.meta.whole || (r.meta.mime !== 'video/webm' && (r.meta.rewrite ?? 0) < REWRITE_VERSION)
    )
    let left = 0
    for (const row of rows) {
      if (row.id === recordingState?.id || liveInAnotherTab(row.id)) continue
      try {
        const ok = await flattenOne(row.id)
        if (!ok) left++
      } catch (err) {
        left++
        console.warn('Sitca: could not rewrite a recording yet', row.id, err)
      }
    }
    for (const row of unmade) {
      if (row.id === recordingState?.id || liveInAnotherTab(row.id)) continue
      try {
        const d = cache.get(row.id) ?? (await loadSession(row.id))
        if (!d) continue
        d.meta.whole = false
        await consolidateRecording(row.id)
        if (!d.meta.whole) left++
      } catch (err) {
        left++
        console.warn('Sitca: could not make a whole file yet', row.id, err)
      }
    }
    if (left === 0) localStorage.setItem(FLATTEN_AT, String(Date.now()))
  }
  async function flattenOne(id: string): Promise<boolean> {
    const d = cache.get(id) ?? (await loadSession(id))
    if (!d) return true
    const where = whereOf(d.meta)
    const bytes = await store.download(videoPath(id), where)
    if (!bytes) return false
    // a file this size, twice over, is more than a tab should hold
    if (bytes.byteLength > 1200 * 1024 * 1024) return true
    const src = new Uint8Array(bytes)
    if (mediaType(src.subarray(0, 12)) !== 'video/mp4') {
      d.meta.flat = true
      await patchSession(id, { meta: d.meta })
      return true
    }
    const flat = flatten(src)
    if (!flat || !(await playable(flat, 'video/mp4'))) {
      // not in fragments after all, or beyond this rewriter: leave it, and stop asking
      d.meta.flat = true
      await patchSession(id, { meta: d.meta })
      return true
    }
    const { error } = await store.upload(videoPath(id), new Blob([flat.buffer as ArrayBuffer], { type: 'video/mp4' }), 'video/mp4')
    if (error) return false
    d.meta.flat = true
    d.meta.rewrite = REWRITE_VERSION
    await patchSession(id, { meta: d.meta })
    emitSession(d.meta)
    track('recording_flattened', { session: id, mb: Math.round(flat.byteLength / 1e6) })
    return true
  }
  setTimeout(() => void flattenOldRecordings(), 45000)

  const MIGRATE_AT = 'sitka.migrated-at.' + user.id
  async function migrateOldRecordings(): Promise<void> {
    if (window.innerWidth < 900) return
    // a sweep every few hours is plenty: it only costs anything when there is something to move
    const last = Number(localStorage.getItem(MIGRATE_AT) || 0)
    if (Date.now() - last < 6 * 3600 * 1000) return
    if (!(await store.ready())) return
    const { data } = await sb.from('sessions').select('id,meta').order('created_at', { ascending: false })
    const rows = (data as { id: string; meta: SessionMeta }[] | null) ?? []
    let remaining = 0
    for (const row of rows) {
      const m = row.meta
      if (m.store === 'r2' || m.readOnly || m.sample || m.status !== 'complete') continue
      if (m.id === recordingState?.id || liveInAnotherTab(m.id)) continue
      try {
        const moved = await migrateOne(m.id)
        if (moved === 'moved') track('recording_moved', { session: m.id })
        else if (moved === 'pending') remaining++
      } catch (err) {
        remaining++
        console.warn('Sitca: could not move a recording yet', m.id, err)
      }
    }
    if (remaining === 0) localStorage.setItem(MIGRATE_AT, String(Date.now()))
  }

  /** 'moved' when files were carried over, 'none' when there was nothing to carry, 'pending' when something is left. */
  async function migrateOne(id: string): Promise<'moved' | 'none' | 'pending'> {
    const folders = [`${user.id}/${id}`, `${user.id}/${id}-slides`]
    const keys: string[] = []
    for (const f of folders) {
      for (const o of await store.listIn(f, 'sb')) keys.push(`${f}/${o.name}`)
    }
    // the whole file has no folder of its own: it is found by trying it
    const wholeKey = videoPath(id)
    const { data: wholeUrl } = await sb.storage.from('recordings').createSignedUrl(wholeKey, 120)
    if (wholeUrl?.signedUrl) keys.push(wholeKey)

    const d = cache.get(id) ?? (await loadSession(id))
    if (keys.length === 0) {
      // nothing in Supabase for this session: it is already where it should be
      if (d) {
        d.meta.store = 'r2'
        await patchSession(id, { meta: d.meta })
      }
      return 'none'
    }
    for (const key of keys) {
      const bytes = await store.download(key, 'sb')
      if (!bytes || bytes.byteLength === 0) return 'pending'
      const kind = key.endsWith('.jpg') ? 'image/jpeg' : mediaType(new Uint8Array(bytes.slice(0, 12)))
      const { error } = await store.upload(key, new Blob([bytes], { type: kind }), kind)
      if (error) return 'pending'
      // the copy must be the same size before the original goes
      let copiedSize = -1
      if (key === wholeKey) {
        copiedSize = (await store.media(user.id, id)).wholeSize ?? -1
      } else {
        const folder = key.slice(0, key.lastIndexOf('/'))
        const name = key.slice(key.lastIndexOf('/') + 1)
        copiedSize = (await store.listIn(folder, 'r2')).find((o) => o.name === name)?.size ?? -1
      }
      if (copiedSize !== bytes.byteLength) return 'pending'
      await store.remove([key], 'sb')
    }
    if (d) {
      d.meta.store = 'r2'
      await patchSession(id, { meta: d.meta })
      emitSession(d.meta)
      if (!d.meta.whole) void consolidateRecording(id)
    }
    return 'moved'
  }
  setTimeout(() => void migrateOldRecordings(), 12000)
}
