import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createManualPersona,
  MAX_LOCAL_PERSONAS,
  discoverLbtPersonaCandidates,
  importLocalPersonas,
  loadLocalPersonas,
  sanitizeLocalPersona,
  saveLocalPersonas,
} from '../js/persona-import.mjs';
import { SIN_ORDER } from '../js/core.mjs';

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }
}

const LBT_INDEX = 'lbt_accounts_index';
const LBT_ACTIVE = 'lbt_account_active';
const LOCAL_KEY = 'lbt_party_color_board_local_personas_v1';

function lbtSource({ name = '基準人格', no = 1, custom = false, colors = SIN_ORDER.slice(0, 5) } = {}) {
  return {
    name,
    no,
    hp: 100,
    san: 40,
    speed: '1d5',
    res_slash: '普通',
    res_pierce: '普通',
    res_blunt: '普通',
    passive_name: `${name}のパッシブ`,
    passive_cond: '憤怒x2 保有',
    passive_always: '',
    passive_effect: '編集時のパッシブ効果',
    keywords: ['出血'],
    unique_buffs: [{ name: '独自バフ', type: 'バフ', desc: '編集済み' }],
    skills: Array.from({ length: 5 }, (_, index) => ({
      rank: `スキル${index}`,
      type: '斬撃',
      sin: colors[index],
      name: `${name} S${index}`,
      effect: '',
      dice: [{ roll: '1d6', effect: '' }],
    })),
    ...(custom ? { __custom: true } : {}),
  };
}

function makeCatalogSource(source, key, kind = 'normal') {
  const slots = Array.from({ length: 5 }, (_, index) => ({
    rank: `S${index}`,
    name: source.skills[index]?.name || '',
    type: source.skills[index]?.type || '',
    colors: [source.skills[index]?.sin].filter(Boolean),
  }));
  return {
    key,
    kind,
    no: source.no,
    name: source.name,
    hp: source.hp,
    san: source.san,
    speed: source.speed,
    speedAvg: 3,
    keywords: source.keywords,
    affiliation: '所属',
    passiveName: source.passive_name,
    passiveCond: source.passive_cond,
    slots,
  };
}

function writeAccount(storage, state, name = 'テスト用アカウント') {
  storage.setItem(LBT_INDEX, JSON.stringify({
    accounts: [{ id: 'acct-1', name, createdAt: 1, updatedAt: 1 }],
  }));
  storage.setItem(LBT_ACTIVE, 'acct-1');
  storage.setItem('lbt_account_acct-1', JSON.stringify(state));
}

test('LBT save discovery extracts the current synced build, saved build differences, and original personas', () => {
  const baseNormal = lbtSource({ name: '基準人格', no: 1 });
  const baseTokui = lbtSource({ name: '特異の基準', no: 2 });
  const editedSkills = baseNormal.skills.map((skill, index) => ({
    ...skill,
    name: index === 0 ? '変更されたS0' : skill.name,
    sin: index === 0 ? '傲慢' : skill.sin,
  }));
  const activeState = {
    schemaVersion: 5,
    charName: 'テスト',
    personaMode: 'n',
    personaNo: 1,
    personaSrc: baseNormal,
    syncedManual: true,
    hp: '125',
    san: '55',
    speed: '1d7',
    resS: '弱点',
    resP: '普通',
    resB: '耐性',
    pas: { name: '編集パッシブ', cond: '嫉妬x1', always: '', effect: '編集済みの効果' },
    skills: editedSkills,
    uniqueBuffs: [{ name: '追加バフ', type: 'バフ', desc: '現在の編集' }],
    roster: {
      personas: [
        {
          uid: 'n1',
          no: 1,
          mode: 'n',
          syncRank: '00',
          syncMax: true,
          synced: true,
          build: {
            personaSrc: baseNormal,
            syncedManual: true,
            hp: '110',
            san: '50',
            speed: '1d6',
            skills: baseNormal.skills,
            pas: { name: '古いスナップショット', cond: '', always: '', effect: '' },
            uniqueBuffs: [],
          },
        },
        {
          uid: 't2',
          no: 2,
          mode: 't',
          syncRank: null,
          syncMax: false,
          synced: false,
          build: {
            personaSrc: baseTokui,
            syncedManual: false,
            hp: '180',
            san: '60',
            speed: '2d5',
            skills: baseTokui.skills.map((skill, index) => ({
              ...skill,
              name: index === 1 ? '保存ビルドだけのスキル' : skill.name,
              sin: index === 1 ? '嫉妬' : skill.sin,
            })),
            pas: { name: baseTokui.passive_name, cond: '', always: '', effect: '' },
            uniqueBuffs: [],
          },
        },
        {
          uid: 'custom-1',
          no: 'custom-1',
          mode: 'custom',
          syncRank: null,
          syncMax: false,
          src: lbtSource({ name: 'オリジナル人格', no: 999, custom: true, colors: ['色欲', '暴食', '怠惰', '憂鬱', '憤怒'] }),
        },
      ],
    },
  };
  const storage = new MemoryStorage();
  writeAccount(storage, activeState, 'アカウントA');
  const catalog = [
    makeCatalogSource(baseNormal, 'n1', 'normal'),
    makeCatalogSource(baseTokui, 't2', 'tokui'),
  ];

  const candidates = discoverLbtPersonaCandidates(storage, catalog);
  assert.equal(candidates.length, 3);

  const current = candidates.find((persona) => persona.name === '基準人格');
  assert.ok(current);
  assert.equal(current.variantType, 'sync');
  assert.equal(current.hp, 125);
  assert.equal(current.san, 55);
  assert.equal(current.speed, '1d7');
  assert.equal(current.passiveName, '編集パッシブ');
  assert.equal(current.passiveCond, '嫉妬x1');
  assert.equal(current.slots[0].name, '変更されたS0');
  assert.deepEqual(current.slots[0].colors, ['傲慢']);
  assert.equal(current.syncRank, '00');
  assert.equal(current.syncMax, true);
  assert.equal(current.sourceAccount, 'アカウントA');

  const savedDiff = candidates.find((persona) => persona.name === '特異の基準');
  assert.ok(savedDiff);
  assert.equal(savedDiff.kind, 'tokui');
  assert.equal(savedDiff.hp, 180);
  assert.equal(savedDiff.slots[1].name, '保存ビルドだけのスキル');
  assert.deepEqual(savedDiff.slots[1].colors, ['嫉妬']);

  const original = candidates.find((persona) => persona.name === 'オリジナル人格');
  assert.ok(original);
  assert.equal(original.kind, 'custom');
  assert.equal(original.variantType, 'custom');
  assert.equal(original.originType, 'lbt-custom');
  assert.deepEqual(original.slots[0].colors, ['色欲']);
});

