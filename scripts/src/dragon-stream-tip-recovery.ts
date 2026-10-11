/** Exact Dragon T4 recovery studies, not an asset selector. Literal SVG RGB
 * recovery was rejected for visual style; it remains source-mask authority.
 * A palette-corrected candidate must pass separate geometry/palette checks AND
 * visual review before an exact-hash release selection can activate it.
 * Masters and historical packs are never destinations. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

export const DRAGON_TIP_LITERAL_STUDY = {
  version: 1,
  key: 'v2_fx_stream_tip_t4',
  original: 'art/source/troops-rework-core/assets/fx_stream_tip_t4.svg',
  originalSha256: 'b9933ab793f4e45254fc7012019f8944fcc3005d81e06533021bef180aeab023',
  master: 'art/game-v4/fx/v2-v2_fx_stream_tip_t4.png',
  masterSha256: '3b5eab25d6449028190288d2923b39a872f41fe4d37745cd1122de615093cd01',
  output: '.reports/dragon-stream-tip-recovery-v1/recovered.png',
} as const;

/** Exact engineering-reviewed correction; unrelated studies cannot become its
 * input. The runtime overlay separately pins this same final PNG hash. */
export const DRAGON_TIP_PALETTE_CORRECTION = {
  key: 'v2_fx_stream_tip_t4',
  output: 'art/game-v4/fx/v2/stream_tip/t4.png',
  outputSha256: '57787109af05b9116b6ce4a750fdc6d53b127747d23aa20bdd21d0d38db4327c',
  providerRecord: 'art/repairs/dragon-tip-t4-2026-09-15/flame-palette-result.json',
  providerRecordSha256: '84ae2a7fc7054eb4b33f03f8033dce81bd8db4693ba426decf81ed0cb2e24642',
} as const;

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Rejected visual study; do not substitute this flat-color output for the
 * detailed palette correction. Also used to verify exact original masks. */
