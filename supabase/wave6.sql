-- Sitka wave 6: Shareable recaps — any session (not only hosted events) can be
-- published as a public text page: title, summary, key moments, notes and the
-- clickable transcript. The recording itself is never published here.
-- Run AFTER the previous scripts.

create table if not exists public.recaps (
  id text primary key,                 -- the session id
  owner uuid not null,
  title text not null default '',
  summary text not null default '',
  highlights jsonb not null default '[]'::jsonb,
  notes text not null default '',
  transcript jsonb not null default '[]'::jsonb,
  duration_ms bigint not null default 0,
  session_at timestamptz,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.recaps enable row level security;

-- Anyone with the link can read a published recap.
create policy "recaps public read" on public.recaps
  for select using (enabled = true);

-- Owners manage their own recaps.
create policy "recaps owner all" on public.recaps
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
