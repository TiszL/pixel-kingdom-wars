/** Serialized generated-IDL fixtures, deliberately separate from SDK decoders. */
import anchorPkg, { type Idl } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { TOKEN, PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import idl from '../idl/shardkeep_economy.json' with { type: 'json' };
import { miningConfigPda, miningEpochPda } from '../miningProgramProtocol';
import { seekerAuctionConfigPda, seekerRegistryPda, seekerTermPda, seekerAuctionPda, seekerAuthorityPda } from '../seekerAuctionProtocol';
import { hashMiningTermTaxIdentity, hashMiningTaxCommitment, miningTermTaxPoolPda, miningTaxEpochReceiptPda, miningTaxSpotCursorPda } from '../miningTaxCommitment';
const { BN, BorshCoder } = anchorPkg;
export const taxFixtureCoder = new BorshCoder(idl as Idl);
export const taxKey = (n: number) => new PublicKey(Buffer.alloc(32, n));
function modelValue(v: unknown): unknown {
 if (typeof v === 'bigint') return new BN(v.toString());
 if (v instanceof PublicKey) return v;
 if (v instanceof Uint8Array) return [...v];
 if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, modelValue(value)]));
 return v;
}
export async function createMiningTaxFixture() {
 const p = new PublicKey(idl.address), keepMint = taxKey(3), reserveOwner = taxKey(2), winner = taxKey(4), payer = taxKey(5);
 const config = miningConfigPda(p), auctionConfig = seekerAuctionConfigPda(p), registry = seekerRegistryPda(p);
 const round = 5n, day = 24n, spot = 7, sec = BigInt(POLICY.daySec), epoch = miningEpochPda(p, day);
 const term = { programId: p, config, keepMint, auctionConfig, term: seekerTermPda(p, auctionConfig, round), registry,
  registryHash: new Uint8Array(32).fill(9), round, auctionStart: 22n * sec, auctionEnd: 23n * sec,
  operatingStart: 23n * sec, operatingEnd: 30n * sec, winnerCount: 3 };
 const pool = miningTermTaxPoolPda(p, term.term), accrual = miningTaxEpochReceiptPda(p, epoch), cursor = miningTaxSpotCursorPda(p, pool, spot);
 const bump = (seed: string, ...tails: Buffer[]) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...tails], p)[1];
 const le = Buffer.alloc(8); le.writeBigUInt64LE(day);
 const models = {
  config: { version: 1, authority: seekerAuthorityPda(p), publisher: payer, keep_mint: keepMint,
   mining_vault: getAssociatedTokenAddressSync(keepMint, config, true), emission_reserve_owner: reserveOwner,
   emission_reserve_ata: getAssociatedTokenAddressSync(keepMint, reserveOwner, true), decimals: TOKEN.decimals,
   genesis_day: 22n, latest_day: day, latest_sequence: 3n, total_published: 800n, total_published_highwater: 800n,
   total_claimed: 30n, tax_highwater: 100n, tax_paid: 3n, recycled_total: 100n, gross_published: 1000n,
   split_cursor: 0, flags: 35, correction_pending: false, bump: bump('economy') },
  pool: { version: 2, distribution_version: 1, config, term: term.term, term_identity: hashMiningTermTaxIdentity(term),
   winner_count: term.winnerCount, accrued: 10n, paid: 3n, bump: bump('mining_tax_pool', config.toBuffer(), term.term.toBuffer()) },
  epoch: { version: 1, config, day, budget_gross: 100n, free_gross: 5n, deed_gross: 95n, player_net: 80n, tax: 10n,
   recycle: 10n, source_hash: new Uint8Array(32).fill(1), tax_commitment: hashMiningTaxCommitment(term, { day, epoch }),
   tax_version: 2, split_start: 0, split_end: 0, funded_at: (day + 1n) * sec, bump: bump('mining_epoch', le) },
  accrual: { version: 2, config, pool, epoch, amount: 10n, accrued_at: (day + 1n) * sec + BigInt(POLICY.claimDelaySec),
   bump: bump('mining_tax_epoch', config.toBuffer(), epoch.toBuffer()) },
  cursor: { version: 2, pool, auction: seekerAuctionPda(p, auctionConfig, spot, round), wallet: winner,
   spot, claimed_total: 3n, bump: bump('mining_tax_spot', pool.toBuffer(), Buffer.of(spot)) },
 };
 const names = { config: 'EconomyConfig', pool: 'MiningTaxPool', epoch: 'MiningEpochReceipt', accrual: 'MiningTaxAccrual', cursor: 'MiningTaxSpot' } as const;
 const addresses = { config, pool, epoch, accrual, cursor };
 async function raw(which: keyof typeof models) {
  return { address: addresses[which], owner: p, executable: false,
   data: await taxFixtureCoder.accounts.encode(names[which], modelValue(models[which]) as object) };
 }
 const identity = { programId: p, keepMint, reserveOwner };
 return { identity, term, day, spot, winner, payer, models, addresses, raw,
  async context() { return { identity, term, config: await raw('config') }; },
  async accrualContext() { return { ...await this.context(), pool: await raw('pool'), epoch: await raw('epoch'), day }; },
  async cursorContext() { return { ...await this.context(), pool: await raw('pool'), spot, winner }; },
 };
}
