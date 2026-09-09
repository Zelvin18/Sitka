-- Sitka: repair the live-stage storage policies on a database where
-- host-upgrade.sql was already run (re-running it stops at the first
-- "already exists" error, so the stage policies at its end never applied).
-- Safe to run more than once.

insert into storage.buckets (id, name, public)
values ('stage', 'stage', true)
on conflict (id) do update set public = true;

drop policy if exists "stage host insert" on storage.objects;
create policy "stage host insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'stage');

drop policy if exists "stage host update" on storage.objects;
create policy "stage host update" on storage.objects
  for update to authenticated using (bucket_id = 'stage');

drop policy if exists "stage public read" on storage.objects;
create policy "stage public read" on storage.objects
  for select using (bucket_id = 'stage');
