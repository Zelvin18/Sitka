-- Sitca hardening, part 2: organisations and courses.
--
-- Run after 20260925_01_rate_limits.sql, in the Supabase SQL editor. Safe to
-- run more than once. No row is deleted and no invitation that works today
-- stops working: existing codes keep opening their organisation and course.
--
-- What changes:
--   * nobody can make themselves an organisation's owner or lead: a
--     membership is only ever written by the functions below, which set the
--     role themselves (the one exception: the owner's own row, when they
--     create the organisation);
--   * invitation codes are made by the database (12 characters from its own
--     randomness), are hidden from everyone but the people who may hand them
--     out, and guessing them is slowed down;
--   * a member sees their own membership; the owner and leads see the roster;
--   * deleting an organisation moves it to a 30-day bin instead of erasing
--     its courses, chats and materials at once;
--   * a course's "live now" link can only be set by its lecturers, to one of
--     their own events; a session can only be filed into a space its owner
--     belongs to; a space's insights count only its own events' questions.

do $$ begin
  if to_regprocedure('public.sitka_rate_hit(text,integer,integer)') is null then
    raise exception 'Run supabase/migrations/20260925_01_rate_limits.sql first.';
  end if;
end $$;

-- a number from a value a browser wrote: anything that is not one counts as 0
create or replace function public.sitka_num(p text)
returns numeric language sql immutable set search_path = '' as $$
  select case when p ~ '^\s*-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?\s*$' then p::numeric else 0 end;
$$;

-- ---------- codes from the database's own randomness ----------
-- 12 characters from a 32-letter alphabet (60 bits): not guessable, and
-- still easy to read out and type. No I, O, 0 or 1.
create or replace function public.sitka_new_code(p_len int default 12)
returns text language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  out_code text := '';
  b bytea;
  i int;
begin
  while length(out_code) < p_len loop
    b := uuid_send(gen_random_uuid());
    for i in 0..15 loop
      -- bytes 6 and 8 carry the uuid's fixed version and variant bits
      continue when i in (6, 8);
      exit when length(out_code) >= p_len;
      out_code := out_code || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
    end loop;
  end loop;
  return out_code;
end $$;

-- courses made from now on get the long codes too (existing ones keep theirs)
create or replace function public.sitka_course_code() returns text
language sql volatile set search_path = '' as $$
  select public.sitka_new_code(12);
$$;

-- ---------- the bin ----------
alter table public.organizations add column if not exists deleted_at timestamptz;

-- membership and leadership ignore an organisation in the bin
create or replace function public.sitka_is_member(p_org text)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.org_members m
    join public.organizations o on o.id = m.org_id and o.deleted_at is null
    where m.org_id = p_org and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.sitka_is_lead(p_org text)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.org_members m
    join public.organizations o on o.id = m.org_id and o.deleted_at is null
    where m.org_id = p_org and m.user_id = (select auth.uid()) and m.role in ('owner', 'lead')
  );
$$;

-- is the caller this organisation's owner (in the bin or not)?
create or replace function public.sitka_owns_org(p_org text)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.organizations o where o.id = p_org and o.owner = (select auth.uid()));
$$;

-- ---------- an organisation is made with server codes, at most five each ----------
-- Runs as the caller (not security definer), so current_user tells a browser
-- write ('authenticated') from one of the functions below ('postgres').
create or replace function public.sitka_org_insert_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is not null then
    if new.owner is distinct from (select auth.uid()) then
      raise exception 'An organisation is made by its owner.';
    end if;
    if public.sitka_org_count() >= 5 then
      raise exception 'You have set up five organisations, the most for now.';
    end if;
  end if;
  new.code := public.sitka_new_code(12);
  new.lead_code := public.sitka_new_code(12);
  new.deleted_at := null;
  return new;
end $$;

-- how many organisations the caller owns (their own count only)
drop function if exists public.sitka_org_count(uuid);
create or replace function public.sitka_org_count()
returns int language sql security definer stable set search_path = '' as $$
  select count(*)::int from public.organizations where owner = (select auth.uid()) and deleted_at is null;
$$;

drop trigger if exists organizations_insert_guard on public.organizations;
create trigger organizations_insert_guard
  before insert on public.organizations
  for each row execute function public.sitka_org_insert_guard();

-- ---------- who may read and write the organisation's row ----------
-- The row is read by its members, but the two codes are not among the
-- columns anyone may read directly: the owner and leads get them from
-- sitka_my_orgs() and sitka_org_overview(). Changes go through the functions.
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'organizations' loop
    execute format('drop policy %I on public.organizations', p.policyname);
  end loop;
