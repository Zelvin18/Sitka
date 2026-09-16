-- Sitka wave 15: a course or space is deleted by the person who made it.
-- Run AFTER the previous scripts. Safe to run more than once.
--
-- Until now any lead in an organisation could delete any of its spaces. Now
-- only the space's creator, or the organisation's owner, may. Everything else
-- about spaces (reading, creating, updating, materials) is unchanged.

drop policy if exists "spaces deleted by leads" on public.org_spaces;
drop policy if exists "spaces deleted by creator or owner" on public.org_spaces;
create policy "spaces deleted by creator or owner" on public.org_spaces
  for delete to authenticated using (
    created_by = auth.uid()
    or exists (select 1 from public.organizations o where o.id = org_id and o.owner = auth.uid())
  );
