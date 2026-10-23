import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../js/app.mjs', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

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
