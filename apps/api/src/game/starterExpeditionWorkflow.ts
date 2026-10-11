/** Closed starter operations. Private composition owns fitted admission; all RPC
 * prefetch completes before game locks. Existing unfitted transport remains usable
 * without a private service; immutable originals recover before admission gates. */
import type { ReviewedSeekerSourcePolicy, ReviewedSeekerTermPolicy, SeekerTermRpc } from '@shardkeep/chain/seeker-terms';
import { applyEquipmentFitting,EquipmentFittingQueryFields,equipmentFittingQuery } from '@shardkeep/shared/phaseEOrdinaryEquipment';
import { PHASE_E_PAID_STARTER_ROUTES } from '@shardkeep/shared';
import { REALM_IDS } from '@shardkeep/shared/baseVisual';
import { PaidStarterRouteIdSchema, paidStarterRoutePreview } from '@shardkeep/shared/paidStarterExpeditions';
import { PaidStarterExpeditionQuerySchema, PaidStarterExpeditionViewSchema } from '@shardkeep/shared/paidStarterExpeditionApi';
import { STARTER_EXPEDITION_FEATURE, StarterExpeditionRequestSchema, StarterExpeditionUuidSchema,
  StarterExpeditionViewSchema, starterEquipmentRoutes, type StarterExpeditionRequest } from '@shardkeep/shared/starterExpeditionApi';
import { z } from 'zod';
import { multiBaseEnabled, starterExpeditionsEnabled } from '../config';
import type { Db, DbTx } from '../db/client';
import { HttpError } from '../lib/errors';
import { getBaseState } from './base';
import { assertFreshLockedBaseAuthority, requireFreshBaseAuthority } from './baseOwnership';
import { ExpeditionRealmAccessError, prefetchExpeditionRealmAccessReader } from './expeditionRealmAccess';
import { readPaidStarterCoverage, type StarterExpeditionAccessProvider } from './paidStarterExpeditionView';
import { requireActiveStablePrerequisiteBase } from './stableBasePrerequisites';
import { prefetchOperatingExpeditionTermReader } from './operatingExpeditionTermReader';
import { dispatchStarterExpeditionCommitted, matchStarterExpeditionCommand, readOwnedStarterExpedition } from './starterExpeditionDispatch';
import { starterExpeditionEnvelope } from './starterExpeditionView';
import type { WorkshopRouteDeps } from './workshopRoutes';

