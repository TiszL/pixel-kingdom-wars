import {
  ReferralCodeSchema, ReferralRelationshipSchema, type ReferralRelationship,
  type ReferralUseV1Response,
} from '@shardkeep/shared/referrals';

export type ReferralIdentity = { api: string; wallet: string; cluster: 'devnet' | 'mainnet-beta' };
export type LegacyReferral = {
  route: '/referrals/use' | '/alpha/referral'; code: string;
  result: { referrer: string } | { ok: true; wallet: string } | null;
};
export type ReferralJournal = {
  version: 1; identity: ReferralIdentity; revision: number; activated: boolean;
  code: string | null; relationship: ReferralRelationship | null; legacy: LegacyReferral | null;
  outcome: ReferralUseV1Response['outcome'] | 'observed' | null;
};
export const sameRelationship = (a: ReferralRelationship, b: ReferralRelationship): boolean =>
  a.id === b.id && a.refereeWallet === b.refereeWallet && a.referrerWallet === b.referrerWallet && a.createdAt === b.createdAt;
export class ReferralJournalConflict extends Error {
  constructor() { super('The saved referral changed in another tab. Check its status before continuing.'); }
}
export function parseReferralJournal(raw: unknown, identity: ReferralIdentity): ReferralJournal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid saved referral.');
  const r = raw as Record<string, unknown>;
  const fields = ['version', 'identity', 'revision', 'activated', 'code', 'relationship', 'outcome', 'legacy'];
  if (Object.keys(r).length !== fields.length || fields.some((key) => !(key in r)) || r.version !== 1
    || JSON.stringify(r.identity) !== JSON.stringify(identity) || !Number.isSafeInteger(r.revision)
    || (r.revision as number) < 0 || typeof r.activated !== 'boolean') throw new Error('Invalid saved referral identity.');
  const code = r.code === null ? null : ReferralCodeSchema.parse(r.code);
  if (code !== r.code) throw new Error('The saved referral code is not normalized.');
  const relationship = r.relationship === null ? null : ReferralRelationshipSchema.parse(r.relationship);
  if (relationship && relationship.refereeWallet !== identity.wallet) throw new Error('The saved referral belongs to another wallet.');
  const outcomes = ['applied', 'already_applied', 'already_bound', 'observed'];
  if (relationship ? !outcomes.includes(r.outcome as string) : r.outcome !== null) throw new Error('Invalid saved referral outcome.');
  const legacy = r.legacy === null ? null : parseLegacyReferral(r.legacy, identity);
  if (relationship && legacy?.result && 'referrer' in legacy.result && legacy.result.referrer !== relationship.referrerWallet) throw new Error('The original legacy attribution changed.');
  if (legacy && code !== null && legacy.code !== code) throw new Error('The saved legacy referral code changed.');
  if (legacy && !code && !legacy.result && (legacy.route === '/alpha/referral' || !relationship)) throw new Error('The original legacy referral still needs recovery.');
  if ((code || relationship || legacy) && !r.activated) throw new Error('Saved referral activation is missing.');
  if (!code && relationship && r.outcome !== 'observed') throw new Error('A code-specific result needs its original code.');
  return { version: 1, identity, revision: r.revision as number, activated: r.activated,
    code, relationship, legacy, outcome: r.outcome as ReferralJournal['outcome'] };
}

export function parseLegacyReferral(raw: unknown, identity: ReferralIdentity): LegacyReferral {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid legacy referral.');
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== 3 || !['/referrals/use', '/alpha/referral'].includes(r.route as string)
    || ReferralCodeSchema.parse(r.code) !== r.code) throw new Error('Invalid legacy referral route/code.');
  if (r.result !== null) {
    if (!r.result || typeof r.result !== 'object' || Array.isArray(r.result)) throw new Error('Invalid legacy referral result.');
    const result = r.result as Record<string, unknown>;
    if (r.route === '/alpha/referral' ? Object.keys(result).length !== 2 || result.ok !== true || result.wallet !== identity.wallet
      : Object.keys(result).length !== 1 || typeof result.referrer !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result.referrer) || result.referrer === identity.wallet) throw new Error('Legacy referral result does not match its route and account.');
  }
  return r as LegacyReferral;
}

/** Critical writes commit before the caller may POST. Revision comparison and
 * replacement occur in one strict IDB transaction; storage failure is never empty.
 * Activation and positive attribution survive Finish to fence legacy fallbacks. */
export class ReferralJournalStore {
  readonly key: string;
  private readonly database: Promise<IDBDatabase>;
  constructor(readonly identity: ReferralIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-referrals-v1') {
    this.key = JSON.stringify(identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Referral recovery needs working browser site storage.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('receipts');
      request.onerror = () => reject(request.error ?? new Error('Unable to open referral storage.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open referral storage.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
    void this.database.catch(() => undefined);
  }
  private empty(): ReferralJournal { return { version: 1, identity: this.identity, revision: 0, activated: false, code: null, relationship: null, outcome: null, legacy: null }; }
  private async transaction(expected: number | null, update?: (old: ReferralJournal) => ReferralJournal, firstRefused = false): Promise<ReferralJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('receipts', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('receipts'); const request = store.get(this.key);
      let result: ReferralJournal; let failure: unknown;
      request.onsuccess = () => {
        try {
          const old = request.result === undefined ? this.empty() : parseReferralJournal(request.result, this.identity);
          if (expected !== null && expected !== old.revision) throw new ReferralJournalConflict();
          if (!update) { result = old; return; }
          result = parseReferralJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
          if (old.activated && !result.activated) throw new Error('Referral activation cannot be erased.');
          if (old.relationship && (!result.relationship || !sameRelationship(old.relationship, result.relationship))) throw new Error('The original referral relationship changed.');
          if (old.legacy && (!result.legacy || old.legacy.route !== result.legacy.route || old.legacy.code !== result.legacy.code
            || (old.legacy.result && JSON.stringify(old.legacy.result) !== JSON.stringify(result.legacy.result)))) throw new Error('The original legacy referral changed.');
          if (old.code && result.code && old.code !== result.code) throw new Error('An unresolved referral code cannot be replaced.');
          if (old.code && !result.code && !result.relationship && !result.legacy?.result && !firstRefused) throw new Error('The original referral still needs recovery.');
          store.put(result, this.key);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('Referral storage did not commit.'));
    });
  }
  read(): Promise<ReferralJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: ReferralJournal) => ReferralJournal): Promise<ReferralJournal> { return this.transaction(revision, update); }
  /** Only the process that issued the fresh first POST may use its atomic refusal.
   * Recovery/retry callers must never treat a later refusal as negative proof. */
  firstRefused(revision: number, code: string): Promise<ReferralJournal> {
    return this.transaction(revision, (old) => {
      if (old.code !== code || old.relationship || old.legacy) throw new Error('The original referral changed.');
      return { ...old, code: null };
    }, true);
  }
  async close(): Promise<void> { (await this.database).close(); }
}
