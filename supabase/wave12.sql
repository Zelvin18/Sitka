-- Sitka wave 12: every shared recap plays the recording.
-- Run AFTER wave11.sql. Safe to run more than once.
--
-- wave11 let readers open the recording parts of an EVENT whose recap is on.
-- This widens the same rule to any SESSION recap the owner has shared
-- (public.recaps, enabled = true), so a recap page shows the video or the
-- audio exactly as it was recorded, straight from the owner's own storage.
-- Nothing is copied. Stop sharing, or delete the session, and it closes.

drop policy if exists "recordings replay read" on storage.objects;
create policy "recordings replay read" on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'recordings'
    and (
      exists (
        select 1 from public.events e
        where coalesce(e.replay->>'enabled', 'false') = 'true'
          and e.session_id is not null
          and (
            split_part(storage.objects.name, '/', 2) = e.session_id
            or split_part(storage.objects.name, '/', 2) = e.session_id || '.webm'
          )
      )
      or exists (
        select 1 from public.recaps r
        where r.enabled = true
          and (
            split_part(storage.objects.name, '/', 2) = r.id
            or split_part(storage.objects.name, '/', 2) = r.id || '.webm'
          )
      )
    )
  );
