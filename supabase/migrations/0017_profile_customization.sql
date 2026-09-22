-- Player-facing profile customization did not exist anywhere in the app --
-- no columns, no RPC, no UI. This is a v1: nickname + one of 6 curated
-- accent colors, self-service, immediate-apply. Deliberately NOT in scope
-- here: photo upload (needs a Storage bucket + moderation) and the
-- moderation/report/reset/lock queue from PROF-02 -- both real follow-up
-- work, not done in this pass.
--
-- Lives on profiles (the account), not on app_state.players (the canonical
-- roster) -- customization is an overlay the UI layers on top of canonical
-- identity, never a replacement for it.

alter table public.profiles
  add column if not exists display_nickname text;
alter table public.profiles
  add column if not exists accent text;

alter table public.profiles
  drop constraint if exists profiles_accent_check;
alter table public.profiles
  add constraint profiles_accent_check
  check (accent is null or accent in ('amber', 'mint', 'coral', 'violet', 'sky', 'gold'));

alter table public.profiles
  drop constraint if exists profiles_display_nickname_check;
alter table public.profiles
  add constraint profiles_display_nickname_check
  check (display_nickname is null or char_length(display_nickname) between 1 and 24);

create or replace function public.set_own_profile_customization(p_nickname text, p_accent text)
returns public.profiles language plpgsql security definer set search_path = public
as $$
declare result public.profiles; clean_nickname text;
begin
  if not exists (select 1 from public.profiles where user_id = auth.uid() and active) then
    raise exception 'Not authenticated';
  end if;
  clean_nickname := nullif(trim(both from p_nickname), '');
  if clean_nickname is not null and char_length(clean_nickname) > 24 then
    raise exception 'Nickname must be 24 characters or fewer';
  end if;
  if p_accent is not null and p_accent not in ('amber', 'mint', 'coral', 'violet', 'sky', 'gold') then
    raise exception 'Invalid accent color';
  end if;
  update public.profiles set display_nickname = clean_nickname, accent = p_accent
    where user_id = auth.uid()
    returning * into result;
  perform public.log_audit_event('set_profile_customization', 'profile', auth.uid()::text, jsonb_build_object('nickname', clean_nickname, 'accent', p_accent));
  return result;
end $$;
grant execute on function public.set_own_profile_customization(text, text) to authenticated;
