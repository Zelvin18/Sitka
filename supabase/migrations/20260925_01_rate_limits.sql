-- Sitca hardening, part 1: a rate-limit counter that lasts.
--
-- The API routes count calls per user, per event or per address here, so a
-- limit holds across every server instance and restart. Only the server
-- (service key) touches it; nobody else can read or write it.
-- Safe to run more than once. Nothing existing is changed.

create table if not exists public.rate_hits (
  key text not null,
  at timestamptz not null default now()
);
create index if not exists rate_hits_key_at_idx on public.rate_hits (key, at desc);
create index if not exists rate_hits_at_idx on public.rate_hits (at);
alter table public.rate_hits enable row level security;
-- no policies: anonymous and signed-in users can neither read nor write it
revoke all on public.rate_hits from anon, authenticated;

-- Counts one call for `p_key` and says whether it is over the limit:
-- more than p_minute calls in the last minute, or p_hour in the last hour.
create or replace function public.sitka_rate_hit(p_key text, p_minute int, p_hour int)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  n_minute int;
  n_hour int;
begin
  insert into public.rate_hits (key) values (left(p_key, 160));
  select count(*) filter (where at > now() - interval '1 minute'), count(*)
    into n_minute, n_hour
    from public.rate_hits
   where key = left(p_key, 160) and at > now() - interval '1 hour';
  -- now and then, the old counts are cleared away
  if random() < 0.01 then
    delete from public.rate_hits where at < now() - interval '2 hours';
  end if;
  return n_minute > p_minute or n_hour > p_hour;
end $$;
revoke execute on function public.sitka_rate_hit(text, int, int) from public, anon, authenticated;
grant execute on function public.sitka_rate_hit(text, int, int) to service_role;
