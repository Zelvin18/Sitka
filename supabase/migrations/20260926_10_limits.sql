-- Sitca hardening, part 10: limits on what anyone can write, and old rules
-- tidied (the second audit's database items).
--
-- Run after 20260926_09_reaudit.sql. Safe to run more than once.
--
-- * The free database stops taking writes at 500 MB. Visitors write error
--   reports and usage events; one address could send hundreds of megabytes a
--   day. Each row is now kept small, and all visitors together have an
--   hourly ceiling. A session's text has a size limit too.
-- * Callers are told apart by the address the network saw, not one a script
--   can name in a header (x-forwarded-for, x-real-ip).
-- * Functions made later start closed to visitors: part 5's revoke was the
--   schema-level kind, which cannot take away Postgres's own grant to
--   everyone.
-- * Checks added "not valid" by part 6 were re-checked on every update, so
--   an old row with an odd status could no longer be changed. Odd values are
--   put right, and each check is then validated.
-- * A lead's short invitation code (six letters, guessable) is replaced by a
--   long one; the owner sees the new one in the app. A space written straight
--   into the table gets a code from the database and no live link.

-- ---------- 1. who is calling: the address the network saw ----------
-- Cloudflare's own header, then the last address the proxies added (a
-- caller can put anything at the front of x-forwarded-for, not at the end).
create or replace function public.sitka_caller_key()
returns text language sql stable set search_path = '' as $$
  select coalesce(
    (select auth.uid())::text,
    nullif(trim((nullif(current_setting('request.headers', true), '')::json)->>'cf-connecting-ip'), ''),
    nullif(trim(reverse(split_part(reverse(coalesce((nullif(current_setting('request.headers', true), '')::json)->>'x-forwarded-for', '')), ',', 1))), ''),
    'anon'
  );
$$;

-- ---------- 2. error reports and usage events: small, and a ceiling ----------
create or replace function public.guard_telemetry()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  me text := public.sitka_caller_key();
  signed_in boolean := (select auth.uid()) is not null;
begin
  if public.sitka_role() = 'service_role' then return new; end if;
  -- per account or address; callers whose address is unknown share one
  -- much larger allowance, so a missing header never silences real reports
  if public.sitka_rate_hit(tg_table_name || ':' || me,
                           case when me = 'anon' then 1200
                                when tg_table_name = 'client_errors' then 30 else 120 end,
                           case when me = 'anon' then 24000
                                when tg_table_name = 'client_errors' then 300 else 2400 end) then
    raise exception 'too many reports';
  end if;
  -- all visitors together, however many addresses they use
  if not signed_in and public.sitka_rate_hit(tg_table_name || ':all-visitors', 2000, 20000) then
    raise exception 'too many reports';
  end if;
  -- each row small: a report is a message, not a file
  if tg_table_name = 'client_errors' then
    -- only the site's server reports server errors; a page claiming to be it is marked as a page
    if new.page like 'server:%' then new.page := 'page ' || new.page; end if;
    new.message := left(coalesce(new.message, ''), 2000);
    new.stack := left(new.stack, 4000);
    new.page := left(new.page, 300);
    new.ua := left(new.ua, 300);
  else
    new.name := left(new.name, 60);
    new.platform := left(new.platform, 40);
    new.ua := left(new.ua, 300);
    if pg_column_size(new.props) > 2000 then new.props := '{}'::jsonb; end if;
  end if;
  return new;
end $$;

-- ---------- 3. a session's text has a size ----------
-- Far above the longest lecture (a three-hour transcript is well under a
-- megabyte); what it stops is a script filling the database.
create or replace function public.sitka_session_size_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if public.sitka_role() = 'service_role' then return new; end if;
  if pg_column_size(new.transcript) > 8 * 1024 * 1024
     or pg_column_size(new.chat) > 4 * 1024 * 1024
     or pg_column_size(new.meta) > 512 * 1024
     or coalesce(pg_column_size(new.notes), 0) > 2 * 1024 * 1024
     or coalesce(pg_column_size(new.study), 0) > 2 * 1024 * 1024
     or coalesce(pg_column_size(new.report), 0) > 2 * 1024 * 1024 then
    raise exception 'This session is larger than Sitca keeps.';
  end if;
  return new;
