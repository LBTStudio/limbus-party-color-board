export const SIN_ORDER = ['憤怒', '色欲', '怠惰', '暴食', '憂鬱', '傲慢', '嫉妬'];

export const SIN_META = {
  憤怒: { short: '憤', color: '#d94d3f', ink: '#141110', en: 'Wrath' },
  色欲: { short: '欲', color: '#ea813a', ink: '#141110', en: 'Lust' },
  怠惰: { short: '怠', color: '#d9d357', ink: '#141110', en: 'Sloth' },
  暴食: { short: '食', color: '#7ec455', ink: '#141110', en: 'Gluttony' },
  憂鬱: { short: '憂', color: '#3f9fe9', ink: '#141110', en: 'Gloom' },
  傲慢: { short: '傲', color: '#5c5bd6', ink: '#ffffff', en: 'Pride' },
  嫉妬: { short: '嫉', color: '#b872d9', ink: '#141110', en: 'Envy' },
};

// New boards start empty. Keep the former example party as a test/sample fixture only.
export const DEFAULT_PARTY = [];

export const SAMPLE_PARTY = [
  { key: 'n48' },
  { key: 'n34' },
  { key: 'n78' },
  { key: 'n49' },
];

export const MAX_PARTY = 6;

// Protect the CSV/TSV parser from accidentally or intentionally oversized pastes.
export const MAX_IMPORT_CHARS = 20_000;
export const MAX_IMPORT_ROWS = 200;

export function personaKindLabel(persona) {
  if (persona?.variantType === 'sync') return '同期';
  if (persona?.kind === 'custom' || persona?.variantType === 'custom' || persona?.variantType === 'manual') return '創作';
  return persona?.kind === 'tokui' ? '特異' : '通常';
}

export function personaNumberLabel(persona) {
  if (persona?.kind === 'custom' || persona?.variantType === 'custom' || persona?.variantType === 'manual') return '創作';
  if (persona?.variantType === 'sync') {
    const original = persona.kind === 'tokui'
      ? `特異 ${String(persona.no).padStart(3, '0')}`
      : `No.${String(persona.no).padStart(3, '0')}`;
    const rank = persona.syncRank ? `・同期${persona.syncRank}` : '';
    const max = persona.syncMax ? '・MAX' : '';
    return `${original}（同期）${rank}${max}`;
  }
  return persona?.kind === 'tokui'
    ? `特異 ${String(persona.no).padStart(3, '0')}`
    : `No.${String(persona.no).padStart(3, '0')}`;
}

export function sheetNumber(persona) {
  return persona.kind === 'tokui' ? 110 + persona.no : persona.no;
}

export function parseSpeedAverage(expr) {
  const match = String(expr ?? '').match(/(\d+)d(\d+)([+-]\d+)?/);
  if (!match) return 0;
  const [, count, sides, mod] = match;
  return Number(count) * (Number(sides) + 1) / 2 + Number(mod || 0);
}

export function slotColors(slot) {
  return Array.isArray(slot?.colors) ? slot.colors : [];
}

export function countColor(persona, sin) {
  let count = 0;
  for (const slot of persona?.slots ?? []) {
    for (const color of slotColors(slot)) if (color === sin) count++;
  }
  return count;
}

export function parsePassiveRequirements(condition) {
  const source = String(condition ?? '');
  const pattern = new RegExp(`(${SIN_ORDER.join('|')})\\s*[xX×＊*]\\s*(\\d+)`, 'gu');
  return [...source.matchAll(pattern)].map((match) => ({
    sin: match[1],
    count: Number(match[2]),
    start: match.index,
    length: match[0].length,
  }));
}

export function totalColors(persona) {
  let count = 0;
  for (const slot of persona?.slots ?? []) count += slotColors(slot).length;
  return count;
}

