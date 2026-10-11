/** Private tester orchestration, never a request capability or a key loader.
 * A closed day gets one immutable intent. Unknown signing/submission outcomes
 * retain that original; they never authorize a replacement or a stock return. */
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { miningConfigPda } from '@shardkeep/chain/mining-program';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import type { MiningBackingTrust } from '@shardkeep/chain/mining-backing';
import type { Db } from '../db/client';
import { phaseEMiningEnabled } from '../config';
import { createResourceMiningPublicationPreparer, type FundedMiningAllocationSources } from './fundedMiningAllocation';
import { getPreparedMiningPublication, type MiningPublicationPreparationOptions } from './publicationPreparation';
import type { PreparedMiningPublication } from './publicationEnvelope';
import { createMiningPublicationOutbox, type MiningPublicationOutbox, type MiningPublicationSigningReservation } from './publicationOutbox';
import { createMiningPublicationReconciler, type MiningPublicationReconcileSources } from './publicationReconcile';
import { projectMiningClaimEntitlements } from './claimEntitlement';
import { readResourceMiningDayPolicy } from './resourceMiningPolicy';

export interface MiningPublicationPublisher {
  readonly publicKey: PublicKey;
  /** The separately authorized OPERATOR adapter owns readiness and signing.
   * It must obey cancellation and must never substitute a blockhash/message. */
  ready(signal: AbortSignal): Promise<boolean>;
  signOriginal(original: Readonly<MiningPublicationSigningReservation>, signal: AbortSignal): Promise<Uint8Array>;
}
export interface MiningPublicationJobOptions {
  readonly enabled?: boolean | undefined;
  readonly testerStack?: boolean;
  readonly cluster: 'devnet' | 'mainnet-beta';
  readonly operator: PublicKey;
  readonly hotWallet: PublicKey;
  readonly publisher: MiningPublicationPublisher;
  readonly sources: FundedMiningAllocationSources;
  readonly blockhashSource: MiningPublicationPreparationOptions['blockhashSource'];
  readonly reconcile: MiningPublicationReconcileSources;
  /** Operational polling/deadline bounds, never a mining-day or reward setting. */
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly report?: (observation: MiningPublicationJobObservation) => void;
}
/** Missing publisher/source wiring is an explicit scanner-only composition. */
export type MiningPublicationScannerOptions = Omit<MiningPublicationJobOptions, 'publisher' | 'sources' | 'blockhashSource'> & {
  readonly publisher?: null;
  readonly sources?: FundedMiningAllocationSources | null;
  readonly blockhashSource?: MiningPublicationPreparationOptions['blockhashSource'] | null;
};
export type MiningPublicationJobResult = Readonly<
  { status: 'disabled' | 'idle' }
  | { status: 'held'; reason: string; epochId?: string }
  | { status: 'submitted'; epochId: string }
  | { status: 'projected'; epochId: string }
