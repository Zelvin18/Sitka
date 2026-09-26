-- Sitca hardening, part 11: a live event's room is read by those who were
-- given its link, and nobody else.
--
-- Run after 20260926_10_limits.sql. Safe to run more than once.
--
-- * The captions, translations, room chat, host's notes, polls and shared
--   questions of every open event could be listed by anyone, without the
--   event's link. Visitors now read them only through functions that take
--   one event's id, and the tables themselves are closed to them. Signed-in
--   people read the rows of their own events (the host's screens), not
--   everyone's; who asked a shared question is no longer visible to anyone
--   but the host.
-- * New lines reach the room on a private channel per event, sent by the
--   database itself: a visitor may listen to an open event's channel (knowing
--   its id), and nobody may send on it.
-- * Live video's signalling moves to two private channels: the host sends to
--   the room on rtc:<event>, and only the host; attendees send to the host on
--   rtcup:<event>, which only the host reads. Nobody else can push video to
--   the room, drop it, or collect attendees' ids.
-- * A new attendee must carry a secret. Rows from before secrets existed are
--   trusted only while their event is still on.
--
-- The pages fall back to the older reads and channels until this has run,
-- so the site is deployed first. After it has run, "Allow public access" can
-- be switched off in the Realtime settings.

-- ---------- 1. helpers the rules use ----------
-- (raised rights: the rules run as the visitor, who cannot read the events table)
create or replace function public.sitka_event_live(p_event text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.events e where e.id = p_event and e.status = 'live');
$$;
create or replace function public.sitka_event_mine(p_event text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.events e where e.id = p_event and e.owner = (select auth.uid()));
$$;

-- ---------- 2. reading one event's room ----------
-- The captions and, when asked, one language's translations, after given
-- lines; `p_tail` gives the last lines instead (a projector shows "now").
create or replace function public.sitka_feed(p_event text, p_after int default -1, p_lang text default null,
                                             p_after_tr int default null, p_limit int default 200, p_tail int default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  lim int := least(greatest(coalesce(p_limit, 200), 1), 1000);
  segs jsonb;
  trs jsonb := '[]'::jsonb;
begin
  if not public.event_open(p_event) then return null; end if;
  if p_tail is not null then
    select coalesce(jsonb_agg(jsonb_build_object('idx', s.idx, 'start_sec', s.start_sec, 'label', s.label, 'text', s.text) order by s.idx), '[]')
      into segs from (select * from public.segments where event_id = p_event order by idx desc limit least(greatest(p_tail, 1), 50)) s;
  else
    select coalesce(jsonb_agg(jsonb_build_object('idx', s.idx, 'start_sec', s.start_sec, 'label', s.label, 'text', s.text) order by s.idx), '[]')
      into segs from (select * from public.segments where event_id = p_event and idx > coalesce(p_after, -1) order by idx limit lim) s;
  end if;
  if p_lang is not null then
    select coalesce(jsonb_agg(jsonb_build_object('idx', t.idx, 'text', t.text) order by t.idx), '[]')
      into trs from (select * from public.translations
                     where event_id = p_event and lang = p_lang and idx > coalesce(p_after_tr, p_after, -1)
                     order by idx limit lim) t;
  end if;
  return jsonb_build_object('segments', segs, 'translations', trs);
end $$;

-- the room chat after a moment, by its anonymous tags (never who wrote it)
create or replace function public.sitka_room(p_event text, p_since timestamptz default null, p_limit int default 50)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when not public.event_open(p_event) then null else coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'author', m.author, 'name', m.name, 'host', m.host, 'text', m.text, 'created_at', m.created_at) order by m.created_at)
    from (select * from public.room_messages
          where event_id = p_event and created_at > coalesce(p_since, '-infinity'::timestamptz)
          order by created_at limit least(greatest(coalesce(p_limit, 50), 1), 200)) m), '[]') end;
$$;

