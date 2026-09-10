-- Sitka: repair the replays storage policies.
-- Safe to run more than once. Run this if "Publish replay" says the
-- replays storage policy is missing even after wave3.sql.
--
-- Why: publishing uploads with upsert, and Supabase storage checks the
-- SELECT policy as well as INSERT/UPDATE for an upsert. wave3.sql created
-- insert/update/delete only, so the upload was refused.

alter table public.events add column if not exists replay jsonb;

insert into storage.buckets (id, name, public)
values ('replays', 'replays', true)
on conflict (id) do update set public = true;

drop policy if exists "replays host insert" on storage.objects;
drop policy if exists "replays host update" on storage.objects;
drop policy if exists "replays host delete" on storage.objects;
drop policy if exists "replays host select" on storage.objects;
drop policy if exists "replays public read" on storage.objects;

create policy "replays host insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'replays');
create policy "replays host update" on storage.objects
  for update to authenticated using (bucket_id = 'replays') with check (bucket_id = 'replays');
create policy "replays host delete" on storage.objects
  for delete to authenticated using (bucket_id = 'replays');
create policy "replays host select" on storage.objects
  for select to authenticated using (bucket_id = 'replays');
create policy "replays public read" on storage.objects
  for select to anon using (bucket_id = 'replays');