end $$;
create policy "org read by members" on public.organizations
  for select to authenticated using (public.sitka_is_member(id) or public.sitka_owns_org(id));
create policy "org create" on public.organizations
  for insert to authenticated with check (owner = (select auth.uid()));

revoke all on public.organizations from anon, authenticated;
grant select (id, name, kind, owner, created_at, domains, courses_by, deleted_at) on public.organizations to authenticated;
-- the codes may be sent (older pages do) but are always replaced by the trigger
grant insert (id, name, kind, owner, code, lead_code) on public.organizations to authenticated;

-- ---------- memberships ----------
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'org_members' loop
    execute format('drop policy %I on public.org_members', p.policyname);
  end loop;
end $$;
-- a member sees their own row; the owner and leads see everyone
create policy "members read own or as lead" on public.org_members
  for select to authenticated using (user_id = (select auth.uid()) or public.sitka_is_lead(org_id));
-- the only row anyone writes directly: the owner's own, in the organisation they just made
create policy "owner row on creation" on public.org_members
  for insert to authenticated with check (
    user_id = (select auth.uid()) and role = 'owner' and public.sitka_owns_org(org_id)
  );
-- a member leaves; the owner removes others (never themselves)
create policy "members leave or owner removes" on public.org_members
  for delete to authenticated using (
    (user_id = (select auth.uid()) and role <> 'owner')
    or (public.sitka_owns_org(org_id) and user_id <> (select auth.uid()))
  );
revoke update on public.org_members from anon, authenticated;
revoke all on public.org_members from anon;

-- ---------- course rosters: a student sees their own row; lecturers and leads see all ----------
create or replace function public.sitka_teaches(p_space text)
returns boolean language sql security definer stable set search_path = '' as $$
  select public.sitka_is_lead(public.sitka_space_org(p_space))
      or exists (
        select 1 from public.space_members m
        where m.space_id = p_space and m.user_id = (select auth.uid()) and m.role = 'lecturer'
      );
$$;
drop policy if exists "space members read" on public.space_members;
create policy "space members read" on public.space_members
  for select to authenticated using (user_id = (select auth.uid()) or public.sitka_teaches(space_id));
revoke all on public.space_members from anon;

-- a space's own settings (its code, its live link) change only through the functions
revoke update on public.org_spaces from anon, authenticated;
revoke all on public.org_spaces from anon;

-- the space-to-organisation lookup ignores spaces of an organisation in the bin
create or replace function public.sitka_space_org(p_space text)
returns text language sql security definer stable set search_path = '' as $$
  select s.org_id from public.org_spaces s
  join public.organizations o on o.id = s.org_id and o.deleted_at is null
  where s.id = p_space;
$$;

-- and nobody sees a space of an organisation in the bin, students included
create or replace function public.sitka_can_see_space(p_space text)
returns boolean language sql security definer stable set search_path = '' as $$
  select public.sitka_space_org(p_space) is not null
     and (public.sitka_is_lead(public.sitka_space_org(p_space))
          or exists (select 1 from public.space_members where space_id = p_space and user_id = (select auth.uid())));
$$;

-- ---------- making, listing, joining, deleting ----------
create or replace function public.sitka_create_org(p_name text, p_kind text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  new_id text := gen_random_uuid()::text;
  n text;
  e text;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Give the organisation a name.'; end if;
  if p_kind not in ('business', 'education') then raise exception 'An organisation is a business or a place of education.'; end if;
  insert into public.organizations (id, name, kind, owner, code, lead_code)
  values (new_id, left(trim(p_name), 120), p_kind, me, 'x', 'x'); -- the trigger writes the real codes
  select coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(u.email, '@', 1)), u.email
    into n, e from auth.users u where u.id = me;
  insert into public.org_members (org_id, user_id, role, name, email)
  values (new_id, me, 'owner', coalesce(n, ''), coalesce(e, ''))
  on conflict (org_id, user_id) do update set role = 'owner';
  return jsonb_build_object('id', new_id);
end $$;

