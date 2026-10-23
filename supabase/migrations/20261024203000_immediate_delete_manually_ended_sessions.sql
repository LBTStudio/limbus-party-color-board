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
    'owner_display_name', coalesce(owner_member.display_name, '編成主')
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
