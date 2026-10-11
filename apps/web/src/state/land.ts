/**
 * THE CLIENT'S THIRD STATE — land ownership, derived from SERVER answers only.
 *
 * Before free onboarding the client was binary: `entryPaid` true (play) or false
 * (the ENTRY paywall, which was a wall — you could not reach a base at all).
 * Free onboarding (docs/LAND-DEED-ONBOARDING-PLAN.md, LOCKED OWNER DECISIONS
 * 2026-08-09) adds a middle: signed in, WITH a base, WITHOUT land.
 *
 * WHY THIS IS A PURE FUNCTION OF SERVER FACTS, AND NOT A FLAG:
 * `FREE_ONBOARDING` is a SERVER env. The client must never guess at it — a
 * client-side guess would either strand a paid-tier player on a base screen the
 * server refuses to serve, or hide the paywall from someone who still needs it.
 * So the two inputs are both server answers:
 *   • `landOwned` — `/me`.entryPaid / `/auth/verify`.entryPaid. The column still
 *     means exactly "this wallet paid 0.2 SOL on-chain" (LOCKED Q2), which under
 *     the new model IS land ownership. Renamed here, not re-meant.
 *   • `hasBase`  — did `GET /base` return a base? With FREE_ONBOARDING OFF a
 *     deedless wallet 402s and there is no base, so this collapses to exactly
 *     today's behaviour: `gated` → the blocking paywall. Nothing to flip.
 *
 * `paying` is the transient: the on-chain payment is in flight and the poll that
 * notices it lives in the ENTRY screen (useEntry), so the state must keep the
 * player there rather than let them wander off from their own confirmation.
 */

export type LandState =
  /** Not signed in — TITLE. */
  | 'anon'
  /** Signed in, NO base: the server will not open one until land is bought.
   *  This is the pre-free-onboarding world, and the blocking paywall. */
  | 'gated'
  /** 0.2 SOL is in flight; the ENTRY screen owns the confirmation poll. */
  | 'paying'
  /** Signed in WITH a base but no land: builds and mines, cannot extract,
   *  is not on the map, and can only be matched against other landless keeps. */
  | 'no-land'
  /** Signed in with land: the full game, exactly as it has always been. */
  | 'landowner';

/**
 * The one place the three states are decided. Order is load-bearing:
 * `landOwned` wins over everything (a credited payment ends `paying`), and the
 * base question is asked LAST because it is the only one that distinguishes
 * "free tier is on" from "free tier is off".
 */
export function landState(x: {
  authed: boolean;
  /** `GET /base` returned a base (server said yes), not "we hope it will". */
  hasBase: boolean;
  /** Server-confirmed 0.2 SOL / Land Deed purchase. */
  landOwned: boolean;
  /** An entry payment is mid-flight in this tab. */
  paying: boolean;
}): LandState {
  if (!x.authed) return 'anon';
  if (x.landOwned) return 'landowner';
  if (x.paying) return 'paying';
  return x.hasBase ? 'no-land' : 'gated';
}

/** True when the player may reach the base/build screens at all. */
export function canPlay(s: LandState): boolean {
  return s === 'no-land' || s === 'landowner';
}

/**
 * WHAT 0.2 SOL BUYS — the sales pitch, and it must stay a description of what
 * the SERVER actually grants. Every line maps to a gate in the plan's §2.2
 * route table; nothing aspirational belongs here (the deed's own "Trophies /
 * League" traits were advertised once and never delivered — see deed.test.ts).
 */
export const LAND_UNLOCKS: ReadonlyArray<{ title: string; sub: string }> = [
  // The frozen parcel is public; legacy allocation bindings stay private.
  { title: 'YOUR PARCEL', sub: 'One deed, one parcel: your own frozen land tile on the globe, plus a Land Deed NFT in your wallet.' },
  { title: 'GOLD FORGE', sub: 'Build the Forge and turn mined Shards into KEEP you can withdraw.' },
  // BOTH sides, because the server gates both: /market/list is `owned`, and so
  // are /market/listings/:id/reserve · /paid · /settle — which is the BUY path.
  // Only browsing (GET /market/listings) is free, so promising "sell" alone left
  // a deedless player to discover the buy refusal by tapping BUY.
  { title: 'TRADE ON THE MARKET', sub: 'Buy and sell items for SOL — and list your Land Deed itself. Browsing the book is free; both sides of a trade need land.' },
  { title: 'RAID LANDOWNERS', sub: 'Pick deeded bases on the globe, scout them first, and take their surplus.' },
  { title: 'PVE BOUNTIES', sub: 'Ruined-keep raids that pay a KEEP bounty three times a day.' },
  { title: 'CLANS', sub: 'Join a clan and share its chest.' },
];

