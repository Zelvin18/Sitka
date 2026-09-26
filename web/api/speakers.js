// Voices told apart.
//
// A finished recording is listened to again, whole, by Deepgram, which hears
// which stretches were spoken by the same voice and hands back utterances:
// who spoke, from when to when, and what they said. The recording never
// passes through here: Deepgram is given a short-lived link straight into
// Cloudflare R2, the same kind the player uses, and only the words come back.
//
// Only the owner of a session may ask, and only for a recording that exists
// as one whole file. The browser does the rest: it lays the voices over the
// session's own transcript lines and saves the result.

import { r2Config, presign, r2List } from './_r2.js'
import { SUPA_URL, SUPA_ANON, requireUser, failSafely, tokenOf } from './_auth.js'
import { allowListen, meter } from './_plan.js'
import { UUID } from './_share.js'
import { overLimitKey } from './_limit.js'

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ configured: Boolean(process.env.DEEPGRAM_API_KEY && r2Config()) })
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const key = String(process.env.DEEPGRAM_API_KEY || '').trim()
  const cfg = r2Config()
  if (!key || !cfg || !SUPA_URL || !SUPA_ANON) return res.status(501).json({ error: 'not-configured' })

  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      body = {}
    }
  }
  if (!body || typeof body !== 'object') body = {}
  const sessionId = String(body.session || '')
  if (!UUID.test(sessionId)) return res.status(400).json({ error: 'Bad session.' })

  const who = await requireUser(req, res)
  if (!who) return
  const owner = who.id.toLowerCase()
  // listening again is the costliest thing Sitca does: a few an hour each,
  // one recording at most twice an hour, and within the plan's allowance
  if ((await overLimitKey(`speakers:user:${owner}`, 3, 20)) || (await overLimitKey(`speakers:session:${sessionId}`, 2, 2))) {
    return res.status(429).json({ error: 'Slow down a little.' })
  }
  const may = await allowListen(tokenOf(req), owner)
  if (!may.ok) return res.status(may.transient ? 503 : 402).json({ error: may.message, plan: may.plan, limit: 'listen' })

  try {
    // the whole file, and only the whole file: parts are not one recording
    const wholeKey = `${owner}/${sessionId}.webm`
    const objects = await r2List(cfg, wholeKey)
    const whole = objects.find((o) => o.key === wholeKey)
    if (!whole) return res.status(404).json({ error: 'no-whole-file' })
    if (whole.size > 1900 * 1024 * 1024) return res.status(413).json({ error: 'That recording is too large to listen to again.' })

    const url = presign(cfg, 'GET', wholeKey, 3600)
    const q = new URLSearchParams({
      model: 'nova-3',
      diarize: 'true',
      utterances: 'true',
      smart_format: 'true',
      punctuate: 'true',
      detect_language: 'true',
      // a hand-over inside a pause is a new utterance, not one long one
      utt_split: '1.2'
    })
    let r
    try {
      r = await fetch(`https://api.deepgram.com/v1/listen?${q}`, {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        // inside this function's own limit; a very long recording is said so
        signal: AbortSignal.timeout(54000)
      })
    } catch (err) {
      const timeout = err && err.name === 'TimeoutError'
      if (!timeout) console.error('[speakers]', String((err && err.message) || err))
      return res.status(504).json({ error: timeout ? 'too-long' : 'Listening failed. Try again in a moment.' })
    }
    const text = await r.text()
    let j = null
    try {
      j = JSON.parse(text)
    } catch {
      j = null
    }
    if (!r.ok || !j) {
      console.error('[speakers]', r.status, (j && (j.err_msg || j.error || j.message)) || '')
      return res.status(502).json({ error: 'Listening failed. Try again in a moment.' })
    }
    const raw = (j.results && j.results.utterances) || []
    const utterances = raw
      .map((u) => ({
        start: Number(u.start) || 0,
        end: Number(u.end) || 0,
        speaker: Number.isInteger(u.speaker) ? u.speaker : 0,
        text: String(u.transcript || '').trim()
      }))
      .filter((u) => u.text && u.end > u.start)
    const channel = j.results && j.results.channels && j.results.channels[0]
    const language = (channel && channel.detected_language) || null
    const duration = Number(j.metadata && j.metadata.duration) || null
    // counted by what the service heard (it bills by the same)
    await meter(owner, 'dg', Math.ceil(duration || whole.size / 16000))
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({ utterances, language, duration })
  } catch (err) {
    return failSafely(res, err, 'speakers')
  }
}
