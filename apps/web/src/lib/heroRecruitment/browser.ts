import { mutationGate } from '../mutationGate';
import { BUILD_COSTS, HEROES, HERO_KEYS, buildCountCapForKeep } from '@shardkeep/shared';
import { HeroRecruitmentKeySchema, HeroRecruitmentRequestSchema } from '@shardkeep/shared/heroRecruitment';
import { api, API_URL, ApiError, type BasesDto } from '../api';
import { assertGameCurrency, chooseGameCurrency, exactGameCurrencyAvailable } from '../gameCurrency';
import { SOLANA_CLUSTER } from '../cluster';
import { playSfx } from '../audio';
import { haptic } from '../juice';
import { bus } from '../events';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp, captureBaseSnapshotGuard, commitBaseSnapshot, type BalancesDto, type BaseStateDto } from '../../state/store';
import { validatePlacement } from '../../ui/layoutEditor/model';
import { heroRecruitmentBrowserLock, type HeroRecruitmentPorts } from './controller';
import { makeHeroRecruitmentIntent, type HeroRecruitmentIdentity, type HeroRecruitmentIntent, type HeroRecruitmentHydration } from './journal';
const uuid = (value: unknown): value is string => HeroRecruitmentKeySchema.safeParse({ key: value }).success;
const amount = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function directory(raw: unknown): BasesDto {
  const r = raw as Partial<BasesDto> | null;
  if (!r || typeof r.enabled !== 'boolean' || typeof r.capabilities?.baseScopedReads !== 'boolean' || typeof r.capabilities?.baseScopedMutations !== 'boolean'
    || !Array.isArray(r.bases) || r.bases.some(b => !b || !uuid(b.id) || !['active', 'inactive'].includes(b.status)
      || !(b.slot === null || integer(b.slot) && b.slot > 0)) || new Set(r.bases.map(b => b.id)).size !== r.bases.length) throw new Error('The base directory did not refresh.');
  return r as BasesDto;
}
type Read = <T>(path: string) => Promise<T>;
const scoped = (path: string, id: string | null): string => id === null ? path : `${path}?baseId=${encodeURIComponent(id)}`;
async function ownership(wallet: string, read: Read, guard: () => void): Promise<{ directory: BasesDto; entryPaid: boolean }> {
  const me = await read<{ wallet: string; entryPaid: boolean }>('/me'); guard();
  if (!me || me.wallet !== wallet || typeof me.entryPaid !== 'boolean') throw new Error('The original Hero account did not refresh.');
  const d = directory(await read('/bases')); guard(); return { directory: d, entryPaid: me.entryPaid };
}
function readable(d: BasesDto, baseId: string | null): boolean {
  return baseId === null ? !d.enabled : d.enabled && d.capabilities.baseScopedReads && d.bases.some(b => b.id === baseId && b.status === 'active' && b.slot !== null);
}
function baseSnapshot(raw: unknown, wallet: string, baseId: string | null): BaseStateDto {
  const r = raw as BaseStateDto | null;
  if (!r || r.player?.wallet !== wallet || (r.baseId ?? null) !== baseId || !integer(r.player.keepLevel) || r.player.keepLevel < 1
    || !integer(r.freeBuilders) || !integer(r.claim?.min) || !integer(r.claim?.max) || r.claim.max <= r.claim.min
    || !Array.isArray(r.buildings) || !Array.isArray(r.obstacles) || !Array.isArray(r.jobs)
    || r.buildings.some(b => !b || !uuid(b.id) || typeof b.type !== 'string' || !integer(b.level) || !integer(b.tx) || !integer(b.ty) || typeof b.underConstruction !== 'boolean')
    || new Set(r.buildings.map(b => b.id)).size !== r.buildings.length
    || r.obstacles.some(o => !o || !uuid(o.id) || typeof o.spriteKey !== 'string' || !integer(o.tx) || !integer(o.ty))) throw new Error('The original Hero base did not refresh.');
  return r;
}
function balances(raw: unknown): BalancesDto {
  const r = raw as BalancesDto | null;
  if (!r || !amount(r.keep) || !amount(r.shards) || !Number.isFinite(r.keepRate)) throw new Error('The Hero balances did not refresh.');
  return r;
}
type HeroStock = { contracts: number; active: boolean };
function stock(raw: unknown, hero: typeof HERO_KEYS[number]): HeroStock {
  const rows = (raw as { catalog?: Array<{ id?: unknown; activation?: { kind?: unknown; active?: unknown; availableContracts?: unknown } }> } | null)?.catalog;
  if (!Array.isArray(rows)) throw new Error('Hero contract stock did not refresh.');
  const found = rows.filter(row => row?.id === HEROES[hero].recruitItemId);
  const a = found[0]?.activation;
  if (found.length !== 1 || a?.kind !== 'hero' || typeof a.active !== 'boolean' || !integer(a.availableContracts)) throw new Error('Hero contract stock is invalid.');
  return { contracts: a.availableContracts, active: a.active };
}
function roster(raw: unknown, hero: typeof HERO_KEYS[number]): { recruited: boolean; price: string } {
  const rows = (raw as { heroes?: Array<{ hero?: unknown; altar?: unknown; recruitItemId?: unknown; recruitCostKeep?: unknown; recruited?: unknown; available?: unknown }> } | null)?.heroes;
  if (!Array.isArray(rows)) throw new Error('The original Hero roster did not refresh.');
  const found = rows.filter(row => row?.hero === hero), h = found[0];
  if (found.length !== 1 || !h || h.altar !== HEROES[hero].altar || h.recruitItemId !== HEROES[hero].recruitItemId
    || !amount(h.recruitCostKeep) || h.recruitCostKeep !== String(HEROES[hero].recruitCostKeep)
    || typeof h.recruited !== 'boolean' || typeof h.available !== 'boolean') throw new Error('Hero recruitment details changed. Update the game before reviewing.');
  return { recruited: h.recruited, price: h.recruitCostKeep };
}
const heroOf = (intent: HeroRecruitmentIntent): typeof HERO_KEYS[number] => HERO_KEYS.find(hero => HEROES[hero].altar === intent.request.type)!;
/** Only original-scope reads may hydrate acceptance. Missing current ownership
 * is an unavailable destination, never a reason to substitute the selected base. */
