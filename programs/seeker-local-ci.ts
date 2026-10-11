/** Linux-only disposable validator gate. Never connects to public RPC or reads
 * production credentials. The phased runner refuses unless actual Clock permits
 * each action; slot estimates are merely bounded test navigation. */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { finished } from 'node:stream/promises';
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '../packages/shared/src/constants';

const programs = dirname(resolve(process.argv[1]!)), root = resolve(programs, '..');
const evidence = join(root, '.reports/phase-e-programs');
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
// 9c1f69b4: inject the public league binary; its fixture-dependent suite lives outside tests/**/*.ts.
const programsByName = ['shardkeep_core', 'shardkeep_distributor', 'shardkeep_economy', 'seeker_cpi_probe', 'shardkeep_league'];
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function requireThat(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function loggedChild(bin: string, args: string[], log: string, env: NodeJS.ProcessEnv = {}) {
  const out = createWriteStream(join(evidence, log));
  const child = spawn(bin, args, { cwd: programs, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure: Error | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    if (child.exitCode === null && child.signalCode === null && !timer) {
      child.kill('SIGINT');
      timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    }
  };
  // Register before piping; convert rejection to a value immediately so startup
  // failures cannot become unhandled rejections while RPC readiness is awaited.
  const drained = finished(out).catch(error => { fail(error); });
  child.once('error', fail);
  child.stdout!.once('error', fail); child.stderr!.once('error', fail);
  child.stdout!.pipe(out, { end: false }); child.stderr!.pipe(out, { end: false });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolve => {
    child.once('close', async (code, signal) => {
      if (timer) clearTimeout(timer);
      out.end();
      await drained;
      resolve({ code, signal, error: failure });
    });
  });
  return { child, closed };
}
async function command(bin: string, args: string[], log: string, env: NodeJS.ProcessEnv = {}) {
  const result = await loggedChild(bin, args, log, env).closed;
  if (result.error) throw result.error;
  requireThat(result.code === 0, `${bin} failed (${result.code ?? result.signal}); see ${log}`);
}
async function main() {
  requireThat(process.platform === 'linux', 'Clock warp gate requires Linux, not host limit changes');
  const limit = execFileSync('bash', ['-c', 'ulimit -n'], { encoding: 'utf8' }).trim();
  requireThat(limit === 'unlimited' || Number(limit) > 73_728, 'Agave warp needs >65,536 retained hash-bin descriptors plus overhead');
  await mkdir(evidence, { recursive: true });
  const working = await mkdtemp(join(tmpdir(), 'seeker-ci-'));
  const wallet = Keypair.generate(), walletPath = join(working, 'payer.json');
  await writeFile(walletPath, JSON.stringify(Array.from(wallet.secretKey)), { mode: 0o600, flag: 'wx' });
  const ids = await Promise.all(programsByName.map(async name => new PublicKey(JSON.parse(
    await readFile(join(programs, 'target/idl', `${name}.json`), 'utf8')).address)));
  let validator: ChildProcess | undefined;
  let validatorExit: ReturnType<typeof loggedChild>['closed'] | undefined;
  async function stop() {
    if (!validator) return;
    const child = validator; validator = undefined;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([validatorExit!, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('owned validator failed to stop cleanly')); }, 20_000);
      })]);
      if (result.error) throw result.error;
    } finally { if (timer) clearTimeout(timer); }
  }
  async function start(ledger: string, port: number, label: string, warp?: number) {
    requireThat(!validator, 'cannot overlap owned validators');
    const args = ['--ledger', ledger, '--rpc-port', String(port), '--faucet-port', String(port + 50),
      '--dynamic-port-range', `${port + 2}-${port + 25}`, '--bind-address', '127.0.0.1',
      // Storage-only retention for all original per-phase receipts. Agave counts
      // data shreds here; coding shreds and DB/snapshot overhead are additional.
      '--slots-per-epoch', '10000000', '--limit-ledger-size', '3000000'];
    if (warp === undefined) for (let i = 0; i < ids.length; i++) args.push('--upgradeable-program', ids[i]!.toBase58(),
      join(programs, 'target/deploy', `${programsByName[i]}.so`), wallet.publicKey.toBase58());
    else args.push('--warp-slot', String(warp));
    const process = loggedChild('solana-test-validator', args, `${label}.log`);
    validator = process.child;
    const owned = validator;
    validatorExit = process.closed;
    let startupError: Error | undefined; owned.once('error', error => { startupError = error; });
    const connection = new Connection(`http://127.0.0.1:${port}`, {
      commitment: 'finalized', fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      requireThat(owned.exitCode === null && owned.signalCode === null, `validator exited; see ${label}.log`);
      try { if (await connection.getSlot('finalized') > (warp ?? 0)) return connection; } catch { /* bounded readiness retry */ }
      await sleep(500);
    }
    throw new Error(`validator did not finalize a normal bank within60s; see ${label}.log`);
  }
  const clock = async (connection: Connection) => {
    const { context, value } = await connection.getAccountInfoAndContext(SYSVAR_CLOCK_PUBKEY, 'finalized');
    requireThat(value?.data.length === 40, 'wrong Clock layout');
    return { slot: context.slot, now: Number(value.data.readBigInt64LE(32)) };
  };
  const fund = async (connection: Connection) => {
    const signature = await connection.requestAirdrop(wallet.publicKey, 50_000_000_000);
    const result = await connection.confirmTransaction(signature, 'finalized');
    requireThat(!result.value.err, 'local faucet failed');
  };
  const observations: object[] = [];
  try {
    const foundation = await start(join(working, 'foundation-ledger'), 8899, 'foundation-validator');
    await fund(foundation);
    await command('anchor', ['test', '--skip-build', '--skip-deploy', '--skip-local-validator',
      '--provider.cluster', 'localnet', '--provider.wallet', walletPath], 'anchor-tests.log');
    await stop();

    const ledger = join(working, 'lifecycle-ledger');
    let connection = await start(ledger, 18899, 'lifecycle-prepare-validator');
    await fund(connection);
    const genesis = await connection.getGenesisHash(), initial = await clock(connection);
    const programId = ids[2]!;
    const [programAccount, programData] = await Promise.all([
      connection.getAccountInfo(programId, 'finalized'),
      connection.getAccountInfo(PublicKey.findProgramAddressSync([programId.toBuffer()], loader)[0], 'finalized'),
    ]);
    const dataAddress = PublicKey.findProgramAddressSync([programId.toBuffer()], loader)[0];
    requireThat(programAccount?.owner.equals(loader) && programAccount.executable && programAccount.data.length === 36
      && programAccount.data.readUInt32LE(0) === 2 && new PublicKey(programAccount.data.subarray(4)).equals(dataAddress), 'wrong loaded program identity');
    requireThat(programData !== null, 'missing ProgramData');
    requireThat(programData.owner.equals(loader) && programData.data.length >= 45 && programData.data.readUInt32LE(0) === 3
      && programData.data[12] === 1 && new PublicKey(programData.data.subarray(13, 45)).equals(wallet.publicKey), 'wrong upgrade authority');
    const binary = await readFile(join(programs, 'target/deploy/shardkeep_economy.so'));
    requireThat(programData.data.subarray(45, 45 + binary.length).equals(binary)
      && programData.data.subarray(45 + binary.length).every(byte => byte === 0), 'validator program differs from built SBF');
    const hash = createHash('sha256').update(programData.data).digest('hex');
    const t0 = initial.now + PHASE_E_POLICY.seekerIsland.overlappingAuctionSec + 3_600;
    const checkpoint = join(tmpdir(), `seeker-local-${working.split('/').at(-1)}.json`);
    // Agave2.3.13 maybe_warp_slot() warps the snapshot root BEFORE replaying
    // blockstore. Finality alone is insufficient: the latest finalized write
    // can be newer than test-validator's completed full snapshot (every100slots).
    // No fixture child is running/writing while either barrier is sampled.
    async function stateFingerprint() {
      const groups = await Promise.all([programId, TOKEN_PROGRAM_ID].map(async owner => {
        const result = await connection.getProgramAccounts(owner, { commitment: 'finalized', withContext: true });
        const accounts = result.value.map(({ pubkey, account }) => {
          requireThat(Number.isSafeInteger(account.lamports), 'unsafe account lamports in restart evidence');
          return [pubkey.toBase58(), account.owner.toBase58(), account.lamports, account.executable, account.data.toString('base64')];
        }).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
        return { slot: result.context.slot, accounts };
      }));
      return { floor: Math.max(...groups.map(group => group.slot)),
        hash: createHash('sha256').update(JSON.stringify(groups.map(group => group.accounts))).digest('hex') };
    }
    async function snapshotBarrier(floor: number) {
      requireThat(Number.isSafeInteger(floor) && floor >= 0, 'invalid finalized snapshot floor');
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const response = await fetch(connection.rpcEndpoint, { method: 'POST', redirect: 'error',
          signal: AbortSignal.timeout(5_000), headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHighestSnapshotSlot' }) });
        requireThat(response.ok, 'snapshot RPC failed');
        const body = await response.json() as { error?: unknown; result?: { full?: number } };
        requireThat(!body.error && Number.isSafeInteger(body.result?.full), 'invalid full snapshot response');
        if (body.result!.full! >= floor) {
          observations.push({ phase: 'snapshot-barrier', floor, fullSnapshot: body.result!.full });
          return;
        }
        await sleep(1_000);
      }
      throw new Error('No completed full snapshot contains finalized fixture state within120s; refusing warp');
    }
    const runner = join(programs, 'seeker-local-lifecycle.ts');
    const tsx = join(root, 'scripts/node_modules/.bin/tsx');
    async function phase(name: string) {
      await command(tsx, [runner, name, '--rpc', connection.rpcEndpoint, '--checkpoint', checkpoint,
        '--payer', walletPath, '--genesis', genesis, '--program-data-sha256', hash, '--t0', String(t0)], `lifecycle-${name}.log`);
      observations.push({ phase: name, ...(await clock(connection)), genesis });
    }
    let warpCount = 0;
    async function advance(min: number, max: number) {
      for (let attempt = 0; attempt < 3; attempt++) {
        let before = await clock(connection);
        requireThat(before.now < max, 'Clock overshot the required operating interval');
        if (before.now >= min) return;
        const original = await stateFingerprint();
        await snapshotBarrier(original.floor);
        before = await clock(connection);
        requireThat(before.now < max, 'Clock overshot while waiting for durable snapshot');
        if (before.now >= min) return;
        // Agave updates voted Clock after warp. This conservative test estimate
        // NEVER grants admission: every restart and phase checks real Clock.
        const slots = Math.max(1_000, Math.ceil((min - before.now) / 0.3) + 512);
        await stop();
        connection = await start(ledger, 18899, `lifecycle-warp-${++warpCount}`, before.slot + slots);
        requireThat(await connection.getGenesisHash() === genesis, 'restart changed the original chain');
        requireThat((await stateFingerprint()).hash === original.hash, 'warp lost or changed finalized auction/token state');
        observations.push({ phase: 'warp', before, after: await clock(connection), genesis });
      }
      const actual = await clock(connection);
      requireThat(actual.now >= min && actual.now < max, 'bounded warp failed to reach the actual Clock interval');
    }
    await phase('prepare');
    await advance(t0 - PHASE_E_POLICY.seekerIsland.overlappingAuctionSec, t0);
    await phase('bid');
    await advance(t0 + PHASE_E_SEEKER_AUCTION.settlementGraceSec, t0 + PHASE_E_POLICY.seekerIsland.operatingTermSec);
    await phase('settle');
    await snapshotBarrier((await stateFingerprint()).floor);
    await writeFile(join(evidence, 'public-summary.json'), JSON.stringify({ genesis, program: programId.toBase58(),
      programDataSha256: hash, compiledSbfSha256: createHash('sha256').update(binary).digest('hex'), observations }, null, 2));
  } finally { await stop(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'local validator gate failed'); process.exitCode = 1; });
