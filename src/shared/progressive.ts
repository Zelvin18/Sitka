/// <reference lib="dom" />
/**
 * Playback of a recording stored in the cloud, the way a video site does it:
 * the first second of picture within a second or two, whatever the length;
 * the rest fetched behind the playhead, never all at once; a jump to any
 * minute served from that minute, not from the beginning; and a buffer that
 * lets go of what has been watched so a phone's memory is never exceeded.
 *
 * Built on Media Source Extensions (Safari's ManagedMediaSource on iPhone).
 * The recorder writes its files in fragments that each carry their own
 * timestamp (MP4 moof/mdat pairs, WebM clusters), which is exactly what lets
 * a fragment fetched from the middle of the file be shown at the right time.
 * A byte position for a moment is estimated from the file's size and
 * length, then snapped to the next fragment boundary found in the bytes.
 *
 * A browser without the engine, or a file it cannot stream, falls back to the
 * caller, which stitches the whole file as before.
 */

export interface ByteSource {
  /** total bytes, when known: needed for jumping ahead */
  size: number | null
  /** the bytes [from, to] inclusive, absolute positions */
  range(from: number, to: number, signal?: AbortSignal): Promise<ArrayBuffer>
}

export interface StreamOptions {
  /** told why the stream could not be started, for the player's account of it */
  note?: (why: string) => void
  /** the recording's length in seconds, when known, so the timeline shows at once */
  durationSec?: number
  /** called as bytes land, for a progress line: 0..1 of the file fetched so far */
  onProgress?: (fraction: number) => void
}

const isEbml = (h: Uint8Array): boolean => h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3
const isMp4 = (h: Uint8Array): boolean => h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70 // "ftyp"

/** The container a recording is in, from its first bytes: what to label it when it is stored or played. */
export function mediaType(head: Uint8Array): 'video/webm' | 'video/mp4' | 'application/octet-stream' {
  if (isEbml(head)) return 'video/webm'
  if (isMp4(head)) return 'video/mp4'
  return 'application/octet-stream'
}

/** The MIME type MSE needs, read off the first bytes of the file. */
export function sniffWebmMime(head: Uint8Array): string | null {
  if (isMp4(head)) {
    const t = new TextDecoder('latin1').decode(head.subarray(0, Math.min(head.length, 200000)))
    const hasVideo = t.includes('avc1') || t.includes('avc3') || t.includes('hvc1')
    const hasAudio = t.includes('mp4a')
    const tries = hasVideo
      ? ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4;codecs="avc1.64001F,mp4a.40.2"', 'video/mp4;codecs="avc1.42E01E"', 'video/mp4']
      : hasAudio
        ? ['audio/mp4;codecs="mp4a.40.2"', 'video/mp4;codecs="mp4a.40.2"', 'audio/mp4']
        : ['video/mp4']
    return tries.find((x) => canStream(x)) ?? null
  }
  if (!isEbml(head)) return null
  const text = new TextDecoder('latin1').decode(head.subarray(0, Math.min(head.length, 200000)))
  const videos = text.includes('V_VP9')
    ? ['vp9', 'vp09.00.10.08', 'vp09.00.31.08']
    : text.includes('V_VP8')
      ? ['vp8']
      : text.includes('V_AV1')
        ? ['av01.0.04M.08', 'av01']
        : []
  const audios = text.includes('A_OPUS') ? ['opus'] : text.includes('A_VORBIS') ? ['vorbis'] : []
  const tries: string[] = []
  for (const v of videos.length ? videos : ['']) {
    for (const a of audios.length ? audios : ['']) {
      const codecs = [v, a].filter(Boolean).join(',')
      tries.push(codecs ? `video/webm;codecs="${codecs}"` : 'video/webm')
    }
  }
  if (!videos.length && audios.length) tries.push(`audio/webm;codecs="${audios[0]}"`)
  tries.push('video/webm')
  return tries.find((t) => canStream(t)) ?? null
}

