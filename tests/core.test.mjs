import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_PARTY,
  MAX_PARTY,
  SAMPLE_PARTY,
  SIN_ORDER,
  aggregate,
  countColor,
  escapeSpreadsheetCell,
  makePersonaMap,
  parsePartySheet,
  parsePassiveRequirements,
  parseSpeedAverage,
  personaNumberLabel,
  resolvePersona,
  sortParty,
  sortResources,
} from '../js/core.mjs';

const data = JSON.parse(fs.readFileSync(new URL('../data/personas.json', import.meta.url), 'utf8'));
const personas = data.personas;
const map = makePersonaMap(personas);

test('dataset keeps every persona and five tactic slots', () => {
  assert.equal(personas.length, 199);
  assert.equal(personas.filter((persona) => persona.kind === 'normal').length, 145);
  assert.equal(personas.filter((persona) => persona.kind === 'tokui').length, 54);
  assert.equal(new Set(personas.map((persona) => persona.key)).size, personas.length);

  for (const persona of personas) {
    assert.equal(persona.slots.length, 5, `${persona.key} ${persona.name}`);
    for (const slot of persona.slots) {
      assert.ok(slot.colors.length >= 1, `${persona.key} ${slot.rank}`);
      for (const color of slot.colors) assert.ok(SIN_ORDER.includes(color), `${persona.key} ${color}`);
    }
  }
});

test('dual-color derived slots are preserved', () => {
  const persona = map.get('t16');
  assert.ok(persona);
  assert.deepEqual(persona.slots[4].colors, ['憤怒', '傲慢']);
  assert.equal(countColor(persona, '憤怒'), 1);
  assert.equal(countColor(persona, '傲慢'), 4);
});

test('empty default party starts with zero resources', () => {
  assert.deepEqual(DEFAULT_PARTY, []);
  const result = aggregate(DEFAULT_PARTY, map);
  assert.equal(result.grandTotal, 0);
  assert.deepEqual(result.totals, Object.fromEntries(SIN_ORDER.map((sin) => [sin, 0])));
});

test('sample party fixture reproduces the historical sample totals', () => {
  const result = aggregate(SAMPLE_PARTY, map);
  assert.deepEqual(result.totals, {
    憤怒: 1,
    色欲: 1,
    怠惰: 2,
    暴食: 10,
    憂鬱: 2,
    傲慢: 2,
    嫉妬: 2,
  });
  assert.deepEqual(result.personaCounts, {
    憤怒: 1,
    色欲: 1,
    怠惰: 2,
    暴食: 4,
    憂鬱: 2,
    傲慢: 2,
    嫉妬: 2,
  });
  assert.equal(result.grandTotal, 20);
});

test('sample fixture keeps only anonymous persona keys', () => {
  assert.deepEqual(SAMPLE_PARTY.map((entry) => entry.key), ['n48', 'n34', 'n78', 'n49']);
  assert.ok(SAMPLE_PARTY.every((entry) => Object.keys(entry).length === 1 && entry.key));
  assert.deepEqual(SAMPLE_PARTY.map((entry) => map.get(entry.key)?.name), [
    '黒獣-卯',
    '北部ヂェーヴィチ協会4課フィクサー',
    'LCEE.G.O:提灯',
    '黒獣-巳',
  ]);
});

test('resource sorting puts the dominant color first', () => {
  const result = aggregate(SAMPLE_PARTY, map);
  const sorted = sortResources(result.totals, result.personaCounts, 'count-desc');
  assert.equal(sorted[0].sin, '暴食');
  assert.equal(sorted[0].total, 10);
  assert.equal(sorted[0].personas, 4);
  assert.deepEqual(sorted.slice(1, 5).map((item) => item.sin), ['怠惰', '憂鬱', '傲慢', '嫉妬']);
  assert.deepEqual(sortResources(result.totals, result.personaCounts, 'sin-order').map((item) => item.sin), SIN_ORDER);
});

test('sorting by a selected color promotes the identities that provide it', () => {
  const sorted = sortParty(SAMPLE_PARTY, 'color', '憤怒', map);
  assert.equal(sorted[0].key, 'n34');
  assert.equal(countColor(map.get('n34'), '憤怒'), 1);
  assert.equal(countColor(map.get('n48'), '憤怒'), 0);
});

test('skill-specific resource sorting prioritizes a matching tactical slot before total counts', () => {
  const slotPersonas = [
    { key: 'a', kind: 'normal', no: 1, name: 'A', slots: [
      { rank: 'S0', colors: ['憤怒'] }, { rank: 'S1', colors: ['色欲'] },
    ] },
    { key: 'b', kind: 'normal', no: 2, name: 'B', slots: [
      { rank: 'S0', colors: ['色欲'] }, { rank: 'S1', colors: ['憤怒'] },
    ] },
  ];
  const slotMap = makePersonaMap(slotPersonas);
  const slotParty = slotPersonas.map((persona) => ({ key: persona.key }));

  assert.deepEqual(sortParty(slotParty, 'color', '色欲', slotMap, 'S0').map((entry) => entry.key), ['b', 'a']);
  assert.deepEqual(sortParty(slotParty, 'color', '色欲', slotMap, 'all').map((entry) => entry.key), ['a', 'b']);
});

