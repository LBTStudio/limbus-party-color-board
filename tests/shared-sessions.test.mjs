import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const personas = JSON.parse(read('../data/personas.json')).personas;
const migration = read('../supabase/migrations/202610230001_shared_party_sessions.sql');
const forwardMigration = read('../supabase/migrations/202610230002_serialize_shared_session_resource_caps.sql');
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
  assert.ok(seed.includes('delete from public.party_persona_keys'));
  assert.ok(seed.includes('where not (persona_key = any (array['));
  assert.match(seed, /commit;/i);
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
  assert.match(migration, /revoke all on table/i);
  assert.match(migration, /from public, anon, authenticated/i);
  assert.match(migration, /revoke all on function public\._party_session_snapshot\(uuid\) from public, anon, authenticated/i);
  assert.doesNotMatch(migration, /create policy/i);
  assert.doesNotMatch(migration, /set search_path = pg_catalog, public/i);
  assert.equal((migration.match(/set search_path = pg_catalog$/gm) || []).length, 14);
});

test('SQL migration is syntactically well-formed and applies abuse/resource caps', () => {
  assert.equal((migration.match(/\bas \$\$/g) || []).length, 14, 'every PL/pgSQL function must open a $ body');
  assert.equal((migration.match(/^\$\$;$/gm) || []).length, 14, 'every PL/pgSQL function must close its $ body');
  assert.doesNotMatch(migration, /\bas \$\s*\ndeclare/i, 'single-dollar delimiter typo breaks migration');
  assert.match(migration, /ACTIVE_SESSION_LIMIT/);
  assert.match(migration, /SESSION_STORAGE_LIMIT/);
  assert.match(migration, /ACTIVE_INVITE_LIMIT/);
  assert.match(migration, /PENDING_REQUEST_LIMIT/);
  assert.match(migration, /SESSION_MEMBER_LIMIT/);
  assert.match(migration, /PARTY_EDIT_RATE_LIMIT/);
  assert.match(migration, /interval '30 days'/i);
});

test('session creation, invitations, and access requests have per-user abuse limits', () => {
  assert.match(migration, /SESSION_CREATE_RATE_LIMIT/);
  assert.match(migration, /INVITE_CREATE_RATE_LIMIT/);
  assert.match(migration, /ACCESS_REQUEST_RATE_LIMIT/);
  assert.match(migration, /PARTY_EDIT_RATE_LIMIT/);
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
    'set_party_session_member_role',
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
  const supabaseConfig = read('../supabase/config.toml');
  assert.match(supabaseConfig, /\[remotes\.main\]/);
  assert.match(supabaseConfig, /project_id = "hobntjcrzybqsiobrpsz"/);
  assert.match(supabaseConfig, /\[remotes\.main\.auth\]/);
  assert.match(supabaseConfig, /enable_anonymous_sign_ins = true/);
  assert.match(supabaseConfig, /\[remotes\.main\.db\.seed\]/);
  assert.match(supabaseConfig, /sql_paths = \["\.\/seed-persona-keys\.sql"\]/);
});
test('Turnstile token is wired into anonymous signup', () => {
  assert.match(config, /TURNSTILE_SITE_KEY/);
  assert.match(client, /isTurnstileConfigured/);
  assert.match(client, /captchaToken/);
  assert.match(client, /supabase-captcha-reset/);
  assert.match(sharedUi, /turnstile\.render/);
  assert.match(sharedUi, /challenges\.cloudflare\.com\/turnstile/);
});

test('polling avoids hidden-tab churn and offers explicit conflict handling', () => {
  assert.match(sharedUi, /document\.hidden/);
  assert.match(sharedUi, /5000/);
  assert.match(sharedUi, /15000/);
  assert.match(sharedUi, /expectedRevision/);
  assert.match(sharedUi, /operationId/);
  assert.match(sharedUi, /reapplyLocal/);
  assert.match(sharedUi, /accessRevoked/);
  assert.match(sharedUi, /!active\.incomingState/);
  assert.match(sharedUi, /session\.pollBusy/);
  assert.match(sharedUi, /未保存の編集、保存処理、または競合があります/);
});

test('pending-request cap is checked before the request is inserted', () => {
  const start = migration.indexOf('create or replace function public.request_party_access');
  const end = migration.indexOf('create or replace function public.check_my_party_access');
  const request = migration.slice(start, end);
  assert.ok(request.indexOf('PENDING_REQUEST_LIMIT') < request.indexOf('insert into public.session_access_requests'));
});

