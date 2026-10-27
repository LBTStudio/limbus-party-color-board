import { SIN_META, SIN_ORDER, parseSpeedAverage } from './core.mjs';

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
    const candidate = String(item ?? '').trim();
    if (!candidate) continue;
    const normalized = candidate.toLocaleLowerCase();
    for (const sin of SIN_ORDER) {
      const english = String(SIN_META[sin]?.en ?? '').toLocaleLowerCase();
      if ((candidate.includes(sin) || (english && normalized.includes(english))) && !colors.includes(sin)) {
        colors.push(sin);
      }
    }
  }
  return colors;
}

function colorsFromSkill(skill) {
  if (!record(skill)) return [];
  // Some LBT snapshots carry an empty colors array alongside the authoritative sin field.
  // Treat the empty array as missing, not as an override.
  const values = Array.isArray(skill.colors) ? [...skill.colors] : [];
  for (const field of ['sin', 'sin_type', 'sinType', 'color', 'attribute', 'attr']) {
    if (skill[field] !== undefined && skill[field] !== null && skill[field] !== '') values.push(skill[field]);
  }
  return validColors(values);
}

function skillRankInfo(skill) {
  const rank = String(skill?.rank ?? skill?.slot ?? '').trim();
  const derivedFrom = String(skill?.derived_from ?? skill?.derivedFrom ?? '').trim();
  const parentMatch = derivedFrom.match(/^(?:S|スキル)?\s*(\d+)$/i);
  if (parentMatch) return { number: Number(parentMatch[1]), derived: true };

  const match = rank.match(/^(?:S|スキル)?\s*(\d+)(?:-(\d+))?$/i);
  if (match) return { number: Number(match[1]), derived: Boolean(match[2]) };
  if (!rank) return { number: null, derived: false };
  return { number: Number.NaN, derived: false };
}

function normalizedSkillSlots(skills) {
  const sourceSkills = Array.isArray(skills) ? skills.filter(record) : [];
  const ranked = sourceSkills.map((skill) => ({ skill, rank: skillRankInfo(skill) }));
  const rankNumbers = ranked
    .map(({ rank }) => rank?.number)
    .filter((number) => Number.isInteger(number));
  // LBT normally uses ranks 0–4. Also accept 1–5 ranks from text/manual imports,
  // where 1-2 is a variant of skill 1 rather than the second board slot.
  const oneBased = !rankNumbers.includes(0) && rankNumbers.includes(5);
  const roots = Array(5).fill(null);
  const colors = Array.from({ length: 5 }, () => []);

  ranked.forEach(({ skill, rank }, arrayIndex) => {
    const explicitRank = String(skill?.rank ?? skill?.slot ?? '').trim();
    let slotIndex;
    if (rank && Number.isInteger(rank.number)) {
      slotIndex = rank.number - (oneBased ? 1 : 0);
    } else if (!explicitRank) {
      slotIndex = arrayIndex;
    } else {
      return;
    }
    if (slotIndex < 0 || slotIndex >= 5) return;

    if (!rank?.derived && !roots[slotIndex]) roots[slotIndex] = skill;
    // Derived skills are alternate forms of their parent action, not new slots;
    // their sin colors still belong to that parent slot and must be represented.
    colors[slotIndex].push(...colorsFromSkill(skill));
  });

  return {
    roots,
    colors: colors.map((values) => validColors(values)),
  };
}

