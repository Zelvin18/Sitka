-- Sitka wave 7: visual memory + Create.
-- Run AFTER the previous scripts.

-- Key frames of what was on screen during a session: [{time, text, path}]
alter table public.sessions
  add column if not exists slides jsonb not null default '[]'::jsonb;

-- Documents, presentations and code Sitka designs for the user.
create table if not exists public.creations (
  id text primary key,
  owner uuid not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.creations enable row level security;

create policy "creations owner all" on public.creations
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
