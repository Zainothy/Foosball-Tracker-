-- Switch the admin-facing login model from passphrase-only to username +
-- passphrase. Supabase Auth still stores users with an email-shaped internal
-- identifier, but the app and profiles table now use username as the visible
-- identity.

alter table public.profiles
  add column if not exists username text;

update public.profiles
set username = lower(regexp_replace(coalesce(nullif(call_sign, ''), 'admin'), '[^a-zA-Z0-9._-]+', '-', 'g'))
where username is null;

update public.profiles
set username = concat('admin-', left(user_id::text, 8))
where username is null
   or username = ''
   or username !~ '^[a-z0-9][a-z0-9._-]{0,30}[a-z0-9]$';

alter table public.profiles
  alter column username set not null;

create unique index if not exists profiles_username_key
  on public.profiles (username);

alter table public.profiles
  drop constraint if exists profiles_username_format;

alter table public.profiles
  add constraint profiles_username_format
  check (
    username ~ '^[a-z0-9][a-z0-9._-]{0,30}[a-z0-9]$'
    or username ~ '^[a-z0-9]$'
  );

create or replace function public.log_audit_event(
  p_action text,
  p_target_type text default null,
  p_target_id text default null,
  p_details jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor public.profiles%rowtype;
begin
  select *
    into actor
  from public.profiles
  where user_id = auth.uid()
    and active = true;

  if actor.user_id is null then
    raise exception 'Only an active admin can write audit events';
  end if;

  insert into public.audit_log (
    actor_user_id,
    actor_call_sign,
    actor_role,
    action,
    target_type,
    target_id,
    details
  )
  values (
    actor.user_id,
    coalesce(actor.username, actor.call_sign),
    actor.role,
    p_action,
    p_target_type,
    p_target_id,
    p_details
  );
end;
$$;
