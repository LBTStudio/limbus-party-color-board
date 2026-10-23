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

if (keys.length === 0 || keys.some((key) => !/^[nt]\d+$/.test(key))) {
  throw new Error('Persona key catalog is empty or has an unexpected format; seed was not written.');
}

const values = keys.map((key) => \`  ('\${key}')\`).join(',\n');
const arrayValues = keys.map((key) => \`'\${key}'\`).join(', ');
const sql = \`-- Generated from data/personas.json. Run after migrations when the persona catalog changes.
begin;
delete from public.party_persona_keys
where not (persona_key = any (array[\${arrayValues}]::text[]));
insert into public.party_persona_keys (persona_key) values
\${values}
on conflict (persona_key) do nothing;
commit;
\`;
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, sql);
console.log(\`Synchronized \${keys.length} persona keys in \${path.relative(root, outputPath)}\`);
