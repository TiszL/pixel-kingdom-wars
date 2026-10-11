import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { assertRealmKitAssetPixels, assertRealmKitManifest, renderRealmKitPixels } from '../../packages/shared/src/realmKit.js';
import { FIXTURE_CELL, fixtureCellRgb, fixtureClaim, realmKitFixture, realmKitFixturePixels, realmKitObstacleProbeFixture, realmKitPathProbeFixture, realmKitProbeFixture, realmKitPropProbeFixture } from '../../packages/shared/src/realmKit.fixture.js';
import { REALM_KIT_FIXTURE_FILE, writeRealmKitFixture, type RealmKitFixtureFile } from './realm-kit-fixture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSX = path.join(HERE, '../node_modules/tsx/dist/cli.mjs'), SCRIPT = path.join(HERE, 'realm-kit-fixture.ts');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => fs.rm(r, { recursive: true, force: true }))); });
async function tmp(): Promise<string> { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'realm-kit-fixture-')); roots.push(root); return root; }

describe('realm-kit parity fixture CLI', () => {
  it('writes a manifest that passes admission with real hashes, the probes the shared tests pin, and PNG sheets that decode to the synthetic pixels', async () => {
    const out = await tmp();
    const stdout = execFileSync(process.execPath, [TSX, SCRIPT, out], { encoding: 'utf8', stdio: 'pipe' });
    const file = path.join(out, REALM_KIT_FIXTURE_FILE);
    expect(stdout.trim()).toBe(file);
    const text = await fs.readFile(file, 'utf8'), value = JSON.parse(text) as RealmKitFixtureFile;
    expect(value.schemaVersion).toBe(1);
    expect(() => assertRealmKitManifest(value.manifest)).not.toThrow();
    expect(value.manifest.realmId).toBe('crownlands'); expect(value.manifest.groundRevision).toBe(5);
    // The probes are exactly what packages/shared computes today, from the written manifest and from a fresh fixture alike.
    expect(value.probes).toEqual(realmKitProbeFixture(value.manifest));
    expect(value.probes).toEqual(realmKitProbeFixture(realmKitFixture()));
    expect(value.probes.length).toBeGreaterThanOrEqual(550);
    // E-6 amended: the frame-seated oak is visible under the 14- and 26-tile claims and hidden from 30 tiles on.
    expect(value.propProbes).toEqual(realmKitPropProbeFixture(value.manifest));
    expect(value.propProbes.map(p => p.visible.includes('oak-frame-east'))).toEqual([true, true, false, false]);
    // E-11 expansion obstacles: every placement's kind and every row's sprite are the shared rule's answers.
    expect(value.obstacleProbes).toEqual(realmKitObstacleProbeFixture(value.manifest));
    expect(value.obstacleProbes.kinds.map(k => k.kind)).toEqual(['pine2', 'stump', 'pine1', 'pine2']);
    expect(value.obstacleProbes.sprites.find(s => s.tx === 30 && s.ty === 15 && s.spriteKey === 'pine2' && s.state === 'intact'))
      .toEqual({ tx: 30, ty: 15, spriteKey: 'pine2', state: 'intact', asset: 'oak', frame: 3 });
    // D-173 creature paths: the poses, cells, facings and the ground band order are the shared functions' answers,
    // so the Kotlin mirror pins a deer to the same pixel and the same draw slot at the same clock.
    expect(value.pathProbes).toEqual(realmKitPathProbeFixture(value.manifest));
    expect(value.pathProbes.length).toBeGreaterThanOrEqual(15);
    expect(value.pathProbes.every(p => p.draws.map(d => d.id).join() === 'gulls,hare-walk,hare-pace,hare-corner,hare-side')).toBe(true);
    expect(value.pathProbes.find(p => p.elapsedMs === 5000 && !p.reducedMotion)!.draws[1]).toEqual({ id: 'hare-walk', frame: 2, facing: 'left', anchor: { x: 1700, y: -700 }, destination: { x: 1692, y: -716, width: 16, height: 16 } });
    expect(value.pathProbes.find(p => p.reducedMotion)!.draws.map(d => d.frame)).toEqual([0, 4, 0, 4, 0]);
    // The file carries a ≥3-point pingpong mid-way up its unfolded return leg and a directions-2 draw on the row tie
    // (up, dx 0 → row right), so the Kotlin mirror's unfold and facingRow(2) branches are pinned by data, not hand pins.
    expect(value.pathProbes.find(p => p.elapsedMs === 5432)!.draws.slice(3)).toEqual([
      { id: 'hare-corner', frame: 6, facing: 'up', anchor: { x: -500, y: 531 }, destination: { x: -508, y: 515, width: 16, height: 16 } },
      { id: 'hare-side', frame: 6, facing: 'up', anchor: { x: -601, y: 1456 }, destination: { x: -609, y: 1440, width: 16, height: 16 } }]);
    expect(value.pathProbes[0]!.band).toEqual(['hare-walk', 'stump-north', 'oak-dead-west', 'hare-corner', 'oak-frame-east', 'hare-side', 'oak-east', 'hare-pace', 'gulls']);
    // Every asset's PNG hashes to its declared identity, decodes to its declared geometry, equals the synthetic pixel set and passes the alpha rules.
    const expected = realmKitFixturePixels(realmKitFixture()), decoded = new Map<string, { width: number; height: number; data: Buffer }>();
    expect(Object.keys(value.assets).sort()).toEqual(value.manifest.assets.map(a => a.id).sort());
    for (const a of value.manifest.assets) {
      const png = Buffer.from(value.assets[a.id]!, 'base64');
      expect(createHash('sha256').update(png).digest('hex'), a.id).toBe(a.sha256);
      expect(png.length, a.id).toBe(a.size);
      expect(a.path).toBe(`atlas/fantasy/layered-ground/assets/${a.sha256}.png`);
      const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height], a.id).toEqual([a.width, a.height]);
      expect(new Uint8Array(data), a.id).toEqual(new Uint8Array(expected.get(a.id)!.data));
      expect(() => assertRealmKitAssetPixels(value.manifest, a, { width: info.width, height: info.height, data }), a.id).not.toThrow();
      decoded.set(a.id, { width: info.width, height: info.height, data });
    }
    expect(value.tileset).toBe(value.assets[value.manifest.ground.cells[0]!.asset]);
    expect(value.props).toBe(value.assets.oak);
    // The tileset PNG itself carries the water still and the bed hole (§7), so a Kotlin decoder sees the same texels.
    const tiles = decoded.get('tiles')!, water = value.manifest.ground.cells[FIXTURE_CELL.water - 1]!, bed = value.manifest.ground.cells[FIXTURE_CELL.bed - 1]!;
    const texel = (x: number, y: number) => [...tiles.data.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)];
    expect(texel(water.x + 3, water.y + 3)).toEqual([...fixtureCellRgb(FIXTURE_CELL.water, 0), 255]);
    expect(texel(water.x + 32 + 3, water.y + 3)).toEqual([...fixtureCellRgb(FIXTURE_CELL.water, 1), 255]);
    expect(texel(bed.x + 3, bed.y + 3)).toEqual([0, 0, 0, 0]);
    // The shared rasterizer over the decoded PNGs is the parity oracle for a native deed/thumbnail render.
    const render = renderRealmKitPixels(value.manifest, decoded, fixtureClaim(14), 32, 32, 55 * 32, 55 * 32);
    expect([...render.subarray(0, 4)]).toEqual([...fixtureCellRgb(FIXTURE_CELL.water, 0), 255]);
    // Deterministic: the in-process writer produces byte-identical output, so the fixture can be regenerated without churn.
    const again = await tmp();
    expect(await writeRealmKitFixture(again)).toBe(path.join(again, REALM_KIT_FIXTURE_FILE));
    expect(await fs.readFile(path.join(again, REALM_KIT_FIXTURE_FILE), 'utf8')).toBe(text);
  });
  it('refuses to run without exactly one output directory and writes nothing', async () => {
    const out = await tmp();
    for (const args of [[], [out, 'extra']]) {
      expect(() => execFileSync(process.execPath, [TSX, SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
    }
    expect(await fs.readdir(out)).toEqual([]);
  });
});
