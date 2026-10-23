import {
  MAX_PARTY,
  SIN_META,
  SIN_ORDER,
  aggregate,
  countColor,
  escapeSpreadsheetCell,
  makePersonaMap,
  parsePartySheet,
  parsePassiveRequirements,
  personaKindLabel,
  personaNumberLabel,
  sheetNumber,
  sortParty,
  sortResources,
  totalColors,
} from './core.mjs';
import { escapeHtml } from './security.mjs';
import {
  createManualPersona,
  MAX_LOCAL_PERSONAS,
  discoverLbtAccounts,
  discoverLbtPersonaCandidates,
  importLocalPersonas,
  isPersonaOwnedByLbtAccount,
  loadLocalPersonas,
  sanitizeLocalPersona,
  saveLocalPersonas,
} from './persona-import.mjs';

const DATA_URL = './data/personas.json';
const STORAGE_KEY = 'lbt_party_color_board_v1';
const LBT_ACCOUNT_FILTER_KEY = 'lbt_party_color_board_lbt_account_filter_v1';
const LBT_SHOW_UNOWNED_KEY = 'lbt_party_color_board_show_unowned_v1';
let sharedPersonaPersistenceWarningShown = false;
const PARTY_SORTS = new Set([
  'default', 'no-asc', 'no-desc', 'name', 'hp-desc', 'san-desc', 'speed-desc', 'pattern', 'color',
]);
const RESOURCE_SORTS = new Set(['count-desc', 'count-asc', 'personas-desc', 'sin-order', 'name']);
const SKILL_SORT_SLOTS = new Set(['all', 'S0', 'S1', 'S2', 'S3', 'S4']);
let localOnlyPersistenceWarningShown = false;

