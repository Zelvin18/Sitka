-- Sitca hardening, part 7: use counted by the server, and nothing kept for ever.
--
-- Run after 20260925_06_indexes_constraints.sql. Safe to run more than once.
--
-- * The site's server counts what costs money (questions to the AI,
--   seconds of audio transcribed) in a table only it writes. An account's
--   use this month is read from there, and never less than what the older
--   count said, so no one gains or loses anything by the change.
-- * A session's length and flags, as the browser wrote them, are made sane
--   on the way in: a value that is not a number counts as 0 instead of
--   breaking everyone's usage and the owners' dashboard. The only rows this
--   touches now are ones whose length is not a number at all.
-- * A nightly clean-up keeps personal data only as long as it is useful:
--     error reports                      90 days
--     usage events                       13 months
--     the room's anonymous traces        a year after the event ended
--       (chat messages, reactions, votes, attendees who never signed in)
--     organisations in the bin           30 days
--   A host's own event (its captions, questions, recap) is never removed by
--   it; that goes when the host deletes it.

-- ---------- what the server counts ----------
create table if not exists public.usage_meter (
  user_id uuid not null,
  day date not null default current_date,
  kind text not null,
  n numeric not null default 0,
  primary key (user_id, day, kind)
);
alter table public.usage_meter enable row level security;
revoke all on public.usage_meter from anon, authenticated;

create or replace function public.sitka_meter(p_user uuid, p_kind text, p_amount numeric default 1)
returns void language sql security definer set search_path = '' as $$
  insert into public.usage_meter as m (user_id, day, kind, n)
  values (p_user, current_date, left(p_kind, 40), greatest(coalesce(p_amount, 0), 0))
  on conflict (user_id, day, kind) do update set n = m.n + excluded.n;
