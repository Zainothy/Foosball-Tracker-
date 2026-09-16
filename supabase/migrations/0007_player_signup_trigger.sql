-- Ordinary players can self-register. Existing production databases use the
-- admin_role enum while early local databases used text, so support both
-- representations before adding the player profile path.
do $$
declare role_is_enum boolean;
begin
  select t.typtype = 'e'
    into role_is_enum
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  where n.nspname = 'public' and c.relname = 'profiles' and a.attname = 'role'
    and not a.attisdropped;

  if role_is_enum then
    -- `role` is public.admin_role in the deployed project.
    alter type public.admin_role add value if not exists 'player';
  else
    alter table public.profiles drop constraint if exists profiles_role_check;
    alter table public.profiles add constraint profiles_role_check
      check (role in ('player', 'referee', 'gameadmin', 'sysadmin'));
  end if;
end $$;
alter table public.profiles add column if not exists player_id text;
