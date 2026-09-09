// AI chat proxy: the host's browser sends its own provider keys per request.
// Nothing is stored server-side. Anthropic (Claude) preferred, Groq fallback.
//
// Messages may carry images: a message's `content` is either a string or an
// array of parts {type:'text', text} | {type:'image', dataUrl}. Images go to
// Claude as-is; on Groq they need a vision model. The response says whether
// the images were actually seen (`vision`), so callers never mistake a guess
// for a reading of the screen.
//
// Reliability: every request has a chain of fallbacks — Anthropic, then each
// Groq key (a user's own key first, then the platform's GROQ_API_KEY and any
// GROQ_API_KEYS / GROQ_API_KEY_2..9 backups), then each candidate model. A model
// that answers with "decommissioned", "requires terms acceptance", or "not
// found" is remembered as dead for a while and skipped.

const NON_CHAT_RE =
  /whisper|tts|orpheus|canopylabs|playai|guard|embed|moderation|safety|allam|saudi|arabic|transcri|-stt|rerank/i
const REASONING_RE = /deepseek|qwq|qwen|r1|reason|think|gpt-oss/i
const VISION_RE = /llama-4|scout|maverick|vision|-vl|vl-|pixtral|llava|gemma-3|gemma3|multimodal|omni/i

// Known-good ids, in order of preference. Used to rank what the account
// actually lists, and tried directly when the list cannot be fetched.
const KNOWN_CHAT = [
  'moonshotai/kimi-k2-instruct-0905',
  'moonshotai/kimi-k2-instruct',
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'openai/gpt-oss-120b',
  'qwen/qwen3-32b',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
  'groq/compound',
  'groq/compound-mini'
]
const KNOWN_VISION = [
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'meta-llama/llama-4-scout-17b-16e-instruct'
]

const listCache = new Map() // key tail -> { ids, at }
const deadModels = new Map() // model id -> until (ms)
const DEAD_MS = 30 * 60 * 1000

const isDead = (id) => (deadModels.get(id) || 0) > Date.now()
const markDead = (id) => deadModels.set(id, Date.now() + DEAD_MS)

// Reasoning models sometimes leak their private chain-of-thought — never show it.
function stripThinking(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*<think>[\s\S]*$/i, '')
    .trim()
}

const sizeOf = (id) => {
  const m = String(id).match(/(\d{1,3})b\b/i)
  return m ? Number(m[1]) : 0
}

