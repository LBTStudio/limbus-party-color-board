import { createSharedSessions, isCaptchaReady, isSharedSessionsConfigured, isTurnstileConfigured, setCaptchaToken } from './shared-sessions.mjs';
import { TURNSTILE_SITE_KEY } from './supabase-config.mjs';
import { forgetKnownSharedSession, readKnownSharedSessions, rememberKnownSharedSession } from './known-shared-sessions.mjs';

const $ = (selector) => document.querySelector(selector);
let api = null;
let active = null;
let personalPartySnapshot = null;
let sessions = [];
let admin = null;
let statusMessage = '';
let sharedPanelOpen = false;
let pollTimer = null;
let realtimeChannel = null;
let realtimeConnected = false;
let realtimeAttemptId = 0;
let realtimeRefreshTimer = null;
let turnstileWidgetId = null;
let bridge = null;
let createBusy = false;
let pendingJoinChoice = null;
let joinChoiceBusy = false;
let displayNameSyncTimer = null;
let displayNameSyncQueue = Promise.resolve();
let displayNameInputVersion = 0;
let displayNameComposing = false;

const DISPLAY_NAME_SYNC_DELAY_MS = 450;

function getApi() {
  if (!isSharedSessionsConfigured()) {
    throw new Error('js/supabase-config.mjs に Supabase の publishable key を設定してください。');
  }
  if (!api) api = createSharedSessions();
  return api;
}

function displayName() {
  try {
    const input = $('#shared-display-name');
    const stored = localStorage.getItem('lbt_party_shared_display_name');
    const value = String(input ? input.value : (stored || '')).trim().slice(0, 40);
    return value || '参加者';
  } catch {
    const value = String($('#shared-display-name')?.value || '').trim().slice(0, 40);
    return value || '参加者';
  }
}

function rememberDisplayName(value = displayName()) {
  const normalized = String(value || '').trim().slice(0, 40) || '参加者';
  const input = $('#shared-display-name');
  if (input && input.value !== normalized) input.value = normalized;
  try {
    localStorage.setItem('lbt_party_shared_display_name', normalized);
  } catch { /* Optional preference. */ }
}

function storeDisplayNamePreference(value) {
  const normalized = String(value || '').trim().slice(0, 40) || '参加者';
  try {
    localStorage.setItem('lbt_party_shared_display_name', normalized);
  } catch { /* Optional preference. */ }
  return normalized;
}

function scheduleDisplayNameSync(delay = DISPLAY_NAME_SYNC_DELAY_MS) {
  if (displayNameSyncTimer) clearTimeout(displayNameSyncTimer);
  const version = ++displayNameInputVersion;
  const session = active;
  displayNameSyncTimer = setTimeout(() => {
    displayNameSyncTimer = null;
    const value = storeDisplayNamePreference($('#shared-display-name')?.value || '');
    if (!session || active !== session || !['owner', 'editor'].includes(session.role)) return;

    // Serialize writes and collapse stale keystroke batches to the latest value.
    displayNameSyncQueue = displayNameSyncQueue.catch(() => {}).then(async () => {
      if (active !== session || version !== displayNameInputVersion
        || !['owner', 'editor'].includes(session.role)) return;
      try {
        await getApi().updateMemberDisplayName(session.sessionId, value);
        if (active === session && version === displayNameInputVersion) {
          setStatus('編集参加時の表示名を共有先へ反映しました。');
        }
      } catch (error) {
        if (active === session && version === displayNameInputVersion) {
          setStatus('表示名を共有先へ同期できませんでした: ' + (error.message || '通信エラー'));
        }
      }
    });
  }, Math.max(0, delay));
}

function snapshotOwnerDisplayName(snapshot, fallback = '編成主') {
  const owner = Array.isArray(snapshot?.members)
    ? snapshot.members.find((member) => member?.role === 'owner')
    : null;
  const value = String(snapshot?.owner_display_name || owner?.display_name || fallback).trim().slice(0, 40);
  return value || fallback;
}

function publicToolUrl() {
  return location.origin + location.pathname;
}

function sameKeys(a, b) {
  return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((key, index) => key === b[index]);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function personaSignature(personas) {
  return JSON.stringify(stableValue(Array.isArray(personas) ? personas : []));
}

function samePartyState(keysA, personasA, keysB, personasB) {
  return sameKeys(keysA, keysB) && personaSignature(personasA) === personaSignature(personasB);
}

function currentKeys() {
  return bridge.getPartyKeys();
}

function currentPartyEntries() {
  const entries = typeof bridge.getPartyEntries === 'function'
    ? bridge.getPartyEntries()
    : currentKeys().map((key) => ({ key }));
  return Array.isArray(entries)
    ? entries.map((entry) => ({
      key: String(entry?.key ?? ''),
      playerName: String(entry?.playerName ?? '').trim().slice(0, 80),
    })).filter((entry) => entry.key)
    : [];
}

function currentPersonas() {
  return typeof bridge.getPartyPersonas === 'function' ? bridge.getPartyPersonas() : [];
}

function remotePersonas(snapshot) {
  return Array.isArray(snapshot?.party_personas) ? snapshot.party_personas : [];
}

function shareabilityError() {
  if (typeof bridge.canShareCurrentParty !== 'function') return '';
  const result = bridge.canShareCurrentParty();
  if (result === true) return '';
  return typeof result === 'string' ? result : '共有できない人格データが編成に含まれています。';
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
  if (role === 'public-viewer') return '閲覧モード';
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
    controls.forEach((control) => {
      if ('disabled' in control) control.disabled = Boolean(active?.controlBusy);
      actions.append(control);
    });
    row.append(actions);
  }
  return row;
}

