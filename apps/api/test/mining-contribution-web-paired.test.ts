/** Actual authenticated HTTP + SQL, with the production browser transport,
 * controller and durable journal. Opening materials are synthetic fixture stock. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { valueMiningContribution, type MiningContributionLine } from '@shardkeep/shared/miningContribution';
import type { MiningContributionEnvelope, MiningContributionRequest } from '@shardkeep/shared/miningContributionApi';
import { describe, expect, it, vi } from 'vitest';

type Operation = { command: { request: MiningContributionRequest }; attemptRevision: number | null;
  proof: Extract<MiningContributionEnvelope, { status: 'accepted' }> | null };
type Journal = { operation: Operation | null; archives: { operation: Operation; reason: string }[] };
type Store = { read(): Promise<Journal>; close(): Promise<void> };
type Controller = { begin(baseId: string, lines: MiningContributionLine[]): Promise<void>; confirm(): Promise<void>;
  open(): Promise<void>; finish(): Promise<void>; abandonDraft(): Promise<void>; snapshot(): { error: string | null; review: unknown } };
const { MiningContributionController } = await vi.importActual<{ MiningContributionController: new (store: Store, ports: object) => Controller }>('../../web/src/lib/miningContribution/controller');
const { MiningContributionJournalStore } = await vi.importActual<{ MiningContributionJournalStore: new (identity: unknown, factory: unknown) => Store }>('../../web/src/lib/miningContribution/journal');
const { createMiningContributionBrowserPorts, miningContributionIdentity } = await vi.importActual<{
  createMiningContributionBrowserPorts(input: object): object; miningContributionIdentity(wallet: string): unknown;
}>('../../web/src/lib/miningContribution/browser');
const { API_URL } = await vi.importActual<{ API_URL: string }>('../../web/src/lib/api');
const { useApp } = await vi.importActual<{ useApp: { getState(): {
  setAuth(wallet: string | null): void; setSelectedBaseId(baseId: string | null, persist: boolean): void;
} } }>('../../web/src/state/store');
const { IDBFactory } = createRequire(new URL('../../web/package.json', import.meta.url))('fake-indexeddb') as { IDBFactory: new () => unknown };
const origin = 'http://localhost:4173';
type Started = { wallet: string; baseId: string; day: string; sessionCookie: string; apiOrigin: string };
type Inspection = { posts: number; receipts: { id: string; total_value: string }[]; shards: string;
  original: MiningContributionEnvelope; raw: { resource_id: string; available: string; mining_pending: string }[] };

async function paired(run: (f: Started, command: <T>(body: object) => Promise<T>) => Promise<void>): Promise<void> {
  const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = '/phase_e_native_web_mining_test';
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/miningContributionApiFixture.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, NODE_ENV: 'test', PHASE_E_NATIVE_PAIRED: '1', PHASE_E_NATIVE_TEST_DATABASE_URL: url.toString() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', part => { stderr = (stderr + String(part)).slice(-4096); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  async function command<T>(body: object): Promise<T> {
    child.stdin.write(`${JSON.stringify(body)}\n`);
    for (;;) {
      const line = await output.next();
      if (line.done) throw Error(`Paired fixture closed before answering: ${stderr}`);
      if (!line.value.startsWith('MINING_CONTRIBUTION_FIXTURE:')) continue;
      const result = JSON.parse(line.value.slice('MINING_CONTRIBUTION_FIXTURE:'.length)) as T & { error?: string };
      if (result.error) throw Error(result.error); return result;
    }
  }
  // Bound a broken child without leaving the disposable SQL instance alive forever.
  const deadline = setTimeout(() => child.kill('SIGTERM'), 110_000);
  try { await run(await command<Started>({ op: 'start', origin, listen: true }), command); }
  finally {
    try { if (child.exitCode === null && !child.killed) await command({ op: 'close' }); }
    finally { child.stdin.end(); const code = await exited; clearTimeout(deadline); expect(code, stderr).toBe(0); }
  }
}

async function browser(f: Started, run: (context: { client(): { store: Store; controller: Controller };
  posts: { status: number; journal: Journal }[]; loseNextReply(): void }) => Promise<void>): Promise<void> {
  const fetchHttp = globalThis.fetch, factory = new IDBFactory(), stores: Store[] = [];
  const posts: { status: number; journal: Journal }[] = []; let activeStore: Store, loseReply = false;
  vi.stubGlobal('window', { location: { origin } });
  vi.stubGlobal('navigator', { locks: { request: async <T>(name: string, _options: unknown, perform: (lock: { name: string }) => Promise<T>) => perform({ name }) } });
  useApp.getState().setAuth(f.wallet); useApp.getState().setSelectedBaseId(f.baseId, false);
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const target = new URL(String(input)), method = init?.method ?? 'GET';
    if (target.origin !== new URL(API_URL).origin || method !== 'GET' && method !== 'POST') throw Error('Unexpected paired browser request');
    const headers = new Headers(init?.headers); headers.set('origin', origin);
    if (init?.credentials === 'include') headers.set('cookie', f.sessionCookie);
    const journal = method === 'POST' ? await activeStore.read() : null;
    // This is an actual HTTP response from buildApp, not a fabricated endpoint body.
    const response = await fetchHttp(`${f.apiOrigin}${target.pathname}${target.search}`, { ...init, headers });
    if (method === 'POST') {
      posts.push({ status: response.status, journal: journal! });
      if (loseReply) { loseReply = false; await response.arrayBuffer(); throw Error('Lost response after actual API acceptance'); }
    }
    return response;
  });
  const client = () => {
    const identity = miningContributionIdentity(f.wallet), store = new MiningContributionJournalStore(identity, factory);
    activeStore = store; stores.push(store);
    return { store, controller: new MiningContributionController(store, createMiningContributionBrowserPorts({ identity,
      lifecycle: () => ({ active: true, visible: true, epoch: 0, actionsEnabled: true }) })) };
  };
  try { await run({ client, posts, loseNextReply: () => { loseReply = true; } }); }
  finally { await Promise.all(stores.map(store => store.close())); useApp.getState().setAuth(null); vi.unstubAllGlobals(); }
}

describe('paired ordinary resource mining browser', () => {
  it('saves before POST and recovers a lost real acceptance after pause and transfer with no second debit', async () => paired(async (f, command) => browser(f, async web => {
    const lines: MiningContributionLine[] = [{ resourceId: 'heartwood_logs', quantity: '3' }, { resourceId: 'frostglass', quantity: '2' }, { resourceId: 'shards', quantity: '100' }];
    const started = web.client(); await started.controller.begin(f.baseId, lines);
    expect(started.controller.snapshot().error).toBeNull(); expect(started.controller.snapshot().review).not.toBeNull();
    const request = (await started.store.read()).operation!.command.request;
    web.loseNextReply(); await started.controller.confirm();
    expect(started.controller.snapshot().error).toContain('Lost response');
    expect(web.posts).toHaveLength(1); expect(web.posts[0]!.status).toBe(201);
    expect(web.posts[0]!.journal.operation!.command.request).toEqual(request);
    expect(web.posts[0]!.journal.operation!.attemptRevision).not.toBeNull();
    expect((await started.store.read()).operation!.proof).toBeNull();
    const before = await command<Inspection>({ op: 'inspect', key: request.idempotencyKey });
    expect(before.receipts).toEqual([{ id: request.idempotencyKey, total_value: valueMiningContribution(lines, request.policyVersion).totalValue }]);
    expect(before.shards).toBe('29900');
    expect(before.raw.find(row => row.resource_id === 'heartwood_logs')).toMatchObject({ available: '997', mining_pending: '3' });
    await command({ op: 'pause', paused: true }); await command({ op: 'transfer' });
    useApp.getState().setSelectedBaseId(null, false);
    const recovered = web.client(); await recovered.controller.open();
    expect(recovered.controller.snapshot().error).toBeNull();
    expect((await recovered.store.read()).operation!.proof).toMatchObject({ status: 'accepted', receipt: { request }, settlement: null });
    await recovered.controller.confirm(); await recovered.controller.finish();
    expect(recovered.controller.snapshot().error).toBeNull();
    const archived = await recovered.store.read(); expect(archived.operation).toBeNull();
    expect(archived.archives).toHaveLength(1); expect(archived.archives[0]!.operation.proof!.receipt.request).toEqual(request);
    await web.client().controller.open();
    const after = await command<Inspection>({ op: 'inspect', key: request.idempotencyKey });
    expect(after.posts).toBe(1); expect(after.receipts).toEqual(before.receipts); expect(after.shards).toBe(before.shards); expect(after.raw).toEqual(before.raw);
    expect(web.posts).toHaveLength(1);
  })), 120_000);

  it('rejects stale UTC-day consent before POST and requires explicit draft abandonment before a fresh basket', async () => paired(async (f, command) => browser(f, async web => {
    const client = web.client(), lines: MiningContributionLine[] = [{ resourceId: 'shards', quantity: '100' }];
    await client.controller.begin(f.baseId, lines); expect(client.controller.snapshot().error).toBeNull();
    const original = (await client.store.read()).operation!.command.request;
    const next = await command<{ day: string }>({ op: 'day', offsetDays: 1 });
    await client.controller.confirm(); expect(client.controller.snapshot().error).toContain('day or policy changed');
    expect(web.posts).toHaveLength(0); expect((await client.store.read()).operation).toMatchObject({ command: { request: original }, attemptRevision: null });
    await client.controller.open(); await client.controller.begin(f.baseId, lines);
    expect(client.controller.snapshot().error).toContain('Recover the saved contribution');
    const unchanged = await command<Inspection>({ op: 'inspect' }); expect(unchanged.receipts).toHaveLength(0); expect(unchanged.shards).toBe('30000');
    await client.controller.abandonDraft(); expect(client.controller.snapshot().error).toBeNull();
    await client.controller.begin(f.baseId, lines); await client.controller.confirm(); expect(client.controller.snapshot().error).toBeNull();
    const journal = await client.store.read(); expect(journal.archives).toHaveLength(1); expect(journal.archives[0]!.reason).toBe('unattempted');
    expect(journal.operation!.command.request.expectedDay).toBe(next.day);
    expect(journal.operation!.command.request.idempotencyKey).not.toBe(original.idempotencyKey);
    expect(journal.operation!.proof).toMatchObject({ status: 'accepted', receipt: { day: next.day } });
    const accepted = await command<Inspection>({ op: 'inspect' }); expect(accepted.posts).toBe(1); expect(accepted.receipts).toHaveLength(1); expect(accepted.shards).toBe('29900');
  })), 120_000);
});
