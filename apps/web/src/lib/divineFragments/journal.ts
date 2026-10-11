import * as A from '@shardkeep/shared/divineFragmentsApi';
export type DivineFragmentsIdentity = { origin: string; api: string; cluster: 'devnet' | 'mainnet-beta'; wallet: string };
export type DivineFragmentsCommand = { kind: 'delivery'; consent: A.DivineFragmentDeliveryConsent }
 | { kind: 'claim'; consent: A.DivineFragmentSeekerClaimConsent; termHash: string; browseCursor: string | null };
export type DivineFragmentsProof = A.DivineFragmentDeliveryEnvelope | A.DivineFragmentSeekerClaimEnvelope;
export type DivineFragmentsOperation = { command: DivineFragmentsCommand; attemptRevision: number | null;
  proof: DivineFragmentsProof | null };
export type DivineFragmentsArchive = { operation: DivineFragmentsOperation; reason: 'accepted' | 'unattempted'; evidence: DivineFragmentsProof | null };
export type DivineFragmentsJournal = { version: 1; identity: DivineFragmentsIdentity; revision: number;
  operation: DivineFragmentsOperation | null; archives: DivineFragmentsArchive[] };
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length
    || keys.some(k => !Object.hasOwn(raw, k))) throw new Error('Invalid saved fragment fields.');
  return raw as Record<string, unknown>;
}
export function parseDivineFragmentsIdentity(raw: unknown): DivineFragmentsIdentity {
  const r = exact(raw, ['origin', 'api', 'cluster', 'wallet']);
  if (typeof r.origin !== 'string' || typeof r.api !== 'string' || r.cluster !== 'devnet' && r.cluster !== 'mainnet-beta') throw new Error('Invalid fragment identity.');
  const origin = new URL(r.origin), api = new URL(r.api);
  if (!['http:', 'https:'].includes(origin.protocol) || !['http:', 'https:'].includes(api.protocol) || origin.origin !== r.origin
    || api.username || api.password || api.search || api.hash || api.href.replace(/\/$/, '') !== r.api) throw new Error('Invalid fragment origin or API scope.');
  if (typeof r.wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.wallet)) throw new Error('Invalid claim wallet.');
  const wallet = r.wallet;
  return { origin: r.origin, api: r.api, cluster: r.cluster, wallet };
}
export function parseDivineFragmentsCommand(raw: unknown): DivineFragmentsCommand {
 if (!raw || typeof raw !== 'object' || !('kind' in raw)) throw Error('Invalid fragment command.');
 if (raw.kind === 'delivery') { const r = exact(raw, ['kind','consent']); return {kind:'delivery',consent:A.DivineFragmentDeliveryConsentSchema.parse(r.consent)}; }
 const r = exact(raw, ['kind','consent','termHash','browseCursor']);
 if (r.kind !== 'claim' || typeof r.termHash !== 'string' || !/^[0-9a-f]{64}$/.test(r.termHash)) throw Error('Invalid original fragment term.');
 const query=A.DivineFragmentPageQuerySchema.parse(r.browseCursor===null?{}:{cursor:r.browseCursor});
 return {kind:'claim',consent:A.DivineFragmentSeekerClaimConsentSchema.parse(r.consent),termHash:r.termHash,browseCursor:query.cursor??null};
}
export function matchDivineFragmentsProof(raw: unknown, identity: DivineFragmentsIdentity, command: DivineFragmentsCommand): DivineFragmentsProof {
 const proof = command.kind==='delivery'?A.DivineFragmentDeliveryEnvelopeSchema.parse(raw):A.DivineFragmentSeekerClaimEnvelopeSchema.parse(raw);
 if(proof.wallet!==identity.wallet || command.consent.wallet!==identity.wallet || proof.idempotencyKey!==command.consent.request.idempotencyKey)throw Error('Foreign fragment receipt.');
 if(proof.receipt){if(command.kind==='delivery')A.matchDivineFragmentDeliveryReceipt(proof.receipt,command.consent);
 else {const receipt=A.matchDivineFragmentSeekerClaimReceipt(proof.receipt,command.consent);if(receipt.termHash!==command.termHash)throw Error('Original fragment term changed.');}}
 return proof;
}
function parseOperation(raw: unknown, identity: DivineFragmentsIdentity, revision: number): DivineFragmentsOperation {
  const r = exact(raw, ['command', 'attemptRevision', 'proof']), command = parseDivineFragmentsCommand(r.command);
  if(command.consent.wallet!==identity.wallet)throw Error('Foreign saved fragment command.');
  if (r.attemptRevision !== null && (!Number.isSafeInteger(r.attemptRevision) || (r.attemptRevision as number) <= 0 || (r.attemptRevision as number) > revision))
    throw new Error('Invalid original fragment attempt revision.');
  const proof = r.proof === null ? null : matchDivineFragmentsProof(r.proof, identity, command);
  if (proof && !proof.receipt) throw new Error('Only accepted fragment proofs are durable.');
  return { command, attemptRevision: r.attemptRevision as number | null, proof };
}
export function parseDivineFragmentsJournal(raw: unknown, identity: DivineFragmentsIdentity): DivineFragmentsJournal {
  const r = exact(raw, ['version', 'identity', 'revision', 'operation', 'archives']);
  if (r.version !== 1 || !same(parseDivineFragmentsIdentity(r.identity), parseDivineFragmentsIdentity(identity))
    || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || !Array.isArray(r.archives)) throw new Error('Invalid fragment journal.');
  const revision = r.revision as number, operation = r.operation === null ? null : parseOperation(r.operation, identity, revision);
  const archives: DivineFragmentsArchive[] = r.archives.map(raw => {
    const a = exact(raw, ['operation', 'reason', 'evidence']), op = parseOperation(a.operation, identity, revision);
    if (a.reason === 'accepted' && op.proof && a.evidence === null) return { operation: op, reason: 'accepted', evidence: null };
    if (a.reason !== 'unattempted' || op.attemptRevision !== null) throw new Error('An ambiguous fragment command cannot be abandoned.');
    const evidence = matchDivineFragmentsProof(a.evidence, identity, op.command);
    if (evidence.receipt !== null) throw new Error('Archival requires fresh original absence evidence.');
    return { operation: op, reason: a.reason, evidence };
  });
  const keys = [...archives.map(a => a.operation), ...(operation ? [operation] : [])].map(o => o.command.consent.request.idempotencyKey);
  if (new Set(keys).size !== keys.length) throw new Error('Original fragment keys cannot be reused.');
  return { version: 1, identity, revision, operation, archives };
}
function preserves(a: DivineFragmentsOperation, b: DivineFragmentsOperation): void {
  if (!same(a.command, b.command) || a.attemptRevision !== null && (b.attemptRevision === null || b.attemptRevision < a.attemptRevision))
    throw new Error('The original fragment command changed.');
  if (a.proof && !same(a.proof, b.proof)) throw new Error('Original fragment acceptance changed or disappeared.');
}
function assertTransition(old: DivineFragmentsJournal, next: DivineFragmentsJournal): void {
  if (next.archives.length < old.archives.length || next.archives.length > old.archives.length + 1) throw new Error('Original claim history cannot disappear.');
  for (let i = 0; i < old.archives.length; i++) {
    const a = old.archives[i]!, b = next.archives[i]!;
    if (a.reason !== b.reason || !same(a.evidence, b.evidence) || a.operation.attemptRevision !== b.operation.attemptRevision) throw new Error('Original claim history changed.');
    preserves(a.operation, b.operation);
  }
  const a = old.operation, b = next.operation;
  if (next.archives.length > old.archives.length) {
    if (!a || b || !same(next.archives.at(-1)?.operation, a)) throw new Error('Only the exact original claim may be archived.');
    if (next.archives.at(-1)?.reason !== 'accepted' && a.proof) throw new Error('Accepted claims must retain their receipt.');
    return;
  }
  if (!a) { if (b && (b.attemptRevision !== null || b.proof)) throw new Error('Save original claim intent before any attempt.'); return; }
  if (!b) throw new Error('Original claim intent cannot disappear.');
  preserves(a, b);
  if (a.attemptRevision !== b.attemptRevision && (b.attemptRevision !== next.revision || a.proof || b.proof))
    throw new Error('Every explicit POST needs a durable attempt revision first.');
}
export interface DivineFragmentsStore {
  readonly identity: DivineFragmentsIdentity; readonly key: string;
  read(): Promise<DivineFragmentsJournal>;
  compareAndSet(revision: number, update: (old: DivineFragmentsJournal) => DivineFragmentsJournal): Promise<DivineFragmentsJournal>;
}
/** One strict-durability record per origin/API/cluster/wallet, including accepted
 * and explicitly abandoned history. An attempted command always needs recovery. */
