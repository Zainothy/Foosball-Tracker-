-- Remove any dashboard-created or earlier permissive policies, then recreate
-- the Phase 1 security boundary in one known shape.

do $$
declare
  policy_record record;
begin
  for policy_record in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('app_state', 'app_state_history', 'profiles', 'audit_log')
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policy_record.policyname,
      policy_record.schemaname,
      policy_record.tablename
    );
  end loop;
end $$;

alter table public.app_state enable row level security;
alter table public.app_state_history enable row level security;
alter table public.profiles enable row level security;
alter table public.audit_log enable row level security;

create policy "Public can read current app state"
on public.app_state
for select
to anon, authenticated
using (true);

create policy "Admins can read app state history"
on public.app_state_history
for select
to authenticated
using (public.has_admin_role('referee'));

create policy "Admins can create app state history"
on public.app_state_history
for insert
to authenticated
with check (public.has_admin_role('referee'));

create policy "Sysadmins can prune app state history"
on public.app_state_history
for delete
to authenticated
using (public.has_admin_role('sysadmin'));

create policy "Admins can read own profile"
on public.profiles
for select
to authenticated
using (user_id = auth.uid() and active = true);

create policy "Sysadmins can read all profiles"
on public.profiles
for select
to authenticated
using (public.has_admin_role('sysadmin'));

create policy "Sysadmins can update profiles"
on public.profiles
for update
to authenticated
using (public.has_admin_role('sysadmin'))
with check (public.has_admin_role('sysadmin'));

create policy "Admins can read audit log"
on public.audit_log
for select
to authenticated
using (public.has_admin_role('referee'));
