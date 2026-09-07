-- Sitka wave 8: session materials — the slides, notes or readings a user
-- shares for a session so Sitka knows what it is about: [{id, name, chars, addedAt, text}]
-- Run AFTER the previous scripts.

alter table public.sessions
  add column if not exists materials jsonb not null default '[]'::jsonb;
