-- Forward migration for the already-deployed shared_party_sessions schema.
-- The original 202610230001 migration has already been applied in production.
-- Recreate only affected RPCs so the lock-order fixes reach the live database
-- without recreating tables or touching existing session data.

create or replace function public.create_party_invite(p_session_id uuid, p_expires_hours integer default 168)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_token text;
  v_invite_id uuid;
  v_expires timestamptz;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  -- Serialize invite creation for this session before enforcing its active-invite cap.
  perform 1 from public.party_sessions s
    where s.id=p_session_id and s.owner_user_id=v_user_id and s.archived_at is null
    for update;
  if not found then raise exception 'OWNER_REQUIRED' using errcode = '42501'; end if;
  if p_expires_hours is null or p_expires_hours < 1 or p_expires_hours > 720 then
    raise exception 'EXPIRY_MUST_BE_1_TO_720_HOURS' using errcode = '22023';
  end if;
  if (select count(*) from public.session_invites i
      where i.created_by = v_user_id and i.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'INVITE_CREATE_RATE_LIMIT' using errcode = '53300';
  end if;
  if (select count(*) from public.session_invites i
      where i.session_id = p_session_id and i.revoked_at is null and i.expires_at > now()) >= 10 then
    raise exception 'ACTIVE_INVITE_LIMIT' using errcode = '53300';
  end if;
  -- Two UUIDs provide about 244 random bits in a 64-character hex token; only its hash is stored.
  v_token := lower(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
  v_expires := now() + make_interval(hours => p_expires_hours);
  insert into public.session_invites(session_id,token_hash,expires_at,created_by)
  values (p_session_id,md5(v_token),v_expires,v_user_id) returning id into v_invite_id;
  return jsonb_build_object('invite_id',v_invite_id,'token',v_token,'expires_at',v_expires);
end;
$$;

create or replace function public.request_party_access(p_token text, p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid;
  v_display_name text := left(btrim(coalesce(p_display_name,'')),40);
  v_status text;
  v_role text;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_token is null or length(p_token) <> 64 or lower(p_token) !~ '^[a-f0-9]{64}$' then
    raise exception 'INVITE_INVALID_OR_EXPIRED' using errcode = '22023';
  end if;
  if v_display_name = '' then raise exception 'DISPLAY_NAME_REQUIRED' using errcode = '22023'; end if;
  if (select count(*) from public.session_access_requests r
      where r.user_id = v_user_id and r.requested_at > now() - interval '1 hour') >= 30 then
    raise exception 'ACCESS_REQUEST_RATE_LIMIT' using errcode = '53300';
  end if;
  select i.session_id into v_session_id
  from public.session_invites i
  join public.party_sessions s on s.id=i.session_id
  where i.token_hash=md5(lower(p_token)) and i.revoked_at is null
    and i.expires_at > now() and s.archived_at is null;
  if not found then raise exception 'INVITE_INVALID_OR_EXPIRED' using errcode = '22023'; end if;

  -- Requests for the same session serialize before checking the pending-request cap.
  perform 1 from public.party_sessions s
    where s.id=v_session_id and s.archived_at is null
    for update;
  if not found then raise exception 'INVITE_INVALID_OR_EXPIRED' using errcode = '22023'; end if;

  select m.role into v_role from public.session_members m
    where m.session_id=v_session_id and m.user_id=v_user_id;
  if found then return jsonb_build_object('status','approved','session_id',v_session_id,'role',v_role); end if;

  if not exists (select 1 from public.session_access_requests r
      where r.session_id=v_session_id and r.user_id=v_user_id and r.status='pending')
     and (select count(*) from public.session_access_requests r
       where r.session_id=v_session_id and r.status='pending') >= 100 then
    raise exception 'PENDING_REQUEST_LIMIT' using errcode = '53300';
  end if;

  insert into public.session_access_requests(session_id,user_id,display_name,status)
  values (v_session_id,v_user_id,v_display_name,'pending')
  on conflict (session_id,user_id) do update
    set display_name=excluded.display_name,status='pending',requested_at=now(),decided_by=null,decided_at=null
    where public.session_access_requests.status in ('denied','revoked');

  select r.status into v_status from public.session_access_requests r
    where r.session_id=v_session_id and r.user_id=v_user_id;
  return jsonb_build_object('status',v_status,'session_id',v_session_id);
end;
$$;

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
       and (select count(*) from public.session_members m where m.session_id=v_request.session_id) >= 20 then
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
