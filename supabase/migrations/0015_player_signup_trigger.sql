-- This runs after 0007 has committed the `player` enum value, so it is safe
-- to use that value in the provisioning function on enum-backed databases.
create or replace function public.handle_player_signup()
returns trigger language plpgsql security definer set search_path = public
as $$
declare requested_username text;
begin
  requested_username := lower(regexp_replace(
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    '[^a-z0-9._-]+', '-', 'g'
  ));
  requested_username := left(trim(both '-' from requested_username), 30);
  if requested_username = '' then
    requested_username := 'player-' || left(new.id::text, 8);
  end if;
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
