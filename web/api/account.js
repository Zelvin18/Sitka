// Deleting an account.
//
// The person asks from the app, signed in. This route checks who they are,
// then removes everything that was theirs: the recordings in Cloudflare,
// the banners and public recordings in Supabase storage, every row they own
// (sessions, events and everything an event carries, organisations and
// everything in them, creations, practice projects, memory, chats), and at
// the end the account itself. Nothing is kept. Sessions other people filed
// in an organisation this person owned go back to those people untouched:
// only the organisation's filing is lost.

import { r2Config, r2Fetch, r2List } from './_r2.js'

const SUPA_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPA_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!SUPA_URL || !SUPA_ANON || !SUPA_SERVICE) return res.status(503).json({ error: 'not-configured' })

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  const user = token ? await userOf(token) : null
  if (!user) return res.status(401).json({ error: 'Sign in first.' })

  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      body = {}
    }
  }
  // the person types their email to confirm: the server checks it too
  const confirm = String((body && body.confirm) || '').trim().toLowerCase()
  if (!user.email || confirm !== user.email.toLowerCase()) {
    return res.status(400).json({ error: 'The email typed does not match this account.' })
  }

  const id = user.id
  const failures = []
  const step = async (name, fn) => {
    try {
      await fn()
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ---- the sessions' ids first: the banners are named after them ----
  const sessions = await rows(`sessions?owner=eq.${id}&select=id`)
  const sessionIds = sessions.map((s) => s.id)

  // ---- recordings in Cloudflare: everything under the person's folder ----
  await step('recordings', async () => {
    const cfg = r2Config()
    if (!cfg) return
    const objects = await r2List(cfg, `${id}/`)
    for (let i = 0; i < objects.length; i += 20) {
      await Promise.all(objects.slice(i, i + 20).map((o) => r2Fetch(cfg, 'DELETE', o.key).catch(() => undefined)))
    }
  })

  // ---- pictures and public copies in Supabase storage ----
  await step('banners', async () => {
    const keys = sessionIds.map((s) => `session-${s}-banner.jpg`)
    if (keys.length) await removeObjects('stage', keys)
  })
  await step('event pictures', async () => {
    const events = await rows(`events?owner=eq.${id}&select=id`)
    const keys = events.flatMap((e) => [`${e.id}-banner.jpg`, `${e.id}.jpg`])
    if (keys.length) await removeObjects('stage', keys)
    const replays = events.map((e) => `${e.id}.webm`)
    if (replays.length) await removeObjects('replays', replays)
  })
  await step('old recordings', async () => {
    // recordings kept in Supabase storage before the move to Cloudflare
    const list = await listObjects('recordings', `${id}`)
    if (list.length) await removeObjects('recordings', list)
  })

  // ---- rows: what the person owns, and their part in what others own ----
  const owned = ['recaps', 'memory_objects', 'creations', 'coach_projects', 'brain_chats', 'sessions', 'events', 'organizations']
  for (const table of owned) {
    await step(table, () => del(`${table}?owner=eq.${id}`))
  }
  await step('memberships', () => del(`org_members?user_id=eq.${id}`))
  await step('space chats', () => del(`space_chats?user_id=eq.${id}`))
  await step('usage', () => del(`usage_events?user_id=eq.${id}`))
  await step('errors', () => del(`client_errors?user_id=eq.${id}`))

  // ---- the account itself ----
  await step('account', async () => {
    const r = await fetch(`${SUPA_URL}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}` }
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  })

  if (failures.length) {
    console.error('account delete', id, failures)
    return res.status(207).json({ ok: false, failures })
  }
  return res.status(200).json({ ok: true })
}

// ---------- who is asking ----------

async function userOf(token) {
  try {
    const r = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPA_ANON }
    })
    if (!r.ok) return null
    const j = await r.json()
    return typeof j?.id === 'string' ? { id: j.id, email: typeof j.email === 'string' ? j.email : '' } : null
  } catch {
    return null
  }
}

// ---------- the database, with the service key ----------

const svc = { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}` }

async function rows(path) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, { headers: svc })
  if (!r.ok) return []
  const j = await r.json().catch(() => [])
  return Array.isArray(j) ? j : []
}

async function del(path) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, { method: 'DELETE', headers: { ...svc, Prefer: 'return=minimal' } })
  // a table this deployment never made is not a failure
  if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`)
}

// ---------- storage buckets ----------

async function listObjects(bucket, prefix) {
  const r = await fetch(`${SUPA_URL}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: { ...svc, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit: 1000, offset: 0 })
  })
  if (!r.ok) return []
  const j = await r.json().catch(() => [])
  return Array.isArray(j) ? j.map((o) => `${prefix}/${o.name}`) : []
}

async function removeObjects(bucket, keys) {
  for (let i = 0; i < keys.length; i += 100) {
    await fetch(`${SUPA_URL}/storage/v1/object/${bucket}`, {
      method: 'DELETE',
      headers: { ...svc, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: keys.slice(i, i + 100) })
    }).catch(() => undefined)
  }
}
