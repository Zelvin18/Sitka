// Deleting an account.
//
// The person asks from the app, signed in, and types their email to confirm.
// Everything that was theirs is removed, table by table and file by file,
// and every step is checked. The account itself goes last, and only when
// every step before it succeeded: a deletion that stops part way can be
// asked again, and finishes what is left.
//
// What is removed:
//   recordings in Cloudflare (everything under their folder, however many);
//   recordings, banners and replays in Supabase storage (folders walked);
//   every row they own: sessions, recaps, events (and everything an event
//   carries), organisations they own (and everything in them), creations,
//   practice projects, memory, chats;
//   their part in other people's things: memberships (with their name and
//   email), kept recaps, hidden courses, space chats, feedback, plan, admin
//   rights, usage and error reports;
//   their link to events they attended (the anonymous attendee row stays with
//   the event, unlinked from them);
//   their name on materials they added to someone else's course (the
//   material stays with the course, its author shown as a former member).
// Sessions other people filed in an organisation this person owned go back
// to those people untouched: only the organisation's filing is lost.

import { r2Config, r2Fetch, r2List } from './_r2.js'
import { SUPA_URL, SUPA_ANON, SUPA_SERVICE, requireUser, failSafely } from './_auth.js'
import { overLimitKey } from './_limit.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!SUPA_URL || !SUPA_ANON || !SUPA_SERVICE) return res.status(503).json({ error: 'not-configured' })

  const user = await requireUser(req, res)
  if (!user) return
  if (await overLimitKey(`account-delete:user:${user.id}`, 3, 10)) return res.status(429).json({ error: 'Slow down a little.' })

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

  try {
    const id = user.id
    const failures = []
    const step = async (name, fn) => {
      try {
        await fn()
      } catch (err) {
        failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // ---- the ids the storage is named after ----
    const sessionIds = (await rows(`sessions?owner=eq.${id}&select=id`)).map((s) => s.id)
    const eventIds = (await rows(`events?owner=eq.${id}&select=id`)).map((e) => e.id)

    // ---- recordings in Cloudflare: listed and deleted until the folder is empty ----
    await step('recordings', async () => {
      const cfg = r2Config()
      if (!cfg) return
      for (let round = 0; round < 60; round++) {
        const objects = await r2List(cfg, `${id}/`)
        if (objects.length === 0) return
        for (let i = 0; i < objects.length; i += 20) {
          await Promise.all(
            objects.slice(i, i + 20).map(async (o) => {
              const r = await r2Fetch(cfg, 'DELETE', o.key)
              if (!r.ok && r.status !== 404) throw new Error(`R2 delete ${r.status}`)
            })
          )
        }
      }
      throw new Error('the folder did not empty')
    })

    // ---- pictures, replays and older recordings in Supabase storage ----
    await step('banners', async () => {
      const keys = sessionIds.map((s) => `session-${s}-banner.jpg`)
      await removeObjects('stage', keys)
    })
    await step('event pictures', async () => {
      await removeObjects('stage', eventIds.flatMap((e) => [`${e}-banner.jpg`, `${e}.jpg`]))
      await removeObjects('replays', eventIds.map((e) => `${e}.webm`))
    })
    await step('older recordings', async () => {
      // recordings kept in Supabase storage before the move to Cloudflare:
      // <id>/<session>.webm and <id>/<session>/part-N.webm, walked folder by folder
      await removeObjects('recordings', await listAll('recordings', id))
    })

    // ---- their part in other people's things ----
    await step('memberships', () => del(`org_members?user_id=eq.${id}`))
    await step('course memberships', () => del(`space_members?user_id=eq.${id}`))
    await step('hidden courses', () => del(`space_hidden?user_id=eq.${id}`))
    await step('kept recaps', () => del(`saved_recaps?user_id=eq.${id}`))
    await step('space chats', () => del(`space_chats?user_id=eq.${id}`))
    await step('answer feedback', () => del(`answer_feedback?user_id=eq.${id}`))
    await step('plan', () => del(`plans?user_id=eq.${id}`))
    await step('admin rights', () => del(`admins?user_id=eq.${id}`))
    await step('attended events', () => patch(`attendees?user_id=eq.${id}`, { user_id: null, keep: false }))
    await step('added materials', () => patch(`org_materials?added_by=eq.${id}`, { added_by_name: 'Former member' }))

    // ---- what they own ----
    for (const table of ['recaps', 'memory_objects', 'creations', 'coach_projects', 'brain_chats', 'sessions', 'events', 'organizations']) {
      await step(table, () => del(`${table}?owner=eq.${id}`))
    }
    await step('usage', () => del(`usage_events?user_id=eq.${id}`))
    await step('errors', () => del(`client_errors?user_id=eq.${id}`))

    // ---- the account itself: last, and only when everything before it went ----
    if (failures.length) {
      console.error('account delete incomplete', id, failures)
      return res.status(207).json({ ok: false, failures, retry: true })
    }
    const r = await fetch(`${SUPA_URL}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}` },
      signal: AbortSignal.timeout(10000)
    })
    if (!r.ok) {
      console.error('account delete: the account itself', id, r.status)
      return res.status(207).json({ ok: false, failures: [`account: HTTP ${r.status}`], retry: true })
    }
    return res.status(200).json({ ok: true })
  } catch (err) {
    return failSafely(res, err, 'account')
  }
}

