/** Canonical retained publication declaration and unsigned message. No DB or RPC. */
import { ComputeBudgetProgram, PublicKey, TransactionMessage } from '@solana/web3.js';
import { z } from 'zod';
import { PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import { buildPublishMiningInstruction } from '@shardkeep/chain/mining-program';
const MAX_PACKET_BYTES = 1232;
const COMPUTE_UNIT_LIMIT = 400_000; // Technical allowance exercised by mining-local-lifecycle.ts.
const amount = z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine(v => /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= (1n << 64n) - 1n);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const address = z.string().max(44).refine(v => {
  if (v.length > 44) return false; // Zod max does not short-circuit refinements.
  try { return new PublicKey(v).toBase58() === v; } catch { return false; }
});
export const miningPublicationSchema = z.object({
  signer: address, programId: address, keepMint: address, reserveOwner: address,
  sequence: amount, root: hash, total: amount, leafCount: z.number().int().positive(), kind: z.literal(0), day: amount,
  budgetGross: amount, freeGross: amount, deedGross: amount, playerNet: amount, recycle: amount, tax: amount,
  taxCommitment: hash, taxVersion: z.union([z.literal(POLICY.version),z.literal(2)]), splitStart: z.number().int().min(0).max(POLICY.splitPeriod - 1),
  splitEnd: z.number().int().min(0).max(POLICY.splitPeriod - 1), blockhash: address,
  lastValidBlockHeight: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  blockhashContextSlot: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type PreparedMiningPublication = Readonly<{
  status: 'prepared'; epochId: string; attemptKey: string; manifestJson: string; sourceHash: string;
  intentHex: string; intentSha256: string; publication: Readonly<z.infer<typeof miningPublicationSchema>>;
  preparedAt: string; publicationFinalized: false; consumptionAuthorized: false;
}>;
export function miningPublicationMessage(p: PreparedMiningPublication['publication'], sourceHash: string): Buffer {
  const signer = new PublicKey(p.signer);
  const instruction = buildPublishMiningInstruction({ programId: new PublicKey(p.programId), keepMint: new PublicKey(p.keepMint), reserveOwner: new PublicKey(p.reserveOwner) }, {
    signer, args: { sequence: BigInt(p.sequence), root: Buffer.from(p.root, 'hex'), totalCumulative: BigInt(p.total), leafCount: p.leafCount, kind: 0,
      day: BigInt(p.day), budgetGross: BigInt(p.budgetGross), freeGross: BigInt(p.freeGross), deedGross: BigInt(p.deedGross),
      sourceHash: Buffer.from(sourceHash, 'hex'), taxCommitment: Buffer.from(p.taxCommitment, 'hex'), taxVersion: p.taxVersion },
  });
  const message = new TransactionMessage({ payerKey: signer, recentBlockhash: p.blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }), instruction] }).compileToLegacyMessage();
  const bytes = Buffer.from(message.serialize());
  if (message.header.numRequiredSignatures !== 1 || 1 + 64 + bytes.length > MAX_PACKET_BYTES) throw new Error('Invalid mining publication envelope');
  return bytes;
}
