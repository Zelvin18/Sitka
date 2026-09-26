// Fakes for everything the API routes talk to: the account service and the
// database (Supabase), the recording store (Cloudflare R2), and the AI and
// voice providers. The routes run unchanged against them; each test sets up
// what it needs and reads back what the routes did.

export const SUPA = 'https://db.test'
export const R2_ACCOUNT = 'acct0000000000000000000000000000'
export const R2_HOST = `${R2_ACCOUNT}.r2.cloudflarestorage.com`
export const PLATFORM = {
  groq: 'gsk_platform_000000000000000000000000000000',
  anthropic: 'sk-ant-platform-0000000000000000000000000000',
  gemini: 'AIza-platform-00000000000000000000000000',
  openai: 'sk-openai-platform-000000000000000000000000',
  deepgram: 'dg_platform_00000000000000000000000000000'
}

export function setEnv() {
  Object.assign(process.env, {
    SUPABASE_URL: SUPA,
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_KEY: 'service-key',
    R2_ACCOUNT_ID: R2_ACCOUNT,
    R2_ACCESS_KEY_ID: 'r2-access',
    R2_SECRET_ACCESS_KEY: 'r2-secret-for-tests',
    R2_BUCKET: 'sitka',
    GROQ_API_KEY: PLATFORM.groq,
    ANTHROPIC_API_KEY: PLATFORM.anthropic,
    GEMINI_API_KEY: PLATFORM.gemini,
    OPENAI_API_KEY: PLATFORM.openai,
    DEEPGRAM_API_KEY: PLATFORM.deepgram,
    RESEND_API_KEY: 're_test',
    ADMIN_EMAIL: 'owner@example.com',
    SITE_ORIGIN: 'https://sitcaai.vercel.app'
  })
}

export const USERS = {
  a: { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'a@example.com', token: 'token-a' },
  b: { id: 'bbbbbbbb-0000-4000-8000-000000000002', email: 'b@example.com', token: 'token-b' },
  m: { id: 'cccccccc-0000-4000-8000-000000000003', email: 'member@example.com', token: 'token-m' },
  // an account only the "plan cannot be read" storage test uses (the server keeps plans a short while)
  n: { id: 'dddddddd-0000-4000-8000-000000000004', email: 'new@example.com', token: 'token-n' }
}

/** A fresh world: tables, storage, and a log of every outside call. */
export function world() {
  return {
    authDown: false,
    tables: {
      usage_meter: [],
      deleted_sessions: [],
      sessions: [],
      recaps: [],
      events: [],
      attendees: [],
      asks: [],
      segments: [],
      speaker_questions: [],
      proxies: [],
      client_errors: [],
      org_members: [],
      space_members: [],
      space_hidden: [],
      saved_recaps: [],
      space_chats: [],
      answer_feedback: [],
      plans: [],
      admins: [],
      org_materials: [],
      memory_objects: [],
      creations: [],
      coach_projects: [],
      brain_chats: [],
      organizations: [],
      usage_events: []
    },
    /** tables whose deletes fail, to test that a failure stops the account going */
    failDelete: new Set(),
    /** database functions this "deployment" has (a missing one answers 404, as PostgREST does) */
    functions: new Set(['sitka_recap', 'sitka_shared_owner', 'my_usage', 'sitka_rate_hit', 'sitka_can_watch', 'is_admin', 'sitka_meter']),
    /** the plan lookup fails (the database is unreachable for it) */
    usageDown: false,
    /** what the server counted: { user, kind, amount } */
    meter: [],
    usage: {}, // user id -> { plan, asks, hours }
    courseMembers: new Map(), // session id -> Set(user id)
    admins: new Set(),
    rate: new Map(),
    r2: new Map(), // key -> Buffer
    authDeleted: [],
    calls: [], // { host, path, method, headers, body }
    ai: { groq: [], anthropic: [], gemini: [], openai: [], deepgram: [], resend: [] },
    evil: []
  }
}

// ---------- a very small PostgREST ----------

