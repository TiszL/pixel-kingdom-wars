/** D153.187 pure PROPOSED numerical prerequisite. No runtime caller, real proof,
 * issuance authority or full recipe. All days/outcomes/source facts are supplied
 * by the caller. Synthetic proof inputs cannot establish source authentication.
 * Technical failure never manufactures terminal provider evidence (K140). */
import { PHASE_E_FRAGMENT_MODEL as P, PHASE_E_POLICY as LOCKED } from '../../packages/shared/src/constants';
const BPS = BigInt(LOCKED.basisPoints);
type Source = 'individual' | 'clan' | 'salvage';
type Bucket = { ceiling: bigint; issued: bigint; reserved: bigint };
export type Winner = { site: string; wallet: string };
type Period = Bucket & { term: string; startsDay: bigint; sources: Record<Source, Bucket>; sites: Set<string> };
export type Outcome = { kind: 'unknown' | 'technical-failure' | 'success' } | { kind: 'gameplay-failure'; rollBps: bigint };
type Commit = { id: string; wallet: string; earnedDay: bigint | null; day: bigint; period: string;
  family: string; tier: number; quotedFragments: bigint; boundInput: boolean; transferableOutput: boolean };
type Opportunity = { wallet: string; day: bigint; sourceId: string; attempt: string | null };
export interface Model {
  version: number; initial: bigint; burned: bigint; exempt: boolean;
  players: Map<string, bigint>; carry: Map<string, bigint>; periods: Map<string, Period>;
  opportunities: Map<string, Opportunity>; renownSources: Map<string, string>;
  attempts: Map<string, { input: Commit; reservedFragments: bigint; reservedSalvage: bigint; outcome: Outcome | null }>;
  terms: Map<string, Winner[] | null>; taxPools: Map<string, bigint>;
  entitlements: Map<string, Map<string, { wallet: string; amount: bigint; claimed: boolean }>>;
}
const require = (ok: boolean, why: string): void => { if (!ok) throw new Error(why); };
const positiveId = (id: string): void => require(id.length > 0, 'empty identity');
const amount = (n: bigint): void => require(n >= 0n, 'negative amount');
const add = (m: Map<string, bigint>, k: string, n: bigint): void => { m.set(k, (m.get(k) ?? 0n) + n); };
const key = (wallet: string, day: bigint): string => JSON.stringify([wallet, day.toString()]);
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v) === JSON.stringify(b, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
const clone = (s: Model): Model => structuredClone(s);
const bucket = (ceiling: bigint): Bucket => ({ ceiling, issued: 0n, reserved: 0n });
function period(s: Model, id: string): Period { const p = s.periods.get(id); require(!!p, 'missing period'); return p!; }
function known(s: Model, term: string): Winner[] { const w = s.terms.get(term); require(w != null, 'unavailable term authority'); return w!; }
function roster(w: readonly Winner[]): Winner[] {
  require(w.length <= P.seekerSites, 'winner maximum');
  const sorted = w.map(x => ({ ...x })).sort((a, b) => a.site < b.site ? -1 : a.site > b.site ? 1 : 0);
  sorted.forEach(x => { positiveId(x.site); positiveId(x.wallet); });
  require(new Set(sorted.map(x => x.site)).size === sorted.length, 'duplicate winning site'); return sorted;
}
export function validatePolicy(p: { allocations: readonly (readonly bigint[])[]; salvageMax: bigint;
  recipeInputs: readonly bigint[]; marketCreatesEligibility: boolean; opportunitiesPerWalletDay: bigint }): void {
  for (const a of p.allocations) require(a.length === 3 && a.every(n => n >= 0n) && a.reduce((x, n) => x + n, 0n) === BPS, 'allocation exceeds partition');
  require(p.salvageMax >= 0n && p.recipeInputs.every(n => n > p.salvageMax), 'fragment sink violated');
  require(!p.marketCreatesEligibility, 'market eligibility forbidden');
  require(p.opportunitiesPerWalletDay === 1n, 'duplicate opportunity policy');
}
export function createModel(initial: Record<string, bigint> = {}, exempt = false): Model {
  validatePolicy(P); const players = new Map(Object.entries(initial));
  players.forEach((n, id) => { amount(n); positiveId(id); });
  return { version: P.version, initial: [...players.values()].reduce((a, n) => a + n, 0n), burned: 0n, exempt,
    players, carry: new Map(), periods: new Map(), opportunities: new Map(), renownSources: new Map(),
    attempts: new Map(), terms: new Map(), taxPools: new Map(), entitlements: new Map() };
}
/** Winners are a frozen original-term synthetic snapshot. null models unavailable
 * authority; [] models proven zero. Neither can be substituted later. */
export function openPeriod(s: Model, id: string, term: string, startsDay: bigint, ceiling: bigint = P.weeklyCeiling,
  allocation: readonly bigint[] = P.allocations[0], winners: readonly Winner[] | null = []): Model {
  positiveId(id); positiveId(term); amount(ceiling); require(!s.periods.has(id), 'duplicate period');
  amount(startsDay); require(startsDay % P.periodDays === 0n, 'period must be aligned');
  require([...s.periods.values()].every(p => startsDay + P.periodDays <= p.startsDay || startsDay >= p.startsDay + P.periodDays), 'overlapping weekly period');
  validatePolicy({ ...P, allocations: [allocation] });
  const frozen = winners === null ? null : roster(winners);
  require(!s.terms.has(term) || equal(s.terms.get(term), frozen), 'term replay mismatch');
  const n = clone(s); n.terms.set(term, frozen);
  const [individual, clan, salvage] = allocation.map(bps => bucket(ceiling * bps / BPS));
  n.periods.set(id, { ...bucket(ceiling), term, startsDay, sources: { individual: individual!, clan: clan!, salvage: salvage! }, sites: new Set() }); return n;
}
function issue(s: Model, p: Period, source: Source, wallet: string, gross: bigint): void {
  known(s, p.term); require(!s.entitlements.has(p.term), 'original term already settled');
  const b = p.sources[source]; require(b.issued + b.reserved + gross <= b.ceiling, 'source budget exhausted');
  p.issued += gross; b.issued += gross;
  const carry = s.carry.get(wallet) ?? 0n;
  const numerator = gross * BigInt(LOCKED.taxes.resources.islandPoolBps) + carry;
  const tax = s.exempt ? 0n : numerator / BPS;
  if (!s.exempt) s.carry.set(wallet, numerator % BPS);
  add(s.players, wallet, gross - tax); add(s.taxPools, p.term, tax);
}
/** Fixed slot allowance means a vacancy can never enrich another winning site.
 * Clan members share existing gross award by sorted identity, before wallet tax. */
export function awardSite(s: Model, id: string, source: 'individual' | 'clan', slot: bigint, members: readonly string[]): Model {
  const n = clone(s); const p = period(n, id); known(n, p.term);
  const slots = BigInt(source === 'individual' ? P.individualSites : P.clanSites);
  require(slot >= 0n && slot < slots, 'invalid site'); const site = `${source}:${slot}`;
  require(!p.sites.has(site), 'site already consumed');
  const sorted = [...members].sort(); sorted.forEach(positiveId);
  require(new Set(sorted).size === sorted.length, 'duplicate member');
  require(source === 'clan' || sorted.length <= 1, 'individual roster');
  p.sites.add(site); const total = p.sources[source].ceiling / slots;
  sorted.forEach((wallet, i) => issue(n, p, source, wallet, total / BigInt(sorted.length) + (BigInt(i) < total % BigInt(sorted.length) ? 1n : 0n)));
  return n;
}
export function earnOpportunity(s: Model, e: { wallet: string; day: bigint; sourceId: string; increment: bigint;
  finalized: boolean; personallyEarned: boolean; source: string }): Model {
  require(e.finalized && e.personallyEarned && e.source === 'renown' && e.increment > 0n, 'requires personally earned finalized Renown increment');
  positiveId(e.wallet); positiveId(e.sourceId); amount(e.day); const identity = key(e.wallet, e.day);
  require(!s.renownSources.has(e.sourceId) || s.renownSources.get(e.sourceId) === identity, 'Renown source identity theft');
  const n = clone(s); n.renownSources.set(e.sourceId, identity);
  if (!n.opportunities.has(identity)) n.opportunities.set(identity, { wallet: e.wallet, day: e.day, sourceId: e.sourceId, attempt: null });
  return n;
}
/** Atomically reserve quoted fragment input and, only when earned, scarce
 * salvage capacity. Family/tier are chosen before the externally supplied result.
 * Full non-fragment material recipes and their source proof remain outside scope. */
export function precommit(s: Model, c: Commit): Model {
  positiveId(c.id); positiveId(c.wallet); positiveId(c.family); amount(c.day);
  const previous = s.attempts.get(c.id);
  if (previous) { require(equal(c, previous.input), 'commit replay mismatch'); return clone(s); }
  const n = clone(s); const p = period(n, c.period);
  require(c.day >= p.startsDay && c.day < p.startsDay + P.periodDays, 'commit outside period');
  require(!(c.boundInput && c.transferableOutput), 'bound input laundering');
  require(P.recipeInputs[c.tier] !== undefined && c.quotedFragments === P.recipeInputs[c.tier], 'invalid fragment quote');
  let reservedSalvage = 0n;
  if (c.earnedDay !== null) {
    amount(c.earnedDay); known(n, p.term); require(!n.entitlements.has(p.term), 'term closed');
    const o = n.opportunities.get(key(c.wallet, c.earnedDay)); require(!!o && o.attempt === null, 'missing or consumed opportunity');
    require(c.day >= c.earnedDay && c.day < c.earnedDay + P.admissionDays, 'opportunity expired or future');
    require(p.sources.salvage.issued + p.sources.salvage.reserved + P.salvageMax <= p.sources.salvage.ceiling, 'salvage budget exhausted');
    o!.attempt = c.id; reservedSalvage = P.salvageMax;
  }
  require((n.players.get(c.wallet) ?? 0n) >= c.quotedFragments, 'insufficient recipe fragments');
  add(n.players, c.wallet, -c.quotedFragments);
  p.reserved += reservedSalvage; p.sources.salvage.reserved += reservedSalvage;
  n.attempts.set(c.id, { input: { ...c }, reservedFragments: c.quotedFragments, reservedSalvage, outcome: null }); return n;
}
export function settle(s: Model, id: string, outcome: Outcome): Model {
  const n = clone(s); const a = n.attempts.get(id); require(!!a, 'missing precommitted attempt');
  if (outcome.kind === 'gameplay-failure') require(outcome.rollBps >= 0n && outcome.rollBps < BPS, 'invalid externally supplied roll');
  if (a!.outcome) { require(equal(a!.outcome, outcome), 'outcome replay mismatch'); return n; }
  if (outcome.kind === 'unknown' || outcome.kind === 'technical-failure') return n;
  const p = period(n, a!.input.period); const salvage = a!.reservedSalvage;
  p.reserved -= salvage; p.sources.salvage.reserved -= salvage;
  n.burned += a!.reservedFragments; a!.reservedFragments = 0n; a!.reservedSalvage = 0n;
  if (salvage > 0n && outcome.kind === 'gameplay-failure' && outcome.rollBps < P.salvageBps) issue(n, p, 'salvage', a!.input.wallet, salvage);
  a!.outcome = { ...outcome }; return n;
}
export function transfer(s: Model, from: string, to: string, quantity: bigint, sellerDeed: boolean, buyerDeed: boolean): Model {
  require(sellerDeed && buyerDeed, 'D190 deed trade gate'); amount(quantity); positiveId(to);
  require((s.players.get(from) ?? 0n) >= quantity, 'insufficient stock');
  const n = clone(s); add(n.players, from, -quantity); add(n.players, to, quantity); return n;
}
export function allocateTax(s: Model, term: string, winners: readonly Winner[]): Model {
  const sorted = roster(winners); require(equal(sorted, known(s, term)), 'winner replay differs from original term');
  const n = clone(s); if (n.entitlements.has(term)) return n;
  require([...n.periods.values()].every(p => p.term !== term || p.reserved === 0n), 'pending original reservation');
  const pool = n.taxPools.get(term) ?? 0n; const entries = new Map<string, { wallet: string; amount: bigint; claimed: boolean }>();
  sorted.forEach((w, i) => entries.set(w.site, { wallet: w.wallet, amount: pool / BigInt(sorted.length) + (BigInt(i) < pool % BigInt(sorted.length) ? 1n : 0n), claimed: false }));
  n.entitlements.set(term, entries); if (sorted.length > 0) n.taxPools.set(term, 0n); return n;
}
export function claimTax(s: Model, term: string, site: string): Model {
  const n = clone(s); const e = n.entitlements.get(term)?.get(site); require(!!e, 'missing entitlement');
  if (!e!.claimed) { e!.claimed = true; add(n.players, e!.wallet, e!.amount); } return n;
}
export function invariant(s: Model): { issued: bigint; reserved: bigint; unissued: bigint; stock: bigint } {
  let issued = 0n; let reserved = 0n; let unissued = 0n;
  for (const p of s.periods.values()) {
    require(p.issued >= 0n && p.reserved >= 0n && p.issued + p.reserved <= p.ceiling, 'gross budget invariant');
    let sourceIssued = 0n; let sourceReserved = 0n;
    for (const b of Object.values(p.sources)) { require(b.issued >= 0n && b.reserved >= 0n && b.issued + b.reserved <= b.ceiling, 'source invariant'); sourceIssued += b.issued; sourceReserved += b.reserved; }
    require(sourceIssued === p.issued && sourceReserved === p.reserved, 'source sum invariant');
    issued += p.issued; reserved += p.reserved; unissued += p.ceiling - p.issued - p.reserved;
  }
  const sum = (values: Iterable<bigint>): bigint => [...values].reduce((a, b) => { amount(b); return a + b; }, 0n);
  const stock = sum(s.players.values()) + sum(s.taxPools.values()) + sum([...s.entitlements.values()].flatMap(e => [...e.values()].filter(x => !x.claimed).map(x => x.amount))) + sum([...s.attempts.values()].map(a => a.reservedFragments)) + s.burned;
  require(s.initial + issued === stock, 'stock conservation');
  for (const [id, p] of s.periods) require(p.reserved === sum([...s.attempts.values()].filter(a => a.input.period === id).map(a => a.reservedSalvage)), 'attempt reservation invariant');
  for (const a of s.attempts.values()) require(a.outcome === null ? a.reservedFragments === a.input.quotedFragments : a.reservedFragments === 0n && a.reservedSalvage === 0n, 'attempt stock invariant');
  for (const carry of s.carry.values()) require(carry >= 0n && carry < BPS, 'carry invariant');
  return { issued, reserved, unissued, stock };
}
export type Rational = { n: bigint; d: bigint };
function rational(n: bigint, d: bigint): Rational { let a = n; let b = d; while (b !== 0n) [a, b] = [b, a % b]; return { n: n / a, d: d / a }; }
/** Optimistic fresh earned opportunity on every failure, unlimited remaining
 * budget; finite opportunities/budgets only reduce salvage and increase net sink.
 * Net is total supply consumption, including tax-stock conservation, not a price. */
export function recipeExpectation(tier: number): { attempts: Rational; fee: Rational; netFragments: Rational; grossFragments: Rational } {
  const input = P.recipeInputs[tier]; const odds = P.recipeSuccessBps[tier]; require(input !== undefined && odds !== undefined, 'unknown tier');
  return { attempts: rational(BPS, odds!), fee: rational(BPS * BigInt(LOCKED.craft.applicationFeeLamports), odds!),
    grossFragments: rational(input! * BPS, odds!),
    netFragments: rational(input! * BPS * BPS - (BPS - odds!) * P.salvageBps * P.salvageMax, odds! * BPS) };
}
