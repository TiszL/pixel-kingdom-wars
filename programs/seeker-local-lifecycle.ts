/** Explicit LOOPBACK fixture; excluded from automatic Anchor tests. No validator launch/reset/clock fabrication.
 * From programs/: ../scripts/node_modules/.bin/tsx seeker-local-lifecycle.ts
 * prepare|bid|settle --rpc http://127.0.0.1:PORT
 * --checkpoint /tmp/seeker-local-UNIQUE.json --payer /absolute/local-validator-wallet.json
 * --genesis ACTUAL_GENESIS --program-data-sha256 FULL_ACCOUNT_HASH --t0 UNIX_SECONDS
 * Root must approve each phase invocation. Warp/restart the SAME ledger externally and inspect
 * actual Clock before subsequent phases. Generated IDL must expose the complete escrow lifecycle.
 * Private checkpoint contains ephemeral fixture keys and signed transactions; never publish it.
 * This acceptance fixture is NOT the production finalized term reader.
 */
// Same identity miningProgramProtocol.ts exports (this IDL's address). That module default-imports
// @coral-xyz/anchor, which tsx cannot initialize from this CommonJS package (CI run 37503885236).
import economyIdl from '../packages/chain/src/idl/shardkeep_economy.json' with { type: 'json' };
import { readFinalizedSeekerTerm, makeSeekerTermRpc } from '../packages/chain/src/seekerTerms';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import * as anchor from '@coral-xyz/anchor';
import type { ShardkeepEconomy } from './target/types/shardkeep_economy';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, MINT_SIZE, createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction, createMintToInstruction, getAccount, getAssociatedTokenAddressSync, getMint } from '@solana/spl-token';
import { Connection, Ed25519Program, Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '../packages/shared/src/constants';
import { canonicalSeekerRegistry, encodeSeekerActionPermit, hashSeekerRegistry, hashSeekerAuctionTerms,
  hashOpenSeekerAuctionPayload, seekerAuthorityPda, seekerAuctionConfigPda, seekerRegistryPda, seekerTermPda,
  seekerAuctionPda, seekerBidPda, seekerPermitReceiptPda, type SeekerAuctionTerms } from '../packages/chain/src/seekerAuctionProtocol';

const MINING_PROGRAM_ADDRESS = economyIdl.address;
const PROGRAM = new PublicKey(MINING_PROGRAM_ADDRESS);
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const ROOT = resolve(dirname(process.argv[1]!), '..'); // tsx supports this entry in the programs CommonJS package.
const P = PHASE_E_POLICY.seekerIsland, A = PHASE_E_SEEKER_AUCTION;
const LOCAL_DECIMALS = 6; // Fixture mint precision, not a claim to official SKR identity.
const DONATION = 7n; // Deliberately non-bid test inventory.
type Phase = 'prepare' | 'bid' | 'settle';
type Step = { phase: Phase; raw: string; signature: string; blockhash: string; lastValidBlockHeight: number; slot?: number };
type Checkpoint = { version: 1; rpc: string; genesis: string; hash: string; payer: string; t0: string;
  keys: { policy: number[]; bidderA: number[]; bidderB: number[]; mint: number[]; custodian: number[] };
  steps: Record<string, Step>; completed: Phase[] };
type Config = { authority: PublicKey; registry: PublicKey; registryHash: number[]; mint: PublicKey; tokenProgram: PublicKey;
  prizeOwner: PublicKey; prizeAta: PublicKey; decimals: number; prizeBps: number; openingBid: anchor.BN;
  firstOperatingStart: anchor.BN; termSec: anchor.BN; auctionSec: anchor.BN; graceSec: anchor.BN;
  registryVersion: number; auctionFormat: number; termsFormat: number };
type Term = { config: PublicKey; round: anchor.BN; opened: number[]; settled: number[]; completedCount: number;
  winnerCount: number; auctionStart: anchor.BN; auctionEnd: anchor.BN; operatingStart: anchor.BN; operatingEnd: anchor.BN };
type Auction = { config: PublicKey; term: PublicKey; vault: PublicKey; termsHash: number[]; highBid: anchor.BN;
  highBidder: PublicKey | null; outstandingEscrow: anchor.BN; settled: boolean; resultOwner: PublicKey | null;
  settledAt: anchor.BN | null; settledSlot: anchor.BN | null };
const bn = (x: bigint) => new anchor.BN(x.toString());
const num = (x: anchor.BN) => BigInt(x.toString());
const eq = (a: PublicKey, b: PublicKey) => a.toBase58() === b.toBase58();
function assert(ok: unknown, label: string): asserts ok { if (!ok) throw new Error(label); }
function signatureText(bytes: Buffer): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt('0x' + bytes.toString('hex')), out = '';
  while (value > 0n) { out = alphabet[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = '1' + out; }
  return out;
}
function parseArgs(): Record<string, string> {
  const args = process.argv.slice(3), out: Record<string, string> = { '--phase': process.argv[2] ?? '' };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    assert(key?.startsWith('--') && value && !value.startsWith('--') && !out[key], 'Malformed/duplicate argument');
    out[key] = value;
  }
  const required = ['--phase', '--rpc', '--checkpoint', '--payer', '--genesis', '--program-data-sha256', '--t0'];
  assert(Object.keys(out).length === required.length && required.every(x => out[x]), 'Require exactly the documented arguments');
  assert(['prepare', 'bid', 'settle'].includes(out['--phase']!), 'Unknown phase');
  const match = /^http:\/\/(127\.0\.0\.1|localhost):([1-9][0-9]{0,4})\/?$/.exec(out['--rpc']!);
  assert(match && Number(match[2]) <= 65535, 'Only explicit HTTP loopback ports are allowed');
  out['--rpc'] = `http://127.0.0.1:${match[2]}`; // No DNS/redirect path to another host.
  assert(/^\/tmp\/seeker-local-[A-Za-z0-9-]+\.json$/.test(out['--checkpoint']!), 'Use a unique direct /tmp/seeker-local-*.json');
  assert(isAbsolute(out['--payer']!), 'Payer path must be absolute');
  assert(/^[0-9a-f]{64}$/.test(out['--program-data-sha256']!), 'Require exact full ProgramData SHA-256');
  assert(/^[1-9][0-9]*$/.test(out['--t0']!), 'T0 must be positive canonical seconds');
  assert(BigInt(out['--t0']!) + BigInt(P.operatingTermSec) <= (1n << 63n) - 1n, 'T0 overflow');
  assert(new PublicKey(out['--genesis']!).toBase58() === out['--genesis'], 'Noncanonical genesis');
  return out;
}
async function privateRead(path: string): Promise<string> {
  const f = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { const stat = await f.stat(); assert(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600,
    'Checkpoint/key material must be a private owned0600 regular file'); return await f.readFile('utf8'); } finally { await f.close(); }
}
async function main(): Promise<void> {
  let readerVerified = false;
  const args = parseArgs(), phase = args['--phase'] as Phase, path = args['--checkpoint']!;
  const rpc = args['--rpc']!, genesis = args['--genesis']!, hash = args['--program-data-sha256']!, t0 = BigInt(args['--t0']!);
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await privateRead(args['--payer']!))));
  const connection = new Connection(rpc, { commitment: 'finalized', disableRetryOnRateLimit: true,
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) });
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: 'finalized', preflightCommitment: 'finalized' });
  const idl = JSON.parse(await readFile(resolve(ROOT, 'programs/target/idl/shardkeep_economy.json'), 'utf8')) as anchor.Idl;
  assert(idl.address === PROGRAM.toBase58(), 'Generated IDL identity mismatch');
  for (const name of ['open_auction', 'open_bid', 'place_bid', 'withdraw_bid', 'settle_auction']) {
    assert(idl.instructions.some(i => i.name === name), `Complete escrow IDL missing ${name}`);
  }
  const program = new anchor.Program<ShardkeepEconomy>(idl as unknown as ShardkeepEconomy, provider);
  const probeIdl = JSON.parse(await readFile(resolve(ROOT, 'programs/target/idl/seeker_cpi_probe.json'), 'utf8')) as anchor.Idl;
  assert(probeIdl.address === 'GGRZUzCunNTqAkny7sLZW6ZkCcj918nDJuzt7SQUYNbK', 'Wrong local-only CPI probe');
  const probe = new anchor.Program(probeIdl, provider);
  const [programData] = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], LOADER);
  async function identity(): Promise<void> {
    assert(await connection.getGenesisHash() === genesis, 'Validator genesis differs from explicit expected identity');
    const [p, d] = await connection.getMultipleAccountsInfo([PROGRAM, programData], 'finalized');
    assert(p && p.executable && eq(p.owner, LOADER) && p.data.length === 36 && p.data.readUInt32LE(0) === 2
      && eq(new PublicKey(p.data.subarray(4)), programData), 'Program is not the expected upgradeable executable');
    assert(d && !d.executable && eq(d.owner, LOADER) && d.data.length > 45 && d.data.readUInt32LE(0) === 3
      && d.data[12] === 1 && eq(new PublicKey(d.data.subarray(13, 45)), payer.publicKey), 'Wrong ProgramData/upgrade authority');
    assert(createHash('sha256').update(d.data).digest('hex') === hash, 'Unreviewed ProgramData bytes');
  }
  let clockContextSlot = 0;
  async function clock(): Promise<bigint> {
    const observed = await connection.getAccountInfoAndContext(SYSVAR_CLOCK_PUBKEY, 'finalized');
    const row = observed.value; clockContextSlot = observed.context.slot;
    assert(row && row.data.length === 40, 'Missing/malformed actual chain Clock');
    return row.data.readBigInt64LE(32);
  }
  async function window(): Promise<bigint> {
    const now = await clock(), start = t0 - BigInt(P.overlappingAuctionSec);
    assert(phase === 'prepare' ? now < start : phase === 'bid' ? now >= start && now < t0
      : now >= t0 + BigInt(A.settlementGraceSec) && now < t0 + BigInt(P.operatingTermSec), `Actual chain Clock outside ${phase} window`);
    return now;
  }
  await identity(); await window();
  const lockPath = path + '.lock', lock = await open(lockPath, 'wx', 0o600);
  let state: Checkpoint;
  try {
    let found = true;
    try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') found = false; else throw error; }
    if (!found) {
      assert(phase === 'prepare', 'No original prepare checkpoint');
      for (const address of [seekerAuthorityPda(PROGRAM), seekerAuctionConfigPda(PROGRAM), seekerRegistryPda(PROGRAM)]) {
        assert(await connection.getAccountInfo(address, 'finalized') === null, 'Unknown existing singleton; use original checkpoint or a separately authorized fresh ledger');
      }
      const secret = () => Array.from(Keypair.generate().secretKey);
      state = { version: 1, rpc, genesis, hash, payer: payer.publicKey.toBase58(), t0: t0.toString(),
        keys: { policy: secret(), bidderA: secret(), bidderB: secret(), mint: secret(), custodian: secret() }, steps: {}, completed: [] };
      const created = await open(path, 'wx', 0o600);
      try { await created.writeFile(JSON.stringify(state)); await created.sync(); } finally { await created.close(); }
    } else state = JSON.parse(await privateRead(path)) as Checkpoint;
    assert(state.version === 1 && state.rpc === rpc && state.genesis === genesis && state.hash === hash
      && state.payer === payer.publicKey.toBase58() && state.t0 === t0.toString(), 'Checkpoint belongs to different fixture identity');
    assert(state.steps && Array.isArray(state.completed) && Object.values(state.steps).every(step => typeof step.signature === 'string'
      && typeof step.raw === 'string' && typeof step.blockhash === 'string' && Number.isSafeInteger(step.lastValidBlockHeight)), 'Malformed checkpoint');
    const fixtureKey = (name: keyof Checkpoint['keys']) => Keypair.fromSecretKey(Uint8Array.from(state.keys[name]));
    const policy = fixtureKey('policy'), bidderA = fixtureKey('bidderA'), bidderB = fixtureKey('bidderB');
    const mint = fixtureKey('mint'), custodian = fixtureKey('custodian');
    const authority = seekerAuthorityPda(PROGRAM), config = seekerAuctionConfigPda(PROGRAM), registry = seekerRegistryPda(PROGRAM);
    const term = seekerTermPda(PROGRAM, config, 0n), prizeAta = getAssociatedTokenAddressSync(mint.publicKey, custodian.publicKey);
    const auction = (spot: number) => seekerAuctionPda(PROGRAM, config, spot, 0n);
    const vault = (spot: number) => getAssociatedTokenAddressSync(mint.publicKey, auction(spot), true);
    const ata = (wallet: PublicKey) => getAssociatedTokenAddressSync(mint.publicKey, wallet);
    const opening = BigInt(A.openingBidSkr) * 10n ** BigInt(LOCAL_DECIMALS);
    const token = { mint: mint.publicKey, tokenProgram: TOKEN_PROGRAM_ID };
    async function save(): Promise<void> {
      const tmp = path + '.' + randomBytes(8).toString('hex');
      const f = await open(tmp, 'wx', 0o600);
      try { await f.writeFile(JSON.stringify(state)); await f.sync(); } finally { await f.close(); }
      await rename(tmp, path);
      const directory = await open(dirname(path), fsConstants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
    async function read<T>(name: keyof typeof program.account, address: PublicKey): Promise<T> {
      return await program.account[name].fetch(address) as unknown as T;
    }
    async function historyFloor(earliestSlot: number): Promise<number> {
      assert(Number.isSafeInteger(earliestSlot) && earliestSlot >= 0, 'Unsafe original receipt slot');
      const firstAvailable = await connection.getFirstAvailableBlock();
      assert(Number.isSafeInteger(firstAvailable) && firstAvailable >= 0 && firstAvailable <= earliestSlot,
        `Original receipt history pruned: first available ${firstAvailable}, required ${earliestSlot}`);
      return firstAvailable;
    }
    async function step(label: string, build: () => Promise<TransactionInstruction[]>, signers: Keypair[] = []): Promise<void> {
      await identity(); await window();
      let entry = state.steps[label];
      if (!entry) {
        const tx = new Transaction().add(...await build());
        const latest = await connection.getLatestBlockhash('finalized');
        tx.feePayer = payer.publicKey; tx.recentBlockhash = latest.blockhash; tx.sign(payer, ...signers);
        assert(tx.signature, 'Fixture transaction missing payer signature');
        entry = { phase, raw: tx.serialize().toString('base64'), signature: signatureText(tx.signature), ...latest };
        state.steps[label] = entry; await save(); // Durable identity before any bytes leave.
      }
      const raw = Buffer.from(entry.raw, 'base64'), tx = Transaction.from(raw);
      assert(tx.verifySignatures() && tx.signature && signatureText(tx.signature) === entry.signature
        && tx.recentBlockhash === entry.blockhash && eq(tx.feePayer!, payer.publicKey), 'Corrupt saved transaction');
      const status = (await connection.getSignatureStatuses([entry.signature], { searchTransactionHistory: true })).value[0];
      assert(!status?.err, `Original ${label} transaction failed; inspect checkpoint, do not replace its identity`);
      if (status?.confirmationStatus === 'finalized') { entry.slot = status.slot; await save(); return; }
      assert(!entry.slot, 'Previously finalized fixture receipt disappeared');
      if (!status) {
        assert(await connection.getBlockHeight('finalized') <= entry.lastValidBlockHeight, `Expired ambiguous ${label}; operator inspection required`);
        await window();
        const sent = await connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0 });
        assert(sent === entry.signature, 'Broadcast signature changed');
      }
      const result = await connection.confirmTransaction({ signature: entry.signature, blockhash: entry.blockhash,
        lastValidBlockHeight: entry.lastValidBlockHeight }, 'finalized');
      assert(!result.value.err, `Original ${label} failed; no automatic replacement`);
      const final = (await connection.getSignatureStatuses([entry.signature], { searchTransactionHistory: true })).value[0];
      assert(final?.confirmationStatus === 'finalized' && !final.err, 'Missing finalized receipt');
      entry.slot = final.slot; await save();
    }
    async function configProof(): Promise<Config> {
      const c = await read<Config>('auctionConfig', config);
      assert(eq(c.authority, authority) && eq(c.registry, registry) && eq(c.mint, mint.publicKey) && eq(c.tokenProgram, TOKEN_PROGRAM_ID)
        && eq(c.prizeOwner, custodian.publicKey) && eq(c.prizeAta, prizeAta) && c.decimals === LOCAL_DECIMALS
        && c.prizeBps === A.prizeBps && num(c.openingBid) === opening && num(c.firstOperatingStart) === t0
        && num(c.termSec) === BigInt(P.operatingTermSec) && num(c.auctionSec) === BigInt(P.overlappingAuctionSec)
        && num(c.graceSec) === BigInt(A.settlementGraceSec) && c.registryVersion === 1 && c.auctionFormat === 1 && c.termsFormat === 1
        && Buffer.from(c.registryHash).equals(hashSeekerRegistry(canonicalSeekerRegistry())), 'Frozen config mismatch');
      const a = await read<{ admin: PublicKey; guardian: PublicKey; currentPolicyKey: PublicKey; clusterGenesis: number[] }>('seekerAuthority', authority);
      assert(eq(a.admin, payer.publicKey) && eq(a.guardian, payer.publicKey) && eq(a.currentPolicyKey, policy.publicKey)
        && Buffer.from(a.clusterGenesis).equals(new PublicKey(genesis).toBuffer()), 'Original authority changed');
      return c;
    }
    function terms(spotId: number): SeekerAuctionTerms {
      const row = canonicalSeekerRegistry()[spotId]!;
      return { config, term, auction: auction(spotId), registry, registryHash: hashSeekerRegistry(canonicalSeekerRegistry()),
        ...row, round: 0n, auctionStart: t0 - BigInt(P.overlappingAuctionSec), auctionEnd: t0, operatingStart: t0,
        operatingEnd: t0 + BigInt(P.operatingTermSec), mint: mint.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        vault: vault(spotId), prizeOwner: custodian.publicKey, prizeAta, prizeBps: A.prizeBps,
        grace: BigInt(A.settlementGraceSec), openingBid: opening, registryVersion: 1, auctionFormat: 1, termsFormat: 1 };
    }
    async function pause(paused: boolean, label: string): Promise<void> {
      await step(label, async () => [await program.methods.setAdmissionPaused!(paused)
        .accountsStrict({ signer: payer.publicKey, authority }).instruction()]);
    }
    async function bid(spot: number, who: Keypair, amount: bigint, label: string): Promise<void> {
      await step(label, async () => [await program.methods.placeBid!(bn(amount)).accountsStrict({ wallet: who.publicKey,
        authority, config, term, auction: auction(spot), bid: seekerBidPda(PROGRAM, auction(spot), who.publicKey),
        ...token, source: ata(who.publicKey), vault: vault(spot) }).instruction()], [who]);
    }
    async function refund(spot: number, who: Keypair, label: string): Promise<void> {
      await step(label, async () => [await program.methods.withdrawBid!().accountsStrict({ wallet: who.publicKey,
        config, auction: auction(spot), bid: seekerBidPda(PROGRAM, auction(spot), who.publicKey),
        ...token, destination: ata(who.publicKey), vault: vault(spot) }).instruction()], [who]);
    }
    if (phase === 'prepare') {
      await step('fixture-mint', async () => [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
        space: MINT_SIZE, lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE), programId: TOKEN_PROGRAM_ID }),
        createInitializeMint2Instruction(mint.publicKey, LOCAL_DECIMALS, payer.publicKey, null)], [mint]);
      await step('initialize-authority', async () => [await program.methods.initializeSeekerAuthority!(payer.publicKey, policy.publicKey,
        Array.from(new PublicKey(genesis).toBytes())).accountsStrict({ admin: payer.publicKey, program: PROGRAM, programData, authority,
        systemProgram: SystemProgram.programId }).instruction()]);
      await step('initialize-config', async () => [await program.methods.initializeAuctionConfig!(bn(t0)).accountsStrict({ admin: payer.publicKey,
        authority, config, registry, ...token, prizeOwner: custodian.publicKey, prizeAta,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction()]);
      await configProof();
      await step('open-term', async () => [await program.methods.openTerm!(bn(0n)).accountsStrict({ payer: payer.publicKey, config, registry, term,
        previousTerm: null, systemProgram: SystemProgram.programId }).instruction()]);
      await step('fixture-funds', async () => [
        ...[bidderA, bidderB].flatMap(w => [
          SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: w.publicKey, lamports: 100_000_000 }), // Fixture rent, no player price.
          createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(w.publicKey), w.publicKey, mint.publicKey),
          createMintToInstruction(mint.publicKey, ata(w.publicKey), payer.publicKey, opening * 20n)]),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, vault(0), auction(0), mint.publicKey),
        createMintToInstruction(mint.publicKey, vault(0), payer.publicKey, DONATION),
      ]);
      await pause(false, 'prepare-unpause');
      for (let spot = 0; spot < P.totalSpots; spot++) await step(`open-auction-${spot}`, async () => {
        const permitId = randomBytes(16), expiry = await clock() + BigInt(A.issuedPolicyPermitTtlSec);
        const signed = encodeSeekerActionPermit({ genesisHash: new PublicKey(genesis), programId: PROGRAM, kind: 7, permitId,
          wallet: payer.publicKey, expiry, payloadHash: hashOpenSeekerAuctionPayload(terms(spot)) });
        return [Ed25519Program.createInstructionWithPrivateKey({ privateKey: policy.secretKey, message: signed }),
          await program.methods.openAuction!(spot, { permitId: Array.from(permitId), expiry: bn(expiry), ed25519Instruction: 0 })
            .accountsStrict({ wallet: payer.publicKey, authority, config, registry, term, auction: auction(spot), vault: vault(spot), ...token,
              receipt: seekerPermitReceiptPda(PROGRAM, permitId), instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction()];
      });
      const t = await read<Term>('seekerTerm', term);
      assert(t.completedCount === 0 && t.winnerCount === 0, 'Preparation manufactured settled evidence');
      for (let spot = 0; spot < P.totalSpots; spot++) {
        assert((t.opened[Math.floor(spot / 8)]! & (1 << (spot % 8))) !== 0, 'Missing prepared auction');
        const a = await read<Auction>('auction', auction(spot));
        assert(!a.settled && a.highBidder === null && num(a.highBid) === 0n && num(a.outstandingEscrow) === 0n
          && Buffer.from(a.termsHash).equals(hashSeekerAuctionTerms(terms(spot))), 'Opening terms or zero-bid accounting wrong');
      }
      assert((await getAccount(connection, vault(0), 'finalized')).amount === DONATION, 'Precreated donated vault was lost or treated as bid');
    } else {
      assert(state.completed.includes('prepare'), 'Prepare has no complete original evidence');
      await configProof();
      if (phase === 'bid') {
        // A private prepare checkpoint is not proof that a restart retained its
        // accounts. Check the actual original term before opening bids/funding.
        const prepared = await read<Term>('seekerTerm', term);
        assert(prepared.opened.length === Math.ceil(P.totalSpots / 8)
          && prepared.opened.every((byte, i) => byte === (i < Math.floor(P.totalSpots / 8)
            ? 255 : (1 << (P.totalSpots % 8)) - 1)), 'Prepared term bitmap changed across restart; inspect original snapshot');
        for (const spot of [0, 1, 2]) for (const [name, who] of [['A', bidderA], ['B', bidderB]] as const) {
          await step(`open-bid-${spot}-${name}`, async () => [await program.methods.openBid!().accountsStrict({ wallet: who.publicKey,
            config, auction: auction(spot), bid: seekerBidPda(PROGRAM, auction(spot), who.publicKey), systemProgram: SystemProgram.programId }).instruction()], [who]);
        }
        await bid(0, bidderA, opening, 'minimum'); await bid(0, bidderA, opening * 2n, 'leader-topup');
        await bid(0, bidderB, opening * 3n, 'outbid'); await refund(0, bidderA, 'loser-refund');
        await bid(0, bidderA, opening * 4n, 'rebid-full');
        // Rejection is simulated against the real on-chain instruction, never accepted as a receipt.
        const before = await getAccount(connection, ata(bidderA.publicKey), 'finalized');
        const expectedRefusal = program.rawIdl.errors?.find(error => error.name === 'NotRefundable');
        assert(expectedRefusal, 'Generated IDL omits the original NotRefundable error ABI');
        let refused = false;
        let refusalEvidence = 'Simulation unexpectedly succeeded';
        try { await program.methods.withdrawBid!().accountsStrict({ wallet: bidderA.publicKey, config, auction: auction(0),
          bid: seekerBidPda(PROGRAM, auction(0), bidderA.publicKey), ...token, destination: ata(bidderA.publicKey), vault: vault(0) })
          // Anchor's legacy simulation helper re-signs from this list, replacing
          // the provider's payer signature. Preserve both required signatures.
          .signers([payer, bidderA]).simulate(); } catch (error) {
          // Anchor 0.32.1 SimulateError nests the RPC result; translateError only
          // reads top-level logs and therefore does not produce AnchorError here.
          const response = (error as { simulationResponse?: { err?: unknown; logs?: string[] } }).simulationResponse;
          const parsed = anchor.AnchorError.parse(response?.logs ?? []);
          const instructionError = (response?.err as { InstructionError?: unknown[] } | undefined)?.InstructionError;
          refused = Array.isArray(instructionError) && instructionError.length === 2 && instructionError[0] === 0
            && (instructionError[1] as { Custom?: unknown } | null)?.Custom === expectedRefusal.code
            && parsed?.error.errorCode.code === expectedRefusal.name && parsed.error.errorCode.number === expectedRefusal.code
            && parsed.program?.equals(PROGRAM) === true;
          refusalEvidence = JSON.stringify({ err: response?.err, logs: response?.logs,
            message: error instanceof Error ? error.message : String(error) });
        }
        assert(refused, `Leader withdrawal did not produce exact NotRefundable refusal: ${refusalEvidence}`);
        assert((await getAccount(connection, ata(bidderA.publicKey), 'finalized')).amount === before.amount, 'Rejected leader withdrawal changed funds');
        await pause(true, 'bid-pause'); await refund(0, bidderB, 'paused-loser-refund'); await pause(false, 'bid-resume');
        await bid(1, bidderB, opening, 'second-winner');
        await bid(2, bidderA, opening, 'retained-loser'); await bid(2, bidderB, opening * 2n, 'third-winner');
        for (const [spot, amount] of [[0, opening * 4n + DONATION], [1, opening], [2, opening * 3n]] as const) {
          assert((await getAccount(connection, vault(spot), 'finalized')).amount === amount, 'Bid/refund/rebid conservation failed');
        }
      } else {
        assert(state.completed.includes('bid'), 'Bid phase incomplete');
        await pause(true, 'settle-pause');
        for (let spot = 0; spot < P.totalSpots; spot++) {
          const a = await read<Auction>('auction', auction(spot));
          await step(`settle-${spot}`, async () => {
            const instruction = await program.methods.settleAuction!().accountsStrict({ wallet: payer.publicKey,
              config, term, auction: auction(spot), ...token, vault: vault(spot), prizeAta,
              winnerBid: a.highBidder ? seekerBidPda(PROGRAM, auction(spot), a.highBidder) : null }).instruction();
            if (spot === 0) {
              // A successful harmless CPI alongside the top-level settlement
              // is not settlement authority and must not poison its evidence.
              const alreadyPaused = await program.methods.setAdmissionPaused(true)
                .accountsStrict({ signer: payer.publicKey, authority }).instruction();
              const noise = await probe.methods.forward!(alreadyPaused.data, false)
                .accountsPartial({ targetProgram: PROGRAM }).remainingAccounts(alreadyPaused.keys).instruction();
              return [instruction, noise];
            }
            if (spot === 1) {
              // Anchor accepts harmless suffixes; the reader must accept the same
              // wire language after verifying every required binding.
              instruction.data = Buffer.concat([instruction.data, Buffer.from([17, 29])]);
              instruction.keys.push({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false });
            }
            return [instruction];
          });
        }
        const t = await read<Term>('seekerTerm', term);
        assert(t.completedCount === P.totalSpots && t.winnerCount === 3, 'Incomplete or fabricated winner denominator');
        for (let spot = 0; spot < P.totalSpots; spot++) {
          const a = await read<Auction>('auction', auction(spot));
          assert(eq(a.config, config) && eq(a.term, term) && eq(a.vault, vault(spot))
            && Buffer.from(a.termsHash).equals(hashSeekerAuctionTerms(terms(spot))), 'Terminal history changed original terms');
          assert(a.settled && a.settledAt !== null && a.settledSlot !== null && num(a.settledAt) >= t0,
            'No genuine terminal auction result');
          assert((t.settled[Math.floor(spot / 8)]! & (1 << (spot % 8))) !== 0, 'Missing settled spot');
          assert(spot < 3 ? a.resultOwner && eq(a.resultOwner, spot === 0 ? bidderA.publicKey : bidderB.publicKey)
            : a.resultOwner === null && num(a.highBid) === 0n, 'Wrong winner/unsold result');
        }
        assert((await getAccount(connection, prizeAta, 'finalized')).amount === opening * 7n, 'Prize consumed surplus/loser funds');
        await refund(2, bidderA, 'postsettlement-loser-refund');
        let sum = (await getAccount(connection, prizeAta, 'finalized')).amount;
        for (const who of [bidderA, bidderB]) sum += (await getAccount(connection, ata(who.publicKey), 'finalized')).amount;
        for (let spot = 0; spot < P.totalSpots; spot++) {
          const account = await getAccount(connection, vault(spot), 'finalized');
          assert(account.amount === (spot === 0 ? DONATION : 0n), 'Residual escrow/donation mismatch'); sum += account.amount;
          assert(num((await read<Auction>('auction', auction(spot))).outstandingEscrow) === 0n, 'Unreleased escrow liability');
        }
        assert(sum === opening * 40n + DONATION && (await getMint(connection, mint.publicKey, 'finalized')).supply === sum,
          'Mint/bidder/vault/prize supply is not conserved');
        const settlementReceipts = Array.from({ length: P.totalSpots }, (_, spot) => {
          const original = state.steps[`settle-${spot}`];
          assert(original?.phase === 'settle' && original.signature && Number.isSafeInteger(original.slot)
            && original.slot! >= 0, 'Original finalized settlement receipt is missing or unsafe');
          return { spot, signature: original.signature, slot: original.slot! };
        });
        assert(settlementReceipts.length === P.totalSpots
          && new Set(settlementReceipts.map(receipt => receipt.signature)).size === P.totalSpots,
        'Original settlement receipts must cover every spot with a unique signature');
        const earliestSettlementSlot = Math.min(...settlementReceipts.map(receipt => receipt.slot));
        const latestSettlementSlot = Math.max(...settlementReceipts.map(receipt => receipt.slot));
        const firstAvailableBefore = await historyFloor(earliestSettlementSlot);
        const signatureHints = new Map(settlementReceipts.map(receipt => [receipt.spot, receipt.signature]));
        const verified = await readFinalizedSeekerTerm(signal => makeSeekerTermRpc(rpc, signal), {
          programId: PROGRAM, config, round: 0n, genesisHash: new PublicKey(genesis), mint: mint.publicKey,
          prizeOwner: custodian.publicKey, prizeAta, stateProvenance: 'fresh-reviewed-deployment',
          deployment: { programDataAddress: programData.toBase58(), programDataSha256: hash,
            upgradeAuthority: payer.publicKey.toBase58() },
        }, { settlementSignatures: signatureHints });
        assert(verified.auctions.length === P.totalSpots && verified.winnerCount === 3,
          'Production reader did not verify every genuine result');
        assert(verified.auctions.every((auction, spot) => auction.terms.spotId === spot
          && auction.settlement.signature === settlementReceipts[spot]!.signature
          && auction.settlement.slot === BigInt(settlementReceipts[spot]!.slot)),
        'Production reader changed an original settlement receipt');
        const firstAvailableAfter = await historyFloor(earliestSettlementSlot);
        readerVerified = true;
        console.log(JSON.stringify({ productionReaderVerified: true, contextSlot: verified.finality.contextSlot.toString(),
          observedAt: verified.finality.observedAt, auctions: verified.auctions.length,
          earliestSettlementSlot, latestSettlementSlot, firstAvailableBefore, firstAvailableAfter }));
      }
    }
    // Only this phase needs live archival receipts. Earlier completed phases may
    // age out during the genuine 24-hour window; local saved slots never replace
    // missing RPC evidence for a phase being executed or resumed.
    const phaseReceipts = Object.values(state.steps).filter(entry => entry.phase === phase);
    assert(phaseReceipts.length > 0 && phaseReceipts.length <= 256 // RPC signature-status batch limit.
      && phaseReceipts.every(entry => Number.isSafeInteger(entry.slot) && entry.slot! >= 0)
      && new Set(phaseReceipts.map(entry => entry.signature)).size === phaseReceipts.length,
    'Current phase has missing, unsafe or duplicate original receipts');
    const earliestPhaseSlot = Math.min(...phaseReceipts.map(entry => entry.slot!));
    const firstAvailableBefore = await historyFloor(earliestPhaseSlot);
    const statuses = (await connection.getSignatureStatuses(phaseReceipts.map(entry => entry.signature),
      { searchTransactionHistory: true })).value;
    assert(statuses.length === phaseReceipts.length && statuses.every((status, i) => status?.err === null
      && status.confirmationStatus === 'finalized' && status.slot === phaseReceipts[i]!.slot),
    'Current phase lost an original finalized RPC receipt');
    const firstAvailableAfter = await historyFloor(earliestPhaseSlot);
    await identity(); const now = await window();
    if (!state.completed.includes(phase)) state.completed.push(phase);
    await save();
    console.log(JSON.stringify({ phase, checkpoint: path, actualClock: now.toString(), contextSlot: clockContextSlot, genesis,
      auctionStart: (t0 - BigInt(P.overlappingAuctionSec)).toString(), auctionEnd: t0.toString(),
      operatingEnd: (t0 + BigInt(P.operatingTermSec)).toString(), program: PROGRAM.toBase58(),
      finalizedTransactions: Object.values(state.steps).filter(s => s.slot !== undefined).length,
      retainedPhaseReceipts: phaseReceipts.length, earliestPhaseSlot, firstAvailableBefore, firstAvailableAfter,
      signatures: Object.entries(state.steps).filter(([, s]) => s.phase === phase && s.slot !== undefined)
        .map(([label, s]) => ({ label, signature: s.signature, slot: s.slot })), productionReaderVerified: readerVerified }));
  } finally { await lock.close(); await unlink(lockPath); }
}
main().catch(error => { console.error(String((error as Error).message).slice(0, 600)); process.exitCode = 1; });
