// A Supabase-shaped database in memory, for testing the database rules.
//
// PGlite is real Postgres (16) compiled to WebAssembly. On top of it this
// sets up what Supabase provides: the anon / authenticated / service_role
// roles with Supabase's default grants, auth.uid() and auth.users, the
// storage schema, and the realtime publication. Then it runs the project's
// scripts in the order they were run on the live database, and (unless
// asked not to) the migrations in supabase/migrations/.
//
//   const db = await supaDb()                    legacy scripts + migrations
//   const old = await supaDb({ migrations: false })   legacy scripts only
//   await db.as(USER_A, 'select ...', [params], { headers: { 'x-sitca-attendee': s } })
//   await db.as(null, ...)        a visitor (anon key)
//   await db.as('service', ...)   the site's server (service key)
//   await db.sql('...')           the database's owner (the SQL editor)

import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const supa = join(root, 'supabase')

/** The order the scripts were run on the live database. */
export const LEGACY = [
  'schema', 'host-upgrade', 'app-upgrade',
  'wave2', 'wave3', 'wave4', 'wave5', 'wave6', 'wave7', 'wave8', 'wave9', 'wave10',
  'wave11', 'wave12', 'wave13', 'wave14', 'wave15', 'wave16', 'wave17', 'wave18',
  'admin', 'hardening', 'plans', 'courses', 'orgadmin', 'keeplive', 'fix-replays', 'fix-stage'
]

export function legacyPath(name) {
  for (const dir of [join(supa, 'legacy'), supa]) {
    try {
      readFileSync(join(dir, `${name}.sql`))
      return join(dir, `${name}.sql`)
    } catch {
      /* the other folder */
    }
  }
  throw new Error(`no legacy script ${name}.sql`)
}

export function migrationFiles() {
  const dir = join(supa, 'migrations')
  return readdirSync(dir)
    .filter((f) => /^\d{8}_\d{2}_.+\.sql$/.test(f))
    .sort()
    .map((f) => join(dir, f))
}

const PRELUDE = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator noinherit;
grant anon, authenticated, service_role to authenticator;

create schema auth;
create schema storage;
create schema extensions;

create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  ), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )
$$;

create table storage.buckets (
  id text primary key,
  name text not null,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index objects_bucket_name on storage.objects (bucket_id, name);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $$;

create publication supabase_realtime;

-- Realtime's broadcast authorisation, as far as the rules see it: the
-- messages table its policies are written on (row-level security already on,
-- owned by another role, as on Supabase), the topic being joined (set by a
-- test as realtime.topic), and send() recording what the database broadcast.
create schema realtime;
create role supabase_realtime_admin nologin;
create table realtime.messages (id bigserial primary key, topic text, extension text, payload jsonb, event text, private boolean, inserted_at timestamptz default now());
alter table realtime.messages enable row level security;
create function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
create table realtime.sent (topic text, event text, payload jsonb, private boolean, at timestamptz default now());
create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
language sql security definer as $$ insert into realtime.sent (topic, event, payload, private) values (topic, event, payload, private) $$;
alter table realtime.messages owner to supabase_realtime_admin;
grant usage on schema realtime to anon, authenticated, service_role;
grant select, insert on realtime.messages to anon, authenticated;
grant usage, select on sequence realtime.messages_id_seq to anon, authenticated;
grant execute on function realtime.topic() to anon, authenticated;

-- Supabase's default grants
grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant all on all tables in schema storage to anon, authenticated, service_role;
grant execute on all functions in schema storage to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
grant select on auth.users to service_role;
`

/** The three people the tests use (and a fourth who is an admin). */
export const PEOPLE = {
  a: { id: '11111111-1111-4111-8111-111111111111', email: 'amara@example.org', name: 'Amara Host' },
  b: { id: '22222222-2222-4222-8222-222222222222', email: 'ben@example.org', name: 'Ben Other' },
  m: { id: '33333333-3333-4333-8333-333333333333', email: 'maya@students.example.ac', name: 'Maya Member' },
  admin: { id: '44444444-4444-4444-8444-444444444444', email: 'owner@example.org', name: 'Site Owner' }
}

export async function supaDb({ migrations = true, twice = false } = {}) {
  const db = new PGlite()
  await db.exec(PRELUDE)
  for (const p of Object.values(PEOPLE)) {
    await db.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)', [
      p.id,
      p.email,
      JSON.stringify({ full_name: p.name })
    ])
  }
  for (const name of LEGACY) {
    try {
      await db.exec(readFileSync(legacyPath(name), 'utf8'))
    } catch (e) {
      throw new Error(`legacy script ${name}.sql failed: ${e.message}`)
    }
  }
  const api = wrap(db)
  if (migrations) await api.migrate(twice ? 2 : 1)
  return api
}

function wrap(db) {
  const api = {
    raw: db,
    /** as the database's owner (the SQL editor) */
    async sql(text, params = []) {
      if (params.length > 0) return (await db.query(text, params)).rows
      const r = await db.exec(text)
      return r.at(-1)?.rows ?? []
    },
    /** run every migration, `times` times over (they must be safe to re-run) */
    async migrate(times = 1) {
      for (let i = 0; i < times; i++) {
        for (const f of migrationFiles()) {
          try {
            await db.exec(readFileSync(f, 'utf8'))
          } catch (e) {
            throw new Error(`${f.split(/[\\/]/).pop()} (run ${i + 1}) failed: ${e.message}`)
          }
        }
      }
    },
    /**
     * As someone: null = a visitor with the anon key, 'service' = the site's
     * server, a uuid = that signed-in person. Returns the rows; throws the
     * database's error as it would reach the app.
     */
    async as(who, text, params = [], { headers = {}, topic = '' } = {}) {
      const role = who === null ? 'anon' : who === 'service' ? 'service_role' : 'authenticated'
      const claims = who === null ? { role: 'anon' } : who === 'service' ? { role: 'service_role' } : { role: 'authenticated', sub: who }
      return db.transaction(async (tx) => {
        await tx.exec(`set local role ${role}`)
        await tx.query(
          `select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true),
                  set_config('request.jwt.claim.role', $3, true), set_config('request.headers', $4, true)`,
          [JSON.stringify(claims), claims.sub || '', claims.role, JSON.stringify(lowerKeys(headers))]
        )
        // the Realtime channel being joined, as realtime.topic() reports it to the rules
        if (topic) await tx.query(`select set_config('realtime.topic', $1, true)`, [topic])
        return (await tx.query(text, params)).rows
      })
    },
    /** the error message a statement fails with, or '' when it succeeds */
    async fails(who, text, params = [], opts) {
      try {
        await api.as(who, text, params, opts)
        return ''
      } catch (e) {
        return e.message || String(e)
      }
    }
  }
  return api
}

function lowerKeys(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]))
}

/** The hex sha-256 the event page stores for an attendee's secret. */
export async function sha256Hex(text) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
