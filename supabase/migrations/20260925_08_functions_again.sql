-- Sitca hardening, part 8: who may call which function, done one at a time.
--
-- Run after 20260925_07_usage_retention.sql. Safe to run more than once.
-- Changes no data.
--
-- Part 5 did this in one sweep. On the live database the sweep stopped at a
-- function in the public schema that is not ours to change, and the SQL
-- editor undid the whole file with it, so visitors could still run the
-- older functions. This does the same work function by function: one it
-- cannot change is skipped and named, never allowed to stop the rest.
-- The last result shows every function a visitor may still run, which
-- should be exactly the six the public pages need.

do $$
declare
  f record;
  skipped text[] := '{}';
begin
  -- a fixed search path for every raised-rights function that is ours
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and pg_get_userbyid(p.proowner) = current_user
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')
  loop
    begin
      execute format('alter function %s set search_path = ''''', f.sig);
    exception when others then
      skipped := skipped || (f.sig::text || ': ' || sqlerrm);
    end;
  end loop;

  -- closed by default: nobody but the site's server runs a function of ours
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and pg_get_userbyid(p.proowner) = current_user
  loop
    begin
      execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
      execute format('grant execute on function %s to service_role', f.sig);
    exception when others then
      skipped := skipped || (f.sig::text || ': ' || sqlerrm);
    end;
  end loop;

  if array_length(skipped, 1) > 0 then
    raise notice 'Left as they were (not ours to change): %', array_to_string(skipped, '; ');
  end if;
end $$;

-- functions made later start closed too
do $$ begin
  alter default privileges in schema public revoke execute on functions from public;
  alter default privileges in schema public revoke execute on functions from anon, authenticated;
exception when others then
  raise notice 'Default privileges left as they were: %', sqlerrm;
end $$;

-- ---------- what a visitor's page may run ----------
do $$
declare f text;
begin
  foreach f in array array[
    'public.attendee_count(text)',            -- "N here" on the event page
    'public.event_open(text)',                -- rules on captions and the room
    'public.sitka_event(text)',               -- one event's public fields
    'public.sitka_recap(text)',               -- one shared recap
    'public.sitka_shared_owner(text)',        -- rules on a shared recording
    'public.sitka_course_preview(text)'       -- what a course invitation says
  ] loop
    if to_regprocedure(f) is not null then
      execute format('grant execute on function %s to anon, authenticated', f);
    end if;
  end loop;
end $$;

-- ---------- what the signed-in app may run ----------
do $$
declare f text;
begin
  foreach f in array array[
    'public.sitka_is_member(text)', 'public.sitka_is_lead(text)', 'public.sitka_owns_org(text)',
    'public.sitka_space_org(text)', 'public.sitka_can_see_space(text)', 'public.sitka_teaches(text)',
    'public.sitka_owns_event(text)', 'public.sitka_owns_session(text)', 'public.sitka_public_file_mine(text,text)',
    'public.sitka_new_code(integer)', 'public.sitka_org_count()', 'public.sitka_num(text)',
    'public.sitka_role()', 'public.sitka_caller_key()',
    'public.sitka_create_org(text,text)', 'public.sitka_my_orgs()', 'public.sitka_join_org(text)',
    'public.sitka_delete_org(text)', 'public.sitka_restore_org(text)', 'public.sitka_org_new_codes(text)',
    'public.sitka_org_overview(text)', 'public.sitka_org_set_role(text,uuid,text)', 'public.sitka_org_remove(text,uuid)',
    'public.sitka_org_rename(text,text)', 'public.sitka_org_rules(text,text[],text)',
    'public.sitka_space_sessions(text)', 'public.sitka_space_session(text)', 'public.sitka_space_insights(text)',
    'public.sitka_unfile_session(text)', 'public.sitka_create_course(text,text,text)', 'public.sitka_join_course(text)',
    'public.sitka_my_courses()', 'public.sitka_hide_course(text,boolean)', 'public.sitka_course_live(text,text,text)',
    'public.sitka_can_watch(text)', 'public.sitka_course_code()',
    'public.sitka_attend_keep(uuid,boolean)', 'public.sitka_my_live()', 'public.sitka_event_keep_all(text,text)',
    'public.sitka_keep_event(text)', 'public.sweep_stale_events()',
    'public.my_usage()',
    'public.is_admin()', 'public.admin_overview(integer)', 'public.admin_series(integer)', 'public.admin_retention(integer)',
    'public.admin_people(integer)', 'public.admin_errors(integer)', 'public.admin_live()', 'public.admin_feedback(integer)',
    'public.admin_set_plan(uuid,text,integer,text)', 'public.admin_plans()', 'public.admin_list()', 'public.admin_grant(text,boolean)'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('grant execute on function %s to authenticated', f);
    end if;
  end loop;
end $$;

-- ---------- the result: every function of ours a visitor may run ----------
-- Expect six rows: attendee_count, event_open, sitka_course_preview,
-- sitka_event, sitka_recap, sitka_shared_owner.
select p.oid::regprocedure::text as visitors_may_run
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and pg_get_userbyid(p.proowner) = current_user
  and has_function_privilege('anon', p.oid, 'execute')
order by 1;