const state = {
  data: null,
  personas: [],
  map: new Map(),
  party: [],
  partySort: 'default',
  resourceSort: 'count-desc',
  skillSortSlot: 'all',
  selectedSin: null,
  previousPartySort: 'default',
  pickerIndex: null,
  pendingAdd: false,
  pickerMode: 'all',
  pickerQuery: '',
  lbtAccounts: [],
  selectedLbtAccountId: '',
  showUnownedPersonas: false,
  lbtAccountPreferencesLoaded: false,
  localPersonas: [],
  importCandidates: [],
  modalReturnToPicker: false,
  lastAggregate: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function sanitizePlayerName(value) {
  return String(value ?? '').trim().slice(0, 80);
}

function defaultPlayerName() {
  const accounts = discoverLbtAccounts(browserStorage(), state.data?.personas || []);
  return sanitizePlayerName(
    accounts.find((account) => account.id === state.selectedLbtAccountId)?.playerName,
  );
}

function readStoragePreference(key) {
  try {
    return browserStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStoragePreference(key, value) {
  try {
    browserStorage()?.setItem(key, value);
  } catch {
    // Preferences are optional; the current tab still uses the selected values.
  }
}

function refreshLbtAccountOptions() {
  state.lbtAccounts = discoverLbtAccounts(browserStorage(), state.data?.personas || []);
  if (!state.lbtAccountPreferencesLoaded) {
    state.showUnownedPersonas = readStoragePreference(LBT_SHOW_UNOWNED_KEY) === '1';
    state.lbtAccountPreferencesLoaded = true;
  }

  const preferredId = state.selectedLbtAccountId || readStoragePreference(LBT_ACCOUNT_FILTER_KEY) || '';
  const preferred = state.lbtAccounts.find((account) => account.id === preferredId);
  const active = state.lbtAccounts.find((account) => account.active);
  state.selectedLbtAccountId = (preferred || active || state.lbtAccounts[0])?.id || '';
}

function renderLbtAccountControls() {
  const wrapper = $('#picker-account-controls');
  const select = $('#picker-lbt-account');
  const showUnowned = $('#picker-show-unowned');
  const status = $('#picker-account-status');
  const hasAccounts = state.lbtAccounts.length > 0;
  wrapper.hidden = !hasAccounts;
  if (!hasAccounts) return;

  select.innerHTML = state.lbtAccounts.map((account) => {
    const activeLabel = account.active ? '・LBT側で選択中' : '';
    const label = `${account.name}（所持公式人格${account.ownedCount}件${activeLabel}）`;
    return `<option value="${escapeHtml(account.id)}">${escapeHtml(label)}</option>`;
  }).join('');
  select.value = state.selectedLbtAccountId;
  showUnowned.checked = state.showUnownedPersonas;

  const account = state.lbtAccounts.find((item) => item.id === state.selectedLbtAccountId);
  if (!account) {
    status.textContent = 'LBTのアカウント保存データが見つからないため、全人格を表示しています。';
  } else if (state.showUnownedPersonas) {
    status.textContent = `LBTアカウント「${account.name}」を選択中。未所持人格も表示する設定なので、公式DBの全人格が候補になります。手動作成の創作人格は常に表示されます。`;
  } else {
    status.textContent = `LBTアカウント「${account.name}」の所持人格（公式DBに一致する${account.ownedCount}件）に候補を絞っています。未所持人格を追加する場合は「未所持の人格も表示」をオンにしてください。手動作成の創作人格は常に表示されます。`;
  }
}

function refreshPersonaPool(localPersonas = state.localPersonas) {
  state.localPersonas = Array.isArray(localPersonas) ? localPersonas : [];
  state.personas = [...state.data.personas, ...state.localPersonas];
  state.map = makePersonaMap(state.personas);
}

function localPersonaPickerSignature(persona) {
  const fields = [
    'kind', 'no', 'name', 'hp', 'san', 'speed', 'speedAvg',
    'resSlash', 'resPierce', 'resBlunt', 'keywords', 'affiliation',
    'passiveName', 'passiveCond', 'passiveEffect', 'slots',
    'variantType', 'originType', 'sourceRef', 'sourceAccount',
    'sourceLabel', 'sourceIdentityKey', 'syncRank', 'syncMax', 'lbtPersonaNo',
  ];
  return JSON.stringify(Object.fromEntries(fields.map((field) => [field, persona?.[field] ?? null])));
}

// The LBT account saved build is the source of truth for renamed/synced identities.
// Refresh the board copy before showing the picker so stale imported entries cannot
// shadow newly synchronized skill names, colors, passives, or resistances.
function refreshSelectedLbtPersonaData() {
  const selectedAccount = state.lbtAccounts.find((account) => account.id === state.selectedLbtAccountId);
  if (!selectedAccount || !state.data?.personas) return false;

  let candidates;
  try {
    candidates = discoverLbtPersonaCandidates(
      browserStorage(),
      state.data.personas,
      selectedAccount.id,
    );
  } catch (error) {
    showToast('LBT同期データを更新できませんでした: ' + (error.message || '保存データエラー'));
    return false;
  }
  if (!candidates.length) return false;

  const existingBySource = new Map(state.localPersonas
    .filter((persona) => persona.sourceRef)
    .map((persona) => [persona.sourceRef, persona]));
  const existingByKey = new Map(state.localPersonas.map((persona) => [persona.key, persona]));
  const shared = window.sharedPartySession;
  const sharedReadOnly = Boolean(shared?.isActive && !shared.canEdit());
  const selectedPartyKeys = new Set(state.party.map((entry) => entry.key));
  const toApply = candidates.filter((candidate) => {
    const existing = existingBySource.get(candidate.sourceRef) || existingByKey.get(candidate.key);
    if (sharedReadOnly && existing && selectedPartyKeys.has(existing.key)) return false;
    return !existing || localPersonaPickerSignature(existing) !== localPersonaPickerSignature(candidate);
  });
  if (!toApply.length) return false;

  let applied = null;
  try {
    applied = importLocalPersonas(browserStorage(), toApply);
  } catch (error) {
    // At the library cap, existing synced identities still get refreshed even if
    // there is not enough room to import every newly discovered identity.
    if (error?.code === 'LOCAL_PERSONA_LIMIT') {
      const updatesOnly = toApply.filter((candidate) => existingBySource.has(candidate.sourceRef));
      if (updatesOnly.length) {
        try {
          applied = importLocalPersonas(browserStorage(), updatesOnly);
          showToast('LBT同期人格の既存データを更新しました。追加の人格を自動登録するには追加人格ライブラリの空きを確保してください。');
        } catch (updateError) {
          mergeLocalPersonasInMemory(updatesOnly);
          renderAll();
          showToast('LBT同期人格は現在のタブに反映しましたが、ブラウザへ保存できませんでした。');
          if (shared?.isActive) shared.onPartyChanged();
          return true;
        }
      } else {
        showToast(`追加人格ライブラリが最大${MAX_LOCAL_PERSONAS}件のため、新しい同期人格を自動登録できません。不要な追加人格を整理してください。`);
        return false;
      }
    } else {
      mergeLocalPersonasInMemory(toApply);
      renderAll();
      showToast('LBT同期人格を現在のタブに反映しましたが、ブラウザへ保存できませんでした: ' + (error.message || '保存エラー'));
      if (shared?.isActive) shared.onPartyChanged();
      return true;
    }
  }

  refreshPersonaPool(applied.personas);
  renderAll();
  if (applied.added || applied.updated) {
    showToast(`LBTアカウント「${selectedAccount.name}」の同期人格を最新データに反映しました（新規${applied.added}件・更新${applied.updated}件）。`);
  }
  if (shared?.isActive) shared.onPartyChanged();
  return true;
}

function syncedIdentityKeysForAccount(account) {
  if (!account) return new Set();
  const prefix = `${account.id}:identity:`;
  return new Set(state.localPersonas
    .filter((persona) => persona.variantType === 'sync'
      && persona.sourceRef?.startsWith(prefix)
      && persona.sourceIdentityKey)
    .map((persona) => persona.sourceIdentityKey));
}

function personaSnapshotForShare(persona, playerName = '') {
  if (!persona) return null;
  const assignment = { key: persona.key, playerName: sanitizePlayerName(playerName) };
  if (!persona.localOnly) return { ...assignment, assignmentOnly: true };
  return {
    ...assignment,
    kind: persona.kind,
    variantType: persona.variantType,
    originType: persona.originType,
    sourceLabel: persona.sourceLabel || '追加人格',
    syncRank: persona.syncRank ?? null,
    syncMax: persona.syncMax === true,
    no: persona.no,
    name: persona.name,
    hp: persona.hp,
    san: persona.san,
    speed: persona.speed,
    speedAvg: persona.speedAvg,
    resSlash: persona.resSlash || '—',
    resPierce: persona.resPierce || '—',
    resBlunt: persona.resBlunt || '—',
    keywords: [...(persona.keywords || [])],
    affiliation: persona.affiliation || '',
    passiveName: persona.passiveName || '',
    passiveCond: persona.passiveCond || '',
    passiveEffect: persona.passiveEffect || '',
    slots: (persona.slots || []).map((slot, index) => ({
      rank: `S${index}`,
      name: slot.name || '',
      type: slot.type || '',
      colors: [...(slot.colors || [])],
    })),
  };
}

function getShareablePartyPersonas() {
  return state.party
    .map((entry) => personaSnapshotForShare(state.map.get(entry.key), entry.playerName))
    .filter(Boolean);
}

function applySharedPartySnapshot(keys, sharedPersonas = []) {
  const selectedKeys = new Set(Array.isArray(keys) ? keys : []);
  const sharedSnapshots = (Array.isArray(sharedPersonas) ? sharedPersonas : [])
    .filter((persona) => selectedKeys.has(persona?.key));
  const playerNamesByKey = new Map();
  for (const snapshot of sharedSnapshots) {
    if (typeof snapshot?.playerName === 'string' || snapshot?.assignmentOnly === true) {
      playerNamesByKey.set(snapshot.key, sanitizePlayerName(snapshot.playerName));
    }
  }
  const incoming = sharedSnapshots
    .filter((persona) => persona?.assignmentOnly !== true)
    .map(sanitizeLocalPersona)
    .filter(Boolean);
  const byKey = new Map(state.localPersonas.map((persona) => [persona.key, persona]));
  for (const persona of incoming) byKey.set(persona.key, persona);
  const nextLocal = [...byKey.values()];
  try {
    state.localPersonas = saveLocalPersonas(browserStorage(), nextLocal);
    sharedPersonaPersistenceWarningShown = false;
  } catch (error) {
    // Keep a validated remote copy in memory when local storage is blocked or full.
    state.localPersonas = nextLocal;
    if (incoming.length && !sharedPersonaPersistenceWarningShown) {
      showToast('共有の追加人格をブラウザに保存できませんでした。現在のタブでは使えますが、個人編成で継続利用するには追加人格の件数上限・保存容量を確認してから再度共有編成を開いてください。');
      sharedPersonaPersistenceWarningShown = true;
    }
  }
  refreshPersonaPool(state.localPersonas);
  state.party = (sanitizeParty(keys) || []).map((entry) => ({
    ...entry,
    playerName: playerNamesByKey.has(entry.key)
      ? playerNamesByKey.get(entry.key)
      : sanitizePlayerName(entry.playerName),
  }));
  const missing = (Array.isArray(keys) ? keys : []).filter((entry) => !state.map.has(typeof entry === 'string' ? entry : entry?.key));
  if (missing.length) {
    showToast('共有編成に必要な追加人格データが不足しています。共有元で再保存してください。');
  }
  renderAll();
}

function currentPartySnapshotSize() {
  const serialized = JSON.stringify(getShareablePartyPersonas());
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(serialized).length;
  return serialized.length * 3;
}

function canShareCurrentParty() {
  return currentPartySnapshotSize() <= 48_000
    ? true
    : '同期・創作人格の共有データが大きすぎます。不要な人格やキーワードを整理してから共有してください。';
}

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readUrlKeys() {
  const params = new URLSearchParams(location.search);
  if (!params.has('p')) return null;
  return params.get('p').split(',').map((key) => key.trim()).filter(Boolean);
}

function readUrlPlayerNames() {
  const params = new URLSearchParams(location.search);
  try {
    const parsed = JSON.parse(params.get('pl') || '[]');
    if (!Array.isArray(parsed)) return new Map();
    return new Map(parsed.slice(0, MAX_PARTY)
      .filter((item) => Array.isArray(item) && typeof item[0] === 'string')
      .map(([key, name]) => [key, sanitizePlayerName(name)]));
  } catch {
    return new Map();
  }
}

function sanitizeParty(entries) {
  if (!Array.isArray(entries)) return null;
  const seen = new Set();
  const party = [];
  for (const entry of entries) {
    const key = typeof entry === 'string' ? entry : entry?.key;
    if (typeof key !== 'string' || !state.map.has(key) || seen.has(key)) continue;
    seen.add(key);
    party.push({
      key,
      playerName: sanitizePlayerName(typeof entry === 'string' ? '' : entry?.playerName),
    });
    if (party.length >= MAX_PARTY) break;
  }
  return party;
}

function defaultParty() {
  // A new or reset board intentionally starts with no selected identities.
  return [];
}

function saveState() {
  const sharedController = window.sharedPartySession;
  const savedParty = sharedController?.isActive && Array.isArray(sharedController.personalPartySnapshot)
    ? sharedController.personalPartySnapshot
    : state.party;
  const payload = {
    party: savedParty.map((entry) => (typeof entry === 'string'
      ? { key: entry, playerName: '' }
      : { key: entry.key, playerName: sanitizePlayerName(entry.playerName) })),
    partySort: state.partySort,
    resourceSort: state.resourceSort,
    skillSortSlot: state.skillSortSlot,
  };
  let storageSaved = false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    storageSaved = true;
  } catch {
    // Storage can be unavailable in private windows.
  }
  const hasLocalOnlySnapshot = savedParty.some((entry) => {
    const key = typeof entry === 'string' ? entry : entry?.key;
    return Boolean(state.map.get(key)?.localOnly);
  });
  if (storageSaved) {
    localOnlyPersistenceWarningShown = false;
  } else if (hasLocalOnlySnapshot && !localOnlyPersistenceWarningShown) {
    showToast('ブラウザに編成を保存できませんでした。追加人格を含む編成はURLに退避できないため、保存が復旧するまで再読み込みやタブを閉じると編成が失われます。');
    localOnlyPersistenceWarningShown = true;
  }
  if (sharedController?.isActive) {
    const params = new URLSearchParams(location.search);
    params.delete('p');
    params.delete('pl');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + '#session=' + encodeURIComponent(sharedController.sessionId));
    sharedController.onPartyChanged();
    return;
  }
  try {
    const params = new URLSearchParams(location.search);
    const containsLocalOnlyPersona = state.party.some((entry) => state.map.get(entry.key)?.localOnly);
    // Local persona keys reference data stored only in this browser profile. Do not
    // emit a URL that looks shareable but cannot reconstruct the custom persona elsewhere.
    if (state.party.length > 0 && !containsLocalOnlyPersona) {
      params.set('p', state.party.map((entry) => entry.key).join(','));
      const namedEntries = state.party
        .filter((entry) => sanitizePlayerName(entry.playerName))
        .map((entry) => [entry.key, sanitizePlayerName(entry.playerName)]);
      if (namedEntries.length) params.set('pl', JSON.stringify(namedEntries));
      else params.delete('pl');
    } else {
      params.delete('p');
      params.delete('pl');
    }
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  } catch {
    // file:// preview may reject replaceState; editing still works in memory.
  }
}

function init(data) {
  state.data = data;
  state.localPersonas = loadLocalPersonas(browserStorage());
  refreshLbtAccountOptions();
  state.personas = [...data.personas, ...state.localPersonas];
  state.map = makePersonaMap(state.personas);

  const stored = readStored();
  const urlKeys = readUrlKeys();
  const fromUrl = urlKeys === null ? null : sanitizeParty(urlKeys);
  const fromStore = stored && Array.isArray(stored.party) ? sanitizeParty(stored.party) : null;
  const storedKeys = Array.isArray(stored?.party)
    ? stored.party.map((entry) => typeof entry === 'string' ? entry : entry?.key)
    : null;
  // The previous release automatically saved this four-person sample party. Migrate
  // only that exact legacy default to empty; retain any party a user actually chose.
  const isLegacySample = JSON.stringify(storedKeys) === JSON.stringify(['n48', 'n34', 'n78', 'n49']);

  let party = null;
  if (fromUrl !== null && (fromUrl.length > 0 || urlKeys.length === 0)) {
    party = fromUrl;
  } else if (isLegacySample) {
    party = [];
  } else {
    party = fromStore;
  }
  if (party === null) party = defaultParty();
  const urlPlayerNames = readUrlPlayerNames();
  state.party = party.slice(0, MAX_PARTY).map((entry) => (
    urlPlayerNames.has(entry.key)
      ? { ...entry, playerName: urlPlayerNames.get(entry.key) }
      : entry
  ));

  if (stored && PARTY_SORTS.has(stored.partySort)) state.partySort = stored.partySort;
  if (stored && RESOURCE_SORTS.has(stored.resourceSort)) state.resourceSort = stored.resourceSort;
  if (stored && SKILL_SORT_SLOTS.has(stored.skillSortSlot)) state.skillSortSlot = stored.skillSortSlot;
  state.previousPartySort = state.partySort === 'color' ? 'default' : state.partySort;

  bindEvents();
  renderAll();
}

function bindEvents() {
  $('#party-sort').addEventListener('change', (event) => {
    state.partySort = event.target.value;
    saveState();
    renderAll();
  });
  $('#resource-sort').addEventListener('change', (event) => {
    state.resourceSort = event.target.value;
    saveState();
    renderAll();
  });
  $('#skill-sort-slot').addEventListener('change', (event) => {
    state.skillSortSlot = SKILL_SORT_SLOTS.has(event.target.value) ? event.target.value : 'all';
    if (state.selectedSin) state.partySort = 'color';
    saveState();
    renderAll();
  });
  $('#add-member').addEventListener('click', () => openPicker(null));
  $('#import-tsv').addEventListener('click', openImport);
  $('#copy-tsv').addEventListener('click', copyTsv);
  $('#party-cards').addEventListener('change', (event) => {
    const input = event.target.closest('[data-player-name-index]');
    if (!input) return;
    const index = Number(input.dataset.playerNameIndex);
    const entry = state.party[index];
    if (!entry) return;
    if (!canEditParty()) {
      input.value = sanitizePlayerName(entry.playerName);
      showToast('このセッションは閲覧のみです。');
      return;
    }
    entry.playerName = sanitizePlayerName(input.value);
    saveState();
    renderMatrix();
    showToast('担当PL名を保存しました。');
  });
  $('#reset-party').addEventListener('click', resetParty);
  $('#import-apply').addEventListener('click', applyImport);
  $('#open-lbt-persona-import').addEventListener('click', openLbtPersonaImport);
  $('#apply-lbt-import').addEventListener('click', applyLbtPersonaImport);
  $('#cancel-lbt-import').addEventListener('click', closeLbtPersonaImport);
  $('#dismiss-lbt-import').addEventListener('click', closeLbtPersonaImport);
  $('#open-manual-persona').addEventListener('click', openManualPersonaDialog);
  $('#save-manual-persona').addEventListener('click', saveManualPersonaFromDialog);
  $('#cancel-manual-persona').addEventListener('click', closeManualPersonaDialog);
  $('#dismiss-manual-persona').addEventListener('click', closeManualPersonaDialog);
  $('#import-text').addEventListener('input', () => {
    const error = $('#import-error');
    error.hidden = true;
    error.textContent = '';
  });
  $('#picker-search').addEventListener('input', (event) => {
    state.pickerQuery = event.target.value;
    renderPickerList();
  });

  $('#picker-lbt-account').addEventListener('change', (event) => {
    const nextId = event.target.value;
    if (!state.lbtAccounts.some((account) => account.id === nextId)) return;
    state.selectedLbtAccountId = nextId;
    writeStoragePreference(LBT_ACCOUNT_FILTER_KEY, nextId);
    refreshSelectedLbtPersonaData();
    renderLbtAccountControls();
    renderPickerList();
  });
  $('#picker-show-unowned').addEventListener('change', (event) => {
    state.showUnownedPersonas = event.target.checked;
    writeStoragePreference(LBT_SHOW_UNOWNED_KEY, state.showUnownedPersonas ? '1' : '0');
    renderLbtAccountControls();
    renderPickerList();
  });

  document.addEventListener('click', handleClick);
  for (const dialog of $$('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      if (dialog.id === 'lbt-import-dialog') closeLbtPersonaImport();
      else if (dialog.id === 'manual-persona-dialog') closeManualPersonaDialog();
      else dialog.close();
    });
    dialog.addEventListener('cancel', (event) => {
      if (dialog.id === 'lbt-import-dialog') {
        event.preventDefault();
        closeLbtPersonaImport();
      } else if (dialog.id === 'manual-persona-dialog') {
        event.preventDefault();
        closeManualPersonaDialog();
      }
    });
  }
}