// ---------- the database, with the service key ----------

const svc = { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}` }

async function rows(path) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, { headers: svc, signal: AbortSignal.timeout(10000) })
  if (r.status === 404) return []
  if (!r.ok) throw new Error(`read ${path.split('?')[0]}: HTTP ${r.status}`)
  const j = await r.json().catch(() => [])
  return Array.isArray(j) ? j : []
}

/** A table this deployment never made (or a column it never added) is not a failure. */
const absent = async (r) => {
  if (r.status === 404) return true
  if (r.status !== 400) return false
  const t = await r.text().catch(() => '')
  return /does not exist|could not find|column/i.test(t)
}

async function del(path) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, { method: 'DELETE', headers: { ...svc, Prefer: 'return=minimal' }, signal: AbortSignal.timeout(15000) })
  if (!r.ok && !(await absent(r))) throw new Error(`HTTP ${r.status}`)
}

async function patch(path, values) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...svc, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(values),
    signal: AbortSignal.timeout(15000)
  })
  if (!r.ok && !(await absent(r))) throw new Error(`HTTP ${r.status}`)
}

// ---------- storage buckets ----------

/** Every object under a prefix in a Supabase bucket, folders walked, paged to the end. */
async function listAll(bucket, prefix) {
  const out = []
  const folders = [prefix]
  while (folders.length) {
    const folder = folders.shift()
    for (let offset = 0; ; offset += 1000) {
      const r = await fetch(`${SUPA_URL}/storage/v1/object/list/${bucket}`, {
        method: 'POST',
        headers: { ...svc, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: folder, limit: 1000, offset }),
        signal: AbortSignal.timeout(15000)
      })
      if (r.status === 400 || r.status === 404) return out // no such bucket here
      if (!r.ok) throw new Error(`list ${bucket}: HTTP ${r.status}`)
      const j = await r.json().catch(() => [])
      const items = Array.isArray(j) ? j : []
      for (const o of items) {
        // an entry without an id is a folder
        if (o.id) out.push(`${folder}/${o.name}`)
        else folders.push(`${folder}/${o.name}`)
      }
      if (items.length < 1000) break
    }
  }
  return out
}

async function removeObjects(bucket, keys) {
  for (let i = 0; i < keys.length; i += 100) {
    const r = await fetch(`${SUPA_URL}/storage/v1/object/${bucket}`, {
      method: 'DELETE',
      headers: { ...svc, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: keys.slice(i, i + 100) }),
      signal: AbortSignal.timeout(15000)
    })
    if (!r.ok && r.status !== 404 && r.status !== 400) throw new Error(`remove from ${bucket}: HTTP ${r.status}`)
  }
}
