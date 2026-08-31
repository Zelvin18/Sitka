-- Sitka wave 3: shareable event replays.
-- Run AFTER the previous scripts.

alter table public.events add column if not exists replay jsonb;

-- Public bucket for published replays (host chooses to publish)
insert into storage.buckets (id, name, public)
values ('replays', 'replays', true)
on conflict (id) do nothing;

create policy "replays host insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'replays');
create policy "replays host update" on storage.objects
  for update to authenticated using (bucket_id = 'replays');
create policy "replays host delete" on storage.objects
  for delete to authenticated using (bucket_id = 'replays');