async function listGroqModels(key) {
  const tail = key.slice(-8)
  const hit = listCache.get(tail)
  if (hit && Date.now() - hit.at < 600000) return hit.ids
  const r = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${key}` }
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    const err = new Error(j.error?.message || `Groq rejected the key (HTTP ${r.status})`)
    err.status = r.status
    throw err
  }
  const ids = (j.data || []).map((m) => m.id).filter(Boolean)
  listCache.set(tail, { ids, at: Date.now() })
  return ids
}

/** Chat-capable models for this key, best first. Never a speech or guard model. */
async function chatCandidates(key) {
  let ids
  try {
    ids = await listGroqModels(key)
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw err
    return KNOWN_CHAT.slice(0, 5)
  }
  const usable = ids.filter((id) => !NON_CHAT_RE.test(id))
  const known = KNOWN_CHAT.filter((id) => usable.includes(id))
  const rest = usable.filter((id) => !known.includes(id))
  const plain = rest.filter((id) => !REASONING_RE.test(id)).sort((a, b) => sizeOf(b) - sizeOf(a))
  const reasoning = rest.filter((id) => REASONING_RE.test(id)).sort((a, b) => sizeOf(b) - sizeOf(a))
  return [...known, ...plain, ...reasoning].slice(0, 6)
}

/** Vision-capable models for this key, best first; [] when the account has none. */
async function visionCandidates(key) {
  let ids
  try {
    ids = await listGroqModels(key)
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw err
    return KNOWN_VISION
  }
  const usable = ids.filter((id) => !NON_CHAT_RE.test(id))
  const known = KNOWN_VISION.filter((id) => usable.includes(id))
  const rest = usable.filter((id) => !known.includes(id) && VISION_RE.test(id))
  return [...known, ...rest].slice(0, 4)
}

const hasImages = (messages) =>
  messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image'))

const NO_VISION_NOTE =
  '[The screen image attached here could not be read: no vision-capable model is available right now. Say plainly that you cannot see the screen at the moment and answer from the transcript only. Never guess what is on screen.]'

function toAnthropic(messages) {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return { role: m.role, content: String(m.content ?? '') }
    const parts = m.content.map((p) => {
      if (p.type === 'image') {
        const mm = String(p.dataUrl || '').match(/^data:(image\/[\w+.-]+);base64,(.+)$/)
        if (!mm) return null
        return { type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } }
      }
      return { type: 'text', text: String(p.text ?? '') }
    })
    return { role: m.role, content: parts.filter(Boolean) }
  })
}

function toGroq(messages, keepImages) {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return { role: m.role, content: String(m.content ?? '') }
    if (!keepImages) {
      const hadImage = m.content.some((p) => p.type === 'image')
      const text = m.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
      return { role: m.role, content: hadImage ? `${NO_VISION_NOTE}\n\n${text}` : text }
    }
    return {
      role: m.role,
      content: m.content.map((p) =>
        p.type === 'image'
          ? { type: 'image_url', image_url: { url: p.dataUrl } }
          : { type: 'text', text: String(p.text ?? '') }
      )
    }
  })
}

// Best-effort per-IP limiter for platform-funded (keyless) requests.
const ipLog = new Map()
function overLimit(ip) {
  const now = Date.now()
  const hits = (ipLog.get(ip) || []).filter((t) => now - t < 3600000)
  hits.push(now)
  ipLog.set(ip, hits)
  if (ipLog.size > 5000) ipLog.clear()
  return hits.length > 60
}

const MODEL_ERROR_RE = /model|decommission|terms|not found|does not exist|not support|deprecated|unavailable/i

/** One Groq call. Returns {text} or {error, kind: 'model'|'key'|'transient'|'request'}. */
async function groqOnce(key, modelId, system, messages, maxTokens, keepImages) {
  let r
  try {
    r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, ...toGroq(messages, keepImages)],
        ...(REASONING_RE.test(modelId) ? { reasoning_format: 'hidden' } : {})
      })
    })
  } catch (err) {
    return { error: String((err && err.message) || err), kind: 'transient' }
  }
  const j = await r.json().catch(() => ({}))
  if (r.ok) {
    const text = stripThinking(j.choices?.[0]?.message?.content || '')
    if (!text) return { error: 'empty answer', kind: 'transient' }
    return { text }
  }
  const msg = j.error?.message || `HTTP ${r.status}`
  if (r.status === 401 || r.status === 403) return { error: msg, kind: 'key' }
  if (r.status === 429) {
    // Limits are per account: rest this key for as long as Groq asks
    // (retry-after header, or "try again in 2m3.5s" in the message).
    let wait = Number(r.headers.get('retry-after')) || 0
    if (!wait) {
      const mm = msg.match(/try again in (?:(\d+)m)?([\d.]+)s/i)
      if (mm) wait = Number(mm[1] || 0) * 60 + Number(mm[2] || 0)
    }
    return { error: msg, kind: 'ratelimit', wait: Math.min(Math.max(wait, 20), 3600) }
  }
  if (r.status >= 500) return { error: msg, kind: 'transient' }
  if (r.status === 404 || MODEL_ERROR_RE.test(msg)) return { error: msg, kind: 'model' }
  return { error: msg, kind: 'request' }
}

// Keys that were rate limited rest until this time, so the next request
// goes straight to a key that can answer instead of asking Groq again.
const keyRest = new Map() // key tail -> until (ms)
let roundRobin = 0

/**
 * Order keys for this request: a user's own key first, then the platform's
 * keys in rotation so every account carries a share of the load. Keys that
 * are resting after a rate limit go last.
 */
function orderKeys(keys, ownKey) {
  const now = Date.now()
  const platform = keys.filter((k) => k !== ownKey)
  const start = platform.length ? roundRobin++ % platform.length : 0
  const rotated = [...platform.slice(start), ...platform.slice(0, start)]
  const ready = rotated.filter((k) => (keyRest.get(k.slice(-8)) || 0) <= now)
  const resting = rotated
    .filter((k) => (keyRest.get(k.slice(-8)) || 0) > now)
    .sort((a, b) => keyRest.get(a.slice(-8)) - keyRest.get(b.slice(-8)))
  return [...(ownKey ? [ownKey] : []), ...ready, ...resting]
}

/**
 * Try every key and every candidate model until one answers. Vision requests
 * try the vision models first; if none can answer the images are dropped
 * (with a note so the model does not invent what it cannot see).
 */
async function groqChain(keys, system, messages, maxTokens, withImages, requireVision) {
  let lastError = 'no Groq key'
  let keyErrors = 0
  for (const key of keys) {
    let plan
    try {
      const vis = withImages ? (await visionCandidates(key)).filter((id) => !isDead(id)) : []
      if (requireVision) {
        if (vis.length === 0) {
          lastError = 'no vision model'
          continue
        }
        plan = vis.map((id) => ({ id, keepImages: true }))
      } else {
        const chat = (await chatCandidates(key)).filter((id) => !isDead(id))
        plan = [...vis.map((id) => ({ id, keepImages: true })), ...chat.map((id) => ({ id, keepImages: false }))]
      }
    } catch (err) {
      lastError = String((err && err.message) || err)
      keyErrors++
      continue
    }
    if (plan.length === 0) {
      lastError = 'This Groq key lists no usable chat models.'
      continue
    }
    let transientOnThisKey = 0
    for (const step of plan) {
      const out = await groqOnce(key, step.id, system, messages, maxTokens, step.keepImages)
      if (out.text) return { text: out.text, vision: step.keepImages, model: step.id }
      lastError = `${step.id}: ${out.error}`
      if (out.kind === 'key') {
        keyErrors++
        break
      }
      if (out.kind === 'model') markDead(step.id)
      if (out.kind === 'ratelimit') {
        keyRest.set(key.slice(-8), Date.now() + out.wait * 1000)
        break // this account is out of quota for now: the next key takes over
      }
      if (out.kind === 'transient' && ++transientOnThisKey >= 2) break
    }
  }
  return { error: lastError, keyErrors }
}

// ---- Gemini: the strongest free sight. Used first for anything with an
// image (after Claude), and as one more text fallback after Groq. ----
const KNOWN_GEMINI = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-flash-latest']
let geminiListCache = { ids: null, at: 0 }

async function geminiCandidates(key) {
  if (geminiListCache.ids && Date.now() - geminiListCache.at < 600000) return geminiListCache.ids
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${key}`)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return KNOWN_GEMINI
    const ids = (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((id) => /^gemini-[\d.]+-flash(-lite)?$/.test(id))
      .sort((a, b) => parseFloat(b.split('-')[1]) - parseFloat(a.split('-')[1]) || a.length - b.length)
    const ranked = [...KNOWN_GEMINI.filter((id) => ids.includes(id)), ...ids.filter((id) => !KNOWN_GEMINI.includes(id))]
    geminiListCache = { ids: ranked.length ? ranked : KNOWN_GEMINI, at: Date.now() }
    return geminiListCache.ids
  } catch {
    return KNOWN_GEMINI
  }
}

