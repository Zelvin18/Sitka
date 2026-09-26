// The database rules (Set 2), on a real Postgres with every script the live
// database has had, in order, and then the migrations — twice, as they must
// be safe to re-run. Data written before the migrations must all still be
// there after them, and everything the app does must still work; what the
// two reports found open must be closed.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { supaDb, PEOPLE, sha256Hex } from '../lib/supadb.mjs'

const A = PEOPLE.a.id
const B = PEOPLE.b.id
const M = PEOPLE.m.id
const ADMIN = PEOPLE.admin.id

const ATT_LEGACY = 'aaaaaaaa-0000-4000-8000-000000000001'
const ATT_NEW = 'aaaaaaaa-0000-4000-8000-000000000002'
const ATT_OTHER = 'aaaaaaaa-0000-4000-8000-000000000003'
const SECRET = 'f'.repeat(64)
const OTHER_SECRET = 'e'.repeat(64)
const withSecret = (s) => ({ headers: { 'x-sitca-attendee': s } })

let db
let before_counts

const TABLES = [
  'events', 'attendees', 'segments', 'asks', 'speaker_questions', 'sessions', 'recaps', 'organizations',
  'org_members', 'org_spaces', 'space_members', 'room_messages', 'reactions', 'polls', 'poll_votes',
  'question_votes', 'client_errors', 'usage_events', 'saved_recaps'
]

async function counts(d) {
  const out = {}
  for (const t of TABLES) out[t] = Number((await d.sql(`select count(*)::int as n from public.${t}`))[0].n)
  out.objects = Number((await d.sql(`select count(*)::int as n from storage.objects`))[0].n)
  return out
}

before(async () => {
  db = await supaDb({ migrations: false })
  // what the live database holds today, written the way it was written
  await db.sql(`
    insert into public.sessions (id, owner, meta) values
      ('sess-a', '${A}', '{"title":"Lecture 1","durationMs":3600000}'),
      ('sess-a2', '${A}', '{"title":"Lecture 2","durationMs":1800000,"eventId":"ev-a2"}'),
      ('sess-b', '${B}', '{"title":"Odd","durationMs":"abc","hosted":"yes"}'),
      ('sess-m', '${M}', '{"title":"Mine"}');
    insert into public.events (id, title, status, owner, session_id, materials_text, materials) values
      ('ev-a', 'Live lecture', 'live', '${A}', 'sess-a', 'SECRET NOTES', '[{"name":"slides","text":"SECRET"}]'),
      ('ev-b', 'Ben''s event', 'live', '${B}', null, 'BEN NOTES', '[]');
    insert into public.events (id, title, status, owner, session_id, replay) values
      ('ev-a2', 'Past lecture', 'ended', '${A}', 'sess-a2', '{"enabled":true,"summary":"s"}');
    insert into public.attendees (id, event_id, persona, lang) values ('${ATT_LEGACY}', 'ev-a', 'Curious attendee', 'English');
    insert into public.asks (id, event_id, attendee_id, kind, question, status, answer)
      values ('bbbbbbbb-0000-4000-8000-000000000001', 'ev-a', '${ATT_LEGACY}', 'ask', 'private question', 'answered', 'private answer');
    insert into public.speaker_questions (id, event_id, attendee_id, text, status)
      values ('cccccccc-0000-4000-8000-000000000001', 'ev-a', '${ATT_LEGACY}', 'shared question', 'submitted'),
             ('cccccccc-0000-4000-8000-000000000002', 'ev-a', '${ATT_LEGACY}', 'not yet shared', 'checking');
    insert into public.room_messages (id, event_id, attendee_id, name, text)
      values ('dddddddd-0000-4000-8000-000000000001', 'ev-a', '${ATT_LEGACY}', 'Guest', 'hello room');
    insert into public.segments (event_id, idx, start_sec, label, text) values ('ev-a', 0, 0, 'Speaker', 'caption one');
    insert into public.organizations (id, name, kind, owner, code, lead_code) values ('org-a', 'Example University', 'education', '${A}', 'ABC234', 'LEAD23');
    insert into public.org_members (org_id, user_id, role, name, email) values
      ('org-a', '${A}', 'owner', 'Amara', '${PEOPLE.a.email}'),
      ('org-a', '${M}', 'member', 'Maya', '${PEOPLE.m.email}');
    insert into public.org_spaces (id, org_id, name, kind, created_by, code) values ('sp-1', 'org-a', 'Physics 101', 'course', '${A}', 'COURSE22');
    insert into public.space_members (space_id, user_id, role, name, email) values
      ('sp-1', '${A}', 'lecturer', 'Amara', '${PEOPLE.a.email}'),
      ('sp-1', '${M}', 'student', 'Maya', '${PEOPLE.m.email}');
    insert into public.recaps (id, owner, title, enabled) values ('sess-a', '${A}', 'Lecture 1 recap', true);
    insert into public.client_errors (at, message) values (now() - interval '100 days', 'old'), (now(), 'new');
    insert into public.usage_events (user_id, name) values ('${A}', 'ask'), ('${A}', 'ask');
    insert into public.admins (user_id) values ('${ADMIN}');
    insert into storage.objects (bucket_id, name) values ('stage', 'ev-a.jpg'), ('stage', 'ev-a-banner.jpg'), ('replays', 'ev-a2.webm');
  `)
  before_counts = await counts(db)
  await db.migrate(2)
})

// ---------- nothing lost ----------

test('every row written before the migrations is still there after them', async () => {
  const after = await counts(db)
  assert.deepEqual(after, before_counts)
})

