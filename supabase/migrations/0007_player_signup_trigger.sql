-- Ordinary players can self-register. The trigger creates the linked app
-- profile because browser clients are intentionally not allowed to insert
-- directly into public.profiles.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('player', 'referee', 'gameadmin', 'sysadmin'));
alter table public.profiles add column if not exists player_id text;

create or replace function public.handle_player_signup()
returns trigger language plpgsql security definer set search_path = public
as $$
declare requested_username text;
begin
  requested_username := lower(regexp_replace(coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)), '[^a-z0-9._-]+', '-', 'g'));
  requested_username := left(trim(both '-' from requested_username), 30);
  if requested_username = '' then requested_username := 'player-' || left(new.id::text, 8); end if;
  if exists (select 1 from public.profiles where username = requested_username) then
    requested_username := left(requested_username, 20) || '-' || left(new.id::text, 8);
  end if;
  insert into public.profiles (user_id, username, role, call_sign, active)
  values (new.id, requested_username, 'player', requested_username, true)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_player_profile on auth.users;
create trigger on_auth_user_created_player_profile
  after insert on auth.users
  for each row execute function public.handle_player_signup();