function toGemini(messages) {
  return messages.map((m) => {
    const role = m.role === 'assistant' ? 'model' : 'user'
    if (!Array.isArray(m.content)) return { role, parts: [{ text: String(m.content ?? '') }] }
    const parts = m.content
      .map((p) => {
        if (p.type === 'image') {
          const mm = String(p.dataUrl || '').match(/^data:(image\/[\w+.-]+);base64,(.+)$/)
          return mm ? { inlineData: { mimeType: mm[1], data: mm[2] } } : null
        }
        return { text: String(p.text ?? '') }
      })
      .filter(Boolean)
    return { role, parts }
  })
}

async function geminiChain(key, system, messages, maxTokens) {
  let lastError = 'no Gemini model'
  for (const model of (await geminiCandidates(key)).filter((id) => !isDead('gemini:' + id))) {
    let r
    try {
      r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: toGemini(messages),
            generationConfig: { maxOutputTokens: maxTokens }
          })
        }
      )
    } catch (err) {
      lastError = String((err && err.message) || err)
      continue
    }
    const j = await r.json().catch(() => ({}))
    if (r.ok) {
      const text = stripThinking(
        ((j.candidates || [])[0]?.content?.parts || []).map((p) => p.text || '').join('')
      )
      if (text) return { text, model }
      lastError = `${model}: empty answer`
      continue
    }
    const msg = j.error?.message || `HTTP ${r.status}`
    lastError = `${model}: ${msg}`
    if (r.status === 400 && /API key/i.test(msg)) break
    if (r.status === 404 || /not found|not supported|deprecated/i.test(msg)) markDead('gemini:' + model)
    // 429: the free quota is counted per model, so the next model may still answer
  }
  return { error: lastError }
}

