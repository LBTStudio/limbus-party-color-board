create or replace function public.update_my_party_session_display_name(
  p_session_id uuid,
  p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_display_name text := left(btrim(coalesce(p_display_name, '')), 40);
  v_role text;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if p_session_id is null then
    raise exception 'SESSION_ID_REQUIRED' using errcode = '22023';
  end if;

  if v_display_name = '' then
    v_display_name := '参加者';
  end if;

  -- A member may rename only their own active membership in this workspace.
  select m.role into v_role
  from public.session_members m
  join public.party_sessions s on s.id = m.session_id
  where m.session_id = p_session_id
    and m.user_id = v_user_id
    and s.archived_at is null
  for update of m;

  if not found then
    raise exception 'SESSION_MEMBERSHIP_REQUIRED' using errcode = '42501';
  end if;

  if v_role not in ('owner', 'editor') then
    raise exception 'EDITOR_MEMBERSHIP_REQUIRED' using errcode = '42501';
  end if;

  update public.session_members
  set display_name = v_display_name
  where session_id = p_session_id
    and user_id = v_user_id
    and display_name is distinct from v_display_name;

  -- The existing session_members update trigger broadcasts membership_changed.
  return jsonb_build_object(
    'status', 'updated',
    'display_name', v_display_name
  );
end;
$$;

revoke all on function public.update_my_party_session_display_name(uuid, text)
  from public, anon, authenticated;
grant execute on function public.update_my_party_session_display_name(uuid, text)
  to authenticated;
