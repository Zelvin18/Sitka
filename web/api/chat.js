// The AI answers for the app, the host page and the public recap page.
//
// Who pays decides what is allowed:
//
//  * A caller who sends their own provider key pays for their own answer:
//    only their keys are used, never the platform's, and only a signed-in
//    person may do it (the app's "own keys" setting).
//  * Anything paid with the platform's keys needs a verified sign-in. It is
//    limited per person, and a question counts against their plan.
//  * The one exception is the public recap page, where people who were sent
//    a link ask about what they are watching without an account. They send a
//    recap or event id and their question; the server reads that recap and
//    builds the prompt itself, so the route cannot be used as a free,
//    general-purpose AI. Limited per address and per recap.
//
// Answers stream as lines of JSON ({"delta"}, then {"done"}) when asked to.

import { answer, platformKeys } from './_ai.js'
import { allow, meter } from './_plan.js'
import { overLimitKey } from './_limit.js'
import { SUPA_URL, SUPA_ANON, SUPA_SERVICE, UNCHECKED, userOf, tokenOf, ipOf, deadline, failSafely, realKey } from './_auth.js'

// what one request may carry, so a single call cannot run up a bill
const MAX_SYSTEM = 150000
const MAX_MESSAGES = 30
const MAX_TEXT = 30000
const MAX_IMAGES = 4
const MAX_IMAGE_CHARS = 2_800_000 // a data URL of about 2 MB

const UUID = /^[0-9a-fA-F-]{16,64}$/
const LANGS = ['English', 'Luganda', 'Nyankole', 'Swahili', 'Shona', 'Ndebele', 'French', 'Portuguese', 'Spanish', 'German', 'Arabic', 'Chinese', 'Hindi']

/** Messages as the providers expect them, trimmed to the caps; null when they break them. */
function tidyMessages(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_MESSAGES) return null
  let images = 0
  const out = []
  for (const m of list) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content.slice(0, MAX_TEXT) })
      continue
    }
    if (!Array.isArray(m.content) || m.content.length > 12) return null
    const parts = []
    for (const p of m.content) {
      if (p && p.type === 'text') parts.push({ type: 'text', text: String(p.text || '').slice(0, MAX_TEXT) })
      else if (p && p.type === 'image') {
        const url = String(p.dataUrl || '')
        if (++images > MAX_IMAGES || url.length > MAX_IMAGE_CHARS || !/^data:image\/[\w+.-]+;base64,/.test(url)) return null
        parts.push({ type: 'image', dataUrl: url })
      } else return null
    }
    out.push({ role: m.role, content: parts })
  }
  return out
}

// ---------- the public recap page: prompts built here ----------

const svcHeaders = () => {
  const key = SUPA_SERVICE || SUPA_ANON
  return { apikey: key, Authorization: `Bearer ${key}` }
}

/** A shared recap (or an event with its replay on), with what a prompt needs; null when not shared. */
async function sharedSession(kind, id, dl) {
  if (!SUPA_URL || !UUID.test(id)) return null
  const headers = svcHeaders()
  const fmt = (sec) => {
    const s = Math.max(0, Math.floor(Number(sec) || 0))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const r = s % 60
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
  }
  if (kind === 'event') {
    const r = await fetch(`${SUPA_URL}/rest/v1/events?id=eq.${id}&select=title,replay,materials_text`, { headers, signal: dl.signal(6000) })
    const rows = r.ok ? await r.json() : []
    const ev = Array.isArray(rows) ? rows[0] : null
    if (!ev || !ev.replay || ev.replay.enabled !== true) return null
    const s = await fetch(`${SUPA_URL}/rest/v1/segments?event_id=eq.${id}&select=start_sec,text&order=idx.asc&limit=6000`, { headers, signal: dl.signal(6000) })
    const segs = s.ok ? await s.json() : []
    return {
      title: ev.replay.title || ev.title || 'Event recap',
      summary: ev.replay.summary || '',
      kindWord: 'live event',
      materials: String(ev.materials_text || '').slice(0, 4000),
      lines: (Array.isArray(segs) ? segs : []).map((x) => ({ t: fmt(x.start_sec), text: String(x.text || '').trim() })).filter((l) => l.text)
    }
  }
  // a recap, one by its id: through sitka_recap once that function exists
  let rc = null
  const viaFn = await fetch(`${SUPA_URL}/rest/v1/rpc/sitka_recap?p_id=${id}`, { headers, signal: dl.signal(6000) })
  if (viaFn.ok) rc = await viaFn.json().catch(() => null)
  else if (viaFn.status === 404) {
    const r = await fetch(`${SUPA_URL}/rest/v1/recaps?id=eq.${id}&enabled=is.true&select=title,summary,transcript,enabled`, { headers, signal: dl.signal(6000) })
    const rows = r.ok ? await r.json() : []
    rc = Array.isArray(rows) ? rows[0] : null
  }
  if (!rc || rc.enabled !== true) return null
  return {
    title: rc.title || 'Session recap',
    summary: rc.summary || '',
    kindWord: 'session',
    materials: '',
    lines: (Array.isArray(rc.transcript) ? rc.transcript : []).map((x) => ({ t: fmt(x.start), text: String(x.text || '').trim() })).filter((l) => l.text)
  }
}

