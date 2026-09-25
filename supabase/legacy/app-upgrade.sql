-- Sitka full web app upgrade. Run AFTER schema.sql and host-upgrade.sql.
-- The complete desktop experience (Home / Overview / Events / Coach / Library)
-- runs online: each signed-in user's sessions, brain chats and coach projects
-- live here; recordings go to private storage.

create table if not exists public.sessions (
  id text primary key,
  owner uuid not null,
  meta jsonb not null,
  transcript jsonb not null default '[]',
  chat jsonb not null default '[]',
  notes jsonb,
  study jsonb,
  marks jsonb not null default '[]',
  report jsonb,
  thumb text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.brain_chats (
  id text primary key,
  owner uuid not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.coach_projects (
  id text primary key,
  owner uuid not null,
  data jsonb not null,
  sim jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

-- Event materials as structured entries (name + text) for the web app
alter table public.events add column if not exists materials jsonb not null default '[]';

alter table public.sessions enable row level security;
alter table public.brain_chats enable row level security;
alter table public.coach_projects enable row level security;

create policy "sessions owner all" on public.sessions
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "brain chats owner all" on public.brain_chats
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "coach owner all" on public.coach_projects
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

-- Private recordings bucket: each user reads/writes only their own folder
insert into storage.buckets (id, name, public)
values ('recordings', 'recordings', false)
on conflict (id) do nothing;

create policy "recordings owner all" on storage.objects
  for all to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
