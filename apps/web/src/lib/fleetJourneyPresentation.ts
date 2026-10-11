/** Ephemeral committed-response effects. Never use receipts or presence diffs as events. */
import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import type { FleetJourneyEvent } from '@shardkeep/shared/fleetJourneyPresentation';
import { authCookies } from '../auth/authCookieCoordinator';
import { useApp, type BaseStateDto } from '../state/store';
import { api } from './api';
import { bus } from './events';

let lifecycle = 0, installed = false, warm = '', seenScope = '';
const seen = new Set<string>();
function installGuards() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const invalidate = () => { lifecycle++; warm = ''; };
  for (const name of ['visibilitychange', 'freeze', 'resume']) document.addEventListener(name, invalidate);
  for (const name of ['pagehide', 'pageshow', 'focus', 'online']) window.addEventListener(name, invalidate);
  useApp.subscribe((next, previous) => {
    if (next.wallet !== previous.wallet || next.authed !== previous.authed
      || next.selectedBaseId !== previous.selectedBaseId || next.baseSelectionEpoch !== previous.baseSelectionEpoch
      || next.screen !== previous.screen) invalidate();
  });
}
function scopeKey() {
  const s = useApp.getState();
  return JSON.stringify([s.wallet, s.selectedBaseId, s.baseSelectionEpoch, authCookies.captureGeneration(), lifecycle]);
}
/** Capture before the request. The first response after hydration/resume only
 * establishes a warm baseline; dropped callbacks are never held for later. */
export function captureFleetJourneyPublication(baseId: string, guard: () => void = () => undefined) {
  installGuards();
  const s = useApp.getState(), key = scopeKey(), epoch = lifecycle, generation = authCookies.captureGeneration();
  const wallet = s.wallet, screen = s.screen, selection = s.baseSelectionEpoch, initialBase = s.base;
  const visible = () => typeof document !== 'undefined' && document.visibilityState !== 'hidden';
  const wasWarm = warm === key && initialBase?.baseId === baseId && initialBase.player.wallet === wallet;
  const current = () => {
    try {
      guard(); const now = useApp.getState();
      return (screen === 'base' || screen === 'build' || screen === 'layout') && visible() && lifecycle === epoch && authCookies.current(generation) && now.authed && !!wallet
        && now.wallet === wallet && now.selectedBaseId === baseId && now.baseSelectionEpoch === selection && now.screen === screen;
    } catch { return false; }
  };
  const emit = (event: FleetJourneyEvent, eventKey: (event: FleetJourneyEvent) => string) => {
    if (!current()) return;
    const scope = JSON.stringify([wallet, baseId, selection, generation]);
    if (scope !== seenScope) { seen.clear(); seenScope = scope; }
    const id = eventKey(event);
    if (seen.has(id)) return;
    seen.add(id); bus.emit('fleet:journey', event);
  };
  return { wallet, current, emit, sameSnapshot: () => initialBase?.baseId === baseId && initialBase.player.wallet === wallet && useApp.getState().base === initialBase,
    wasWarm, markWarm: () => { if (current()) warm = key; } };
}

/** Strip even malformed transient siblings: they may never reach the cache. */
export function stripFleetJourneyEvents<T extends object>(base: T): T {
  if (!Object.hasOwn(base, 'fleetJourneyEvents')) return base;
  const { fleetJourneyEvents: _discard, ...state } = base as T & { fleetJourneyEvents?: unknown };
  return state as T;
}
export async function publishFleetJourneyReturns(raw: unknown, base: BaseStateDto,
  scope: ReturnType<typeof captureFleetJourneyPublication>, stillNewest: () => boolean): Promise<void> {
  // Direct commits (for example Hero hydration) do not advance the wrapper's
  // read sequence. Bind the effect to the exact clean snapshot that was stored.
  const currentSnapshot = () => scope.current() && stillNewest() && useApp.getState().base === base;
  if (!scope.wasWarm || !currentSnapshot() || raw === undefined) return;
  try {
    const { matchFleetJourneyEventBatch, fleetJourneyEventKey } = await import('@shardkeep/shared/fleetJourneyPresentation');
    const batch = matchFleetJourneyEventBatch(raw, base.baseId!);
    // The response is a current committed snapshot, not a historical body.
    // A destroyed/missing/construction berth cannot receive an effect.
    if (batch.events.some(e => e.kind !== 'return' || !base.buildings.some(b => b.id === e.berthId
      && b.type === 'berth' && b.level >= 1 && !b.underConstruction) || !matchesReturnPresence(base, e))) return;
    if (!currentSnapshot()) return;
    for (const event of batch.events) { if (!currentSnapshot()) return; scope.emit(event, fleetJourneyEventKey); }
  } catch { /* Optional animation is dropped; authoritative state remains committed. */ }
}

function matchesReturnPresence(base: BaseStateDto, event: FleetJourneyEvent): boolean {
  if (event.vehicle.family === 'starter') {
    const installed = base.servicePresentation?.berths.find(b => b.buildingId === event.berthId)?.installation;
    return installed?.family === 'starter' && installed.presence === 'occupied';
  }
  const installed = base.advancedServicePresentation?.berths.find(b => b.buildingId === event.berthId)?.installation;
  return !!installed && installed.family === event.vehicle.family && installed.tier === event.vehicle.tier
    && (installed.presence === 'occupied' || installed.presence === 'exhausted');
}