export function aggregate(party, personaMap) {
  const totals = Object.fromEntries(SIN_ORDER.map((sin) => [sin, 0]));
  const personaSets = Object.fromEntries(SIN_ORDER.map((sin) => [sin, new Set()]));

  const rows = party.map((entry, index) => {
    const persona = personaMap.get(entry.key);
    const counts = Object.fromEntries(SIN_ORDER.map((sin) => [sin, 0]));

    if (persona) {
      for (const slot of persona.slots) {
        for (const sin of slotColors(slot)) {
          if (counts[sin] === undefined) continue;
          counts[sin]++;
          totals[sin]++;
          personaSets[sin].add(persona.key);
        }
      }
    }

    return {
      key: entry.key,
      slot: index + 1,
      persona,
      counts,
      total: Object.values(counts).reduce((sum, value) => sum + value, 0),
    };
  });

  const personaCounts = Object.fromEntries(
    SIN_ORDER.map((sin) => [sin, personaSets[sin].size]),
  );

  return {
    totals,
    personaCounts,
    rows,
    grandTotal: Object.values(totals).reduce((sum, value) => sum + value, 0),
  };
}

function colorPattern(persona) {
  return persona.slots.map((slot) => {
    const indexes = slotColors(slot)
      .map((sin) => SIN_ORDER.indexOf(sin))
      .filter((index) => index >= 0);
    return indexes.length ? Math.min(...indexes) : 99;
  });
}

export function sortParty(party, mode, selectedSin, personaMap, selectedSkill = 'all') {
  const copy = [...party];
  const originalIndex = new Map(party.map((entry, index) => [entry.key, index]));
  const persona = (entry) => personaMap.get(entry.key);
  const fallback = (a, b) => originalIndex.get(a.key) - originalIndex.get(b.key);
  const selectedSkillIndex = /^S[0-4]$/.test(selectedSkill) ? Number(selectedSkill.slice(1)) : -1;
  const selectedSkillMatch = (target) => {
    if (selectedSkillIndex < 0) return 0;
    const identity = persona(target);
    const slot = identity?.slots?.find((item) => item.rank === selectedSkill) ?? identity?.slots?.[selectedSkillIndex];
    return slotColors(slot).includes(selectedSin) ? 1 : 0;
  };
  const noCompare = (a, b) => {
    const pa = persona(a);
    const pb = persona(b);
    const kindA = pa?.kind === 'tokui' ? 1 : 0;
    const kindB = pb?.kind === 'tokui' ? 1 : 0;
    return kindA - kindB || (pa?.no ?? 0) - (pb?.no ?? 0);
  };

  switch (mode) {
    case 'no-asc':
      copy.sort((a, b) => noCompare(a, b) || fallback(a, b));
      break;
    case 'no-desc':
      copy.sort((a, b) => -noCompare(a, b) || fallback(a, b));
      break;
    case 'name':
      copy.sort((a, b) => String(persona(a)?.name ?? '').localeCompare(String(persona(b)?.name ?? ''), 'ja') || fallback(a, b));
      break;
    case 'hp-desc':
      copy.sort((a, b) => (persona(b)?.hp ?? 0) - (persona(a)?.hp ?? 0) || fallback(a, b));
      break;
    case 'san-desc':
      copy.sort((a, b) => (persona(b)?.san ?? 0) - (persona(a)?.san ?? 0) || fallback(a, b));
      break;
    case 'speed-desc':
      copy.sort((a, b) => (persona(b)?.speedAvg ?? 0) - (persona(a)?.speedAvg ?? 0) || fallback(a, b));
      break;
    case 'color':
      if (selectedSin) {
        copy.sort((a, b) => {
          const pa = persona(a);
          const pb = persona(b);
          return (selectedSkillIndex >= 0 ? selectedSkillMatch(b) - selectedSkillMatch(a) : 0)
            || countColor(pb, selectedSin) - countColor(pa, selectedSin)
            || totalColors(pb) - totalColors(pa)
            || fallback(a, b);
        });
      }
      break;
    case 'pattern':
      copy.sort((a, b) => {
        const patternA = colorPattern(persona(a));
        const patternB = colorPattern(persona(b));
        for (let i = 0; i < Math.max(patternA.length, patternB.length); i++) {
          if ((patternA[i] ?? 99) !== (patternB[i] ?? 99)) {
            return (patternA[i] ?? 99) - (patternB[i] ?? 99);
          }
        }
        return fallback(a, b);
      });
      break;
    case 'default':
    default:
      break;
  }

  return copy;
}

