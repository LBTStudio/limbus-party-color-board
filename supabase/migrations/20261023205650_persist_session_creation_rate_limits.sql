-- Preserve create rate limits after manually ended sessions are physically deleted.
-- The log contains only user IDs and timestamps, not party contents or invite tokens.
create table if not exists public.party_session_creation_log (
  id bigint generated always as identity primary key,
  owner_user_id uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists party_session_creation_log_owner_created_idx
  on public.party_session_creation_log(owner_user_id, created_at desc);
create index if not exists party_session_creation_log_created_idx
  on public.party_session_creation_log(created_at);

alter table public.party_session_creation_log enable row level security;
revoke all on table public.party_session_creation_log from public, anon, authenticated;

create or replace function public.create_party_session(
  p_title text,
  p_display_name text default '編成主'
)
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

  -- Serialize this user's creation requests so concurrent requests cannot bypass caps.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  -- Keep the rolling 30-day log small. These records intentionally outlive a deleted session.
  delete from public.party_session_creation_log
    where created_at < now() - interval '30 days';

  if (select count(*) from public.party_session_creation_log l
      where l.owner_user_id = v_user_id and l.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'SESSION_CREATE_RATE_LIMIT' using errcode = '53300';
  end if;
  if (select count(*) from public.party_session_creation_log l
      where l.owner_user_id = v_user_id and l.created_at > now() - interval '30 days') >= 50 then
    raise exception 'SESSION_STORAGE_LIMIT' using errcode = '53300';
  end if;
  if (select count(*) from public.party_sessions s
      where s.owner_user_id = v_user_id and s.archived_at is null) >= 20 then
    raise exception 'ACTIVE_SESSION_LIMIT' using errcode = '53300';
  end if;

  if v_name = '' then v_name := '編成主'; end if;
  insert into public.party_session_creation_log(owner_user_id) values (v_user_id);
  insert into public.party_sessions (title, owner_user_id)
    values (v_title, v_user_id) returning id into v_session_id;
  insert into public.session_members (session_id,user_id,role,display_name)
    values (v_session_id,v_user_id,'owner',v_name);
  return public._party_session_snapshot(v_session_id);
end;
$$;

revoke all on function public.create_party_session(text,text) from public, anon;
grant execute on function public.create_party_session(text,text) to authenticated;