export async function refreshHeroRecruitmentDestination(wallet: string, intent: HeroRecruitmentIntent, read: Read, guard: () => void): Promise<{
  hydration: HeroRecruitmentHydration; directory: BasesDto; entryPaid: boolean; base: BaseStateDto | null; balances: BalancesDto | null;
}> {
  const owned = await ownership(wallet, read, guard), id = intent.request.baseId;
  if (!readable(owned.directory, id)) return { ...owned, hydration: { base: 'unavailable', items: 'unavailable', roster: 'unavailable' }, base: null, balances: null };
  const b = baseSnapshot(await read(scoped('/base', id)), wallet, id); guard();
  const funds = balances(await read(scoped('/balances', id))); guard();
  const items = stock(await read(scoped('/items', id)), heroOf(intent)); guard();
  const heroes = roster(await read(scoped('/heroes', id)), heroOf(intent)); guard();
  if (items.active !== heroes.recruited) throw new Error('Hero inventory and roster changed during refresh. Check the original placement again.');
  const after = await ownership(wallet, read, guard);
  if (JSON.stringify(after) !== JSON.stringify(owned)) throw new Error('The original Hero base changed during refresh.');
  return { ...owned, hydration: { base: 'refreshed', items: 'refreshed', roster: 'refreshed' }, base: b, balances: funds };
}
export const heroRecruitmentIdentity = (wallet: string): HeroRecruitmentIdentity => ({ api: new URL(API_URL, window.location.origin).href, wallet, cluster: SOLANA_CLUSTER });
export function createHeroRecruitmentBrowserPorts(identity: HeroRecruitmentIdentity, lifecycle: () => { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean }): HeroRecruitmentPorts {
  const capture = (newAction: boolean): (() => void) => {
    const revision = authCookies.assertSession(), generation = authCookies.captureGeneration();
    const original = useApp.getState(), epoch = lifecycle().epoch;
    return () => {
      authCookies.assertResponse(revision); const current = useApp.getState(), page = lifecycle();
      if (!authCookies.current(generation) || !current.authed || current.wallet !== identity.wallet || !page.active
        || newAction && (!mutationGate.getSnapshot() || !page.visible || !page.actionsEnabled || current.screen !== 'build' || page.epoch !== epoch
          || current.selectedBaseId !== original.selectedBaseId || current.baseSelectionEpoch !== original.baseSelectionEpoch)) throw new Error('The account, base or page changed. Check the original saved Hero placement.');
    };
  };
  const read: Read = path => api.get(path);
  const validate = async (intent: HeroRecruitmentIntent, guard: () => void, retry: boolean): Promise<void> => {
    const owned = await ownership(identity.wallet, read, guard), id = intent.request.baseId;
    if (!readable(owned.directory, id) || owned.directory.enabled && !owned.directory.capabilities.baseScopedMutations) throw new Error('The original Hero base is unavailable for construction.');
    if (!retry && useApp.getState().selectedBaseId !== id) throw new Error('Review the base currently on screen.');
    const b = baseSnapshot(await read(scoped('/base', id)), identity.wallet, id); guard();
    const hero = heroOf(intent), spec = HEROES[hero];
    if (b.player.keepLevel < spec.unlockKeepLevel || b.player.keepLevel < BUILD_COSTS[intent.request.type].requiresKeepLevel!) throw new Error('Upgrade the Keep before recruiting this Hero.');
    const cap = buildCountCapForKeep(intent.request.type, b.player.keepLevel);
    if (cap === undefined || b.buildings.filter(row => row.type === intent.request.type).length >= cap) throw new Error('This base already has its Hero altar, including construction in progress.');
    if (b.freeBuilders === 0) throw new Error('A free builder is required.');
    const geometry = validatePlacement({ geometryVersion: 1, claim: b.claim,
      buildings: [...b.buildings, { id: intent.request.idempotencyKey, type: intent.request.type, level: 1, tx: intent.request.tx, ty: intent.request.ty, underConstruction: false }], obstacles: b.obstacles },
    b.buildings.map(row => ({ buildingId: row.id, tx: row.tx, ty: row.ty })), intent.request.idempotencyKey, intent.request.tx, intent.request.ty);
    if (geometry) throw new Error(geometry);
    const items = stock(await read(scoped('/items', id)), hero); guard();
    const heroes = roster(await read(scoped('/heroes', id)), hero); guard();
    if (heroes.recruited || items.active) throw new Error('This Hero is already recruited on the original base.');
    if (intent.request.heroContractOnly && items.contracts === 0) throw new Error('The original contract-only consent needs a Hero contract. No KEEP will be spent.');
    if (!intent.request.heroContractOnly && BigInt(heroes.price) > BigInt(intent.request.maxCostKeep)) throw new Error('The Hero price exceeds the original consent.');
    if (!intent.request.heroContractOnly && (items.contracts === 0 || intent.expectedCurrency)) {
      const funds = balances(await read(scoped('/balances', id))); guard();
      if (intent.expectedCurrency) {
        if (!exactGameCurrencyAvailable(funds)) throw new Error('Currency enforcement is unavailable. Keep the original command and refresh.');
        if (items.contracts === 0) assertGameCurrency(intent.expectedCurrency, heroes.price, funds);
      }
      else if (BigInt(funds.keep) < BigInt(heroes.price)) throw new Error('There is not enough KEEP for the original Hero placement.');
    }
  };
  const hydrate = async (intent: HeroRecruitmentIntent, guard: () => void): Promise<HeroRecruitmentHydration> => {
    const scope = captureBaseSnapshotGuard();
    const result = await refreshHeroRecruitmentDestination(identity.wallet, intent, read, guard); guard();
    const current = useApp.getState(); current.setEntryPaid(result.entryPaid); current.setBaseDirectory(result.directory);
    if (result.base && result.balances && current.selectedBaseId === intent.request.baseId
      && commitBaseSnapshot(scope, intent.request.baseId, result.base, result.balances)) bus.emit('base:refresh', undefined);
    return result.hydration;
  };
  return {
    get: read, post: (path, body, guard, expectedCurrency, observeResponseError) => api.postRaw(path, body, { isCurrent: () => { guard(); return true; }, ...(expectedCurrency ? { expectedCurrency } : {}), ...(observeResponseError ? { observeResponseError } : {}) }),
    currencyRefused: (error, currency) => error instanceof ApiError && error.status === 409 && error.code === 'CURRENCY_CONSENT_CHANGED' && error.details?.expectedCurrency === currency,
    lock: heroRecruitmentBrowserLock, capture, key: () => crypto.randomUUID(), unsupported: error => error instanceof ApiError && error.status === 404,
    confirmed: () => { playSfx('sfx_place_thump'); haptic('light'); }, validate, hydrate,
    refreshUnknownLegacy: async (intent, guard) => { await hydrate(intent, guard); },
    consent: async (input, key, mechanism, guard) => {
      const owned = await ownership(identity.wallet, read, guard);
      if (!readable(owned.directory, input.baseId) || useApp.getState().selectedBaseId !== input.baseId) throw new Error('Select the original base before reviewing.');
      const hero = HERO_KEYS.find(value => HEROES[value].altar === input.type)!;
      const items = stock(await read(scoped('/items', input.baseId)), hero); guard();
      const heroes = roster(await read(scoped('/heroes', input.baseId)), hero); guard();
      const request = HeroRecruitmentRequestSchema.parse({ ...input, idempotencyKey: key, heroContractOnly: items.contracts > 0, maxCostKeep: items.contracts > 0 ? '0' : heroes.price });
      let expectedCurrency;
      if (!request.heroContractOnly) {
        if (mechanism !== 'v1') throw new Error('This server cannot recover a paid Hero placement. Use a Hero contract or update before paying.');
        const funds = balances(await read(scoped('/balances', input.baseId))); guard();
        expectedCurrency = chooseGameCurrency(request.maxCostKeep, funds);
      }
      const intent = makeHeroRecruitmentIntent(mechanism, request, expectedCurrency); await validate(intent, guard, false); guard(); return intent;
    },
  };
}