function parseQuery(qs) {
  const params = new URLSearchParams(qs)
  const filters = []
  let select = '*'
  let limit = Infinity
  let order = null
  for (const [k, v] of params) {
    if (k === 'select') select = v
    else if (k === 'limit') limit = Number(v)
    else if (k === 'order') order = v
    else if (k === 'on_conflict') continue
    else filters.push([k, v])
  }
  return { filters, select, limit, order }
}
function valueAt(row, col) {
  if (col.includes('->>')) {
    const [c, f] = col.split('->>')
    const o = row[c]
    return o && typeof o === 'object' ? (o[f] === undefined ? null : String(o[f])) : null
  }
  return row[col]
}
function matches(row, [col, expr]) {
  const v = valueAt(row, col)
  const dot = expr.indexOf('.')
  const op = expr.slice(0, dot)
  const arg = expr.slice(dot + 1)
  if (op === 'eq') return String(v) === arg
  if (op === 'gte') return String(v) >= arg
  if (op === 'is') return arg === 'null' ? v == null : String(v) === arg
  if (op === 'like') return new RegExp('^' + arg.replace(/\*/g, '.*') + '$').test(String(v))
  if (op === 'ilike') return new RegExp('^' + arg.replace(/\*/g, '.*') + '$', 'i').test(String(v))
  throw new Error('fake PostgREST: unknown operator ' + op)
}
function project(row, select) {
  if (select === '*') return { ...row }
  const out = {}
  for (const c of select.split(',')) {
    if (!(c in row) && row.__strict) throw Object.assign(new Error(`column ${c} does not exist`), { status: 400 })
    out[c] = row[c] === undefined ? null : row[c]
  }
  return out
}
/** columns a table does not have yet, to act out a database before a migration */
const missingColumns = new Map()
export function withoutColumn(table, col) {
  missingColumns.set(`${table}.${col}`, true)
}
export function resetColumns() {
  missingColumns.clear()
}

function rest(w, method, table, qs, body, headers) {
  const rows = w.tables[table]
  if (!rows) return json(404, { message: `relation ${table} does not exist` })
  const { filters, select, limit, order } = parseQuery(qs)
  for (const c of select === '*' ? [] : select.split(',')) {
    if (missingColumns.has(`${table}.${c}`)) return json(400, { code: '42703', message: `column ${table}.${c} does not exist` })
  }
  const role = keyRole(headers)
  if (method === 'GET') {
    let out = rows.filter((r) => filters.every((f) => matches(r, f)))
    if (role === 'user') out = out.filter((r) => rowVisibleTo(table, r, userByToken(headers)))
    if (order) {
      const [col, dir] = order.split('.')
      out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === 'desc' ? -1 : 1))
    }
    return json(200, out.slice(0, limit).map((r) => project(r, select)))
  }
  if (method === 'POST') {
    const items = Array.isArray(body) ? body : [body]
    for (const it of items) {
      for (const c of Object.keys(it)) if (missingColumns.has(`${table}.${c}`)) return json(400, { code: 'PGRST204', message: `Could not find the '${c}' column` })
    }
    const merge = /merge-duplicates/.test(String(headers.Prefer || headers.prefer || ''))
    for (const it of items) {
      const at = it.id !== undefined ? rows.findIndex((r) => r.id === it.id) : -1
      if (at >= 0) {
        if (!merge) return json(409, { code: '23505', message: 'duplicate key value' })
        rows[at] = { ...rows[at], ...it }
      } else rows.push({ ...it })
    }
    return json(201, null)
  }
  if (method === 'PATCH') {
    for (const c of Object.keys(body || {})) if (missingColumns.has(`${table}.${c}`)) return json(400, { code: '42703', message: `column ${c} does not exist` })
    for (const r of rows) if (filters.every((f) => matches(r, f))) Object.assign(r, body)
    return json(204, null)
  }
  if (method === 'DELETE') {
    if (w.failDelete.has(table)) return json(500, { message: 'boom' })
    w.tables[table] = rows.filter((r) => !filters.every((f) => matches(r, f)))
    return json(204, null)
  }
  return json(405, {})
}
function rowVisibleTo(table, row, user) {
  if (!user) return false
  if ('owner' in row) return row.owner === user.id
  if ('user_id' in row) return row.user_id === user.id
  return true
}

// ---------- the database functions the routes call ----------

