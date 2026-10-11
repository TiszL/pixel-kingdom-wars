/**
 * SFX pipeline (GDD §3.11 manifest, ARCHITECTURE §3; build-order task #4).
 *
 * scripts/audio-presets/<name>.json (checked-in, hand-tuned jsfxr synth
 * params per sound, grouped by preset family) → jsfxr WAV synthesis →
 * apps/web/public/audio/sfx/<name>.wav (44.1kHz 8-bit mono — Phaser loads
 * the individual files directly; audiosprite/music deferred per task spec).
 *
 * Determinism: jsfxr's NOISE waveform fills its noise buffer from
 * Math.random(). We swap Math.random for a mulberry32 PRNG seeded from the
 * sound name during synthesis, so every run emits bit-identical WAVs.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import jsfxr from 'jsfxr';

import {
  SOUND_GENERATION_CONTRACT,
  SOUND_GENERATION_CONTRACT_SHA256,
} from './audio-generation-contract.js';
import { promotedRuntimeFile } from './audio-runtime-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PRESETS_DIR = path.join(ROOT, 'scripts', 'audio-presets');
export const SFX_DIR = path.join(ROOT, 'apps', 'web', 'public', 'audio', 'sfx');
export const AUDIO_DIR = path.dirname(SFX_DIR);
export const PROMOTED_SFX_DIR = path.join(ROOT, 'scripts', 'audio-production', 'masters');
export const PRODUCTION_SFX_CATALOG = path.join(ROOT, 'scripts', 'audio-production', 'catalog.json');
export const AI_SFX_DIR = path.join(AUDIO_DIR, 'sfx-ai');
const PRODUCTION_SFX_EXPORTS = 247;

/** Owner-authored themes copied byte-for-byte; runtime routing chooses the mood. */
export const MUSIC_TRACKS = [
  { source: 'newbgmusic.mp3', output: 'bgmusic-world.mp3' },
  { source: 'bgmusic.mp3', output: 'bgmusic-battle.mp3' },
] as const;

/** One-release rolling alias for already-open clients from the previous web
 * build. They still request `/audio/bgmusic.mp3`; deleting that URL during the
 * static publish would silence them until their soft-update reload completes. */
export const LEGACY_MUSIC_TRACK = { source: 'bgmusic.mp3', output: 'bgmusic.mp3' } as const;

/** The full SFX manifest from GDD §3.11 (8 UI/meta + 5 build + 15 battle + 3 stars + 4 hero — owner 2026-07-28). */
export const SFX_NAMES: readonly string[] = [
  // UI/meta
  'sfx_tap',
  'sfx_confirm',
  'sfx_error',
  'sfx_claim_chime',
  'sfx_coin_shower',
  'sfx_quest_done',
  'sfx_levelup',
  'sfx_streak_tick',
  // Build
  'sfx_place_thump',
  'sfx_build_complete',
  'sfx_upgrade_hammer',
  'sfx_rubble_crash',
  'sfx_wall_clink',
  // Battle
  'sfx_deploy_pop',
  'sfx_sword_hit',
  'sfx_bow_shot',
  'sfx_arrow_hit',
  'sfx_cannon_fire',
  'sfx_mortar_thunk',
  'sfx_shell_whistle',
  'sfx_keg_fuse',
  'sfx_explosion_big',
  'sfx_trap_snap',
  'sfx_burrow_loop',
  'sfx_emerge_pop',
  'sfx_rally_horn',
  'sfx_shield_up',
  'sfx_shield_shatter',
  // Stars (escalating)
  'sfx_star_1',
  'sfx_star_2',
  'sfx_star_3',
  // Heroes (owner 2026-07-28: heroes get their own SFX, not borrowed generics)
  'sfx_hero_dash',
  'sfx_hero_quake',
  'sfx_hero_deploy_vex',
  'sfx_hero_deploy_theo',
];

// --- deterministic Math.random swap ----------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function withSeededRandom<T>(seed: number, fn: () => T): T {
  const original = Math.random;
  Math.random = mulberry32(seed);
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

// --- synthesis --------------------------------------------------------------

export function synthesizeWav(name: string, presetJson: Record<string, unknown>): Buffer {
  // Strip "_"-prefixed metadata keys (e.g. _family, _desc) before fromJSON,
  // which copies every own property onto the params object.
  const params = new jsfxr.Params();
  const synthParams: Record<string, number> = {};
  for (const [key, value] of Object.entries(presetJson)) {
    if (key.startsWith('_')) continue;
    if (typeof value !== 'number') throw new Error(`${name}: preset key '${key}' is not a number`);
    synthParams[key] = value;
  }
  params.fromJSON(synthParams);

  const sound = withSeededRandom(fnv1a(name), () => new jsfxr.SoundEffect(params).generate());
  const match = sound.dataURI.match(/^data:audio\/wav;base64,(.+)$/);
  if (!match) throw new Error(`${name}: jsfxr returned unexpected dataURI`);
  return Buffer.from(match[1]!, 'base64');
}

