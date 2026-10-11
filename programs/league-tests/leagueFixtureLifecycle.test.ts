/** C1 tests first: mocked OS/RPC only. No validator, socket, key or signature. */
import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PublicKey, TransactionExpiredBlockheightExceededError, type Connection, type FetchFn } from '@solana/web3.js';
import {
  assertLeaguePortsAvailable, startLeagueValidator, LEAGUE_RPC_URL,
  installLeagueConfirmationCancellation, closeOwnedLeagueConnection,
  type LeagueLifecycleDependencies, type LeagueValidatorInput,
} from './leagueFixtureLifecycle';

const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const admin = new PublicKey(new Uint8Array(32).fill(31));
const league = new PublicKey('2x3PP9GeyvcwvrBCwAjYacTaaLRMhXbzBnRLDAWtninE');
const core = new PublicKey('mYYQFnpyGofG31y5oJkiKVmNwifbSXBMnQ5aUgQkL6b');
const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]);
const input = (): LeagueValidatorInput => ({
  programsDirectory: '/owned/programs', admin, leagueProgramId: league, coreProgramId: core,
  leagueElfPath: '/owned/programs/target/deploy/shardkeep_league.so',
  coreElfPath: '/owned/programs/target/deploy/shardkeep_core.so', leagueElf: Buffer.from(elf), coreElf: Buffer.from(elf),
});

