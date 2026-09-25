-- Wave 17: a lead (or the owner) may take someone else's session out of a
-- space they lead. The session itself stays with the person who recorded
-- it; only its filing changes. Run in the Supabase SQL editor.

create or replace function public.sitka_unfile_session(p_id text)
returns void
language plpgsql security definer as $$
declare
  v_space text;
  v_org text;
begin
  select s.space_id into v_space from public.sessions s where s.id = p_id;
  if v_space is null then
    return;
  end if;
  v_org := public.sitka_space_org(v_space);
  if not public.sitka_is_lead(v_org) then
    raise exception 'Only a lead of this space can remove sessions from it';
  end if;
  update public.sessions
     set space_id = null,
         meta = meta - 'spaceId',
         updated_at = now()
   where id = p_id;
end;
$$;

revoke all on function public.sitka_unfile_session(text) from public;
grant execute on function public.sitka_unfile_session(text) to authenticated;