function handleClick(event) {
  const action = event.target.closest('[data-action]');
  if (action) {
    switch (action.dataset.action) {
      case 'select-sin':
        toggleSin(action.dataset.sin);
        break;
      case 'edit-member':
        openPicker(Number(action.dataset.index));
        break;
      case 'remove-member':
        removeMember(Number(action.dataset.index));
        break;
      case 'pick-persona':
        choosePersona(action.dataset.key);
        break;
      case 'delete-local-persona':
        deleteLocalPersona(action.dataset.key);
        break;
      default:
        break;
    }
    return;
  }

  const mode = event.target.closest('[data-picker-mode]');
  if (mode) {
    state.pickerMode = mode.dataset.pickerMode;
    syncPickerMode();
    renderPickerList();
    return;
  }

  const close = event.target.closest('[data-close-dialog]');
  if (close) {
    $(`#${close.dataset.closeDialog}`)?.close();
  }
}

function renderAll() {
  if (!state.data) return;
  state.lastAggregate = aggregate(state.party, state.map);
  renderMeta();
  renderResources();
  renderMatrix();
  renderParty();
  syncControls();
  if ($('#picker').open) renderPickerList();
}

function canEditParty() {
  return window.sharedPartySession?.canEdit?.() ?? true;
}

function renderMeta() {
  const meta = state.data.meta;
  const result = state.lastAggregate;
  const localCount = state.localPersonas.length;
  $('#source-meta').textContent = `${meta.sourceVersion} / 通常${meta.normalCount} + 特異${meta.tokuiCount}${localCount ? ` / 追加人格${localCount}` : ''}`;
  $('#version-label').textContent = meta.sourceVersion;
  $('#resource-total').textContent = `合計 ${result.grandTotal}`;
  $('#party-count').textContent = `${state.party.length}名`;
  $('#party-count-2').textContent = `${state.party.length}名`;
  const canEdit = canEditParty();
  $('#add-member').disabled = state.party.length >= MAX_PARTY || !canEdit;
  $('#import-tsv').disabled = !canEdit;
  $('#reset-party').disabled = !canEdit;
  $('#import-apply').disabled = !canEdit;

  const selected = $('#selected-sin-label');
  if (state.selectedSin) {
    const color = SIN_META[state.selectedSin].color;
    selected.hidden = false;
    selected.textContent = `選択色: ${state.selectedSin}`;
    selected.style.borderColor = color;
    selected.style.color = color;
  } else {
    selected.hidden = true;
    selected.textContent = '';
    selected.style.borderColor = '';
    selected.style.color = '';
  }
}

