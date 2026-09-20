-- Sitca: hardening of what the world may write and read.
-- Run once in the Supabase SQL editor, after schema.sql and the waves. Safe to run again.
--
-- Attendees join an event with nothing but its link, so some tables accept
-- rows from anyone. That is by design; what this file adds is a ceiling on
-- it: every text has a longest it may be, every event has a most it may
-- hold, an event that has ended takes no more, and what an event's tables
-- hold can be read only while it is on, or when its replay is open, or by
-- its owner. A dump of every transcript ever hosted is no longer a query.

-- ---------- sizes ----------
-- "not valid": rows already there are not checked, only new ones
do $$ begin
  alter table public.asks add constraint asks_text_len check (char_length(text) <= 2000) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.speaker_questions add constraint speaker_questions_text_len check (char_length(text) <= 1500) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.room_messages add constraint room_messages_len check (char_length(text) <= 1500 and char_length(name) <= 80) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.attendees add constraint attendees_len check (char_length(persona) <= 120 and char_length(lang) <= 60) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.client_errors add constraint client_errors_len check (
    char_length(message) <= 4000 and coalesce(char_length(stack), 0) <= 12000
    and coalesce(char_length(page), 0) <= 300 and coalesce(char_length(ua), 0) <= 400
  ) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.usage_events add constraint usage_events_len check (
    char_length(name) <= 60 and pg_column_size(props) <= 4000
    and char_length(platform) <= 40 and coalesce(char_length(ua), 0) <= 400
  ) not valid;
exception when duplicate_object then null; end $$;

-- ---------- how much one event may hold, and nothing once it has ended ----------
create or replace function public.guard_event_rows() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  st text;
  n bigint;
  lim int;
begin
  select status into st from public.events where id = new.event_id;
  if st is null then raise exception 'no such event'; end if;
  -- an ended event takes no more from the room; its owner may still write
  if st = 'ended' and auth.uid() is null and tg_table_name in ('asks', 'speaker_questions', 'reactions', 'room_messages') then
    raise exception 'the event has ended';
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

-- ---------- what may be read: while it is on, with replay, or as its owner ----------
create or replace function public.event_open(p_event text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.events e
    where e.id = p_event
      and (e.status <> 'ended'
        or coalesce((e.replay->>'enabled')::boolean, false)
        or e.owner = auth.uid())
  );
$$;
grant execute on function public.event_open(text) to anon, authenticated;

drop policy if exists "segments readable" on public.segments;
create policy "segments readable" on public.segments for select using (public.event_open(event_id));
drop policy if exists "translations readable" on public.translations;
create policy "translations readable" on public.translations for select using (public.event_open(event_id));
drop policy if exists "asks readable" on public.asks;
create policy "asks readable" on public.asks for select using (public.event_open(event_id));
drop policy if exists "speaker questions readable" on public.speaker_questions;
create policy "speaker questions readable" on public.speaker_questions for select using (public.event_open(event_id));
drop policy if exists "room readable" on public.room_messages;
create policy "room readable" on public.room_messages for select using (public.event_open(event_id));

-- ---------- the owners' tables take rows only from the page that made them ----------
-- an event by someone signed in carries their id; nobody may write an event
-- in another person's name, or a usage row in another person's name
drop policy if exists "usage insert" on public.usage_events;
create policy "usage insert" on public.usage_events
  for insert to anon, authenticated with check (user_id is null or user_id = auth.uid());
drop policy if exists "errors insert" on public.client_errors;
create policy "errors insert" on public.client_errors
  for insert to anon, authenticated with check (user_id is null or user_id = auth.uid());

-- ---------- a word on an answer ----------
-- Right or wrong, from the person who asked, with the question and the
-- answer as they were. Read by the owners (admin_feedback); never by others.
create table if not exists public.answer_feedback (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid not null,
  session_id text,
  question text not null,
  answer text not null,
  good boolean not null,
  note text
);
create index if not exists answer_feedback_at_idx on public.answer_feedback (at desc);
alter table public.answer_feedback enable row level security;
drop policy if exists "feedback own insert" on public.answer_feedback;
create policy "feedback own insert" on public.answer_feedback
  for insert to authenticated with check (user_id = auth.uid() and char_length(question) <= 2000 and char_length(answer) <= 8000);

create or replace function public.admin_feedback(lim int default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select jsonb_build_object(
    'good', (select count(*) from public.answer_feedback where good and at >= now() - interval '30 days'),
    'bad', (select count(*) from public.answer_feedback where not good and at >= now() - interval '30 days'),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
      'at', f.at, 'good', f.good, 'session', f.session_id, 'question', left(f.question, 300), 'answer', left(f.answer, 600),
      'user', (select email from auth.users where id = f.user_id)
    ) order by f.at desc), '[]'::jsonb) from (select * from public.answer_feedback order by at desc limit lim) f)
  ) into out;
  return out;
end $$;
grant execute on function public.admin_feedback(int) to authenticated;
