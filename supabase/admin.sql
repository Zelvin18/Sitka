-- Sitka: the owners' dashboard (/admin).
-- Run once in the Supabase SQL editor. Safe to run again.
--
-- Then give yourself access (replace the address):
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'you@example.com'
--   on conflict do nothing;
--
-- How it works: the page never reads tables directly. Every number comes from
-- a function below that runs with elevated rights, checks that the caller is
-- listed in public.admins, and returns aggregates. Usage is recorded as named
-- events (what people do, never what they say) plus client-side errors.

-- ---------- who may look ----------
create table if not exists public.admins (
  user_id uuid primary key,
  added_at timestamptz not null default now()
);
alter table public.admins enable row level security;
drop policy if exists "admins self read" on public.admins;
create policy "admins self read" on public.admins
  for select to authenticated using (user_id = auth.uid());

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- ---------- what people do ----------
create table if not exists public.usage_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,                 -- null for attendees and visitors
  name text not null,           -- app_open, session_start, session_end, ask, ask_overview, listen, attach, recap_open, attendee_join, document, stt_error, db_error, voice_error
  props jsonb not null default '{}',
  platform text not null default 'web',
  ua text
);
create index if not exists usage_events_at_idx on public.usage_events (at desc);
create index if not exists usage_events_name_idx on public.usage_events (name, at desc);
create index if not exists usage_events_user_idx on public.usage_events (user_id, at desc);
alter table public.usage_events enable row level security;
drop policy if exists "usage insert" on public.usage_events;
create policy "usage insert" on public.usage_events
  for insert to anon, authenticated with check (true);

-- ---------- what went wrong on their screens ----------
create table if not exists public.client_errors (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  page text,
  message text not null,
  stack text,
  ua text
);
create index if not exists client_errors_at_idx on public.client_errors (at desc);
alter table public.client_errors enable row level security;
drop policy if exists "errors insert" on public.client_errors;
create policy "errors insert" on public.client_errors
  for insert to anon, authenticated with check (true);

-- ---------- the numbers ----------
-- Every function: admins only, aggregates only.

