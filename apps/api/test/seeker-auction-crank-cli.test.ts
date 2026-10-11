/** SA-3 lifecycle/CLI tests only. All files are synthetic, all queue/issuer/core
 * effects are injected, and importing the module must start nothing. The CLI
 * write mode only queues work on the application's globally serialized worker. */
import { constants as fsConstants } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHASE_E_SEEKER_AUCTION_RUNTIME } from '@shardkeep/shared';
import { loadConfig, type Config } from '../src/config';
import { createSeekerAuctionRuntime, type SeekerAuctionRegistry } from '../src/seeker/auctionRuntime';
import { createSeekerAuctionCrank, type SeekerAuctionCrankOptions } from '../src/seeker/auctionCrank';
import { loadSeekerAuctionCrankKey, loadSeekerAuctionCrankToken, openSeekerAuctionCrankDryRun,
  startSeekerAuctionCrankWorker, main, type SeekerAuctionSecretFileIo, type SeekerAuctionCrankCliIo } from '../src/seeker/auctionCrankCli';

const R = PHASE_E_SEEKER_AUCTION_RUNTIME;
const crankKey = Keypair.fromSeed(Buffer.alloc(32, 1)), policyKey = Keypair.fromSeed(Buffer.alloc(32, 2));
const pk = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const base = { DATABASE_URL: 'postgres://x:y@localhost:5433/example', JWT_SECRET: 'test-secret-test-secret-test-secret!',
  WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test', REDIS_URL: 'redis://localhost:6380' };
const pins = { SEEKER_AUCTION_PROGRAM_ID: pk(4), SEEKER_AUCTION_DEPLOYMENT_SLOT: '100',
  SEEKER_AUCTION_PROGRAM_DATA_SHA256: 'a'.repeat(64), SEEKER_AUCTION_UPGRADE_AUTHORITY: 'none',
  SEEKER_AUCTION_MINT: pk(5), SEEKER_AUCTION_PRIZE_OWNER: pk(6), SEEKER_AUCTION_STATE_PROVENANCE: 'fresh-reviewed-deployment' };
const registry: SeekerAuctionRegistry = { cluster: 'devnet', skrMint: pk(5), skrDecimals: 6 };
const publicEnv = { ...base, ...pins, SEEKER_AUCTION_CRANK_PUBKEY: crankKey.publicKey.toBase58() };
const enabledEnv = { ...publicEnv, SEEKER_AUCTION_CRANK_ENABLED: 'true', SEEKER_AUCTION_CRANK_KEYPAIR_FILE: '/synthetic/crank.json',
  CHARTER_POLICY_ISSUER_URL: 'https://issuer.example', CHARTER_POLICY_ISSUER_PUBLIC_KEY: policyKey.publicKey.toBase58(),
  CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE: '/synthetic/issuer-token' };
const signature = '2'.repeat(88), token = 'synthetic-issuer-token-0123456789abcdef';
const queueName = 'seeker-auction-crank', schedulerId = 'sched-seeker-auction-crank';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function files() {
  const dir = await mkdtemp(join(tmpdir(), 'seeker-crank-test-')); dirs.push(dir);
  const key = join(dir, 'crank.json'), auth = join(dir, 'issuer-token');
  await writeFile(key, JSON.stringify([...crankKey.secretKey]), { mode: 0o600 });
  await writeFile(auth, token + '\n', { mode: 0o600 }); return { dir, key, auth };
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
type Crank = ReturnType<typeof createSeekerAuctionCrank>;

function fixture() {
  const order: string[] = [], runtimeCloses: ReturnType<typeof vi.fn>[] = [];
  let processor: ((job: { name: string }) => Promise<unknown>) | undefined, active: Promise<unknown> | undefined;
  const runOnce = vi.fn<Crank['runOnce']>().mockResolvedValue({ status: 'idle', actions: [], alarms: [], signature: null });
  const pendingAttempt = vi.fn<Crank['pendingAttempt']>().mockReturnValue(null);
  const queue = { setGlobalConcurrency: vi.fn(async (_value: number) => { order.push('global-limit'); }),
    upsertJobScheduler: vi.fn(async (_id: string, _repeat: { every: number }, _job: { name: string; opts?: { attempts: number } }) => { order.push('schedule'); }),
    removeJobScheduler: vi.fn(async (_id: string) => { order.push('unschedule'); return true; }),
    drain: vi.fn(async (_delayed?: boolean) => { order.push('drain'); }),
    close: vi.fn(async () => { order.push('queue-close'); }) };
  const worker = { pause: vi.fn(async (_doNotWaitActive?: boolean) => { order.push('worker-pause'); }),
    close: vi.fn(async () => { order.push('worker-close'); await active?.catch(() => {}); }) };
  const issuer = { issueOnce: vi.fn(async () => { throw Error('not exercised by wiring tests'); }), close: vi.fn(() => { order.push('issuer-close'); }) };
  const deps = {
    createRuntime: vi.fn((config: Config, identity: SeekerAuctionRegistry | null) => {
      order.push('runtime'); const runtime = createSeekerAuctionRuntime(config, identity);
      if (!runtime) return null;
      const close = vi.fn(() => { order.push('runtime-close'); runtime.close(); }); runtimeCloses.push(close);
      return { source: runtime.source, close };
    }),
    loadKey: vi.fn(async (_file: string, _publicKey: string) => { order.push('key'); return crankKey; }),
    loadToken: vi.fn(async (_file: string) => { order.push('token'); return token; }),
    createIssuer: vi.fn((_options: { endpoint: string; authToken: string; currentPublicKey: string; allowPrivateHttp?: boolean }) => { order.push('issuer'); return issuer; }),
    createCrank: vi.fn((_options: SeekerAuctionCrankOptions): Crank => { order.push('core'); return { runOnce, pendingAttempt }; }),
    createQueue: vi.fn((_name: string, _options: { connection: { url: string }; defaultJobOptions: { attempts: number } }) => { order.push('queue'); return queue; }),
    createWorker: vi.fn((_name: string, run: (job: { name: string }) => Promise<unknown>, _options: { connection: { url: string }; concurrency: number }) => {
      order.push('worker'); processor = run; return worker;
    }),
    waitForNextPoll: vi.fn(async (_ms: number, signal: AbortSignal) => { signal.throwIfAborted(); }),
    onEvent: vi.fn((_event: unknown) => {}),
  };
  const dispatch = (name = queueName) => { if (!processor) throw Error('worker not constructed'); active = processor({ name }); return active; };
  return { order, runtimeCloses, runOnce, pendingAttempt, queue, worker, issuer, deps, dispatch };
}

describe('dedicated crank secret file admission', () => {
  it('accepts only the exact owned crank key and dedicated issuer token', async () => {
    const f = await files();
    expect((await loadSeekerAuctionCrankKey(f.key, crankKey.publicKey.toBase58())).publicKey.equals(crankKey.publicKey)).toBe(true);
    expect(await loadSeekerAuctionCrankToken(f.auth)).toBe(token);
    await expect(loadSeekerAuctionCrankKey(f.key, policyKey.publicKey.toBase58())).rejects.toThrow();
  });
  it('uses no-follow descriptor admission, bounded reads and descriptor cleanup', async () => {
    const f = await files(), buffers: Buffer[] = [], closes: ReturnType<typeof vi.fn>[] = [];
    const io: SeekerAuctionSecretFileIo = { currentUid: () => process.getuid?.(), open: vi.fn(async (file, flags) => {
      const handle = await open(file, flags), close = vi.fn(() => handle.close()); closes.push(close);
      return { stat: () => handle.stat(), read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        buffers.push(buffer); return handle.read(buffer, offset, length, position);
      }, close };
    }) };
    const key = await loadSeekerAuctionCrankKey(f.key, crankKey.publicKey.toBase58(), io);
    expect(key.publicKey.equals(crankKey.publicKey)).toBe(true);
    expect(io.open).toHaveBeenCalledWith(f.key, expect.any(Number));
    const flags = vi.mocked(io.open).mock.calls[0]![1];
    expect(flags & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
    expect(flags & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK);
    expect(closes[0]).toHaveBeenCalledTimes(1); expect(buffers.every(buffer => buffer.every(byte => byte === 0))).toBe(true);
  });
  it('rejects relative paths, directories, symlinks, hardlinks and every permission other than 0600', async () => {
    const f = await files(), symbolic = join(f.dir, 'link'), hard = join(f.dir, 'hard'), directory = join(f.dir, 'directory');
    await symlink(f.key, symbolic); await mkdir(directory);
    for (const file of ['relative-key.json', symbolic, directory]) await expect(loadSeekerAuctionCrankKey(file, crankKey.publicKey.toBase58())).rejects.toThrow();
    for (const mode of [0o400, 0o640, 0o604, 0o666, 0o700]) {
      await chmod(f.key, mode); await expect(loadSeekerAuctionCrankKey(f.key, crankKey.publicKey.toBase58())).rejects.toThrow();
    }
    await chmod(f.key, 0o600); await link(f.key, hard);
    await expect(loadSeekerAuctionCrankKey(f.key, crankKey.publicKey.toBase58())).rejects.toThrow();
    await expect(loadSeekerAuctionCrankKey(hard, crankKey.publicKey.toBase58())).rejects.toThrow();
  });
  it('rejects missing ownership before I/O and closes every opened descriptor on refusal', async () => {
    for (const defect of ['owner', 'changed', 'missing uid'] as const) {
      const f = await files(), closed = vi.fn(); let reads = 0, opened = 0;
      const io: SeekerAuctionSecretFileIo = { currentUid: () => defect === 'missing uid' ? undefined : process.getuid?.(), open: async (file, flags) => {
        opened++;
        const handle = await open(file, flags);
        return { stat: async () => { const stat = await handle.stat(); reads++;
          return { ...stat, isFile: () => stat.isFile(), uid: defect === 'owner' ? stat.uid + 1 : stat.uid,
            mtimeMs: stat.mtimeMs + (defect === 'changed' && reads > 1 ? 1 : 0) };
        }, read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: async () => { closed(); await handle.close(); } };
      } };
      await expect(loadSeekerAuctionCrankKey(f.key, crankKey.publicKey.toBase58(), io)).rejects.toThrow();
      // Labelled fixture correction: absent owner identity must reject before
      // opening; a nonexistent descriptor cannot require a close operation.
      expect(opened).toBe(defect === 'missing uid' ? 0 : 1); expect(closed).toHaveBeenCalledTimes(opened);
    }
  });
  it('rejects malformed, oversized or internally inconsistent key material', async () => {
    const corrupt = [...crankKey.secretKey]; corrupt[63] = corrupt[63]! ^ 1;
    for (const data of ['not-json', JSON.stringify(Array(63).fill(1)), JSON.stringify(Array(64).fill(-1)),
      JSON.stringify(Array(64).fill(0.5)), JSON.stringify(Array(64).fill('1')), JSON.stringify(corrupt), ' '.repeat(8193)]) {
      const f = await files(); await writeFile(f.key, data);
      await expect(loadSeekerAuctionCrankKey(f.key, crankKey.publicKey.toBase58())).rejects.toThrow();
    }
  });
  it('applies the same file protections and exact dedicated-token grammar to token reads', async () => {
    const f = await files(), symbolic = join(f.dir, 'token-link'); await symlink(f.auth, symbolic);
    for (const file of ['relative-token', symbolic]) await expect(loadSeekerAuctionCrankToken(file)).rejects.toThrow();
    await chmod(f.auth, 0o644); await expect(loadSeekerAuctionCrankToken(f.auth)).rejects.toThrow(); await chmod(f.auth, 0o600);
    for (const content of ['short', token + '\n\n', ' ' + token, token + ' ', 'x'.repeat(1025)]) {
      await writeFile(f.auth, content); await expect(loadSeekerAuctionCrankToken(f.auth)).rejects.toThrow();
    }
  });
});

describe('default-off auction worker and read-only preview construction', () => {
  it('does no I/O or queue construction when crank is unset or false, even with stale path settings', async () => {
    for (const flag of [undefined, 'false']) {
      const f = fixture(), config = loadConfig({ ...enabledEnv, SEEKER_AUCTION_CRANK_ENABLED: flag });
      expect(await startSeekerAuctionCrankWorker(config, registry, f.deps)).toBeNull();
      for (const operation of Object.values(f.deps)) expect(operation).not.toHaveBeenCalled();
    }
  });
  it('dry-run uses the same core and reviewed read source but cannot open secrets, issuer, queue or worker', async () => {
    const f = fixture(); f.runOnce.mockResolvedValue({ status: 'dry-run', actions: [], alarms: [], signature: null });
    const preview = await openSeekerAuctionCrankDryRun(loadConfig(publicEnv), registry, f.deps);
    const signal = new AbortController().signal; expect(await preview.runOnce(signal)).toMatchObject({ status: 'dry-run' });
    expect(f.deps.createCrank).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, crankPublicKey: crankKey.publicKey.toBase58() }));
    for (const operation of [f.deps.loadKey, f.deps.loadToken, f.deps.createIssuer, f.deps.createQueue, f.deps.createWorker]) expect(operation).not.toHaveBeenCalled();
    await preview.close(); await preview.close(); expect(f.runtimeCloses[0]).toHaveBeenCalledTimes(1);
    await expect(preview.runOnce(signal)).rejects.toThrow();
  });
  it('refuses missing pins/registry/key identity/issuer settings before any queue or worker exists', async () => {
    const original = loadConfig(enabledEnv);
    for (const [config, identity] of [
      [{ ...original, SEEKER_AUCTION_PROGRAM_DATA_SHA256: undefined }, registry], [original, null],
      [original, { ...registry, skrMint: pk(99) }], [{ ...original, SEEKER_AUCTION_CRANK_PUBKEY: undefined }, registry],
      [{ ...original, SEEKER_AUCTION_CRANK_KEYPAIR_FILE: undefined }, registry], [{ ...original, SEEKER_AUCTION_CRANK_KEYPAIR_FILE: 'relative.json' }, registry],
      [{ ...original, CHARTER_POLICY_ISSUER_URL: undefined }, registry], [{ ...original, CHARTER_POLICY_ISSUER_PUBLIC_KEY: undefined }, registry],
      [{ ...original, CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE: undefined }, registry],
    ] as const) {
      const f = fixture(); await expect(startSeekerAuctionCrankWorker(config, identity, f.deps)).rejects.toThrow();
      expect(f.deps.createQueue).not.toHaveBeenCalled(); expect(f.deps.createWorker).not.toHaveBeenCalled();
    }
  });
  it('loads only dedicated paths and refuses a signer whose public key differs before queue creation', async () => {
    const f = fixture(), lifecycle = await startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, f.deps);
    expect(f.deps.loadKey).toHaveBeenCalledWith(enabledEnv.SEEKER_AUCTION_CRANK_KEYPAIR_FILE, crankKey.publicKey.toBase58());
    expect(f.deps.loadToken).toHaveBeenCalledWith(enabledEnv.CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE);
    expect(f.deps.createIssuer).toHaveBeenCalledWith(expect.objectContaining({ endpoint: enabledEnv.CHARTER_POLICY_ISSUER_URL,
      currentPublicKey: policyKey.publicKey.toBase58(), authToken: token }));
    expect(f.order.indexOf('key')).toBeLessThan(f.order.indexOf('queue')); expect(f.order.indexOf('token')).toBeLessThan(f.order.indexOf('queue'));
    await lifecycle!.close();
    const g = fixture(); g.deps.loadKey.mockResolvedValue(policyKey);
    await expect(startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, g.deps)).rejects.toThrow();
    expect(g.deps.createQueue).not.toHaveBeenCalled(); expect(g.deps.createWorker).not.toHaveBeenCalled();
  });
});

