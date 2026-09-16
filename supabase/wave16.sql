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
