// This codec is a byte-preserving test double, not evidence of actual PNG decoding.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { projectServiceAssets } from './service-catalog.mjs';

const projectionSha = bytes => createHash('sha256').update(bytes).digest('hex');
const projectionImage = ({ data, width, height }) => Buffer.concat([
  Buffer.from(JSON.stringify({ width, height }) + '\n'), data,
]);
function projectionDecode(bytes) {
  const end = bytes.indexOf(10), size = JSON.parse(bytes.subarray(0, end));
  return { ...size, data: Buffer.from(bytes.subarray(end + 1)) };
}
function projectionCodec() {
  return {
    inspectPng: async bytes => ({ format: 'png', ...projectionDecode(bytes), depth: 'uchar', hasAlpha: true }),
    decodePng: async bytes => projectionDecode(bytes),
    encodePng: async image => projectionImage(image),
  };
}
function projectionFixture() {
  const frames = [], assets = new Map(), expected = new Map();
  for (const [familyIndex, family] of ['starter', 'survey-balloon', 'cargo-cutter', 'courier-airship', 'expedition-barge'].entries()) {
    const sourceGroup = family === 'starter' ? 'pe_fleet_starter' : `pe_berth_${family.replaceAll('-', '_')}`;
    const states = ['intact_f1', 'damaged_f1', 'destroyed_f1', ...Array.from({ length: 8 }, (_, i) => `ambient_f${i + 1}`)];
    const width = states.length * 2, height = 2, data = Buffer.alloc(width * height * 4), cells = [];
    for (const [index, state] of states.entries()) {
      const sourceKey = `pe_berth_${family.replaceAll('-', '_')}_${state}`, key = `pe_berth_${family}_${state}`;
      // Nonzero RGB under zero alpha must survive unchanged.
      const rgba = Buffer.from([familyIndex + 1, index + 2, 91, 0, 31, 42, 53, 255, 61, 72, 83, 255, 9, 8, 7, 0]);
      for (let row = 0; row < 2; row++) rgba.copy(data, (row * width + index * 2) * 4, row * 8, (row + 1) * 8);
      cells.push({ filename: sourceKey, rotated: false, trimmed: false,
        sourceSize: { w: 2, h: 2 }, spriteSourceSize: { x: 0, y: 0, w: 2, h: 2 },
        frame: { x: index * 2, y: 0, w: 2, h: 2 } });
      frames.push({ key, group: 'pe_fleet_berths', sourceAtlasPath: `atlas/${sourceGroup}@1x.json`, sourceKey,
        width: 2, height: 2, rgbaSha256: projectionSha(rgba) });
      expected.set(key, rgba);
    }
    assets.set(`atlas/${sourceGroup}@1x.json`, Buffer.from(JSON.stringify({ textures: [{ image: `${sourceGroup}@1x.png`,
      format: 'RGBA8888', size: { w: width, h: height }, scale: 1, frames: cells }] })));
    assets.set(`atlas/${sourceGroup}@1x.png`, projectionImage({ data, width, height }));
  }
  return { frames, assets, ...projectionCodec(), expected };
}
function projectionEditAtlas(input, edit) {
  const name = input.frames[0].sourceAtlasPath, json = JSON.parse(input.assets.get(name));
  edit(json.textures[0], json); input.assets.set(name, Buffer.from(JSON.stringify(json)));
}
function projectionExtract(image, rect) {
  const cell = Buffer.alloc(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) image.data.copy(cell, y * rect.w * 4,
    ((rect.y + y) * image.width + rect.x) * 4, ((rect.y + y) * image.width + rect.x + rect.w) * 4);
  return cell;
}

