import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const personas = JSON.parse(read('../data/personas.json')).personas;
const migration = read('../supabase/migrations/202610230001_shared_party_sessions.sql');
const seed = read('../supabase/seed-persona-keys.sql');
const client = read('../js/shared-sessions.mjs');
const config = read('../js/supabase-config.mjs');
const sharedUi = read('../js/shared-sessions-ui.mjs');

test('Supabase persona allowlist matches the checked-in persona catalog', () => {
  const generatedKeys = [...seed.matchAll(/^\s*\('([nt]\d+)'\),?$/gm)].map((match) => match[1]);
  const expectedKeys = [...new Set(personas.map((persona) => persona.key))].sort((a, b) => {
    const prefix = a[0].localeCompare(b[0]);
    return prefix || Number(a.slice(1)) - Number(b.slice(1));
  });
  assert.deepEqual(generatedKeys, expectedKeys);
  assert.equal(new Set(generatedKeys).size, generatedKeys.length);
});

test('shared session tables have RLS enabled and browser roles cannot access them directly', () => {
  for (const table of [
    'party_persona_keys',
    'party_sessions',
    'session_members',
    'session_invites',
    'session_access_requests',
    'session_events',
  ]) {
    assert.match(migration, new RegExp('alter table public\\.' + table + ' enable row level security', 'i'));
  }
  assert.match(migration, /revoke all on table[\s\S]+from anon, authenticated/i);
  assert.match(migration, /revoke all on function public\._party_session_snapshot\(uuid\) from public, anon, authenticated/i);
  assert.doesNotMatch(migration, /create policy/i);
});

test('shared session RPCs enforce owner/member roles and per-session revision checks', () => {
  for (const signature of [
    'create_party_session',
    'create_party_invite',
    'request_party_access',
    'check_my_party_access',
    'poll_party_session',
    'apply_party_edit',
    'list_party_session_admin',
    'decide_party_access_request',
    'remove_party_session_member',
    'revoke_party_invite',
    'archive_party_session',
  ]) {
    assert.match(migration, new RegExp('function public\\.' + signature + '\\(', 'i'));
  }
  assert.match(migration, /md5\(lower\(p_token\)\)/i);
  assert.match(migration, /p_expected_revision\s*<>\s*v_revision/i);
  assert.match(migration, /unique \(session_id, operation_id\)/i);
  assert.match(migration, /v_role not in \('owner','editor'\)/i);
  assert.match(migration, /OWNER_REQUIRED/i);
  assert.match(migration, /cardinality\(p_party_keys\) > 6/i);
});

test('browser config does not contain a privileged key and defaults to not configured', () => {
  assert.match(config, /SUPABASE_URL = 'https:\/\/hobntjcrzybqsiobrpsz\.supabase\.co'/);
  assert.match(config, /REPLACE_WITH_SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(config, /sb_secret_|service_role/i);
  assert.match(client, /!SUPABASE_PUBLISHABLE_KEY\.toLowerCase\(\)\.includes\('secret'\)/);
});

test('polling avoids hidden-tab churn and offers explicit conflict handling', () => {
  assert.match(sharedUi, /document\.hidden/);
  assert.match(sharedUi, /5000/);
  assert.match(sharedUi, /15000/);
  assert.match(sharedUi, /expectedRevision/);
  assert.match(sharedUi, /operationId/);
  assert.match(sharedUi, /reapplyLocal/);
  assert.match(sharedUi, /accessRevoked/);
});
