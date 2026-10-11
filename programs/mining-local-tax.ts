/** R1: one fresh loopback validator with explicit synthetic original-term accounts.
 * No public RPC, retained ledger, Clock replacement, deployment, release keys or natural-wait claim.
 * Run after the current economy SBF/IDL build: scripts/node_modules/.bin/tsx programs/mining-local-tax.ts
 */
// Same identity miningProgramProtocol.ts exports (this IDL's address). That module default-imports
// @coral-xyz/anchor, which tsx cannot initialize from this CommonJS package (CI run 37503885236).
import economyIdl from '../packages/chain/src/idl/shardkeep_economy.json' with { type: 'json' };
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import * as anchor from '@coral-xyz/anchor';
import { keccak_256 } from '@noble/hashes/sha3';
import { AccountLayout, AccountState, MintLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createTransferCheckedInstruction } from '@solana/spl-token';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, Transaction,
  type TransactionInstruction } from '@solana/web3.js';
import type { ShardkeepEconomy } from './target/types/shardkeep_economy';
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION as AUCTION, PHASE_E_MINING_PUBLICATION as MINING, TOKEN } from '../packages/shared/src/constants';
import { canonicalSeekerRegistry, hashSeekerRegistry, hashSeekerAuctionTerms } from '../packages/chain/src/seekerAuctionProtocol';

const MINING_PROGRAM_ADDRESS = economyIdl.address;
const PROGRAM = new PublicKey(MINING_PROGRAM_ADDRESS);
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const programs = dirname(resolve(process.argv[1]!));
const bn = (value: number | bigint) => new anchor.BN(value.toString());
const le = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(value); return bytes; };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const pda = (seed: string, ...parts: Buffer[]) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...parts], PROGRAM);
const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);

