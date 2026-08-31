// Whisper proxy: audio chunk (base64) in, timestamped segments out.
// OpenAI preferred when its key is present, otherwise Groq's free Whisper.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const { keys = {}, audioB64 = '', mime = 'audio/webm', offsetSec = 0 } = req.body || {}
    const key = keys.openaiApiKey || keys.groqApiKey
    if (!key) {
      res.status(400).json({ error: 'missing-key' })
      return
    }
    const useOpenai = Boolean(keys.openaiApiKey)
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
    const segments = (j.segments || [])
      .map((s) => ({
        start: offsetSec + (Number(s.start) || 0),
        end: offsetSec + (Number(s.end) || 0),
        text: String(s.text || '').trim()
      }))
      .filter((s) => s.text)
    if (segments.length === 0 && j.text && String(j.text).trim()) {
      segments.push({ start: offsetSec, end: offsetSec + 5, text: String(j.text).trim() })
    }
    res.status(200).json({ segments })
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) })
  }
}
