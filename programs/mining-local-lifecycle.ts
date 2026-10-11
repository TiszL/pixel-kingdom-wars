/** Disposable loopback validator only. The parent owns startup, Clock advancement and shutdown.
 * prepare|claims --rpc http://127.0.0.1:PORT --checkpoint /tmp/mining-local-UNIQUE.json
 * --payer /absolute/private-fixture-payer.json --genesis ACTUAL_HASH --program-data-sha256 FULL_HASH
 * claims may add --fixture-parent-genesis ORIGINAL_HASH for a parent-created copied genesis.
 * That fixture permits ONLY the recorded root publishedAt timestamps to move back by the audit delay.
 * Private checkpoint retains generated keys and original signed attempts; never publish it.
 */
// Same identity miningProgramProtocol.ts exports (this IDL's address). That module default-imports
// @coral-xyz/anchor, which tsx cannot initialize from this CommonJS package (CI run 37503885236).
import economyIdl from '../packages/chain/src/idl/shardkeep_economy.json' with { type: 'json' };
import { createHash, randomBytes } from 'node:crypto';
import { constants as fs } from 'node:fs';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import * as anchor from '@coral-xyz/anchor';
import type { ShardkeepEconomy } from './target/types/shardkeep_economy';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, MINT_SIZE, AuthorityType,
  createInitializeMint2Instruction, createMintToInstruction, createSetAuthorityInstruction,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import { AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  SYSVAR_CLOCK_PUBKEY, Transaction, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import { PHASE_E_MINING_PUBLICATION as POLICY, PHASE_E_POLICY, TOKEN } from '../packages/shared/src/constants';
import { buildMiningAllocationTree, type MiningAllocationLeaf } from '../packages/chain/src/miningAllocationProof';

const MINING_PROGRAM_ADDRESS = economyIdl.address;
const PROGRAM = new PublicKey(MINING_PROGRAM_ADDRESS);
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const ROOT = resolve(dirname(process.argv[1]!), '..');
const bn = (n: bigint | number | string) => new anchor.BN(n.toString());
const integer = (n: anchor.BN) => BigInt(n.toString());
const eq = (a: PublicKey, b: PublicKey) => a.equals(b);
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function signatureText(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`), result = '';
  while (n) { result = alphabet[Number(n % 58n)] + result; n /= 58n; }
  for (const byte of bytes) { if (byte) break; result = '1' + result; }
  return result;
}
type Phase = 'prepare' | 'claims';
type Step = { raw: string; signature: string; blockhash: string; lastValidBlockHeight: number; expected: string | null; slot?: number };
type State = { version: 1; rpc: string; genesis: string; hash: string; payer: string; day: string;
  keys: Record<'guardian' | 'publisher' | 'alice' | 'bob' | 'carol' | 'mint' | 'wrongMint', number[]>;
  steps: Record<string, Step>; completed: Phase[]; claimAfter?: string; lookupTable?: string; packets?: unknown[];
  snapshotAccounts?: Array<{ address: string; owner: string; data: string }>;
  allocationPublishedAt?: Record<string, string>; fixtureGenesis?: string; fixtureClaimAfter?: string };
function args() {
  const values: Record<string, string> = { phase: process.argv[2] ?? '' };
  for (let i = 3; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    check(key?.startsWith('--') && value && !value.startsWith('--') && !(key in values), 'Malformed/duplicate argument'); values[key] = value;
  }
  const required = ['phase', '--rpc', '--checkpoint', '--payer', '--genesis', '--program-data-sha256'];
  const fixture = values['--fixture-parent-genesis'];
  check(Object.keys(values).length === required.length + (fixture ? 1 : 0) && required.every(k => values[k]), 'Require exactly the documented arguments');
  check(['prepare', 'claims'].includes(values.phase!), 'Unknown phase');
  const match = /^http:\/\/(127\.0\.0\.1|localhost):([1-9][0-9]{0,4})\/?$/.exec(values['--rpc']!);
  check(match && Number(match[2]) <= 65535, 'Explicit HTTP loopback port required');
  values['--rpc'] = `http://127.0.0.1:${match[2]}`;
  check(/^\/tmp\/mining-local-[A-Za-z0-9-]+\.json$/.test(values['--checkpoint']!), 'Private /tmp/mining-local checkpoint required');
  check(isAbsolute(values['--payer']!), 'Absolute fixture payer path required');
  check(/^[0-9a-f]{64}$/.test(values['--program-data-sha256']!), 'ProgramData hash required');
  check(new PublicKey(values['--genesis']!).toBase58() === values['--genesis'], 'Canonical genesis required');
  if (fixture) check(values.phase === 'claims' && new PublicKey(fixture).toBase58() === fixture && fixture !== values['--genesis'], 'Copied-genesis fixture is claims-only and must name its distinct parent');
  return values;
}
async function privateRead(path: string) {
  const f = await open(path, fs.O_RDONLY | fs.O_NOFOLLOW);
  try { const s = await f.stat(); check(s.isFile() && s.uid === process.getuid?.() && (s.mode & 0o777) === 0o600, 'Private owned0600 regular file required'); return await f.readFile('utf8'); }
  finally { await f.close(); }
}
async function main() {
  const a = args(), phase = a.phase as Phase, path = a['--checkpoint']!, rpc = a['--rpc']!;
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await privateRead(a['--payer']!))));
  const connection = new Connection(rpc, { commitment: 'finalized', disableRetryOnRateLimit: true,
    confirmTransactionInitialTimeout: 60_000, fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }) });
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: 'finalized', preflightCommitment: 'finalized' });
  const idl = JSON.parse(await readFile(resolve(ROOT, 'programs/target/idl/shardkeep_economy.json'), 'utf8'));
  check(idl.address === PROGRAM.toBase58(), 'Wrong generated program ID');
  const program = new anchor.Program<ShardkeepEconomy>(idl, provider);
  const pda = (seed: string, value?: bigint | PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(seed),
    ...(value === undefined ? [] : [value instanceof PublicKey ? value.toBuffer() : bn(value).toArrayLike(Buffer, 'le', 8)])], PROGRAM)[0];
  const authority = pda('seeker_authority'), config = pda('economy');
  const [programData] = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], LOADER);
  async function identity() {
    check(await connection.getGenesisHash() === a['--genesis'], 'Wrong validator genesis');
    const [p, d] = await connection.getMultipleAccountsInfo([PROGRAM, programData], 'finalized');
    check(p?.executable && eq(p.owner, LOADER) && p.data.length === 36 && p.data.readUInt32LE(0) === 2
      && eq(new PublicKey(p.data.subarray(4)), programData), 'Wrong upgradeable program');
    check(d && eq(d.owner, LOADER) && d.data.readUInt32LE(0) === 3 && d.data[12] === 1
      && eq(new PublicKey(d.data.subarray(13, 45)), payer.publicKey) && digest(d.data) === a['--program-data-sha256'], 'Wrong reviewed binary/upgrade authority');
  }
  async function clock() { const row = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'finalized'); check(row?.data.length === 40, 'Missing actual Clock'); return row.data.readBigInt64LE(32); }
  await identity();
  const lock = await open(path + '.lock', 'wx', 0o600);
  try {
    let state: State;
    try { state = JSON.parse(await privateRead(path)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      check(phase === 'prepare', 'Claims require original checkpoint');
      check((await connection.getMultipleAccountsInfo([authority, config])).every(v => v === null), 'Fresh mining ledger required');
      const secret = () => Array.from(Keypair.generate().secretKey);
      state = { version: 1, rpc, genesis: a['--genesis']!, hash: a['--program-data-sha256']!, payer: payer.publicKey.toBase58(),
        day: ((await clock()) / BigInt(POLICY.daySec)).toString(), keys: { guardian: secret(), publisher: secret(), alice: secret(), bob: secret(), carol: secret(), mint: secret(), wrongMint: secret() }, steps: {}, completed: [] };
      const created = await open(path, 'wx', 0o600); try { await created.writeFile(JSON.stringify(state)); await created.sync(); } finally { await created.close(); }
    }
    const fixtureParent = a['--fixture-parent-genesis'];
    check(state.version === 1 && (fixtureParent || state.rpc === rpc) && state.genesis === (fixtureParent ?? a['--genesis']) && state.hash === a['--program-data-sha256']
      && state.payer === payer.publicKey.toBase58() && /^[1-9][0-9]*$/.test(state.day), 'Checkpoint identity mismatch');
    const key = (name: keyof State['keys']) => Keypair.fromSecretKey(Uint8Array.from(state.keys[name]));
    const guardian = key('guardian'), publisher = key('publisher'), alice = key('alice'), bob = key('bob'), carol = key('carol'), mint = key('mint'), wrongMint = key('wrongMint');
    const day = BigInt(state.day), first = day - 4n, last = day - 2n;
    check(first > 0n, 'Fixture needs positive past days');
    const ata = (owner: PublicKey, tokenMint = mint.publicKey) => getAssociatedTokenAddressSync(tokenMint, owner, true);
    const reserve = ata(payer.publicKey), vault = ata(config), root = (seq: bigint) => pda('alloc', seq), epoch = (d: bigint) => pda('mining_epoch', d);
    const miner = (wallet: PublicKey) => pda('miner', wallet), renown = (wallet: PublicKey) => pda('renown', wallet);
    const watched = [authority, config, mint.publicKey, reserve, vault, ...[1n, 2n, 3n, 4n].map(root),
      ...[first, first + 1n, last].map(epoch), ...[alice, bob, carol].flatMap(k => [miner(k.publicKey), renown(k.publicKey), ata(k.publicKey)])];
    async function save() {
      const tmp = path + '.' + randomBytes(8).toString('hex'), f = await open(tmp, 'wx', 0o600);
      try { await f.writeFile(JSON.stringify(state)); await f.sync(); } finally { await f.close(); }
      await rename(tmp, path); const d = await open(dirname(path), fs.O_RDONLY); try { await d.sync(); } finally { await d.close(); }
    }
    async function snapshot() { return JSON.stringify((await connection.getMultipleAccountsInfo(watched, 'finalized')).map(v => v ? [v.owner.toBase58(), digest(v.data)] : null)); }
    async function step(label: string, build: () => Promise<TransactionInstruction[]>, signers: Keypair[] = [], expected: string | null = null, feePayer = payer) {
      await identity();
      let attempt = state.steps[label];
      const before = expected ? await snapshot() : null;
      if (!attempt) {
        const tx = new Transaction().add(...await build()), latest = await connection.getLatestBlockhash('finalized');
        tx.feePayer = feePayer.publicKey; tx.recentBlockhash = latest.blockhash;
        const unique = [...new Map([feePayer, ...signers].map(k => [k.publicKey.toBase58(), k])).values()]; tx.sign(...unique);
        check(tx.signature, 'Unsigned fixture attempt');
        attempt = { raw: tx.serialize().toString('base64'), signature: signatureText(tx.signature), ...latest, expected };
        state.steps[label] = attempt; await save();
      }
      check(attempt.expected === expected, 'Changed attempt outcome');
      const raw = Buffer.from(attempt.raw, 'base64'), tx = Transaction.from(raw);
      check(tx.verifySignatures() && tx.signature && signatureText(tx.signature) === attempt.signature
        && tx.recentBlockhash === attempt.blockhash && tx.feePayer?.equals(feePayer.publicKey), 'Corrupt original attempt');
      let status = (await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0];
      if (!status) {
        check(!attempt.slot && await connection.getBlockHeight('finalized') <= attempt.lastValidBlockHeight, 'Expired or missing original attempt; refuse replacement');
        check(await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }) === attempt.signature, 'Signature changed');
      }
      if (status?.confirmationStatus !== 'finalized') await connection.confirmTransaction({ signature: attempt.signature, blockhash: attempt.blockhash, lastValidBlockHeight: attempt.lastValidBlockHeight }, 'finalized');
      status = (await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0];
      check(status?.confirmationStatus === 'finalized', `Missing finalized ${label}`);
      check(expected ? !!status.err : !status.err, `Unexpected ${label} outcome: ${JSON.stringify(status.err)}`);
      if (expected) {
        const body = await connection.getTransaction(attempt.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
        const matched = body?.meta?.logMessages?.some(log => expected === 'already in use'
          ? /^(?:Program log: )?Allocate: account Address \{ address: [1-9A-HJ-NP-Za-km-z]{32,44}, base: None \} already in use$/.test(log)
          : log.includes(`Error Code: ${expected}.`));
        check(matched, `${label}: missing exact expected ${expected}`);
        check(await snapshot() === before, `${label}: failed transaction changed program/token state`);
      }
      attempt.slot = status.slot; await save();
    }
    const ix = async (builder: { instruction(): Promise<TransactionInstruction> }) => [await builder.instruction()];
    const getConfig = () => program.account.economyConfig.fetch(config);
    const balance = async (account: PublicKey) => (await getAccount(connection, account, 'finalized')).amount;
    const token = { mint: mint.publicKey, miningVault: vault, reserveAta: reserve, tokenProgram: TOKEN_PROGRAM_ID };
    const init = { admin: payer.publicKey, upgradeAuthority: payer.publicKey, program: PROGRAM, programData, authority, config,
      mint: mint.publicKey, reserveOwner: payer.publicKey, reserveAta: reserve, miningVault: vault,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId };
    const flags = (n: number, signer = payer) => program.methods.setMiningFlags(n).accountsPartial({ signer: signer.publicKey, authority, config });
    const allocations = (seq: bigint) => {
      const amounts = seq === 1n ? [60n, 20n] : seq === 2n ? [120n, 40n] : seq === 3n ? [100n, 60n] : [140n, 100n];
      const days = seq === 1n ? 1n : seq === 4n ? 3n : 2n;
      return buildMiningAllocationTree([alice, bob, carol].map((k, i): MiningAllocationLeaf => ({ wallet: k.publicKey.toBase58(),
        cumulativeKeep: amounts[i] ?? 0n, cumulativeRenown: days, cumulativeDays: days, sequence: seq })));
    };
    const publication = (seq: bigint, d: bigint) => { const tree = allocations(seq); return { sequence: bn(seq), day: bn(d), kind: 0,
      root: Array.from(tree.root), totalCumulative: bn(tree.total), leafCount: tree.leafCount, budgetGross: bn(100), freeGross: bn(5), deedGross: bn(95),
      sourceHash: Array.from(Buffer.alloc(32, Number(seq))), taxCommitment: Array.from(Buffer.alloc(32, 7)), taxVersion: 1 }; };
    const pubAccounts = (seq: bigint, d: bigint, signer = publisher) => ({ signer: signer.publicKey, authority, config, root: root(seq), epoch: epoch(d), ...token, systemProgram: SystemProgram.programId });
    const claim = (who: Keypair, seq: bigint, overrides: Record<string, unknown> = {}, changes: Partial<MiningAllocationLeaf> = {}) => {
      const tree = allocations(seq), index = tree.leaves.findIndex(v => v.wallet === who.publicKey.toBase58()), leaf = { ...tree.leaves[index]!, ...changes };
      return program.methods.claimMining(bn(leaf.sequence), bn(leaf.cumulativeKeep), bn(leaf.cumulativeRenown), bn(leaf.cumulativeDays),
        tree.proof(index).map(p => ({ hash: Array.from(p.hash), sum: bn(p.sum), isLeft: p.isLeft }))).accountsPartial({ claimant: who.publicKey, config,
        root: root(seq), miner: miner(who.publicKey), renown: renown(who.publicKey), vault, destination: ata(who.publicKey), keepMint: mint.publicKey, tokenProgram: TOKEN_PROGRAM_ID, ...overrides });
    };
    const sync = (who: Keypair, seq: bigint) => { const tree = allocations(seq), i = tree.leaves.findIndex(v => v.wallet === who.publicKey.toBase58()), leaf = tree.leaves[i]!;
      return program.methods.syncRenown(who.publicKey, bn(seq), bn(leaf.cumulativeKeep), bn(leaf.cumulativeRenown), bn(leaf.cumulativeDays), tree.proof(i).map(p => ({ hash: Array.from(p.hash), sum: bn(p.sum), isLeft: p.isLeft })))
        .accountsPartial({ payer: payer.publicKey, config, root: root(seq), miner: miner(who.publicKey), renown: renown(who.publicKey) }); };
    const revoke = (seq: bigint) => program.methods.revokeAllocationRoot().accountsPartial({ admin: payer.publicKey, authority, config, root: root(seq) });
    const withdraw = (amount: bigint, overrides = {}) => program.methods.withdrawMiningSurplus(bn(amount)).accountsPartial({ admin: payer.publicKey, authority, config, ...token, ...overrides });
    const transfer = (amount: bigint) => Promise.resolve([createTransferCheckedInstruction(reserve, mint.publicKey, vault, payer.publicKey, amount, TOKEN.decimals)]);
    if (fixtureParent) {
      check(state.completed.includes('prepare') && state.snapshotAccounts?.length === watched.length && state.allocationPublishedAt
        && (!state.fixtureGenesis || state.fixtureGenesis === a['--genesis']), 'Missing/mismatched original copied-genesis evidence');
      if (!state.fixtureGenesis) {
        check(!Object.keys(state.steps).some(label => label === 'permanent-record-duplicate'), 'Cannot reinterpret an existing claims run under a new genesis');
        const originals = new Map(state.snapshotAccounts.map(row => [row.address, row]));
        check(originals.size === watched.length, 'Duplicate original snapshot account');
        const actual = await connection.getMultipleAccountsInfo(watched, 'finalized');
        let ready = 0n;
        for (let i = 0; i < watched.length; i++) {
          const address = watched[i]!.toBase58(), original = originals.get(address), current = actual[i];
          check(original && current && current.owner.toBase58() === original.owner, `Copied account identity differs: ${address}`);
          let expected: Buffer = Buffer.from(original.data, 'base64');
          if (address in state.allocationPublishedAt) {
            const decoded = program.coder.accounts.decode('allocationRoot', expected);
            check(integer(decoded.publishedAt).toString() === state.allocationPublishedAt[address], 'Original root clock differs from checkpoint');
            check((await program.coder.accounts.encode('allocationRoot', decoded)).equals(expected), 'Original root has unexplained serialized bytes');
            const shifted = integer(decoded.publishedAt) - BigInt(POLICY.claimDelaySec);
            check(shifted >= 0n, 'Fixture root clock underflow');
            expected = await program.coder.accounts.encode('allocationRoot', { ...decoded, publishedAt: bn(shifted) });
            ready = shifted + BigInt(POLICY.claimDelaySec) > ready ? shifted + BigInt(POLICY.claimDelaySec) : ready;
          }
          check(current.data.equals(expected), `Copied account changed beyond explicit audit-delay fixture: ${address}`);
        }
        check(Object.keys(state.allocationPublishedAt).length === 4, 'Require all original allocation roots');
        state.fixtureGenesis = a['--genesis']; state.fixtureClaimAfter = ready.toString(); await save();
      }
    } else check(!state.fixtureGenesis, 'Copied-genesis checkpoint cannot return to original evidence mode');
    if (state.completed.includes(phase)) { check(Object.values(state.steps).every(s => s.slot !== undefined), 'Incomplete accepted phase'); console.log(JSON.stringify({ phase, replay: true, checkpoint: path, claimAfter: state.claimAfter })); return; }
    if (phase === 'prepare') {
      await step('fund-generated-wallets', async () => [guardian, publisher, alice, bob, carol].map(k => SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k.publicKey, lamports: 1_000_000_000 })));
      const auth = { admin: payer.publicKey, program: PROGRAM, programData, authority, systemProgram: SystemProgram.programId };
      await step('wrong-seeker-initializer', () => ix(program.methods.initializeSeekerAuthority(guardian.publicKey, publisher.publicKey, Array.from(new PublicKey(state.genesis).toBytes())).accountsPartial({ ...auth, admin: alice.publicKey })), [alice], 'Unauthorized');
      await step('initialize-seeker', () => ix(program.methods.initializeSeekerAuthority(guardian.publicKey, publisher.publicKey, Array.from(new PublicKey(state.genesis).toBytes())).accountsPartial(auth)));
      const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
      await step('create-fixture-token-inventory', async () => [mint, wrongMint].flatMap(k => [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: k.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
        createInitializeMint2Instruction(k.publicKey, TOKEN.decimals, payer.publicKey, payer.publicKey)])
        .concat([reserve, vault, ata(alice.publicKey), ata(bob.publicKey), ata(carol.publicKey)].map((address, i) => createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, address, [payer.publicKey, config, alice.publicKey, bob.publicKey, carol.publicKey][i]!, mint.publicKey)))
        .concat([createMintToInstruction(mint.publicKey, reserve, payer.publicKey, 1_000_000n)]), [mint, wrongMint]);
      await step('mutable-mint-refused', () => ix(program.methods.initializeEconomy(publisher.publicKey, bn(first)).accountsPartial(init)), [], 'Token');
      await step('freeze-fixture-mint-authorities', async () => [createSetAuthorityInstruction(mint.publicKey, payer.publicKey, AuthorityType.MintTokens, null), createSetAuthorityInstruction(mint.publicKey, payer.publicKey, AuthorityType.FreezeAccount, null)]);
      await step('wrong-upgrade-authority', () => ix(program.methods.initializeEconomy(publisher.publicKey, bn(first)).accountsPartial({ ...init, upgradeAuthority: alice.publicKey })), [alice], 'Unauthorized');
      const core = new PublicKey('mYYQFnpyGofG31y5oJkiKVmNwifbSXBMnQ5aUgQkL6b');
      const foreignData = PublicKey.findProgramAddressSync([core.toBuffer()], LOADER)[0];
      await step('foreign-programdata', () => ix(program.methods.initializeEconomy(publisher.publicKey, bn(first)).accountsPartial({ ...init, programData: foreignData })), [], 'Unauthorized');
      await step('substituted-init-vault', () => ix(program.methods.initializeEconomy(publisher.publicKey, bn(first)).accountsPartial({ ...init, miningVault: reserve })), [], 'Token');
      await step('prefund-canonical-vault', () => transfer(7n));
      await step('initialize-economy', () => ix(program.methods.initializeEconomy(publisher.publicKey, bn(first)).accountsPartial(init)));
      check((await getConfig()).flags === 35, 'Economy must start fully paused');
      await step('guardian-cannot-resume', () => ix(flags(0, guardian)), [guardian], 'Unauthorized');
      await step('paused-publish', () => ix(program.methods.publishAllocationRoot(publication(1n, first)).accountsPartial(pubAccounts(1n, first))), [publisher], 'Paused');
      await step('resume', () => ix(flags(0)));
      await step('fund-underflow-boundary', () => transfer(92n));
      await step('underfunded-by-one', () => ix(program.methods.publishAllocationRoot(publication(1n, first)).accountsPartial(pubAccounts(1n, first))), [publisher], 'Backing');
      await step('fund-first-budget', () => transfer(1n));
      await step('cohort-cap', () => ix(program.methods.publishAllocationRoot({ ...publication(1n, first), freeGross: bn(6), deedGross: bn(94) }).accountsPartial(pubAccounts(1n, first))), [publisher], 'Configuration');
      await step('gross-ceiling', () => ix(program.methods.publishAllocationRoot({ ...publication(1n, first), budgetGross: bn(BigInt(PHASE_E_POLICY.mining.grossDailyCeilingKeep) * 10n ** BigInt(TOKEN.decimals) + 1n) }).accountsPartial(pubAccounts(1n, first))), [publisher], 'Configuration');
      await step('open-day', () => ix(program.methods.publishAllocationRoot({ ...publication(1n, day), kind: 2 }).accountsPartial(pubAccounts(1n, day, payer))), [], 'Time');
      await step('wrong-publisher', () => ix(program.methods.publishAllocationRoot(publication(1n, first)).accountsPartial(pubAccounts(1n, first, alice))), [alice], 'Unauthorized');
      await step('publish-one', () => ix(program.methods.publishAllocationRoot(publication(1n, first)).accountsPartial(pubAccounts(1n, first))), [publisher]);
      await step('duplicate-day', () => ix(program.methods.publishAllocationRoot(publication(2n, first)).accountsPartial(pubAccounts(2n, first))), [publisher], 'already in use');
      for (const who of [alice, bob, carol]) await step(`open-${who.publicKey}`, () => ix(program.methods.openMinerRecords(who.publicKey).accountsPartial({ payer: who.publicKey, miner: miner(who.publicKey), renown: renown(who.publicKey), systemProgram: SystemProgram.programId })), [], null, who);
      await step('early-claim', () => ix(claim(alice, 1n)), [], 'Time', alice);
      await step('early-permissionless-sync', () => ix(sync(carol, 1n)), [], 'Time');
      await step('fund-second-budget', () => transfer(100n));
      await step('publish-two', () => ix(program.methods.publishAllocationRoot(publication(2n, first + 1n)).accountsPartial(pubAccounts(2n, first + 1n))), [publisher]);
      const beforeCorrection = await getConfig(), reserveBefore = await balance(reserve), vaultBefore = await balance(vault);
      await step('revoke-two', () => ix(revoke(2n)));
      await step('revoked-claim', () => ix(claim(alice, 2n)), [], 'InvalidMiningClaim', alice);
      const tree3 = allocations(3n), correction = { sequence: bn(3), root: Array.from(tree3.root), totalCumulative: bn(tree3.total), leafCount: tree3.leafCount, kind: 0 };
      const correctAccounts = { signer: publisher.publicKey, authority, config, revokedRoot: root(2n), epoch: epoch(first + 1n), root: root(3n), miningVault: vault, systemProgram: SystemProgram.programId };
      await step('correction-cannot-reprice', () => ix(program.methods.correctAllocationRoot({ ...correction, totalCumulative: bn(161) }).accountsPartial(correctAccounts)), [publisher], 'Backing');
      await step('correct-three', () => ix(program.methods.correctAllocationRoot(correction).accountsPartial(correctAccounts)), [publisher]);
      const corrected = await getConfig();
      for (const field of ['totalPublishedHighwater', 'taxHighwater', 'recycledTotal', 'grossPublished', 'splitCursor'] as const) check(String(corrected[field]) === String(beforeCorrection[field]), `Correction changed ${field}`);
      check(await balance(reserve) === reserveBefore && await balance(vault) === vaultBefore, 'Correction recycled twice');
      await step('corrected-delay', () => ix(claim(alice, 3n)), [], 'Time', alice);
      await step('corrected-permissionless-sync-delay', () => ix(sync(carol, 3n)), [], 'Time');
      await step('fund-third-budget', () => transfer(100n));
      await step('publish-four', () => ix(program.methods.publishAllocationRoot(publication(4n, last)).accountsPartial(pubAccounts(4n, last))), [publisher]);
      await step('surplus-donation', () => transfer(7n));
      await step('surplus-floor', () => ix(withdraw(8n)), [], 'Backing');
      await step('surplus-destination', () => ix(withdraw(1n, { reserveAta: ata(alice.publicKey) })), [], 'ConstraintAddress');
      await step('surplus-only', () => ix(withdraw(7n)));
      check(await balance(vault) === 270n, 'Expected240 player +30 tax backing');
      const c = await getConfig(); check(integer(c.totalPublishedHighwater) === 240n && integer(c.taxHighwater) === 30n && integer(c.recycledTotal) === 30n && integer(c.grossPublished) === 300n, 'Publication accounting mismatch');
      const published = await Promise.all([1n, 3n, 4n].map(s => program.account.allocationRoot.fetch(root(s))));
      state.claimAfter = (published.reduce((n, r) => integer(r.publishedAt) > n ? integer(r.publishedAt) : n, 0n) + BigInt(POLICY.claimDelaySec)).toString();
      const slot = await connection.getSlot('finalized');
      const [createTable, address] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
      state.lookupTable = address.toBase58(); await save();
      await step('create-lookup-table', async () => [createTable]);
      await step('extend-lookup-table', async () => [AddressLookupTableProgram.extendLookupTable({ lookupTable: address, authority: payer.publicKey, payer: payer.publicKey, addresses: [config, vault, mint.publicKey] })]);
      await step('freeze-lookup-table', async () => [AddressLookupTableProgram.freezeLookupTable({ lookupTable: address, authority: payer.publicKey })]);
      const originals = await connection.getMultipleAccountsInfo(watched, 'finalized');
      state.snapshotAccounts = watched.map((address, i) => { const row = originals[i]; check(row, 'Missing completed source account'); return { address: address.toBase58(), owner: row.owner.toBase58(), data: row.data.toString('base64') }; });
      state.allocationPublishedAt = {};
      for (const seq of [1n, 2n, 3n, 4n]) state.allocationPublishedAt[root(seq).toBase58()] = integer((await program.account.allocationRoot.fetch(root(seq))).publishedAt).toString();
    } else {
      const claimAfter = fixtureParent ? state.fixtureClaimAfter : state.claimAfter;
      check(state.completed.includes('prepare') && claimAfter && await clock() >= BigInt(claimAfter), 'Actual Clock has not reached the recorded claim delay');
      await step('permanent-record-duplicate', () => ix(program.methods.openMinerRecords(alice.publicKey).accountsPartial({ payer: alice.publicKey, miner: miner(alice.publicKey), renown: renown(alice.publicKey), systemProgram: SystemProgram.programId })), [], 'already in use', alice);
      await step('forged-keep', () => ix(claim(alice, 1n, {}, { cumulativeKeep: 61n })), [], 'InvalidMiningProof', alice);
      await step('forged-renown', () => ix(claim(alice, 1n, {}, { cumulativeRenown: 2n })), [], 'InvalidMiningRenown', alice);
      await step('wrong-wallet-record', () => ix(claim(alice, 1n, { miner: miner(bob.publicKey) })), [], 'ConstraintSeeds', alice);
      await step('wrong-recipient', () => ix(claim(alice, 1n, { destination: ata(bob.publicKey) })), [], 'Token', alice);
      await step('wrong-claim-mint', () => ix(claim(alice, 1n, { keepMint: wrongMint.publicKey })), [], 'Token', alice);
      await step('wrong-claim-vault', () => ix(claim(alice, 1n, { vault: reserve })), [], 'Token', alice);
      await step('pause-claims', () => ix(flags(1)));
      await step('paused-claim', () => ix(claim(alice, 1n)), [], 'Paused', alice);
      await step('zero-keep-sync', () => ix(sync(carol, 4n)));
      check(integer((await program.account.minerClaim.fetch(miner(carol.publicKey))).claimedTotal) === 0n, 'Sync moved KEEP cursor');
      await step('sync-fences-revoke', () => ix(revoke(4n)), [], 'InvalidPredecessor');
      await step('sync-noop', () => ix(sync(carol, 4n)), [], 'InvalidMiningRenown');
      await step('pause-sync-only', () => ix(flags(32)));
      await step('paused-sync', () => ix(sync(bob, 4n)), [], 'Paused');
      await step('unpause-claims-sync', () => ix(flags(0)));
      await step('claim-alice-old-root', () => ix(claim(alice, 1n)), [], null, alice);
      check(await balance(ata(alice.publicKey)) === 60n, 'Old nonrevoked root did not pay exact amount');
      await step('double-claim', () => ix(claim(alice, 1n)), [], 'InvalidMiningClaim', alice);
      await step('claim-alice-correction', () => ix(claim(alice, 3n)), [], null, alice);
      check(await balance(ata(alice.publicKey)) === 100n, 'Correction claim did not pay cumulative difference');
      await step('older-root-after-newer', () => ix(claim(alice, 1n)), [], 'InvalidMiningClaim', alice);
      await step('claim-alice-latest', () => ix(claim(alice, 4n)), [], null, alice);
      await step('sync-bob-before-claim', () => ix(sync(bob, 4n)));
      check(integer((await program.account.minerClaim.fetch(miner(bob.publicKey))).claimedTotal) === 0n, 'Renown sync consumed Bob KEEP');
      await step('renown-cursor-refuses-old-root', () => ix(claim(bob, 3n)), [], 'InvalidMiningClaim', bob);
      await step('claim-bob-latest', () => ix(claim(bob, 4n)), [], null, bob);
      await step('zero-keep-claim', () => ix(claim(carol, 4n)), [], 'InvalidMiningClaim', carol);
      await step('revoked-root-stays-revoked', () => ix(claim(alice, 2n)), [], 'InvalidMiningClaim', alice);
      await step('tax-reserve-cannot-be-withdrawn', () => ix(withdraw(1n)), [], 'Backing');
      check(await balance(ata(alice.publicKey)) === 140n && await balance(ata(bob.publicKey)) === 100n && await balance(vault) === 30n, 'Net claims/tax backing mismatch');
      const c = await getConfig(); check(integer(c.totalClaimed) === 240n && integer(c.taxPaid) === 0n && integer(c.taxHighwater) === 30n, 'Claim totals changed tax rights');
      check(state.lookupTable, 'Missing original lookup table');
      const table = (await connection.getAddressLookupTable(new PublicKey(state.lookupTable), { commitment: 'finalized' })).value;
      check(table && table.state.authority === undefined && table.isActive() && table.state.addresses.length === 3
        && table.state.addresses.every((k, i) => k.equals([config, vault, mint.publicKey][i]!)), 'Lookup table is not exact and frozen');
      const blockhash = (await connection.getLatestBlockhash('finalized')).blockhash, packets: unknown[] = [];
      // Packet serialization only: these illustrative deep proofs are not submitted on-chain.
      for (const depth of [14, 15, 16]) {
        const proof = Array.from({ length: depth }, () => ({ hash: Array(32).fill(1), sum: bn(1), isLeft: false }));
        const instruction = await program.methods.claimMining(bn(4), bn(140), bn(3), bn(3), proof).accountsPartial({ claimant: alice.publicKey, config, root: root(4n), miner: miner(alice.publicKey), renown: renown(alice.publicKey), vault, destination: ata(alice.publicKey), keepMint: mint.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).instruction();
        const compute = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
        const createAta = createAssociatedTokenAccountIdempotentInstruction(alice.publicKey, ata(alice.publicKey), alice.publicKey, mint.publicKey);
        const openRecords = await program.methods.openMinerRecords(alice.publicKey).accountsPartial({ payer: alice.publicKey, miner: miner(alice.publicKey), renown: renown(alice.publicKey), systemProgram: SystemProgram.programId }).instruction();
        for (const [name, instructions] of [['claim', [compute, instruction]], ['ata-claim', [compute, createAta, instruction]], ['prepare-claim', [compute, createAta, openRecords, instruction]]] as const) {
          const legacy = new Transaction({ feePayer: alice.publicKey, recentBlockhash: blockhash }).add(...instructions);
          const legacyBytes = 1 + legacy.compileMessage().header.numRequiredSignatures * 64 + legacy.serializeMessage().length;
          const v0 = new VersionedTransaction(new TransactionMessage({ payerKey: alice.publicKey, recentBlockhash: blockhash, instructions: [...instructions] }).compileToV0Message([table]));
          const v0Bytes = v0.serialize().length;
          packets.push({ depth, variant: name, legacyBytes, v0Bytes });
          if (name === 'claim') check(v0Bytes <= 1232, `Depth${depth} v0 claim exceeds packet limit`);
        }
      }
      state.packets = packets;
      check(!idl.instructions.some((i: { name: string }) => /close.*(miner|renown)|realloc.*(miner|renown)/i.test(i.name)), 'Permanent record close/realloc exposed');
    }
    state.completed.push(phase); await save();
    console.log(JSON.stringify({ phase, checkpoint: path, finalizedAttempts: Object.keys(state.steps).length, actualClock: String(await clock()), claimAfter: state.claimAfter,
      fixtureParentGenesis: fixtureParent, fixtureGenesis: state.fixtureGenesis, fixtureClaimAfter: state.fixtureClaimAfter, packets: state.packets }));
  } finally { await lock.close(); await unlink(path + '.lock'); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