describe('application-owned globally serialized auction worker', () => {
  it('creates one dedicated queue and one concurrency-one worker after setting the global limit', async () => {
    const f = fixture(), lifecycle = await startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, f.deps);
    expect(f.deps.createQueue).toHaveBeenCalledTimes(1); expect(f.deps.createQueue).toHaveBeenCalledWith(queueName,
      expect.objectContaining({ connection: { url: base.REDIS_URL }, defaultJobOptions: expect.objectContaining({ attempts: 1 }) }));
    expect(f.queue.setGlobalConcurrency).toHaveBeenCalledWith(1);
    expect(f.deps.createWorker).toHaveBeenCalledWith(queueName, expect.any(Function), expect.objectContaining({ connection: { url: base.REDIS_URL }, concurrency: 1 }));
    expect(f.order.indexOf('global-limit')).toBeLessThan(f.order.indexOf('worker'));
    expect(f.queue.upsertJobScheduler).toHaveBeenCalledWith(schedulerId, { every: R.crankPollMs }, expect.objectContaining({ name: queueName, opts: expect.objectContaining({ attempts: 1 }) }));
    expect(f.runOnce).not.toHaveBeenCalled(); expect(await f.dispatch()).toMatchObject({ status: 'idle' });
    expect(f.runOnce).toHaveBeenCalledTimes(1); await lifecycle!.close();
  });
  it('refuses an unrelated job without calling the crank', async () => {
    const f = fixture(), lifecycle = await startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, f.deps);
    await expect(f.dispatch('withdrawal')).rejects.toThrow(); expect(f.runOnce).not.toHaveBeenCalled(); await lifecycle!.close();
  });
  it('retains the same job and crank across submitted/pending until a terminal finalized observation', async () => {
    const f = fixture(), entered = gate(), resume = gate();
    f.runOnce.mockResolvedValueOnce({ status: 'submitted', signature, actions: [], alarms: [] })
      .mockResolvedValueOnce({ status: 'pending', signature, actions: [], alarms: [] })
      .mockResolvedValueOnce({ status: 'finalized', signature, actions: [], alarms: [] });
    f.deps.waitForNextPoll.mockImplementationOnce(async (_ms, signal) => { entered.release(); await resume.promise; signal.throwIfAborted(); });
    const lifecycle = await startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, f.deps);
    let finished = false; const active = f.dispatch().then(value => { finished = true; return value; }); await entered.promise;
    expect(finished).toBe(false); expect(f.runOnce).toHaveBeenCalledTimes(1); expect(f.deps.createCrank).toHaveBeenCalledTimes(1);
    resume.release(); expect(await active).toMatchObject({ status: 'finalized', signature });
    expect(f.runOnce).toHaveBeenCalledTimes(3); expect(f.deps.waitForNextPoll).toHaveBeenCalledTimes(2);
    for (const [delay, signal] of f.deps.waitForNextPoll.mock.calls) { expect(delay).toBe(R.crankPollMs); expect(signal).toBeInstanceOf(AbortSignal); }
    await lifecycle!.close();
  });
  it('returns a finalized failure for operator visibility without retrying it in the same job', async () => {
    const f = fixture(); f.runOnce.mockResolvedValueOnce({ status: 'pending', signature, actions: [], alarms: [] })
      .mockResolvedValueOnce({ status: 'failed', signature, actions: [], alarms: [] });
    const lifecycle = await startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, f.deps);
    expect(await f.dispatch()).toMatchObject({ status: 'failed', signature }); expect(f.runOnce).toHaveBeenCalledTimes(2); await lifecycle!.close();
  });
  it('retains the job after an ambiguous pending status error, emits no private error, and reconciles at the bounded poll rate', async () => {
    const f = fixture(), entered = gate(), resume = gate();
    f.pendingAttempt.mockReturnValue({ signature, lastValidBlockHeight: 3100, slot: 2000, action: { kind: 'open-term', round: '0' } });
    f.runOnce.mockRejectedValueOnce(Error('SYNTHETIC_RPC_SECRET_SHOULD_NOT_APPEAR')).mockImplementationOnce(async () => {
      f.pendingAttempt.mockReturnValue(null); return { status: 'finalized', signature, actions: [], alarms: [] };
    });
    f.deps.waitForNextPoll.mockImplementationOnce(async (_ms, signal) => { entered.release(); await resume.promise; signal.throwIfAborted(); });
    const lifecycle = await startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, f.deps);
    let finished = false; const active = f.dispatch().then(value => { finished = true; return value; }); await entered.promise;
    expect(finished).toBe(false); expect(f.runOnce).toHaveBeenCalledTimes(1); expect(f.pendingAttempt).toHaveBeenCalled();
    expect(f.deps.waitForNextPoll).toHaveBeenCalledWith(R.crankPollMs, expect.any(AbortSignal));
    expect(f.deps.onEvent).toHaveBeenCalled(); expect(JSON.stringify(f.deps.onEvent.mock.calls)).toContain(signature);
    expect(JSON.stringify(f.deps.onEvent.mock.calls)).not.toContain('SYNTHETIC_RPC_SECRET_SHOULD_NOT_APPEAR');
    resume.release(); expect(await active).toMatchObject({ status: 'finalized', signature });
    expect(f.deps.createCrank).toHaveBeenCalledTimes(1); expect(f.runOnce).toHaveBeenCalledTimes(2); await lifecycle!.close();
  });
  it('fails a non-pending error without automatic retries or hidden new jobs', async () => {
    const f = fixture(); f.runOnce.mockRejectedValueOnce(Error('synthetic read failure')); f.pendingAttempt.mockReturnValue(null);
    const lifecycle = await startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, f.deps);
    await expect(f.dispatch()).rejects.toThrow(); expect(f.runOnce).toHaveBeenCalledTimes(1);
    expect(f.deps.waitForNextPoll).not.toHaveBeenCalled(); await lifecycle!.close();
  });
  it('close aborts and awaits owned work, retaining the shared scheduler and other queued jobs', async () => {
    const f = fixture(), entered = gate(); f.runOnce.mockResolvedValue({ status: 'pending', signature, actions: [], alarms: [] });
    f.deps.waitForNextPoll.mockImplementation(async (_ms, signal) => {
      entered.release(); await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) { reject(Error('cancelled')); return; }
        signal.addEventListener('abort', () => { f.order.push('aborted'); reject(Error('cancelled')); }, { once: true });
      });
    });
    const lifecycle = await startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, f.deps);
    const active = f.dispatch().catch(error => error); await entered.promise; await lifecycle!.close(); await lifecycle!.close(); await active;
    expect(f.worker.pause).toHaveBeenCalledWith(true); expect(f.queue.removeJobScheduler).not.toHaveBeenCalled(); expect(f.queue.drain).not.toHaveBeenCalled();
    expect(f.order.indexOf('aborted')).toBeLessThan(f.order.indexOf('worker-close'));
    expect(f.order.indexOf('aborted')).toBeLessThan(f.order.indexOf('issuer-close'));
    expect(f.worker.close).toHaveBeenCalledTimes(1); expect(f.issuer.close).toHaveBeenCalledTimes(1); expect(f.runtimeCloses[0]).toHaveBeenCalledTimes(1); expect(f.queue.close).toHaveBeenCalledTimes(1);
    expect(f.deps.createQueue).toHaveBeenCalledTimes(1); expect(f.runOnce).toHaveBeenCalledTimes(1);
  });
  it('cleans up already acquired resources after startup or shutdown failure', async () => {
    const f = fixture(); f.queue.upsertJobScheduler.mockRejectedValueOnce(Error('synthetic scheduler failure'));
    await expect(startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, f.deps)).rejects.toThrow();
    expect(f.queue.close).toHaveBeenCalledTimes(1); expect(f.issuer.close).toHaveBeenCalledTimes(1); expect(f.runtimeCloses[0]).toHaveBeenCalledTimes(1);
    expect(f.queue.removeJobScheduler).not.toHaveBeenCalled();
    const g = fixture(), lifecycle = await startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, g.deps);
    g.worker.close.mockRejectedValueOnce(Error('synthetic cleanup failure'));
    await expect(lifecycle!.close()).rejects.toThrow(); expect(g.worker.close).toHaveBeenCalledTimes(1);
    expect(g.queue.close).toHaveBeenCalledTimes(1); expect(g.issuer.close).toHaveBeenCalledTimes(1); expect(g.runtimeCloses[0]).toHaveBeenCalledTimes(1);
    expect(g.queue.removeJobScheduler).not.toHaveBeenCalled();
  });
  it('closing one replica never removes the recurring producer used by another', async () => {
    const a = fixture(), b = fixture(), live = new Set<string>();
    for (const f of [a, b]) {
      f.queue.upsertJobScheduler.mockImplementation(async id => { live.add(id); });
      f.queue.removeJobScheduler.mockImplementation(async id => live.delete(id));
    }
    const first = await startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, a.deps);
    const second = await startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, b.deps);
    try {
      await first!.close(); expect(live.has(schedulerId)).toBe(true);
      expect(await b.dispatch()).toMatchObject({ status: 'idle' });
      expect(a.queue.removeJobScheduler).not.toHaveBeenCalled(); expect(b.queue.removeJobScheduler).not.toHaveBeenCalled();
    } finally { await first!.close(); await second!.close(); }
    expect(live.has(schedulerId)).toBe(true);
  });
});

