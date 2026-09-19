// Read text aloud in a natural voice. For English, Deepgram's quick voice
// (DEEPGRAM_API_KEY) first, then Groq's; for other languages Gemini's speech
// models (the same GEMINI_API_KEY / GEMINI_API_KEYS as chat). Then 503 so
// the browser falls back to its own voice.
// Returns a WAV body. Nothing is stored.
//
// Model ids are discovered from what each account lists, so a renamed or
// retired preview id never silences the feature. A model that answers with
// "not found", "decommissioned" or "requires terms acceptance" is skipped for
// a while.

import { overLimit } from './_limit.js'

const KNOWN_GEMINI = [
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-flash-tts',
  'gemini-2.5-pro-preview-tts',
  'gemini-2.5-pro-tts'
]
const GEMINI_VOICE = 'Kore'
const KNOWN_GROQ = ['playai-tts', 'canopylabs/orpheus-3b-0.1-ft', 'canopylabs/orpheus-v1-english']
const GROQ_VOICES = {
  playai: ['Arista-PlayAI', 'Celeste-PlayAI', 'Fritz-PlayAI'],
  orpheus: ['autumn', 'tara', 'hannah', 'diana', 'daniel', 'austin']
}
const MAX_CHARS = 2000
const DEAD_MS = 30 * 60 * 1000

const listCache = new Map() // key tail -> { ids, at }
const dead = new Map() // provider:model -> until
const isDead = (id) => (dead.get(id) || 0) > Date.now()
const markDead = (id) => dead.set(id, Date.now() + DEAD_MS)
const DEAD_RE = /not found|does not exist|decommissioned|terms acceptance|no longer|deprecated|not supported|unsupported model|invalid model/i

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

const tail = (key) => key.slice(0, 1) + key.slice(-8)
function cached(key) {
  const c = listCache.get(tail(key))
  return c && Date.now() - c.at < 10 * 60 * 1000 ? c.ids : null
}
function remember(key, ids) {
  listCache.set(tail(key), { ids, at: Date.now() })
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

// ---------- Gemini ----------
async function geminiModels(key) {
  const hit = cached('g' + key)
  if (hit) return hit
  // the known ids answer at once; the directory is read in the background
  // for the next call, so a cold start never spends seconds listing
  remember('g' + key, KNOWN_GEMINI)
  void listGemini(key)
  return KNOWN_GEMINI
}
async function listGemini(key) {
  let listed = []
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${key}`,
      { signal: AbortSignal.timeout(10000) }
    )
    if (r.ok) {
      const j = await r.json()
      listed = (j.models || [])
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter((id) => /tts/i.test(id))
    }
  } catch {
    /* fall through to the known list */
  }
  const order = (id) => (/flash/i.test(id) ? 0 : 1)
  const ids = [...listed.sort((a, b) => order(a) - order(b)), ...KNOWN_GEMINI].filter(
    (id, i, all) => all.indexOf(id) === i
  )
  remember('g' + key, ids)
  return ids
}

async function geminiSpeakWith(key, model, text) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      signal: AbortSignal.timeout(25000),
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
  if (!r.ok) {
    const body = (await r.text().catch(() => '')).slice(0, 300)
    return { error: `${model} ${r.status} ${body}`, status: r.status, body }
  }
  const j = await r.json()
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || []
  const part = parts.find((p) => p.inlineData && p.inlineData.data)
  if (!part) return { error: `${model} returned no audio`, status: 200, body: '' }
  const rate = Number((/rate=(\d+)/.exec(part.inlineData.mimeType || '') || [])[1]) || 24000
  const pcm = Buffer.from(part.inlineData.data, 'base64')
  return { wav: /wav/i.test(part.inlineData.mimeType || '') ? pcm : pcmToWav(pcm, rate) }
}

async function geminiSpeak(keys, text, errors) {
  for (const key of keys) {
    const models = await geminiModels(key)
    for (const model of models) {
      if (isDead('gemini:' + model)) continue
      try {
        const out = await geminiSpeakWith(key, model, text)
        if (out.wav) return { wav: out.wav, model }
        errors.push('Gemini ' + out.error)
        if (out.status === 404 || DEAD_RE.test(out.body)) markDead('gemini:' + model)
        // a rate limit or quota problem is about the key: try the next key
        if (out.status === 429 || out.status === 403) break
      } catch (err) {
        errors.push('Gemini ' + String(err && err.message ? err.message : err))
      }
    }
  }
  return null
}

// ---------- Groq ----------
async function groqModels(key) {
  const hit = cached('q' + key)
  if (hit) return hit
  remember('q' + key, KNOWN_GROQ)
  void listGroq(key)
  return KNOWN_GROQ
}
async function listGroq(key) {
  let listed = []
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${key}` }
    })
    if (r.ok) {
      const j = await r.json()
      listed = (j.data || [])
        .map((m) => String(m.id || ''))
        .filter((id) => /tts|orpheus|playai/i.test(id) && !/arabic|whisper|stt|transcri/i.test(id))
    }
  } catch {
    /* fall through to the known list */
  }
  const order = (id) => (/playai/i.test(id) ? 0 : 1)
  const ids = [...listed.sort((a, b) => order(a) - order(b)), ...KNOWN_GROQ].filter(
    (id, i, all) => all.indexOf(id) === i
  )
  remember('q' + key, ids)
  return ids
}

