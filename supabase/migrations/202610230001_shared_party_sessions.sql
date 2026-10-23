-- Shared party sessions, private-by-default access, and optimistic concurrency.
-- Apply from Supabase Dashboard > SQL Editor or with Supabase CLI migrations.
-- Public browser keys are safe to expose only because table access is revoked and RPCs check auth/roles.

create table if not exists public.party_persona_keys (
  persona_key text primary key check (persona_key ~ '^[nt][0-9]+$'),
  created_at timestamptz not null default now()
);

insert into public.party_persona_keys (persona_key) values
  ('n1'),
  ('n2'),
  ('n3'),
  ('n4'),
  ('n5'),
  ('n6'),
  ('n7'),
  ('n8'),
  ('n9'),
  ('n10'),
  ('n11'),
  ('n12'),
  ('n13'),
  ('n14'),
  ('n15'),
  ('n16'),
  ('n17'),
  ('n18'),
  ('n19'),
  ('n20'),
  ('n21'),
  ('n22'),
  ('n23'),
  ('n24'),
  ('n25'),
  ('n26'),
  ('n27'),
  ('n28'),
  ('n29'),
  ('n30'),
  ('n31'),
  ('n32'),
  ('n33'),
  ('n34'),
  ('n35'),
  ('n36'),
  ('n37'),
  ('n38'),
  ('n39'),
  ('n40'),
  ('n41'),
  ('n42'),
  ('n43'),
  ('n44'),
  ('n45'),
  ('n46'),
  ('n47'),
  ('n48'),
  ('n49'),
  ('n50'),
  ('n51'),
  ('n52'),
  ('n53'),
  ('n54'),
  ('n55'),
  ('n56'),
  ('n57'),
  ('n58'),
  ('n59'),
  ('n60'),
  ('n61'),
  ('n62'),
  ('n63'),
  ('n64'),
  ('n65'),
  ('n66'),
  ('n67'),
  ('n68'),
  ('n69'),
  ('n70'),
  ('n71'),
  ('n72'),
  ('n73'),
  ('n74'),
  ('n75'),
  ('n76'),
  ('n77'),
  ('n78'),
  ('n79'),
  ('n80'),
  ('n81'),
  ('n82'),
  ('n83'),
  ('n84'),
  ('n85'),
  ('n86'),
  ('n87'),
  ('n88'),
  ('n89'),
  ('n90'),
  ('n91'),
  ('n92'),
  ('n93'),
  ('n94'),
  ('n95'),
  ('n96'),
  ('n97'),
  ('n98'),
  ('n99'),
  ('n100'),
  ('n101'),
  ('n102'),
  ('n103'),
  ('n104'),
  ('n105'),
  ('n106'),
  ('n107'),
  ('n108'),
  ('n109'),
  ('n110'),
  ('n111'),
  ('n112'),
  ('n113'),
  ('n114'),
  ('n115'),
  ('n116'),
  ('n117'),
  ('n118'),
  ('n119'),
  ('n120'),
  ('n121'),
  ('n122'),
  ('n123'),
  ('n124'),
  ('n125'),
  ('n126'),
  ('n127'),
  ('n128'),
  ('n129'),
  ('n130'),
  ('n131'),
  ('n132'),
  ('n133'),
  ('n134'),
  ('n135'),
  ('n136'),
  ('n137'),
  ('n138'),
  ('n139'),
  ('n140'),
  ('n141'),
  ('n142'),
  ('n143'),
  ('n144'),
  ('n145'),
  ('t1'),
  ('t2'),
  ('t3'),
  ('t4'),
  ('t5'),
  ('t6'),
  ('t7'),
  ('t8'),
  ('t9'),
  ('t10'),
  ('t11'),
  ('t12'),
  ('t13'),
  ('t14'),
  ('t15'),
  ('t16'),
  ('t17'),
  ('t18'),
  ('t19'),
  ('t20'),
  ('t21'),
  ('t22'),
  ('t23'),
  ('t24'),
  ('t25'),
  ('t26'),
  ('t27'),
  ('t28'),
  ('t29'),
  ('t30'),
  ('t31'),
  ('t32'),
  ('t33'),
  ('t34'),
  ('t35'),
  ('t36'),
  ('t37'),
  ('t38'),
  ('t39'),
  ('t40'),
  ('t41'),
  ('t42'),
  ('t43'),
  ('t44'),
  ('t45'),
  ('t46'),
  ('t47'),
  ('t48'),
  ('t49'),
  ('t50'),
  ('t51'),
  ('t52'),
  ('t53'),
  ('t54')
