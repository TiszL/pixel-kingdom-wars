import { isResourceMiningManifest } from './resourceMiningAudit';
import { auditFundedMiningManifest, miningCanonical } from './fundedMiningAudit';
import { auditResourceMiningManifest } from './resourceMiningAudit';
import { getResourceMiningPublicationAttempt } from './resourcePublicationCustody';
import type { ResourceMiningOriginal, ResourceMiningDisposition } from './resourceMiningAllocation';
/** Reconstruct cumulative rights from immutable owner-held publications and
 * finalized custody receipts. No request-supplied leaves and no historical RPC. */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { keepAta } from '@shardkeep/chain';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { miningConfigPda, miningEpochPda, miningRootPda } from '@shardkeep/chain/mining-program';
import { verifyMiningPublicationSignedWire } from '@shardkeep/chain/mining-publication-wire';
import type { MiningBackingSnapshot } from '@shardkeep/chain/mining-backing';
import type { DbOrTx } from '../db/client';
import { auditInitialFreePublicationManifest, auditCumulativeFreePublicationManifest,
  type InitialFreeCapturedReservation } from './initialFreePublicationAudit';
import { assertCumulativeMiningFunding, type AuditedPriorMiningPublication,
  type MiningPriorReference } from './cumulativeFreePublication';
import { miningPublicationMessage, miningPublicationSchema } from './publicationEnvelope';

// Technical work bounds, never a truncation or an economic wallet cap.
const MAX_HISTORY = 1_024, MAX_HISTORY_BYTES = 64 * 1024 * 1024, MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const u64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine(v => /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) < 1n << 64n);
const address = z.string().max(44).refine(v => {
  if (v.length > 44) return false;
  try { return new PublicKey(v).toBase58() === v; } catch { return false; }
});
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const safe = z.number().int().nonnegative().safe();
const referenceSchema = z.object({ epochId: z.uuid(), sequence: u64, day: u64, root: digest, total: u64,
  leafCount: z.number().int().positive().max(10_000), sourceHash: digest, signature: z.string().min(64).max(88),
  publicationSlot: safe, messageSha256: digest, wireSha256: digest }).strict();
const identitySchema = z.object({ genesisHash: address, programId: address, configAddress: address,
  keepMint: address, reserveOwner: address, reviewedDeploymentSlot: safe, reviewedProgramDataSha256: digest }).strict();
const inputSchema = identitySchema.extend({ sequence: u64, expectedReference: referenceSchema.optional() }).strict();
type Identity = z.infer<typeof identitySchema>;
export type MiningHistoryRequest = z.infer<typeof inputSchema>;
type Code = 'INVALID_INPUT' | 'OWNER_REQUIRED' | 'HISTORY_UNAVAILABLE' | 'HISTORY_CONFLICT' | 'HISTORY_TOO_LARGE' | 'HISTORY_TIMEOUT';
export class MiningPublicationHistoryError extends Error {
  constructor(readonly code: Code) { super(`Mining publication history refused: ${code}`); this.name = 'MiningPublicationHistoryError'; }
}
function fail(code: Code): never { throw new MiningPublicationHistoryError(code); }
function check(v: unknown): asserts v { if (!v) fail('HISTORY_CONFLICT'); }
function object(v: unknown): Record<string, unknown> {
  check(v && typeof v === 'object' && !Array.isArray(v)); return v as Record<string, unknown>;
}
function sameReference(a: unknown, b: MiningPriorReference): void {
  const parsed = referenceSchema.safeParse(a); check(parsed.success);
  for (const key of Object.keys(b) as (keyof MiningPriorReference)[]) check(parsed.data[key] === b[key]);
}
async function owner(db: DbOrTx): Promise<void> {
  const [r] = await db.execute<{ allowed: boolean }>(sql`select current_user=(select pg_get_userbyid(relowner)
    from pg_catalog.pg_class where oid='public.mining_publication_manifests'::regclass) allowed`);
  if (!r?.allowed) fail('OWNER_REQUIRED');
}
function sourceIdentity(funding: unknown): Identity {
  const f = object(funding), s = object(f.source), c = object(f.config);
  return identitySchema.parse({ genesisHash: s.genesisHash, programId: s.programId, configAddress: c.address,
    keepMint: c.keepMint, reserveOwner: c.emissionReserveOwner, reviewedDeploymentSlot: s.reviewedDeploymentSlot,
    reviewedProgramDataSha256: s.reviewedProgramDataSha256 });
}
function sameIdentity(a: Identity, b: Identity): void {
  for (const k of Object.keys(a) as (keyof Identity)[]) check(a[k] === b[k]);
  check(miningConfigPda(new PublicKey(a.programId)).toBase58() === a.configAddress);
}
type Row = {
  epoch_id: string; manifest_json: string; source_hash: string; intent_sha256: string;
  intent_hex: string; reservations: InitialFreeCapturedReservation[] | null; publication: unknown;
  contributions: ResourceMiningOriginal[] | null; native_contributions: ResourceMiningOriginal[];
  contributions_sha256: string | null; resource_dispositions: ResourceMiningDisposition[] | null;
  signature: string; wire_hex: string; wire_sha256: string; message_sha256: string; receipt: unknown;
  dispositions: { reservationId: string; baseId: string; actorWallet: string; consumed: number; returned: number }[];
};

