/** Internal current deed drawing input. Capture only; never settles gameplay. */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { matchBoundCosmeticBaseRead, type BoundCosmeticBaseRead } from '@shardkeep/shared/boundCosmeticVisual';
import type { BaseVisualContext } from '@shardkeep/shared/baseVisual';
import type { Db } from '../db/client';
import { bases, baseSlots, players } from '../db/schema';
import { readAdvancedServicePresentation } from './advancedServicePresentation';
import { resolveBaseVisual } from './baseVisual';
import { readBoundCosmeticBase } from './boundCosmeticPresentation';
import { RaidAdvancedPresentationSchema, type RaidAdvancedPresentation } from './raidAdvancedPresentation';
import { RaidStarterPresentationSchema, type RaidStarterPresentation } from './raidStarterPresentation';
import { readStarterFleetView } from './starterFleetView';
import { readStarterServicePresentation } from './starterServicePresentation';

const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const Drawing = z.object({
  expansions: z.number().int().nonnegative(),
  buildings: z.array(z.object({
    id: Uuid, type: z.string(), level: z.number().int().nonnegative(),
    tx: z.number().int(), ty: z.number().int(), underConstruction: z.boolean(),
    trapSpentAt: z.string().nullable().transform(value => {
      if (value === null) return null;
      const date = new Date(value);
      if (!Number.isFinite(+date)) throw new Error('Invalid captured trap clock');
      return date.toISOString();
    }),
  }).strict()),
  obstacles: z.array(z.object({ spriteKey: z.string(), tx: z.number().int(), ty: z.number().int() }).strict()),
}).strict();
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type CapturedDeedDrawing = Immutable<z.infer<typeof Drawing> & {
  version: 1;
  identity: { wallet: string; baseId: string; deedAssetId: string };
  admittedArtFingerprint: string;
  visualContext: BaseVisualContext;
  boundCosmetics: Extract<BoundCosmeticBaseRead, { state: 'available' }>;
  servicePresentation: RaidStarterPresentation;
  advancedServicePresentation: RaidAdvancedPresentation;
}>;

function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}

/** Picture identity only: cutoff and owner identity cannot cause idle repaints. */
export function deedDrawingFingerprint(drawing: CapturedDeedDrawing): string {
  return createHash('sha256').update(JSON.stringify({
    version: drawing.version, admittedArtFingerprint: drawing.admittedArtFingerprint,
    expansions: drawing.expansions, buildings: drawing.buildings, obstacles: drawing.obstacles,
    visualContext: drawing.visualContext, boundCosmetics: drawing.boundCosmetics,
    servicePresentation: drawing.servicePresentation,
    advancedServicePresentation: drawing.advancedServicePresentation,
  })).digest('hex');
}

/** Persisted identity only, for the later painter/uploader's race refusal.
 * This is not live chain ownership proof or an atomic database/R2 publication. */
export async function deedDrawingIdentityCurrent(db: Db, drawing: CapturedDeedDrawing): Promise<boolean> {
  if ('rollback' in db) throw new Error('Deed identity recheck requires a top-level database');
  const { wallet, baseId, deedAssetId } = drawing.identity;
  const [row] = await db.select({ id: bases.id }).from(bases)
    .innerJoin(baseSlots, eq(baseSlots.baseId, bases.id))
    .where(and(eq(bases.id, baseId), eq(bases.ownerWallet, wallet), eq(bases.deedAssetId, deedAssetId),
      eq(bases.status, 'active'), eq(baseSlots.wallet, wallet), eq(baseSlots.active, true)));
  return row !== undefined;
}

/** Null is explicit optional unavailability. Mandatory SQL/source errors throw.
 * The caller supplies an already admitted art fingerprint, never an HTTP value.
 * No lock survives this promise; painting and upload belong after it resolves. */
