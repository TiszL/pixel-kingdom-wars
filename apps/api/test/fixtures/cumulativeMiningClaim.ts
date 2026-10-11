/** R1 only: actual DB publications/preparations/receipts, generated claimant
 * signatures, and raw serialized finalized RPC evidence. No live execution.
 * The next publication advances only from a successfully verified claim receipt. */
import { randomUUID } from 'node:crypto';
import { Message, PublicKey, SystemProgram, VersionedTransaction, type CompiledInstruction, type TransactionInstruction, type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import { PHASE_E_MINING_PUBLICATION as POLICY, TOKEN } from '@shardkeep/shared';
import { decodeMiningAllocationLeaf, decodeMiningAllocationProof } from '@shardkeep/chain/mining-allocation';
import { buildMiningClaimMessages } from '@shardkeep/chain/mining-claim-message';
import { createMiningClaimSnapshotReader, type MiningClaimRawAccount, type MiningClaimSnapshot, type MiningClaimSnapshotReader } from '@shardkeep/chain/mining-claim-snapshot';
import type { MiningClaimReceiptReader } from '@shardkeep/chain/mining-claim-receipt';
import { createMiningClaimFixture } from '../../../../packages/chain/src/testFixtures/miningClaim';
import { projectMiningClaimEntitlements } from '../../src/mining/claimEntitlement';
import { createMiningClaimPreparer, type MiningClaimQuoteReader } from '../../src/mining/claimPreparation';
import { getMiningClaimPreparation, type MiningClaimPreparation } from '../../src/mining/claimPreparationStore';
import { acceptMiningClaimSigned } from '../../src/mining/claimSignedStore';
import { createMiningClaimSettlement, getMiningClaimSettlement, type MiningClaimSettlement } from '../../src/mining/claimSettlement';
import { createMiningClaimFailure, getMiningClaimFailure } from '../../src/mining/claimFailure';
import { withCumulativeFreePublicationFixture } from './cumulativeFreePublication';

type PublicationFixture = Parameters<Parameters<typeof withCumulativeFreePublicationFixture>[0]>[0];
type Publication = Awaited<ReturnType<PublicationFixture['first']>>;
type ClaimState = Awaited<ReturnType<typeof createMiningClaimFixture>>;
type PriorClaim = { postSnapshot: MiningClaimSnapshot; post: ClaimState; settlement: MiningClaimSettlement };
const copy = (row: MiningClaimRawAccount | null): MiningClaimRawAccount | null => row ? { ...row, data: Buffer.from(row.data) } : null;
function need(value: unknown, why: string): asserts value { if (!value) throw Error(`Cumulative claim fixture: ${why}`); }
const date = (day: string) => new Date(Number(BigInt(day) * BigInt(POLICY.daySec) * 1000n)).toISOString().slice(0, 10);

async function admission(f: PublicationFixture, publication: Publication, previous: PriorClaim | null) {
  await projectMiningClaimEntitlements(f.conn.db, { epochId: publication.prepared.epochId });
  const h = publication.prepared.publication, sequence = BigInt(h.sequence), day = BigInt(h.day),
    at = publication.chain.fundedAt + BigInt(POLICY.claimDelaySec), bankSlot = publication.chain.contextSlot + 10;
  const raw = await createMiningClaimFixture({ wallet: f.walletSigner.publicKey, day: date(h.day) });
  need(raw.trust.programId.equals(publication.chain.trusted.programId) && raw.trust.keepMint.equals(publication.chain.trusted.keepMint)
    && raw.trust.reserveOwner.equals(publication.chain.trusted.reserveOwner), 'raw fixture encoders must share the exact publication identities');
  const rows = raw.rows.map(copy);
  for (let i = 0; i < 8; i++) rows[i] = copy(publication.backing.rows[i]!);
  rows[0] = copy(publication.chain.accounts[0]!); rows[8] = copy(publication.chain.accounts[2]!); rows[9] = copy(publication.chain.accounts[1]!);
  Buffer.from(rows[1]!.data.buffer, rows[1]!.data.byteOffset, rows[1]!.data.byteLength).writeBigUInt64LE(publication.chain.afterTokenBalance.vaultAfter, 64);
  Buffer.from(rows[2]!.data.buffer, rows[2]!.data.byteOffset, rows[2]!.data.byteLength).writeBigUInt64LE(publication.chain.afterTokenBalance.reserveAfter, 64);
  for (const i of [10, 11, 12, 13]) rows[i] = previous ? copy(previous.post.rows[i]!) : i === 13 ? copy(raw.rows[13]!) : null;
  const clock = Buffer.from(rows[7]!.data); clock.writeBigUInt64LE(BigInt(bankSlot)); clock.writeBigInt64LE(at, 32); rows[7] = { ...rows[7]!, data: clock };
  let bankReads = 0, observedSlot = bankSlot;
  const observe = (slot: number) => {
    observedSlot = Math.max(observedSlot, slot);
    (rows[7]!.data as Buffer).writeBigUInt64LE(BigInt(observedSlot));
  };
  const reader: MiningClaimSnapshotReader = { getGenesisHash: async () => f.identity.genesisHash, getSlot: async () => observedSlot,
    getMultipleAccountsInfoAndContext: async () => { bankReads++; return { context: { slot: observedSlot }, value: rows.map(copy) }; } };
  const trust = publication.chain.trusted;
  const before = await createMiningClaimSnapshotReader(reader, trust)({ wallet: f.walletSigner.publicKey, sequence, day });
  if (previous) {
    need(previous.settlement.claimFinalized, 'prior claim must already be verified and persisted');
    need(before.minerClaim?.claimedTotal === BigInt(previous.settlement.receipt.currentClaimedTotal), 'persistent miner cursor changed between publications');
    need(before.backing.config.totalClaimed === BigInt(previous.settlement.receipt.currentGlobalClaimedTotal), 'global paid counter differs from verified predecessor');
    need(before.claimantAta.balanceBaseUnits === previous.postSnapshot.claimantAta.balanceBaseUnits, 'publication changed player token balance');
  } else need(before.minerClaim === null && before.renownRecord === null && !before.claimantAta.exists, 'first claim must create its own records and ATA');

  const fees: Uint8Array[] = [], rentSpaces: number[] = [], blockhash = new PublicKey(Buffer.alloc(32, Number(sequence) + 70)).toBase58();
  const rentForSpace = (space: number) => space * 10; // Injected rent RPC output, not a game price.
  const quote: MiningClaimQuoteReader = { getGenesisHash: async () => f.identity.genesisHash, getSlot: async () => bankSlot + 2,
    getBlockHeight: async () => bankSlot, getLatestBlockhashAndContext: async () => { observe(bankSlot + 1); return { context: { slot: observedSlot }, value: { blockhash, lastValidBlockHeight: bankSlot + 200 } }; },
    getFeeForMessage: async message => { fees.push(message.serialize()); observe(bankSlot + 2); return { context: { slot: bankSlot + 2 }, value: 5000 }; },
    getMinimumBalanceForRentExemption: async space => { rentSpaces.push(space); return rentForSpace(space); } };
  const service = createMiningClaimPreparer(f.conn.db, { reader, trust, quoteSource: () => quote, now: () => new Date(Number(at) * 1000) });
  return { h, sequence, day, at, bankSlot, rows, reader, trust, before, fees, rentSpaces, rentForSpace, quote, service, reads: () => bankReads };
}
async function execution(f: PublicationFixture, publication: Publication, previous: PriorClaim | null, failedAttemptFirst = false, idempotencyKey: string = randomUUID()): Promise<Execution> {
  const a = await admission(f, publication, previous);
  const { h, sequence, day, at, bankSlot, rows, reader, trust, before, fees, rentSpaces, rentForSpace, quote, service } = a;
  const request = { idempotencyKey }, preparedClaim = await service.prepare(f.wallet, request);
  need(preparedClaim.header.sequence === h.sequence && preparedClaim.header.root === h.root, 'preparation selected another publication');
  need(preparedClaim.transactions.length === 1, 'this two-wallet fixture must have one genuine claim packet');
  need(preparedClaim.needsAta === !before.claimantAta.exists && preparedClaim.needsMinerRecords === (before.minerClaim === null), 'setup flags differ from the actual bank');
  if (previous) need(!preparedClaim.needsAta && !preparedClaim.needsMinerRecords && preparedClaim.rentLamports === '0'
    && preparedClaim.transactions[0]!.kind === 'claim' && rentSpaces.length === 0, 'repeat claim must reuse its ATA and permanent records');
  const message = Message.from(Buffer.from(preparedClaim.transactions[0]!.messageHex, 'hex')), transaction = new VersionedTransaction(message);
  transaction.sign([f.walletSigner]); const wire = transaction.serialize();
  const signed = await acceptMiningClaimSigned(f.conn.db, { wallet: f.wallet, claimId: preparedClaim.claimId, signedTransaction: wire });
  const leaf = decodeMiningAllocationLeaf(Buffer.from(preparedClaim.leafHex, 'hex'));
  const payment = leaf.cumulativeKeep - (before.minerClaim?.claimedTotal ?? 0n);
  need(payment > 0n, 'no fabricated positive claim amount');
  const strings = message.accountKeys.map(key => key.toBase58()), index = (key: string) => { const n = strings.indexOf(key); need(n >= 0, 'missing transaction account'); return n; };
  const claimIndex = message.compiledInstructions.length - 1, claim = message.compiledInstructions[claimIndex]!, account = (i: number) => message.accountKeys[claim.accountKeyIndexes[i]!]!;
  const vault = account(5), ata = account(6), mint = account(7), token = account(8), config = account(1);
  const oldAta = before.claimantAta.balanceBaseUnits ?? 0n, vaultBefore = before.backing.vaultAmount, vaultAfter = vaultBefore - payment;
  need(vaultAfter >= 0n, 'fixture payment exceeds vault');
  const post = await createMiningClaimFixture({ wallet: f.walletSigner.publicKey, day: date(h.day) });
  for (let i = 0; i < rows.length; i++) post.rows[i] = copy(rows[i]!);
  Object.assign(post.backing.model, publication.chain.models[0]); Object.assign(post.root, publication.chain.models[2]); Object.assign(post.epoch, publication.chain.models[1]);
  if (previous) { Object.assign(post.miner, previous.post.miner); Object.assign(post.renown, previous.post.renown); }
  post.miner.claimed_total = leaf.cumulativeKeep; post.miner.last_sequence = sequence; post.miner.last_claim_at = at;
  post.renown.renown_total = leaf.cumulativeRenown; post.renown.days_attested = leaf.cumulativeDays; post.renown.last_sequence = sequence; post.renown.synced_at = at;
  post.backing.model.total_claimed = before.backing.config.totalClaimed + payment; post.root.claims_count = before.root.claimsCount + 1n;
  await post.records(); await post.backing.config(); await post.encodeRoot(); await post.encodeEpoch();
  post.rows[0] = copy(post.backing.rows[0]!);
  // The reusable raw fixture initially creates sequence1; bind its newly encoded
  // root bytes to the actual current publication PDA, never that fixture default.
  post.rows[8] = { ...post.rows[8]!, address: publication.chain.accounts[2]!.address };
  post.rows[9] = { ...post.rows[9]!, address: publication.chain.accounts[1]!.address };
  (post.rows[1]!.data as Buffer).writeBigUInt64LE(vaultAfter, 64);
  const ataData = rows[12] ? Buffer.from(rows[12]!.data) : Buffer.alloc(165);
  mint.toBuffer().copy(ataData); f.walletSigner.publicKey.toBuffer().copy(ataData, 32); ataData.writeBigUInt64LE(oldAta + payment, 64); ataData[108] = 1;
  post.rows[12] = { address: ata, owner: token, executable: false, data: ataData };
  const postSlot = bankSlot + 4; (post.rows[7]!.data as Buffer).writeBigUInt64LE(BigInt(postSlot));

  const balance = (address: PublicKey, owner: string, amount: bigint) => ({ accountIndex: index(address.toBase58()), mint: mint.toBase58(), owner,
    programId: token.toBase58(), uiTokenAmount: { amount: String(amount), decimals: TOKEN.decimals, uiAmount: null, uiAmountString: String(amount) } });
  const exactPlan = buildMiningClaimMessages({ programId: trust.programId, keepMint: trust.keepMint, reserveOwner: trust.reserveOwner }, { wallet: f.walletSigner.publicKey, sequence, day, root: Buffer.from(h.root, 'hex'),
    totalCumulative: BigInt(h.total), leaf, proof: decodeMiningAllocationProof(Buffer.from(preparedClaim.proofHex, 'hex')),
    blockhash: preparedClaim.blockhash, needsAta: preparedClaim.needsAta, needsMinerRecords: preparedClaim.needsMinerRecords });
  const inner: { index: number; instructions: (CompiledInstruction & { stackHeight: number })[] }[] = [];
  const compile = (ix: TransactionInstruction) => ({ programIdIndex: index(ix.programId.toBase58()), accounts: ix.keys.map(k => index(k.pubkey.toBase58())), data: bs58.encode(ix.data), stackHeight: 2 });
  const create = (address: string, space: number, owner: PublicKey) => compile(SystemProgram.createAccount({ fromPubkey: f.walletSigner.publicKey, newAccountPubkey: new PublicKey(address), lamports: rentForSpace(space), space, programId: owner }));
  for (const [i, ix] of message.compiledInstructions.entries()) {
    if (i === claimIndex) {
      const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(payment, 1); data[9] = TOKEN.decimals;
      inner.push({ index: i, instructions: [{ programIdIndex: index(token.toBase58()), accounts: [index(vault.toBase58()), index(mint.toBase58()), index(ata.toBase58()), index(config.toBase58())], data: bs58.encode(data), stackHeight: 2 }] });
    } else if (message.accountKeys[ix.programIdIndex]!.equals(trust.programId)) {
      inner.push({ index: i, instructions: exactPlan.transactions[0]!.expectedNewAccounts.filter(a => a.address !== ata.toBase58()).map(a => create(a.address, a.space, trust.programId)) });
    } else inner.push({ index: i, instructions: [
      { programIdIndex: index(token.toBase58()), accounts: [index(mint.toBase58())], data: bs58.encode(Buffer.of(21, 7, 0)), stackHeight: 2 },
      create(ata.toBase58(), 165, token),
      { programIdIndex: index(token.toBase58()), accounts: [index(ata.toBase58())], data: bs58.encode(Buffer.of(22)), stackHeight: 2 },
      { programIdIndex: index(token.toBase58()), accounts: [index(ata.toBase58()), index(mint.toBase58())], data: bs58.encode(Buffer.concat([Buffer.of(18), f.walletSigner.publicKey.toBuffer()])), stackHeight: 2 }] });
  }
  const preBalances = strings.map(() => 1_000_000), postBalances = [...preBalances];
  preBalances[0] = Number(before.payer.lamports!); postBalances[0] = preBalances[0]! - Number(BigInt(preparedClaim.totalLamports));
  for (const row of exactPlan.transactions[0]!.expectedNewAccounts) { const i = index(row.address); preBalances[i] = 0; postBalances[i] = rentForSpace(row.space); }
  post.rows[13] = { ...post.rows[13]!, lamports: postBalances[0]! };
  const tx: VersionedTransactionResponse = { slot: bankSlot + 3, blockTime: Number(at), version: 'legacy', transaction: { message, signatures: [signed.signature] },
    meta: { err: null, fee: Number(BigInt(preparedClaim.feeLamports)), preBalances, postBalances,
      preTokenBalances: [balance(vault, config.toBase58(), vaultBefore), ...(before.claimantAta.exists ? [balance(ata, f.wallet, oldAta)] : [])],
      postTokenBalances: [balance(vault, config.toBase58(), vaultAfter), balance(ata, f.wallet, oldAta + payment)],
      innerInstructions: inner, logMessages: [], loadedAddresses: { writable: [], readonly: [] } } };
  const receiptReader: MiningClaimReceiptReader = { getGenesisHash: async () => f.identity.genesisHash, getSlot: async () => postSlot,
    getMultipleAccountsInfoAndContext: async () => ({ context: { slot: postSlot }, value: post.rows.map(copy) }),
    getTransaction: async signature => signature === signed.signature ? tx : null };
  const key = { wallet: f.wallet, claimId: preparedClaim.claimId, ordinal: 0 };
  // A distinct canonical quote/wire fails before the successful claim. Its
  // finalized metadata proves fee-only execution and no surviving token change.
  // The same signature is never assigned contradictory terminal outcomes.
  async function captureEarlierFailure() {
    const originalQuote = quote.getLatestBlockhashAndContext;
    quote.getLatestBlockhashAndContext = async () => ({ context: { slot: bankSlot + 2 }, value: {
      blockhash: new PublicKey(Buffer.alloc(32, Number(sequence) + 90)).toBase58(), lastValidBlockHeight: bankSlot + 200 } });
    let failedPreparation;
    try { failedPreparation = await service.prepare(f.wallet, { idempotencyKey: randomUUID() }); }
    finally { quote.getLatestBlockhashAndContext = originalQuote; }
    const failedMessage = Message.from(Buffer.from(failedPreparation.transactions[0]!.messageHex, 'hex'));
    const failedTransaction = new VersionedTransaction(failedMessage); failedTransaction.sign([f.walletSigner]);
    const failedWire = failedTransaction.serialize();
    const failedSigned = await acceptMiningClaimSigned(f.conn.db, { wallet: f.wallet, claimId: failedPreparation.claimId, signedTransaction: failedWire });
    const failedTx: VersionedTransactionResponse = { ...tx, slot: bankSlot + 2,
      transaction: { message: failedMessage, signatures: [failedSigned.signature] }, meta: { ...tx.meta!,
        err: { InstructionError: [claimIndex, { Custom: 6000 }] }, preBalances: [...preBalances],
        postBalances: preBalances.map((value, index) => index === 0 ? value - tx.meta!.fee : value),
        postTokenBalances: structuredClone(tx.meta!.preTokenBalances!) } };
    const failureSlot = bankSlot + 2;
    const failureReader: MiningClaimReceiptReader = { ...reader, getSlot: async () => failureSlot,
      getMultipleAccountsInfoAndContext: async () => {
        const bank = rows.map(copy), data = Buffer.from(bank[7]!.data); data.writeBigUInt64LE(BigInt(failureSlot));
        bank[7] = { ...bank[7]!, data }; bank[13] = { ...bank[13]!, lamports: preBalances[0]! - tx.meta!.fee };
        return { context: { slot: failureSlot }, value: bank };
      }, getTransaction: async signature => signature === failedSigned.signature ? failedTx : null };
    const failedKey = { wallet: f.wallet, claimId: failedPreparation.claimId, ordinal: 0 };
    const failed = await createMiningClaimFailure(f.conn.db, { reader: failureReader, trust })(failedKey);
    return { preparedClaim: failedPreparation, signed: failedSigned, wire: Uint8Array.from(failedWire), tx: failedTx,
      failure: failed, recover: () => getMiningClaimFailure(f.conn.db, failedKey) };
  }
  const earlierFailure = failedAttemptFirst ? await captureEarlierFailure() : null;
  if (earlierFailure) {
    // The already verified failed transaction charged this fee. Carry it into
    // the subsequent success metadata and current payer account, without a top-up.
    const chargedFee = earlierFailure.tx.meta!.fee;
    preBalances[0]! -= chargedFee; postBalances[0]! -= chargedFee;
    rows[13] = { ...rows[13]!, lamports: preBalances[0]! };
    post.rows[13] = { ...post.rows[13]!, lamports: postBalances[0]! };
  }
  const settle = () => createMiningClaimSettlement(f.conn.db, { reader: receiptReader, trust })(key);
  const settlement = await settle();
  const postSnapshot = await createMiningClaimSnapshotReader(receiptReader, trust)({ wallet: f.walletSigner.publicKey, sequence, day });
  const r = settlement.receipt;
  need(r.originalMessageSha256 === signed.messageSha256 && r.signedTransactionSha256 === signed.wireSha256
    && r.signature === signed.signature && r.sequence === h.sequence && r.source.sourceHash === publication.prepared.sourceHash, 'receipt not bound to exact retained claim');
  need(BigInt(r.paidKeepBaseUnits) === payment && postSnapshot.backing.vaultAmount === vaultBefore - payment
    && postSnapshot.claimantAta.balanceBaseUnits === oldAta + payment
    && postSnapshot.backing.config.totalClaimed === before.backing.config.totalClaimed + payment
    && BigInt(r.currentGlobalClaimedTotal) === postSnapshot.backing.config.totalClaimed
    && BigInt(r.currentClaimedTotal) === postSnapshot.minerClaim?.claimedTotal, 'verified receipt and raw post-bank conservation differ');
  need(postSnapshot.backing.reserveAmount === before.backing.reserveAmount && postSnapshot.backing.config.taxHighwater === before.backing.config.taxHighwater
    && postSnapshot.backing.config.taxPaid === before.backing.config.taxPaid, 'player claim charged a second tax or moved reserve');
  return { publication, preparedClaim, request, service, bank: { rows, reader, trust, before, reads: a.reads }, quote: { reader: quote, fees, rentSpaces },
    signed, wire: Uint8Array.from(wire), tx, receiptReader, post, postSnapshot, payment, settlement, settle, earlierFailure,
    recover: () => getMiningClaimSettlement(f.conn.db, key),
    recoverPreparation: () => getMiningClaimPreparation(f.conn.db, { wallet: f.wallet, idempotencyKey: request.idempotencyKey }) };
}

export async function withCumulativeMiningClaimFixture(run: (f: Awaited<ReturnType<typeof extend>>) => Promise<void>) {
  return withCumulativeFreePublicationFixture(async f => run(await extend(f)));
}
type Signed = Awaited<ReturnType<typeof acceptMiningClaimSigned>>;
type Failure = NonNullable<Awaited<ReturnType<typeof getMiningClaimFailure>>>;
interface Execution {
  publication: Publication; preparedClaim: MiningClaimPreparation; request: { idempotencyKey: string };
  service: Admission['service']; bank: ClientAdmission['bank']; quote: ClientAdmission['quote'];
  signed: Signed; wire: Uint8Array; tx: VersionedTransactionResponse; receiptReader: MiningClaimReceiptReader;
  post: ClaimState; postSnapshot: MiningClaimSnapshot; payment: bigint; settlement: MiningClaimSettlement;
  settle(): Promise<MiningClaimSettlement>;
  earlierFailure: { preparedClaim: MiningClaimPreparation; signed: Signed; wire: Uint8Array; tx: VersionedTransactionResponse;
    failure: Failure; recover(): Promise<Failure | null> } | null;
  recover(): Promise<MiningClaimSettlement | null>;
  recoverPreparation(): Promise<MiningClaimPreparation | null>;
}
type Admission = Awaited<ReturnType<typeof admission>>;
type ClientAdmission = {
  publication: Publication; claimantSigner: PublicationFixture['walletSigner']; preparedAt: string;
  bank: { rows: Admission['rows']; reader: Admission['reader']; trust: Admission['trust']; before: Admission['before']; reads: Admission['reads'] };
  quote: { reader: Admission['quote']; fees: Admission['fees']; rentSpaces: Admission['rentSpaces'] };
  service: Admission['service']; completeClientClaim(idempotencyKey: string): Promise<Execution>;
};
type CumulativeClaimFixture = PublicationFixture & {
  firstClaim(options?: { failedAttemptFirst?: boolean }): Promise<Execution>;
  nextClaim(): Promise<Execution>; nextAdmission(): Promise<ClientAdmission>;
};
async function extend(f: PublicationFixture): Promise<CumulativeClaimFixture> {
  let first: Awaited<ReturnType<typeof execution>> | null = null, second: Awaited<ReturnType<typeof execution>> | null = null;
  async function firstClaim(options: { failedAttemptFirst?: boolean } = {}) {
    if (!first) first = await execution(f, await f.first(), null, options.failedAttemptFirst);
    return first;
  }
  let nextPublication: Publication | null = null;
  async function nextAdmission() {
    need(first, 'verify first claim before advancing publication');
    if (nextPublication) return clientAdmission(nextPublication);
    const recovered = await first.recover(); need(recovered && recovered.signature === first.signed.signature, 'immutable prior receipt missing');
    const delta = BigInt(recovered.receipt.currentGlobalClaimedTotal) - first.publication.chain.nextFrontier.totalClaimed;
    need(delta === BigInt(recovered.receipt.paidKeepBaseUnits) && delta === first.payment, 'only the verified payment can advance publication backing');
    const stage = await f.stageDay('2020-01-02', { claimedAdvance: delta });
    need(stage.backing.model.total_claimed === BigInt(recovered.receipt.currentGlobalClaimedTotal)
      && stage.backing.rows[1]!.data.readBigUInt64LE(64) === first.postSnapshot.backing.vaultAmount, 'next funding bank is not the verified claim output');
    nextPublication = await stage.publish();
    return clientAdmission(nextPublication);
  }
  async function clientAdmission(publication: Publication) {
    need(first, 'first claim required');
    const a = await admission(f, publication, first);
    return { publication, claimantSigner: f.walletSigner, preparedAt: new Date(Number(a.at) * 1000).toISOString(),
      bank: { rows: a.rows, reader: a.reader, trust: a.trust, before: a.before, reads: a.reads },
      quote: { reader: a.quote, fees: a.fees, rentSpaces: a.rentSpaces }, service: a.service,
      completeClientClaim: (idempotencyKey: string) => execution(f, publication, first, false, idempotencyKey) };
  }
  async function nextClaim() {
    need(first, 'first claim required');
    if (second) return second;
    const stage = await nextAdmission();
    second = await execution(f, stage.publication, first);
    need(second.payment === BigInt(second.preparedClaim.header.totalCumulative) - BigInt(first.preparedClaim.header.totalCumulative), 'only the active wallet delta should be paid on day two');
    return second;
  }
  return { ...f, firstClaim, nextClaim, nextAdmission };
}
