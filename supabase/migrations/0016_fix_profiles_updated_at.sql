-- "record 'new' has no field 'updated_at'" on every profiles UPDATE.
--
-- app_state and app_state_history both got a defensive
-- `alter table ... add column if not exists` right after their
-- `create table if not exists`, because the live tables predate this
-- migration file. profiles did not get the same treatment -- its
-- updated_at only exists inside the create-table block, which no-ops
-- against the pre-existing live table. profiles_touch_updated_at
-- (before update, for each row) then references NEW.updated_at on every
-- UPDATE and fails. This breaks deactivate/reactivate, role changes,
-- profile-request review, and anything else that updates a profiles row.

alter table public.profiles
  add column if not exists updated_at timestamptz not null default now();

-- Same defensive belt-and-braces for the rest of the table -- the live
-- schema has already shown drift once (the role enum). Cheap insurance
-- against any other column that predates this migration file.
alter table public.profiles
  add column if not exists created_at timestamptz not null default now();
alter table public.profiles
  add column if not exists active boolean not null default true;
alter table public.profiles
  add column if not exists created_by uuid references auth.users(id) on delete set null;