/** Keep MP3 encoding and embedded provenance intact while producing logical URLs. */
export async function copyMusicTracks(outputDir = AUDIO_DIR): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  for (const track of [...MUSIC_TRACKS, LEGACY_MUSIC_TRACK]) {
    await fs.copyFile(
      path.join(ROOT, 'art/source/soundtrack', track.source),
      path.join(outputDir, track.output),
    );
  }
}

/**
 * Publish only hash-pinned, review-gated AI masters. The approved source lives
 * outside generated public assets, so `pnpm assets` can never overwrite it.
 */
interface PromotedManifestEntry {
  id: string;
  file: string;
  sha256: string;
  loopStart?: number;
  loopEnd?: number;
}

export function validatePromotedManifest(
  rawManifest: unknown,
  rawCatalog: unknown,
  catalogSha256: string,
): PromotedManifestEntry[] {
  if (typeof rawCatalog !== 'object' || rawCatalog === null) throw new Error('production SFX catalog is invalid');
  const catalog = rawCatalog as { schemaVersion?: unknown; entries?: unknown };
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries)
      || catalog.entries.length !== PRODUCTION_SFX_EXPORTS) {
    throw new Error(`production SFX catalog must contain exactly ${PRODUCTION_SFX_EXPORTS} entries`);
  }
  const expected = new Map<string, { file: string; loop: boolean }>();
  for (const candidate of catalog.entries) {
    if (typeof candidate !== 'object' || candidate === null) throw new Error('production SFX catalog entry is invalid');
    const entry = candidate as { id?: unknown; loop?: unknown; outputFile?: unknown; runtimeTargetName?: unknown };
    if (typeof entry.id !== 'string'
        || !/^sfx_(?:troop|hero|defense|ui|base|battle|ambience)_[a-z0-9_]+_v[1-3]$/.test(entry.id)
        || typeof entry.loop !== 'boolean' || typeof entry.outputFile !== 'string'
        || typeof entry.runtimeTargetName !== 'string' || expected.has(entry.id)) {
      throw new Error('production SFX catalog contains an invalid or duplicate ID');
    }
    const file = promotedRuntimeFile({
      id: entry.id,
      loop: entry.loop,
      outputFile: entry.outputFile,
      runtimeTargetName: entry.runtimeTargetName,
    });
    if (!/\.(mp3|wav)$/.test(file) || (entry.loop && !file.endsWith('.wav'))
        || file !== path.posix.normalize(file) || file.startsWith('/')
        || file.startsWith('../') || file.includes('/../')) {
      throw new Error(`${entry.id}: production catalog runtime file is unsafe`);
    }
    expected.set(entry.id, { file, loop: entry.loop });
  }

  if (typeof rawManifest !== 'object' || rawManifest === null) throw new Error('promoted SFX manifest is invalid');
  const manifest = rawManifest as {
    schemaVersion?: unknown;
    catalogSha256?: unknown;
    generationContract?: unknown;
    generationContractSha256?: unknown;
    entries?: unknown;
  };
  if (manifest.schemaVersion !== 1 || manifest.catalogSha256 !== catalogSha256
      || manifest.generationContractSha256 !== SOUND_GENERATION_CONTRACT_SHA256
      || JSON.stringify(manifest.generationContract) !== JSON.stringify(SOUND_GENERATION_CONTRACT)
      || !Array.isArray(manifest.entries) || manifest.entries.length !== PRODUCTION_SFX_EXPORTS) {
    throw new Error('promoted SFX manifest count, catalog SHA, or generation contract is invalid');
  }
  const ids = new Set<string>();
  const outputs = new Set<string>();
  const result: PromotedManifestEntry[] = [];
  for (const candidate of manifest.entries) {
    if (typeof candidate !== 'object' || candidate === null) throw new Error('promoted SFX manifest contains an invalid entry');
    const entry = candidate as { id?: unknown; file?: unknown; sha256?: unknown; loopStart?: unknown; loopEnd?: unknown };
    if (typeof entry.id !== 'string' || !expected.has(entry.id) || ids.has(entry.id)
        || typeof entry.file !== 'string' || typeof entry.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(entry.sha256) || outputs.has(entry.file)) {
      throw new Error('promoted SFX manifest contains a duplicate, unknown, or invalid entry');
    }
    const expectedEntry = expected.get(entry.id)!;
    const hasLoop = entry.loopStart !== undefined || entry.loopEnd !== undefined;
    if (entry.file !== expectedEntry.file || hasLoop !== expectedEntry.loop
        || (hasLoop && (typeof entry.loopStart !== 'number' || typeof entry.loopEnd !== 'number'
          || !Number.isFinite(entry.loopStart) || !Number.isFinite(entry.loopEnd)
          || entry.loopStart < 0 || entry.loopStart >= entry.loopEnd))) {
      throw new Error(`${entry.id}: promoted runtime file or loop contract differs from catalog`);
    }
    ids.add(entry.id);
    outputs.add(entry.file);
    result.push({
      id: entry.id,
      file: entry.file,
      sha256: entry.sha256,
      ...(hasLoop ? { loopStart: entry.loopStart as number, loopEnd: entry.loopEnd as number } : {}),
    });
  }
  if (ids.size !== expected.size || [...expected.keys()].some((id) => !ids.has(id))) {
    throw new Error('promoted SFX manifest does not exactly match the production catalog IDs');
  }
  return result;
}