async function anthropicOnce(key, system, messages, maxTokens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: maxTokens,
      system,
      messages: toAnthropic(messages)
    })
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.error?.message || `HTTP ${r.status}` }
  const text = stripThinking(
    (j.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
  )
  return text ? { text } : { error: 'empty answer' }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const { keys = {}, system = '', messages = [], maxTokens = 1600, requireVision = false } = req.body || {}
    const usingOwnKeys = Boolean(keys.anthropicApiKey || keys.groqApiKey)
    if (!usingOwnKeys) {
      const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim()
      if (overLimit(ip)) {
        res.status(429).json({ error: 'Slow down a little — try again in a few minutes.' })
        return
      }
    }
    // API keys are ASCII; strip anything else (smart dashes, stray words,
    // invisible characters from copy-paste) so headers can never crash.
    const clean = (s) => String(s || '').replace(/[^\x21-\x7e]/g, '')
    const anthropicKey = clean(keys.anthropicApiKey) || clean(process.env.ANTHROPIC_API_KEY)
    const ownGroqKey = clean(keys.groqApiKey)
    const groqKeys = orderKeys(
      [
        ownGroqKey,
        clean(process.env.GROQ_API_KEY),
        ...String(process.env.GROQ_API_KEYS || '')
          .split(/[,\s]+/)
          .map(clean),
        ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => clean(process.env[`GROQ_API_KEY_${n}`]))
      ].filter((k, i, all) => k && k.length > 10 && all.indexOf(k) === i),
      ownGroqKey.length > 10 ? ownGroqKey : ''
    )
    const geminiKey = clean(keys.geminiApiKey) || clean(process.env.GEMINI_API_KEY)
    const withImages = hasImages(messages)
    const errors = []

    // Only treat the Anthropic field as real when it looks like an Anthropic
    // key — otherwise stray text there would block the working Groq path.
    if (anthropicKey.startsWith('sk-')) {
      const out = await anthropicOnce(anthropicKey, system, messages, maxTokens)
      if (out.text) {
        res.status(200).json({ text: out.text, vision: withImages, model: 'claude' })
        return
      }
      errors.push('Anthropic: ' + out.error)
    }

    // Anything with an image goes to Gemini before Groq: it reads boards,
    // slides and charts far more reliably than the vision models Groq hosts.
    if (geminiKey && withImages) {
      const out = await geminiChain(geminiKey, system, messages, maxTokens)
      if (out.text) {
        res.status(200).json({ text: out.text, vision: true, model: out.model })
        return
      }
      errors.push('Gemini: ' + out.error)
    }

    if (groqKeys.length > 0) {
      const out = await groqChain(groqKeys, system, messages, maxTokens, withImages, requireVision)
      if (out.text) {
        res.status(200).json({ text: out.text, vision: out.vision, model: out.model })
        return
      }
      errors.push('Groq: ' + out.error)
      if (out.keyErrors >= groqKeys.length && errors.length === 1 && !geminiKey) {
        res.status(502).json({ error: 'Groq: ' + out.error })
        return
      }
    }

    // Text-only requests: Gemini is the last resort when every Groq account is busy.
    if (geminiKey && !withImages) {
      const out = await geminiChain(geminiKey, system, messages, maxTokens)
      if (out.text) {
        res.status(200).json({ text: out.text, vision: false, model: out.model })
        return
      }
      errors.push('Gemini: ' + out.error)
    }

    if (requireVision) {
      // No model could see the image: report that honestly instead of failing.
      res.status(200).json({ text: '', vision: false })
      return
    }

    if (errors.length === 0) {
      res.status(400).json({ error: 'missing-key' })
      return
    }
    res.status(502).json({
      error: `Sitka's AI is busy right now — it will try again automatically. (${errors[errors.length - 1]})`,
      transient: true
    })
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) })
  }
}
