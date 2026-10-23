import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MAX_IMPORT_CHARS, MAX_IMPORT_ROWS, parsePartySheet } from '../js/core.mjs';
import { escapeHtml } from '../js/security.mjs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const personas = JSON.parse(read('../data/personas.json')).personas;
const migration = read('../supabase/migrations/202610230001_shared_party_sessions.sql');
const forwardMigration = read('../supabase/migrations/202610230002_serialize_shared_session_resource_caps.sql');
const lifecycleMigration = read('../supabase/migrations/20261023152951_shared_session_lifecycle_cleanup.sql');
const personaSnapshotMigration = read('../supabase/migrations/20261023181231_shared_persona_snapshots.sql');
const closedSessionAccessMigration = read('../supabase/migrations/20261023201147_restrict_closed_session_status_to_related_users.sql');
const immediateDeleteMigration = read('../supabase/migrations/20261023204722_immediate_delete_manually_ended_sessions_and_owner_display_name.sql');
const sessionCreationRateLimitMigration = read('../supabase/migrations/20261023210000_persist_session_creation_rate_limits.sql');
const design = read('../docs/shared-sessions-design.md');
const seed = read('../supabase/seed-persona-keys.sql');
const client = read('../js/shared-sessions.mjs');
const config = read('../js/supabase-config.mjs');
const sharedUi = read('../js/shared-sessions-ui.mjs');
const app = read('../js/app.mjs');
const html = read('../index.html');
const styles = read('../styles.css');
const testWorkflow = read('../.github/workflows/test.yml');
const updateWorkflow = read('../.github/workflows/update-data.yml');

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