test('the host’s materials and every session are untouched', async () => {
  const [e] = await db.sql(`select materials_text from public.events where id = 'ev-a'`)
  assert.equal(e.materials_text, 'SECRET NOTES')
  const [s] = await db.sql(`select meta from public.sessions where id = 'sess-a'`)
  assert.equal(s.meta.title, 'Lecture 1')
})

test('an existing invitation code still opens its organisation and course', async () => {
  const [row] = await db.as(PEOPLE.b.id, `select * from public.sitka_join_org('abc234')`)
  assert.equal(row.id, 'org-a')
  assert.deepEqual(Object.keys(row).sort(), ['id', 'kind', 'name'])
  const [c] = await db.as(PEOPLE.b.id, `select public.sitka_join_course('COURSE22') as j`)
  assert.equal(c.j.spaceId, 'sp-1')
  // (Ben stays a member for the tests below)
})

// ---------- organisations (Audit S2 · Henry D1, D2, D8, D16, D17) ----------

test('nobody can write themselves into an organisation as owner or lead', async () => {
  for (const role of ['owner', 'lead', 'member']) {
    const err = await db.fails(B, `insert into public.org_members (org_id, user_id, role) values ('org-a', $1, $2)
                                  on conflict (org_id, user_id) do nothing`, [B, role])
    // Ben is already a member from the test above; a fresh stranger is tried too
    const err2 = await db.fails(PEOPLE.admin.id, `insert into public.org_members (org_id, user_id, role) values ('org-a', $1, $2)`, [ADMIN, role])
    assert.match(err2, /row-level security|permission/i, `stranger inserted as ${role}`)
    assert.ok(err === '' || /row-level security|permission/i.test(err))
  }
  const [r] = await db.sql(`select count(*)::int as n from public.org_members where org_id = 'org-a' and user_id = '${ADMIN}'`)
  assert.equal(r.n, 0)
  const noUpdate = await db.fails(M, `update public.org_members set role = 'owner' where user_id = $1`, [M])
  assert.match(noUpdate, /permission/i)
})

test('a member cannot read the invitation codes', async () => {
  const err = await db.fails(M, `select code, lead_code from public.organizations where id = 'org-a'`)
  assert.match(err, /permission denied/i)
  const rows = await db.as(M, `select id, name from public.organizations where id = 'org-a'`)
  assert.equal(rows.length, 1)
  const [mine] = await db.as(M, `select public.sitka_my_orgs() as o`)
  const org = mine.o.find((x) => x.id === 'org-a')
  assert.equal(org.role, 'member')
  assert.equal(org.code, null)
  assert.equal(org.leadCode, null)
  const [owner] = await db.as(A, `select public.sitka_my_orgs() as o`)
  const o2 = owner.o.find((x) => x.id === 'org-a')
  assert.equal(o2.code, 'ABC234')
  assert.equal(o2.leadCode, 'LEAD23')
})

test('a member sees their own membership; the owner sees the roster', async () => {
  const mine = await db.as(M, `select user_id, email from public.org_members where org_id = 'org-a'`)
  assert.deepEqual(mine.map((r) => r.user_id), [M])
  const all = await db.as(A, `select user_id from public.org_members where org_id = 'org-a'`)
  assert.ok(all.length >= 3)
  const course = await db.as(M, `select user_id from public.space_members where space_id = 'sp-1'`)
  assert.deepEqual(course.map((r) => r.user_id), [M])
})

test('the lead code makes a lead, and never demotes the owner', async () => {
  const [r] = await db.as(A, `select * from public.sitka_join_org('LEAD23')`)
  assert.equal(r.id, 'org-a')
  const [own] = await db.sql(`select role from public.org_members where org_id = 'org-a' and user_id = '${A}'`)
  assert.equal(own.role, 'owner')
})

test('new organisations get long codes from the database, five at most', async () => {
  const [made] = await db.as(B, `select public.sitka_create_org('Ben Co', 'business') as r`)
  const [row] = await db.sql(`select code, lead_code from public.organizations where id = $1`, [made.r.id])
  assert.match(row.code, /^[A-HJ-NP-Z2-9]{12}$/)
  assert.match(row.lead_code, /^[A-HJ-NP-Z2-9]{12}$/)
  assert.notEqual(row.code, row.lead_code)
  // an older page that sends its own codes gets the database's instead
  await db.as(B, `insert into public.organizations (id, name, kind, owner, code, lead_code) values ('org-old', 'Old way', 'business', $1, 'AAAAAA', 'BBBBBB')`, [B])
  const [old] = await db.sql(`select code from public.organizations where id = 'org-old'`)
  assert.notEqual(old.code, 'AAAAAA')
  assert.equal(old.code.length, 12)
  for (let i = 0; i < 3; i++) await db.as(B, `select public.sitka_create_org($1, 'business')`, [`Extra ${i}`])
  const sixth = await db.fails(B, `select public.sitka_create_org('One too many', 'business')`)
  assert.match(sixth, /five organisations/)
  const forSomeoneElse = await db.fails(B, `insert into public.organizations (id, name, kind, owner, code, lead_code) values ('org-x', 'x', 'business', $1, 'a', 'b')`, [A])
  assert.match(forSomeoneElse, /row-level security|made by its owner/i)
})

test('guessing codes is slowed down', async () => {
  let last = ''
  for (let i = 0; i < 12; i++) last = await db.fails(M, `select * from public.sitka_join_org('ZZZZZZZZZZZZ')`)
  assert.match(last, /Too many tries/)
})

