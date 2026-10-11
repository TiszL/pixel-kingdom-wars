/**
 * "THERE IS NOBODY TO FIGHT" — TWO POOLS, TWO ANSWERS (F10, free onboarding).
 *
 * `POST /raids` auto-match answers 404 when it finds nobody, and since free
 * onboarding it answers with TWO DIFFERENT codes because there are two pools
 * (apps/api/src/game/raids.ts): a landowner's ladder (`no_targets`) and the
 * landless pool (`no_targets_deedless`). They are not the same failure and must
 * not share a panel:
 *
 *   • a LANDOWNER has a world map and PvE ruins to fall back on — the existing
 *     panel routes to both, and it is unchanged;
 *   • a DEEDLESS player has NEITHER (no parcel ⇒ no roster row ⇒ nothing to pick
 *     and nobody to scout; PvE bounties are `owned`). Offering them WORLD MAP
 *     here would be a button whose only outcome is a 402.
 *
 * WHY THIS IS THE FIRST-RUN PATH, NOT AN EDGE CASE: the landless pool starts
 * EMPTY, so the very first free player to press FIND ME A TARGET gets this. Until
 * F10 the client matched neither the code nor this message and fell through to the
 * generic dead end (one red line + BACK TO BASE) — the primary CTA of a brand-new
 * account terminating in a shrug.
 *
 * Hook-free and prop-driven so raidNoTargets.test.tsx can assert the copy and the
 * exits by CALLING it (there is no jsdom in this package — see
 * mapChromeUI.test.tsx / RaidChooser.test.tsx for the pattern).
 */
import { ApiError } from '../lib/api';
import { Btn, COLORS as C, Icon } from './primitives';

/** Which matchmaking pool came back empty. */
export type NoTargetsPool = 'ladder' | 'deedless';

/**
 * Classify a failed auto-match. Returns null for every other failure, so the
 * caller's `outOfEnergy` / daily-cap / generic paths are untouched.
 *
 * GUARANTEE THIS MUST KEEP TRUE: an empty-pool 404 is NEVER classified null, and
 * a DEEDLESS empty pool is never classified 'ladder'. Being null is the dead end
 * F10 exists to remove; being 'ladder' would offer a landless player the world map
 * and PvE, two things the server will refuse with a 402.
 *
 * The CODE is the primary signal — api.ts's rule is that "reasons the client must
 * ACT on ride a code", and messages get reworded while codes do not: D-099
 * reworded BOTH messages to name the Keep restriction ("no deeded base at KEEP ≥
 * 6 …"), and RaidUI shows that server line VERBATIM above the exits, so the
 * player reads the rule, not a paraphrase. The message fallback exists only so
 * an OLDER api build (the 404 predates both codes) still gets routes instead of
 * the dead end; it is keyed on the words THAT build's messages cannot lose
 * ('settlers' names the landless pool; 'eligible targets' was the ladder's),
 * never on the whole sentence.
 */
export function noTargetsPool(e: unknown): NoTargetsPool | null {
  if (!(e instanceof ApiError)) return null;
  if (e.code === 'no_targets_deedless') return 'deedless';
  if (e.code === 'no_targets') return 'ladder';
  if (e.status !== 404) return null;
  if (/no other settlers/i.test(e.message)) return 'deedless';
  if (/no eligible targets/i.test(e.message)) return 'ladder';
  return null;
}

/** The honest headline. Not an error the player can fix — a fact about the world. */
export const NO_SETTLERS_TITLE = 'NO OTHER SETTLERS YET';
/**
 * Why, in the player's terms, and it says the true thing: the pool of landless
 * keeps is empty. It deliberately does NOT claim a number — the server does not
 * return a pool size and inventing one would be a second, unsourced game fact.
 */
export const NO_SETTLERS_WHY =
  'Landless keeps are only matched against each other, and right now there is no '
  + 'other landless keep free to fight. Nothing is wrong with your keep — the pool '
  + 'is empty.';

/**
 * The deedless empty-pool panel. Two REAL exits plus the caller's BACK TO BASE:
 *   • CAMPAIGN is primary because it is the true answer — free, no energy, no
 *     matchmaking, and it is always playable;
 *   • BUY LAND is the other one, because owning land is what opens the whole PvP
 *     world (map targets, scouting, PvE bounties) rather than just this pool.
 *
 * `entryFeeSol` is a PROP for the same reason LandGateSheet takes one: the price
 * must agree with the deployed on-chain Config PDA, so it stays a single sourced
 * value at the call site and this file never becomes a second home for it.
 */
export function DeedlessNoTargets({
  entryFeeSol, onCampaign, onBuyLand,
}: {
  entryFeeSol: number;
  onCampaign: () => void;
  onBuyLand: () => void;
}): React.JSX.Element {
  return (
    <>
      <div style={{ color: C.goldHi, fontSize: 17, letterSpacing: '1px' }}>{NO_SETTLERS_TITLE}</div>
      <div style={{ color: C.textDim, fontSize: 14, lineHeight: 1.45 }}>{NO_SETTLERS_WHY}</div>
      <Btn fontSize={18} onClick={onCampaign}>
        <Icon name="star" size={18} />PLAY CAMPAIGN
      </Btn>
      <Btn variant="sec" fontSize={16} onClick={onBuyLand}>
        <Icon name="sol" size={17} />BUY YOUR LAND · {entryFeeSol} SOL
      </Btn>
    </>
  );
}
