import { ForgeClaimReceiptSchema, ForgeClaimRequestSchema, type ForgeClaimReceipt } from '@shardkeep/shared/forgeClaims';

export type ForgeClaimIdentity = { api: string; wallet: string; cluster: 'devnet' | 'mainnet-beta' };
export type ForgeClaimIntent = { request: import('@shardkeep/shared/forgeClaims').ForgeClaimRequest };
export type ForgeClaimHydration = { walletKeep: 'refreshed' | 'unavailable' };
function exactObject(raw: unknown, fields: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== fields.length || fields.some((key) => !(key in raw))) throw new Error('Invalid saved Forge claim fields.');
  return raw as Record<string, unknown>;
}
function hydration(raw: unknown): ForgeClaimHydration {
  const r = exactObject(raw, ['walletKeep']);
  if (r.walletKeep !== 'refreshed' && r.walletKeep !== 'unavailable') throw new Error('Invalid saved Forge wallet refresh.');
  return r as ForgeClaimHydration;
}
export type ForgeClaimJournal = {
  version: 1; identity: ForgeClaimIdentity; revision: number; intent: ForgeClaimIntent | null;
  receipt: ForgeClaimReceipt | null; hydrated: ForgeClaimHydration | null; finished: boolean;
};
export function parseForgeClaimIntent(value: unknown): ForgeClaimIntent {
  const r = exactObject(value, ['request']);
  return { request: ForgeClaimRequestSchema.parse(r.request) };
}
export function sameForgeClaimConsent(intent: ForgeClaimIntent, receipt: ForgeClaimReceipt, wallet: string): boolean {
  return receipt.actor === wallet && receipt.idempotencyKey === intent.request.idempotencyKey
    && receipt.baseId === intent.request.baseId && receipt.day === intent.request.day;
}
export function parseForgeClaimJournal(raw: unknown, identity: ForgeClaimIdentity): ForgeClaimJournal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid saved Forge claim command.');
  const r = raw as Record<string, unknown>;
  const fields = ['version', 'identity', 'revision', 'intent', 'receipt', 'hydrated', 'finished'];
  if (Object.keys(r).length !== fields.length || fields.some((key) => !(key in r)) || r.version !== 1
    || JSON.stringify(r.identity) !== JSON.stringify(identity) || !Number.isSafeInteger(r.revision)
    || (r.revision as number) < 0 || typeof r.finished !== 'boolean') throw new Error('Invalid saved Forge claim identity.');
  const intent = r.intent === null ? null : parseForgeClaimIntent(r.intent);
  const receipt = r.receipt === null ? null : ForgeClaimReceiptSchema.parse(r.receipt);
  const hydrated = r.hydrated === null ? null : hydration(r.hydrated);
  if (receipt && (!intent || !sameForgeClaimConsent(intent, receipt, identity.wallet))) throw new Error('The saved receipt belongs to different Forge claim consent.');
  if ((!receipt && hydrated) || (r.finished && (!receipt || !hydrated))) throw new Error('The original Forge claim command still needs recovery.');
  return { version: 1, identity, revision: r.revision as number, intent, receipt, hydrated, finished: r.finished };
}

/** One unresolved claim command per origin/account/cluster. Exact consent
 * commits with strict durability before POST. Finish retains its receipt until
 * the user explicitly reviews the next command; no storage error means empty. */
export class ForgeClaimJournalStore {
  readonly key: string;
  private readonly database: Promise<IDBDatabase>;
  constructor(readonly identity: ForgeClaimIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-forge-claims-v1') {
    this.key = JSON.stringify(identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('ForgeClaim recovery needs working browser site storage.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Unable to open saved Forge claim commands.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open Forge claim recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
    void this.database.catch(() => undefined);
  }
  private empty(): ForgeClaimJournal {
    return { version: 1, identity: this.identity, revision: 0, intent: null, receipt: null, hydrated: null, finished: false };
  }
  private async transaction(expected: number | null, update?: (old: ForgeClaimJournal) => ForgeClaimJournal): Promise<ForgeClaimJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'); const read = store.get(this.key);
      let result: ForgeClaimJournal; let failure: unknown;
      read.onsuccess = () => {
        try {
          const old = read.result === undefined ? this.empty() : parseForgeClaimJournal(read.result, this.identity);
          if (expected !== null && expected !== old.revision) throw new Error('Another tab changed the saved Forge claim command. Check its receipt.');
          if (!update) { result = old; return; }
          result = parseForgeClaimJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
          const same = JSON.stringify(old.intent) === JSON.stringify(result.intent);
          if (old.intent && !same && (!old.finished || !result.intent || result.receipt || result.hydrated || result.finished)) {
            throw new Error('The original Forge claim command cannot be replaced before recovery finishes.');
          }
          if (!same && old.intent && result.intent?.request.idempotencyKey === old.intent.request.idempotencyKey) throw new Error('A new Forge claim command needs a distinct key.');
          if (same && old.receipt && JSON.stringify(old.receipt) !== JSON.stringify(result.receipt)) throw new Error('The original Forge claim receipt changed.');
          if (same && old.hydrated && JSON.stringify(old.hydrated) !== JSON.stringify(result.hydrated)) throw new Error('The saved original payout refresh changed.');
          if (same && old.finished && !result.finished) throw new Error('A finished Forge claim command cannot be replayed.');
          store.put(result, this.key);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The Forge claim command did not save.'));
    });
  }
  read(): Promise<ForgeClaimJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: ForgeClaimJournal) => ForgeClaimJournal): Promise<ForgeClaimJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
