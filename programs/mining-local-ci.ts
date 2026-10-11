/** R1 local fixtures: real publication transactions, then a separate genesis with
 * only allocation audit timestamps aged. No Clock override, retained ledger,
 * public RPC, persistent supervisor, release credential or natural-wait claim. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { finished } from 'node:stream/promises';
import * as anchor from '@coral-xyz/anchor';
import { AddressLookupTableProgram, Connection, Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PHASE_E_MINING_PUBLICATION as POLICY } from '../packages/shared/src/constants';

const programs = dirname(resolve(process.argv[1]!)), root = resolve(programs, '..');
const report = join(root, '.reports/phase-e-mining');
const names = ['shardkeep_core', 'shardkeep_distributor', 'shardkeep_economy', 'seeker_cpi_probe'];
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
function launch(bin: string, args: string[], label: string) {
  const out = createWriteStream(join(report, label + '.log'));
  const child = spawn(bin, args, { cwd: programs, stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: true });
  let failure: Error | undefined;
  const terminate = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error as Error; }
  };
  const fail = (e: Error) => { failure ??= e; terminate('SIGINT'); };
  child.once('error', fail); child.stdout!.once('error', fail); child.stderr!.once('error', fail);
  const drained = finished(out).catch(fail);
  child.stdout!.pipe(out, { end: false }); child.stderr!.pipe(out, { end: false });
  const closed = new Promise<void>((resolve, reject) => child.once('close', async code => {
    out.end(); await drained;
    if (failure || code !== 0) reject(failure ?? new Error(`${label} exited ${code}; see its log`)); else resolve();
  }));
  // A validator is intentionally terminated by its parent; keep its rejection
  // handled while readiness and child test commands are awaited.
  void closed.catch(() => undefined);
  return { child, closed, terminate };
}
async function main() {
  const miningOnly = process.argv.length === 3 && process.argv[2] === '--mining-only';
  check(process.argv.length === 2 || miningOnly, 'Only --mining-only is supported');
  await mkdir(report, { recursive: true });
  const working = await mkdtemp('/tmp/mining-ci-');
  const payer = Keypair.generate(), payerPath = join(working, 'payer.json');
  await writeFile(payerPath, JSON.stringify(Array.from(payer.secretKey)), { mode: 0o600, flag: 'wx' });
  const ids = await Promise.all(names.map(async name => new PublicKey(JSON.parse(await readFile(join(programs, 'target/idl', name + '.json'), 'utf8')).address)));
  const economy = ids[2]!, binary = await readFile(join(programs, 'target/deploy/shardkeep_economy.so'));
  const tsx = join(root, 'scripts/node_modules/.bin/tsx');
  let active: ReturnType<typeof launch> | undefined;
  let activeCommand: ReturnType<typeof launch> | undefined;
  let timedOut = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const interrupt = () => {
    timedOut = true; process.exitCode = 1; activeCommand?.terminate('SIGINT'); active?.terminate('SIGINT');
    escalation ??= setTimeout(() => { activeCommand?.terminate('SIGKILL'); active?.terminate('SIGKILL'); }, 20_000);
  };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const deadline = setTimeout(interrupt, 30 * 60_000);
  async function stop() {
    const run = active; active = undefined;
    if (!run) return;
    run.terminate('SIGINT');
    const force = setTimeout(() => run.terminate('SIGKILL'), 20_000);
    try { await run.closed.catch(error => { if (run.child.signalCode !== 'SIGINT' && run.child.exitCode !== 0) throw error; }); }
    finally { clearTimeout(force); }
  }
  async function command(bin: string, args: string[], label: string) {
    check(!timedOut, 'Local fixture deadline exceeded');
    const run = launch(bin, args, label); activeCommand = run;
    try { await run.closed; check(!timedOut, 'Interrupted local fixture command'); }
    finally { run.terminate('SIGKILL'); activeCommand = undefined; }
  }
  async function start(label: string, port: number, accountDir?: string) {
    check(!active && !timedOut, 'Cannot overlap fixture validators');
    for (const candidate of [port, port + 1, port + 50]) await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(candidate, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
    });
    const args = ['--ledger', join(working, label), '--rpc-port', String(port), '--faucet-port', String(port + 50),
      '--dynamic-port-range', `${port + 2}-${port + 25}`, '--bind-address', '127.0.0.1',
      '--mint', Keypair.generate().publicKey.toBase58(), '--limit-ledger-size', '10000'];
    for (let i = 0; i < ids.length; i++) args.push('--upgradeable-program', ids[i]!.toBase58(),
      join(programs, 'target/deploy', names[i] + '.so'), payer.publicKey.toBase58());
    if (accountDir) args.push('--account-dir', accountDir);
    active = launch('solana-test-validator', args, label);
    const connection = new Connection(`http://127.0.0.1:${port}`, { commitment: 'finalized',
      disableRetryOnRateLimit: true, fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5_000) }) });
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      check(active.child.exitCode === null && active.child.signalCode === null && !timedOut, `${label} stopped during startup`);
      let slot = 0;
      try { slot = await connection.getSlot('finalized'); } catch { /* bounded local readiness */ }
      if (slot > 0) {
        // A socket preflight has a race; the freshly generated upgrade authority
        // and exact current binary must identify our child before any write.
        await programHash(connection);
        check(active.child.exitCode === null && active.child.signalCode === null && !timedOut, `${label} exited during identity check`);
        return connection;
      }
      await sleep(500);
    }
    throw new Error(`${label} did not finalize within60s`);
  }
  async function fund(connection: Connection) {
    const signature = await connection.requestAirdrop(payer.publicKey, 100_000_000_000);
    check(!(await connection.confirmTransaction(signature, 'finalized')).value.err, 'Local faucet failed');
  }
  async function programHash(connection: Connection) {
    const address = PublicKey.findProgramAddressSync([economy.toBuffer()], loader)[0];
    const [program, data] = await connection.getMultipleAccountsInfo([economy, address], 'finalized');
    check(program?.executable && program.owner.equals(loader) && program.data.length === 36
      && program.data.readUInt32LE(0) === 2 && new PublicKey(program.data.subarray(4)).equals(address), 'Wrong program identity');
    check(data !== null && data.owner.equals(loader) && data.data.readUInt32LE(0) === 3 && data.data[12] === 1
      && new PublicKey(data.data.subarray(13, 45)).equals(payer.publicKey), 'Wrong fixture upgrade authority');
    check(data.data.subarray(45, 45 + binary.length).equals(binary) && data.data.subarray(45 + binary.length).every(v => v === 0), 'Loaded program differs from current SBF');
    return digest(data.data);
  }
  try {
    // CI already ran these exact binaries through seeker-local-ci's complete
    // Anchor suite. Standalone runs include that suite unless explicitly omitted.
    if (!miningOnly) {
      const foundation = await start('foundation', 8899);
      await fund(foundation);
      await command(process.env.PHASE_E_ANCHOR_BIN ?? 'anchor', ['test', '--skip-build', '--skip-deploy', '--skip-local-validator',
        '--provider.cluster', 'localnet', '--provider.wallet', payerPath], 'anchor-tests');
      await stop();
    }
    let connection = await start('prepare', 18899);
    await fund(connection);
    const originalGenesis = await connection.getGenesisHash(), hash = await programHash(connection);
    const checkpoint = `/tmp/mining-local-${working.split('/').at(-1)}.json`;
    const runner = join(programs, 'mining-local-lifecycle.ts');
    const common = ['--rpc', connection.rpcEndpoint, '--checkpoint', checkpoint, '--payer', payerPath, '--program-data-sha256', hash];
    await command(tsx, [runner, 'prepare', ...common, '--genesis', originalGenesis], 'mining-prepare');
    // Freeze originals before deriving the separately labelled elapsed fixture.
    const originalState = await readFile(checkpoint);
    await writeFile(join(working, 'original-prepare.json'), originalState, { mode: 0o600, flag: 'wx' });
    const prepared = JSON.parse(originalState.toString('utf8')) as { keys: Record<string, number[]> };
    const systemWallets = new Set([payer.publicKey.toBase58(), ...['guardian', 'publisher', 'alice', 'bob', 'carol'].map(name => {
      const secret = prepared.keys[name];
      check(Array.isArray(secret) && secret.length === 64 && secret.every(v => Number.isInteger(v) && v >= 0 && v <= 255), 'Malformed generated fixture wallet');
      return Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey.toBase58();
    })]);
    const groups = await Promise.all([economy, TOKEN_PROGRAM_ID, SystemProgram.programId, AddressLookupTableProgram.programId].map(owner => connection.getProgramAccounts(owner, { commitment: 'finalized', withContext: true })));
    // Validator mint/faucet identities are unrelated to the test and may hold
    // unsafe-number genesis balances. Copy only its explicitly generated wallets.
    const accounts = groups.flatMap(g => g.value).filter(v => !v.account.executable
      && (!v.account.owner.equals(SystemProgram.programId) || (v.account.data.length === 0 && systemWallets.has(v.pubkey.toBase58()))));
    check([...systemWallets].every(key => accounts.some(v => v.pubkey.toBase58() === key)), 'Missing generated fixture wallet');
    check(accounts.length > 0 && accounts.length <= 256, 'Unbounded fixture account set');
    check(new Set(accounts.map(v => v.pubkey.toBase58())).size === accounts.length, 'Duplicate fixture accounts');
    const idl = JSON.parse(await readFile(join(programs, 'target/idl/shardkeep_economy.json'), 'utf8'));
    const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {}));
    const rootDiscriminator = Buffer.from(program.idl.accounts!.find(v => v.name === 'allocationRoot')!.discriminator);
    const accountDir = join(working, 'elapsed-fixture'); await mkdir(accountDir, { mode: 0o700 });
    const originals = [], expected = new Map<string, { owner: string; lamports: number; data: Buffer }>();
    let changedRoots = 0;
    for (const { pubkey, account } of accounts) {
      check(Number.isSafeInteger(account.lamports), 'Unsafe fixture lamports');
      const before = account.data;
      let data = before;
      if (account.owner.equals(economy) && before.subarray(0, 8).equals(rootDiscriminator)) {
        const decoded = program.coder.accounts.decode('allocationRoot', before);
        check((await program.coder.accounts.encode('allocationRoot', decoded)).equals(before), 'Root IDL does not preserve exact bytes');
        const original = BigInt(decoded.publishedAt.toString());
        check(original >= BigInt(POLICY.claimDelaySec), 'Audit timestamp subtraction underflow');
        decoded.publishedAt = new anchor.BN((original - BigInt(POLICY.claimDelaySec)).toString());
        data = await program.coder.accounts.encode('allocationRoot', decoded);
        changedRoots++;
      }
      const json = (bytes: Buffer) => ({ pubkey: pubkey.toBase58(), account: { lamports: account.lamports,
        data: [bytes.toString('base64'), 'base64'], owner: account.owner.toBase58(), executable: false, rentEpoch: 0 } });
      originals.push(json(before)); expected.set(pubkey.toBase58(), { owner: account.owner.toBase58(), lamports: account.lamports, data });
      await writeFile(join(accountDir, pubkey.toBase58() + '.json'), JSON.stringify(json(data)), { mode: 0o600, flag: 'wx' });
    }
    check(changedRoots === 4, 'Expected four published/corrected root fixtures');
    await writeFile(join(working, 'original-accounts.json'), JSON.stringify(originals), { mode: 0o600, flag: 'wx' });
    await stop();
    connection = await start('elapsed-claims', 18899, accountDir);
    const genesis = await connection.getGenesisHash();
    check(genesis !== originalGenesis && await programHash(connection) === hash, 'Fixture identity mismatch');
    for (const [key, expectedAccount] of expected) {
      const actual = await connection.getAccountInfo(new PublicKey(key), 'finalized');
      check(actual?.owner.toBase58() === expectedAccount.owner && actual.lamports === expectedAccount.lamports
        && actual.data.equals(expectedAccount.data), `Copied fixture changed ${key}`);
    }
    const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'finalized');
    check(clock?.data.length === 40, 'Missing actual fixture Clock');
    await command(tsx, [runner, 'claims', ...common, '--genesis', genesis, '--fixture-parent-genesis', originalGenesis], 'mining-claims');
    check(!timedOut, 'Interrupted local fixture cannot report success');
    await writeFile(join(report, 'result.json'), JSON.stringify({ acceptance: 'injected elapsed audit-delay fixture',
      originalGenesis, claimsGenesis: genesis, changedRoots, copiedAccounts: accounts.length,
      compiledSbfSha256: digest(binary), actualClaimsClock: clock.data.readBigInt64LE(32).toString(),
      foundation: miningOnly ? 'not_run' : 'passed', prepare: 'passed', claims: 'passed' }, null, 2));
  } finally {
    clearTimeout(deadline);
    try { await stop(); }
    finally {
      if (escalation) clearTimeout(escalation);
      process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    }
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
