/** review 68d06fbe: a separately reviewed wallet-only KEEP identity.
 * No registry loader, network, binding writer or automatic legacy migration.
 * The receipt pins the privately supplied ceremony/deployment review packet;
 * configuration and a matching row alone are not new chain evidence. */
import { keepAta, SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

export interface PhaseEKeepSelection {
  readonly SOLANA_CLUSTER: 'devnet' | 'mainnet-beta';
  readonly PHASE_E_KEEP_IDENTITY?: 'disabled' | 'keep-v4' | undefined;
  readonly PHASE_E_KEEP_RESERVE_OWNER?: string | undefined;
  readonly HOT_WALLET_PUBKEY?: string | undefined;
}
export interface PhaseEKeepRegistry {
  readonly cluster: string;
  readonly keepMint: string;
  readonly keepMintV4?: string | undefined;
}
export interface PhaseEKeepDeployment {
  readonly reviewedDeploymentSlot: number;
  readonly reviewedProgramDataSha256: string;
  readonly upgradeAuthority: string | null;
}
export interface PhaseEKeepReviewedBinding {
  readonly cluster: 'devnet';
  readonly genesisHash: string;
  readonly keepMint: string;
  readonly economyProgram: string;
  readonly craftProgram: string;
  readonly treasury: string;
  readonly reserveOwner: string;
  readonly reserveAta: string;
  readonly bindingReceiptSha256: string;
  readonly economyDeployment: PhaseEKeepDeployment;
}
export interface PhaseEKeepIdentity extends PhaseEKeepReviewedBinding { readonly kind: 'keep-v4' }

// Public accepted roles, not secrets or inferred ceremony outputs. The actual
// mint and deployment slot/hash remain absent until a reviewed packet exists.
const EXPECTED = Object.freeze({
  economyProgram: '5qyN1Xbe2L16t7MPwwcD5QGmLYAnGF4VjN9BXtazvzkr',
  craftProgram: '4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59',
  treasury: '9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q',
  reserveOwner: 'CVKo5i8ax2kiKe9nSB4LfCpBEbyfaLcq8S8bWXsvKo1Q',
});
const MINT_AUTHORITY = 'A3MRaRRDw6qJfYu8Z8xZfHcSWNEZuMc91nQ2cCurQXEP';
const OPERATOR = 'AvsebCwRDs63UMwKv2xSVCRKB8cxUS4W3B4sNR9SHpKv';
const ECONOMY_UA = 'Ce5HrbPJ2naKQAbQ6Xga55WeFwVDavHhBzc2AsWd6KY8';
const CRAFT_UA = '5cYNJabvsfTUAZBK31yp6ZknKiv9dRdJoBKjggWpDWLV';
const admitted = new WeakSet<PhaseEKeepIdentity>();
function refuse(): never { throw Error('Phase E KEEP identity is missing, mismatched or not reviewed; serving is refused'); }
function rejectObsoleteFields(value: object | undefined, config = false): void {
  if (value && Object.getOwnPropertyNames(value).some(name => /gems[_-]?reserve/i.test(name)
      && (!config || (value as Record<string, unknown>)[name] !== undefined))) {
    throw Error('obsolete gems-reserve identity field');
  }
}
/** Fail before selecting a v4 packet, including env names the config parser
 * would otherwise strip. Undefined declared config options are not supplied. */
export function assertNoObsoletePhaseEKeepConfiguration(config: PhaseEKeepSelection): void {
  if (config.PHASE_E_KEEP_IDENTITY !== 'keep-v4') return;
  rejectObsoleteFields(config, true);
  if (Object.keys(process.env).some(name => /^PHASE_E_.*GEMS_RESERVE/.test(name))) {
    throw Error('obsolete gems-reserve identity field');
  }
}

function address(value: unknown): string {
  if (typeof value !== 'string' || value.length > 44) return refuse();
  try { const key = new PublicKey(value); if (key.equals(PublicKey.default) || key.toBase58() !== value) return refuse(); }
  catch { return refuse(); }
  return value;
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return refuse();
  return value;
}
function copyBinding(input: PhaseEKeepReviewedBinding): PhaseEKeepIdentity {
  rejectObsoleteFields(input);
  if (!input || input.cluster !== 'devnet' || input.genesisHash !== SOLANA_GENESIS_HASH.devnet) return refuse();
  for (const field of Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]) {
    if (address(input[field]) !== EXPECTED[field]) return refuse();
  }
  const keepMint = address(input.keepMint);
  if (new Set<string>([...Object.values(EXPECTED), MINT_AUTHORITY, OPERATOR, ECONOMY_UA, CRAFT_UA]).has(keepMint)) return refuse();
  const reserveAta = keepAta(new PublicKey(input.reserveOwner), new PublicKey(keepMint), true).toBase58();
  if (address(input.reserveAta) !== reserveAta) return refuse();
  const deployment = input.economyDeployment;
  if (!deployment || !Number.isSafeInteger(deployment.reviewedDeploymentSlot) || deployment.reviewedDeploymentSlot < 0
    || deployment.upgradeAuthority !== ECONOMY_UA) return refuse();
  return Object.freeze({ kind: 'keep-v4', cluster: 'devnet', genesisHash: SOLANA_GENESIS_HASH.devnet,
    keepMint, ...EXPECTED, reserveAta, bindingReceiptSha256: sha(input.bindingReceiptSha256),
    economyDeployment: Object.freeze({ reviewedDeploymentSlot: deployment.reviewedDeploymentSlot,
      reviewedProgramDataSha256: sha(deployment.reviewedProgramDataSha256), upgradeAuthority: deployment.upgradeAuthority }) });
}

