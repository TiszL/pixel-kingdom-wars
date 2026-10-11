/** N2 C1 / F5: owns one local validator. Importing this module has no side effects.
 * No actor keys are created, read, serialized or accepted here: argv contains only
 * the caller's public admin address and the two reviewed public ELF paths. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Connection, PublicKey, TransactionExpiredBlockheightExceededError, type AccountInfo, type FetchFn, type Commitment,
  type TransactionConfirmationStrategy } from '@solana/web3.js';

export const LEAGUE_RPC_URL = 'http://127.0.0.1:18899';
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const LEAGUE_ID = '2x3PP9GeyvcwvrBCwAjYacTaaLRMhXbzBnRLDAWtninE';
const CORE_ID = 'mYYQFnpyGofG31y5oJkiKVmNwifbSXBMnQ5aUgQkL6b';
// Fixture lifecycle limits, not game policy or production transaction settings.
const READINESS_MS = 60_000, RPC_MS = 5_000, STOP_MS = 5_000, POLL_MS = 100;

export interface LeagueValidatorInput {
  programsDirectory: string;
  admin: PublicKey;
  leagueProgramId: PublicKey;
  coreProgramId: PublicKey;
  leagueElfPath: string;
  coreElfPath: string;
  leagueElf: Buffer;
  coreElf: Buffer;
}
type ProcessEvent = 'SIGINT' | 'SIGTERM' | 'exit';
export interface LeagueLifecycleDependencies {
  readValidatorVersion(cwd: string): { status: number | null; signal: NodeJS.Signals | null; stdout: string; error?: Error };
  probePort(port: number, transport: 'tcp' | 'udp'): Promise<void>;
  createLedger(): Promise<string>;
  removeLedger(directory: string): Promise<void>;
  spawnValidator(args: string[], cwd: string): ChildProcess;
  createConnection(fetch: FetchFn, lifetime: AbortSignal): Connection;
  closeConnection(connection: Connection): void;
  fetch: FetchFn;
  now(): number;
  delay(milliseconds: number): Promise<void>;
  schedule(milliseconds: number, callback: () => void): () => void;
  onProcess(event: ProcessEvent, callback: () => void): () => void;
  exit(code: number): void;
}

/** Probe without adopting or terminating the occupant. Port races are additionally
 * caught by child-liveness and genesis-program authority/ELF checks at readiness. */
function probePort(port: number, transport: 'tcp' | 'udp'): Promise<void> {
  return new Promise((accept, reject) => {
    let finished = false;
    const tcp = transport === 'tcp' ? createServer() : undefined;
    const udp = transport === 'udp' ? createSocket('udp4') : undefined;
    const close = () => { try { tcp?.close(); } catch {} try { udp?.close(); } catch {} };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); close();
      if (error) reject(error); else accept();
    };
    const timer = setTimeout(() => finish(new Error(`League ${transport} port ${port} probe timed out`)), 2000);
    const unavailable = () => finish(new Error(`League ${transport} port ${port} is unavailable; no existing process was touched`));
    if (tcp) {
      tcp.once('error', unavailable);
      tcp.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        if (finished) { close(); return; }
        tcp.close(error => finish(error ?? undefined));
      });
    } else {
      udp!.once('error', unavailable);
      udp!.bind({ address: '127.0.0.1', port, exclusive: true }, () => {
        if (finished) { close(); return; }
        udp!.close(() => finish());
      });
    }
  });
}

/** Pinned web3.js 1.98.4 has no public Connection.dispose(). This adapter only
 * shuts down the Connection made below. Its @internal socket/heartbeat/idle
 * fields are present in the installed SDK sources. The socket's documented
 * setAutoReconnect(false) alone does not cancel an already queued reconnect.
 * Never apply this adapter to a caller's/shared Connection. */