/** Owner rows are historical execution authority only after the original capture,
 * signed message, receipt and complete custody disposition agree. */
function auditRow(row: Row, identity: Identity, prior: AuditedPriorMiningPublication | null): AuditedPriorMiningPublication {
  check(Buffer.byteLength(row.manifest_json) <= MAX_MANIFEST_BYTES && hash(row.manifest_json) === row.source_hash);
  const manifest = object(JSON.parse(row.manifest_json)), p = miningPublicationSchema.parse(row.publication);
  sameIdentity(sourceIdentity(manifest.funding), identity);
  check(p.programId === identity.programId && p.keepMint === identity.keepMint && p.reserveOwner === identity.reserveOwner);
  check(object(manifest.input).epochId === row.epoch_id);
  check(/^(?:[0-9a-f]{2})+$/.test(row.intent_hex) && row.intent_hex.length <= 2464
    && /^(?:[0-9a-f]{2})+$/.test(row.wire_hex) && row.wire_hex.length <= 2464);
  const message = Buffer.from(row.intent_hex, 'hex'), wire = Buffer.from(row.wire_hex, 'hex');
  check(hash(message) === row.intent_sha256 && miningPublicationMessage(p, row.source_hash).equals(message));
  const signed = verifyMiningPublicationSignedWire({ intentBytes: message, signedTransaction: wire, signer: new PublicKey(p.signer) });
  check(signed.signature === row.signature && signed.wireSha256 === row.wire_sha256
    && signed.messageSha256 === row.message_sha256 && row.message_sha256 === row.intent_sha256);
  const audited = (() => {
    if (isResourceMiningManifest(manifest.version)) {
      check(row.reservations === null && row.dispositions === null && Array.isArray(row.contributions)
        && miningCanonical(row.contributions) === miningCanonical(row.native_contributions)
        && row.contributions_sha256 === object(manifest.epoch).contributionSetSha256);
      const resource = auditResourceMiningManifest({ manifestJson: row.manifest_json, publication: p,
        contributions: row.native_contributions, previousPublication: prior });
      check(miningCanonical(row.resource_dispositions) === miningCanonical(resource.contributions));
      return resource;
    }
    check(Array.isArray(row.reservations) && row.contributions === null && row.contributions_sha256 === null && row.resource_dispositions === null);
    const common = { manifestJson: row.manifest_json, publication: p, reservations: row.reservations };
    const legacy = (manifest.version === 3 || manifest.version === 4) ? auditFundedMiningManifest({ ...common, previousPublication: prior }) : prior === null ? auditInitialFreePublicationManifest(common)
      : auditCumulativeFreePublicationManifest({ ...common, previousPublication: prior });
    check(Array.isArray(row.dispositions) && row.dispositions.length === legacy.reservations.length);
    for (const [i, d] of row.dispositions.entries()) {
      const expected = legacy.reservations[i]!;
      check(d.reservationId === expected.reservationId && d.baseId === expected.baseId && d.actorWallet === expected.actorWallet
        && d.consumed === expected.proposedConsumed && d.returned === expected.proposedReturned);
    }
    return legacy;
  })();
  check(audited.sourceHash === row.source_hash);
  const receipt = object(row.receipt), program = new PublicKey(identity.programId);
  check(receipt.version === 1 && receipt.trust === 'trusted-finalized-rpc-reviewed-program'
    && receipt.genesisHash === identity.genesisHash && receipt.programId === identity.programId
    && receipt.reviewedDeploymentSlot === identity.reviewedDeploymentSlot
    && receipt.reviewedProgramDataSha256 === identity.reviewedProgramDataSha256
    && receipt.signature === row.signature && receipt.originalMessageSha256 === row.intent_sha256
    && receipt.signedTransactionSha256 === row.wire_sha256 && receipt.sourceHash === row.source_hash
    && receipt.config === identity.configAddress && receipt.mint === identity.keepMint
    && receipt.epoch === miningEpochPda(program, BigInt(p.day)).toBase58()
    && receipt.allocationRoot === miningRootPda(program, BigInt(p.sequence)).toBase58()
    && receipt.reserveAta === keepAta(new PublicKey(identity.reserveOwner), new PublicKey(identity.keepMint), true).toBase58()
    && receipt.totalCumulative === p.total && receipt.currentClaimsAuthorized === false && receipt.scoreFairnessVerified === false);
  for (const k of ['day', 'sequence', 'root', 'budgetGross', 'freeGross', 'deedGross', 'playerNet', 'recycle', 'tax',
    'taxCommitment', 'taxVersion', 'splitStart', 'splitEnd'] as const) check(receipt[k] === p[k]);
  const publicationSlot = safe.parse(receipt.slot), observed = safe.parse(receipt.observedAccountSlot);
  check(publicationSlot > identity.reviewedDeploymentSlot && publicationSlot >= p.blockhashContextSlot && observed >= publicationSlot);
  safe.parse(receipt.blockTime); u64.parse(receipt.fundedAt);
  const sequence = BigInt(p.sequence), day = BigInt(p.day);
  check(sequence === (prior?.declaration.sequence ?? 0n) + 1n && (!prior || day > prior.frontier.latestDay));
  const funding = object(manifest.funding), config = object(funding.config);
  const reference = referenceSchema.parse({ epochId: row.epoch_id, sequence: p.sequence, day: p.day, root: p.root,
    total: p.total, leafCount: p.leafCount, sourceHash: row.source_hash, signature: row.signature,
    publicationSlot, messageSha256: row.message_sha256, wireSha256: row.wire_sha256 });
  const frontier = Object.freeze({ genesisDay: prior?.frontier.genesisDay ?? BigInt(u64.parse(config.genesisDay)),
    latestSequence: sequence, latestDay: day, totalPublished: BigInt(p.total), totalPublishedHighwater: BigInt(p.total),
    taxHighwater: (prior?.frontier.taxHighwater ?? 0n) + BigInt(p.tax),
    recycledTotal: (prior?.frontier.recycledTotal ?? 0n) + BigInt(p.recycle),
    grossPublished: (prior?.frontier.grossPublished ?? 0n) + BigInt(p.freeGross) + BigInt(p.deedGross), splitCursor: p.splitEnd });
  return Object.freeze({ reference: Object.freeze(reference), declaration: audited.declaration, frontier });
}