describe('league owned connection confirmation cancellation / C1', () => {
  it('legacy confirmations wait for the requested confirmed or finalized level even for an error', async () => {
    for (const commitment of ['confirmed', 'finalized'] as const) {
      const h = harness(), lifetime = new AbortController(); let reads = 0;
      const expected = { InstructionError: [0, { Custom: 6007 }] };
      const connection = {
        commitment: 'confirmed', confirmTransaction: async () => { throw new Error('legacy SDK must not open a websocket'); },
        getSignatureStatuses: async () => ({ context: { slot: 42 }, value: [{ slot: 40, confirmations: 1,
          confirmationStatus: ++reads === 1 ? (commitment === 'finalized' ? 'confirmed' : 'processed') : commitment, err: expected }] }),
      } as unknown as Connection;
      installLeagueConfirmationCancellation(connection, lifetime.signal, h.deps);
      const result = await connection.confirmTransaction('mock-public-signature', commitment);
      expect(reads).to.equal(2); expect(result).to.deep.equal({ context: { slot: 42 }, value: { err: expected } });
    }
  });
  it('disposal aborts legacy confirmation polling without an SDK background loop', async () => {
    const h = harness(), lifetime = new AbortController(); let reads = 0;
    const connection = { commitment: 'confirmed', confirmTransaction: async () => { throw new Error('unexpected SDK legacy call'); },
      getSignatureStatuses: async () => { reads++; return { context: { slot: 1 }, value: [null] }; },
    } as unknown as Connection;
    h.deps.delay = async () => { lifetime.abort(new Error('fixture disposed')); };
    installLeagueConfirmationCancellation(connection, lifetime.signal, h.deps);
    expect((await failure(() => connection.confirmTransaction('mock-public-signature', 'finalized'))).message).to.include('disposed');
    expect(reads).to.equal(1);
  });
  it('bounds a legacy confirmation whose status never appears', async () => {
    const h = harness(), lifetime = new AbortController();
    const connection = { commitment: 'confirmed', confirmTransaction: async () => { throw new Error('unexpected SDK legacy call'); },
      getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [null] }),
    } as unknown as Connection;
    installLeagueConfirmationCancellation(connection, lifetime.signal, h.deps);
    expect((await failure(() => connection.confirmTransaction('mock-public-signature', 'finalized'))).message).to.include('deadline');
    expect(h.state.clock).to.equal(60000);
  });
  it('polls blockheight strategies without SDK confirmation and admits errors only at requested finality', async () => {
    for (const commitment of ['confirmed', 'finalized'] as const) {
      const h = harness(), lifetime = new AbortController(); let reads = 0, heights = 0, sdkCalls = 0;
      const expected = { InstructionError: [0, { Custom: 6007 }] };
      const strategy = Object.freeze({ signature: 'mock-public-signature', blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 42 });
      const connection = {
        confirmTransaction: async () => { sdkCalls++; throw new Error('SDK confirmation must never be invoked'); },
        getSignatureStatuses: async (signatures: string[], options: unknown) => {
          expect(signatures).to.deep.equal([strategy.signature]); expect(options).to.deep.equal({ searchTransactionHistory: true });
          return { context: { slot: 42 }, value: [{ slot: 40, confirmations: 1,
            confirmationStatus: ++reads === 1 ? (commitment === 'finalized' ? 'confirmed' : 'processed') : commitment, err: expected }] };
        },
        getBlockHeight: async (requested: string) => { heights++; expect(requested).to.equal(commitment); return 42; },
      } as unknown as Connection;
      installLeagueConfirmationCancellation(connection, lifetime.signal, h.deps);
      const result = await connection.confirmTransaction(strategy, commitment);
      expect(result).to.deep.equal({ context: { slot: 42 }, value: { err: expected } });
      expect(reads).to.equal(2); expect(heights).to.equal(1); expect(sdkCalls).to.equal(0); expect(h.timers.size).to.equal(0);
    }
  });
  it('preserves a caller abort signal on a blockheight confirmation', async () => {
    const h = harness(), lifetime = new AbortController(), caller = new AbortController();
    let rejectStatus!: (error: Error) => void, sdkCalls = 0;
    const connection = {
      confirmTransaction: async () => { sdkCalls++; throw new Error('SDK confirmation must never be invoked'); },
      getSignatureStatuses: () => new Promise((_accept, reject) => { rejectStatus = reject; }),
    } as unknown as Connection;
    installLeagueConfirmationCancellation(connection, lifetime.signal, h.deps);
    const result = failure(() => connection.confirmTransaction({ signature: 'mock', blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 42, abortSignal: caller.signal }, 'confirmed'));
    caller.abort(new Error('caller cancelled'));
    expect((await result).message).to.include('caller cancelled'); expect(h.timers.size).to.equal(0);
    // The cancelled race must retain a rejection handler on the pending RPC.
    rejectStatus(new Error('later transport abort')); await Promise.resolve(); expect(sdkCalls).to.equal(0);
  });
  it('adds a finite deadline to a pending blockheight status request', async () => {
    const h = harness(), lifetime = new AbortController();
    let rejectStatus!: (error: Error) => void;
    const connection = {
      confirmTransaction: async () => { throw new Error('SDK confirmation must never be invoked'); },
      getSignatureStatuses: () => new Promise((_accept, reject) => { rejectStatus = reject; }),
    } as unknown as Connection;
    installLeagueConfirmationCancellation(connection, lifetime.signal, h.deps);
    const result = failure(() => connection.confirmTransaction({ signature: 'mock', blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 42 }));
    [...h.timers][0](); expect((await result).message).to.include('deadline'); expect(h.timers.size).to.equal(0);
    rejectStatus(new Error('later transport abort')); await Promise.resolve();
  });
  it('disposal cancels an in-flight guarded status request for both forms without invoking the SDK', async () => {
    for (const strategy of ['mock-public-signature', { signature: 'mock-public-signature',
      blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 42 }]) {
      const h = harness(); let sdkCalls = 0, rpcStarted = false;
      h.deps.fetch = (async (_url, init) => await new Promise<Response>((_accept, reject) => {
        rpcStarted = true;
        init?.signal?.addEventListener('abort', () => reject(new Error('guarded HTTP disposed')), { once: true });
      })) as FetchFn;
      h.connection.confirmTransaction = (async () => { sdkCalls++; throw new Error('SDK confirmation must never be invoked'); }) as Connection['confirmTransaction'];
      h.deps.createConnection = (fetch, lifetime) => {
        h.connection.getSignatureStatuses = async () => {
          await fetch(LEAGUE_RPC_URL, { method: 'POST', body: '{}' });
          throw new Error('aborted HTTP must not resolve');
        };
        installLeagueConfirmationCancellation(h.connection, lifetime, h.deps); return h.connection;
      };
      const handle = await startLeagueValidator(input(), h.deps);
      const result = failure(() => typeof strategy === 'string'
        ? handle.connection.confirmTransaction(strategy, 'finalized')
        : handle.connection.confirmTransaction(strategy, 'finalized'));
      expect(rpcStarted).to.equal(true); await handle.dispose();
      expect((await result).message).to.include('disposed');
      expect(sdkCalls).to.equal(0); expect(h.timers.size).to.equal(0);
    }
  });
  it('uses the SDK expiry error only when height exceeds the exact last-valid boundary', async () => {
    const h = harness(), lifetime = new AbortController(); let heightReads = 0;
    const connection = {
      confirmTransaction: async () => { throw new Error('unexpected SDK call'); },
      getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [null] }),
      getBlockHeight: async (commitment: string) => { expect(commitment).to.equal('finalized'); return ++heightReads === 1 ? 42 : 43; },
    } as unknown as Connection;
    installLeagueConfirmationCancellation(connection, lifetime.signal, h.deps);
    const error = await failure(() => connection.confirmTransaction({ signature: 'mock-public-signature',
      blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 42 }, 'finalized'));
    expect(error).to.be.instanceOf(TransactionExpiredBlockheightExceededError);
    expect((error as TransactionExpiredBlockheightExceededError).signature).to.equal('mock-public-signature');
    expect(heightReads).to.equal(2); expect(h.state.clock).to.equal(100); expect(h.timers.size).to.equal(0);
  });
  it('preserves status and height transport errors without synthesizing chain state', async () => {
    for (const method of ['getSignatureStatuses', 'getBlockHeight'] as const) {
      const h = harness(), lifetime = new AbortController(), expected = new Error(`failed ${method}`);
      const connection = {
        confirmTransaction: async () => { throw new Error('unexpected SDK call'); },
        getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [null] }),
        getBlockHeight: async () => 42,
        [method]: async () => { throw expected; },
      } as unknown as Connection;
      installLeagueConfirmationCancellation(connection, lifetime.signal, h.deps);
      expect(await failure(() => connection.confirmTransaction({ signature: 'mock', blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 42 }, 'confirmed'))).to.equal(expected);
      expect(h.timers.size).to.equal(0);
    }
  });
  it('cancels an in-flight blockheight request and handles its later rejection', async () => {
    const h = harness(), lifetime = new AbortController();
    let rejectHeight!: (error: Error) => void, started!: () => void;
    const heightStarted = new Promise<void>(accept => { started = accept; });
    const connection = {
      confirmTransaction: async () => { throw new Error('unexpected SDK call'); },
      getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [null] }),
      getBlockHeight: () => new Promise((_accept, reject) => { rejectHeight = reject; started(); }),
    } as unknown as Connection;
    installLeagueConfirmationCancellation(connection, lifetime.signal, h.deps);
    const result = failure(() => connection.confirmTransaction({ signature: 'mock', blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 42 }));
    await heightStarted; lifetime.abort(new Error('fixture disposed'));
    expect((await result).message).to.include('disposed');
    rejectHeight(new Error('later height transport abort')); await Promise.resolve(); expect(h.timers.size).to.equal(0);
  });
  it('refuses unsupported durable-nonce and malformed blockheight strategies before RPC', async () => {
    for (const strategy of [
      { signature: 'mock', nonceAccountPubkey: admin, nonceValue: 'mock', minContextSlot: 1 },
      { signature: 'mock', blockhash: 'mock', lastValidBlockHeight: -1 },
      { signature: 'mock', blockhash: 'mock', lastValidBlockHeight: 1.5 },
    ]) {
      const h = harness(), lifetime = new AbortController(); let calls = 0;
      const connection = { confirmTransaction: async () => { calls++; },
        getSignatureStatuses: async () => { calls++; }, getBlockHeight: async () => { calls++; },
      } as unknown as Connection;
      installLeagueConfirmationCancellation(connection, lifetime.signal, h.deps);
      expect((await failure(() => connection.confirmTransaction(strategy, 'confirmed'))).message).to.include('strategy');
      expect(calls).to.equal(0); expect(h.timers.size).to.equal(0);
    }
  });
  it('refuses already-cancelled fixture and caller signals before beginning any RPC', async () => {
    for (const abortFixture of [true, false]) {
      const h = harness(), lifetime = new AbortController(), caller = new AbortController(); let calls = 0;
      const reason = new Error('cancelled before start');
      (abortFixture ? lifetime : caller).abort(reason);
      const connection = { confirmTransaction: async () => { calls++; }, getSignatureStatuses: async () => { calls++; },
      } as unknown as Connection;
      installLeagueConfirmationCancellation(connection, lifetime.signal, h.deps);
      expect(await failure(() => connection.confirmTransaction({ signature: 'mock', blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 42, abortSignal: caller.signal }, 'confirmed'))).to.equal(reason);
      expect(calls).to.equal(0); expect(h.timers.size).to.equal(0);
    }
  });
  it('closes only the owned SDK socket and suppresses future reconnect/subscription work', async () => {
    const calls: string[] = [];
    const socket = { connect: () => { calls.push('connect'); }, setAutoReconnect: (value: boolean) => { calls.push(`reconnect:${value}`); },
      removeAllListeners: () => { calls.push('remove-listeners'); }, on: (event: string) => { calls.push(`on:${event}`); },
      close: (code: number) => { calls.push(`close:${code}`); },
    };
    const connection = { _rpcWebSocket: socket, _rpcWebSocketHeartbeat: null, _rpcWebSocketIdleTimeout: null,
      _updateSubscriptions: async () => { calls.push('subscriptions'); },
    };
    closeOwnedLeagueConnection(connection as unknown as Connection);
    socket.connect(); await connection._updateSubscriptions();
    expect(calls).to.deep.equal(['reconnect:false', 'remove-listeners', 'on:error', 'close:1000']);
  });
});
function programAccounts(program: PublicKey) {
  const [dataAddress] = PublicKey.findProgramAddressSync([program.toBuffer()], loader);
  const programData = Buffer.alloc(36); programData.writeUInt32LE(2); dataAddress.toBuffer().copy(programData, 4);
  const data = Buffer.alloc(45 + elf.length + 8); data.writeUInt32LE(3); data[12] = 1;
  admin.toBuffer().copy(data, 13); elf.copy(data, 45);
  return [
    { owner: loader, executable: true, lamports: 1, data: programData },
    { owner: loader, executable: false, lamports: 1, data },
  ];
}
function harness() {
  const calls: string[] = [], listeners = new Map<string, () => void>();
  const timers = new Set<() => void>();
  const child = Object.assign(new EventEmitter(), {
    pid: 321, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill(signal: NodeJS.Signals) {
      calls.push(`kill:${signal}`);
      if (signal === 'SIGKILL' || !state.ignoreTerm) {
        child.signalCode = signal; child.emit('exit', null, signal);
      }
      return true;
    },
  });
  const state = { clock: 0, unavailable: false, ignoreTerm: false, neverExit: false,
    spawnThrows: false, rpcThrows: false, mutate: undefined as ((accounts: ReturnType<typeof programAccounts>) => void) | undefined,
    connectionFetch: undefined as FetchFn | undefined, fetchInputs: [] as Array<{ url: string; init: RequestInit | undefined }>,
    exitCodes: [] as number[], args: [] as string[], cwd: '', removed: [] as string[],
  };
  const connection = {
    async getMultipleAccountsInfo(addresses: PublicKey[], commitment: string) {
      calls.push('accounts'); expect(commitment).to.equal('finalized'); expect(addresses).to.have.length(4);
      if (state.rpcThrows) throw new Error('not ready');
      if (state.unavailable) return [null, null, null, null];
      const accounts = [...programAccounts(league), ...programAccounts(core)];
      state.mutate?.(accounts); return accounts;
    },
  } as unknown as Connection;
  const deps: LeagueLifecycleDependencies = {
    readValidatorVersion: cwd => {
      calls.push('version'); expect(cwd).to.equal('/owned/programs');
      return { status: 0, signal: null, stdout: 'solana-test-validator 2.3.13 (src:mock; feat:0, client:Agave)\n' };
    },
    probePort: async (port, transport) => { calls.push(`probe:${transport}:${port}`); },
    createLedger: async () => { calls.push('ledger'); return '/owned-temp/league-fixture-A'; },
    removeLedger: async (directory) => { calls.push('remove'); state.removed.push(directory); },
    spawnValidator: (args, cwd) => {
      calls.push('spawn'); state.args = args; state.cwd = cwd;
      if (state.spawnThrows) throw new Error('spawn refused');
      return child as unknown as ChildProcess;
    },
    createConnection: (fetch) => { calls.push('connect'); state.connectionFetch = fetch; return connection; },
    closeConnection: (value) => { expect(value).to.equal(connection); calls.push('close-connection'); },
    fetch: (async (url, init) => {
      state.fetchInputs.push({ url: String(url), init });
      return new Response('{}', { status: 200 });
    }) as FetchFn,
    now: () => state.clock,
    delay: async (ms) => { state.clock += ms; calls.push('delay'); },
    schedule: (_ms, callback) => { timers.add(callback); return () => { timers.delete(callback); }; },
    onProcess: (event, callback) => { listeners.set(event, callback); return () => { listeners.delete(event); }; },
    exit: (code) => { state.exitCodes.push(code); },
  };
  return { calls, state, child, deps, listeners, timers, connection };
}
async function failure(action: () => Promise<unknown>): Promise<Error> {
  try { await action(); } catch (error) { return error as Error; }
  throw new Error('Expected lifecycle refusal');
}