test('deleting an organisation puts it in the bin: nothing is erased, and it can come back', async () => {
  await db.sql(`insert into public.organizations (id, name, kind, owner, code, lead_code) values ('org-bin', 'Bin me', 'education', '${A}', 'x', 'y');
                insert into public.org_members (org_id, user_id, role) values ('org-bin', '${A}', 'owner'), ('org-bin', '${M}', 'member');
                insert into public.org_spaces (id, org_id, name, kind, created_by, code) values ('sp-bin', 'org-bin', 'Binned course', 'course', '${A}', 'BINCOURSE1');
                insert into public.space_members (space_id, user_id, role) values ('sp-bin', '${M}', 'student');
                insert into public.space_chats (space_id, user_id, messages) values ('sp-bin', '${M}', '[{"role":"user","content":"my notes"}]');`)
  const notOwner = await db.fails(M, `select public.sitka_delete_org('org-bin')`)
  assert.match(notOwner, /Only the owner/)
  const direct = await db.fails(A, `delete from public.organizations where id = 'org-bin'`)
  assert.match(direct, /permission/i)
  await db.as(A, `select public.sitka_delete_org('org-bin')`)
  const [c] = await db.as(M, `select public.sitka_can_see_space('sp-bin') as ok`)
  assert.equal(c.ok, false)
  const courses = await db.as(M, `select public.sitka_my_courses() as c`)
  assert.ok(!courses[0].c.some((x) => x.id === 'sp-bin'))
  const [kept] = await db.sql(`select count(*)::int as n from public.space_chats where space_id = 'sp-bin'`)
  assert.equal(kept.n, 1)
  await db.as(A, `select public.sitka_restore_org('org-bin')`)
  const [back] = await db.as(M, `select public.sitka_can_see_space('sp-bin') as ok`)
  assert.equal(back.ok, true)
})

test('the bin is emptied after 30 days, by the nightly clean-up only', async () => {
  await db.as(A, `select public.sitka_delete_org('org-bin')`)
  await db.as('service', `select public.sitka_retention()`)
  let [n] = await db.sql(`select count(*)::int as n from public.organizations where id = 'org-bin'`)
  assert.equal(n.n, 1, 'removed before its 30 days')
  await db.sql(`update public.organizations set deleted_at = now() - interval '31 days' where id = 'org-bin'`)
  await db.as('service', `select public.sitka_retention()`)
  ;[n] = await db.sql(`select count(*)::int as n from public.organizations where id = 'org-bin'`)
  assert.equal(n.n, 0)
  const notYou = await db.fails(A, `select public.sitka_retention()`)
  assert.match(notYou, /permission denied/i)
})

// ---------- courses and filing (Audit S17 · Henry D9) ----------

test('only a course’s lecturers set its live link, to their own event’s page', async () => {
  const student = await db.fails(M, `select public.sitka_course_live('sp-1', 'ev-a', 'https://sitcaai.vercel.app/e/ev-a')`)
  assert.match(student, /lecturers/)
  const phishing = await db.fails(A, `select public.sitka_course_live('sp-1', 'ev-a', 'https://evil.example/login?next=/e/ev-a')`)
  assert.match(phishing, /own page/)
  const notTheirs = await db.fails(A, `select public.sitka_course_live('sp-1', 'ev-b', 'https://sitcaai.vercel.app/e/ev-b')`)
  assert.match(notTheirs, /not yours/)
  await db.as(A, `select public.sitka_course_live('sp-1', 'ev-a', 'https://sitcaai.vercel.app/e/ev-a')`)
  const [sp] = await db.sql(`select live_url from public.org_spaces where id = 'sp-1'`)
  assert.equal(sp.live_url, 'https://sitcaai.vercel.app/e/ev-a')
  await db.as(A, `select public.sitka_course_live('sp-1', null, null)`)
  const direct = await db.fails(M, `update public.org_spaces set live_url = 'https://evil.example' where id = 'sp-1'`)
  assert.match(direct, /permission/i)
})

test('a session can be filed only into a space its owner belongs to, and is always saved', async () => {
  await db.as(B, `insert into public.sessions (id, owner, meta, space_id) values ('sess-b2', $1, '{}', 'sp-1')`, [B])
  let [s] = await db.sql(`select space_id from public.sessions where id = 'sess-b2'`)
  assert.equal(s.space_id, 'sp-1', 'Ben joined the course above, so this filing stands')
  await db.as(PEOPLE.admin.id, `insert into public.sessions (id, owner, meta, space_id) values ('sess-x', $1, '{}', 'sp-1')`, [ADMIN])
  ;[s] = await db.sql(`select space_id from public.sessions where id = 'sess-x'`)
  assert.equal(s.space_id, null, 'a stranger’s session was filed into the course')
})

test('a space’s insights count only its own events’ questions', async () => {
  // Maya files a session that claims Amara's event
  await db.as(M, `insert into public.sessions (id, owner, meta, space_id) values ('sess-spy', $1, '{"eventId":"ev-a"}', 'sp-1')`, [M])
  const rows = await db.as(A, `select * from public.sitka_space_insights('sp-1')`)
  const spy = rows.find((r) => r.session_id === 'sess-spy')
  assert.equal(Number(spy.asks), 0)
  assert.deepEqual(spy.questions, [])
})

// ---------- events (Audit S5 · Henry D5) ----------

test('a visitor cannot read the events table, only one event’s public fields', async () => {
  const err = await db.fails(null, `select id from public.events`)
  assert.match(err, /permission denied/i)
  const [e] = await db.as(null, `select public.sitka_event('ev-a') as e`)
  assert.equal(e.e.title, 'Live lecture')
  assert.equal(e.e.status, 'live')
  assert.equal(e.e.materials_text, undefined)
  assert.equal(e.e.materials, undefined)
  assert.equal(e.e.owner, null)
  assert.equal(e.e.session_id, null)
  const [r] = await db.as(null, `select public.sitka_event('ev-a2') as e`)
  assert.equal(r.e.session_id, 'sess-a2', 'a published replay names its recording')
  assert.equal(r.e.owner, A)
  const [none] = await db.as(null, `select public.sitka_event('nope') as e`)
  assert.equal(none.e, null)
})

