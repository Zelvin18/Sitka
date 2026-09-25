-- Sitka wave 11: the event recap opens the host's own recording.
-- Run AFTER the previous scripts. Safe to run more than once.
--
-- When a hosted event ends, its recap page (/r/<event id>) is shared with the
-- room straight away. The recording plays from the parts the host's browser
-- already uploaded while recording (bucket "recordings", path
-- <owner>/<session id>/part-NNNN.webm), so nothing is copied or re-uploaded,
-- and deleting the session removes the recording for everyone.
--
-- This policy lets anyone read those parts, but only while the event's recap
-- is switched on. Unpublishing, or deleting the session, closes it again.

drop policy if exists "recordings replay read" on storage.objects;
create policy "recordings replay read" on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'recordings'
    and exists (
      select 1 from public.events e
      where coalesce(e.replay->>'enabled', 'false') = 'true'
        and e.session_id is not null
        and (
          split_part(storage.objects.name, '/', 2) = e.session_id
          or split_part(storage.objects.name, '/', 2) = e.session_id || '.webm'
        )
    )
  );
