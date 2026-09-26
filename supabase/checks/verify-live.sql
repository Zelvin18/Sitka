-- What the live database really contains, for the release notes.
--
-- Read-only: it only looks. Run after migration 09. Paste it into the Supabase SQL editor and run it;
-- everything comes back as one table (check · item · detail), which can be
-- exported as CSV from the results pane and kept with the release notes.
-- From both reports of 26 September; each part checks something the
-- migrations cannot check about themselves.

with checks (ord, "check", item, detail) as (
  -- 1. which migrations have run (from part 9 on)
  select 1, 'migration ran', name, ran_at::text from public.schema_migrations

  -- 2. functions visitors can run (expect exactly six)
  union all
  select 2, 'visitors may run', p.oid::regprocedure::text, 'owner ' || pg_get_userbyid(p.proowner)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')

  -- 3. raised-rights functions without a fixed search path (expect none)
  union all
  select 3, 'no fixed search path', p.oid::regprocedure::text, 'owner ' || pg_get_userbyid(p.proowner)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')

  -- 4. every row-level rule
  union all
  select 4, 'rule', schemaname || '.' || tablename, policyname || ' · ' || cmd || ' · ' || array_to_string(roles, ',')
  from pg_policies where schemaname in ('public', 'storage')

  -- 5. what visitors and signed-in people may do with each table
  union all
  select 5, 'table access', table_name || ' · ' || grantee, string_agg(privilege_type, ',' order by privilege_type)
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated')
  group by table_name, grantee

  -- 6. the triggers the migrations add
  union all
  select distinct 6, 'trigger', event_object_table, trigger_name
  from information_schema.triggers where trigger_schema = 'public'

  -- 7. new tables and columns (expect every one "present")
  union all
  select 7, 'table', t, case when to_regclass('public.' || t) is null then 'MISSING' else 'present' end
  from unnest(array['rate_hits', 'usage_meter', 'deleted_sessions', 'schema_migrations']) t
  union all
  select 7, 'column', tc, case when exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name || '.' || column_name = tc) then 'present' else 'MISSING' end
  from unnest(array['attendees.secret_hash', 'room_messages.author', 'organizations.deleted_at']) tc

  -- 8. checks added as "not valid" (false = not yet checked against old rows)
  union all
  select 8, 'check validated', conname, convalidated::text from pg_constraint
  where conname ~ '(_account_fk|_known|attendees_secret_shape|org_spaces_live_url_len)$'

  -- 9. the storage buckets' limits
  union all
  select 9, 'bucket', id, 'public ' || public || ' · size limit ' || coalesce(file_size_limit::text, 'none') || ' · types ' || coalesce(array_to_string(allowed_mime_types, ','), 'any')
  from storage.buckets where id in ('stage', 'replays', 'recordings')

  -- 10. the nightly clean-up: scheduled, and how its last runs went
  union all
  select 10, 'scheduled job', jobname, schedule || ' · active ' || active from cron.job
  union all
  select * from (
    select 11, 'job run', j.jobname, d.status || ' · ' || d.start_time::text || ' · ' || left(coalesce(d.return_message, ''), 160)
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    order by d.start_time desc limit 5
  ) last_runs

  -- 11. owner rows that are not the organisation's owner (expect none after part 9)
  union all
  select 12, 'stray owner row', m.org_id, m.user_id::text
  from public.org_members m join public.organizations o on o.id = m.org_id
  where m.role = 'owner' and m.user_id <> o.owner
)
select "check", item, detail from checks order by ord, item, detail;
