import { describe, expect, it } from 'vitest';
import { CandidateExpansion, CANDIDATE_LOCAL_ORIGIN, CANDIDATE_ORIGIN, candidateExpansionBuild,
  validateExpansionState, type ExpansionQuote, type ExpansionRequest, type ExpansionState, type SavedExpansion } from './candidateExpansion';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { origin: CANDIDATE_ORIGIN, sourceSha: 'a'.repeat(40), wallet: '1'.repeat(32), baseId: id(1) };
function quote(request: ExpansionRequest): ExpansionQuote {
  return { version: 1, mode: 'candidate-expansion', origin: scope.origin, sourceSha: scope.sourceSha,
    wallet: scope.wallet, fixtureId: id(2), request, baseEpoch: { landPaidAt: '2026-09-15T00:00:00.000Z', deedAssetId: null },
    offer: { expectedExpansions: request.expectedExpansions, fromClaimTiles: 14, toClaimTiles: 16,
      requiredKeepLevel: 1, referencePriceLamports: '100000000', chargedLamports: '0' },
    createdAt: '2026-09-15T00:00:00.000Z', quoteHash: 'b'.repeat(64) };
}
function harness() {
  const disk = new Map<string, string>(); const requests: { path: string; body: unknown }[] = [];
  let serial = Promise.resolve<unknown>(null); let key = 10; let remote: ExpansionState | null = null;
  let storageFails = false; let responseLost = false; let active = true;
  const ports = {
    storage: { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => {
      if (storageFails) throw new Error('Storage unavailable'); disk.set(k, v);
    } },
    lock: <T>(_name: string, work: () => Promise<T>): Promise<T> => {
      const next = serial.then(work, work); serial = next.catch(() => null); return next;
    },
    assertCurrent: () => { if (!active) throw new Error('Account changed'); }, key: () => id(key++),
    get: async (path: string): Promise<unknown> => {
      requests.push({ path, body: null });
      if (path.includes('/capability')) return { version: 1, mode: 'candidate-expansion', enabled: true, ...scope };
      return structuredClone(remote ?? { version: 1, mode: 'candidate-expansion', wallet: scope.wallet,
        idempotencyKey: path.split('/').at(-1), status: 'unquoted', quote: null, receipt: null });
    },
    post: async (path: string, body: unknown): Promise<unknown> => {
      requests.push({ path, body });
      const durable = JSON.parse(disk.get(client.storageKey)!) as SavedExpansion;
      expect(durable.request.idempotencyKey).toMatch(/0000/);
      if (path.endsWith('/quote')) {
        expect(durable.request).toEqual(body);
        remote = { version: 1, mode: 'candidate-expansion', wallet: scope.wallet, idempotencyKey: durable.request.idempotencyKey,
          status: 'quoted', quote: quote(durable.request), receipt: null };
      } else if (path.endsWith('/confirm')) {
        expect(durable.confirmedHash).toBe(remote!.quote!.quoteHash);
        remote = { ...remote!, status: 'granted', receipt: { version: 1, mode: 'candidate-expansion', id: id(3),
          wallet: scope.wallet, idempotencyKey: durable.request.idempotencyKey, baseId: scope.baseId,
          quoteHash: remote!.quote!.quoteHash, fromExpansions: durable.request.expectedExpansions,
          toExpansions: durable.request.expectedExpansions + 1, fromClaimTiles: 14, toClaimTiles: 16,
          chargedLamports: '0', acceptedAt: '2026-09-15T00:01:00.000Z' } };
      } else if (remote?.status !== 'granted') remote = { version: 1, mode: 'candidate-expansion', wallet: scope.wallet,
        idempotencyKey: durable.request.idempotencyKey, status: 'cancelled', quote: remote?.quote ?? null, receipt: null };
      if (responseLost) throw new Error('Connection interrupted');
      return structuredClone(remote);
    },
  };
  const client = new CandidateExpansion(scope, ports);
  return { client, ports, disk, requests, get remote() { return remote; }, set remote(v: ExpansionState | null) { remote = v; },
    set storageFails(v: boolean) { storageFails = v; }, set responseLost(v: boolean) { responseLost = v; },
    set active(v: boolean) { active = v; } };
}
describe('candidate expansion isolation and durable consent', () => {
  it('requires the explicit build tag, exact launcher, relative proxy and complete SHA', () => {
    expect(candidateExpansionBuild(CANDIDATE_ORIGIN, CANDIDATE_LOCAL_ORIGIN, '/api', scope.sourceSha)).toBe(true);
    for (const args of [[undefined, CANDIDATE_LOCAL_ORIGIN, '/api', scope.sourceSha],
      [CANDIDATE_ORIGIN, 'https://play.pixelkingdomwars.com', '/api', scope.sourceSha],
      [CANDIDATE_ORIGIN, CANDIDATE_LOCAL_ORIGIN, 'https://play.pixelkingdomwars.com', scope.sourceSha],
      [CANDIDATE_ORIGIN, CANDIDATE_LOCAL_ORIGIN, '/api', 'abc']]) {
      expect(candidateExpansionBuild(args[0], args[1]!, args[2]!, args[3]!)).toBe(false);
    }
  });
  it('persists request, quote, and exact consent before the corresponding mutation', async () => {
    const h = harness(); const s = await h.client.start(0);
    const done = await h.client.confirm(s.request.idempotencyKey, s.state!.quote!.quoteHash);
    expect(done.state?.receipt?.chargedLamports).toBe('0');
    expect(h.requests.filter(r => r.body)).toHaveLength(2);
    expect(h.requests.every(r => r.path.startsWith('/candidate/expansions/v1/'))).toBe(true);
  });
  it('does not send when durable storage fails', async () => {
    const h = harness(); h.storageFails = true;
    await expect(h.client.start(0)).rejects.toThrow('Storage');
    expect(h.requests.every(r => r.body === null)).toBe(true);
  });
  it('reopening after lost confirmation reads the original receipt without resending', async () => {
    const h = harness(); const s = await h.client.start(0); h.responseLost = true;
    await expect(h.client.confirm(s.request.idempotencyKey, s.state!.quote!.quoteHash)).rejects.toThrow('interrupted');
    const count = h.requests.filter(r => r.body).length;
    const reopened = new CandidateExpansion(scope, h.ports);
    expect((await reopened.check())?.state?.status).toBe('granted');
    expect(h.requests.filter(r => r.body)).toHaveLength(count);
  });
  it('a lost quote response cannot create another request and recovery is GET-only', async () => {
    const h = harness(); h.responseLost = true;
    await expect(h.client.start(0)).rejects.toThrow('interrupted');
    await expect(h.client.start(0)).rejects.toThrow('saved');
    const s = await h.client.check(); expect(s?.state?.status).toBe('quoted');
    expect(h.requests.filter(r => r.body)).toHaveLength(1);
  });
  it('unknown recovery never repeats quote until an explicit same-key retry', async () => {
    const h = harness(); const s = await h.client.start(0);
    h.remote = null;
    // Represent interruption before the server received the original quote.
    h.disk.set(h.client.storageKey, JSON.stringify({ ...s, state: null }));
    const count = h.requests.length; await h.client.check();
    expect(h.requests.slice(count).every(r => r.body === null)).toBe(true);
    await h.client.retryQuote(s.request.idempotencyKey);
    expect(h.requests.filter(r => r.path.endsWith('/quote')).map(r => r.body)).toEqual([s.request, s.request]);
  });
  it('serializes duplicate tabs and refuses stale displayed consent', async () => {
    const h = harness(); const other = new CandidateExpansion(scope, h.ports);
    const results = await Promise.allSettled([h.client.start(0), other.start(0)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await expect(other.confirm(id(999), 'b'.repeat(64))).rejects.toThrow('verified');
    expect(h.requests.filter(r => r.body)).toHaveLength(1);
  });
  it('retains confirmed success when cancel races a granted request', async () => {
    const h = harness(); const s = await h.client.start(0);
    const done = await h.client.confirm(s.request.idempotencyKey, s.state!.quote!.quoteHash);
    expect((await h.client.cancel(s.request.idempotencyKey)).state).toEqual(done.state);
  });
  it('retains original source evidence across a rebuilt candidate', async () => {
    const h = harness(); const s = await h.client.start(0);
    const updated = new CandidateExpansion({ ...scope, sourceSha: 'c'.repeat(40) }, h.ports);
    expect((await updated.check())?.scope.sourceSha).toBe(scope.sourceSha);
    expect((await updated.check())?.request).toEqual(s.request);
  });
  it('recovers equivalent receipts after the server reorders JSON properties', async () => {
    const h = harness(); const s = await h.client.start(0);
    const done = await h.client.confirm(s.request.idempotencyKey, s.state!.quote!.quoteHash);
    const reordered = JSON.parse(JSON.stringify(h.remote, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value)) as ExpansionState;
    h.remote = reordered;
    expect((await h.client.check())?.state).toEqual(done.state);
  });
  it('rejects terminal downgrade and a changed quote without overwriting good evidence', async () => {
    const h = harness(); const s = await h.client.start(0);
    const done = await h.client.confirm(s.request.idempotencyKey, s.state!.quote!.quoteHash);
    h.remote = { ...h.remote!, status: 'quoted', receipt: null };
    await expect(h.client.check()).rejects.toThrow('verified');
    expect(JSON.parse(h.disk.get(h.client.storageKey)!)).toEqual(done);
  });
  it('rejects foreign or charged receipts, footprints and malformed protocol data', async () => {
    const h = harness(); const s = await h.client.start(0);
    const done = await h.client.confirm(s.request.idempotencyKey, s.state!.quote!.quoteHash);
    for (const changes of [{ wallet: '2'.repeat(32) }, { baseId: id(99) }, { chargedLamports: '1' },
      { toExpansions: 99 }, { toClaimTiles: 99 }, { quoteHash: 'a'.repeat(64) }]) {
      expect(() => validateExpansionState({ ...done.state, receipt: { ...done.state!.receipt, ...changes } }, done)).toThrow();
    }
    expect(() => validateExpansionState({ ...done.state, version: 2 }, done)).toThrow();
  });
  it('storage corruption blocks both recovery and another mutation', async () => {
    const h = harness(); h.disk.set(h.client.storageKey, '{broken');
    await expect(h.client.check()).rejects.toThrow(); await expect(h.client.start(0)).rejects.toThrow();
    expect(h.requests).toEqual([]); expect(h.disk.get(h.client.storageKey)).toBe('{broken');
  });
  it('account/base changes while queued prevent any original operation from starting', async () => {
    const h = harness(); const pending = h.client.start(0); h.active = false;
    await expect(pending).rejects.toThrow('Account changed'); expect(h.requests).toEqual([]);
  });
  it('archives terminal evidence before starting the next expansion', async () => {
    const h = harness(); const s = await h.client.start(0);
    const done = await h.client.confirm(s.request.idempotencyKey, s.state!.quote!.quoteHash);
    await h.client.start(1);
    expect(JSON.parse(h.disk.get(`${h.client.storageKey}:${s.request.idempotencyKey}`)!)).toEqual(done);
  });
});
