-- Sitca hardening, part 4: the "stage" and "replays" storage buckets.
--
-- Run after 20260925_03_events.sql. Safe to run more than once. No file is
-- moved or deleted, and every picture link that works today keeps working.
--
-- Both buckets are public: a file opens by its link, for anyone, with no
-- rule needed. What was wrong were the rules for changing them: any signed-in
-- person could replace or delete any host's live screen, banner or replay,
-- and anyone could list both buckets. Now:
--   * a file is changed only by the host its name belongs to:
--       stage/<event id>.jpg              the live screen    -> that event's host
--       stage/<event id>-banner.jpg       an event's banner  -> that event's host
--       stage/session-<id>-banner.jpg     a session's banner -> that session's owner
--       replays/<event id>.webm           an older replay    -> that event's host
--   * nobody lists the buckets; files still open by their links;
--   * the stage takes pictures only, up to 5 MB each.

create or replace function public.sitka_owns_event(p_event text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.events e where e.id = p_event and e.owner = (select auth.uid()));
$$;

create or replace function public.sitka_owns_session(p_session text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.sessions s where s.id = p_session and s.owner = (select auth.uid()));
$$;

-- Does this stage or replay file belong to the caller, by its name?
create or replace function public.sitka_public_file_mine(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when (select auth.uid()) is null or p_name is null or position('/' in p_name) > 0 then false
    when p_bucket = 'stage' and p_name ~ '^session-.+-banner\.jpg$'
      then public.sitka_owns_session(substring(p_name from '^session-(.+)-banner\.jpg$'))
    when p_bucket = 'stage' and p_name ~ '^.+-banner\.jpg$'
      then public.sitka_owns_event(substring(p_name from '^(.+)-banner\.jpg$'))
    when p_bucket = 'stage' and p_name ~ '^.+\.jpg$'
      then public.sitka_owns_event(substring(p_name from '^(.+)\.jpg$'))
    when p_bucket = 'replays' and p_name ~ '^.+\.webm$'
      then public.sitka_owns_event(substring(p_name from '^(.+)\.webm$'))
    else false
  end;
$$;

-- every rule on these two buckets, whatever it was called, is replaced
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (coalesce(qual, '') ~ '''(stage|replays)''' or coalesce(with_check, '') ~ '''(stage|replays)''')
  loop
    execute format('drop policy %I on storage.objects', p.policyname);
  end loop;
end $$;

-- (the "select" rule is what lets the owner replace a file in place)
create policy "stage and replays owner select" on storage.objects
  for select to authenticated
  using (bucket_id in ('stage', 'replays') and public.sitka_public_file_mine(bucket_id, name));
create policy "stage and replays owner insert" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('stage', 'replays') and public.sitka_public_file_mine(bucket_id, name));
create policy "stage and replays owner update" on storage.objects
  for update to authenticated
  using (bucket_id in ('stage', 'replays') and public.sitka_public_file_mine(bucket_id, name))
  with check (bucket_id in ('stage', 'replays') and public.sitka_public_file_mine(bucket_id, name));
create policy "stage and replays owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id in ('stage', 'replays') and public.sitka_public_file_mine(bucket_id, name));

-- what the stage takes
update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'stage';
update storage.buckets
   set allowed_mime_types = array['video/webm', 'audio/webm', 'video/mp4', 'audio/mp4']
 where id = 'replays';