function renderResources() {
  const result = state.lastAggregate;
  const list = sortResources(result.totals, result.personaCounts, state.resourceSort);
  const max = Math.max(1, ...list.map((item) => item.total));
  $('#resource-cards').innerHTML = list.map((item) => {
    const selected = state.selectedSin === item.sin;
    const width = Math.round((item.total / max) * 100);
    return `
      <button type="button" class="resource-card" data-action="select-sin" data-sin="${escapeHtml(item.sin)}"
        style="--sin:${item.color}" aria-pressed="${selected}"
        aria-label="${escapeHtml(item.sin)} 資源${item.total} 出せる人格${item.personas}人${selected ? ' 選択中' : ''}"
        title="${selected ? 'もう一度押すと選択解除' : 'この色を出せる人格を上に並べる'}">
        <span class="resource-name">${escapeHtml(item.sin)}</span>
        <span class="resource-count">${item.total}</span>
        <span class="resource-personas">${item.personas}人</span>
        <span class="resource-bar" aria-hidden="true"><i style="width:${width}%"></i></span>
      </button>
    `;
  }).join('');
}

function selectedClass(sin) {
  return state.selectedSin === sin ? ' is-selected' : '';
}

function selectedStyle(sin) {
  return `--sin:${SIN_META[sin].color}`;
}

function renderPassiveCondition(condition) {
  const source = String(condition || '—');
  const requirements = parsePassiveRequirements(source);
  if (requirements.length === 0) return escapeHtml(source);

  let output = '';
  let cursor = 0;
  for (const requirement of requirements) {
    output += escapeHtml(source.slice(cursor, requirement.start));
    output += `<span class="passive-sin" style="--sin:${SIN_META[requirement.sin].color}" title="必要な大罪資源">${escapeHtml(requirement.sin)}<b>×${requirement.count}</b></span>`;
    cursor = requirement.start + requirement.length;
  }
  return output + escapeHtml(source.slice(cursor));
}

function renderMatrix() {
  const result = state.lastAggregate;
  const sorted = sortParty(state.party, state.partySort, state.selectedSin, state.map, state.skillSortSlot);

  let head = '<tr><th class="member-head" scope="col">人格</th>';
  for (let index = 0; index < 5; index++) {
    head += `<th scope="col">S${index}</th>`;
  }
  for (const sin of SIN_ORDER) {
    head += `<th scope="col" class="sin-head${selectedClass(sin)}" style="${selectedStyle(sin)}">${escapeHtml(sin)}</th>`;
  }
  head += '<th scope="col">計</th></tr>';
  $('#matrix thead').innerHTML = head;

  let body = '';
  for (const entry of sorted) {
    const persona = state.map.get(entry.key);
    if (!persona) continue;
    const slot = state.party.findIndex((item) => item.key === entry.key) + 1;
    body += '<tr>';
    body += `<th scope="row" class="member"><span class="member-label">${escapeHtml(entry.playerName || 'PL未設定')}</span><span class="member-name" title="${escapeHtml(persona.name)}">${escapeHtml(persona.name)}<span class="member-kind">${personaKindLabel(persona)}</span></span></th>`;
    for (const skillSlot of persona.slots) {
      const chips = skillSlot.colors.map((sin) => (
        `<span class="slot-chip" style="--sin:${SIN_META[sin].color}">${escapeHtml(sin)}</span>`
      )).join('');
      body += `<td class="slot-cell" title="${escapeHtml(`${skillSlot.rank} ${skillSlot.name} / ${skillSlot.type}`)}"><span class="slot-chips">${chips || '–'}</span></td>`;
    }
    for (const sin of SIN_ORDER) {
      const count = countColor(persona, sin);
      const mix = Math.min(54, 10 + count * 10);
      body += `<td class="count-cell${selectedClass(sin)}" style="${selectedStyle(sin)}" data-sin="${escapeHtml(sin)}"><span class="count-pill${count === 0 ? ' is-zero' : ''}" style="--sin:${SIN_META[sin].color};--mix:${mix}%">${count === 0 ? '–' : count}</span></td>`;
    }
    body += `<td class="total-cell">${totalColors(persona)}</td>`;
    body += '</tr>';
  }
  if (sorted.length === 0) {
    body = '<tr><td colspan="14" class="empty">人格がありません。</td></tr>';
  }
  $('#matrix tbody').innerHTML = body;

  let foot = '<tr><th scope="row">合計</th><td colspan="5"></td>';
  for (const sin of SIN_ORDER) {
    foot += `<td class="${selectedClass(sin).trim()}" style="${selectedStyle(sin)}">${result.totals[sin]}</td>`;
  }
  foot += `<td class="total-cell">${result.grandTotal}</td></tr>`;

  foot += '<tr><th scope="row">人数</th><td colspan="5"></td>';
  for (const sin of SIN_ORDER) {
    foot += `<td class="${selectedClass(sin).trim()}" style="${selectedStyle(sin)}">${result.personaCounts[sin]}人</td>`;
  }
  foot += '<td></td></tr>';
  $('#matrix tfoot').innerHTML = foot;
}

