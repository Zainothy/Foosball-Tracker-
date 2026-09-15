-- Interim containment for SEC-02.
--
-- Referees and game admins currently share the same whole-state write RPC
-- (update_state_versioned) used for legitimate match/roster editing. Fully
-- blocking that RPC for them (the eventual SEC-02 target) would also block
-- logging/scoring games, since no per-command replacement exists yet --
-- that's phase 3/4 work (configurable authorization + authoritative
-- commands). This migration closes the one concretely reported abuse in the
-- meantime: a referee/gameadmin removing a player from the roster via this
-- path. Sysadmins are unaffected.

create or replace function public.update_state_versioned(
  expected_v integer,
  new_state jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_state jsonb;
  current_v integer;
  current_player_ids jsonb;
  new_player_ids jsonb;
  removed_count integer;
begin
  if not public.has_admin_role('referee') then
    raise exception 'Only an active admin can update app state';
  end if;

  select state
    into current_state
  from public.app_state
  where id = 1
  for update;

  if current_state is not null and not public.has_admin_role('sysadmin') then
    select coalesce(jsonb_agg(elem->>'id'), '[]'::jsonb)
      into current_player_ids
    from jsonb_array_elements(coalesce(current_state->'players', '[]'::jsonb)) elem;

    select coalesce(jsonb_agg(elem->>'id'), '[]'::jsonb)
      into new_player_ids
    from jsonb_array_elements(coalesce(new_state->'players', '[]'::jsonb)) elem;

    select count(*)
      into removed_count
    from jsonb_array_elements_text(current_player_ids) cur(id)
    where not exists (
      select 1
      from jsonb_array_elements_text(new_player_ids) nw(id)
      where nw.id = cur.id
    );

    if removed_count > 0 then
      raise exception 'Referees and game admins cannot remove players from the roster';
    end if;
  end if;

  if current_state is null then
    current_v := 0;
    if coalesce(expected_v, 0) <> 0 then
      return false;
    end if;

    insert into public.app_state (id, state)
    values (1, new_state);
  else
    current_v := coalesce((current_state->>'_v')::integer, 0);
    if current_v <> expected_v then
      return false;
    end if;

    update public.app_state
    set state = new_state
    where id = 1;
  end if;

  perform public.log_audit_event(
    'update_state',
    'app_state',
    '1',
    jsonb_build_object(
      'expected_v', expected_v,
      'new_v', coalesce((new_state->>'_v')::integer, null)
    )
  );

  return true;
end;
$$;

grant execute on function public.update_state_versioned(integer, jsonb) to authenticated;
