/** Separate zero-charge candidate protocol. Never calls a payment endpoint. */
export const CANDIDATE_ORIGIN = 'https://qa.pixelkingdomwars.com';
export const CANDIDATE_LOCAL_ORIGIN = 'https://localhost:19443';
const ROOT = '/candidate/expansions/v1';
const TAG = 'candidate-expansion';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
type Scope = { origin: string; sourceSha: string; wallet: string; baseId: string };
export type ExpansionRequest = { kind: 'expansion'; idempotencyKey: string; baseId: string; expectedExpansions: number };
export type ExpansionQuote = Omit<Scope, 'baseId'> & {
  version: 1; mode: typeof TAG; fixtureId: string; request: ExpansionRequest;
  baseEpoch: { landPaidAt: string; deedAssetId: null };
  offer: { expectedExpansions: number; fromClaimTiles: number; toClaimTiles: number;
    requiredKeepLevel: number; referencePriceLamports: string; chargedLamports: '0' };
  createdAt: string; quoteHash: string;
};
export type ExpansionReceipt = {
  version: 1; mode: typeof TAG; id: string; wallet: string; idempotencyKey: string; baseId: string;
  quoteHash: string; fromExpansions: number; toExpansions: number; fromClaimTiles: number;
  toClaimTiles: number; chargedLamports: '0'; acceptedAt: string;
};
export type ExpansionState = {
  version: 1; mode: typeof TAG; wallet: string; idempotencyKey: string;
  status: 'unquoted' | 'quoted' | 'granted' | 'cancelled';
  quote: ExpansionQuote | null; receipt: ExpansionReceipt | null;
};
export type SavedExpansion = { version: 1; scope: Scope; request: ExpansionRequest;
  state: ExpansionState | null; confirmedHash: string | null };
type Ports = {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  lock<T>(name: string, work: () => Promise<T>): Promise<T>;
  get(path: string): Promise<unknown>; post(path: string, body: unknown): Promise<unknown>;
  assertCurrent(): void; key(): string;
};
function requireValid(ok: unknown): asserts ok {
  if (!ok) throw new Error('The saved expansion could not be verified. Keep this request and check again.');
}
function obj(value: unknown): Record<string, unknown> {
  requireValid(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const nonnegative = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const date = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));
