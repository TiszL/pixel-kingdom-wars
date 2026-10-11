/**
 * Client-side shardkeep-core instruction builders (R9 entry flow).
 *
 * Hand-encoded from the committed IDL (packages/chain/src/idl/shardkeep_core
 * .json) instead of pulling @coral-xyz/anchor into the bundle: every payment
 * ix is 8 discriminator bytes (+ a u8 index for expansion, or a kind/u64
 * amount for repeatable sinks) over a
 * fixed account list. Devnet addresses come from the checked-in public
 * registry; a mainnet build must receive every payment address explicitly in
 * its reviewed VITE_ environment (never hardcode program/treasury keys here).
 *
 * The `reference` account is the server-minted deposit-intent key (POST
 * /deposits): a no-op account the deposit watcher looks up signatures for.
 */
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { SOLANA } from './cluster';

export const CORE_PROGRAM_ID = new PublicKey(SOLANA.addresses.coreProgram);
const CONFIG = new PublicKey(SOLANA.addresses.config);
const TREASURY_LIQUIDITY = new PublicKey(SOLANA.addresses.treasuries.liquidity);
const TREASURY_DEV = new PublicKey(SOLANA.addresses.treasuries.dev);
const TREASURY_OPS = new PublicKey(SOLANA.addresses.treasuries.ops);

// Anchor instruction discriminators (IDL `instructions[].discriminator`).
const DISC_PAY_ENTRY = [187, 10, 90, 67, 83, 172, 196, 207];
const DISC_BUY_EXPANSION = [240, 15, 88, 142, 33, 215, 48, 32];
const DISC_BUY_SINK = [220, 121, 168, 150, 121, 25, 213, 14];

/** buy_sink payment `kind` byte (lib.rs PAYMENT_KIND_*). Repeatable SOL sinks.
 *  `mine` (5) was retired 2026-07-20 — mine UPGRADES now pay SOL 100% to the
 *  liquidity wallet via a direct transfer (buildSolPaymentTx), not the buy_sink
 *  40/35/25 split, aligning them with mine builds. The on-chain PAYMENT_KIND_MINE
 *  constant stays dead-but-harmless (no client emits it). */
export const SINK_KIND = {
  energy: 3, shield: 4, warzone_shield: 6, energy_pack: 7, builder: 8, deed: 9,
} as const;
export type SinkKind = keyof typeof SINK_KIND;

/** Little-endian u64 encoder for the buy_sink `amount` arg (lamports). */
function u64le(n: bigint): number[] {
  if (n < 0n || n > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError('amount does not fit in an unsigned 64-bit integer');
  }
  const out: number[] = [];
  let v = n;
  for (let i = 0; i < 8; i++) { out.push(Number(v & 0xffn)); v >>= 8n; }
  return out;
}

/** Mirrors packages/chain playerPda — seeds ['player', wallet]. */
export function playerPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('player'), wallet.toBytes()],
    CORE_PROGRAM_ID,
  )[0];
}

/** Shared account list of pay_entry / buy_expansion (IDL order). */
function paymentKeys(wallet: PublicKey, reference: PublicKey) {
  return [
    { pubkey: CONFIG, isSigner: false, isWritable: false },
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: playerPda(wallet), isSigner: false, isWritable: true },
    { pubkey: TREASURY_LIQUIDITY, isSigner: false, isWritable: true },
    { pubkey: TREASURY_DEV, isSigner: false, isWritable: true },
    { pubkey: TREASURY_OPS, isSigner: false, isWritable: true },
    { pubkey: reference, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}

function paymentTx(wallet: PublicKey, reference: PublicKey, data: number[]): Transaction {
  return new Transaction().add(new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: paymentKeys(wallet, reference),
    data: Buffer.from(data),
  }));
}

/** pay_entry: 0.2 SOL split on-chain 40/35/25; inits the one-per-wallet Player PDA. */
export function buildPayEntryTx(wallet: PublicKey, reference: PublicKey): Transaction {
  return paymentTx(wallet, reference, DISC_PAY_ENTRY);
}

/** buy_expansion(index): index = expansions already purchased (0-based). */
export function buildBuyExpansionTx(wallet: PublicKey, reference: PublicKey, index: number): Transaction {
  return paymentTx(wallet, reference, [...DISC_BUY_EXPANSION, index]);
}

/** buy_sink account list — repeatable SOL sinks (energy/shield). No Player PDA:
 *  the instruction takes only config, the payer, the three treasuries, the
 *  reference, and the system program (IDL order). */
