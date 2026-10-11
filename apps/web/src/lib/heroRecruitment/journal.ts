import type { GameCurrency } from '../gameCurrency';
import { HeroRecruitmentReceiptSchema, HeroRecruitmentRequestSchema, HeroRecruitmentKeySchema, type HeroRecruitmentReceipt } from '@shardkeep/shared/heroRecruitment';

export type HeroRecruitmentIdentity = { api: string; wallet: string; cluster: 'devnet' | 'mainnet-beta' };
type Request = import('@shardkeep/shared/heroRecruitment').HeroRecruitmentRequest;
export type LegacyHeroBody = Omit<Request, 'baseId' | 'maxCostKeep'> & { baseId?: string };
export type HeroRecruitmentIntent = { mechanism: 'v1' | 'legacy'; request: Request; legacyBody: LegacyHeroBody | null; expectedCurrency?: GameCurrency };
export type HeroRecruitmentHydration = { base: 'refreshed' | 'unavailable'; items: 'refreshed' | 'unavailable'; roster: 'refreshed' | 'unavailable' };
export type LegacyHeroAcceptance = { actor: string; building: HeroRecruitmentReceipt['building'] };
export type HeroRecruitmentJournal = {
  version: 1; identity: HeroRecruitmentIdentity; revision: number; intent: HeroRecruitmentIntent | null;
  receipt: HeroRecruitmentReceipt | null; legacyAcceptance: LegacyHeroAcceptance | null;
  hydrated: HeroRecruitmentHydration | null; finished: boolean; refusal?: 'CURRENCY_CONSENT_CHANGED';
};
function exactObject(raw: unknown, fields: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== fields.length || fields.some(key => !(key in raw))) throw new Error('Invalid saved Hero recruitment fields.');
  return raw as Record<string, unknown>;
}
export function makeHeroRecruitmentIntent(mechanism: 'v1' | 'legacy', request: Request, expectedCurrency?: GameCurrency): HeroRecruitmentIntent {
  const { baseId, maxCostKeep: _quote, ...body } = request;
  return { mechanism, request, legacyBody: mechanism === 'legacy' ? { ...body, ...(baseId === null ? {} : { baseId }) } : null, ...(expectedCurrency ? { expectedCurrency } : {}) };
}
export function parseHeroRecruitmentIntent(raw: unknown): HeroRecruitmentIntent {
  const hasCurrency = !!raw && typeof raw === 'object' && 'expectedCurrency' in raw;
  const r = exactObject(raw, ['mechanism', 'request', 'legacyBody', ...(hasCurrency ? ['expectedCurrency'] : [])]);
  if (hasCurrency && r.expectedCurrency !== 'GEMS' && r.expectedCurrency !== 'KEEP') throw new Error('Invalid original Hero currency.');
  if (r.mechanism !== 'v1' && r.mechanism !== 'legacy') throw new Error('Invalid saved Hero command mechanism.');
  const expected = makeHeroRecruitmentIntent(r.mechanism, HeroRecruitmentRequestSchema.parse(r.request), r.expectedCurrency as GameCurrency | undefined);
  if (hasCurrency && (expected.request.heroContractOnly || expected.mechanism !== 'v1')) throw new Error('Exact currency needs a paid receipt-capable Hero command.');
  if (JSON.stringify(r.legacyBody) !== JSON.stringify(expected.legacyBody)) throw new Error('The exact original legacy Hero body changed.');
  return expected;
}
export function sameHeroRecruitmentConsent(intent: HeroRecruitmentIntent, receipt: HeroRecruitmentReceipt, wallet: string): boolean {
  return intent.mechanism === 'v1' && receipt.actor === wallet && JSON.stringify(receipt.request) === JSON.stringify(intent.request)
    && (!intent.expectedCurrency || receipt.funding.kind === 'contract' || receipt.funding.kind === intent.expectedCurrency.toLowerCase());
}
export function parseLegacyHeroAcceptance(raw: unknown, intent: HeroRecruitmentIntent, wallet: string): LegacyHeroAcceptance {
  const r = exactObject(raw, ['actor', 'building']);
  const b = exactObject(r.building, ['id', 'baseId', 'type', 'level', 'tx', 'ty']);
  const request = intent.request;
  if (intent.mechanism !== 'legacy' || r.actor !== wallet || !HeroRecruitmentKeySchema.safeParse({ key: b.id }).success
    || b.baseId !== request.baseId || b.type !== request.type || b.level !== 1 || b.tx !== request.tx || b.ty !== request.ty) throw new Error('The legacy building response does not match the original Hero placement.');
  return { actor: wallet, building: b as LegacyHeroAcceptance['building'] };
}
export function parseHeroRecruitmentJournal(raw: unknown, identity: HeroRecruitmentIdentity): HeroRecruitmentJournal {
  const hasRefusal = !!raw && typeof raw === 'object' && 'refusal' in raw;
  const r = exactObject(raw, ['version', 'identity', 'revision', 'intent', 'receipt', 'legacyAcceptance', 'hydrated', 'finished', ...(hasRefusal ? ['refusal'] : [])]);
  if (r.version !== 1 || JSON.stringify(r.identity) !== JSON.stringify(identity) || !Number.isSafeInteger(r.revision)
    || (r.revision as number) < 0 || typeof r.finished !== 'boolean') throw new Error('Invalid saved Hero recruitment identity.');
  const intent = r.intent === null ? null : parseHeroRecruitmentIntent(r.intent);
  const receipt = r.receipt === null ? null : HeroRecruitmentReceiptSchema.parse(r.receipt);
  if (receipt && (!intent || !sameHeroRecruitmentConsent(intent, receipt, identity.wallet))) throw new Error('The saved receipt belongs to different Hero recruitment consent.');
  const legacyAcceptance = r.legacyAcceptance === null ? null : intent ? parseLegacyHeroAcceptance(r.legacyAcceptance, intent, identity.wallet) : null;
  if (r.legacyAcceptance && !legacyAcceptance || receipt && legacyAcceptance) throw new Error('Invalid saved Hero acceptance.');
  const h = r.hydrated === null ? null : exactObject(r.hydrated, ['base', 'items', 'roster']);
  if (h && Object.values(h).some(value => value !== 'refreshed' && value !== 'unavailable')) throw new Error('Invalid original Hero refresh.');
  if (hasRefusal && (r.refusal !== 'CURRENCY_CONSENT_CHANGED' || !intent?.expectedCurrency || receipt || legacyAcceptance || h || !r.finished)) throw new Error('Invalid definitive Hero refusal.');
  if (h && !receipt && !legacyAcceptance || r.finished && !hasRefusal && (!h || !receipt && !legacyAcceptance)) throw new Error('The original Hero command still needs recovery.');
  return { version: 1, identity, revision: r.revision as number, intent, receipt, legacyAcceptance, hydrated: h as HeroRecruitmentHydration | null, finished: r.finished, ...(hasRefusal ? { refusal: 'CURRENCY_CONSENT_CHANGED' as const } : {}) };
}