>;
export type MiningPublicationJobObservation = Readonly<MiningPublicationJobResult & { day: string | null; observedAt: string }>;
interface Candidate extends Record<string, unknown> {
  epochId: string; epochKey: string; day: string; policyVersion: 2 | 3;
  attemptKey: string | null; settled: boolean;
}
const INTERVAL_MS = 15_000, MAX_TIMEOUT_MS = 30_000;
const held = (reason: string, epochId?: string): MiningPublicationJobResult => Object.freeze({ status: 'held', reason, ...(epochId ? { epochId } : {}) });
class JobError extends Error { constructor(readonly code: string) { super(code); } }
function fail(code: string): never { throw new JobError(code); }
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  // Diagnostics contain only bounded codes, never provider URLs, SQL or keys.
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  const message = error instanceof Error ? error.message : undefined;
  return typeof message === 'string' && /^MINING_[A-Z0-9_]{1,56}$/.test(message) ? message : 'SOURCE_UNAVAILABLE';
}
function publicIdentity(value: PublicKey): PublicKey {
  const result = new PublicKey(value.toBytes());
  if (result.equals(PublicKey.default)) throw Error('Mining publication job requires an explicit public identity');
  return result;
}
function trustCopy(value: MiningBackingTrust): MiningBackingTrust {
  if (value.expectedGenesisHash !== SOLANA_GENESIS_HASH.devnet || !Number.isSafeInteger(value.reviewedDeploymentSlot)
      || value.reviewedDeploymentSlot < 0 || !/^[0-9a-f]{64}$/.test(value.reviewedProgramDataSha256)) {
    throw Error('Mining publication job requires complete reviewed devnet identity');
  }
  return Object.freeze({ ...value, programId: publicIdentity(value.programId), keepMint: publicIdentity(value.keepMint), reserveOwner: publicIdentity(value.reserveOwner) });
}
function sameTrust(a: MiningBackingTrust, b: MiningBackingTrust) {
  return a.expectedGenesisHash === b.expectedGenesisHash && a.reviewedDeploymentSlot === b.reviewedDeploymentSlot
    && a.reviewedProgramDataSha256 === b.reviewedProgramDataSha256
    && a.programId.equals(b.programId) && a.keepMint.equals(b.keepMint) && a.reserveOwner.equals(b.reserveOwner);
}
function withoutFixtureClock({ resourceClock: _ignored, ...source }: FundedMiningAllocationSources) { return source; }

