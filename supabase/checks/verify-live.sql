-- What the live database really contains, for the release notes.
--
-- Read-only: every statement here only looks. Paste the whole file into the
-- Supabase SQL editor, run it, and keep the results (the editor shows the
-- last one; run the sections one at a time to see each). From both reports
-- of 26 September; each checks something the migrations cannot check about
-- themselves.

-- 1. which migrations have run (from part 9 on; none listed = part 9 not run yet)
select name, ran_at from public.schema_migrations order by name;

-- 2. functions visitors can run (expect exactly six), and raised-rights
--    functions without a fixed search path (expect none)
select p.oid::regprocedure as function, pg_get_userbyid(p.proowner) as owner, p.prosecdef as raised_rights, p.proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (has_function_privilege('anon', p.oid, 'execute') or (p.prosecdef and p.proconfig is null))
order by 1;

-- 3. every row-level rule
select schemaname, tablename, policyname, roles, cmd from pg_policies
where schemaname in ('public', 'storage') order by 1, 2, 3;

-- 4. what visitors and signed-in people may do with each table
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as may
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated')
group by 1, 2 order by 1, 2;

-- 5. the triggers the migrations add
select event_object_table as on_table, trigger_name from information_schema.triggers
where trigger_schema = 'public' group by 1, 2 order by 1, 2;

-- 6. new tables and columns (expect every table named, and new_cols = 3)
select to_regclass('public.rate_hits') as rate_hits, to_regclass('public.usage_meter') as usage_meter,
       to_regclass('public.deleted_sessions') as deleted_sessions, to_regclass('public.schema_migrations') as schema_migrations,
  (select count(*) from information_schema.columns where table_schema = 'public' and (table_name, column_name) in
     (('attendees', 'secret_hash'), ('room_messages', 'author'), ('organizations', 'deleted_at'))) as new_cols;

-- 7. checks added as "not valid", and the buckets' limits
select conname, convalidated from pg_constraint
where conname ~ '(_account_fk|_known|attendees_secret_shape|org_spaces_live_url_len)$';
select id, public, file_size_limit, allowed_mime_types from storage.buckets where id in ('stage', 'replays', 'recordings');

-- 8. the nightly clean-up: is it scheduled, and did its last runs succeed?
select jobname, schedule, active from cron.job;
select jobname, status, start_time from cron.job_run_details order by start_time desc limit 5;

-- 9. owner rows that are not the organisation's owner (expect none after part 9)
select m.org_id, m.user_id from public.org_members m join public.organizations o on o.id = m.org_id
where m.role = 'owner' and m.user_id <> o.owner;