function cliFixture() {
  const session = { runOnce: vi.fn(async (_signal: AbortSignal) => ({ status: 'dry-run' as const, actions: [], alarms: [], signature: null })), close: vi.fn(async () => {}) };
  const io: SeekerAuctionCrankCliIo = { loadRegistry: vi.fn(async (_config: Config) => registry),
    openDryRun: vi.fn(async (_config: Config, _registry: SeekerAuctionRegistry) => session),
    enqueueOnce: vi.fn(async (_config: Config, _registry: SeekerAuctionRegistry) => ({ jobId: 'synthetic-job-1' })),
    print: vi.fn(), printError: vi.fn() };
  return { io, session };
}

describe('finite explicit auction CLI', () => {
  it('requires exactly one mode and --once; malformed input opens nothing', async () => {
    for (const args of [[], ['--once'], ['--dry-run'], ['--execute'], ['--dry-run', '--execute', '--once'],
      ['--dry-run', '--dry-run', '--once'], ['--execute', '--once', '--once'], ['--execute', '--once', '--force'], ['start']]) {
      const f = cliFixture(); expect(await main(args, enabledEnv, f.io)).toBe(2);
      expect(f.io.loadRegistry).not.toHaveBeenCalled(); expect(f.io.openDryRun).not.toHaveBeenCalled(); expect(f.io.enqueueOnce).not.toHaveBeenCalled();
    }
  });
  it('runs a finite read-only preview without requiring an enabled crank or any secret path', async () => {
    const f = cliFixture(); expect(await main(['--dry-run', '--once'], publicEnv, f.io)).toBe(0);
    expect(f.session.runOnce).toHaveBeenCalledTimes(1); expect(f.session.close).toHaveBeenCalledTimes(1); expect(f.io.enqueueOnce).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(f.io.print).mock.calls[0]![0])).toMatchObject({ mode: 'dry-run', result: { status: 'dry-run' } });
  });
  it('write --once only enqueues into the dedicated application worker and reports queued, never executed', async () => {
    const f = cliFixture(); expect(await main(['--execute', '--once'], enabledEnv, f.io)).toBe(0);
    expect(f.io.enqueueOnce).toHaveBeenCalledTimes(1); expect(f.io.openDryRun).not.toHaveBeenCalled(); expect(f.session.runOnce).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(f.io.print).mock.calls[0]![0])).toEqual({ mode: 'execute', status: 'queued', jobId: 'synthetic-job-1' });
  });
  it('never enables flags, substitutes a registry, or queues when explicit write configuration is incomplete', async () => {
    for (const env of [{ ...enabledEnv, SEEKER_AUCTION_CRANK_ENABLED: undefined }, { ...enabledEnv, SEEKER_AUCTION_CRANK_ENABLED: 'false' },
      { ...enabledEnv, SEEKER_AUCTION_PROGRAM_DATA_SHA256: undefined }, { ...enabledEnv, SEEKER_AUCTION_CRANK_PUBKEY: undefined },
      { ...enabledEnv, CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE: undefined }]) {
      const f = cliFixture(); expect(await main(['--execute', '--once'], env, f.io)).toBe(1); expect(f.io.enqueueOnce).not.toHaveBeenCalled();
    }
    const g = cliFixture(); vi.mocked(g.io.loadRegistry).mockResolvedValue(null);
    expect(await main(['--execute', '--once'], enabledEnv, g.io)).toBe(1); expect(g.io.enqueueOnce).not.toHaveBeenCalled();
  });
  it('prints only a stable refusal on errors, closes previews, and reports cleanup failure', async () => {
    const f = cliFixture(); f.session.runOnce.mockRejectedValueOnce(Error('SYNTHETIC_PRIVATE_TOKEN_SHOULD_NOT_APPEAR'));
    expect(await main(['--dry-run', '--once'], publicEnv, f.io)).toBe(1); expect(f.session.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(f.io.printError).mock.calls)).not.toContain('SYNTHETIC_PRIVATE_TOKEN_SHOULD_NOT_APPEAR');
    const g = cliFixture(); g.session.close.mockRejectedValueOnce(Error('synthetic close failure'));
    expect(await main(['--dry-run', '--once'], publicEnv, g.io)).toBe(1);
  });
});

