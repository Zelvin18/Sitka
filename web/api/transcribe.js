// Whisper proxy: audio chunk (base64) in, timestamped segments out.
// OpenAI preferred when its key is present, otherwise Groq's free Whisper.
//
// Only a signed-in person may transcribe. Someone who sends their own key
// pays with it alone; everyone else is paid for by the platform, limited per
// person (never per address: a whole lecture hall shares one) and counted
// against their plan's hours.

import { allow } from './_plan.js'
import { overLimitKey } from './_limit.js'
import { platformKeys } from './_ai.js'
import { UNCHECKED, userOf, tokenOf, deadline, failSafely, realKey } from './_auth.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  const dl = deadline(55000)
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const { keys = {}, audioB64 = '', mime = 'audio/webm', offsetSec = 0 } = body
    // The language the session is in, once known. Left to guess on every
    // piece, the model hears a mumbled second of English as Japanese or
    // Korean and writes that; told the language, it stays in it.
    const language = /^[a-z]{2}$/i.test(String(body.language || '')) ? String(body.language).toLowerCase() : ''
    const me = await userOf(tokenOf(req))
    if (me === UNCHECKED) {
      res.status(503).json({ error: 'Could not check who you are just now. Try again in a moment.' })
      return
    }
    if (!me) {
      res.status(401).json({ error: 'Sign in first.' })
      return
    }
    const ownOpenai = realKey(keys.openaiApiKey)
    const ownGroq = realKey(keys.groqApiKey)
    const usingOwn = Boolean(ownOpenai || ownGroq)
    // a session sends a piece every few seconds; a flood from one person is something else
    if (await overLimitKey(`${usingOwn ? 'stt-own' : 'stt'}:user:${me.id}`, 60, 2500)) {
      res.status(429).json({ error: 'Slow down a little.', retry: true })
      return
    }
    // the month's hours; a session under way may finish
    if (!usingOwn) {
      const may = await allow(tokenOf(req), 'hours')
      if (!may.ok) {
        res.status(402).json({ error: may.message, plan: may.plan, limit: 'hours' })
        return
      }
    }
    // their keys alone, or the platform's alone: never a mix
    const openaiKey = usingOwn ? ownOpenai : platformKeys('OPENAI_API_KEY')[0] || ''
    // Every Groq key the deployment has, the same set the chat route rotates
    // through, so one account being rate-limited does not silence a lecture.
    const groqKeys = usingOwn ? (ownGroq ? [ownGroq] : []) : platformKeys('GROQ_API_KEY')
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
      // nothing new is started that could not finish inside the request
      if (dl.left() < 5000) break
      const form = new FormData()
      // the service reads the container from the file name: iPhones record AAC in MP4
      const ext = /mp4|m4a|aac/i.test(mime) ? 'mp4' : /ogg/i.test(mime) ? 'ogg' : /wav/i.test(mime) ? 'wav' : 'webm'
      form.append('file', new Blob([buf], { type: mime }), `chunk.${ext}`)
      form.append('model', t.model)
      form.append('response_format', 'verbose_json')
      if (language) form.append('language', language)
      let r
      try {
        // a stalled provider is given up on well inside the function's own limit
        r = await fetch(t.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${t.key}` },
          body: form,
          signal: dl.signal(40000)
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
      // the page keeps the piece and asks again; the provider's words stay in the logs
      console.error('[transcribe]', lastError)
      res.status(502).json({ error: 'Transcription is busy right now. Sitca tries this piece again.', retry: true })
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
    // what language the model heard, for the session to hold on to
    const heard = typeof j.language === 'string' ? j.language.toLowerCase().slice(0, 12) : ''
    res.status(200).json({ segments, language: heard })
  } catch (err) {
    failSafely(res, err, 'transcribe')
  }
}