export function closeOwnedLeagueConnection(connection: Connection): void {
  const owned = connection as unknown as {
    _rpcWebSocket: {
      connect: () => void;
      setAutoReconnect(value: boolean): void;
      removeAllListeners(): void;
      on(event: string, callback: () => void): void;
      close(code: number): void;
      reconnect_timer_id?: ReturnType<typeof setTimeout>;
    };
    _rpcWebSocketHeartbeat: ReturnType<typeof setInterval> | null;
    _rpcWebSocketIdleTimeout: ReturnType<typeof setTimeout> | null;
    _updateSubscriptions: () => Promise<void>;
  };
  owned._updateSubscriptions = async () => {};
  const socket = owned._rpcWebSocket;
  socket.setAutoReconnect(false); socket.connect = () => {};
  if (socket.reconnect_timer_id !== undefined) clearTimeout(socket.reconnect_timer_id);
  if (owned._rpcWebSocketHeartbeat !== null) clearInterval(owned._rpcWebSocketHeartbeat);
  if (owned._rpcWebSocketIdleTimeout !== null) clearTimeout(owned._rpcWebSocketIdleTimeout);
  owned._rpcWebSocketHeartbeat = null; owned._rpcWebSocketIdleTimeout = null;
  socket.removeAllListeners(); socket.on('error', () => {}); socket.close(1000);
}

const defaults: LeagueLifecycleDependencies = {
  readValidatorVersion: cwd => spawnSync('solana-test-validator', ['--version'], {
    cwd, encoding: 'utf8', shell: false, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 4096,
    stdio: ['ignore', 'pipe', 'ignore'],
  }),
  probePort,
  createLedger: () => mkdtemp(join(tmpdir(), 'shardkeep-league-fixture-')),
  removeLedger: directory => rm(directory, { recursive: true, force: true }),
  spawnValidator: (args, cwd) => spawn('solana-test-validator', args, {
    cwd, stdio: 'ignore', shell: false,
  }),
  createConnection: (fetch, lifetime) => {
    const connection = new Connection(LEAGUE_RPC_URL, {
      commitment: 'confirmed', wsEndpoint: 'ws://127.0.0.1:18900',
      fetch, httpAgent: false, disableRetryOnRateLimit: true, confirmTransactionInitialTimeout: 60_000,
    });
    installLeagueConfirmationCancellation(connection, lifetime);
    return connection;
  },
  closeConnection: closeOwnedLeagueConnection,
  fetch: (resource, init) => globalThis.fetch(resource, init),
  now: () => Date.now(),
  delay: milliseconds => new Promise(accept => setTimeout(accept, milliseconds)),
  schedule: (milliseconds, callback) => { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); },
  onProcess: (event, callback) => { process.on(event, callback); return () => { process.removeListener(event, callback); }; },
  exit: code => { process.exit(code); },
};

/** Only for the Connection this fixture owns. Its two used confirmation forms
 * poll actual HTTP status with bounded, cancellable awaits. Never enter the SDK
 * confirmation helper: web3.js 1.98.4 starts a detached status request whose
 * rejection on shutdown is unhandled. Durable nonce strategies are unused and
 * explicitly refused. No result is admitted below its requested commitment. */
