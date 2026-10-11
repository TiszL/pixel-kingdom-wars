/** Test-only generated wallets and the real server planner. Never imported by UI. */
import { Keypair, Transaction, Message, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { PHASE_E_MINING_CLAIM_QUOTE, TOKEN } from '@shardkeep/shared';
import type { MiningClaimPreparationView, MiningClaimStatusView, MiningClaimView } from '@shardkeep/shared/miningClaimsApi';
import { buildMiningClaimMessages } from '../../../../../packages/chain/src/miningClaimMessage';
import { hashMiningAllocationLeaf } from '../../../../../packages/chain/src/miningAllocationProof';
import { miningConfigPda, MINING_PROGRAM_ADDRESS } from '../../../../../packages/chain/src/miningProgramProtocol';

export function miningClaimFixture() {
  const signer = Keypair.generate(), wallet = signer.publicKey.toBase58();
  const programId = new PublicKey(MINING_PROGRAM_ADDRESS), keepMint = Keypair.generate().publicKey, reserveOwner = Keypair.generate().publicKey;
  const trust = { genesisHash: Keypair.generate().publicKey.toBase58(), programId: programId.toBase58(), keepMint: keepMint.toBase58(),
    reserveOwner: reserveOwner.toBase58(), configAddress: miningConfigPda(programId).toBase58() };
  const leaf = { wallet, sequence: 1n, cumulativeKeep: 80n, cumulativeRenown: 1n, cumulativeDays: 1n };
  const root = hashMiningAllocationLeaf(leaf), blockhash = Keypair.generate().publicKey.toBase58();
  const plan = buildMiningClaimMessages({ programId, keepMint, reserveOwner }, { wallet: signer.publicKey, sequence: 1n, day: 1n,
    root, totalCumulative: 80n, leaf, proof: [], blockhash, needsAta: true, needsMinerRecords: true });
  const now = Date.parse('2035-01-01T00:00:00.000Z'), iso = new Date(now).toISOString();
  const preparation: MiningClaimPreparationView = { version: 1, wallet, idempotencyKey: crypto.randomUUID(), claimId: crypto.randomUUID(), quoteId: '',
    quoteVersion: PHASE_E_MINING_CLAIM_QUOTE.version, rootSequence: '1', day: '1', root: Buffer.from(root).toString('hex'), totalCumulativeBaseUnits: '80', identity: trust,
    leaf: { wallet, rootSequence: '1', cumulativeKeepBaseUnits: '80', cumulativeRenown: '1', cumulativeDays: '1' }, proof: [], needsAta: true, needsMinerRecords: true,
    fees: { feeLamports: '5000', rentLamports: '10000', totalLamports: '15000', payerBalanceLamports: '1000000' },
    transactions: plan.transactions.map((tx, ordinal) => ({ ordinal, kind: tx.kind, version: 'legacy', message: Buffer.from(tx.messageBytes).toString('base64'),
      lookupTables: [], feePayer: wallet, blockhash, lastValidBlockHeight: 250, feeLamports: '5000', rentLamports: '10000' })),
    preparedAt: iso, expiresAt: new Date(now + PHASE_E_MINING_CLAIM_QUOTE.ttlSec * 1000).toISOString(), serverNow: iso, state: 'prepared',
    currentSigningAuthorized: false, claimSubmissionAuthorized: false };
  preparation.quoteId = preparation.claimId;
  const signed = () => {
    const transaction = Transaction.populate(Message.from(Buffer.from(preparation.transactions[0]!.message, 'base64')), [bs58.encode(new Uint8Array(64))]);
    transaction.partialSign(signer);
    return { ordinal: 0, wire: transaction.serialize().toString('base64'), signature: bs58.encode(transaction.signature!) };
  };
  const status = (): MiningClaimStatusView => ({ features: { claims: { version: 1, receipts: 1 } }, wallet, program: 'shardkeep-economy',
    programId: trust.programId, keepMint: trust.keepMint, state: 'ready', reason: null, rootSequence: '1', cumulativeKeepBaseUnits: '80',
    claimedBaseUnits: '0', claimableBaseUnits: '80', decimals: TOKEN.decimals, observedSlot: 3003, chainUnixTimestamp: '7201', claimableAfterUnixTimestamp: '7200',
    needsAta: true, needsMinerRecords: true, preparationAllowed: true, claimSubmissionAuthorized: false, serverNow: iso });
  const claim = (state: 'unknown' | 'prepared' | 'retained' | 'settled' | 'failed'): MiningClaimView => {
    const failed = state === 'failed', retained = state === 'retained' || state === 'settled' || failed, paid = state === 'settled', signature = retained ? signed().signature : null;
    return { version: 1, wallet, claimId: preparation.claimId, state, landing: paid ? 'finalized' : failed ? 'failed' : 'pending', signature,
      settledBaseUnits: paid ? '80' : null, serverNow: iso, claimSubmissionAuthorized: false,
      transactions: state === 'unknown' ? [] : [{ ordinal: 0, kind: 'combined', signature, landing: paid ? 'finalized' : failed ? 'failed' : 'pending',
        settledBaseUnits: paid ? '80' : null, acceptedAt: retained ? iso : null, settledAt: paid || failed ? iso : null }] };
  };
  return { preparation, identity: { origin: 'https://fixture.example', api: 'https://fixture.example/api', cluster: 'devnet' as const, wallet },
    signer, trust, now, claim, signed, status };
}