/** Default-dark selector. KEEP_MINT is deliberately not read. */
export function resolvePhaseEKeepIdentity(
  config: PhaseEKeepSelection, registry: PhaseEKeepRegistry, reviewedBinding?: PhaseEKeepReviewedBinding,
): PhaseEKeepIdentity | null {
  if (config.PHASE_E_KEEP_IDENTITY === undefined || config.PHASE_E_KEEP_IDENTITY === 'disabled') return null;
  assertNoObsoletePhaseEKeepConfiguration(config);
  rejectObsoleteFields(registry); rejectObsoleteFields(reviewedBinding);
  if (config.PHASE_E_KEEP_IDENTITY !== 'keep-v4' || config.SOLANA_CLUSTER !== 'devnet' || registry.cluster !== 'devnet'
      || !reviewedBinding || config.PHASE_E_KEEP_RESERVE_OWNER !== EXPECTED.reserveOwner) return refuse();
  const legacyMint = address(registry.keepMint), selectedMint = address(registry.keepMintV4);
  const identity = copyBinding(reviewedBinding), hot = address(config.HOT_WALLET_PUBKEY);
  if (selectedMint === legacyMint || identity.keepMint !== selectedMint
      || [identity.reserveOwner, OPERATOR].includes(hot)) return refuse();
  return identity;
}

const COLUMNS = Object.freeze({ cluster: 'cluster', genesisHash: 'genesis_hash', keepMint: 'keep_mint',
  economyProgram: 'economy_program', craftProgram: 'craft_program', treasury: 'treasury',
  reserveOwner: 'reserve_owner', reserveAta: 'reserve_ata', bindingReceiptSha256: 'binding_receipt_sha256' } as const);

/** Serving is SELECT-only. Schema installation and the one-time, history-free
 * owner binding are separate reviewed operations. Missing rows are not repaired. */
export async function assertPhaseEKeepIdentity(db: Db, selected: PhaseEKeepIdentity): Promise<PhaseEKeepIdentity> {
  const identity = copyBinding(selected);
  if (selected.kind !== 'keep-v4') return refuse();
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT *
    FROM public.phase_e_chain_identity WHERE singleton=true LIMIT 2`);
  const row = rows[0];
  rejectObsoleteFields(row);
  if (rows.length !== 1 || !row || row.singleton !== true) return refuse();
  for (const field of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
    if (row[COLUMNS[field]] !== identity[field]) return refuse();
  }
  if (!(row.bound_at instanceof Date) || !Number.isFinite(row.bound_at.getTime())) return refuse();
  admitted.add(identity);
  return identity;
}

/** Sync construction gate after the startup DB comparison. An arbitrary object
 * cannot stand in for the independently reviewed and admitted startup binding. */
export function requirePhaseEKeepRuntimeIdentity(
  config: PhaseEKeepSelection, identity: PhaseEKeepIdentity | undefined,
  deployment: { readonly programId: string | undefined; readonly slot: number | undefined;
    readonly sha256: string | undefined; readonly upgradeAuthority?: string | null | undefined },
): PhaseEKeepIdentity {
  assertNoObsoletePhaseEKeepConfiguration(config);
  if (!identity || !admitted.has(identity) || config.PHASE_E_KEEP_IDENTITY !== 'keep-v4'
      || config.SOLANA_CLUSTER !== identity.cluster || config.PHASE_E_KEEP_RESERVE_OWNER !== identity.reserveOwner
      || deployment.programId !== identity.economyProgram || deployment.slot !== identity.economyDeployment.reviewedDeploymentSlot
      || deployment.sha256 !== identity.economyDeployment.reviewedProgramDataSha256
      || (deployment.upgradeAuthority !== undefined && deployment.upgradeAuthority !== identity.economyDeployment.upgradeAuthority)) return refuse();
  const hot = address(config.HOT_WALLET_PUBKEY);
  if ([identity.reserveOwner, OPERATOR].includes(hot)) return refuse();
  return identity;
}

/** review 3149a9f3 N1: only explicit v4 selection moves legacy consumers.
 * A supplied v4 object cannot be silently discarded into the v3 path. */
export function selectPhaseEKeepRuntimeIdentity(
  config: PhaseEKeepSelection, identity: PhaseEKeepIdentity | undefined,
  deployment: Parameters<typeof requirePhaseEKeepRuntimeIdentity>[2],
): PhaseEKeepIdentity | undefined {
  assertNoObsoletePhaseEKeepConfiguration(config);
  if (config.PHASE_E_KEEP_IDENTITY === 'keep-v4') return requirePhaseEKeepRuntimeIdentity(config, identity, deployment);
  if (identity || (config.PHASE_E_KEEP_IDENTITY !== undefined && config.PHASE_E_KEEP_IDENTITY !== 'disabled')) return refuse();
  return undefined;
}
