/** Before enabling companion routing, compare only admission settings in the
 * two running containers. Never dump an env file or Docker Config.Env.
 * pnpm --filter @shardkeep/scripts exec tsx src/check-native-admission.ts \
 *   --main-container shardkeep-api-1 --companion-container shardkeep-native-presentation-1
 */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADMISSION_FIELDS = ['ALPHA_WALLETS', 'ADMIN_WALLETS', 'PLAYTEST_OPEN', 'MULTI_BASE_ENABLED'] as const;
type Field = typeof ADMISSION_FIELDS[number];
type Values = Record<Field, string | null>;
export type ContainerProbe = (file: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => string;

/** Mirrors config.ts: blank lists are unset, comma-only lists are present and
 * empty, wallet order/duplicates do not matter, and flags require exact case. */
export function normalizeAdmission(raw: unknown): Record<Field, string[] | null | boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).length !== ADMISSION_FIELDS.length) throw new Error('invalid admission projection');
  const values = raw as Values;
  for (const field of ADMISSION_FIELDS) {
    if (!Object.hasOwn(values, field) || (values[field] !== null && typeof values[field] !== 'string')) {
      throw new Error(`invalid admission field: ${field}`);
    }
  }
  const wallets = (field: 'ALPHA_WALLETS' | 'ADMIN_WALLETS') => {
    const rawValue = values[field];
    if (rawValue === null || rawValue.trim() === '') return null;
    const parts = [...new Set(rawValue.split(',').map((value) => value.trim()).filter(Boolean))].sort();
    if (parts.some((value) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))) {
      throw new Error(`invalid admission field: ${field}`);
    }
    return parts;
  };
  const flag = (field: 'PLAYTEST_OPEN' | 'MULTI_BASE_ENABLED') => {
    const value = values[field];
    if (value !== null && value !== 'false' && value !== 'true') throw new Error(`invalid admission field: ${field}`);
    return value === 'true';
  };
  return { ALPHA_WALLETS: wallets('ALPHA_WALLETS'), ADMIN_WALLETS: wallets('ADMIN_WALLETS'),
    PLAYTEST_OPEN: flag('PLAYTEST_OPEN'), MULTI_BASE_ENABLED: flag('MULTI_BASE_ENABLED') };
}

export function assertAdmissionParity(main: unknown, companion: unknown): void {
  const left = normalizeAdmission(main); const right = normalizeAdmission(companion);
  const mismatches = ADMISSION_FIELDS.filter((field) => JSON.stringify(left[field]) !== JSON.stringify(right[field]));
  if (mismatches.length) throw new Error(`native admission mismatch: ${mismatches.join(', ')}`);
}

export function readContainerAdmission(container: string, run: ContainerProbe = execFileSync): unknown {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) throw new Error('invalid container name');
  // Projection happens inside the container. No unrelated environment value
  // crosses the process boundary, and stderr is discarded on every failure.
  const script = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(ADMISSION_FIELDS)}.map(key=>[key,process.env[key]??null]))))`;
  try {
    const output = run('docker', ['exec', container, 'node', '-e', script], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 64 * 1024,
    });
    const selected: unknown = JSON.parse(String(output));
    normalizeAdmission(selected);
    return selected;
  } catch { throw new Error('cannot verify selected container admission settings'); }
}

export function checkNativeAdmission(args: string[]): void {
  if (args.length !== 4 || args[0] !== '--main-container' || args[2] !== '--companion-container' || args[1] === args[3]) {
    throw new Error('usage: --main-container NAME --companion-container NAME (distinct containers required)');
  }
  assertAdmissionParity(readContainerAdmission(args[1]!), readContainerAdmission(args[3]!));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkNativeAdmission(process.argv.slice(2));
    process.stdout.write(`native admission parity verified: ${ADMISSION_FIELDS.join(', ')}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'native admission check failed'}\n`);
    process.exitCode = 1;
  }
}