function rpc(w, name, args, headers) {
  if (!w.functions.has(name)) return json(404, { code: 'PGRST202', message: 'Could not find the function' })
  const me = userByToken(headers)
  if (name === 'sitka_recap') {
    const r = w.tables.recaps.find((x) => x.id === args.p_id && x.enabled)
    return json(200, r ? { ...r } : null)
  }
  if (name === 'sitka_shared_owner') {
    // the migration's rule: the sharer must own the session
    const s = String(args.p_session)
    const viaRecap = w.tables.recaps.find((r) => r.id === s && r.enabled && w.tables.sessions.some((x) => x.id === r.id && x.owner === r.owner))
    if (viaRecap) return json(200, viaRecap.owner)
    const viaEvent = w.tables.events.find(
      (e) => e.session_id === s && e.replay && e.replay.enabled === true && w.tables.sessions.some((x) => x.id === e.session_id && x.owner === e.owner)
    )
    return json(200, viaEvent ? viaEvent.owner : null)
  }
  if (name === 'my_usage') {
    if (w.usageDown) return json(503, { message: 'down' })
    if (!me) return json(401, {})
    return json(200, { plan: 'free', asks: 0, hours: 0, ...(w.usage[me.id] || {}) })
  }
  if (name === 'sitka_rate_hit') {
    if (keyRole(headers) !== 'service') return json(401, {})
    const k = args.p_key
    const hits = (w.rate.get(k) || []).filter((t) => Date.now() - t < 3600000)
    hits.push(Date.now())
    w.rate.set(k, hits)
    const lastMinute = hits.filter((t) => Date.now() - t < 60000).length
    return json(200, lastMinute > args.p_minute || hits.length > args.p_hour)
  }
  if (name === 'sitka_can_watch') {
    return json(200, Boolean(me && (w.courseMembers.get(String(args.p_id)) || new Set()).has(me.id)))
  }
  if (name === 'is_admin') return json(200, Boolean(me && w.admins.has(me.id)))
  if (name === 'sitka_meter') {
    if (keyRole(headers) !== 'service') return json(401, {})
    w.meter.push({ user: args.p_user, kind: args.p_kind, amount: args.p_amount })
    w.tables.usage_meter.push({ user_id: args.p_user, day: new Date().toISOString().slice(0, 10), kind: args.p_kind, n: args.p_amount })
    return json(200, null)
  }
  return json(404, {})
}

// ---------- R2 ----------

function r2(w, method, url, body) {
  const u = new URL(url)
  const path = decodeURIComponent(u.pathname.replace(/^\/sitka\/?/, ''))
  if (method === 'GET' && u.searchParams.get('list-type') === '2') {
    const prefix = u.searchParams.get('prefix') || ''
    const keys = [...w.r2.keys()].filter((k) => k.startsWith(prefix)).sort()
    const xml = `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key><Size>${w.r2.get(k).length}</Size></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`
    return new Response(xml, { status: 200 })
  }
  if (method === 'GET') {
    const b = w.r2.get(path)
    return b ? new Response(b, { status: 200 }) : new Response('', { status: 404 })
  }
  if (method === 'HEAD') {
    const b = w.r2.get(path)
    return new Response(null, { status: b ? 200 : 404, headers: b ? { 'content-length': String(b.length) } : {} })
  }
  if (method === 'PUT') {
    w.r2.set(path, Buffer.from(body || ''))
    return new Response('', { status: 200 })
  }
  if (method === 'DELETE') {
    w.r2.delete(path)
    return new Response(null, { status: 204 })
  }
  return new Response('', { status: 405 })
}

// ---------- the providers ----------

