-- Sitka wave 9: Organisations — a university or a company, with spaces inside
-- (courses, teams, projects). Members join with a code. Session content is
-- shared with a space's members through functions that never expose the
-- owner's private chat or recording. Run AFTER the previous scripts.

create table if not exists public.organizations (
  id text primary key,
  name text not null,
  kind text not null check (kind in ('business','education')),
  owner uuid not null,
  code text not null unique,
  lead_code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.org_members (
  org_id text not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner','lead','member')),
  name text not null default '',
  email text not null default '',
  joined_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table if not exists public.org_spaces (
  id text primary key,
  org_id text not null references public.organizations(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('course','team','project')),
  description text not null default '',
  created_by uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists public.org_materials (
  id text primary key,
  space_id text not null references public.org_spaces(id) on delete cascade,
  name text not null,
  text text not null,
  chars int not null default 0,
  added_by uuid not null,
  added_by_name text not null default '',
  created_at timestamptz not null default now()
);

alter table public.sessions add column if not exists space_id text;
create index if not exists sessions_space_idx on public.sessions (space_id);

-- ---------- helpers ----------

create or replace function public.sitka_is_member(p_org text)
returns boolean language sql security definer stable as $$
  select exists (select 1 from public.org_members where org_id = p_org and user_id = auth.uid());
$$;

create or replace function public.sitka_is_lead(p_org text)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.org_members
    where org_id = p_org and user_id = auth.uid() and role in ('owner','lead')
  );
$$;

create or replace function public.sitka_space_org(p_space text)
returns text language sql security definer stable as $$
  select org_id from public.org_spaces where id = p_space;
$$;

-- ---------- row security ----------

alter table public.organizations enable row level security;
alter table public.org_members enable row level security;
alter table public.org_spaces enable row level security;
alter table public.org_materials enable row level security;

create policy "org read by members" on public.organizations
  for select to authenticated using (public.sitka_is_member(id));
create policy "org create" on public.organizations
  for insert to authenticated with check (owner = auth.uid());
create policy "org owner update" on public.organizations
  for update to authenticated using (owner = auth.uid());
create policy "org owner delete" on public.organizations
  for delete to authenticated using (owner = auth.uid());

create policy "members read by members" on public.org_members
  for select to authenticated using (public.sitka_is_member(org_id));
create policy "members insert self" on public.org_members
  for insert to authenticated with check (user_id = auth.uid());
create policy "members leave or owner removes" on public.org_members
  for delete to authenticated using (
    user_id = auth.uid()
    or exists (select 1 from public.organizations o where o.id = org_id and o.owner = auth.uid())
  );

create policy "spaces read by members" on public.org_spaces
  for select to authenticated using (public.sitka_is_member(org_id));
create policy "spaces created by leads" on public.org_spaces
  for insert to authenticated with check (public.sitka_is_lead(org_id) and created_by = auth.uid());
create policy "spaces updated by leads" on public.org_spaces
  for update to authenticated using (public.sitka_is_lead(org_id));
create policy "spaces deleted by leads" on public.org_spaces
  for delete to authenticated using (public.sitka_is_lead(org_id));

create policy "materials read by members" on public.org_materials
  for select to authenticated using (public.sitka_is_member(public.sitka_space_org(space_id)));
create policy "materials added by leads" on public.org_materials
  for insert to authenticated with check (public.sitka_is_lead(public.sitka_space_org(space_id)) and added_by = auth.uid());
create policy "materials removed by leads" on public.org_materials
  for delete to authenticated using (public.sitka_is_lead(public.sitka_space_org(space_id)));

-- ---------- joining with a code ----------

create or replace function public.sitka_join_org(p_code text)
returns public.organizations language plpgsql security definer as $$
declare
  o public.organizations;
  r text;
  n text;
  e text;
begin
  select * into o from public.organizations
    where code = upper(trim(p_code)) or lead_code = upper(trim(p_code));
  if o.id is null then
    raise exception 'No organisation has that code.';
  end if;
  r := case when o.lead_code = upper(trim(p_code)) then 'lead' else 'member' end;
  select coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', split_part(email, '@', 1)), email
    into n, e from auth.users where id = auth.uid();
  insert into public.org_members (org_id, user_id, role, name, email)
    values (o.id, auth.uid(), r, coalesce(n, ''), coalesce(e, ''))
    on conflict (org_id, user_id) do update
      set role = case when excluded.role = 'lead' then 'lead' else public.org_members.role end;
  return o;
end;
$$;

-- ---------- what a space's members may see of its sessions ----------
-- Never the owner's private chat, never the recording.

create or replace function public.sitka_space_sessions(p_space text)
returns table (id text, meta jsonb, created_at timestamptz)
language sql security definer stable as $$
  select s.id, s.meta, s.created_at
  from public.sessions s
  where s.space_id = p_space
    and public.sitka_is_member(public.sitka_space_org(p_space))
  order by s.created_at desc;
$$;

create or replace function public.sitka_space_session(p_id text)
returns table (id text, owner uuid, meta jsonb, transcript jsonb, notes jsonb, study jsonb, slides jsonb)
language sql security definer stable as $$
  select s.id, s.owner, s.meta, s.transcript, s.notes, s.study, s.slides
  from public.sessions s
  where s.id = p_id
    and s.space_id is not null
    and public.sitka_is_member(public.sitka_space_org(s.space_id));
$$;

-- Real counts of how each session landed with its room: "lost me" taps and
-- private questions, from hosted events (sessions with an event id).
create or replace function public.sitka_space_insights(p_space text)
returns table (session_id text, meta jsonb, created_at timestamptz, lost bigint, asks bigint, questions jsonb)
language sql security definer stable as $$
  select s.id, s.meta, s.created_at,
    (select count(*) from public.reactions r where r.event_id = s.meta->>'eventId' and r.kind = 'lost'),
    (select count(*) from public.asks a where a.event_id = s.meta->>'eventId' and a.kind = 'ask'),
    (select coalesce(jsonb_agg(q.question order by q.created_at desc), '[]'::jsonb)
       from (select question, created_at from public.asks a
             where a.event_id = s.meta->>'eventId' and a.kind = 'ask'
             order by created_at desc limit 40) q)
  from public.sessions s
  where s.space_id = p_space
    and public.sitka_is_lead(public.sitka_space_org(p_space))
  order by s.created_at desc;
$$;