export class DivineFragmentsJournalStore implements DivineFragmentsStore {
  readonly identity: DivineFragmentsIdentity; readonly key: string; private readonly database: Promise<IDBDatabase>;
  constructor(identity: DivineFragmentsIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-divine-fragments-v1') {
    this.identity = Object.freeze(parseDivineFragmentsIdentity(identity)); this.key = JSON.stringify(this.identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Durable browser storage is unavailable. fragment commands cannot begin.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Cannot open fragment recovery.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open fragment recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }); void this.database.catch(() => undefined);
  }
  private async transaction(revision: number | null, update?: (old: DivineFragmentsJournal) => DivineFragmentsJournal): Promise<DivineFragmentsJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'), read = store.get(this.key); let result: DivineFragmentsJournal, failure: unknown;
      read.onsuccess = () => { try {
        const old: DivineFragmentsJournal = read.result === undefined ? { version: 1, identity: this.identity, revision: 0, operation: null, archives: [] } : parseDivineFragmentsJournal(read.result, this.identity);
        if (revision !== null && revision !== old.revision) throw new Error('Another tab changed the original fragment command. Read its recovery record.');
        if (!update) { result = old; return; }
        result = parseDivineFragmentsJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
        assertTransition(old, result); store.put(result, this.key);
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The original fragment command did not save.'));
    });
  }
  read(): Promise<DivineFragmentsJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: DivineFragmentsJournal) => DivineFragmentsJournal): Promise<DivineFragmentsJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