-- the host's notes to the room after a moment
create or replace function public.sitka_room_notes(p_event text, p_since timestamptz default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when not public.event_open(p_event) then null else coalesce((
    select jsonb_agg(jsonb_build_object('id', n.id, 'text', n.text, 'created_at', n.created_at) order by n.created_at)
    from (select * from public.room_notes
          where event_id = p_event and created_at > coalesce(p_since, '-infinity'::timestamptz)
          order by created_at limit 5) n), '[]') end;
$$;

-- the latest poll (or the latest open one), with its count per choice
create or replace function public.sitka_poll(p_event text, p_open_only boolean default false)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when not public.event_open(p_event) then null else (
    select jsonb_build_object('id', p.id, 'question', p.question, 'options', p.options, 'status', p.status,
      'tally', coalesce((select jsonb_object_agg(v.choice::text, v.n) from
                          (select choice, count(*) as n from public.poll_votes where poll_id = p.id group by choice) v), '{}'))
    from public.polls p
    where p.event_id = p_event and (not coalesce(p_open_only, false) or p.status = 'open')
    order by p.created_at desc limit 1) end;
$$;

-- the questions put to the speaker, as the room sees them, with their votes
create or replace function public.sitka_shared_questions(p_event text, p_limit int default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when not public.event_open(p_event) then null else coalesce((
    select jsonb_agg(jsonb_build_object('id', q.id, 'refined', q.refined, 'text', q.text, 'topic', q.topic,
                                        'votes', (select count(*) from public.question_votes v where v.question_id = q.id)) order by q.created_at desc)
    from (select * from public.speaker_questions
          where event_id = p_event and status = 'submitted'
          order by created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 100)) q), '[]') end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.sitka_feed(text, int, text, int, int, int)', 'public.sitka_room(text, timestamptz, int)',
    'public.sitka_room_notes(text, timestamptz)', 'public.sitka_poll(text, boolean)',
    'public.sitka_shared_questions(text, int)', 'public.sitka_event_live(text)', 'public.sitka_event_mine(text)'
  ] loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

