/** League policy projection only. No chain, build, signing, or deployment work. */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEAGUES, PHASE_E_LEAGUE_REWARDS } from '@shardkeep/shared';

export const LEAGUE_CONSTANTS_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../programs/shardkeep-league/src/constants.rs',
);

export interface LeagueConstantsInput {
  readonly maxPlaces: number;
  readonly claimWindowSec: number;
  readonly claimWindowMaxSec: number;
  readonly settlementDelayMs: number;
}

// Encoding bounds belong to this protocol, not shared game policy. The proof
// verifier admits at most ten siblings; a larger tree is never a valid input.
const MAX_PROOF_DEPTH = 10;
const U16_MAX = 0xffff;
const I64_MAX = (1n << 63n) - 1n;

function sharedInput(): LeagueConstantsInput {
  const skr = PHASE_E_LEAGUE_REWARDS.v1.skr;
  return {
    maxPlaces: skr.maxPlaces,
    claimWindowSec: skr.claimWindowSec,
    claimWindowMaxSec: skr.claimWindowMaxSec,
    settlementDelayMs: LEAGUES.settlementDelayMs,
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid shared positive integer for ${name}`);
  }
  return value;
}

function positiveI64(value: number, name: string): number {
  const integer = positiveInteger(value, name);
  if (BigInt(integer) > I64_MAX) throw new Error(`Shared integer exceeds i64 for ${name}`);
  return integer;
}

/** Pure renderer; every monetary/calendar policy value comes from shared input. */
export function generateLeagueConstants(input: LeagueConstantsInput = sharedInput()): string {
  if (input === null || typeof input !== 'object') throw new Error('Invalid league constants input');
  const maxPlaces = positiveInteger(input.maxPlaces, 'LEAGUE_SKR_MAX_PLACES');
  if (maxPlaces > U16_MAX) throw new Error('League maximum places exceeds u16');
  if (maxPlaces > 2 ** MAX_PROOF_DEPTH) {
    throw new Error('League maximum places exceeds the supported proof depth');
  }
  const claimWindowSec = positiveI64(input.claimWindowSec, 'LEAGUE_CLAIM_WINDOW_SEC');
  const claimWindowMaxSec = positiveI64(input.claimWindowMaxSec, 'LEAGUE_CLAIM_WINDOW_MAX_SEC');
  if (claimWindowSec > claimWindowMaxSec) throw new Error('League claim window exceeds its ceiling');
  const settlementDelayMs = positiveInteger(input.settlementDelayMs, 'LEAGUE_SETTLEMENT_DELAY_MS');
  if (settlementDelayMs % 1_000 !== 0) {
    throw new Error('League settlement delay must be an exact number of seconds');
  }
  const settlementDelaySec = positiveI64(settlementDelayMs / 1_000, 'LEAGUE_SETTLEMENT_DELAY_SEC');
  const bitmapBytes = Math.ceil(maxPlaces / 8);
  const rows: ReadonlyArray<readonly [string, 'u16' | 'usize' | 'i64', number]> = [
    ['LEAGUE_SKR_MAX_PLACES', 'u16', maxPlaces],
    ['LEAGUE_BITMAP_BYTES', 'usize', bitmapBytes],
    ['LEAGUE_SETTLEMENT_DELAY_SEC', 'i64', settlementDelaySec],
    ['LEAGUE_CLAIM_WINDOW_SEC', 'i64', claimWindowSec],
    ['LEAGUE_CLAIM_WINDOW_MAX_SEC', 'i64', claimWindowMaxSec],
  ];
  return '// @generated projection target: scripts/src/generate-league-constants.ts.\n'
    + '// Source: packages/shared/src/constants.ts; regenerate after accepted policy composition.\n'
    + rows.map(([name, type, value]) => `pub const ${name}: ${type} = ${value};\n`).join('')
    + '\n// Bitmap width must track the generated place limit at compile time.\n'
    + 'const _: () = assert!(LEAGUE_BITMAP_BYTES == (LEAGUE_SKR_MAX_PLACES as usize + 7) / 8);\n';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('Usage: generate-league-constants.ts [--check]');
  }
  const expected = generateLeagueConstants();
  if (args[0] === '--check') {
    if (await readFile(LEAGUE_CONSTANTS_FILE, 'utf8') !== expected) {
      throw new Error('League constants drift; run the generator after accepted shared policy composition');
    }
  } else {
    await writeFile(LEAGUE_CONSTANTS_FILE, expected);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