export function installLeagueConfirmationCancellation(connection: Connection, lifetime: AbortSignal,
  runtime: Pick<LeagueLifecycleDependencies, 'now' | 'delay' | 'schedule'> = defaults): void {
  connection.confirmTransaction = (async (strategy: string | TransactionConfirmationStrategy, commitment?: Commitment) => {
    if (lifetime.aborted) throw lifetime.reason ?? new Error('Owned league connection disposed');
    let signature: string, lastValidBlockHeight: number | undefined, caller: AbortSignal | undefined;
    if (typeof strategy === 'string') {
      signature = strategy;
    } else {
      if (!strategy || !('lastValidBlockHeight' in strategy)
        || 'nonceAccountPubkey' in strategy || typeof strategy.blockhash !== 'string' || !strategy.blockhash
        || !Number.isSafeInteger(strategy.lastValidBlockHeight) || strategy.lastValidBlockHeight < 0) {
        throw new Error('Unsupported or malformed league confirmation strategy');
      }
      signature = strategy.signature; lastValidBlockHeight = strategy.lastValidBlockHeight; caller = strategy.abortSignal;
    }
    if (typeof signature !== 'string' || !signature) throw new Error('Malformed league confirmation strategy signature');
    if (caller?.aborted) throw caller.reason ?? new Error('League confirmation caller cancelled');
    const requested = commitment ?? connection.commitment ?? 'finalized';
    const final = ['finalized', 'root', 'max'].includes(requested);
    const confirmed = ['confirmed', 'single', 'singleGossip'].includes(requested);
    if (!final && !confirmed && !['processed', 'recent'].includes(requested)) throw new Error('Unsupported league confirmation commitment');
    const cancellation = new AbortController();
    const abortLifetime = () => cancellation.abort(lifetime.reason ?? new Error('Owned league connection disposed'));
    const abortCaller = () => cancellation.abort(caller?.reason ?? new Error('League confirmation caller cancelled'));
    lifetime.addEventListener('abort', abortLifetime, { once: true });
    caller?.addEventListener('abort', abortCaller, { once: true });
    if (lifetime.aborted) abortLifetime();
    if (caller?.aborted) abortCaller();
    const cancel = runtime.schedule(READINESS_MS, () => cancellation.abort(new Error('Owned league confirmation deadline expired')));
    const until = runtime.now() + READINESS_MS;
    const checkCancelled = () => { if (cancellation.signal.aborted) throw cancellation.signal.reason; };
    const wait = <T>(operation: () => Promise<T>): Promise<T> => new Promise((accept, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true; cancellation.signal.removeEventListener('abort', abort); complete();
      };
      const abort = () => finish(() => reject(cancellation.signal.reason));
      cancellation.signal.addEventListener('abort', abort, { once: true });
      if (cancellation.signal.aborted) { abort(); return; }
      // Both handlers remain attached if cancellation wins. A pending guarded
      // fetch can later reject without creating an unhandled detached task.
      try { operation().then(value => finish(() => accept(value)), error => finish(() => reject(error))); }
      catch (error) { finish(() => reject(error)); }
    });
    try {
      while (runtime.now() < until) {
        checkCancelled();
        const result = await wait(() => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }));
        checkCancelled();
        const status = result.value[0];
        if (status) {
          const finalized = status.confirmationStatus === 'finalized'
            || (status.confirmationStatus === undefined && status.confirmations === null);
          const confirmedStatus = finalized || status.confirmationStatus === 'confirmed'
            || (status.confirmationStatus === undefined && status.confirmations !== null && status.confirmations > 0);
          if ((!final && !confirmed) || (final && finalized) || (confirmed && confirmedStatus)) {
            return { context: result.context, value: { err: status.err } };
          }
        }
        if (lastValidBlockHeight !== undefined) {
          const height = await wait(() => connection.getBlockHeight(requested));
          checkCancelled();
          if (height > lastValidBlockHeight) throw new TransactionExpiredBlockheightExceededError(signature);
        }
        await wait(() => runtime.delay(POLL_MS));
      }
      throw new Error('Owned league confirmation deadline expired');
    } finally {
      cancel(); lifetime.removeEventListener('abort', abortLifetime); caller?.removeEventListener('abort', abortCaller);
    }
  }) as Connection['confirmTransaction'];
}

/** The bootstrap calls this before generating its seven in-memory actors.
 * startLeagueValidator repeats it immediately before allocating its child. */
export async function assertLeaguePortsAvailable(dependencies: LeagueLifecycleDependencies = defaults): Promise<void> {
  for (const port of [18899, 18900, 18902]) await dependencies.probePort(port, 'tcp');
  await dependencies.probePort(18901, 'udp');
  for (let port = 19010; port <= 19035; port++) {
    await dependencies.probePort(port, 'tcp'); await dependencies.probePort(port, 'udp');
  }
}

