-- "Initial migration maps current staff accounts to explicit presets
-- without promoting ordinary accounts" (ACCOUNT-GOVERNANCE.md) was never
-- implemented. Concretely: the legacy bridge in 0010 only grants
-- games:approve_match to sysadmin (has_admin_role('sysadmin') is an exact
-- floor, not "gameadmin or higher"), so every existing gameadmin lost the
-- ability to approve submitted games the moment 0010 was applied -- nothing
-- had ever put them in the new authz_user_roles table.
--
-- One-time, idempotent backfill: map active referee/gameadmin/sysadmin
-- profiles onto the matching preset dynamic role. Ordinary players are not
-- touched.
insert into public.authz_user_roles (user_id, role_id)
select p.user_id, r.id
from public.profiles p
join public.authz_roles r on r.is_preset and lower(r.name) = case p.role
  when 'sysadmin' then 'admin'
  when 'gameadmin' then 'game admin'
  when 'referee' then 'referee'
  else null
end
where p.active and p.role in ('sysadmin', 'gameadmin', 'referee')
on conflict do nothing;