function gradientFor(colors) {
  const palette = colors.map((sin) => SIN_META[sin].color);
  if (palette.length === 0) return 'var(--surface-3)';
  if (palette.length === 1) return palette[0];
  return `linear-gradient(90deg, ${palette.map((color, index) => (
    `${color} ${(index / palette.length) * 100}% ${((index + 1) / palette.length) * 100}%`
  )).join(', ')})`;
}

function renderParty() {
  const sorted = sortParty(state.party, state.partySort, state.selectedSin, state.map, state.skillSortSlot);
  const selectedColor = state.selectedSin ? SIN_META[state.selectedSin].color : 'transparent';
  const cards = [];

  for (const entry of sorted) {
    const persona = state.map.get(entry.key);
    if (!persona) continue;
    const originalIndex = state.party.findIndex((item) => item.key === entry.key);
    const playerName = sanitizePlayerName(entry.playerName);
    const colorCount = state.selectedSin ? countColor(persona, state.selectedSin) : 0;
    const cardClass = [
      'persona-card',
      state.selectedSin && colorCount === 0 ? 'is-dim' : '',
      state.selectedSin && colorCount > 0 ? 'is-hot' : '',
    ].filter(Boolean).join(' ');
    const counts = Object.fromEntries(SIN_ORDER.map((sin) => [sin, countColor(persona, sin)]));
    const resources = [...SIN_ORDER]
      .sort((a, b) => counts[b] - counts[a] || SIN_ORDER.indexOf(a) - SIN_ORDER.indexOf(b));

    const stripLabels = persona.slots.map((skillSlot, index) => (
      `<span title="${escapeHtml(skillSlot.rank)}">${index}</span>`
    )).join('');
    const strip = persona.slots.map((skillSlot) => {
      const sins = skillSlot.colors.length ? skillSlot.colors.join('・') : '罪悪属性なし';
      const label = `${skillSlot.rank} ${skillSlot.name} / ${skillSlot.type} / ${sins}`;
      return `<span style="background:${gradientFor(skillSlot.colors)}" title="${escapeHtml(label)}"></span>`;
    }).join('');

    const slots = persona.slots.map((skillSlot) => {
      const firstColor = skillSlot.colors[0] ? SIN_META[skillSlot.colors[0]].color : 'var(--tx-mute)';
      const sins = skillSlot.colors.map((sin) => (
        `<span class="sin-chip" style="--sin:${SIN_META[sin].color}">${escapeHtml(sin)}</span>`
      )).join('');
      return `
        <div class="slot-row" style="--sin:${firstColor}" title="${escapeHtml(`${skillSlot.name} / ${skillSlot.type}`)}">
          <span class="slot-rank">${escapeHtml(skillSlot.rank)}</span>
          <span class="slot-name">${escapeHtml(skillSlot.name)}</span>
          <span class="slot-sins">${sins || '–'}</span>
        </div>
      `;
    }).join('');

    const keywordTags = persona.keywords.length > 0
      ? persona.keywords.map((keyword) => `<span class="keyword">${escapeHtml(keyword)}</span>`).join('')
      : '<span class="keyword">キーワードなし</span>';

    const resourceChips = resources.map((sin) => (
      `<span class="res-chip${counts[sin] === 0 ? ' is-zero' : ''}" style="--sin:${SIN_META[sin].color}"><i aria-hidden="true"></i>${escapeHtml(sin)}×${counts[sin]}</span>`
    )).join('');

    cards.push(`
      <article class="${cardClass}" data-key="${escapeHtml(persona.key)}" style="--selected-sin-color:${selectedColor}">
        <div class="color-strip-wrap">
          <div class="color-strip-indexes" aria-hidden="true">${stripLabels}</div>
          <div class="color-strip" role="img" aria-label="色帯上の数字0〜4は、左からS0〜S4の罪悪属性を示します">${strip}</div>
        </div>
        <div class="card-head">
          <div class="card-id">
            <label class="card-player-field">
              <span>PL名</span>
              <input class="card-player-input" type="text" maxlength="80"
                data-player-name-index="${originalIndex}" value="${escapeHtml(playerName)}"
                placeholder="PL名を入力" aria-label="${escapeHtml(persona.name)}の担当PL名" ${canEditParty() ? '' : 'disabled'}>
            </label>
            <span class="kind-badge">${personaKindLabel(persona)}</span>
            <span class="card-no">${escapeHtml(personaNumberLabel(persona))}</span>
          </div>
          <div class="card-actions">
            <button type="button" class="mini-btn" data-action="edit-member" data-index="${originalIndex}" ${canEditParty() ? "" : "disabled"}>変更</button>
            <button type="button" class="icon-btn" data-action="remove-member" data-index="${originalIndex}" aria-label="${escapeHtml(persona.name)}を編成から外す" ${canEditParty() ? "" : "disabled"}>×</button>
          </div>
        </div>
        <div class="card-title">
          <div>
            <h3 class="persona-name">${escapeHtml(persona.name)}</h3>
            <div class="keyword-row">${keywordTags}</div>
          </div>
        </div>
        <dl class="stats">
          <div><dt>速度</dt><dd>${escapeHtml(persona.speed || '—')}</dd></div>
          <div><dt>斬撃耐性</dt><dd>${escapeHtml(persona.resSlash || '—')}</dd></div>
          <div><dt>貫通耐性</dt><dd>${escapeHtml(persona.resPierce || '—')}</dd></div>
          <div><dt>打撃耐性</dt><dd>${escapeHtml(persona.resBlunt || '—')}</dd></div>
        </dl>
        <p class="passive"><b>パッシブ</b> <span class="passive-conditions">${renderPassiveCondition(persona.passiveCond || '—')}</span>${persona.passiveName ? ` / ${escapeHtml(persona.passiveName)}` : ''}</p>
        <div class="slot-list">${slots}</div>
        <div class="card-resources" aria-label="大罪資源内訳">${resourceChips}</div>
      </article>
    `);
  }

  $('#party-cards').innerHTML = cards.join('');
  $('#empty-state').hidden = cards.length > 0;
}

function syncControls() {
  $('#party-sort').value = state.partySort;
  $('#resource-sort').value = state.resourceSort;
  $('#skill-sort-slot').value = state.skillSortSlot;
  syncPickerMode();
}

