-- Wave 18: a recap someone shared, kept in another person's library.
-- The recording, transcript and notes stay with whoever recorded them (the
-- public recap row); this table only remembers who kept which recap.
-- Run in the Supabase SQL editor. Safe to run again.

create table if not exists public.saved_recaps (
  user_id uuid not null,
  recap_id text not null references public.recaps(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, recap_id)
);

-- the student's own work on a kept recap: their notes, study pack and chat
alter table public.saved_recaps add column if not exists notes jsonb;
alter table public.saved_recaps add column if not exists study jsonb;
alter table public.saved_recaps add column if not exists chat jsonb;

alter table public.saved_recaps enable row level security;

drop policy if exists "saved recaps own" on public.saved_recaps;
create policy "saved recaps own" on public.saved_recaps
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
