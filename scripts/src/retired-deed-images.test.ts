import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRetiredDeedImages } from './retired-deed-images';

const source = fileURLToPath(new URL('../../art/retired-deed-images-v1/', import.meta.url));
const identities = fileURLToPath(new URL('../../apps/api/src/game/retiredDeedPreservation.v1.json', import.meta.url));
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'retired-pack-')); temporary.push(root);
  const art = path.join(root, 'art/retired-deed-images-v1');
  await fs.mkdir(path.dirname(art), { recursive: true }); await fs.cp(source, art, { recursive: true });
  const identityFile = path.join(root, 'apps/api/src/game/retiredDeedPreservation.v1.json');
  await fs.mkdir(path.dirname(identityFile), { recursive: true }); await fs.copyFile(identities, identityFile);
  return { root, art, identityFile };
}
describe('retired image release archive', () => {
  it('copies every captured response without recompression and preserves the manifest checksum', async () => {
    const { root, art } = await fixture(); expect(await buildRetiredDeedImages(root)).toBe(22);
    for (const filename of await fs.readdir(art)) {
      const original = await fs.readFile(path.join(art, filename));
      const output = await fs.readFile(path.join(root, 'apps/web/public/atlas/retired-deeds', filename));
      expect(output.equals(original)).toBe(true);
    }
  });
  it('refuses a changed manifest or image before publishing any archive bytes', async () => {
    const { root, art } = await fixture();
    const manifest = path.join(art, 'manifest.json'); const original = await fs.readFile(manifest);
    await fs.writeFile(manifest, '{}'); await expect(buildRetiredDeedImages(root)).rejects.toThrow('manifest changed');
    await fs.writeFile(manifest, original);
    const file = (JSON.parse(original.toString()) as { entries: Array<{ asset: { file: string } }> }).entries[0]!.asset.file;
    await fs.appendFile(path.join(art, file), 'bad'); await expect(buildRetiredDeedImages(root)).rejects.toThrow('bytes changed');
    await expect(fs.stat(path.join(root, 'apps/web/public/atlas/retired-deeds'))).rejects.toThrow();
  });
  it('rejects preservation identities not derived from the audited master before copying release bytes', async () => {
    const { root, identityFile } = await fixture();
    const data = JSON.parse(await fs.readFile(identityFile, 'utf8'));
    data.entries.pop(); await fs.writeFile(identityFile, JSON.stringify(data));
    await expect(buildRetiredDeedImages(root)).rejects.toThrow('identities differ');
    await expect(fs.stat(path.join(root, 'apps/web/public/atlas/retired-deeds'))).rejects.toThrow();
  });

});
