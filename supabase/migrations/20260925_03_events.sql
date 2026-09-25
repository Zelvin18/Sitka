-- Sitca hardening, part 3: events and the room.
--
-- Run after 20260925_02_organisations.sql. Safe to run more than once.
-- Deploy the website first: its event, stage and recap pages read an event
-- through sitka_event() and fall back to the old read until this has run.
-- No row is deleted.
--
-- What changes:
--   * the events table is read only by each event's host; everyone else gets
--     one event at a time, by its id, with its public fields only
--     (sitka_event): never the host's materials, never a list of events;
--   * an attendee's questions and the AI's answers are read by the host and
--     by the attendee's own page (through the site's server, with the
--     attendee's secret), no longer by anyone in the room;
--   * everything an attendee writes (questions, messages, reactions, votes,
--     a proxy request) must come from a real attendee of that event, shown
--     by the secret their page holds, and is rate-limited per attendee;
--     joining is rate-limited per address and per event;
--   * room messages no longer show who wrote them, only an anonymous tag
--     the writer's own page recognises; votes no longer show who voted.

-- ---------- the attendee's secret ----------
alter table public.attendees add column if not exists secret_hash text;

-- Is this a real attendee of this event, and is the caller that attendee?
-- The event page sends its secret in the x-sitca-attendee header; the row
-- holds its sha-256. Attendees who joined before secrets existed have no
-- hash and are taken at their word.
create or replace function public.sitka_attendee_ok(p_attendee uuid, p_event text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.attendees a
    where a.id = p_attendee and a.event_id = p_event
      and (a.secret_hash is null
           or a.secret_hash = encode(sha256(convert_to(
                coalesce(nullif(current_setting('request.headers', true), '')::json->>'x-sitca-attendee', ''), 'UTF8')), 'hex'))
  );
$$;

-- the caller's role as the database was told it: anon, authenticated, service_role
create or replace function public.sitka_role()
returns text language sql stable set search_path = '' as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role',
    ''
  );
$$;

-- ---------- one event, for its public pages ----------
create or replace function public.sitka_event(p_id text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', e.id,
    'title', e.title,
    'status', e.status,
    'starts_at', e.starts_at,
    'agenda', e.agenda,
    'pre_event_chat', e.pre_event_chat,
    'materials_present', e.materials_present,
    'live_voice', e.live_voice,
    'host_seen', e.host_seen,
    'banner', e.banner,
    'updated_at', e.updated_at,
    -- the recap's own fields, once the host has published it
    'replay', case when coalesce(e.replay->>'enabled', 'false') = 'true' then e.replay
                   else jsonb_build_object('enabled', false) end,
    -- whose recording, and which: only for a published replay, whose page plays it
    'owner', case when coalesce(e.replay->>'enabled', 'false') = 'true' then e.owner end,
    'session_id', case when coalesce(e.replay->>'enabled', 'false') = 'true' then e.session_id end
  )
  from public.events e
  where e.id = p_id;
$$;

-- ---------- the events table: its host only ----------
drop policy if exists "events readable" on public.events;
drop policy if exists "events host read" on public.events;
create policy "events host read" on public.events
  for select to authenticated using (owner = (select auth.uid()));
revoke all on public.events from anon;

-- ---------- attendees ----------
-- a row may name a signed-in person only when it is that person
drop policy if exists "attendees join" on public.attendees;
create policy "attendees join" on public.attendees
  for insert to anon, authenticated with check (
    (user_id is null or user_id = (select auth.uid()))
    and (keep = false or user_id = (select auth.uid()))
  );
revoke update, delete on public.attendees from anon;