-- My organisations, as the app shows them: the member code to the owner and
-- leads, the lead code to the owner alone, counts without the roster.
create or replace function public.sitka_my_orgs()
returns jsonb language sql security definer stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', o.id,
    'name', o.name,
    'kind', o.kind,
    'role', m.role,
    'code', case when m.role in ('owner', 'lead') then o.code end,
    'leadCode', case when m.role = 'owner' then o.lead_code end,
    'domains', to_jsonb(o.domains),
    'coursesBy', o.courses_by,
    'members', (select count(*) from public.org_members x where x.org_id = o.id),
    'spaces', (select count(*) from public.org_spaces s where s.org_id = o.id),
    'createdAt', o.created_at
  ) order by o.created_at), '[]'::jsonb)
  from public.organizations o
  join public.org_members m on m.org_id = o.id and m.user_id = (select auth.uid())
  where o.deleted_at is null;
$$;

-- Joining with a code. The role comes from which code it was, never from
-- the caller; an owner who uses a code stays the owner. Returns only what
-- the page needs to open the organisation.
drop function if exists public.sitka_join_org(text);
create function public.sitka_join_org(p_code text)
returns table (id text, name text, kind text)
language plpgsql security definer set search_path = '' as $$
declare
  o public.organizations;
  c text := upper(trim(coalesce(p_code, '')));
  r text;
  n text;
  e text;
begin
  if (select auth.uid()) is null then raise exception 'Sign in first.'; end if;
  if public.sitka_rate_hit('join-org:' || (select auth.uid())::text, 10, 60) then
    raise exception 'Too many tries. Wait a few minutes, then try again.';
  end if;
  -- a code that opens nothing returns nothing (the app says so): raising
  -- here would also undo the attempt just counted above
  if char_length(c) < 6 then return; end if;
  select * into o from public.organizations x
   where (x.code = c or x.lead_code = c) and x.deleted_at is null;
  if o.id is null then return; end if;
  r := case when o.lead_code = c then 'lead' else 'member' end;
  select coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(u.email, '@', 1)), u.email
    into n, e from auth.users u where u.id = (select auth.uid());
  insert into public.org_members as m (org_id, user_id, role, name, email)
    values (o.id, (select auth.uid()), r, coalesce(n, ''), coalesce(e, ''))
    on conflict (org_id, user_id) do update
      set role = case when excluded.role = 'lead' and m.role = 'member' then 'lead' else m.role end;
  return query select o.id, o.name, o.kind;
end $$;

-- Deleting an organisation puts it in the bin for 30 days: nobody sees it,
-- nothing in it is erased. The owner may take it back out; after 30 days
-- the nightly clean-up removes it for good.
create or replace function public.sitka_delete_org(p_org text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.organizations where id = p_org and owner = (select auth.uid()) and deleted_at is null) then
    raise exception 'Only the owner can delete an organisation.';
  end if;
  update public.organizations set deleted_at = now() where id = p_org;
end $$;

create or replace function public.sitka_restore_org(p_org text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.organizations where id = p_org and owner = (select auth.uid()) and deleted_at is not null) then
    raise exception 'Only the owner can bring an organisation back.';
  end if;
  update public.organizations set deleted_at = null where id = p_org;
end $$;