create or replace function public.admin_overview(days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  since timestamptz := now() - make_interval(days => days);
  prev_since timestamptz := now() - make_interval(days => days * 2);
  out jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;

  with
  active_now as (
    select user_id from public.usage_events where at >= since and user_id is not null
    union select owner from public.sessions where updated_at >= since
  ),
  active_prev as (
    select user_id from public.usage_events where at >= prev_since and at < since and user_id is not null
    union select owner from public.sessions where updated_at >= prev_since and updated_at < since
  ),
  rec_storage as (
    select coalesce(sum((metadata->>'size')::bigint), 0) as bytes
    from storage.objects where bucket_id = 'recordings'
  )
  select jsonb_build_object(
    'days', days,
    'users_total', (select count(*) from auth.users),
    'users_new', (select count(*) from auth.users where created_at >= since),
    'users_new_prev', (select count(*) from auth.users where created_at >= prev_since and created_at < since),
    'users_active', (select count(distinct user_id) from active_now),
    'users_active_prev', (select count(distinct user_id) from active_prev),
    'sessions_total', (select count(*) from public.sessions),
    'sessions_new', (select count(*) from public.sessions where created_at >= since),
    'sessions_new_prev', (select count(*) from public.sessions where created_at >= prev_since and created_at < since),
    'hours_total', (select coalesce(sum((meta->>'durationMs')::numeric), 0) / 3600000 from public.sessions),
    'hours_new', (select coalesce(sum((meta->>'durationMs')::numeric), 0) / 3600000 from public.sessions where created_at >= since),
    'hours_new_prev', (select coalesce(sum((meta->>'durationMs')::numeric), 0) / 3600000 from public.sessions where created_at >= prev_since and created_at < since),
    'events_total', (select count(*) from public.events where status <> 'waiting'),
    'events_new', (select count(*) from public.events where status <> 'waiting' and updated_at >= since),
    'events_new_prev', (select count(*) from public.events where status <> 'waiting' and updated_at >= prev_since and updated_at < since),
    'events_live', (select count(*) from public.events where status = 'live'),
    'attendees_total', (select count(*) from public.attendees),
    'attendees_new', (select count(*) from public.attendees where joined_at >= since),
    'attendees_new_prev', (select count(*) from public.attendees where joined_at >= prev_since and joined_at < since),
    'asks_new', (select count(*) from public.usage_events where at >= since and name in ('ask', 'ask_overview'))
              + (select count(*) from public.asks where created_at >= since),
    'asks_new_prev', (select count(*) from public.usage_events where at >= prev_since and at < since and name in ('ask', 'ask_overview'))
              + (select count(*) from public.asks where created_at >= prev_since and created_at < since),
    'storage_gb', (select round(bytes / 1073741824.0, 2) from rec_storage),
    'errors_24h', (select count(*) from public.client_errors where at >= now() - interval '24 hours'),
    'errors_7d', (select count(*) from public.client_errors where at >= now() - interval '7 days'),
    'stt_errors', (select count(*) from public.usage_events where at >= since and name = 'stt_error'),
    'db_errors', (select count(*) from public.usage_events where at >= since and name = 'db_error'),
    'voice_errors', (select count(*) from public.usage_events where at >= since and name = 'voice_error'),
    'kinds', (
      select coalesce(jsonb_agg(jsonb_build_object('name', k, 'count', c) order by c desc), '[]'::jsonb)
      from (select coalesce(meta->>'kind', 'other') as k, count(*) as c
            from public.sessions where created_at >= since group by 1) t
    ),
    'capture', jsonb_build_object(
      'audio', (select count(*) from public.sessions where created_at >= since and (meta->>'audioOnly')::boolean is true),
      'screen', (select count(*) from public.sessions where created_at >= since and coalesce((meta->>'audioOnly')::boolean, false) = false),
      'hosted', (select count(*) from public.sessions where created_at >= since and (meta->>'hosted')::boolean is true)
    ),
    'languages', (
      select coalesce(jsonb_agg(jsonb_build_object('name', lang, 'count', c) order by c desc), '[]'::jsonb)
      from (select lang, count(*) as c from public.attendees where joined_at >= since group by 1 order by 2 desc limit 8) t
    ),
    'features', (
      select coalesce(jsonb_agg(jsonb_build_object('name', name, 'count', c, 'people', p) order by c desc), '[]'::jsonb)
      from (select name, count(*) as c, count(distinct user_id) as p
            from public.usage_events
            where at >= since and name in ('ask', 'ask_overview', 'listen', 'attach', 'recap_open', 'document', 'catchup', 'attendee_join', 'session_start')
            group by 1) t
    ),
    'platforms', (
      select coalesce(jsonb_agg(jsonb_build_object('name', platform, 'count', c) order by c desc), '[]'::jsonb)
      from (select platform, count(distinct coalesce(user_id::text, ua)) as c
            from public.usage_events where at >= since group by 1) t
    )
  ) into out;
  return out;
end $$;

create or replace function public.admin_series(days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  since date := (now() - make_interval(days => days - 1))::date;
  out jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;

  with d as (
    select generate_series(since, now()::date, interval '1 day')::date as day
  ),
  signups as (select created_at::date as day, count(*) as n from auth.users where created_at::date >= since group by 1),
  active as (
    select day, count(distinct u) as n from (
      select at::date as day, user_id::text as u from public.usage_events where at::date >= since and user_id is not null
      union
      select updated_at::date, owner::text from public.sessions where updated_at::date >= since
    ) x group by 1
  ),
  sess as (
    select created_at::date as day, count(*) as n, coalesce(sum((meta->>'durationMs')::numeric), 0) / 3600000 as hours
    from public.sessions where created_at::date >= since group by 1
  ),
  ev as (select updated_at::date as day, count(*) as n from public.events where status <> 'waiting' and updated_at::date >= since group by 1),
  att as (select joined_at::date as day, count(*) as n from public.attendees where joined_at::date >= since group by 1),
  asks as (
    select day, sum(n) as n from (
      select at::date as day, count(*) as n from public.usage_events where at::date >= since and name in ('ask', 'ask_overview') group by 1
      union all
      select created_at::date, count(*) from public.asks where created_at::date >= since group by 1
    ) y group by 1
  ),
  errs as (select at::date as day, count(*) as n from public.client_errors where at::date >= since group by 1)
  select jsonb_agg(jsonb_build_object(
    'day', to_char(d.day, 'YYYY-MM-DD'),
    'signups', coalesce(signups.n, 0),
    'active', coalesce(active.n, 0),
    'sessions', coalesce(sess.n, 0),
    'hours', round(coalesce(sess.hours, 0), 2),
    'events', coalesce(ev.n, 0),
    'attendees', coalesce(att.n, 0),
    'asks', coalesce(asks.n, 0),
    'errors', coalesce(errs.n, 0)
  ) order by d.day) into out
  from d
  left join signups on signups.day = d.day
  left join active on active.day = d.day
  left join sess on sess.day = d.day
  left join ev on ev.day = d.day
  left join att on att.day = d.day
  left join asks on asks.day = d.day
  left join errs on errs.day = d.day;
  return coalesce(out, '[]'::jsonb);
end $$;

-- Weekly cohorts: of the people who signed up in a week, how many were back
-- in each of the following weeks.
create or replace function public.admin_retention(weeks int default 8)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;

  with cohorts as (
    select id as user_id, date_trunc('week', created_at)::date as week
    from auth.users
    where created_at >= date_trunc('week', now()) - make_interval(weeks => weeks - 1)
  ),
  activity as (
    select distinct u, date_trunc('week', at)::date as week from (
      select user_id::text as u, at from public.usage_events where user_id is not null
      union all
      select owner::text, updated_at from public.sessions
      union all
      select owner::text, created_at from public.sessions
    ) a
  ),
  grid as (
    select c.week, count(distinct c.user_id) as size,
      jsonb_agg(distinct jsonb_build_object('offset', o.offset, 'users', o.users)) as keep
    from cohorts c
    join lateral (
      select k as offset,
        (select count(distinct c2.user_id) from cohorts c2
           join activity a on a.u = c2.user_id::text and a.week = c2.week + make_interval(weeks => k)
         where c2.week = c.week) as users
      from generate_series(0, least(weeks - 1, 6)) k
    ) o on true
    group by c.week
  )
  select jsonb_agg(jsonb_build_object('week', to_char(week, 'YYYY-MM-DD'), 'size', size, 'keep', keep) order by week) into out
  from grid;
  return coalesce(out, '[]'::jsonb);
end $$;

create or replace function public.admin_people(lim int default 60)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;

  with s as (
    select owner, count(*) as sessions,
      coalesce(sum((meta->>'durationMs')::numeric), 0) / 3600000 as hours,
      count(*) filter (where (meta->>'hosted')::boolean is true) as hosted,
      max(updated_at) as last_session
    from public.sessions group by owner
  ),
  u as (
    select user_id, max(at) as last_seen, count(*) filter (where name in ('ask', 'ask_overview')) as asks
    from public.usage_events where user_id is not null group by user_id
  )
  select jsonb_agg(jsonb_build_object(
    'id', au.id,
    'email', au.email,
    'joined', au.created_at,
    'last_seen', greatest(coalesce(u.last_seen, au.last_sign_in_at, au.created_at), coalesce(s.last_session, au.created_at)),
    'sessions', coalesce(s.sessions, 0),
    'hours', round(coalesce(s.hours, 0), 1),
    'hosted', coalesce(s.hosted, 0),
    'asks', coalesce(u.asks, 0),
    'admin', exists (select 1 from public.admins a where a.user_id = au.id)
  ) order by greatest(coalesce(u.last_seen, au.last_sign_in_at, au.created_at), coalesce(s.last_session, au.created_at)) desc) into out
  from (select * from auth.users order by created_at desc limit lim) au
  left join s on s.owner = au.id
  left join u on u.user_id = au.id;
  return coalesce(out, '[]'::jsonb);
end $$;

create or replace function public.admin_errors(lim int default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select jsonb_agg(jsonb_build_object(
    'at', e.at, 'page', e.page, 'message', left(e.message, 300), 'ua', left(e.ua, 120),
    'user', (select email from auth.users where id = e.user_id)
  ) order by e.at desc) into out
  from (select * from public.client_errors order by at desc limit lim) e;
  return coalesce(out, '[]'::jsonb);
end $$;

create or replace function public.admin_live()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select jsonb_build_object(
    'events', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id, 'title', e.title, 'since', e.updated_at,
        'host', (select email from auth.users where id = e.owner),
        'attendees', (select count(*) from public.attendees a where a.event_id = e.id),
        'captions', (select count(*) from public.segments s where s.event_id = e.id),
        'asks', (select count(*) from public.asks k where k.event_id = e.id)
      ) order by e.updated_at desc), '[]'::jsonb)
      from public.events e where e.status = 'live'
    ),
    'people_15m', (
      select count(distinct coalesce(user_id::text, ua)) from public.usage_events where at >= now() - interval '15 minutes'
    ),
    'joins_15m', (select count(*) from public.attendees where joined_at >= now() - interval '15 minutes'),
    'recording_now', (select count(*) from public.sessions where meta->>'status' = 'recording' and updated_at >= now() - interval '2 hours')
  ) into out;
  return out;
end $$;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.admin_overview(int) to authenticated;
grant execute on function public.admin_series(int) to authenticated;
grant execute on function public.admin_retention(int) to authenticated;
grant execute on function public.admin_people(int) to authenticated;
grant execute on function public.admin_errors(int) to authenticated;
grant execute on function public.admin_live() to authenticated;
