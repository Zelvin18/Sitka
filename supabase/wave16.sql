-- Sitka wave 16: spaces belong to the organisation's owner and its assigned
-- leads (co-owners, lecturers). Only they add courses and spaces, and only
-- they delete them; people who were merely invited cannot.
-- Run AFTER wave15.sql. Safe to run more than once.

drop policy if exists "spaces deleted by creator or owner" on public.org_spaces;
drop policy if exists "spaces deleted by leads" on public.org_spaces;
drop policy if exists "spaces deleted by owner and leads" on public.org_spaces;
create policy "spaces deleted by owner and leads" on public.org_spaces
  for delete to authenticated using (public.sitka_is_lead(org_id));

-- a member's own conversation with a course or space: kept, so it is there
-- when they come back, on any device
create table if not exists public.space_chats (
  space_id text not null references public.org_spaces(id) on delete cascade,
  user_id uuid not null,
  messages jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  primary key (space_id, user_id)
);
alter table public.space_chats enable row level security;
drop policy if exists "space chats own" on public.space_chats;
create policy "space chats own" on public.space_chats
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- An attendee's questions, a speaker question before it is shared, and a
-- proxy's personal brief are theirs. Until now anyone with the anonymous key
-- could list them by event; now only the host reads them in the database,
-- and the attendee's own page reads its own rows through the site's server.
drop policy if exists "asks readable" on public.asks;
drop policy if exists "asks host read" on public.asks;
create policy "asks host read" on public.asks
  for select to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.owner = auth.uid())
  );
drop policy if exists "speaker questions readable" on public.speaker_questions;
drop policy if exists "speaker questions host read" on public.speaker_questions;
create policy "speaker questions host read" on public.speaker_questions
  for select to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.owner = auth.uid())
  );
drop policy if exists "proxies readable" on public.proxies;
drop policy if exists "proxies host read" on public.proxies;
create policy "proxies host read" on public.proxies
  for select to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.owner = auth.uid())
  );