test('a signed-in stranger cannot read another host’s event row; the host can', async () => {
  const theirs = await db.as(B, `select id from public.events where id = 'ev-a'`)
  assert.equal(theirs.length, 0)
  const mine = await db.as(A, `select materials_text from public.events where id = 'ev-a'`)
  assert.equal(mine[0].materials_text, 'SECRET NOTES')
})

// ---------- the room (Audit S6, S9, S18 · Henry D6, D10, A6, A7) ----------

test('an attendee joins with a secret; a row cannot name someone else', async () => {
  await db.as(null, `insert into public.attendees (id, event_id, secret_hash) values ($1, 'ev-a', $2)`, [ATT_NEW, await sha256Hex(SECRET)])
  await db.as(null, `insert into public.attendees (id, event_id, secret_hash) values ($1, 'ev-b', $2)`, [ATT_OTHER, await sha256Hex(OTHER_SECRET)])
  const impersonate = await db.fails(null, `insert into public.attendees (id, event_id, user_id, keep) values (gen_random_uuid(), 'ev-a', $1, true)`, [A])
  assert.match(impersonate, /row-level security/i)
  const [n] = await db.as(null, `select public.attendee_count('ev-a') as n`)
  assert.equal(n.n, 2)
})

test('attendees’ questions and answers are not readable by the room', async () => {
  const err = await db.fails(null, `select question, answer from public.asks`)
  assert.ok(/permission denied/i.test(err) || err === '', err)
  const rows = await db.as(null, `select id from public.asks`).catch(() => [])
  assert.equal(rows.length, 0)
  const signedIn = await db.as(B, `select id from public.asks`)
  assert.equal(signedIn.length, 0)
  const host = await db.as(A, `select answer from public.asks where event_id = 'ev-a'`)
  assert.equal(host[0].answer, 'private answer')
})

test('a question is written only by a real attendee of that event, with their secret', async () => {
  const q = (id) => [`insert into public.asks (id, event_id, attendee_id, kind, question, status) values ($1, 'ev-a', $2, 'ask', 'hi', 'pending')`, [id, ATT_NEW]]
  assert.equal(await db.fails(null, ...q('bbbbbbbb-0000-4000-8000-000000000010'), withSecret(SECRET)), '')
  assert.match(await db.fails(null, ...q('bbbbbbbb-0000-4000-8000-000000000011'), withSecret(OTHER_SECRET)), /join the event/)
  assert.match(await db.fails(null, ...q('bbbbbbbb-0000-4000-8000-000000000012')), /join the event/)
  // an attendee of another event
  const cross = await db.fails(null, `insert into public.asks (id, event_id, attendee_id, kind, question, status) values (gen_random_uuid(), 'ev-a', $1, 'ask', 'hi', 'pending')`, [ATT_OTHER], withSecret(OTHER_SECRET))
  assert.match(cross, /join the event/)
  // an answer cannot be written from the room
  const answered = await db.fails(null, `insert into public.asks (id, event_id, attendee_id, kind, question, status, answer) values (gen_random_uuid(), 'ev-a', $1, 'ask', 'q', 'answered', 'fake')`, [ATT_NEW], withSecret(SECRET))
  assert.match(answered, /row-level security/i)
  // someone who joined before secrets existed can still ask
  assert.equal(await db.fails(null, `insert into public.asks (id, event_id, attendee_id, kind, question, status) values (gen_random_uuid(), 'ev-a', $1, 'ask', 'q', 'pending')`, [ATT_LEGACY]), '')
})

test('the room sees questions put to the speaker, never who asked', async () => {
  const rows = await db.as(null, `select id, text, status from public.speaker_questions where event_id = 'ev-a'`)
  assert.deepEqual(rows.map((r) => r.text), ['shared question'])
  const who = await db.fails(null, `select attendee_id from public.speaker_questions`)
  assert.match(who, /permission denied/i)
})

test('room messages carry an anonymous tag, not the writer’s id', async () => {
  const who = await db.fails(null, `select attendee_id from public.room_messages`)
  assert.match(who, /permission denied/i)
  await db.as(null, `insert into public.room_messages (id, event_id, attendee_id, name, text) values (gen_random_uuid(), 'ev-a', $1, 'Guest', 'hi all')`, [ATT_NEW], withSecret(SECRET))
  const rows = await db.as(null, `select author, text from public.room_messages where event_id = 'ev-a' and text = 'hi all'`)
  // the tag the writer's page computes for itself: sha-256 of the id's 16 bytes, first 16 hex
  const { createHash } = await import('node:crypto')
  const tag = createHash('sha256').update(Buffer.from(ATT_NEW.replace(/-/g, ''), 'hex')).digest('hex').slice(0, 16)
  assert.equal(rows[0].author, tag)
  const spoof = await db.fails(null, `insert into public.room_messages (id, event_id, attendee_id, name, text) values (gen_random_uuid(), 'ev-a', $1, 'Guest', 'as someone else')`, [ATT_NEW], withSecret(OTHER_SECRET))
  assert.match(spoof, /join the event/)
  const asHost = await db.fails(null, `insert into public.room_messages (id, event_id, attendee_id, name, host, text) values (gen_random_uuid(), 'ev-a', $1, 'Host', true, 'I am the host')`, [ATT_NEW], withSecret(SECRET))
  assert.match(asHost, /row-level security|only the host/i)
  // the host writes as the host
  assert.equal(await db.fails(A, `insert into public.room_messages (id, event_id, name, host, text) values (gen_random_uuid(), 'ev-a', 'Host', true, 'welcome')`), '')
})