export async function loadAuditedMiningPrior(db: DbOrTx, value: MiningHistoryRequest, signal?: AbortSignal): Promise<AuditedPriorMiningPublication> {
  const parsed = inputSchema.safeParse(value); if (!parsed.success || parsed.data.sequence === '0') fail('INVALID_INPUT');
  const active = () => { if (signal?.aborted) fail('HISTORY_TIMEOUT'); };
  const input = parsed.data; active(); await owner(db); active();
  if (BigInt(input.sequence) > BigInt(MAX_HISTORY)) fail('HISTORY_TOO_LARGE');
  try {
    // Read only lengths first. A large retained set cannot cause a large driver
    // allocation before the cumulative byte bound is enforced. Resource source
    // bytes cover retained originals, native originals and terminal line copies.
    const lengths = await db.execute<{ epoch_id: string; bytes: number; sequence: string }>(sql`select m.epoch_id,
      (octet_length(m.manifest_json)+octet_length(m.publication::text)+coalesce(octet_length(a.reservations::text),0)+3*coalesce(octet_length(a.contributions::text),0)
        +octet_length(s.receipt::text)+octet_length(a.intent_bytes)+octet_length(s.signed_transaction)) bytes,m.publication->>'sequence' sequence
      from mining_publication_manifests m join mining_publication_attempts a using(epoch_id)
      join mining_publication_settlements s using(epoch_id)
      where m.publication->>'programId'=${input.programId} and m.publication->>'keepMint'=${input.keepMint}
      and m.publication->>'reserveOwner'=${input.reserveOwner}
      and m.manifest_json::jsonb#>>'{funding,source,genesisHash}'=${input.genesisHash}
      and m.manifest_json::jsonb#>>'{funding,config,address}'=${input.configAddress}
      and (m.publication->>'sequence')::numeric<=${input.sequence}::numeric
      order by (m.publication->>'sequence')::numeric,m.epoch_id limit ${MAX_HISTORY + 1}`);
    active();
    if (lengths.length > MAX_HISTORY || lengths.reduce((n, r) => n + Number(r.bytes), 0) > MAX_HISTORY_BYTES) fail('HISTORY_TOO_LARGE');
    if (lengths.length !== Number(input.sequence)) fail('HISTORY_UNAVAILABLE');
    let prior: AuditedPriorMiningPublication | null = null;
    for (const [index, entry] of lengths.entries()) {
      active();
      check(entry.sequence === String(index + 1) && Number.isSafeInteger(Number(entry.bytes)) && Number(entry.bytes) > 0);
      const [row] = await db.execute<Row>(sql`select m.epoch_id,m.manifest_json,m.source_hash,m.intent_sha256,m.publication,
        encode(a.intent_bytes,'hex') intent_hex,a.reservations,a.contributions,a.contributions_sha256,
        case when a.contributions is not null then public.shardkeep_mining_resource_originals(m.epoch_id) else '[]'::jsonb end native_contributions,
        s.signature,encode(s.signed_transaction,'hex') wire_hex,
        s.wire_sha256,s.message_sha256,s.receipt,
        (select jsonb_agg(jsonb_build_object('reservationId',r.id,'baseId',r.base_id,'actorWallet',r.actor_wallet,
          'consumed',d.consumed_qty,'returned',d.returned_qty) order by r.base_id,r.id)
          from mining_ingot_dispositions d join mining_ingot_reservations r on r.id=d.reservation_id
          where d.epoch_id=m.epoch_id) dispositions,
        (select jsonb_agg(jsonb_build_object('id',r.id,'baseId',r.base_id,'actorWallet',r.actor_wallet,
          'lines',(select jsonb_agg(jsonb_build_object('resourceId',l.resource_id,'quantity',l.quantity::text,'unitValue',l.unit_value::text,'value',l.value::text) order by l.resource_id)
            from mining_contribution_lines l where l.receipt_id=r.id),'totalValue',r.total_value::text,'outcome',t.outcome) order by r.base_id,r.id)
          from mining_contribution_terminals t join mining_contribution_receipts r on r.id=t.receipt_id
          where t.epoch_id=m.epoch_id) resource_dispositions
        from mining_publication_manifests m join mining_publication_attempts a using(epoch_id)
        join mining_publication_settlements s using(epoch_id) where m.epoch_id=${entry.epoch_id}`);
      active(); check(row); prior = auditRow(row, input, prior);
    }
    if (!prior) fail('HISTORY_UNAVAILABLE');
    if (input.expectedReference) sameReference(input.expectedReference, prior.reference);
    return prior;
  } catch (error) { if (error instanceof MiningPublicationHistoryError) throw error; fail('HISTORY_CONFLICT'); }
}