end $$;
drop trigger if exists sessions_size_guard on public.sessions;
create trigger sessions_size_guard
  before insert or update on public.sessions
  for each row execute function public.sitka_session_size_guard();

-- a live caption line, a room message: a line, not a page
create or replace function public.sitka_line_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if public.sitka_role() = 'service_role' then return new; end if;
  if char_length(coalesce(new.text, '')) > 4000 then
    raise exception 'That is longer than a line.';
  end if;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['segments', 'translations', 'room_messages', 'room_notes'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists line_guard on public.%I', t);
      execute format('create trigger line_guard before insert or update on public.%I for each row execute function public.sitka_line_guard()', t);
    end if;
  end loop;
end $$;

-- ---------- 4. functions made later start closed ----------
-- Postgres lets everyone run a new function unless the grant is taken away
-- for the role that makes it, without naming a schema.
do $$ begin
  alter default privileges for role postgres revoke execute on functions from public;
exception when others then raise notice 'Default privileges for postgres left as they were: %', sqlerrm; end $$;
do $$ begin
  alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
exception when others then raise notice 'Schema defaults left as they were: %', sqlerrm; end $$;

-- ---------- 5. old rows with odd values, then the checks made whole ----------
update public.events set status = 'ended' where status not in ('waiting', 'live', 'ended');
update public.asks set status = 'error' where status not in ('pending', 'answered', 'error');
update public.asks set kind = 'ask' where kind not in ('ask', 'catchup', 'pack');
update public.speaker_questions set status = 'error' where status not in ('checking', 'submitted', 'already_answered', 'error');
update public.polls set status = 'closed' where status not in ('open', 'closed');
update public.proxies set status = 'error' where status not in ('pending', 'ready', 'error');
update public.attendees set secret_hash = null where secret_hash is not null and secret_hash !~ '^[0-9a-f]{64}$';
update public.org_spaces set live_url = null where live_url is not null and char_length(live_url) > 300;
do $$
declare c record;
begin
  -- every check and account link still "not valid": validated where the rows
  -- allow; a link to an account that no longer exists leaves its check as it
  -- was (named in the notices), and nothing is deleted to make it pass
  for c in
    select conrelid::regclass as tbl, conname from pg_constraint
    where not convalidated and connamespace = 'public'::regnamespace
      and conname ~ '(_known|_shape|_len|_account_fk)$'
  loop
    begin
      execute format('alter table %s validate constraint %I', c.tbl, c.conname);
    exception when others then
      raise notice 'Left not valid: % (%)', c.conname, sqlerrm;
    end;
  end loop;
end $$;

-- ---------- 6. codes and spaces ----------
update public.organizations set lead_code = public.sitka_new_code(12)
 where lead_code is not null and char_length(lead_code) < 12;

-- A space written straight into the table (a lead may make a team or a
-- project space that way) gets its code from the database and no live link:
-- the live link is set only through sitka_set_live, which checks it.
create or replace function public.sitka_space_insert_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if public.sitka_role() = 'service_role' then return new; end if;
  if new.code is not null or new.kind = 'course' then new.code := public.sitka_new_code(12); end if;
  new.live_url := null;
  new.live_event_id := null;
  new.live_at := null;
  return new;
end $$;
drop trigger if exists org_spaces_insert_guard on public.org_spaces;
create trigger org_spaces_insert_guard
  before insert on public.org_spaces
  for each row execute function public.sitka_space_insert_guard();

revoke execute on function public.sitka_session_size_guard() from public, anon, authenticated;
revoke execute on function public.sitka_line_guard() from public, anon, authenticated;
revoke execute on function public.sitka_space_insert_guard() from public, anon, authenticated;

insert into public.schema_migrations (name) values ('20260926_10_limits')
on conflict (name) do update set ran_at = now();
