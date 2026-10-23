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
  assert.doesNotMatch(migration, /set search_path = pg_catalog, public/i);
  assert.equal((migration.match(/set search_path = pg_catalog$/gm) || []).length, 13);
});

test('session creation, invitations, and access requests have per-user abuse limits', () => {
  assert.match(migration, /SESSION_CREATE_RATE_LIMIT/);
  assert.match(migration, /INVITE_CREATE_RATE_LIMIT/);
  assert.match(migration, /ACCESS_REQUEST_RATE_LIMIT/);
  assert.match(migration, /interval '1 hour'/i);
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

test('browser config rejects privileged keys and allows supported public-key formats', () => {
  assert.match(config, /SUPABASE_URL = 'https:\/\/hobntjcrzybqsiobrpsz\.supabase\.co'/);
  const keyMatch = config.match(/SUPABASE_PUBLISHABLE_KEY = '([^']+)'/);
  assert.ok(keyMatch);
  const configuredKey = keyMatch[1];
  const isLegacyAnonKey = (() => {
    try {
      const payload = configuredKey.split('.')[1];
      if (!payload) return false;
      const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      return JSON.parse(json).role === 'anon';
    } catch {
      return false;
    }
  })();
  assert.ok(
    configuredKey === 'REPLACE_WITH_SUPABASE_PUBLISHABLE_KEY'
      || configuredKey.startsWith('sb_publishable_')
      || isLegacyAnonKey,
    'Use a publishable key or legacy anon key (or keep the placeholder until setup).',
  );
  assert.doesNotMatch(configuredKey, /sb_secret_|service_role|supabase_admin/i);
  assert.match(client, /!isPrivilegedKey\(SUPABASE_PUBLISHABLE_KEY\)/);
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