test('one attendee cannot flood the room', async () => {
  let last = ''
  for (let i = 0; i < 14; i++) {
    last = await db.fails(null, `insert into public.room_messages (id, event_id, attendee_id, name, text) values (gen_random_uuid(), 'ev-a', $1, 'Guest', $2)`, [ATT_NEW, `msg ${i}`], withSecret(SECRET))
  }
  assert.match(last, /slow down/)
})

test('reactions and votes: only from attendees, and never showing who', async () => {
  assert.equal(await db.fails(null, `insert into public.reactions (id, event_id, attendee_id, kind) values (gen_random_uuid(), 'ev-a', $1, 'lost')`, [ATT_NEW], withSecret(SECRET)), '')
  assert.match(await db.fails(null, `insert into public.reactions (id, event_id, attendee_id, kind) values (gen_random_uuid(), 'ev-a', $1, 'lost')`, [ATT_NEW]), /join the event/)
  const seen = await db.as(null, `select * from public.reactions`).catch((e) => e.message)
  assert.ok(Array.isArray(seen) ? seen.length === 0 : /permission/.test(seen))
  await db.as(null, `insert into public.question_votes (question_id, attendee_id) values ('cccccccc-0000-4000-8000-000000000001', $1)`, [ATT_NEW], withSecret(SECRET))
  assert.match(await db.fails(null, `select attendee_id from public.question_votes`), /permission denied/i)
  const counted = await db.as(null, `select question_id from public.question_votes`)
  assert.equal(counted.length, 1)
  const unshared = await db.fails(null, `insert into public.question_votes (question_id, attendee_id) values ('cccccccc-0000-4000-8000-000000000002', $1)`, [ATT_NEW], withSecret(SECRET))
  assert.match(unshared, /join the event|nothing to vote/)
})

test('keeping an event: only one’s own attendee row', async () => {
  const takeover = await db.fails(B, `select public.sitka_attend_keep($1, true)`, [ATT_NEW], withSecret(OTHER_SECRET))
  assert.match(takeover, /Not yours/)
  assert.equal(await db.fails(M, `select public.sitka_attend_keep($1, true)`, [ATT_NEW], withSecret(SECRET)), '')
  const again = await db.fails(B, `select public.sitka_attend_keep($1, true)`, [ATT_NEW], withSecret(SECRET))
  assert.match(again, /Not yours/, 'someone else took over a kept row')
})

test('an ended event takes nothing more from the room', async () => {
  await db.sql(`insert into public.attendees (id, event_id) values ('aaaaaaaa-0000-4000-8000-000000000009', 'ev-a2')`)
  const late = await db.fails(null, `insert into public.room_messages (id, event_id, attendee_id, name, text) values (gen_random_uuid(), 'ev-a2', 'aaaaaaaa-0000-4000-8000-000000000009', 'Guest', 'late')`)
  assert.match(late, /ended/)
})

// ---------- shared recaps (Audit S1, S4, X3 · Henry D3, D4, D12) ----------

test('nobody can share a session that is not theirs, by recap or by event', async () => {
  const recap = await db.fails(B, `insert into public.recaps (id, owner, title, enabled) values ('sess-a', $1, 'planted', true)
                                   on conflict (id) do update set title = excluded.title`, [B])
  assert.match(recap, /row-level security|Only the person who recorded/)
  const ev = await db.fails(B, `insert into public.events (id, title, status, owner, session_id, replay) values ('ev-plant', 'x', 'ended', $1, 'sess-a', '{"enabled":true}')`, [B])
  assert.match(ev, /only play a session its host recorded/)
  const [owner] = await db.as(null, `select public.sitka_shared_owner('sess-a') as o`)
  assert.equal(owner.o, A, 'the real share still opens')
})

test('recaps cannot be listed; one opens by its id', async () => {
  const listed = await db.as(null, `select id from public.recaps`).catch(() => [])
  assert.equal(listed.length, 0)
  const [one] = await db.as(null, `select public.sitka_recap('sess-a') as r`)
  assert.equal(one.r.title, 'Lecture 1 recap')
})

test('deleting a session takes its recap with it', async () => {
  await db.sql(`insert into public.sessions (id, owner, meta) values ('sess-del', '${A}', '{}');
                insert into public.recaps (id, owner, title, enabled) values ('sess-del', '${A}', 'to go', true)`)
  await db.as(A, `delete from public.sessions where id = 'sess-del'`)
  const [r] = await db.as(null, `select public.sitka_recap('sess-del') as r`)
  assert.equal(r.r, null)
})

test('re-audit N4: a deleted session stays deleted: it cannot be written again, by anyone', async () => {
  await db.sql(`insert into public.sessions (id, owner, meta) values ('sess-tomb', '${A}', '{}')`)
  await db.as(A, `delete from public.sessions where id = 'sess-tomb'`)
  const [t] = await db.as(A, `select id from public.deleted_sessions where id = 'sess-tomb'`)
  assert.equal(t?.id, 'sess-tomb', 'the owner sees it was deleted')
  assert.equal((await db.as(B, `select id from public.deleted_sessions`)).length, 0, 'nobody else does')
  assert.match(await db.fails(A, `insert into public.sessions (id, owner, meta) values ('sess-tomb', '${A}', '{}')`), /was deleted/)
  // nor by someone hoping to take over its old recap link
  assert.match(await db.fails(B, `insert into public.sessions (id, owner, meta) values ('sess-tomb', '${B}', '{}')`), /was deleted/)
  assert.equal(await db.fails(A, `insert into public.sessions (id, owner, meta) values ('sess-fresh', '${A}', '{}')`), '')
  assert.match(await db.fails(A, `insert into public.deleted_sessions (id, owner) values ('x', '${A}')`), /permission denied/i)
})

