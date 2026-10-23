import {
  MAX_PARTY,
  SIN_META,
  SIN_ORDER,
  aggregate,
  countColor,
  makePersonaMap,
  parsePartySheet,
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
  discoverLbtPersonaCandidates,
  importLocalPersonas,
  loadLocalPersonas,
  saveLocalPersonas,
} from './persona-import.mjs';

const DATA_URL = './data/personas.json';
const STORAGE_KEY = 'lbt_party_color_board_v1';
const PARTY_SORTS = new Set([
  'default', 'no-asc', 'no-desc', 'name', 'hp-desc', 'san-desc', 'speed-desc', 'pattern', 'color',
]);
const RESOURCE_SORTS = new Set(['count-desc', 'count-asc', 'personas-desc', 'sin-order', 'name']);

const state = {
  data: null,
  personas: [],
  map: new Map(),
  party: [],
  partySort: 'default',
  resourceSort: 'count-desc',
  selectedSin: null,
  previousPartySort: 'default',
  pickerIndex: null,
  pendingAdd: false,
  pickerMode: 'all',
  pickerQuery: '',
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

function refreshPersonaPool(localPersonas = state.localPersonas) {
  state.localPersonas = Array.isArray(localPersonas) ? localPersonas : [];
  state.personas = [...state.data.personas, ...state.localPersonas];
  state.map = makePersonaMap(state.personas);
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

function sanitizeParty(entries) {
  if (!Array.isArray(entries)) return null;
  const seen = new Set();
  const party = [];
  for (const entry of entries) {
    const key = typeof entry === 'string' ? entry : entry?.key;
    if (typeof key !== 'string' || !state.map.has(key) || seen.has(key)) continue;
    seen.add(key);
    party.push({ key });
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
    : state.party.map((entry) => entry.key);
  const payload = {
    party: savedParty.map((entry) => typeof entry === 'string' ? entry : entry.key),
    partySort: state.partySort,
    resourceSort: state.resourceSort,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage can be unavailable in private windows; the URL still carries the party.
  }
  if (sharedController?.isActive) {
    const params = new URLSearchParams(location.search);
    params.delete('p');
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
    } else {
      params.delete('p');
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
  state.party = party.slice(0, MAX_PARTY);

  if (stored && PARTY_SORTS.has(stored.partySort)) state.partySort = stored.partySort;
  if (stored && RESOURCE_SORTS.has(stored.resourceSort)) state.resourceSort = stored.resourceSort;
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
  $('#add-member').addEventListener('click', () => openPicker(null));
  $('#import-tsv').addEventListener('click', openImport);
  $('#copy-tsv').addEventListener('click', copyTsv);
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

  document.addEventListener('click', handleClick);
  for (const dialog of $$('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      if (dialog.id === 'lbt-import-dialog') closeLbtPersonaImport();
      else if (dialog.id === 'manual-persona-dialog') closeManualPersonaDialog();
      else dialog.close();
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

function renderMatrix() {
  const result = state.lastAggregate;
  const sorted = sortParty(state.party, state.partySort, state.selectedSin, state.map);

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
    body += `<th scope="row" class="member"><span class="member-label">枠 ${slot}</span><span class="member-name" title="${escapeHtml(persona.name)}">${escapeHtml(persona.name)}<span class="member-kind">${personaKindLabel(persona)}</span></span></th>`;
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
  const sorted = sortParty(state.party, state.partySort, state.selectedSin, state.map);
  const selectedColor = state.selectedSin ? SIN_META[state.selectedSin].color : 'transparent';
  const cards = [];

  for (const entry of sorted) {
    const persona = state.map.get(entry.key);
    if (!persona) continue;
    const originalIndex = state.party.findIndex((item) => item.key === entry.key);
    const slot = originalIndex + 1;
    const colorCount = state.selectedSin ? countColor(persona, state.selectedSin) : 0;
    const cardClass = [
      'persona-card',
      state.selectedSin && colorCount === 0 ? 'is-dim' : '',
      state.selectedSin && colorCount > 0 ? 'is-hot' : '',
    ].filter(Boolean).join(' ');
    const counts = Object.fromEntries(SIN_ORDER.map((sin) => [sin, countColor(persona, sin)]));
    const resources = SIN_ORDER
      .filter((sin) => counts[sin] > 0)
      .sort((a, b) => counts[b] - counts[a] || SIN_ORDER.indexOf(a) - SIN_ORDER.indexOf(b));

    const strip = persona.slots.map((skillSlot) => {
      const sins = skillSlot.colors.length ? skillSlot.colors.join('・') : '罪悪属性なし';
      const label = `${skillSlot.rank} ${skillSlot.name} / ${skillSlot.type} / ${sins}`;
      return `<span class="color-strip-slot" style="background:${gradientFor(skillSlot.colors)}" title="${escapeHtml(label)}"><b>${escapeHtml(skillSlot.rank)}</b></span>`;
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
      `<span class="res-chip" style="--sin:${SIN_META[sin].color}"><i aria-hidden="true"></i>${escapeHtml(sin)}×${counts[sin]}</span>`
    )).join('');

    cards.push(`
      <article class="${cardClass}" data-key="${escapeHtml(persona.key)}" style="--selected-sin-color:${selectedColor}">
        <div class="color-strip" role="group" aria-label="各区画はスキル別の罪悪属性です。S番号は下段の同じ番号に対応します">${strip}</div>
        <div class="card-head">
          <div class="card-id">
            <span class="card-slot">SLOT ${slot}</span>
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
          <div><dt>HP</dt><dd>${escapeHtml(persona.hp)}</dd></div>
          <div><dt>SAN</dt><dd>${escapeHtml(persona.san)}</dd></div>
          <div><dt>速度</dt><dd>${escapeHtml(persona.speed)}</dd></div>
        </dl>
        <p class="passive"><b>パッシブ</b> ${escapeHtml(persona.passiveCond || '—')}${persona.passiveName ? ` / ${escapeHtml(persona.passiveName)}` : ''}</p>
        <div class="slot-list">${slots}</div>
        <div class="card-resources">${resourceChips || '<span class="res-chip">資源色なし</span>'}</div>
      </article>
    `);
  }

  $('#party-cards').innerHTML = cards.join('');
  $('#empty-state').hidden = cards.length > 0;
}

function syncControls() {
  $('#party-sort').value = state.partySort;
  $('#resource-sort').value = state.resourceSort;
  syncPickerMode();
}

function syncPickerMode() {
  for (const button of $('[data-picker-mode]')) {
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
  state.pickerQuery = '';
  $('#picker-search').value = '';
  $('#picker-title').textContent = index === null ? '人格を追加' : '人格を変更';
  syncPickerMode();
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
          <span class="lbt-import-option-meta">${escapeHtml(persona.sourceAccount || 'LBT保存データ')} · ${escapeHtml(persona.sourceLabel || typeLabel)} · HP ${persona.hp} / SAN ${persona.san}</span>
          <span class="lbt-import-option-skills">${escapeHtml(skills || 'スキル・罪悪属性は未登録')}</span>
        </span>
      </label>
    `;
  }).join('');
  empty.hidden = candidates.length > 0;
  status.textContent = candidates.length
    ? `${candidates.length}件の同期・創作人格が見つかりました。チェックした人格だけを追加ライブラリに取り込みます。元のLBT保存データは変更しません。${sharedActive ? ' なお、追加人格は現在のクラウド共有セッションでは使用できません。' : ''}`
    : '同じブラウザプロフィールのLBT保存データから、取り込み対象の同期・創作人格を検出できませんでした。公式DBの人格はすでに一覧にあります。';
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
  $('#picker').close();
  try {
    state.importCandidates = discoverLbtPersonaCandidates(browserStorage(), state.data.personas);
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

  try {
    const result = importLocalPersonas(browserStorage(), selected);
    refreshPersonaPool(result.personas);
    showToast(`LBT人格を${result.added}件追加、${result.updated}件更新しました。`);
  } catch (error) {
    mergeLocalPersonasInMemory(selected);
    showToast('今回の追加データをメモリ上に読み込みました。永続保存はできませんでした: ' + (error.message || '保存エラー'));
  }
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
  } catch {
    state.localPersonas = [...state.localPersonas.filter((item) => item.key !== persona.key), persona];
    showToast('人格を一時追加しましたが、ブラウザへ永続保存できませんでした。');
  }
  refreshPersonaPool(state.localPersonas);
  if ($('#manual-persona-dialog').open) $('#manual-persona-dialog').close();
  reopenPickerAfterLocalDialog('local');
  showToast(`創作人格「${persona.name}」を追加しました。`);
}

function renderPickerList() {
  const query = state.pickerQuery.trim().normalize('NFKC').toLowerCase();
  const selectedKeys = new Set(state.party.map((entry) => entry.key));
  const currentKey = state.pickerIndex !== null ? state.party[state.pickerIndex]?.key : null;

  const results = state.personas.filter((persona) => {
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
    const localOnlyBlocked = Boolean(persona.localOnly && window.sharedPartySession?.isActive);
    const disabled = alreadySelected || localOnlyBlocked;
    const colors = [...new Set(persona.slots.flatMap((slot) => slot.colors))];
    const keywords = persona.keywords.length > 0 ? persona.keywords.join('・') : (persona.affiliation || '—');
    const stateLabel = alreadySelected ? '編成済み' : (localOnlyBlocked ? '共有編成では未対応' : '');
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
}

function deleteLocalPersona(key) {
  const persona = state.localPersonas.find((item) => item.key === key);
  if (!persona) return;
  if (state.party.some((entry) => entry.key === key)) {
    showToast('編成で使用中の人格です。先に編成から外してください。');
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
  if (persona.localOnly && window.sharedPartySession?.isActive) {
    showToast('LBT同期・創作人格は現在クラウド共有セッションに未対応です。個人編成に戻ると選択できます。');
    return;
  }
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
    state.party.push({ key });
  } else if (state.pickerIndex !== null) {
    state.party[state.pickerIndex] = { key };
  }

  state.pickerIndex = null;
  state.pendingAdd = false;
  $('#picker').close();
  saveState();
  renderAll();
  showToast(`${persona.name} を編成しました。`);
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

  state.party = result.party.map((entry) => ({ key: entry.key }));
  state.selectedSin = null;
  state.partySort = 'default';
  state.previousPartySort = 'default';
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
  saveState();
  renderAll();
  showToast('編成を空にしました。');
}

async function copyTsv() {
  const result = state.lastAggregate;
  const rows = [[
    '枠',
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
    .map((row) => row.map((value) => String(value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t'))
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
        setPartyKeys: (keys) => {
          state.party = sanitizeParty(keys) || [];
          renderAll();
        },
        renderAll,
        saveState,
        showToast,
        canShareCurrentParty: () => state.party.every((entry) => !state.map.get(entry.key)?.localOnly),
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