test('approved access remains pending if session activation is blocked by unsaved edits', () => {
  const checkStart = sharedUi.indexOf('async function checkAccess(quiet = false)');
  const checkEnd = sharedUi.indexOf('function captureInitialRoute()', checkStart);
  const check = sharedUi.slice(checkStart, checkEnd);
  const approvedStart = check.indexOf("if (result.status === 'approved')");
  const deniedStart = check.indexOf("} else if (['denied', 'revoked', 'not_requested', 'closed'].includes(result.status))", approvedStart);
  assert.ok(checkStart >= 0 && checkEnd > checkStart);
  assert.ok(approvedStart >= 0 && deniedStart > approvedStart);
  const approved = check.slice(approvedStart, deniedStart);
  assert.ok(
    approved.indexOf('await activateSession(sessionId)') < approved.indexOf('pendingRequestSessionId = null'),
    'do not clear the approved request before the destination session actually opens',
  );
  assert.match(approved, /catch \(error\)[\s\S]*?scheduleAccessCheck\(15000\)/);
  assert.match(approved, /参加が承認されましたが、現在の編成を切り替えられません/);
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


test('forward migration updates already-deployed resource-cap RPCs and serializes limits', () => {
  assert.match(forwardMigration, /create index if not exists session_access_requests_decided_by_idx/i);
  assert.equal((forwardMigration.match(/\bas \$\$/g) || []).length, 5);
  assert.equal((forwardMigration.match(/^\$\$;$/gm) || []).length, 5);

  const names = [
    'create_party_session',
    'create_party_invite',
    'request_party_access',
    'apply_party_edit',
    'decide_party_access_request',
  ];
  for (const name of names) {
    assert.match(forwardMigration, new RegExp('create or replace function public\\.' + name + '\\(', 'i'));
  }

  const functionBody = (name) => {
    const start = forwardMigration.indexOf('create or replace function public.' + name);
    assert.ok(start >= 0, name + ' exists in the forward migration');
    const next = forwardMigration.indexOf('create or replace function public.', start + 1);
    return forwardMigration.slice(start, next < 0 ? undefined : next);
  };

  const rateLimits = [
    ['create_party_session', 'SESSION_CREATE_RATE_LIMIT'],
    ['create_party_invite', 'INVITE_CREATE_RATE_LIMIT'],
    ['request_party_access', 'ACCESS_REQUEST_RATE_LIMIT'],
    ['apply_party_edit', 'PARTY_EDIT_RATE_LIMIT'],
  ];
  for (const [name, limit] of rateLimits) {
    const body = functionBody(name);
    const advisoryLock = body.indexOf('pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0))');
    const limitCheck = body.indexOf(limit);
    assert.ok(advisoryLock >= 0 && limitCheck > advisoryLock, name + ' locks before checking per-user rate limits');
  }

  const invite = functionBody('create_party_invite');
  assert.ok(invite.indexOf('for update') >= 0);
  assert.ok(invite.indexOf('for update') < invite.indexOf('ACTIVE_INVITE_LIMIT'));

  const request = functionBody('request_party_access');
  assert.ok(request.indexOf('for update') >= 0);
  assert.ok(request.indexOf('for update') < request.indexOf('PENDING_REQUEST_LIMIT'));
  assert.ok(request.indexOf('for update') < request.indexOf('insert into public.session_access_requests'));

  const decide = functionBody('decide_party_access_request');
  const firstRowLock = decide.indexOf('for update');
  const secondRowLock = decide.indexOf('for update', firstRowLock + 1);
  assert.ok(firstRowLock >= 0 && secondRowLock > firstRowLock);
  assert.ok(secondRowLock < decide.indexOf('SESSION_MEMBER_LIMIT'));
});


test('closed-session status is only disclosed to a user related to that session', () => {
  const start = closedSessionAccessMigration.indexOf('create or replace function public.check_my_party_access');
  const end = closedSessionAccessMigration.indexOf('revoke all on function public.check_my_party_access', start);
  const fn = closedSessionAccessMigration.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(fn, /s\.archived_at is not null/);
  assert.match(fn, /s\.owner_user_id=v_user_id/);
  assert.match(fn, /public\.session_members m[\s\S]*?m\.session_id=s\.id and m\.user_id=v_user_id/);
  assert.match(fn, /public\.session_access_requests r[\s\S]*?r\.session_id=s\.id and r\.user_id=v_user_id/);
  const closedStatus = fn.indexOf("return jsonb_build_object('status','closed'");
  assert.ok(closedStatus > fn.indexOf('s.archived_at is not null'));
  assert.ok(closedStatus > fn.indexOf('s.owner_user_id=v_user_id'));
  assert.ok(closedStatus > fn.indexOf('r.session_id=s.id and r.user_id=v_user_id'));
  assert.match(fn, /security definer/i);
  assert.match(fn, /set search_path = pg_catalog/i);
  assert.match(closedSessionAccessMigration, /revoke all on function public\.check_my_party_access\(uuid\) from public, anon/i);
  assert.match(closedSessionAccessMigration, /grant execute on function public\.check_my_party_access\(uuid\) to authenticated/i);
});

test('shared session lifecycle clearly separates browser-local and cloud data', () => {
  const html = read('../index.html');
  assert.match(html, /編成の共同編集・同期/);
  assert.match(html, /shared-title-short">共同編集/);
  assert.match(html, /招待リンクから参加申請を受け付け/);
  assert.match(html, /発行者が承認したメンバーと同じ編成を共同編集/);
  assert.match(html, /共同編集スペースの保存期間と自動削除/);
  assert.match(html, /この端末の個人編成/);
  assert.match(html, /PERSONAL · THIS BROWSER/);
  assert.match(html, /SHARED · CLOUD DATABASE/);
  assert.match(html, /30日間/);
  assert.match(html, /自動終了した共有編成は、終了から7日後/);
  assert.match(html, /発行者が手動で終了した共有編成は、その場で共有データと関連データを削除/);
  assert.match(html, /この端末で閉じる/);
  assert.match(html, /共同編集スペースを終了/);
  assert.match(sharedUi, /last_activity_at/);
  assert.match(sharedUi, /共有編成・参加者・招待・申請・編集履歴を即時削除/);
  assert.match(sharedUi, /共有データと関連記録を即時削除/);
});

test('creating a workspace validates the title and the owner display name separately', () => {
  const start = sharedUi.indexOf('async function createSession()');
  const end = sharedUi.indexOf('function sessionSwitchError()', start);
  const create = sharedUi.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(create, /const title = String\(\$\('#shared-session-title'\)\.value \|\| ''\)\.trim\(\)\.slice\(0, 80\)/);
  assert.match(create, /const ownerDisplayName = String\(\$\('#shared-display-name'\)\.value \|\| ''\)\.trim\(\)\.slice\(0, 40\)/);
  const titleValidation = create.indexOf("共同編集スペース名を入力してください。");
  const displayValidation = create.indexOf("自分の表示名を入力してください。");
  const rpc = create.indexOf("getApi().createSession(title, ownerDisplayName)");
  assert.ok(titleValidation >= 0 && displayValidation > titleValidation);
  assert.ok(rpc > displayValidation, 'the server call must happen only after both independent fields are validated');
  assert.match(sharedUi, /if \(value\) rememberDisplayName\(value\);/);
});

test('workspace creation is blocked before the create RPC when the current shared session has unsettled edits', () => {
  assert.match(sharedUi, /function sessionSwitchError\(\)/);
  const createStart = sharedUi.indexOf('async function createSession()');
  const createEnd = sharedUi.indexOf('function sessionSwitchError()', createStart);
  const createBody = sharedUi.slice(createStart, createEnd);
  assert.ok(createStart >= 0 && createEnd > createStart);
  assert.match(createBody, /const switchError = sessionSwitchError\(\)/);
  assert.ok(
    createBody.indexOf('sessionSwitchError()') < createBody.indexOf('getApi().createSession'),
    'reject before creating a server-side workspace that cannot be opened',
  );
  const activateStart = sharedUi.indexOf('async function activateSession(');
  const activateBody = sharedUi.slice(activateStart, activateStart + 500);
  assert.match(activateBody, /const switchError = sessionSwitchError\(\)/);
});

test('session creation rate limits survive immediate deletion of the workspace row', () => {
  assert.match(sessionCreationRateLimitMigration, /create table if not exists public\.party_session_creation_log/i);
  assert.match(sessionCreationRateLimitMigration, /owner_user_id uuid not null/i);
  assert.match(sessionCreationRateLimitMigration, /alter table public\.party_session_creation_log enable row level security/i);
  assert.match(sessionCreationRateLimitMigration, /revoke all on table public\.party_session_creation_log from public, anon, authenticated/i);
  const start = sessionCreationRateLimitMigration.indexOf('create or replace function public.create_party_session');
  const end = sessionCreationRateLimitMigration.indexOf('revoke all on function public.create_party_session', start);
  const fn = sessionCreationRateLimitMigration.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(fn, /pg_advisory_xact_lock/);
  assert.match(fn, /party_session_creation_log l[\s\S]*?l\.created_at > now\(\) - interval '1 hour'\) >= 10/);
  assert.match(fn, /party_session_creation_log l[\s\S]*?l\.created_at > now\(\) - interval '30 days'\) >= 50/);
  assert.match(fn, /insert into public\.party_session_creation_log\(owner_user_id\)/);
  assert.match(fn, /party_sessions s[\s\S]*?s\.archived_at is null\) >= 20/);
  assert.ok(
    fn.indexOf('insert into public.party_session_creation_log') < fn.indexOf('insert into public.party_sessions'),
    'record creation limits independently of the session row that may later be deleted',
  );
});