export async function captureDeedFleetDrawing(
  db: Db, wallet: string, baseId: string, deedAssetId: string, admittedArtFingerprint: string,
  clock: () => Date = () => new Date(),
): Promise<CapturedDeedDrawing | null> {
  if ('rollback' in db) throw new Error('Deed capture requires a top-level database');
  Address.parse(wallet); Uuid.parse(baseId); Address.parse(deedAssetId); Fingerprint.parse(admittedArtFingerprint);
  return db.transaction(async tx => {
    const [mode] = await tx.execute<{ isolation: string }>(sql`select current_setting('transaction_isolation') isolation`);
    if (mode?.isolation !== 'read committed') throw new Error('Deed capture requires read committed isolation');
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update', { noWait: true });
    if (!player) return null;
    const [base] = await tx.select({ id: bases.id }).from(bases).where(and(
      eq(bases.id, baseId), eq(bases.ownerWallet, wallet), eq(bases.deedAssetId, deedAssetId), eq(bases.status, 'active'),
    )).for('update', { noWait: true });
    if (!base) return null;
    const [slot] = await tx.select({ id: baseSlots.baseId }).from(baseSlots).where(and(
      eq(baseSlots.baseId, baseId), eq(baseSlots.wallet, wallet), eq(baseSlots.active, true),
    )).for('update', { noWait: true });
    if (!slot) return null;
    const cutoff = new Date(clock().getTime());
    if (!Number.isFinite(+cutoff)) throw new Error('Invalid deed capture cutoff');
    // One statement snapshot for EVERY mutable drawing field. A later move or
    // job completion cannot be substituted by the asynchronous painter.
    const [row] = await tx.execute<{ drawing: unknown }>(sql`select jsonb_build_object(
      'expansions', b.expansions,
      'buildings', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', x.id, 'type', x.type, 'level', x.level, 'tx', x.tx, 'ty', x.ty,
        'trapSpentAt', x.trap_spent_at, 'underConstruction', exists(
          select 1 from public.builder_jobs j where j.building_id=x.id and j.kind='build' and j.completed_at is null
        )) order by x.tx,x.ty,x.type,x.id), '[]') from public.buildings x where x.base_id=b.id),
      'obstacles', (select coalesce(jsonb_agg(jsonb_build_object(
        'spriteKey', o.sprite_key, 'tx', o.tx, 'ty', o.ty
        ) order by o.tx,o.ty,o.sprite_key,o.id), '[]') from public.obstacles o where o.base_id=b.id and o.cleared_at is null)
      ) drawing from public.bases b where b.id=${baseId}::uuid`);
    const drawing = Drawing.parse(row?.drawing);
    if (new Set(drawing.buildings.map(b => b.id)).size !== drawing.buildings.length)
      throw new Error('Duplicate captured building identity');
    const visualContext = await resolveBaseVisual(tx, baseId);
    const boundCosmetics: BoundCosmeticBaseRead = drawing.buildings.some(b => b.type === 'market')
      ? await readBoundCosmeticBase(tx, baseId, wallet)
      : { state: 'available', visual: { version: 1, marketAwnings: [] } };
    matchBoundCosmeticBaseRead(boundCosmetics, drawing.buildings);
    const fleet = await readStarterFleetView(tx, baseId);
    const starter = await readStarterServicePresentation(tx, baseId, drawing.buildings, fleet, cutoff);
    const [capability] = await tx.execute<{ ready: boolean }>(sql`select
      to_regprocedure('public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz)') is not null ready`);
    // Do not short circuit another mandatory source because starter is overdue
    // or the Market appearance is unavailable. Existing readers own integrity.
    const advanced = capability?.ready
      ? await readAdvancedServicePresentation(tx, wallet, baseId, drawing.buildings, cutoff) : null;
    if (starter === null || advanced === null || boundCosmetics.state !== 'available') return null;
    const servicePresentation = RaidStarterPresentationSchema.parse(starter);
    const advancedServicePresentation = RaidAdvancedPresentationSchema.parse(advanced);
    const berths = drawing.buildings.filter(b => b.type === 'berth').sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (servicePresentation.berths.length !== berths.length || advancedServicePresentation.berths.length !== berths.length
      || berths.some((b, i) => {
        const s = servicePresentation.berths[i]!, a = advancedServicePresentation.berths[i]!;
        return s.buildingId !== b.id || a.buildingId !== b.id
          || (s.installation !== null && a.installation !== null)
          || ((s.installation !== null || a.installation !== null) && (b.level < 1 || b.underConstruction));
      })) throw new Error('Conflicting captured fleet or building facts');
    return freeze({ version: 1 as const, identity: { wallet, baseId, deedAssetId }, admittedArtFingerprint,
      ...drawing, visualContext, boundCosmetics, servicePresentation, advancedServicePresentation });
  });
}
