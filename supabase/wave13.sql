-- Sitka wave 13: the room can see how many are in it.
-- Run AFTER the previous scripts. Safe to run more than once.
--
-- Attendees are written by anyone with the link but readable only by the
-- host, so the "N here" badge on every phone always read zero. This gives the
-- room the number and nothing else: no names, no languages, no ids.

create or replace function public.attendee_count(eid text)
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::int from public.attendees where event_id = eid
$$;

grant execute on function public.attendee_count(text) to anon, authenticated;
