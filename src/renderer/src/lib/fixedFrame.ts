/**
 * The recorded picture at one size, whatever the shared window does.
 *
 * Chrome's MP4 recorder writes the picture's size once, at the start. When
 * the shared window or tab changes size (resized, maximised, a tab switched,
 * the extension's side panel opening), it carries on with frames of the new
 * size but never says so, and every frame after that decodes as a green
 * smear while the sound stays clear.
 *
 * So the recorder is given frames of one fixed size: each captured frame is
 * scaled to fit and letterboxed onto a frame the size the capture began at.
 * The work is done frame by frame as frames arrive (not on a timer, which a
 * background tab slows to a crawl), with Chrome's MediaStreamTrackProcessor.
 * Where that is missing (Firefox, older Safari) the capture is recorded as it
 * is: Firefox records WebM, which carries the size in every keyframe.
 */

export interface FixedFrame {
  /** the track to record */
  track: MediaStreamTrack
  /** the size every recorded frame has */
  width: number
  height: number
  /** stops the fixed track (the capture itself is left to its owner) */
  stop: () => void
}

type Processor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }
type Generator = new (init: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> }

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

export function fixedFrame(source: MediaStreamTrack, max = { width: 1920, height: 1080 }): FixedFrame | null {
  const g = globalThis as unknown as { MediaStreamTrackProcessor?: Processor; MediaStreamTrackGenerator?: Generator }
  if (!g.MediaStreamTrackProcessor || !g.MediaStreamTrackGenerator || typeof OffscreenCanvas === 'undefined' || typeof VideoFrame === 'undefined') {
    return null
  }
  // the size the capture begins at, no larger than the recording allows
  const s = source.getSettings()
  let w = Number(s.width) || max.width
  let h = Number(s.height) || max.height
  // the long side at most 1920, the short side at most 1080 (a portrait camera too)
  const fit = Math.min(1, max.width / Math.max(w, h), max.height / Math.min(w, h))
  w = even(w * fit)
  h = even(h * fit)
  try {
    const processor = new g.MediaStreamTrackProcessor({ track: source })
    const generator = new g.MediaStreamTrackGenerator({ kind: 'video' })
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D | null
    if (!ctx) return null
    ctx.imageSmoothingQuality = 'high'
    let last = { fw: 0, fh: 0, dx: 0, dy: 0, dw: w, dh: h }
    const transform = new TransformStream<VideoFrame, VideoFrame>({
      transform(frame, controller) {
        try {
          const fw = frame.displayWidth
          const fh = frame.displayHeight
          if (fw !== last.fw || fh !== last.fh) {
            const scale = Math.min(w / fw, h / fh)
            const dw = Math.round(fw * scale)
            const dh = Math.round(fh * scale)
            last = { fw, fh, dx: Math.floor((w - dw) / 2), dy: Math.floor((h - dh) / 2), dw, dh }
            // the bars around a smaller picture are cleared once per size
            ctx.fillStyle = '#000'
            ctx.fillRect(0, 0, w, h)
          }
          ctx.drawImage(frame, last.dx, last.dy, last.dw, last.dh)
          const out = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined })
          controller.enqueue(out)
        } finally {
          frame.close()
        }
      }
    })
    void processor.readable
      .pipeThrough(transform)
      .pipeTo(generator.writable)
      .catch(() => undefined)
    return {
      track: generator,
      width: w,
      height: h,
      stop: () => {
        try {
          generator.stop()
        } catch {
          /* already stopped */
        }
      }
    }
  } catch {
    return null
  }
}
