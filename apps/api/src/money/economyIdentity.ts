import { keepAta } from '@shardkeep/chain';
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { economyChainIdentity } from '../db/schema';
import { SPL_TOKEN_PROGRAM_ID, type FinalizedAccountReader } from './reserves';

export interface EconomyChainBinding {
  cluster: Config['SOLANA_CLUSTER'];
  keepMint: string;
  coreProgram: string;
  configPda: string;
}
function same(a: EconomyChainBinding, b: EconomyChainBinding): boolean {
  return a.cluster === b.cluster && a.keepMint === b.keepMint
    && a.coreProgram === b.coreProgram && a.configPda === b.configPda;
}

/** Bind a database to one economy chain identity. Serving code never rebinds. */
export async function assertEconomyChainIdentity(
  db: Db, selected: EconomyChainBinding, knownDevnet: EconomyChainBinding,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('shardkeep:economy-chain-identity'))`);
    const [existing] = await tx.select().from(economyChainIdentity).limit(1).for('update');
    if (existing) {
      if (!same(existing as EconomyChainBinding, selected)) {
        throw new Error(
          `database economy identity is ${existing.cluster}/${existing.keepMint}, `
          + `but runtime selected ${selected.cluster}/${selected.keepMint}; serving is refused`,
        );
      }
      return;
    }

    const [state] = await tx.execute(sql<{ nonempty: boolean }>`
      SELECT EXISTS(SELECT 1 FROM players)
          OR EXISTS(SELECT 1 FROM accounts)
          OR EXISTS(SELECT 1 FROM ledger_transactions) AS nonempty
    `);
    if (state?.nonempty && (selected.cluster !== 'devnet' || !same(selected, knownDevnet))) {
      throw new Error(
        'nonempty legacy database may bind only the known devnet economy identity; '
        + 'mainnet requires a separate reviewed, drained owner migration',
      );
    }
    await tx.insert(economyChainIdentity).values({ singleton: true, ...selected });
  });
}

interface GemsReserveBinding { owner: string; ata: string; mint: string }
const verifiedReserves = new WeakMap<Db, Readonly<GemsReserveBinding>>();
type GemsReserveConfig = Pick<Config, 'GEMS_RESERVE_OWNER' | 'GEMS_RESERVE_ATA' | 'HOT_WALLET_PUBKEY'>;

/** K-153: PDA/multisig owners are valid, but every destination is the canonical
 * Classic SPL ATA. A configured ATA is only an operator equality assertion. */
export async function verifyGemsReserveAccount(
  config: GemsReserveConfig, keepMint: string, readers: readonly FinalizedAccountReader[],
): Promise<GemsReserveBinding | null> {
  if (!config.GEMS_RESERVE_OWNER) {
    if (config.GEMS_RESERVE_ATA) throw new Error('GEMS_RESERVE_ATA requires GEMS_RESERVE_OWNER');
    return null;
  }
  if (!config.HOT_WALLET_PUBKEY) throw new Error('Gems reserve requires a known custody hot wallet');
  const owner = new PublicKey(config.GEMS_RESERVE_OWNER);
  const mint = new PublicKey(keepMint);
  const ata = keepAta(owner, mint, true);
  if (ata.equals(keepAta(new PublicKey(config.HOT_WALLET_PUBKEY), mint, true))) {
    throw new Error('Gems reserve must not be the custody hot ATA');
  }
  if (config.GEMS_RESERVE_ATA && config.GEMS_RESERVE_ATA !== ata.toBase58()) {
    throw new Error('GEMS_RESERVE_ATA does not match the canonical reserve ATA');
  }
  if (readers.length === 0) throw new Error('Gems reserve needs finalized RPC evidence');
  for (const rpc of readers) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        rpc.getAccountInfoAndContext(ata, 'finalized'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('finalized Gems reserve read timed out')), 5_000);
        }),
      ]);
      const info = response.value;
      if (!Number.isSafeInteger(response.context.slot) || response.context.slot < 0) {
        throw new Error('Gems reserve has invalid finalized slot evidence');
      }
      if (!info || info.executable || !info.owner.equals(SPL_TOKEN_PROGRAM_ID)) {
        throw new Error('Gems reserve is missing or has the wrong token program');
      }
      const data = info.data;
      // Classic SPL layout only; Token-2022 extensions and native SOL wrapping
      // are not supported by the KEEP reserve policy.
      if (data.length !== 165) throw new Error('Gems reserve has invalid token account data');
      if (!new PublicKey(data.subarray(0, 32)).equals(mint)) throw new Error('Gems reserve has wrong mint');
      if (!new PublicKey(data.subarray(32, 64)).equals(owner)) throw new Error('Gems reserve has wrong authority');
      if (data[108] !== 1) throw new Error('Gems reserve must be initialized and not frozen');
      if (data.readUInt32LE(72) !== 0 || data.readBigUInt64LE(121) !== 0n) {
        throw new Error('Gems reserve must have no delegate');
      }
      if (data.readUInt32LE(129) !== 0) throw new Error('Gems reserve must have no close authority');
      if (data.readUInt32LE(109) !== 0) throw new Error('Gems reserve must not be a native token account');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return { owner: owner.toBase58(), ata: ata.toBase58(), mint: mint.toBase58() };
}

/** Startup only: prove first, pin once under the chain-identity lock, then admit
 * the destination for this database handle. Failed startup never publishes an
 * unverified target. Removing configuration after binding is drift, even dark.
 * Account authority governance remains a separately reviewed reserve ceremony. */
export async function assertGemsReserveIdentity(
  db: Db, config: GemsReserveConfig, selected: EconomyChainBinding,
  readers: readonly FinalizedAccountReader[],
): Promise<void> {
  verifiedReserves.delete(db);
  const reserve = await verifyGemsReserveAccount(config, selected.keepMint, readers);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('shardkeep:economy-chain-identity'))`);
    const [identity] = await tx.select().from(economyChainIdentity).limit(1).for('update');
    if (!identity || !same(identity as EconomyChainBinding, selected)) {
      throw new Error('Gems reserve requires the selected database economy chain identity');
    }
    if (identity.gemsReserveOwner !== null || identity.gemsReserveAta !== null) {
      if (identity.gemsReserveOwner !== reserve?.owner || identity.gemsReserveAta !== reserve?.ata) {
        throw new Error('database Gems reserve identity differs from runtime; serving is refused');
      }
    } else if (reserve) {
      await tx.update(economyChainIdentity).set({ gemsReserveOwner: reserve.owner, gemsReserveAta: reserve.ata });
    }
  });
  if (reserve) verifiedReserves.set(db, Object.freeze(reserve));
}

/** Creation and capabilities use only the startup-verified destination. Already
 * paid deposits recover from their frozen row regardless of this binding. */
export function gemsReserveAta(db: Db, expectedMint?: string): string | null {
  const reserve = verifiedReserves.get(db);
  return reserve && (expectedMint === undefined || expectedMint === reserve.mint) ? reserve.ata : null;
}
