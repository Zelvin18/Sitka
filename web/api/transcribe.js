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
    // Every Groq key the deployment has, the same set the chat route rotates
    // through, so one account being rate-limited does not silence a lecture.
    const groqKeys = [
      clean(keys.groqApiKey),
      clean(process.env.GROQ_API_KEY),
      ...String(process.env.GROQ_API_KEYS || '').split(/[,\s]+/).map(clean),
      ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => clean(process.env[`GROQ_API_KEY_${n}`]))
    ].filter((k, i, all) => k && k.length > 10 && all.indexOf(k) === i)
    const tries = openaiKey
      ? [{ key: openaiKey, url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1' }]
      : groqKeys.map((key) => ({ key, url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo' }))
    if (tries.length === 0) {
      res.status(400).json({ error: 'missing-key' })
      return
    }

    const buf = Buffer.from(audioB64, 'base64')
    if (buf.length < 1500) {
      res.status(200).json({ segments: [] })
      return
    }
    if (buf.length > 6 * 1024 * 1024) {
      res.status(413).json({ error: 'That piece of audio is too large.' })
      return
    }

    let j = null
    let lastError = 'Transcription error'
    for (const t of tries) {
      const form = new FormData()
      form.append('file', new Blob([buf], { type: mime }), 'chunk.webm')
      form.append('model', t.model)
      form.append('response_format', 'verbose_json')
      let r
      try {
        // a stalled provider is given up on well inside the function's own limit
        r = await fetch(t.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${t.key}` },
          body: form,
          signal: AbortSignal.timeout(40000)
        })
      } catch (err) {
        lastError = err && err.name === 'TimeoutError' ? 'The transcription service did not answer in time.' : String((err && err.message) || err)
        continue
      }
      const text = await r.text()
      let body = null
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
      if (r.ok && body) {
        j = body
        break
      }
      lastError = (body && body.error && body.error.message) || `Transcription error (HTTP ${r.status})`
      // a key that is out of quota, rate-limited or refused: the next key takes over
      if (r.status === 429 || r.status === 401 || r.status === 403 || r.status >= 500) continue
      break
    }
    if (!j) {
      res.status(502).json({ error: lastError })
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
