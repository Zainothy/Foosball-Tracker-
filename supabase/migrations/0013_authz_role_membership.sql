-- The dynamic role system (0005) could define roles and their capability
-- grants, but nothing could ever put a user into a role or set a per-user
-- exception -- authz_user_roles/authz_user_exceptions had no write path at
-- all. This is the missing half: assign/revoke commands, an exception
-- command, and the read access admins need to see current assignments
-- (previously readable only by the row's own owner).
--
-- Legacy sysadmin is treated as supreme rank (bootstrap bridge, same idea as
-- 0010's capability bridge) until a real protected League owner authority
-- exists. Non-sysadmin legacy roles (referee/gameadmin) carry no rank in
-- this system on their own -- only an assigned authz_roles membership does.

create or replace function public.authz_effective_rank(p_user_id uuid)
returns integer language sql stable security definer set search_path = public
as $$
  select case
    when exists (select 1 from public.profiles p where p.user_id = p_user_id and p.active and p.role = 'sysadmin') then 1000000
    else coalesce(
      (select max(r.rank) from public.authz_user_roles ur
        join public.authz_roles r on r.id = ur.role_id and r.active
        where ur.user_id = p_user_id),
      -1
    )
  end;
$$;
grant execute on function public.authz_effective_rank(uuid) to authenticated;

create or replace function public.admin_assign_authz_role(p_user_id uuid, p_role_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare role_rank_value integer; actor_rank integer; target_rank integer;
begin
  if not public.has_admin_role('sysadmin') and not public.has_capability('authz:assign_roles') then
    raise exception 'Role assignment permission required';
  end if;
  if auth.uid() = p_user_id then raise exception 'You cannot change your own access'; end if;
  select rank into role_rank_value from public.authz_roles where id = p_role_id and active;
  if role_rank_value is null then raise exception 'Role not found'; end if;
  actor_rank := public.authz_effective_rank(auth.uid());
  target_rank := public.authz_effective_rank(p_user_id);
  if actor_rank <= role_rank_value or actor_rank <= target_rank then
    raise exception 'You must strictly outrank the role and the target account';
  end if;
  insert into public.authz_user_roles (user_id, role_id) values (p_user_id, p_role_id)
    on conflict do nothing;
  perform public.log_audit_event('assign_authz_role', 'profile', p_user_id::text, jsonb_build_object('role_id', p_role_id));
end $$;
grant execute on function public.admin_assign_authz_role(uuid, uuid) to authenticated;

create or replace function public.admin_revoke_authz_role(p_user_id uuid, p_role_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare role_rank_value integer; actor_rank integer;
begin
  if not public.has_admin_role('sysadmin') and not public.has_capability('authz:assign_roles') then
    raise exception 'Role assignment permission required';
  end if;
  if auth.uid() = p_user_id then raise exception 'You cannot change your own access'; end if;
  select rank into role_rank_value from public.authz_roles where id = p_role_id;
  if role_rank_value is null then raise exception 'Role not found'; end if;
  actor_rank := public.authz_effective_rank(auth.uid());
  if actor_rank <= role_rank_value or actor_rank <= public.authz_effective_rank(p_user_id) then
    raise exception 'You must strictly outrank the role and the target account';
  end if;
  delete from public.authz_user_roles where user_id = p_user_id and role_id = p_role_id;
  perform public.log_audit_event('revoke_authz_role', 'profile', p_user_id::text, jsonb_build_object('role_id', p_role_id));
end $$;
grant execute on function public.admin_revoke_authz_role(uuid, uuid) to authenticated;

create or replace function public.admin_set_authz_exception(p_user_id uuid, p_capability_id text, p_effect text)
returns void language plpgsql security definer set search_path = public
as $$
declare actor_rank integer;
begin
  if not public.has_admin_role('sysadmin') and not public.has_capability('authz:assign_roles') then
    raise exception 'Role assignment permission required';
  end if;
  if auth.uid() = p_user_id then raise exception 'You cannot change your own access'; end if;
  if p_effect is not null and p_effect not in ('ALLOW', 'DENY') then raise exception 'Invalid effect'; end if;
  actor_rank := public.authz_effective_rank(auth.uid());
  if actor_rank <= public.authz_effective_rank(p_user_id) then
    raise exception 'You must strictly outrank the target account';
  end if;
  if p_effect is null then
    delete from public.authz_user_exceptions where user_id = p_user_id and capability_id = p_capability_id;
  else
    insert into public.authz_user_exceptions (user_id, capability_id, effect) values (p_user_id, p_capability_id, p_effect::public.authz_effect)
      on conflict (user_id, capability_id) do update set effect = excluded.effect;
  end if;
  perform public.log_audit_event('set_authz_exception', 'profile', p_user_id::text, jsonb_build_object('capability_id', p_capability_id, 'effect', p_effect));
end $$;
grant execute on function public.admin_set_authz_exception(uuid, text, text) to authenticated;

-- Admins need to see current assignments/exceptions to manage them, not just
-- their own row.
drop policy if exists "Admins can read all role assignments" on public.authz_user_roles;
create policy "Admins can read all role assignments" on public.authz_user_roles
  for select to authenticated
  using (public.has_admin_role('sysadmin') or public.has_capability('authz:assign_roles'));

drop policy if exists "Admins can read all exceptions" on public.authz_user_exceptions;
create policy "Admins can read all exceptions" on public.authz_user_exceptions
  for select to authenticated
  using (public.has_admin_role('sysadmin') or public.has_capability('authz:assign_roles'));