function renderAdmin(data) {
  const members = Array.isArray(data.members) ? data.members : [];
  const memberLimit = Math.max(1, Math.min(20, Number(data.member_limit) || 6));
  const memberLimitInput = $('#shared-member-limit');
  memberLimitInput.value = String(memberLimit);
  memberLimitInput.min = String(Math.max(1, members.length));
  memberLimitInput.disabled = Boolean(active?.controlBusy);
  $('#shared-update-member-limit').disabled = Boolean(active?.controlBusy);
  $('#shared-member-limit-hint').textContent = '現在 ' + members.length + '名 / 上限 ' + memberLimit
    + '名。ルームマスターを含みます。上限は1〜20名で設定でき、参加中の人数より小さくはできません。';
  const membersRoot = $('#shared-members');
  membersRoot.replaceChildren(adminSection(
    '編集参加者（' + members.length + '/' + memberLimit + '名）',
    members,
    '編集参加者はいません。',
    (item) => adminItem(
      item.display_name,
      roleLabel(item.role) + ' · ID ' + String(item.user_id).slice(0, 8),
      item.role === 'owner' ? [] : [
        makeActionButton('編集参加を解除', 'shared-remove-member', { userId: item.user_id }),
      ],
    ),
  ));
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

function setSharedPanelOpen(open) {
  sharedPanelOpen = Boolean(open);
  const panel = $('#shared-panel');
  const toggle = $('#shared-panel-toggle');
  if (!panel || !toggle) return;
  panel.classList.toggle('is-open', sharedPanelOpen);
  toggle.setAttribute('aria-expanded', String(sharedPanelOpen));
  const fullLabel = $('.shared-toggle-label-full');
  const compactLabel = $('.shared-toggle-label-compact');
  const mark = $('.shared-toggle-mark');
  if (fullLabel) fullLabel.textContent = sharedPanelOpen ? '共有パネルを閉じる' : '共有・共同編集を開く';
  if (compactLabel) compactLabel.textContent = sharedPanelOpen ? '閉じる' : '共有スペース';
  if (mark) mark.textContent = sharedPanelOpen ? '×' : '＋';
}

function render() {
  const statusEl = $('#shared-status');
  if (!statusEl) return;
  const configured = isSharedSessionsConfigured();
  statusEl.textContent = statusMessage || (configured
    ? '共有編成を開くか、新規作成してください。'
    : '共有機能は接続設定待ちです。js/supabase-config.mjs に公開用 publishable key を設定し、Supabase でマイグレーションを実行してください。');
  const choosingAccess = Boolean(pendingJoinChoice);
  $('#shared-join-choice').hidden = !choosingAccess;
  $('#shared-create-tools').hidden = choosingAccess;
  if (choosingAccess) {
    const editEnabled = pendingJoinChoice.public_edit_enabled !== false;
    $('#shared-join-choice-title').textContent = pendingJoinChoice.title || '共有スペース';
    $('#shared-choice-display-name').value = displayName();
    $('#shared-choice-name-field').hidden = !editEnabled;
    $('#shared-join-as-editor').disabled = joinChoiceBusy || !editEnabled;
    $('#shared-join-as-viewer').disabled = joinChoiceBusy;
    $('#shared-join-as-editor').textContent = editEnabled ? '参加者として参加（編集）' : '参加者として参加（停止中）';
    $('#shared-join-choice-note').textContent = editEnabled
      ? '参加者は編成を編集して全員に共有できます。閲覧のみでは編成を変更できません。'
      : 'この共有スペースでは新しい編集参加が停止されています。閲覧のみ利用できます。';
  }
  $('#shared-create').disabled = !configured || createBusy;
  $('#shared-refresh').disabled = !configured || active?.role === 'public-viewer';
  $('#shared-role-label').textContent = active
    ? roleLabel(active.role) + ' / revision ' + active.revision
    : 'この端末の個人編成';

  const list = $('#shared-session-list');
  list.replaceChildren();
  sessions.forEach((item) => {
    const selected = active && active.sessionId === item.session_id;
    const row = node('div', 'shared-session-item');
    const text = node('div', 'shared-session-copy');
    text.append(node('strong', '', item.title));
    if (item.rememberedOnly) {
      text.append(node('small', '', '前回利用した共有スペース · 接続時に権限を再確認します'));
    } else {
      const memberCount = Number(item.member_count);
      const memberLimit = Number(item.member_limit) || 20;
      const memberCountLabel = Number.isInteger(memberCount) && memberCount >= 1
        ? memberCount + '/' + memberLimit + '名'
        : '人数取得中';
      text.append(node('small', '', roleLabel(item.role) + ' · revision ' + (Number(item.revision) || 0)
        + ' · ' + memberCountLabel));
      text.append(node('small', 'shared-session-owner', '発行者: ' + (item.owner_display_name || '編成主')));
      const activity = item.last_activity_at ? new Date(item.last_activity_at) : (item.updated_at ? new Date(item.updated_at) : null);
      text.append(node('small', 'shared-session-activity', activity && !Number.isNaN(activity.getTime())
        ? '最終利用 ' + activity.toLocaleDateString() + ' ' + activity.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '利用状況を取得できません'));
    }
    row.append(text);
    const openButton = makeActionButton(selected ? '選択中' : (item.rememberedOnly ? '再接続' : '開く'), 'shared-open-session', { sessionId: item.session_id });
    openButton.disabled = Boolean(selected) || Boolean(active?.controlBusy);
    row.append(openButton);
    list.append(row);
  });
  if (!sessions.length && configured) {
    list.append(node('p', 'empty', 'この端末に記録された共有スペースはありません。共有リンクを開くと、次回からここに表示されます。'));
  }

  $('#shared-active').hidden = !active;
  if (!active) return;
  $('#shared-active-title').textContent = active.title;
  const memberLimitLabel = Number(active.memberLimit) > 0 ? ' · 定員 ' + active.memberLimit + '名' : '';
  $('#shared-active-meta').textContent = '発行者: ' + active.ownerDisplayName + ' · ' + roleLabel(active.role)
    + memberLimitLabel + ' · revision ' + active.revision + ' · ' + activeStatusLabel();
  const owner = active.role === 'owner' && !active.accessRevoked && active.status !== 'closed';
  $('#shared-join-edit').hidden = active.role !== 'public-viewer' || !active.publicEditEnabled;
  $('#shared-join-edit').disabled = Boolean(active.controlBusy);
  $('#shared-copy-session-link').hidden = false;
  $('#shared-refresh-snapshot').hidden = false;
  $('#shared-refresh-snapshot').disabled = Boolean(active.controlBusy);
  $('#shared-archive').hidden = !owner;
  $('#shared-leave').disabled = active.saveBusy || Boolean(active.controlBusy);
  $('#shared-retry-save').hidden = !active.retry || active.status !== 'unsaved';
  $('#shared-archive').disabled = active.saveBusy || Boolean(active.retry) || Boolean(active.incomingState) || Boolean(active.controlBusy);
  $('#shared-conflict').hidden = !active.incomingState;
  if (active.incomingState) {
    $('#shared-conflict-message').textContent =
      'サーバー revision ' + active.incomingState.revision + ' が最新です。未保存の編成を保持しています。どちらを採用するか選んでください。';
  }
  $('#shared-public-settings').hidden = !owner;
  $('#shared-public-view-enabled').checked = active.publicViewEnabled !== false;
  $('#shared-public-edit-enabled').checked = active.publicEditEnabled !== false;
  $('#shared-public-view-enabled').disabled = Boolean(active.controlBusy);
  $('#shared-public-edit-enabled').disabled = Boolean(active.controlBusy) || active.publicViewEnabled === false;
  $('#shared-admin').hidden = !owner || !admin;
  if (owner && admin) renderAdmin(admin);
}

async function refreshSessions() {
  try {
    setStatus('参加中の共有編成をクラウドから読み込んでいます…');
    const result = await getApi().listSessions(displayName());
    const listed = Array.isArray(result) ? result : [];
    const listedIds = new Set(listed.map((item) => String(item.session_id || '').toLowerCase()));
    const remembered = readKnownSharedSessions()
      .filter((item) => !listedIds.has(item.session_id))
      .map((item) => ({
        session_id: item.session_id,
        title: item.title,
        role: 'remembered',
        rememberedOnly: true,
      }));
    sessions = [...listed, ...remembered];
    const activeListing = active && sessions.find((item) => item.session_id === active.sessionId);
    if (activeListing?.owner_display_name) {
      active.ownerDisplayName = String(activeListing.owner_display_name).trim().slice(0, 40) || '編成主';
    }
    statusMessage = '共有編成を読み込みました（' + sessions.length + '件）。';
    render();
    if (active && active.role === 'owner') await refreshAdmin();
  } catch (error) {
    // Preserve the locally remembered entries if the cloud membership listing
    // is temporarily unavailable. Opening one still revalidates access at the server.
    const remembered = readKnownSharedSessions().map((item) => ({
      session_id: item.session_id,
      title: item.title,
      role: 'remembered',
      rememberedOnly: true,
    }));
    sessions = remembered;
    setStatus((error.message || 'セッション一覧を取得できませんでした。')
      + (remembered.length ? ' 前回利用した共有スペースは再接続できます。' : ''));
  }
}

async function createSession() {
  if (createBusy) return;
  const switchError = sessionSwitchError();
  if (switchError) {
    setStatus(switchError);
    return;
  }
  const shareError = shareabilityError();
  if (shareError) {
    setStatus(shareError);
    bridge.showToast(shareError);
    setSharedPanelOpen(true);
    return;
  }
  const title = String($('#shared-session-title').value || '').trim().slice(0, 80);
  const ownerDisplayName = String($('#shared-display-name').value || '').trim().slice(0, 40);
  if (!title) {
    setStatus('共同編集スペース名を入力してください。');
    $('#shared-session-title').focus();
    return;
  }
  if (!ownerDisplayName) {
    setStatus('自分の表示名を入力してください。');
    $('#shared-display-name').focus();
    return;
  }
  rememberDisplayName(ownerDisplayName);
  createBusy = true;
  render();
  try {
    if (await getApi().needsAnonymousAuth()) {
      await initializeTurnstile();
      if (isTurnstileConfigured() && !isCaptchaReady()) {
        setStatus('共有スペースの作成には不正利用防止の確認が必要です。確認を完了してから、もう一度作成してください。');
        return;
      }
    }
    setStatus('共有編成をクラウドに作成しています…');
    const result = await getApi().createSession(title, ownerDisplayName);
    if (!result || !result.session_id) throw new Error('セッション作成の応答が不正です。');

    // Keep database defaults private so an older deployed frontend cannot
    // accidentally publish a workspace during the migration/deployment gap.
    // The new UI explicitly enables the intended public defaults after creation.
    let publicAccessError = null;
    try {
      const access = await getApi().setPublicAccess(result.session_id, true, true);
      if (access?.public_view_enabled !== true || access?.public_edit_enabled !== true) {
        throw new Error('公開設定の更新結果を確認できませんでした。');
      }
      Object.assign(result, access);
    } catch (error) {
      publicAccessError = error;
    }

    $('#shared-session-title').value = '';
    await activateSession(result.session_id, result);
    if (publicAccessError) {
      setStatus('共有スペースは作成されましたが、公開設定をONにできませんでした。非公開のままです。公開・参加設定を確認してください: '
        + (publicAccessError.message || '設定エラー'));
    }
  } catch (error) {
    setStatus('共同編集スペースを作成できませんでした: ' + error.message);
  } finally {
    createBusy = false;
    render();
  }
}

function sessionSwitchError() {
  if (!active) return '';
  if (active.controlBusy) {
    return '共有設定・参加者管理の処理中です。完了してから切り替えてください。';
  }
  if (active.saveBusy || active.retry || active.incomingState
    || !samePartyState(currentKeys(), currentPersonas(), active.lastSavedKeys, active.lastSavedPersonas)) {
    return '未保存の編集、保存処理、または競合があります。再試行・競合解決・破棄のいずれかを済ませてから切り替えてください。';
  }
  return '';
}

async function activateSession(sessionId, prefetched = null) {
  const switchError = sessionSwitchError();
  if (switchError) throw new Error(switchError);
  const snapshot = prefetched && Array.isArray(prefetched.party_keys)
    ? prefetched
    : await getApi().readPublicSession(sessionId);
  if (snapshot.status === 'closed') throw new Error('このセッションは終了されています。');
  if (!Array.isArray(snapshot.party_keys)) throw new Error('編成データが取得できませんでした。');
  rememberKnownSharedSession(snapshot.session_id || sessionId, snapshot.title || '共有スペース');

  if (!active && !personalPartySnapshot) personalPartySnapshot = currentPartyEntries();
  stopPolling();
  stopRealtime();
  active = {
    sessionId: snapshot.session_id || sessionId,
    title: snapshot.title || '共有セッション',
    role: snapshot.role || 'public-viewer',
    publicViewEnabled: snapshot.public_view_enabled !== false,
    publicEditEnabled: snapshot.public_edit_enabled !== false,
    memberLimit: Number(snapshot.member_limit) || 20,
    ownerDisplayName: snapshotOwnerDisplayName(snapshot),
    revision: Number(snapshot.revision) || 0,
    lastSavedKeys: [...snapshot.party_keys],
    lastSavedPersonas: remotePersonas(snapshot),
    status: 'saved',
    saveBusy: false,
    retry: null,
    incomingState: null,
    localDraft: null,
    accessRevoked: false,
    lastActivity: Date.now(),
    failures: 0,
    pollBusy: false,
    pollQueued: false,
    adminUpdatedAt: 0,
    controlBusy: false,
  };
  admin = null;
  setSharedPanelOpen(true);
  setRoute('session=' + active.sessionId);
  bridge.setPartyKeys(snapshot.party_keys, remotePersonas(snapshot));
  statusMessage = snapshot._fromCache
    ? '保存済みの閲覧キャッシュを表示しています。必要に応じて「編成を更新」を押してください。'
    : '「' + active.title + '」を開きました。閲覧中は自動同期・定期通信を行いません。';
  render();
  if (['owner', 'editor', 'viewer'].includes(active.role)) {
    // refreshSessions already loads the owner roster; don't make a second admin RPC.
    await refreshSessions();
    if (active && ['owner', 'editor'].includes(active.role)) void startRealtime(active);
  }
}

async function refreshAdmin() {
  const session = active;
  if (!session || session.role !== 'owner') {
    admin = null;
    render();
    return;
  }
  try {
    const result = await getApi().getAdmin(session.sessionId);
    if (active !== session || session.role !== 'owner') return;
    admin = result;
    const owner = Array.isArray(result.members)
      ? result.members.find((member) => member?.role === 'owner')
      : null;
    if (owner?.display_name) {
      session.ownerDisplayName = String(owner.display_name).trim().slice(0, 40) || '編成主';
    }
    session.adminUpdatedAt = Date.now();
    render();
  } catch (error) {
    if (active !== session || session.role !== 'owner') return;
    statusMessage = '編集参加者の管理情報を取得できませんでした: ' + error.message;
    render();
  }
}

function stopRealtime() {
  // Invalidate a pending subscribe() as well as an already-open channel.
  // Visibility changes and session switches can otherwise leave orphan sockets.
  realtimeAttemptId += 1;
  if (active) active.realtimeStarting = false;
  if (realtimeRefreshTimer) clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer = null;
  realtimeConnected = false;
  const previous = realtimeChannel;
  realtimeChannel = null;
  if (previous && api) void api.removeChannel(previous).catch(() => {});
}

async function startRealtime(session) {
  if (!session || active !== session || !['owner', 'editor'].includes(session.role) || document.hidden) return;
  if (session.realtimeStarting || (realtimeChannel && realtimeConnected)) return;

  stopRealtime();
  const attemptId = realtimeAttemptId;
  session.realtimeStarting = true;
  let pendingChannel = null;
  try {
    const subscribePromise = getApi().subscribeSession(session.sessionId, (payload) => {
      if (active !== session || realtimeAttemptId !== attemptId) return;
      if (payload?._event === 'membership_changed') {
        // Refresh the workspace list (and owner roster) after a member renames themselves.
        void refreshSessions();
        if (realtimeRefreshTimer) clearTimeout(realtimeRefreshTimer);
        realtimeRefreshTimer = setTimeout(() => { void pollSession(); }, 150);
        return;
      }
      // The save RPC response owns the outcome of our in-flight write.
      // Its own Broadcast echo must not be treated as a competing edit.
      if (session.saveBusy) return;
      const nextRevision = Number(payload?.revision) || 0;
      if (nextRevision <= session.revision) return;
      if (realtimeRefreshTimer) clearTimeout(realtimeRefreshTimer);
      realtimeRefreshTimer = setTimeout(() => { void pollSession(); }, 300);
    }, (status) => {
      if (active !== session || realtimeAttemptId !== attemptId) return;
      realtimeConnected = status === 'SUBSCRIBED';
      if (realtimeConnected) {
        stopPolling();
        session.failures = 0;
        // Reconcile after subscribe to close the read-to-subscribe race where
        // a revision can be committed before this channel starts receiving.
        if (session.saveBusy) session.pollQueued = true;
        else void pollSession();
      } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        realtimeConnected = false;
        session.realtimeStarting = false;
        realtimeAttemptId += 1;
        const failedChannel = realtimeChannel || pendingChannel;
        realtimeChannel = null;
        if (failedChannel && api) void api.removeChannel(failedChannel).catch(() => {});
        schedulePoll(10000);
      }
    });

    // Keep a bounded polling fallback until Realtime confirms the subscription.
    schedulePoll(15000);
    pendingChannel = await subscribePromise;
    if (active === session && !document.hidden && realtimeAttemptId === attemptId) {
      realtimeChannel = pendingChannel;
    } else {
      await getApi().removeChannel(pendingChannel);
      if (session.realtimeStarting === true) session.realtimeStarting = false;
    }
  } catch (error) {
    if (active === session && realtimeAttemptId === attemptId) {
      realtimeConnected = false;
      session.realtimeStarting = false;
      session.status = 'disconnected';
      statusMessage = 'Realtime接続に失敗しました。低頻度の確認通信へ切り替えます: ' + (error.message || '接続エラー');
      render();
      schedulePoll(10000);
    }
    if (pendingChannel) void getApi().removeChannel(pendingChannel).catch(() => {});
  }
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll(delay = null) {
  stopPolling();
  if (!active || active.role === 'public-viewer' || realtimeConnected || active.accessRevoked || active.status === 'closed' || document.hidden) return;
  const busyWindow = Date.now() - active.lastActivity < 120000;
  const base = delay === null ? (busyWindow ? 60000 : 120000) : delay;
  pollTimer = setTimeout(() => pollSession(), Math.round(base + Math.random() * Math.min(900, base * 0.15)));
}

async function pollSession() {
  const session = active;
  if (!session || document.hidden || session.accessRevoked || session.status === 'closed') return;
  if (session.saveBusy || session.pollBusy) {
    session.pollQueued = true;
    return;
  }

  stopPolling();
  session.pollBusy = true;
  session.pollQueued = false;
  const finishPoll = () => {
    session.pollBusy = false;
    if (active === session && session.pollQueued && !session.saveBusy
      && !session.accessRevoked && session.status !== 'closed') {
      session.pollQueued = false;
      setTimeout(() => { void pollSession(); }, 0);
      return true;
    }
    return false;
  };

  try {
    const result = await getApi().pollSession(session.sessionId, session.revision);
    if (active !== session) {
      finishPoll();
      return;
    }
    // A save may have started while this snapshot request was in flight.
    // Let the write response decide success/conflict before comparing snapshots.
    if (session.saveBusy) {
      session.pollQueued = true;
      finishPoll();
      return;
    }
    session.failures = 0;
    if (result.status === 'closed') {
      session.status = 'closed';
      session.pollQueued = false;
      stopRealtime();
      statusMessage = '発行者がこのセッションを終了しました。編集は保存できません。';
      bridge.renderAll();
      render();
      finishPoll();
      return;
    }
    const previousRole = session.role;
    if (result.role) session.role = result.role === 'viewer' ? 'public-viewer' : result.role;
    if (result.public_view_enabled !== undefined) session.publicViewEnabled = result.public_view_enabled !== false;
    if (result.public_edit_enabled !== undefined) session.publicEditEnabled = result.public_edit_enabled !== false;
    if (Number(result.member_limit) > 0) session.memberLimit = Number(result.member_limit);
    if (Array.isArray(result.members)) {
      session.ownerDisplayName = snapshotOwnerDisplayName(result, session.ownerDisplayName);
    }
    if (previousRole !== session.role) bridge.renderAll();
    const remoteKeys = Array.isArray(result.party_keys) ? result.party_keys : null;
    const incomingPersonas = remotePersonas(result);
    if (remoteKeys && Number(result.revision) > session.revision) {
      const localKeys = currentKeys();
      const localPersonas = currentPersonas();
      if (samePartyState(localKeys, localPersonas, remoteKeys, incomingPersonas)) {
        session.revision = Number(result.revision);
        session.lastSavedKeys = [...remoteKeys];
        session.lastSavedPersonas = incomingPersonas;
        session.status = 'saved';
        session.retry = null;
        session.incomingState = null;
        session.localDraft = null;
        statusMessage = '同期済み · revision ' + session.revision;
        bridge.renderAll();
      } else if (samePartyState(localKeys, localPersonas, session.lastSavedKeys, session.lastSavedPersonas)
        && !session.retry && !session.saveBusy) {
        applySnapshot(result);
      } else {
        session.incomingState = result;
        session.localDraft = { keys: localKeys, personas: localPersonas };
        session.status = 'conflict';
        statusMessage = '別の利用者が先に編集を保存しました。採用する編成を選択してください。';
        bridge.renderAll();
      }
    } else if (result.revision !== undefined) {
      session.revision = Math.max(session.revision, Number(result.revision) || 0);
    }
    render();
  } catch (error) {
    if (/SESSION_ACCESS_DENIED|42501|permission denied|OWNER_REQUIRED/i.test(String(error.code || '') + ' ' + String(error.message || ''))) {
      session.accessRevoked = true;
      session.status = 'closed';
      session.pollQueued = false;
      statusMessage = '編集参加権限が失効したか、セッションが終了されています。閲覧リンクが有効なら閲覧モードで開き直せます。';
      stopPolling();
      stopRealtime();
      bridge.renderAll();
      render();
      finishPoll();
      return;
    }
    session.failures += 1;
    session.status = 'disconnected';
    statusMessage = '同期エラー: ' + (error.message || '通信に失敗しました') + '。再接続を試みます。';
    render();
  }
  const queued = finishPoll();
  if (!queued && active === session && !session.accessRevoked && session.status !== 'closed' && !realtimeConnected) {
    const delay = session.failures
      ? Math.min(120000, 10000 * (2 ** Math.min(session.failures, 4)))
      : null;
    schedulePoll(delay);
  }
}

function applySnapshot(snapshot) {
  if (!active || !Array.isArray(snapshot.party_keys)) return;
  active.revision = Number(snapshot.revision) || active.revision;
  active.title = snapshot.title || active.title;
  active.role = snapshot.role || active.role;
  active.ownerDisplayName = snapshotOwnerDisplayName(snapshot, active.ownerDisplayName);
  if (Number(snapshot.member_limit) > 0) active.memberLimit = Number(snapshot.member_limit);
  active.lastSavedKeys = [...snapshot.party_keys];
  active.lastSavedPersonas = remotePersonas(snapshot);
  active.retry = null;
  active.incomingState = null;
  active.localDraft = null;
  active.status = 'saved';
  statusMessage = '他の利用者の編集を同期しました · revision ' + active.revision;
  bridge.setPartyKeys(snapshot.party_keys, active.lastSavedPersonas);
  render();
}

async function enterEditMode() {
  const session = active;
  if (!session || session.role !== 'public-viewer' || !session.publicEditEnabled || session.controlBusy) return;
  session.controlBusy = true;
  render();
  try {
    if (await getApi().needsAnonymousAuth()) {
      await initializeTurnstile();
      if (active !== session) return;
      if (isTurnstileConfigured() && !isCaptchaReady()) {
        setStatus('編集参加には不正利用防止の確認が必要です。表示された確認を完了し、もう一度「編集に参加」を押してください。');
        return;
      }
    }
    rememberDisplayName(displayName());
    setStatus('編集参加を開始しています…');
    const snapshot = await getApi().joinPublicSession(session.sessionId, displayName());
    if (active !== session) return;
    session.controlBusy = false;
    await activateSession(session.sessionId, snapshot);
    setStatus('編集参加しました。保存時はRealtime通知で他の編集者へ変更を知らせます。');
  } catch (error) {
    if (active === session) setStatus('編集に参加できませんでした: ' + (error.message || '通信エラー'));
  } finally {
    session.controlBusy = false;
    if (active === session) render();
  }
}

async function refreshActiveSnapshot() {
  const session = active;
  if (!session) return;
  if (session.role === 'public-viewer') {
    try {
      const snapshot = await getApi().readPublicSession(session.sessionId, { force: true });
      if (active === session) await activateSession(session.sessionId, snapshot);
    } catch (error) {
      setStatus('閲覧データを更新できませんでした: ' + (error.message || '通信エラー'));
    }
    return;
  }
  await pollSession();
}

async function copySessionLink() {
  if (!active) return;
  const value = publicToolUrl() + '#session=' + encodeURIComponent(active.sessionId);
  try {
    await navigator.clipboard.writeText(value);
    bridge.showToast('閲覧・編集参加用リンクをコピーしました。');
  } catch {
    let copied = false;
    const fallback = document.createElement('textarea');
    fallback.value = value;
    fallback.setAttribute('readonly', '');
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    document.body.appendChild(fallback);
    try {
      fallback.select();
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    fallback.remove();
    bridge.showToast(copied
      ? '閲覧・編集参加用リンクをコピーしました。'
      : 'リンクをコピーできませんでした。ブラウザのクリップボード権限を確認してください。');
  }
}

async function updateMemberLimit() {
  const session = active;
  if (!session || session.role !== 'owner' || session.controlBusy || !admin) return;
  const input = $('#shared-member-limit');
  const rawValue = String(input.value || '').trim();
  if (!/^(?:[1-9]|1[0-9]|20)$/.test(rawValue)) {
    setStatus('最大人数は1〜20の整数で指定してください。');
    input.focus();
    return;
  }
  const nextLimit = Number(rawValue);
  const currentCount = Array.isArray(admin.members) ? admin.members.length : 1;
  if (nextLimit < currentCount) {
    setStatus('現在の参加人数（' + currentCount + '名）より小さい上限には変更できません。');
    input.focus();
    return;
  }
  const previousLimit = Number(admin.member_limit) || session.memberLimit || 6;
  if (nextLimit === previousLimit) {
    setStatus('最大人数は変更されていません。');
    return;
  }
  if (nextLimit < previousLimit
    && !window.confirm('最大人数を ' + nextLimit + '名に減らします。現在の参加者は維持されますが、空き枠は減少します。続行しますか？')) return;

  session.controlBusy = true;
  render();
  try {
    const result = await getApi().setMemberLimit(session.sessionId, nextLimit);
    if (active !== session) return;
    session.memberLimit = Number(result.member_limit) || nextLimit;
    await refreshAdmin();
    if (active === session) setStatus('最大参加人数を ' + session.memberLimit + '名に更新しました（ルームマスター含む）。');
  } catch (error) {
    if (active === session) {
      const message = /MEMBER_LIMIT_BELOW_CURRENT/.test(error.message || '')
        ? '現在の参加人数より小さい上限には変更できません。'
        : /OWNER_REQUIRED/.test(error.message || '')
          ? 'ルームマスターのみ最大人数を変更できます。'
          : /MEMBER_LIMIT_OUT_OF_RANGE/.test(error.message || '')
            ? '最大人数は1〜20名の範囲で指定してください。'
            : '最大人数を更新できませんでした: ' + (error.message || '通信エラー');
      setStatus(message);
    }
  } finally {
    session.controlBusy = false;
    if (active === session) render();
  }
}

async function updatePublicAccess() {
  const session = active;
  if (!session || session.role !== 'owner' || session.controlBusy) return;
  const viewEnabled = $('#shared-public-view-enabled').checked;
  const editEnabled = viewEnabled && $('#shared-public-edit-enabled').checked;
  if (!viewEnabled) $('#shared-public-edit-enabled').checked = false;
  session.controlBusy = true;
  render();
  // Keep the requested values visible while the controls are locked.
  $('#shared-public-view-enabled').checked = viewEnabled;
  $('#shared-public-edit-enabled').checked = editEnabled;
  $('#shared-public-view-enabled').disabled = true;
  $('#shared-public-edit-enabled').disabled = true;
  $('#shared-leave').disabled = true;
  $('#shared-archive').disabled = true;
  try {
    const result = await getApi().setPublicAccess(session.sessionId, viewEnabled, editEnabled);
    if (active !== session) return;
    session.publicViewEnabled = result.public_view_enabled !== false;
    session.publicEditEnabled = result.public_edit_enabled !== false;
    await refreshAdmin();
    if (active !== session) return;
    setStatus('公開設定を更新しました。' + (!session.publicEditEnabled ? ' 新しい編集参加は停止しました。既存の編集参加者は個別に解除できます。' : ''));
  } catch (error) {
    if (active === session) {
      $('#shared-public-view-enabled').checked = session.publicViewEnabled !== false;
      $('#shared-public-edit-enabled').checked = session.publicEditEnabled !== false;
      setStatus('公開設定を更新できませんでした: ' + (error.message || '通信エラー'));
    }
  } finally {
    session.controlBusy = false;
    if (active === session) render();
  }
}

function onPartyChanged() {
  if (!active || !canEdit() || active.incomingState || active.retry || active.saveBusy) return;
  const keys = currentKeys();
  const personas = currentPersonas();
  if (samePartyState(keys, personas, active.lastSavedKeys, active.lastSavedPersonas)) return;
  const shareError = shareabilityError();
  if (shareError) {
    active.status = 'unsaved';
    statusMessage = shareError;
    render();
    bridge.showToast(shareError);
    return;
  }
  active.saveBusy = true;
  const operation = {
    keys: [...keys],
    personas,
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
      operation.personas,
      operation.label,
    );
    if (active !== session) return;
    if (result.status === 'conflict') {
      session.revision = Number(result.revision) || session.revision;
      session.incomingState = result;
      session.localDraft = { keys: currentKeys(), personas: currentPersonas() };
      session.retry = null;
      session.status = 'conflict';
      statusMessage = '保存競合を検出しました。サーバー版かローカル版を選択してください。';
      bridge.renderAll();
      bridge.showToast('他の利用者が先に編集を保存しました。');
      return;
    }
    session.revision = Number(result.revision) || session.revision;
    session.lastSavedKeys = Array.isArray(result.party_keys) ? [...result.party_keys] : [...operation.keys];
    session.lastSavedPersonas = remotePersonas(result);
    session.retry = null;
    session.status = 'saved';
    session.title = result.title || session.title;
    session.ownerDisplayName = snapshotOwnerDisplayName(result, session.ownerDisplayName);
    const roleChanged = session.role !== (result.role || session.role);
    session.role = result.role || session.role;
    statusMessage = '保存済み · revision ' + session.revision;
    if (roleChanged) bridge.renderAll();
  } catch (error) {
    if (active !== session) return;
    if (/EDITOR_REQUIRED|SESSION_ACCESS_DENIED|42501|permission denied/i.test(String(error.code || '') + ' ' + String(error.message || ''))) {
      session.accessRevoked = true;
      session.status = 'closed';
      session.retry = null;
      stopPolling();
      stopRealtime();
      statusMessage = '編集参加権限が解除されたため保存できません。未保存の内容はこの画面に残しています。共有編成を閉じる前に必要な情報を控えてください。';
    } else {
      session.status = 'unsaved';
      statusMessage = '未保存の編集があります: ' + (error.message || '通信エラー') + '。同じ操作IDで再試行できます。';
    }
  } finally {
    if (active === session) {
      session.saveBusy = false;
      if (session.pollQueued && !session.accessRevoked && session.status !== 'closed') {
        session.pollQueued = false;
        void pollSession();
      }
      render();
      if (!session.retry && !session.incomingState
        && !samePartyState(currentKeys(), currentPersonas(), session.lastSavedKeys, session.lastSavedPersonas)) {
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
  if (!active || !active.incomingState || !active.localDraft || !Array.isArray(active.localDraft.keys)) return;
  const session = active;
  session.revision = Number(session.incomingState.revision) || session.revision;
  session.lastSavedKeys = [...(session.incomingState.party_keys || [])];
  session.lastSavedPersonas = remotePersonas(session.incomingState);
  session.incomingState = null;
  const draft = { keys: [...session.localDraft.keys], personas: session.localDraft.personas || [] };
  session.localDraft = null;
  session.retry = null;
  session.status = 'saved';
  bridge.setPartyKeys(draft.keys, draft.personas);
  statusMessage = 'ローカル編成を最新 revision に対して再適用しています…';
  render();
  onPartyChanged();
}

async function removeMember(userId) {
  const session = active;
  if (!session || session.role !== 'owner' || session.controlBusy
    || !window.confirm('この編集参加者を解除しますか？この匿名Auth IDはこの共有スペースへ再参加できなくなります。ブラウザデータ削除や別端末で新しい匿名IDを作ると、公開編集がONの間は再参加できます。')) return;
  session.controlBusy = true;
  render();
  try {
    await getApi().removeMember(session.sessionId, userId);
    if (active !== session) return;
    await refreshAdmin();
    if (active === session) setStatus('編集参加を解除し、この匿名Auth IDの再参加を禁止しました。');
  } catch (error) {
    if (active === session) setStatus('編集参加者を解除できませんでした: ' + (error.message || '通信エラー'));
  } finally {
    session.controlBusy = false;
    if (active === session) render();
  }
}

async function archiveActive() {
  const session = active;
  if (!session || session.role !== 'owner' || session.controlBusy) return;
  const switchError = sessionSwitchError();
  if (switchError) {
    setStatus(switchError + ' 未解決の編集がある間は共同編集スペースを終了できません。');
    return;
  }
  if (!window.confirm('「' + session.title + '」を終了しますか？共有編成・参加者・招待・申請・編集履歴を即時削除します。この操作は取り消せません。続行しますか？')) return;
  session.controlBusy = true;
  render();
  try {
    await getApi().archiveSession(session.sessionId);
    forgetKnownSharedSession(session.sessionId);
    sessions = sessions.filter((item) => item.session_id !== session.sessionId);
    if (active === session) {
      session.controlBusy = false;
      leaveSession();
    }
    await refreshSessions();
    setStatus('共有編成を終了し、共有データと関連記録を即時削除しました。個人編成は残っています。');
  } catch (error) {
    if (active === session) setStatus('セッションを終了できませんでした: ' + error.message);
  } finally {
    session.controlBusy = false;
    if (active === session) render();
  }
}

function leaveSession() {
  if (active && active.controlBusy) {
    setStatus('共有設定・参加者管理の処理中です。完了してから共有セッションを閉じてください。');
    return;
  }
  if (active && active.saveBusy) {
    setStatus('保存処理中です。完了してから共有セッションを閉じてください。');
    return;
  }
  if (active && (active.retry || active.incomingState
    || !samePartyState(currentKeys(), currentPersonas(), active.lastSavedKeys, active.lastSavedPersonas))) {
    if (!window.confirm('サーバーに未保存、または競合中の編集があります。破棄して個人編成に戻りますか？')) return;
  }
  stopPolling();
  stopRealtime();
  const old = active;
  active = null;
  admin = null;
  setRoute('');
  if (personalPartySnapshot) bridge.setPartyKeys(personalPartySnapshot);
  personalPartySnapshot = null;
  bridge.saveState();
  bridge.renderAll();
  statusMessage = old && old.accessRevoked
    ? 'アクセス権が失効したため、この端末の個人編成に戻りました。'
    : 'この端末の個人編成に戻りました。共有編成はクラウドに残っています。';
  render();
}

function handleVisibility() {
  if (document.hidden) {
    stopPolling();
    stopRealtime();
    return;
  }
  if (active && !active.accessRevoked && ['owner', 'editor'].includes(active.role)) {
    void pollSession();
    void startRealtime(active);
  }
}


function captureInitialRoute() {
  const params = new URLSearchParams(location.hash.slice(1));
  const route = {
    token: params.get('invite'),
    sessionId: params.get('session'),
    requestedSessionId: params.get('request'),
  };

  // Shared-session links open the collaboration area directly rather than
  // leaving visitors at the top of the unrelated personal-board interface.
  if (route.token || route.sessionId || route.requestedSessionId) {
    setSharedPanelOpen(true);
  }

  // Legacy invite tokens are bearer-like secrets. Remove them before any
  // third-party script is loaded, then show the invite-retired notice.
  if (route.token) setRoute('');
  return route;
}

async function initializeRoute(route) {
  const { token, sessionId, requestedSessionId } = route;

  if (!isSharedSessionsConfigured()) {
    if (token || sessionId || requestedSessionId) {
      statusMessage = '共有リンクを利用するには、管理者が Supabase の publishable key と DB マイグレーションを設定する必要があります。';
      render();
    }
    return;
  }
  if (sessionId) {
    try {
      const snapshot = await getApi().readPublicSession(sessionId, { force: true });
      if (snapshot.status === 'closed') throw new Error('このセッションは終了されています。');
      if (!Array.isArray(snapshot.party_keys)) throw new Error('編成データが取得できませんでした。');
      if (['owner', 'editor'].includes(snapshot.role)) {
        // Existing authenticated members retain their current role and skip the chooser.
        await activateSession(sessionId, snapshot);
      } else {
        // Unrecognized visitors must explicitly choose editing or read-only access.
        pendingJoinChoice = snapshot;
        $('#shared-choice-display-name').value = displayName();
        statusMessage = '「' + (snapshot.title || '共有スペース') + '」の利用方法を選択してください。';
        render();
      }
    } catch (error) {
      setStatus('共有セッションを開けませんでした: ' + error.message);
    }
    return;
  }
  if (token || requestedSessionId) {
    setRoute('');
    setStatus('招待制は廃止されました。発行者に新しい閲覧・編集リンクを共有してもらってください。');
  }
}

async function chooseSharedAccess(mode) {
  const snapshot = pendingJoinChoice;
  if (!snapshot || joinChoiceBusy) return;
  const joinAsEditor = mode === 'editor';
  if (joinAsEditor && snapshot.public_edit_enabled === false) {
    setStatus('この共有スペースでは新しい編集参加が停止されています。閲覧のみ利用できます。');
    return;
  }
  const chosenName = String($('#shared-choice-display-name').value || '').trim().slice(0, 40);
  if (joinAsEditor && !chosenName) {
    setStatus('参加時の表示名を入力してください。');
    $('#shared-choice-display-name').focus();
    return;
  }

  joinChoiceBusy = true;
  pendingJoinChoice = null;
  if (joinAsEditor) rememberDisplayName(chosenName);
  render();
  try {
    await activateSession(snapshot.session_id, snapshot);
    if (joinAsEditor) await enterEditMode();
  } catch (error) {
    setStatus('共有スペースを開けませんでした: ' + (error.message || '通信エラー'));
  } finally {
    joinChoiceBusy = false;
    render();
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
      case 'shared-remove-member':
        await removeMember(button.dataset.userId);
        break;
      default:
        break;
    }
  } catch (error) {
    setStatus('操作に失敗しました: ' + error.message);
  }
}

async function initializeTurnstile() {
  const container = $('#shared-captcha-widget');
  const hint = $('#shared-captcha-hint');
  if (!container || !isTurnstileConfigured()) {
    if (container) container.hidden = true;
    if (hint) hint.hidden = true;
    return;
  }
  container.hidden = false;
  if (hint) hint.hidden = false;
  if (turnstileWidgetId !== null) return;
  try {
    if (!window.turnstile) {
      await new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-turnstile-loader]');
        if (existing) {
          existing.addEventListener('load', resolve, { once: true });
          existing.addEventListener('error', reject, { once: true });
          return;
        }
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        script.dataset.turnstileLoader = 'true';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Turnstile スクリプトを読み込めませんでした'));
        document.head.append(script);
      });
    }
    if (!window.turnstile) throw new Error('Turnstile が初期化されませんでした');
    const widgetId = window.turnstile.render(container, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token) => setCaptchaToken(token),
      'expired-callback': () => setCaptchaToken(''),
      'error-callback': () => {
        setCaptchaToken('');
        setStatus('不正利用防止の確認に失敗しました。ページを再読み込みしてやり直してください。');
      },
    });
    turnstileWidgetId = widgetId;
    window.addEventListener('supabase-captcha-reset', () => {
      setCaptchaToken('');
      if (window.turnstile && turnstileWidgetId !== null) window.turnstile.reset(turnstileWidgetId);
    });
  } catch (error) {
    setStatus('CAPTCHA を読み込めませんでした: ' + (error.message || '通信エラー'));
  }
}