function validateInput(input: LeagueValidatorInput): void {
  if (!input || typeof input.programsDirectory !== 'string' || !input.programsDirectory.trim()
    || !(input.admin instanceof PublicKey) || input.admin.equals(PublicKey.default)
    || input.leagueProgramId?.toBase58() !== LEAGUE_ID || input.coreProgramId?.toBase58() !== CORE_ID) {
    throw new Error('League validator requires the pinned public program identities and an admin');
  }
  for (const [path, bytes, name] of [
    [input.leagueElfPath, input.leagueElf, 'shardkeep_league.so'],
    [input.coreElfPath, input.coreElf, 'shardkeep_core.so'],
  ] as const) {
    if (typeof path !== 'string' || resolve(path) !== resolve(input.programsDirectory, 'target/deploy', name)
      || !Buffer.isBuffer(bytes) || bytes.length < 4 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error('League validator requires the exact reviewed ELF artifact paths and bytes');
    }
  }
}

function checkProgram(program: AccountInfo<Buffer>, data: AccountInfo<Buffer>, dataAddress: PublicKey, admin: PublicKey, elf: Buffer): void {
  if (!program.owner.equals(LOADER) || !program.executable || program.data.length !== 36
    || program.data.readUInt32LE(0) !== 2 || !program.data.subarray(4, 36).equals(dataAddress.toBuffer())
    || !data.owner.equals(LOADER) || data.executable || data.data.length < 45 + elf.length
    || data.data.readUInt32LE(0) !== 3 || data.data[12] !== 1 || !data.data.subarray(13, 45).equals(admin.toBuffer())
    || !data.data.subarray(45, 45 + elf.length).equals(elf) || !data.data.subarray(45 + elf.length).every(byte => byte === 0)) {
    throw new Error('League validator program identity, upgrade authority or ELF bytes mismatch');
  }
}

