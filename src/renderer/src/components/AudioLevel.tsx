import React, { useEffect, useRef } from 'react'

interface Props {
  stream: MediaStream | null
  bars?: number
  tall?: boolean
}

/**
 * A quiet live waveform: bars that breathe with the microphone. Used on the
 * setup page (so you know Sitka can hear you) and as the stage of an
 * audio-only session.
 */
export default function AudioLevel({ stream, bars = 28, tall = false }: Props): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return undefined
    const nodes = Array.from(wrap.children) as HTMLElement[]
    if (!stream || stream.getAudioTracks().length === 0) {
      nodes.forEach((n) => (n.style.transform = 'scaleY(0.12)'))
      return undefined
    }
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.82
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()))
    src.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    let raf = 0
    const draw = (): void => {
      analyser.getByteFrequencyData(data)
      const step = Math.max(1, Math.floor((data.length * 0.6) / nodes.length))
      nodes.forEach((n, i) => {
        let sum = 0
        for (let j = 0; j < step; j++) sum += data[i * step + j] ?? 0
        const v = sum / step / 255
        n.style.transform = `scaleY(${Math.max(0.12, Math.min(1, v * 1.6))})`
      })
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => {
      cancelAnimationFrame(raf)
      src.disconnect()
      void ctx.close().catch(() => undefined)
    }
  }, [stream, bars])

  return (
    <div ref={wrapRef} className={`audio-level${tall ? ' tall' : ''}`} aria-hidden="true">
      {Array.from({ length: bars }).map((_, i) => (
        <span key={i} className="audio-bar" />
      ))}
    </div>
  )
}