test('passive resource requirements parse sin names and quantities without guessing from prose', () => {
  assert.deepEqual(
    parsePassiveRequirements('色欲x2 共鳴').map(({ sin, count }) => ({ sin, count })),
    [{ sin: '色欲', count: 2 }],
  );
  assert.deepEqual(
    parsePassiveRequirements('傲慢x2 憤怒 x3 保有').map(({ sin, count }) => ({ sin, count })),
    [{ sin: '傲慢', count: 2 }, { sin: '憤怒', count: 3 }],
  );
  assert.deepEqual(parsePassiveRequirements('夜明事務所所属の味方3名以上'), []);
});

test('party sorting by number, name and speed is deterministic', () => {
  assert.equal(sortParty(SAMPLE_PARTY, 'no-asc', null, map)[0].key, 'n34');
  assert.equal(sortParty(SAMPLE_PARTY, 'name', null, map)[0].key, 'n78');
  assert.equal(sortParty(SAMPLE_PARTY, 'speed-desc', null, map)[0].key, 'n48');
  assert.equal(sortParty(SAMPLE_PARTY, 'pattern', null, map).length, 4);
});

test('speed dice average is parsed for sorting', () => {
  assert.equal(parseSpeedAverage('1d5'), 3);
  assert.equal(parseSpeedAverage('3d2+1'), 5.5);
  assert.equal(parseSpeedAverage('4d2'), 6);
  assert.equal(parseSpeedAverage(''), 0);
});

test('tokui personas use the +110 catalog convention only for display', () => {
  const tokui = map.get('t1');
  assert.ok(tokui);
  assert.equal(personaNumberLabel(tokui), '特異 001');
  assert.equal(resolvePersona(personas, { name: 'N 社握る者', no: '111' }).persona.key, 't1');
});

test('TSV import resolves all four sample personas', () => {
  const text = [
    '\tメンバー名\t人格番号\t人格名\t保有キーワード\tパッシブ条件\t戦術０罪悪属性\t戦術１罪悪属性\t戦術２罪悪属性\t戦術３罪悪属性\t戦術４罪悪属性',
    '\tA\t48\t黒獣-卯\t破裂\t暴食 x3 保有\t暴食\t怠惰\t暴食\t暴食\t憂鬱',
    '\tB\t34\t北部ヂェーヴィチ協会4課フィクサー\t破裂\t暴食 x4 保有\t暴食\t色欲\t暴食\t憤怒\t暴食',
    '\tC\t78\tLCE E.G.O:提灯の人格\t破裂\t暴食 x3 保有\t暴食\t傲慢\t怠惰\t嫉妬\t暴食',
    '\tD\t49\t黒獣-巳\t破裂・呼吸\t暴食 x3 保有\t暴食\t傲慢\t暴食\t嫉妬\t憂鬱',
    '\t\t\t#N/A\t#N/A\t#N/A\t#N/A\t#N/A\t#N/A\t#N/A\t#N/A',
  ].join('\n');

  const result = parsePartySheet(text, personas);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.party.map((entry) => entry.key), ['n48', 'n34', 'n78', 'n49']);
  assert.ok(result.party.every((entry) => Object.keys(entry).length === 1));
});

test('spreadsheet formulas are escaped and formula-like names round-trip through TSV import', () => {
  const formulaName = '=HYPERLINK("https://example.invalid","click")';
  assert.equal(escapeSpreadsheetCell(formulaName), "'" + formulaName);
  assert.equal(escapeSpreadsheetCell('  +SUM(1,2)'), "'  +SUM(1,2)");
  assert.equal(escapeSpreadsheetCell('ordinary persona name'), 'ordinary persona name');

  const identity = { ...personas[0], key: 'manual-formula-roundtrip', name: formulaName };
  const safeName = escapeSpreadsheetCell(identity.name);
  const text = [
    '枠\t人格キー\t人格番号\t人格名\t種別',
    `1\t${identity.key}\t${identity.no}\t${safeName}\t通常`,
  ].join('\n');
  const result = parsePartySheet(text, [...personas, identity]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.party, [{ key: identity.key }]);
});