$$;
revoke execute on function public.sitka_meter(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.sitka_meter(uuid, text, numeric) to service_role;

-- An account's use this month (replaces the one in plans.sql).
create or replace function public.my_usage()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  p_start timestamptz := date_trunc('month', now());
  p_end timestamptz := date_trunc('month', now()) + interval '1 month';
  row_plan record;
  metered numeric;
  logged bigint;
  out_v jsonb;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into row_plan from public.plans
    where user_id = me and status = 'active' and (period_end is null or period_end > now());
  select coalesce(sum(n), 0) into metered from public.usage_meter
    where user_id = me and day >= p_start::date and kind = 'ask';
  select count(*) into logged from public.usage_events
    where user_id = me and at >= p_start and name in ('ask', 'ask_overview');
  select jsonb_build_object(
    'plan', coalesce(row_plan.plan, 'free'),
    'planEnds', row_plan.period_end,
    'planSource', row_plan.source,
    'periodStart', p_start,
    'periodEnd', p_end,
    -- the longer of: the sessions' own lengths, and the audio the server
    -- transcribed on the platform's account (which no browser can shorten)
    'hours', round(greatest(
      (select coalesce(sum(public.sitka_num(s.meta->>'durationMs')), 0) / 3600000
         from public.sessions s where s.owner = me and s.created_at >= p_start),
      (select coalesce(sum(n), 0) / 3600 from public.usage_meter
         where user_id = me and day >= p_start::date and kind = 'stt')
    ), 2),
    'sessions', (select count(*) from public.sessions s where s.owner = me and s.created_at >= p_start),
    'asks', greatest(metered, logged),
    'transcribed', (
      select coalesce(sum(n), 0) from public.usage_meter
      where user_id = me and day >= p_start::date and kind = 'stt'
    ),
    'attendeesMax', (
      select coalesce(max(c), 0) from (
        select count(*) as c from public.attendees a
        join public.events e on e.id = a.event_id
        where e.owner = me and a.joined_at >= p_start
        group by a.event_id
      ) t
    )
  ) into out_v;
  return out_v;
end $$;
grant execute on function public.my_usage() to authenticated;

-- ---------- a session's numbers, made sane on the way in ----------
create or replace function public.sitka_session_meta_guard()
returns trigger language plpgsql set search_path = '' as $$
declare k text;
begin
  if new.meta is null or jsonb_typeof(new.meta) <> 'object' then return new; end if;
  if new.meta ? 'durationMs' and jsonb_typeof(new.meta->'durationMs') <> 'number' then
    new.meta := jsonb_set(new.meta, '{durationMs}', to_jsonb(public.sitka_num(new.meta->>'durationMs')));
  end if;
  foreach k in array array['hosted', 'audioOnly'] loop
    if new.meta ? k and jsonb_typeof(new.meta->k) <> 'boolean' then
      new.meta := jsonb_set(new.meta, array[k], to_jsonb(lower(coalesce(new.meta->>k, '')) = 'true'));
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists sessions_meta_guard on public.sessions;
create trigger sessions_meta_guard
  before insert or update of meta on public.sessions
  for each row execute function public.sitka_session_meta_guard();

-- the rows that would break the sums today, and only those
update public.sessions set meta = meta
where jsonb_typeof(meta) = 'object'
  and ((meta ? 'durationMs' and jsonb_typeof(meta->'durationMs') <> 'number')
    or (meta ? 'hosted' and jsonb_typeof(meta->'hosted') <> 'boolean')
    or (meta ? 'audioOnly' and jsonb_typeof(meta->'audioOnly') <> 'boolean'));

-- ---------- error reports and usage events: at a human pace ----------
-- Pages report their own errors and what people do, with the anonymous key.
-- One page (or one script) may not fill the tables: past the pace, rows are
-- quietly refused. The site's server is not held to it.
create or replace function public.guard_telemetry()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if public.sitka_role() = 'service_role' then return new; end if;
  -- per account or address; callers whose address is unknown share one
  -- much larger allowance, so a missing header never silences real reports
  if public.sitka_rate_hit(tg_table_name || ':' || public.sitka_caller_key(),
                           case when public.sitka_caller_key() = 'anon' then 1200
                                when tg_table_name = 'client_errors' then 30 else 120 end,
                           case when public.sitka_caller_key() = 'anon' then 24000
                                when tg_table_name = 'client_errors' then 300 else 2400 end) then
    raise exception 'too many reports';
  end if;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['client_errors', 'usage_events'] loop
    execute format('drop trigger if exists guard_telemetry on public.%I', t);
    execute format('create trigger guard_telemetry before insert on public.%I for each row execute function public.guard_telemetry()', t);
  end loop;
end $$;

-- ---------- the nightly clean-up ----------
create or replace function public.sitka_retention()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  old_events text[];
  n_errors int; n_usage int; n_room int; n_react int; n_votes int; n_att int; n_orgs int; n_hits int;
begin
  delete from public.client_errors where at < now() - interval '90 days';
  get diagnostics n_errors = row_count;
  delete from public.usage_events where at < now() - interval '13 months';
  get diagnostics n_usage = row_count;
  delete from public.rate_hits where at < now() - interval '2 hours';
  get diagnostics n_hits = row_count;

  select coalesce(array_agg(e.id), '{}') into old_events from public.events e
  where e.status = 'ended' and e.updated_at < now() - interval '1 year';
  delete from public.room_messages where event_id = any(old_events) and not host;
  get diagnostics n_room = row_count;
  delete from public.reactions where event_id = any(old_events);
  get diagnostics n_react = row_count;
  delete from public.question_votes v using public.speaker_questions q
  where q.id = v.question_id and q.event_id = any(old_events);
  get diagnostics n_votes = row_count;
  delete from public.poll_votes v using public.polls p
  where p.id = v.poll_id and p.event_id = any(old_events);
  delete from public.attendees where event_id = any(old_events) and user_id is null;
  get diagnostics n_att = row_count;

  delete from public.organizations where deleted_at is not null and deleted_at < now() - interval '30 days';
  get diagnostics n_orgs = row_count;

  return jsonb_build_object('errors', n_errors, 'usage', n_usage, 'rate_hits', n_hits, 'room', n_room,
    'reactions', n_react, 'votes', n_votes, 'attendees', n_att, 'organisations', n_orgs);
end $$;
revoke execute on function public.sitka_retention() from public, anon, authenticated;
grant execute on function public.sitka_retention() to service_role;

-- every night at 03:17 UTC, and stale live events every ten minutes, where
-- the database has a scheduler (Supabase: the pg_cron extension)
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('sitca-retention', '17 3 * * *', 'select public.sitka_retention()');
  perform cron.schedule('sitca-sweep-events', '*/10 * * * *', 'select public.sweep_stale_events()');
exception when others then
  raise notice 'No scheduler here (%). Run "select public.sitka_retention();" now and then.', sqlerrm;
end $$;
