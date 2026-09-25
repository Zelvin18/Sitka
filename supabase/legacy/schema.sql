-- Sitka cloud events schema. Run once in the Supabase SQL editor.
-- The Electron app writes with the service_role key (bypasses RLS);
-- attendee phones read/insert through the anon key under the policies below.

create table if not exists public.events (
  id text primary key,
  title text not null default '',
  status text not null default 'waiting', -- waiting | live | ended
  starts_at timestamptz,
  agenda jsonb not null default '[]',
  pre_event_chat boolean not null default true,
  materials_present boolean not null default false,
  live_voice jsonb not null default '{"enabled":true,"languages":[]}',
  session_id text,
  updated_at timestamptz not null default now()
);

create table if not exists public.attendees (
  id uuid primary key,
  event_id text not null references public.events(id) on delete cascade,
  persona text not null default 'Curious attendee',
  lang text not null default 'English',
  joined_at timestamptz not null default now()
);

create table if not exists public.segments (
  event_id text not null references public.events(id) on delete cascade,
  idx int not null,
  start_sec numeric not null,
  label text not null,
  text text not null,
  primary key (event_id, idx)
);

create table if not exists public.translations (
  event_id text not null references public.events(id) on delete cascade,
  lang text not null,
  idx int not null,
  text text not null,
  primary key (event_id, lang, idx)
);

create table if not exists public.asks (
  id uuid primary key,
  event_id text not null references public.events(id) on delete cascade,
  attendee_id uuid not null,
  kind text not null default 'ask', -- ask | catchup | pack
  question text not null default '',
  answer text,
  status text not null default 'pending', -- pending | answered | error
  created_at timestamptz not null default now(),
  answered_at timestamptz
);

create table if not exists public.speaker_questions (
  id uuid primary key,
  event_id text not null references public.events(id) on delete cascade,
  attendee_id uuid,
  text text not null,
  force boolean not null default false,
  status text not null default 'checking', -- checking | submitted | already_answered | error
  refined text,
  topic text,
  answered_at_label text,
  answer text,
  created_at timestamptz not null default now()
);

-- ---------- row level security ----------
alter table public.events enable row level security;
alter table public.attendees enable row level security;
alter table public.segments enable row level security;
alter table public.translations enable row level security;
alter table public.asks enable row level security;
alter table public.speaker_questions enable row level security;

create policy "events readable" on public.events for select using (true);
create policy "attendees join" on public.attendees for insert with check (true);
create policy "segments readable" on public.segments for select using (true);
create policy "translations readable" on public.translations for select using (true);
create policy "asks insert" on public.asks
  for insert with check (status = 'pending' and answer is null);
create policy "asks readable" on public.asks for select using (true);
create policy "speaker questions insert" on public.speaker_questions
  for insert with check (status = 'checking' and answer is null and refined is null);
create policy "speaker questions readable" on public.speaker_questions for select using (true);

-- ---------- realtime ----------
alter publication supabase_realtime add table
  public.events, public.segments, public.translations,
  public.asks, public.speaker_questions;

-- ---------- storage: live stage frames ----------
insert into storage.buckets (id, name, public)
values ('stage', 'stage', true)
on conflict (id) do nothing;
