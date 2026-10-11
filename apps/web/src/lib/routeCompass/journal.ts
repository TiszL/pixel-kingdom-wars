import {OrdinaryEquipmentRequestSchema,OrdinaryEquipmentEnvelopeSchema,matchOrdinaryEquipmentEnvelope,type OrdinaryEquipmentEnvelope} from '@shardkeep/shared/ordinaryEquipmentApi';
import {OrdinaryEquipmentRecipeSnapshotSchema,fittingSelection} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {StarterExpeditionRequestSchema,StarterEquipmentRoutePreviewSchema,matchStarterExpeditionEnvelope,type StarterExpeditionEnvelope} from '@shardkeep/shared/starterExpeditionApi';
import {PaidStarterRoutePreviewSchema} from '@shardkeep/shared/paidStarterExpeditions';
import {AdvancedExpeditionRequestSchema,matchAdvancedExpeditionEnvelope,type AdvancedExpeditionEnvelope} from '@shardkeep/shared/advancedExpeditionApi';
import {AdvancedExpeditionPreviewSchema} from '@shardkeep/shared/phaseEAdvancedExpeditions';
export type CompassCommand=
 |{kind:'craft';request:ReturnType<typeof OrdinaryEquipmentRequestSchema.parse>;quote:ReturnType<typeof OrdinaryEquipmentRecipeSnapshotSchema.parse>}
 |{kind:'starter';request:ReturnType<typeof StarterExpeditionRequestSchema.parse>;quote:ReturnType<typeof StarterEquipmentRoutePreviewSchema.parse>|ReturnType<typeof PaidStarterRoutePreviewSchema.parse>}
 |{kind:'advanced';request:ReturnType<typeof AdvancedExpeditionRequestSchema.parse>;quote:ReturnType<typeof AdvancedExpeditionPreviewSchema.parse>};
export type CompassProof=OrdinaryEquipmentEnvelope|StarterExpeditionEnvelope|AdvancedExpeditionEnvelope;
export const need:(v:unknown,message?:string)=>asserts v=(v,message='Compass original is unavailable or differs.')=>{if(!v)throw Error(message);};
export function terminal(p:CompassProof|null){return p?.status==='accepted'&&('completion'in p?p.completion!==null:p.return!==null);}
export function outcome(p:CompassProof){return 'completion'in p?p.completion:p.return;}
export function previewRoute(route:unknown){const value=structuredClone(route) as Record<string,unknown>;if(value.access&&typeof value.access==='object'&&'observation'in value.access){const {observation,...access}=value.access;value.access=access;}return value;}
export type CompassIdentity = { origin: string; api: string; cluster: 'devnet' | 'mainnet-beta'; wallet: string };
export type CompassRefusal = { phase: 'first_post'; status: number; code: string };
export type CompassOperation = { command: CompassCommand; attemptRevision: number | null;
  proof: CompassProof | null; refusal: CompassRefusal | null };
export type CompassArchive = { operation: CompassOperation; reason: 'accepted' | 'unattempted' | 'refused'; evidence: CompassProof | null };
export type CompassJournal = { version: 1; identity: CompassIdentity; revision: number;
  operation: CompassOperation | null; archives: CompassArchive[] };
export function same(a:unknown,b:unknown):boolean{
 if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
 if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>same(v,b[i]));
 const x=a as Record<string,unknown>,y=b as Record<string,unknown>,keys=Object.keys(x);
 return keys.length===Object.keys(y).length&&keys.every(k=>Object.hasOwn(y,k)&&same(x[k],y[k]));
}
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length
    || keys.some(k => !Object.hasOwn(raw, k))) throw new Error('Invalid saved Compass fields.');
  return raw as Record<string, unknown>;
}
const REFUSALS: Readonly<Record<string, number>> = { BASE_NOT_OWNED: 404, BASE_ID_REQUIRED: 409, DEED_OWNERSHIP_CHANGED: 409,
  BASE_BEING_RAIDED: 423, DEED_AUTHORITY_UNAVAILABLE: 503, PHASE_E_DISABLED: 503, ORDINARY_WORKSHOP_REQUIRED: 409,
  ORDINARY_CRAFTING_BUSY: 409, EQUIPMENT_UNAVAILABLE:503, EQUIPMENT_CRAFT_UNAVAILABLE:409, COMPASS_UNAVAILABLE:409, LENS_UNAVAILABLE:409, STARTER_EXPEDITIONS_DISABLED:503, COMPASS_ROUTE_UNAVAILABLE:409, ORDINARY_RECIPE_CHANGED: 409, ORDINARY_RECIPE_INVALID: 400,
  CRAFTING_STORAGE_FULL: 409, INSUFFICIENT_CRAFTING_STOCK: 422, INSUFFICIENT_RAW_STOCK: 422 };
