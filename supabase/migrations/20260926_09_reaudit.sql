-- Sitca hardening, part 9: what the second audit found in the database.
--
-- Run after 20260925_08_functions_again.sql. Safe to run more than once.
-- Changes no data a person wrote.
--
-- * Course invitation previews failed every time: the preview function was
--   marked read-only (stable) but notes each try in the rate-limit table,
--   and Postgres refuses a write inside a read-only function.
-- * A deleted session is remembered by the server. A session with that id
--   can never be written again, so a tab or device that still held a copy
--   cannot bring it back, and the site's upload route refuses it links. It
--   also stops anyone re-creating the id to take over its old recap link.
-- * Recaps whose session is gone can be switched off, and those still on
--   are switched off once.
-- * Owner rows written by someone other than the organisation's owner (the
--   hole part 2 closed) are made plain memberships.
-- * A record of which migrations have run, so the live database's state is
--   known rather than guessed. Each migration from this one on writes its
--   own name here as its last statement.

-- ---------- 1. invitation previews work again ----------
alter function public.sitka_course_preview(text) volatile;

-- ---------- 2. a deleted session stays deleted ----------
create table if not exists public.deleted_sessions (
  id text primary key,
  owner uuid not null,
  deleted_at timestamptz not null default now()
);
alter table public.deleted_sessions enable row level security;
revoke all on public.deleted_sessions from anon, authenticated;
-- the owner may see their own (the app asks before writing a row back)
drop policy if exists "deleted sessions own read" on public.deleted_sessions;
create policy "deleted sessions own read" on public.deleted_sessions
  for select to authenticated using (owner = (select auth.uid()));
grant select on public.deleted_sessions to authenticated;

create or replace function public.sitka_session_tombstone()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.deleted_sessions (id, owner) values (old.id, old.owner)
  on conflict (id) do nothing;
  return old;
end $$;
drop trigger if exists sessions_tombstone on public.sessions;
create trigger sessions_tombstone
  after delete on public.sessions
  for each row execute function public.sitka_session_tombstone();

create or replace function public.sitka_session_not_deleted()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.deleted_sessions d where d.id = new.id) then
    raise exception 'This session was deleted.' using errcode = 'P0410';
  end if;
  return new;
end $$;
drop trigger if exists sessions_not_deleted on public.sessions;
create trigger sessions_not_deleted
  before insert on public.sessions
  for each row execute function public.sitka_session_not_deleted();

revoke execute on function public.sitka_session_tombstone() from public, anon, authenticated;
revoke execute on function public.sitka_session_not_deleted() from public, anon, authenticated;

-- ---------- 3. recaps whose session is gone can be switched off ----------
-- The guard refused every change to a recap whose session row was gone,
-- including switching it off. Switching off is always allowed to its owner;
-- and those left on before part 0 took shares with their sessions are
-- switched off here, once.
create or replace function public.sitka_recap_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'UPDATE' and (new.id <> old.id or new.owner <> old.owner) then
    raise exception 'A recap keeps its session and its owner.';
  end if;
  if tg_op = 'UPDATE' and old.owner = auth.uid() and new.enabled is not true then
    return new;
  end if;
  if not exists (select 1 from public.sessions s where s.id = new.id and s.owner = auth.uid()) then
    raise exception 'Only the person who recorded a session can share it.';
  end if;
  return new;
end $$;
update public.recaps r set enabled = false
 where r.enabled
   and not exists (select 1 from public.sessions s where s.id = r.id and s.owner = r.owner);

-- ---------- 4. owners are the organisation's owner, nobody else ----------
-- Before part 2, anyone could write themselves into an organisation as its
-- owner. Such rows are made plain memberships, and the lead check reads an
-- owner row as an owner only for the organisation's real owner.
update public.org_members m set role = 'member'
  from public.organizations o
 where o.id = m.org_id and m.role = 'owner' and m.user_id <> o.owner;
create or replace function public.sitka_is_lead(p_org text)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.org_members m
    join public.organizations o on o.id = m.org_id and o.deleted_at is null
    where m.org_id = p_org and m.user_id = (select auth.uid())
      and (m.role = 'lead' or (m.role = 'owner' and o.owner = m.user_id))
  );
$$;

-- ---------- 5. which migrations have run ----------
create table if not exists public.schema_migrations (
  name text primary key,
  ran_at timestamptz not null default now()
);
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from anon, authenticated;

insert into public.schema_migrations (name) values ('20260926_09_reaudit')
on conflict (name) do update set ran_at = now();