function normalizedSlots(persona) {
  const skills = Array.isArray(persona?.skills) ? persona.skills.filter(record) : [];
  const { roots, colors } = normalizedSkillSlots(skills);

  if (Array.isArray(persona?.slots)) {
    return Array.from({ length: 5 }, (_, index) => {
      const slot = persona.slots.find((item) => Number(String(item?.rank ?? '').replace(/^S/i, '')) === index)
        || persona.slots[index] || {};
      const skill = roots[index];
      return {
        rank: `S${index}`,
        name: text(slot.name, 120) || text(skill?.name, 120),
        type: text(slot.type, 80) || text(skill?.type, 80),
        // Prefer actual LBT skill records (including derived variants). Fall back to
        // an older slot snapshot only when no color could be recovered from skills.
        colors: colors[index].length ? colors[index] : colorsFromSkill(slot),
      };
    });
  }

  return roots.map((skill, index) => ({
    rank: `S${index}`,
    name: text(skill?.name, 120),
    type: text(skill?.type, 80),
    colors: colors[index],
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
    resSlash: text(persona?.resSlash ?? persona?.res_slash ?? persona?.resS, 40) || '—',
    resPierce: text(persona?.resPierce ?? persona?.res_pierce ?? persona?.resP, 40) || '—',
    resBlunt: text(persona?.resBlunt ?? persona?.res_blunt ?? persona?.resB, 40) || '—',
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
  result.res_slash = stat('resS', base.res_slash);
  result.res_pierce = stat('resP', base.res_pierce);
  result.res_blunt = stat('resB', base.res_blunt);
  if (record(snapshot.pas)) {
    result.passive_name = snapshot.pas.name ?? base.passive_name;
    result.passive_cond = snapshot.pas.cond ?? base.passive_cond;
    result.passive_always = snapshot.pas.always ?? base.passive_always;
    result.passive_effect = snapshot.pas.effect ?? base.passive_effect;
  }
  if (Array.isArray(snapshot.skills)) {
    // The saved LBT build is the source of truth for visible skill names/types/attributes.
    // Do not let a stale pre-normalized slots array on an imported personaSrc shadow it.
    result.skills = snapshot.skills;
    delete result.slots;
  }
  if (Array.isArray(snapshot.uniqueBuffs)) result.unique_buffs = snapshot.uniqueBuffs;
  if (Array.isArray(base.keywords)) result.keywords = base.keywords;
  return result;
}

function applyRosterDisplayName(source, entry) {
  if (!record(source)) return source;
  const displayName = text(entry?.displayName, 100);
  return displayName ? { ...source, name: displayName } : source;
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
    passiveEffect: persona.passiveEffect,
    resSlash: persona.resSlash, resPierce: persona.resPierce, resBlunt: persona.resBlunt,
    slots: (persona.slots || []).map((slot) => ({
      name: slot.name, type: slot.type, colors: [...slot.colors].sort(),
    })),
  });
  return select(a) === select(b);
}

function relevantDataDifferenceScore(persona, base) {
  if (!persona || !base) return 0;
  let score = 0;
  const fields = [
    'name', 'hp', 'san', 'speed', 'affiliation',
    'passiveName', 'passiveCond', 'passiveEffect',
    'resSlash', 'resPierce', 'resBlunt',
  ];
  for (const field of fields) {
    if ((persona[field] ?? null) !== (base[field] ?? null)) score++;
  }
  const keywords = (value) => JSON.stringify([...(value || [])].sort());
  if (keywords(persona.keywords) !== keywords(base.keywords)) score++;
  for (let index = 0; index < 5; index++) {
    const a = persona.slots?.[index] || {};
    const b = base.slots?.[index] || {};
    // Skill names, attack types, and sin colors are the exact fields that must
    // reflect synchronized LBT edits, so prefer the snapshot with those changes.
    if ((a.name ?? '') !== (b.name ?? '')) score += 100;
    if ((a.type ?? '') !== (b.type ?? '')) score += 100;
    const colors = (slot) => JSON.stringify([...(slot.colors || [])].sort());
    if (colors(a) !== colors(b)) score += 100;
  }
  return score;
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

/**
 * Return the account labels and owned-persona index required by the picker.
 * Only identity keys and catalog keys are returned; raw LBT save objects stay
 * inside this module and are never handed to the UI.
 */
export function discoverLbtAccounts(storage, catalog = []) {
  const catalogByIdentity = new Map();
  for (const persona of Array.isArray(catalog) ? catalog : []) {
    const mode = persona?.kind === 'normal' ? 'n' : persona?.kind === 'tokui' ? 't' : '';
    const no = text(persona?.no, 80);
    if (mode && no && text(persona?.key, 180)) {
      catalogByIdentity.set(`${mode}:${no}`, text(persona.key, 180));
    }
  }

  return readAccountStates(storage).map((account) => {
    const identityKeys = new Set();
    const owned = Array.isArray(account.state.roster?.personas)
      ? account.state.roster.personas.filter(record).slice(0, 500)
      : [];
    for (const entry of owned) {
      const mode = text(entry.mode, 12);
      const no = text(entry.no ?? entry.uid, 80);
      if (['n', 't', 'custom'].includes(mode) && no) identityKeys.add(`${mode}:${no}`);
    }
    // A currently equipped identity is owned/current even if an older save is
    // missing its corresponding roster row.
    const currentMode = text(account.state.personaMode, 12);
    const currentNo = text(account.state.personaNo, 80);
    if (record(account.state.personaSrc) && ['n', 't', 'custom'].includes(currentMode) && currentNo) {
      identityKeys.add(`${currentMode}:${currentNo}`);
    }

    const ownedKeys = [...identityKeys]
      .map((key) => catalogByIdentity.get(key))
      .filter(Boolean);
    return {
      id: account.id,
      name: account.name,
      active: account.active,
      ownedKeys: [...new Set(ownedKeys)],
      ownedIdentityKeys: [...identityKeys],
      ownedCount: new Set(ownedKeys).size,
      playerName: text(account.state.plName, 80),
    };
  });
}

/** Whether a picker candidate belongs to an LBT account's owned roster. */
export function isPersonaOwnedByLbtAccount(persona, account) {
  if (!persona || !account || !text(account.id, 120)) return false;
  if (!persona.localOnly) {
    return Array.isArray(account.ownedKeys) && account.ownedKeys.includes(persona.key);
  }
  // Board-authored manual personas and shared snapshots do not carry an LBT
  // source reference, so they remain selectable even in an owned-only view.
  if (!persona.sourceRef) return true;
  const prefix = `${text(account.id, 120)}:identity:`;
  return persona.sourceRef.startsWith(prefix)
    && Boolean(persona.sourceIdentityKey)
    && Array.isArray(account.ownedIdentityKeys)
    && account.ownedIdentityKeys.includes(persona.sourceIdentityKey);
}

export function discoverLbtPersonaCandidates(storage, catalog = [], accountId = null) {
  const requestedAccountId = text(accountId, 120);
  const availableAccounts = readAccountStates(storage);
  const accounts = requestedAccountId
    ? availableAccounts.filter((account) => account.id === requestedAccountId)
    : availableAccounts;
  const namespace = localPersonaNamespace(storage);
  const byKey = new Map();
  const sourceKeys = new Map();
  const priorities = new Map();
  const addCandidate = (candidate, priority = 0) => {
    if (!candidate) return;
    const sourceRef = candidate.sourceRef;
    const previousKey = sourceRef ? sourceKeys.get(sourceRef) : null;
    if (previousKey) {
      const previousPriority = priorities.get(previousKey) ?? 0;
      if (priority <= previousPriority) return;
      byKey.delete(previousKey);
      priorities.delete(previousKey);
    }
    byKey.set(candidate.key, candidate);
    priorities.set(candidate.key, priority);
    if (sourceRef) sourceKeys.set(sourceRef, candidate.key);
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
    const basePersona = (mode, no) => {
      const prefix = mode === 't' ? 't' : mode === 'n' ? 'n' : '';
      // Prefer canonical catalog keys to normalize baseline lookup consistently.
      const byKey = prefix ? catalog.find((persona) => persona.key === `${prefix}${no}`) : null;
      if (byKey) return byKey;
      return catalog.find((persona) => (
        (mode === 't' ? persona.kind === 'tokui' : mode === 'n' ? persona.kind === 'normal' : false)
        && String(persona.no) === String(no)
      ));
    };

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
        const candidate = makeCandidate(applyRosterDisplayName(source, currentOwnedEntry), {
          ...baseMeta,
          mode: modeForMap,
          no,
          sourceRef,
          identityKey: `${modeForMap}:${no}`,
          syncRank,
          syncMax,
          sourceLabel: isCustom ? '現在のオリジナル人格' : '現在の同期化・手動編集',
        }, catalog);
        const base = basePersona(modeForMap, no);
        // The active state wins a tie because it may include unsaved current edits.
        // A more complete saved roster build can still replace it if it reflects
        // more visible changes than this stale equipped-state snapshot.
        const priority = (base ? relevantDataDifferenceScore(candidate, base) * 10 : 0) + 2;
        addCandidate(candidate, priority);
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
        const candidate = makeCandidate(applyRosterDisplayName(effective, entry), {
          ...baseMeta, mode: 'custom', no, sourceRef, identityKey,
          sourceLabel: '保存済みオリジナル人格', syncRank, syncMax,
        }, catalog);
        addCandidate(candidate, (basePersona(mode, no)
          ? relevantDataDifferenceScore(candidate, basePersona(mode, no)) * 10
          : 0) + 1);
        continue;
      }

      const build = record(entry.build) ? entry.build : null;
      if (build && record(build.personaSrc)) {
        const source = currentSourceFromSnapshot(build.personaSrc, build);
        const candidate = makeCandidate(applyRosterDisplayName(source, entry), {
          ...baseMeta, mode, no, sourceRef, identityKey,
          sourceLabel: build.syncedManual ? '同期化・手動編集済み' : '保存済みビルド差分',
          syncRank, syncMax,
        }, catalog);
        const base = basePersona(mode, no);
        const differs = !base || !sameRelevantData(candidate, base);
        if (candidate && (build.syncedManual === true || entry.synced === true || syncRank || syncMax || differs)) {
          addCandidate(candidate, (base ? relevantDataDifferenceScore(candidate, base) * 10 : 0) + 1);
        }
        continue;
      }

      // Sync rank / MAX and an explicitly renamed roster identity are metadata separate from a manual build snapshot.
      const base = basePersona(mode, no);
      if (!base) continue;
      const displayName = text(entry.displayName, 100);
      if (entry.synced === true || syncRank || syncMax || (displayName && displayName !== text(base.name, 100))) {
        const renamedBase = applyRosterDisplayName(base, entry);
        const candidate = {
          ...renamedBase,
          key: `lbt-sync-${hashText(`${namespace}:${sourceRef}:${JSON.stringify(renamedBase)}:${syncRank || ''}:${syncMax}`)}`,
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
        addCandidate(candidate, (base ? relevantDataDifferenceScore(candidate, base) * 10 : 0) + 1);
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
