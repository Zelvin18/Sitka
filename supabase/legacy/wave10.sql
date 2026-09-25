-- Sitka wave 10: the room chat — attendees talk to each other during an
-- event, and the host reads and joins in. Run after wave9.sql.

create table if not exists public.room_messages (
  id uuid primary key,
  event_id text not null references public.events(id) on delete cascade,
  attendee_id uuid,                       -- null when the host writes
  name text not null default 'Guest',
  host boolean not null default false,
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists room_messages_event_idx on public.room_messages (event_id, created_at);

alter table public.room_messages enable row level security;

-- everyone in the room reads the room
create policy "room readable" on public.room_messages
  for select using (true);

-- attendees (anonymous) write as themselves, never as the host
create policy "room attendee insert" on public.room_messages
  for insert with check (host = false and length(text) between 1 and 600);

-- the event's owner writes as the host
create policy "room host insert" on public.room_messages
  for insert to authenticated with check (
    exists (select 1 from public.events e where e.id = event_id and e.owner = auth.uid())
  );

alter publication supabase_realtime add table public.room_messages;
