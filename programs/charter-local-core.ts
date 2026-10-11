/** Owned, ephemeral Core execution fixture. No public RPC, deployed equivalence,
 * policy permit, production craft identity, or Charter registration authority.
 * Root invokes this after building the host verifier; this file builds nothing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import type { TransactionBuilder, Signer } from '../packages/chain/node_modules/@metaplex-foundation/umi';
import { charterFreezePda } from '../packages/chain/src/charterProtocol';

const programs = dirname(resolve(process.argv[1]!)), root = resolve(programs, '..');
const requireChain = createRequire(join(root, 'packages/chain/package.json'));
const core: typeof import('../packages/chain/node_modules/@metaplex-foundation/mpl-core') = requireChain('@metaplex-foundation/mpl-core');
const umiApi: typeof import('../packages/chain/node_modules/@metaplex-foundation/umi') = requireChain('@metaplex-foundation/umi');
const umiBundle: typeof import('../packages/chain/node_modules/@metaplex-foundation/umi-bundle-defaults') = requireChain('@metaplex-foundation/umi-bundle-defaults');
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
// Official release/core@0.15.2 asset542981306, source e72d63e4118a0a95ac9b40221e81b19d49e1e102.
const CORE_SHA256 = '69be69672220f4b5b0813e53cc4e2f3042dcac991f088b174bc7907dab4b2dee';
const CORE_BYTES = 809696;
const CLAN = '12345678-1234-5678-9abc-def012345678';
const CRAFT = new PublicKey(Buffer.alloc(32, 14)); // Explicit fixture identity, never a deployment pin.
const FREEZE = charterFreezePda(CRAFT, CLAN);
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
type Profile = { asset: PublicKey; collection: PublicKey };
type Outcome = { label: string; category: 'decoder' | 'owner-refusal' | 'governance-demonstration'; result: string };

async function freePortBlock(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise<number>((done, fail) => {
      const server = createServer(); server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address(); check(address && typeof address !== 'string', 'Missing allocated port');
        server.close(error => error ? fail(error) : done(address.port));
      });
    });
    if (port < 20000 || port > 65000) continue;
    const servers: ReturnType<typeof createServer>[] = [], sockets: ReturnType<typeof createSocket>[] = [];
    try {
      for (let p = port; p < port + 30; p++) {
        const server = createServer(); servers.push(server);
        await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(p, '127.0.0.1', done); });
        const socket = createSocket('udp4'); sockets.push(socket);
        await new Promise<void>((done, fail) => { socket.once('error', fail); socket.bind(p, '127.0.0.1', done); });
      }
      return port;
    } catch { /* bounded fresh selection; never connect to the occupying service */ }
    finally {
      for (const server of servers) if (server.listening) await new Promise<void>(done => server.close(() => done()));
      for (const socket of sockets) { try { socket.close(); } catch { /* failed bind has no socket */ } }
    }
  }
  throw new Error('Could not reserve an unused loopback port block');
}

