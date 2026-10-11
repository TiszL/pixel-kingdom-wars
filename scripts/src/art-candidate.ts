import fs from 'node:fs/promises';
import path from 'node:path';

import {
  GAME_ART_CONTRACT_SCHEMA,
  gameArtContractSha256,
  type GameArtContract,
  type GameArtIdentity,
} from './game-art-contract.js';
import {
  GAME_ART_PACK_SCHEMA,
  GAME_ART_PROVENANCE_SCHEMA,
  loadGameArtPack,
  type GameArtPackManifest,
  type GameArtPackProvenance,
} from './game-art-pack.js';

export const ART_CANDIDATE_ENV = 'SHARDKEEP_ART_CANDIDATE_ROOT' as const;

export const ART_CANDIDATE_FILES = [
  {
    identity: 'ware:ware_bld_keep_l20_idle',
    logicalFile: 'keep/bld_keep_l20_idle.png',
    acceptedFile: 'art/game-v4/buildings/keep/l20/idle.png',
    sha256: '77f32c407c5bfdd413c467819b77c85fac8f7e0826d851c488151c8b7e60c635',
    width: 432,
    height: 136,
    pixelLaw: 'game-v4-proof-exact-v1',
  },
  {
    identity: 'v2:v2_trp_giant_t4_walk',
    logicalFile: 'giant/trp_giant_t4_walk.png',
    acceptedFile: 'art/game-v4/actors/giant/t4/walk.png',
    sha256: '28abded5a203d2d874a2f234b5e2b0ab4b96a3e4a661e347461dd45b4014fad7',
    width: 896,
    height: 896,
    pixelLaw: 'game-v4-proof-exact-v1',
  },
  {
    identity: 'v2:v2_trp_giant_t4_throw',
    logicalFile: 'giant/trp_giant_t4_throw.png',
    acceptedFile: 'art/game-v4/actors/giant/t4/throw.png',
    sha256: 'e09736d00f4a2befcec555023f7379a16897e51ec5da4b18ff339561e74e4e77',
    width: 672,
    height: 896,
    pixelLaw: 'game-v4-proof-exact-v1',
  },
] as const;

export type ArtCandidateLogicalFile = typeof ART_CANDIDATE_FILES[number]['logicalFile'];
export type ArtCandidatePixelLaw = typeof ART_CANDIDATE_FILES[number]['pixelLaw'];

export interface ArtCandidatePixelValidators {
  ware(data: Buffer, label: string): void;
  v2(data: Buffer, label: string): void;
}

export interface ArtCandidate {
  /** Stable, secret-free names suitable for emitted provenance metadata. */
  logicalFiles: readonly ArtCandidateLogicalFile[];
  /** Defensive copy of the validated in-memory snapshot; never rereads disk. */
  readRenderSource(logicalFile: ArtCandidateLogicalFile): Buffer;
}

export interface ArtCandidateEnvironment {
  SHARDKEEP_ART_CANDIDATE_ROOT?: string | undefined;
  NODE_ENV?: string | undefined;
  CI?: string | undefined;
}

interface NormalizationProvenanceOutput {
  file: string;
  sha256: string;
  width: number;
  height: number;
}

function booleanEnvironmentValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

