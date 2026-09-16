// An attendee's question, answered here on the server from the event's own
// row: the host's materials, the agenda, and every caption written so far.
//
// Until now every question waited for the host's app to notice it, think, and
// write the answer back — which meant nothing at all before the event, when
// the host was not even running the app, and long waits whenever the host's
// phone slept. The row has everything needed; the answer comes from here in
// a few seconds, before, during and after the event. The host's app still
// answers anything left pending, so nothing is lost when this route cannot.

const SUPA_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPA_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
// with the service key the answered question is written back for the host's
// report and for follow-ups; without it the answer still reaches the attendee
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const ID = /^[0-9a-zA-Z-]{6,64}$/

const formatTime = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

async function rest(path, init = {}) {
  const key = init.service && SUPA_SERVICE ? SUPA_SERVICE : SUPA_ANON
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    },
    signal: AbortSignal.timeout(8000)
  })
  return r
}

function systemPrompt({ ev, persona, lang, transcript, materials, hasWords }) {
  const preEvent = ev.status === 'waiting'
  const ended = ev.status === 'ended'
  const agenda = Array.isArray(ev.agenda) && ev.agenda.length ? ev.agenda.map((a) => `- ${a}`).join('\n') : ''
  return [
    preEvent
      ? 'You are Sitka, a personal AI companion for an audience member of an upcoming live event. The event has NOT started yet. Answer from what the host has shared (the materials and agenda below) and say clearly when something will only be known once the event begins.'
      : ended
        ? 'You are Sitka, a personal AI companion for an audience member of a live event that has now ended. You listened to it with them; the transcript is below, with whatever the host shared beforehand.'
        : 'You are Sitka, a personal AI companion for one audience member at a live event. You have been listening to the event with them; the transcript so far is below.',
    `The event is called "${ev.title || 'Live event'}".`,
    agenda ? `The host's agenda:\n${agenda}` : '',
    `This attendee describes themself as: "${persona || 'Curious attendee'}". Calibrate every answer to that perspective and knowledge level — the same talk means different things to different people.`,
    lang && lang.toLowerCase() !== 'english'
      ? `Respond ENTIRELY in ${lang}, even though the source material is in another language.`
      : '',
    'Rules:',
    '- Ground every answer in the provided material; if something was not covered, say so plainly instead of guessing.',
    !hasWords && materials
      ? '- Nothing has been transcribed from the event itself. When asked what the event is about, what was covered, or for a summary, answer from the materials the host shared: they are what the event is built on. Say that they are the host\'s materials.'
      : '',
    '- When asked what YOU think — an opinion, a critique, whether the speaker is right, what you would challenge — give a genuine, reasoned point of view drawing on your broader knowledge as well as the talk. Never say you cannot have an opinion; make clear what is your view and what the speaker said.',
    hasWords
      ? '- When you reference a specific moment of the talk, cite it inline with the exact format [[M:SS]] using a single timestamp that appears in the transcript (for example [[12:37]]). Plain ASCII double square brackets only. The app turns these into tappable links.'
      : '',
    '- Match the length of your answer to the question: short and direct by default; structure only for catch-ups and summaries.',
    '- Formatting: **bold** for key terms, "-" bullets for genuine lists, "## " headings only in long answers, tables only for comparisons. This renders on a phone — keep it tight.',
    '- The user is not a programmer. Never answer with programming code unless they explicitly ask for it.',
    '- Do not end answers with offers like "let me know if you want more" — just answer.',
    materials ? `\nEvent materials shared by the host:\n${materials.slice(0, 14000)}` : '',
    hasWords ? `\nTranscript so far:\n${transcript}` : preEvent ? '' : '\nTranscript so far: (nothing has been transcribed yet)',
    kind === 'catchup' ? '' : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function packPrompt({ lang, hasWords, materials }) {
  return [
    hasWords
      ? 'Create a take-home pack for an audience member from this event transcript.'
      : 'Create a take-home pack for an audience member of this event. Nothing was transcribed from the event itself, so build it from the materials the host shared, and say in the summary that it is drawn from the host\'s materials.',
    lang && lang.toLowerCase() !== 'english' ? `Write EVERYTHING in ${lang}.` : '',
    'Return ONLY JSON: {"summary": string, "takeaways": [string]} — summary is 3-5 sentences; takeaways are 4-7 short bullet points.',
    !hasWords && materials ? `\nMaterials shared by the host:\n${materials.slice(0, 14000)}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function extractJson(text) {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(text.slice(a, b + 1))
  } catch {
    return null
  }
}

/**
 * GET: one of the page's own rows, by its unguessable id. The rows are no
 * longer readable with the anonymous key, so the page asks here and the
 * server reads with its own key. ?ask=<id> · ?question=<id> · ?proxy=<attendeeId>
 */
async function readOwn(req, res) {
  const q = req.query || {}
  const pick = (v) => (typeof v === 'string' && ID.test(v) ? v : '')
  const ask = pick(q.ask)
  const question = pick(q.question)
  const proxy = pick(q.proxy)
  const attendee = pick(q.attendee)
  if (!ask && !question && !proxy && !attendee) {
    res.status(400).json({ error: 'bad-request' })
    return
  }
  res.setHeader('Cache-Control', 'no-store')
  const path = ask
    ? `asks?id=eq.${ask}&select=status,answer`
    : question
      ? `speaker_questions?id=eq.${question}&select=id,status,refined,answered_at_label,answer,text`
      : proxy
        ? `proxies?attendee_id=eq.${proxy}&select=status,brief`
        : `asks?attendee_id=eq.${attendee}&kind=eq.ask&status=eq.answered&select=kind,question,answer,status&order=created_at.asc`
  const r = await rest(path, { service: true })
  if (!r.ok) {
    res.status(502).json({ error: 'not-readable' })
    return
  }
  const rows = await r.json()
  if (attendee) {
    res.status(200).json({ rows: Array.isArray(rows) ? rows : [] })
    return
  }
  res.status(200).json({ row: Array.isArray(rows) && rows.length ? rows[0] : null })
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      if (!SUPA_URL || !(SUPA_SERVICE || SUPA_ANON)) {
        res.status(503).json({ error: 'not-configured' })
        return
      }
      await readOwn(req, res)
    } catch (err) {
      res.status(500).json({ error: String((err && err.message) || err) })
    }
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    if (!SUPA_URL || !SUPA_ANON) {
      res.status(503).json({ error: 'not-configured' })
      return
    }
    const body = req.body || {}
    const id = String(body.id || '')
    const eventId = String(body.eventId || '')
    const attendeeId = String(body.attendeeId || '')
    const kind = ['ask', 'catchup', 'pack'].includes(body.kind) ? body.kind : 'ask'
    const question = String(body.question || '').slice(0, 600)
    const persona = String(body.persona || '').slice(0, 200)
    const lang = String(body.lang || 'English').slice(0, 40)
    const history = Array.isArray(body.history) ? body.history.slice(-8) : []
    if (!ID.test(eventId) || !ID.test(attendeeId) || !ID.test(id)) {
      res.status(400).json({ error: 'bad-request' })
      return
    }
    if (kind === 'ask' && !question.trim()) {
      res.status(400).json({ error: 'empty' })
      return
    }

    // the event, and every word of it so far
    const evR = await rest(`events?id=eq.${encodeURIComponent(eventId)}&select=id,title,status,agenda,materials_text,materials_present,starts_at`)
    const evRows = evR.ok ? await evR.json() : []
    const ev = Array.isArray(evRows) && evRows.length ? evRows[0] : null
    if (!ev) {
      res.status(404).json({ error: 'not-found' })
      return
    }
    const segR = await rest(`segments?event_id=eq.${encodeURIComponent(eventId)}&select=idx,start_sec,text&order=idx.asc&limit=4000`)
    const segs = segR.ok ? await segR.json() : []
    const words = (Array.isArray(segs) ? segs : []).filter((s) => s && String(s.text || '').trim())
    const hasWords = words.length > 0
    // the freshest words matter most: a very long event is kept to its last ~60k characters
    let transcript = words.map((s) => `[${formatTime(s.start_sec)}] ${String(s.text).trim()}`).join('\n')
    if (transcript.length > 60000) transcript = '…\n' + transcript.slice(-60000)
    const materials = String(ev.materials_text || '')
    // a desktop host keeps its materials on its own machine: only that app
    // can answer well, so the question is left to it
    if (ev.materials_present && !materials && !hasWords) {
      res.status(200).json({ defer: true })
      return
    }

    let system
    let messages
    if (kind === 'pack') {
      system = packPrompt({ lang, hasWords, materials })
      messages = [{ role: 'user', content: hasWords ? transcript : 'Build the pack.' }]
    } else {
      const q =
        kind === 'catchup'
          ? 'Catch me up: in a few short bullets, what has happened so far? End with one line on what is being discussed right now.'
          : question
      system = systemPrompt({ ev, persona, lang, transcript, materials, hasWords })
      messages = [
        ...history
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) })),
        { role: 'user', content: q }
      ]
    }

    // the same chain of models this deployment answers everything with
    const host = req.headers['x-forwarded-host'] || req.headers.host
    const proto = req.headers['x-forwarded-proto'] || 'https'
    const r = await fetch(`${proto}://${host}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': String(req.headers['x-forwarded-for'] || '')
      },
      body: JSON.stringify({ system, messages, fast: kind === 'ask', maxTokens: kind === 'pack' ? 1400 : 1000 }),
      signal: AbortSignal.timeout(50000)
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || !j.text) {
      res.status(502).json({ error: j.error || 'Sitka could not answer right now.' })
      return
    }
    let answer = String(j.text)
    if (kind === 'pack') {
      const parsed = extractJson(answer)
      answer = JSON.stringify({
        summary: parsed?.summary ?? answer,
        takeaways: Array.isArray(parsed?.takeaways) ? parsed.takeaways.map(String) : [],
        moments: []
      })
    }

    // written back for the host's report and for follow-up questions
    if (SUPA_SERVICE) {
      await rest('asks?on_conflict=id', {
        method: 'POST',
        service: true,
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          id,
          event_id: eventId,
          attendee_id: attendeeId,
          kind,
          question,
          answer,
          status: 'answered',
          answered_at: new Date().toISOString()
        })
      }).catch(() => undefined)
    }
    res.status(200).json({ answer })
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) })
  }
}