async function main() {
  const argv = process.argv.slice(2);
  check(argv.length === 4 && argv[0] === '--core-binary' && argv[2] === '--verifier',
    'Usage: charter-local-core.ts --core-binary ABSOLUTE_PATH --verifier ABSOLUTE_PATH');
  const binaryPath = argv[1]!, verifierPath = argv[3]!;
  check(isAbsolute(binaryPath) && isAbsolute(verifierPath), 'Both executable paths must be explicit and absolute');
  for (const path of [binaryPath, verifierPath]) check((await lstat(path)).isFile(), 'Expected regular file, not symlink/directory: ' + path);
  check(((await lstat(verifierPath)).mode & 0o111) !== 0, 'Host verifier is not executable');
  const binary = await readFile(binaryPath);
  check(binary.length === CORE_BYTES && binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    && hash(binary) === CORE_SHA256, 'Official Core executable digest/size/ELF mismatch');
  // Read the same installed package roots used by the SDK imports; Umi does
  // not expose package.json through its public exports map.
  const coreSdkVersion: unknown = JSON.parse(await readFile(join(root, 'packages/chain/node_modules/@metaplex-foundation/mpl-core/package.json'), 'utf8')).version;
  const umiVersion: unknown = JSON.parse(await readFile(join(root, 'packages/chain/node_modules/@metaplex-foundation/umi/package.json'), 'utf8')).version;
  check(coreSdkVersion === '1.10.0', 'Re-review the Core SDK version');
  check(umiVersion === '1.5.1', 'Re-review the Umi version');
  const version = spawnSync('solana-test-validator', ['--version'], { encoding: 'utf8', timeout: 10000 });
  check(!version.error && version.status === 0 && /solana-test-validator 2\.3\.13(?:\s|\(|$)/.test(version.stdout),
    'Require pinned solana-test-validator2.3.13; no toolchain fallback');
  const working = await mkdtemp('/tmp/charter-core-');
  console.log('Owned fixture directory: ' + working);
  const payer = Keypair.generate(), owner = Keypair.generate(), stranger = Keypair.generate();
  const port = await freePortBlock(), endpoint = `http://127.0.0.1:${port}`;
  const validatorLog = createWriteStream(join(working, 'validator.log'), { flags: 'wx', mode: 0o600 });
  const validator = spawn('solana-test-validator', [
    '--ledger', join(working, 'ledger'), '--rpc-port', String(port), '--faucet-port', String(port + 3),
    '--gossip-port', String(port + 2), '--dynamic-port-range', `${port + 4}-${port + 29}`,
    '--bind-address', '127.0.0.1', '--mint', Keypair.generate().publicKey.toBase58(),
    '--limit-ledger-size', '10000', '--upgradeable-program', CORE.toBase58(), binaryPath, payer.publicKey.toBase58(),
  ], { cwd: working, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let processFailure: Error | undefined, interrupted = false;
  const abort = new AbortController();
  const terminate = (signal: NodeJS.Signals) => {
    if (validator.pid === undefined) return;
    try { process.kill(-validator.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') processFailure ??= error as Error; }
  };
  const fail = (error: Error) => { processFailure ??= error; abort.abort(error); terminate('SIGINT'); };
  validator.once('error', fail); validator.stdout!.once('error', fail); validator.stderr!.once('error', fail);
  const drained = finished(validatorLog).catch(fail);
  validator.stdout!.pipe(validatorLog, { end: false }); validator.stderr!.pipe(validatorLog, { end: false });
  const closed = new Promise<void>(done => validator.once('close', async () => { validatorLog.end(); await drained; done(); }));
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const interrupt = () => {
    interrupted = true; abort.abort(new Error('Fixture interrupted or deadline exceeded')); terminate('SIGINT');
    escalation ??= setTimeout(() => terminate('SIGKILL'), 5000);
  };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const deadline = setTimeout(interrupt, 10 * 60_000);
  const live = () => check(!interrupted && !processFailure && validator.exitCode === null && validator.signalCode === null,
    'Owned validator exited or fixture interrupted; see validator.log');
  const connection = new Connection(endpoint, { commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      check(url.origin === endpoint && url.protocol === 'http:' && url.hostname === '127.0.0.1', 'Non-owned RPC refused');
      return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
    } });
  const outcomes: Outcome[] = [], transactions: object[] = [];
  let genesis: string | undefined, failure: string | undefined;
  async function identity() {
    live();
    const dataKey = PublicKey.findProgramAddressSync([CORE.toBuffer()], LOADER)[0];
    const [program, data] = await connection.getMultipleAccountsInfo([CORE, dataKey], 'confirmed');
    check(program?.executable && program.owner.equals(LOADER) && program.data.length === 36
      && program.data.readUInt32LE(0) === 2 && new PublicKey(program.data.subarray(4)).equals(dataKey), 'Wrong runtime Core program identity');
    check(data && !data.executable && data.owner.equals(LOADER) && data.data.length >= 45 + binary.length
      && data.data.readUInt32LE(0) === 3 && data.data[12] === 1
      && new PublicKey(data.data.subarray(13, 45)).equals(payer.publicKey), 'Wrong fresh Core upgrade authority');
    check(data.data.subarray(45, 45 + binary.length).equals(binary)
      && data.data.subarray(45 + binary.length).every(byte => byte === 0), 'Runtime Core differs from the pinned executable');
    live();
  }
  async function confirmed(signature: string) {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      live();
      const row = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (row?.confirmationStatus === 'confirmed' || row?.confirmationStatus === 'finalized') return row;
      await sleep(150);
    }
    throw new Error('Transaction did not confirm within30s: ' + signature);
  }
  async function snapshot(profile: Profile) {
    const { context, value } = await connection.getMultipleAccountsInfoAndContext([profile.asset, profile.collection], 'confirmed');
    return { slot: context.slot, rows: value.map((row, i) => {
      check(row && row.owner.equals(CORE) && !row.executable && row.data.length <= 4096,
        'Missing, non-Core, executable or oversized profile account');
      return { key: [profile.asset, profile.collection][i]!.toBase58(), owner: row.owner.toBase58(),
        executable: row.executable, lamports: row.lamports, data: row.data.toString('hex') };
    }) };
  }
  try {
    const end = Date.now() + 60000;
    let ready = false;
    while (Date.now() < end) {
      live();
      try { if (await connection.getSlot('confirmed') > 0) { ready = true; break; } } catch { /* bounded readiness */ }
      await sleep(250);
    }
    check(ready, 'Pinned Core/validator did not start within60s; no version fallback');
    await identity(); // Fresh authority and loaded bytes defeat any port-allocation race before writes.
    genesis = await connection.getGenesisHash();
    for (const wallet of [payer.publicKey, owner.publicKey, stranger.publicKey]) {
      await identity();
      const signature = await connection.requestAirdrop(wallet, 2_000_000_000);
      check((await confirmed(signature)).err === null, 'Owned local faucet failed');
    }
    const umi = umiBundle.createUmi(endpoint).use(core.mplCore());
    const signer = (key: Keypair) => umiApi.createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(key.secretKey));
    const adminSigner = signer(payer), ownerSigner = signer(owner);
    umi.use(umiApi.keypairIdentity(adminSigner));
    const upk = (key: PublicKey) => umiApi.publicKey(key.toBase58());
    const pfd = (frozen = true, address = FREEZE): Parameters<typeof core.create>[1]['plugins'] => [
      { type: 'PermanentFreezeDelegate', frozen, authority: { type: 'Address', address: upk(address) } },
    ];
    async function execute(label: string, builder: TransactionBuilder, expectedError?: number) {
      await identity();
      const instructions = builder.getInstructions();
      check(instructions.length === 1 && instructions[0]!.programId.toString() === CORE.toBase58(), 'Expected exactly one Core instruction');
      const latest = await connection.getLatestBlockhash('confirmed');
      const tx = await builder.useLegacyVersion().setBlockhash(latest.blockhash).buildAndSign(umi);
      const wire = umi.transactions.serialize(tx);
      const signature = await connection.sendRawTransaction(wire, { skipPreflight: true, maxRetries: 0 });
      const status = await confirmed(signature);
      let record = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      for (let i = 0; !record && i < 10; i++) { await sleep(150); record = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); }
      check(record?.meta && record.meta.logMessages, 'Missing confirmed Core transaction metadata/logs');
      const actual = { label, signature, slot: record.slot, status, error: record.meta.err, logs: record.meta.logMessages };
      transactions.push(actual);
      await writeFile(join(working, 'transactions.json'), JSON.stringify(transactions, null, 2), { mode: 0o600 });
      check(JSON.stringify(status.err) === JSON.stringify(record.meta.err), 'Status and transaction error disagree');
      check(record.meta.logMessages.includes(`Program ${CORE.toBase58()} invoke [1]`), 'Core did not execute as the top-level instruction');
      if (expectedError === undefined) check(record.meta.err === null, `${label}: unexpected Core failure ${JSON.stringify(record.meta.err)}`);
      else {
        check(JSON.stringify(record.meta.err) === JSON.stringify({ InstructionError: [0, { Custom: expectedError }] }),
          `${label}: expected Core custom error${expectedError}, got ${JSON.stringify(record.meta.err)}`);
        check(record.meta.logMessages.some(line => line === `Program ${CORE.toBase58()} failed: custom program error: 0x${expectedError.toString(16)}`),
          label + ': missing exact Core failure log');
      }
      return signature;
    }
    async function collection(label: string, plugins: Parameters<typeof core.createCollection>[1]['plugins'] = []) {
      const key = umiApi.generateSigner(umi);
      await execute(label, core.createCollection(umi, { collection: key, name: label,
        uri: 'https://invalid.example/charter-fixture.json', updateAuthority: adminSigner.publicKey, plugins }));
      return new PublicKey(key.publicKey);
    }
    const canonicalCollection = await collection('plain-collection');
    async function createProfile(label: string, options: { collection?: PublicKey; owner?: PublicKey; plugins?: Parameters<typeof core.create>[1]['plugins'] } = {}): Promise<Profile> {
      const asset = umiApi.generateSigner(umi), collection = options.collection ?? canonicalCollection;
      await execute(label, core.create(umi, { asset, collection: { publicKey: upk(collection) },
        owner: upk(options.owner ?? owner.publicKey), name: label, uri: 'https://invalid.example/charter-fixture.json',
        plugins: options.plugins ?? pfd() }));
      return { asset: new PublicKey(asset.publicKey), collection };
    }
    async function decode(label: string, profile: Profile, expected: string | null,
      trust: { owner?: PublicKey; freeze?: PublicKey; collectionAuthority?: PublicKey } = {}, count = true) {
      const actual = await snapshot(profile);
      const assetFile = join(working, label + '-asset.bin'), collectionFile = join(working, label + '-collection.bin');
      await writeFile(assetFile, Buffer.from(actual.rows[0]!.data, 'hex'), { mode: 0o600, flag: 'wx' });
      await writeFile(collectionFile, Buffer.from(actual.rows[1]!.data, 'hex'), { mode: 0o600, flag: 'wx' });
      await writeFile(join(working, label + '-accounts.json'), JSON.stringify(actual, null, 2), { mode: 0o600, flag: 'wx' });
      const result = spawnSync(verifierPath, ['--asset', assetFile, '--collection', collectionFile,
        '--asset-key', profile.asset.toBase58(), '--collection-key', profile.collection.toBase58(),
        '--owner', (trust.owner ?? owner.publicKey).toBase58(), '--freeze-authority', (trust.freeze ?? FREEZE).toBase58(),
        '--collection-authority', (trust.collectionAuthority ?? payer.publicKey).toBase58()],
      { cwd: programs, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
      check(!result.error && result.signal === null, label + ': verifier execution failed');
      await writeFile(join(working, label + '-decoder.json'), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2), { mode: 0o600, flag: 'wx' });
      if (expected === null) check(result.status === 0, label + ': actual Core profile refused by decoder: ' + result.stderr.trim());
      else check(result.status === 2 && result.stderr.trim() === 'CHARTER_CORE_REJECTED:' + expected,
        label + ': expected decoder ' + expected + ', got exit' + result.status + ' ' + result.stderr.trim());
      if (count) outcomes.push({ label, category: 'decoder', result: expected ?? 'accepted' });
    }
    const valid = await createProfile('valid');
    await decode('valid', valid, null); // If real layout disagrees, stop and retain bytes; never weaken the decoder here.
    const baseline = await snapshot(valid);
    async function refusal(label: string, builder: TransactionBuilder, error: number) {
      const before = await snapshot(valid);
      await execute(label, builder, error);
      check(JSON.stringify((await snapshot(valid)).rows) === JSON.stringify(before.rows), label + ': rejected operation changed account bytes/balances');
      outcomes.push({ label, category: 'owner-refusal', result: 'Core custom error' + error });
    }
    const accounts = { asset: upk(valid.asset), collection: upk(valid.collection), payer: adminSigner, authority: ownerSigner };
    // Exact error codes from the pinned Core source: explicit frozen veto9,
    // no approving authority26, re-delegating an Address-managed plugin27.
    await refusal('owner-transfer', core.transferV1(umi, { ...accounts, newOwner: upk(stranger.publicKey) }), 9);
    await refusal('owner-burn', core.burnV1(umi, accounts), 9);
    await refusal('owner-remove-pfd', core.removePluginV1(umi, { ...accounts, pluginType: core.PluginType.PermanentFreezeDelegate }), 9);
    await refusal('owner-thaw', core.updatePluginV1(umi, { ...accounts, plugin: core.plugin('PermanentFreezeDelegate', [{ frozen: false }]) }), 26);
    await refusal('owner-revoke-pfd', core.revokePluginAuthorityV1(umi, { ...accounts, pluginType: core.PluginType.PermanentFreezeDelegate }), 26);
    await refusal('collection-authority-reapprove', core.approvePluginAuthorityV1(umi, { ...accounts, authority: adminSigner,
      pluginType: core.PluginType.PermanentFreezeDelegate, newAuthority: core.basePluginAuthority('Address', { address: upk(stranger.publicKey) }) }), 27);
    check(JSON.stringify((await snapshot(valid)).rows) === JSON.stringify(baseline.rows), 'Original profile changed during owner refusal matrix');

    await decode('wrong-owner', await createProfile('wrong-owner', { owner: stranger.publicKey }), 'OwnerMismatch');
    const otherCollection = await collection('other-collection');
    const crossCollection = await createProfile('wrong-collection', { collection: otherCollection });
    await decode('wrong-collection', { ...crossCollection, collection: canonicalCollection }, 'CollectionMismatch');
    await decode('wrong-freeze', await createProfile('wrong-freeze', { plugins: pfd(true, stranger.publicKey) }), 'FreezeAuthority');
    await decode('unfrozen', await createProfile('unfrozen', { plugins: pfd(false) }), 'NotFrozen');
    await decode('missing-pfd', await createProfile('missing-pfd', { plugins: [] }), 'Malformed');
    await decode('wrong-collection-authority', valid, 'CollectionAuthority', { collectionAuthority: stranger.publicKey });
    await decode('extra-asset-delegate', await createProfile('extra-asset-delegate', { plugins: [
      ...pfd()!, { type: 'TransferDelegate', authority: { type: 'Address', address: upk(stranger.publicKey) } },
    ] }), 'Malformed');
    const delegatedCollection = await collection('delegated-collection', [
      { type: 'PermanentTransferDelegate', authority: { type: 'Address', address: adminSigner.publicKey } },
    ]);
    await decode('extra-collection-delegate', await createProfile('extra-collection-delegate', { collection: delegatedCollection }), 'UnsupportedProfile');

    // Deliberately unsafe governance fixture, NOT accepted custody: collection
    // update authority can revoke the asset delegate, thaw, then let owner move.
    const governance = await createProfile('governance');
    const governanceAccounts = { asset: upk(governance.asset), collection: upk(governance.collection), payer: adminSigner, authority: adminSigner };
    await execute('governance-revoke', core.revokePluginAuthorityV1(umi, { ...governanceAccounts, pluginType: core.PluginType.PermanentFreezeDelegate }));
    await decode('governance-revoked', governance, 'UnsupportedProfile', {}, false);
    await execute('governance-thaw', core.updatePluginV1(umi, { ...governanceAccounts, plugin: core.plugin('PermanentFreezeDelegate', [{ frozen: false }]) }));
    await decode('governance-thawed', governance, 'NotFrozen', {}, false);
    await execute('governance-owner-transfer', core.transferV1(umi, { ...governanceAccounts, authority: ownerSigner, newOwner: upk(stranger.publicKey) }));
    const changed = await snapshot(governance);
    check(Buffer.from(changed.rows[0]!.data, 'hex').subarray(1, 33).equals(stranger.publicKey.toBuffer()), 'Governance bypass did not move actual Core ownership');
    outcomes.push({ label: 'collection-authority-can-revoke-thaw-and-transfer', category: 'governance-demonstration', result: 'unsafe governance observed; decoder holds' });
    await decode('valid-after-adversarial-profiles', valid, null);
    await identity();
    console.log(JSON.stringify({ checks: outcomes.length, decoder: outcomes.filter(x => x.category === 'decoder').length,
      refusals: outcomes.filter(x => x.category === 'owner-refusal').length, governance: 1, transactions: transactions.length }));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    clearTimeout(deadline);
    terminate('SIGINT');
    const force = setTimeout(() => terminate('SIGKILL'), 5000);
    try { await closed; }
    finally {
      clearTimeout(force); if (escalation) clearTimeout(escalation);
      process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
      await writeFile(join(working, 'result.json'), JSON.stringify({
        scope: 'Official Core0.15.2 executed locally; no deployment equivalence or Charter admission',
        status: failure || interrupted || processFailure ? 'failed' : 'passed', failure: failure ?? processFailure?.message ?? null,
        coreSha256: hash(binary), verifierSha256: hash(await readFile(verifierPath)), binaryPath, verifierPath,
        validatorVersion: version.stdout.trim(), coreSdkVersion, umiVersion, endpoint, genesis, fixtureUpgradeAuthority: payer.publicKey.toBase58(),
        fixtureCraft: CRAFT.toBase58(), clan: CLAN, freeze: FREEZE.toBase58(), outcomes, transactions: transactions.length,
      }, null, 2), { mode: 0o600, flag: 'wx' });
    }
    check(!interrupted && !processFailure, 'Fixture interrupted or owned validator failed');
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
