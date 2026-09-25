-- Sitca hardening, part 6: indexes, checks and links to accounts.
--
-- Run after 20260925_05_functions.sql. Safe to run more than once.
-- Changes no data. Every check and link below is added "not valid": rows
-- already in the database are not examined or touched; only rows written
-- from now on must satisfy them.

-- ---------- the lookups every page makes ----------
create index if not exists sessions_owner_created_idx on public.sessions (owner, created_at desc);
create index if not exists events_owner_idx on public.events (owner);
create index if not exists attendees_event_idx on public.attendees (event_id);
create index if not exists asks_event_status_idx on public.asks (event_id, status);
create index if not exists asks_attendee_idx on public.asks (attendee_id);
create index if not exists speaker_questions_event_status_idx on public.speaker_questions (event_id, status);
create index if not exists speaker_questions_attendee_idx on public.speaker_questions (attendee_id);
create index if not exists reactions_event_kind_idx on public.reactions (event_id, kind);
create index if not exists polls_event_idx on public.polls (event_id, created_at desc);
create index if not exists proxies_event_idx on public.proxies (event_id);
create index if not exists room_notes_event_idx on public.room_notes (event_id);
create index if not exists org_members_user_idx on public.org_members (user_id);
create index if not exists org_spaces_org_idx on public.org_spaces (org_id);
create index if not exists org_materials_space_idx on public.org_materials (space_id);
create index if not exists space_members_user_idx on public.space_members (user_id);
create index if not exists space_chats_user_idx on public.space_chats (user_id);
create index if not exists space_hidden_user_idx on public.space_hidden (user_id);
create index if not exists saved_recaps_recap_idx on public.saved_recaps (recap_id);
create index if not exists memory_objects_owner_idx on public.memory_objects (owner);
create index if not exists creations_owner_idx on public.creations (owner);
create index if not exists brain_chats_owner_idx on public.brain_chats (owner);
create index if not exists coach_projects_owner_idx on public.coach_projects (owner);
create index if not exists organizations_owner_idx on public.organizations (owner);

-- ---------- rules read the caller once per query, not once per row ----------
-- auth.uid() inside a rule is re-evaluated for every row; (select auth.uid())
-- is read once. Every rule in the public schema is rewritten to the second.
do $$
declare
  p record;
  q text;
  c text;
begin
  for p in
    select * from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') ~ '(?<!SELECT )auth\.uid\(\)' or coalesce(with_check, '') ~ '(?<!SELECT )auth\.uid\(\)')
  loop
    q := regexp_replace(p.qual, '(?<!SELECT )auth\.uid\(\)', '(select auth.uid())', 'g');
    c := regexp_replace(p.with_check, '(?<!SELECT )auth\.uid\(\)', '(select auth.uid())', 'g');
    if q is not null then
      execute format('alter policy %I on public.%I using (%s)', p.policyname, p.tablename, q);
    end if;
    if c is not null then
      execute format('alter policy %I on public.%I with check (%s)', p.policyname, p.tablename, c);
    end if;
  end loop;
end $$;

-- ---------- the values a status may take ----------
do $$ begin
  alter table public.events add constraint events_status_known check (status in ('waiting', 'live', 'ended')) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.asks add constraint asks_status_known check (status in ('pending', 'answered', 'error')) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.asks add constraint asks_kind_known check (kind in ('ask', 'catchup', 'pack')) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.speaker_questions add constraint speaker_questions_status_known
    check (status in ('checking', 'submitted', 'already_answered', 'error')) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.polls add constraint polls_status_known check (status in ('open', 'closed')) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.proxies add constraint proxies_status_known check (status in ('pending', 'ready', 'error')) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.attendees add constraint attendees_secret_shape check (secret_hash is null or secret_hash ~ '^[0-9a-f]{64}$') not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.org_spaces add constraint org_spaces_live_url_len check (live_url is null or char_length(live_url) <= 300) not valid;
exception when duplicate_object then null; end $$;

-- ---------- rows that belong to an account go with it ----------
-- When an account is deleted (by the person, or from the dashboard), what
-- is theirs goes too; a count of what they did is kept without their name.
-- Recaps and events are left out: the retired desktop app wrote some
-- without an account, and those stay readable.
do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('sessions', 'owner', 'cascade'),
      ('brain_chats', 'owner', 'cascade'),
      ('coach_projects', 'owner', 'cascade'),
      ('memory_objects', 'owner', 'cascade'),
      ('creations', 'owner', 'cascade'),
      ('saved_recaps', 'user_id', 'cascade'),
      ('space_chats', 'user_id', 'cascade'),
      ('space_hidden', 'user_id', 'cascade'),
      ('space_members', 'user_id', 'cascade'),
      ('org_members', 'user_id', 'cascade'),
      ('plans', 'user_id', 'cascade'),
      ('admins', 'user_id', 'cascade'),
      ('answer_feedback', 'user_id', 'cascade'),
      ('usage_events', 'user_id', 'set null'),
      ('client_errors', 'user_id', 'set null')
    ) as x(tbl, col, on_delete)
  loop
    if to_regclass('public.' || t.tbl) is not null
       and not exists (select 1 from pg_constraint where conname = t.tbl || '_' || t.col || '_account_fk') then
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) references auth.users(id) on delete %s not valid',
        t.tbl, t.tbl || '_' || t.col || '_account_fk', t.col, t.on_delete);
    end if;
  end loop;
end $$;