/** A deadline that counts only while the page is visible: a hidden tab's media is held back by the browser. */
function openDeadline(ms: number, fn: () => void): void {
  if (typeof document === 'undefined') {
    setTimeout(fn, ms)
    return
  }
  let left = ms
  let started = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = (): void => {
    if (document.visibilityState !== 'visible') return
    started = Date.now()
    timer = setTimeout(() => {
      document.removeEventListener('visibilitychange', onVis)
      fn()
    }, left)
  }
  const onVis = (): void => {
    if (document.visibilityState === 'visible') arm()
    else if (timer) {
      left = Math.max(500, left - (Date.now() - started))
      clearTimeout(timer)
      timer = null
    }
  }
  document.addEventListener('visibilitychange', onVis)
  arm()
}

/** The streaming engine: MediaSource, or Safari's ManagedMediaSource on iPhone (iOS 17.1+). */
type MSCtor = { new (): MediaSource; isTypeSupported?: (t: string) => boolean }
function engine(): MSCtor | null {
  const w = window as unknown as { MediaSource?: MSCtor; ManagedMediaSource?: MSCtor }
  return w.ManagedMediaSource ?? w.MediaSource ?? null
}

export function canStream(mime: string): boolean {
  const MS = engine()
  return Boolean(MS && MS.isTypeSupported && MS.isTypeSupported(mime))
}

// ---------- sources ----------

/** one file that honours byte ranges */
export function sourceFromUrl(url: string, size: number): ByteSource {
  return {
    size,
    async range(from, to, signal) {
      const r = await fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal })
      if (r.status !== 206) throw new Error(`range refused (${r.status})`)
      return r.arrayBuffer()
    }
  }
}

/** parts laid end to end, each honouring byte ranges; sizes must be known */
export function sourceFromParts(parts: { url: string; size: number }[]): ByteSource {
  const starts: number[] = []
  let total = 0
  for (const p of parts) {
    starts.push(total)
    total += p.size
  }
  return {
    size: total,
    async range(from, to, signal) {
      const pieces: ArrayBuffer[] = []
      for (let i = 0; i < parts.length; i++) {
        const s = starts[i]
        const e = s + parts[i].size - 1
        if (e < from || s > to) continue
        const a = Math.max(from, s) - s
        const b = Math.min(to, e) - s
        const whole = a === 0 && b === parts[i].size - 1
        const r = await fetch(parts[i].url, whole ? { signal } : { headers: { Range: `bytes=${a}-${b}` }, signal })
        if (!r.ok) throw new Error(`part ${i}: ${r.status}`)
        pieces.push(await r.arrayBuffer())
      }
      if (pieces.length === 1) return pieces[0]
      const out = new Uint8Array(pieces.reduce((n, p) => n + p.byteLength, 0))
      let at = 0
      for (const p of pieces) {
        out.set(new Uint8Array(p), at)
        at += p.byteLength
      }
      return out.buffer
    }
  }
}

// ---------- fragment boundaries ----------

/** the offset of the first fragment that begins inside these bytes, or -1 */
function fragmentAt(bytes: Uint8Array, kind: 'video/mp4' | 'video/webm'): number {
  if (kind === 'video/mp4') {
    // "moof" is preceded by its 4-byte size; the box begins there
    for (let i = 4; i + 4 <= bytes.length; i++) {
      if (bytes[i] === 0x6d && bytes[i + 1] === 0x6f && bytes[i + 2] === 0x6f && bytes[i + 3] === 0x66) {
        const size = ((bytes[i - 4] << 24) | (bytes[i - 3] << 16) | (bytes[i - 2] << 8) | bytes[i - 1]) >>> 0
        if (size >= 16 && size < 64 * 1024 * 1024) return i - 4
      }
    }
    return -1
  }
  // a WebM Cluster begins with its id 1F 43 B6 75
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x1f && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75) return i
  }
  return -1
}

// ---------- the engine ----------

const FIRST = 1 * 1024 * 1024
const SLICE_MAX = 8 * 1024 * 1024
/** how far ahead of the playhead to keep fetching, in seconds of buffered media */
const AHEAD_SEC = 480
/** how much behind the playhead to keep before letting go */
const BEHIND_SEC = 45