-- fresh codes: the database's own, long ones
create or replace function public.sitka_org_new_codes(p_org text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c1 text := public.sitka_new_code(12);
  c2 text := public.sitka_new_code(12);
begin
  if not exists (select 1 from public.organizations where id = p_org and owner = (select auth.uid()) and deleted_at is null) then
    raise exception 'Only the organisation''s owner may change the codes.';
  end if;
  update public.organizations set code = c1, lead_code = c2 where id = p_org;
  return jsonb_build_object('code', c1, 'leadCode', c2);
end $$;

-- ---------- courses: joining is slowed down; the preview too ----------
-- who is asking, for a rate limit: the account, else the address the
-- request came from, else 'anon' (every unknown caller together, so the
-- limits keyed on it are the generous shared ones)
create or replace function public.sitka_caller_key()
returns text language sql stable set search_path = '' as $$
  select coalesce(
    (select auth.uid())::text,
    nullif(trim((nullif(current_setting('request.headers', true), '')::json)->>'cf-connecting-ip'), ''),
    nullif(trim((nullif(current_setting('request.headers', true), '')::json)->>'x-real-ip'), ''),
    nullif(trim(split_part((nullif(current_setting('request.headers', true), '')::json)->>'x-forwarded-for', ',', 1)), ''),
    'anon'
  );
$$;

create or replace function public.sitka_course_preview(p_code text)
returns jsonb language plpgsql security definer stable set search_path = '' as $$
declare out_v jsonb;
begin
  -- a link opened by a class at once shares one address: generous, but not endless
  if public.sitka_rate_hit('course-preview:' || public.sitka_caller_key(),
       case when public.sitka_caller_key() = 'anon' then 1200 else 60 end,
       case when public.sitka_caller_key() = 'anon' then 12000 else 600 end) then
    raise exception 'Too many tries. Wait a few minutes, then try again.';
  end if;
  select jsonb_build_object(
    'course', sp.name,
    'org', o.name,
    'kind', o.kind,
    'domains', o.domains,
    'lecturers', (select coalesce(jsonb_agg(m.name) filter (where m.name <> ''), '[]'::jsonb)
                  from public.space_members m where m.space_id = sp.id and m.role = 'lecturer')
  ) into out_v
  from public.org_spaces sp join public.organizations o on o.id = sp.org_id and o.deleted_at is null
  where sp.code = upper(trim(coalesce(p_code, '')));
  return out_v;
end $$;

create or replace function public.sitka_join_course(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  sp public.org_spaces;
  o public.organizations;
  n text; e text; d text; ok boolean := false; r text;
begin
  if (select auth.uid()) is null then raise exception 'Sign in first.'; end if;
  if public.sitka_rate_hit('join-course:' || (select auth.uid())::text, 10, 60) then
    raise exception 'Too many tries. Wait a few minutes, then try again.';
  end if;
  -- not found is an answer, not an error, so the attempt above stays counted
  select * into sp from public.org_spaces where code = upper(trim(coalesce(p_code, '')));
  if sp.id is null then return jsonb_build_object('error', 'No course has that link.'); end if;
  select * into o from public.organizations where id = sp.org_id and deleted_at is null;
  if o.id is null then return jsonb_build_object('error', 'No course has that link.'); end if;
  select coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', split_part(u.email, '@', 1)), lower(u.email)
    into n, e from auth.users u where u.id = (select auth.uid());
  if coalesce(array_length(o.domains, 1), 0) > 0 then
    foreach d in array o.domains loop
      if e like '%@' || lower(d) or e like '%.' || lower(d) then ok := true; end if;
    end loop;
    if not ok and not public.sitka_is_lead(o.id) then
      raise exception 'This course is for % addresses. Sign in with your % email.', array_to_string(o.domains, ' or '), o.name;
    end if;
  end if;
  insert into public.org_members (org_id, user_id, role, name, email)
  values (o.id, (select auth.uid()), 'member', coalesce(n, ''), coalesce(e, ''))
  on conflict (org_id, user_id) do nothing;
  r := case when public.sitka_is_lead(o.id) then 'lecturer' else 'student' end;
  insert into public.space_members (space_id, user_id, role, name, email)
  values (sp.id, (select auth.uid()), r, coalesce(n, ''), coalesce(e, ''))
  on conflict (space_id, user_id) do nothing;
  return jsonb_build_object('spaceId', sp.id, 'orgId', o.id, 'course', sp.name, 'org', o.name, 'role', r);
end $$;

-- ---------- a course's "live now" link ----------
-- Only its lecturers (or the organisation's leads) set it, only to an event
-- they host, and only to that event's own page on this site.
create or replace function public.sitka_course_live(p_space text, p_event text, p_url text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.sitka_teaches(p_space) then raise exception 'Only the course''s lecturers can do this.'; end if;
  if p_event is null then
    update public.org_spaces set live_event_id = null, live_url = null, live_at = null where id = p_space;
    return;
  end if;
  if not exists (select 1 from public.events e where e.id = p_event and e.owner = (select auth.uid())) then
    raise exception 'That event is not yours.';
  end if;
  if p_url is null or char_length(p_url) > 300
     or right(p_url, char_length(p_event) + 3) <> '/e/' || p_event
     or p_url !~ '^(https://[A-Za-z0-9.-]+(:[0-9]+)?|http://(localhost|127\.0\.0\.1)(:[0-9]+)?)/e/[^/?#[:space:]]+$' then
    raise exception 'A course''s live link is its event''s own page.';
  end if;
  update public.org_spaces set live_event_id = p_event, live_url = p_url, live_at = now() where id = p_space;
end $$;

-- ---------- filing a session into a space ----------
-- Only into a space its owner can see. A filing that is not allowed is
-- simply not made: the session itself is always saved.
create or replace function public.sitka_session_space_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or new.space_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.space_id is not distinct from old.space_id then return new; end if;
  if not public.sitka_can_see_space(new.space_id) then
    new.space_id := case when tg_op = 'UPDATE' then old.space_id else null end;
  end if;
  return new;
end $$;
drop trigger if exists sessions_space_guard on public.sessions;
create trigger sessions_space_guard
  before insert or update of space_id on public.sessions
  for each row execute function public.sitka_session_space_guard();

-- ---------- a space's insights: its own events' questions only ----------
-- A session names its event in meta.eventId; the counts are taken only when
-- that event belongs to the session's owner.
create or replace function public.sitka_space_insights(p_space text)
returns table (session_id text, meta jsonb, created_at timestamptz, lost bigint, asks bigint, questions jsonb)
language sql security definer stable set search_path = '' as $$
  select s.id, s.meta, s.created_at,
    (select count(*) from public.reactions r where r.event_id = ev.id and r.kind = 'lost'),
    (select count(*) from public.asks a where a.event_id = ev.id and a.kind = 'ask'),
    (select coalesce(jsonb_agg(q.question order by q.created_at desc), '[]'::jsonb)
       from (select a.question, a.created_at from public.asks a
             where a.event_id = ev.id and a.kind = 'ask'
             order by a.created_at desc limit 40) q)
  from public.sessions s
  left join public.events ev on ev.id = s.meta->>'eventId' and ev.owner = s.owner
  where s.space_id = p_space
    and public.sitka_is_lead(public.sitka_space_org(p_space))
  order by s.created_at desc;
$$;

-- ---------- the organisation's overview reads the codes from their row ----------
-- (unchanged, but for the bin: an organisation in it has no overview)
create or replace function public.sitka_org_overview(p_org text)
returns jsonb language plpgsql security definer stable set search_path = '' as $$
declare
  o public.organizations;
  p_start timestamptz := date_trunc('month', now());
  out_v jsonb;
begin
  select * into o from public.organizations where id = p_org and deleted_at is null;
  if o.id is null then raise exception 'No such organisation.'; end if;
  if not public.sitka_is_lead(p_org) then raise exception 'Only the organisation''s leads may see this.'; end if;
  select jsonb_build_object(
    'name', o.name,
    'kind', o.kind,
    'owner', o.owner,
    'domains', o.domains,
    'coursesBy', o.courses_by,
    'code', case when o.owner = (select auth.uid()) then o.code else null end,
    'leadCode', case when o.owner = (select auth.uid()) then o.lead_code else null end,
    'month', jsonb_build_object(
      'sessions', (select count(*) from public.sessions s join public.org_members m on m.user_id = s.owner and m.org_id = p_org where s.created_at >= p_start),
      'hours', (select round(coalesce(sum(public.sitka_num(s.meta->>'durationMs')), 0) / 3600000, 1) from public.sessions s join public.org_members m on m.user_id = s.owner and m.org_id = p_org where s.created_at >= p_start),
      'asks', (select count(*) from public.usage_events u join public.org_members m on m.user_id = u.user_id and m.org_id = p_org where u.at >= p_start and u.name in ('ask', 'ask_overview')),
      'active', (select count(distinct u.user_id) from public.usage_events u join public.org_members m on m.user_id = u.user_id and m.org_id = p_org where u.at >= p_start)
    ),
    'members', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'userId', m.user_id, 'name', m.name, 'email', m.email, 'role', m.role, 'joinedAt', m.joined_at,
        'sessions', (select count(*) from public.sessions s where s.owner = m.user_id and s.created_at >= p_start),
        'courses', (select count(*) from public.space_members sm join public.org_spaces sp on sp.id = sm.space_id where sm.user_id = m.user_id and sp.org_id = p_org),
        'lastSeen', (select max(u.at) from public.usage_events u where u.user_id = m.user_id)
      ) order by case m.role when 'owner' then 0 when 'lead' then 1 else 2 end, m.name), '[]'::jsonb)
      from public.org_members m where m.org_id = p_org
    ),
    'courses', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', sp.id, 'name', sp.name, 'kind', sp.kind, 'code', sp.code, 'createdAt', sp.created_at,
        'lecturers', (select coalesce(jsonb_agg(sm.name) filter (where sm.name <> ''), '[]'::jsonb) from public.space_members sm where sm.space_id = sp.id and sm.role = 'lecturer'),
        'students', (select count(*) from public.space_members sm where sm.space_id = sp.id and sm.role = 'student'),
        'sessions', (select count(*) from public.sessions s where s.space_id = sp.id),
        'materials', (select count(*) from public.org_materials om where om.space_id = sp.id),
        'liveUrl', sp.live_url,
        'lastSession', (select max(s.created_at) from public.sessions s where s.space_id = sp.id)
      ) order by sp.created_at desc), '[]'::jsonb)
      from public.org_spaces sp where sp.org_id = p_org
    )
  ) into out_v;
  return out_v;
end $$;