/**
 * WHAT EACH LOCKED DOOR SAYS — one entry per screen a deedless player can still
 * open and would otherwise be refused by.
 *
 * These replace a toast. The pattern they exist to kill: the screen mounts, its
 * `owned` fetch 402s, api.ts raises the buy-land sheet globally, AND the screen's
 * own catch toasts 'BUY YOUR LAND TO UNLOCK THIS' underneath it — two refusals
 * for one tap, neither of which says what the screen was for.
 *
 * Every `why` states a gate that exists in apps/api/src/game/routes.ts today; the
 * route names are in the comments so a gate that moves takes its copy with it.
 */
export const LAND_LOCKED = {
  /** GET /forge + /forge/contribute · /claim · /allocations · /global · /convert
   *  are all `owned`, AND game/base.ts refuses to PLACE a `goldforge`. */
  forge: {
    title: 'THE GOLD FORGE NEEDS LAND',
    why: 'The Forge is the only way mined Shards become KEEP you can withdraw, so it opens with your Land Deed. Keep mining — the Shards you stack now are what you will smelt.',
  },
  /** POST /deposits refuses KEEP deposits for an unpaid wallet; SOL→KEEP sales
   *  are globally unavailable until reserve-backed; /withdrawals is `owned`. */
  keepWallet: {
    title: 'THE KEEP WALLET NEEDS LAND',
    why: 'KEEP only crosses between the game and your wallet once you own land — depositing and withdrawing wait on your Land Deed. SOL purchases are temporarily unavailable for everyone while reserve backing is prepared. Nothing you have mined is lost; Shards were never withdrawable.',
  },
  /** POST /withdrawals + GET /withdrawals are `owned`. */
  withdraw: {
    title: 'WITHDRAWALS NEED LAND',
    why: 'Withdrawing moves real KEEP out of the game, and that valve opens with your Land Deed.',
  },
  /** All six /2fa/* routes are `owned` — they exist only to make a withdrawal
   *  instant, and there are no withdrawals to make yet. Key export is NOT here:
   *  POST /auth/export/challenge is auth-only, on purpose (custody). */
  twofa: {
    title: '2FA UNLOCKS INSTANT WITHDRAWALS',
    why: 'A second factor skips the withdrawal cooldown, so it waits on land like withdrawals do. Exporting your private key does not — that is yours either way, and it is below.',
  },
  /** POST /clans · /:id/join · /leave · /kick AND the two reads
   *  GET /clans/mine · /clans are `owned` — the chest pays every member. */
  clans: {
    title: 'CLANS NEED LAND',
    why: 'A clan chest pays out to every member, so joining one waits on your Land Deed. The roster and the leaderboard come with it.',
  },
  /** GET /market/listings is FREE; /market/list and reserve/paid/settle/cancel
   *  are `owned`. So the book is browsable and neither side of a trade is. */
  market: {
    title: 'TRADING NEEDS LAND',
    why: 'Browse all you like — buying and selling both open with your Land Deed.',
  },
} as const satisfies Record<string, { title: string; why: string }>;

/** Free, and stays free — so the limited state reads as a tier, not a trial. */
export const LAND_FREE_TIER =
  'Free already: build, mine Shards, train your army, level heroes, quests and the campaign.';

/**
 * The two honest halves of having no land. Both are consequences of one
 * mechanism (no land ⇒ no plot ⇒ no deeded globe cell), so they are
 * stated together — a player told only the first would think they were being
 * protected for free.
 */
export const LAND_NO_MAP_NOTE =
  'Until you own land you have no deeded parcel or marker on the globe: nobody can find, scout or raid you — and you cannot raid landowners either. Landless keeps are matched against each other.';

/** Shards never leave the game; only KEEP does. Said out loud so free mining is
 *  not mistaken for free earning. */
export const LAND_SHARDS_NOTE = 'Shards stay in the game. Only KEEP can be withdrawn.';
