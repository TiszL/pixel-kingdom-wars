import * as anchor from '@coral-xyz/anchor';
import { BN, Program } from '@coral-xyz/anchor';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccount, createMint,
  getAccount, getAssociatedTokenAddressSync, mintTo } from '@solana/spl-token';
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram, Transaction } from '@solana/web3.js';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { ShardkeepEconomy } from '../target/types/shardkeep_economy';

// Read the generated policy used by Rust; the separate generator drift gate binds
// it to shared/constants.ts. Test funding/headroom below are fixtures, not tuning.
const policySource = readFileSync('shardkeep-economy/src/constants.rs', 'utf8');
function policy(name: string): number {
  const match = policySource.match(new RegExp(`pub const ${name}: \\w+ = (\\d+);`));
  if (!match) throw new Error(`missing generated policy ${name}`);
  return Number(match[1]);
}
async function fail(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error('transaction unexpectedly succeeded');
}
function code(error: unknown): string | undefined {
  return (error as { error?: { errorCode?: { code?: string } } })?.error?.errorCode?.code;
}

describe('shardkeep-economy genuine authority and immutable manifests', () => {
  const environment = anchor.AnchorProvider.env();
  // Anchor defaults to processed. Setup writes must reach the same confirmed
  // bank used by rollback snapshots, or a prior pause/rotation looks like a write
  // made by the rejected transaction.
  const provider = new anchor.AnchorProvider(new anchor.web3.Connection(environment.connection.rpcEndpoint, 'confirmed'),
    environment.wallet, { ...environment.opts, commitment: 'confirmed', preflightCommitment: 'confirmed' });
  if (!['127.0.0.1', 'localhost'].includes(new URL(provider.connection.rpcEndpoint).hostname)) {
    throw new Error('Seeker tests require a disposable loopback validator');
  }
  anchor.setProvider(provider);
  const program = anchor.workspace.shardkeepEconomy as Program<ShardkeepEconomy>;
  const connection = provider.connection, admin = provider.wallet.publicKey;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const guardian = Keypair.generate(), attacker = Keypair.generate(), successor = Keypair.generate();
  const firstPolicy = Keypair.generate(), secondPolicy = Keypair.generate(), thirdPolicy = Keypair.generate();
  const prizeOwner = Keypair.generate();
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const authority = pda(Buffer.from('seeker_authority'));
  const config = pda(Buffer.from('auction_config'));
  const registry = pda(Buffer.from('seeker_registry'));
  const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()],
    new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'));
  const term = (round: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(round);
    return pda(Buffer.from('seeker_term'), config.toBuffer(), bytes); };
  let mint: PublicKey, prizeAta: PublicKey, genesis: number[], firstStart: number;
  const clock = async () => {
    const account = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
    if (!account || account.data.length !== 40) throw new Error('invalid Clock sysvar');
    return Number(account.data.readBigInt64LE(32));
  };
  const initAccounts = (signer = admin) => ({ admin: signer, program: program.programId, programData,
    authority, systemProgram: SystemProgram.programId });
  const configAccounts = (signer = admin) => ({ admin: signer, authority, config, registry, mint,
    prizeOwner: prizeOwner.publicKey, prizeAta, tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId });
  const open = (round: bigint, previous: PublicKey | null, signer = attacker) => program.methods
    .openTerm(new BN(round.toString())).accountsPartial({ payer: signer.publicKey, config, registry,
      term: term(round), previousTerm: previous, systemProgram: SystemProgram.programId }).signers([signer]).rpc();

  before(async () => {
    genesis = Array.from(new PublicKey(await connection.getGenesisHash()).toBytes());
    const tx = new Transaction();
    for (const wallet of [guardian, attacker, successor, prizeOwner]) tx.add(SystemProgram.transfer({
      fromPubkey: admin, toPubkey: wallet.publicKey, lamports: 100_000_000,
    }));
    await provider.sendAndConfirm(tx);
    mint = await createMint(connection, payer, admin, null, 6);
    prizeAta = getAssociatedTokenAddressSync(mint, prizeOwner.publicKey);
    // A third party can precreate/fund a canonical ATA. This must neither brick
    // configuration nor create an auction bid or alter the prize policy.
    await createAssociatedTokenAccount(connection, payer, mint, prizeOwner.publicKey);
    await mintTo(connection, payer, mint, prizeAta, payer, 123n);
    firstStart = await clock() + policy('OVERLAPPING_AUCTION_SEC') + 3_600;
  });

  it('rejects an initializer who is not the actual upgrade authority without reserving its PDA', async () => {
    const error = await fail(program.methods.initializeSeekerAuthority(guardian.publicKey, firstPolicy.publicKey, genesis)
      .accountsPartial(initAccounts(attacker.publicKey)).signers([attacker]).rpc());
    expect(code(error)).to.equal('Unauthorized');
    expect(await connection.getAccountInfo(authority)).to.equal(null);
  });
  it('rejects another program ProgramData even when its upgrade authority is the same wallet', async () => {
    const [otherData] = PublicKey.findProgramAddressSync([anchor.workspace.shardkeepCore.programId.toBuffer()],
      new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'));
    expect(code(await fail(program.methods.initializeSeekerAuthority(guardian.publicKey, firstPolicy.publicKey, genesis)
      .accountsPartial({ ...initAccounts(), programData: otherData }).rpc()))).to.equal('Unauthorized');
    expect(await connection.getAccountInfo(authority)).to.equal(null);
  });
  it('refuses an empty genesis domain and rolls back initialization', async () => {
    expect(code(await fail(program.methods.initializeSeekerAuthority(guardian.publicKey, firstPolicy.publicKey, Array(32).fill(0))
      .accountsPartial(initAccounts()).rpc()))).to.equal('InvalidAuthority');
    expect(await connection.getAccountInfo(authority)).to.equal(null);
  });
  it('initializes paused with the genuine local domain and no previous policy key', async () => {
    await program.methods.initializeSeekerAuthority(guardian.publicKey, firstPolicy.publicKey, genesis)
      .accountsPartial(initAccounts()).rpc();
    const row = await program.account.seekerAuthority.fetch(authority);
    expect(row.admin.equals(admin)).to.equal(true); expect(row.guardian.equals(guardian.publicKey)).to.equal(true);
    expect(row.admissionPaused).to.equal(true); expect(row.clusterGenesis).to.deep.equal(genesis);
    expect(row.previousPolicyKey).to.equal(null); expect(row.pendingAdmin).to.equal(null);
  });
  it('cannot replace a saved authority by initializing again', async () => {
    await fail(program.methods.initializeSeekerAuthority(attacker.publicKey, attacker.publicKey, genesis)
      .accountsPartial(initAccounts()).rpc());
    expect((await program.account.seekerAuthority.fetch(authority)).guardian.equals(guardian.publicKey)).to.equal(true);
  });
  it('permits only admin resume and guardian pause, never arbitrary callers', async () => {
    expect(code(await fail(program.methods.setAdmissionPaused(false).accountsPartial({ signer: guardian.publicKey, authority })
      .signers([guardian]).rpc()))).to.equal('Unauthorized');
    await program.methods.setAdmissionPaused(false).accountsPartial({ signer: admin, authority }).rpc();
    expect(code(await fail(program.methods.setAdmissionPaused(true).accountsPartial({ signer: attacker.publicKey, authority })
      .signers([attacker]).rpc()))).to.equal('Unauthorized');
    expect((await program.account.seekerAuthority.fetch(authority)).admissionPaused).to.equal(false);
    await program.methods.setAdmissionPaused(true).accountsPartial({ signer: guardian.publicKey, authority }).signers([guardian]).rpc();
    expect((await program.account.seekerAuthority.fetch(authority)).admissionPaused).to.equal(true);
  });
  it('requires nomination and acceptance by the new admin before revoking the old one', async () => {
    await fail(program.methods.proposeAdmin(attacker.publicKey).accountsPartial({ admin: attacker.publicKey, authority }).signers([attacker]).rpc());
    await program.methods.proposeAdmin(successor.publicKey).accountsPartial({ admin, authority }).rpc();
    expect((await program.account.seekerAuthority.fetch(authority)).admin.equals(admin)).to.equal(true);
    expect(code(await fail(program.methods.acceptAdmin().accountsPartial({ newAdmin: attacker.publicKey, authority }).signers([attacker]).rpc()))).to.equal('Unauthorized');
    await program.methods.acceptAdmin().accountsPartial({ newAdmin: successor.publicKey, authority }).signers([successor]).rpc();
    await fail(program.methods.rotatePolicy(attacker.publicKey).accountsPartial({ admin, authority }).rpc());
    expect((await program.account.seekerAuthority.fetch(authority)).currentPolicyKey.equals(firstPolicy.publicKey)).to.equal(true);
    // Restore via the same two-step contract, not a test-only account rewrite.
    await program.methods.proposeAdmin(admin).accountsPartial({ admin: successor.publicKey, authority }).signers([successor]).rpc();
    await program.methods.acceptAdmin().accountsPartial({ newAdmin: admin, authority }).rpc();
  });
  it('bounds previous-key grace by chain time and replaces it on the next rotation', async () => {
    const before = await clock();
    await program.methods.rotatePolicy(secondPolicy.publicKey).accountsPartial({ admin, authority }).rpc();
    const row = await program.account.seekerAuthority.fetch(authority), after = await clock();
    expect(row.previousPolicyKey?.equals(firstPolicy.publicKey)).to.equal(true);
    expect(row.previousValidUntil.toNumber()).to.be.within(before + policy('MAX_POLICY_PERMIT_TTL_SEC'), after + policy('MAX_POLICY_PERMIT_TTL_SEC'));
    await program.methods.rotatePolicy(thirdPolicy.publicKey).accountsPartial({ admin, authority }).rpc();
    expect((await program.account.seekerAuthority.fetch(authority)).previousPolicyKey?.equals(secondPolicy.publicKey)).to.equal(true);
    await fail(program.methods.rotatePolicy(PublicKey.default).accountsPartial({ admin, authority }).rpc());
    expect((await program.account.seekerAuthority.fetch(authority)).currentPolicyKey.equals(thirdPolicy.publicKey)).to.equal(true);
  });
  it('refuses unauthorized economics and a truncated first auction window without leaving config', async () => {
    await fail(program.methods.initializeAuctionConfig(new BN(firstStart)).accountsPartial(configAccounts(attacker.publicKey)).signers([attacker]).rpc());
    expect(code(await fail(program.methods.initializeAuctionConfig(new BN(await clock())).accountsPartial(configAccounts()).rpc()))).to.equal('InvalidCalendar');
    expect(await connection.getAccountInfo(config)).to.equal(null); expect(await connection.getAccountInfo(registry)).to.equal(null);
    expect((await getAccount(connection, prizeAta)).amount).to.equal(123n);
  });
  it('rejects recipient substitution atomically before initializing the immutable registry', async () => {
    const badAta = getAssociatedTokenAddressSync(mint, attacker.publicKey);
    expect(code(await fail(program.methods.initializeAuctionConfig(new BN(firstStart)).accountsPartial({ ...configAccounts(), prizeAta: badAta }).rpc()))).to.equal('InvalidTokenAccount');
    expect(await connection.getAccountInfo(config)).to.equal(null); expect(await connection.getAccountInfo(registry)).to.equal(null);
  });
  it('accepts a precreated funded canonical prize ATA and freezes the exact complete registry', async () => {
    await program.methods.initializeAuctionConfig(new BN(firstStart)).accountsPartial(configAccounts()).rpc();
    const row = await program.account.auctionConfig.fetch(config), spots = await program.account.seekerRegistry.fetch(registry);
    expect(row.prizeAta.equals(prizeAta)).to.equal(true); expect(row.mint.equals(mint)).to.equal(true);
    expect(row.openingBid.toString()).to.equal((BigInt(policy('OPENING_BID_SKR')) * 10n ** 6n).toString());
    expect(row.prizeBps).to.equal(policy('PRIZE_BPS')); expect(row.firstOperatingStart.toNumber()).to.equal(firstStart);
    expect((await getAccount(connection, prizeAta)).amount).to.equal(123n);
    expect(spots.entries).to.have.length(policy('TOTAL_SPOTS'));
    spots.entries.forEach((spot, index) => {
      expect(spot.id).to.equal(index);
      expect(spot.class).to.equal(index < policy('KING_SPOTS') ? 1 : 0);
      const count = spot.realmMask.toString(2).replace(/0/g, '').length;
      expect(count).to.equal(index < policy('KING_SPOTS') ? policy('REALM_COUNT') : policy('REGULAR_REALM_COUNT'));
    });
    expect(row.registryHash).to.deep.equal(spots.hash);
    await fail(program.methods.initializeAuctionConfig(new BN(firstStart + 1)).accountsPartial(configAccounts()).rpc());
    expect((await program.account.auctionConfig.fetch(config)).firstOperatingStart.toNumber()).to.equal(firstStart);
  });
  it('creates a deterministic empty round while paused without claiming settled or unsold authority', async () => {
    await open(0n, null);
    const row = await program.account.seekerTerm.fetch(term(0n));
    expect(row.previous).to.equal(null); expect(row.auctionStart.toNumber()).to.equal(firstStart - policy('OVERLAPPING_AUCTION_SEC'));
    expect(row.operatingStart.toNumber()).to.equal(firstStart); expect(row.operatingEnd.toNumber()).to.equal(firstStart + policy('OPERATING_TERM_SEC'));
    expect(row.opened.every(byte => byte === 0)).to.equal(true); expect(row.settled.every(byte => byte === 0)).to.equal(true);
    expect(row.completedCount).to.equal(0); expect(row.winnerCount).to.equal(0); expect(row.completedAt).to.equal(null);
    await fail(open(0n, null));
  });
  it('requires the genuine predecessor but permits preparing a successor before older results exist', async () => {
    expect(code(await fail(open(1n, null)))).to.equal('InvalidPredecessor');
    expect(await connection.getAccountInfo(term(1n))).to.equal(null);
    await open(1n, term(0n));
    expect(code(await fail(open(2n, term(0n))))).to.equal('InvalidPredecessor');
    expect(await connection.getAccountInfo(term(2n))).to.equal(null);
    await open(2n, term(1n));
    const row = await program.account.seekerTerm.fetch(term(2n));
    expect(row.operatingStart.toNumber()).to.equal(firstStart + 2 * policy('OPERATING_TERM_SEC'));
    expect(row.previous?.equals(term(1n))).to.equal(true); expect(row.completedAt).to.equal(null);
  });
});
