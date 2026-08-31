// AI chat proxy: the host's browser sends its own provider keys per request.
// Nothing is stored server-side. Anthropic (Claude) preferred, Groq fallback.

let groqModelCache = { id: null, at: 0 }

async function pickGroqModel(key) {
  if (groqModelCache.id && Date.now() - groqModelCache.at < 600000) return groqModelCache.id
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}` }
    })
    const j = await r.json()
    const ids = (j.data || []).map((m) => m.id).filter((id) => !/whisper|tts|guard/i.test(id))
    const prefs = ['llama-3.3-70b', 'llama-4', 'llama3-70b', '70b', 'llama']
    let pick = null
    for (const p of prefs) {
      pick = ids.find((id) => id.includes(p))
      if (pick) break
    }
    groqModelCache = { id: pick || ids[0] || null, at: Date.now() }
  } catch {
    /* keep cache */
  }
  return groqModelCache.id
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const { keys = {}, system = '', messages = [], maxTokens = 1600 } = req.body || {}
    if (keys.anthropicApiKey) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': keys.anthropicApiKey,
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
        res.status(502).json({ error: j.error?.message || 'Anthropic error' })
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
    if (keys.groqApiKey) {
      const model = await pickGroqModel(keys.groqApiKey)
      if (!model) {
        res.status(502).json({ error: 'No Groq chat model available' })
        return
      }
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keys.groqApiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, ...messages]
        })
      })
      const j = await r.json()
      if (!r.ok) {
        res.status(502).json({ error: j.error?.message || 'Groq error' })
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