test('edit role is rechecked after the session row lock', () => {
  const start = migration.indexOf('create or replace function public.apply_party_edit');
  const end = migration.indexOf('create or replace function public.list_party_session_admin');
  const applyEdit = migration.slice(start, end);
  const lockIndex = applyEdit.indexOf('for update');
  const roleIndex = applyEdit.indexOf('select m.role into v_role');
  assert.ok(lockIndex > -1 && roleIndex > lockIndex);
  assert.match(applyEdit, /EDITOR_REQUIRED/);
});

test('session switching preserves the personal snapshot and ignores stale admin responses', () => {
  assert.match(sharedUi, /if \(!active && !personalPartySnapshot\)/);
  assert.match(sharedUi, /if \(active !== session \|\| session\.role !== 'owner'\) return;/);
});

test('docs describe the implemented shared-session feature', () => {
  const readme = read('../README.md');
  const design = read('../docs/shared-sessions-design.md');
  const failureModes = read('../docs/shared-sessions-failure-modes.md');
  assert.doesNotMatch(readme, /複数人の編集は同期されません/);
  assert.doesNotMatch(design, /共有セッションは未実装/);
  assert.doesNotMatch(failureModes, /共有セッション機能がまだない/);
  assert.match(readme, /招待リンクを開いた人はアクセス申請を送り/);
});

test('per-session resource caps are protected by parent-row locks', () => {
  const inviteStart = migration.indexOf('create or replace function public.create_party_invite');
  const inviteEnd = migration.indexOf('create or replace function public.revoke_party_invite');
  const createInvite = migration.slice(inviteStart, inviteEnd);
  assert.ok(createInvite.indexOf('for update') >= 0);
  assert.ok(createInvite.indexOf('for update') < createInvite.indexOf('ACTIVE_INVITE_LIMIT'));

  const requestStart = migration.indexOf('create or replace function public.request_party_access');
  const requestEnd = migration.indexOf('create or replace function public.check_my_party_access');
  const requestAccess = migration.slice(requestStart, requestEnd);
  assert.ok(requestAccess.indexOf('for update') >= 0);
  assert.ok(requestAccess.indexOf('for update') < requestAccess.indexOf('PENDING_REQUEST_LIMIT'));
  assert.ok(requestAccess.indexOf('for update') < requestAccess.indexOf('insert into public.session_access_requests'));

  const decideStart = migration.indexOf('create or replace function public.decide_party_access_request');
  const decideEnd = migration.indexOf('create or replace function public.set_party_session_member_role');
  const decide = migration.slice(decideStart, decideEnd);
  const sessionLock = decide.indexOf('for update');
  const requestLock = decide.indexOf('for update', sessionLock + 1);
  assert.ok(sessionLock >= 0 && requestLock > sessionLock);
  assert.ok(requestLock < decide.indexOf('SESSION_MEMBER_LIMIT'));
});


test('forward migration updates already-deployed resource-cap RPCs', () => {
  for (const name of ['create_party_invite', 'request_party_access', 'decide_party_access_request']) {
    assert.match(forwardMigration, new RegExp('create or replace function public\\\\.' + name + '\\\\(', 'i'));
  }
  assert.equal((forwardMigration.match(/\\bas \\$\\$/g) || []).length, 3);
  assert.equal((forwardMigration.match(/^\\$\\$;$/gm) || []).length, 3);

  const inviteStart = forwardMigration.indexOf('create or replace function public.create_party_invite');
  const inviteEnd = forwardMigration.indexOf('create or replace function public.request_party_access');
  const invite = forwardMigration.slice(inviteStart, inviteEnd);
  assert.ok(invite.indexOf('for update') >= 0);
  assert.ok(invite.indexOf('for update') < invite.indexOf('ACTIVE_INVITE_LIMIT'));

  const requestStart = forwardMigration.indexOf('create or replace function public.request_party_access');
  const requestEnd = forwardMigration.indexOf('create or replace function public.decide_party_access_request');
  const request = forwardMigration.slice(requestStart, requestEnd);
  assert.ok(request.indexOf('for update') >= 0);
  assert.ok(request.indexOf('for update') < request.indexOf('PENDING_REQUEST_LIMIT'));
  assert.ok(request.indexOf('for update') < request.indexOf('insert into public.session_access_requests'));

  const decide = forwardMigration.slice(requestEnd);
  const firstLock = decide.indexOf('for update');
  const secondLock = decide.indexOf('for update', firstLock + 1);
  assert.ok(firstLock >= 0 && secondLock > firstLock);
  assert.ok(secondLock < decide.indexOf('SESSION_MEMBER_LIMIT'));
});
