// The launcher icon is the owner-picked avatar V1 rendered as adaptive layers (tools/launcher-icon/README.md).
// These pins exist so a "quick fix" cannot silently swap the icon back to the old square, resize a density, or point the
// adaptive XML at a colour again (that would drop the glow the owner approved): the set is regenerated, never edited.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = path.join(ROOT, 'app/src/main/res');
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const PINNED = JSON.parse(readFileSync(path.join(ROOT, 'tools/launcher-icon/pinned-hashes.json'), 'utf8'));

function pngSize(file) {
  const b = readFileSync(file);
  assert.equal(b.toString('ascii', 1, 4), 'PNG', `${file} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

test('every density carries a 108 dp adaptive foreground + background and 48 dp legacy icons with alpha', () => {
  for (const [name, m] of Object.entries(DENSITIES)) {
    const dir = path.join(RES, `mipmap-${name}`);
    for (const n of ['ic_launcher_foreground.png', 'ic_launcher_background.png']) {
      const s = pngSize(path.join(dir, n));
      assert.deepEqual([s.width, s.height], [108 * m, 108 * m], `${name}/${n} must be the 108 dp adaptive canvas`);
    }
    for (const n of ['ic_launcher.png', 'ic_launcher_round.png']) {
      const s = pngSize(path.join(dir, n));
      assert.deepEqual([s.width, s.height], [48 * m, 48 * m], `${name}/${n} must be the 48 dp legacy size`);
      assert.equal(s.colorType, 6, `${name}/${n} keeps an alpha channel (round icons need it)`);
    }
  }
});

test('the adaptive icon XML composes the PNG background layer (the navy glow), not a flat colour', () => {
  for (const n of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const xml = readFileSync(path.join(RES, 'mipmap-anydpi-v26', n), 'utf8');
    assert.match(xml, /<background android:drawable="@mipmap\/ic_launcher_background"\/>/, `${n} background layer`);
    assert.match(xml, /<foreground android:drawable="@mipmap\/ic_launcher_foreground"\/>/, `${n} foreground layer`);
  }
});

test('the installed set is byte-identical to the owner-picked V1 render (regenerate, never hand-edit)', () => {
  for (const [key, expected] of Object.entries(PINNED)) {
    const [d, n] = key.split('/');
    const actual = createHash('sha256').update(readFileSync(path.join(RES, `mipmap-${d}`, n))).digest('hex');
    assert.equal(actual, expected, `${key} differs from the pinned V1 render`);
  }
  assert.equal(Object.keys(PINNED).length, 20);
});
