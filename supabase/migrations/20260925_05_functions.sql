-- Sitca hardening, part 5: who may call which database function.
--
-- Run after 20260925_04_storage_buckets.sql. Safe to run more than once.
-- Changes no data.
--
-- Postgres lets everyone run a new function unless told otherwise, so the
-- older scripts' "grant … to authenticated" restricted nothing: anonymous
-- visitors could call every one of them (current_plan told anyone any
-- account's plan). Now:
--   * every function that runs with raised rights has a fixed search_path;
--   * nobody may run a function by default; each role is given the ones it
--     needs: visitors the handful the public pages use, signed-in people the
--     app's, the site's server everything;
--   * functions made later start closed too.

-- ---------- a fixed search path for every raised-rights function ----------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')
  loop
    execute format('alter function %s set search_path = ''''', f.sig);
  end loop;
end $$;

-- ---------- closed by default ----------
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
do $$ begin
  execute 'alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated';
exception when others then null; end $$;

-- the site's server may run everything
grant execute on all functions in schema public to service_role;

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
    -- rules and helpers the database checks on the caller's behalf
    'public.sitka_is_member(text)', 'public.sitka_is_lead(text)', 'public.sitka_owns_org(text)',
    'public.sitka_space_org(text)', 'public.sitka_can_see_space(text)', 'public.sitka_teaches(text)',
    'public.sitka_owns_event(text)', 'public.sitka_owns_session(text)', 'public.sitka_public_file_mine(text,text)',
    'public.sitka_new_code(integer)', 'public.sitka_org_count()', 'public.sitka_num(text)',
    'public.sitka_role()', 'public.sitka_caller_key()',
    -- organisations and courses
    'public.sitka_create_org(text,text)', 'public.sitka_my_orgs()', 'public.sitka_join_org(text)',
    'public.sitka_delete_org(text)', 'public.sitka_restore_org(text)', 'public.sitka_org_new_codes(text)',
    'public.sitka_org_overview(text)', 'public.sitka_org_set_role(text,uuid,text)', 'public.sitka_org_remove(text,uuid)',
    'public.sitka_org_rename(text,text)', 'public.sitka_org_rules(text,text[],text)',
    'public.sitka_space_sessions(text)', 'public.sitka_space_session(text)', 'public.sitka_space_insights(text)',
    'public.sitka_unfile_session(text)', 'public.sitka_create_course(text,text,text)', 'public.sitka_join_course(text)',
    'public.sitka_my_courses()', 'public.sitka_hide_course(text,boolean)', 'public.sitka_course_live(text,text,text)',
    'public.sitka_can_watch(text)', 'public.sitka_course_code()',
    -- live events you attend
    'public.sitka_attend_keep(uuid,boolean)', 'public.sitka_my_live()', 'public.sitka_event_keep_all(text,text)',
    'public.sitka_keep_event(text)', 'public.sweep_stale_events()',
    -- your plan and use
    'public.my_usage()',
    -- the owners' dashboard (each checks is_admin() itself)
    'public.is_admin()', 'public.admin_overview(integer)', 'public.admin_series(integer)', 'public.admin_retention(integer)',
    'public.admin_people(integer)', 'public.admin_errors(integer)', 'public.admin_live()', 'public.admin_feedback(integer)',
    'public.admin_set_plan(uuid,text,integer,text)', 'public.admin_plans()', 'public.admin_list()', 'public.admin_grant(text,boolean)'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('grant execute on function %s to authenticated', f);
    end if;
  end loop;
end $$;

-- deliberately not granted to visitors or the app:
--   current_plan(uuid)            any account's plan (the server asks)
--   sitka_rate_hit, sitka_meter   the server's counters
--   sitka_retention()             the nightly clean-up
--   sitka_attendee_ok             checked inside the rules, never asked directly
--   guard_* and *_guard           triggers (they need no grant to run)