// Labelled tests-only successor: K-026 bounds terminal-history purges by age
// plus limit. A count cap can still perform an unbounded Lua purge.
it('uses shared age-only retention and bounded purges on both queue defaults and scheduled jobs', async () => {
  const f = fixture(), lifecycle = await startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, f.deps);
  try {
    const expected = { attempts: 1,
      removeOnComplete: { age: R.completedJobAgeSec, limit: R.completedJobPurgeMax },
      removeOnFail: { age: R.failedJobAgeSec, limit: R.failedJobPurgeMax } };
    const defaults = f.deps.createQueue.mock.calls[0]![1].defaultJobOptions;
    const scheduled = f.queue.upsertJobScheduler.mock.calls[0]![2].opts;
    for (const options of [defaults, scheduled]) {
      expect(options).toEqual(expected);
      expect(options).not.toHaveProperty('count');
      expect(options).not.toHaveProperty('removeOnComplete.count');
      expect(options).not.toHaveProperty('removeOnFail.count');
    }
  } finally { await lifecycle!.close(); }
});

// S6-S1: the existing global queue lease spans a bounded refusal cooldown.
// review bc3f47ad rules 60 seconds; these preserved cases are the spec.
// Authored/unrun: the constants hunk still needs Cedar3's serial composition.
describe('S6-S1 worker policy pin and refusal cooldown', () => {
  it('forwards the configured issuer public key independently to the live core', async () => {
    const f = fixture(), lifecycle = await startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, f.deps);
    try {
      expect(f.deps.createCrank).toHaveBeenCalledWith(expect.objectContaining({
        issuerPublicKey: policyKey.publicKey.toBase58(), dryRun: false,
      }));
    } finally { await lifecycle!.close(); }
  });
  it('keeps a refused job active for 60 seconds without issuing again in that job', async () => {
    const f = fixture(), entered = gate(), resume = gate();
    const held = { status: 'held' as const, actions: [], signature: null,
      alarms: [{ code: 'ISSUER_REFUSED' as const, round: '0', spots: [2], auctionStart: '1780000000' }] };
    f.runOnce.mockResolvedValueOnce(held);
    f.deps.waitForNextPoll.mockImplementationOnce(async (_ms, signal) => {
      entered.release(); await resume.promise; signal.throwIfAborted();
    });
    const lifecycle = await startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, f.deps);
    let finished = false;
    const active = f.dispatch().then(value => { finished = true; return value; });
    try {
      // RED returns early on the predecessor; this assertion fails promptly
      // instead of hanging forever waiting for a cooldown never entered.
      expect(await Promise.race([entered.promise.then(() => 'waiting'), active.then(() => 'returned')])).toBe('waiting');
      expect(finished).toBe(false); expect(f.runOnce).toHaveBeenCalledTimes(1);
      expect(f.deps.waitForNextPoll).toHaveBeenCalledWith(60_000, expect.any(AbortSignal));
      expect(f.deps.createWorker).toHaveBeenCalledTimes(1); expect(f.deps.createCrank).toHaveBeenCalledTimes(1);
      resume.release(); expect(await active).toEqual(held);
      expect(f.runOnce).toHaveBeenCalledTimes(1); expect(f.deps.waitForNextPoll).toHaveBeenCalledTimes(1);
    } finally { resume.release(); await active.catch(() => {}); await lifecycle!.close(); }
  });
  it('aborts refusal cooldown on close without deleting the shared scheduler or starting another pass', async () => {
    const f = fixture(), entered = gate();
    f.runOnce.mockResolvedValueOnce({ status: 'held', actions: [], signature: null,
      alarms: [{ code: 'ISSUER_REFUSED', round: '0', spots: [2], auctionStart: '1780000000' }] });
    f.deps.waitForNextPoll.mockImplementationOnce(async (_ms, signal) => {
      entered.release(); await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) { reject(Error('cancelled')); return; }
        signal.addEventListener('abort', () => { f.order.push('cooldown-aborted'); reject(Error('cancelled')); }, { once: true });
      });
    });
    const lifecycle = await startSeekerAuctionCrankWorker(loadConfig(enabledEnv), registry, f.deps);
    const active = f.dispatch().then(() => 'returned', () => 'aborted');
    try {
      expect(await Promise.race([entered.promise.then(() => 'waiting'), active])).toBe('waiting');
      await lifecycle!.close(); expect(await active).toBe('aborted');
      expect(f.order.indexOf('cooldown-aborted')).toBeGreaterThanOrEqual(0);
      expect(f.order.indexOf('cooldown-aborted')).toBeLessThan(f.order.indexOf('issuer-close'));
      expect(f.runOnce).toHaveBeenCalledTimes(1); expect(f.queue.removeJobScheduler).not.toHaveBeenCalled();
      expect(f.queue.drain).not.toHaveBeenCalled(); expect(f.deps.createWorker).toHaveBeenCalledTimes(1);
    } finally { await lifecycle!.close(); await active; }
  });
});
