-- Remember who added each persona to a shared party and expose that member's
-- current display name in snapshots without exposing their Auth user id.
create table if not exists public.party_session_persona_authors (
  session_id uuid not null references public.party_sessions(id) on delete cascade,
  persona_key text not null,
  user_id uuid not null,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  primary key (session_id, persona_key)
);

alter table public.party_session_persona_authors enable row level security;
revoke all on table public.party_session_persona_authors from public, anon, authenticated;

-- Backfill only additions identifiable from a complete retained event history.
with ordered_events as (
  select e.session_id, e.revision, e.actor_user_id,
    e.payload -> 'party_keys' as party_keys,
    lag(e.payload -> 'party_keys') over (
      partition by e.session_id order by e.revision
    ) as previous_party_keys
  from public.session_events e
),
additions as (
  select e.session_id, e.revision, e.actor_user_id, selected.persona_key
  from ordered_events e
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(e.party_keys) = 'array' then e.party_keys else '[]'::jsonb end
  ) as selected(persona_key)
  where (
    (e.previous_party_keys is null and e.revision = 1)
    or (e.previous_party_keys is not null
      and not (e.previous_party_keys ? selected.persona_key))
  )
),
first_additions as (
  select distinct on (session_id, persona_key)
    session_id, persona_key, actor_user_id
  from additions
  order by session_id, persona_key, revision
)
insert into public.party_session_persona_authors(session_id, persona_key, user_id, display_name)
select s.id, selected.persona_key, first_addition.actor_user_id,
  coalesce(member.display_name, '')
from public.party_sessions s
cross join lateral unnest(coalesce(s.party_keys, array[]::text[])) as selected(persona_key)
join first_additions first_addition
  on first_addition.session_id = s.id
 and first_addition.persona_key = selected.persona_key
left join public.session_members member
  on member.session_id = s.id
 and member.user_id = first_addition.actor_user_id
on conflict (session_id, persona_key) do nothing;

create or replace function public.track_party_session_persona_authors()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_user_id uuid := auth.uid();
  v_display_name text;
  v_key text;
begin
  if tg_op = 'UPDATE' and old.party_keys is not distinct from new.party_keys then
    return new;
  end if;

  delete from public.party_session_persona_authors a
  where a.session_id = new.id
    and not (a.persona_key = any(coalesce(new.party_keys, array[]::text[])));

  if v_user_id is null then
    return new;
  end if;

  select m.display_name into v_display_name
  from public.session_members m
  where m.session_id = new.id
    and m.user_id = v_user_id
    and m.role in ('owner', 'editor');

  if not found then
    return new;
  end if;

  for v_key in
    select selected.persona_key
    from unnest(coalesce(new.party_keys, array[]::text[])) as selected(persona_key)
  loop
    if tg_op = 'INSERT'
      or not (v_key = any(coalesce(old.party_keys, array[]::text[])))
    then
      insert into public.party_session_persona_authors(
        session_id, persona_key, user_id, display_name
      )
      values (new.id, v_key, v_user_id, v_display_name)
      on conflict (session_id, persona_key) do nothing;
    end if;
  end loop;

  return new;
end;
$$;

revoke all on function public.track_party_session_persona_authors() from public, anon, authenticated;
drop trigger if exists party_session_persona_author_tracking on public.party_sessions;
create trigger party_session_persona_author_tracking
after update of party_keys on public.party_sessions
for each row execute function public.track_party_session_persona_authors();

create or replace function public._party_personas_with_contributors(
  p_session_id uuid,
  p_party_personas jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select coalesce(
    jsonb_agg(
      case
        when author.display_name is null then persona.value
        else persona.value || jsonb_build_object('addedByDisplayName', author.display_name)
      end
      order by persona.ordinality
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(
    case
      when jsonb_typeof(p_party_personas) = 'array' then p_party_personas
      else '[]'::jsonb
    end
  ) with ordinality as persona(value, ordinality)
  left join public.party_session_persona_authors author
    on author.session_id = p_session_id
   and author.persona_key = persona.value ->> 'key';
$$;

revoke all on function public._party_personas_with_contributors(uuid, jsonb) from public, anon, authenticated;

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
    'party_personas',public._party_personas_with_contributors(p_session_id, v_session.party_personas),
    'revision',v_session.revision,
    'updated_at',v_session.updated_at,
    'role',v_role,
    'members',v_members,'member_limit',v_session.member_limit
  );
end;
$$;

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
    'party_personas', public._party_personas_with_contributors(p_session_id, v_session.party_personas),
    'revision', v_session.revision,
    'updated_at', v_session.updated_at,
    'owner_display_name', coalesce(v_owner_name, '編成主'),
    'role', case when v_member_role in ('owner', 'editor') then v_member_role else 'public-viewer' end,
    'public_view_enabled', v_session.public_view_enabled,
    'public_edit_enabled', v_session.public_edit_enabled,
    'member_limit', v_session.member_limit
  );
end;
$$;

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

  update public.party_session_persona_authors
  set display_name = v_display_name
  where session_id = p_session_id
    and user_id = v_user_id
    and display_name is distinct from v_display_name;

  return jsonb_build_object('status', 'updated', 'display_name', v_display_name);
end;
$$;

revoke all on function public._party_session_snapshot(uuid) from public, anon, authenticated;
grant execute on function public._party_session_snapshot(uuid) to authenticated;
revoke all on function public.read_public_party_session(uuid) from public, anon, authenticated;
grant execute on function public.read_public_party_session(uuid) to anon, authenticated;
revoke all on function public.update_my_party_session_display_name(uuid, text)
  from public, anon, authenticated;
grant execute on function public.update_my_party_session_display_name(uuid, text) to authenticated;
