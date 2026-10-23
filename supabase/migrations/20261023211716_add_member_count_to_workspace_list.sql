-- Add participant count to the member-scoped workspace list. The creator display
-- name continues to come from the owner membership record; no additional sessions
-- become visible to callers.
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
