create or replace function public.has_capability(p_capability text)
returns boolean language sql stable security definer set search_path = public
as $$
  select (
    exists (select 1 from public.authz_user_exceptions e where e.user_id=auth.uid() and e.capability_id=p_capability and e.effect='ALLOW')
    and not exists (select 1 from public.authz_user_exceptions e where e.user_id=auth.uid() and e.capability_id=p_capability and e.effect='DENY')
  ) or (
    not exists (select 1 from public.authz_user_exceptions e where e.user_id=auth.uid() and e.capability_id=p_capability)
    and exists (select 1 from public.authz_user_roles ur join public.authz_roles r on r.id=ur.role_id and r.active join public.authz_role_capabilities rc on rc.role_id=r.id and rc.capability_id=p_capability where ur.user_id=auth.uid())
  ) or (
    (p_capability='games:score_match' and public.has_admin_role('referee'))
    or (p_capability in ('games:approve_match','authz:manage_roles','authz:assign_roles','audit:view_all','audit:rewind','roster:manage_access') and public.has_admin_role('sysadmin'))
  );
$$;
