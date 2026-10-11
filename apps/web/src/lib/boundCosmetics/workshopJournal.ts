import { BoundCosmeticAppearanceSchema, BoundCosmeticEnvelopeSchema, BoundCosmeticRequestSchema,
  matchBoundCosmeticEnvelope, type BoundCosmeticEnvelope, type BoundCosmeticAppearance, type BoundCosmeticRequest } from '@shardkeep/shared/boundCosmeticApi';
import { BoundCosmeticRecipeSnapshotSchema, type BoundCosmeticRecipeSnapshot } from '@shardkeep/shared/phaseEBoundCosmetics';
import { parseOrdinaryCraftingIdentity, type OrdinaryCraftingIdentity } from '../ordinaryCrafting/journal';

export type WorkshopIdentity = OrdinaryCraftingIdentity;
/** Closed command families share transitions and account coordination, but never storage. */
export type WorkshopCommandMode = 'awning' | 'wake';
const databases = { awning: 'pkw-bound-cosmetics-v1', wake: 'pkw-bound-cosmetics-wake-v1' } as const;
function checkMode(mode: WorkshopCommandMode): void {
  if (mode !== 'awning' && mode !== 'wake') throw Error('Saved appearance mode is invalid.');
}
export const sameWorkshopValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length
    || keys.some(key => !Object.hasOwn(raw, key))) throw Error('Saved Awning fields are invalid.');
  return raw as Record<string, unknown>;
}
export type WorkshopCommand = { request: BoundCosmeticRequest; recipe: BoundCosmeticRecipeSnapshot; appearance: BoundCosmeticAppearance };
export function parseWorkshopCommand(raw: unknown, mode: WorkshopCommandMode = 'awning'): WorkshopCommand {
  checkMode(mode);
  const r = exact(raw, ['request', 'recipe', 'appearance']);
  const c = { request: BoundCosmeticRequestSchema.parse(r.request), recipe: BoundCosmeticRecipeSnapshotSchema.parse(r.recipe), appearance: BoundCosmeticAppearanceSchema.parse(r.appearance) };
  if ((mode === 'wake') !== (c.recipe.outputId === 'aurora_wake') || c.request.recipeId !== c.recipe.recipeId || c.request.recipeVersion !== c.recipe.recipeVersion
    || c.recipe.outputId !== c.appearance.outputId || c.request.appearanceBindingSha256 !== c.appearance.bindingSha256) throw Error('Saved Awning terms do not match.');
  return c;
}
export function matchWorkshopProof(raw: unknown, identity: WorkshopIdentity, command: WorkshopCommand, mode: WorkshopCommandMode = 'awning'): BoundCosmeticEnvelope {
  command = parseWorkshopCommand(command, mode);
  const proof = matchBoundCosmeticEnvelope(raw, identity.wallet, command.request);
  if (proof.status === 'accepted' && (!sameWorkshopValue(proof.receipt.recipe, command.recipe)
    || !sameWorkshopValue(proof.receipt.appearance, command.appearance)
    || Date.parse(proof.receipt.startedAt) > Date.parse(proof.serverNow)
    || proof.completion && Date.parse(proof.completion.completedAt) > Date.parse(proof.serverNow)))
    throw Error('The original Awning receipt differs from the reviewed terms.');
  return proof;
}
export type WorkshopOperation = { command: WorkshopCommand; attempted: boolean; proof: BoundCosmeticEnvelope | null };
export type WorkshopJournal = { version: 1; identity: WorkshopIdentity; revision: number; operation: WorkshopOperation | null; archives: WorkshopOperation[] };
export function parseWorkshopJournal(raw: unknown, identity: WorkshopIdentity, mode: WorkshopCommandMode = 'awning'): WorkshopJournal {
  checkMode(mode);
  const r = exact(raw, ['version', 'identity', 'revision', 'operation', 'archives']);
  if (!sameWorkshopValue(parseOrdinaryCraftingIdentity(r.identity), parseOrdinaryCraftingIdentity(identity)))
    throw Error('The saved Awning request belongs to another account or server.');
  if (r.version !== 1 || !Number.isSafeInteger(r.revision) || Number(r.revision) < 0 || !Array.isArray(r.archives)) throw Error('Saved Awning recovery is invalid.');
  const operation = (value: unknown): WorkshopOperation => {
    const o = exact(value, ['command', 'attempted', 'proof']);
    if (typeof o.attempted !== 'boolean') throw Error('Saved attempt marker is invalid.');
    return { command: parseWorkshopCommand(o.command, mode), attempted: o.attempted, proof: o.proof === null ? null : BoundCosmeticEnvelopeSchema.parse(o.proof) };
  };
  const j: WorkshopJournal = { version: 1, identity, revision: Number(r.revision), operation: r.operation === null ? null : operation(r.operation), archives: r.archives.map(operation) };
  const operations = [...j.archives, ...(j.operation ? [j.operation] : [])];
  if (new Set(operations.map(o => o.command.request.idempotencyKey)).size !== operations.length)
    throw Error('An original Awning request key cannot be reused.');
  for (const op of operations) {
    if (op.proof && (matchWorkshopProof(op.proof, identity, op.command, mode).status !== 'accepted' || !op.attempted))
      throw Error('Saved acceptance requires an original attempted request.');
  }
  if (j.archives.some(op => op.attempted && !op.proof)) throw Error('An unknown Awning outcome cannot be archived.');
  return { ...j, identity };
}
function preserves(a: WorkshopOperation, b: WorkshopOperation): void {
  if (!sameWorkshopValue(a.command, b.command) || a.attempted && !b.attempted
    || a.proof?.status === 'accepted' && (b.proof?.status !== 'accepted'
      || !sameWorkshopValue(a.proof.receipt, b.proof.receipt)
      || a.proof.completion && !sameWorkshopValue(a.proof.completion, b.proof.completion)))
    throw Error('Original Awning terms or acceptance cannot change or disappear.');
}
function transition(old: WorkshopJournal, next: WorkshopJournal): void {
  if (next.archives.length < old.archives.length || next.archives.length > old.archives.length + 1)
    throw Error('Saved Awning history cannot disappear.');
  old.archives.forEach((op, i) => preserves(op, next.archives[i]!));
  if (next.archives.length > old.archives.length) {
    if (!old.operation || next.operation || !sameWorkshopValue(old.operation, next.archives.at(-1)))
      throw Error('Only the exact saved request may be archived.');
  } else if (old.operation) {
    if (!next.operation) throw Error('An original Awning request cannot disappear.');
    preserves(old.operation, next.operation);
  } else if (next.operation && (next.operation.attempted || next.operation.proof)) {
    throw Error('Save reviewed Awning terms before attempting the request.');
  }
}
export interface WorkshopStore {
  readonly identity: WorkshopIdentity; readonly key: string;
  read(): Promise<WorkshopJournal>;
  compareAndSet(revision: number, update: (old: WorkshopJournal) => WorkshopJournal): Promise<WorkshopJournal>;
}
/** Same strict IndexedDB transaction/CAS convention as ordinary refining. An
 * attempted outcome remains recoverable; failed replies never mint new keys. */
