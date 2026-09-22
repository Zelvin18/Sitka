-- Sitca: the organisation's administration.
-- Run once in the Supabase SQL editor, after courses.sql. Safe to run again.
--
-- The owner of an organisation (a university's admin, a company's lead)
-- sees the whole of it in one view: who is in, which courses exist and how
-- busy they are, what the month has cost in hours and questions; and may
-- change a person's role, remove someone, set the rules, and hand out fresh
-- invitation codes. Lecturers and leads see the same view, read-only.

-- ---------- the whole organisation, in one answer ----------
create or replace function public.sitka_org_overview(p_org text)
returns jsonb language plpgsql security definer stable as $$
declare
  o public.organizations;
  p_start timestamptz := date_trunc('month', now());
  out jsonb;
begin
  select * into o from public.organizations where id = p_org;
  if o.id is null then raise exception 'No such organisation.'; end if;
  if not public.sitka_is_lead(p_org) then raise exception 'Only the organisation''s leads may see this.'; end if;
  select jsonb_build_object(
    'name', o.name,
    'kind', o.kind,
    'owner', o.owner,
    'domains', o.domains,
    'coursesBy', o.courses_by,
    'code', case when o.owner = auth.uid() then o.code else null end,
    'leadCode', case when o.owner = auth.uid() then o.lead_code else null end,
    'month', jsonb_build_object(
      'sessions', (select count(*) from public.sessions s join public.org_members m on m.user_id = s.owner and m.org_id = p_org where s.created_at >= p_start),
      'hours', (select round(coalesce(sum((s.meta->>'durationMs')::numeric), 0) / 3600000, 1) from public.sessions s join public.org_members m on m.user_id = s.owner and m.org_id = p_org where s.created_at >= p_start),
      'asks', (select count(*) from public.usage_events u join public.org_members m on m.user_id = u.user_id and m.org_id = p_org where u.at >= p_start and u.name in ('ask', 'ask_overview')),
      'active', (select count(distinct u.user_id) from public.usage_events u join public.org_members m on m.user_id = u.user_id and m.org_id = p_org where u.at >= p_start)
    ),
    'members', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'userId', m.user_id, 'name', m.name, 'email', m.email, 'role', m.role, 'joinedAt', m.joined_at,
        'sessions', (select count(*) from public.sessions s where s.owner = m.user_id and s.created_at >= p_start),
        'courses', (select count(*) from public.space_members sm join public.org_spaces sp on sp.id = sm.space_id where sm.user_id = m.user_id and sp.org_id = p_org),
        'lastSeen', (select max(u.at) from public.usage_events u where u.user_id = m.user_id)
      ) order by case m.role when 'owner' then 0 when 'lead' then 1 else 2 end, m.name), '[]'::jsonb)
      from public.org_members m where m.org_id = p_org
    ),
    'courses', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', sp.id, 'name', sp.name, 'kind', sp.kind, 'code', sp.code, 'createdAt', sp.created_at,
        'lecturers', (select coalesce(jsonb_agg(sm.name) filter (where sm.name <> ''), '[]'::jsonb) from public.space_members sm where sm.space_id = sp.id and sm.role = 'lecturer'),
        'students', (select count(*) from public.space_members sm where sm.space_id = sp.id and sm.role = 'student'),
        'sessions', (select count(*) from public.sessions s where s.space_id = sp.id),
        'materials', (select count(*) from public.org_materials om where om.space_id = sp.id),
        'liveUrl', sp.live_url,
        'lastSession', (select max(s.created_at) from public.sessions s where s.space_id = sp.id)
      ) order by sp.created_at desc), '[]'::jsonb)
      from public.org_spaces sp where sp.org_id = p_org
    )
  ) into out;
  return out;
end $$;
grant execute on function public.sitka_org_overview(text) to authenticated;

-- ---------- a person's role: lecturer/lead or student/member ----------
create or replace function public.sitka_org_set_role(p_org text, p_user uuid, p_role text)
returns void language plpgsql security definer as $$
declare
  o public.organizations;
begin
  select * into o from public.organizations where id = p_org;
  if o.id is null or o.owner <> auth.uid() then raise exception 'Only the organisation''s owner may change roles.'; end if;
  if p_user = o.owner then raise exception 'The owner''s role cannot change.'; end if;
  if p_role not in ('lead', 'member') then raise exception 'A role is lead or member.'; end if;
  update public.org_members set role = p_role where org_id = p_org and user_id = p_user;
  -- a lead teaches: every course they are in knows them as a lecturer; a member as a student
  update public.space_members sm set role = case when p_role = 'lead' then 'lecturer' else 'student' end
  from public.org_spaces sp where sp.id = sm.space_id and sp.org_id = p_org and sm.user_id = p_user;
end $$;
grant execute on function public.sitka_org_set_role(text, uuid, text) to authenticated;

-- ---------- someone leaves, or is removed ----------
create or replace function public.sitka_org_remove(p_org text, p_user uuid)
returns void language plpgsql security definer as $$
declare
  o public.organizations;
  target text;
begin
  select * into o from public.organizations where id = p_org;
  if o.id is null then raise exception 'No such organisation.'; end if;
  if p_user = o.owner then raise exception 'The owner cannot be removed.'; end if;
  select role into target from public.org_members where org_id = p_org and user_id = p_user;
  -- the owner removes anyone; a lead removes members only
  if not (o.owner = auth.uid() or (public.sitka_is_lead(p_org) and target = 'member')) then
    raise exception 'Not allowed.';
  end if;
  delete from public.space_members sm using public.org_spaces sp where sp.id = sm.space_id and sp.org_id = p_org and sm.user_id = p_user;
  delete from public.org_members where org_id = p_org and user_id = p_user;
end $$;
grant execute on function public.sitka_org_remove(text, uuid) to authenticated;

-- ---------- fresh invitation codes: the old ones stop working ----------
create or replace function public.sitka_org_new_codes(p_org text)
returns jsonb language plpgsql security definer as $$
declare
  o public.organizations;
  c1 text; c2 text;
begin
  select * into o from public.organizations where id = p_org;
  if o.id is null or o.owner <> auth.uid() then raise exception 'Only the organisation''s owner may change the codes.'; end if;
  c1 := public.sitka_course_code();
  c2 := public.sitka_course_code();
  update public.organizations set code = c1, lead_code = c2 where id = p_org;
  return jsonb_build_object('code', c1, 'leadCode', c2);
end $$;
grant execute on function public.sitka_org_new_codes(text) to authenticated;

-- ---------- the organisation's name, changed ----------
create or replace function public.sitka_org_rename(p_org text, p_name text)
returns void language plpgsql security definer as $$
begin
  if not exists (select 1 from public.organizations where id = p_org and owner = auth.uid()) then
    raise exception 'Only the organisation''s owner may rename it.';
  end if;
  if char_length(trim(p_name)) < 2 then raise exception 'Give it a name.'; end if;
  update public.organizations set name = trim(p_name) where id = p_org;
end $$;
grant execute on function public.sitka_org_rename(text, text) to authenticated;
