-- Public read-only view, opt-in editing by direct join, and private revision broadcasts.
-- Apply after 20261027111058_preserve_derived_skill_names.sql.

alter table public.party_sessions
  add column if not exists public_view_enabled boolean not null default false,
  add column if not exists public_edit_enabled boolean not null default false;

-- Existing workspaces retain the old private-by-default behavior. Owners can
-- opt in to open viewing/editing from the new settings panel. New workspaces
-- are created open by the replacement create_party_session RPC below.
update public.party_sessions
set public_view_enabled = false,
    public_edit_enabled = false
where archived_at is null;

create or replace function public.create_party_session(
  p_title text,
  p_display_name text default '編成主'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid;
  v_title text := left(btrim(coalesce(p_title,'')),80);
  v_name text := left(btrim(coalesce(p_display_name,'')),40);
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if v_title = '' then raise exception 'SESSION_TITLE_REQUIRED' using errcode = '22023'; end if;
  if (select count(*) from public.party_sessions s
      where s.owner_user_id = v_user_id and s.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'SESSION_CREATE_RATE_LIMIT' using errcode = '53300';
  end if;
  if (select count(*) from public.party_sessions s
      where s.owner_user_id = v_user_id and s.archived_at is null) >= 20 then
    raise exception 'ACTIVE_SESSION_LIMIT' using errcode = '53300';
  end if;
  if (select count(*) from public.party_sessions s
      where s.owner_user_id = v_user_id and s.created_at > now() - interval '30 days') >= 50 then
    raise exception 'SESSION_STORAGE_LIMIT' using errcode = '53300';
  end if;
  if v_name = '' then v_name := '編成主'; end if;
  insert into public.party_sessions (
    title, owner_user_id, public_view_enabled, public_edit_enabled
  )
  values (v_title, v_user_id, true, true)
  returning id into v_session_id;
  insert into public.session_members (session_id,user_id,role,display_name)
  values (v_session_id,v_user_id,'owner',v_name);
  return public._party_session_snapshot(v_session_id)
    || jsonb_build_object('public_view_enabled',true,'public_edit_enabled',true);
end;
$;

create or replace function public.read_public_party_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
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
    'public_edit_enabled', v_session.public_edit_enabled
  );
end;
$$;

create or replace function public.join_public_party_session(
  p_session_id uuid,
  p_display_name text default '参加者'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_session public.party_sessions%rowtype;
  v_role text;
  v_display_name text := left(btrim(coalesce(p_display_name, '')), 40);
  v_member_count integer;
  v_user_membership_count integer;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if v_display_name = '' then v_display_name := '参加者'; end if;

  -- Serialize joins per user, then lock the target workspace before enforcing caps.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  select s.* into v_session
  from public.party_sessions s
  where s.id = p_session_id
  for update;
  if not found or v_session.archived_at is not null then
    raise exception 'SESSION_NOT_FOUND_OR_CLOSED' using errcode = 'P0002';
  end if;
  if not v_session.public_edit_enabled then
    raise exception 'PUBLIC_EDIT_DISABLED' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.session_access_requests r
    where r.session_id = p_session_id
      and r.user_id = v_user_id
      and r.status = 'revoked'
  ) then
    raise exception 'EDITOR_ACCESS_REVOKED' using errcode = '42501';
  end if;

  select m.role into v_role
  from public.session_members m
  where m.session_id = p_session_id and m.user_id = v_user_id;

  if found then
    if v_role = 'viewer' then
      update public.session_members
      set role = 'editor', display_name = v_display_name
      where session_id = p_session_id and user_id = v_user_id;
    elsif v_role = 'editor' then
      update public.session_members
      set display_name = v_display_name
      where session_id = p_session_id and user_id = v_user_id;
    end if;
    return public._party_session_snapshot(p_session_id)
      || jsonb_build_object('public_view_enabled', v_session.public_view_enabled,
                            'public_edit_enabled', v_session.public_edit_enabled);
  end if;

  select count(*)::integer into v_member_count
  from public.session_members m where m.session_id = p_session_id;
  if v_member_count >= 20 then
    raise exception 'SESSION_MEMBER_LIMIT' using errcode = '53300';
  end if;

  select count(*)::integer into v_user_membership_count
  from public.session_members m
  where m.user_id = v_user_id and m.role <> 'owner';
  if v_user_membership_count >= 20 then
    raise exception 'USER_SESSION_LIMIT' using errcode = '53300';
  end if;

  insert into public.session_members(session_id, user_id, role, display_name)
  values (p_session_id, v_user_id, 'editor', v_display_name);

  return public._party_session_snapshot(p_session_id)
    || jsonb_build_object('public_view_enabled', v_session.public_view_enabled,
                          'public_edit_enabled', v_session.public_edit_enabled);
end;
$$;

create or replace function public.remove_party_session_member(
  p_session_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_caller uuid := auth.uid();
  v_owner uuid;
  v_display_name text;
begin
  if v_caller is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select s.owner_user_id into v_owner
  from public.party_sessions s
  where s.id = p_session_id and s.archived_at is null
  for update;
  if not found or v_owner <> v_caller then
    raise exception 'OWNER_REQUIRED' using errcode = '42501';
  end if;
  if p_user_id = v_owner then
    raise exception 'CANNOT_REMOVE_OWNER' using errcode = '22023';
  end if;

  select m.display_name into v_display_name
  from public.session_members m
  where m.session_id = p_session_id and m.user_id = p_user_id;

  delete from public.session_members
  where session_id = p_session_id and user_id = p_user_id;
  if not found then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Keep a revocation tombstone so an open-edit link cannot immediately
  -- re-add the same anonymous account after the owner removes it.
  insert into public.session_access_requests(
    session_id,user_id,display_name,status,requested_at,decided_by,decided_at
  )
  values (
    p_session_id,p_user_id,coalesce(v_display_name,'参加者'),'revoked',now(),v_caller,now()
  )
  on conflict (session_id,user_id) do update
    set display_name = excluded.display_name,
        status = 'revoked',
        decided_by = excluded.decided_by,
        decided_at = excluded.decided_at;

  return jsonb_build_object('status','removed','rejoin_blocked',true);
end;
$$;

create or replace function public.set_public_party_access(
  p_session_id uuid,
  p_public_view_enabled boolean,
  p_public_edit_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_owner uuid;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_public_view_enabled is null or p_public_edit_enabled is null then
    raise exception 'ACCESS_FLAGS_REQUIRED' using errcode = '22023';
  end if;

  select s.owner_user_id into v_owner
  from public.party_sessions s
  where s.id = p_session_id and s.archived_at is null
  for update;
  if not found or v_owner <> v_user_id then
    raise exception 'OWNER_REQUIRED' using errcode = '42501';
  end if;

  update public.party_sessions
  set public_view_enabled = p_public_view_enabled,
      public_edit_enabled = p_public_edit_enabled,
      updated_at = now()
  where id = p_session_id;

  -- Disabling open editing immediately revokes all non-owner write memberships.
  -- Existing sockets may remain connected until they reconnect, but every write RPC
  -- rechecks membership and therefore rejects them after this transaction commits.
  if not p_public_edit_enabled then
    delete from public.session_members
    where session_id = p_session_id and role <> 'owner';
  end if;

  return jsonb_build_object(
    'status', 'updated',
    'public_view_enabled', p_public_view_enabled,
    'public_edit_enabled', p_public_edit_enabled
  );
end;
$$;
 
-- The editor fallback poll also returns public flags, so disabled editing can
-- be reflected after reconnect without a separate metadata request.
create or replace function public.poll_party_session(
  p_session_id uuid,
  p_after_revision bigint default -1
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_revision bigint;
  v_role text;
  v_archived timestamptz;
  v_public_view_enabled boolean;
  v_public_edit_enabled boolean;
  v_snapshot jsonb;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select s.revision,s.archived_at,m.role,s.public_view_enabled,s.public_edit_enabled
    into v_revision,v_archived,v_role,v_public_view_enabled,v_public_edit_enabled
  from public.party_sessions s
  join public.session_members m on m.session_id=s.id and m.user_id=v_user_id
  where s.id=p_session_id;
  if not found then raise exception 'SESSION_ACCESS_DENIED' using errcode = '42501'; end if;
  if v_archived is not null then
    return jsonb_build_object('status','closed','session_id',p_session_id,'revision',v_revision,'role',v_role);
  end if;
  if v_revision=p_after_revision then
    return jsonb_build_object(
      'status','unchanged','session_id',p_session_id,'revision',v_revision,'role',v_role,
      'public_view_enabled',v_public_view_enabled,'public_edit_enabled',v_public_edit_enabled
    );
  end if;
  v_snapshot := public._party_session_snapshot(p_session_id);
  return v_snapshot || jsonb_build_object(
    'public_view_enabled',v_public_view_enabled,
    'public_edit_enabled',v_public_edit_enabled
  );
end;
$$;

create or replace function public.can_receive_party_broadcast(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_session_id uuid;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null or p_topic !~ '^party:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_session_id := substring(p_topic from 7)::uuid;
  return exists (
    select 1
    from public.session_members m
    where m.session_id = v_session_id
      and m.user_id = v_user_id
      and m.role in ('owner', 'editor')
  );
exception when others then
  return false;
end;
$$;

create or replace function public.broadcast_party_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.revision is distinct from old.revision then
    perform realtime.send(
      payload => jsonb_build_object('revision', new.revision),
      event => 'party_changed',
      topic => 'party:' || new.id::text,
      private => true
    );
  end if;
  return new;
end;
$$;

drop trigger if exists party_session_revision_broadcast on public.party_sessions;
create trigger party_session_revision_broadcast
after update of revision on public.party_sessions
for each row execute function public.broadcast_party_revision();

create or replace function public.broadcast_party_membership_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_session_id uuid;
begin
  if tg_op = 'DELETE' then
    v_session_id := old.session_id;
  else
    v_session_id := new.session_id;
  end if;
  perform realtime.send(
    payload => jsonb_build_object('kind', 'membership_changed'),
    event => 'membership_changed',
    topic => 'party:' || v_session_id::text,
    private => true
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists party_session_member_broadcast on public.session_members;
create trigger party_session_member_broadcast
after insert or delete or update of role on public.session_members
for each row execute function public.broadcast_party_membership_change();

drop policy if exists party_editors_receive_revision_broadcast on realtime.messages;
create policy party_editors_receive_revision_broadcast
on realtime.messages
for select
to authenticated
using (
  extension = 'broadcast'
  and public.can_receive_party_broadcast((select realtime.topic()))
);

revoke all on function public.read_public_party_session(uuid) from public;
revoke all on function public.join_public_party_session(uuid,text) from public, anon;
revoke all on function public.set_public_party_access(uuid,boolean,boolean) from public, anon;
revoke all on function public.can_receive_party_broadcast(text) from public, anon;
revoke all on function public.broadcast_party_revision() from public, anon, authenticated;
revoke all on function public.broadcast_party_membership_change() from public, anon, authenticated;

grant execute on function public.read_public_party_session(uuid) to anon, authenticated;
grant execute on function public.join_public_party_session(uuid,text) to authenticated;
grant execute on function public.set_public_party_access(uuid,boolean,boolean) to authenticated;
grant execute on function public.can_receive_party_broadcast(text) to authenticated;