function syncPickerMode() {
  for (const button of $$('[data-picker-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.pickerMode === state.pickerMode));
  }
}

function toggleSin(sin) {
  if (state.selectedSin === sin) {
    state.selectedSin = null;
    state.partySort = state.previousPartySort || 'default';
  } else {
    if (state.partySort !== 'color') state.previousPartySort = state.partySort;
    state.selectedSin = sin;
    state.partySort = 'color';
  }
  saveState();
  renderAll();
}

function openPicker(index) {
  if (!canEditParty()) { showToast('このセッションは閲覧のみです。'); return; }
  if (index === null && state.party.length >= MAX_PARTY) {
    showToast(`編成は最大 ${MAX_PARTY} 名です。`);
    return;
  }
  if (index !== null && !state.party[index]) return;

  state.pickerIndex = index;
  state.pendingAdd = index === null;
  refreshLbtAccountOptions();
  refreshSelectedLbtPersonaData();
  state.pickerQuery = '';
  $('#picker-search').value = '';
  $('#picker-title').textContent = index === null ? '人格を追加' : '人格を変更';
  syncPickerMode();
  renderLbtAccountControls();
  renderPickerList();
  $('#picker').showModal();
  requestAnimationFrame(() => $('#picker-search').focus());
}

function renderLbtImportCandidates() {
  const list = $('#lbt-import-candidates');
  const empty = $('#lbt-import-empty');
  const status = $('#lbt-import-status');
  const candidates = state.importCandidates;
  const sharedActive = Boolean(window.sharedPartySession?.isActive);
  list.innerHTML = candidates.map((persona, index) => {
    const skills = persona.slots
      .filter((slot) => slot.name)
      .map((slot) => `${slot.rank} ${slot.name}${slot.colors.length ? `（${slot.colors.join('・')}）` : ''}`)
      .join(' / ');
    const typeLabel = persona.variantType === 'sync' ? '同期データ' : 'オリジナル人格';
    return `
      <label class="lbt-import-option">
        <input type="checkbox" data-lbt-import-index="${index}" checked>
        <span class="lbt-import-option-copy">
          <span class="lbt-import-option-title">
            <span>${escapeHtml(persona.name)}</span>
            <span class="persona-source-badge">${escapeHtml(typeLabel)}</span>
          </span>
          <span class="lbt-import-option-meta">${escapeHtml(persona.sourceAccount || 'LBT保存データ')} · ${escapeHtml(persona.sourceLabel || typeLabel)} · 速度 ${escapeHtml(persona.speed || '—')} · 斬撃 ${escapeHtml(persona.resSlash || '—')} / 貫通 ${escapeHtml(persona.resPierce || '—')} / 打撃 ${escapeHtml(persona.resBlunt || '—')}</span>
          <span class="lbt-import-option-skills">${escapeHtml(skills || 'スキル・罪悪属性は未登録')}</span>
        </span>
      </label>
    `;
  }).join('');
  empty.hidden = candidates.length > 0;
  const selectedAccount = state.lbtAccounts.find((account) => account.id === state.selectedLbtAccountId);
  const scopeLabel = selectedAccount ? `アカウント「${selectedAccount.name}」の保存データから` : 'LBT保存データから';
  status.textContent = candidates.length
    ? `${scopeLabel}${candidates.length}件の同期・創作人格が見つかりました。チェックした人格だけを追加ライブラリに取り込みます。元のLBT保存データは変更しません。${sharedActive ? ' 共有セッションで編集権限がある場合、取り込んだ人格を編成に追加すると、必要な人格データだけが参加者へ同期されます。LBTの生セーブやアカウント情報は送信しません。' : ' 追加人格を別端末で使う場合は、編成に追加して「共同編集スペース（クラウド保存）」を利用してください。URL共有には含まれません。'}`
    : `${scopeLabel}取り込み対象の同期・創作人格を検出できませんでした。別のアカウントを試すか、人格選択画面の「手動で創作人格を追加」を利用してください。公式DBの人格は、所持絞り込みの設定に応じて通常の選択候補に表示されます。`;
  $('#apply-lbt-import').disabled = candidates.length === 0;
}

function reopenPickerAfterLocalDialog(mode = null) {
  const shouldReopen = state.modalReturnToPicker;
  const index = state.pickerIndex;
  state.modalReturnToPicker = false;
  if (!shouldReopen) return;
  if (mode) state.pickerMode = mode;
  requestAnimationFrame(() => {
    openPicker(index);
    if (mode) {
      state.pickerMode = mode;
      syncPickerMode();
      renderPickerList();
    }
  });
}

function openLbtPersonaImport() {
  state.modalReturnToPicker = true;
  state.pickerQuery = '';
  $('#picker-search').value = '';
  $('#picker').close();
  refreshLbtAccountOptions();
  try {
    state.importCandidates = discoverLbtPersonaCandidates(
      browserStorage(),
      state.data.personas,
      state.lbtAccounts.length ? state.selectedLbtAccountId : null,
    );
  } catch (error) {
    state.importCandidates = [];
    showToast('LBT保存データを読み取れませんでした: ' + (error.message || '保存データエラー'));
  }
  renderLbtImportCandidates();
  $('#lbt-import-dialog').showModal();
}

function closeLbtPersonaImport() {
  if ($('#lbt-import-dialog').open) $('#lbt-import-dialog').close();
  state.importCandidates = [];
  reopenPickerAfterLocalDialog();
}

function mergeLocalPersonasInMemory(candidates) {
  const byKey = new Map(state.localPersonas.map((persona) => [persona.key, persona]));
  const bySource = new Map(state.localPersonas.filter((persona) => persona.sourceRef).map((persona) => [persona.sourceRef, persona]));
  for (const persona of candidates) {
    if (!persona?.key || !persona?.name) continue;
    const previous = bySource.get(persona.sourceRef) || byKey.get(persona.key);
    const next = { ...persona, key: previous?.key || persona.key };
    byKey.set(next.key, next);
    if (next.sourceRef) bySource.set(next.sourceRef, next);
  }
  refreshPersonaPool([...byKey.values()]);
}

function applyLbtPersonaImport() {
  const indexes = Array.from(document.querySelectorAll('#lbt-import-candidates [data-lbt-import-index]'))
    .filter((input) => input.checked)
    .map((input) => Number(input.dataset.lbtImportIndex));
  const selected = indexes.map((index) => state.importCandidates[index]).filter(Boolean);
  if (!selected.length) {
    $('#lbt-import-status').textContent = '取り込む人格にチェックを入れてください。';
    return;
  }

  const sharedSession = window.sharedPartySession;
  if (sharedSession?.isActive && !sharedSession.canEdit()) {
    const selectedPartyKeys = new Set(state.party.map((entry) => entry.key));
    const wouldChangeSharedIdentity = selected.some((candidate) => {
      const existing = state.localPersonas.find((persona) => (
        candidate.sourceRef && persona.sourceRef === candidate.sourceRef
      )) || state.localPersonas.find((persona) => persona.key === candidate.key);
      return existing && selectedPartyKeys.has(existing.key);
    });
    if (wouldChangeSharedIdentity) {
      $('#lbt-import-status').textContent =
        '閲覧中の共有編成で使用している人格は更新できません。共有編成を閉じてから再取り込みしてください。';
      return;
    }
  }

  try {
    const result = importLocalPersonas(browserStorage(), selected);
    refreshPersonaPool(result.personas);
    showToast(`LBT人格を${result.added}件追加、${result.updated}件更新しました。`);
  } catch (error) {
    if (error?.code === 'LOCAL_PERSONA_LIMIT') {
      $('#lbt-import-status').textContent = error.message;
      return;
    }
    mergeLocalPersonasInMemory(selected);
    showToast('今回の追加データをメモリ上に読み込みました。永続保存はできませんでした: ' + (error.message || '保存エラー'));
  }
  renderAll();
  // Importing an update to an identity currently selected in an editable shared
  // party changes its snapshot too; start the normal optimistic save path.
  if (sharedSession?.isActive) sharedSession.onPartyChanged();
  if ($('#lbt-import-dialog').open) $('#lbt-import-dialog').close();
  state.importCandidates = [];
  reopenPickerAfterLocalDialog('local');
}

function renderManualSkillFields() {
  const options = ['<option value="">なし</option>', ...SIN_ORDER.map((sin) => `<option value="${sin}">${sin}</option>`)].join('');
  $('#manual-skill-fields').innerHTML = Array.from({ length: 5 }, (_, index) => `
    <div class="manual-skill-row">
      <span class="manual-skill-rank">S${index}</span>
      <label class="manual-skill-field manual-skill-field-name" for="manual-skill-name-${index}">スキル名
        <input class="input" id="manual-skill-name-${index}" maxlength="120" placeholder="スキル${index}">
      </label>
      <label class="manual-skill-field manual-skill-field-type" for="manual-skill-type-${index}">種別
        <input class="input" id="manual-skill-type-${index}" maxlength="80" placeholder="斬撃・貫通など">
      </label>
      <label class="manual-skill-field" for="manual-skill-color-a-${index}">罪悪属性1
        <select id="manual-skill-color-a-${index}">${options}</select>
      </label>
      <label class="manual-skill-field" for="manual-skill-color-b-${index}">属性2（任意）
        <select id="manual-skill-color-b-${index}">${options}</select>
      </label>
    </div>
  `).join('');
}

function resetManualPersonaForm() {
  $('#manual-persona-error').hidden = true;
  $('#manual-persona-error').textContent = '';
  $('#manual-persona-name').value = '';
  $('#manual-persona-hp').value = '100';
  $('#manual-persona-san').value = '45';
  $('#manual-persona-speed').value = '1d5';
  $('#manual-persona-affiliation').value = '';
  $('#manual-persona-keywords').value = '';
  $('#manual-persona-passive-name').value = '';
  $('#manual-persona-passive-cond').value = '';
  renderManualSkillFields();
}

function openManualPersonaDialog() {
  state.modalReturnToPicker = true;
  state.pickerQuery = '';
  $('#picker-search').value = '';
  $('#picker').close();
  resetManualPersonaForm();
  $('#manual-persona-dialog').showModal();
  requestAnimationFrame(() => $('#manual-persona-name').focus());
}

function closeManualPersonaDialog() {
  if ($('#manual-persona-dialog').open) $('#manual-persona-dialog').close();
  reopenPickerAfterLocalDialog();
}

function saveManualPersonaFromDialog() {
  const error = $('#manual-persona-error');
  error.hidden = true;
  let persona;
  try {
    const slots = Array.from({ length: 5 }, (_, index) => ({
      name: $(`#manual-skill-name-${index}`).value,
      type: $(`#manual-skill-type-${index}`).value,
      colors: [
        $(`#manual-skill-color-a-${index}`).value,
        $(`#manual-skill-color-b-${index}`).value,
      ].filter(Boolean),
    }));
    persona = createManualPersona({
      name: $('#manual-persona-name').value,
      hp: $('#manual-persona-hp').value,
      san: $('#manual-persona-san').value,
      speed: $('#manual-persona-speed').value,
      affiliation: $('#manual-persona-affiliation').value,
      keywords: $('#manual-persona-keywords').value,
      passiveName: $('#manual-persona-passive-name').value,
      passiveCond: $('#manual-persona-passive-cond').value,
      slots,
    });
  } catch (failure) {
    error.textContent = failure.message || '人格を作成できませんでした。';
    error.hidden = false;
    return;
  }

  try {
    const storage = browserStorage();
    state.localPersonas = saveLocalPersonas(storage, [...loadLocalPersonas(storage), persona]);
  } catch (failure) {
    if (failure?.code === 'LOCAL_PERSONA_LIMIT') {
      error.textContent = failure.message;
      error.hidden = false;
      return;
    }
    state.localPersonas = [...state.localPersonas.filter((item) => item.key !== persona.key), persona];
    showToast('人格を一時追加しましたが、ブラウザへ永続保存できませんでした。');
  }
  refreshPersonaPool(state.localPersonas);
  renderAll();
  if ($('#manual-persona-dialog').open) $('#manual-persona-dialog').close();
  reopenPickerAfterLocalDialog('local');
  showToast(`創作人格「${persona.name}」を追加しました。`);
}

function renderPickerList() {
  const query = state.pickerQuery.trim().normalize('NFKC').toLowerCase();
  const selectedKeys = new Set(state.party.map((entry) => entry.key));
  const currentKey = state.pickerIndex !== null ? state.party[state.pickerIndex]?.key : null;
  const selectedAccount = state.lbtAccounts.find((account) => account.id === state.selectedLbtAccountId) || null;
  const ownedOnly = Boolean(selectedAccount && !state.showUnownedPersonas);
  const syncedIdentityKeys = syncedIdentityKeysForAccount(selectedAccount);

  const results = state.personas.filter((persona) => {
    if (!persona.localOnly) {
      const identityKey = `${persona.kind === 'tokui' ? 't' : 'n'}:${persona.no}`;
      if (syncedIdentityKeys.has(identityKey)) return false;
    }
    if (ownedOnly && !isPersonaOwnedByLbtAccount(persona, selectedAccount)) return false;
    if (state.pickerMode === 'local' && !persona.localOnly) return false;
    if (state.pickerMode !== 'all' && state.pickerMode !== 'local' && persona.kind !== state.pickerMode) return false;
    if (!query) return true;
    const haystack = [
      persona.name,
      persona.no,
      persona.key,
      personaNumberLabel(persona),
      persona.keywords.join(' '),
      persona.affiliation,
      persona.sourceLabel,
      persona.sourceAccount,
    ].join(' ').normalize('NFKC').toLowerCase();
    return haystack.includes(query);
  });

  $('#picker-list').innerHTML = results.map((persona) => {
    const alreadySelected = selectedKeys.has(persona.key) && persona.key !== currentKey;
    const disabled = alreadySelected;
    const colors = [...new Set(persona.slots.flatMap((slot) => slot.colors))];
    const keywords = persona.keywords.length > 0 ? persona.keywords.join('・') : (persona.affiliation || '—');
    const stateLabel = alreadySelected ? '編成済み' : '';
    const sourceBadge = persona.localOnly
      ? `<span class="persona-source-badge">${escapeHtml(persona.sourceLabel || personaKindLabel(persona))}</span>`
      : '';
    const pickerButton = `
      <button type="button" class="picker-item" data-action="pick-persona" data-key="${escapeHtml(persona.key)}"
        ${disabled ? 'disabled' : ''} aria-label="${escapeHtml(`${personaNumberLabel(persona)} ${persona.name}${stateLabel ? ` ${stateLabel}` : ''}`)}">
        <span class="picker-main">
          <span class="picker-line">
            <span class="picker-no">${escapeHtml(personaNumberLabel(persona))}</span>
            <span class="picker-name">${escapeHtml(persona.name)}</span>
            ${sourceBadge}
            ${stateLabel ? `<span class="picker-state">${escapeHtml(stateLabel)}</span>` : ''}
          </span>
          <span class="picker-keywords">${escapeHtml(keywords)}</span>
          ${persona.localOnly && persona.sourceAccount ? `<span class="lbt-import-option-meta">保存元：${escapeHtml(persona.sourceAccount)}</span>` : ''}
        </span>
        <span class="picker-colors" aria-hidden="true">${colors.map((sin) => (
          `<span class="picker-dot" style="--sin:${SIN_META[sin].color}" title="${escapeHtml(sin)}"></span>`
        )).join('')}</span>
      </button>`;
    return persona.localOnly
      ? `<div class="picker-item-wrap">${pickerButton}<button type="button" class="icon-btn picker-delete-local" data-action="delete-local-persona" data-key="${escapeHtml(persona.key)}" aria-label="${escapeHtml(persona.name)}を追加人格ライブラリから削除" title="追加人格から削除">×</button></div>`
      : pickerButton;
  }).join('');

  $('#picker-empty').hidden = results.length > 0;
  $('#picker-empty').textContent = ownedOnly
    ? '選択中のLBTアカウントの所持人格候補がありません。未所持人格も表示する場合は、上のチェックを入れてください。'
    : '該当する人格がありません。';
}

function deleteLocalPersona(key) {
  const persona = state.localPersonas.find((item) => item.key === key);
  if (!persona) return;
  if (state.party.some((entry) => entry.key === key)) {
    showToast('現在の編成で使用中です。先に編成から外してください。');
    return;
  }
  const savedPersonalKeys = window.sharedPartySession?.isActive
    ? window.sharedPartySession.personalPartySnapshot
    : null;
  const storedParty = readStored()?.party;
  const persistedPartyKeys = Array.isArray(storedParty)
    ? storedParty.map((entry) => typeof entry === 'string' ? entry : entry?.key)
    : [];
  if ((Array.isArray(savedPersonalKeys) && savedPersonalKeys.some((entry) => (
    (typeof entry === 'string' ? entry : entry?.key) === key
  ))) || persistedPartyKeys.includes(key)) {
    showToast('保存済みの個人編成で使用中の人格です。個人編成から外してから削除してください。');
    return;
  }
  if (!window.confirm(`「${persona.name}」をこのブラウザの追加人格ライブラリから削除しますか？`)) return;
  const next = state.localPersonas.filter((item) => item.key !== key);
  try {
    state.localPersonas = saveLocalPersonas(browserStorage(), next);
  } catch (error) {
    showToast('追加人格を削除できませんでした: ' + (error.message || '保存エラー'));
    return;
  }
  refreshPersonaPool(state.localPersonas);
  renderAll();
  renderPickerList();
  showToast(`「${persona.name}」を追加人格ライブラリから削除しました。`);
}

function choosePersona(key) {
  if (!canEditParty()) { showToast('このセッションは閲覧のみです。'); return; }
  const persona = state.map.get(key);
  if (!persona) return;
  const existingIndex = state.party.findIndex((entry) => entry.key === key);
  if (existingIndex >= 0 && existingIndex !== state.pickerIndex) {
    showToast('その人格はすでに編成されています。');
    return;
  }

  if (state.pendingAdd) {
    if (state.party.length >= MAX_PARTY) {
      showToast(`編成は最大 ${MAX_PARTY} 名です。`);
      return;
    }
    state.party.push({ key, playerName: defaultPlayerName() });
  } else if (state.pickerIndex !== null) {
    const previous = state.party[state.pickerIndex];
    state.party[state.pickerIndex] = {
      key,
      playerName: sanitizePlayerName(previous?.playerName) || defaultPlayerName(),
    };
  }

  state.pickerIndex = null;
  state.pendingAdd = false;
  $('#picker').close();
  saveState();
  renderAll();
  const sharedActive = Boolean(window.sharedPartySession?.isActive);
  showToast(persona.localOnly
    ? (sharedActive
      ? `${persona.name} を編成しました。必要な人格データは共有セッションに含めて同期されます。URL共有には含まれません。`
      : `${persona.name} を編成しました。追加人格はこのブラウザに保存されます。URL共有には含まれません。別端末で使う場合は「共同編集スペース（クラウド保存）」を利用してください。`)
    : `${persona.name} を編成しました。`);
}

function removeMember(index) {
  if (!canEditParty()) { showToast('このセッションは閲覧のみです。'); return; }
  if (index < 0 || index >= state.party.length) return;
  const [removed] = state.party.splice(index, 1);
  const persona = removed ? state.map.get(removed.key) : null;
  saveState();
  renderAll();
  showToast(persona ? `${persona.name} を外しました。` : '編成から外しました。');
}

function openImport() {
  $('#import-text').value = '';
  const error = $('#import-error');
  error.hidden = true;
  error.textContent = '';
  $('#import-dialog').showModal();
  requestAnimationFrame(() => $('#import-text').focus());
}

function applyImport() {
  if (!canEditParty()) { showToast('このセッションは閲覧のみです。'); return; }
  const result = parsePartySheet($('#import-text').value, state.personas);
  const error = $('#import-error');
  if (result.errors.length > 0) {
    error.textContent = result.errors.join('\n');
    error.hidden = false;
    return;
  }

  state.party = result.party.map((entry) => ({
    key: entry.key,
    playerName: sanitizePlayerName(entry.playerName),
  }));
  state.selectedSin = null;
  state.partySort = 'default';
  state.previousPartySort = 'default';
  state.skillSortSlot = 'all';
  saveState();
  renderAll();
  $('#import-dialog').close();
  showToast(`${state.party.length}名を取り込みました。`);
}

function resetParty() {
  if (!canEditParty()) { showToast('このセッションは閲覧のみです。'); return; }
  if (!window.confirm('編成を空に戻しますか？')) return;
  state.party = defaultParty();
  state.selectedSin = null;
  state.partySort = 'default';
  state.previousPartySort = 'default';
  state.resourceSort = 'count-desc';
  state.skillSortSlot = 'all';
  saveState();
  renderAll();
  showToast('編成を空にしました。');
}

async function copyTsv() {
  const result = state.lastAggregate;
  const rows = [[
    '枠',
    'PL名',
    '人格キー',
    '人格番号',
    '人格名',
    '種別',
    '保有キーワード',
    'パッシブ条件',
    '戦術0罪悪属性',
    '戦術1罪悪属性',
    '戦術2罪悪属性',
    '戦術3罪悪属性',
    '戦術4罪悪属性',
  ]];

  state.party.forEach((entry, index) => {
    const persona = state.map.get(entry.key);
    if (!persona) return;
    rows.push([
      index + 1,
      sanitizePlayerName(entry.playerName),
      persona.key,
      sheetNumber(persona),
      persona.name,
      personaKindLabel(persona),
      persona.keywords.join('・'),
      persona.passiveCond,
      ...persona.slots.map((slot) => slot.colors.join('/')),
    ]);
  });

  rows.push([]);
  rows.push(['総保有罪悪属性', '数']);
  for (const sin of SIN_ORDER) {
    rows.push([sin, `${result.totals[sin]}(${result.personaCounts[sin]})`]);
  }

  const tsv = rows
    .map((row) => row.map(escapeSpreadsheetCell).join('\t'))
    .join('\n');

  try {
    await copyText(tsv);
    showToast('編成と資源色のTSVをコピーしました。');
  } catch {
    showToast('コピーに失敗しました。ブラウザの権限を確認してください。');
  }
}

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('copy failed');
}