/** Resource recovery authenticates native originals as well as the retained
 * attempt. Neither caller receipt JSON nor a current live provider can replace it. */
export async function auditStoredResourcePublication(db:DbOrTx,input:{manifestJson:string;publication:unknown}){
 if(Buffer.byteLength(input.manifestJson)>MAX_MANIFEST_BYTES)fail('HISTORY_TOO_LARGE');
 try{
  const manifest=object(JSON.parse(input.manifestJson));check(isResourceMiningManifest(manifest.version));
  const epochId=z.uuid().parse(object(manifest.input).epochId),attempt=await getResourceMiningPublicationAttempt(db,epochId);check(attempt);
  const [actual]=await db.execute<{contributions:ResourceMiningOriginal[]}>(sql`select public.shardkeep_mining_resource_originals(${epochId}) contributions`);
  check(actual&&miningCanonical(actual.contributions)===miningCanonical(attempt.contributions)
   &&object(manifest.epoch).contributionSetSha256===attempt.contributionSetSha256);
  const reference=manifest.previousPublication===null?null:referenceSchema.parse(manifest.previousPublication);
  const prior=reference===null?null:await loadAuditedMiningPrior(db,{...sourceIdentity(manifest.funding),sequence:reference.sequence,expectedReference:reference});
  return auditResourceMiningManifest({...input,contributions:actual.contributions,previousPublication:prior});
 }catch(error){if(error instanceof MiningPublicationHistoryError)throw error;fail('HISTORY_CONFLICT');}
}