export interface StarterExpeditionProvider {
  readonly policy: ReviewedSeekerSourcePolicy | ReviewedSeekerTermPolicy;
  readonly connect: (signal: AbortSignal) => SeekerTermRpc;
}
export interface StarterExpeditionWorkflowDeps extends WorkshopRouteDeps { provider?: StarterExpeditionProvider | null; accessProvider?: StarterExpeditionAccessProvider | null }
export const StarterExpeditionViewQuerySchema = z.object({ baseId: StarterExpeditionUuidSchema, ...EquipmentFittingQueryFields }).strict().refine(v=>{try{equipmentFittingQuery(v);return true;}catch{return false;}},'Invalid equipment selection');
function workflow(db: Db, deps: StarterExpeditionWorkflowDeps, allowFitted: boolean) {
  // A transaction-bound db would fold the committed dispatch and its RPC prefetch
  // into the caller's transaction. Refuse when a starter operation RUNS, not when
  // buildApp registers the routes: an app built on a rolled-back fixture
  // transaction that never serves a starter route must still construct
  // (2026-10-10 CI cluster E: keep-custody-sinks/http failed at registration).
  const topLevel = () => { if ('rollback' in db) throw new Error('Starter workflow requires a top-level connection'); };
  const assertAdmission = () => {
    if (!starterExpeditionsEnabled()) throw new HttpError(503, 'Starter departures are paused', 'STARTER_EXPEDITIONS_DISABLED');
    if (!deps.provider) throw new HttpError(503, 'Genuine expedition term provider unavailable', 'EXPEDITION_TERM_UNAVAILABLE');
  };
  const lockedAuthority = async (tx: DbTx, wallet: string, baseId: string): Promise<void> => {
    await assertFreshLockedBaseAuthority(tx, wallet, baseId);
  };
  const authority = async (wallet: string, baseId: string) => {
    if (!multiBaseEnabled()) throw new HttpError(409, 'Starter expeditions require an explicit stable base', 'BASE_ID_REQUIRED');
    await requireFreshBaseAuthority(db, wallet, baseId, deps.market?.finalizedDeedReader ?? null, deps.market?.deedCollection ?? null);
  };
  return Object.freeze({
    read: async (wallet: string, key: string) => { topLevel(); return starterExpeditionEnvelope(db, wallet, StarterExpeditionUuidSchema.parse(key)); },
    paidView: async (wallet: string, raw: z.infer<typeof PaidStarterExpeditionQuerySchema>) => {
    topLevel();
    const { baseId, realm, fitting,resourceId } = PaidStarterExpeditionQuerySchema.parse({ ...raw, realm: String(raw.realm) });
    await authority(wallet, baseId);
    const selected = PaidStarterRouteIdSchema.options.find(id => PHASE_E_PAID_STARTER_ROUTES.routes[id] === REALM_IDS[realm]);
    if (!selected) throw new Error('Paid destination is not registered');
    const observation = await readPaidStarterCoverage(wallet, realm, deps.accessProvider);
    await requireActiveStablePrerequisiteBase(db, wallet, baseId);
    let route;try{route=applyEquipmentFitting(paidStarterRoutePreview(selected),equipmentFittingQuery({fitting,resourceId}));}catch{throw new HttpError(409,'This route cannot use the selected equipment',fitting==='survey_lens'?'LENS_ROUTE_UNAVAILABLE':'COMPASS_ROUTE_UNAVAILABLE');}
    return PaidStarterExpeditionViewSchema.parse({ wallet, baseId, realm, authorization: 'none',
      route, acceptingDepartures: starterExpeditionsEnabled() && !!deps.provider && !!deps.accessProvider && (!fitting || allowFitted), ...observation });
    },
    view: async (wallet: string, raw: z.infer<typeof StarterExpeditionViewQuerySchema>) => {
    topLevel();
    const { baseId, fitting,resourceId } = StarterExpeditionViewQuerySchema.parse(raw);
    await authority(wallet, baseId);
    const state = await getBaseState(db, wallet, new Date(), baseId, lockedAuthority);
    if (!state.starterExpeditions || !state.rawStock) throw new Error('Authorized expedition snapshot missing');
    return StarterExpeditionViewSchema.parse({ wallet, baseId,
      features: { starterExpeditions: STARTER_EXPEDITION_FEATURE }, acceptingDepartures: starterExpeditionsEnabled() && !!deps.provider && (!fitting || allowFitted),
      ...state.starterExpeditions, ...(fitting?{fitting:equipmentFittingQuery({fitting,resourceId}),routes:state.starterExpeditions.home?starterEquipmentRoutes(state.starterExpeditions.home,equipmentFittingQuery({fitting,resourceId})!):[]}:{}), rawStock: state.rawStock });
    },
    start: async (wallet: string, raw: StarterExpeditionRequest) => {
    topLevel();
    const request = StarterExpeditionRequestSchema.parse(raw);
    const { idempotencyKey: id, ...body } = request, command = { id, ...body };
    const original = await readOwnedStarterExpedition(db, wallet, id, true);
    if (original) {
      matchStarterExpeditionCommand(original, wallet, command);
      return { created: false, envelope: await starterExpeditionEnvelope(db, wallet, id) };
    }
    if (request.fitting && !allowFitted) throw new HttpError(503, 'Fitted departure owner capability unavailable', 'EQUIPMENT_OWNER');
    assertAdmission();
    await authority(wallet, request.baseId);
    const provider = deps.provider!, paid = PaidStarterRouteIdSchema.safeParse(request.routeId);
    let created: boolean;
    try {
      if (paid.success && !deps.accessProvider) throw new ExpeditionRealmAccessError('UNAVAILABLE');
      // All network observations precede game locks. Coverage and tax authority
      // remain independent; an owned permit never consults the sales pause.
      const access = paid.success ? await prefetchExpeditionRealmAccessReader(deps.accessProvider!.connect, deps.accessProvider!.trust,
        { wallet, realm: REALM_IDS.indexOf(PHASE_E_PAID_STARTER_ROUTES.routes[paid.data]) }) : undefined;
      const reader = await prefetchOperatingExpeditionTermReader(provider.connect, provider.policy);
      created = (await dispatchStarterExpeditionCommitted(db, wallet, command, { baseId: request.baseId, assertAuthority: lockedAuthority },
        { reader, assertAdmission, ...(access ? { readCoverage: access.readCoverage } : {}) })).created;
    } catch (error) {
      if (error instanceof ExpeditionRealmAccessError) {
        const blocked = error.code === 'NO_COVERAGE' || error.code === 'EXPIRED';
        throw new HttpError(blocked ? 409 : 503, blocked ? 'Paid destination coverage is not active' : 'Paid destination coverage unavailable',
          `EXPEDITION_ACCESS_${blocked ? error.code : 'UNAVAILABLE'}`);
      }
      throw error;
    }
    return { created, envelope: await starterExpeditionEnvelope(db, wallet, id) };
    },
  });
}
export function createStarterExpeditionWorkflow(db: Db, deps: StarterExpeditionWorkflowDeps = {}) { return workflow(db, deps, true); }
/** Explicit existing request-DB fallback; it cannot admit a new fitted trip. */
export function createUnfittedStarterExpeditionWorkflow(db: Db, deps: StarterExpeditionWorkflowDeps = {}) { return workflow(db, deps, false); }
export type StarterExpeditionWorkflow = ReturnType<typeof createStarterExpeditionWorkflow>;
