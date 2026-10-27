import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PARTY,
  SIN_ORDER,
  aggregate,
  makePersonaMap,
  parseSpeedAverage,
} from '../js/core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const args = process.argv.slice(2);
const dbArgIndex = args.indexOf('--db');
const dbPath = path.resolve(
  dbArgIndex >= 0 ? args[dbArgIndex + 1] : (process.env.LBT_DB || path.join(repoRoot, '..', 'LIMBUS_BUILD_TERMINAL', 'data', 'db.json')),
);
const lbtRoot = path.resolve(path.dirname(dbPath), '..');

function readVersion() {
  try {
    const readme = fs.readFileSync(path.join(lbtRoot, 'README.md'), 'utf8');
    return readme.match(/^#\s+LIMBUS BUILD TERMINAL\s+(v[\w.]+)/m)?.[1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function extractSlots(persona) {
  const slots = [];
  for (let index = 0; index < 5; index++) {
    const exact = persona.skills.filter((skill) => skill.rank === `スキル${index}`);
    const derived = persona.skills.filter((skill) => skill.rank.startsWith(`スキル${index}-`));
    const chosen = exact.length > 0 ? exact : derived;
    if (chosen.length === 0) {
      throw new Error(`${persona.name}: スキル${index} が見つかりません`);
    }
    // Some LBT identities have only -1/-2 variants and no unsuffixed root row.
    // Use the first variant as the visible skill, and retain later names separately.
    const displaySkills = exact.length > 0 ? exact : chosen.slice(0, 1);
    const derivedNames = exact.length > 0 ? derived : chosen.slice(1);
    slots.push({
      rank: `S${index}`,
      name: [...new Set(displaySkills.map((skill) => skill.name))].join(' / '),
      type: [...new Set(chosen.map((skill) => skill.type))].join(' / '),
      colors: [...new Set([...exact, ...derived].map((skill) => skill.sin))],
      derivedNames: [...new Set(derivedNames.map((skill) => skill.name))],
    });
  }
  return slots;
}

function toPersona(persona, kind) {
  const slots = extractSlots(persona);
  for (const slot of slots) {
    for (const color of slot.colors) {
      if (!SIN_ORDER.includes(color)) {
        throw new Error(`${persona.name}: 未知の罪悪属性 ${color}`);
      }
    }
  }
  return {
    key: `${kind === 'tokui' ? 't' : 'n'}${persona.no}`,
    kind,
    no: persona.no,
    name: persona.name,
    hp: persona.hp,
    san: persona.san,
    speed: persona.speed,
    speedAvg: parseSpeedAverage(persona.speed),
    resSlash: persona.res_slash ?? '',
    resPierce: persona.res_pierce ?? '',
    resBlunt: persona.res_blunt ?? '',
    keywords: Array.isArray(persona.keywords) ? persona.keywords : [],
    affiliation: persona.affiliation ?? '',
    passiveName: persona.passive_name ?? '',
    passiveCond: persona.passive_cond ?? '',
    slots,
  };
}

if (!fs.existsSync(dbPath)) {
  console.error(`DB が見つかりません: ${dbPath}`);
  console.error('--db か環境変数 LBT_DB で LIMBUS_BUILD_TERMINAL/data/db.json を指定してください。');
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const personas = [
  ...db.normal_personas.map((persona) => toPersona(persona, 'normal')),
  ...db.tokui_personas.map((persona) => toPersona(persona, 'tokui')),
];

const payload = {
  meta: {
    source: 'LIMBUS BUILD TERMINAL',
    sourceVersion: readVersion(),
    sourceRepo: 'https://github.com/LBTStudio/LIMBUS_BUILD_TERMINAL',
    normalCount: db.normal_personas.length,
    tokuiCount: db.tokui_personas.length,
    sinOrder: SIN_ORDER,
    defaultParty: DEFAULT_PARTY,
    note: '戦術0〜4の罪悪属性を1スロット1資源として集計。二属性スキルは両方に数える。',
  },
  personas,
};

const outputPath = path.join(repoRoot, 'data', 'personas.json');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

const map = makePersonaMap(personas);
const totals = aggregate(DEFAULT_PARTY, map);
console.log(`wrote ${outputPath}`);
console.log(`personas: ${personas.length} (normal ${db.normal_personas.length} / tokui ${db.tokui_personas.length})`);
console.log(`default party: ${DEFAULT_PARTY.map((entry) => map.get(entry.key)?.name ?? entry.key).join(' / ')}`);
console.log(`default totals: ${SIN_ORDER.map((sin) => `${sin} ${totals.totals[sin]}(${totals.personaCounts[sin]})`).join(', ')}`);
console.log(`bytes: ${fs.statSync(outputPath).size}`);