const buffered = (v: HTMLVideoElement, t: number): boolean => {
  const b = v.buffered
  for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.3 && t < b.end(i) - 0.2) return true
  return false
}
const bufferedEndFrom = (v: HTMLVideoElement, t: number): number => {
  const b = v.buffered
  for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.3 && t <= b.end(i)) return b.end(i)
  return t
}

/**
 * Stream `source` into `video`. Resolves true once streaming has begun (it
 * carries on in the background for as long as the element lives), false if
 * streaming was not possible here, in which case nothing has been attached
 * and the caller may stitch instead.
 */
export async function streamMedia(video: HTMLVideoElement, source: ByteSource, opts: StreamOptions = {}): Promise<boolean> {
  const MS = engine()
  const note = opts.note ?? ((): void => undefined)
  if (!MS) {
    note('this browser has no streaming engine')
    return false
  }
  if (source.size === null || source.size < 1024) {
    note(`the size is not known (${source.size})`)
    return false
  }
  const size = source.size

  // the head decides whether this file can be streamed at all, and is the first thing appended
  let head: ArrayBuffer
  try {
    head = await source.range(0, Math.min(size, FIRST) - 1)
  } catch (e) {
    note(`the first bytes could not be fetched (${e instanceof Error ? e.message : String(e)})`)
    return false
  }
  const headBytes = new Uint8Array(head)
  const kind = mediaType(headBytes)
  if (kind === 'application/octet-stream') {
    note('the first bytes are not a recording')
    return false
  }
  const mime = sniffWebmMime(headBytes)
  if (!mime || !canStream(mime)) {
    note(`this browser's engine does not take ${mime || kind}`)
    return false
  }

  ;(video as HTMLVideoElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true
  const ms = new MS()
  const url = URL.createObjectURL(ms)
  let openFailure = ''
  const w = window as unknown as { ManagedMediaSource?: unknown }
  const managed = Boolean(w.ManagedMediaSource) && MS === (w.ManagedMediaSource as MSCtor)
  await new Promise<void>((resolve, reject) => {
    ms.addEventListener('sourceopen', () => resolve(), { once: true })
    video.addEventListener('error', () => reject(new Error('media error')), { once: true })
    // the engine opens only once the page is looked at: a hidden tab's media
    // waits, so the clock here runs only while the page is visible
    openDeadline(6000, () => reject(new Error('sourceopen timeout')))
    // Safari's managed engine is attached as an object, the way Apple documents
    // it; the classic engine by its object address
    if (managed && 'srcObject' in video) {
      try {
        ;(video as HTMLVideoElement & { srcObject: unknown }).srcObject = ms
      } catch {
        video.src = url
      }
    } else video.src = url
  }).catch((e: Error) => {
    openFailure = e.message
  })
  if (ms.readyState !== 'open') {
    URL.revokeObjectURL(url)
    note(`the engine did not open (${openFailure || ms.readyState})`)
    return false
  }
  let sb: SourceBuffer
  try {
    sb = ms.addSourceBuffer(mime)
  } catch (e) {
    note(`no buffer for ${mime} (${e instanceof Error ? e.message : String(e)})`)
    return false
  }
  const duration = opts.durationSec && Number.isFinite(opts.durationSec) && opts.durationSec > 0 ? opts.durationSec : null
  if (duration) {
    try {
      ms.duration = duration
    } catch {
      /* set once data is in */
    }
  }

  const append = (buf: ArrayBuffer): Promise<void> =>
    new Promise((resolve, reject) => {
      const onEnd = (): void => {
        sb.removeEventListener('updateend', onEnd)
        sb.removeEventListener('error', onErr)
        resolve()
      }
      const onErr = (): void => {
        sb.removeEventListener('updateend', onEnd)
        sb.removeEventListener('error', onErr)
        reject(new Error('append failed'))
      }
      sb.addEventListener('updateend', onEnd)
      sb.addEventListener('error', onErr)
      try {
        sb.appendBuffer(buf)
      } catch (e) {
        sb.removeEventListener('updateend', onEnd)
        sb.removeEventListener('error', onErr)
        reject(e)
      }
    })
  const remove = (from: number, to: number): Promise<void> =>
    new Promise((resolve) => {
      if (sb.updating || to <= from) {
        resolve()
        return
      }
      const onEnd = (): void => {
        sb.removeEventListener('updateend', onEnd)
        resolve()
      }
      sb.addEventListener('updateend', onEnd)
      try {
        sb.remove(from, to)
      } catch {
        sb.removeEventListener('updateend', onEnd)
        resolve()
      }
    })
  /** let go of what has been watched, and far-ahead ranges from an old jump, then try again */
  const appendWithRoom = async (buf: ArrayBuffer): Promise<void> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await append(buf)
        return
      } catch (e) {
        const quota = e instanceof Error && (e.name === 'QuotaExceededError' || /quota/i.test(e.message))
        if (!quota) throw e
        const t = video.currentTime
        const b = video.buffered
        // behind the playhead first, then anything more than the window ahead
        await remove(0, Math.max(0, t - BEHIND_SEC))
        for (let i = 0; i < b.length; i++) {
          if (b.start(i) > t + AHEAD_SEC) await remove(b.start(i), b.end(i))
        }
        if (attempt >= 2) await new Promise((r) => setTimeout(r, 1500))
      }
    }
    throw new Error('no room in the buffer')
  }

  // ---- the download: from the cursor, in slices that grow, only as far ahead as the window ----
  let cursor = 0
  let sliceLen = FIRST
  let controller: AbortController | null = null
  let generation = 0
  let alive = true
  const stop = (): void => {
    alive = false
    controller?.abort()
  }
  video.addEventListener('emptied', stop, { once: true })

  const bytesToTime = (b: number): number => (duration ? (b / size) * duration : 0)
  const timeToBytes = (t: number): number => (duration ? Math.floor((t / duration) * size) : 0)

  const wait = (ms_: number): Promise<void> => new Promise((r) => setTimeout(r, ms_))

  /**
   * Put the cursor at the fragment that begins just before moment `t`: an
   * estimate from the file's size and length, snapped to a fragment boundary
   * found in the bytes, checked against where the appended fragment landed
   * on the timeline, and walked back when it landed too late.
   */
  const jumpTo = async (t: number): Promise<void> => {
    let target = Math.max(0, timeToBytes(t) - 1.5 * 1024 * 1024)
    for (let attempt = 0; attempt < 5 && alive; attempt++) {
      const probeEnd = Math.min(size, target + 1.5 * 1024 * 1024) - 1
      let probe: ArrayBuffer
      try {
        probe = await source.range(target, probeEnd)
      } catch {
        return
      }
      const at = fragmentAt(new Uint8Array(probe), kind)
      if (at < 0) {
        target = Math.min(size - 1, target + 1.5 * 1024 * 1024)
        continue
      }
      const start = target + at
      const before: number[] = []
      for (let i = 0; i < video.buffered.length; i++) before.push(video.buffered.start(i))
      const first = await source.range(start, Math.min(size, start + 2 * 1024 * 1024) - 1)
      // the parser must start this fragment clean, not as a continuation
      if (ms.readyState === 'open') {
        try {
          sb.abort()
        } catch {
          /* nothing in flight */
        }
      }
      await appendWithRoom(first)
      const b = video.buffered
      let newStart = -1
      for (let i = 0; i < b.length; i++) {
        if (!before.some((x) => Math.abs(x - b.start(i)) < 0.1)) newStart = b.start(i)
      }
      if (buffered(video, t) || start === 0 || newStart < 0 || newStart <= t) {
        cursor = start + first.byteLength
        sliceLen = 2 * 1024 * 1024
        return
      }
      // it landed after the moment (a slower stretch of the recording): step back further
      target = Math.max(0, target - 4 * 1024 * 1024)
    }
  }

  /** the first hole in what is buffered, preferring one ahead of the playhead */
  const firstGap = (): number | null => {
    if (!duration) return null
    const b = video.buffered
    const gaps: number[] = []
    let prevEnd = 0
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) - prevEnd > 1.5) gaps.push(prevEnd)
      prevEnd = Math.max(prevEnd, b.end(i))
    }
    if (duration - prevEnd > 2.5) gaps.push(prevEnd)
    // only what the playhead will reach soon: the browser lets go of data far
    // from it anyway, and would only be handed the same bytes again
    const t = video.currentTime
    return gaps.find((g) => g >= t - 1 && g < t + AHEAD_SEC) ?? null
  }

  let seeking = false
  let fills = 0
  const loop = async (): Promise<void> => {
    cursor = head.byteLength
    opts.onProgress?.(cursor / size)
    while (alive) {
      if (cursor >= size) {
        // the end of the file: fill the holes a jump left behind, from the
        // playhead forward; when there are none, the stream is complete
        const gap = fills < 400 && !seeking ? firstGap() : null
        if (gap !== null) {
          fills++
          seeking = true
          generation++
          await jumpTo(gap + 0.05)
          seeking = false
          await wait(300)
          continue
        }
        if (ms.readyState === 'open' && !sb.updating) {
          try {
            ms.endOfStream()
          } catch {
            /* already ended */
          }
        }
        await wait(500)
        continue
      }
      // no further ahead than the window: a phone's memory, and its data, are finite
      if (duration) {
        const ahead = bufferedEndFrom(video, video.currentTime) - video.currentTime
        const cursorAhead = bytesToTime(cursor) - video.currentTime
        if (ahead > AHEAD_SEC && cursorAhead > AHEAD_SEC) {
          await wait(1000)
          continue
        }
      }
      if (seeking) {
        await wait(100)
        continue
      }
      const gen = generation
      const from = cursor
      const to = Math.min(size, from + sliceLen) - 1
      controller = new AbortController()
      let buf: ArrayBuffer
      try {
        buf = await source.range(from, to, controller.signal)
      } catch {
        if (!alive) return
        if (gen !== generation) continue // a jump moved the cursor: this slice is not wanted
        await wait(1200)
        continue
      }
      if (!alive || gen !== generation) continue
      try {
        await appendWithRoom(buf)
      } catch (err) {
        console.warn('[stream] append stopped', err)
        return
      }
      if (gen !== generation) continue
      cursor = to + 1
      sliceLen = Math.min(SLICE_MAX, sliceLen * 2)
      opts.onProgress?.(Math.min(1, cursor / size))
    }
  }

  // ---- a jump: the playhead lands where nothing is buffered, or playback runs out of buffer ----
  // Safari will not step over a small gap at the start on its own: a buffer
  // that begins a few frames after zero leaves the playhead waiting at zero.
  // The playhead is moved to where the sound and picture begin.
  const nudgeStart = (): boolean => {
    const b = video.buffered
    if (!b.length) return false
    const t = video.currentTime
    if (t < b.start(0) && b.start(0) - t < 2) {
      video.currentTime = b.start(0) + 0.05
      return true
    }
    return false
  }
  const onSeek = async (): Promise<void> => {
    if (!alive || !duration || seeking) return
    if (nudgeStart()) return
    const t = video.currentTime
    if (buffered(video, t)) return
    // the sequential fetch is about to reach it anyway: let it
    const cursorTime = bytesToTime(cursor)
    if (cursor < size && t >= cursorTime && t < cursorTime + 20) return
    seeking = true
    generation++
    controller?.abort()
    try {
      await jumpTo(t)
    } finally {
      seeking = false
    }
  }
  video.addEventListener('waiting', () => void onSeek())
  video.addEventListener('seeking', () => void onSeek())

  // The head is appended before anything is promised: a file the engine
  // cannot parse (a container it does not know, a header it cannot read) is
  // found out here, the element is left clean, and the caller plays it
  // another way.
  try {
    await appendWithRoom(head)
  } catch (err) {
    console.warn('[stream] this file cannot be streamed here', err)
    note(`the first piece was refused (${err instanceof Error ? err.message : String(err)})`)
    alive = false
    try {
      if (ms.readyState === 'open') ms.endOfStream()
    } catch {
      /* already closed */
    }
    ;(video as HTMLVideoElement & { srcObject: unknown }).srcObject = null
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
    return false
  }
  if (video.error) {
    note(`the player refused the first piece (code ${video.error.code})`)
    alive = false
    ;(video as HTMLVideoElement & { srcObject: unknown }).srcObject = null
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
    return false
  }
  nudgeStart()
  void loop()
  return true
}

