/** Copy captured public HTTP images without recompression or repainting. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function buildRetiredDeedImages(root = ROOT): Promise<number> {
  const source = path.join(root, 'art/retired-deed-images-v1');
  const manifestBytes = await fs.readFile(path.join(source, 'manifest.json'));
  const sha = (await fs.readFile(path.join(source, 'manifest.sha256'), 'utf8')).trim();
  if (createHash('sha256').update(manifestBytes).digest('hex') !== sha) throw new Error('Retired image manifest changed');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { version: number; entries: Array<{
    mintId: string; walletAlias: string; asset: { status: number; file?: string; body?: string; sha256: string; bytes: number; contentType: string };
    wallet: { status: number; file?: string; body?: string; sha256: string; bytes: number; contentType: string };
  }> };
  const seen = new Set<string>(); const copies: Array<{ file: string; bytes: Buffer }> = [];
  if (manifest.version !== 1 || manifest.entries.length === 0) throw new Error('Empty retired image archive');
  for (const entry of manifest.entries) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(entry.mintId)
      || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(entry.walletAlias) || seen.has(entry.mintId)) throw new Error('Invalid retired image identity');
    seen.add(entry.mintId);
    for (const kind of ['asset', 'wallet'] as const) {
      const response = entry[kind]; let bytes: Buffer;
      if (response.status === 200) {
        if (response.file !== `${entry.mintId}-${kind}.png` || response.contentType !== 'image/png') throw new Error('Invalid archived image path');
        bytes = await fs.readFile(path.join(source, response.file));
        if ((await sharp(bytes).metadata()).format !== 'png') throw new Error('Retired image is not PNG');
        copies.push({ file: response.file, bytes });
      } else if (response.status === 404 && typeof response.body === 'string') bytes = Buffer.from(response.body);
      else throw new Error('Unsupported captured image status');
      if (bytes.length !== response.bytes || createHash('sha256').update(bytes).digest('hex') !== response.sha256) throw new Error('Retired image bytes changed');
    }
  }
  // API quarantine must be exactly derived from these positively audited
  // identities, so staging cannot repaint them before the DB import.
  const preservation = JSON.parse(await fs.readFile(path.join(root, 'apps/api/src/game/retiredDeedPreservation.v1.json'), 'utf8'));
  const expected = { version: 1, source: 'art/retired-deed-images-v1/manifest.json', manifestSha256: sha,
    entries: manifest.entries.map(({ mintId, walletAlias }) => ({ mintId, walletAlias })) };
  if (JSON.stringify(preservation) !== JSON.stringify(expected)) throw new Error('Retired preservation identities differ from audited archive');
  // Validate the entire archive before copying any bytes into the release.
  const target = path.join(root, 'apps/web/public/atlas/retired-deeds');
  await fs.mkdir(target, { recursive: true });
  for (const row of copies) await fs.writeFile(path.join(target, row.file), row.bytes);
  await fs.writeFile(path.join(target, 'manifest.json'), manifestBytes);
  await fs.writeFile(path.join(target, 'manifest.sha256'), sha + '\n');
  return copies.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`Retired deed images: ${await buildRetiredDeedImages()} originals preserved`);