test('manual workspace ending deletes data immediately while idle cleanup keeps its seven-day grace period', () => {
  assert.match(immediateDeleteMigration, /create or replace function public\.archive_party_session\(p_session_id uuid\)/i);
  assert.match(immediateDeleteMigration, /delete from public\.party_sessions[\s\S]*?owner_user_id=v_user_id/i);
  assert.match(immediateDeleteMigration, /deleted_immediately',true/);
  assert.match(immediateDeleteMigration, /revoke all on function public\.archive_party_session\(uuid\) from public, anon/i);
  assert.match(immediateDeleteMigration, /grant execute on function public\.archive_party_session\(uuid\) to authenticated/i);
  for (const table of ['session_members', 'session_invites', 'session_access_requests', 'session_events']) {
    assert.ok(migration.includes(table), 'child table is part of the shared-session schema');
  }
  assert.match(migration, /references public\.party_sessions\(id\) on delete cascade/i);
  assert.match(lifecycleMigration, /archived_at < now\(\) - interval '7 days'/i,
    'the delayed purge remains only for automatically archived idle sessions');
});

test('member capacity supports 16 participants and workspace lists show the creator display name', () => {
  assert.match(migration, /SESSION_MEMBER_LIMIT/);
  assert.match(migration, /session_members m where m\.session_id=v_request\.session_id\) >= 20/);
  const start = immediateDeleteMigration.indexOf('create or replace function public.list_my_party_sessions()');
  const end = immediateDeleteMigration.indexOf('revoke all on function public.list_my_party_sessions()', start);
  const listFunction = immediateDeleteMigration.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(listFunction, /owner_display_name/);
  assert.match(listFunction, /owner_member\.display_name/);
  assert.match(listFunction, /owner_member\.user_id = s\.owner_user_id/);
  assert.match(sharedUi, /'発行者: ' \+ \(item\.owner_display_name \|\| '編成主'\)/);
  assert.match(sharedUi, /'発行者: ' \+ active\.ownerDisplayName/);
  assert.match(design, /16名全員が常時アクティブの場合/);
});