export async function recoverLiteralDragonTipStudy(original: Buffer, master: Buffer): Promise<Buffer> {
  if (sha256(original) !== DRAGON_TIP_LITERAL_STUDY.originalSha256 || sha256(master) !== DRAGON_TIP_LITERAL_STUDY.masterSha256) {
    throw new Error('Dragon tip recovery source hash changed; review the exact damaged sheet');
  }
  // Source manifest: @1x, four 48×56 cells, anchor (0,28), loop at 14fps.
  const decoded = await Promise.all([
    sharp(new Resvg(original, { shapeRendering: 1 }).render().asPng()).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(master).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (decoded.some(({ info }) => info.width !== 192 || info.height !== 56 || info.channels !== 4)) {
    throw new Error('Dragon tip recovery geometry changed');
  }
  const source = decoded[0]!.data;
  const output = Buffer.from(decoded[1]!.data);
  for (let y = 0; y < 56; y++) for (let x = 0; x < 192; x++) {
    const offset = (y * 192 + x) * 4;
    if (source[offset + 3] !== output[offset + 3]) throw new Error('Dragon tip recovery alpha mask changed');
    if (x >= 144 || !source[offset + 3]) continue;
    if (output[offset] || output[offset + 1] || output[offset + 2]) {
      throw new Error('Dragon tip recovery refuses to replace a colored pixel');
    }
    source.copy(output, offset, offset, offset + 3);
  }
  return sharp(output, { raw: { width: 192, height: 56, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
}

/** Study packaging only: preserve provider RGB inside the authored mask. The
 * one reviewed missing outline pixel has exact source authority; any other
 * missing color rejects the whole sheet. This never selects runtime assets. */
export async function packageDragonTipReferenceEdit(original: Buffer, master: Buffer, frames: readonly Buffer[]): Promise<{
  png: Buffer;
  restoredSourcePixels: Array<{ frame: number; x: number; y: number }>;
  clippedOutsidePixels: number[];
}> {
  if (frames.length !== 3) throw new Error('Dragon tip reference edit requires exactly three frames');
  // The literal recovery verifies both pinned masters, geometry and every alpha
  // pixel, then supplies exact authored RGB for the only permitted restoration.
  const authored = await sharp(await recoverLiteralDragonTipStudy(original, master)).ensureAlpha().raw().toBuffer();
  const output = await sharp(master).ensureAlpha().raw().toBuffer();
  const restoredSourcePixels: Array<{ frame: number; x: number; y: number }> = [];
  const clippedOutsidePixels: number[] = [];
  for (const [frame, png] of frames.entries()) {
    const edited = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (edited.info.width !== 48 || edited.info.height !== 56 || edited.info.channels !== 4) {
      throw new Error('Dragon tip reference edit geometry changed');
    }
    let clipped = 0;
    for (let y = 0; y < 56; y++) for (let x = 0; x < 48; x++) {
      const sourceOffset = (y * 192 + frame * 48 + x) * 4;
      const editOffset = (y * 48 + x) * 4;
      const alpha = authored[sourceOffset + 3]!;
      if (!alpha) {
        if (edited.data[editOffset + 3]) clipped++;
        output.fill(0, sourceOffset, sourceOffset + 4);
        continue;
      }
      if (!edited.data[editOffset + 3]) {
        if (frame !== 0 || x !== 21 || y !== 30) {
          throw new Error(`Dragon tip reference edit missing unreviewed source pixel: ${frame + 1},${x},${y}`);
        }
        authored.copy(output, sourceOffset, sourceOffset, sourceOffset + 4);
        restoredSourcePixels.push({ frame: frame + 1, x, y });
      } else {
        edited.data.copy(output, sourceOffset, editOffset, editOffset + 3);
        output[sourceOffset + 3] = alpha;
      }
    }
    clippedOutsidePixels.push(clipped);
  }
  return { png: await sharp(output, { raw: { width: 192, height: 56, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer(),
    restoredSourcePixels, clippedOutsidePixels };
}

/** Only validate and stitch a provider palette conversion. No RGB or alpha
 * repair is allowed here. Palette membership is not visual approval: spatial
 * contour/shading distribution still requires review of the whole loop. */
export async function finalizePaletteDragonTipCandidate(original: Buffer, master: Buffer, frames: readonly Buffer[]): Promise<Buffer> {
  if (frames.length !== 3) throw new Error('Dragon tip palette candidate requires exactly three frames');
  await recoverLiteralDragonTipStudy(original, master); // Pins both authorities and their identical masks.
  const output = await sharp(master).ensureAlpha().raw().toBuffer();
  const palette = new Set<string>();
  for (let y = 0; y < 56; y++) for (let x = 144; x < 192; x++) {
    const offset = (y * 192 + x) * 4;
    if (output[offset + 3]) palette.add(output.subarray(offset, offset + 3).toString('hex'));
  }
  for (const [frame, png] of frames.entries()) {
    const edited = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (edited.info.width !== 48 || edited.info.height !== 56 || edited.info.channels !== 4) {
      throw new Error('Dragon tip palette candidate geometry changed');
    }
    for (let y = 0; y < 56; y++) for (let x = 0; x < 48; x++) {
      const sourceOffset = (y * 192 + frame * 48 + x) * 4;
      const editOffset = (y * 48 + x) * 4;
      if (edited.data[editOffset + 3] !== output[sourceOffset + 3]) throw new Error('Dragon tip palette candidate alpha changed');
      if (!output[sourceOffset + 3]) { output.fill(0, sourceOffset, sourceOffset + 4); continue; }
      if (!palette.has(edited.data.subarray(editOffset, editOffset + 3).toString('hex'))) {
        throw new Error('Dragon tip palette candidate uses a color outside intact frame four');
      }
      edited.data.copy(output, sourceOffset, editOffset, editOffset + 4);
    }
  }
  return sharp(output, { raw: { width: 192, height: 56, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
}

/** Reproduce accepted bytes from retained provider output without another
 * provider call, stochastic regeneration, palette remapping or master write. */
export async function reproduceSelectedDragonTipCorrection(root: string): Promise<Buffer> {
  const recipe = DRAGON_TIP_PALETTE_CORRECTION;
  const bytes = await fs.readFile(path.join(root, recipe.providerRecord));
  if (sha256(bytes) !== recipe.providerRecordSha256) throw new Error('Selected Dragon tip provider record hash changed');
  const record = JSON.parse(bytes.toString('utf8')) as { content: Array<{ type: string; data?: string; mimeType?: string }> };
  const images = record.content.filter((block) => block.type === 'image');
  if (images.length !== 3 || images.some(({ data, mimeType }) => !data || mimeType !== 'image/png')) {
    throw new Error('Selected Dragon tip provider record frames changed');
  }
  const png = await finalizePaletteDragonTipCandidate(
    await fs.readFile(path.join(root, DRAGON_TIP_LITERAL_STUDY.original)),
    await fs.readFile(path.join(root, DRAGON_TIP_LITERAL_STUDY.master)),
    images.map(({ data }) => Buffer.from(data!, 'base64')),
  );
  if (sha256(png) !== recipe.outputSha256) throw new Error('Selected Dragon tip correction hash changed');
  return png;
}

/** Reproduce only the rejected literal study; never an accepted runtime fix.
 * Additive and idempotent only for identical existing bytes. */
export async function writeLiteralDragonTipStudy(root: string): Promise<{ path: string; sha256: string }> {
  const original = await fs.readFile(path.join(root, DRAGON_TIP_LITERAL_STUDY.original));
  const master = await fs.readFile(path.join(root, DRAGON_TIP_LITERAL_STUDY.master));
  const png = await recoverLiteralDragonTipStudy(original, master);
  const target = path.join(root, DRAGON_TIP_LITERAL_STUDY.output);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.writeFile(target, png, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await fs.readFile(target)).equals(png)) throw error;
  }
  return { path: DRAGON_TIP_LITERAL_STUDY.output, sha256: sha256(png) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  if (process.argv[2] === '--literal-study') console.log(JSON.stringify(await writeLiteralDragonTipStudy(root)));
  else {
    const png = await reproduceSelectedDragonTipCorrection(root);
    if (!(await fs.readFile(path.join(root, DRAGON_TIP_PALETTE_CORRECTION.output))).equals(png)) throw new Error('Selected Dragon tip artifact differs from reproduced bytes');
    console.log(JSON.stringify({ status: 'selected-correction-verified', path: DRAGON_TIP_PALETTE_CORRECTION.output, sha256: sha256(png) }));
  }
}
