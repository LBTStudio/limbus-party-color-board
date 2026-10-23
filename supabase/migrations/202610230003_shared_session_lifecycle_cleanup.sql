-- Shared-session lifecycle: clarify cloud ownership, touch active sessions cheaply,
-- archive idle sessions after 30 days, and permanently purge them 7 days later.
-- Forward-only migration; existing sessions and membership rows are preserved.

alter table public.party_sessions
  add column if not exists last_activity_at timestamptz not null default now();

create index if not exists party_sessions_last_activity_idx
  on public.party_sessions (last_activity_at)
  where archived_at is null;

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
  -- Refresh last activity at most once every five minutes per active session.
  update public.party_sessions set last_activity_at=now()
    where id=p_session_id and last_activity_at < now() - interval '5 minutes';
  if v_revision=p_after_revision then
    return jsonb_build_object('status','unchanged','session_id',p_session_id,'revision',v_revision,'role',v_role);
  end if;
  return public._party_session_snapshot(p_session_id);
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
    'session_id',s.id,'title',s.title,'role',m.role,'revision',s.revision,'updated_at',s.updated_at,'last_activity_at',s.last_activity_at
  ) order by s.updated_at desc), '[]'::jsonb)
  into v_result
  from public.party_sessions s
  join public.session_members m on m.session_id = s.id and m.user_id = v_user_id
  where s.archived_at is null;
  return v_result;
end;
$$;

create or replace function public.cleanup_idle_party_sessions()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_archived integer;
  v_deleted integer;
begin
  update public.party_sessions
    set archived_at=now(), updated_at=now()
    where archived_at is null
      and last_activity_at < now() - interval '30 days';
  get diagnostics v_archived = row_count;

  delete from public.party_sessions
    where archived_at < now() - interval '7 days';
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('archived',v_archived,'deleted',v_deleted);
end;
$$;

revoke all on function public.cleanup_idle_party_sessions() from public, anon, authenticated;

create extension if not exists pg_cron;
do $schedule$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname='cleanup-idle-party-sessions';
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
  perform cron.schedule(
    'cleanup-idle-party-sessions',
    '17 4 * * *',
    'select public.cleanup_idle_party_sessions();'
  );
end;
$schedule$;