function provider(w, host, path, method, headers, body) {
  const auth = String(headers.Authorization || headers.authorization || headers['x-api-key'] || '')
  if (host === 'api.groq.com') {
    if (path === '/openai/v1/models') {
      w.ai.groq.push({ kind: 'models', auth })
      return json(200, { data: [{ id: 'llama-3.1-8b-instant' }, { id: 'llama-3.3-70b-versatile' }] })
    }
    if (path.endsWith('/audio/transcriptions')) {
      w.ai.groq.push({ kind: 'stt', auth })
      return json(200, { segments: [{ start: 0, end: 2, text: 'hello from the lecture', no_speech_prob: 0.01, avg_logprob: -0.2 }], language: 'english', duration: 12.5 })
    }
    const b = JSON.parse(body || '{}')
    w.ai.groq.push({ kind: 'chat', auth, model: b.model, system: b.messages?.[0]?.content, messages: b.messages })
    return json(200, { choices: [{ message: { content: 'groq answer' } }] })
  }
  if (host === 'api.anthropic.com') {
    const b = JSON.parse(body || '{}')
    w.ai.anthropic.push({ auth, system: b.system, model: b.model, messages: b.messages })
    return json(200, { content: [{ type: 'text', text: 'claude answer' }] })
  }
  if (host === 'generativelanguage.googleapis.com') {
    w.ai.gemini.push({ path })
    if (path.includes(':generateContent')) return json(200, { candidates: [{ content: { parts: [{ text: 'gemini answer' }] } }] })
    return json(200, { models: [] })
  }
  if (host === 'api.openai.com') {
    w.ai.openai.push({ auth })
    return json(200, { segments: [{ start: 0, end: 2, text: 'openai words', no_speech_prob: 0.01, avg_logprob: -0.2 }], language: 'english', duration: 12.5 })
  }
  if (host === 'api.deepgram.com') {
    w.ai.deepgram.push({ path })
    return new Response(Buffer.alloc(4000, 1), { status: 200, headers: { 'content-type': 'audio/wav' } })
  }
  if (host === 'api.resend.com') {
    w.ai.resend.push(JSON.parse(body || '{}'))
    return json(200, { id: 'mail' })
  }
  if (host === 'www.googleapis.com') {
    if (method === 'POST') return new Response('{}', { status: 200, headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=x' } })
    return json(200, { id: 'drivefile' })
  }
  return null
}

// ---------- the one fetch everything goes through ----------

function keyRole(headers) {
  const k = String(headers.apikey || '')
  const a = String(headers.Authorization || headers.authorization || '')
  if (k === 'service-key' || a === 'Bearer service-key') return 'service'
  if (userByToken(headers)) return 'user'
  return 'anon'
}
function userByToken(headers) {
  const a = String(headers.Authorization || headers.authorization || '').replace(/^Bearer\s+/i, '')
  return Object.values(USERS).find((u) => u.token === a) || null
}
function json(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function headersOf(init) {
  const h = init && init.headers
  if (!h) return {}
  if (h instanceof Headers) return Object.fromEntries(h.entries())
  return { ...h }
}

export function install(w) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const u = new URL(url)
    const method = (init.method || 'GET').toUpperCase()
    const headers = headersOf(init)
    let body = init.body
    if (body && typeof body !== 'string' && !(body instanceof Buffer) && !(body instanceof Uint8Array)) {
      body = body instanceof Blob ? Buffer.from(await body.arrayBuffer()) : body
    }
    w.calls.push({ host: u.host, path: u.pathname + u.search, method, headers })
    if (u.origin === SUPA) {
      if (u.pathname === '/auth/v1/user') {
        if (w.authDown) throw new TypeError('fetch failed')
        const me = userByToken(headers)
        return me ? json(200, { id: me.id, email: me.email }) : json(401, { message: 'bad token' })
      }
      if (u.pathname.startsWith('/auth/v1/admin/users/')) {
        w.authDeleted.push(u.pathname.split('/').pop())
        return json(200, {})
      }
      if (u.pathname.startsWith('/rest/v1/rpc/')) {
        const name = u.pathname.slice('/rest/v1/rpc/'.length)
        const args = method === 'GET' ? Object.fromEntries(u.searchParams) : JSON.parse(String(body || '{}'))
        return rpc(w, name, args, headers)
      }
      if (u.pathname.startsWith('/rest/v1/')) {
        const table = u.pathname.slice('/rest/v1/'.length)
        return rest(w, method, table, u.search.slice(1), body ? JSON.parse(String(body)) : null, headers)
      }
      if (u.pathname.startsWith('/storage/v1/')) return json(200, [])
    }
    if (u.host === R2_HOST) return r2(w, method, url, body)
    const p = provider(w, u.host, u.pathname, method, headers, typeof body === 'string' ? body : null)
    if (p) return p
    // anything else is somewhere a route should never have gone
    w.evil.push(url)
    return new Response('evil', { status: 200 })
  }
}

// ---------- calling a route the way Vercel does ----------

export function request({ method = 'POST', body, headers = {}, query = {}, url = '/api/x' } = {}) {
  return { method, body, headers: { 'x-forwarded-for': '203.0.113.9', ...headers }, query, url }
}
export function response() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    chunks: [],
    headersSent: false,
    ended: false,
    status(c) {
      this.statusCode = c
      return this
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v
      return this
    },
    json(o) {
      this.body = o
      this.headersSent = true
      this.ended = true
      return this
    },
    send(o) {
      this.body = o
      this.headersSent = true
      this.ended = true
      return this
    },
    write(s) {
      this.chunks.push(String(s))
      this.headersSent = true
      return true
    },
    end(s) {
      if (s !== undefined) this.body = s
      this.headersSent = true
      this.ended = true
      return this
    },
    flushHeaders() {}
  }
  return res
}
export async function call(handler, req) {
  const res = response()
  await handler(req, res)
  return res
}
export const bearer = (u) => ({ authorization: `Bearer ${u.token}` })
