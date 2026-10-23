import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = path.join(root, 'data/personas.json');
const outputPath = path.join(root, 'supabase/seed-persona-keys.sql');
const { personas } = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const keys = [...new Set(personas.map((persona) => persona.key))].sort((a, b) => {
  const prefix = a[0].localeCompare(b[0]);
  return prefix || Number(a.slice(1)) - Number(b.slice(1));
});

if (keys.some((key) => !/^[nt]\d+$/.test(key))) {
  throw new Error('Unexpected persona key format; seed was not written.');
}

const values = keys.map((key) => `  ('${key}')`).join(',\n');
const sql = `-- Generated from data/personas.json. Apply after migration when persona keys change.
insert into public.party_persona_keys (persona_key) values
${values}
on conflict (persona_key) do nothing;
`;
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, sql);
console.log(`Wrote ${keys.length} persona keys to ${path.relative(root, outputPath)}`);
