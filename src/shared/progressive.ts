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

/** The MIME type MSE needs, read off the first bytes of the file. */
export function sniffWebmMime(head: Uint8Array): string | null {
  // the EBML magic first; then the codec ids the muxer wrote into the Tracks
  if (!(head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)) return null
  const text = new TextDecoder('latin1').decode(head.subarray(0, Math.min(head.length, 200000)))
  const video = text.includes('V_VP9') ? 'vp9' : text.includes('V_VP8') ? 'vp8' : text.includes('V_AV1') ? 'av01' : null
  const audio = text.includes('A_OPUS') ? 'opus' : text.includes('A_VORBIS') ? 'vorbis' : null
  const codecs = [video, audio].filter(Boolean).join(',')
  return codecs ? `video/webm;codecs="${codecs}"` : 'video/webm'
}

export function canStream(mime: string): boolean {
  const MS = (window as unknown as { MediaSource?: { isTypeSupported?: (t: string) => boolean } }).MediaSource
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
  if (count === 0 || typeof MediaSource === 'undefined') return false
  const lookahead = Math.max(1, opts.lookahead ?? 2)

  // the first part decides whether this file can be streamed at all
  const first = await fetchPart(0)
  const mime = sniffWebmMime(new Uint8Array(first))
  if (!mime || !canStream(mime)) return false

  const ms = new MediaSource()
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
