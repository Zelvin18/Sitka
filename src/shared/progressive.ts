/// <reference lib="dom" />
/**
 * Progressive playback of a recording stored as parts. The first part is
 * playing within seconds; the rest arrive while it plays. Built on Media
 * Source Extensions; a browser without them (or a file it cannot stream)
 * falls back to the caller, which stitches the whole file as before.
 */

export interface ProgressiveOptions {
  /** the recording's length in seconds, when known, so the timeline shows at once */
  durationSec?: number
  /** how many parts to fetch ahead of the one being appended */
  lookahead?: number
  /** called as parts land, for a progress line */
  onProgress?: (done: number, total: number) => void
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
  // MP4 (H.264/AAC): the format every phone streams natively
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
  // WebM: the EBML magic first, then the codec ids the muxer wrote into the Tracks.
  if (!isEbml(head)) return null
  // Browsers spell the codecs differently (Chrome "vp9", Safari "vp09.…"),
  // so the first spelling this browser accepts is the one used.
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

/**
 * Stream `parts` (fetched in order by `fetchPart`) into `video`. Resolves true
 * once everything has been appended, false if streaming was not possible —
 * in which case nothing has been attached and the caller may stitch instead.
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

  // the first part decides whether this file can be streamed at all
  const first = await fetchPart(0)
  const mime = sniffWebmMime(new Uint8Array(first))
  if (!mime || !canStream(mime)) return false

  // Safari's managed source insists the element will not hand playback to
  // another device; harmless everywhere else
  ;(video as HTMLVideoElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true
  const ms = new MS()
  const url = URL.createObjectURL(ms)
  await new Promise<void>((resolve, reject) => {
    ms.addEventListener('sourceopen', () => resolve(), { once: true })
    video.addEventListener('error', () => reject(new Error('media error')), { once: true })
    video.src = url
  }).catch(() => undefined)
  if (ms.readyState !== 'open') return false

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

  // parts are fetched a little ahead and appended strictly in order
  const pending = new Map<number, Promise<ArrayBuffer>>()
  const fetchAt = (i: number): Promise<ArrayBuffer> => {
    if (i === 0) return Promise.resolve(first)
    let p = pending.get(i)
    if (!p) {
      p = fetchPart(i)
      pending.set(i, p)
    }
    return p
  }
  try {
    for (let i = 0; i < count; i++) {
      for (let k = i + 1; k <= Math.min(count - 1, i + lookahead); k++) void fetchAt(k).catch(() => undefined)
      const buf = await fetchAt(i)
      pending.delete(i)
      if (ms.readyState !== 'open') return true // the element was torn down mid-way
      await append(buf)
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
    // whatever was appended keeps playing; the caller may not stitch over it
    return true
  }
}
