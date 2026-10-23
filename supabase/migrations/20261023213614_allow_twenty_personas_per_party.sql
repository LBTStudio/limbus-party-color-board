-- Raise the lineup cap from six to twenty for both the legacy RPC and the
-- current local-persona-aware RPC. Preserve authorization, revision checks,
-- rate limits, snapshot allowlisting, and the existing 60 KB payload ceiling.
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

  -- Serialize this user's edit rate limit across different sessions.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  -- Serialize edits and membership changes within this session only.
  select s.revision,s.archived_at into v_revision,v_archived
    from public.party_sessions s where s.id=p_session_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_archived is not null then raise exception 'SESSION_CLOSED' using errcode = '55000'; end if;
  select m.role into v_role from public.session_members m
    where m.session_id=p_session_id and m.user_id=v_user_id;
  if not found or v_role not in ('owner','editor') then raise exception 'EDITOR_REQUIRED' using errcode = '42501'; end if;

  if exists (select 1 from public.session_events e where e.session_id=p_session_id and e.operation_id=p_operation_id) then
    return public._party_session_snapshot(p_session_id) || jsonb_build_object('status','duplicate','operation_id',p_operation_id);
  end if;
  if p_expected_revision is null or p_expected_revision <> v_revision then
    return public._party_session_snapshot(p_session_id) || jsonb_build_object('status','conflict');
  end if;
  if (select count(*) from public.session_events e
      where e.actor_user_id=v_user_id and e.created_at > now() - interval '1 minute') >= 60 then
    raise exception 'PARTY_EDIT_RATE_LIMIT' using errcode = '53300';
  end if;
  -- Keep only a bounded idempotency/audit window for this session.
  delete from public.session_events e
    where e.session_id=p_session_id and e.created_at < now() - interval '30 days';
  if p_party_keys is null or cardinality(p_party_keys) > 20 then
    raise exception 'PARTY_MUST_HAVE_ZERO_TO_TWENTY_PERSONAS' using errcode = '22023';
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