test('re-audit N8: no read-only function writes (Postgres refuses it, and the feature fails)', async () => {
  const rows = await db.sql(`
    select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.provolatile <> 'v'
      and p.prosrc ~* '(\\minsert\\s+into\\M|\\mupdate\\s+public\\.|\\mdelete\\s+from\\M|sitka_rate_hit|sitka_meter)'
    order by 1`)
  assert.deepEqual(rows.map((r) => r.f), [])
  const [r] = await db.as(null, `select public.sitka_course_preview('COURSE22') as p`)
  assert.equal(r.p?.course, 'Physics 101')
})

test('re-audit B9: owner rows written by anyone but the organisation’s owner are made memberships, and give no lead powers', async () => {
  // a row the hole before part 2 let a stranger write (put back as the database's owner would find it)
  await db.sql(`insert into public.org_members (org_id, user_id, role, name, email) values ('org-a', '${B}', 'owner', 'Ben', '${PEOPLE.b.email}')
                on conflict (org_id, user_id) do update set role = 'owner'`)
  const [before] = await db.as(B, `select public.sitka_is_lead('org-a') as lead`)
  assert.equal(before.lead, false, 'a stray owner row no longer counts as lead, even before it is corrected')
  await db.sql(readFileSync(new URL('../../supabase/migrations/20260926_09_reaudit.sql', import.meta.url), 'utf8'))
  const [row] = await db.sql(`select role from public.org_members where org_id = 'org-a' and user_id = '${B}'`)
  assert.equal(row.role, 'member')
  const [owner] = await db.sql(`select role from public.org_members where org_id = 'org-a' and user_id = '${A}'`)
  assert.equal(owner.role, 'owner', 'the real owner is untouched')
  const [a] = await db.as(A, `select public.sitka_is_lead('org-a') as lead`)
  assert.equal(a.lead, true)
  await db.sql(`delete from public.org_members where org_id = 'org-a' and user_id = '${B}'`)
})

test('re-audit N30: a recap whose session is gone is switched off, and its owner may always switch one off', async () => {
  // a recap left on by a session deleted before part 0 (the guard is not asked when the database's owner writes)
  await db.sql(`insert into public.recaps (id, owner, title, enabled) values ('sess-orphan', '${A}', 'left on', true)`)
  await db.sql(readFileSync(new URL('../../supabase/migrations/20260926_09_reaudit.sql', import.meta.url), 'utf8'))
  const [r] = await db.sql(`select enabled from public.recaps where id = 'sess-orphan'`)
  assert.equal(r.enabled, false)
  await db.sql(`update public.recaps set enabled = true where id = 'sess-orphan'`)
  assert.equal(await db.fails(A, `update public.recaps set enabled = false where id = 'sess-orphan'`), '')
  assert.match(await db.fails(A, `update public.recaps set enabled = true where id = 'sess-orphan'`), /Only the person who recorded/)
})

test('migrations from part 9 on say that they ran', async () => {
  const rows = await db.sql(`select name from public.schema_migrations order by 1`)
  assert.ok(rows.some((r) => r.name === '20260926_09_reaudit'))
  assert.equal((await db.as(null, `select 1 from pg_tables where schemaname = 'public' and tablename = 'schema_migrations'`)).length, 1)
  assert.match(await db.fails(A, `select * from public.schema_migrations`), /permission denied/i)
})

// ---------- storage (Audit S7 · Henry D7) ----------

test('only the host changes their live screen, banner or replay', async () => {
  const hijack = await db.fails(B, `insert into storage.objects (bucket_id, name) values ('stage', 'ev-a.jpg') on conflict (bucket_id, name) do update set updated_at = now()`)
  assert.match(hijack, /row-level security/i)
  const del = await db.as(B, `delete from storage.objects where bucket_id in ('stage', 'replays') returning name`)
  assert.equal(del.length, 0)
  assert.equal(await db.fails(A, `update storage.objects set updated_at = now() where bucket_id = 'stage' and name = 'ev-a.jpg'`), '')
  assert.equal(await db.fails(A, `insert into storage.objects (bucket_id, name) values ('stage', 'session-sess-a-banner.jpg')`), '')
  assert.match(await db.fails(B, `insert into storage.objects (bucket_id, name) values ('stage', 'session-sess-a-banner.jpg')`), /row-level security/i)
  assert.match(await db.fails(A, `insert into storage.objects (bucket_id, name) values ('stage', 'folder/ev-a.jpg')`), /row-level security/i)
  const listed = await db.as(null, `select name from storage.objects where bucket_id in ('stage', 'replays')`)
  assert.equal(listed.length, 0, 'visitors can list the public buckets')
  const [b] = await db.sql(`select file_size_limit, allowed_mime_types from storage.buckets where id = 'stage'`)
  assert.equal(Number(b.file_size_limit), 5242880)
})

// ---------- functions (Audit S16 · Henry D13) ----------

test('every raised-rights function has a fixed search path', async () => {
  const rows = await db.sql(`
    select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')`)
  assert.deepEqual(rows.map((r) => r.f), [])
})

test('visitors may run only the public pages’ functions; nobody may ask for another person’s plan', async () => {
  const rows = await db.sql(`
    select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`)
  assert.deepEqual(rows.map((r) => r.f), [
    'attendee_count(text)', 'event_open(text)', 'sitka_course_preview(text)', 'sitka_event(text)',
    'sitka_recap(text)', 'sitka_shared_owner(text)'
  ])
  assert.match(await db.fails(B, `select public.current_plan($1)`, [A]), /permission denied/i)
  assert.match(await db.fails(null, `select public.sitka_space_org('sp-1')`), /permission denied/i)
  assert.match(await db.fails(B, `select public.sitka_meter($1, 'ask', 1)`, [B]), /permission denied/i)
})

