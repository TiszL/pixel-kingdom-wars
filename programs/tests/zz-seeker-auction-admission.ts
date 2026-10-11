/** Runs AFTER shardkeep-economy.ts on the same disposable local validator.
 * Real native Ed25519 instructions and confirmed failed transactions, no Clock
 * patch or account injection. Funded bid/settlement lifecycle is a separate gate.
 */
import * as anchor from '@coral-xyz/anchor';
import { BN, Program } from '@coral-xyz/anchor';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccount,
  createMint, getAccount, getAssociatedTokenAddressSync, mintTo } from '@solana/spl-token';
import { Ed25519Program, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { randomBytes } from 'node:crypto';
import { expect } from 'chai';
import { PHASE_E_SEEKER_AUCTION } from '../../packages/shared/src/constants';
import { encodeSeekerActionPermit, hashOpenSeekerAuctionPayload, hashSeekerAuctionTerms,
  hashSettleSeekerAuctionPayload, seekerAuthorityPda, seekerAuctionConfigPda,
  seekerAuctionPda, seekerRegistryPda, seekerTermPda, seekerPermitReceiptPda,
  type SeekerAuctionTerms } from '../../packages/chain/src/seekerAuctionProtocol';
import { ShardkeepEconomy } from '../target/types/shardkeep_economy';
import { SeekerCpiProbe } from '../target/types/seeker_cpi_probe';

const num = (value: BN) => BigInt(value.toString());
const bn = (value: bigint) => new BN(value.toString());
const DONATION = 7n; // Deliberately not an admitted bid.

describe('Seeker auction native permit admission and atomic rollback', () => {
  const environment = anchor.AnchorProvider.env();
  // Anchor defaults to processed. Setup writes must reach the same confirmed
  // bank used by rollback snapshots, or a prior pause/rotation looks like a write
  // made by the rejected transaction.
  const provider = new anchor.AnchorProvider(new anchor.web3.Connection(environment.connection.rpcEndpoint, 'confirmed'),
    environment.wallet, { ...environment.opts, commitment: 'confirmed', preflightCommitment: 'confirmed' });
  if (!['127.0.0.1', 'localhost'].includes(new URL(provider.connection.rpcEndpoint).hostname)) {
    throw new Error('Seeker admission tests require a disposable loopback validator');
  }
  anchor.setProvider(provider);
  const program = anchor.workspace.shardkeepEconomy as Program<ShardkeepEconomy>;
  const probe = anchor.workspace.seekerCpiProbe as Program<SeekerCpiProbe>;
  const connection = provider.connection, admin = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const wallet = Keypair.generate(), other = Keypair.generate();
  const firstPolicy = Keypair.generate(), secondPolicy = Keypair.generate(), thirdPolicy = Keypair.generate();
  const authority = seekerAuthorityPda(program.programId), config = seekerAuctionConfigPda(program.programId);
  const registry = seekerRegistryPda(program.programId), term = seekerTermPda(program.programId, config, 0n);
  let cfg: Awaited<ReturnType<typeof program.account.auctionConfig.fetch>>;
  let registryRow: Awaited<ReturnType<typeof program.account.seekerRegistry.fetch>>;
  let termRow: Awaited<ReturnType<typeof program.account.seekerTerm.fetch>>;
  let genesis: PublicKey, wrongMint: PublicKey, unrelatedAta: PublicKey;
  let currentPolicy = firstPolicy;
  let accepted: Awaited<ReturnType<typeof opening>>;
  const auction = (spot: number) => seekerAuctionPda(program.programId, config, spot, 0n);
  const vault = (spot: number) => getAssociatedTokenAddressSync(cfg.mint, auction(spot), true);
  const clock = async () => {
    const value = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
    if (!value || value.data.length !== 40) throw new Error('Invalid actual Clock sysvar');
    return value.data.readBigInt64LE(32);
  };
  function terms(spot: number): SeekerAuctionTerms {
    const entry = registryRow.entries[spot];
    if (!entry || (entry.class !== 0 && entry.class !== 1)) throw new Error('Unknown registry entry');
    return { config, term, auction: auction(spot), registry, registryHash: Uint8Array.from(cfg.registryHash),
      spotId: entry.id, class: entry.class, realmMask: entry.realmMask, round: num(termRow.round),
      auctionStart: num(termRow.auctionStart), auctionEnd: num(termRow.auctionEnd),
      operatingStart: num(termRow.operatingStart), operatingEnd: num(termRow.operatingEnd),
      mint: cfg.mint, tokenProgram: cfg.tokenProgram, vault: vault(spot), prizeOwner: cfg.prizeOwner,
      prizeAta: cfg.prizeAta, prizeBps: cfg.prizeBps, grace: num(cfg.graceSec), openingBid: num(cfg.openingBid),
      registryVersion: cfg.registryVersion, auctionFormat: cfg.auctionFormat, termsFormat: cfg.termsFormat };
  }
  function accounts(spot: number, id: Buffer) {
    return { wallet: wallet.publicKey, authority, config, registry, term, auction: auction(spot), vault: vault(spot),
      mint: cfg.mint, receipt: seekerPermitReceiptPda(program.programId, id), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId };
  }
  type OpenOptions = {
    id?: Buffer; expiry?: bigint; signer?: Keypair; signedWallet?: PublicKey; signedGenesis?: PublicKey;
    signedProgram?: PublicKey; kind?: 7 | 8; payload?: Buffer; index?: number;
    accounts?: Partial<ReturnType<typeof accounts>>;
    native?: (instruction: TransactionInstruction) => TransactionInstruction;
    sequence?: (native: TransactionInstruction, open: TransactionInstruction) => TransactionInstruction[];
  };
  async function opening(spot = 10, options: OpenOptions = {}) {
    const id = options.id ?? randomBytes(16);
    const expiry = options.expiry ?? await clock() + BigInt(PHASE_E_SEEKER_AUCTION.issuedPolicyPermitTtlSec);
    const payload = options.payload ?? hashOpenSeekerAuctionPayload(terms(spot));
    const message = encodeSeekerActionPermit({ genesisHash: options.signedGenesis ?? genesis,
      programId: options.signedProgram ?? program.programId, kind: options.kind ?? 7, permitId: id,
      wallet: options.signedWallet ?? wallet.publicKey, expiry, payloadHash: payload });
    const originalNative = Ed25519Program.createInstructionWithPrivateKey({ privateKey: (options.signer ?? currentPolicy).secretKey, message });
    const native = options.native ? options.native(originalNative) : originalNative;
    const originalAccounts = accounts(spot, id);
    const instruction = await program.methods.openAuction(spot, { permitId: Array.from(id), expiry: bn(expiry),
      ed25519Instruction: options.index ?? 0 }).accountsPartial({ ...originalAccounts, ...options.accounts }).instruction();
    return { id, expiry, payload, originalAccounts, tx: new Transaction().add(...(options.sequence?.(native, instruction) ?? [native, instruction])) };
  }
  async function execute(tx: Transaction, shouldFail: boolean): Promise<string> {
    const latest = await connection.getLatestBlockhash('confirmed');
    tx.feePayer = admin; tx.recentBlockhash = latest.blockhash;
    tx.partialSign(wallet); const signed = await provider.wallet.signTransaction(tx);
    const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 0 });
    const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
    if (shouldFail) expect(result.value.err, `expected actual failed transaction ${signature}`).not.to.equal(null);
    else expect(result.value.err, `expected successful transaction ${signature}`).to.equal(null);
    return signature;
  }
  async function snapshots(addresses: PublicKey[]) {
    return (await connection.getMultipleAccountsInfo(addresses, 'confirmed')).map(row => row === null ? null : ({
      owner: row.owner.toBase58(), executable: row.executable, lamports: row.lamports, data: row.data.toString('hex'),
    }));
  }
  async function exactSettlementError(signature: string, code: 'Time' | 'TopLevelOnly') {
    const confirmed = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    expect(confirmed, 'require a genuine confirmed transaction, not preflight-only failure').not.to.equal(null);
    const meta = confirmed!.meta;
    expect(meta).not.to.equal(null);
    expect(meta!.err, 'Agave 2.3.13 callee failure must abort the outer transaction, including attempted catch').not.to.equal(null);
    const logs = meta!.logMessages ?? [];
    const parsed = anchor.AnchorError.parse(logs);
    expect(parsed, `expected exact Anchor ${code} error in actual transaction logs`).not.to.equal(null);
    expect(parsed!.error.errorCode.code).to.equal(code);
    // Program.idl camel-cases names; rawIdl retains the actual Rust error ABI.
    const expected = program.rawIdl.errors?.find(error => error.name === code);
    expect(expected, 'the error must exist in the actual generated economy IDL').not.to.equal(undefined);
    expect(parsed!.error.errorCode.number).to.equal(expected!.code);
    if (code === 'TopLevelOnly') expect(logs.join('\n')).not.to.include('Error Code: Time.');
    expect(logs.join('\n'), 'the pinned runtime must not return a callee error to the probe catch branch').not.to.include('Probe caught CPI failure:');
  }
  async function throughProbe(original: TransactionInstruction, catchFailure: boolean) {
    return probe.methods.forward(original.data, catchFailure).accountsPartial({ targetProgram: program.programId })
      .remainingAccounts(original.keys).instruction();
  }
  async function rejected(attempt: Awaited<ReturnType<typeof opening>>) {
    const a = attempt.originalAccounts;
    const tracked = [authority, config, registry, term, a.auction, a.receipt, a.vault, cfg.prizeAta];
    const before = await snapshots(tracked);
    await execute(attempt.tx, true);
    expect(await snapshots(tracked), 'failed native/program/CPI admission must leave all original evidence and balances unchanged').to.deep.equal(before);
  }
  const pause = async (value: boolean) => program.methods.setAdmissionPaused(value).accountsPartial({ signer: admin, authority }).rpc();
  before(async () => {
    cfg = await program.account.auctionConfig.fetch(config);
    registryRow = await program.account.seekerRegistry.fetch(registry);
    termRow = await program.account.seekerTerm.fetch(term);
    genesis = new PublicKey(await connection.getGenesisHash());
    const auth = await program.account.seekerAuthority.fetch(authority);
    expect(auth.admin.equals(admin)).to.equal(true);
    expect(auth.clusterGenesis).to.deep.equal(Array.from(genesis.toBytes()));
    expect(termRow.opened.every(x => x === 0)).to.equal(true);
    expect(await clock() < num(termRow.auctionStart)).to.equal(true);
    await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: admin,
      toPubkey: wallet.publicKey, lamports: 200_000_000 })));
    wrongMint = await createMint(connection, payer, admin, null, cfg.decimals);
    unrelatedAta = await createAssociatedTokenAccount(connection, payer, cfg.mint, other.publicKey);
    await program.methods.rotatePolicy(firstPolicy.publicKey).accountsPartial({ admin, authority }).rpc();
    await pause(false);
  });
  after(async () => { await pause(true); });

  it('publishes every existing runtime error with its original numeric ABI in the generated IDL', () => {
    // Multiple #[error_code] enums or a custom offset silently corrupt this
    // generated section under Anchor0.32.1. Mining extends the ABI in its own
    // range; historic ranges must remain byte-for-byte compatible when Charter
    // adds its distinct range. Pin the complete list so missing errors also fail.
    const foundation = ['Unauthorized', 'InvalidAuthority', 'InvalidVersion', 'InvalidPolicy', 'Arithmetic',
      'InvalidSpot', 'AlreadyRecorded', 'InvalidPermit', 'PermitExpired', 'InvalidCalendar',
      'InvalidTokenAccount', 'InvalidPredecessor', 'InvalidRegistry'];
    const escrow = ['Paused', 'Identity', 'Configuration', 'Time', 'Incomplete', 'Settled', 'BidTooLow',
      'NotRefundable', 'Backing', 'Token', 'EscrowArithmetic', 'Winner', 'TopLevelOnly'];
    const mining = ['InvalidMiningProof', 'InvalidMiningClaim', 'InvalidMiningRenown',
      'InvalidMiningTaxTerm', 'InvalidMiningTaxEpoch', 'InvalidMiningTaxClaim'];
    const sale = ['InvalidRealmSaleTerms', 'RealmSaleQuotaExhausted', 'RealmAccessChanged', 'InvalidRealmSeller', 'RealmSaleBalance'];
    const charter = ['CharterTopLevelOnly', 'CharterIdentity', 'CharterCore', 'CharterNotImplemented'];
    expect(program.rawIdl.errors?.map(({ name, code }) => ({ name, code }))).to.deep.equal([
      ...foundation.map((name, index) => ({ name, code: 6000 + index })),
      ...escrow.map((name, index) => ({ name, code: 7000 + index })),
      ...mining.map((name, index) => ({ name, code: 8000 + index })),
      ...sale.map((name, index) => ({ name, code: 9000 + index })),
      ...charter.map((name, index) => ({ name, code: 10000 + index })),
    ]);
  });

  it('rejects a genuine native signature by an unauthorized policy key without reserving any identities', async () => {
    await rejected(await opening(10, { signer: Keypair.generate() }));
  });
  for (const [label, options] of [
    ['wallet', () => ({ signedWallet: other.publicKey })],
    ['genesis', () => ({ signedGenesis: Keypair.generate().publicKey })],
    ['program', () => ({ signedProgram: SystemProgram.programId })],
    ['action kind', () => ({ kind: 8 as const })],
    ['immutable payload', () => ({ payload: randomBytes(32) })],
  ] as const) {
    it(`rejects a correctly signed but wrong ${label} domain with atomic receipt/auction/bitmap rollback`, async () => {
      await rejected(await opening(10, options()));
    });
  }
  it('rejects an already expired permit even when its native signature is valid', async () => {
    await rejected(await opening(10, { expiry: await clock() - 1n }));
  });
  it('rejects a permit beyond the on-chain maximum TTL', async () => {
    await rejected(await opening(10, { expiry: await clock() + BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec) * 2n }));
  });
  it('requires native verification before the consuming instruction, never a later signature', async () => {
    await rejected(await opening(10, { index: 1, sequence: (native, open) => [open, native] }));
  });
  it('refuses a missing native verifier at the explicit evidence index', async () => {
    await rejected(await opening(10, { sequence: (_native, open) => [open] }));
  });
  it('refuses another successful native program as policy evidence', async () => {
    await rejected(await opening(10, { sequence: (_native, open) => [SystemProgram.transfer({ fromPubkey: admin,
      toPubkey: wallet.publicKey, lamports: 0 }), open] }));
  });
  it('refuses native-valid explicit cross-instruction offsets instead of the required self-contained sentinel', async () => {
    await rejected(await opening(10, { native: ix => {
      // Ed25519 permits explicit references to instruction0 (itself); our contract
      // deliberately requires all three u16::MAX sentinels and refuses this form.
      for (const at of [4, 8, 14]) ix.data.writeUInt16LE(0, at);
      return ix;
    } }));
  });
  it('refuses malformed native offsets before any auction or receipt can persist', async () => {
    await rejected(await opening(10, { native: ix => { ix.data.writeUInt16LE(65_534, 10); return ix; } }));
  });
  it('refuses native evidence carrying account metas even when its key/message are valid', async () => {
    await rejected(await opening(10, { native: ix => {
      ix.keys.push({ pubkey: wallet.publicKey, isSigner: false, isWritable: false }); return ix;
    } }));
  });
  it('rejects another valid classic ATA as the canonical vault without changing its balance', async () => {
    const before = await snapshots([unrelatedAta]);
    await rejected(await opening(10, { accounts: { vault: unrelatedAta } }));
    expect(await snapshots([unrelatedAta])).to.deep.equal(before);
  });
  it('rejects a different classic mint without accepting the otherwise valid permit', async () => {
    await rejected(await opening(10, { accounts: { mint: wrongMint } }));
  });
  it('rejects token-program substitution before any account creation persists', async () => {
    await rejected(await opening(10, { accounts: { tokenProgram: SystemProgram.programId } }));
  });
  it('rejects a different genuine term PDA for this auction even when both terms belong to the config', async () => {
    await rejected(await opening(10, { accounts: { term: seekerTermPda(program.programId, config, 1n) } }));
  });
  it('pauses new auction preparation and does not consume its valid permit', async () => {
    await pause(true);
    try { await rejected(await opening()); } finally { await pause(false); }
  });
  it('accepts a precreated donated vault with genuine native verification but records zero bid liability', async () => {
    await createAssociatedTokenAccount(connection, payer, cfg.mint, auction(0), {}, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, true);
    await mintTo(connection, payer, cfg.mint, vault(0), payer, DONATION);
    accepted = await opening(0);
    await execute(accepted.tx, false);
    const row = await program.account.auction.fetch(auction(0));
    const receipt = await program.account.permitReceipt.fetch(accepted.originalAccounts.receipt);
    const manifest = await program.account.seekerTerm.fetch(term);
    expect(row.termsHash).to.deep.equal(Array.from(hashSeekerAuctionTerms(terms(0))));
    expect(row.highBid.toString()).to.equal('0'); expect(row.highBidder).to.equal(null);
    expect(row.outstandingEscrow.toString()).to.equal('0'); expect(row.settled).to.equal(false);
    expect((await getAccount(connection, vault(0))).amount).to.equal(DONATION);
    expect(receipt.kind).to.equal(7); expect(receipt.wallet.equals(wallet.publicKey)).to.equal(true);
    expect(receipt.permitId).to.deep.equal(Array.from(accepted.id)); expect(receipt.payloadHash).to.deep.equal(Array.from(accepted.payload));
    expect(receipt.expiry.toString()).to.equal(accepted.expiry.toString());
    expect(manifest.opened[0]).to.equal(1); expect(manifest.opened.slice(1).every(x => x === 0)).to.equal(true);
    expect(manifest.completedCount).to.equal(0); expect(manifest.completedAt).to.equal(null);
  });
  it('does not reopen an existing auction or consume a fresh permit on duplicate initialization', async () => {
    await rejected(await opening(0));
  });
  it('keeps a permit ID globally consumed even with a newly signed different auction target', async () => {
    await rejected(await opening(10, { id: accepted.id }));
  });
  it('retains valid previous-key authority only through the currently stored rotation grace', async () => {
    await program.methods.rotatePolicy(secondPolicy.publicKey).accountsPartial({ admin, authority }).rpc();
    currentPolicy = secondPolicy;
    const auth = await program.account.seekerAuthority.fetch(authority);
    expect(auth.previousPolicyKey?.equals(firstPolicy.publicKey)).to.equal(true);
    expect(await clock() < num(auth.previousValidUntil)).to.equal(true);
    const attempt = await opening(1, { signer: firstPolicy }); await execute(attempt.tx, false);
    expect((await program.account.permitReceipt.fetch(attempt.originalAccounts.receipt)).wallet.equals(wallet.publicKey)).to.equal(true);
  });
  it('a second rotation revokes the older previous key without consuming its attempt', async () => {
    await program.methods.rotatePolicy(thirdPolicy.publicKey).accountsPartial({ admin, authority }).rpc(); currentPolicy = thirdPolicy;
    expect((await program.account.seekerAuthority.fetch(authority)).previousPolicyKey?.equals(secondPolicy.publicKey)).to.equal(true);
    await rejected(await opening(10, { signer: firstPolicy }));
    const attempt = await opening(2, { signer: secondPolicy }); await execute(attempt.tx, false);
    expect((await program.account.auction.fetch(auction(2))).settled).to.equal(false);
  });
  function settlementAccounts(id?: Buffer) {
    return { wallet: wallet.publicKey, config, term, auction: auction(0), mint: cfg.mint, vault: vault(0),
      prizeAta: cfg.prizeAta, winnerBid: null, tokenProgram: TOKEN_PROGRAM_ID,
      ...(id ? { authority, receipt: seekerPermitReceiptPda(program.programId, id), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId } : {}) };
  }
  it('permissionless settlement cannot consume donations or publish unsold before the real clock allows it', async () => {
    const tracked = [term, auction(0), vault(0), cfg.prizeAta]; const before = await snapshots(tracked);
    const ix = await program.methods.settleAuction().accountsPartial(settlementAccounts()).instruction();
    const signature = await execute(new Transaction().add(ix), true);
    await exactSettlementError(signature, 'Time');
    expect(await snapshots(tracked)).to.deep.equal(before);
  });
  async function earlySettlement(id: Buffer) {
    const row = await program.account.auction.fetch(auction(0));
    const expiry = await clock() + BigInt(PHASE_E_SEEKER_AUCTION.issuedPolicyPermitTtlSec);
    const payloadHash = hashSettleSeekerAuctionPayload({ auction: auction(0), config, term,
      termsHash: Uint8Array.from(row.termsHash), highBid: num(row.highBid), highBidder: row.highBidder });
    const message = encodeSeekerActionPermit({ genesisHash: genesis, programId: program.programId, kind: 8,
      permitId: id, wallet: wallet.publicKey, expiry, payloadHash });
    const native = Ed25519Program.createInstructionWithPrivateKey({ privateKey: currentPolicy.secretKey, message });
    const ix = await program.methods.settleAuctionWithPermit({ permitId: Array.from(id), expiry: bn(expiry), ed25519Instruction: 0 })
      .accountsPartial(settlementAccounts(id)).instruction();
    return new Transaction().add(native, ix);
  }
  it('a valid kind8 permit cannot settle before close and its failed receipt creation rolls back', async () => {
    const id = randomBytes(16); const receipt = seekerPermitReceiptPda(program.programId, id);
    const tracked = [term, auction(0), vault(0), cfg.prizeAta, receipt]; const before = await snapshots(tracked);
    const signature = await execute(await earlySettlement(id), true);
    await exactSettlementError(signature, 'Time');
    expect(await snapshots(tracked)).to.deep.equal(before);
    // Proof of rollback: the failed kind8 ID was not consumed and can authorize
    // a newly signed kind7 operation; no locally fabricated receipt is inserted.
    const next = await opening(3, { id }); await execute(next.tx, false);
    expect((await program.account.permitReceipt.fetch(receipt)).kind).to.equal(7);
  });
  for (const catchFailure of [false, true]) {
    it(`rejects permissionless CPI settlement before the time gate with unchanged evidence (${catchFailure ? 'attempted catch' : 'propagated'})`, async () => {
      const tracked = [authority, config, registry, term, auction(0), vault(0), cfg.prizeAta, wallet.publicKey];
      const before = await snapshots(tracked);
      const original = await program.methods.settleAuction().accountsPartial(settlementAccounts()).instruction();
      const signature = await execute(new Transaction().add(await throughProbe(original, catchFailure)), true);
      await exactSettlementError(signature, 'TopLevelOnly');
      expect(await snapshots(tracked), 'CPI must never create a result unreadable by the top-level evidence verifier').to.deep.equal(before);
    });
    it(`rejects valid native kind8 followed by CPI before time/receipt consumption (${catchFailure ? 'attempted catch' : 'propagated'})`, async () => {
      const id = randomBytes(16), receipt = seekerPermitReceiptPda(program.programId, id);
      const tracked = [authority, config, registry, term, auction(0), vault(0), cfg.prizeAta, wallet.publicKey, receipt];
      const before = await snapshots(tracked);
      const original = await earlySettlement(id);
      // Native verification remains outer instruction0, precisely the signed
      // permit's index. Only the actual economy instruction is wrapped in CPI.
      const signature = await execute(new Transaction().add(original.instructions[0],
        await throughProbe(original.instructions[1], catchFailure)), true);
      await exactSettlementError(signature, 'TopLevelOnly');
      expect(await snapshots(tracked), 'even attempted catch must roll back init rent, receipt, counters, tokens and settlement').to.deep.equal(before);
      expect(await connection.getAccountInfo(receipt, 'confirmed')).to.equal(null);
    });
  }
  it('an accepted kind7 ID cannot be reused by a newly signed kind8 instruction', async () => {
    const tracked = [term, auction(0), vault(0), cfg.prizeAta, accepted.originalAccounts.receipt];
    const before = await snapshots(tracked);
    const signature = await execute(await earlySettlement(accepted.id), true);
    expect(await snapshots(tracked)).to.deep.equal(before);
    const confirmed = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    expect(confirmed, 'the replay must have an actual failed transaction receipt').not.to.equal(null);
    // Time would also reject this early attempt. Require the earlier init-once
    // failure so this case proves cross-kind identity, not merely the clock gate.
    expect(confirmed!.meta!.logMessages!.join('\n')).to.match(/already in use|already initialized/i);
    expect((await program.account.permitReceipt.fetch(accepted.originalAccounts.receipt)).kind).to.equal(7);
  });
});
