create or replace function public.ensure_player_profile()
returns public.profiles language plpgsql security definer set search_path = public
as $$
declare account auth.users; result public.profiles; username_value text;
begin
  select * into account from auth.users where id=auth.uid();
  if account.id is null then raise exception 'Not authenticated'; end if;
  select * into result from public.profiles where user_id=account.id;
  if result.user_id is not null then return result; end if;
  username_value := lower(regexp_replace(coalesce(account.raw_user_meta_data->>'username', split_part(account.email,'@',1)), '[^a-z0-9._-]+', '-', 'g'));
  username_value := left(trim(both '-' from username_value), 30);
  if username_value = '' or exists (select 1 from public.profiles where username=username_value) then username_value := 'player-' || left(account.id::text, 8); end if;
  insert into public.profiles(user_id, username, role, call_sign, active) values(account.id, username_value, 'player', username_value, true) returning * into result;
  return result;
end $$;
grant execute on function public.ensure_player_profile() to authenticated;
