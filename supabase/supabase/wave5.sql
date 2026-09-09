-- Sitka wave 5: Memory — durable decisions, promises, people and concepts
-- extracted from every session, each pinned to the moment it was said.
-- Run AFTER the previous scripts.

create table if not exists public.memory_objects (
  id text primary key,
  owner uuid not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.memory_objects enable row level security;

create policy "memory owner all" on public.memory_objects
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