export function sortResources(totals, personaCounts, mode) {
  const list = SIN_ORDER.map((sin, index) => ({
    sin,
    index,
    total: totals[sin] ?? 0,
    personas: personaCounts[sin] ?? 0,
    ...SIN_META[sin],
  }));

  switch (mode) {
    case 'count-asc':
      list.sort((a, b) => a.total - b.total || a.personas - b.personas || a.index - b.index);
      break;
    case 'personas-desc':
      list.sort((a, b) => b.personas - a.personas || b.total - a.total || a.index - b.index);
      break;
    case 'sin-order':
      list.sort((a, b) => a.index - b.index);
      break;
    case 'name':
      list.sort((a, b) => a.sin.localeCompare(b.sin, 'ja') || a.index - b.index);
      break;
    case 'count-desc':
    default:
      list.sort((a, b) => b.total - a.total || b.personas - a.personas || a.index - b.index);
      break;
  }

  return list;
}

export function normalizePersonaName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/の人格$/u, '')
    .replace(/[：:・._\-–—]/g, '')
    .toLowerCase();
}

export function resolvePersona(personas, { name = '', no = '', key = '', kind = '' } = {}) {
  const rawName = String(name ?? '').trim();
  const rawKey = String(key ?? '').trim();
  const rawKind = String(kind ?? '').trim().normalize('NFKC');
  const digits = String(no ?? '').match(/\d+/)?.[0];
  const numeric = digits === undefined ? null : Number(digits);

  // A key from this browser's local persona library is the only unambiguous
  // portable-in-the-same-profile reference for synced/custom variants.
  if (rawKey) {
    const exact = personas.find((persona) => persona.key === rawKey);
    if (exact) {
      if (rawName && normalizePersonaName(exact.name) !== normalizePersonaName(rawName)) {
        return { error: `人格キー「${rawKey}」と名前「${rawName}」が一致しません。` };
      }
      return { persona: exact };
    }
  }

  const matchesKind = (persona) => {
    if (!rawKind) return true;
    if (/同期/u.test(rawKind)) return persona.variantType === 'sync';
    if (/創作|カスタム|手動/u.test(rawKind)) {
      return persona.variantType === 'custom' || persona.variantType === 'manual' || persona.kind === 'custom';
    }
    if (/特異/u.test(rawKind)) return persona.kind === 'tokui';
    if (/通常/u.test(rawKind)) return persona.kind === 'normal' && persona.variantType !== 'sync';
    return true;
  };

  let nameMatches = [];
  if (rawName) {
    nameMatches = personas.filter((persona) => persona.name === rawName && matchesKind(persona));
    if (nameMatches.length === 0) {
      const normalized = normalizePersonaName(rawName);
      nameMatches = personas.filter((persona) => normalizePersonaName(persona.name) === normalized && matchesKind(persona));
    }
  }

  let numberMatches = [];
  if (numeric !== null) {
    numberMatches = personas.filter((persona) => matchesKind(persona)
      && ((persona.kind === 'normal' && persona.no === numeric)
        || (persona.kind === 'tokui' && persona.no === numeric - 110)));
  }

  if (nameMatches.length === 1 && numberMatches.length === 1) {
    if (nameMatches[0].key === numberMatches[0].key) return { persona: nameMatches[0] };
    return {
      error: `番号 ${numeric}（${numberMatches[0].name}）と名前「${rawName}」が一致しません。`,
    };
  }

  if (nameMatches.length > 1) {
    return {
      error: `「${rawName}」は複数の人格に一致します: ${nameMatches.map((persona) => `${persona.kind === 'tokui' ? '特異' : '通常'} No.${persona.no}`).join(', ')}`,
    };
  }

  if (numberMatches.length > 1) {
    if (nameMatches.length === 1 && numberMatches.some((persona) => persona.key === nameMatches[0].key)) {
      return { persona: nameMatches[0] };
    }
    return {
      error: `番号 ${numeric} は通常 No.${numeric} と特異 No.${numeric - 110} の両方に一致します。人格名も入力してください。`,
    };
  }

  if (numberMatches.length === 1) return { persona: numberMatches[0] };
  if (nameMatches.length === 1) return { persona: nameMatches[0] };

  return { error: `人格を特定できません（番号: ${no || '空'} / 名前: ${rawName || '空'}）` };
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (character !== '\r') {
      field += character;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function findHeader(rows) {
  return rows.findIndex((row) => row.some((cell) => /人格番号|人格名/u.test(String(cell))));
}

export function parsePartySheet(text, personas) {
  const source = String(text ?? '');
  if (!source.trim()) return { party: [], errors: ['貼り付け内容が空です。'] };
  if (source.length > MAX_IMPORT_CHARS) {
    return { party: [], errors: ['貼り付け内容が長すぎます。最大20,000文字まで取り込めます。'] };
  }

  const firstLine = source.split(/\r?\n/).find((line) => line.trim()) ?? '';
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  const rows = parseDelimited(source, delimiter);
  if (rows.length > MAX_IMPORT_ROWS) {
    return { party: [], errors: ['行数が多すぎます。最大200行まで取り込めます。'] };
  }
  const headerIndex = findHeader(rows);
  if (headerIndex < 0) {
    return { party: [], errors: ['「人格番号」または「人格名」を含むヘッダー行が見つかりません。'] };
  }

  const header = rows[headerIndex].map((cell) => String(cell).trim());
  const column = (pattern) => header.findIndex((cell) => pattern.test(cell));
  const noIndex = column(/人格番号/u);
  const nameIndex = column(/人格名/u);
  const keyIndex = column(/^人格キー$|^persona\s*key$/iu);
  const kindIndex = column(/^種別$|^人格種別$/u);

  if (noIndex < 0 && nameIndex < 0) {
    return { party: [], errors: ['「人格番号」または「人格名」の列がありません。'] };
  }

  const party = [];
  const errors = [];

  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex].map((cell) => String(cell).trim());
    if (row.every((cell) => !cell)) continue;
    if (row.some((cell) => /総保有罪悪属性|使い方/u.test(cell))) break;

    const no = noIndex >= 0 ? row[noIndex] : '';
    const name = nameIndex >= 0 ? row[nameIndex] : '';
    const key = keyIndex >= 0 ? row[keyIndex] : '';
    const kind = kindIndex >= 0 ? row[kindIndex] : '';
    if (/^#N\/A$/i.test(no) || /^#N\/A$/i.test(name)) continue;
    if (!key && !no && !name) continue;

    const resolved = resolvePersona(personas, { key, name, no, kind });
    if (resolved.error) {
      errors.push(`${rowIndex + 1}行目: ${resolved.error}`);
      continue;
    }

    if (party.some((entry) => entry.key === resolved.persona.key)) {
      errors.push(`${rowIndex + 1}行目: ${resolved.persona.name} が重複しています。`);
      continue;
    }

    party.push({ key: resolved.persona.key });
  }

  if (party.length === 0 && errors.length === 0) {
    errors.push('人格行を読み取れませんでした。');
  }
  if (party.length > MAX_PARTY) {
    errors.push(`編成は最大 ${MAX_PARTY} 名です（読み取り: ${party.length} 名）。`);
  }

  return { party, errors };
}

export function makePersonaMap(personas) {
  return new Map(personas.map((persona) => [persona.key, persona]));
}
