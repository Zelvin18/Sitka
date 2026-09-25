// The AI chain every route answers with: Anthropic (Claude) when a key is
// there, Gemini first for anything with an image, then every Groq key and
// model, then Gemini as the last text fallback. A model that is gone is
// remembered as dead for a while; a rate-limited account rests.
//
// Nothing here decides who may use it or whose keys pay: the routes do that
// (chat.js for the app and the recap page, ask.js for event attendees), and
// hand in exactly the keys that may be used. A caller's own key is never
// mixed with the platform's.
//
// Messages may carry images: a message's `content` is a string or an array of
// parts {type:'text', text} | {type:'image', dataUrl}.
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
/**
 * Reads a provider's server-sent events and hands each piece of text to
 * `sink` as it arrives. `pick` turns one parsed event into text ('' when the
 * event carries none). Returns the whole text once the stream ends.
 */
async function drainSse(body, pick, sink) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      let ev
      try {
        ev = JSON.parse(data)
      } catch {
        continue
      }
      const piece = pick(ev)
      if (piece) {
        text += piece
        sink(piece)
      }
    }
  }
  return text
}

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
    signal: AbortSignal.timeout(12000),
    headers: { Authorization: `Bearer ${key}` }
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    throw Object.assign(new Error(j.error?.message || `Groq rejected the key (HTTP ${r.status})`), { status: r.status })
  }
  const ids = (j.data || []).map((m) => m.id).filter(Boolean)
  listCache.set(tail, { ids, at: Date.now() })
  return ids
}

// For a quick reply — a greeting, a short question over a recap — the small
// fast models go first; they answer in a second where the biggest take ten.
const FAST_FIRST = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b']