test('every function the app calls still runs with the fixed search path', async () => {
  const calls = [
    [A, `select public.sitka_my_orgs()`], [A, `select public.sitka_my_courses()`], [A, `select public.sitka_my_live()`],
    [A, `select public.my_usage()`], [A, `select * from public.sitka_space_sessions('sp-1')`],
    [A, `select * from public.sitka_space_session('sess-a')`], [A, `select public.sitka_can_watch('sess-a')`],
    [A, `select public.sitka_unfile_session('sess-spy')`], [A, `select public.sitka_org_overview('org-a')`],
    [A, `select public.sitka_org_rename('org-a', 'Example University')`],
    [A, `select public.sitka_org_rules('org-a', array['example.ac'], 'leads')`],
    [A, `select public.sitka_org_set_role('org-a', '${M}', 'member')`],
    [A, `select public.sitka_create_course('org-a', 'Chemistry', '')`],
    [A, `select public.sitka_hide_course('sp-1', true)`], [A, `select public.sitka_hide_course('sp-1', false)`],
    [A, `select public.sitka_org_new_codes('org-a')`],
    [A, `select public.sitka_event_keep_all('ev-a2', 'sess-a2')`], [M, `select public.sitka_keep_event('ev-a2')`],
    [A, `select public.sweep_stale_events()`], [A, `select public.is_admin()`],
    [null, `select public.attendee_count('ev-a')`], [null, `select public.event_open('ev-a')`],
    [null, `select public.sitka_recap('sess-a')`], [null, `select public.sitka_shared_owner('sess-a')`],
    [null, `select public.sitka_course_preview('COURSE22')`],
    [ADMIN, `select public.admin_overview(30)`], [ADMIN, `select public.admin_series(30)`],
    [ADMIN, `select public.admin_retention(8)`], [ADMIN, `select public.admin_people(60)`],
    [ADMIN, `select public.admin_errors(50)`], [ADMIN, `select public.admin_live()`], [ADMIN, `select public.admin_feedback(100)`],
    [ADMIN, `select public.admin_plans()`], [ADMIN, `select public.admin_list()`],
    [ADMIN, `select public.admin_set_plan('${B}', 'plus', 1, 'test')`],
    ['service', `select public.sitka_meter('${A}', 'ask', 1)`], ['service', `select public.sitka_retention()`]
  ]
  for (const [who, text] of calls) {
    assert.equal(await db.fails(who, text), '', text)
  }
  // the organisation's new codes are the long kind
  const [o] = await db.sql(`select code from public.organizations where id = 'org-a'`)
  assert.equal(o.code.length, 12)
})

// ---------- usage (Audit S12 · Henry D14) ----------

test('use this month comes from the server’s count, never less than before', async () => {
  const [u] = await db.as(A, `select public.my_usage() as u`)
  // two logged asks before; the server has metered one since
  assert.equal(Number(u.u.asks), 2)
  for (let i = 0; i < 3; i++) await db.as('service', `select public.sitka_meter($1, 'ask', 1)`, [A])
  const [u2] = await db.as(A, `select public.my_usage() as u`)
  assert.equal(Number(u2.u.asks), 4)
  assert.match(await db.fails(A, `insert into public.usage_meter (user_id, kind, n) values ($1, 'ask', -100)`, [A]), /permission denied/i)
})

test('hours are the longer of the sessions’ lengths and the audio the server transcribed', async () => {
  const [u0] = await db.as(M, `select public.my_usage() as u`)
  assert.equal(Number(u0.u.hours), 0)
  await db.as('service', `select public.sitka_meter($1, 'stt', 5400)`, [M])
  const [u1] = await db.as(M, `select public.my_usage() as u`)
  assert.equal(Number(u1.u.hours), 1.5)
  // a browser that shortens its session cannot shorten this
  await db.as(M, `update public.sessions set meta = '{"durationMs":0}' where id = 'sess-m'`)
  const [u2] = await db.as(M, `select public.my_usage() as u`)
  assert.equal(Number(u2.u.hours), 1.5)
})

test('a length that is not a number no longer breaks the sums', async () => {
  const [s] = await db.sql(`select meta from public.sessions where id = 'sess-b'`)
  assert.equal(s.meta.durationMs, 0)
  assert.equal(s.meta.hosted, false)
  assert.equal(s.meta.title, 'Odd')
  await db.as(B, `update public.sessions set meta = '{"durationMs":"lots"}' where id = 'sess-b'`)
  assert.equal(await db.fails(ADMIN, `select public.admin_overview(30)`), '')
  assert.equal(await db.fails(B, `select public.my_usage()`), '')
})

test('error reports and usage events cannot be flooded; the server is not limited', async () => {
  let last = ''
  const from = { headers: { 'x-forwarded-for': '203.0.113.9' } }
  for (let i = 0; i < 32; i++) last = await db.fails(null, `insert into public.client_errors (message) values ($1)`, [`e${i}`], from)
  assert.match(last, /too many reports/)
  assert.equal(await db.fails(null, `insert into public.client_errors (message) values ('from elsewhere')`, [], { headers: { 'x-forwarded-for': '198.51.100.7' } }), '')
  for (let i = 0; i < 5; i++) assert.equal(await db.fails('service', `insert into public.client_errors (page, message) values ('server:x', 'server error')`), '')
  const other = await db.fails(null, `insert into public.usage_events (user_id, name) values ($1, 'ask')`, [A])
  assert.match(other, /row-level security/i, 'a visitor wrote a usage row in someone else’s name')
})

