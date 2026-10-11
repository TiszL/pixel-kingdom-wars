/** Lazy unpaid E2 boundary. Import this from recovery flows, never the shell. */
import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { OrdinaryCraftingRequestSchema, matchOrdinaryCraftingEnvelope, type OrdinaryCraftingRequest, type OrdinaryCraftingEnvelope } from '@shardkeep/shared/ordinaryCraftingApi';
import { StarterFleetRequestSchema, matchStarterFleetEnvelope, type StarterFleetRequest, type StarterFleetEnvelope } from '@shardkeep/shared/starterFleetApi';
import { StarterExpeditionRequestSchema, matchStarterExpeditionEnvelope, type StarterExpeditionRequest, type StarterExpeditionEnvelope } from '@shardkeep/shared/starterExpeditionApi';
import { HarvesterSourceRequestSchema, matchHarvesterSourceEnvelope, type HarvesterSourceRequest, type HarvesterSourceEnvelope } from '@shardkeep/shared/harvesterApi';
import { requestUnpaidOriginal } from '../api';
import { captureFleetJourneyPublication, publishFleetDeparture } from '../fleetJourneyPresentation';

export type UnpaidCommand =
  | { kind: 'ordinary'; request: OrdinaryCraftingRequest }
  | { kind: 'installation'; request: StarterFleetRequest }
  | { kind: 'expedition'; request: StarterExpeditionRequest }
  | { kind: 'harvester'; request: HarvesterSourceRequest };
export type UnpaidProof = OrdinaryCraftingEnvelope | StarterFleetEnvelope | StarterExpeditionEnvelope | HarvesterSourceEnvelope;
export type UnpaidAcceptedProof = Extract<UnpaidProof, { status: 'accepted' }>;
export type UnpaidRefusal = { status: number; code: string };

const common = { BASE_NOT_OWNED: 404, BASE_ID_REQUIRED: 409, DEED_OWNERSHIP_CHANGED: 409,
  BASE_BEING_RAIDED: 423, DEED_AUTHORITY_UNAVAILABLE: 503 };
// Only documented pre-acceptance refusals. HTTP status alone, untyped failures,
// key conflicts and every replay refusal remain uncertain original outcomes.
const refusals: Record<UnpaidCommand['kind'], Record<string, number>> = {
  ordinary: { ...common, PHASE_E_DISABLED: 503, ORDINARY_WORKSHOP_REQUIRED: 409, ORDINARY_CRAFTING_BUSY: 409,
    ORDINARY_RECIPE_CHANGED: 409, ORDINARY_RECIPE_INVALID: 400, CRAFTING_STORAGE_FULL: 409,
    INSUFFICIENT_CRAFTING_STOCK: 422, INSUFFICIENT_RAW_STOCK: 422 },
  installation: { ...common, PHASE_E_DISABLED: 503, STARTER_BERTH_UNAVAILABLE: 409,
    STARTER_FAMILY_OCCUPIED: 409, STARTER_BERTH_OCCUPIED: 409 },
  expedition: { ...common, EXPEDITION_ACCESS_NO_COVERAGE: 409, EXPEDITION_ACCESS_EXPIRED: 409, EXPEDITION_ACCESS_UNAVAILABLE: 503, STARTER_EXPEDITIONS_DISABLED: 503, EXPEDITION_TERM_UNAVAILABLE: 503,
    EXPEDITION_HOME_UNAVAILABLE: 409, STARTER_FLEET_UNAVAILABLE: 409, STARTER_EXPEDITION_INFLIGHT: 409,
    EXPEDITION_LODGE_UNAVAILABLE: 409, EXPEDITION_ROUTE_INVALID: 400, EXPEDITION_ROUTE_CHANGED: 409 },
  harvester: { ...common, HARVESTERS_DISABLED: 503, EXPEDITION_TERM_UNAVAILABLE: 503,
    EXPEDITION_HOME_UNAVAILABLE: 409, HARVESTER_SOURCE_CHANGED: 409, HARVESTER_SOURCE_PENDING: 409,
    HARVESTER_POLICY_CHANGED: 409, HARVESTER_FACILITY_UNAVAILABLE: 409, HARVESTER_SETTLEMENT_PENDING: 409 },
};