export async function initializeSharedSessionsUi(callbacks) {
  bridge = callbacks;
  const displayNameInput = $('#shared-display-name');
  try {
    const savedName = String(localStorage.getItem('lbt_party_shared_display_name') || '').trim().slice(0, 40);
    if (savedName) displayNameInput.value = savedName;
    else if (!displayNameInput.value.trim()) displayNameInput.value = '参加者';
  } catch { /* Optional display-name preference. */ }

  const controller = {
    get isActive() { return Boolean(active); },
    get sessionId() { return active ? active.sessionId : ''; },
    get personalPartySnapshot() { return personalPartySnapshot ? personalPartySnapshot.map((entry) => ({ ...entry })) : null; },
    canEdit,
    onPartyChanged,
  };
  window.sharedPartySession = controller;

  $('#shared-panel-toggle').addEventListener('click', () => {
    const nextOpen = !sharedPanelOpen;
    setSharedPanelOpen(nextOpen);
    if (nextOpen && active?.role === 'owner') void refreshAdmin();
    else if (nextOpen && !active) void refreshSessions();
  });
  $('#shared-refresh').addEventListener('click', () => refreshSessions());
  $('#shared-join-as-editor').addEventListener('click', () => chooseSharedAccess('editor'));
  $('#shared-join-as-viewer').addEventListener('click', () => chooseSharedAccess('viewer'));
  displayNameInput.addEventListener('compositionstart', () => {
    displayNameComposing = true;
    if (displayNameSyncTimer) clearTimeout(displayNameSyncTimer);
    displayNameSyncTimer = null;
    displayNameInputVersion += 1;
  });
  displayNameInput.addEventListener('compositionend', () => {
    displayNameComposing = false;
    scheduleDisplayNameSync();
  });
  displayNameInput.addEventListener('input', (event) => {
    if (displayNameComposing || event.isComposing) return;
    scheduleDisplayNameSync();
  });
  displayNameInput.addEventListener('change', () => {
    if (!displayNameComposing) scheduleDisplayNameSync(0);
  });
  $('#shared-create').addEventListener('click', () => createSession());
  $('#shared-leave').addEventListener('click', () => leaveSession());
  $('#shared-archive').addEventListener('click', () => archiveActive());
  $('#shared-retry-save').addEventListener('click', () => retrySave());
  $('#shared-join-edit').addEventListener('click', () => enterEditMode());
  $('#shared-copy-session-link').addEventListener('click', () => copySessionLink());
  $('#shared-refresh-snapshot').addEventListener('click', () => refreshActiveSnapshot());
  $('#shared-public-view-enabled').addEventListener('change', () => updatePublicAccess());
  $('#shared-update-member-limit').addEventListener('click', () => updateMemberLimit());
  $('#shared-public-edit-enabled').addEventListener('change', () => updatePublicAccess());
  $('#shared-accept-remote').addEventListener('click', () => acceptRemote());
  $('#shared-reapply-local').addEventListener('click', () => reapplyLocal());
  document.addEventListener('click', handleSharedClick);
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('online', () => {
    if (active && !active.accessRevoked && ['owner', 'editor'].includes(active.role)) {
      void pollSession();
      void startRealtime(active);
    }
  });
  render();
  const initialRoute = captureInitialRoute();
  await initializeRoute(initialRoute);
}