/** Called only after a POST with both actual-commit markers has resolved through
 * its durable journal and current-session guard. All schemas remain lazy. */
export async function publishFleetDeparture(kind: 'starter' | 'advanced', wallet: string,
  raw: unknown, guard: () => void, scope: ReturnType<typeof captureFleetJourneyPublication>): Promise<void> {
  try {
    if (!scope.current() || !scope.sameSnapshot() || scope.wallet !== wallet) return;
    const [{ StarterExpeditionEnvelopeSchema, StarterExpeditionViewSchema }, { AdvancedExpeditionEnvelopeSchema },
      { AdvancedFleetEnvelopeSchema }, { BoundCosmeticWakeOriginalEnvelopeSchema, BoundCosmeticWakeCurrentEnvelopeSchema },
      { FleetJourneyEventSchema, fleetJourneyEventKey }] = await Promise.all([
      import('@shardkeep/shared/starterExpeditionApi'), import('@shardkeep/shared/advancedExpeditionApi'),
      import('@shardkeep/shared/advancedFleetApi'), import('@shardkeep/shared/boundCosmeticWakePresentation'),
      import('@shardkeep/shared/fleetJourneyPresentation'),
    ]);
    const proof = (kind === 'starter' ? StarterExpeditionEnvelopeSchema : AdvancedExpeditionEnvelopeSchema).parse(raw);
    if (proof.wallet !== wallet || proof.status !== 'accepted' || proof.return !== null) return;
    const receipt = proof.receipt, baseId = receipt.request.baseId;
    const current = () => { guard(); return scope.current() && scope.sameSnapshot(); };
    if (!current()) return;
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
    let originalRaw: unknown, activeRaw: unknown, fleetRaw: unknown;
    try {
      [originalRaw, activeRaw, fleetRaw] = await Promise.all([
        api.get(`/bound-cosmetics/wakes/v1/originals/${kind}/${receipt.expeditionId}`, { isCurrent: current, signal: abort.signal }),
        api.get(`/bound-cosmetics/wakes/v1/current?baseId=${baseId}`, { isCurrent: current, signal: abort.signal }),
        api.get(kind === 'starter' ? `/starter-expeditions?baseId=${baseId}` : `/vehicles/fleet?baseId=${baseId}`, { isCurrent: current, signal: abort.signal }),
      ]);
      abort.signal.throwIfAborted();
    } finally { clearTimeout(timer); abort.abort(); }
    if (!current()) return;
    const original = BoundCosmeticWakeOriginalEnvelopeSchema.parse(originalRaw), active = BoundCosmeticWakeCurrentEnvelopeSchema.parse(activeRaw);
    if (original.wallet !== wallet || original.kind !== kind || original.key !== receipt.expeditionId
      || original.status !== 'known' || original.returnedAt !== null || active.wallet !== wallet || active.baseId !== baseId) return;
    const p = original.presentation, trip = active.trips.find(t => t.kind === kind && t.expeditionId === receipt.expeditionId);
    if (p.baseId !== baseId || p.installationId !== receipt.installationId || p.departedAt !== receipt.departedAt
      || p.returnsAt !== receipt.returnsAt || p.realmId !== receipt.route.realmId || !trip
      || trip.installationId !== p.installationId || trip.departedAt !== p.departedAt || trip.returnsAt !== p.returnsAt
      || trip.homeRealmId !== p.homeRealmId || trip.realmId !== p.realmId || JSON.stringify(trip.wake) !== JSON.stringify(p.wake)) return;
    let berthId: string, vehicle: FleetJourneyEvent['vehicle'];
    if (kind === 'starter') {
      const fleet = StarterExpeditionViewSchema.parse(fleetRaw);
      if (fleet.wallet !== wallet || fleet.baseId !== baseId || fleet.installation?.installationId !== receipt.installationId
        || fleet.flight?.expeditionId !== receipt.expeditionId || fleet.flight.departedAt !== receipt.departedAt
        || fleet.flight.returnsAt !== receipt.returnsAt) return;
      berthId = fleet.installation.berthId; vehicle = { family: 'starter' };
    } else {
      const fleet = AdvancedFleetEnvelopeSchema.parse(fleetRaw), installed = fleet.vehicles.find(v => v.installationId === receipt.installationId);
      if (fleet.wallet !== wallet || fleet.baseId !== baseId || !installed?.away || !('family' in receipt.route)
        || installed.family !== receipt.route.family || installed.tier !== receipt.route.tier) return;
      berthId = installed.berthId; vehicle = { family: installed.family, tier: installed.tier };
    }
    const event = FleetJourneyEventSchema.parse({ version: 1, kind: 'departure', baseId, berthId,
      installationId: receipt.installationId, expeditionId: receipt.expeditionId, at: receipt.departedAt, vehicle, wake: p.wake });
    if (current()) scope.emit(event, fleetJourneyEventKey);
  } catch { /* A lost visual is safe. Never turn optional art into command failure/retry. */ }
}
