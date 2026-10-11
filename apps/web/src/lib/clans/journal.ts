import { ClanCommandReceiptSchema, ClanKickRequestSchema, ClanLeaveRequestSchema, type ClanCommandReceipt } from '@shardkeep/shared/clanCommands';

export type ClanIdentity = { api: string; wallet: string; cluster: 'devnet' | 'mainnet-beta' };
export type ClanIntent = { kind: 'leave'; request: import('@shardkeep/shared/clanCommands').ClanLeaveRequest; clanName: string }
  | { kind: 'kick'; request: import('@shardkeep/shared/clanCommands').ClanKickRequest; clanName: string };
export type ClanHydration = { membershipAvailable: boolean; originalPayout: 'refreshed' | 'unavailable' | 'not-applicable' };
function exactObject(raw: unknown, fields: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== fields.length || fields.some((key) => !(key in raw))) throw new Error('Invalid saved clan fields.');
  return raw as Record<string, unknown>;
}
function hydration(raw: unknown): ClanHydration {
  const r = exactObject(raw, ['membershipAvailable', 'originalPayout']);
  if (typeof r.membershipAvailable !== 'boolean' || !['refreshed', 'unavailable', 'not-applicable'].includes(String(r.originalPayout))) throw new Error('Invalid saved clan hydration.');
  return r as ClanHydration;
}
export type ClanJournal = {
  version: 1; identity: ClanIdentity; revision: number; intent: ClanIntent | null;
  receipt: ClanCommandReceipt | null; hydrated: ClanHydration | null; finished: boolean;
};
export function parseClanIntent(value: unknown): ClanIntent {
  const r = exactObject(value, ['kind', 'request', 'clanName']);
  if (typeof r.clanName !== 'string' || r.clanName.length < 1 || r.clanName.length > 128) throw new Error('Invalid saved clan name.');
  if (r.kind === 'leave') return { kind: r.kind, request: ClanLeaveRequestSchema.parse(r.request), clanName: r.clanName };
  if (r.kind === 'kick') return { kind: r.kind, request: ClanKickRequestSchema.parse(r.request), clanName: r.clanName };
  throw new Error('Invalid saved clan command kind.');
}
export function sameClanConsent(intent: ClanIntent, receipt: ClanCommandReceipt, wallet: string): boolean {
  return receipt.actor === wallet && receipt.idempotencyKey === intent.request.idempotencyKey
    && receipt.clanId === intent.request.clanId && receipt.kind === intent.kind
    && receipt.baseId === (intent.kind === 'leave' ? intent.request.baseId : null)
    && receipt.target === (intent.kind === 'kick' ? intent.request.wallet : null);
}
export function parseClanJournal(raw: unknown, identity: ClanIdentity): ClanJournal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid saved clan command.');
  const r = raw as Record<string, unknown>;
  const fields = ['version', 'identity', 'revision', 'intent', 'receipt', 'hydrated', 'finished'];
  if (Object.keys(r).length !== fields.length || fields.some((key) => !(key in r)) || r.version !== 1
    || JSON.stringify(r.identity) !== JSON.stringify(identity) || !Number.isSafeInteger(r.revision)
    || (r.revision as number) < 0 || typeof r.finished !== 'boolean') throw new Error('Invalid saved clan identity.');
  const intent = r.intent === null ? null : parseClanIntent(r.intent);
  const receipt = r.receipt === null ? null : ClanCommandReceiptSchema.parse(r.receipt);
  const hydrated = r.hydrated === null ? null : hydration(r.hydrated);
  if (receipt && (!intent || !sameClanConsent(intent, receipt, identity.wallet))) throw new Error('The saved receipt belongs to different clan consent.');
  if ((!receipt && hydrated) || (r.finished && (!receipt || !hydrated))) throw new Error('The original clan command still needs recovery.');
  if (hydrated && receipt && (receipt.state === 'disbanded') === (hydrated.originalPayout === 'not-applicable')) throw new Error('Invalid original clan payout refresh.');
  return { version: 1, identity, revision: r.revision as number, intent, receipt, hydrated, finished: r.finished };
}

/** One unresolved management command per origin/account/cluster. Exact consent
 * commits with strict durability before POST. Finish retains its receipt until
 * the user explicitly reviews the next command; no storage error means empty. */
export class ClanJournalStore {
  readonly key: string;
  private readonly database: Promise<IDBDatabase>;
  constructor(readonly identity: ClanIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-clans-v1') {
    this.key = JSON.stringify(identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Clan recovery needs working browser site storage.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Unable to open saved clan commands.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open clan recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
    void this.database.catch(() => undefined);
  }
  private empty(): ClanJournal {
    return { version: 1, identity: this.identity, revision: 0, intent: null, receipt: null, hydrated: null, finished: false };
  }
  private async transaction(expected: number | null, update?: (old: ClanJournal) => ClanJournal): Promise<ClanJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'); const read = store.get(this.key);
      let result: ClanJournal; let failure: unknown;
      read.onsuccess = () => {
        try {
          const old = read.result === undefined ? this.empty() : parseClanJournal(read.result, this.identity);
          if (expected !== null && expected !== old.revision) throw new Error('Another tab changed the saved clan command. Check its receipt.');
          if (!update) { result = old; return; }
          result = parseClanJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
          const same = JSON.stringify(old.intent) === JSON.stringify(result.intent);
          if (old.intent && !same && (!old.finished || !result.intent || result.receipt || result.hydrated || result.finished)) {
            throw new Error('The original clan command cannot be replaced before recovery finishes.');
          }
          if (!same && old.intent && result.intent?.request.idempotencyKey === old.intent.request.idempotencyKey) throw new Error('A new clan command needs a distinct key.');
          if (same && old.receipt && JSON.stringify(old.receipt) !== JSON.stringify(result.receipt)) throw new Error('The original clan receipt changed.');
          if (same && old.hydrated && JSON.stringify(old.hydrated) !== JSON.stringify(result.hydrated)) throw new Error('The saved original payout refresh changed.');
          if (same && old.finished && !result.finished) throw new Error('A finished clan command cannot be replayed.');
          store.put(result, this.key);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The clan command did not save.'));
    });
  }
  read(): Promise<ClanJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: ClanJournal) => ClanJournal): Promise<ClanJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