export async function copyPromotedSfx(
  sourceDir = PROMOTED_SFX_DIR,
  outputDir = AI_SFX_DIR,
  catalogPath = PRODUCTION_SFX_CATALOG,
): Promise<{ count: number; bytes: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sourceDir, 'manifest.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await fs.rm(outputDir, { recursive: true, force: true });
      return { count: 0, bytes: 0 };
    }
    throw error;
  }
  const catalogBytes = await fs.readFile(catalogPath);
  const catalogSha256 = createHash('sha256').update(catalogBytes).digest('hex');
  const entries = validatePromotedManifest(JSON.parse(raw), JSON.parse(catalogBytes.toString('utf8')), catalogSha256);
  const approved: Array<{
    id: string;
    file: string;
    sha256: string;
    audio: Buffer;
    loopStart?: number;
    loopEnd?: number;
  }> = [];
  let bytes = 0;
  for (const entry of entries) {
    if (!/\.(mp3|wav)$/.test(entry.file) || entry.file !== path.posix.normalize(entry.file)
        || entry.file.startsWith('/') || entry.file.startsWith('../') || entry.file.includes('/../')) {
      throw new Error('promoted SFX manifest contains an unsafe file');
    }
    const isLoop = entry.loopStart !== undefined && entry.loopEnd !== undefined;
    if (isLoop && !entry.file.endsWith('.wav')) {
      throw new Error(`${entry.id}: loops must publish WAV`);
    }
    const source = path.join(sourceDir, entry.file);
    const audio = await fs.readFile(source);
    const digest = createHash('sha256').update(audio).digest('hex');
    if (digest !== entry.sha256) throw new Error(`${entry.id}: promoted SFX hash mismatch`);
    approved.push({
      id: entry.id,
      file: entry.file,
      sha256: entry.sha256,
      audio,
      ...(typeof entry.loopStart === 'number' && typeof entry.loopEnd === 'number'
        ? { loopStart: entry.loopStart, loopEnd: entry.loopEnd }
        : {}),
    });
    bytes += audio.length;
  }

  await fs.mkdir(path.dirname(outputDir), { recursive: true });
  const temporaryOutput = await fs.mkdtemp(path.join(path.dirname(outputDir), '.sfx-ai-build-'));
  try {
    for (const entry of approved) {
      const destination = path.join(temporaryOutput, entry.file);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, entry.audio);
    }
    await fs.writeFile(path.join(temporaryOutput, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 1,
      catalogSha256,
      generationContractSha256: SOUND_GENERATION_CONTRACT_SHA256,
      entries: approved.map((entry) => ({
        id: entry.id,
        file: entry.file,
        sha256: entry.sha256,
        ...(entry.loopStart !== undefined && entry.loopEnd !== undefined
          ? { loopStart: entry.loopStart, loopEnd: entry.loopEnd }
          : {}),
      })),
    }, null, 2)}\n`);
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.rename(temporaryOutput, outputDir);
  } catch (error) {
    await fs.rm(temporaryOutput, { recursive: true, force: true });
    throw error;
  }
  return { count: entries.length, bytes };
}

export async function runAudio(): Promise<{ count: number; bytes: number }> {
  const presetFiles = (await fs.readdir(PRESETS_DIR)).filter((f) => f.endsWith('.json')).sort();
  const presetNames = presetFiles.map((f) => f.replace(/\.json$/, ''));

  // Fail loud on any drift from the GDD §3.11 manifest.
  const expected = new Set(SFX_NAMES);
  const missing = SFX_NAMES.filter((n) => !presetNames.includes(n));
  const extra = presetNames.filter((n) => !expected.has(n));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `audio-presets/ does not match GDD §3.11 manifest. missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`,
    );
  }

  await fs.rm(SFX_DIR, { recursive: true, force: true });
  await fs.mkdir(SFX_DIR, { recursive: true });

  let bytes = 0;
  for (const name of presetNames) {
    const raw = await fs.readFile(path.join(PRESETS_DIR, `${name}.json`), 'utf8');
    const wav = synthesizeWav(name, JSON.parse(raw) as Record<string, unknown>);
    await fs.writeFile(path.join(SFX_DIR, `${name}.wav`), wav);
    bytes += wav.length;
  }

  // Owner 2026-08-14: the new theme is normal world/menu music; retain the old
  // theme for battles. Copy rather than transcode so the owner-authored MP3 bytes
  // and embedded Suno provenance survive the generated-asset build unchanged.
  await copyMusicTracks();
  const promoted = await copyPromotedSfx();

  console.log(`audio done: ${presetNames.length} legacy SFX WAVs (${(bytes / 1024).toFixed(0)} KiB) + ${promoted.count} reviewed AI runtime files (${(promoted.bytes / 1024).toFixed(0)} KiB) + ${MUSIC_TRACKS.length} music tracks + legacy alias → ${AUDIO_DIR}`);
  return { count: presetNames.length, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAudio().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
