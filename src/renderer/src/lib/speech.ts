/**
 * Reading answers aloud. On the web the words go to /api/speak, which returns a
 * natural voice; the browser's own voice is only the fallback, and even then
 * the best voice installed is chosen rather than the default one.
 */

const IS_WEB = (window as unknown as { sitkaWeb?: boolean }).sitkaWeb === true
const CHUNK = 900

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
    const cut = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '), slice.lastIndexOf('\n'))
    const at = cut > CHUNK / 3 ? cut + 1 : CHUNK
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) out.push(rest)
  return out
}

function speakWithBrowser(text: string, lang: string, onEnd: () => void): Speaker {
  const synth = window.speechSynthesis
  if (!synth) {
    onEnd()
    return { stop: () => undefined }
  }
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  const v = bestVoice(lang)
  if (v) u.voice = v
  u.lang = v?.lang || lang
  u.rate = 1.02
  u.onend = onEnd
  u.onerror = onEnd
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
    const b = await r.blob()
    return b.size > 1000 ? b : null
  } catch {
    return null
  }
}

/**
 * Speak `text`; resolves the speaker at once. `onEnd` fires when the reading
 * finishes or fails, not when it is stopped.
 */
export function speakText(text: string, lang: string, onEnd: () => void): Speaker {
  if (!IS_WEB) return speakWithBrowser(text, lang, onEnd)

  let cancelled = false
  let current: HTMLAudioElement | null = null
  let fallback: Speaker | null = null
  const parts = chunks(text)

  const run = async (): Promise<void> => {
    // the first piece decides: no voice from the server means the browser reads
    let next: Promise<Blob | null> = fetchSpeech(parts[0])
    for (let i = 0; i < parts.length; i++) {
      const blob = await next
      if (cancelled) return
      if (!blob) {
        if (i === 0) {
          fallback = speakWithBrowser(text, lang, onEnd)
          return
        }
        break
      }
      if (i + 1 < parts.length) next = fetchSpeech(parts[i + 1])
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      current = audio
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve()
        audio.onerror = () => resolve()
        void audio.play().catch(() => resolve())
      })
      URL.revokeObjectURL(url)
      current = null
      if (cancelled) return
    }
    onEnd()
  }
  void run()

  return {
    stop: () => {
      cancelled = true
      if (current) {
        current.pause()
        current.src = ''
      }
      fallback?.stop()
    }
  }
}