export function compassRefusalDefinitive(status: number, code: string): boolean {
  return Object.hasOwn(REFUSALS, code) && REFUSALS[code] === status;
}
function parseRefusal(raw: unknown): CompassRefusal {
  const r = exact(raw, ['phase', 'status', 'code']);
  if (r.phase !== 'first_post' || typeof r.status !== 'number' || typeof r.code !== 'string'
    || !compassRefusalDefinitive(r.status, r.code)) throw new Error('Invalid original Compass refusal.');
  return { phase: 'first_post', status: r.status, code: r.code };
}
export function parseCompassIdentity(raw: unknown): CompassIdentity {
  const r = exact(raw, ['origin', 'api', 'cluster', 'wallet']);
  if (typeof r.origin !== 'string' || typeof r.api !== 'string' || r.cluster !== 'devnet' && r.cluster !== 'mainnet-beta') throw new Error('Invalid Compass identity.');
  const origin = new URL(r.origin), api = new URL(r.api);
  if (!['http:', 'https:'].includes(origin.protocol) || !['http:', 'https:'].includes(api.protocol) || origin.origin !== r.origin
    || api.username || api.password || api.search || api.hash || api.href.replace(/\/$/, '') !== r.api) throw new Error('Invalid Compass origin or API scope.');
  const { wallet } = OrdinaryEquipmentEnvelopeSchema.parse({ wallet: r.wallet, idempotencyKey: '00000000-0000-4000-8000-000000000000',
    serverNow: '2000-01-01T00:00:00.000Z', status: 'unknown', receipt: null, completion: null });
  return { origin: r.origin, api: r.api, cluster: r.cluster, wallet };
}
export function parseCompassCommand(raw:unknown):CompassCommand{
 const r=exact(raw,['kind','request','quote']);let c:CompassCommand;
 if(r.kind==='craft')c={kind:r.kind,request:OrdinaryEquipmentRequestSchema.parse(r.request),quote:OrdinaryEquipmentRecipeSnapshotSchema.parse(r.quote)};
 else if(r.kind==='starter'){const preview=StarterEquipmentRoutePreviewSchema.safeParse(r.quote);c={kind:r.kind,request:StarterExpeditionRequestSchema.parse(r.request),quote:preview.success?preview.data:PaidStarterRoutePreviewSchema.parse(r.quote)};}
 else {need(r.kind==='advanced');c={kind:r.kind,request:AdvancedExpeditionRequestSchema.parse(r.request),quote:AdvancedExpeditionPreviewSchema.parse(r.quote)};}
 need(c.kind==='craft'?c.request.recipeId===c.quote.recipeId&&c.request.recipeVersion===c.quote.recipeVersion&&c.request.quantity===c.quote.quantity:
 !!c.request.fitting&&!!c.quote.fitting&&same(c.request.fitting,fittingSelection(c.quote).fitting)&&c.request.routeId===c.quote.routeId
 &&(c.kind==='starter'?c.request.routeVersion===c.quote.routeCatalogueVersion&&c.request.rewardVersion===c.quote.rewardTableVersion:c.request.policyVersion===c.quote.policyVersion));return c;
}
export function matchCompassProof(raw:unknown,identity:CompassIdentity,command:CompassCommand):CompassProof{
 const p=command.kind==='craft'?matchOrdinaryEquipmentEnvelope(raw,identity.wallet,command.request):command.kind==='starter'?matchStarterExpeditionEnvelope(raw,identity.wallet,command.request):matchAdvancedExpeditionEnvelope(raw,identity.wallet,command.request);
 if(p.status==='accepted'){
  need(same('recipe'in p.receipt?p.receipt.recipe:previewRoute(p.receipt.route),command.quote),'Server receipt differs from the reviewed Compass terms.');
  const start='startedAt'in p.receipt?p.receipt.startedAt:p.receipt.departedAt,end=outcome(p);
  need(Date.parse(start)<=Date.parse(p.serverNow)&&(!end||Date.parse('completedAt'in end?end.completedAt:end.returnedAt)<=Date.parse(p.serverNow)),'Compass evidence lies after its observation.');
 }return p;
}
function parseOperation(raw: unknown, identity: CompassIdentity, revision: number): CompassOperation {
  const r = exact(raw, ['command', 'attemptRevision', 'proof', 'refusal']), command = parseCompassCommand(r.command);
  if (r.attemptRevision !== null && (!Number.isSafeInteger(r.attemptRevision) || (r.attemptRevision as number) <= 0 || (r.attemptRevision as number) > revision))
    throw new Error('Invalid original Compass attempt revision.');
  const proof = r.proof === null ? null : matchCompassProof(r.proof, identity, command);
  if (proof && proof.status !== 'accepted') throw new Error('Only accepted Compass proofs are durable.');
  const refusal = r.refusal === null ? null : parseRefusal(r.refusal);
  if (refusal && r.attemptRevision === null) throw new Error('Refusal requires an original attempted command.');
  return { command, attemptRevision: r.attemptRevision as number | null, proof, refusal };
}
export function parseCompassJournal(raw: unknown, identity: CompassIdentity): CompassJournal {
  const r = exact(raw, ['version', 'identity', 'revision', 'operation', 'archives']);
  if (r.version !== 1 || !same(parseCompassIdentity(r.identity), parseCompassIdentity(identity))
    || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || !Array.isArray(r.archives)) throw new Error('Invalid Compass journal.');
  const revision = r.revision as number, operation = r.operation === null ? null : parseOperation(r.operation, identity, revision);
  const archives: CompassArchive[] = r.archives.map(raw => {
    const a = exact(raw, ['operation', 'reason', 'evidence']), op = parseOperation(a.operation, identity, revision);
    if (a.reason === 'accepted' && op.proof && a.evidence === null) return { operation: op, reason: 'accepted', evidence: null };
    if (a.reason !== 'unattempted' && a.reason !== 'refused'
      || a.reason === 'unattempted' && (op.attemptRevision !== null || op.refusal !== null)
      || a.reason === 'refused' && !op.refusal) throw new Error('An ambiguous Compass command cannot be abandoned.');
    const evidence = matchCompassProof(a.evidence, identity, op.command);
    if (evidence.status !== 'unknown') throw new Error('Archival requires fresh original absence evidence.');
    return { operation: op, reason: a.reason, evidence };
  });
  const keys = [...archives.map(a => a.operation), ...(operation ? [operation] : [])].map(o => o.command.request.idempotencyKey);
  if (new Set(keys).size !== keys.length) throw new Error('Original Compass keys cannot be reused.');
  return { version: 1, identity, revision, operation, archives };
}
function preserves(a: CompassOperation, b: CompassOperation): void {
  if (!same(a.command, b.command) || a.attemptRevision !== null && (b.attemptRevision === null || b.attemptRevision < a.attemptRevision)
    || a.refusal && !same(a.refusal, b.refusal)) throw new Error('The original Compass command or refusal changed.');
  if (a.proof && (b.proof?.status !== 'accepted' || a.proof.status !== 'accepted'
    || !same(a.proof.receipt, b.proof.receipt) || outcome(a.proof) && !same(outcome(a.proof), outcome(b.proof))))
    throw new Error('Original Compass acceptance or completion changed or disappeared.');
}
function assertTransition(old: CompassJournal, next: CompassJournal): void {
  if (next.archives.length < old.archives.length || next.archives.length > old.archives.length + 1) throw new Error('Original Compass archives cannot disappear.');
  for (let i = 0; i < old.archives.length; i++) {
    const a = old.archives[i]!, b = next.archives[i]!;
    if (a.reason !== b.reason || !same(a.evidence, b.evidence) || a.operation.attemptRevision !== b.operation.attemptRevision
      || !same(a.operation.refusal, b.operation.refusal)) throw new Error('Original Compass archive changed.');
    preserves(a.operation, b.operation);
  }
  const a = old.operation, b = next.operation;
  if (next.archives.length > old.archives.length) {
    if (!a || b || !same(next.archives.at(-1)?.operation, a)) throw new Error('Only the exact original operation may be archived.');
    if (next.archives.at(-1)?.reason !== 'accepted' && a.proof) throw new Error('Accepted originals must be archived as accepted.');
    return;
  }
  if (!a) { if (b && (b.attemptRevision !== null || b.proof || b.refusal)) throw new Error('Save original Compass intent before evidence or attempt.'); return; }
  if (!b) throw new Error('Original Compass intent cannot disappear.');
  preserves(a, b);
  if (a.attemptRevision !== b.attemptRevision && (b.attemptRevision !== next.revision || a.proof || a.refusal || b.proof || b.refusal))
    throw new Error('Every explicit attempt requires its own durable revision.');
  if (!a.refusal && b.refusal && (a.attemptRevision === null || a.proof)) throw new Error('Persist an original attempt before refusal.');
}
export interface CompassStore {
  readonly identity: CompassIdentity; readonly key: string;
  read(): Promise<CompassJournal>;
  compareAndSet(revision: number, update: (old: CompassJournal) => CompassJournal): Promise<CompassJournal>;
}
/** One strict-durability record per origin/API/cluster/wallet, including accepted
 * and explicitly abandoned history. An attempted command always needs recovery. */
