// Read text aloud in a natural voice. Gemini's speech model first (the same
// GEMINI_API_KEY / GEMINI_API_KEYS as chat), then Groq's PlayAI voice on the
// GROQ_API_KEY(S) backups, then 503 so the browser falls back to its own voice.
// Returns a WAV body. Nothing is stored.

const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts'
const GEMINI_VOICE = 'Kore'
const GROQ_TTS_MODEL = 'playai-tts'
const GROQ_VOICE = 'Arista-PlayAI'
const MAX_CHARS = 2000

const clean = (s) => String(s || '').replace(/[^\x21-\x7e]/g, '')

function keysFrom(single, many, prefix) {
  return [
    clean(process.env[single]),
    ...String(process.env[many] || '')
      .split(/[,\s]+/)
      .map(clean),
    ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => clean(process.env[`${prefix}_${n}`]))
  ].filter((k, i, all) => k && k.length > 10 && all.indexOf(k) === i)
}

// Gemini returns raw 16-bit PCM at 24 kHz; wrap it as WAV so <audio> plays it.
function pcmToWav(pcm, rate = 24000) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function geminiSpeak(key, text) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE } } }
        }
      })
    }
  )
  if (!r.ok) return { error: `Gemini ${r.status}` }
  const j = await r.json()
  const part = (((j.candidates || [])[0] || {}).content || {}).parts?.find((p) => p.inlineData)
  if (!part) return { error: 'Gemini returned no audio' }
  const rate = Number((/rate=(\d+)/.exec(part.inlineData.mimeType || '') || [])[1]) || 24000
  const pcm = Buffer.from(part.inlineData.data, 'base64')
  return { wav: pcmToWav(pcm, rate) }
}

async function groqSpeak(key, text) {
  const r = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: GROQ_TTS_MODEL, voice: GROQ_VOICE, input: text, response_format: 'wav' })
  })
  if (!r.ok) return { error: `Groq ${r.status}` }
  return { wav: Buffer.from(await r.arrayBuffer()) }
}

async function synthesize(text) {
  const errors = []
  const gemini = keysFrom('GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GEMINI_API_KEY')
  const groq = keysFrom('GROQ_API_KEY', 'GROQ_API_KEYS', 'GROQ_API_KEY')
  for (const key of gemini) {
    try {
      const out = await geminiSpeak(key, text)
      if (out.wav) return { wav: out.wav, provider: 'gemini', errors }
      errors.push('Gemini: ' + out.error)
    } catch (err) {
      errors.push('Gemini: ' + String(err && err.message ? err.message : err))
    }
  }
  for (const key of groq) {
    try {
      const out = await groqSpeak(key, text)
      if (out.wav) return { wav: out.wav, provider: 'groq', errors }
      errors.push('Groq: ' + out.error)
    } catch (err) {
      errors.push('Groq: ' + String(err && err.message ? err.message : err))
    }
  }
  if (gemini.length === 0 && groq.length === 0) errors.push('No GEMINI_API_KEY(S) or GROQ_API_KEY(S) set')
  return { wav: null, provider: null, errors }
}

export default async function handler(req, res) {
  // GET /api/speak — a check you can open in a browser: which voice answers.
  if (req.method === 'GET') {
    const out = await synthesize('Sitka is ready.')
    res.status(out.wav ? 200 : 503).json({
      ok: Boolean(out.wav),
      provider: out.provider,
      bytes: out.wav ? out.wav.length : 0,
      errors: out.errors.slice(0, 6)
    })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  const text = String((req.body || {}).text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHARS)
  if (!text) {
    res.status(400).json({ error: 'Nothing to say.' })
    return
  }
  const out = await synthesize(text)
  if (!out.wav) {
    res.status(503).json({ error: 'No voice available right now.', detail: out.errors.slice(0, 4) })
    return
  }
  res.setHeader('Content-Type', 'audio/wav')
  res.setHeader('Cache-Control', 'private, max-age=3600')
  res.setHeader('X-Voice', out.provider)
  res.status(200).send(out.wav)
}
