-- Dynamic capability authorization foundation.
-- This migration is additive: legacy profiles continue to work while role
-- assignments are moved into the configurable authorization tables.

create extension if not exists pgcrypto;

create table if not exists public.authz_capabilities (
  id text primary key,
  description text not null,
  category text not null
);

create table if not exists public.authz_roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  rank integer not null default 0 check (rank >= 0),
  is_preset boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.authz_role_capabilities (
  role_id uuid not null references public.authz_roles(id) on delete cascade,
  capability_id text not null references public.authz_capabilities(id) on delete cascade,
  primary key (role_id, capability_id)
);

create table if not exists public.authz_user_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role_id uuid not null references public.authz_roles(id) on delete cascade,
  primary key (user_id, role_id)
);

do $$ begin
  create type public.authz_effect as enum ('ALLOW', 'DENY');
exception when duplicate_object then null; end $$;

create table if not exists public.authz_user_exceptions (
  user_id uuid not null references auth.users(id) on delete cascade,
  capability_id text not null references public.authz_capabilities(id) on delete cascade,
  effect public.authz_effect not null,
  primary key (user_id, capability_id)
);

insert into public.authz_capabilities (id, description, category) values
  ('league:edit_settings', 'Change league settings', 'League'),
  ('roster:edit_player', 'Edit player profile data', 'Roster'),
  ('roster:manage_access', 'Approve links and manage access', 'Roster'),
  ('games:score_match', 'Record or submit a match', 'Games'),
  ('games:approve_match', 'Approve or reject submitted matches', 'Games'),
  ('games:edit_history', 'Correct or void official matches', 'Games'),
  ('authz:manage_roles', 'Create and edit roles and capabilities', 'Authorization'),
  ('authz:assign_roles', 'Assign roles to users', 'Authorization'),
  ('audit:view_all', 'Read the complete audit history', 'Audit'),
  ('audit:rewind', 'Restore an audited state change', 'Audit')
on conflict (id) do update set description = excluded.description, category = excluded.category;

insert into public.authz_roles (name, rank, is_preset) values
  ('Admin', 100, true), ('Game Admin', 50, true), ('Referee', 20, true), ('Player', 0, true)
on conflict (name) do update set rank = excluded.rank, is_preset = true;

insert into public.authz_role_capabilities (role_id, capability_id)
select r.id, c.id from public.authz_roles r cross join public.authz_capabilities c
where r.name = 'Admin'
on conflict do nothing;
insert into public.authz_role_capabilities (role_id, capability_id)
select r.id, c.id from public.authz_roles r join public.authz_capabilities c
  on c.id in ('games:score_match','games:approve_match','games:edit_history')
where r.name = 'Game Admin' on conflict do nothing;
insert into public.authz_role_capabilities (role_id, capability_id)
select r.id, c.id from public.authz_roles r join public.authz_capabilities c
  on c.id in ('games:score_match')
where r.name = 'Referee' on conflict do nothing;
insert into public.authz_role_capabilities (role_id, capability_id)
select r.id, c.id from public.authz_roles r join public.authz_capabilities c
  on c.id in ('games:score_match')
where r.name = 'Player' on conflict do nothing;

create or replace function public.has_capability(p_capability text)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.authz_user_exceptions e
    where e.user_id = auth.uid() and e.capability_id = p_capability and e.effect = 'ALLOW'
  ) and not exists (
    select 1 from public.authz_user_exceptions e
    where e.user_id = auth.uid() and e.capability_id = p_capability and e.effect = 'DENY'
  )
  or (
    not exists (select 1 from public.authz_user_exceptions e where e.user_id = auth.uid() and e.capability_id = p_capability)
    and exists (
      select 1 from public.authz_user_roles ur
      join public.authz_roles r on r.id = ur.role_id and r.active
      join public.authz_role_capabilities rc on rc.role_id = r.id and rc.capability_id = p_capability
      where ur.user_id = auth.uid()
    )
  )
  or (p_capability = 'games:score_match' and public.has_admin_role('referee'));
$$;

grant execute on function public.has_capability(text) to authenticated;

alter table public.authz_capabilities enable row level security;
alter table public.authz_roles enable row level security;
alter table public.authz_role_capabilities enable row level security;
alter table public.authz_user_roles enable row level security;
alter table public.authz_user_exceptions enable row level security;

drop policy if exists "Authenticated users can read capabilities" on public.authz_capabilities;
create policy "Authenticated users can read capabilities" on public.authz_capabilities for select to authenticated using (true);
drop policy if exists "Authenticated users can read active roles" on public.authz_roles;
create policy "Authenticated users can read active roles" on public.authz_roles for select to authenticated using (active = true);
drop policy if exists "Authenticated users can read role grants" on public.authz_role_capabilities;
create policy "Authenticated users can read role grants" on public.authz_role_capabilities for select to authenticated using (true);
drop policy if exists "Users can read own role assignments" on public.authz_user_roles;
create policy "Users can read own role assignments" on public.authz_user_roles for select to authenticated using (user_id = auth.uid());
drop policy if exists "Users can read own exceptions" on public.authz_user_exceptions;
create policy "Users can read own exceptions" on public.authz_user_exceptions for select to authenticated using (user_id = auth.uid());

-- No browser insert/update/delete policies are granted. Mutations must be
-- added as audited, hierarchy-aware SECURITY DEFINER commands.