/** Chat-capable models for this key, best first. Never a speech or guard model. */
async function chatCandidates(key, fast = false) {
  const order = fast ? [...FAST_FIRST, ...KNOWN_CHAT.filter((id) => !FAST_FIRST.includes(id))] : KNOWN_CHAT
  // A quick answer should not wait on a catalogue. When the list is not
  // already to hand, the known-good fast models are tried straight away; a
  // model that has gone is caught by the chain, which then asks properly.
  if (fast && !listCache.has(key.slice(-8))) {
    void listGroqModels(key).catch(() => undefined) // warmed for next time
    return order.slice(0, 4)
  }
  let ids
  try {
    ids = await listGroqModels(key)
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw err
    return order.slice(0, 5)
  }
  const usable = ids.filter((id) => !NON_CHAT_RE.test(id))
  const known = order.filter((id) => usable.includes(id))
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

const MODEL_ERROR_RE = /model|decommission|terms|not found|does not exist|not support|deprecated|unavailable/i

/** One Groq call. Returns {text} or {error, kind: 'model'|'key'|'transient'|'request'}. */
async function groqOnce(key, modelId, system, messages, maxTokens, keepImages, sink, dl) {
  let r
  try {
    r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      signal: dl ? dl.signal(45000) : AbortSignal.timeout(45000),
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, ...toGroq(messages, keepImages)],
        ...(REASONING_RE.test(modelId) ? { reasoning_format: 'hidden' } : {}),
        ...(sink ? { stream: true } : {})
      })
    })
  } catch (err) {
    return { error: String((err && err.message) || err), kind: 'transient' }
  }
  if (r.ok && sink && r.body) {
    // the words go out as they come; a stream that breaks after it began
    // still counts for what was said
    let text = ''
    try {
      text = await drainSse(r.body, (ev) => ev.choices?.[0]?.delta?.content || '', sink)
    } catch (err) {
      if (!text) return { error: String((err && err.message) || err), kind: 'transient' }
    }
    text = stripThinking(text)
    if (!text) return { error: 'empty answer', kind: 'transient' }
    return { text }
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
async function groqChain(keys, system, messages, maxTokens, withImages, requireVision, fast = false, sink = null, dl = null) {
  let lastError = 'no Groq key'
  let keyErrors = 0
  for (const key of keys) {
    // nothing new is started that could not finish inside the request
    if (dl && dl.left() < 4000) {
      lastError = 'out of time'
      break
    }
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
        const chat = (await chatCandidates(key, fast)).filter((id) => !isDead(id))
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
      if (dl && dl.left() < 4000) break
      const out = await groqOnce(key, step.id, system, messages, maxTokens, step.keepImages, sink, dl)
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
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${key}`, { signal: AbortSignal.timeout(12000) })
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

/**
 * Every Gemini key (each a separate Google account, so a separate free
 * quota), then every model on it. A key that is out of quota rests for as
 * long as Google asks and the next key takes over.
 */
async function geminiChain(keys, system, messages, maxTokens, dl = null) {
  let lastError = 'no Gemini key'
  for (const key of keys) {
    let limited = 0
    for (const model of (await geminiCandidates(key)).filter((id) => !isDead('gemini:' + id))) {
      if (dl && dl.left() < 4000) return { error: 'out of time' }
      let r
      try {
        r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            signal: dl ? dl.signal(45000) : AbortSignal.timeout(45000),
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: toGemini(messages),
              generationConfig: {
              maxOutputTokens: maxTokens,
              // 2.5 models "think" before answering by default, which adds
              // seconds to every screen question; a lecture needs answers now.
              ...(/-2\.5-/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {})
            }
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
      if ((r.status === 400 || r.status === 403) && /API key|permission|denied/i.test(msg)) break // bad key: next one
      if (r.status === 404 || /not found|not supported|deprecated/i.test(msg)) markDead('gemini:' + model)
      if (r.status === 429) {
        // Quota is per model per account: try the next model once, then rest the key.
        const mm = msg.match(/retry in ([\d.]+)s/i)
        const wait = mm ? Number(mm[1]) : 60
        if (++limited >= 2) {
          keyRest.set(key.slice(-8), Date.now() + Math.min(Math.max(wait, 20), 3600) * 1000)
          break
        }
      }
    }
  }
  return { error: lastError }
}

async function anthropicOnce(key, system, messages, maxTokens, sink, dl = null, model = 'claude-opus-5') {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    signal: dl ? dl.signal(50000) : AbortSignal.timeout(50000),
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: toAnthropic(messages),
      ...(sink ? { stream: true } : {})
    })
  })
  if (r.ok && sink && r.body) {
    let text = ''
    try {
      text = await drainSse(r.body, (ev) => (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' ? ev.delta.text : ''), sink)
    } catch (err) {
      if (!text) return { error: String((err && err.message) || err) }
    }
    text = stripThinking(text)
    return text ? { text } : { error: 'empty answer' }
  }
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

const clean = (s) => String(s || '').replace(/[^\x21-\x7e]/g, '')

/** Every platform key for a provider: NAME, NAMES (comma separated), NAME_2..9. */
export function platformKeys(name) {
  return [
    clean(process.env[name]),
    ...String(process.env[name + 'S'] || '')
      .split(/[,\s]+/)
      .map(clean),
    ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => clean(process.env[`${name}_${n}`]))
  ].filter((k, i, all) => k && k.length > 10 && all.indexOf(k) === i)
}

/**
 * One answer from the chain, with exactly the keys given:
 *   keys: { anthropic: string, groq: string[], gemini: string[] }
 *   own:  the caller's own Groq key, tried first when there is one
 * Returns { text, vision, model } or { error, transient, keyErrors, missing }.
 * `sink(piece)` receives words as they are written, when the provider streams.
 */
export async function answer({ system, messages, maxTokens, requireVision = false, fast = false, sink = null, keys, ownGroq = '', dl = null, anthropicModel = 'claude-opus-5' }) {
  const withImages = hasImages(messages)
  const errors = []
  let streamedAny = false
  const tap = sink
    ? (piece) => {
        streamedAny = true
        sink(piece)
      }
    : null
  const anthropicKey = clean(keys.anthropic)
  if (anthropicKey.startsWith('sk-')) {
    const out = await anthropicOnce(anthropicKey, system, messages, maxTokens, tap, dl, anthropicModel).catch((err) => ({
      text: '',
      error: String((err && err.message) || err)
    }))
    if (out.text) return { text: out.text, vision: withImages, model: 'claude' }
    if (streamedAny) return { error: 'The answer broke off. Ask again.', transient: true }
    errors.push('Anthropic: ' + out.error)
  }
  const gemini = keys.gemini || []
  if (gemini.length && withImages) {
    const out = await geminiChain(gemini, system, messages, maxTokens, dl)
    if (out.text) return { text: out.text, vision: true, model: out.model }
    errors.push('Gemini: ' + out.error)
  }
  const groq = orderKeys(keys.groq || [], ownGroq)
  if (groq.length) {
    const out = await groqChain(groq, system, messages, maxTokens, withImages, requireVision, Boolean(fast), tap, dl)
    if (out.text) return { text: out.text, vision: out.vision, model: out.model }
    if (streamedAny) return { error: 'The answer broke off. Ask again.', transient: true }
    errors.push('Groq: ' + out.error)
    if (out.keyErrors >= groq.length && errors.length === 1 && !gemini.length) return { error: 'Groq: ' + out.error, keyErrors: out.keyErrors }
  }
  if (gemini.length && !withImages) {
    const out = await geminiChain(gemini, system, messages, maxTokens, dl)
    if (out.text) return { text: out.text, vision: false, model: out.model }
    errors.push('Gemini: ' + out.error)
  }
  if (requireVision) return { text: '', vision: false }
  if (errors.length === 0) return { error: 'missing-key', missing: true }
  return { error: errors[errors.length - 1], transient: true }
}

export { hasImages }