-- keeping an event: only the attendee themself, and never someone else's row
create or replace function public.sitka_attend_keep(p_attendee uuid, p_keep boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.attendees;
begin
  if (select auth.uid()) is null then raise exception 'Sign in first.'; end if;
  select * into a from public.attendees where id = p_attendee;
  if a.id is null then raise exception 'No such attendee.'; end if;
  if a.user_id is not null and a.user_id <> (select auth.uid()) then raise exception 'Not yours.'; end if;
  if not public.sitka_attendee_ok(p_attendee, a.event_id) then raise exception 'Not yours.'; end if;
  update public.attendees set user_id = (select auth.uid()), keep = p_keep where id = p_attendee;
end $$;

-- ---------- questions to the AI: the host, and the attendee's own page via the server ----------
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'asks' loop
    execute format('drop policy %I on public.asks', p.policyname);
  end loop;
end $$;
create policy "asks insert" on public.asks
  for insert to anon, authenticated with check (status = 'pending' and answer is null and answered_at is null);
create policy "asks host read" on public.asks
  for select to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.owner = (select auth.uid()))
  );
create policy "asks host update" on public.asks
  for update to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.owner = (select auth.uid()))
  );

-- ---------- questions for the speaker: the room sees those put to the speaker ----------
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'speaker_questions' loop
    execute format('drop policy %I on public.speaker_questions', p.policyname);
  end loop;
end $$;
create policy "speaker questions insert" on public.speaker_questions
  for insert to anon, authenticated with check (status = 'checking' and answer is null and refined is null);
create policy "speaker questions shared" on public.speaker_questions
  for select to anon, authenticated using (status = 'submitted' and public.event_open(event_id));
create policy "speaker questions host read" on public.speaker_questions
  for select to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.owner = (select auth.uid()))
  );
create policy "speaker questions host update" on public.speaker_questions
  for update to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.owner = (select auth.uid()))
  );
-- the room reads the question, never who asked it
revoke select on public.speaker_questions from anon;
grant select (id, event_id, text, refined, topic, status, created_at) on public.speaker_questions to anon;
revoke update, delete on public.speaker_questions from anon;

-- ---------- the room chat: an anonymous tag instead of the writer's id ----------
alter table public.room_messages
  add column if not exists author text
  generated always as (left(encode(sha256(decode(replace(coalesce(attendee_id::text, ''), '-', ''), 'hex')), 'hex'), 16)) stored;
revoke select on public.room_messages from anon, authenticated;
grant select (id, event_id, name, host, text, created_at, author) on public.room_messages to anon, authenticated;
revoke update, delete on public.room_messages from anon, authenticated;

-- ---------- reactions, votes, polls, notes: read inside the event, without who ----------
drop policy if exists "reactions readable" on public.reactions;
drop policy if exists "reactions host read" on public.reactions;
create policy "reactions host read" on public.reactions
  for select to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.owner = (select auth.uid()))
  );

drop policy if exists "question votes readable" on public.question_votes;
create policy "question votes readable" on public.question_votes
  for select to anon, authenticated using (
    exists (select 1 from public.speaker_questions q where q.id = question_id)
  );
revoke select on public.question_votes from anon, authenticated;
grant select (question_id) on public.question_votes to anon, authenticated;

drop policy if exists "polls readable" on public.polls;
create policy "polls readable" on public.polls
  for select to anon, authenticated using (public.event_open(event_id));

drop policy if exists "poll votes readable" on public.poll_votes;
create policy "poll votes readable" on public.poll_votes
  for select to anon, authenticated using (
    exists (select 1 from public.polls p where p.id = poll_id)
  );
revoke select on public.poll_votes from anon, authenticated;
grant select (poll_id, choice, at) on public.poll_votes to anon, authenticated;

drop policy if exists "room notes readable" on public.room_notes;
create policy "room notes readable" on public.room_notes
  for select to anon, authenticated using (public.event_open(event_id));

-- ---------- what the room writes: a real attendee, at a human pace ----------
-- Replaces the guard from hardening.sql (same name, same caps), adding the
-- attendee check and the pace. The event's host, and the site's server,
-- are not held to it.
create or replace function public.guard_event_rows() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  st text;
  host uuid;
  n bigint;
  lim int;
  att uuid;
  who text;
