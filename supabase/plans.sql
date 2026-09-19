-- Sitca: plans and usage.
-- Run once in the Supabase SQL editor, after admin.sql. Safe to run again.
--
-- What a plan allows lives in the code (src/shared/plans.ts). This file keeps
-- which plan each account is on, and adds up what an account has used this
-- month from rows that already exist. Nothing new is logged.
--
-- No row in public.plans means Free.

-- ---------- which plan an account is on ----------
create table if not exists public.plans (
  user_id uuid primary key,
  plan text not null default 'free',          -- free | plus | pro | institution
  status text not null default 'active',      -- active | ended
  period_start timestamptz not null default now(),
  period_end timestamptz,                     -- null: open-ended (an institution seat, a gift)
  source text not null default 'manual',      -- manual | flutterwave | …
  note text,                                  -- who paid, how, anything worth remembering
  updated_at timestamptz not null default now()
);
alter table public.plans enable row level security;
drop policy if exists "plans self read" on public.plans;
create policy "plans self read" on public.plans
  for select to authenticated using (user_id = auth.uid());

-- ---------- what an account may do right now ----------
-- The plan in force: active, and not past its end.
create or replace function public.current_plan(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((
    select plan from public.plans
    where user_id = p_user and status = 'active' and (period_end is null or period_end > now())
  ), 'free');
$$;

-- ---------- what an account has used this month ----------
-- Called by the app (Settings) and by the server before it does work for
-- someone. Runs as the caller: their own rows only.
create or replace function public.my_usage()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  p_start timestamptz := date_trunc('month', now());
  p_end timestamptz := date_trunc('month', now()) + interval '1 month';
  row_plan record;
  out jsonb;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into row_plan from public.plans
    where user_id = me and status = 'active' and (period_end is null or period_end > now());
  select jsonb_build_object(
    'plan', coalesce(row_plan.plan, 'free'),
    'planEnds', row_plan.period_end,
    'planSource', row_plan.source,
    'periodStart', p_start,
    'periodEnd', p_end,
    'hours', (
      select round(coalesce(sum((meta->>'durationMs')::numeric), 0) / 3600000, 2)
      from public.sessions where owner = me and created_at >= p_start
    ),
    'sessions', (select count(*) from public.sessions where owner = me and created_at >= p_start),
    'asks', (
      select count(*) from public.usage_events
      where user_id = me and at >= p_start and name in ('ask', 'ask_overview')
    ),
    'attendeesMax', (
      select coalesce(max(n), 0) from (
        select count(*) as n from public.attendees a
        join public.events e on e.id = a.event_id
        where e.owner = me and a.joined_at >= p_start
        group by a.event_id
      ) t
    )
  ) into out;
  return out;
end $$;
grant execute on function public.my_usage() to authenticated;

-- ---------- the owners set plans by hand, for now ----------
-- months = 0 leaves the plan open-ended; 'free' ends whatever was there.
create or replace function public.admin_set_plan(p_user uuid, p_plan text, p_months int default 1, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ends timestamptz;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if p_plan not in ('free', 'plus', 'pro', 'institution') then raise exception 'no such plan'; end if;
  if p_plan = 'free' then
    update public.plans set status = 'ended', updated_at = now(), note = coalesce(p_note, note) where user_id = p_user;
    return jsonb_build_object('plan', 'free');
  end if;
  ends := case when p_months > 0 then now() + make_interval(months => p_months) else null end;
  insert into public.plans (user_id, plan, status, period_start, period_end, source, note, updated_at)
  values (p_user, p_plan, 'active', now(), ends, 'manual', p_note, now())
  on conflict (user_id) do update set
    plan = excluded.plan, status = 'active', period_start = now(), period_end = excluded.period_end,
    source = 'manual', note = coalesce(excluded.note, public.plans.note), updated_at = now();
  return jsonb_build_object('plan', p_plan, 'ends', ends);
end $$;
grant execute on function public.admin_set_plan(uuid, text, int, text) to authenticated;

-- Plans across the whole system: how many on each, who pays, who is about to lapse.
create or replace function public.admin_plans()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select jsonb_build_object(
    'counts', (
      select jsonb_build_object(
        'free', (select count(*) from auth.users) - (select count(*) from public.plans where status = 'active' and (period_end is null or period_end > now())),
        'plus', (select count(*) from public.plans where plan = 'plus' and status = 'active' and (period_end is null or period_end > now())),
        'pro', (select count(*) from public.plans where plan = 'pro' and status = 'active' and (period_end is null or period_end > now())),
        'institution', (select count(*) from public.plans where plan = 'institution' and status = 'active' and (period_end is null or period_end > now()))
      )
    ),
    'paid', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.user_id, 'email', u.email, 'plan', p.plan, 'status', p.status,
        'since', p.period_start, 'ends', p.period_end, 'source', p.source, 'note', p.note,
        'active', (p.status = 'active' and (p.period_end is null or p.period_end > now()))
      ) order by p.updated_at desc), '[]'::jsonb)
      from public.plans p left join auth.users u on u.id = p.user_id
    ),
    'lapsing', (
      select count(*) from public.plans
      where status = 'active' and period_end is not null and period_end between now() and now() + interval '7 days'
    ),
    'new_30d', (select count(*) from public.plans where status = 'active' and period_start >= now() - interval '30 days')
  ) into out;
  return out;
