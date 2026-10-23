import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.mjs', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('startup sync updates every picker mode button without throwing', () => {
  const match = app.match(/function syncPickerMode\(\) \{([\s\S]*?)\n\}/);
  assert.ok(match, 'syncPickerMode exists');
  assert.match(
    match[1],
    /for\s*\(const button of \$\$\('\[data-picker-mode\]'\)\)/,
    'all matching buttons must use querySelectorAll via $$',
  );
  assert.doesNotMatch(
    match[1],
    /for\s*\(const button of \$\('\[data-picker-mode\]'\)\)/,
    'a single HTMLElement is not iterable',
  );
  assert.match(app, /function syncControls\(\) \{[\s\S]*?syncPickerMode\(\);[\s\S]*?\}/);
  assert.equal((html.match(/data-picker-mode=/g) || []).length, 4, 'all four filter buttons exist');
});


test('deleting an added persona cannot remove one referenced by the saved personal party during collaboration', () => {
  const deleteStart = app.indexOf('function deleteLocalPersona(key)');
  const deleteEnd = app.indexOf('\nfunction choosePersona(', deleteStart);
  const deletion = app.slice(deleteStart, deleteEnd);
  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
  assert.match(deletion, /window\.sharedPartySession\?\.isActive/);
  assert.match(deletion, /window\.sharedPartySession\.personalPartySnapshot/);
  assert.match(deletion, /savedPersonalKeys\.includes\(key\)/);
  assert.ok(
    deletion.indexOf('savedPersonalKeys.includes(key)') < deletion.indexOf('saveLocalPersonas('),
    'protect the saved lineup before mutating the local persona library',
  );
});

test('party color strip retains the compact legacy design and explains the S0-S4 order', () => {
  assert.match(html, /色帯は左からS0→S4の順です/);
  assert.match(app, /class="color-strip" role="img" aria-label="色帯は左からS0、S1、S2、S3、S4の罪悪属性です"/);
  assert.match(app, /<span style="background:\$\{gradientFor\(skillSlot\.colors\)\}" title="\$\{escapeHtml\(label\)\}"><\/span>/);
  assert.match(styles, /\.color-strip \{\s*display: flex;\s*height: 4px;[\s\S]*?\.color-strip span \{\s*flex: 1 1 0;/);
  assert.doesNotMatch(app, /color-strip-slot/);
  assert.doesNotMatch(styles, /color-strip-slot/);
});

test('passive resource costs and skill-specific resource sorting are wired into the UI', () => {
  assert.match(html, /id="skill-sort-slot"/);
  assert.match(html, /資源色ソートの対象スキル/);
  assert.match(app, /function renderPassiveCondition\(condition\)/);
  assert.match(app, /class="passive-sin"/);
  assert.match(app, /state\.skillSortSlot/);
  assert.match(app, /sortParty\(state\.party, state\.partySort, state\.selectedSin, state\.map, state\.skillSortSlot\)/);
  assert.match(styles, /\.passive-sin \{/);
});
