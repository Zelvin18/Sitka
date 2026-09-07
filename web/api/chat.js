// AI chat proxy: the host's browser sends its own provider keys per request.
// Nothing is stored server-side. Anthropic (Claude) preferred, Groq fallback.
//
// Messages may carry images: a message's `content` is either a string or an
// array of parts {type:'text', text} | {type:'image', dataUrl}. Images go to
// Claude as-is; on Groq they need a vision model (Llama 4) and are dropped
// when the account has none.

let groqModelCache = { id: null, at: 0 }
let groqVisionCache = { id: null, at: 0 }

const isReasoningModel = (id) => /deepseek|qwq|qwen|r1|reason|think|gpt-oss/i.test(id)

// Reasoning models sometimes leak their private chain-of-thought — never show it.
function stripThinking(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*<think>[\s\S]*$/i, '')
    .trim()
}

async function listGroqModels(key) {
  const r = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${key}` }
  })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error?.message || `Groq rejected the key (HTTP ${r.status})`)
  return (j.data || []).map((m) => m.id)
}

async function pickGroqModel(key) {
  if (groqModelCache.id && Date.now() - groqModelCache.at < 600000) {
    return { id: groqModelCache.id }
  }
  try {
    const ids = (await listGroqModels(key)).filter(
      (id) => !/whisper|tts|guard|embed|moderation|vision-preview|safety/i.test(id)
    )
    // Plain instruction models first; reasoning models (which emit <think>
    // blocks) only as a last resort.
    const plain = ids.filter((id) => !isReasoningModel(id))
    const prefs = ['llama-3.3-70b', 'llama-4-maverick', 'llama-4', 'llama3-70b', '70b', 'llama', 'gpt-oss', 'mixtral', 'gemma']
    let pick = null
    for (const p of prefs) {
      pick = plain.find((id) => id.toLowerCase().includes(p))
      if (pick) break
    }
    pick = pick || plain[0] || ids[0] || null
    if (pick) {
      groqModelCache = { id: pick, at: Date.now() }
      return { id: pick }
    }
    return { error: 'Groq returned no usable chat models for this key.' }
  } catch (err) {
    if (/rejected the key/.test(String(err && err.message))) return { error: err.message }
    // Network blip listing models — try a known model id directly.
    return { id: 'llama-3.3-70b-versatile' }
  }
}

async function pickGroqVisionModel(key) {
  if (groqVisionCache.id && Date.now() - groqVisionCache.at < 600000) return groqVisionCache.id
  try {
    const ids = await listGroqModels(key)
    const pick =
      ids.find((id) => /llama-4-maverick/i.test(id)) ||
      ids.find((id) => /llama-4-scout/i.test(id)) ||
      ids.find((id) => /llama-4|vision/i.test(id) && !/preview/i.test(id)) ||
      null
    if (pick) groqVisionCache = { id: pick, at: Date.now() }
    return pick
  } catch {
    return null
  }
}

const hasImages = (messages) =>
  messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image'))

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
      return {
        role: m.role,
        content: m.content
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('\n')
      }
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const { keys = {}, system = '', messages = [], maxTokens = 1600 } = req.body || {}
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
    // Users' own keys win; otherwise the deployment's platform keys serve them.
    const anthropicKey = clean(keys.anthropicApiKey) || clean(process.env.ANTHROPIC_API_KEY)
    const groqKey = clean(keys.groqApiKey) || clean(process.env.GROQ_API_KEY)
    const withImages = hasImages(messages)

    // Only treat the Anthropic field as real when it looks like an Anthropic
    // key — otherwise stray text there would block the working Groq path.
    if (anthropicKey.startsWith('sk-')) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
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
      const j = await r.json()
      if (!r.ok) {
        res.status(502).json({ error: 'Anthropic: ' + (j.error?.message || `HTTP ${r.status}`) })
        return
      }
      res.status(200).json({
        text: stripThinking(
          (j.content || [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
        ),
        vision: withImages
      })
      return
    }

    if (groqKey) {
      let modelId = null
      if (withImages) modelId = await pickGroqVisionModel(groqKey)
      const sawImages = Boolean(modelId)
      if (!modelId) {
        const picked = await pickGroqModel(groqKey)
        if (picked.error) {
          res.status(502).json({ error: picked.error })
          return
        }
        modelId = picked.id
      }
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${groqKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, ...toGroq(messages, sawImages)],
          // reasoning models: keep the thinking out of the answer
          ...(isReasoningModel(modelId) ? { reasoning_format: 'hidden' } : {})
        })
      })
      const j = await r.json()
      if (!r.ok) {
        groqModelCache = { id: null, at: 0 } // model may have been retired — rediscover next call
        groqVisionCache = { id: null, at: 0 }
        res.status(502).json({ error: 'Groq: ' + (j.error?.message || `HTTP ${r.status}`) })
        return
      }
      res.status(200).json({
        text: stripThinking(j.choices?.[0]?.message?.content || ''),
        vision: sawImages
      })
      return
    }

    res.status(400).json({ error: 'missing-key' })
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) })
  }
}
