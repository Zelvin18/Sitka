// AI chat proxy: the host's browser sends its own provider keys per request.
// Nothing is stored server-side. Anthropic (Claude) preferred, Groq fallback.

let groqModelCache = { id: null, at: 0 }

async function pickGroqModel(key) {
  if (groqModelCache.id && Date.now() - groqModelCache.at < 600000) {
    return { id: groqModelCache.id }
  }
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}` }
    })
    const j = await r.json()
    if (!r.ok) {
      return { error: j.error?.message || `Groq rejected the key (HTTP ${r.status})` }
    }
    const ids = (j.data || [])
      .map((m) => m.id)
      .filter((id) => !/whisper|tts|guard|embed|moderation|vision-preview/i.test(id))
    const prefs = ['llama-3.3-70b', 'llama-4', 'llama3-70b', '70b', 'llama', 'qwen', 'deepseek']
    let pick = null
    for (const p of prefs) {
      pick = ids.find((id) => id.toLowerCase().includes(p))
      if (pick) break
    }
    pick = pick || ids[0] || null
    if (pick) {
      groqModelCache = { id: pick, at: Date.now() }
      return { id: pick }
    }
    return { error: 'Groq returned no usable chat models for this key.' }
  } catch (err) {
    // Network blip listing models — try a known model id directly.
    return { id: 'llama-3.3-70b-versatile' }
  }
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
          messages
        })
      })
      const j = await r.json()
      if (!r.ok) {
        res.status(502).json({ error: 'Anthropic: ' + (j.error?.message || `HTTP ${r.status}`) })
        return
      }
      res.status(200).json({
        text: (j.content || [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
      })
      return
    }

    if (groqKey) {
      const picked = await pickGroqModel(groqKey)
      if (picked.error) {
        res.status(502).json({ error: picked.error })
        return
      }
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${groqKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: picked.id,
          max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, ...messages]
        })
      })
      const j = await r.json()
      if (!r.ok) {
        groqModelCache = { id: null, at: 0 } // model may have been retired — rediscover next call
        res.status(502).json({ error: 'Groq: ' + (j.error?.message || `HTTP ${r.status}`) })
        return
      }
      res.status(200).json({ text: j.choices?.[0]?.message?.content || '' })
      return
    }

    res.status(400).json({ error: 'missing-key' })
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) })
  }
}
