-- New shared rooms start with six total members (room master included).
-- Preserve the former 20-member limit for rooms that already exist.
alter table public.party_sessions
  add column if not exists member_limit integer not null default 6;

update public.party_sessions
set member_limit = 20;

alter table public.party_sessions
  alter column member_limit set default 6;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'party_sessions_member_limit_range'
      and conrelid = 'public.party_sessions'::regclass
  ) then
    alter table public.party_sessions
      add constraint party_sessions_member_limit_range
      check (member_limit between 1 and 20);
  end if;
end;
$$;

comment on column public.party_sessions.member_limit is
  'Maximum number of room members including the room master. New rooms default to 6; hard maximum is 20.';

-- Enforce the selected cap for every membership INSERT path, including legacy
-- invite/request functions. The parent row lock serializes concurrent admissions.
create or replace function public.enforce_party_session_member_limit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_member_limit integer;
  v_member_count integer;
begin
  select s.member_limit into v_member_limit
  from public.party_sessions s
  where s.id = new.session_id
  for update;

  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.session_members m
    where m.session_id = new.session_id and m.user_id = new.user_id
  ) then
    return new;
  end if;

  select count(*)::integer into v_member_count
  from public.session_members m
  where m.session_id = new.session_id;

  if v_member_count >= v_member_limit then
    raise exception 'SESSION_MEMBER_LIMIT' using errcode = '53300';
  end if;

  return new;
end;
$$;

drop trigger if exists party_session_member_limit_guard on public.session_members;
create trigger party_session_member_limit_guard
before insert on public.session_members
for each row execute function public.enforce_party_session_member_limit();

revoke all on function public.enforce_party_session_member_limit() from public, anon, authenticated;

create or replace function public.set_party_session_member_limit(
  p_session_id uuid,
  p_member_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_owner uuid;
  v_member_count integer;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_member_limit is null or p_member_limit < 1 or p_member_limit > 20 then
    raise exception 'MEMBER_LIMIT_OUT_OF_RANGE' using errcode = '22023';
  end if;

  select s.owner_user_id into v_owner
  from public.party_sessions s
  where s.id = p_session_id and s.archived_at is null
  for update;

  if not found or v_owner <> v_user_id then
    raise exception 'OWNER_REQUIRED' using errcode = '42501';
  end if;

  select count(*)::integer into v_member_count
  from public.session_members m
  where m.session_id = p_session_id;

  if p_member_limit < v_member_count then
    raise exception 'MEMBER_LIMIT_BELOW_CURRENT' using errcode = '22023';
  end if;

  update public.party_sessions
  set member_limit = p_member_limit,
      updated_at = now()
  where id = p_session_id;

  -- Notify connected editors without incrementing the party-content revision.
  begin
    perform realtime.send(
      payload => jsonb_build_object('member_limit', p_member_limit),
      event => 'party_changed',
      topic => 'party:' || p_session_id::text,
      private => true
    );
  exception when others then
    -- A disconnected Realtime service must not undo the durable cap update.
    null;
  end;

  return jsonb_build_object(
    'status', 'updated',
    'member_limit', p_member_limit,
    'member_count', v_member_count
  );
end;
$$;

CREATE OR REPLACE FUNCTION public._party_session_snapshot(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_session public.party_sessions%rowtype;
  v_role text;
  v_members jsonb;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select s.* into v_session
    from public.party_sessions s
    join public.session_members m on m.session_id = s.id and m.user_id = v_user_id
    where s.id = p_session_id;
  if not found then raise exception 'SESSION_ACCESS_DENIED' using errcode = '42501'; end if;
  select m.role into v_role
    from public.session_members m
    where m.session_id = p_session_id and m.user_id = v_user_id;
  if v_session.archived_at is not null then
    return jsonb_build_object('status','closed','session_id',v_session.id,'title',v_session.title,'revision',v_session.revision,'role',v_role,'member_limit',v_session.member_limit);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'display_name', m.display_name,
    'role', m.role,
    'joined_at', m.joined_at
  ) order by m.joined_at), '[]'::jsonb)
  into v_members
  from public.session_members m
  where m.session_id = p_session_id;

  return jsonb_build_object(
    'status','ok',
    'session_id',v_session.id,
    'title',v_session.title,
    'party_keys',to_jsonb(v_session.party_keys),
    'party_personas',v_session.party_personas,
    'revision',v_session.revision,
    'updated_at',v_session.updated_at,
    'role',v_role,
    'members',v_members,'member_limit',v_session.member_limit
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.list_my_party_sessions()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
    'member_count', (select count(*)::integer from public.session_members count_member where count_member.session_id = s.id),
    'member_limit', s.member_limit
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
$function$;


CREATE OR REPLACE FUNCTION public.list_party_session_admin(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_owner uuid;
  v_member_limit integer;
  v_member_count integer;
  v_requests jsonb;
  v_members jsonb;
  v_invites jsonb;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select s.owner_user_id, s.member_limit into v_owner, v_member_limit from public.party_sessions s where s.id=p_session_id and s.archived_at is null;
  if not found or v_owner <> v_user_id then raise exception 'OWNER_REQUIRED' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'request_id',r.id,'user_id',r.user_id,'display_name',r.display_name,'status',r.status,'requested_at',r.requested_at
  ) order by r.requested_at), '[]'::jsonb)
    into v_requests from public.session_access_requests r
    where r.session_id=p_session_id and r.status='pending';

  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id',m.user_id,'display_name',m.display_name,'role',m.role,'joined_at',m.joined_at
  ) order by (m.role='owner') desc,m.joined_at), '[]'::jsonb)
    into v_members from public.session_members m where m.session_id=p_session_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'invite_id',i.id,'expires_at',i.expires_at,'revoked_at',i.revoked_at,
    'active',i.revoked_at is null and i.expires_at>now()
  ) order by i.created_at desc), '[]'::jsonb)
    into v_invites from public.session_invites i where i.session_id=p_session_id;

  select count(*)::integer into v_member_count from public.session_members m where m.session_id=p_session_id;
  return jsonb_build_object('requests',v_requests,'members',v_members,'invites',v_invites,
    'member_limit',v_member_limit,'member_count',v_member_count);
