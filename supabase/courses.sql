-- Sitca: courses.
-- Run once in the Supabase SQL editor, after wave9.sql and hardening.sql. Safe to run again.
--
-- A course is a space of kind 'course' with its own members and its own
-- invitation link. A lecturer makes one, shares the link, and records into
-- it; a student opens the link, joins with the address the organisation
-- allows, and sees that course alone: its sessions, its materials, and
-- Sitca answering from all of it. The organisation's owner and leads still
-- see every space; a member sees only the courses they are in.

-- ---------- what a course carries ----------
alter table public.org_spaces add column if not exists code text;
alter table public.org_spaces add column if not exists live_event_id text;
alter table public.org_spaces add column if not exists live_url text;
alter table public.org_spaces add column if not exists live_at timestamptz;
create unique index if not exists org_spaces_code_idx on public.org_spaces (code) where code is not null;

-- an organisation may insist on an address: 'students.cavendish.ac.ug', 'cavendish.ac.ug'
alter table public.organizations add column if not exists domains text[] not null default '{}';
-- who may make courses: leads (lecturers) or the owner alone
alter table public.organizations add column if not exists courses_by text not null default 'leads';

create table if not exists public.space_members (
  space_id text not null references public.org_spaces(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('lecturer', 'student')),
  name text not null default '',
  email text not null default '',
  joined_at timestamptz not null default now(),
  primary key (space_id, user_id)
);
alter table public.space_members enable row level security;

-- a course a person no longer teaches, folded away on their side only
create table if not exists public.space_hidden (
  space_id text not null references public.org_spaces(id) on delete cascade,
  user_id uuid not null,
  primary key (space_id, user_id)
);
alter table public.space_hidden enable row level security;
drop policy if exists "hidden own" on public.space_hidden;
create policy "hidden own" on public.space_hidden
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- a readable code for every course that lacks one
create or replace function public.sitka_course_code() returns text
language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (floor(random() * 32))::int + 1, 1), '')
  from generate_series(1, 8);
$$;
update public.org_spaces set code = public.sitka_course_code() where code is null;

-- ---------- who may see a space ----------
create or replace function public.sitka_can_see_space(p_space text)
returns boolean language sql security definer stable as $$
  select public.sitka_is_lead(public.sitka_space_org(p_space))
      or exists (select 1 from public.space_members where space_id = p_space and user_id = auth.uid());
$$;

drop policy if exists "spaces read by members" on public.org_spaces;
create policy "spaces read by members" on public.org_spaces
  for select to authenticated using (public.sitka_can_see_space(id));

drop policy if exists "materials read by members" on public.org_materials;
create policy "materials read by members" on public.org_materials
  for select to authenticated using (public.sitka_can_see_space(space_id));

drop policy if exists "space members read" on public.space_members;
create policy "space members read" on public.space_members
  for select to authenticated using (public.sitka_can_see_space(space_id));
drop policy if exists "space members leave" on public.space_members;
create policy "space members leave" on public.space_members
  for delete to authenticated using (user_id = auth.uid() or public.sitka_is_lead(public.sitka_space_org(space_id)));

create or replace function public.sitka_space_sessions(p_space text)
returns table (id text, meta jsonb, created_at timestamptz)
language sql security definer stable as $$
  select s.id, s.meta, s.created_at
  from public.sessions s
  where s.space_id = p_space
    and public.sitka_can_see_space(p_space)
  order by s.created_at desc;
$$;

create or replace function public.sitka_space_session(p_id text)
returns table (id text, owner uuid, meta jsonb, transcript jsonb, notes jsonb, study jsonb, slides jsonb)
language sql security definer stable as $$
  select s.id, s.owner, s.meta, s.transcript, s.notes, s.study, s.slides
  from public.sessions s
  where s.id = p_id
    and s.space_id is not null
    and public.sitka_can_see_space(s.space_id);
$$;

-- ---------- making a course ----------
create or replace function public.sitka_create_course(p_org text, p_name text, p_description text default '')
returns public.org_spaces language plpgsql security definer as $$
declare
  o public.organizations;
  sp public.org_spaces;
  n text; e text;
begin
  select * into o from public.organizations where id = p_org;
  if o.id is null then raise exception 'No such organisation.'; end if;
  if not (public.sitka_is_lead(p_org) and (o.courses_by = 'leads' or o.owner = auth.uid())) then
    raise exception 'Only the organisation''s lecturers may make a course.';
  end if;
  if char_length(trim(p_name)) < 2 then raise exception 'Give the course a name.'; end if;
  insert into public.org_spaces (id, org_id, name, kind, description, created_by, code)
  values (gen_random_uuid()::text, p_org, trim(p_name), 'course', coalesce(p_description, ''), auth.uid(), public.sitka_course_code())
  returning * into sp;
  select coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', split_part(email, '@', 1)), email
    into n, e from auth.users where id = auth.uid();
  insert into public.space_members (space_id, user_id, role, name, email)
  values (sp.id, auth.uid(), 'lecturer', coalesce(n, ''), coalesce(e, ''))
  on conflict do nothing;
  return sp;
end $$;
grant execute on function public.sitka_create_course(text, text, text) to authenticated;

