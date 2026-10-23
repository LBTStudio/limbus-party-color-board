-- Do not reveal whether an unrelated session has been archived.
-- A closed status is returned only to its owner, a current/former member, or a user
-- whose access request is associated with that session.
create or replace function public.check_my_party_access(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_status text;
  v_role text;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;

  if exists (
    select 1 from public.party_sessions s
    where s.id=p_session_id
      and s.archived_at is not null
      and (
        s.owner_user_id=v_user_id
        or exists (
          select 1 from public.session_members m
          where m.session_id=s.id and m.user_id=v_user_id
        )
        or exists (
          select 1 from public.session_access_requests r
          where r.session_id=s.id and r.user_id=v_user_id
        )
      )
  ) then
    return jsonb_build_object('status','closed','session_id',p_session_id);
  end if;

  select m.role into v_role from public.session_members m
    where m.session_id=p_session_id and m.user_id=v_user_id;
  if found then return jsonb_build_object('status','approved','session_id',p_session_id,'role',v_role); end if;

  select r.status into v_status from public.session_access_requests r
    where r.session_id=p_session_id and r.user_id=v_user_id;
  return jsonb_build_object('status',coalesce(v_status,'not_requested'),'session_id',p_session_id);
end;
$$;

revoke all on function public.check_my_party_access(uuid) from public, anon;
grant execute on function public.check_my_party_access(uuid) to authenticated;