function original(command: UnpaidCommand, wallet: string) {
  if (!command || Object.keys(command).some(key => !['kind', 'request'].includes(key))
    || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new Error('Invalid unpaid original identity');
  switch (command.kind) {
    case 'ordinary': { const request = OrdinaryCraftingRequestSchema.parse(command.request);
      return { request, path: '/ordinary-crafting/jobs', parse: (raw: unknown) => matchOrdinaryCraftingEnvelope(raw, wallet, request) }; }
    case 'installation': { const request = StarterFleetRequestSchema.parse(command.request);
      return { request, path: '/starter-fleet/installations', parse: (raw: unknown) => matchStarterFleetEnvelope(raw, wallet, request) }; }
    case 'expedition': { const request = StarterExpeditionRequestSchema.parse(command.request);
      return { request, path: '/starter-expeditions', parse: (raw: unknown) => matchStarterExpeditionEnvelope(raw, wallet, request) }; }
    case 'harvester': { const request = HarvesterSourceRequestSchema.parse(command.request);
      return { request, path: '/harvesters/sources', parse: (raw: unknown) => matchHarvesterSourceEnvelope(raw, wallet, request) }; }
    default: throw new Error('Invalid unpaid command family');
  }
}

/** No retry or generated key. POST callers first persist their original command
 * and attempt marker; firstAttempt is true only for that first durable attempt.
 * Both callbacks belong to the original identity's journal, not its live view.
 * Current-view GETs deliberately continue to use ordinary api.get. */
export async function unpaidOriginal(input: {
  wallet: string; command: UnpaidCommand; method: 'GET' | 'POST'; firstAttempt: boolean;
  signal?: AbortSignal; isCurrent: () => boolean; onCreated?: () => void;
  retainAccepted: (proof: UnpaidAcceptedProof) => Promise<void>;
  retainRefusal: (refusal: UnpaidRefusal) => Promise<void>;
}): Promise<UnpaidProof> {
  if (Object.keys(input).some(key => !['wallet', 'command', 'method', 'firstAttempt', 'signal', 'isCurrent', 'retainAccepted', 'retainRefusal', 'onCreated'].includes(key))
    || !['GET', 'POST'].includes(input.method) || typeof input.firstAttempt !== 'boolean'
    || typeof input.isCurrent !== 'function' || typeof input.retainAccepted !== 'function' || typeof input.retainRefusal !== 'function'
    || input.method === 'GET' && input.firstAttempt
    || input.onCreated !== undefined && (typeof input.onCreated !== 'function' || input.command.kind !== 'expedition' || input.method !== 'POST')) throw new Error('Invalid unpaid original options');
  const bound = original(input.command, input.wallet), kind = input.command.kind;
  const { method, firstAttempt, retainAccepted, retainRefusal } = input;
  const guard = () => { if (!input.isCurrent()) throw new Error('Journey view changed'); };
  const journey = method === 'POST' && kind === 'expedition' ? captureFleetJourneyPublication(input.command.request.baseId, guard) : null;
  let created = false;
  const result = await requestUnpaidOriginal({ method,
    path: method === 'GET' ? `${bound.path}/by-key/${bound.request.idempotencyKey}` : bound.path,
    ...(method === 'POST' ? { body: bound.request } : {}),
    ...(input.signal ? { signal: input.signal } : {}), isCurrent: input.isCurrent,
    timeoutMs: LAND_CHECKOUT_RECOVERY.requestTimeoutMs,
    observe: async (status, raw, headers) => {
      if (status >= 200 && status < 300) {
        const proof = bound.parse(raw);
        if (method === 'POST' && proof.status !== 'accepted') throw new Error('POST did not prove original acceptance');
        if (proof.status === 'accepted') await retainAccepted(proof);
        created = !!journey && status === 201 && headers?.get('x-pkw-journey-created') === '1';
        return proof;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1 || !('error' in raw)
        || !raw.error || typeof raw.error !== 'object' || Array.isArray(raw.error)) throw new Error('Invalid original error envelope');
      const error = raw.error as Record<string, unknown>;
      if (Object.keys(error).some(key => !['code', 'message'].includes(key)) || typeof error.code !== 'string'
        || typeof error.message !== 'string' || !error.message || !/^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)) throw new Error('Invalid original typed refusal');
      if (method === 'POST' && firstAttempt && refusals[kind][error.code] === status) {
        await retainRefusal({ status, code: error.code });
      }
      // api applies navigation only after its current-session guards. Unknown
      // but well-typed errors are surfaced there, never journaled as refusal.
      return undefined;
    },
  });
  if (created && journey) {
    await publishFleetDeparture('starter', input.wallet, result, guard, journey);
    if (journey.current()) input.onCreated?.();
  }
  return result;
}

/** Typed first consumer; the shared transport itself still imports no UI/store. */
export async function ordinaryOriginal(input: Omit<Parameters<typeof unpaidOriginal>[0], 'command' | 'retainAccepted'> & {
  request: OrdinaryCraftingRequest;
  retainAccepted: (proof: Extract<OrdinaryCraftingEnvelope, { status: 'accepted' }>) => Promise<void>;
}): Promise<OrdinaryCraftingEnvelope> {
  const { request: rawRequest, retainAccepted, ...options } = input;
  const request = OrdinaryCraftingRequestSchema.parse(rawRequest), wallet = input.wallet;
  return await unpaidOriginal({ ...options, command: { kind: 'ordinary', request },
    retainAccepted: proof => retainAccepted(matchOrdinaryCraftingEnvelope(proof, wallet, request) as Extract<OrdinaryCraftingEnvelope, { status: 'accepted' }>) }) as OrdinaryCraftingEnvelope;
}