test('tool URL copying is separate from invitation issuance and cannot auto-copy an invite secret', () => {
  assert.match(html, /id="shared-tool-url"/);
  assert.match(html, /id="shared-copy-tool-url">ツールURLをコピー/);
  assert.match(html, /id="shared-copy-invite">招待リンクをコピー/);
  assert.match(html, /共同編集への参加権限はありません/);
  assert.match(sharedUi, /function publicToolUrl\(\) \{\s*return location\.origin \+ location\.pathname;/);
  const start = sharedUi.indexOf('async function issueInvite()');
  const end = sharedUi.indexOf('async function copyInvite()', start);
  const issue = sharedUi.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(issue, /render\(\)/);
  assert.doesNotMatch(issue, /copyInvite\(\)/, 'issuing an invite must not copy it automatically');
  assert.match(sharedUi, /navigator\.clipboard\.writeText\(value\)/);
});

test('workspace archival is rejected before the RPC when local changes have not settled', () => {
  const start = sharedUi.indexOf('async function archiveActive()');
  const end = sharedUi.indexOf('\nfunction leaveSession()', start);
  const archive = sharedUi.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(archive, /const switchError = sessionSwitchError\(\)/);
  assert.ok(
    archive.indexOf('sessionSwitchError()') < archive.indexOf('window.confirm('),
    'validate edits before asking for archival confirmation',
  );
  assert.ok(
    archive.indexOf('sessionSwitchError()') < archive.indexOf('getApi().archiveSession'),
    'never archive first and only afterwards ask whether to discard local edits',
  );
  assert.match(archive, /未解決の編集がある間は共同編集スペースを終了できません/);
});

test('workspace name and creator display name are independent fields', () => {
  assert.match(html, /共同編集スペース名<input class="input" id="shared-session-title" maxlength="80"/);
  assert.match(html, /自分の表示名<input class="input" id="shared-display-name" maxlength="40" autocomplete="nickname"/);
  assert.match(html, /スペース名は編成の名前、表示名は参加者一覧に表示する自分の名前です/);
  assert.match(sharedUi, /getApi\(\)\.createSession\(title, ownerDisplayName\)/);
  assert.match(sharedUi, /const ownerDisplayName = String\(\$\('#shared-display-name'\)\.value \|\| ''\)/);
  assert.match(sharedUi, /localStorage\.getItem\('lbt_party_shared_display_name'\)/);
  assert.match(sharedUi, /window\.prompt\('共有セッションで表示する名前を入力してください'/);
  assert.match(sharedUi, /getApi\(\)\.requestAccess\(token, provided\.trim\(\)\.slice\(0, 40\)\)/);
  assert.match(sharedUi, /\$\('#shared-display-name'\)\.addEventListener\('change'/);
  assert.match(styles, /\.shared-fields \{\s*display: grid;\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test('lifecycle migration tracks live usage and schedules idle cleanup safely', () => {
  assert.match(lifecycleMigration, /add column if not exists last_activity_at/i);
  assert.match(lifecycleMigration, /last_activity_at < now\(\) - interval '5 minutes'/i);
  assert.match(lifecycleMigration, /last_activity_at < now\(\) - interval '30 days'/i);
  assert.match(lifecycleMigration, /archived_at < now\(\) - interval '7 days'/i);
  assert.match(lifecycleMigration, /create extension if not exists pg_cron/i);
  assert.match(lifecycleMigration, /cleanup-idle-party-sessions/);
  assert.match(lifecycleMigration, /revoke all on function public\.cleanup_idle_party_sessions\(\) from public, anon, authenticated/i);
  assert.match(lifecycleMigration, /'last_activity_at',s\.last_activity_at/i);
});


 
test('untrusted persona fields are escaped before template-based HTML insertion', () => {
  const payload = '</dd><img src=x onerror="alert(1)">';
  assert.equal(
    escapeHtml(payload),
    '&lt;/dd&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
  );
  assert.ok(app.includes('<dd>${escapeHtml(persona.hp)}</dd>'));
  assert.ok(app.includes('<dd>${escapeHtml(persona.san)}</dd>'));
  assert.equal((app.match(/escapeHtml\(personaNumberLabel\(persona\)\)/g) || []).length, 2);
});

test('CSV/TSV import rejects excessive length and row counts before resolving personas', () => {
  assert.equal(MAX_IMPORT_CHARS, 20_000);
  assert.equal(MAX_IMPORT_ROWS, 200);
  const tooLong = parsePartySheet('x'.repeat(MAX_IMPORT_CHARS + 1), personas);
  assert.match(tooLong.errors.join(' '), /長すぎます/);

  const tooManyRows = parsePartySheet(Array(MAX_IMPORT_ROWS + 1).fill('人格番号').join(String.fromCharCode(10)), personas);
  assert.match(tooManyRows.errors.join(' '), /行数が多すぎます/);
});

test('CSP disallows inline script execution and limits resource origins', () => {
  const match = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(match, 'a CSP meta policy must be present');
  const policy = match[1];
  assert.ok(policy.includes("script-src 'self' https://esm.sh https://challenges.cloudflare.com"));
  const scriptSource = policy.split(';').find((directive) => directive.trim().startsWith('script-src'));
  assert.ok(scriptSource);
  assert.ok(!scriptSource.includes('unsafe-inline'));
  assert.ok(policy.includes("object-src 'none'"));
  assert.ok(policy.includes('connect-src'));
  assert.ok(policy.includes('hobntjcrzybqsiobrpsz.supabase.co'));
});

test('invite token is removed from the URL before loading third-party scripts', () => {
  const initPosition = sharedUi.indexOf('const initialRoute = captureInitialRoute();');
  const turnstilePosition = sharedUi.indexOf('await initializeTurnstile();', initPosition);
  assert.ok(initPosition >= 0 && turnstilePosition > initPosition);
  const captureStart = sharedUi.indexOf('function captureInitialRoute()');
  const routeStart = sharedUi.indexOf('async function initializeRoute(route)', captureStart);
  assert.ok(captureStart >= 0 && routeStart > captureStart);
  assert.ok(sharedUi.slice(captureStart, routeStart).includes("if (route.token) setRoute('');"));
});

test('browser Supabase SDK dependency uses an exact version instead of a floating major tag', () => {
  assert.ok(client.includes('@supabase/supabase-js@2.118.0?target=es2022'));
  assert.ok(!client.includes('@supabase/supabase-js@2?target=es2022'));
});

test('GitHub Actions dependencies are pinned and upstream data updates require review', () => {
  for (const workflow of [testWorkflow, updateWorkflow]) {
    for (const line of workflow.split(String.fromCharCode(10)).filter((value) => value.includes('uses: actions/checkout@') || value.includes('uses: actions/setup-node@'))) {
      const reference = line.trim().split('@')[1].split(' ')[0];
      assert.match(reference, /^[0-9a-f]{40}$/);
    }
  }
  assert.ok(updateWorkflow.includes('pull-requests: write'));
  assert.ok(updateWorkflow.includes('gh pr create'));
  assert.ok(updateWorkflow.includes('git add data/personas.json supabase/seed-persona-keys.sql'));
  assert.ok(!updateWorkflow.includes('git push origin main'));
  assert.ok(updateWorkflow.includes('git push --force origin "HEAD:${BRANCH_NAME}"'));
});


test('main board is prioritized and infrequent operations are grouped', () => {
  const toolbarStart = html.indexOf('<section class="panel controls"');
  const resourcesStart = html.indexOf('<section class="panel resource-section"');
  const matrixStart = html.indexOf('<section class="panel" aria-labelledby="matrix-title"');
  const personaStart = html.indexOf('<section class="panel" aria-labelledby="party-title"');
  const sharingStart = html.indexOf('<section class="panel shared-panel" id="shared-panel"');
  assert.ok(toolbarStart >= 0 && resourcesStart > toolbarStart);
  assert.ok(matrixStart > resourcesStart && personaStart > matrixStart);
  assert.ok(sharingStart > personaStart, 'sharing controls should not displace the primary lineup workflow');
  assert.ok(html.includes('<details class="toolbar-more">'));
  assert.ok(html.includes('href="#shared-panel">共同編集・同期へ</a>'));
  assert.ok(html.includes('<details class="shared-info">'));
  assert.ok(html.includes('id="shared-panel-toggle"'));
  assert.ok(html.includes('id="shared-panel-content"'));
  assert.ok(styles.includes('.shared-panel:not(.is-open) .shared-panel-content'));
  assert.ok(styles.includes('position: fixed;'));
  assert.ok(styles.includes('.shared-panel,\n  .card-actions'));
  assert.ok(sharedUi.includes('a[href="#shared-panel"]'));
  assert.ok(sharedUi.includes('setSharedPanelOpen(true)'));
  assert.ok(sharedUi.includes('setSharedPanelOpen(true, { focusRequests: true })'));
  assert.ok(sharedUi.includes('requestHeading.scrollIntoView({ behavior: \'auto\', block: \'start\' })'));
  assert.ok(sharedUi.includes("bridge.showToast('新しい参加申請が"));
  assert.ok(sharedUi.includes("requestBadge.textContent = '参加申請 ' + pendingCount"));
});


test('numbered persona skill color strip explains index mapping without enlarging the bar', () => {
  assert.match(html, /色帯の上にある数字0〜4は、左からS0→S4/);
  assert.match(app, /const stripLabels = persona\.slots\.map\(\(skillSlot, index\)/);
  assert.match(app, /class="color-strip-indexes" aria-hidden="true">\$\{stripLabels\}/);
  assert.match(app, /class="color-strip" role="img" aria-label="色帯上の数字0〜4は、左からS0〜S4/);
  assert.match(styles, /\.color-strip-indexes \{[\s\S]*?display: flex;[\s\S]*?\.color-strip \{\s*display: flex;\s*height: 4px;/);
  assert.match(styles, /\.color-strip-wrap \{\s*margin: -3px 0 1px;[\s\S]*?\.color-strip \{\s*display: flex;\s*height: 4px;[\s\S]*?margin: 0;/);
  assert.doesNotMatch(app, /color-strip-slot/);
  assert.doesNotMatch(styles, /color-strip-slot/);
});
test('mobile refinement keeps the collapsed shared-session dock compact and respects phone safe areas', () => {
  assert.match(styles, /\.shared-panel:not\(\.is-open\) \{[\s\S]*?width: fit-content;/);
  assert.match(styles, /max-height: min\(70dvh, 620px\)/);
  assert.match(styles, /env\(safe-area-inset-bottom, 0px\)/);
  assert.match(styles, /\.shared-panel:not\(\.is-open\) > \.section-head \{[\s\S]*?flex-direction: row;/);
});


test('LBT local persona snapshots are synchronized through authorized shared-session RPCs', () => {
  const localImport = read('../js/persona-import.mjs');
  assert.match(html, /LBT保存データを読み込む/);
  assert.match(html, /手動で創作人格を追加/);
  assert.match(localImport, /lbt_accounts_index/);
  assert.match(localImport, /lbt_account_/);
  assert.match(localImport, /lbt_v46_state/);
  assert.match(app, /personaSnapshotForShare/);
  assert.match(app, /getPartyPersonas: getShareablePartyPersonas/);
  assert.match(app, /applySharedPartySnapshot/);
  assert.match(app, /currentPartySnapshotSize/);
  assert.match(sharedUi, /party_personas/);
  assert.match(sharedUi, /samePartyState/);
  assert.match(client, /rpc\('apply_party_edit_v2'/);
  assert.match(personaSnapshotMigration, /add column if not exists party_personas jsonb/i);
  assert.match(personaSnapshotMigration, /create or replace function public\.apply_party_edit_v2/i);
  assert.match(personaSnapshotMigration, /jsonb_array_length\(p_party_personas\) > 6/i);
  assert.match(personaSnapshotMigration, /octet_length\(p_party_personas::text\) > 60000/i);
  assert.match(personaSnapshotMigration, /v_role not in \('owner','editor'\)/i);
  assert.match(personaSnapshotMigration, /UNKNOWN_PERSONA_KEY/);
  assert.match(personaSnapshotMigration, /party_personas',v_session\.party_personas/i);
  assert.match(personaSnapshotMigration, /revoke all on function public\.apply_party_edit_v2/i);
  assert.match(personaSnapshotMigration, /grant execute on function public\.apply_party_edit_v2.*to authenticated/i);
  assert.doesNotMatch(sharedUi, /同期・創作・手動追加の人格を含む編成は、現在クラウド共有に対応していません/);
  assert.match(app, /必要な人格データは共有セッションに含めて同期されます/);
  assert.match(app, /元のLBT保存データは変更しません/);
  assert.doesNotMatch(app, /URL・クラウド共有には含まれません/);
  assert.doesNotMatch(app, /追加人格は現在のクラウド共有セッションでは使用できません/);
});