async function loadNormalizationOutputs(candidateRoot: string): Promise<Map<string, NormalizationProvenanceOutput>> {
  const provenanceFile = path.join(path.dirname(candidateRoot), 'provenance', 'normalization.json');
  let encoded: string;
  try {
    encoded = await fs.readFile(provenanceFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${ART_CANDIDATE_ENV} normalization provenance is missing`);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error(`${ART_CANDIDATE_ENV} normalization provenance is not valid JSON`);
  }
  const record = parsed as Record<string, unknown> | null;
  if (!record || record.schemaVersion !== 2
      || record.normalizer !== 'shardkeep-provider-proof-normalizer'
      || !Array.isArray(record.outputs)) {
    throw new Error(`${ART_CANDIDATE_ENV} normalization provenance has an unsupported schema`);
  }

  const expected = new Map(ART_CANDIDATE_FILES.map((spec) => [
    `candidate/${spec.logicalFile}`,
    spec,
  ]));
  const outputs = new Map<string, NormalizationProvenanceOutput>();
  for (const raw of record.outputs) {
    const output = raw as Partial<NormalizationProvenanceOutput> | null;
    if (!output || typeof output.file !== 'string' || !expected.has(output.file)) {
      throw new Error(`${ART_CANDIDATE_ENV} normalization provenance contains an unexpected output`);
    }
    if (outputs.has(output.file)) {
      throw new Error(`${ART_CANDIDATE_ENV} normalization provenance contains a duplicate output ${output.file}`);
    }
    const spec = expected.get(output.file)!;
    if (output.width !== spec.width || output.height !== spec.height
        || output.sha256 !== spec.sha256) {
      throw new Error(`${ART_CANDIDATE_ENV} normalization provenance is invalid for ${output.file}`);
    }
    outputs.set(output.file, output as NormalizationProvenanceOutput);
  }
  if (outputs.size !== expected.size) {
    throw new Error(`${ART_CANDIDATE_ENV} normalization provenance must describe exactly three outputs`);
  }
  return outputs;
}

/**
 * Resolve and validate the complete three-file proof as one unit. Nothing is
 * returned until the inventory, dimensions, PNG encoding, and accepted
 * game-v4 SHA256 pins all pass, which prevents a partially generated or
 * palette-remapped candidate from entering atlases.
 */
export async function resolveArtCandidate(
  environment: ArtCandidateEnvironment,
  _validators: ArtCandidatePixelValidators,
): Promise<ArtCandidate | null> {
  const root = environment.SHARDKEEP_ART_CANDIDATE_ROOT?.trim();
  if (!root) return null;
  if (environment.NODE_ENV?.trim().toLowerCase() === 'production') {
    throw new Error(`${ART_CANDIDATE_ENV} is forbidden when NODE_ENV=production`);
  }
  if (booleanEnvironmentValue(environment.CI)) {
    throw new Error(`${ART_CANDIDATE_ENV} is forbidden in CI`);
  }
  if (!path.isAbsolute(root)) {
    throw new Error(`${ART_CANDIDATE_ENV} must be an absolute path`);
  }

  const provenanceOutputs = await loadNormalizationOutputs(root);
  const contract: GameArtContract = {
    schemaVersion: GAME_ART_CONTRACT_SCHEMA,
    entries: ART_CANDIDATE_FILES.map(({ identity, width, height, pixelLaw }) => ({
      identity, width, height, pixelLaw,
    })),
  };
  const manifest: GameArtPackManifest = {
    schemaVersion: GAME_ART_PACK_SCHEMA,
    packId: 'provider-proof',
    profile: 'candidate',
    contractSha256: gameArtContractSha256(contract),
    scope: ART_CANDIDATE_FILES.map(({ identity }) => identity),
    entries: ART_CANDIDATE_FILES.map(({ identity, logicalFile }) => ({
      identity,
      file: logicalFile,
      sha256: provenanceOutputs.get(`candidate/${logicalFile}`)!.sha256,
    })),
  };
  const provenance: GameArtPackProvenance = {
    schemaVersion: GAME_ART_PROVENANCE_SCHEMA,
    producer: 'shardkeep-provider-proof-normalizer',
    outputs: ART_CANDIDATE_FILES.map(({ identity, logicalFile, width, height }) => ({
      identity,
      file: logicalFile,
      sha256: provenanceOutputs.get(`candidate/${logicalFile}`)!.sha256,
      width,
      height,
    })),
  };
  const pack = await loadGameArtPack({
    root,
    expectedProfile: 'candidate',
    contract,
    manifest,
    provenance,
    // The proof root is PNG-only, unlike permanent game-v4 (whose labs/docs
    // live outside its managed art directories), so reject every extra file.
    managedRoots: ['.'],
    pixelValidators: {
      // The manifest hash is the pixel law for this bounded proof. It pins the
      // complete encoded accepted sheet, so applying the older Ware/v2 closed
      // palettes here would mutate or reject the approved game-v4 colors.
      'game-v4-proof-exact-v1': ({ data }, entry) => {
        for (let offset = 0; offset < data.length; offset += 4) {
          const alpha = data[offset + 3]!;
          if (alpha !== 0 && alpha !== 255) {
            throw new Error(`${entry.identity}: accepted proof sheet has non-binary alpha`);
          }
          if (alpha === 0 && (data[offset] !== 0 || data[offset + 1] !== 0 || data[offset + 2] !== 0)) {
            throw new Error(`${entry.identity}: accepted proof sheet has nonzero transparent RGB`);
          }
        }
      },
    },
  });

  const identityByLogicalFile = new Map<ArtCandidateLogicalFile, GameArtIdentity>(
    ART_CANDIDATE_FILES.map(({ logicalFile, identity }) => [logicalFile, identity]),
  );

  return {
    logicalFiles: ART_CANDIDATE_FILES.map(({ logicalFile }) => logicalFile),
    readRenderSource(logicalFile): Buffer {
      const identity = identityByLogicalFile.get(logicalFile);
      if (!identity) throw new Error(`unknown art candidate logical file ${logicalFile}`);
      return pack.readPng(identity);
    },
  };
}
