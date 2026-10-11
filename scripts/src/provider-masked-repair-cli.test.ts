import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import {
  publishProviderMaskedRepairSpec,
  publishProviderMaskedRepairSpecFile,
  type ProviderMaskedRepairSpec,
} from './provider-masked-repair-cli.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shardkeep-masked-repair-cli-'));
  roots.push(root);
  return root;
}

function setPixel(rgba: Uint8Array, width: number, x: number, y: number, pixel: readonly number[]): void {
  rgba.set(pixel, ((y * width) + x) * 4);
}

async function png(width: number, height: number, rgba: Uint8Array, channels: 3 | 4 = 4): Promise<Buffer> {
  return sharp(Buffer.from(rgba), { raw: { width, height, channels } })
    .png({ palette: false, compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
}

async function decoded(absolute: string): Promise<Uint8Array> {
  const result = await sharp(await fs.readFile(absolute)).raw().toBuffer();
  return new Uint8Array(result);
}

function spec(root: string): ProviderMaskedRepairSpec {
  return {
    schemaVersion: 1,
    original: path.join(root, 'original.png'),
    provider: path.join(root, 'provider.png'),
    output: path.join(root, 'published', 'frame.png'),
    provenance: path.join(root, 'published', 'frame.json'),
    masks: [{ x: 2, y: 2, width: 2, height: 2 }],
  };
}

async function writeGiantDriftFixture(root: string): Promise<{ original: Uint8Array; provider: Uint8Array }> {
  const original = new Uint8Array(8 * 8 * 4);
  setPixel(original, 8, 2, 2, [20, 30, 40, 255]);
  setPixel(original, 8, 3, 2, [21, 31, 41, 255]);
  setPixel(original, 8, 2, 3, [22, 32, 42, 255]);
  setPixel(original, 8, 3, 3, [23, 33, 43, 255]);
  const provider = new Uint8Array(original);
  setPixel(provider, 8, 3, 3, [90, 80, 70, 255]);
  for (const [x, y] of [[0, 0], [7, 0], [0, 7], [7, 7], [5, 4]] as const) {
    setPixel(provider, 8, x, y, [200, 100, 50, 255]);
  }
  await Promise.all([
    fs.writeFile(path.join(root, 'original.png'), await png(8, 8, original)),
    fs.writeFile(path.join(root, 'provider.png'), await png(8, 8, provider)),
  ]);
  return { original, provider };
}

describe('provider masked repair CLI/library wrapper', () => {
  it('restores the five real-PNG exterior drift pixels byte-for-byte and emits deterministic path-free evidence', async () => {
    const root = await fixture();
    const source = await writeGiantDriftFixture(root);
    const config = spec(root);
    const first = await publishProviderMaskedRepairSpec(config);
    const firstPng = await fs.readFile(config.output);
    const firstProvenance = await fs.readFile(config.provenance!, 'utf8');
    const result = await decoded(config.output);
    for (let pixel = 0; pixel < 64; pixel += 1) {
      const x = pixel % 8;
      const y = Math.floor(pixel / 8);
      const offset = pixel * 4;
      const expected = x >= 2 && x < 4 && y >= 2 && y < 4 ? source.provider : source.original;
      expect(result.subarray(offset, offset + 4)).toEqual(expected.subarray(offset, offset + 4));
    }
    expect(first.metrics).toMatchObject({
      discardedProviderOutsideMaskPixels: 5,
      outsideMaskChangedPixels: 0,
      outsideMaskChangedBytes: 0,
      changedPixels: 1,
    });
    expect(firstPng[24]).toBe(8);
    expect(firstPng[25]).toBe(6);
    expect(firstProvenance).not.toContain(root);
    expect(firstProvenance).not.toMatch(/(?:Authorization|Bearer|api[_-]?key|token)/i);
    expect(JSON.parse(firstProvenance)).toMatchObject({
      schemaVersion: 1,
      producer: 'shardkeep-provider-masked-repair-cli',
      transform: { preserveOriginalOpaque: false },
      metrics: { discardedProviderOutsideMaskPixels: 5, outsideMaskChangedBytes: 0 },
    });

    await publishProviderMaskedRepairSpec(config);
    expect(await fs.readFile(config.output)).toEqual(firstPng);
    expect(await fs.readFile(config.provenance!, 'utf8')).toBe(firstProvenance);
  });

  it('applies the ordered palette only to changed masked pixels', async () => {
    const root = await fixture();
    const original = new Uint8Array([9, 9, 9, 255, 3, 3, 3, 255]);
    const provider = new Uint8Array([1, 0, 0, 255, 3, 3, 3, 255]);
    await Promise.all([
      fs.writeFile(path.join(root, 'original.png'), await png(2, 1, original)),
      fs.writeFile(path.join(root, 'provider.png'), await png(2, 1, provider)),
    ]);
    const config = spec(root);
    config.masks = [{ x: 0, y: 0, width: 2, height: 1 }];
    config.palette = ['#020000', '#000000'];
    const result = await publishProviderMaskedRepairSpec(config);
    expect([...await decoded(config.output)]).toEqual([2, 0, 0, 255, 3, 3, 3, 255]);
    expect(result.metrics).toMatchObject({ candidateChangedPixels: 1, changedPixels: 1, remappedPixels: 1 });
  });

  it('deterministically restores provider-cut identity holes only when alpha-union is explicitly enabled', async () => {
    const root = await fixture();
    const original = new Uint8Array(4 * 2 * 4);
    setPixel(original, 4, 1, 0, [25, 35, 45, 255]);
    setPixel(original, 4, 2, 0, [55, 65, 75, 255]);
    const provider = new Uint8Array(original);
    setPixel(provider, 4, 1, 0, [0, 0, 0, 0]);
    setPixel(provider, 4, 2, 0, [1, 0, 0, 255]);
    await Promise.all([
      fs.writeFile(path.join(root, 'original.png'), await png(4, 2, original)),
      fs.writeFile(path.join(root, 'provider.png'), await png(4, 2, provider)),
    ]);
    const config = spec(root);
    config.masks = [{ x: 1, y: 0, width: 2, height: 1 }];
    config.palette = ['#020000', '#000000'];

    const erased = await publishProviderMaskedRepairSpec(config);
    expect([...await decoded(config.output)].slice(4, 8)).toEqual([0, 0, 0, 0]);
    expect(erased.metrics.preservedOriginalOpaquePixels).toBe(0);

    config.preserveOriginalOpaque = true;
    const preserved = await publishProviderMaskedRepairSpec(config);
    const firstPng = await fs.readFile(config.output);
    const firstProvenance = await fs.readFile(config.provenance!, 'utf8');
    const output = await decoded(config.output);
    expect([...output.slice(4, 8)]).toEqual([25, 35, 45, 255]);
    expect([...output.slice(8, 12)]).toEqual([2, 0, 0, 255]);
    expect(preserved.metrics).toMatchObject({
      preservedOriginalOpaquePixels: 1,
      candidateChangedPixels: 1,
      changedPixels: 1,
      remappedPixels: 1,
    });
    expect(JSON.parse(firstProvenance)).toMatchObject({
      transform: { preserveOriginalOpaque: true },
      metrics: { preservedOriginalOpaquePixels: 1 },
    });
    await publishProviderMaskedRepairSpec(config);
    expect(await fs.readFile(config.output)).toEqual(firstPng);
    expect(await fs.readFile(config.provenance!, 'utf8')).toBe(firstProvenance);
  });

  it('treats overlapping rectangles as one mask union', async () => {
    const root = await fixture();
    const original = new Uint8Array(3 * 3 * 4);
    const provider = new Uint8Array(original);
    setPixel(provider, 3, 1, 1, [70, 80, 90, 255]);
    await Promise.all([
      fs.writeFile(path.join(root, 'original.png'), await png(3, 3, original)),
      fs.writeFile(path.join(root, 'provider.png'), await png(3, 3, provider)),
    ]);
    const config = spec(root);
    config.masks = [{ x: 0, y: 0, width: 2, height: 2 }, { x: 1, y: 1, width: 2, height: 2 }];
    const result = await publishProviderMaskedRepairSpec(config);
    expect(result.metrics).toMatchObject({ maskCount: 2, maskedPixels: 7, outsideMaskPixels: 2 });
    expect([...await decoded(config.output)].slice((1 * 3 + 1) * 4, (1 * 3 + 1) * 4 + 4)).toEqual([70, 80, 90, 255]);
  });

  it('leaves the prior output and provenance byte-identical when publication stops before activation', async () => {
    const root = await fixture();
    await writeGiantDriftFixture(root);
    const config = spec(root);
    await publishProviderMaskedRepairSpec(config);
    const outputBefore = await fs.readFile(config.output);
    const provenanceBefore = await fs.readFile(config.provenance!);
    await expect(publishProviderMaskedRepairSpec(config, {
      beforeActivate: () => { throw new Error('injected publication stop'); },
    })).rejects.toThrow('injected publication stop');
    expect(await fs.readFile(config.output)).toEqual(outputBefore);
    expect(await fs.readFile(config.provenance!)).toEqual(provenanceBefore);
    expect((await fs.readdir(path.dirname(config.output))).some((name) => name.includes('.stage-'))).toBe(false);
  });

  it('rejects unsafe aliases, non-absolute paths, and malformed specs before publication', async () => {
    const root = await fixture();
    await writeGiantDriftFixture(root);
    const relative = spec(root) as unknown as Record<string, unknown>;
    relative.output = 'relative.png';
    await expect(publishProviderMaskedRepairSpec(relative)).rejects.toThrow('output must be an absolute normalized path');

    const alias = spec(root);
    alias.output = alias.original;
    await expect(publishProviderMaskedRepairSpec(alias)).rejects.toThrow('must not alias the same filesystem entry');

    const hardlink = spec(root);
    hardlink.output = path.join(root, 'hardlink.png');
    await fs.link(hardlink.original, hardlink.output);
    await expect(publishProviderMaskedRepairSpec(hardlink)).rejects.toThrow('must not alias the same filesystem entry');

    const malformed = { ...spec(root), surprise: true };
    await expect(publishProviderMaskedRepairSpec(malformed)).rejects.toThrow('unsupported field surprise');
    await expect(publishProviderMaskedRepairSpec({ ...spec(root), palette: ['red'] })).rejects.toThrow(
      'palette[0] must be #RRGGBB',
    );
    await expect(publishProviderMaskedRepairSpec({ ...spec(root), alphaThreshold: 0 })).rejects.toThrow(
      'alphaThreshold must be an integer from 1 through 255',
    );
    await expect(publishProviderMaskedRepairSpec({ ...spec(root), preserveOriginalOpaque: 'yes' })).rejects.toThrow(
      'preserveOriginalOpaque must be a boolean',
    );
    await expect(fs.stat(path.join(root, 'published'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects input symlinks, mismatched PNG canvases, RGB PNGs, and spec-file output aliasing', async () => {
    const root = await fixture();
    await writeGiantDriftFixture(root);
    const config = spec(root);
    const providerReal = path.join(root, 'provider-real.png');
    await fs.rename(config.provider, providerReal);
    await fs.symlink(providerReal, config.provider);
    await expect(publishProviderMaskedRepairSpec(config)).rejects.toThrow('provider must not be a symlink');
    await fs.unlink(config.provider);
    await fs.rename(providerReal, config.provider);

    await fs.writeFile(config.provider, await png(4, 4, new Uint8Array(4 * 4 * 4)));
    await expect(publishProviderMaskedRepairSpec(config)).rejects.toThrow('dimensions must match exactly');

    await fs.writeFile(config.provider, await png(8, 8, new Uint8Array(8 * 8 * 3), 3));
    await expect(publishProviderMaskedRepairSpec(config)).rejects.toThrow('static 8-bit RGBA PNG');

    const specFile = path.join(root, 'repair.json');
    await fs.writeFile(specFile, JSON.stringify({ ...config, provider: config.original, output: specFile }));
    await expect(publishProviderMaskedRepairSpecFile(specFile)).rejects.toThrow(
      'spec file and output must not alias the same filesystem entry',
    );
  });
});
