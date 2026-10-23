-- Seed create-rate limits from sessions that existed before the creation log was introduced.
-- The log intentionally outlives physical deletion of the original party_sessions row.
insert into public.party_session_creation_log(owner_user_id, created_at)
select s.owner_user_id, s.created_at
from public.party_sessions s
where s.created_at > now() - interval '30 days';