describe('league owned validator lifecycle / C1', () => {
  it('checks fixed RPC, websocket, faucet, gossip and dynamic TCP/UDP ports without spawning', async () => {
    const h = harness(); await assertLeaguePortsAvailable(h.deps);
    for (const entry of ['probe:tcp:18899', 'probe:tcp:18900', 'probe:tcp:18902', 'probe:udp:18901',
      'probe:tcp:19010', 'probe:udp:19010', 'probe:tcp:19030', 'probe:udp:19030',
      'probe:tcp:19035', 'probe:udp:19035']) expect(h.calls).to.include(entry);
    expect(h.calls).to.have.length(56); expect(new Set(h.calls).size).to.equal(56);
    expect(h.calls).not.to.include('probe:tcp:19036'); expect(h.calls).not.to.include('probe:udp:19036');
    expect(h.calls).not.to.include('spawn');
  });
  it('refuses a non-pinned validator version before ledger allocation or validator spawning', async () => {
    for (const stdout of ['solana-test-validator 2.3.12', 'solana-test-validator 2.3.130', 'solana-test-validator 2.3.13-dev']) {
      const h = harness(); h.deps.readValidatorVersion = () => ({ status: 0, signal: null, stdout });
      expect((await failure(() => startLeagueValidator(input(), h.deps))).message).to.include('2.3.13');
      expect(h.calls).to.deep.equal([]); expect(h.listeners.size).to.equal(0);
    }
  });
  it('refuses malformed version output and invalid dependency results before acquiring resources', async () => {
    for (const result of [null, undefined, false, {},
      ...['', '2.3.13', 'solana-cli 2.3.13', 'solana-test-validator 2.3.13\nunexpected second line'].map(stdout => ({ status: 0, signal: null, stdout })),
      { status: 0, signal: null, stdout: null }, { status: 0, stdout: 'solana-test-validator 2.3.13' },
    ]) {
      const h = harness();
      h.deps.readValidatorVersion = () => result as ReturnType<LeagueLifecycleDependencies['readValidatorVersion']>;
      expect((await failure(() => startLeagueValidator(input(), h.deps))).message).to.include('2.3.13');
      expect(h.calls).to.deep.equal([]); expect(h.listeners.size).to.equal(0);
    }
  });
  it('refuses failed, timed-out or throwing version commands even when stdout claims the pinned version', async () => {
    for (const failureResult of [{ status: 1, signal: null }, { status: null, signal: 'SIGKILL' as const },
      { status: 0, signal: null, error: new Error('version command failed') }, undefined]) {
      const h = harness(); h.deps.readValidatorVersion = () => {
        if (!failureResult) throw new Error('version command threw');
        return { stdout: 'solana-test-validator 2.3.13', ...failureResult };
      };
      expect((await failure(() => startLeagueValidator(input(), h.deps))).message).to.include('2.3.13');
      expect(h.calls).to.deep.equal([]); expect(h.listeners.size).to.equal(0);
    }
  });
  it('fails on an occupied port before ledger allocation or child acquisition', async () => {
    const h = harness(); h.deps.probePort = async () => { throw new Error('occupied'); };
    expect((await failure(() => startLeagueValidator(input(), h.deps))).message).to.include('occupied');
    expect(h.calls).not.to.include('ledger'); expect(h.calls).not.to.include('spawn');
  });
  it('rejects altered program identities, ELF bytes and artifact paths before acquisition', async () => {
    for (const change of [{ leagueProgramId: core }, { coreProgramId: league }, { leagueElf: Buffer.from([1]) },
      { coreElfPath: '/outside/unreviewed.so' }]) {
      const h = harness(); await failure(() => startLeagueValidator({ ...input(), ...change }, h.deps));
      expect(h.calls).to.deep.equal([]);
    }
  });
  it('spawns exactly its two upgradeable programs on loopback, minting genesis SOL only to the supplied admin', async () => {
    const h = harness(), handle = await startLeagueValidator(input(), h.deps);
    expect(h.calls[0]).to.equal('version');
    expect(h.calls.indexOf('ledger')).to.be.greaterThan(h.calls.indexOf('version'));
    expect(h.calls.indexOf('spawn')).to.be.greaterThan(h.calls.indexOf('version'));
    expect(h.state.cwd).to.equal('/owned/programs');
    expect(h.state.args).to.deep.equal([
      '--ledger', '/owned-temp/league-fixture-A/ledger', '--rpc-port', '18899', '--faucet-port', '18902',
      '--gossip-port', '18901', '--dynamic-port-range', '19010-19035', '--bind-address', '127.0.0.1',
      '--mint', admin.toBase58(), '--limit-ledger-size', '10000',
      '--upgradeable-program', league.toBase58(), input().leagueElfPath, admin.toBase58(),
      '--upgradeable-program', core.toBase58(), input().coreElfPath, admin.toBase58(),
    ]);
    expect(handle.connection).to.equal(h.connection); await handle.dispose();
  });
  it('verifies both loader-owned executable links, admin authority and exact ELF with zero padding', async () => {
    for (const mutate of [
      (a: ReturnType<typeof programAccounts>) => { a[0].owner = admin; },
      (a: ReturnType<typeof programAccounts>) => { a[0].executable = false; },
      (a: ReturnType<typeof programAccounts>) => { a[0].data[4] ^= 1; },
      (a: ReturnType<typeof programAccounts>) => { a[1].data[12] = 0; },
      (a: ReturnType<typeof programAccounts>) => { a[1].data[13] ^= 1; },
      (a: ReturnType<typeof programAccounts>) => { a[1].data[45] ^= 1; },
      (a: ReturnType<typeof programAccounts>) => { a[3].data[a[3].data.length - 1] = 1; },
    ]) {
      const h = harness(); h.state.mutate = mutate;
      expect((await failure(() => startLeagueValidator(input(), h.deps))).message).to.include('identity');
      expect(h.calls).to.include('kill:SIGTERM'); expect(h.state.removed).to.deep.equal(['/owned-temp/league-fixture-A']);
    }
  });
  it('bounds missing-program readiness and cleans the child and ledger before rejecting', async () => {
    const h = harness(); h.state.unavailable = true;
    expect((await failure(() => startLeagueValidator(input(), h.deps))).message).to.include('readiness');
    expect(h.state.clock).to.be.at.most(65000); expect(h.calls).to.include('kill:SIGTERM');
    expect(h.listeners.size).to.equal(0); expect(h.state.removed).to.have.length(1);
  });
  it('bounds transport failures during readiness instead of attaching to an unrelated endpoint', async () => {
    const h = harness(); h.state.rpcThrows = true;
    expect((await failure(() => startLeagueValidator(input(), h.deps))).message).to.include('readiness');
    expect(h.state.removed).to.have.length(1);
  });
  it('removes its fresh directory when spawn throws, without sending any signal', async () => {
    const h = harness(); h.state.spawnThrows = true;
    expect((await failure(() => startLeagueValidator(input(), h.deps))).message).to.include('spawn refused');
    expect(h.calls.some((call) => call.startsWith('kill:'))).to.equal(false);
    expect(h.state.removed).to.deep.equal(['/owned-temp/league-fixture-A']);
  });
  it('refuses readiness if its own child exits even when RPC serves correct-looking accounts', async () => {
    const h = harness(); const original = h.connection.getMultipleAccountsInfo.bind(h.connection);
    h.connection.getMultipleAccountsInfo = async (...args) => {
      const accounts = await original(...args); h.child.exitCode = 1; h.child.emit('exit', 1, null); return accounts;
    };
    expect((await failure(() => startLeagueValidator(input(), h.deps))).message).to.include('child');
    expect(h.calls.some((call) => call.startsWith('kill:'))).to.equal(false);
    expect(h.state.removed).to.have.length(1);
  });
  it('disposes once, closes only its connection, and waits for its child before deleting its ledger', async () => {
    const h = harness(), handle = await startLeagueValidator(input(), h.deps);
    await Promise.all([handle.dispose(), handle.dispose()]);
    expect(h.calls.filter((call) => call === 'kill:SIGTERM')).to.have.length(1);
    expect(h.calls.filter((call) => call === 'close-connection')).to.have.length(1);
    expect(h.state.removed).to.have.length(1); expect(h.listeners.size).to.equal(0);
    expect(h.calls.indexOf('remove')).to.be.greaterThan(h.calls.indexOf('kill:SIGTERM'));
  });
  it('escalates only its stubborn child from TERM to KILL within the cleanup bound', async () => {
    const h = harness(); h.state.ignoreTerm = true;
    const handle = await startLeagueValidator(input(), h.deps); await handle.dispose();
    expect(h.calls.filter((call) => call.startsWith('kill:'))).to.deep.equal(['kill:SIGTERM', 'kill:SIGKILL']);
    expect(h.state.clock).to.be.at.most(10000); expect(h.state.removed).to.have.length(1);
  });
  it('retains the ledger and rejects if even its KILL cannot prove child exit', async () => {
    const h = harness(); h.child.kill = (signal) => { h.calls.push(`kill:${signal}`); return true; };
    const handle = await startLeagueValidator(input(), h.deps);
    expect((await failure(() => handle.dispose())).message).to.include('exit');
    expect(h.state.removed).to.have.length(0); expect(h.listeners.size).to.equal(0);
  });
  it('SIGINT and SIGTERM await owned cleanup before exiting their runner', async () => {
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
      const h = harness(), handle = await startLeagueValidator(input(), h.deps);
      h.listeners.get(signal)!(); await handle.dispose(); await Promise.resolve();
      expect(h.state.exitCodes).to.deep.equal([code]); expect(h.state.removed).to.have.length(1);
    }
  });
  it('synchronous process exit sends only a best-effort KILL to its live child', async () => {
    const h = harness(); await startLeagueValidator(input(), h.deps); h.listeners.get('exit')!();
    expect(h.calls).to.include('kill:SIGKILL'); expect(h.state.removed).to.have.length(0);
  });
  it('RPC refuses redirects and any URL outside its fixed loopback endpoint', async () => {
    const h = harness(), handle = await startLeagueValidator(input(), h.deps), fetch = h.state.connectionFetch!;
    await fetch(LEAGUE_RPC_URL, { method: 'POST', body: '{}' });
    expect(h.state.fetchInputs[0].init?.redirect).to.equal('error');
    expect(h.state.fetchInputs[0].init?.signal).to.be.instanceOf(AbortSignal);
    for (const url of ['https://api.devnet.solana.com', 'http://127.0.0.1:18898', 'http://user:pass@127.0.0.1:18899']) {
      await failure(() => fetch(url));
    }
    expect(h.state.fetchInputs).to.have.length(1); await handle.dispose();
    await failure(() => fetch(LEAGUE_RPC_URL)); expect(h.timers.size).to.equal(0);
  });
  it('aborts pending RPC calls on dispose and clears their deadline timers', async () => {
    const h = harness(); let requestSignal: AbortSignal | null | undefined;
    h.deps.fetch = (async (_url, init) => {
      requestSignal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }) as FetchFn;
    const handle = await startLeagueValidator(input(), h.deps);
    const request = failure(() => h.state.connectionFetch!(LEAGUE_RPC_URL));
    await handle.dispose(); expect((await request).message).to.include('aborted');
    expect(requestSignal?.aborted).to.equal(true); expect(h.timers.size).to.equal(0);
  });
  it('gives each RPC request its own abort deadline', async () => {
    const h = harness();
    h.deps.fetch = (async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('deadline aborted')), { once: true });
    })) as FetchFn;
    const handle = await startLeagueValidator(input(), h.deps);
    const request = failure(() => h.state.connectionFetch!(LEAGUE_RPC_URL));
    [...h.timers][0](); expect((await request).message).to.include('deadline');
    expect(h.timers.size).to.equal(0); await handle.dispose();
  });
});
