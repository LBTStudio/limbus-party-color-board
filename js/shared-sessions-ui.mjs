import { createSharedSessions, isSharedSessionsConfigured } from './shared-sessions.mjs';

const $ = (selector) => document.querySelector(selector);
let api = null;
let active = null;
let personalPartySnapshot = null;
let sessions = [];
let admin = null;
let inviteUrl = '';
let pendingRequestSessionId = null;
let statusMessage = '';
let pollTimer = null;
let accessTimer = null;
let bridge = null;

function getApi() {
  if (!isSharedSessionsConfigured()) {
    throw new Error('js/supabase-config.mjs に Supabase の publishable key を設定してください。');
  }
  if (!api) api = createSharedSessions();
  return api;
}

function displayName() {
  const value = String($('#shared-display-name')?.value || '').trim().slice(0, 40);
  return value || '参加者';
}

function rememberDisplayName() {
  try {
    localStorage.setItem('lbt_party_shared_display_name', displayName());
  } catch { /* Optional preference. */ }
}

function sameKeys(a, b) {
  return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((key, index) => key === b[index]);
}

function currentKeys() {
  return bridge.getPartyKeys();
}

function canEdit() {
  return !active
    || (!active.accessRevoked && active.status !== 'closed' && !active.incomingState
      && ['owner', 'editor'].includes(active.role));
}

function setStatus(message) {
  statusMessage = message;
  render();
}

