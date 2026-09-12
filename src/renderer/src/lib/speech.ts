/**
 * Reading answers aloud. On the web the words go to /api/speak, which returns a
 * natural voice; the browser's own voice is only the fallback, and even then
 * the best voice installed is chosen rather than the default one.
 *
 * Browsers only let a page play sound after a tap. The audio element is
 * therefore created and started inside the tap that asked for the reading,
 * with a silent clip, and the fetched speech is played through that same
 * element afterwards.
 */

const IS_WEB = (window as unknown as { sitkaWeb?: boolean }).sitkaWeb === true
const CHUNK = 900
/** A tenth of a second of silence as a WAV: enough to unlock playback. */
function silentWav(): string {
  const rate = 8000
  const samples = rate / 10
  const buf = new ArrayBuffer(44 + samples * 2)
  const v = new DataView(buf)
  const str = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + samples * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, samples * 2, true)
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
}
let SILENT_WAV = ''

export interface Speaker {
  stop: () => void
}

/** The nicest voice the browser has for a language; robotic ones score last. */
export function bestVoice(lang = 'en'): SpeechSynthesisVoice | null {
  const synth = window.speechSynthesis
  if (!synth) return null
  const code = lang.toLowerCase().slice(0, 2)
  const voices = synth.getVoices().filter((v) => v.lang?.toLowerCase().startsWith(code))
  if (voices.length === 0) return null
  const score = (v: SpeechSynthesisVoice): number => {
    const n = v.name
    let s = 0
    if (/natural|neural|premium|enhanced|wavenet|journey|studio/i.test(n)) s += 40
    if (/^google/i.test(n)) s += 30
    if (/microsoft .*online/i.test(n)) s += 25
    if (/samantha|daniel|karen|moira|siri|ava|allison/i.test(n)) s += 15
    if (/espeak|compact|robot/i.test(n)) s -= 50
    if (!v.localService) s += 5
    return s
  }
  return [...voices].sort((a, b) => score(b) - score(a))[0] ?? null
}

/** Split long text at sentence ends so each piece stays a comfortable size. */
function chunks(text: string): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > CHUNK) {
    const slice = rest.slice(0, CHUNK)
    const cut = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('? '),
      slice.lastIndexOf('! '),
      slice.lastIndexOf('\n')
    )
    const at = cut > CHUNK / 3 ? cut + 1 : CHUNK
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) out.push(rest)
  return out
}

function speakWithBrowser(text: string, lang: string, onEnd: (ok: boolean) => void): Speaker {
  const synth = window.speechSynthesis
  if (!synth) {
    onEnd(false)
    return { stop: () => undefined }
  }
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  const v = bestVoice(lang)
  if (v) u.voice = v
  u.lang = v?.lang || lang
  u.rate = 1.02
  let spoke = false
  u.onstart = () => {
    spoke = true
  }
  u.onend = () => onEnd(true)
  u.onerror = () => onEnd(spoke)
  // Some browsers drop an utterance queued in the same tick as cancel().
  setTimeout(() => synth.speak(u), 80)
  return {
    stop: () => {
      u.onend = null
      u.onerror = null
      synth.cancel()
    }
  }
}

async function fetchSpeech(text: string): Promise<Blob | null> {
  try {
    const r = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    })
    if (!r.ok) return null
    // anything that is not audio (an HTML page, a JSON error) is no voice
    if (!/^audio\//i.test(r.headers.get('content-type') || '')) return null
    const b = await r.blob()
    return b.size > 1000 ? b : null
  } catch {
    return null
  }
}

/**
 * Speak `text`; returns the speaker at once. Call it inside the tap that asked
 * for the reading. `onEnd(ok)` fires when the reading finishes or fails, not
 * when it is stopped.
 */
export function speakText(text: string, lang: string, onEnd: (ok: boolean) => void): Speaker {
  if (!IS_WEB) return speakWithBrowser(text, lang, onEnd)

  let cancelled = false
  let fallback: Speaker | null = null
  const parts = chunks(text)

  // Created and started inside the tap so the browser lets it make sound.
  if (!SILENT_WAV) SILENT_WAV = silentWav()
  const audio = new Audio(SILENT_WAV)
  audio.preload = 'auto'
  let unlocked = true
  audio.play().catch(() => {
    unlocked = false
  })

  const playBlob = (blob: Blob): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const url = URL.createObjectURL(blob)
      let played = false
      const finish = (ok: boolean): void => {
        URL.revokeObjectURL(url)
        audio.onended = null
        audio.onerror = null
        audio.onplaying = null
        resolve(ok)
      }
      audio.onplaying = () => {
        played = true
      }
      audio.onended = () => finish(true)
      audio.onerror = () => finish(played)
      audio.src = url
      audio.play().catch(() => finish(false))
    })

  const run = async (): Promise<void> => {
    let next: Promise<Blob | null> = fetchSpeech(parts[0])
    for (let i = 0; i < parts.length; i++) {
      const blob = await next
      if (cancelled) return
      if (!blob || !unlocked) {
        // no voice from the server, or sound is blocked: the browser reads it
        if (i === 0) {
          fallback = speakWithBrowser(text, lang, onEnd)
          return
        }
        break
      }
      if (i + 1 < parts.length) next = fetchSpeech(parts[i + 1])
      const ok = await playBlob(blob)
      if (cancelled) return
      if (!ok) {
        if (i === 0) {
          fallback = speakWithBrowser(text, lang, onEnd)
          return
        }
        break
      }
    }
    onEnd(true)
  }
  void run()

  return {
    stop: () => {
      cancelled = true
      audio.pause()
      audio.onended = null
      audio.onerror = null
      audio.removeAttribute('src')
      fallback?.stop()
    }
  }
}