test('unmodified official data is not duplicated as a synced variant without sync metadata', () => {
  const source = lbtSource({ name: '通常の未編集人格', no: 8 });
  const storage = new MemoryStorage();
  writeAccount(storage, {
    personaMode: null,
    personaNo: null,
    personaSrc: null,
    roster: {
      personas: [{ uid: 'n8', no: 8, mode: 'n', synced: false, syncRank: null, syncMax: false, equipped: false }],
    },
  });
  assert.deepEqual(discoverLbtPersonaCandidates(storage, [makeCatalogSource(source, 'n8')]), []);
});

test('legacy monolithic LBT save can be discovered without an account index', () => {
  const source = lbtSource({ name: '旧保存の創作人格', no: 999, custom: true });
  const storage = new MemoryStorage();
  storage.setItem('lbt_v46_state', JSON.stringify({
    charName: '旧保存',
    personaMode: 'custom',
    personaNo: 'custom-legacy',
    personaSrc: source,
    syncedManual: false,
    hp: '102',
    san: '45',
    speed: '1d5',
    roster: { personas: [] },
  }));
  const candidates = discoverLbtPersonaCandidates(storage, []);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, '旧保存の創作人格');
  assert.equal(candidates[0].sourceAccount, '旧保存');
});

test('active LBT account is still discovered when the account index exceeds the safety cap', () => {
  const storage = new MemoryStorage();
  const accountIds = Array.from({ length: 31 }, (_, index) => `acct-${index}`);
  storage.setItem(LBT_INDEX, JSON.stringify({
    accounts: accountIds.map((id, index) => ({ id, name: `アカウント${index}`, createdAt: index, updatedAt: index })),
  }));
  storage.setItem(LBT_ACTIVE, 'acct-30');

  for (const id of accountIds) {
    const isActive = id === 'acct-30';
    storage.setItem(`lbt_account_${id}`, JSON.stringify(isActive ? {
      personaMode: 'custom',
      personaNo: 'active-custom',
      personaSrc: lbtSource({ name: '現在のアカウントの創作人格', no: 999, custom: true }),
      syncedManual: false,
      roster: { personas: [] },
    } : {
      personaMode: null,
      personaNo: null,
      personaSrc: null,
      roster: { personas: [] },
    }));
  }

  const candidates = discoverLbtPersonaCandidates(storage, []);
  assert.ok(candidates.some((persona) => persona.name === '現在のアカウントの創作人格'));
});

test('local persona import is repeatable and updates the same saved identity rather than duplicating it', () => {
  const storage = new MemoryStorage();
  const source = lbtSource({ name: '同期人格', no: 4 });
  const candidate = {
    ...makeCatalogSource(source, 'n4'),
    key: 'lbt-sync-abcd1234ef567890',
    variantType: 'sync',
    localOnly: true,
    originType: 'lbt-sync',
    sourceRef: 'acct-1:identity:n:4',
    sourceAccount: 'アカウントA',
    sourceLabel: '同期00',
    syncRank: '00',
    syncMax: false,
  };
  const first = importLocalPersonas(storage, [candidate]);
  assert.equal(first.added, 1);
  assert.equal(first.updated, 0);
  assert.equal(first.personas.length, 1);

  const second = importLocalPersonas(storage, [{ ...candidate, hp: 150, sourceLabel: '同期000', syncRank: '000' }]);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 1);
  assert.equal(second.personas.length, 1);
  assert.equal(second.personas[0].hp, 150);
  assert.equal(second.personas[0].syncRank, '000');
  assert.equal(loadLocalPersonas(storage).length, 1);
});

