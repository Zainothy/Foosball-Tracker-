create table if not exists public.profile_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  request_type text not null check (request_type in ('profile_claim','onboarding_creation')),
  player_id text,
  canonical_name text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists profile_requests_status_idx on public.profile_requests(status, created_at desc);

create table if not exists public.game_submissions (
  id uuid primary key default gen_random_uuid(),
  submitter_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  payload jsonb not null,
  played_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists game_submissions_status_idx on public.game_submissions(status, created_at desc);

alter table public.profile_requests enable row level security;
alter table public.game_submissions enable row level security;
create policy "users create profile requests" on public.profile_requests for insert to authenticated with check (user_id = auth.uid());
create policy "users read own profile requests" on public.profile_requests for select to authenticated using (user_id = auth.uid() or public.has_capability('authz:assign_roles'));
create policy "linked users create submissions" on public.game_submissions for insert to authenticated with check (submitter_id = auth.uid());
create policy "reviewers read submissions" on public.game_submissions for select to authenticated using (submitter_id = auth.uid() or public.has_capability('games:approve_match'));

create or replace function public.review_game_submission(p_submission_id uuid, p_status text)
returns public.game_submissions language plpgsql security definer set search_path = public
as $$
declare row public.game_submissions;
begin
  if not public.has_capability('games:approve_match') then raise exception 'Not permitted'; end if;
  if p_status not in ('approved','rejected') then raise exception 'Invalid status'; end if;
  update public.game_submissions set status=p_status, reviewed_by=auth.uid(), reviewed_at=now()
    where id=p_submission_id and status='pending' returning * into row;
  if row.id is null then raise exception 'Submission not found or already reviewed'; end if;
  perform public.log_audit_event('review_game_submission','game_submission',row.id::text,jsonb_build_object('status',p_status));
  return row;
end $$;
grant execute on function public.review_game_submission(uuid,text) to authenticated;
