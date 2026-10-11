import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import {
  publishProviderProductionSpec,
  type ProviderProductionSpec,
} from './provider-production-normalize-cli.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ root: string; input: string; output: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shardkeep-production-normalize-'));
  roots.push(root);
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await fs.mkdir(input);
  return { root, input, output };
}

async function png(width: number, height: number, red: number, channels: 3 | 4 = 4): Promise<Buffer> {
  const data = Buffer.alloc(width * height * channels);
  for (let offset = 0; offset < data.length; offset += channels) {
    data[offset] = red;
    if (channels === 4) data[offset + 3] = 255;
  }
  return sharp(data, { raw: { width, height, channels } }).png({ palette: false }).toBuffer();
}

async function sparsePng(width: number, height: number, x: number, y: number, red: number): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 4);
  data.set([red, 0, 0, 255], ((y * width) + x) * 4);
  return sharp(data, { raw: { width, height, channels: 4 } }).png({ palette: false }).toBuffer();
}

async function write(root: string, relative: string, bytes: Buffer): Promise<void> {
  const target = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
}

function spec(inputRoot: string, outputRoot: string): ProviderProductionSpec {
  return { schemaVersion: 1, inputRoot, outputRoot, runtimeCell: { width: 2, height: 2 },
    preferredSourceOffset: { x: 0, y: 0 }, directionOrder: ['s', 'n'], frameOrder: [1, 2],
    inputs: { pattern: 'giant/walk/{direction}/frame-{frame:02}.png' },
    outputs: { sheet: 'sheets/giant-walk.png', frames: 'frames/{direction}/frame-{frame:02}.png',
      provenance: 'provenance/giant-walk.json' } };
}

async function completeInput(input: string): Promise<void> {
  let color = 10;
  for (const direction of ['s', 'n']) for (const frame of [1, 2]) {
    await write(input, `giant/walk/${direction}/frame-0${frame}.png`, await png(2, 2, color));
    color += 10;
  }
}

async function tree(root: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else result.set(child, await fs.readFile(path.join(root, ...child.split('/'))));
    }
  };
  await visit('');
  return result;
}