test('manually created personas support dual sin colors and round-trip through local storage', () => {
  const storage = new MemoryStorage();
  const manual = createManualPersona({
    name: '手動人格',
    hp: 9999,
    san: 0,
    speed: '2d4+1',
    affiliation: '自作卓',
    keywords: '出血、破裂',
    passiveName: '独自パッシブ',
    passiveCond: '嫉妬x2 保有',
    slots: [
      { name: '二属性スキル', type: '斬撃', colors: ['憤怒', '傲慢'] },
      { name: '第2スキル', type: '貫通', colors: ['色欲'] },
    ],
  });
  assert.equal(manual.kind, 'custom');
  assert.equal(manual.variantType, 'manual');
  assert.deepEqual(manual.slots[0].colors, ['憤怒', '傲慢']);
  assert.deepEqual(manual.keywords, ['出血', '破裂']);
  const saved = saveLocalPersonas(storage, [manual]);
  assert.equal(saved.length, 1);
  assert.equal(loadLocalPersonas(storage)[0].name, '手動人格');
  assert.deepEqual(loadLocalPersonas(storage)[0].slots[0].colors, ['憤怒', '傲慢']);
});

test('malformed local storage records and foreign official keys are not accepted as local persona entries', () => {
  const storage = new MemoryStorage();
  storage.setItem(LOCAL_KEY, JSON.stringify({
    version: 1,
    personas: [
      { key: 'n1', name: '偽の公式キー', kind: 'normal', slots: [] },
      { key: 'manual-valid1', name: '有効な手動人格', kind: 'custom', slots: [] },
      { key: 'bad key <script>', name: '不正キー', kind: 'custom', slots: [] },
      null,
    ],
  }));
  const personas = loadLocalPersonas(storage);
  assert.deepEqual(personas.map((persona) => persona.key), ['manual-valid1']);
  assert.equal(sanitizeLocalPersona({ key: 'n1', name: '別人格', kind: 'custom' }), null);
  assert.throws(() => createManualPersona({ name: '   ' }), /人格名/);
});


test('local persona import enforces the 300-person library limit without partially persisting overflow', () => {
  const storage = new MemoryStorage();
  const candidates = Array.from({ length: MAX_LOCAL_PERSONAS + 1 }, (_, index) => ({
    key: `manual-limit-${index}`,
    kind: 'custom',
    variantType: 'manual',
    name: `上限テスト人格${index}`,
    hp: 100,
    san: 45,
    speed: '1d5',
    slots: [],
  }));

  assert.equal(MAX_LOCAL_PERSONAS, 300);
  assert.throws(
    () => importLocalPersonas(storage, candidates),
    (error) => error.code === 'LOCAL_PERSONA_LIMIT' && /最大300件/.test(error.message),
  );
  assert.equal(loadLocalPersonas(storage).length, 0, 'failed over-capacity import must not write a partial library');
});

test('LBT identity keys are namespaced per browser profile and remain stable on repeated discovery', () => {
  const source = lbtSource({ name: '同じ基底人格', no: 7 });
  const save = {
    schemaVersion: 5,
    charName: 'アカウント1',
    personaMode: 'n',
    personaNo: 7,
    personaSrc: source,
    syncedManual: true,
    hp: '120',
    san: '50',
    speed: '1d6',
    roster: { personas: [] },
  };
  const firstStorage = new MemoryStorage();
  const secondStorage = new MemoryStorage();
  writeAccount(firstStorage, save, '同じアカウント名');
  writeAccount(secondStorage, save, '同じアカウント名');
  const catalog = [makeCatalogSource(source, 'n7', 'normal')];

  const first = discoverLbtPersonaCandidates(firstStorage, catalog)[0];
  const second = discoverLbtPersonaCandidates(secondStorage, catalog)[0];
  const firstAgain = discoverLbtPersonaCandidates(firstStorage, catalog)[0];

  assert.ok(first && second);
  assert.equal(first.sourceRef, second.sourceRef, 'local LBT account IDs can repeat on different devices');
  assert.notEqual(first.key, second.key, 'different browser profiles need disjoint local identity keys');
  assert.equal(first.key, firstAgain.key, 'reopening the import dialog should not change a local key');
  assert.ok(firstStorage.getItem('lbt_party_color_board_installation_id_v1'));
  assert.ok(secondStorage.getItem('lbt_party_color_board_installation_id_v1'));
});
