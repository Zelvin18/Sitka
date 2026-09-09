-- Sitka wave 4: Ask-the-event replay chat needs no schema.
-- This adds Room's Mind pushes and absent-attendee proxies.
-- Run AFTER the previous scripts.

-- Notes the host's AI pushes to every attendee phone (e.g. a recap)
create table if not exists public.room_notes (
  id uuid primary key,
  event_id text not null references public.events(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

-- "Attend for me": absent attendees register what they need; a personal
-- brief is written for them when the event ends.
create table if not exists public.proxies (
  attendee_id uuid primary key,
  event_id text not null references public.events(id) on delete cascade,
  request text not null,
  status text not null default 'pending', -- pending | ready | error
  brief text,
  created_at timestamptz not null default now()
);

alter table public.room_notes enable row level security;
alter table public.proxies enable row level security;

create policy "room notes readable" on public.room_notes for select using (true);
create policy "room notes host write" on public.room_notes
  for insert to authenticated with check (
    exists (select 1 from public.events e where e.id = event_id and e.owner = auth.uid())
  );
create policy "proxies insert" on public.proxies
  for insert with check (status = 'pending' and brief is null);
create policy "proxies readable" on public.proxies for select using (true);
create policy "proxies host update" on public.proxies
  for update to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.owner = auth.uid())
  );

alter publication supabase_realtime add table public.room_notes, public.proxies;
