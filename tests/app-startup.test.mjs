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


test('deleting an added persona protects persisted personal and active shared parties', () => {
  const deleteStart = app.indexOf('function deleteLocalPersona(key)');
  const deleteEnd = app.indexOf('\nfunction choosePersona(', deleteStart);
  const deletion = app.slice(deleteStart, deleteEnd);
  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
  assert.match(deletion, /window\.sharedPartySession\?\.isActive/);
  assert.match(deletion, /window\.sharedPartySession\.personalPartySnapshot/);
  assert.match(deletion, /savedPersonalKeys\.some\(\(entry\) =>/);
  assert.match(deletion, /const storedParty = readStored\(\)\?\.party/);
  assert.match(deletion, /persistedPartyKeys\.includes\(key\)/);
  assert.ok(
    deletion.indexOf('savedPersonalKeys.some') < deletion.indexOf('saveLocalPersonas('),
    'protect the saved lineup before mutating the local persona library',
  );
  assert.ok(
    deletion.indexOf('persistedPartyKeys.includes(key)') < deletion.indexOf('saveLocalPersonas('),
    'protect the stored party even when the current URL displays a different party',
  );
});

test('UI documents the local persona library cap separately from party and collaboration caps', () => {
  assert.match(html, /追加人格ライブラリの上限は、このブラウザにつき最大300件/);
  assert.match(html, /1つの編成に配置できる人格は最大20名、共同編集スペースの参加者は発行者を含め最大20名/);
  assert.match(html, /上限は既存分を含め最大300件です/);
});

test('manual and LBT imports do not bypass the local-persona cap through memory-only fallback', () => {
  const manualStart = app.indexOf('function saveManualPersonaFromDialog()');
  const manualEnd = app.indexOf('\nfunction renderPickerList(', manualStart);
  const manual = app.slice(manualStart, manualEnd);
  assert.ok(manualStart >= 0 && manualEnd > manualStart);
  assert.match(manual, /failure\?\.code === 'LOCAL_PERSONA_LIMIT'/);
  assert.ok(
    manual.indexOf("failure?.code === 'LOCAL_PERSONA_LIMIT'") < manual.indexOf('state.localPersonas = [...state.localPersonas.filter'),
    'manual persona creation must reject the cap before memory-only fallback',
  );

  const importStart = app.indexOf('function applyLbtPersonaImport()');
  const importEnd = app.indexOf('\nfunction renderManualSkillFields(', importStart);
  const importer = app.slice(importStart, importEnd);
  assert.ok(importStart >= 0 && importEnd > importStart);
  assert.match(importer, /error\?\.code === 'LOCAL_PERSONA_LIMIT'/);
  assert.ok(
    importer.indexOf("error?.code === 'LOCAL_PERSONA_LIMIT'") < importer.indexOf('mergeLocalPersonasInMemory(selected)'),
    'LBT import must reject the cap before memory-only fallback',
  );
});

test('shared persona snapshots warn once when local persistence fails and recover after a successful save', () => {
  const start = app.indexOf('function applySharedPartySnapshot(');
  const end = app.indexOf('\nfunction currentPartySnapshotSize()', start);
  const snapshot = app.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(snapshot, /state\.localPersonas = saveLocalPersonas\(browserStorage\(\), nextLocal\)/);
  assert.match(snapshot, /sharedPersonaPersistenceWarningShown = false/);
  assert.match(snapshot, /state\.localPersonas = nextLocal/);
  assert.match(snapshot, /if \(incoming\.length && !sharedPersonaPersistenceWarningShown\)/);
  assert.match(snapshot, /共有の追加人格をブラウザに保存できませんでした/);
  assert.ok(
    snapshot.indexOf('state.localPersonas = nextLocal') < snapshot.indexOf('showToast('),
    'keep the validated remote copy usable in the current tab even when persistence fails',
  );
});

test('saveState warns once when a local-only lineup cannot be persisted and clears the warning after recovery', () => {
  const start = app.indexOf('function saveState()');
  const end = app.indexOf('\nfunction init(', start);
  const save = app.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(save, /let storageSaved = false/);
  assert.match(save, /storageSaved = true/);
  assert.match(save, /hasLocalOnlySnapshot/);
  assert.match(save, /localOnlyPersistenceWarningShown/);
  assert.match(save, /追加人格を含む編成はURLに退避できない/);
  assert.ok(
    save.indexOf('localStorage.setItem(STORAGE_KEY') < save.indexOf('hasLocalOnlySnapshot'),
    'check persistence before silently omitting the lineup from URL fallback',
  );
});

test('LBT identity imports save active-party snapshot changes and block read-only visual divergence', () => {
  const start = app.indexOf('function applyLbtPersonaImport()');
  const end = app.indexOf('\nfunction renderManualSkillFields(', start);
  const importer = app.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(importer, /sharedSession\?\.isActive && !sharedSession\.canEdit\(\)/);
  assert.match(importer, /wouldChangeSharedIdentity/);
  assert.match(importer, /閲覧中の共有編成で使用している人格は更新できません/);
  assert.ok(
    importer.indexOf('const wouldChangeSharedIdentity') < importer.indexOf('importLocalPersonas(browserStorage(), selected)'),
    'read-only sessions must reject an overwrite before persisting local data',
  );
  assert.ok(
    importer.indexOf('renderAll();') < importer.indexOf('sharedSession.onPartyChanged()'),
    'notify the shared save controller after an editable active-party identity is refreshed',
  );
});

test('copied TSV cells are escaped against spreadsheet formula interpretation', () => {
  assert.match(app, /escapeSpreadsheetCell,/);
  assert.match(app, /row\.map\(escapeSpreadsheetCell\)/);
  assert.doesNotMatch(app, /row\.map\(\(value\) => String\(value \?\? ''\)\.replace\(/);
});

test('numbered color strip maps indices above the unchanged 4px S0-S4 bar', () => {
  assert.match(html, /色帯の上にある数字0〜4は、左からS0→S4/);
  assert.match(app, /const stripLabels = persona\.slots\.map\(\(skillSlot, index\)/);
  assert.match(app, /class="color-strip-indexes" aria-hidden="true">\$\{stripLabels\}/);
  assert.match(app, /class="color-strip" role="img" aria-label="色帯上の数字0〜4は、左からS0〜S4/);
  assert.match(styles, /\.color-strip-indexes \{[\s\S]*?display: flex;[\s\S]*?\.color-strip \{\s*display: flex;\s*height: 4px;/);
  assert.match(styles, /\.color-strip-wrap \{\s*margin: -3px 0 1px;[\s\S]*?\.color-strip \{\s*display: flex;\s*height: 4px;[\s\S]*?margin: 0;/);
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

test('party member PL names persist in the matrix and detail cards show speed and resistances instead of HP/SAN', () => {
  const matrixStart = app.indexOf('function renderMatrix()');
  const partyStart = app.indexOf('function renderParty()');
  const partyEnd = app.indexOf('function syncControls()', partyStart);
  const detail = app.slice(partyStart, partyEnd);
  const saveStart = app.indexOf('function saveState()');
  const saveEnd = app.indexOf('function readUrlKeys()', saveStart);
  const save = app.slice(saveStart, saveEnd);
  assert.ok(matrixStart >= 0 && partyStart > matrixStart && partyEnd > partyStart);
  assert.match(app.slice(matrixStart, partyStart), /entry\.playerName \|\| 'PL未設定'/);
  assert.match(detail, /data-player-name-index/);
  assert.match(detail, /persona\.speed/);
  assert.match(detail, /persona\.resSlash/);
  assert.match(detail, /persona\.resPierce/);
  assert.match(detail, /persona\.resBlunt/);
  assert.doesNotMatch(detail, /<dt>HP<\/dt>|<dt>SAN<\/dt>/);
  assert.match(save, /playerName: sanitizePlayerName\(entry\.playerName\)/);
  assert.match(app, /getPartyEntries: \(\) => state\.party\.map/);
  assert.match(app, /assignmentOnly: true/);
  assert.match(app, /playerNamesByKey/);
  assert.match(styles, /\.card-player-input/);
  assert.match(styles, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test('PL-name edit uses the normal persistence and shared-session save path', () => {
  const start = app.indexOf("$('#party-cards').addEventListener('change'");
  const end = app.indexOf("$('#reset-party').addEventListener", start);
  const handler = app.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(handler, /data-player-name-index/);
  assert.match(handler, /entry\.playerName = sanitizePlayerName\(input\.value\)/);
  assert.match(handler, /saveState\(\)/);
  assert.match(handler, /renderMatrix\(\)/);
  assert.match(handler, /canEditParty\(\)/);
  assert.doesNotMatch(handler, /renderAll\(\)/, 'do not replace the input/button while the user is clicking away');
});