async function groqSpeakWith(key, model, voice, text) {
  const r = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    signal: AbortSignal.timeout(25000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, voice, input: text, response_format: 'wav' })
  })
  if (!r.ok) {
    const body = (await r.text().catch(() => '')).slice(0, 300)
    return { error: `${model}/${voice} ${r.status} ${body}`, status: r.status, body }
  }
  return { wav: Buffer.from(await r.arrayBuffer()) }
}

async function groqSpeak(keys, text, errors) {
  for (const key of keys) {
    const models = await groqModels(key)
    for (const model of models) {
      if (isDead('groq:' + model)) continue
      const voices = /playai/i.test(model) ? GROQ_VOICES.playai : GROQ_VOICES.orpheus
      let keyDone = false
      for (const voice of voices) {
        try {
          const out = await groqSpeakWith(key, model, voice, text)
          if (out.wav) return { wav: out.wav, model }
          errors.push('Groq ' + out.error)
          if (out.status === 404 || DEAD_RE.test(out.body)) {
            markDead('groq:' + model)
            break
          }
          if (out.status === 429) {
            keyDone = true
            break
          }
          // a wrong voice name is a 400: try the next voice; anything else, next model
          if (out.status !== 400) break
        } catch (err) {
          errors.push('Groq ' + String(err && err.message ? err.message : err))
          break
        }
      }
      if (keyDone) break
    }
  }
  return null
}

// ---------- Deepgram ----------
// The quickest voice of all for English, from the same account that tells
// speakers apart: a sentence in well under a second.
const DEEPGRAM_VOICE = 'aura-2-thalia-en'
async function deepgramSpeak(key, text, errors) {
  if (!key || isDead('deepgram:aura')) return null
  try {
    const r = await fetch(
      `https://api.deepgram.com/v1/speak?model=${DEEPGRAM_VOICE}&encoding=linear16&sample_rate=24000&container=wav`,
      {
        signal: AbortSignal.timeout(15000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Token ${key}` },
        body: JSON.stringify({ text })
      }
    )
    if (!r.ok) {
      const body = (await r.text().catch(() => '')).slice(0, 300)
      errors.push(`Deepgram ${r.status} ${body}`)
      if (r.status === 401 || r.status === 403 || r.status === 404) markDead('deepgram:aura')
      return null
    }
    const wav = Buffer.from(await r.arrayBuffer())
    return wav.length > 1000 ? { wav, model: DEEPGRAM_VOICE } : null
  } catch (err) {
    errors.push('Deepgram ' + String(err && err.message ? err.message : err))
    return null
  }
}

async function synthesize(text, lang) {
  const errors = []
  const gemini = keysFrom('GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GEMINI_API_KEY')
  const groq = keysFrom('GROQ_API_KEY', 'GROQ_API_KEYS', 'GROQ_API_KEY')
  const deepgram = clean(process.env.DEEPGRAM_API_KEY)
  if (gemini.length === 0 && groq.length === 0 && !deepgram) {
    errors.push('No DEEPGRAM_API_KEY, GEMINI_API_KEY(S) or GROQ_API_KEY(S) set')
    return { wav: null, provider: null, errors }
  }
  // English has quick voices (Deepgram's in well under a second, Groq's in
  // about one); Gemini's speak most languages and take a few seconds.
  // English goes to the quick ones first, everything else to the one that
  // can say it.
  const english = !lang || /^(en|english)/i.test(String(lang).trim())
  const tryDeepgram = async () => {
    const d = await deepgramSpeak(deepgram, text, errors)
    return d ? { wav: d.wav, provider: 'deepgram:' + d.model, errors } : null
  }
  const tryGroq = async () => {
    const q = await groqSpeak(groq, text, errors)
    return q ? { wav: q.wav, provider: 'groq:' + q.model, errors } : null
  }
  const tryGemini = async () => {
    const g = await geminiSpeak(gemini, text, errors)
    return g ? { wav: g.wav, provider: 'gemini:' + g.model, errors } : null
  }
  // (the English-only voices would read other languages as gibberish rather
  // than refuse, so for those the browser's own voice is the better fallback)
  const order = english ? [tryDeepgram, tryGroq, tryGemini] : [tryGemini]
  for (const step of order) {
    const out = await step()
    if (out) return out
  }
  return { wav: null, provider: null, errors }
}

export default async function handler(req, res) {
  // the desktop app asks for the same voice from its own window
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  // GET /api/speak — a check you can open in a browser: which voice answers.
  if (req.method === 'GET') {
    const out = await synthesize('Sitca is ready.', 'en')
    res.status(out.wav ? 200 : 503).json({
      ok: Boolean(out.wav),
      provider: out.provider,
      bytes: out.wav ? out.wav.length : 0,
      errors: out.errors.slice(0, 8)
    })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  // a voice costs money each time: a flood from one address is refused
  if (overLimit(req, 60, 1500, String((req.body || {}).who || ''))) {
    res.status(429).json({ error: 'Slow down a little.' })
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
  const lang = String((req.body || {}).lang || '').slice(0, 40)
  const out = await synthesize(text, lang)
  if (!out.wav) {
    res.status(503).json({ error: 'No voice available right now.', detail: out.errors.slice(0, 6) })
    return
  }
  res.setHeader('Content-Type', 'audio/wav')
  res.setHeader('Cache-Control', 'private, max-age=3600')
  res.setHeader('X-Voice', out.provider)
  res.status(200).send(out.wav)
}
