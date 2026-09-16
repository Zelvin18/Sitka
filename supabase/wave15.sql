-- Sitka wave 15: a course or space is deleted by the person who made it.
-- Run AFTER the previous scripts. Safe to run more than once.
--
-- Until now any lead in an organisation could delete any of its spaces. Now
-- only the space's creator, or the organisation's owner, may. Everything else
-- about spaces (reading, creating, updating, materials) is unchanged.

drop policy if exists "spaces deleted by leads" on public.org_spaces;
drop policy if exists "spaces deleted by creator or owner" on public.org_spaces;
create policy "spaces deleted by creator or owner" on public.org_spaces
  for delete to authenticated using (
    created_by = auth.uid()
    or exists (select 1 from public.organizations o where o.id = org_id and o.owner = auth.uid())
  );

-- The host's heartbeat. Both apps touch it every few seconds while an event
-- is live; an attendee's phone that sees it go quiet for minutes knows the
-- host is gone even when the "ended" write never arrived.
alter table public.events add column if not exists host_seen timestamptz;

-- The event's banner: a picture the host chooses when setting the event up,
-- shown on attendees' phones where the video would be when the host presents
-- by voice alone. A public link into the "stage" bucket.
alter table public.events add column if not exists banner text;