export class CompassJournalStore implements CompassStore {
  readonly identity: CompassIdentity; readonly key: string; private readonly database: Promise<IDBDatabase>;
  constructor(identity: CompassIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-route-compass-v1') {
    this.identity = Object.freeze(parseCompassIdentity(identity)); this.key = JSON.stringify(this.identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Durable browser storage is unavailable. Refining commands cannot begin.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Cannot open Compass recovery.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open Compass recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }); void this.database.catch(() => undefined);
  }
  private async transaction(revision: number | null, update?: (old: CompassJournal) => CompassJournal): Promise<CompassJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'), read = store.get(this.key); let result: CompassJournal, failure: unknown;
      read.onsuccess = () => { try {
        const old: CompassJournal = read.result === undefined ? { version: 1, identity: this.identity, revision: 0, operation: null, archives: [] } : parseCompassJournal(read.result, this.identity);
        if (revision !== null && revision !== old.revision) throw new Error('Another tab changed the original Compass command. Read its recovery record.');
        if (!update) { result = old; return; }
        result = parseCompassJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
        assertTransition(old, result); store.put(result, this.key);
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The original Compass command did not save.'));
    });
  }
  read(): Promise<CompassJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: CompassJournal) => CompassJournal): Promise<CompassJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
