-- Sessions created within the last 30 days cannot have been idle-archived
-- by the 30-day inactivity policy. Any such archived session was manually ended
-- under the old seven-day retention rule; purge those old-policy leftovers now.
-- New manual endings are physically deleted directly by archive_party_session().
delete from public.party_sessions
where archived_at is not null
  and created_at > now() - interval '30 days';