const tagged = (v: Record<string, unknown>): boolean => v.version === 1 && v.mode === TAG;
// JSON object order is not protocol evidence (JSONB and serializers may reorder it).
const canonical = (value: unknown): string | undefined => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
function sameRequest(value: unknown, expected: ExpansionRequest): boolean {
  const r = obj(value);
  return r.kind === 'expansion' && r.idempotencyKey === expected.idempotencyKey
    && r.baseId === expected.baseId && r.expectedExpansions === expected.expectedExpansions;
}
export function validateExpansionState(value: unknown, saved: Pick<SavedExpansion, 'scope' | 'request'>): ExpansionState {
  const s = obj(value); const { scope, request } = saved;
  requireValid(tagged(s) && s.wallet === scope.wallet && s.idempotencyKey === request.idempotencyKey
    && ['unquoted', 'quoted', 'granted', 'cancelled'].includes(String(s.status)));
  if (s.quote !== null) {
    const q = obj(s.quote); const o = obj(q.offer); const epoch = obj(q.baseEpoch);
    requireValid(tagged(q) && q.origin === scope.origin && q.sourceSha === scope.sourceSha && q.wallet === scope.wallet
      && UUID.test(String(q.fixtureId)) && sameRequest(q.request, request) && date(q.createdAt)
      && date(epoch.landPaidAt) && epoch.deedAssetId === null && SHA.test(String(q.quoteHash))
      && o.expectedExpansions === request.expectedExpansions && positive(o.fromClaimTiles) && positive(o.toClaimTiles)
      && o.toClaimTiles > o.fromClaimTiles && positive(o.requiredKeepLevel) && o.chargedLamports === '0'
      && typeof o.referencePriceLamports === 'string' && /^[1-9][0-9]*$/.test(o.referencePriceLamports));
  }
  requireValid(s.status === 'unquoted' ? s.quote === null && s.receipt === null
    : s.status === 'cancelled' ? s.receipt === null : s.quote !== null);
  if (s.status === 'granted') {
    const r = obj(s.receipt); const q = obj(s.quote); const o = obj(q.offer);
    requireValid(tagged(r) && UUID.test(String(r.id)) && r.wallet === scope.wallet && r.baseId === request.baseId
      && r.idempotencyKey === request.idempotencyKey && r.quoteHash === q.quoteHash
      && r.fromExpansions === request.expectedExpansions && r.toExpansions === request.expectedExpansions + 1
      && r.fromClaimTiles === o.fromClaimTiles && r.toClaimTiles === o.toClaimTiles
      && r.chargedLamports === '0' && date(r.acceptedAt));
  } else requireValid(s.receipt === null);
  return s as unknown as ExpansionState;
}
export function candidateExpansionBuild(flag: unknown, localOrigin: string, apiUrl: string, sha: string): boolean {
  return flag === CANDIDATE_ORIGIN && localOrigin === CANDIDATE_LOCAL_ORIGIN && apiUrl === '/api' && /^[0-9a-f]{40}$/.test(sha);
}
/** Same-origin Web Locks serialize duplicate tabs; every mutation follows a verified durable write. */
export class CandidateExpansion {
  readonly storageKey: string;
  constructor(readonly scope: Scope, private readonly ports: Ports) {
    requireValid(scope.origin === CANDIDATE_ORIGIN && /^[0-9a-f]{40}$/.test(scope.sourceSha)
      && UUID.test(scope.baseId) && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(scope.wallet));
    // Keep original requests reachable when the candidate is rebuilt.
    this.storageKey = `pkw:candidate-expansion:v1:${scope.origin}:${scope.wallet}:${scope.baseId}`;
  }
  private read(): SavedExpansion | null {
    const raw = this.ports.storage.getItem(this.storageKey);
    if (raw === null) return null;
    requireValid(raw.length <= 65536);
    const v = obj(JSON.parse(raw)); const scope = obj(v.scope); const r = obj(v.request);
    requireValid(v.version === 1 && scope.origin === this.scope.origin && scope.wallet === this.scope.wallet
      && scope.baseId === this.scope.baseId && /^[0-9a-f]{40}$/.test(String(scope.sourceSha))
      && r.kind === 'expansion' && UUID.test(String(r.idempotencyKey)) && r.baseId === this.scope.baseId
      && nonnegative(r.expectedExpansions) && (v.confirmedHash === null || SHA.test(String(v.confirmedHash))));
    const saved = v as unknown as SavedExpansion;
    if (saved.state !== null) validateExpansionState(saved.state, saved);
    requireValid(saved.confirmedHash === null || saved.state?.quote?.quoteHash === saved.confirmedHash);
    return saved;
  }
  private write(saved: SavedExpansion): SavedExpansion {
    const raw = JSON.stringify(saved);
    this.ports.storage.setItem(this.storageKey, raw);
    if (this.ports.storage.getItem(this.storageKey) !== raw) throw new Error('This browser could not save your request. Enable site storage and try again.');
    return saved;
  }
  private run<T>(work: () => Promise<T>): Promise<T> {
    return this.ports.lock(this.storageKey, async () => { this.ports.assertCurrent(); return work(); });
  }
  private adopt(saved: SavedExpansion, value: unknown): SavedExpansion {
    this.ports.assertCurrent();
    const state = validateExpansionState(value, saved); const old = saved.state;
    if (old?.quote) requireValid(canonical(old.quote) === canonical(state.quote));
    if (old?.status === 'granted' || old?.status === 'cancelled') requireValid(canonical(old) === canonical(state));
    return this.write({ ...saved, state });
  }
  private async capability(): Promise<void> {
    const c = obj(await this.ports.get(`${ROOT}/capability?baseId=${encodeURIComponent(this.scope.baseId)}`));
    this.ports.assertCurrent();
    requireValid(tagged(c) && c.enabled === true && c.origin === this.scope.origin && c.sourceSha === this.scope.sourceSha
      && c.wallet === this.scope.wallet && c.baseId === this.scope.baseId);
  }
  /** Foreground/restart recovery performs reads only, even for an unknown request. */
  check(): Promise<SavedExpansion | null> {
    return this.run(async () => {
      const saved = this.read();
      if (saved) return this.adopt(saved, await this.ports.get(`${ROOT}/${saved.request.idempotencyKey}`));
      await this.capability(); return null;
    });
  }
  start(expectedExpansions: number): Promise<SavedExpansion> {
    return this.run(async () => {
      requireValid(nonnegative(expectedExpansions));
      const old = this.read();
      if (old && old.state?.status !== 'granted' && old.state?.status !== 'cancelled') throw new Error('Check or cancel your saved expansion first.');
      await this.capability(); this.ports.assertCurrent();
      if (old) {
        const archiveKey = `${this.storageKey}:${old.request.idempotencyKey}`; const raw = JSON.stringify(old);
        this.ports.storage.setItem(archiveKey, raw); requireValid(this.ports.storage.getItem(archiveKey) === raw);
      }
      const saved = this.write({ version: 1, scope: this.scope, request: { kind: 'expansion',
        idempotencyKey: this.ports.key(), baseId: this.scope.baseId, expectedExpansions }, state: null, confirmedHash: null });
      return this.adopt(saved, await this.ports.post(`${ROOT}/quote`, saved.request));
    });
  }
  retryQuote(id: string): Promise<SavedExpansion> {
    return this.run(async () => {
      const saved = this.read(); requireValid(saved && saved.request.idempotencyKey === id);
      const checked = this.adopt(saved, await this.ports.get(`${ROOT}/${id}`));
      if (checked.state?.status !== 'unquoted') return checked;
      await this.capability(); this.ports.assertCurrent();
      return this.adopt(checked, await this.ports.post(`${ROOT}/quote`, checked.request));
    });
  }
  confirm(id: string, quoteHash: string): Promise<SavedExpansion> {
    return this.run(async () => {
      const saved = this.read(); requireValid(saved && saved.request.idempotencyKey === id && saved.state?.quote?.quoteHash === quoteHash);
      if (saved.state.status === 'granted' || saved.state.status === 'cancelled') return saved;
      requireValid(saved.state.status === 'quoted');
      const confirmed = this.write({ ...saved, confirmedHash: quoteHash }); this.ports.assertCurrent();
      return this.adopt(confirmed, await this.ports.post(`${ROOT}/${id}/confirm`, { quoteHash }));
    });
  }
  cancel(id: string): Promise<SavedExpansion> {
    return this.run(async () => {
      const saved = this.read(); requireValid(saved && saved.request.idempotencyKey === id);
      return this.adopt(saved, await this.ports.post(`${ROOT}/${id}/cancel`, {}));
    });
  }
}