const STOP = new Set(
  'what which when where about that this there their they them then than with from into your have been were was does did has had the and for are but not you our its his her she him can could would should will just like more most some such very also only into onto over under after before earlier later show shown showed said say tell explain please hello hi thanks thank'.split(' ')
)
/** The lines a question needs, with a little around them, capped small; the shape of the session when nothing matches. */
function excerptFor(lines, q) {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOP.has(w))
  const keep = new Set()
  if (words.length > 0) {
    lines.forEach((l, i) => {
      const t = l.text.toLowerCase()
      if (words.some((w) => t.includes(w))) for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 2); k++) keep.add(k)
    })
  }
  if (keep.size < 12) {
    const step = Math.max(1, Math.floor(lines.length / 60))
    for (let i = 0; i < lines.length; i += step) keep.add(i)
  }
  let out = ''
  for (const i of [...keep].sort((a, b) => a - b)) {
    const line = `[${lines[i].t}] ${lines[i].text}\n`
    if (out.length + line.length > 14000) break
    out += line
  }
  return out
}

function recapAskPrompt(s, q, lang) {
  return [
    `You are Sitca, answering questions about a recorded ${s.kindWord}: "${s.title}".`,
    s.summary ? `Summary of the session: ${s.summary}` : '',
    'Answer every question. Look in the excerpt (and materials) below first; when the session covers it, answer from what was said. When it does not, or the question is about something else, never refuse: say so in one friendly clause, such as "That was not part of this session, but here is the short answer:", then answer properly from your own knowledge, kept clearly apart from what the speaker said.',
    'Talking to the reader, call it "the session", never "the transcript" or "the excerpt".',
    'When you reference a specific moment, cite the time exactly as it appears at the start of that line, inside plain double square brackets — for example [[12:37]] or [[1:02:15]]. Never write letters inside the brackets, never a range. These become tap-to-play links.',
    'Cite a moment when the reader would want to jump to it; a summary reads as prose.',
    'Shape every answer so it can be taken in at a glance: the answer itself in one or two plain sentences first; then, only if more is needed, short bullets that each open with a bold lead-in of two or three words; a blank line between parts. Never one long paragraph. A greeting gets one friendly line.',
    lang && lang !== 'English' ? `Always answer in ${lang}.` : '',
    s.materials ? `\nMaterials:\n${s.materials}` : '',
    `\nExcerpt of the session (each line starts with its time):\n${excerptFor(s.lines, q) || '(no words captured)'}`
  ]
    .filter(Boolean)
    .join('\n')
}