let toastTimer = null;
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2400);
}

async function boot() {
  try {
    const response = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    init(await response.json());
    try {
      const { initializeSharedSessionsUi } = await import('./shared-sessions-ui.mjs');
      await initializeSharedSessionsUi({
        getPartyKeys: () => state.party.map((entry) => entry.key),
        getPartyEntries: () => state.party.map((entry) => ({
          key: entry.key,
          playerName: sanitizePlayerName(entry.playerName),
        })),
        setPartyKeys: (keys, sharedPersonas = []) => applySharedPartySnapshot(keys, sharedPersonas),
        getPartyPersonas: getShareablePartyPersonas,
        renderAll,
        saveState,
        showToast,
        canShareCurrentParty,
      });
    } catch (sharedError) {
      console.error('Shared sessions UI failed to initialize', sharedError);
      const sharedStatus = document.querySelector('#shared-status');
      if (sharedStatus) sharedStatus.textContent = '共有機能の初期化に失敗しました。個人編成はそのまま利用できます。';
    }
  } catch (error) {
    console.error(error);
    $('#source-meta').textContent = 'データ読み込み失敗';
    $('#resource-cards').innerHTML = '<p class="empty">人格データを読み込めませんでした。ローカルで開く場合は <code>node tools/serve.mjs</code> で配信してください。</p>';
  }
}

boot();