export async function loadAuditedMiningPriorForBacking(db: DbOrTx, funds: MiningBackingSnapshot, signal?: AbortSignal): Promise<AuditedPriorMiningPublication> {
  const prior = await loadAuditedMiningPrior(db, { ...sourceIdentity(funds), sequence: String(funds.config.latestSequence) }, signal);
  try { assertCumulativeMiningFunding(funds, prior); } catch { fail('HISTORY_CONFLICT'); }
  check(funds.slot >= prior.reference.publicationSlot); return prior;
}

/** Saved preparation recovery selects the immutable prior by reference; it never
 * asks the current chain frontier to replace that historical predecessor. */
export async function auditStoredFreePublication(db: DbOrTx, input: {
  manifestJson: string; publication: unknown; reservations: readonly InitialFreeCapturedReservation[];
}) {
  if (Buffer.byteLength(input.manifestJson) > MAX_MANIFEST_BYTES) fail('HISTORY_TOO_LARGE');
  try {
    const manifest = object(JSON.parse(input.manifestJson));
    if (manifest.version === 1) return auditInitialFreePublicationManifest(input);
    if (manifest.version === 3 || manifest.version === 4) {
      const reference = manifest.previousPublication === null ? null : referenceSchema.parse(manifest.previousPublication);
      const prior = reference === null ? null : await loadAuditedMiningPrior(db, { ...sourceIdentity(manifest.funding), sequence: reference.sequence, expectedReference: reference });
      return auditFundedMiningManifest({ ...input, previousPublication: prior });
    }
    check(manifest.version === 2 && manifest.scope === 'initial-free-cumulative-keep-only');
    const reference = referenceSchema.parse(manifest.previousPublication);
    const prior = await loadAuditedMiningPrior(db, { ...sourceIdentity(manifest.funding), sequence: reference.sequence,
      expectedReference: reference });
    return auditCumulativeFreePublicationManifest({ ...input, previousPublication: prior });
  } catch (error) { if (error instanceof MiningPublicationHistoryError) throw error; fail('HISTORY_CONFLICT'); }
}
