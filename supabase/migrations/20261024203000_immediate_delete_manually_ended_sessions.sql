-- Explicitly ending a workspace is a deliberate, irreversible deletion.
-- Idle workspaces still follow the separate 30-day idle archive + 7-day purge policy.
create or replace function public.archive_party_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_deleted_id uuid;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;

  -- The four child tables use ON DELETE CASCADE, so their rows are removed
  -- in the same transaction. Only the owning user can perform this operation.
  delete from public.party_sessions
    where id=p_session_id and owner_user_id=v_user_id
    returning id into v_deleted_id;

  if not found then raise exception 'SESSION_NOT_FOUND_OR_OWNER_REQUIRED' using errcode = '42501'; end if;
  return jsonb_build_object('status','deleted','session_id',v_deleted_id,'deleted_immediately',true);
end;
$$;

revoke all on function public.archive_party_session(uuid) from public, anon;
grant execute on function public.archive_party_session(uuid) to authenticated;

-- Add the creator's participant display name to the per-user workspace list.
-- This does not broaden access: results are still restricted to current members.
create or replace function public.list_my_party_sessions()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_result jsonb;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'session_id', s.id,
    'title', s.title,
    'role', m.role,
    'revision', s.revision,
    'updated_at', s.updated_at,
    'last_activity_at', s.last_activity_at,
    'owner_display_name', coalesce(owner_member.display_name, '編成主'),
    'member_count', (select count(*)::integer from public.session_members count_member where count_member.session_id = s.id)
  ) order by s.updated_at desc), '[]'::jsonb)
  into v_result
  from public.party_sessions s
  join public.session_members m on m.session_id = s.id and m.user_id = v_user_id
  left join public.session_members owner_member
    on owner_member.session_id = s.id
   and owner_member.user_id = s.owner_user_id
   and owner_member.role = 'owner'
  where s.archived_at is null;

  return v_result;
end;
$$;

revoke all on function public.list_my_party_sessions() from public, anon;
grant execute on function public.list_my_party_sessions() to authenticated;

-- Enforce the 16-member limit in the serialized approval RPC. The owner counts as one member.
create or replace function public.decide_party_access_request(p_request_id uuid, p_decision text, p_role text default 'editor')
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_request public.session_access_requests%rowtype;
  v_owner uuid;
  v_session_id uuid;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select r.session_id into v_session_id from public.session_access_requests r where r.id=p_request_id;
  if not found then raise exception 'REQUEST_NOT_FOUND' using errcode = 'P0002'; end if;

  -- Lock the parent session first so concurrent approvals cannot exceed its member cap.
  perform 1 from public.party_sessions s
    where s.id=v_session_id and s.archived_at is null
    for update;
  if not found then raise exception 'OWNER_REQUIRED' using errcode = '42501'; end if;

  select * into v_request from public.session_access_requests r where r.id=p_request_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND' using errcode = 'P0002'; end if;
  select s.owner_user_id into v_owner from public.party_sessions s
    where s.id=v_request.session_id and s.archived_at is null;
  if not found or v_owner <> v_user_id then raise exception 'OWNER_REQUIRED' using errcode = '42501'; end if;
  if v_request.status <> 'pending' then raise exception 'REQUEST_ALREADY_DECIDED' using errcode = '55000'; end if;

  if p_decision='approve' then
    if p_role not in ('editor','viewer') then raise exception 'ROLE_MUST_BE_EDITOR_OR_VIEWER' using errcode = '22023'; end if;
    if not exists (select 1 from public.session_members m
        where m.session_id=v_request.session_id and m.user_id=v_request.user_id)
       and (select count(*) from public.session_members m where m.session_id=v_request.session_id) >= 16 then
      raise exception 'SESSION_MEMBER_LIMIT' using errcode = '53300';
    end if;
    insert into public.session_members(session_id,user_id,role,display_name)
      values (v_request.session_id,v_request.user_id,p_role,v_request.display_name)
      on conflict (session_id,user_id) do update
        set role=excluded.role,display_name=excluded.display_name;
    update public.session_access_requests set status='approved',decided_by=v_user_id,decided_at=now()
      where id=p_request_id;
    return jsonb_build_object('status','approved','role',p_role);
  elsif p_decision='deny' then
    update public.session_access_requests set status='denied',decided_by=v_user_id,decided_at=now()
      where id=p_request_id;
    return jsonb_build_object('status','denied');
  else
    raise exception 'DECISION_MUST_BE_APPROVE_OR_DENY' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.decide_party_access_request(uuid,text,text) from public, anon;
grant execute on function public.decide_party_access_request(uuid,text,text) to authenticated;