on conflict (persona_key) do nothing;

create table if not exists public.party_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  party_keys text[] not null default '{}'::text[],
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.session_members (
  session_id uuid not null references public.party_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  display_name text not null default '参加者' check (char_length(btrim(display_name)) between 1 and 40),
  joined_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

create table if not exists public.session_invites (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.party_sessions(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.session_access_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.party_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'revoked')),
  requested_at timestamptz not null default now(),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  unique (session_id, user_id)
);

create table if not exists public.session_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.party_sessions(id) on delete cascade,
  revision bigint not null,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  operation text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (session_id, operation_id),
  unique (session_id, revision)
);

create index if not exists party_sessions_owner_updated_idx
  on public.party_sessions (owner_user_id, updated_at desc) where archived_at is null;
create index if not exists session_members_user_idx
  on public.session_members (user_id, session_id);
create index if not exists session_requests_pending_idx
  on public.session_access_requests (session_id, requested_at) where status = 'pending';
create index if not exists session_invites_active_idx
  on public.session_invites (session_id, expires_at) where revoked_at is null;

alter table public.party_persona_keys enable row level security;
alter table public.party_sessions enable row level security;
alter table public.session_members enable row level security;
alter table public.session_invites enable row level security;
alter table public.session_access_requests enable row level security;
alter table public.session_events enable row level security;

-- No direct table access from browser roles. All operations pass through checked RPCs.
revoke all on table public.party_persona_keys, public.party_sessions, public.session_members,
  public.session_invites, public.session_access_requests, public.session_events
  from public, anon, authenticated;

create or replace function public._party_session_snapshot(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
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
    return jsonb_build_object('status','closed','session_id',v_session.id,'title',v_session.title,'revision',v_session.revision,'role',v_role);
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
    'revision',v_session.revision,
    'updated_at',v_session.updated_at,
    'role',v_role,
    'members',v_members
  );
end;
$$;

create or replace function public.create_party_session(p_title text, p_display_name text default '編成主')
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
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
  if v_name = '' then v_name := '編成主'; end if;
  insert into public.party_sessions (title, owner_user_id)
  values (v_title, v_user_id) returning id into v_session_id;
  insert into public.session_members (session_id,user_id,role,display_name)
  values (v_session_id,v_user_id,'owner',v_name);
  return public._party_session_snapshot(v_session_id);
end;
$$;

create or replace function public.list_my_party_sessions()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare v_user_id uuid := auth.uid(); v_result jsonb;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'session_id',s.id,'title',s.title,'role',m.role,'revision',s.revision,'updated_at',s.updated_at
  ) order by s.updated_at desc), '[]'::jsonb)
  into v_result
  from public.party_sessions s
  join public.session_members m on m.session_id = s.id and m.user_id = v_user_id
  where s.archived_at is null;
  return v_result;