describe('provider production normalizer CLI/library wrapper', () => {
  it('publishes a patterned direction/frame tree, hashes all PNGs, and reruns byte-identically', async () => {
    const work = await fixture();
    await completeInput(work.input);
    await write(work.input, 'giant/walk/n/frame-01.png', await sparsePng(3, 3, 1, 1, 30));
    await write(work.input, 'giant/walk/n/frame-02.png', await sparsePng(3, 3, 2, 2, 40));
    const config = spec(work.input, work.output);
    config.preferredSourceOffsets = { n: { x: 1, y: 1 } };
    const first = await publishProviderProductionSpec(config);
    expect(first.outputFiles).toHaveLength(5);
    const firstTree = await tree(work.output);
    const provenance = JSON.parse(firstTree.get('provenance/giant-walk.json')!.toString()) as {
      inputs: Array<{ sha256: string }>; outputs: Array<{ file: string; sha256: string }>;
      transform: { directions: Array<{ direction: string; providerCanvas: { width: number; height: number } }> };
    };
    expect(provenance.inputs).toHaveLength(4);
    expect(provenance.outputs).toEqual(first.outputFiles);
    expect(provenance.transform.directions.map(({ direction, providerCanvas }) => ({ direction, providerCanvas }))).toEqual([
      { direction: 's', providerCanvas: { width: 2, height: 2 } },
      { direction: 'n', providerCanvas: { width: 3, height: 3 } },
    ]);
    for (const output of first.outputFiles) expect(output.sha256).toMatch(/^[a-f0-9]{64}$/);
    await publishProviderProductionSpec(config);
    const secondTree = await tree(work.output);
    expect([...secondTree.keys()]).toEqual([...firstTree.keys()]);
    for (const [file, bytes] of firstTree) expect(secondTree.get(file)).toEqual(bytes);
  });

  it('rejects non-RGBA PNGs and mismatched provider canvases', async () => {
    const work = await fixture();
    await completeInput(work.input);
    await write(work.input, 'giant/walk/s/frame-01.png', await png(2, 2, 10, 3));
    await expect(publishProviderProductionSpec(spec(work.input, work.output))).rejects.toThrow('static 8-bit RGBA PNG');
    await write(work.input, 'giant/walk/s/frame-01.png', await png(2, 2, 10));
    await write(work.input, 'giant/walk/n/frame-02.png', await png(3, 2, 40));
    await expect(publishProviderProductionSpec(spec(work.input, work.output))).rejects.toThrow('share one provider canvas');
  });

  it('publishes only at the exact requested direction offset and never silently clamps', async () => {
    const work = await fixture();
    await completeInput(work.input);
    await write(work.input, 'giant/walk/n/frame-01.png', await sparsePng(3, 3, 1, 1, 30));
    await write(work.input, 'giant/walk/n/frame-02.png', await sparsePng(3, 3, 2, 2, 40));
    await expect(publishProviderProductionSpec(spec(work.input, work.output))).rejects.toThrow(
      'n: union opaque width bounds [1,2] do not fit requested width window [0,1]; exact anchor mapping forbids clamping',
    );
    await expect(fs.stat(work.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects traversal, input symlinks, and unmanaged existing outputs', async () => {
    const work = await fixture();
    await completeInput(work.input);
    const traversal = spec(work.input, work.output);
    traversal.outputs.sheet = '../escape.png';
    await expect(publishProviderProductionSpec(traversal)).rejects.toThrow('without traversal');
    const target = path.join(work.input, 'giant/walk/s/frame-01.png');
    await fs.rename(target, `${target}.real`);
    await fs.symlink(`${target}.real`, target);
    await expect(publishProviderProductionSpec(spec(work.input, work.output))).rejects.toThrow('must not traverse a symlink');
    await fs.unlink(target);
    await fs.rename(`${target}.real`, target);
    const directionDirectory = path.join(work.input, 'giant/walk/n');
    await fs.rename(directionDirectory, `${directionDirectory}-real`);
    await fs.symlink(`${directionDirectory}-real`, directionDirectory);
    await expect(publishProviderProductionSpec(spec(work.input, work.output))).rejects.toThrow('must not traverse a symlink');
    await fs.unlink(directionDirectory);
    await fs.rename(`${directionDirectory}-real`, directionDirectory);
    await fs.mkdir(work.output);
    await fs.writeFile(path.join(work.output, 'notes.txt'), 'owner file');
    await expect(publishProviderProductionSpec(spec(work.input, work.output))).rejects.toThrow('unmanaged extra notes.txt');
  });

  it('canonicalizes aliases before rejecting equal or nested input/output roots', async () => {
    const work = await fixture();
    await completeInput(work.input);
    const alias = path.join(work.root, 'input-alias');
    await fs.symlink(work.input, alias);
    await expect(publishProviderProductionSpec(spec(work.input, alias))).rejects.toThrow(
      'canonical inputRoot and outputRoot must be disjoint',
    );
    const nestedAliasOutput = path.join(alias, 'nested-output');
    await expect(publishProviderProductionSpec(spec(work.input, nestedAliasOutput))).rejects.toThrow(
      'canonical inputRoot and outputRoot must be disjoint',
    );
    await expect(fs.stat(nestedAliasOutput)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(work.input)).some((name) => name.startsWith('.nested-output.stage-'))).toBe(false);

    const canonicalInput = await fs.realpath(work.input);
    if (canonicalInput.startsWith('/private/var/')) {
      const varAlias = canonicalInput.replace(/^\/private\/var\//, '/var/');
      await expect(publishProviderProductionSpec(spec(canonicalInput, path.join(varAlias, 'mac-alias-output')))).rejects.toThrow(
        'canonical inputRoot and outputRoot must be disjoint',
      );
    }
  });

  it('leaves the prior publication byte-identical when staging crashes before activation', async () => {
    const work = await fixture();
    await completeInput(work.input);
    const config = spec(work.input, work.output);
    await publishProviderProductionSpec(config);
    const before = await tree(work.output);
    await expect(publishProviderProductionSpec(config, { beforeActivate: () => { throw new Error('injected crash'); } }))
      .rejects.toThrow('injected crash');
    const after = await tree(work.output);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [file, bytes] of before) expect(after.get(file)).toEqual(bytes);
  });

  it('keeps provenance secret-free and contains no absolute filesystem paths', async () => {
    const work = await fixture();
    await completeInput(work.input);
    await publishProviderProductionSpec(spec(work.input, work.output));
    const provenance = await fs.readFile(path.join(work.output, 'provenance/giant-walk.json'), 'utf8');
    expect(provenance).not.toContain(work.root);
    expect(provenance).not.toMatch(/(?:Authorization|Bearer|api[_-]?key|token)/i);
    expect(provenance).toContain('giant/walk/s/frame-01.png');
  });
});