begin
  select e.status, e.owner into st, host from public.events e where e.id = new.event_id;
  if st is null then raise exception 'no such event'; end if;
  -- the site's server and the event's own host write freely
  if public.sitka_role() = 'service_role' or (host is not null and host = (select auth.uid())) then
    return new;
  end if;
  -- an ended event takes no more from the room
  if st = 'ended' and tg_table_name in ('asks', 'speaker_questions', 'reactions', 'room_messages') then
    raise exception 'the event has ended';
  end if;
  if tg_table_name = 'attendees' then
    who := public.sitka_caller_key();
    -- a whole class joining from one Wi-Fi is a few hundred a minute at most;
    -- when the address is not known, only the event's own limit applies
    if (who <> 'anon' and public.sitka_rate_hit('join:' || new.event_id || ':' || who, 150, 900))
       or public.sitka_rate_hit('join:' || new.event_id, 900, 9000) then
      raise exception 'too many people joining at once, try again in a minute';
    end if;
  else
    -- (each of these tables has attendee_id; only room_messages has host,
    -- so that field is read inside its own branch)
    att := new.attendee_id;
    if tg_table_name = 'room_messages' then
      if new.host then raise exception 'only the host writes as the host'; end if;
    end if;
    if att is null or not public.sitka_attendee_ok(att, new.event_id) then
      raise exception 'join the event first';
    end if;
    if (tg_table_name = 'room_messages' and public.sitka_rate_hit('room:' || att, 12, 240))
       or (tg_table_name = 'reactions' and public.sitka_rate_hit('react:' || att, 40, 600))
       or (tg_table_name = 'asks' and public.sitka_rate_hit('ask-db:' || att, 8, 120))
       or (tg_table_name = 'speaker_questions' and public.sitka_rate_hit('sq:' || att, 5, 40)) then
      raise exception 'slow down a little';
    end if;
  end if;
  lim := case tg_table_name
    when 'attendees' then 2500
    when 'asks' then 5000
    when 'speaker_questions' then 3000
    when 'room_messages' then 5000
    when 'reactions' then 20000
    else 10000 end;
  execute format('select count(*) from public.%I where event_id = $1', tg_table_name) into n using new.event_id;
  if n >= lim then raise exception 'this event is full'; end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['attendees', 'asks', 'speaker_questions', 'room_messages', 'reactions'] loop
    execute format('drop trigger if exists guard_rows on public.%I', t);
    execute format('create trigger guard_rows before insert on public.%I for each row execute function public.guard_event_rows()', t);
  end loop;
end $$;

-- votes and proxy requests: the same attendee check, one vote each (the keys already say so)
create or replace function public.guard_attendee_vote() returns trigger
language plpgsql security definer set search_path = '' as $$
declare ev text;
begin
  if public.sitka_role() = 'service_role' then return new; end if;
  if tg_table_name = 'question_votes' then
    select q.event_id into ev from public.speaker_questions q where q.id = new.question_id and q.status = 'submitted';
  elsif tg_table_name = 'poll_votes' then
    select p.event_id into ev from public.polls p where p.id = new.poll_id and p.status = 'open';
  else
    ev := new.event_id;
  end if;
  if ev is null then raise exception 'nothing to vote on'; end if;
  if not public.sitka_attendee_ok(new.attendee_id, ev) then raise exception 'join the event first'; end if;
  if public.sitka_rate_hit('vote:' || new.attendee_id::text, 30, 300) then raise exception 'slow down a little'; end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['question_votes', 'poll_votes', 'proxies'] loop
    execute format('drop trigger if exists guard_votes on public.%I', t);
    execute format('create trigger guard_votes before insert on public.%I for each row execute function public.guard_attendee_vote()', t);
  end loop;
end $$;
revoke update, delete on public.question_votes, public.poll_votes, public.reactions from anon, authenticated;
revoke update, delete on public.proxies from anon;