export class WorkshopJournalStore implements WorkshopStore {
  readonly identity: WorkshopIdentity; readonly key: string; private database: Promise<IDBDatabase> | null = null;
  private readonly name: string;
  constructor(identity: WorkshopIdentity, private readonly factory = globalThis.indexedDB, readonly mode: WorkshopCommandMode = 'awning') {
    checkMode(mode); this.name = databases[mode];
    this.identity = Object.freeze(parseOrdinaryCraftingIdentity(identity)); this.key = JSON.stringify(this.identity);
  }
  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    const { factory, name } = this;
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(Error('Recovery storage is unavailable. Crafting cannot begin.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? Error('Awning recovery storage could not open.'));
      request.onblocked = () => reject(Error('Close older game tabs to open Awning recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }); void this.database.catch(() => undefined); return this.database;
  }
  private async transaction(revision: number | null, update?: (old: WorkshopJournal) => WorkshopJournal): Promise<WorkshopJournal> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'), request = store.get(this.key); let result: WorkshopJournal, failure: unknown;
      request.onsuccess = () => { try {
        const old = request.result === undefined ? { version: 1 as const, identity: this.identity, revision: 0, operation: null, archives: [] }
          : parseWorkshopJournal(request.result, this.identity, this.mode);
        if (revision !== null && old.revision !== revision) throw Error('Another tab changed this request. Check its original receipt.');
        if (!update) { result = old; return; }
        result = parseWorkshopJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity, this.mode);
        transition(old, result); store.put(result, this.key);
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? Error('The original Awning request could not be saved.'));
    });
  }
  read(): Promise<WorkshopJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: WorkshopJournal) => WorkshopJournal): Promise<WorkshopJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { if (this.database) (await this.database).close(); }
}
