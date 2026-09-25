-- Sitca: a shared recap opens for anyone with its link, and for nothing else.
-- Run in the Supabase SQL editor after keeplive.sql. Safe to run again.
-- Deploy the website that reads recaps through sitka_recap() first; it falls
-- back to the old table read until this script has run.
--
-- A recap link still works for anyone who has it, signed in or not. What
-- this closes is everything around the link:
--   * nobody can list recaps: a recap is read one at a time, by its id;
--   * a recap, or an event replay, can only point at a session its author
--     owns, so nobody can "share" someone else's recording;
--   * the recording a shared link opens is checked against the owner's own
--     folder, not just the session id;
--   * deleting a session takes its recap and its event replay with it, and
--     every "kept" copy of the recap goes too (saved_recaps cascades).
--
-- Before running, look at what is already there. Each row below is a recap
-- or an event replay that points at a session its owner does not have. The
-- desktop app's recaps (owner 00000000-…) are expected here: their sessions
-- live on a computer, not in this database, and their text stays readable.
-- Anything else deserves a look before it is left in place.
--
--   select 'recap' as what, r.id, r.owner, r.title, r.created_at
--   from public.recaps r
--   where not exists (select 1 from public.sessions s where s.id = r.id and s.owner = r.owner)
--   union all
--   select 'event', e.id, e.owner, e.title, e.updated_at
--   from public.events e
--   where e.session_id is not null
--     and not exists (select 1 from public.sessions s where s.id = e.session_id and s.owner = e.owner);

-- ---------- 1. one recap, by its id ----------
-- The public page, the link preview and "keep this recap" all read through
-- this. It answers only for a recap that is on, and only the one asked for.
create or replace function public.sitka_recap(p_id text)
returns jsonb language sql security definer stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id,
    'owner', r.owner,
    'title', r.title,
    'summary', r.summary,
    'highlights', r.highlights,
    'notes', r.notes,
    'transcript', r.transcript,
    'duration_ms', r.duration_ms,
    'session_at', r.session_at,
    'enabled', r.enabled,
    'has_recording', r.has_recording,
    'thumb', r.thumb
  )
  from public.recaps r
  where r.id = p_id and r.enabled;
$$;
revoke execute on function public.sitka_recap(text) from public;
grant execute on function public.sitka_recap(text) to anon, authenticated;

-- The table itself is no longer readable by everyone. Owners still manage
-- theirs ("recaps owner all"), and someone who kept a recap still reads it
-- from their library.
drop policy if exists "recaps public read" on public.recaps;
drop policy if exists "recaps kept read" on public.recaps;
create policy "recaps kept read" on public.recaps
  for select to authenticated
  using (
    enabled
    and exists (
      select 1 from public.saved_recaps k
      where k.recap_id = recaps.id and k.user_id = (select auth.uid())
    )
  );

-- ---------- 2. whose recording a shared session is ----------
-- The owner of a session that is shared (its recap is on, or its event
-- replay is on), and only when that owner really owns the session. Storage
-- compares this with the folder it is asked to open.
create or replace function public.sitka_shared_owner(p_session text)
returns uuid language sql security definer stable set search_path = '' as $$
  select x.owner from (
    select r.owner
    from public.recaps r
    join public.sessions s on s.id = r.id and s.owner = r.owner
    where r.id = p_session and r.enabled
    union all
    select e.owner
    from public.events e
    join public.sessions s on s.id = e.session_id and s.owner = e.owner
    where e.session_id = p_session and coalesce(e.replay->>'enabled', 'false') = 'true'
  ) x
  limit 1;
$$;
revoke execute on function public.sitka_shared_owner(text) from public;
grant execute on function public.sitka_shared_owner(text) to anon, authenticated;

-- Recordings still in Supabase storage (made before the move to Cloudflare):
-- the same rule, by folder. <owner>/<session>/part-N.webm or <owner>/<session>.webm
drop policy if exists "recordings replay read" on storage.objects;
create policy "recordings replay read" on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'recordings'
    and split_part(name, '/', 1) =
      public.sitka_shared_owner(regexp_replace(split_part(name, '/', 2), '\.webm$', ''))::text
  );

-- ---------- 3. only your own session can be shared ----------
-- Signed-in writes only. The desktop app and the scripts write with the
-- service key (no auth.uid()) and are left as they are.
create or replace function public.sitka_recap_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'UPDATE' and (new.id <> old.id or new.owner <> old.owner) then
    raise exception 'A recap keeps its session and its owner.';
  end if;
  if not exists (select 1 from public.sessions s where s.id = new.id and s.owner = auth.uid()) then
    raise exception 'Only the person who recorded a session can share it.';
  end if;
  return new;
end $$;
drop trigger if exists recaps_own_session on public.recaps;
create trigger recaps_own_session
  before insert or update on public.recaps
  for each row execute function public.sitka_recap_guard();

create or replace function public.sitka_event_session_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or new.session_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.session_id is not distinct from old.session_id then return new; end if;
  if not exists (select 1 from public.sessions s where s.id = new.session_id and s.owner = auth.uid()) then
    raise exception 'An event can only play a session its host recorded.';
  end if;
  return new;
end $$;
drop trigger if exists events_own_session on public.events;
create trigger events_own_session
  before insert or update of session_id on public.events
  for each row execute function public.sitka_event_session_guard();

-- ---------- 4. a deleted session takes its shares with it ----------
create or replace function public.sitka_session_gone()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.recaps where id = old.id and owner = old.owner;
  update public.events
     set replay = coalesce(replay, '{}'::jsonb) || '{"enabled": false}'::jsonb,
         updated_at = now()
   where session_id = old.id and owner = old.owner
     and coalesce(replay->>'enabled', 'false') = 'true';
  return old;
end $$;
drop trigger if exists sessions_take_shares on public.sessions;
create trigger sessions_take_shares
  after delete on public.sessions
  for each row execute function public.sitka_session_gone();

-- ---------- 5. the lookups these make ----------
create index if not exists events_session_idx on public.events (session_id) where session_id is not null;
create index if not exists recaps_owner_idx on public.recaps (owner);
create index if not exists sessions_owner_idx on public.sessions (owner);