export function createMiningPublicationJob(db: Db, options: MiningPublicationJobOptions | MiningPublicationScannerOptions) {
  const enabled = options.enabled === true, intervalMs = options.intervalMs ?? INTERVAL_MS, timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
  if (enabled && (options.testerStack !== true || options.cluster !== 'devnet')) throw Error('Mining publication job requires an explicit devnet tester stack');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 60_000
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw Error('Invalid mining publication job operational limits');
  const operator = publicIdentity(options.operator), hotWallet = publicIdentity(options.hotWallet);
  const publisher = options.publisher ? Object.freeze({
    publicKey: publicIdentity(options.publisher.publicKey), ready: options.publisher.ready.bind(options.publisher),
    signOriginal: options.publisher.signOriginal.bind(options.publisher),
  }) : null;
  if (publisher && !publisher.publicKey.equals(operator)) throw Error('Mining publication publisher differs from OPERATOR');
  const backingTrust = trustCopy(options.reconcile.backing.trust), settlementTrust = trustCopy(options.reconcile.settlement.trust);
  if (operator.equals(backingTrust.reserveOwner) || operator.equals(hotWallet) || backingTrust.reserveOwner.equals(hotWallet)) {
    throw Error('Mining publication OPERATOR, RESERVE and hot wallet identities must be distinct');
  }
  const configAddress = miningConfigPda(backingTrust.programId).toBase58();
  if (!sameTrust(backingTrust, settlementTrust)) throw Error('Mining publication sources have different reviewed identities');
  const backingReader = options.reconcile.backing.reader, settlementReader = options.reconcile.settlement.reader,
    transportSource = options.reconcile.transport, blockhashSource = options.blockhashSource;
  // Copy configuration, preserving only application-owned reader functions.
  // The job never installs a roster/source baseline or a policy cutover.
  const source = options.sources;
  const sources: FundedMiningAllocationSources | null = source ? {
    ...withoutFixtureClock(source), qualification: { ...source.qualification },
    ...(source.backing ? { backing: { reader: source.backing.reader, trust: trustCopy(source.backing.trust) } } : {}),
    ...(source.gems ? { gems: { trust: { ...source.gems.trust }, connect: source.gems.connect } } : {}),
    ...(source.tax ? { tax: { connect: source.tax.connect, policy: { ...source.tax.policy,
      programId: publicIdentity(source.tax.policy.programId), config: publicIdentity(source.tax.policy.config),
      mint: publicIdentity(source.tax.policy.mint), prizeOwner: publicIdentity(source.tax.policy.prizeOwner),
      prizeAta: publicIdentity(source.tax.policy.prizeAta), genesisHash: publicIdentity(source.tax.policy.genesisHash),
      deployment: { ...source.tax.policy.deployment },
    } } } : {}),
    ...(source.seeker ? { seeker: { ...source.seeker, providers: source.seeker.providers.map(p => ({ ...p })) as unknown as NonNullable<FundedMiningAllocationSources['seeker']>['providers'] } } : {}),
    ...(source.seekerEnrollment ? { seekerEnrollment: { ...source.seekerEnrollment, providers: source.seekerEnrollment.providers.map(p => ({ ...p })) as unknown as NonNullable<FundedMiningAllocationSources['seekerEnrollment']>['providers'] } } : {}),
    ...(source.existingWallet ? { existingWallet: { ...source.existingWallet } } : {}),
    ...(source.seekerAbsence ? { seekerAbsence: { ...source.seekerAbsence } } : {}),
  } : null;
  if (sources && (sources.qualification.expectedGenesisHash !== backingTrust.expectedGenesisHash
      || sources.backing && !sameTrust(sources.backing.trust, backingTrust))) throw Error('Mining publication allocation source identity mismatch');
  let started = false, stopping = false, closing: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  type Flight = { reply: Promise<MiningPublicationJobResult>; drained: Promise<void>; abort(): void };
  let flight: Flight | null = null;
  let lastResult: MiningPublicationJobObservation | null = null, lastReportedKey = '', lastReportedAt = -Infinity,
    repeatedHolds = 0, previousHoldKey = '', retryOriginal = false;
  const report = options.report ?? ((observation: MiningPublicationJobObservation) => console.warn('[mining-publication-job]', observation));
  function observe(result: MiningPublicationJobResult, day: string | null = null) {
    const now = Date.now(), observation = Object.freeze({ ...result, day, observedAt: new Date(now).toISOString() });
    lastResult = observation;
    const key = JSON.stringify({ ...result, day });
    repeatedHolds = result.status === 'held' ? (previousHoldKey === key ? repeatedHolds + 1 : 1) : 0;
    previousHoldKey = result.status === 'held' ? key : '';
    if (result.status !== 'idle' && (key !== lastReportedKey || now - lastReportedAt >= 60_000)) {
      lastReportedKey = key; lastReportedAt = now;
      try { report(observation); } catch { console.warn('[mining-publication-job] Observation sink unavailable'); }
    }
  }

  function runOnce(): Promise<MiningPublicationJobResult> {
    if (stopping) return Promise.reject(Error('Mining publication job is closed'));
    if (!enabled) { const result = Object.freeze({ status: 'disabled' as const }); observe(result); return Promise.resolve(result); }
    if (flight) return flight.reply;
    retryOriginal = false;
    const controller = new AbortController(), signal = controller.signal, pending = new Set<Promise<unknown>>();
    let epochId: string | undefined, day: string | null = null, workDone = false, replyDone = false, deadline: ReturnType<typeof setTimeout> | undefined;
    let resolveReply!: (value: MiningPublicationJobResult) => void, resolveDrained!: () => void;
    const reply = new Promise<MiningPublicationJobResult>(resolve => { resolveReply = resolve; });
    const drained = new Promise<void>(resolve => { resolveDrained = resolve; });
    const entry: Flight = { reply, drained, abort: () => { controller.abort(); finish(held('CLOSED', epochId)); } };
    flight = entry;
    function release() {
      if (workDone && pending.size === 0) {
        if (flight === entry) flight = null;
        resolveDrained();
      }
    }
    function resetDeadline() {
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(() => { controller.abort(); finish(held('TIMEOUT', epochId)); }, timeoutMs);
    }
    function active() { if (signal.aborted || stopping) fail(stopping ? 'CLOSED' : 'TIMEOUT'); }
    function finish(result: MiningPublicationJobResult) {
      if (replyDone) return; replyDone = true;
      if (deadline) clearTimeout(deadline); observe(result, day); resolveReply(result); release();
    }
    async function tracked<T>(call: () => T | PromiseLike<T>): Promise<T> {
      active();
      const raw = Promise.resolve().then(() => { active(); return call(); }); pending.add(raw);
      try { const result = await raw; active(); return result; }
      finally { pending.delete(raw); release(); }
    }
    const readers = new WeakMap<object, object>();
    function reader<T extends object>(value: T): T {
      const old = readers.get(value); if (old) return old as T;
      // The empty forwarding target also accepts frozen source methods. A proxy
      // over a nonconfigurable method cannot legally return a guarded function.
      const get = (name: PropertyKey) => {
        const method = Reflect.get(value, name, value);
        return typeof method === 'function' ? (...args: unknown[]) => tracked(() => method.apply(value, args)) : method;
      };
      const proxy = new Proxy({} as T, { get: (_target, name) => get(name),
        has: (_target, name) => Reflect.has(value, name), ownKeys: () => Reflect.ownKeys(value),
        getOwnPropertyDescriptor: (_target, name) => {
          const property = Reflect.getOwnPropertyDescriptor(value, name);
          return property ? { configurable: true, enumerable: property.enumerable === true, writable: false, value: get(name) } : undefined;
        },
      }); readers.set(value, proxy); return proxy;
    }
    // Every SQL entry and transactional callback is fenced. Shutdown waits for
    // entered calls to drain; it never closes somebody else's database pool.
    function database<T extends object>(value: T): T {
      return new Proxy(value, { get(target, name, receiver) {
        const method = Reflect.get(target, name, receiver);
        if (name === 'execute' && typeof method === 'function') return (...args: unknown[]) => tracked(() => method.apply(target, args));
        if (name === 'transaction' && typeof method === 'function') return (callback: (tx: object) => Promise<unknown>, ...args: unknown[]) => tracked(() => method.apply(target, [async (tx: object) => {
          active(); const result = await callback(database(tx)); active(); return result;
        }, ...args]));
        return typeof method === 'function' ? method.bind(target) : method;
      } });
    }
    const ownedDb = database(db);
    async function ready() {
      if (!publisher) return false;
      try { return await tracked(() => publisher.ready(signal)) === true; }
      catch { active(); return false; }
    }
    function admission() { active(); if (!phaseEMiningEnabled()) fail('PAUSED'); }
    async function project() {
      active(); await projectMiningClaimEntitlements(ownedDb, { epochId: epochId! }); active();
      return Object.freeze({ status: 'projected' as const, epochId: epochId! });
    }
    function validPrepared(p: PreparedMiningPublication, row: Candidate) {
      const manifest = JSON.parse(p.manifestJson) as { input: { epochId?: unknown; day?: unknown; policyVersion?: unknown };
        funding?: { source?: { genesisHash?: unknown; programId?: unknown; reviewedDeploymentSlot?: unknown; reviewedProgramDataSha256?: unknown } } };
      const scope = manifest.input, originalSource = manifest.funding?.source;
      if (p.epochId !== row.epochId || row.attemptKey !== null && p.attemptKey !== row.attemptKey
          || scope.epochId !== row.epochId || scope.day !== row.day || scope.policyVersion !== row.policyVersion
          || originalSource?.genesisHash !== backingTrust.expectedGenesisHash || originalSource.programId !== backingTrust.programId.toBase58()
          || originalSource.reviewedDeploymentSlot !== backingTrust.reviewedDeploymentSlot
          || originalSource.reviewedProgramDataSha256 !== backingTrust.reviewedProgramDataSha256
          || p.publication.programId !== backingTrust.programId.toBase58() || p.publication.keepMint !== backingTrust.keepMint.toBase58()
          || p.publication.reserveOwner !== backingTrust.reserveOwner.toBase58()
          || p.publication.day !== String(Date.parse(row.day) / (POLICY.daySec * 1000))) fail('SOURCE_CONFLICT');
    }
    function validReservation(record: MiningPublicationOutbox, p: PreparedMiningPublication) {
      if (record.epochId !== p.epochId || record.attemptKey !== p.attemptKey || record.signer !== p.publication.signer
          || record.genesisHash !== backingTrust.expectedGenesisHash || record.programId !== p.publication.programId
          || record.sequence !== p.publication.sequence || record.intentHex !== p.intentHex || record.intentSha256 !== p.intentSha256
          || record.blockhashContextSlot !== p.publication.blockhashContextSlot || record.lastValidBlockHeight !== p.publication.lastValidBlockHeight) fail('SOURCE_CONFLICT');
    }
    async function reconcile(p: PreparedMiningPublication) {
      let broadcastDenied: string | undefined;
      const step = createMiningPublicationReconciler(ownedDb, {
        domain: 'resources', backing: { reader: reader(backingReader), trust: backingTrust },
        settlement: { reader: reader(settlementReader), trust: settlementTrust }, timeoutMs,
        transport: inner => {
          active(); const combined = AbortSignal.any([inner, signal]), raw = transportSource(combined);
          const observed = reader(raw);
          return { ...observed, getGenesisHash: observed.getGenesisHash,
            getSignatureStatuses: observed.getSignatureStatuses, getBlockHeight: observed.getBlockHeight,
            sendRawTransaction: async (...args: Parameters<typeof raw.sendRawTransaction>) => {
              // The reconciler first attempts read-only finality. A missing or
              // offline publisher can therefore recover, but cannot send.
              if (!await ready()) { broadcastDenied = 'PUBLISHER_UNAVAILABLE'; fail(broadcastDenied); }
              active(); combined.throwIfAborted();
              if (!phaseEMiningEnabled()) { broadcastDenied = 'PAUSED'; fail(broadcastDenied); }
              return tracked(() => { combined.throwIfAborted(); return raw.sendRawTransaction(...args); });
            },
          };
        },
      });
      const result = await step({ epochId: p.epochId, attemptKey: p.attemptKey }); active();
      if (result.status === 'settled') return project();
      if (result.status === 'submitted') return Object.freeze({ status: 'submitted' as const, epochId: p.epochId });
      return held(broadcastDenied ?? result.reason, p.epochId);
    }
    function allocationSources(): FundedMiningAllocationSources {
      if (!sources || !sources.backing || !sources.tax || !blockhashSource) fail('PUBLICATION_SOURCE_UNAVAILABLE');
      const q = sources.qualification.source;
      return {
        ...sources,
        qualification: { ...sources.qualification, source: inner => { active(); return reader(typeof q === 'function' ? q(AbortSignal.any([inner, signal])) : q); } },
        backing: { ...sources.backing, reader: reader(sources.backing.reader) },
        tax: { ...sources.tax, connect: inner => { active(); return reader(sources.tax!.connect(AbortSignal.any([inner, signal]))); } },
        ...(sources.gems ? { gems: { ...sources.gems, connect: (inner: AbortSignal) => { active(); return sources.gems!.connect(AbortSignal.any([inner, signal])).map(r => reader(r)); } } } : {}),
        ...(sources.seeker ? { seeker: { ...sources.seeker, providers: sources.seeker.providers.map(p => ({ ...p,
          connect: (inner: AbortSignal) => { active(); return reader(p.connect(AbortSignal.any([inner, signal]))); },
        })) as unknown as NonNullable<FundedMiningAllocationSources['seeker']>['providers'] } } : {}),
        ...(sources.seekerEnrollment ? { seekerEnrollment: { ...sources.seekerEnrollment, providers: sources.seekerEnrollment.providers.map(p => ({ ...p,
          connect: (inner: AbortSignal) => { active(); return reader(p.connect(AbortSignal.any([inner, signal]))); },
        })) as unknown as NonNullable<FundedMiningAllocationSources['seekerEnrollment']>['providers'] } } : {}),
      };
    }
    async function scan(): Promise<MiningPublicationJobResult> {
      const [role] = await ownedDb.execute<{ allowed: boolean }>(sql`select current_user=session_user and not exists(
        select 1 from pg_class where oid in ('public.mining_publication_attempts'::regclass,'public.mining_publication_manifests'::regclass,
          'public.mining_publication_signing_reservations'::regclass,'public.mining_publication_signed_wires'::regclass,
          'public.mining_publication_settlements'::regclass,'public.mining_claim_entitlement_headers'::regclass,
          'public.mining_claim_entitlement_leaves'::regclass) and relowner<>current_user::regrole::oid) allowed`);
      if (!role?.allowed) return held('OWNER_REQUIRED');
      // Replay attempted originals before admitting another day. Sequence order
      // preserves cumulative predecessors; an unresolved oldest original holds
      // subsequent fresh publication rather than silently skipping history.
      const [row] = await ownedDb.execute<Candidate>(sql`select e.id "epochId",e.epoch_key "epochKey",
        split_part(e.epoch_key,':',2) "day",substring(e.epoch_key from '^resource-mining-v([23]):')::integer "policyVersion",
        a.attempt_key "attemptKey",(s.epoch_id is not null) settled
        from mining_ingot_epochs e left join mining_publication_attempts a on a.epoch_id=e.id
        left join mining_publication_manifests m on m.epoch_id=e.id
        left join mining_publication_settlements s on s.epoch_id=e.id
        where e.epoch_key ~ '^resource-mining-v[23]:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          and clock_timestamp()>=(split_part(e.epoch_key,':',2)::date::timestamp at time zone 'UTC')+${POLICY.daySec}*interval '1 second'
          and not exists(select 1 from mining_ingot_aborts b where b.epoch_id=e.id)
          and not exists(select 1 from mining_claim_entitlement_headers h where h.epoch_id=e.id)
        order by case when a.epoch_id is null then 1 else 0 end,(m.publication->>'sequence')::numeric nulls last,
          split_part(e.epoch_key,':',2),e.id limit 1`);
      if (!row) return Object.freeze({ status: 'idle' });
      epochId = row.epochId;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.epochId)
          || !/^\d{4}-\d{2}-\d{2}$/.test(row.day) || !Number.isFinite(Date.parse(row.day))
          || new Date(row.day).toISOString().slice(0, 10) !== row.day
          || ![2, 3].includes(row.policyVersion) || row.epochKey !== `resource-mining-v${row.policyVersion}:${row.day}`) fail('SOURCE_CONFLICT');
      day = row.day;
      let p = await getPreparedMiningPublication(ownedDb, epochId); active();
      if (p) { validPrepared(p, row); retryOriginal = true; resetDeadline(); }
      else if (row.attemptKey !== null || row.settled) fail('SOURCE_CONFLICT');
      if (row.settled) return project();
      const outbox = createMiningPublicationOutbox(ownedDb, { reader: reader(backingReader), trust: backingTrust, timeoutMs });
      const saved = await outbox.get(epochId); active();
      if (saved) { if (!p) fail('SOURCE_CONFLICT'); validReservation(saved, p); }
      if (saved?.signed) return reconcile(p!);
      admission();
      if (await readResourceMiningDayPolicy(ownedDb, row.day) !== row.policyVersion) fail('SOURCE_CONFLICT'); active();
      if (!await ready()) return held('PUBLISHER_UNAVAILABLE', epochId);
      admission();
      if (!p) {
        // The ingot and resource publishers share the on-chain sequence. Do not
        // freeze another immutable intent behind any unsettled original, even
        // one that has not reserved signing yet. Durable reservation uniqueness
        // remains the concurrent-writer fence; this is conservative admission.
        const [scope] = await ownedDb.execute<{ originalsInFlight: boolean }>(sql`select exists(
          select 1 from mining_publication_attempts a join mining_publication_manifests m on m.epoch_id=a.epoch_id
          where m.manifest_json::jsonb->'funding'->'source'->>'genesisHash'=${backingTrust.expectedGenesisHash}
            and m.publication->>'programId'=${backingTrust.programId.toBase58()}
            and m.manifest_json::jsonb->'funding'->'config'->>'address'=${configAddress}
            and not exists(select 1 from mining_publication_settlements s where s.epoch_id=a.epoch_id)
        ) "originalsInFlight"`);
        if (scope?.originalsInFlight !== false) return held('ORIGINAL_IN_FLIGHT', epochId);
        const allocation = allocationSources();
        const prepare = createResourceMiningPublicationPreparer(ownedDb, { signer: operator, sources: allocation,
          blockhashSource: inner => { active(); return reader(blockhashSource!(AbortSignal.any([inner, signal]))); } });
        const next = await prepare({ epochId, day: row.day, policyVersion: row.policyVersion, attemptKey: `resource-mining-job:${epochId}` }).catch(error => {
          if (errorCode(error) === 'PUBLISHER_UNAVAILABLE') fail('ONCHAIN_PUBLISHER_REFUSED');
          throw error;
        });
        // Retry becomes valid only after preparation actually returns its immutable original.
        if (next.status === 'prepared') { validPrepared(next, row); retryOriginal = true; }
        active();
        if (next.status !== 'prepared') { retryOriginal = false; return held('ABORT_PROPOSED', epochId); }
        p = next; validPrepared(p, row); resetDeadline();
      }
      admission();
      if (p.publication.signer !== operator.toBase58()) fail('SOURCE_CONFLICT');
      const request = { epochId, attemptKey: p.attemptKey };
      const original = saved ?? await outbox.reserveSigning(request); active(); validReservation(original, p);
      // Another process may have persisted this exact original while we read.
      if (original.signed) return reconcile(p);
      if (!await ready()) return held('PUBLISHER_UNAVAILABLE', epochId);
      admission();
      let wire: Uint8Array;
      try { wire = await tracked(() => publisher!.signOriginal(Object.freeze(structuredClone(original)), signal)); }
      catch (error) { active(); return held(errorCode(error) === 'SOURCE_UNAVAILABLE' ? 'SIGNING_UNCERTAIN' : errorCode(error), epochId); }
      active();
      // After tracked() accepts a timely wire, a pause cannot discard it. A wire
      // arriving after the deadline is dropped by tracked(); retry asks the same
      // signer for the same immutable message (deterministic ed25519 signature).
      // Persist exact bytes; the reconciler enforces any send admission.
      const retained = await outbox.acceptSigned({ ...request, signedTransaction: Uint8Array.from(wire) }); active();
      validReservation(retained, p); if (!retained.signed) fail('SOURCE_CONFLICT');
      return reconcile(p);
    }
    resetDeadline();
    void scan().then(result => { workDone = true; finish(result); release(); }, error => {
      workDone = true; finish(held(stopping ? 'CLOSED' : signal.aborted ? 'TIMEOUT' : errorCode(error), epochId)); release();
    });
    return reply;
  }
  function retryableOriginal(result: MiningPublicationJobResult | null): boolean {
    return retryOriginal && result?.status === 'held'
      && !['PAUSED', 'CLOSED', 'SOURCE_CONFLICT', 'EXPIRED_UNRESOLVED', 'FINALIZED_ERROR', 'OWNER_REQUIRED'].includes(result.reason);
  }
  function schedule() {
    if (stopping || !enabled) return;
    // A retained blockhash keeps aging during source outages; never back off its retry.
    const delay = retryableOriginal(lastResult) ? Math.min(INTERVAL_MS, intervalMs)
      : Math.min(60_000, intervalMs * 2 ** Math.min(6, Math.max(0, repeatedHolds - 1)));
    timer = setTimeout(() => { void tick(); }, delay); timer.unref();
  }
  async function tick() {
    try {
      const result = await runOnce(), current = flight;
      // A public timeout reply cannot authorize overlapping work. Wait for every
      // entered source/database call to drain before the single prompt retry.
      await current?.drained;
      if (!stopping && retryableOriginal(result)) {
        await runOnce(); const retried = flight; await retried?.drained;
      }
    } catch { /* close rejects new entry; every admitted scan records its result */ }
    finally { schedule(); }
  }
  return Object.freeze({ runOnce, getLastResult: () => lastResult,
    start() { if (started || stopping || !enabled) return; started = true; void tick(); },
    close() { return closing ??= (async () => { stopping = true; if (timer) clearTimeout(timer); const current = flight;
      current?.abort(); await current?.drained;
    })(); },
  });
}
