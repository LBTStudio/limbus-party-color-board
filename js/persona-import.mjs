import { SIN_ORDER, parseSpeedAverage } from './core.mjs';

export const LOCAL_PERSONA_STORAGE_KEY = 'lbt_party_color_board_local_personas_v1';
const LOCAL_PERSONA_NAMESPACE_KEY = 'lbt_party_color_board_installation_id_v1';
const LBT_ACCOUNTS_INDEX_KEY = 'lbt_accounts_index';
const LBT_ACTIVE_ACCOUNT_KEY = 'lbt_account_active';
const LBT_LEGACY_STATE_KEY = 'lbt_v46_state';
export const MAX_LOCAL_PERSONAS = 300;
const MAX_ACCOUNTS = 30;
const MAX_ACCOUNT_STATE_CHARS = 8_000_000;
const VALID_KINDS = new Set(['normal', 'tokui', 'custom']);
const VALID_VARIANTS = new Set(['sync', 'custom', 'manual']);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

function safeNumber(value, fallback, min = 0, max = 9999) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseJson(raw, maxChars = MAX_ACCOUNT_STATE_CHARS) {
  if (typeof raw !== 'string' || !raw || raw.length > maxChars) return null;
  try {
    const parsed = JSON.parse(raw);
    return record(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeGet(storage, key) {
  try {
    return storage?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}

function localPersonaNamespace(storage) {
  const existing = text(safeGet(storage, LOCAL_PERSONA_NAMESPACE_KEY), 100);
  if (/^[A-Za-z0-9_-]{16,100}$/.test(existing)) return existing;
  let value = '';
  try {
    value = globalThis.crypto?.randomUUID?.().replaceAll('-', '') || '';
  } catch {
    value = '';
  }
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(value)) {
    value = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }
  try {
    storage?.setItem?.(LOCAL_PERSONA_NAMESPACE_KEY, value);
  } catch {
    // If storage is blocked, use an ephemeral namespace; the caller will keep the
    // imported candidate in memory and must not claim that it is persistently saved.
  }
  return value;
}

function hashText(value) {
  // Two independent 32-bit FNV-1a hashes make deterministic local keys compact.
  const input = String(value);
  const hash = (seed) => {
    let value = seed >>> 0;
    for (let index = 0; index < input.length; index++) {
      value ^= input.charCodeAt(index);
      value = Math.imul(value, 0x01000193) >>> 0;
    }
    return value.toString(16).padStart(8, '0');
  };
  return hash(0x811c9dc5) + hash(0x9747b28c);
}

function validColors(value) {
  const values = Array.isArray(value) ? value : [value];
  const colors = [];
  for (const item of values) {
    const candidate = String(item ?? '');
    for (const sin of SIN_ORDER) {
      if ((candidate === sin || candidate.includes(sin)) && !colors.includes(sin)) colors.push(sin);
    }
  }
  return colors;
}

function colorsFromSkill(skill) {
  if (Array.isArray(skill?.colors)) return validColors(skill.colors);
  return validColors(skill?.sin ?? skill?.sin_type ?? skill?.color ?? []);
}

function skillIndex(skill) {
  const rank = String(skill?.rank ?? skill?.slot ?? '');
  const match = rank.match(/^(?:S|スキル)?\s*(\d+)(?:-(\d+))?$/i);
  if (!match) return null;
  if (match[2]) return null; // A derived skill belongs to the parent action, not a new S0–S4 slot.
  const number = Number(match[1]);
  return Number.isInteger(number) && number >= 0 && number <= 4 ? number : null;
}

function normalizedSlots(persona) {
  if (Array.isArray(persona?.slots)) {
    return Array.from({ length: 5 }, (_, index) => {
      const slot = persona.slots.find((item) => Number(String(item?.rank ?? '').replace(/^S/i, '')) === index)
        || persona.slots[index] || {};
      return {
        rank: `S${index}`,
        name: text(slot.name, 120),
        type: text(slot.type, 80),
        colors: validColors(slot.colors),
      };
    });
  }

  const skills = Array.isArray(persona?.skills) ? persona.skills.filter(record) : [];
  const roots = Array(5).fill(null);
  for (let index = 0; index < skills.length; index++) {
    const skill = skills[index];
    const rankIndex = skillIndex(skill);
    const slotIndex = rankIndex === null ? (String(skill?.rank ?? '').trim() ? -1 : index) : rankIndex;
    if (slotIndex >= 0 && slotIndex < 5 && !roots[slotIndex]) roots[slotIndex] = skill;
  }
  return roots.map((skill, index) => ({
    rank: `S${index}`,
    name: text(skill?.name, 120),
    type: text(skill?.type, 80),
    colors: skill ? colorsFromSkill(skill) : [],
  }));
}

function normalizedPersonaFields(persona) {
  const kind = VALID_KINDS.has(persona?.kind) ? persona.kind : 'custom';
  const speed = text(persona?.speed, 40) || '1d5';
  const numericSpeed = Number(speed);
  const speedAvg = Number.isFinite(numericSpeed) && speed.trim() !== ''
    ? numericSpeed
    : parseSpeedAverage(speed);
  return {
    kind,
    no: safeNumber(persona?.no, kind === 'custom' ? 999 : 1, 0, 9999),
    name: text(persona?.name, 100),
    hp: safeNumber(persona?.hp, 100, 1, 9999),
    san: safeNumber(persona?.san, 45, 0, 9999),
    speed,
    speedAvg: safeNumber(persona?.speedAvg, speedAvg, 0, 999),
    keywords: [...new Set((Array.isArray(persona?.keywords) ? persona.keywords : [])
      .map((item) => text(item, 60)).filter(Boolean))].slice(0, 60),
    affiliation: text(persona?.affiliation, 100),
    passiveName: text(persona?.passiveName ?? persona?.passive_name, 100),
    passiveCond: text(persona?.passiveCond ?? persona?.passive_cond, 240),
    passiveEffect: text(persona?.passiveEffect ?? persona?.passive_effect, 2000),
    slots: normalizedSlots(persona),
  };
}

function currentSourceFromSnapshot(source, snapshot) {
  const base = record(source) ? { ...source } : {};
  if (!record(snapshot)) return base;
  const result = { ...base };
  const stat = (key, fallback) => {
    const value = snapshot[key];
    return value === '' || value === null || value === undefined ? fallback : value;
  };
  result.hp = stat('hp', base.hp);
  result.san = stat('san', base.san);
  result.speed = stat('speed', base.speed);
  result.res_slash = snapshot.resS || base.res_slash;
  result.res_pierce = snapshot.resP || base.res_pierce;
  result.res_blunt = snapshot.resB || base.res_blunt;
  if (record(snapshot.pas)) {
    result.passive_name = snapshot.pas.name ?? base.passive_name;
    result.passive_cond = snapshot.pas.cond ?? base.passive_cond;
    result.passive_always = snapshot.pas.always ?? base.passive_always;
    result.passive_effect = snapshot.pas.effect ?? base.passive_effect;
  }
  if (Array.isArray(snapshot.skills)) result.skills = snapshot.skills;
  if (Array.isArray(snapshot.uniqueBuffs)) result.unique_buffs = snapshot.uniqueBuffs;
  if (Array.isArray(base.keywords)) result.keywords = base.keywords;
  return result;
}

function kindFromMode(mode, source) {
  if (mode === 't') return 'tokui';
  if (mode === 'n') return 'normal';
  return source?.__custom || mode === 'custom' ? 'custom' : 'normal';
}

function sameRelevantData(a, b) {
  if (!a || !b) return false;
  const select = (persona) => JSON.stringify({
    name: persona.name, hp: persona.hp, san: persona.san, speed: persona.speed,
    keywords: [...(persona.keywords || [])].sort(), affiliation: persona.affiliation,
    passiveName: persona.passiveName, passiveCond: persona.passiveCond,
    slots: (persona.slots || []).map((slot) => ({
      name: slot.name, type: slot.type, colors: [...slot.colors].sort(),
    })),
  });
  return select(a) === select(b);
}

function makeCandidate(source, metadata, catalog) {
  const kind = kindFromMode(metadata.mode, source);
  const original = kind === 'custom' || source?.__custom === true;
  const variantType = original ? 'custom' : 'sync';
  const sourceRef = text(metadata.sourceRef, 240);
  const normalized = normalizedPersonaFields({ ...source, kind });
  if (!normalized.name) return null;
  const namespace = text(metadata.namespace, 100) || 'ephemeral';
  const syncRank = ['0', '00', '000'].includes(String(metadata.syncRank ?? ''))
    ? String(metadata.syncRank) : null;
  const syncMax = metadata.syncMax === true;
  // LBT's account IDs (e.g. "acct-1") are local and repeat across devices.
  // Include a per-browser namespace plus the imported data in the initial key so
  // separate users can share different edits of the same base identity without
  // key collisions. Re-import matching sourceRef preserves the existing key.
  const localKey = `${original ? 'lbt-original' : 'lbt-sync'}-${hashText(
    `${namespace}:${sourceRef}:${JSON.stringify(normalized)}:${syncRank || ''}:${syncMax}`
  )}`;
  const syncLabel = syncRank ? `同期${syncRank}` : (syncMax ? '同期ランク未設定' : '同期化データ');
  return {
    key: localKey,
    ...normalized,
    variantType,
    localOnly: true,
    originType: original ? 'lbt-custom' : 'lbt-sync',
    sourceRef,
    sourceAccount: text(metadata.accountName, 80),
    sourceLabel: original ? 'オリジナル人格' : (metadata.sourceLabel || syncLabel),
    sourceIdentityKey: text(metadata.identityKey, 120),
    syncRank,
    syncMax,
    lbtPersonaNo: metadata.no ?? source?.no ?? null,
  };
}

function hasAccountsIndex(storage) {
  const parsed = parseJson(safeGet(storage, LBT_ACCOUNTS_INDEX_KEY), 500_000);
  return parsed && Array.isArray(parsed.accounts) ? parsed : null;
}

function readAccountStates(storage) {
  const index = hasAccountsIndex(storage);
  const states = [];
  if (index) {
    const activeId = text(safeGet(storage, LBT_ACTIVE_ACCOUNT_KEY), 120);
    const accounts = index.accounts.filter((account) => record(account)
      && /^[A-Za-z0-9_-]{1,120}$/.test(String(account.id ?? '')));
    // Sort the active account before applying the safety cap, or a long account
    // list could silently omit the very save the user currently has open.
    accounts.sort((a, b) => Number(String(b.id) === activeId) - Number(String(a.id) === activeId));
    accounts.length = Math.min(accounts.length, MAX_ACCOUNTS);
    for (const account of accounts) {
      const state = parseJson(safeGet(storage, `lbt_account_${account.id}`));
      if (!state) continue;
      states.push({
        id: String(account.id),
        name: text(account.name, 80) || '名称未設定',
        active: String(account.id) === activeId,
        state,
      });
    }
    if (states.length) return states;
  }

  const legacy = parseJson(safeGet(storage, LBT_LEGACY_STATE_KEY));
  if (legacy) states.push({ id: 'legacy', name: text(legacy.charName || legacy.personaSrc?.name, 80) || '旧形式の保存データ', active: true, state: legacy });
  return states;
}

export function discoverLbtPersonaCandidates(storage, catalog = []) {
  const accounts = readAccountStates(storage);
  const namespace = localPersonaNamespace(storage);
  const byKey = new Map();
  const sourceRefs = new Set();
  const addCandidate = (candidate) => {
    if (!candidate || (candidate.sourceRef && sourceRefs.has(candidate.sourceRef))) return;
    byKey.set(candidate.key, candidate);
    if (candidate.sourceRef) sourceRefs.add(candidate.sourceRef);
  };
  for (const account of accounts) {
    const state = account.state;
    const baseMeta = {
      accountName: account.name,
      namespace,
      identityKey: '',
      syncRank: null,
      syncMax: false,
    };
    const owned = Array.isArray(state.roster?.personas) ? state.roster.personas.filter(record) : [];
    const basePersona = (mode, no) => catalog.find((persona) => (
      (mode === 't' ? persona.kind === 'tokui' : persona.kind === 'n' ? persona.kind === 'normal' : false)
      && String(persona.no) === String(no)
    ));

    // Current equipped build: import only custom identities or edits explicitly marked as synchronized.
    if (record(state.personaSrc)) {
      const mode = String(state.personaMode ?? '');
      const isCustom = mode === 'custom' || state.personaSrc.__custom === true;
      if (isCustom || state.syncedManual === true) {
        const source = currentSourceFromSnapshot(state.personaSrc, state);
        const no = state.personaNo ?? source.no;
        const modeForMap = isCustom ? 'custom' : mode;
        const sourceRef = `${account.id}:identity:${modeForMap}:${no}`;
        const currentOwnedEntry = owned.find((entry) => String(entry.mode ?? '') === modeForMap
          && String(entry.no ?? entry.uid ?? '') === String(no));
        const syncRank = ['0', '00', '000'].includes(String(currentOwnedEntry?.syncRank ?? ''))
          ? String(currentOwnedEntry.syncRank) : null;
        const syncMax = currentOwnedEntry?.syncMax === true;
        const candidate = makeCandidate(source, {
          ...baseMeta,
          mode: modeForMap,
          no,
          sourceRef,
          identityKey: `${modeForMap}:${no}`,
          syncRank,
          syncMax,
          sourceLabel: isCustom ? '現在のオリジナル人格' : '現在の同期化・手動編集',
        }, catalog);
        addCandidate(candidate);
      }
    }

    for (const entry of owned.slice(0, 500)) {
      const mode = String(entry.mode ?? '');
      const no = entry.no ?? entry.uid ?? '';
      const isCustom = mode === 'custom' || entry.src?.__custom === true;
      const syncRank = ['0', '00', '000'].includes(String(entry.syncRank ?? '')) ? String(entry.syncRank) : null;
      const syncMax = entry.syncMax === true;
      const identityKey = `${mode}:${no}`;
      const sourceRef = `${account.id}:identity:${identityKey}`;

      if (isCustom) {
        const source = entry.src || entry.build?.personaSrc;
        if (!record(source)) continue;
        const effective = entry.build?.personaSrc
          ? currentSourceFromSnapshot(entry.build.personaSrc, entry.build)
          : source;
        const candidate = makeCandidate(effective, {
          ...baseMeta, mode: 'custom', no, sourceRef, identityKey,
          sourceLabel: '保存済みオリジナル人格', syncRank, syncMax,
        }, catalog);
        addCandidate(candidate);
        continue;
      }

      const build = record(entry.build) ? entry.build : null;
      if (build && record(build.personaSrc)) {
        const source = currentSourceFromSnapshot(build.personaSrc, build);
        const candidate = makeCandidate(source, {
          ...baseMeta, mode, no, sourceRef, identityKey,
          sourceLabel: build.syncedManual ? '同期化・手動編集済み' : '保存済みビルド差分',
          syncRank, syncMax,
        }, catalog);
        const base = basePersona(mode, no);
        const differs = !base || !sameRelevantData(candidate, base);
        if (candidate && (build.syncedManual === true || entry.synced === true || syncRank || syncMax || differs)) {
          addCandidate(candidate);
        }
        continue;
      }

      // Sync rank / MAX is metadata separate from a manual build snapshot. Use the official catalog as its template.
      if (entry.synced === true || syncRank || syncMax) {
        const base = basePersona(mode, no);
        if (!base) continue;
        const candidate = {
          ...base,
          key: `lbt-sync-${hashText(`${namespace}:${sourceRef}:${JSON.stringify(base)}:${syncRank || ''}:${syncMax}`)}`,
          variantType: 'sync',
          localOnly: true,
          originType: 'lbt-sync',
          sourceRef,
          sourceAccount: account.name,
          sourceLabel: syncRank ? `同期${syncRank}` : (syncMax ? '同期MAX' : '同期状態'),
          sourceIdentityKey: identityKey,
          syncRank,
          syncMax,
          lbtPersonaNo: no,
        };
        addCandidate(candidate);
      }
    }
  }

  return [...byKey.values()].slice(0, 300);
}

export function sanitizeLocalPersona(persona) {
  if (!record(persona)) return null;
  const key = text(persona.key, 180);
  if (!/^(?:lbt-sync-|lbt-original-|manual-)[A-Za-z0-9_-]+$/.test(key)) return null;
  const normalized = normalizedPersonaFields(persona);
  if (!normalized.name) return null;
  const variantType = VALID_VARIANTS.has(persona.variantType) ? persona.variantType : 'manual';
  if (!VALID_KINDS.has(normalized.kind)) return null;
  return {
    ...normalized,
    key,
    variantType,
    localOnly: true,
    originType: text(persona.originType, 40) || 'manual',
    sourceRef: text(persona.sourceRef, 240),
    sourceAccount: text(persona.sourceAccount, 80),
    sourceLabel: text(persona.sourceLabel, 100) || (variantType === 'sync' ? '同期データ' : variantType === 'custom' ? 'オリジナル人格' : '手動追加'),
    sourceIdentityKey: text(persona.sourceIdentityKey, 120),
    syncRank: ['0', '00', '000'].includes(String(persona.syncRank ?? '')) ? String(persona.syncRank) : null,
    syncMax: persona.syncMax === true,
    lbtPersonaNo: persona.lbtPersonaNo == null ? null : text(persona.lbtPersonaNo, 80),
  };
}

export function loadLocalPersonas(storage) {
  const parsed = parseJson(safeGet(storage, LOCAL_PERSONA_STORAGE_KEY), 4_000_000);
  if (!Array.isArray(parsed?.personas)) return [];
  const items = parsed.personas.slice(0, MAX_LOCAL_PERSONAS).map(sanitizeLocalPersona).filter(Boolean);
  return [...new Map(items.map((persona) => [persona.key, persona])).values()];
}

export function saveLocalPersonas(storage, personas) {
  if (!storage || typeof storage.setItem !== 'function') throw new Error('このブラウザではローカル保存を利用できません。');
  const normalizedInput = [...new Map((Array.isArray(personas) ? personas : [])
    .slice(0, MAX_LOCAL_PERSONAS * 2)
    .map(sanitizeLocalPersona).filter(Boolean)
    .map((persona) => [persona.key, persona])).values()];
  if (normalizedInput.length > MAX_LOCAL_PERSONAS) {
    const error = new Error(`ローカル人格は最大${MAX_LOCAL_PERSONAS}件です。不要な人格を整理してから保存してください。`);
    error.code = 'LOCAL_PERSONA_LIMIT';
    throw error;
  }
  const normalized = normalizedInput;
  try {
    storage.setItem(LOCAL_PERSONA_STORAGE_KEY, JSON.stringify({ version: 1, personas: normalized }));
  } catch {
    throw new Error('人格データを保存できません。ブラウザの保存容量を確認してください。');
  }
  return normalized;
}

export function importLocalPersonas(storage, candidates) {
  const current = loadLocalPersonas(storage);
  const byKey = new Map(current.map((persona) => [persona.key, persona]));
  const bySource = new Map(current.filter((persona) => persona.sourceRef).map((persona) => [persona.sourceRef, persona]));
  let added = 0;
  let updated = 0;
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const candidate = sanitizeLocalPersona(raw);
    if (!candidate) continue;
    const previous = bySource.get(candidate.sourceRef) || byKey.get(candidate.key);
    const result = { ...candidate, key: previous?.key || candidate.key };
    if (previous) updated++;
    else added++;
    byKey.set(result.key, result);
    if (result.sourceRef) bySource.set(result.sourceRef, result);
  }
  if (byKey.size > MAX_LOCAL_PERSONAS) {
    const error = new Error(`ローカル人格は最大${MAX_LOCAL_PERSONAS}件です。不要な人格を整理してから取り込んでください。`);
    error.code = 'LOCAL_PERSONA_LIMIT';
    throw error;
  }
  const personas = saveLocalPersonas(storage, [...byKey.values()]);
  return { personas, added, updated };
}

export function createManualPersona(input) {
  const name = text(input?.name, 100);
  if (!name) throw new Error('人格名を入力してください。');
  const kind = 'custom';
  const slots = Array.from({ length: 5 }, (_, index) => {
    const source = Array.isArray(input?.slots) ? input.slots[index] : {};
    const colors = validColors(source?.colors);
    const slotName = text(source?.name, 120);
    return { rank: `S${index}`, name: slotName, type: text(source?.type, 80), colors: slotName ? colors : [] };
  });
  const seed = JSON.stringify({
    name, hp: input.hp, san: input.san, speed: input.speed,
    affiliation: input.affiliation, passiveName: input.passiveName,
    passiveCond: input.passiveCond, keywords: input.keywords, slots,
    nonce: `${Date.now()}-${Math.random()}`,
  });
  const base = normalizedPersonaFields({
    kind, no: 999, name,
    hp: safeNumber(input?.hp, 100, 1, 9999),
    san: safeNumber(input?.san, 45, 0, 9999),
    speed: text(input?.speed, 40) || '1d5',
    affiliation: text(input?.affiliation, 100),
    passiveName: text(input?.passiveName, 100),
    passiveCond: text(input?.passiveCond, 240),
    keywords: Array.isArray(input?.keywords) ? input.keywords : text(input?.keywords, 600).split(/[、,，\n]/u),
    slots,
  });
  return sanitizeLocalPersona({
    ...base,
    key: `manual-${hashText(seed)}`,
    variantType: 'manual',
    originType: 'manual',
    sourceLabel: '手動追加',
    sourceRef: '',
    sourceAccount: '',
    localOnly: true,
  });
}