function sinkKeys(wallet: PublicKey, reference: PublicKey) {
  return [
    { pubkey: CONFIG, isSigner: false, isWritable: false },
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: TREASURY_LIQUIDITY, isSigner: false, isWritable: true },
    { pubkey: TREASURY_DEV, isSigner: false, isWritable: true },
    { pubkey: TREASURY_OPS, isSigner: false, isWritable: true },
    { pubkey: reference, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}

/** buy_sink(kind, amount): a repeatable SOL payment for raid energy or a shield
 *  extension, split on-chain 40/35/25 like every other payment. `amountLamports`
 *  is the shared-constant price; the server re-checks it before granting. */
export function buildBuySinkTx(
  wallet: PublicKey, reference: PublicKey, kind: SinkKind, amountLamports: bigint,
): Transaction {
  const data = Buffer.from([...DISC_BUY_SINK, SINK_KIND[kind], ...u64le(amountLamports)]);
  return new Transaction().add(new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: sinkKeys(wallet, reference),
    data,
  }));
}

// --- KEEP deposit (inbound) — a plain SPL TransferChecked to the hot wallet's
// KEEP ATA, tagged with the deposit-intent reference (Solana Pay). Hand-encoded
// so the web bundle needs no @solana/spl-token. The server returns source/dest
// ATAs + decimals in the deposit intent, so the client only assembles the ix. --

/** SPL Token program id (Tokenkeg…). */
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/** SPL Token instruction index for TransferChecked. */
const IX_TRANSFER_CHECKED = 12;

/** Build the KEEP deposit transfer. The reference is appended as an extra
 *  read-only account — the token program ignores it, but the deposit watcher
 *  finds the tx by it (getSignaturesForAddress). */
export function buildKeepDepositTx(params: {
  source: PublicKey; mint: PublicKey; destination: PublicKey; owner: PublicKey;
  reference: PublicKey; amountBaseUnits: bigint; decimals: number;
}): Transaction {
  const data = Buffer.from([IX_TRANSFER_CHECKED, ...u64le(params.amountBaseUnits), params.decimals]);
  return new Transaction().add(new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.source, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.destination, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
      { pubkey: params.reference, isSigner: false, isWritable: false },
    ],
    data,
  }));
}

/** A native SOL transfer to `to`, reference-tagged (Solana Pay). Used for mine
 *  builds, whose SOL goes 100% to the liquidity pool wallet (owner 2026-07-19) —
 *  a direct transfer, NOT the 40/35/25 buy_sink split. */
export function buildSolPaymentTx(params: {
  from: PublicKey; to: PublicKey; lamports: bigint; reference: PublicKey;
}): Transaction {
  const ix = SystemProgram.transfer({
    fromPubkey: params.from, toPubkey: params.to, lamports: params.lamports,
  });
  ix.keys.push({ pubkey: params.reference, isSigner: false, isWritable: false });
  return new Transaction().add(ix);
}

/** Item-market buy (Lane B): ONE buyer-signed tx, TWO legs — 95% to the seller
 *  and 5% to our fee treasury — sharing the reservation `reference` so the
 *  server's split verifier confirms both on the same finalized tx. Non-custodial:
 *  SOL leaves the buyer's wallet straight to the seller + fee, never a game
 *  wallet. Atomic: neither leg can land without the other. */
export function buildMarketBuyTx(params: {
  buyer: PublicKey; seller: PublicKey; feeTreasury: PublicKey;
  sellerLamports: bigint; feeLamports: bigint; reference: PublicKey;
}): Transaction {
  const { buyer, seller, feeTreasury, sellerLamports, feeLamports, reference } = params;
  const sellerLeg = SystemProgram.transfer({ fromPubkey: buyer, toPubkey: seller, lamports: sellerLamports });
  sellerLeg.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
  const feeLeg = SystemProgram.transfer({ fromPubkey: buyer, toPubkey: feeTreasury, lamports: feeLamports });
  return new Transaction().add(sellerLeg, feeLeg);
}

/** Warzone shield (#49): ONE transaction, TWO legs, ONE wallet approval — a direct
 *  SOL transfer of `directLamports` STRAIGHT to the liquidity wallet (the 50%) PLUS
 *  a buy_sink(kind=6, `splitLamports`) that the program routes 40/35/25 (the other
 *  50%). Both ixs share the one deposit-intent `reference`, so the server's two-leg
 *  verifier can confirm both on the same finalized tx. Atomic: neither leg can land
 *  without the other. */
export function buildWarzoneShieldTx(params: {
  wallet: PublicKey; reference: PublicKey; directLamports: bigint; splitLamports: bigint;
}): Transaction {
  const { wallet, reference, directLamports, splitLamports } = params;
  const direct = SystemProgram.transfer({ fromPubkey: wallet, toPubkey: TREASURY_LIQUIDITY, lamports: directLamports });
  direct.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
  const sink = new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: sinkKeys(wallet, reference),
    data: Buffer.from([...DISC_BUY_SINK, SINK_KIND.warzone_shield, ...u64le(splitLamports)]),
  });
  return new Transaction().add(direct).add(sink);
}

/** True when a program error means "this wallet already paid entry" (Player
 * PDA `init` hit an existing account) — the watcher's PDA fallback will still
 * credit the intent, so the client should fall through to polling. */
export function isAlreadyPaidError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /already in use|already been processed/i.test(msg);
}