end $$;
grant execute on function public.admin_plans() to authenticated;

-- People, now with their plan and this month's use (replaces the one in admin.sql).
create or replace function public.admin_people(lim int default 60)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb; m timestamptz := date_trunc('month', now());
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;

  with s as (
    select owner, count(*) as sessions,
      coalesce(sum((meta->>'durationMs')::numeric), 0) / 3600000 as hours,
      coalesce(sum((meta->>'durationMs')::numeric) filter (where created_at >= m), 0) / 3600000 as hours_month,
      count(*) filter (where (meta->>'hosted')::boolean is true) as hosted,
      max(updated_at) as last_session
    from public.sessions group by owner
  ),
  u as (
    select user_id, max(at) as last_seen,
      count(*) filter (where name in ('ask', 'ask_overview')) as asks,
      count(*) filter (where name in ('ask', 'ask_overview') and at >= m) as asks_month
    from public.usage_events where user_id is not null group by user_id
  )
  select jsonb_agg(jsonb_build_object(
    'id', au.id,
    'email', au.email,
    'name', coalesce(au.raw_user_meta_data->>'full_name', au.raw_user_meta_data->>'name', ''),
    'joined', au.created_at,
    'last_seen', greatest(coalesce(u.last_seen, au.last_sign_in_at, au.created_at), coalesce(s.last_session, au.created_at)),
    'sessions', coalesce(s.sessions, 0),
    'hours', round(coalesce(s.hours, 0), 1),
    'hours_month', round(coalesce(s.hours_month, 0), 1),
    'hosted', coalesce(s.hosted, 0),
    'asks', coalesce(u.asks, 0),
    'asks_month', coalesce(u.asks_month, 0),
    'plan', public.current_plan(au.id),
    'plan_ends', (select period_end from public.plans p where p.user_id = au.id and p.status = 'active'),
    'admin', exists (select 1 from public.admins a where a.user_id = au.id)
  ) order by greatest(coalesce(u.last_seen, au.last_sign_in_at, au.created_at), coalesce(s.last_session, au.created_at)) desc) into out
  from (select * from auth.users order by created_at desc limit lim) au
  left join s on s.owner = au.id
  left join u on u.user_id = au.id;
  return coalesce(out, '[]'::jsonb);
end $$;
grant execute on function public.admin_people(int) to authenticated;

-- The owners' own list, so admins can be added from the dashboard.
create or replace function public.admin_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', a.user_id, 'email', u.email, 'since', a.added_at) order by a.added_at), '[]'::jsonb)
  into out from public.admins a left join auth.users u on u.id = a.user_id;
  return out;
end $$;
grant execute on function public.admin_list() to authenticated;

create or replace function public.admin_grant(p_email text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then raise exception 'no account has that address'; end if;
  if p_on then
    insert into public.admins (user_id) values (uid) on conflict do nothing;
  else
    if uid = auth.uid() then raise exception 'you cannot remove yourself'; end if;
    delete from public.admins where user_id = uid;
  end if;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.admin_grant(text, boolean) to authenticated;
