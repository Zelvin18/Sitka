import React, { useEffect, useRef, useState } from 'react'
import { IconQr, Mark } from '../lib/icons'

interface Props {
  onBack: () => void
}

const IS_WEB = (window as unknown as { sitkaWeb?: boolean }).sitkaWeb === true

// The browser's own QR reader where it exists (Chrome, Android); a small
// decoder loaded on demand everywhere else (iPhone Safari).
interface DetectedCode {
  rawValue: string
}
interface BarcodeDetectorLike {
  detect: (source: HTMLVideoElement) => Promise<DetectedCode[]>
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike
type JsQr = (data: Uint8ClampedArray, w: number, h: number) => { data: string } | null

const JSQR_URLS = [
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js'
]
let jsQrPromise: Promise<JsQr> | null = null
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`could not load ${src}`))
    document.head.appendChild(s)
  })
}
function loadJsQr(): Promise<JsQr> {
  if (!jsQrPromise) {
    jsQrPromise = (async () => {
      const w = window as unknown as { jsQR?: JsQr }
      for (const url of JSQR_URLS) {
        if (w.jsQR) break
        try {
          await loadScript(url)
        } catch {
          /* try the next mirror */
        }
      }
      if (!w.jsQR) throw new Error('QR reader unavailable')
      return w.jsQR
    })()
    jsQrPromise.catch(() => {
      jsQrPromise = null // allow a retry next time
    })
  }
  return jsQrPromise
}

/** Turn whatever was scanned or typed into a Sitka link, or null if it is not one. */
export function sitkaLinkFrom(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  try {
    const url = new URL(text)
    if (!/^https?:$/.test(url.protocol)) return null
    if (/^\/(e|s|r)\//.test(url.pathname) || url.pathname.startsWith('/app')) return url.toString()
    return null
  } catch {
    // a bare event id or code, as printed under some QR codes
    if (/^[a-z0-9][a-z0-9-]{3,}$/i.test(text)) return `${IS_WEB ? location.origin : 'https://sitka-blue.vercel.app'}/e/${text}`
    return null
  }
}

/**
 * Join a live session: point the camera at the host's QR code, or paste the
 * link. Attendees land on the event page, which runs in the browser.
 */
export default function JoinView({ onBack }: Props): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [camera, setCamera] = useState<'starting' | 'on' | 'off'>('starting')
  const [reader, setReader] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [found, setFound] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')

  const go = (url: string): void => {
    setFound(url)
    if (IS_WEB) window.location.assign(url)
    else window.open(url)
  }

  useEffect(() => {
    let stream: MediaStream | null = null
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const canvas = document.createElement('canvas')
    const handle = (text: string): boolean => {
      const link = sitkaLinkFrom(text)
      if (!link) {
        setError('That code is not a Sitka session.')
        return false
      }
      setError(null)
      go(link)
      return true
    }
    const run = async (): Promise<void> => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
          audio: false
        })
      } catch {
        if (!stopped) setCamera('off')
        return
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      const v = videoRef.current
      if (!v) return
      v.srcObject = stream
      await v.play().catch(() => undefined)
      setCamera('on')
      // The browser's own reader where it exists; otherwise the small decoder.
      // If the built-in one ever throws, the decoder takes over.
      const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
      let detector: BarcodeDetectorLike | null = null
      try {
        detector = Detector ? new Detector({ formats: ['qr_code'] }) : null
      } catch {
        detector = null
      }
      let jsqr: JsQr | null = null
      const ensureDecoder = async (): Promise<void> => {
        if (jsqr) return
        try {
          jsqr = await loadJsQr()
          setReader('ready')
        } catch {
          setReader('failed')
        }
      }
      if (!detector) await ensureDecoder()
      else setReader('ready')
      const tick = async (): Promise<void> => {
        if (stopped) return
        const video = videoRef.current
        if (video && video.videoWidth > 0) {
          let text: string | undefined
          if (detector) {
            try {
              const codes = await detector.detect(video)
              text = codes[0]?.rawValue
            } catch {
              detector = null
              await ensureDecoder()
            }
          }
          if (!text && jsqr) {
            try {
              // the whole picture, scaled down: people rarely centre the code perfectly
              const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight))
              const w = Math.round(video.videoWidth * scale)
              const h = Math.round(video.videoHeight * scale)
              canvas.width = w
              canvas.height = h
              const ctx = canvas.getContext('2d', { willReadFrequently: true })
              if (ctx) {
                ctx.drawImage(video, 0, 0, w, h)
                const img = ctx.getImageData(0, 0, w, h)
                text = jsqr(img.data, w, h)?.data
              }
            } catch {
              /* try again on the next frame */
            }
          }
          if (text && handle(text)) return
        }
        timer = setTimeout(() => void tick(), 250)
      }
      void tick()
    }
    void run()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="content">
      <div className="content-inner join" style={{ maxWidth: 560 }}>
        <h1 className="page-title">Join a session</h1>
        <p className="page-subtitle">
          Point the camera at the QR code the host is showing. You will get the captions, the slides and your own
          Sitka, on this phone.
        </p>

        <div className={`join-stage${camera === 'on' ? ' on' : ''}`}>
          <video ref={videoRef} playsInline muted autoPlay />
          {camera === 'on' && !found && (
            <div className="join-frame" aria-hidden="true">
              <i /> <i /> <i /> <i />
            </div>
          )}
          {camera === 'starting' && (
            <div className="join-note">
              <Mark size={18} live /> Opening the camera…
            </div>
          )}
          {camera === 'off' && (
            <div className="join-note">
              <IconQr size={26} strokeWidth={1.5} />
              <span>
                The camera is not available here. Scan the code with your phone&apos;s camera app, or paste the link
                below.
              </span>
            </div>
          )}
          {found && (
            <div className="join-note">
              <Mark size={18} live /> Joining…
            </div>
          )}
        </div>
        {camera === 'on' && !found && reader !== 'failed' && (
          <div className="join-hint">
            {reader === 'ready' ? 'Hold steady over the code. It joins by itself.' : 'Getting the reader ready…'}
          </div>
        )}
        {camera === 'on' && reader === 'failed' && (
          <div className="notice notice-error" style={{ marginTop: 12 }}>
            The code reader could not load on this connection. Paste the link below instead.
          </div>
        )}
        {error && <div className="notice notice-error" style={{ marginTop: 12 }}>{error}</div>}

        <div className="join-manual">
          <div className="join-manual-label">Or paste the link or code</div>
          <div className="join-manual-row">
            <input
              className="input"
              placeholder="https://… or the event code"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const link = sitkaLinkFrom(typed)
                  if (link) go(link)
                  else setError('That does not look like a Sitka link or code.')
                }
              }}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="url"
            />
            <button
              className="btn"
              disabled={!typed.trim()}
              onClick={() => {
                const link = sitkaLinkFrom(typed)
                if (link) go(link)
                else setError('That does not look like a Sitka link or code.')
              }}
            >
              Join
            </button>
          </div>
        </div>

        <button className="btn btn-ghost btn-sm" style={{ marginTop: 22 }} onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  )
}
