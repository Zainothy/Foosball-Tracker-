create or replace function public.admin_update_profile(
  p_user_id uuid,
  p_role text default null,
  p_active boolean default null,
  p_player_id text default null
)
returns public.profiles language plpgsql security definer set search_path = public
as $$
declare actor public.profiles; target public.profiles; next_role text;
begin
  select * into actor from public.profiles where user_id=auth.uid() and active for update;
  select * into target from public.profiles where user_id=p_user_id for update;
  if actor.user_id is null or target.user_id is null then raise exception 'Account not found'; end if;
  if actor.user_id = target.user_id then raise exception 'You cannot change your own access'; end if;
  if public.role_rank(actor.role) <= public.role_rank(target.role) then raise exception 'You must strictly outrank the target account'; end if;
  next_role := coalesce(p_role, target.role);
  if public.role_rank(actor.role) <= public.role_rank(next_role) then raise exception 'You cannot grant an equal or higher role'; end if;
  update public.profiles set role=next_role, active=coalesce(p_active, active), player_id=coalesce(p_player_id, player_id) where user_id=p_user_id returning * into target;
  perform public.log_audit_event('admin_update_profile','profile',p_user_id::text,jsonb_build_object('role',next_role,'active',target.active,'player_id',target.player_id));
  return target;
end $$;
grant execute on function public.admin_update_profile(uuid,text,boolean,text) to authenticated;

create or replace function public.review_profile_request(p_request_id uuid, p_status text, p_player_id text default null)
returns public.profile_requests language plpgsql security definer set search_path = public
as $$
declare request_row public.profile_requests;
begin
  if not public.has_admin_role('sysadmin') and not public.has_capability('roster:manage_access') then raise exception 'Access management permission required'; end if;
  if p_status not in ('approved','rejected','cancelled') then raise exception 'Invalid request status'; end if;
  update public.profile_requests set status=p_status, reviewed_by=auth.uid(), reviewed_at=now(), player_id=coalesce(p_player_id, player_id)
    where id=p_request_id and status='pending' returning * into request_row;
  if request_row.id is null then raise exception 'Request not found or already reviewed'; end if;
  if p_status='approved' and request_row.request_type='profile_claim' and request_row.player_id is not null then
    update public.profiles set player_id=request_row.player_id where user_id=request_row.user_id;
  end if;
  perform public.log_audit_event('review_profile_request','profile_request',request_row.id::text,jsonb_build_object('status',p_status,'request_type',request_row.request_type,'player_id',request_row.player_id));
  return request_row;
end $$;
grant execute on function public.review_profile_request(uuid,text,text) to authenticated;