-- ---------- the invitation: what a link says before anyone signs in ----------
create or replace function public.sitka_course_preview(p_code text)
returns jsonb language sql security definer stable as $$
  select jsonb_build_object(
    'course', sp.name,
    'org', o.name,
    'kind', o.kind,
    'domains', o.domains,
    'lecturers', (select coalesce(jsonb_agg(m.name) filter (where m.name <> ''), '[]'::jsonb) from public.space_members m where m.space_id = sp.id and m.role = 'lecturer')
  )
  from public.org_spaces sp join public.organizations o on o.id = sp.org_id
  where sp.code = upper(trim(p_code));
$$;
grant execute on function public.sitka_course_preview(text) to anon, authenticated;

-- ---------- joining by the link ----------
create or replace function public.sitka_join_course(p_code text)
returns jsonb language plpgsql security definer as $$
declare
  sp public.org_spaces;
  o public.organizations;
  n text; e text; d text; ok boolean := false; r text;
begin
  select * into sp from public.org_spaces where code = upper(trim(p_code));
  if sp.id is null then raise exception 'No course has that link.'; end if;
  select * into o from public.organizations where id = sp.org_id;
  select coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', split_part(email, '@', 1)), lower(email)
    into n, e from auth.users where id = auth.uid();
  if coalesce(array_length(o.domains, 1), 0) > 0 then
    foreach d in array o.domains loop
      if e like '%@' || lower(d) or e like '%.' || lower(d) then ok := true; end if;
    end loop;
    if not ok and not public.sitka_is_lead(o.id) then
      raise exception 'This course is for % addresses. Sign in with your % email.', array_to_string(o.domains, ' or '), o.name;
    end if;
  end if;
  insert into public.org_members (org_id, user_id, role, name, email)
  values (o.id, auth.uid(), 'member', coalesce(n, ''), coalesce(e, ''))
  on conflict (org_id, user_id) do nothing;
  r := case when public.sitka_is_lead(o.id) then 'lecturer' else 'student' end;
  insert into public.space_members (space_id, user_id, role, name, email)
  values (sp.id, auth.uid(), r, coalesce(n, ''), coalesce(e, ''))
  on conflict (space_id, user_id) do nothing;
  return jsonb_build_object('spaceId', sp.id, 'orgId', o.id, 'course', sp.name, 'org', o.name, 'role', r);
end $$;
grant execute on function public.sitka_join_course(text) to authenticated;

-- ---------- my courses, for the picker and the home page ----------
create or replace function public.sitka_my_courses()
returns jsonb language sql security definer stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', sp.id, 'orgId', sp.org_id, 'org', o.name, 'orgKind', o.kind,
    'name', sp.name, 'kind', sp.kind, 'code', sp.code,
    'role', coalesce((select m.role from public.space_members m where m.space_id = sp.id and m.user_id = auth.uid()),
                     case when public.sitka_is_lead(sp.org_id) then 'lecturer' else 'student' end),
    'hidden', exists (select 1 from public.space_hidden h where h.space_id = sp.id and h.user_id = auth.uid()),
    'members', (select count(*) from public.space_members m where m.space_id = sp.id),
    'sessions', (select count(*) from public.sessions s where s.space_id = sp.id),
    'liveEventId', sp.live_event_id, 'liveUrl', sp.live_url, 'liveAt', sp.live_at
  ) order by sp.created_at desc), '[]'::jsonb)
  from public.org_spaces sp join public.organizations o on o.id = sp.org_id
  where sp.kind = 'course' and public.sitka_can_see_space(sp.id);
$$;
grant execute on function public.sitka_my_courses() to authenticated;

create or replace function public.sitka_hide_course(p_space text, p_hidden boolean)
returns void language plpgsql security definer as $$
begin
  if p_hidden then
    insert into public.space_hidden (space_id, user_id) values (p_space, auth.uid()) on conflict do nothing;
  else
    delete from public.space_hidden where space_id = p_space and user_id = auth.uid();
  end if;
end $$;
grant execute on function public.sitka_hide_course(text, boolean) to authenticated;

-- the lecturer's page says the course is live, and where the room is
create or replace function public.sitka_course_live(p_space text, p_event text, p_url text)
returns void language plpgsql security definer as $$
begin
  if not public.sitka_can_see_space(p_space) then raise exception 'not allowed'; end if;
  update public.org_spaces
  set live_event_id = p_event, live_url = p_url, live_at = case when p_event is null then null else now() end
  where id = p_space;
end $$;
grant execute on function public.sitka_course_live(text, text, text) to authenticated;

-- the organisation's rules, set by its owner
create or replace function public.sitka_org_rules(p_org text, p_domains text[], p_courses_by text)
returns void language plpgsql security definer as $$
begin
  if not exists (select 1 from public.organizations where id = p_org and owner = auth.uid()) then
    raise exception 'Only the organisation''s owner may change this.';
  end if;
  update public.organizations
  set domains = coalesce(p_domains, '{}'), courses_by = case when p_courses_by = 'owner' then 'owner' else 'leads' end
  where id = p_org;
end $$;
grant execute on function public.sitka_org_rules(text, text[], text) to authenticated;