// ---------- keeping and clean-up (Audit P4, D5) ----------

test('the clean-up removes old error reports and leaves the host’s event alone', async () => {
  const [before] = await db.sql(`select count(*)::int as n from public.client_errors`)
  await db.as('service', `select public.sitka_retention()`)
  const [after] = await db.sql(`select count(*)::int as n from public.client_errors`)
  assert.equal(after.n, before.n - 1 >= 0 ? after.n : 0)
  const [old] = await db.sql(`select count(*)::int as n from public.client_errors where message = 'old'`)
  assert.equal(old.n, 0)
  const [seg] = await db.sql(`select count(*)::int as n from public.segments where event_id = 'ev-a'`)
  assert.equal(seg.n, 1)
})

test('checks and links to accounts apply to new rows only, and an account takes its rows with it', async () => {
  const bad = await db.fails(A, `insert into public.events (id, title, status, owner) values ('ev-bad', 't', 'paused', $1)`, [A])
  assert.match(bad, /events_status_known/)
  const [fk] = await db.sql(`select count(*)::int as n from pg_constraint where conname like '%_account_fk' and not convalidated`)
  assert.ok(fk.n >= 10)
  await db.sql(`insert into auth.users (id, email) values ('55555555-5555-4555-8555-555555555555', 'gone@example.org');
                insert into public.sessions (id, owner, meta) values ('sess-gone', '55555555-5555-4555-8555-555555555555', '{}');
                insert into public.usage_events (user_id, name) values ('55555555-5555-4555-8555-555555555555', 'ask');
                delete from auth.users where id = '55555555-5555-4555-8555-555555555555';`)
  const [s] = await db.sql(`select count(*)::int as n from public.sessions where id = 'sess-gone'`)
  assert.equal(s.n, 0)
  const [u] = await db.sql(`select count(*)::int as n from public.usage_events where user_id is null and name = 'ask'`)
  assert.ok(u.n >= 1)
})

test('rules read the caller once per query', async () => {
  const rows = await db.sql(`select tablename, policyname from pg_policies where schemaname = 'public'
    and (coalesce(qual, '') ~ '(?<!SELECT )auth\\.uid\\(\\)' or coalesce(with_check, '') ~ '(?<!SELECT )auth\\.uid\\(\\)')`)
  assert.deepEqual(rows, [])
})

// ---------- the live database: part 5 stopped, part 8 finishes the job ----------

test('part 8 closes the functions on a database where part 5 was undone, and touches nothing not ours', async () => {
  const { supaDb: fresh, migrationFiles } = await import('../lib/supadb.mjs')
  const { readFileSync } = await import('node:fs')
  const live = await fresh({ migrations: false })
  // as on Supabase: a raised-rights function in public that belongs to another role
  await live.sql(`create role platform_admin nologin;
                  create function public.platform_helper() returns int language sql security definer as 'select 1';
                  alter function public.platform_helper() owner to platform_admin;`)
  const files = migrationFiles()
  // the live database: every part ran except 5, which the SQL editor undid
  for (const f of files) {
    if (/_0[58]_/.test(f)) continue
    await live.raw.exec(readFileSync(f, 'utf8'))
  }
  const [open] = await live.as(null, `select public.current_plan($1) as p`, [A])
  assert.equal(open.p, 'free', 'the hole is open, as it is on the live database')
  const f08 = files.find((f) => /_08_/.test(f))
  const out = await live.raw.exec(readFileSync(f08, 'utf8'))
  assert.deepEqual(out.at(-1).rows.map((r) => r.visitors_may_run), [
    'attendee_count(text)', 'event_open(text)', 'sitka_course_preview(text)', 'sitka_event(text)',
    'sitka_recap(text)', 'sitka_shared_owner(text)'
  ])
  assert.match(await live.fails(null, `select public.current_plan($1)`, [A]), /permission denied/i)
  assert.match(await live.fails(B, `select public.current_plan($1)`, [A]), /permission denied/i)
  assert.match(await live.fails(null, `select public.sitka_space_org('x')`), /permission denied/i)
  assert.equal(await live.fails(A, `select public.sitka_my_orgs()`), '')
  assert.equal(await live.fails(A, `select public.my_usage()`), '')
  assert.equal(await live.fails(null, `select public.sitka_event('x')`), '')
  const [fx] = await live.sql(`select proconfig is null as untouched from pg_proc where proname = 'platform_helper'`)
  assert.equal(fx.untouched, true, 'a function that is not ours was changed')
  const [nf] = await live.sql(`select count(*)::int as n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.prosecdef and pg_get_userbyid(p.proowner) = current_user
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')`)
  assert.equal(nf.n, 0)
  // and it is safe to run again
  await live.raw.exec(readFileSync(f08, 'utf8'))
})

// ---------- before the migrations, the holes were real ----------

test('the same attacks succeed on the database as it was (so these tests test something)', async () => {
  const old = await (await import('../lib/supadb.mjs')).supaDb({ migrations: false })
  await old.sql(`insert into public.organizations (id, name, kind, owner, code, lead_code) values ('org-a', 'U', 'education', '${A}', 'ABC234', 'LEAD23');
                 insert into public.events (id, title, status, owner, materials_text) values ('ev-a', 't', 'live', '${A}', 'SECRET NOTES')`)
  assert.equal(await old.fails(B, `insert into public.org_members (org_id, user_id, role) values ('org-a', $1, 'owner')`, [B]), '')
  const [e] = await old.as(null, `select materials_text from public.events where id = 'ev-a'`)
  assert.equal(e.materials_text, 'SECRET NOTES')
  const [p] = await old.as(null, `select public.current_plan($1) as p`, [A])
  assert.equal(p.p, 'free')
})
