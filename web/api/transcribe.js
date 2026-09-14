// Whisper proxy: audio chunk (base64) in, timestamped segments out.
// OpenAI preferred when its key is present, otherwise Groq's free Whisper.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const { keys = {}, audioB64 = '', mime = 'audio/webm', offsetSec = 0 } = req.body || {}
    const clean = (s) => String(s || '').replace(/[^\x21-\x7e]/g, '')
    const openaiKey = clean(keys.openaiApiKey) || clean(process.env.OPENAI_API_KEY)
    const groqKey = clean(keys.groqApiKey) || clean(process.env.GROQ_API_KEY)
    const key = openaiKey || groqKey
    if (!key) {
      res.status(400).json({ error: 'missing-key' })
      return
    }
    const useOpenai = Boolean(openaiKey)
    const url = useOpenai
      ? 'https://api.openai.com/v1/audio/transcriptions'
      : 'https://api.groq.com/openai/v1/audio/transcriptions'
    const model = useOpenai ? 'whisper-1' : 'whisper-large-v3-turbo'

    const buf = Buffer.from(audioB64, 'base64')
    if (buf.length < 1500) {
      res.status(200).json({ segments: [] })
      return
    }
    const form = new FormData()
    form.append('file', new Blob([buf], { type: mime }), 'chunk.webm')
    form.append('model', model)
    form.append('response_format', 'verbose_json')

    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form
    })
    const j = await r.json()
    if (!r.ok) {
      res.status(502).json({ error: j.error?.message || 'Transcription error' })
      return
    }
    // Silence makes Whisper invent words: lone punctuation, "Thank you.",
    // "Hello, welcome to the channel." and the like. Two guards: the model's
    // own confidence (no_speech_prob, avg_logprob) and a list of the phrases
    // it produces from nothing. Neither is ever shown as speech.
    const INVENTED =
      /^(i'?m sorry\.?|thank you\.?|thanks?( for watching| you)?\.?|hello,? (and )?welcome( to (the|my|this) (channel|video|stream))?\.?|please subscribe.*|subscribe.*|bye\.?|you\.?|so\.?|okay\.?|um+\.?|music\.?|\[music\]|\(music\)|\[applause\]|\[blank_audio\]|amara\.org.*|www\..*)$/i
    const isSpeech = (s) => {
      const t = String(s.text || '').trim()
      if (!/[\p{L}\p{N}]/u.test(t)) return false
      if (INVENTED.test(t)) return false
      if (Number(s.no_speech_prob) > 0.6) return false
      if (Number(s.avg_logprob) < -1.0) return false
      if (Number(s.compression_ratio) > 2.4) return false
      return true
    }
    const segments = (j.segments || [])
      .filter(isSpeech)
      .map((s) => ({
        start: offsetSec + (Number(s.start) || 0),
        end: offsetSec + (Number(s.end) || 0),
        text: String(s.text || '').trim()
      }))
    if (segments.length === 0 && j.text && String(j.text).trim() && !(j.segments || []).length) {
      const t = String(j.text).trim()
      if (/[\p{L}\p{N}]/u.test(t) && !INVENTED.test(t)) segments.push({ start: offsetSec, end: offsetSec + 5, text: t })
    }
    res.status(200).json({ segments })
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) })
  }
}