function setRoute(route = '') {
  const url = new URL(location.href);
  url.searchParams.delete('p');
  url.hash = route;
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

function roleLabel(role) {
  if (role === 'owner') return '発行者';
  if (role === 'editor') return '編集者';
  return '閲覧者';
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function makeActionButton(label, action, dataset = {}, primary = false) {
  const button = node('button', primary ? 'btn' : 'btn btn-ghost', label);
  button.type = 'button';
  button.dataset.action = action;
  Object.entries(dataset).forEach(([key, value]) => { button.dataset[key] = String(value); });
  return button;
}

function adminSection(title, items, emptyText, renderItem) {
  const wrap = node('div', 'shared-admin-section');
  wrap.append(node('h3', '', title + ' (' + items.length + ')'));
  if (!items.length) {
    wrap.append(node('p', 'hint', emptyText));
  } else {
    items.forEach((item) => wrap.append(renderItem(item)));
  }
  return wrap;
}

function adminItem(label, description, controls = []) {
  const row = node('div', 'shared-admin-item');
  const left = node('div');
  left.append(node('strong', '', label));
  if (description) left.append(node('p', 'hint', description));
  row.append(left);
  if (controls.length) {
    const actions = node('div', 'shared-admin-buttons');
    controls.forEach((control) => actions.append(control));
    row.append(actions);
  }
  return row;
}

function renderAdmin(data) {
  const requests = Array.isArray(data.requests) ? data.requests : [];
  const members = Array.isArray(data.members) ? data.members : [];
  const invites = Array.isArray(data.invites) ? data.invites : [];
  const requestsRoot = $('#shared-requests');
  const membersRoot = $('#shared-members');
  const invitesRoot = $('#shared-invites');
  requestsRoot.replaceChildren(adminSection('参加申請', requests, '保留中の申請はありません。', (item) => adminItem(
    item.display_name,
    new Date(item.requested_at).toLocaleString(),
    [
      makeActionButton('編集許可', 'shared-approve', { requestId: item.request_id, role: 'editor' }, true),
      makeActionButton('閲覧許可', 'shared-approve', { requestId: item.request_id, role: 'viewer' }),
      makeActionButton('却下', 'shared-deny', { requestId: item.request_id }),
    ],
  )));
  membersRoot.replaceChildren(adminSection('参加者', members, '参加者はいません。', (item) => adminItem(
    item.display_name,
    roleLabel(item.role),
    item.role === 'owner' ? [] : [
      makeActionButton('参加権限を剥奪', 'shared-remove-member', { userId: item.user_id }),
    ],
  )));
  invitesRoot.replaceChildren(adminSection('招待リンク', invites, 'まだリンクを発行していません。', (item) => adminItem(
    item.active ? '有効' : '失効・期限切れ',
    '期限: ' + new Date(item.expires_at).toLocaleString(),
    item.active ? [makeActionButton('リンクを失効', 'shared-revoke-invite', { inviteId: item.invite_id })] : [],
  )));
}

function activeStatusLabel() {
  if (!active) return '';
  if (active.accessRevoked) return 'アクセス権失効';
  if (active.status === 'closed') return '終了済み';
  const labels = {
    saving: '保存中',
    saved: '同期済み',
    unsaved: '未保存',
    conflict: '競合あり',
    disconnected: '接続エラー',
  };
  return labels[active.status] || '同期中';
}

function render() {
  const statusEl = $('#shared-status');
  if (!statusEl) return;
  const configured = isSharedSessionsConfigured();
  statusEl.textContent = statusMessage || (configured
    ? '共有セッションを読み込むか、新規作成してください。'
    : '共有機能は接続設定待ちです。js/supabase-config.mjs に公開用 publishable key を設定し、Supabase でマイグレーションを実行してください。');
  $('#shared-create').disabled = !configured;
  $('#shared-refresh').disabled = !configured;
  $('#shared-role-label').textContent = active
    ? roleLabel(active.role) + ' / revision ' + active.revision
    : '個人編成';

  const list = $('#shared-session-list');
  list.replaceChildren();
  sessions.forEach((item) => {
    const selected = active && active.sessionId === item.session_id;
    const row = node('div', 'shared-session-item');
    const text = node('div');
    text.append(node('strong', '', item.title));
    text.append(node('small', '', roleLabel(item.role) + ' · rev ' + (Number(item.revision) || 0) + ' · ' + String(item.session_id).slice(0, 8)));
    row.append(text);
    const openButton = makeActionButton(selected ? '選択中' : '開く', 'shared-open-session', { sessionId: item.session_id });
    openButton.disabled = Boolean(selected);
    row.append(openButton);
    list.append(row);
  });
  if (!sessions.length && configured) {
    list.append(node('p', 'empty', 'セッションがありません。「空の共有セッションを作成」から開始してください。'));
  }

  $('#shared-active').hidden = !active;
  $('#shared-access-waiting').hidden = !pendingRequestSessionId;
  if (pendingRequestSessionId) {
    $('#shared-access-message').textContent = '承認待ちの申請があります。承認までは編成内容は取得できません。';
  }
  if (!active) return;

  $('#shared-active-title').textContent = active.title;
  $('#shared-active-meta').textContent = roleLabel(active.role) + ' · revision ' + active.revision + ' · ' + activeStatusLabel();
  const owner = active.role === 'owner' && !active.accessRevoked && active.status !== 'closed';
  $('#shared-create-invite').hidden = !owner;
  $('#shared-invite-tools').hidden = !owner || !inviteUrl;
  $('#shared-archive').hidden = !owner;
  $('#shared-leave').disabled = active.saveBusy;
  $('#shared-retry-save').hidden = !active.retry || active.status !== 'unsaved';
  $('#shared-conflict').hidden = !active.incomingState;
  if (active.incomingState) {
    $('#shared-conflict-message').textContent =
      'サーバー revision ' + active.incomingState.revision + ' が最新です。未保存の編成を保持しています。どちらを採用するか選んでください。';
  }
  $('#shared-invite-link').value = inviteUrl;
  $('#shared-admin').hidden = !owner || !admin;
  if (owner && admin) renderAdmin(admin);
}

async function refreshSessions() {
  try {
    setStatus('自分が参加しているセッションを読み込んでいます…');
    const result = await getApi().listSessions(displayName());
    sessions = Array.isArray(result) ? result : [];
    statusMessage = 'セッション一覧を読み込みました（' + sessions.length + '件）。';
    render();
    if (active && active.role === 'owner') await refreshAdmin();
  } catch (error) {
    setStatus(error.message || 'セッション一覧を取得できませんでした。');
  }
}

async function createSession() {
  const title = String($('#shared-session-title').value || '').trim();
  if (!title) {
    setStatus('セッション名を入力してください。');
    $('#shared-session-title').focus();
    return;
  }
  rememberDisplayName();
  try {
    setStatus('空の共有セッションを作成しています…');
    const result = await getApi().createSession(title, displayName());
    if (!result || !result.session_id) throw new Error('セッション作成の応答が不正です。');
    $('#shared-session-title').value = '';
    await activateSession(result.session_id, result);
    await refreshSessions();
  } catch (error) {
    setStatus('セッションを作成できませんでした: ' + error.message);
  }
}

async function activateSession(sessionId, prefetched = null) {
  if (active && (active.saveBusy || active.retry || active.incomingState
    || !sameKeys(currentKeys(), active.lastSavedKeys))) {
    throw new Error('未保存の編集、保存処理、または競合があります。再試行・競合解決・破棄のいずれかを済ませてから切り替えてください。');
  }
  const snapshot = prefetched && Array.isArray(prefetched.party_keys)
    ? prefetched
    : await getApi().pollSession(sessionId, -1);
  if (snapshot.status === 'closed') throw new Error('このセッションは終了されています。');
  if (!Array.isArray(snapshot.party_keys)) throw new Error('編成データが取得できませんでした。');

  if (!personalPartySnapshot) personalPartySnapshot = currentKeys().slice();
  stopPolling();
  active = {
    sessionId: snapshot.session_id || sessionId,
    title: snapshot.title || '共有セッション',
    role: snapshot.role || 'viewer',
    revision: Number(snapshot.revision) || 0,
    lastSavedKeys: [...snapshot.party_keys],
    status: 'saved',
    saveBusy: false,
    retry: null,
    incomingState: null,
    localDraft: null,
    accessRevoked: false,
    lastActivity: Date.now(),
    failures: 0,
    pollBusy: false,
    adminUpdatedAt: 0,
  };
  pendingRequestSessionId = null;
  admin = null;
  inviteUrl = '';
  setRoute('session=' + active.sessionId);
  bridge.setPartyKeys(snapshot.party_keys);
  statusMessage = '「' + active.title + '」を開きました。編集の保存と同期状態はこのパネルで確認できます。';
  render();
  await refreshSessions();
  schedulePoll(1000);
}

async function refreshAdmin() {
  const session = active;
  if (!session || session.role !== 'owner') {
    admin = null;
    render();
    return;
  }
  try {
    admin = await getApi().getAdmin(session.sessionId);
    session.adminUpdatedAt = Date.now();
    render();
  } catch (error) {
    statusMessage = '参加権限の管理情報を取得できませんでした: ' + error.message;
    render();
  }
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll(delay = null) {
  stopPolling();
  if (!active || active.accessRevoked || active.status === 'closed' || document.hidden) return;
  const busyWindow = Date.now() - active.lastActivity < 120000;
  const base = delay === null ? (busyWindow ? 5000 : 15000) : delay;
  pollTimer = setTimeout(() => pollSession(), Math.round(base + Math.random() * Math.min(900, base * 0.15)));
}

async function pollSession() {
  const session = active;
  if (!session || document.hidden || session.accessRevoked || session.status === 'closed' || session.pollBusy) return;
  session.pollBusy = true;
  try {
    const result = await getApi().pollSession(session.sessionId, session.revision);
    if (active !== session) {
      session.pollBusy = false;
      return;
    }
    session.failures = 0;
    if (result.status === 'closed') {
      session.status = 'closed';
      statusMessage = '発行者がこのセッションを終了しました。編集は保存できません。';
      bridge.renderAll();
      render();
      session.pollBusy = false;
      return;
    }
    const previousRole = session.role;
    if (result.role) session.role = result.role;
    if (previousRole !== session.role) bridge.renderAll();
    const remoteKeys = Array.isArray(result.party_keys) ? result.party_keys : null;
    if (remoteKeys && Number(result.revision) > session.revision) {
      const localKeys = currentKeys();
      if (sameKeys(localKeys, remoteKeys)) {
        session.revision = Number(result.revision);
        session.lastSavedKeys = [...remoteKeys];
        session.status = 'saved';
        session.retry = null;
        session.incomingState = null;
        session.localDraft = null;
        statusMessage = '同期済み · revision ' + session.revision;
        bridge.renderAll();
      } else if (sameKeys(localKeys, session.lastSavedKeys) && !session.retry && !session.saveBusy) {
        applySnapshot(result);
      } else {
        session.incomingState = result;
        session.localDraft = localKeys;
        session.status = 'conflict';
        statusMessage = '別の利用者が先に編集を保存しました。採用する編成を選択してください。';
        bridge.renderAll();
      }
    } else if (result.revision !== undefined) {
      session.revision = Math.max(session.revision, Number(result.revision) || 0);
    }
    render();
    if (active === session && session.role === 'owner'
      && Date.now() - (session.adminUpdatedAt || 0) >= 15000) {
      await refreshAdmin();
    }
  } catch (error) {
    if (/SESSION_ACCESS_DENIED|42501|permission denied|OWNER_REQUIRED/i.test(String(error.code || '') + ' ' + String(error.message || ''))) {
      session.accessRevoked = true;
      session.status = 'closed';
      statusMessage = 'アクセス権が失効したか、セッションが終了されています。共有セッションを閉じてください。';
      stopPolling();
      bridge.renderAll();
      render();
      session.pollBusy = false;
      return;
    }
    session.failures += 1;
    session.status = 'disconnected';
    statusMessage = '同期エラー: ' + (error.message || '通信に失敗しました') + '。再接続を試みます。';
    render();
  }
  session.pollBusy = false;
  if (active === session && !session.accessRevoked && session.status !== 'closed') {
    const delay = session.failures
      ? Math.min(60000, 5000 * (2 ** Math.min(session.failures, 4)))
      : null;
    schedulePoll(delay);
  }
}

function applySnapshot(snapshot) {
  if (!active || !Array.isArray(snapshot.party_keys)) return;
  active.revision = Number(snapshot.revision) || active.revision;
  active.title = snapshot.title || active.title;
  active.role = snapshot.role || active.role;
  active.lastSavedKeys = [...snapshot.party_keys];
  active.retry = null;
  active.incomingState = null;
  active.localDraft = null;
  active.status = 'saved';
  statusMessage = '他の利用者の編集を同期しました · revision ' + active.revision;
  bridge.setPartyKeys(snapshot.party_keys);
  render();
}

function onPartyChanged() {
  if (!active || !canEdit() || active.incomingState || active.retry || active.saveBusy) return;
  const keys = currentKeys();
  if (sameKeys(keys, active.lastSavedKeys)) return;
  active.saveBusy = true;
  const operation = {
    keys: [...keys],
    expectedRevision: active.revision,
    operationId: crypto.randomUUID(),
    label: 'party_update',
  };
  active.retry = operation;
  active.status = 'saving';
  active.lastActivity = Date.now();
  active.failures = 0;
  statusMessage = '編成を保存しています…';
  render();
  void sendSave(active, operation);
}

async function sendSave(session, operation) {
  try {
    const result = await getApi().applyParty(
      session.sessionId,
      operation.expectedRevision,
      operation.operationId,
      operation.keys,
      operation.label,
    );
    if (active !== session) return;
    if (result.status === 'conflict') {
      session.revision = Number(result.revision) || session.revision;
      session.incomingState = result;
      session.localDraft = currentKeys();
      session.retry = null;
      session.status = 'conflict';
      statusMessage = '保存競合を検出しました。サーバー版かローカル版を選択してください。';
      bridge.renderAll();
      bridge.showToast('他の利用者が先に編集を保存しました。');
      return;
    }
    session.revision = Number(result.revision) || session.revision;
    session.lastSavedKeys = Array.isArray(result.party_keys) ? [...result.party_keys] : [...operation.keys];
    session.retry = null;
    session.status = 'saved';
    session.title = result.title || session.title;
    session.role = result.role || session.role;
    statusMessage = '保存済み · revision ' + session.revision;
  } catch (error) {
    if (active !== session) return;
    session.status = 'unsaved';
    statusMessage = '未保存の編集があります: ' + (error.message || '通信エラー') + '。同じ操作IDで再試行できます。';
  } finally {
    if (active === session) {
      session.saveBusy = false;
      render();
      if (!session.retry && !session.incomingState && !sameKeys(currentKeys(), session.lastSavedKeys)) {
        onPartyChanged();
      }
    }
  }
}

async function retrySave() {
  const session = active;
  if (!session || !session.retry || session.saveBusy) return;
  session.saveBusy = true;
  session.status = 'saving';
  statusMessage = '同じ操作IDで未保存の編集を再試行しています…';
  render();
  await sendSave(session, session.retry);
}

function acceptRemote() {
  if (!active || !active.incomingState) return;
  applySnapshot(active.incomingState);
}

function reapplyLocal() {
  if (!active || !active.incomingState || !Array.isArray(active.localDraft)) return;
  const session = active;
  session.revision = Number(session.incomingState.revision) || session.revision;
  session.lastSavedKeys = [...(session.incomingState.party_keys || [])];
  session.incomingState = null;
  const draft = [...session.localDraft];
  session.localDraft = null;
  session.retry = null;
  session.status = 'saved';
  bridge.setPartyKeys(draft);
  statusMessage = 'ローカル編成を最新 revision に対して再適用しています…';
  render();
  onPartyChanged();
}

async function issueInvite() {
  if (!active || active.role !== 'owner') return;
  try {
    const invite = await getApi().createInvite(active.sessionId, 168);
    inviteUrl = location.origin + location.pathname + '#invite=' + invite.token;
    statusMessage = '参加申請リンクを発行しました。有効期限: ' + new Date(invite.expires_at).toLocaleString();
    await refreshAdmin();
    render();
    await copyInvite();
  } catch (error) {
    setStatus('リンクを発行できませんでした: ' + error.message);
  }
}

async function copyInvite() {
  if (!inviteUrl) return;
  try {
    await navigator.clipboard.writeText(inviteUrl);
    bridge.showToast('参加申請リンクをコピーしました。');
  } catch {
    $('#shared-invite-link').focus();
    $('#shared-invite-link').select();
    bridge.showToast('自動コピーできません。リンク欄を選択してコピーしてください。');
  }
}

async function revokeInvite(inviteId) {
  await getApi().revokeInvite(inviteId);
  inviteUrl = '';
  await refreshAdmin();
  setStatus('招待リンクを失効しました。');
}

async function removeMember(userId) {
  if (!active || !window.confirm('この参加者のアクセス権を剥奪しますか？')) return;
  await getApi().removeMember(active.sessionId, userId);
  await refreshAdmin();
  setStatus('参加権限を剥奪しました。');
}

async function decideRequest(requestId, decision, role = 'viewer') {
  await getApi().decideRequest(requestId, decision, role);
  await refreshAdmin();
  await refreshSessions();
  setStatus(decision === 'approve' ? roleLabel(role) + 'として承認しました。' : '参加申請を却下しました。');
}

async function archiveActive() {
  const session = active;
  if (!session || session.role !== 'owner') return;
  if (!window.confirm('「' + session.title + '」を終了しますか？以後、参加者はアクセスできません。')) return;
  try {
    await getApi().archiveSession(session.sessionId);
    sessions = sessions.filter((item) => item.session_id !== session.sessionId);
    leaveSession();
    await refreshSessions();
    setStatus('共有セッションを終了しました。');
  } catch (error) {
    setStatus('セッションを終了できませんでした: ' + error.message);
  }
}

function leaveSession() {
  if (active && active.saveBusy) {
    setStatus('保存処理中です。完了してから共有セッションを閉じてください。');
    return;
  }
  if (active && (active.retry || active.incomingState || !sameKeys(currentKeys(), active.lastSavedKeys))) {
    if (!window.confirm('サーバーに未保存、または競合中の編集があります。破棄して個人編成に戻りますか？')) return;
  }
  stopPolling();
  if (accessTimer) clearTimeout(accessTimer);
  accessTimer = null;
  const old = active;
  active = null;
  admin = null;
  inviteUrl = '';
  pendingRequestSessionId = null;
  setRoute('');
  if (personalPartySnapshot) bridge.setPartyKeys(personalPartySnapshot);
  personalPartySnapshot = null;
  bridge.saveState();
  bridge.renderAll();
  statusMessage = old && old.accessRevoked
    ? 'アクセス権が失効したため、個人編成に戻りました。'
    : '個人編成に戻りました。';
  render();
}

function handleVisibility() {
  if (document.hidden) {
    stopPolling();
    if (accessTimer) clearTimeout(accessTimer);
    accessTimer = null;
    return;
  }
  if (active && !active.accessRevoked) schedulePoll(250);
  if (pendingRequestSessionId) scheduleAccessCheck(500);
}

function scheduleAccessCheck(delay = 15000) {
  if (accessTimer) clearTimeout(accessTimer);
  if (!pendingRequestSessionId || document.hidden) return;
  accessTimer = setTimeout(async () => {
    await checkAccess(true);
    if (pendingRequestSessionId && !document.hidden) scheduleAccessCheck(15000);
  }, delay);
}

async function checkAccess(quiet = false) {
  const sessionId = pendingRequestSessionId;
  if (!sessionId) return;
  try {
    const result = await getApi().checkAccess(sessionId, displayName());
    if (result.status === 'approved') {
      if (accessTimer) clearTimeout(accessTimer);
      accessTimer = null;
      pendingRequestSessionId = null;
      await activateSession(sessionId);
    } else if (['denied', 'revoked', 'not_requested'].includes(result.status)) {
      if (accessTimer) clearTimeout(accessTimer);
      accessTimer = null;
      pendingRequestSessionId = null;
      setRoute('');
      setStatus('参加申請の状態は「' + result.status + '」です。発行者へ確認してください。');
    } else if (!quiet) {
      setStatus('まだ承認されていません。承認後は自動で共有編成を開きます。');
    }
  } catch (error) {
    if (!quiet) setStatus('承認状態を確認できませんでした: ' + error.message);
  }
}

async function initializeRoute() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('invite');
  const sessionId = params.get('session');
  const requestedSessionId = params.get('request');

  if (!isSharedSessionsConfigured()) {
    if (token || sessionId || requestedSessionId) {
      statusMessage = '共有リンクを利用するには、管理者が Supabase の publishable key と DB マイグレーションを設定する必要があります。';
      render();
    }
    return;
  }
  if (sessionId) {
    try {
      await activateSession(sessionId);
    } catch (error) {
      setStatus('共有セッションを開けませんでした: ' + error.message);
    }
    return;
  }
  if (requestedSessionId) {
    pendingRequestSessionId = requestedSessionId;
    setStatus('参加申請の承認状態を確認しています…');
    await checkAccess();
    if (pendingRequestSessionId) scheduleAccessCheck(15000);
    return;
  }
  if (!token) return;

  const provided = window.prompt('共有セッションで表示する名前を入力してください', displayName());
  if (!provided || !provided.trim()) {
    setStatus('参加申請をキャンセルしました。招待リンクを再度開くと申請できます。');
    return;
  }
  $('#shared-display-name').value = provided.trim().slice(0, 40);
  rememberDisplayName();
  // Remove the bearer token from URL/history before sending it to the API.
  setRoute('');
  try {
    const result = await getApi().requestAccess(token, displayName());
    if (result.status === 'approved') {
      await activateSession(result.session_id);
    } else if (result.status === 'pending') {
      pendingRequestSessionId = result.session_id;
      setRoute('request=' + result.session_id);
      setStatus('参加申請を送信しました。発行者の承認までは編成内容は表示されません。');
      scheduleAccessCheck(15000);
    } else {
      setStatus('参加申請を作成できませんでした: ' + (result.status || '不明な状態'));
    }
  } catch (error) {
    setStatus('参加申請に失敗しました: ' + error.message);
  }
}

async function handleSharedClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  try {
    switch (button.dataset.action) {
      case 'shared-open-session':
        await activateSession(button.dataset.sessionId);
        break;
      case 'shared-approve':
        await decideRequest(button.dataset.requestId, 'approve', button.dataset.role);
        break;
      case 'shared-deny':
        await decideRequest(button.dataset.requestId, 'deny', 'viewer');
        break;
      case 'shared-remove-member':
        await removeMember(button.dataset.userId);
        break;
      case 'shared-revoke-invite':
        await revokeInvite(button.dataset.inviteId);
        break;
      default:
        break;
    }
  } catch (error) {
    setStatus('操作に失敗しました: ' + error.message);
  }
}

export async function initializeSharedSessionsUi(callbacks) {
  bridge = callbacks;
  try {
    const savedName = localStorage.getItem('lbt_party_shared_display_name');
    if (savedName && !$('#shared-display-name').value) $('#shared-display-name').value = savedName;
  } catch { /* Optional display-name preference. */ }

  const controller = {
    get isActive() { return Boolean(active); },
    get sessionId() { return active ? active.sessionId : ''; },
    get personalPartySnapshot() { return personalPartySnapshot ? [...personalPartySnapshot] : null; },
    canEdit,
    onPartyChanged,
  };
  window.sharedPartySession = controller;

  $('#shared-display-name').addEventListener('change', rememberDisplayName);
  $('#shared-refresh').addEventListener('click', () => refreshSessions());
  $('#shared-create').addEventListener('click', () => createSession());
  $('#shared-create-invite').addEventListener('click', () => issueInvite());
  $('#shared-copy-invite').addEventListener('click', () => copyInvite());
  $('#shared-leave').addEventListener('click', () => leaveSession());
  $('#shared-archive').addEventListener('click', () => archiveActive());
  $('#shared-retry-save').addEventListener('click', () => retrySave());
  $('#shared-check-access').addEventListener('click', () => checkAccess());
  $('#shared-accept-remote').addEventListener('click', () => acceptRemote());
  $('#shared-reapply-local').addEventListener('click', () => reapplyLocal());
  document.addEventListener('click', handleSharedClick);
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('online', () => {
    if (active && !active.accessRevoked) schedulePoll(250);
    if (pendingRequestSessionId) scheduleAccessCheck(500);
  });
  render();
  await initializeRoute();
}