// ---------- the older door ----------

export interface ProgressiveOptions {
  durationSec?: number
  lookahead?: number
  onProgress?: (done: number, total: number) => void
}

/**
 * Parts fetched one after another and appended in order, for callers that
 * only have the parts as links. The new engine, with its jumps and its
 * window, wants sizes; this keeps the old promise: true once everything is
 * appended, false if streaming is not possible.
 */
export async function playProgressively(
  video: HTMLVideoElement,
  count: number,
  fetchPart: (index: number) => Promise<ArrayBuffer>,
  opts: ProgressiveOptions = {}
): Promise<boolean> {
  const MS = engine()
  if (count === 0 || !MS) return false
  const lookahead = Math.max(1, opts.lookahead ?? 2)
  const first = await fetchPart(0)
  const mime = sniffWebmMime(new Uint8Array(first))
  if (!mime || !canStream(mime)) return false
  ;(video as HTMLVideoElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true
  const ms = new MS()
  const url = URL.createObjectURL(ms)
  await new Promise<void>((resolve, reject) => {
    ms.addEventListener('sourceopen', () => resolve(), { once: true })
    video.addEventListener('error', () => reject(new Error('media error')), { once: true })
    openDeadline(6000, () => reject(new Error('sourceopen timeout')))
    video.src = url
  }).catch(() => undefined)
  if (ms.readyState !== 'open') {
    URL.revokeObjectURL(url)
    return false
  }
  let sb: SourceBuffer
  try {
    sb = ms.addSourceBuffer(mime)
  } catch {
    return false
  }
  if (opts.durationSec && Number.isFinite(opts.durationSec)) {
    try {
      ms.duration = opts.durationSec
    } catch {
      /* set once data is in */
    }
  }
  const append = (buf: ArrayBuffer): Promise<void> =>
    new Promise((resolve, reject) => {
      const onEnd = (): void => {
        sb.removeEventListener('updateend', onEnd)
        sb.removeEventListener('error', onErr)
        resolve()
      }
      const onErr = (): void => {
        sb.removeEventListener('updateend', onEnd)
        sb.removeEventListener('error', onErr)
        reject(new Error('append failed'))
      }
      sb.addEventListener('updateend', onEnd)
      sb.addEventListener('error', onErr)
      try {
        sb.appendBuffer(buf)
      } catch (e) {
        onErr()
        void e
      }
    })
  const pending = new Map<number, Promise<ArrayBuffer>>()
  const fetchTwice = async (i: number): Promise<ArrayBuffer> => {
    let last: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fetchPart(i)
      } catch (err) {
        last = err
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)))
      }
    }
    throw last
  }
  const fetchAt = (i: number): Promise<ArrayBuffer> => {
    if (i === 0) return Promise.resolve(first)
    let p = pending.get(i)
    if (!p) {
      p = fetchTwice(i)
      pending.set(i, p)
    }
    return p
  }
  try {
    for (let i = 0; i < count; i++) {
      for (let k = i + 1; k <= Math.min(count - 1, i + lookahead); k++) void fetchAt(k).catch(() => undefined)
      const buf = await fetchAt(i)
      pending.delete(i)
      if (ms.readyState !== 'open') return true
      try {
        await append(buf)
      } catch {
        // a full buffer: let go of what has been watched and try once more
        const t = video.currentTime
        await new Promise<void>((resolve) => {
          if (sb.updating) {
            resolve()
            return
          }
          sb.addEventListener('updateend', () => resolve(), { once: true })
          try {
            sb.remove(0, Math.max(0, t - 30))
          } catch {
            resolve()
          }
        })
        await append(buf)
      }
      opts.onProgress?.(i + 1, count)
    }
    if (ms.readyState === 'open') {
      try {
        ms.endOfStream()
      } catch {
        /* already closed */
      }
    }
    return true
  } catch (err) {
    console.warn('[progressive] streaming stopped', err)
    const report = (window as unknown as { sitkaReportError?: (p: string, m: string) => void }).sitkaReportError
    report?.(location.pathname, 'streaming stopped: ' + (err instanceof Error ? err.message : String(err)))
    return true
  }
}