end;
$$;

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
  if not exists (select 1 from public.party_sessions s where s.id=p_session_id and s.owner_user_id=v_user_id and s.archived_at is null) then
    raise exception 'OWNER_REQUIRED' using errcode = '42501';
  end if;
  if p_expires_hours is null or p_expires_hours < 1 or p_expires_hours > 720 then
    raise exception 'EXPIRY_MUST_BE_1_TO_720_HOURS' using errcode = '22023';
  end if;
  if (select count(*) from public.session_invites i
      where i.created_by = v_user_id and i.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'INVITE_CREATE_RATE_LIMIT' using errcode = '53300';
  end if;
  -- Two UUIDs provide about 244 random bits in a 64-character hex token; only its hash is stored.
  v_token := lower(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
  v_expires := now() + make_interval(hours => p_expires_hours);
  insert into public.session_invites(session_id,token_hash,expires_at,created_by)
  values (p_session_id,md5(v_token),v_expires,v_user_id) returning id into v_invite_id;
  return jsonb_build_object('invite_id',v_invite_id,'token',v_token,'expires_at',v_expires);
end;
$$;

create or replace function public.revoke_party_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  update public.session_invites i set revoked_at=coalesce(i.revoked_at,now())
  from public.party_sessions s
  where i.id=p_invite_id and s.id=i.session_id and s.owner_user_id=v_user_id;
  if not found then raise exception 'INVITE_NOT_FOUND_OR_OWNER_REQUIRED' using errcode = '42501'; end if;
  return jsonb_build_object('status','revoked');
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

  select m.role into v_role from public.session_members m
    where m.session_id=v_session_id and m.user_id=v_user_id;
  if found then return jsonb_build_object('status','approved','session_id',v_session_id,'role',v_role); end if;

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
  select m.role into v_role from public.session_members m
    where m.session_id=p_session_id and m.user_id=v_user_id;
  if found then return jsonb_build_object('status','approved','session_id',p_session_id,'role',v_role); end if;
  select r.status into v_status from public.session_access_requests r
    where r.session_id=p_session_id and r.user_id=v_user_id;
  return jsonb_build_object('status',coalesce(v_status,'not_requested'),'session_id',p_session_id);
end;
$$;

create or replace function public.poll_party_session(p_session_id uuid, p_after_revision bigint default -1)
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
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select s.revision,s.archived_at,m.role into v_revision,v_archived,v_role
    from public.party_sessions s
    join public.session_members m on m.session_id=s.id and m.user_id=v_user_id
    where s.id=p_session_id;
  if not found then raise exception 'SESSION_ACCESS_DENIED' using errcode = '42501'; end if;
  if v_archived is not null then return jsonb_build_object('status','closed','session_id',p_session_id,'revision',v_revision,'role',v_role); end if;
  if v_revision=p_after_revision then
    return jsonb_build_object('status','unchanged','session_id',p_session_id,'revision',v_revision,'role',v_role);
  end if;
  return public._party_session_snapshot(p_session_id);
end;
$$;

create or replace function public.apply_party_edit(
  p_session_id uuid,
  p_expected_revision bigint,
  p_operation_id uuid,
  p_party_keys text[],
  p_operation text default 'party_update'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_revision bigint;
  v_archived timestamptz;
  v_role text;
  v_new_revision bigint;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_operation_id is null then raise exception 'OPERATION_ID_REQUIRED' using errcode = '22023'; end if;
  select m.role into v_role from public.session_members m
    where m.session_id=p_session_id and m.user_id=v_user_id;
  if not found or v_role not in ('owner','editor') then raise exception 'EDITOR_REQUIRED' using errcode = '42501'; end if;

  -- Serialize edits within this session only. Other group sessions use different rows.
  select s.revision,s.archived_at into v_revision,v_archived
    from public.party_sessions s where s.id=p_session_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_archived is not null then raise exception 'SESSION_CLOSED' using errcode = '55000'; end if;

  if exists (select 1 from public.session_events e where e.session_id=p_session_id and e.operation_id=p_operation_id) then
    return public._party_session_snapshot(p_session_id) || jsonb_build_object('status','duplicate','operation_id',p_operation_id);
  end if;
  if p_expected_revision is null or p_expected_revision <> v_revision then
    return public._party_session_snapshot(p_session_id) || jsonb_build_object('status','conflict');
  end if;
  if p_party_keys is null or cardinality(p_party_keys) > 6 then
    raise exception 'PARTY_MUST_HAVE_ZERO_TO_SIX_PERSONAS' using errcode = '22023';
  end if;
  if cardinality(p_party_keys) <> (select count(distinct k) from unnest(p_party_keys) as u(k)) then
    raise exception 'DUPLICATE_PERSONA_KEY' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_party_keys) as u(k)
    where not exists (select 1 from public.party_persona_keys valid where valid.persona_key=u.k)
  ) then raise exception 'UNKNOWN_PERSONA_KEY' using errcode = '22023'; end if;

  v_new_revision := v_revision + 1;
  update public.party_sessions
    set party_keys=p_party_keys,revision=v_new_revision,updated_at=now()
    where id=p_session_id;
  insert into public.session_events(session_id,revision,actor_user_id,operation_id,operation,payload)
    values (p_session_id,v_new_revision,v_user_id,p_operation_id,left(coalesce(p_operation,'party_update'),40),
      jsonb_build_object('party_keys',p_party_keys));
  return public._party_session_snapshot(p_session_id) || jsonb_build_object('status','saved','operation_id',p_operation_id);
end;
$$;

create or replace function public.list_party_session_admin(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_owner uuid;
  v_requests jsonb;
  v_members jsonb;
  v_invites jsonb;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select s.owner_user_id into v_owner from public.party_sessions s where s.id=p_session_id and s.archived_at is null;
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

  return jsonb_build_object('requests',v_requests,'members',v_members,'invites',v_invites);
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
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select * into v_request from public.session_access_requests r where r.id=p_request_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND' using errcode = 'P0002'; end if;
  select s.owner_user_id into v_owner from public.party_sessions s
    where s.id=v_request.session_id and s.archived_at is null;
  if not found or v_owner <> v_user_id then raise exception 'OWNER_REQUIRED' using errcode = '42501'; end if;
  if v_request.status <> 'pending' then raise exception 'REQUEST_ALREADY_DECIDED' using errcode = '55000'; end if;

  if p_decision='approve' then
    if p_role not in ('editor','viewer') then raise exception 'ROLE_MUST_BE_EDITOR_OR_VIEWER' using errcode = '22023'; end if;
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

create or replace function public.set_party_session_member_role(p_session_id uuid, p_user_id uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_role not in ('editor','viewer') then
    raise exception 'ROLE_MUST_BE_EDITOR_OR_VIEWER' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.party_sessions s
    where s.id=p_session_id and s.owner_user_id=v_user_id and s.archived_at is null
  ) then raise exception 'OWNER_REQUIRED' using errcode = '42501'; end if;
  if p_user_id=v_user_id then raise exception 'CANNOT_CHANGE_OWNER_ROLE' using errcode = '22023'; end if;

  update public.session_members m
    set role=p_role
    where m.session_id=p_session_id and m.user_id=p_user_id and m.role <> 'owner';
  if not found then raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object('status','updated','role',p_role);
end;
$;

create or replace function public.remove_party_session_member(p_session_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare v_owner uuid; v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select owner_user_id into v_owner from public.party_sessions where id=p_session_id and archived_at is null;
  if not found or v_owner <> v_caller then raise exception 'OWNER_REQUIRED' using errcode = '42501'; end if;
  if p_user_id=v_owner then raise exception 'CANNOT_REMOVE_OWNER' using errcode = '22023'; end if;
  delete from public.session_members where session_id=p_session_id and user_id=p_user_id;
  if not found then raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002'; end if;
  update public.session_access_requests set status='revoked',decided_by=v_caller,decided_at=now()
    where session_id=p_session_id and user_id=p_user_id;
  return jsonb_build_object('status','removed');
end;
$$;

create or replace function public.archive_party_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  update public.party_sessions set archived_at=now(),updated_at=now()
    where id=p_session_id and owner_user_id=v_user_id and archived_at is null;
  if not found then raise exception 'SESSION_NOT_FOUND_OR_OWNER_REQUIRED' using errcode = '42501'; end if;
  update public.session_invites set revoked_at=coalesce(revoked_at,now())
    where session_id=p_session_id and revoked_at is null;
  return jsonb_build_object('status','archived');
end;
$$;

-- Explicitly revoke the default PUBLIC execute grant from every security-definer function.
revoke all on function public._party_session_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.create_party_session(text,text) from public, anon;
revoke all on function public.list_my_party_sessions() from public, anon;
revoke all on function public.create_party_invite(uuid,integer) from public, anon;
revoke all on function public.revoke_party_invite(uuid) from public, anon;
revoke all on function public.request_party_access(text,text) from public, anon;
revoke all on function public.check_my_party_access(uuid) from public, anon;
revoke all on function public.poll_party_session(uuid,bigint) from public, anon;
revoke all on function public.apply_party_edit(uuid,bigint,uuid,text[],text) from public, anon;
revoke all on function public.list_party_session_admin(uuid) from public, anon;
revoke all on function public.decide_party_access_request(uuid,text,text) from public, anon;
revoke all on function public.set_party_session_member_role(uuid,uuid,text) from public, anon;
revoke all on function public.remove_party_session_member(uuid,uuid) from public, anon;
revoke all on function public.archive_party_session(uuid) from public, anon;

grant execute on function public.create_party_session(text,text) to authenticated;
grant execute on function public.list_my_party_sessions() to authenticated;
grant execute on function public.create_party_invite(uuid,integer) to authenticated;
grant execute on function public.revoke_party_invite(uuid) to authenticated;
grant execute on function public.request_party_access(text,text) to authenticated;
grant execute on function public.check_my_party_access(uuid) to authenticated;
grant execute on function public.poll_party_session(uuid,bigint) to authenticated;
grant execute on function public.apply_party_edit(uuid,bigint,uuid,text[],text) to authenticated;
grant execute on function public.list_party_session_admin(uuid) to authenticated;
grant execute on function public.decide_party_access_request(uuid,text,text) to authenticated;
grant execute on function public.set_party_session_member_role(uuid,uuid,text) to authenticated;
grant execute on function public.remove_party_session_member(uuid,uuid) to authenticated;
grant execute on function public.archive_party_session(uuid) to authenticated;