export async function startLeagueValidator(input: LeagueValidatorInput, dependencies: LeagueLifecycleDependencies = defaults): Promise<{
  connection: Connection; dispose(): Promise<void>;
}> {
  validateInput(input);
  const deps = dependencies, programsDirectory = resolve(input.programsDirectory);
  const admin = new PublicKey(input.admin.toBytes()), league = new PublicKey(input.leagueProgramId.toBytes()), core = new PublicKey(input.coreProgramId.toBytes());
  const leagueElf = Buffer.from(input.leagueElf), coreElf = Buffer.from(input.coreElf);
  const leagueElfPath = resolve(input.leagueElfPath), coreElfPath = resolve(input.coreElfPath);
  const versionRequirement = 'Require pinned solana-test-validator 2.3.13; no toolchain fallback';
  let version: ReturnType<LeagueLifecycleDependencies['readValidatorVersion']>;
  try { version = deps.readValidatorVersion(programsDirectory); }
  catch { throw new Error(versionRequirement); }
  if (!version || typeof version !== 'object' || version.error !== undefined || version.status !== 0
    || version.signal !== null || typeof version.stdout !== 'string'
    || !/^solana-test-validator 2\.3\.13(?:[ \t]+\([^()\r\n]*\))?$/.test(version.stdout.trim())) {
    throw new Error(versionRequirement);
  }
  await assertLeaguePortsAvailable(deps);
  const ledgerRoot = await deps.createLedger();
  let child: ChildProcess | undefined, connection: Connection | undefined;
  let exited = false, childError: unknown, stopping = false, disposed: Promise<void> | undefined, signalHandled = false;
  const lifetime = new AbortController();
  const controllers = new Set<AbortController>(), unsubscribe: Array<() => void> = [];
  const alive = () => child !== undefined && child.pid !== undefined && !exited && child.exitCode === null && child.signalCode === null;
  const requireAlive = () => { if (stopping || !alive() || childError !== undefined) throw new Error('Owned league validator child is not live'); };
  const abortRequests = () => { for (const controller of controllers) controller.abort(); };

  const rpcFetch: FetchFn = async (resource, init) => {
    requireAlive();
    const url = new URL(typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url);
    if (url.href !== `${LEAGUE_RPC_URL}/`) throw new Error('League RPC must use its fixed loopback endpoint');
    const controller = new AbortController(), upstream = init?.signal;
    const abort = () => controller.abort();
    controllers.add(controller); upstream?.addEventListener('abort', abort, { once: true });
    if (upstream?.aborted) controller.abort();
    const cancel = deps.schedule(RPC_MS, abort);
    try {
      const response = await deps.fetch(url.href, { ...init, signal: controller.signal, redirect: 'error' });
      if (!response.ok || response.redirected) throw new Error('League RPC returned an unsuccessful or redirected response');
      // Keep the timeout active while consuming the body, not just its headers.
      const body = await response.arrayBuffer();
      requireAlive();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      cancel(); upstream?.removeEventListener('abort', abort); controllers.delete(controller); controller.abort();
    }
  };

  const stopConnection = () => { if (connection) { const own = connection; connection = undefined; deps.closeConnection(own); } };
  const waitForExit = async () => {
    const until = deps.now() + STOP_MS;
    while (alive() && deps.now() < until) await deps.delay(POLL_MS);
  };
  const dispose = (): Promise<void> => {
    if (disposed) return disposed;
    stopping = true; lifetime.abort(new Error('Owned league connection disposed')); abortRequests();
    disposed = (async () => {
      const errors: unknown[] = [];
      try { stopConnection(); } catch (error) { errors.push(error); }
      try {
        if (alive()) { child!.kill('SIGTERM'); await waitForExit(); }
        if (alive()) { child!.kill('SIGKILL'); await waitForExit(); }
        if (alive()) throw new Error('Owned league validator child did not exit; ledger retained');
        await deps.removeLedger(ledgerRoot);
      } catch (error) { errors.push(error); }
      finally { for (const remove of unsubscribe.splice(0)) remove(); }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'League validator cleanup failed');
    })();
    return disposed;
  };
  const signal = (code: number) => {
    if (signalHandled) return;
    signalHandled = true;
    void dispose().then(() => deps.exit(code), () => deps.exit(1));
  };
  try {
    unsubscribe.push(deps.onProcess('SIGINT', () => signal(130)), deps.onProcess('SIGTERM', () => signal(143)));
    unsubscribe.push(deps.onProcess('exit', () => {
      stopping = true; lifetime.abort(new Error('Owned league connection disposed')); abortRequests();
      try { stopConnection(); } catch {}
      // exit callbacks cannot await. Never delete a ledger while its child may
      // still be writing. The normal and signal paths above await full cleanup.
      if (alive()) { try { child!.kill('SIGKILL'); } catch {} }
    }));
    child = deps.spawnValidator([
      '--ledger', join(ledgerRoot, 'ledger'), '--rpc-port', '18899', '--faucet-port', '18902',
      '--gossip-port', '18901', '--dynamic-port-range', '19010-19035', '--bind-address', '127.0.0.1',
      '--mint', admin.toBase58(), '--limit-ledger-size', '10000',
      '--upgradeable-program', league.toBase58(), leagueElfPath, admin.toBase58(),
      '--upgradeable-program', core.toBase58(), coreElfPath, admin.toBase58(),
    ], programsDirectory);
    // Keep the once(error) listener attached even when spawn returns no pid:
    // Node reports ENOENT asynchronously, and an unhandled child error is fatal.
    child.once('error', (error: Error) => { childError = error; });
    child.once('exit', () => { exited = true; });
    connection = deps.createConnection(rpcFetch, lifetime.signal);
    const [leagueData] = PublicKey.findProgramAddressSync([league.toBuffer()], LOADER);
    const [coreData] = PublicKey.findProgramAddressSync([core.toBuffer()], LOADER);
    const until = deps.now() + READINESS_MS;
    while (deps.now() < until) {
      requireAlive();
      let accounts: Array<AccountInfo<Buffer> | null> | undefined;
      try { accounts = await connection.getMultipleAccountsInfo([league, leagueData, core, coreData], 'finalized'); }
      catch { requireAlive(); }
      requireAlive();
      if (accounts?.length === 4 && accounts.every(account => account !== null)) {
        checkProgram(accounts[0]!, accounts[1]!, leagueData, admin, leagueElf);
        checkProgram(accounts[2]!, accounts[3]!, coreData, admin, coreElf);
        return { connection, dispose };
      }
      await deps.delay(POLL_MS);
    }
    throw new Error('Owned league validator readiness deadline expired');
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'League validator startup and cleanup failed'); }
    throw error;
  }
}
