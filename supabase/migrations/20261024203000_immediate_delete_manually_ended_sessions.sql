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

  -- Child rows (members, invites, access requests and edit events) use ON DELETE
  -- CASCADE, so they are removed in this same transaction with the workspace.
  delete from public.party_sessions
    where id=p_session_id and owner_user_id=v_user_id
    returning id into v_deleted_id;

  if not found then raise exception 'SESSION_NOT_FOUND_OR_OWNER_REQUIRED' using errcode = '42501'; end if;
  return jsonb_build_object('status','deleted','session_id',v_deleted_id,'deleted_immediately',true);
end;
$$;

revoke all on function public.archive_party_session(uuid) from public, anon;
grant execute on function public.archive_party_session(uuid) to authenticated;