async function main() {
  const identityOnly = process.argv.length === 3 && process.argv[2] === '--identity-adversaries';
  check(process.argv.length === 2 || identityOnly, 'Only --identity-adversaries is supported; no RPC, key or ledger arguments');
  const working = await mkdtemp('/tmp/mining-tax-ci-');
  const accountDir = join(working, 'accounts'); await mkdir(accountDir, { mode: 0o700 });
  const payer = Keypair.generate(), alice = Keypair.generate(), bob = Keypair.generate(), guardian = Keypair.generate();
  const keepMint = Keypair.generate().publicKey, skrMint = Keypair.generate().publicKey, wrongMint = Keypair.generate().publicKey;
  const idl = JSON.parse(await readFile(join(programs, 'target/idl/shardkeep_economy.json'), 'utf8'));
  check(idl.address === PROGRAM.toBase58(), 'Wrong generated program identity');
  const binary = await readFile(join(programs, 'target/deploy/shardkeep_economy.so'));
  // Program normalizes the generated IDL's account/field names; this codec-only
  // provider is never asked to connect and uses only our throwaway signer.
  const coder = new anchor.Program<ShardkeepEconomy>(idl, new anchor.AnchorProvider(
    new Connection('http://127.0.0.1:1'), new anchor.Wallet(payer), {})).coder.accounts;
  const [config, configBump] = pda('economy'), [auctionConfig, auctionConfigBump] = pda('auction_config');
  const [registry, registryBump] = pda('seeker_registry'), [authority, authorityBump] = pda('seeker_authority');
  const vault = ata(keepMint, config), destinationA = ata(keepMint, alice.publicKey), destinationB = ata(keepMint, bob.publicKey);
  const reserve = ata(keepMint, payer.publicKey);
  const D = BigInt(MINING.daySec), P = PHASE_E_POLICY.seekerIsland;
  // The injected calendar is already historical. The running validator's actual
  // Clock is checked independently before transactions; no wall-clock wait gates.
  const firstDay = BigInt(Math.floor(Date.now() / 1000 / MINING.daySec)) - 10n;
  const firstStart = firstDay * D;
  const entries = canonicalSeekerRegistry(), registryHash = hashSeekerRegistry(entries);
  const bitmap = Array.from({ length: Math.ceil(P.totalSpots / 8) }, (_, index) => {
    let byte = 0; for (let bit = 0; bit < 8; bit++) if (index * 8 + bit < P.totalSpots) byte |= 1 << bit; return byte;
  });
  // Match auction::initialize's whole-SKR -> mint-base-units conversion.
  const openingBid = BigInt(AUCTION.openingBidSkr) * 10n ** BigInt(TOKEN.decimals);
  const acModel = { version: 1, authority, registry, registryHash: [...registryHash], registryVersion: 1,
    mint: skrMint, tokenProgram: TOKEN_PROGRAM_ID, decimals: TOKEN.decimals, prizeOwner: payer.publicKey,
    prizeAta: ata(skrMint, payer.publicKey), prizeBps: AUCTION.prizeBps, openingBid: bn(openingBid),
    firstOperatingStart: bn(firstStart), termSec: bn(P.operatingTermSec), auctionSec: bn(P.overlappingAuctionSec),
    graceSec: bn(AUCTION.settlementGraceSec), auctionFormat: 1, termsFormat: 1, bump: auctionConfigBump };
  const accounts = new Map<string, { owner: PublicKey; data: Buffer; lamports: number }>();
  async function account(key: PublicKey, owner: PublicKey, data: Buffer, lamports = 10_000_000) {
    check(!accounts.has(key.toBase58()), 'Duplicate injected account');
    accounts.set(key.toBase58(), { owner, data, lamports });
    await writeFile(join(accountDir, key.toBase58() + '.json'), JSON.stringify({ pubkey: key.toBase58(), account: {
      lamports, data: [data.toString('base64'), 'base64'], owner: owner.toBase58(), executable: false, rentEpoch: 0,
    } }), { mode: 0o600, flag: 'wx' });
  }
  const programAccount = async (key: PublicKey, name: string, model: object) => account(key, PROGRAM, await coder.encode(name, model));
  async function tokenAccount(key: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint) {
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: AccountState.Initialized,
      isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    await account(key, TOKEN_PROGRAM_ID, data);
  }
  for (const wallet of [payer, alice, bob, guardian]) await account(wallet.publicKey, SystemProgram.programId, Buffer.alloc(0), 10_000_000_000);
  for (const [mint, supply] of [[keepMint, 860n], [wrongMint, 0n]] as const) {
    const data = Buffer.alloc(MintLayout.span);
    MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply, decimals: TOKEN.decimals,
      isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
    await account(mint, TOKEN_PROGRAM_ID, data);
  }
  await tokenAccount(vault, keepMint, config, 859n);
  await tokenAccount(reserve, keepMint, payer.publicKey, 1n);
  await tokenAccount(destinationA, keepMint, alice.publicKey, 0n);
  await tokenAccount(destinationB, keepMint, bob.publicKey, 0n);
  await programAccount(authority, 'seekerAuthority', { version: 1, admin: payer.publicKey, pendingAdmin: null,
    guardian: guardian.publicKey, currentPolicyKey: Keypair.generate().publicKey, previousPolicyKey: null,
    previousValidUntil: bn(0), clusterGenesis: Array(32).fill(1), admissionPaused: true, bump: authorityBump });
  await programAccount(config, 'economyConfig', { version: 1, authority, publisher: payer.publicKey, keepMint, miningVault: vault,
    emissionReserveOwner: payer.publicKey, emissionReserveAta: reserve, decimals: TOKEN.decimals,
    genesisDay: bn(firstDay), latestDay: bn(firstDay + 6n), latestSequence: bn(6), totalPublished: bn(800),
    totalPublishedHighwater: bn(800), totalClaimed: bn(0), taxHighwater: bn(60), taxPaid: bn(0),
    recycledTotal: bn(60), grossPublished: bn(920), splitCursor: 0, flags: 0, correctionPending: false, bump: configBump });
  await programAccount(auctionConfig, 'auctionConfig', acModel);
  await programAccount(registry, 'seekerRegistry', { version: 1, island: 1,
    entries: entries.map(e => ({ id: e.spotId, class: e.class, realmMask: e.realmMask })), hash: [...registryHash], bump: registryBump });
  const terms: Array<{ key: PublicKey; start: bigint }> = [];
  for (const round of [0n, 1n]) {
    const [key, bump] = pda('seeker_term', auctionConfig.toBuffer(), le(round));
    const start = firstStart + round * BigInt(P.operatingTermSec);
    const model = { version: 1, config: auctionConfig, registry, registryHash: [...registryHash], round: bn(round),
      previous: round === 0n ? null : terms[0]!.key, auctionStart: bn(start - BigInt(P.overlappingAuctionSec)),
      auctionEnd: bn(start), operatingStart: bn(start), operatingEnd: bn(start + BigInt(P.operatingTermSec)),
      opened: bitmap, settled: bitmap, completedCount: P.totalSpots, winnerCount: 3,
      completedAt: bn(start), completedSlot: bn(1), bump };
    terms.push({ key, start }); await programAccount(key, 'seekerTerm', model);
  }
  const term = terms[0]!.key, successor = terms[1]!.key;
  const auctionKeys = new Map<number, PublicKey>();
  const spotIds = [0, P.kingSpots, P.kingSpots + 1, P.kingSpots + 2];
  for (const id of spotIds) {
    const [key, bump] = pda('auction', auctionConfig.toBuffer(), Buffer.from([id]), le(0n)); auctionKeys.set(id, key);
    const entry = entries[id]!, owner = id === P.kingSpots ? bob.publicKey : alice.publicKey;
    const auctionVault = ata(skrMint, key), unsold = id === P.kingSpots + 2;
    const termsHash = hashSeekerAuctionTerms({ config: auctionConfig, term, auction: key, registry, registryHash,
      spotId: id, class: entry.class, realmMask: entry.realmMask, round: 0n, auctionStart: firstStart - BigInt(P.overlappingAuctionSec),
      auctionEnd: firstStart, operatingStart: firstStart, operatingEnd: firstStart + BigInt(P.operatingTermSec), mint: skrMint,
      tokenProgram: TOKEN_PROGRAM_ID, vault: auctionVault, prizeOwner: payer.publicKey, prizeAta: acModel.prizeAta,
      prizeBps: AUCTION.prizeBps, grace: BigInt(AUCTION.settlementGraceSec), openingBid,
      registryVersion: 1, auctionFormat: 1, termsFormat: 1 });
    await programAccount(key, 'auction', { version: 1, config: auctionConfig, term, registry,
      spot: { id, class: entry.class, realmMask: entry.realmMask }, round: bn(0), auctionStart: bn(firstStart - BigInt(P.overlappingAuctionSec)),
      auctionEnd: bn(firstStart), operatingStart: bn(firstStart), operatingEnd: bn(firstStart + BigInt(P.operatingTermSec)),
      termsHash: [...termsHash], vault: auctionVault, highBid: bn(unsold ? 0n : openingBid),
      highBidder: unsold ? null : owner, outstandingEscrow: bn(0), settled: true, resultOwner: unsold ? null : owner,
      settledAt: bn(firstStart), settledSlot: bn(1), bump });
  }
  const epochs: PublicKey[] = [];
  for (const [index, tax] of [10n, 2n, 7n, 3n, 1n].entries()) {
    const day = firstDay + BigInt(index + 1), [key, bump] = pda('mining_epoch', le(day)); epochs.push(key);
    const version = Buffer.from([2, 0]), original = index === 3 ? terms[1]! : terms[0]!;
    const commitment = Buffer.from(keccak_256(Buffer.concat([Buffer.from('SKMTAX02'), version, PROGRAM.toBuffer(),
      config.toBuffer(), keepMint.toBuffer(), key.toBuffer(), le(day), auctionConfig.toBuffer(), original.key.toBuffer(),
      registry.toBuffer(), registryHash, le(index === 3 ? 1n : 0n), le(original.start - BigInt(P.overlappingAuctionSec)),
      le(original.start), le(original.start), le(original.start + BigInt(P.operatingTermSec)), Buffer.from([3, 1])])));
    const gross = tax * BigInt(MINING.splitPeriod);
    const free = gross * BigInt(PHASE_E_POLICY.mining.freePoolBps) / BigInt(PHASE_E_POLICY.basisPoints);
    await programAccount(key, 'miningEpochReceipt', { version: 1, config, day: bn(day), budgetGross: bn(100),
      freeGross: bn(free), deedGross: bn(gross - free), playerNet: bn(tax * BigInt(MINING.splitPlayerUnits)),
      tax: bn(tax), recycle: bn(tax), sourceHash: Array(32).fill(1),
      taxCommitment: [...commitment], taxVersion: index === 2 ? 1 : 2, splitStart: 0, splitEnd: 0,
      fundedAt: bn((day + 1n) * D), bump });
  }
  const [pool] = pda('mining_tax_pool', config.toBuffer(), term.toBuffer());
  const spot = (id: number) => pda('mining_tax_spot', pool.toBuffer(), Buffer.from([id]))[0];
  const accrual = (epoch: PublicKey) => pda('mining_tax_epoch', config.toBuffer(), epoch.toBuffer())[0];
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const a = server.address(); check(a && typeof a === 'object', 'No loopback port'); server.close(e => e ? reject(e) : resolve(a.port)); });
  });
  const out = createWriteStream(join(working, 'validator.log'));
  const child = spawn('solana-test-validator', ['--ledger', join(working, 'ledger'), '--rpc-port', String(port),
    '--bind-address', '127.0.0.1', '--dynamic-port-range', '19500-19525', '--faucet-port', '19530',
    '--limit-ledger-size', '10000', '--mint', Keypair.generate().publicKey.toBase58(), '--account-dir', accountDir,
    '--upgradeable-program', PROGRAM.toBase58(), join(programs, 'target/deploy/shardkeep_economy.so'), payer.publicKey.toBase58()],
  { cwd: programs, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout!.pipe(out, { end: false }); child.stderr!.pipe(out, { end: false });
  let failure: Error | undefined;
  const kill = (signal: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= e as Error; } };
  child.once('error', error => { failure = error; });
  const closed = new Promise<void>(resolve => child.once('close', () => { out.end(); resolve(); }));
  const drained = finished(out).catch(error => { failure ??= error; });
  const deadline = setTimeout(() => { failure = new Error('Ten-minute fixture deadline exceeded'); kill('SIGINT'); }, 600_000);
  const interrupt = () => { failure = new Error('Fixture interrupted'); kill('SIGINT'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const steps: Array<{ name: string; signature: string; expected: string | null }> = [];
  try {
    const connection = new Connection(`http://127.0.0.1:${port}`, { commitment: 'confirmed', disableRetryOnRateLimit: true,
      fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5_000) }) });
    const readyUntil = Date.now() + 60_000;
    while (true) {
      check(!failure && child.exitCode === null && child.signalCode === null, 'Owned validator exited');
      try { if (await connection.getSlot('confirmed') > 0) break; } catch { /* bounded readiness */ }
      check(Date.now() < readyUntil, 'Validator readiness exceeded60s'); await sleep(250);
    }
    const [programData] = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], LOADER);
    const [loadedProgram, loadedData] = await connection.getMultipleAccountsInfo([PROGRAM, programData], 'confirmed');
    check(loadedProgram?.executable && loadedProgram.owner.equals(LOADER) && loadedProgram.data.length === 36
      && loadedProgram.data.readUInt32LE(0) === 2 && new PublicKey(loadedProgram.data.subarray(4)).equals(programData), 'Wrong loaded program');
    check(loadedData && loadedData.owner.equals(LOADER) && loadedData.data.readUInt32LE(0) === 3 && loadedData.data[12] === 1
      && new PublicKey(loadedData.data.subarray(13, 45)).equals(payer.publicKey)
      && loadedData.data.subarray(45, 45 + binary.length).equals(binary)
      && loadedData.data.subarray(45 + binary.length).every(b => b === 0), 'Wrong binary or task-owned upgrade authority');
    for (const [key, expected] of accounts) {
      const actual = await connection.getAccountInfo(new PublicKey(key), 'confirmed');
      check(actual && actual.owner.equals(expected.owner) && actual.data.equals(expected.data), `Injected bytes differ: ${key}`);
    }
    const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
    check(clock && clock.data.readBigInt64LE(32) > firstStart + BigInt(P.operatingTermSec), 'Original term must have expired before claims');
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: 'confirmed' });
    const program = new anchor.Program<ShardkeepEconomy>(idl, provider);
    const base = { config, auctionConfig, registry, term, pool };
    const openPool = () => program.methods.openMiningTaxPool().accountsPartial({ payer: payer.publicKey, ...base, systemProgram: SystemProgram.programId }).instruction();
    const openSpot = (id: number) => program.methods.openMiningTaxSpot().accountsPartial({ payer: payer.publicKey, ...base,
      auction: auctionKeys.get(id)!, spotClaim: spot(id), systemProgram: SystemProgram.programId }).instruction();
    const accrue = (index: number, override = {}) => program.methods.accrueMiningTax().accountsPartial({ payer: payer.publicKey, ...base,
      epoch: epochs[index]!, accrual: accrual(epochs[index]!), systemProgram: SystemProgram.programId, ...override }).instruction();
    const claim = (id: number, wallet: Keypair, override = {}) => program.methods.claimMiningTax().accountsPartial({ claimant: wallet.publicKey,
      ...base, auction: auctionKeys.get(id)!, spotClaim: spot(id), vault, destination: ata(keepMint, wallet.publicKey),
      keepMint, tokenProgram: TOKEN_PROGRAM_ID, ...override }).instruction();
    const flags = (value: number) => program.methods.setMiningFlags(value).accountsPartial({ signer: payer.publicKey, authority, config }).instruction();
    const watched = [config, pool, ...epochs.map(accrual), ...spotIds.map(spot), vault, destinationA, destinationB];
    const snapshot = async () => (await connection.getMultipleAccountsInfo(watched, 'confirmed')).map(a => a ? `${a.owner}:${a.data.toString('base64')}:${a.lamports}` : null);
    async function step(name: string, instructions: TransactionInstruction[], signers: Keypair[] = [], expected: string | null = null) {
      check(!failure, failure?.message ?? 'Fixture interrupted');
      const before = await snapshot(), latest = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: steps.length + 1 }), ...instructions); tx.sign(payer, ...signers);
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
      // HTTP polling prevents orphaned confirmation WebSockets from reconnecting
      // after the owned validator has already shut down.
      const confirmUntil = Date.now() + 60_000;
      let status;
      while (true) {
        status = (await connection.getSignatureStatuses([signature])).value[0];
        if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) break;
        check(!failure && Date.now() < confirmUntil, `${name} confirmation exceeded60s`); await sleep(200);
      }
      const detail = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      const logs = (detail?.meta?.logMessages ?? []).join('\n');
      check(expected ? status.err !== null && logs.includes(expected) : status.err === null,
        `${name} unexpected outcome ${JSON.stringify(status.err)}\n${logs}`);
      if (expected) check(JSON.stringify(before) === JSON.stringify(await snapshot()), `${name} changed state despite rollback`);
      steps.push({ name, signature, expected }); console.log(name + ':pass');
    }
    async function identityAdversaries() {
      await step('wrong-account-owner', [await claim(0, alice, { auction: destinationA })], [alice], 'AccountOwnedByWrongProgram');
      await step('wrong-account-discriminator', [await claim(0, alice, { auction: term })], [alice], 'AccountDiscriminatorMismatch');
      await step('wrong-token-program', [await claim(0, alice, { tokenProgram: SystemProgram.programId })], [alice], 'InvalidProgramId');
    }
    if (identityOnly) {
      await step('identity-setup-pool', [await openPool()]);
      await step('identity-setup-accrual', [await accrue(0)]);
      await step('identity-setup-spot', [await openSpot(0)]);
      await identityAdversaries();
      await writeFile(join(working, 'result.json'), JSON.stringify({ fixture: 'injected-identity-adversaries-local-only',
        binarySha256: sha(binary), programDataSha256: sha(loadedData.data), steps }, null, 2));
      console.log(`Verified3 additional identity cases; report ${working}/result.json`);
      return;
    }
    await step('open-original-expired-term', [await openPool()]);
    await step('duplicate-pool', [await openPool()], [], 'already in use');
    await step('held-v1-is-not-reinterpreted', [await accrue(2)], [], 'InvalidMiningTaxEpoch');
    await step('wrong-successor-commitment', [await accrue(3)], [], 'InvalidMiningTaxEpoch');
    await step('wrong-successor-term-account', [await accrue(0, { term: successor })], [], 'ConstraintSeeds');
    await step('accrue-first', [await accrue(0)]);
    await step('duplicate-epoch', [await accrue(0)], [], 'already in use');
    await step('unsold-has-no-rights', [await openSpot(P.kingSpots + 2)], [], 'InvalidMiningTaxClaim');
    for (const id of spotIds.slice(0, 3)) await step(`open-spot-${id}`, [await openSpot(id)]);
    await step('duplicate-spot', [await openSpot(0)], [], 'already in use');
    await step('wrong-winner', [await claim(0, bob)], [bob], 'Unauthorized');
    await step('wrong-destination', [await claim(0, alice, { destination: destinationB })], [alice], 'Token');
    await step('wrong-mint', [await claim(0, alice, { keepMint: wrongMint })], [alice], 'Token');
    await identityAdversaries();
    await step('wrong-original-auction', [await claim(0, alice, { auction: auctionKeys.get(P.kingSpots)! })], [alice], 'ConstraintSeeds');
    await step('underfunded-full-liability', [await claim(0, alice)], [alice], 'Backing');
    await step('restore-one-fixture-token', [createTransferCheckedInstruction(reserve, keepMint, vault, payer.publicKey, 1n, TOKEN.decimals)]);
    await step('pause-claims', [await flags(1)]);
    await step('paused-tax-transfer', [await claim(0, alice)], [alice], 'Paused');
    await step('resume-claims', [await flags(0)]);
    await step('claim-then-fail-is-atomic', [await claim(0, alice), await claim(0, alice)], [alice], 'InvalidMiningTaxClaim');
    await step('king-claim', [await claim(0, alice)], [alice]);
    await step('regular-equal-claim', [await claim(P.kingSpots, bob)], [bob]);
    await step('same-wallet-second-spot', [await claim(P.kingSpots + 1, alice)], [alice]);
    let state = await program.account.miningTaxPool.fetch(pool);
    check(state.accrued.eq(bn(10)) && state.paid.eq(bn(9)), 'One dust unit must remain in original term');
    await step('duplicate-claim', [await claim(0, alice)], [alice], 'InvalidMiningTaxClaim');
    await step('later-epoch', [await accrue(1)]);
    for (const id of spotIds.slice(0, 3)) {
      const wallet = id === P.kingSpots ? bob : alice;
      await step(`later-delta-${id}`, [await claim(id, wallet)], [wallet]);
    }
    await step('dust-epoch', [await accrue(4)]);
    await step('dust-never-fabricates-entitlement', [await claim(0, alice)], [alice], 'InvalidMiningTaxClaim');
    state = await program.account.miningTaxPool.fetch(pool);
    const economy = await program.account.economyConfig.fetch(config);
    const balances = await connection.getMultipleAccountsInfo([vault, destinationA, destinationB], 'confirmed');
    const amounts = balances.map(a => { check(a, 'Missing KEEP account'); return AccountLayout.decode(a.data).amount; });
    check(state.accrued.eq(bn(13)) && state.paid.eq(bn(12)) && economy.taxPaid.eq(bn(12))
      && economy.totalClaimed.eq(bn(0)) && amounts[0] === 848n && amounts[1] === 8n && amounts[2] === 4n,
    'Final player+tax liability and per-winning-spot conservation failed');
    await writeFile(join(working, 'result.json'), JSON.stringify({ fixture: 'injected-history-local-only', genesis: await connection.getGenesisHash(),
      binarySha256: sha(binary), programDataSha256: sha(loadedData.data), steps, final: { accrued: '13', paid: '12', dust: '1', vault: '848', alice: '8', bob: '4' } }, null, 2));
    console.log(`Verified ${steps.length} tax lifecycle cases; report ${working}/result.json`);
  } finally {
    clearTimeout(deadline); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    kill('SIGINT'); const escalation = setTimeout(() => kill('SIGKILL'), 20_000);
    try { await closed; await drained; } finally { clearTimeout(escalation); }
    if (failure) throw failure;
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
