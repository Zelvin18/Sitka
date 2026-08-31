-- Sitka online host upgrade. Run AFTER schema.sql in the Supabase SQL editor.
-- Hosts sign in (Supabase email auth) and run events entirely from the browser.

alter table public.events add column if not exists owner uuid;
alter table public.events add column if not exists materials_text text;

-- Hosts write their own events
create policy "events host insert" on public.events
  for insert to authenticated with check (owner = auth.uid());
create policy "events host update" on public.events
  for update to authenticated using (owner = auth.uid());
create policy "events host delete" on public.events
  for delete to authenticated using (owner = auth.uid());

-- Live data written by the event owner
create policy "segments host insert" on public.segments
  for insert to authenticated with check (
    exists (select 1 from public.events e where e.id = event_id and e.owner = auth.uid())
  );
create policy "translations host insert" on public.translations
  for insert to authenticated with check (
    exists (select 1 from public.events e where e.id = event_id and e.owner = auth.uid())
  );

-- The owner answers attendee asks and reviews speaker questions
create policy "asks host update" on public.asks
  for update to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.owner = auth.uid())
  );
create policy "speaker questions host update" on public.speaker_questions
  for update to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.owner = auth.uid())
  );

-- The owner sees the attendee roster (languages drive live translation)
create policy "attendees host read" on public.attendees
  for select to authenticated using (
    exists (select 1 from public.events e where e.id = event_id and e.owner = auth.uid())
  );

-- Stage frames: signed-in hosts may upload/replace in the public 'stage' bucket
create policy "stage host insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'stage');
create policy "stage host update" on storage.objects
  for update to authenticated using (bucket_id = 'stage');
