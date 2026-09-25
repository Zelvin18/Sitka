-- Sitca: keeping a live event you attend.
-- Run once in the Supabase SQL editor, after wave18.sql. Safe to run again.
--
-- Someone with an account who is in a live event may keep it: while it is
-- on, it shows on their Home ("you are in this"); when it ends, the recap is
-- filed in their library without another tap. Someone who decides at the
-- end may keep it then, from the end card.

-- an attendee may be a signed-in person, and may have asked to keep the event
alter table public.attendees add column if not exists user_id uuid;
alter table public.attendees add column if not exists keep boolean not null default false;
create index if not exists attendees_user_idx on public.attendees (user_id) where user_id is not null;

-- ---------- the attendee, signed in, says whether to keep it ----------
create or replace function public.sitka_attend_keep(p_attendee uuid, p_keep boolean)
returns void language plpgsql security definer as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  update public.attendees set user_id = auth.uid(), keep = p_keep where id = p_attendee;
end $$;
grant execute on function public.sitka_attend_keep(uuid, boolean) to authenticated;

-- ---------- the live events this person is in and keeping, for their Home ----------
create or replace function public.sitka_my_live()
returns jsonb language sql security definer stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'startsAt', e.starts_at, 'attendeeId', a.id)), '[]'::jsonb)
  from public.events e
  join public.attendees a on a.event_id = e.id
  where a.user_id = auth.uid() and a.keep and e.status = 'live';
$$;
grant execute on function public.sitka_my_live() to authenticated;

-- ---------- at the end: the recap into every keeper's library ----------
-- Called by the host's app once the session's recap row exists. Only the
-- event's owner may call it; it only ever adds rows for people who asked.
create or replace function public.sitka_event_keep_all(p_event text, p_session text)
returns int language plpgsql security definer as $$
declare
  n int := 0;
begin
  if not exists (select 1 from public.events where id = p_event and owner = auth.uid()) then
    raise exception 'Only the host may do this.';
  end if;
  if not exists (select 1 from public.recaps where id = p_session and enabled) then return 0; end if;
  insert into public.saved_recaps (user_id, recap_id)
  select a.user_id, p_session
  from public.attendees a
  where a.event_id = p_event and a.keep and a.user_id is not null and a.user_id <> auth.uid()
  on conflict (user_id, recap_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function public.sitka_event_keep_all(text, text) to authenticated;

-- ---------- at the end, by the attendee: keep it now ----------
-- {ok: true, sessionId} once the recap is in their library; {ok: false}
-- while the host's recap has not been written yet (asked again in a moment).
create or replace function public.sitka_keep_event(p_event text)
returns jsonb language plpgsql security definer as $$
declare
  sid text;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select session_id into sid from public.events where id = p_event;
  if sid is null then raise exception 'No such event.'; end if;
  if not exists (select 1 from public.recaps where id = sid and enabled) then return jsonb_build_object('ok', false); end if;
  -- the host's own session needs no keeping
  if not exists (select 1 from public.sessions where id = sid and owner = auth.uid()) then
    insert into public.saved_recaps (user_id, recap_id) values (auth.uid(), sid)
    on conflict (user_id, recap_id) do nothing;
  end if;
  return jsonb_build_object('ok', true, 'sessionId', sid);
end $$;
grant execute on function public.sitka_keep_event(text) to authenticated;
