import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { craftSuccessImage, serviceAssetEntries, composeServiceMetadata } from './service-catalog.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('exporter selects composed tables, retains the legacy graph path, and refuses partial composed sources', async () => {
  // Evaluate the exporter's actual predicate, following service-catalog.test.mjs;
  // neither the exporter nor source modules are imported or an asset pack generated.
  const exporter = await readFile(new URL('./export-client-pack.mjs', import.meta.url), 'utf8');
  const selection = exporter.match(/^const composedServices = (.+);$/m);
  assert.ok(selection, 'the exporter must declare its composedServices selection');
  assert.match(exporter, /^const phaseEArt = phaseEServices && !composedServices \? await load\('packages\/shared\/src\/phaseEArt\.ts'\) : undefined;$/m);
  const select = (phaseEServices, meta) => new Function('phaseEServices', 'meta', `return ${selection[1]};`)(phaseEServices, meta);
  const keys = ['peServiceBuildings', 'peHarvesters', 'peMarket', 'peStarterFleet', 'peAdvancedFleet'];
  const composed = Object.fromEntries(keys.map(key => [key, {}]));
  assert.equal(select(true, composed), true);
  assert.equal(select(false, composed), false, 'without the services flag no composed services path is selected');
  for (const key of keys) for (const value of [{}, null, undefined])
    assert.equal(select(true, { [key]: value }), true, `${key} presence cannot silently fall back to the legacy module`);
  // The legacy 6f7a9e81 graph table shape; synthetic empty tables are selection inputs only.
  const legacy = { peClips: {}, peAppearances: {}, peEffects: {} };
  assert.equal(select(true, legacy), false);
  assert.equal(select(false, legacy), false);
  const partial = { peServiceBuildings: { schemaVersion: 1, sourceScale: 1, sourceIndexBase: 0, keyIndexBase: 1 } };
  assert.equal(select(true, partial), true);
  const still = { path: 'production-assets/shared-fx/craft-success/frames/frame-00.png', sha256: sha(Buffer.from('synthetic still')), bytes: 1 };
  assert.throws(() => composeServiceMetadata(partial, still), /composed source table header/);
});

test('craft-success descriptor binds the separately supplied manifest frame-zero bytes', () => {
  const bytes = Buffer.from('synthetic still'), effect = { id: 'craft-success', reducedMotion: 'craft-success/frames/frame-00.png', frameHashes: [sha(bytes)] };
  const manifest = { schemaVersion: 1, exportFrameIndices: [1, 2, 3, 4, 5, 6, 7, 8], effects: [effect] };
  const info = { format: 'png', width: 64, height: 64, depth: 'uchar', hasAlpha: true };
  assert.deepEqual(craftSuccessImage(manifest, bytes, info), { path: 'production-assets/shared-fx/craft-success/frames/frame-00.png', sha256: sha(bytes), bytes: bytes.length });
  for (const changed of [Buffer.from('animation cell zero'), Buffer.alloc(0)]) assert.throws(() => craftSuccessImage(manifest, changed, info));
  assert.throws(() => craftSuccessImage(manifest, bytes, { ...info, width: 112 }));
  assert.throws(() => craftSuccessImage({ ...manifest, effects: [effect, effect] }, bytes, info));
  assert.throws(() => craftSuccessImage({ ...manifest, exportFrameIndices: [0, 1, 2, 3, 4, 5, 6, 7] }, bytes, info));
});

test('source collisions are archived byte-for-byte and unrelated optional families keep their paths', () => {
  const source = new Map([['atlas/pe_market_t1@1x.json', Buffer.from('original market')], ['atlas/pe_cosmetics@1x.png', Buffer.from('cosmetics')]]);
  const projected = new Map([['atlas/pe_market_t1@1x.json', Buffer.from('normalized market')], ['atlas/pe_fleet_berths@1x.png', Buffer.from('berths')]]);
  const rows = serviceAssetEntries(source, projected), result = new Map(rows);
  assert.equal(result.size, source.size + projected.size);
  assert.equal(result.get('atlas/source-phase-e/pe_market_t1@1x.json').toString(), 'original market');
  assert.equal(result.get('atlas/pe_market_t1@1x.json').toString(), 'normalized market');
  assert.equal(result.get('atlas/pe_cosmetics@1x.png').toString(), 'cosmetics');
  assert.deepEqual(rows.map(([path]) => path), [...result.keys()].sort());
  assert.deepEqual([...serviceAssetEntries(source, new Map())], [...source].sort(([a], [b]) => a.localeCompare(b)));
  assert.throws(() => serviceAssetEntries(new Map([['../escape', Buffer.from('bad')]]), projected));
});