// ---------- the route ----------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  const dl = deadline(55000)
  let streaming = false
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const stream = Boolean(body.stream)
    const sink = stream
      ? (piece) => {
          if (!streaming) {
            streaming = true
            res.status(200)
            res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
            res.setHeader('Cache-Control', 'no-cache, no-transform')
            res.setHeader('X-Accel-Buffering', 'no')
            if (typeof res.flushHeaders === 'function') res.flushHeaders()
          }
          res.write(JSON.stringify({ delta: piece }) + '\n')
        }
      : null
    const finish = (out) => {
      if (streaming) {
        res.write(JSON.stringify({ done: true, vision: out.vision, model: out.model }) + '\n')
        res.end()
      } else if (stream) {
        res.status(200)
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
        res.write(JSON.stringify({ delta: out.text }) + '\n')
        res.write(JSON.stringify({ done: true, vision: out.vision, model: out.model }) + '\n')
        res.end()
      } else {
        res.status(200).json(out)
      }
    }
    const fail = (status, payload) => {
      if (streaming) {
        res.write(JSON.stringify({ error: payload.error || 'failed', transient: Boolean(payload.transient) }) + '\n')
        res.end()
      } else res.status(status).json(payload)
    }
    const deliver = (out) => {
      if (out.text !== undefined && !out.error) return finish(out)
      if (out.missing) return fail(400, { error: 'missing-key' })
      return fail(502, { error: `Sitca's AI is busy right now — it will try again automatically.`, transient: true })
    }

    // ---- the public recap page: no account, a recap id, a prompt built here ----
    const recapId = String(body.recap || '')
    const eventId = String(body.replayEvent || '')
    if (recapId || eventId) {
      const mode = body.mode === 'translate' ? 'translate' : 'ask'
      const ip = ipOf(req)
      const target = recapId ? `recap:${recapId}` : `event:${eventId}`
      if ((await overLimitKey(`chat-public:ip:${ip}`, 20, 200)) || (await overLimitKey(`chat-public:${target}`, 60, 900))) {
        res.status(429).json({ error: 'Slow down a little — try again in a few minutes.' })
        return
      }
      const s = await sharedSession(recapId ? 'recap' : 'event', recapId || eventId, dl)
      if (!s) {
        res.status(404).json({ error: 'This recap is not shared.' })
        return
      }
      const lang = LANGS.includes(String(body.lang || '')) ? String(body.lang) : 'English'
      let system
      let messages
      let maxTokens
      if (mode === 'translate') {
        const lines = Array.isArray(body.lines) ? body.lines.slice(0, 60).map((l) => String(l || '').slice(0, 500)) : []
        if (lines.length === 0 || lang === 'English') {
          res.status(400).json({ error: 'Nothing to translate.' })
          return
        }
        system = `You translate into ${lang}. The user sends numbered lines. Reply with ONLY the translated lines, one per line, keeping the same numbers in the form "N: text". No notes, no extra lines.`
        messages = [{ role: 'user', content: lines.map((t, i) => `${i + 1}: ${t}`).join('\n') }]
        maxTokens = 2000
      } else {
        const q = String(body.question || '').trim().slice(0, 800)
        if (!q) {
          res.status(400).json({ error: 'Ask something first.' })
          return
        }
        const history = (Array.isArray(body.history) ? body.history : [])
          .slice(-6)
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
        system = recapAskPrompt(s, q, lang)
        messages = [...history, { role: 'user', content: q }]
        maxTokens = 700
      }
      // the free models only: a public page never reaches the costliest provider
      const out = await answer({ system, messages, maxTokens, fast: true, sink, keys: { anthropic: '', groq: platformKeys('GROQ_API_KEY'), gemini: platformKeys('GEMINI_API_KEY') }, dl })
      deliver(out)
      return
    }

    // ---- everything else: a signed-in person ----
    const me = await userOf(tokenOf(req))
    if (me === UNCHECKED) {
      res.status(503).json({ error: 'Could not check who you are just now. Try again in a moment.' })
      return
    }
    if (!me) {
      res.status(401).json({ error: 'Sign in first.' })
      return
    }
    const system = String(body.system || '')
    if (system.length > MAX_SYSTEM) {
      res.status(413).json({ error: 'That request is too large.' })
      return
    }
    const messages = tidyMessages(body.messages)
    if (!messages) {
      res.status(400).json({ error: 'That request is not one Sitca can answer.' })
      return
    }
    const maxTokens = Math.min(4000, Math.max(64, Number(body.maxTokens) || 1600))
    const keys = body.keys && typeof body.keys === 'object' ? body.keys : {}
    const own = { anthropic: realKey(keys.anthropicApiKey), groq: realKey(keys.groqApiKey), gemini: realKey(keys.geminiApiKey) }
    const usingOwn = Boolean(own.anthropic || own.groq || own.gemini)
    if (usingOwn) {
      // their keys, their bill: nothing of the platform's is added
      if (await overLimitKey(`chat-own:user:${me.id}`, 60, 2000)) {
        res.status(429).json({ error: 'Slow down a little — try again in a few minutes.' })
        return
      }
      const out = await answer({
        system,
        messages,
        maxTokens,
        requireVision: Boolean(body.requireVision),
        fast: Boolean(body.fast),
        sink,
        keys: { anthropic: own.anthropic, groq: own.groq ? [own.groq] : [], gemini: own.gemini ? [own.gemini] : [] },
        ownGroq: own.groq,
        dl
      })
      deliver(out)
      return
    }
    // the platform's keys: limited per person, and a question counts against the plan
    if (await overLimitKey(`chat:user:${me.id}`, 45, 900)) {
      res.status(429).json({ error: 'Slow down a little — try again in a few minutes.' })
      return
    }
    if (body.kind === 'ask') {
      const may = await allow(tokenOf(req), 'asks')
      if (!may.ok) {
        res.status(may.transient ? 503 : 402).json({ error: may.message, plan: may.plan, limit: 'asks' })
        return
      }
    }
    // counted by the server as it is asked (a question, or the app's other AI work)
    const counted = meter(me.id, body.kind === 'ask' ? 'ask' : 'ai', 1)
    const out = await answer({
      system,
      messages,
      maxTokens,
      requireVision: Boolean(body.requireVision),
      fast: Boolean(body.fast),
      sink,
      keys: { anthropic: platformKeys('ANTHROPIC_API_KEY')[0] || '', groq: platformKeys('GROQ_API_KEY'), gemini: platformKeys('GEMINI_API_KEY') },
      dl
    })
    await counted
    deliver(out)
  } catch (err) {
    if (streaming || res.headersSent) {
      try {
        res.write(JSON.stringify({ error: 'The answer broke off. Ask again.' }) + '\n')
        res.end()
      } catch {
        /* gone */
      }
      return
    }
    failSafely(res, err, 'chat')
  }
}

// the words leave as they are written: Vercel must not hold the response
export const config = { supportsResponseStreaming: true }
