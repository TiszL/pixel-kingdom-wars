/** R1: atomic paid realm access on one fresh loopback validator.
 * No public RPC, retained ledger, Clock replacement, deployment, release keys or natural-wait claim.
 * Run after the current economy SBF/IDL build: scripts/node_modules/.bin/tsx programs/seeker-local-sales.ts
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
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, Transaction,
  type TransactionInstruction } from '@solana/web3.js';
import type { ShardkeepEconomy } from './target/types/shardkeep_economy';
import { PHASE_E_POLICY, PHASE_E_SEEKER_SALE as SALE, PHASE_E_SEEKER_AUCTION as AUCTION, PHASE_E_MINING_PUBLICATION as MINING, TOKEN } from '../packages/shared/src/constants';
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
  check(process.argv.length === 2, 'No RPC, key, ledger or other arguments are supported');
  const working = await mkdtemp('/tmp/seeker-sale-ci-');
  const accountDir = join(working, 'accounts'); await mkdir(accountDir, { mode: 0o700 });
  const payer = Keypair.generate(), alice = Keypair.generate(), bob = Keypair.generate(), carol = Keypair.generate(), dave = Keypair.generate(), poor = Keypair.generate();
  const idl = JSON.parse(await readFile(join(programs, 'target/idl/shardkeep_economy.json'), 'utf8'));
  check(idl.address === PROGRAM.toBase58(), 'Wrong program identity');
  const binary = await readFile(join(programs, 'target/deploy/shardkeep_economy.so'));
  const coder = new anchor.Program<ShardkeepEconomy>(idl, new anchor.AnchorProvider(new Connection('http://127.0.0.1:1'), new anchor.Wallet(payer), {})).coder.accounts;
  const [config] = pda('realm_sale_config'), [auctionConfig, auctionConfigBump] = pda('auction_config');
  const [registry, registryBump] = pda('seeker_registry'), [authority, authorityBump] = pda('seeker_authority');
  const mint = Keypair.generate().publicKey, P = PHASE_E_POLICY.seekerIsland;
  const day = BigInt(Math.floor(Date.now() / 1000 / MINING.daySec)), firstStart = (day - 10n) * BigInt(MINING.daySec);
  const currentStart = firstStart + BigInt(P.operatingTermSec), round = 1n;
  const entries = canonicalSeekerRegistry(), registryHash = hashSeekerRegistry(entries);
  const bitmap = Array.from({ length: Math.ceil(P.totalSpots / 8) }, (_, index) => {
    let byte = 0; for (let bit = 0; bit < 8; bit++) if (index * 8 + bit < P.totalSpots) byte |= 1 << bit; return byte;
  });
  const openingBid = BigInt(AUCTION.openingBidSkr) * 10n ** BigInt(TOKEN.decimals);
  const ac = { version: 1, authority, registry, registryHash: [...registryHash], registryVersion: 1,
    mint, tokenProgram: TOKEN_PROGRAM_ID, decimals: TOKEN.decimals, prizeOwner: payer.publicKey, prizeAta: ata(mint, payer.publicKey),
    prizeBps: AUCTION.prizeBps, openingBid: bn(openingBid), firstOperatingStart: bn(firstStart),
    termSec: bn(P.operatingTermSec), auctionSec: bn(P.overlappingAuctionSec), graceSec: bn(AUCTION.settlementGraceSec),
    auctionFormat: 1, termsFormat: 1, bump: auctionConfigBump };
  const accounts = new Map<string, { owner: PublicKey; data: Buffer; lamports: number }>();
  async function account(key: PublicKey, owner: PublicKey, data: Buffer, lamports = 10_000_000) {
    check(!accounts.has(key.toBase58()), 'Duplicate fixture key'); accounts.set(key.toBase58(), { owner, data, lamports });
    await writeFile(join(accountDir, key.toBase58() + '.json'), JSON.stringify({ pubkey: key.toBase58(), account: {
      lamports, data: [data.toString('base64'), 'base64'], owner: owner.toBase58(), executable: false, rentEpoch: 0,
    }}), { mode: 0o600, flag: 'wx' });
  }
  const encoded = async (key: PublicKey, name: string, model: object) => account(key, PROGRAM, await coder.encode(name, model));
  for (const wallet of [payer, alice, bob, carol, dave, poor]) await account(wallet.publicKey, SystemProgram.programId, Buffer.alloc(0), wallet === poor ? 5_000_000 : 10_000_000_000);
  await encoded(authority, 'seekerAuthority', { version: 1, admin: alice.publicKey, pendingAdmin: null,
    guardian: payer.publicKey, currentPolicyKey: Keypair.generate().publicKey, previousPolicyKey: null,
    previousValidUntil: bn(0), clusterGenesis: Array(32).fill(1), admissionPaused: true, bump: authorityBump });
  await encoded(auctionConfig, 'auctionConfig', ac);
  await encoded(registry, 'seekerRegistry', { version: 1, island: 1,
    entries: entries.map(e => ({ id: e.spotId, class: e.class, realmMask: e.realmMask })), hash: [...registryHash], bump: registryBump });
  const terms: PublicKey[] = [];
  for (const r of [0n, 1n]) {
    const [key, bump] = pda('seeker_term', auctionConfig.toBuffer(), le(r)), start = firstStart + r * BigInt(P.operatingTermSec); terms.push(key);
    await encoded(key, 'seekerTerm', { version: 1, config: auctionConfig, registry, registryHash: [...registryHash], round: bn(r),
      previous: r === 0n ? null : terms[0], auctionStart: bn(start - BigInt(P.overlappingAuctionSec)), auctionEnd: bn(start),
      operatingStart: bn(start), operatingEnd: bn(start + BigInt(P.operatingTermSec)), opened: bitmap, settled: bitmap,
      completedCount: P.totalSpots, winnerCount: 5, completedAt: bn(start), completedSlot: bn(1), bump });
  }
  const term = terms[1]!, expiredTerm = terms[0]!;
  const auctionKey = (spot: number, r = round) => pda('auction', auctionConfig.toBuffer(), Buffer.from([spot]), le(r))[0];
  // One developer is also an original winner, allowing every role-alias pattern.
  for (const [r, ids] of [[0n, [0]], [1n, [0, 1, 2, P.kingSpots, P.kingSpots + 1, P.kingSpots + 2]]] as const) {
    const start = firstStart + r * BigInt(P.operatingTermSec);
    for (const id of ids) {
      const [key, bump] = pda('auction', auctionConfig.toBuffer(), Buffer.from([id]), le(r));
      const entry = entries[id]!, seller = id === 1 ? bob.publicKey : alice.publicKey, unsold = id === P.kingSpots + 1;
      const vault = ata(mint, key), original = terms[Number(r)]!;
      const hash = hashSeekerAuctionTerms({ config: auctionConfig, term: original, auction: key, registry, registryHash,
        spotId: id, class: entry.class, realmMask: entry.realmMask, round: r, auctionStart: start - BigInt(P.overlappingAuctionSec),
        auctionEnd: start, operatingStart: start, operatingEnd: start + BigInt(P.operatingTermSec), mint,
        tokenProgram: TOKEN_PROGRAM_ID, vault, prizeOwner: ac.prizeOwner, prizeAta: ac.prizeAta, prizeBps: AUCTION.prizeBps,
        grace: BigInt(AUCTION.settlementGraceSec), openingBid, registryVersion: 1, auctionFormat: 1, termsFormat: 1 });
      await encoded(key, 'auction', { version: 1, config: auctionConfig, term: original, registry,
        spot: { id, class: entry.class, realmMask: entry.realmMask }, round: bn(r), auctionStart: bn(start - BigInt(P.overlappingAuctionSec)),
        auctionEnd: bn(start), operatingStart: bn(start), operatingEnd: bn(start + BigInt(P.operatingTermSec)),
        termsHash: [...hash], vault, highBid: bn(unsold ? 0n : openingBid), highBidder: unsold ? null : seller,
        outstandingEscrow: bn(0), settled: true, resultOwner: unsold ? null : seller, settledAt: bn(start), settledSlot: bn(1), bump });
    }
  }
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const a = server.address(); check(a && typeof a === 'object', 'No loopback port'); server.close(e => e ? reject(e) : resolve(a.port)); });
  });
  const out = createWriteStream(join(working, 'validator.log'));
  const child = spawn('solana-test-validator', ['--ledger', join(working, 'ledger'), '--rpc-port', String(port),
    '--bind-address', '127.0.0.1', '--dynamic-port-range', '19600-19625', '--faucet-port', '19630',
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
    check(clock && clock.data.readBigInt64LE(32) >= currentStart && clock.data.readBigInt64LE(32) < currentStart + BigInt(P.operatingTermSec)
      && clock.data.readBigInt64LE(32) / BigInt(MINING.daySec) === day, 'Fixture calendar/day must match actual Clock');
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: 'confirmed' });
    const program = new anchor.Program<ShardkeepEconomy>(idl, provider);
    const access = (wallet: PublicKey, realm: number) => pda('realm_access', wallet.toBuffer(), Buffer.from([realm]))[0];
    const quota = (spot: number, d = day) => pda('spot_sales', Buffer.from([spot]), le(d))[0];
    const receipt = (wallet: PublicKey, id: number[]) => pda('realm_sale', wallet.toBuffer(), Buffer.from(id))[0];
    const watched = new Map<string, PublicKey>();
    const watch = (...keys: PublicKey[]) => keys.forEach(key => watched.set(key.toBase58(), key));
    watch(config, authority, ...[alice,bob,carol,dave,poor].map(k => k.publicKey));
    const snapshot = async () => (await connection.getMultipleAccountsInfo([...watched.values()], 'confirmed')).map(a => a ? `${a.owner}:${a.data.toString('base64')}:${a.lamports}` : null);
    async function step(name: string, instructions: TransactionInstruction[], signers: Keypair[] = [], expected: string | null = null) {
      check(!failure, failure?.message ?? 'Fixture interrupted');
      const before = await snapshot(), latest = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: payer.publicKey, ...latest }).add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: steps.length + 1 }), ...instructions);
      tx.sign(payer, ...signers.filter(k => !k.publicKey.equals(payer.publicKey)));
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
      const until = Date.now() + 60_000; let status;
      while (true) {
        status = (await connection.getSignatureStatuses([signature])).value[0];
        if (status && ['confirmed','finalized'].includes(status.confirmationStatus ?? '')) break;
        check(!failure && Date.now() < until, `${name} confirmation deadline`); await sleep(150);
      }
      const detail = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      const logs = (detail?.meta?.logMessages ?? []).join('\n');
      check(expected ? status.err !== null && logs.includes(expected) : status.err === null, `${name}: ${JSON.stringify(status.err)}\n${logs}`);
      if (expected) check(JSON.stringify(before) === JSON.stringify(await snapshot()), `${name} changed state despite rollback`);
      steps.push({ name, signature, expected }); console.log(name + ':pass');
    }
    const init = (override = {}) => program.methods.initializeRealmSaleConfig().accountsPartial({ admin: alice.publicKey,
      upgradeAuthority: payer.publicKey, program: PROGRAM, programData, authority, config, developer: bob.publicKey,
      systemProgram: SystemProgram.programId, ...override }).instruction();
    const pause = (paused: boolean) => program.methods.setAdmissionPaused(paused).accountsPartial({ signer: alice.publicKey, authority }).instruction();
    const openAccess = (wallet: PublicKey, realm: number) => { watch(access(wallet,realm)); return program.methods.openRealmAccess(wallet,realm)
      .accountsPartial({ payer: payer.publicKey, config, access: access(wallet,realm), systemProgram: SystemProgram.programId }).instruction(); };
    const openQuota = (spot: number, d = day) => { watch(quota(spot,d)); return program.methods.openSpotSalesQuota(spot,bn(d))
      .accountsPartial({ payer: payer.publicKey, config, quota: quota(spot,d), systemProgram: SystemProgram.programId }).instruction(); };
    let nonce = 0;
    async function quote(buyer = carol, spot = 0, realm = 0) {
      const c = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed'); check(c, 'Missing Clock'); const now = c.data.readBigInt64LE(32);
      const prior = await program.account.realmAccess.fetch(access(buyer.publicKey,realm));
      const id = Buffer.alloc(16); id.writeUInt32LE(++nonce); watch(receipt(buyer.publicKey,[...id]));
      return { version: SALE.version, saleId: [...id], spot, realm, round: bn(round), day: bn(day),
        seller: spot === 1 ? bob.publicKey : alice.publicKey, developer: bob.publicKey, registryVersion: 1,
        priceLamports: bn(P.permitPriceLamports), durationSec: bn(P.permitDurationSec), sellerBps: P.contractSellerBps,
        developerBps: P.contractDevBps, priorExpiry: prior.expiresAt, validAfter: bn(now), validUntil: bn(now + BigInt(SALE.quoteTtlSec)) };
    }
    type Quote = Awaited<ReturnType<typeof quote>>;
    const buy = (a: Quote, buyer = carol, override = {}) => program.methods.buyRealmAccess(a).accountsPartial({ buyer: buyer.publicKey,
      authority, config, auctionConfig, registry, term, auction: auctionKey(a.spot), quota: quota(a.spot),
      access: access(buyer.publicKey,a.realm), receipt: receipt(buyer.publicKey,a.saleId), seller: a.seller, developer: bob.publicKey,
      systemProgram: SystemProgram.programId, ...override }).instruction();
    async function purchase(name: string, buyer = carol, spot = 0, realm = 0) {
      const a = await quote(buyer,spot,realm); const keys = [buyer.publicKey,a.seller,a.developer];
      const before = await Promise.all(keys.map(k => connection.getBalance(k,'confirmed')));
      await step(name,[await buy(a,buyer)],[buyer]);
      const key = receipt(buyer.publicKey,a.saleId), saved = await program.account.realmSaleReceipt.fetch(key);
      const grant = await program.account.realmAccess.fetch(access(buyer.publicKey,realm));
      const rent = (await connection.getAccountInfo(key,'confirmed'))!.lamports;
      const after = await Promise.all(keys.map(k => connection.getBalance(k,'confirmed')));
      const legs = [-P.permitPriceLamports-rent, saved.sellerLamports.toNumber(), saved.developerLamports.toNumber()];
      for (let i = 0; i < keys.length; i++) check(after[i] === before[i]! + legs.reduce((sum,v,j) => sum+(keys[i]!.equals(keys[j]!) ? v : 0),0), name+' exact SOL conservation');
      check(saved.priceLamports.eq(bn(P.permitPriceLamports)) && saved.sellerLamports.add(saved.developerLamports).eq(saved.priceLamports)
        && saved.priorExpiry.eq(a.priorExpiry) && saved.expiresAt.sub(saved.coverageStart).eq(bn(P.permitDurationSec))
        && grant.expiresAt.eq(saved.expiresAt) && saved.term.equals(term), name+' entitlement/receipt mismatch');
      check(saved.coverageStart.eq(anchor.BN.max(saved.acceptedAt,saved.priorExpiry)), name+' renewal anchor');
      return a;
    }
    await step('config-reject-wrong-admin',[await init({admin:carol.publicKey})],[carol],'ConstraintHasOne');
    await step('config-reject-wrong-upgrader',[await init({upgradeAuthority:carol.publicKey})],[alice,carol],'Unauthorized');
    await step('config-reject-wrong-ProgramData',[await init({programData:authority})],[alice],'AccountOwnedByWrongProgram');
    await step('config-dual-authority-initializes',[await init()],[alice]);
    await step('config-cannot-reinitialize',[await init()],[alice],'already in use');
    await step('reject-future-day-quota',[await openQuota(0,day+1n)],[],'InvalidRealmSaleTerms');
    for (const wallet of [alice,bob,carol,dave,poor]) await step('open-zero-access-'+wallet.publicKey.toBase58().slice(0,5),[await openAccess(wallet.publicKey,0)]);
    await step('open-second-realm',[await openAccess(carol.publicKey,1)]);
    await step('open-access-invalid-realm',[await openAccess(carol.publicKey,P.realmCount)],[],'InvalidRealmSaleTerms');
    for (const spot of [0,1,2,P.kingSpots,P.kingSpots+1,P.kingSpots+2]) await step('open-quota-'+spot,[await openQuota(spot)]);
    await step('quota-cannot-reinitialize',[await openQuota(0)],[],'already in use');
    await step('access-cannot-reinitialize',[await openAccess(carol.publicKey,0)],[],'already in use');
    check((await program.account.realmAccess.fetch(access(carol.publicKey,0))).expiresAt.eq(bn(0)), 'Opening alone granted access');
    await step('paused-sale-refuses',[await buy(await quote())],[carol],'Paused');
    await step('unpause-sales',[await pause(false)],[alice]);
    for (const [name, override, error] of [
      ['wrong-account-owner',{auction:carol.publicKey},'AccountOwnedByWrongProgram'],
      ['wrong-discriminator',{auction:term},'AccountDiscriminatorMismatch'],
      ['wrong-successor-or-old-term',{term:expiredTerm},'ConstraintSeeds'],
      ['wrong-access-wallet',{access:access(dave.publicKey,0)},'ConstraintSeeds'],
      ['wrong-quota-spot',{quota:quota(1)},'ConstraintSeeds'],
      ['wrong-system-program',{systemProgram:TOKEN_PROGRAM_ID},'InvalidProgramId'],
    ] as const) await step(name,[await buy(await quote(),carol,override)],[carol],error);
    const unsigned = await buy(await quote()); unsigned.keys.find(k => k.pubkey.equals(carol.publicKey))!.isSigner = false;
    await step('missing-buyer-signature',[unsigned],[],'AccountNotSigner');
    const badSeller = await quote(); badSeller.seller = dave.publicKey;
    await step('wrong-original-seller',[await buy(badSeller)],[carol],'InvalidRealmSeller');
    await step('unsold-spot',[await buy(await quote(carol,P.kingSpots+1))],[carol],'InvalidRealmSeller');
    const unsupported = entries[P.kingSpots]!.realmMask; const absent = Array.from({length:P.realmCount},(_,i)=>i).find(i => !(unsupported & (1<<i)))!;
    if (absent > 1) await step('open-uncovered-realm',[await openAccess(carol.publicKey,absent)]);
    await step('registry-uncovered-realm',[await buy(await quote(carol,P.kingSpots,absent))],[carol],'InvalidRealmSeller');
    const old = await quote(); old.round = bn(0);
    await step('expired-original-term-refuses',[await buy(old,carol,{term:expiredTerm,auction:auctionKey(0,0n)})],[carol],'Time');
    for (const [name, mutate] of [
      ['wrong-price',(a:Quote)=>a.priceLamports=a.priceLamports.addn(1)],
      ['wrong-duration',(a:Quote)=>a.durationSec=a.durationSec.addn(1)],
      ['wrong-developer',(a:Quote)=>a.developer=dave.publicKey],
      ['stale-prior-expiry',(a:Quote)=>a.priorExpiry=bn(1)],
      ['stale-day',(a:Quote)=>a.day=a.day.subn(1)],
      ['expired-quote',(a:Quote)=>{a.validAfter=bn(0);a.validUntil=bn(1);}],
    ] as const) { const a = await quote(); mutate(a); await step(name,[await buy(a,carol,name==='stale-day'?{quota:quota(0)}:{})],[carol], name==='stale-prior-expiry'?'RealmAccessChanged':name==='stale-day'?'ConstraintSeeds':name==='expired-quote'?'Time':'InvalidRealmSaleTerms'); }
    await step('insufficient-price-rolls-back-rent',[await buy(await quote(poor),poor)],[poor],'RealmSaleBalance');
    const rollback = await quote();
    await step('purchase-then-fail-rolls-back-both-transfers-and-access',[await buy(rollback),SystemProgram.transfer({fromPubkey:carol.publicKey,toPubkey:dave.publicKey,lamports:100_000_000_000})],[carol],'insufficient lamports');
    const first = await purchase('first-paid-access');
    await step('same-sale-ID-never-charges-or-grants-twice',[await buy(first)],[carol],'already in use');
    const duplicate = await quote(); duplicate.priorExpiry = first.priorExpiry;
    await step('distinct-ID-stale-coverage-never-grants-twice',[await buy(duplicate)],[carol],'RealmAccessChanged');
    await purchase('renew-future-access');
    await purchase('buyer-is-seller',alice);
    await purchase('buyer-is-developer',bob);
    await purchase('seller-is-developer',carol,1);
    await purchase('all-three-roles-equal',bob,1);
    for (let n = 0; n < P.paidContractsPerSpotDayMax; n++) await purchase('cross-realm-sale-'+(n+1),carol,2,n%2);
    await step('eleventh-shared-spot-sale-refuses',[await buy(await quote(carol,2))],[carol],'RealmSaleQuotaExhausted');
    const raceSpot = P.kingSpots+2, raceRealm = Array.from({length:P.realmCount},(_,i)=>i).find(i => entries[raceSpot]!.realmMask & (1<<i))!;
    for (const wallet of [carol,dave]) if (raceRealm !== 0 && (wallet!==carol || raceRealm!==1)) await step('race-realm-open-'+wallet.publicKey.toBase58().slice(0,5),[await openAccess(wallet.publicKey,raceRealm)]);
    for (let n = 0; n < P.paidContractsPerSpotDayMax - 1; n++) await purchase('race-fill-'+n,carol,raceSpot,raceRealm);
    // Both signed transactions see the same final quota slot. Runtime account locking
    // serializes them; one pays and gains access, the loser preserves all balances.
    const ra = await quote(carol,raceSpot,raceRealm), rb = await quote(dave,raceSpot,raceRealm);
    const racers = [carol,dave], quotes = [ra,rb];
    const raceBefore = await Promise.all(racers.map(w => connection.getBalance(w.publicKey,'confirmed')));
    const priorAccess = await Promise.all(racers.map(w => program.account.realmAccess.fetch(access(w.publicKey,raceRealm))));
    const latest = await connection.getLatestBlockhash('confirmed');
    const signed = await Promise.all(racers.map(async (wallet,index) => {
      const tx = new Transaction({feePayer:payer.publicKey,...latest}).add(
        ComputeBudgetProgram.setComputeUnitPrice({microLamports:steps.length+index+1}),await buy(quotes[index]!,wallet));
      tx.sign(payer,wallet); return tx.serialize();
    }));
    const signatures = await Promise.all(signed.map(bytes => connection.sendRawTransaction(bytes,{skipPreflight:true,maxRetries:0})));
    const until = Date.now()+60_000; let statuses;
    while (true) {
      statuses = (await connection.getSignatureStatuses(signatures)).value;
      if (statuses.every(s => s && ['confirmed','finalized'].includes(s.confirmationStatus ?? ''))) break;
      check(!failure && Date.now()<until,'Race confirmation deadline'); await sleep(150);
    }
    check(statuses.filter(s => s?.err === null).length === 1,'Exactly one final-slot race must win');
    for (const [index,wallet] of racers.entries()) {
      const won = statuses[index]!.err === null, key = receipt(wallet.publicKey,quotes[index]!.saleId);
      const saved = await connection.getAccountInfo(key,'confirmed');
      const detail = await connection.getTransaction(signatures[index]!,{commitment:'confirmed',maxSupportedTransactionVersion:0});
      const logs = (detail?.meta?.logMessages??[]).join('\n');
      const grant = await program.account.realmAccess.fetch(access(wallet.publicKey,raceRealm));
      check(won ? saved !== null && grant.expiresAt.gt(priorAccess[index]!.expiresAt)
        : saved === null && grant.expiresAt.eq(priorAccess[index]!.expiresAt) && logs.includes('RealmSaleQuotaExhausted'),'Race access/receipt mismatch');
      check(await connection.getBalance(wallet.publicKey,'confirmed') === raceBefore[index]!-(won ? P.permitPriceLamports+saved!.lamports : 0),'Race loser paid or winner paid incorrectly');
      steps.push({name:won?'concurrent-final-slot-winner':'concurrent-final-slot-loser',signature:signatures[index]!,expected:won?null:'RealmSaleQuotaExhausted'});
      console.log(steps.at(-1)!.name+':pass');
    }
    const preserved = await program.account.realmAccess.fetch(access(carol.publicKey,0));
    check(preserved.expiresAt.gt(bn(currentStart+BigInt(P.operatingTermSec))), 'Paid access must survive original term turnover');
    await step('pause-new-sales',[await pause(true)],[alice]);
    await step('pause-renewal-preserves-existing-access',[await buy(await quote())],[carol],'Paused');
    check((await program.account.realmAccess.fetch(access(carol.publicKey,0))).expiresAt.eq(preserved.expiresAt), 'Pause erased access');
    await writeFile(join(working,'result.json'),JSON.stringify({ fixture:'atomic-realm-sale-local-only', genesis:await connection.getGenesisHash(),
      binarySha256:sha(binary), programDataSha256:sha(loadedData.data), steps, final:{sharedQuota:(await program.account.spotSalesQuota.fetch(quota(2))).sales,
      raceQuota:(await program.account.spotSalesQuota.fetch(quota(raceSpot))).sales, permanentAccessExpiry:preserved.expiresAt.toString()}},null,2));
    console.log(`Verified ${steps.length} atomic realm sale transaction cases; report ${working}/result.json`);
  } finally {
    clearTimeout(deadline); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    kill('SIGINT'); const escalation = setTimeout(() => kill('SIGKILL'), 20_000);
    try { await closed; await drained; } finally { clearTimeout(escalation); }
    if (failure) throw failure;
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