-- ---------- 3. the tables closed to visitors; hosts read their own ----------
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['segments', 'translations', 'room_messages', 'room_notes', 'polls', 'poll_votes', 'speaker_questions', 'question_votes'] loop
    -- the open-to-the-room read rules go (the host's own, and write rules, stay)
    for p in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = t and cmd = 'SELECT' and policyname !~ 'host read'
    loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('revoke select on public.%I from anon', t);
  end loop;
  -- a table's revoke leaves grants made column by column (part 3 gave the
  -- room's columns to visitors that way): those go one by one
  for p in
    select distinct table_name, column_name, grantee from information_schema.column_privileges
    where table_schema = 'public' and privilege_type = 'SELECT' and grantee = 'anon'
      and table_name in ('segments', 'translations', 'room_messages', 'room_notes', 'polls', 'poll_votes', 'speaker_questions', 'question_votes')
  loop
    execute format('revoke select (%I) on public.%I from anon', p.column_name, p.table_name);
  end loop;
end $$;

drop policy if exists "segments host read" on public.segments;
create policy "segments host read" on public.segments for select to authenticated using (public.sitka_event_mine(event_id));
drop policy if exists "translations host read" on public.translations;
create policy "translations host read" on public.translations for select to authenticated using (public.sitka_event_mine(event_id));
drop policy if exists "room host read" on public.room_messages;
create policy "room host read" on public.room_messages for select to authenticated using (public.sitka_event_mine(event_id));
drop policy if exists "room notes host read" on public.room_notes;
create policy "room notes host read" on public.room_notes for select to authenticated using (public.sitka_event_mine(event_id));
drop policy if exists "polls host read" on public.polls;
create policy "polls host read" on public.polls for select to authenticated using (public.sitka_event_mine(event_id));
drop policy if exists "poll votes host read" on public.poll_votes;
create policy "poll votes host read" on public.poll_votes for select to authenticated using (
  exists (select 1 from public.polls p where p.id = poll_id and public.sitka_event_mine(p.event_id)));
drop policy if exists "question votes host read" on public.question_votes;
create policy "question votes host read" on public.question_votes for select to authenticated using (
  exists (select 1 from public.speaker_questions q where q.id = question_id and public.sitka_event_mine(q.event_id)));
-- (speaker_questions keeps its "speaker questions host read")
-- the host's screens read whole rows of their own events again
grant select on public.segments, public.translations, public.room_messages, public.room_notes, public.polls,
  public.poll_votes, public.speaker_questions, public.question_votes to authenticated;

-- ---------- 4. new lines to the room, on the event's private channel ----------
create or replace function public.sitka_room_broadcast()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then return null; end if;
  begin
    -- never who wrote it, never the event's id (the channel says that)
    perform realtime.send(to_jsonb(new) - 'attendee_id' - 'event_id', tg_table_name, 'event:' || new.event_id, true);
  exception when others then
    null; -- the room's own asking catches up; a line is never refused for this
  end;
  return null;
end $$;
revoke execute on function public.sitka_room_broadcast() from public, anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['segments', 'translations', 'room_messages', 'room_notes'] loop
    execute format('drop trigger if exists room_broadcast on public.%I', t);
    execute format('create trigger room_broadcast after insert on public.%I for each row execute function public.sitka_room_broadcast()', t);
  end loop;
  drop trigger if exists room_broadcast on public.polls;
  create trigger room_broadcast after insert or update on public.polls for each row execute function public.sitka_room_broadcast();
end $$;

-- ---------- 5. who may listen, and who may send ----------
-- On Supabase, realtime.messages already has row-level security on (it is
-- not ours to change); these rules say who may join which private channel.
do $$
begin
  if to_regclass('realtime.messages') is null or to_regprocedure('realtime.topic()') is null then
    raise notice 'No Realtime here: channel rules skipped.';
    return;
  end if;
  execute 'drop policy if exists "sitca room listen" on realtime.messages';
  execute $p$create policy "sitca room listen" on realtime.messages for select to anon, authenticated using (
    realtime.messages.extension = 'broadcast' and (select realtime.topic()) like 'event:%'
    and public.event_open(substr((select realtime.topic()), 7)))$p$;
  -- live video, host to room: the room listens, only the host sends
  execute 'drop policy if exists "sitca video listen" on realtime.messages';
  execute $p$create policy "sitca video listen" on realtime.messages for select to anon, authenticated using (
    realtime.messages.extension = 'broadcast' and (select realtime.topic()) like 'rtc:%'
    and public.event_open(substr((select realtime.topic()), 5)))$p$;
  execute 'drop policy if exists "sitca video host sends" on realtime.messages';
  execute $p$create policy "sitca video host sends" on realtime.messages for insert to authenticated with check (
    realtime.messages.extension = 'broadcast' and (select realtime.topic()) like 'rtc:%'
    and public.sitka_event_mine(substr((select realtime.topic()), 5)))$p$;
  -- live video, attendees to host: anyone at a live event sends, only the host reads
  execute 'drop policy if exists "sitca video to host" on realtime.messages';
  execute $p$create policy "sitca video to host" on realtime.messages for insert to anon, authenticated with check (
    realtime.messages.extension = 'broadcast' and (select realtime.topic()) like 'rtcup:%'
    and public.sitka_event_live(substr((select realtime.topic()), 7)))$p$;
  execute 'drop policy if exists "sitca video host hears" on realtime.messages';
  execute $p$create policy "sitca video host hears" on realtime.messages for select to authenticated using (
    realtime.messages.extension = 'broadcast' and (select realtime.topic()) like 'rtcup:%'
    and public.sitka_event_mine(substr((select realtime.topic()), 7)))$p$;
exception when others then
  raise notice 'Channel rules not written: %', sqlerrm;
end $$;

-- ---------- 6. a new attendee carries a secret ----------
-- Rows from before secrets existed are trusted only while their event is on.
create or replace function public.sitka_attendee_ok(p_attendee uuid, p_event text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.attendees a join public.events e on e.id = a.event_id
    where a.id = p_attendee and a.event_id = p_event
      and case when a.secret_hash is null then e.status <> 'ended'
               else a.secret_hash = encode(sha256(convert_to(
                 coalesce(nullif(current_setting('request.headers', true), '')::json->>'x-sitca-attendee', ''), 'UTF8')), 'hex') end
  );
$$;
create or replace function public.sitka_attendee_secret_required()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- only pages are held to it: the site's server, the database's owner and the host write freely
  if public.sitka_role() not in ('anon', 'authenticated') or public.sitka_event_mine(new.event_id) then return new; end if;
  if new.secret_hash is null then
    raise exception 'Reload the page to join (it is older than the event).';
  end if;
  return new;
end $$;
revoke execute on function public.sitka_attendee_secret_required() from public, anon, authenticated;
drop trigger if exists attendees_secret_required on public.attendees;
create trigger attendees_secret_required
  before insert on public.attendees
  for each row execute function public.sitka_attendee_secret_required();

-- ---------- 7. the older recordings bucket: no longer listable by visitors ----------
-- Every folder of every shared session stored there could be listed (each
-- name a recap id). The site's server now reads a shared recording there
-- itself, after checking the share; the owner's own rules stay.
drop policy if exists "recordings replay read" on storage.objects;

insert into public.schema_migrations (name) values ('20260926_11_live_events')
on conflict (name) do update set ran_at = now();
