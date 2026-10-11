/** Immutable v3 correction: keep the approved v2 painting outside two rock
 * clusters. The generated study supplies only grass inside those regions;
 * it must never replace or rescale the surrounding authored geography. */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../../', import.meta.url));
const originalPath = `${root}art/fantasy-ground-v2/ground/crownlands.png`;
const studyPath = `${root}art/fantasy-ground-v3/source/crownlands-clean-study.png`;
const out = `${root}art/fantasy-ground-v3/ground`;
const original = await fs.readFile(originalPath);
const study = await fs.readFile(studyPath);
const { data: base, info } = await sharp(original).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
if (info.width !== 1536 || info.height !== 1536) throw new Error('Crownlands source geometry changed');
const patch = await sharp(study).resize(1536, 1536, { kernel: 'nearest' }).ensureAlpha().raw().toBuffer();
const data = Buffer.from(base);
const regions = [{ x: 795, y: 615, width: 178, height: 152 }, { x: 528, y: 825, width: 230, height: 169 }];
const feather = 12;
const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
for (const r of regions) for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) {
  const edge = Math.min(x - r.x, y - r.y, r.x + r.width - 1 - x, r.y + r.height - 1 - y);
  // Ordered pixel selection joins the two grass textures without blurred pixels.
  if (Math.min(1, edge / feather) <= (bayer[(y % 4) * 4 + (x % 4)] + 0.5) / 16) continue;
  const at = (y * info.width + x) * 4;
  patch.copy(data, at, at, at + 4);
}
const png = await sharp(data, { raw: info }).png().toBuffer();
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
await fs.mkdir(out, { recursive: true });
await fs.writeFile(`${out}/crownlands.png`, png);
await fs.writeFile(`${out}/manifest.json`, `${JSON.stringify({ version: 3, sourceSize: 1536, worldOriginTiles: -34, worldTiles: 98, tilePx: 32, files: [{ id: 'crownlands', path: 'crownlands.png', sha256: sha(png), width: 1536, height: 1536 }] }, null, 2)}\n`);
await fs.writeFile(`${root}art/fantasy-ground-v3/provenance.json`, `${JSON.stringify({ version: 1, purpose: 'Remove two painted boulder clusters from buildable Crownlands ground without changing gameplay obstacles.', original: { path: 'art/fantasy-ground-v2/ground/crownlands.png', sha256: sha(original) }, study: { path: 'art/fantasy-ground-v3/source/crownlands-clean-study.png', sha256: sha(study), provider: 'OpenAI built-in image generation', edit: 'Remove only the central boulder clusters near (890,681) and (642,909); preserve the pixel-art grass and all surrounding geography.' }, derivative: { path: 'art/fantasy-ground-v3/ground/crownlands.png', sha256: sha(png), regions, feather, method: 'Nearest-neighbor study scaling, bounded patches, 4x4 ordered edge selection; all pixels outside patches copied unchanged from v2.' } }, null, 2)}\n`);
console.log(JSON.stringify({ path: `${out}/crownlands.png`, sha256: sha(png), regions }));