/** One unresolved Hero command per origin/account/cluster. Exact consent
 * commits with strict durability before POST. Finish retains its receipt until
 * the user explicitly reviews the next command; no storage error means empty. */
export class HeroRecruitmentJournalStore {
  readonly key: string;
  private readonly database: Promise<IDBDatabase>;
  constructor(readonly identity: HeroRecruitmentIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-hero-recruitment-v1') {
    this.key = JSON.stringify(identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('HeroRecruitment recovery needs working browser site storage.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Unable to open saved Hero recruitment commands.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open Hero recruitment recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
    void this.database.catch(() => undefined);
  }
  private empty(): HeroRecruitmentJournal {
    return { version: 1, identity: this.identity, revision: 0, intent: null, receipt: null, legacyAcceptance: null, hydrated: null, finished: false };
  }
  private async transaction(expected: number | null, update?: (old: HeroRecruitmentJournal) => HeroRecruitmentJournal): Promise<HeroRecruitmentJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'); const read = store.get(this.key);
      let result: HeroRecruitmentJournal; let failure: unknown;
      read.onsuccess = () => {
        try {
          const old = read.result === undefined ? this.empty() : parseHeroRecruitmentJournal(read.result, this.identity);
          if (expected !== null && expected !== old.revision) throw new Error('Another tab changed the saved Hero recruitment command. Check its receipt.');
          if (!update) { result = old; return; }
          result = parseHeroRecruitmentJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
          const same = JSON.stringify(old.intent) === JSON.stringify(result.intent);
          if (old.intent && !same && (!old.finished || !result.intent || result.receipt || result.legacyAcceptance || result.hydrated || result.finished)) {
            throw new Error('The original Hero recruitment command cannot be replaced before recovery finishes.');
          }
          if (same && old.refusal && result.refusal !== old.refusal) throw new Error('The original Hero refusal changed.');
          if (!same && result.refusal) throw new Error('A new Hero command cannot inherit a refusal.');
          if (!same && old.intent && result.intent?.request.idempotencyKey === old.intent.request.idempotencyKey) throw new Error('A new Hero recruitment command needs a distinct key.');
          if (same && old.receipt && JSON.stringify(old.receipt) !== JSON.stringify(result.receipt)) throw new Error('The original Hero recruitment receipt changed.');
          if (same && old.legacyAcceptance && JSON.stringify(old.legacyAcceptance) !== JSON.stringify(result.legacyAcceptance)) throw new Error('The original legacy Hero acceptance changed.');
          if (same && old.hydrated && JSON.stringify(old.hydrated) !== JSON.stringify(result.hydrated)) throw new Error('The saved original Hero refresh changed.');
          if (same && old.finished && !result.finished) throw new Error('A finished Hero recruitment command cannot be replayed.');
          store.put(result, this.key);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The Hero recruitment command did not save.'));
    });
  }
  read(): Promise<HeroRecruitmentJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: HeroRecruitmentJournal) => HeroRecruitmentJournal): Promise<HeroRecruitmentJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