test('TSV PL-name assignments round-trip without affecting older sheets', () => {
  const text = [
    '枠\tPL名\t人格キー\t人格番号\t人格名\t種別',
    '1\tプレイヤーA\tn48\t48\t黒獣-卯\t通常',
    '2\tプレイヤーB\tn34\t34\t北部ヂェーヴィチ協会4課フィクサー\t通常',
  ].join('\\n');
  const result = parsePartySheet(text, personas);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.party, [
    { key: 'n48', playerName: 'プレイヤーA' },
    { key: 'n34', playerName: 'プレイヤーB' },
  ]);

  const legacy = parsePartySheet('枠\\t人格番号\\t人格名\\n1\\t48\\t黒獣-卯', personas);
  assert.deepEqual(legacy.errors, []);
  assert.deepEqual(legacy.party, [{ key: 'n48' }]);
});

test('TSV import rejects unterminated quoted fields instead of merging the rest of the sheet', () => {
  const result = parsePartySheet([
    '枠\t人格番号\t人格名',
    '1\t1\t"引用符が閉じていない',
  ].join('\n'), personas);
  assert.equal(result.party.length, 0);
  assert.match(result.errors.join(' '), /引用符が閉じていないセル/);
});

test('TSV import reports ambiguous legacy numbers instead of guessing', () => {
  const text = [
    'メンバー名\t人格番号\t人格名',
    'test\t111\t',
  ].join('\n');
  const result = parsePartySheet(text, personas);
  assert.equal(result.party.length, 0);
  assert.match(result.errors[0], /通常 No\.111 と特異 No\.1 の両方/);
});

test('TSV import accepts a name when the legacy number is ambiguous', () => {
  const text = [
    'メンバー名\t人格番号\t人格名',
    'test\t111\tN 社握る者',
  ].join('\n');
  const result = parsePartySheet(text, personas);
  assert.deepEqual(result.errors, []);
  assert.equal(result.party[0].key, 't1');
});

test('TSV import rejects duplicates and over-capacity parties', () => {
  const duplicate = [
    'メンバー名\t人格番号\t人格名',
    'a\t48\t黒獣-卯',
    'b\t48\t黒獣-卯',
  ].join('\n');
  const duplicateResult = parsePartySheet(duplicate, personas);
  assert.ok(duplicateResult.errors.some((error) => /重複/.test(error)));

  assert.equal(MAX_PARTY, 20);

  const twenty = ['メンバー名\t人格番号\t人格名'];
  for (const persona of personas.filter((item) => item.kind === 'normal').slice(0, 20)) {
    twenty.push(`${persona.name}\t${persona.no}\t${persona.name}`);
  }
  const exactLimit = parsePartySheet(twenty.join('\n'), personas);
  assert.deepEqual(exactLimit.errors, []);
  assert.equal(exactLimit.party.length, 20);

  const twentyOne = ['メンバー名\t人格番号\t人格名'];
  for (const persona of personas.filter((item) => item.kind === 'normal').slice(0, 21)) {
    twentyOne.push(`${persona.name}\t${persona.no}\t${persona.name}`);
  }
  const over = parsePartySheet(twentyOne.join('\n'), personas);
  assert.ok(over.errors.some((error) => /最大 20 名/.test(error)));
});


test('TSV persona keys disambiguate local synced variants that share an official name', () => {
  const official = personas.find((persona) => persona.key === 'n1');
  assert.ok(official);
  const synced = {
    ...official,
    key: 'lbt-sync-abcd1234ef567890',
    variantType: 'sync',
    localOnly: true,
    sourceLabel: '同期00',
    syncRank: '00',
  };
  const text = [
    '枠\t人格キー\t人格番号\t人格名\t種別',
    `1\t${synced.key}\t${synced.no}\t${synced.name}\t同期`,
  ].join('\n');
  const result = parsePartySheet(text, [...personas, synced]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.party, [{ key: synced.key }]);
  assert.equal(resolvePersona([...personas, synced], { key: synced.key, name: official.name }).persona.variantType, 'sync');

  const missingLocalVariant = parsePartySheet([
    '枠\t人格キー\t人格番号\t人格名\t種別',
    `1\tunavailable-local-key\t1\t${official.name}\t同期`,
  ].join('\n'), personas);
  assert.equal(missingLocalVariant.party.length, 0, 'do not silently map a missing synced variant to the official base persona');
  assert.match(missingLocalVariant.errors.join(' '), /人格を特定できません/);

  const missingNamespacedKey = resolvePersona(personas, {
    key: 'lbt-sync-unavailable123',
    name: official.name,
    no: official.no,
  });
  assert.match(missingNamespacedKey.error, /ローカル追加人格キー/);
  assert.equal(missingNamespacedKey.persona, undefined, 'missing local keys must never fall back to an official identity with a matching name/number');

  const uppercaseMissingKey = resolvePersona(personas, {
    key: 'LBT-SYNC-UNAVAILABLE123',
    name: official.name,
    no: official.no,
  });
  assert.match(uppercaseMissingKey.error, /ローカル追加人格キー/);
  assert.equal(uppercaseMissingKey.persona, undefined, 'case-altered local keys must not bypass the namespace guard');
});
