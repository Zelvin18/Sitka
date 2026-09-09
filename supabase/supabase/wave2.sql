-- Sitka wave 2: the live audience loop.
-- Reactions (comprehension pulse), speaker-question upvotes, and live polls.
-- Run AFTER schema.sql, host-upgrade.sql and app-upgrade.sql.

create table if not exists public.reactions (
  id uuid primary key,
  event_id text not null references public.events(id) on delete cascade,
  attendee_id uuid,
  kind text not null check (kind in ('landed', 'lost')),
  at timestamptz not null default now()
);

create table if not exists public.question_votes (
  question_id uuid not null references public.speaker_questions(id) on delete cascade,
  attendee_id uuid not null,
  primary key (question_id, attendee_id)
);

create table if not exists public.polls (
  id uuid primary key,
  event_id text not null references public.events(id) on delete cascade,
  question text not null,
  options jsonb not null default '[]',
  status text not null default 'open', -- open | closed
  created_at timestamptz not null default now()
);

create table if not exists public.poll_votes (
  poll_id uuid not null references public.polls(id) on delete cascade,
  attendee_id uuid not null,
  choice int not null,
  at timestamptz not null default now(),
  primary key (poll_id, attendee_id)
);

alter table public.reactions enable row level security;
alter table public.question_votes enable row level security;
alter table public.polls enable row level security;
alter table public.poll_votes enable row level security;

-- Attendees (anon) react, upvote, and vote — one row per attendee enforced by
-- the primary keys; no anon updates or deletes anywhere.
create policy "reactions insert" on public.reactions for insert with check (kind in ('landed', 'lost'));
create policy "reactions readable" on public.reactions for select using (true);
create policy "question votes insert" on public.question_votes for insert with check (true);
create policy "question votes readable" on public.question_votes for select using (true);
create policy "polls readable" on public.polls for select using (true);
create policy "poll votes insert" on public.poll_votes for insert with check (true);
create policy "poll votes readable" on public.poll_votes for select using (true);

-- Hosts create and close polls for their own events
create policy "polls host write" on public.polls
  for insert to authenticated with check (
    exists (select 1 from public.events e where e.id = event_id and e.owner = auth.uid())
  );
create policy "polls host update" on public.polls
  for update to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.owner = auth.uid())
  );

alter publication supabase_realtime add table public.polls;