test('projection regroups 55 explicitly selected berth cells with deterministic names, raw pixels and zero padding', async () => {
  const input = projectionFixture(), originals = new Map([...input.assets].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const originalFrames = structuredClone(input.frames), result = await projectServiceAssets(input);
  assert.deepEqual([...result.keys()], ['atlas/pe_fleet_berths@1x.json', 'atlas/pe_fleet_berths@1x.png']);
  assert.deepEqual(input.assets, originals); assert.deepEqual(input.frames, originalFrames);
  const [texture] = JSON.parse(result.get('atlas/pe_fleet_berths@1x.json')).textures;
  const image = projectionDecode(result.get('atlas/pe_fleet_berths@1x.png'));
  assert.equal(texture.frames.length, 55); assert.equal(texture.format, 'RGBA8888'); assert.equal(texture.scale, 1);
  assert.deepEqual(texture.frames.map(frame => frame.filename), [...input.expected.keys()].sort());
  const unclaimed = Buffer.from(image.data);
  for (const frame of texture.frames) {
    assert.equal(frame.rotated, false); assert.equal(frame.trimmed, false);
    assert.deepEqual(frame.sourceSize, { w: 2, h: 2 });
    assert.deepEqual(frame.spriteSourceSize, { x: 0, y: 0, w: 2, h: 2 });
    assert.deepEqual(projectionExtract(image, frame.frame), input.expected.get(frame.filename));
    assert.ok(frame.frame.x >= 2 && frame.frame.y >= 2);
    assert.ok(frame.frame.x + 2 <= image.width - 2 && frame.frame.y + 2 <= image.height - 2);
    for (let y = 0; y < 2; y++) unclaimed.fill(0, ((frame.frame.y + y) * image.width + frame.frame.x) * 4,
      ((frame.frame.y + y) * image.width + frame.frame.x + 2) * 4);
  }
  assert.ok(unclaimed.every(byte => byte === 0));
  const reversed = await projectServiceAssets({ ...input, frames: [...input.frames].reverse(), assets: new Map([...input.assets].reverse()) });
  assert.deepEqual(reversed, result, 'input order cannot affect output bytes');
});

test('projection permits an explicitly listed source alias but rejects destination key collision', async () => {
  const input = projectionFixture(), first = input.frames[0];
  input.frames.push({ ...first, key: 'pe_berth_starter_explicit_alias_f1' });
  const result = await projectServiceAssets(input);
  assert.equal(JSON.parse(result.get('atlas/pe_fleet_berths@1x.json')).textures[0].frames.length, 56);
  input.frames.push({ ...first });
  await assert.rejects(projectServiceAssets(input), /duplicate destination/);
});

for (const [name, edit] of [
  ['wrong RGBA digest', input => { input.frames[0].rgbaSha256 = '0'.repeat(64); }],
  ['path traversal', input => { input.frames[0].sourceAtlasPath = '../atlas/pe_fleet_starter@1x.json'; }],
  ['missing input image', input => { input.assets.delete('atlas/pe_fleet_starter@1x.png'); }],
  ['unknown source key', input => { input.frames[0].sourceKey = 'pe_berth_missing_f1'; }],
  ['duplicate source atlas key', input => projectionEditAtlas(input, texture => texture.frames.push(texture.frames[0]))],
  ['overlap', input => projectionEditAtlas(input, texture => { texture.frames[1].frame.x = 0; })],
  ['rotation', input => projectionEditAtlas(input, texture => { texture.frames[0].rotated = true; })],
  ['trimming', input => projectionEditAtlas(input, texture => { texture.frames[0].trimmed = true; })],
  ['offset source cell', input => projectionEditAtlas(input, texture => { texture.frames[0].spriteSourceSize.x = 1; })],
  ['fractional rectangle', input => projectionEditAtlas(input, texture => { texture.frames[0].frame.x = 0.5; })],
  ['out of bounds rectangle', input => projectionEditAtlas(input, texture => { texture.frames[0].frame.y = 1; })],
  ['source size mismatch', input => projectionEditAtlas(input, texture => { texture.frames[0].sourceSize.w = 3; })],
  ['multiple textures', input => projectionEditAtlas(input, (texture, json) => json.textures.push(texture))],
  ['image escape', input => projectionEditAtlas(input, texture => { texture.image = '../x.png'; })],
  ['oversized texture', input => projectionEditAtlas(input, texture => { texture.size.w = 4097; })],
  ['wrong scale', input => projectionEditAtlas(input, texture => { texture.scale = 2; })],
]) test(`projection refuses ${name}`, async () => {
  const input = projectionFixture(); edit(input); await assert.rejects(projectServiceAssets(input), /Service projection/);
});

for (const [name, changes] of [['format', { format: 'jpeg' }], ['depth', { depth: 'ushort' }],
  ['alpha', { hasAlpha: false }], ['pages', { pages: 2 }], ['dimensions', { width: 99 }]]) {
  test(`projection refuses incorrect decoded source ${name}`, async () => {
    const input = projectionFixture(), inspect = input.inspectPng;
    input.inspectPng = async bytes => ({ ...await inspect(bytes), ...changes });
    await assert.rejects(projectServiceAssets(input), /Service projection/);
  });
}

test('projection rejects a short decoded buffer, encoder pixel changes and callback mutation', async () => {
  const short = projectionFixture(), decode = short.decodePng;
  short.decodePng = async bytes => { const image = await decode(bytes); image.data = image.data.subarray(1); return image; };
  await assert.rejects(projectServiceAssets(short), /decoded shape/);
  const changed = projectionFixture();
  changed.encodePng = async image => { const data = Buffer.from(image.data); data[0] ^= 1; return projectionImage({ ...image, data }); };
  await assert.rejects(projectServiceAssets(changed), /round-trip pixels/);
  const mutated = projectionFixture();
  mutated.encodePng = async image => { image.data[0] ^= 1; return projectionImage(image); };
  await assert.rejects(projectServiceAssets(mutated), /callback mutated/);
  const inspected = projectionFixture(), inspect = inspected.inspectPng;
  inspected.inspectPng = async bytes => { const result = await inspect(bytes); bytes[bytes.length - 1] ^= 1; return result; };
  await assert.rejects(projectServiceAssets(inspected), /callback mutated/);
});

test('projection owns every selected input before its first asynchronous callback', async () => {
  const input = projectionFixture(), baseline = await projectServiceAssets(input), inspect = input.inspectPng;
  let first = true;
  input.inspectPng = async bytes => {
    if (first) { first = false; for (const value of input.assets.values()) value.fill(0); input.frames[0].key = 'caller_mutation'; }
    return inspect(bytes);
  };
  assert.deepEqual(await projectServiceAssets(input), baseline);
});

// Allocation-limit regressions: the selected data is deliberately not decoded.
// These validate refusal before any asynchronous inspection or RGBA allocation.
test('projection bounds repeated explicit aliases by selected RGBA bytes before decoding', async () => {
  const input = projectionFixture(), sourceAtlasPath = 'atlas/pe_large@1x.json', sourceKey = 'pe_large_cell_f1';
  const cell = { filename: sourceKey, rotated: false, trimmed: false, sourceSize: { w: 4092, h: 4092 },
    spriteSourceSize: { x: 0, y: 0, w: 4092, h: 4092 }, frame: { x: 0, y: 0, w: 4092, h: 4092 } };
  input.assets = new Map([[sourceAtlasPath, Buffer.from(JSON.stringify({ textures: [{ image: 'pe_large@1x.png',
    format: 'RGBA8888', size: { w: 4092, h: 4092 }, scale: 1, frames: [cell] }] }))],
    ['atlas/pe_large@1x.png', Buffer.from('undecoded test bytes')]]);
  input.frames = Array.from({ length: 5 }, (_, i) => ({ key: `pe_large_alias_${i}`, group: 'pe_fleet_berths',
    sourceAtlasPath, sourceKey, width: 4092, height: 4092, rgbaSha256: 'a'.repeat(64) }));
  let inspected = false;
  input.inspectPng = async () => { inspected = true; throw new Error('codec must not run'); };
  await assert.rejects(projectServiceAssets(input), /selected decoded-byte limit/);
  assert.equal(inspected, false);
});

test('projection bounds destination groups before its first asynchronous callback', async () => {
  const input = projectionFixture(), frame = input.frames[0];
  input.frames = Array.from({ length: 65 }, (_, i) => ({ ...frame, key: `pe_group_alias_${i}`, group: `pe_group_${i}` }));
  let inspected = false;
  input.inspectPng = async () => { inspected = true; throw new Error('codec must not run'); };
  await assert.rejects(projectServiceAssets(input), /destination group limit/);
  assert.equal(inspected, false);
});

test('projection caps aggregate encoded input bytes before copying the next image', async context => {
  const input = { frames: [], assets: new Map(), ...projectionCodec() };
  // One physical 4 MiB buffer is referenced by 64 inputs. The test replaces only
  // copies of this sentinel with an alias so neither a passing nor regressed
  // implementation actually allocates 256 MiB. No codec consumes the sentinel.
  const sharedPng = Buffer.alloc(4 * 1024 * 1024), realFrom = Buffer.from;
  for (let i = 0; i < 64; i++) {
    const group = `pe_input_${i}`, key = `${group}_f1`, sourceAtlasPath = `atlas/${group}@1x.json`;
    input.assets.set(sourceAtlasPath, Buffer.from(JSON.stringify({ textures: [{ image: `${group}@1x.png`, format: 'RGBA8888',
      size: { w: 1, h: 1 }, scale: 1, frames: [{ filename: key, rotated: false, trimmed: false,
        sourceSize: { w: 1, h: 1 }, spriteSourceSize: { x: 0, y: 0, w: 1, h: 1 }, frame: { x: 0, y: 0, w: 1, h: 1 } }] }] })));
    input.assets.set(`atlas/${group}@1x.png`, sharedPng);
    input.frames.push({ key, group: 'pe_fleet_berths', sourceAtlasPath, sourceKey: key, width: 1, height: 1, rgbaSha256: 'a'.repeat(64) });
  }
  let imageCopies = 0, inspected = false;
  context.mock.method(Buffer, 'from', function(value, ...rest) {
    if (value === sharedPng) { imageCopies++; return value; }
    return realFrom.call(Buffer, value, ...rest);
  });
  input.inspectPng = async () => { inspected = true; throw new Error('codec must not run'); };
  await assert.rejects(projectServiceAssets(input), /encoded input-byte limit/);
  assert.equal(imageCopies, 63, 'the input exceeding 256 MiB including JSON was not copied');
  assert.equal(inspected, false);
});