create or replace function public.apply_party_edit_v2(
  p_session_id uuid,
  p_expected_revision bigint,
  p_operation_id uuid,
  p_party_keys text[],
  p_party_personas jsonb,
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
  v_persona jsonb;
  v_slot jsonb;
  v_color jsonb;
  v_keyword jsonb;
  v_slot_index integer;
  v_local_keys text[] := '{}'::text[];
  v_keyword_values text[];
  v_slot_colors text[];
  v_key text;
  v_numeric numeric;
  v_clean_personas jsonb := '[]'::jsonb;
  v_clean_slots jsonb;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_operation_id is null then raise exception 'OPERATION_ID_REQUIRED' using errcode = '22023'; end if;

  -- Match the per-user serialization used by the current party-edit RPC.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  select s.revision,s.archived_at into v_revision,v_archived
    from public.party_sessions s where s.id=p_session_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_archived is not null then raise exception 'SESSION_CLOSED' using errcode = '55000'; end if;
  select m.role into v_role from public.session_members m
    where m.session_id=p_session_id and m.user_id=v_user_id;
  if not found or v_role not in ('owner','editor') then raise exception 'EDITOR_REQUIRED' using errcode = '42501'; end if;

  if exists (select 1 from public.session_events e where e.session_id=p_session_id and e.operation_id=p_operation_id) then
    return public._party_session_snapshot(p_session_id) || jsonb_build_object('status','duplicate','operation_id',p_operation_id);
  end if;
  if p_expected_revision is null or p_expected_revision <> v_revision then
    return public._party_session_snapshot(p_session_id) || jsonb_build_object('status','conflict');
  end if;
  if (select count(*) from public.session_events e
      where e.actor_user_id=v_user_id and e.created_at > now() - interval '1 minute') >= 60 then
    raise exception 'PARTY_EDIT_RATE_LIMIT' using errcode = '53300';
  end if;
  delete from public.session_events e
    where e.session_id=p_session_id and e.created_at < now() - interval '30 days';

  if p_party_keys is null or cardinality(p_party_keys) > 20 then
    raise exception 'PARTY_MUST_HAVE_ZERO_TO_TWENTY_PERSONAS' using errcode = '22023';
  end if;
  if cardinality(p_party_keys) <> (select count(distinct k) from unnest(p_party_keys) as u(k)) then
    raise exception 'DUPLICATE_PERSONA_KEY' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_party_keys) as selected(k)
    where selected.k is null or char_length(selected.k) > 180
  ) then
    raise exception 'INVALID_PERSONA_KEY_LENGTH' using errcode = '22023';
  end if;
  if p_party_personas is null or jsonb_typeof(p_party_personas) is distinct from 'array' then
    raise exception 'PARTY_PERSONAS_MUST_BE_ARRAY' using errcode = '22023';
  end if;
  if jsonb_array_length(p_party_personas) > 20 or octet_length(p_party_personas::text) > 60000 then
    raise exception 'PARTY_PERSONA_SNAPSHOT_LIMIT' using errcode = '22023';
  end if;

  for v_persona in select value from jsonb_array_elements(p_party_personas)
  loop
    if jsonb_typeof(v_persona) is distinct from 'object' then
      raise exception 'INVALID_PARTY_PERSONA_SNAPSHOT' using errcode = '22023';
    end if;

    v_key := coalesce(v_persona->>'key','');
    if char_length(v_key) > 180
      or v_key !~ '^(lbt-sync-|lbt-original-|manual-)[A-Za-z0-9_-]{1,180}$'
    then
      raise exception 'INVALID_LOCAL_PERSONA_KEY' using errcode = '22023';
    end if;
    if v_key = any(v_local_keys) then
      raise exception 'DUPLICATE_LOCAL_PERSONA_SNAPSHOT' using errcode = '22023';
    end if;
    v_local_keys := array_append(v_local_keys, v_key);
    if not (v_key = any(p_party_keys)) then
      raise exception 'UNSELECTED_LOCAL_PERSONA_SNAPSHOT' using errcode = '22023';
    end if;

    if jsonb_typeof(v_persona->'name') is distinct from 'string'
      or coalesce(v_persona->>'name','') = '' or char_length(v_persona->>'name') > 100
      or coalesce(v_persona->>'kind','') not in ('normal','tokui','custom')
      or coalesce(v_persona->>'variantType','') not in ('sync','custom','manual')
      or jsonb_typeof(v_persona->'no') is distinct from 'number'
      or jsonb_typeof(v_persona->'hp') is distinct from 'number'
      or jsonb_typeof(v_persona->'san') is distinct from 'number'
      or jsonb_typeof(v_persona->'speed') is distinct from 'string'
      or char_length(v_persona->>'speed') > 40
      or jsonb_typeof(v_persona->'speedAvg') is distinct from 'number'
      or jsonb_typeof(v_persona->'sourceLabel') is distinct from 'string'
      or char_length(v_persona->>'sourceLabel') > 100
      or jsonb_typeof(v_persona->'originType') is distinct from 'string'
      or char_length(v_persona->>'originType') > 40
      or jsonb_typeof(v_persona->'syncMax') is distinct from 'boolean'
      or (v_persona->>'syncRank' is not null and v_persona->>'syncRank' not in ('0','00','000'))
      or jsonb_typeof(v_persona->'passiveName') is distinct from 'string'
      or char_length(v_persona->>'passiveName') > 100
      or jsonb_typeof(v_persona->'passiveCond') is distinct from 'string'
      or char_length(v_persona->>'passiveCond') > 240
      or jsonb_typeof(v_persona->'affiliation') is distinct from 'string'
      or char_length(v_persona->>'affiliation') > 100
      or jsonb_typeof(v_persona->'keywords') is distinct from 'array'
      or jsonb_typeof(v_persona->'slots') is distinct from 'array'
    then
      raise exception 'INVALID_PARTY_PERSONA_FIELDS' using errcode = '22023';
    end if;
    if (v_persona->>'variantType' in ('custom','manual') and v_persona->>'kind' <> 'custom')
      or (v_persona->>'variantType' = 'sync' and v_persona->>'kind' = 'custom')
    then
      raise exception 'INCONSISTENT_PARTY_PERSONA_KIND' using errcode = '22023';
    end if;

    v_numeric := (v_persona->>'no')::numeric;
    if v_numeric < 0 or v_numeric > 9999 then
      raise exception 'INVALID_PARTY_PERSONA_NUMBER' using errcode = '22023';
    end if;
    v_numeric := (v_persona->>'hp')::numeric;
    if v_numeric < 1 or v_numeric > 9999 then
      raise exception 'INVALID_PARTY_PERSONA_HP' using errcode = '22023';
    end if;
    v_numeric := (v_persona->>'san')::numeric;
    if v_numeric < 0 or v_numeric > 9999 then
      raise exception 'INVALID_PARTY_PERSONA_SAN' using errcode = '22023';
    end if;
    v_numeric := (v_persona->>'speedAvg')::numeric;
    if v_numeric < 0 or v_numeric > 999 then
      raise exception 'INVALID_PARTY_PERSONA_SPEED' using errcode = '22023';
    end if;

    v_keyword_values := '{}'::text[];
    if jsonb_array_length(v_persona->'keywords') > 60 then
      raise exception 'PARTY_PERSONA_KEYWORD_LIMIT' using errcode = '22023';
    end if;
    for v_keyword in select value from jsonb_array_elements(v_persona->'keywords')
    loop
      if jsonb_typeof(v_keyword) is distinct from 'string'
        or char_length(v_keyword #>> '{}') > 60
      then
        raise exception 'INVALID_PARTY_PERSONA_KEYWORDS' using errcode = '22023';
      end if;
      if (v_keyword #>> '{}') = any(v_keyword_values) then
        raise exception 'DUPLICATE_PARTY_PERSONA_KEYWORD' using errcode = '22023';
      end if;
      v_keyword_values := array_append(v_keyword_values, v_keyword #>> '{}');
    end loop;

    if jsonb_array_length(v_persona->'slots') <> 5 then
      raise exception 'PARTY_PERSONA_REQUIRES_FIVE_SLOTS' using errcode = '22023';
    end if;
    v_clean_slots := '[]'::jsonb;
    for v_slot, v_slot_index in
      select value, (ordinality - 1)::integer
      from jsonb_array_elements(v_persona->'slots') with ordinality
    loop
      if jsonb_typeof(v_slot) is distinct from 'object'
        or jsonb_typeof(v_slot->'rank') is distinct from 'string'
        or coalesce(v_slot->>'rank','') <> ('S' || v_slot_index::text)
        or jsonb_typeof(v_slot->'name') is distinct from 'string'
        or char_length(v_slot->>'name') > 120
        or jsonb_typeof(v_slot->'type') is distinct from 'string'
        or char_length(v_slot->>'type') > 80
        or jsonb_typeof(v_slot->'colors') is distinct from 'array'
      then
        raise exception 'INVALID_PARTY_PERSONA_SLOT' using errcode = '22023';
      end if;
      if jsonb_array_length(v_slot->'colors') > 2 then
        raise exception 'PARTY_PERSONA_COLOR_LIMIT' using errcode = '22023';
      end if;
      v_slot_colors := '{}'::text[];
      for v_color in select value from jsonb_array_elements(v_slot->'colors')
      loop
        if jsonb_typeof(v_color) is distinct from 'string'
          or (v_color #>> '{}') not in ('憤怒','色欲','怠惰','暴食','憂鬱','傲慢','嫉妬')
        then
          raise exception 'INVALID_PARTY_PERSONA_COLOR' using errcode = '22023';
        end if;
        if (v_color #>> '{}') = any(v_slot_colors) then
          raise exception 'DUPLICATE_PARTY_PERSONA_COLOR' using errcode = '22023';
        end if;
        v_slot_colors := array_append(v_slot_colors, v_color #>> '{}');
      end loop;
      v_clean_slots := v_clean_slots || jsonb_build_array(jsonb_build_object(
        'rank',v_slot->'rank',
        'name',v_slot->'name',
        'type',v_slot->'type',
        'colors',v_slot->'colors'
      ));
    end loop;

    -- Store only allowlisted fields. Never retain arbitrary fields supplied by a client.
    v_clean_personas := v_clean_personas || jsonb_build_array(jsonb_build_object(
      'key',v_key,
      'kind',v_persona->'kind',
      'variantType',v_persona->'variantType',
      'originType',v_persona->'originType',
      'sourceLabel',v_persona->'sourceLabel',
      'syncRank',v_persona->'syncRank',
      'syncMax',v_persona->'syncMax',
      'no',v_persona->'no',
      'name',v_persona->'name',
      'hp',v_persona->'hp',
      'san',v_persona->'san',
      'speed',v_persona->'speed',
      'speedAvg',v_persona->'speedAvg',
      'keywords',v_persona->'keywords',
      'affiliation',v_persona->'affiliation',
      'passiveName',v_persona->'passiveName',
      'passiveCond',v_persona->'passiveCond',
      'slots',v_clean_slots
    ));
  end loop;

  -- Official identities must match the allowlist. Any other selected key must be
  -- an allowed local key with exactly one snapshot in this atomic edit.
  if exists (
    select 1 from unnest(p_party_keys) as selected(k)
    where exists (select 1 from public.party_persona_keys official where official.persona_key=selected.k)
      and selected.k = any(v_local_keys)
  ) then
    raise exception 'OFFICIAL_KEY_CANNOT_BE_LOCAL_SNAPSHOT' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_party_keys) as selected(k)
    where not exists (select 1 from public.party_persona_keys official where official.persona_key=selected.k)
      and not (selected.k = any(v_local_keys))
  ) then
    raise exception 'UNKNOWN_PERSONA_KEY' using errcode = '22023';
  end if;

  v_new_revision := v_revision + 1;
  update public.party_sessions
    set party_keys=p_party_keys,
        party_personas=v_clean_personas,
        revision=v_new_revision,
        updated_at=now()
    where id=p_session_id;
  insert into public.session_events(session_id,revision,actor_user_id,operation_id,operation,payload)
    values (p_session_id,v_new_revision,v_user_id,p_operation_id,left(coalesce(p_operation,'party_update'),40),
      jsonb_build_object('party_keys',p_party_keys));
  return public._party_session_snapshot(p_session_id) || jsonb_build_object('status','saved','operation_id',p_operation_id);
end;
$$;


revoke all on function public.apply_party_edit(uuid,bigint,uuid,text[],text) from public, anon, authenticated;
grant execute on function public.apply_party_edit(uuid,bigint,uuid,text[],text) to authenticated;
revoke all on function public.apply_party_edit_v2(uuid,bigint,uuid,text[],jsonb,text) from public, anon, authenticated;
grant execute on function public.apply_party_edit_v2(uuid,bigint,uuid,text[],jsonb,text) to authenticated;
