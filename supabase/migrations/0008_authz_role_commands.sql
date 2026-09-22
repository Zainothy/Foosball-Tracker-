create or replace function public.admin_save_authz_role(
  p_role_id uuid,
  p_name text,
  p_rank integer,
  p_capability_ids text[]
)
returns public.authz_roles
language plpgsql security definer set search_path = public
as $$
declare result public.authz_roles; actor_rank integer; existing_rank integer;
begin
  if not public.has_admin_role('sysadmin') and not public.has_capability('authz:manage_roles') then
    raise exception 'Role management permission required';
  end if;
  if coalesce(trim(p_name), '') = '' or p_rank < 0 then raise exception 'Invalid role'; end if;
  select coalesce(max(public.role_rank(p.role::text)), 0) into actor_rank from public.profiles p where p.user_id = auth.uid() and p.active;
  if p_role_id is not null then
    select rank into existing_rank from public.authz_roles where id = p_role_id for update;
    if existing_rank is null then raise exception 'Role not found'; end if;
    if p_rank >= 100 and not public.has_admin_role('sysadmin') then raise exception 'Cannot manage an equal or higher role'; end if;
    update public.authz_roles set name=p_name, rank=p_rank where id=p_role_id returning * into result;
  else
    insert into public.authz_roles(name, rank, is_preset) values (p_name, p_rank, false) returning * into result;
  end if;
  delete from public.authz_role_capabilities where role_id=result.id;
  insert into public.authz_role_capabilities(role_id, capability_id)
    select result.id, c.id from public.authz_capabilities c where c.id = any(coalesce(p_capability_ids, '{}'));
  perform public.log_audit_event('save_authz_role','authz_role',result.id::text,jsonb_build_object('name',result.name,'rank',result.rank,'capabilities',p_capability_ids));
  return result;
end $$;
grant execute on function public.admin_save_authz_role(uuid,text,integer,text[]) to authenticated;