end;
$function$;


CREATE OR REPLACE FUNCTION public.read_public_party_session(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_session public.party_sessions%rowtype;
  v_owner_name text;
  v_user_id uuid := auth.uid();
  v_member_role text;
begin
  select s.* into v_session
  from public.party_sessions s
  where s.id = p_session_id
    and s.archived_at is null
    and (
      s.public_view_enabled = true
      or exists (
        select 1 from public.session_members access_member
        where access_member.session_id = s.id and access_member.user_id = v_user_id
      )
    );
  if not found then
    raise exception 'PUBLIC_SESSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Public views count as activity, but update the shared row at most once per
  -- five minutes across all viewers to avoid write amplification.
  update public.party_sessions
  set last_activity_at = now()
  where id = p_session_id
    and last_activity_at < now() - interval '5 minutes';

  select m.display_name into v_owner_name
  from public.session_members m
  where m.session_id = p_session_id and m.role = 'owner'
  limit 1;

  if v_user_id is not null then
    select m.role into v_member_role
    from public.session_members m
    where m.session_id = p_session_id and m.user_id = v_user_id;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'session_id', v_session.id,
    'title', v_session.title,
    'party_keys', to_jsonb(v_session.party_keys),
    'party_personas', v_session.party_personas,
    'revision', v_session.revision,
    'updated_at', v_session.updated_at,
    'owner_display_name', coalesce(v_owner_name, '編成主'),
    'role', case when v_member_role in ('owner', 'editor') then v_member_role else 'public-viewer' end,
    'public_view_enabled', v_session.public_view_enabled,
    'public_edit_enabled', v_session.public_edit_enabled,
    'member_limit', v_session.member_limit
  );
end;
$function$;


-- Return the current cap even when the party revision is unchanged.


CREATE OR REPLACE FUNCTION public.poll_party_session(p_session_id uuid, p_after_revision bigint DEFAULT '-1'::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_revision bigint;
  v_role text;
  v_archived timestamptz;
  v_public_view_enabled boolean;
  v_public_edit_enabled boolean;
  v_member_limit integer;
  v_snapshot jsonb;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select s.revision,s.archived_at,m.role,s.public_view_enabled,s.public_edit_enabled,s.member_limit
    into v_revision,v_archived,v_role,v_public_view_enabled,v_public_edit_enabled,v_member_limit
  from public.party_sessions s
  join public.session_members m on m.session_id=s.id and m.user_id=v_user_id
  where s.id=p_session_id;
  if not found then raise exception 'SESSION_ACCESS_DENIED' using errcode = '42501'; end if;
  if v_archived is not null then
    return jsonb_build_object('status','closed','session_id',p_session_id,'revision',v_revision,'role',v_role,'member_limit',v_member_limit);
  end if;
  if v_revision=p_after_revision then
    return jsonb_build_object(
      'status','unchanged','session_id',p_session_id,'revision',v_revision,'role',v_role,
      'public_view_enabled',v_public_view_enabled,'public_edit_enabled',v_public_edit_enabled,'member_limit',v_member_limit
    );
  end if;
  v_snapshot := public._party_session_snapshot(p_session_id);
  return v_snapshot || jsonb_build_object(
    'public_view_enabled',v_public_view_enabled,
    'public_edit_enabled',v_public_edit_enabled,
    'member_limit',v_member_limit
  );
end;
$function$;

revoke all on function public.set_party_session_member_limit(uuid,integer) from public, anon;
grant execute on function public.set_party_session_member_limit(uuid,integer) to authenticated;

revoke all on function public._party_session_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.enforce_party_session_member_limit() from public, anon, authenticated;
