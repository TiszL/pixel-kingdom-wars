import { useUserCommand } from './pk/useUserCommand';
/**
 * RAID destination chooser (owner 2026-08-09).
 *
 * WHY: tapping RAID used to run `setRaidTarget(null); setScreen('battle')` —
 * i.e. it silently auto-matched a random PvP opponent, and when the ladder had
 * nobody eligible the player's first experience of the button was a dead-end
 * "no eligible targets" dialog. The three ways to actually get into a fight
 * (auto-match, pick a target on the world map, play a campaign stage) already
 * existed but only two were reachable from here, and neither was named.
 *
 * So RAID now ASKS. Nothing about the destinations changed — each row performs
 * exactly the navigation the game already supported, which is what keeps this
 * a routing change rather than a gameplay one.
 *
 * FREE ONBOARDING (LOCKED OWNER DECISIONS 2026-08-09) adds a second shape.
 * A deedless player gets AUTO-MATCH ONLY: the server partitions matchmaking by
 * land ownership, so they fight other landless keeps — but they have no parcel,
 * therefore no row in the valley roster, therefore nothing to pick on the map
 * and nobody to scout. The map row survives as a LOOK-ONLY preview rather than
 * being deleted, because the world is the reason to buy land and a hidden button
 * cannot sell it. The landowner's chooser is unchanged, to the byte.
 *
 * F10: and in that shape CAMPAIGN — not auto-match — is the primary row, because
 * the landless pool starts EMPTY and auto-match therefore cannot succeed for the
 * first free player. See the comment on the deedless branch of `raidChoices`.
 */
import { RaidEntryCost } from './RaidEntryCost';
import { useApp } from '../state/store';
import { Btn, Chip, COLORS as C, Icon, ModalWrap, Phead, Sp } from './primitives';

/** Where a row sends you. `preview` = a look, not a target picker. */
export type RaidChoiceId = 'auto' | 'map' | 'campaign';

export interface RaidChoice {
  id: RaidChoiceId;
  icon: 'attack' | 'map' | 'star';
  title: string;
  sub: string;
  gold?: boolean;
  /** True only for the deedless WORLD MAP row: it opens the board to look at,
   *  and the copy must not promise target picking or scouting the server will
   *  refuse. Asserted in RaidChooser.test.tsx. */
  preview?: boolean;
}

/**
 * THE GATE, as data. A pure function so the deedless shape is testable without a
 * DOM: the landowner branch must stay identical to what shipped, and the deedless
 * branch must not contain a target-picking affordance.
 */
export function raidChoices(landOwned: boolean, onboarding = false): RaidChoice[] {
  if (landOwned && !onboarding) {
    return [
      {
        id: 'auto', icon: 'attack', gold: true, title: 'FIND ME A TARGET',
        sub: 'Auto-match a base near your trophies — the fastest fight.',
      },
      {
        id: 'map', icon: 'map', title: 'WORLD MAP',
        sub: 'Pick any base on the globe and scout it first — distance never matters.',
      },
      {
        id: 'campaign', icon: 'star', title: 'CAMPAIGN',
        sub: 'Single-player stages. Free, no energy, your base is never at risk.',
      },
    ];
  }
  // CAMPAIGN LEADS, and auto-match tells the truth about itself (F10).
  //
  // GUARANTEE THIS STATES: for a deedless player, exactly one row is a fight the
  // server can ALWAYS run, and it is the primary one. FIND ME A TARGET matches
  // against the landless pool, and that pool STARTS EMPTY — the first free player
  // to press it is guaranteed a 404 (`no_targets_deedless`). Presenting it as the
  // gold CTA sold a button that could not succeed. It stays present and reachable
  // (the pool fills as players arrive, and hiding PvP would hide the game), but it
  // no longer claims to be the fight on offer, and its copy admits the condition.
  //
  // No pool COUNT appears here: the server exposes none, and inventing one would
  // be an unsourced game number. The honesty is in the ordering and the copy; the
  // graceful landing is DeedlessNoTargets (raidNoTargets.tsx).
  return [
    {
      id: 'campaign', icon: 'star', gold: true, title: 'CAMPAIGN',
      sub: 'Single-player stages, always open. Free, no energy, your base is never at risk.',
    },
    {
      id: 'auto', icon: 'attack', title: 'FIND ME A TARGET',
      sub: landOwned ? 'Auto-match a base near your trophies.' : 'Auto-match another landless keep — your only PvP yet, and only when there is one free to fight.',
    },
    {
      id: 'map', icon: 'map', preview: !landOwned, title: landOwned ? 'WORLD MAP' : 'WORLD MAP — LOOK ONLY',
      sub: landOwned ? 'Pick a base on the globe and scout it first.' : 'Look at a region you own no parcel in. Buying land deeds you a parcel of your own, puts you on the map, and lets you choose and scout targets.',
    },
  ];
}

/** One destination row: icon + title + one line of why you'd pick it. */
function Choice({
  id, icon, title, sub, onClick, gold,
}: {
  /** Doubles as the first-run coach mark's anchor (ui/tutorial/guideCues.ts):
   *  WIN YOUR FIRST RAID points at CAMPAIGN, which is the one fight the server
   *  can always run for a brand-new player. A data hook because the row's text
   *  is a title plus a wrapped subtitle, and its accessible name must stay both. */
  id: RaidChoiceId;
  icon: 'attack' | 'map' | 'star'; title: string; sub: string; onClick: () => void;
  gold?: boolean | undefined;
}): React.JSX.Element {
  return (
    <span data-raid-choice={id} style={{ display: 'flex', flexDirection: 'column' }}>
      <Btn
        variant={gold ? 'gold' : 'sec'}
        fontSize={17}
        // Column layout so the subtitle can wrap on a 320px phone instead of
        // pushing the title out of the button.
        style={{
          flexDirection: 'column', alignItems: 'flex-start', gap: 2,
          padding: '11px 13px 13px', textAlign: 'left', minHeight: 60,
        }}
        onClick={onClick}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name={icon} size={19} />
          {title}
        </span>
        <span style={{
          fontSize: 12, lineHeight: 1.3, opacity: 0.72,
          fontFamily: 'inherit', whiteSpace: 'normal',
        }}>
          {sub}
        </span>
      </Btn>
    </span>
  );
}

export function RaidChooser({ onClose }: { onClose: () => void }): React.JSX.Element {
  const setScreen = useApp((s) => s.setScreen);
  const setRaidTarget = useApp((s) => s.setRaidTarget);
  const setMapTab = useApp((s) => s.setMapTab);
  const setWorldIntent = useApp((s) => s.setWorldIntent);
  // Same server-authoritative source the map's own pill reads (base.energy),
  // so the two can never disagree about how many raids are left.
  const energy = useApp((s) => s.base?.energy ?? null);
  // Server-confirmed land ownership (see state/land.ts). Never a client guess at
  // the server's FREE_ONBOARDING flag: with the flag off a deedless wallet never
  // reaches a base at all, so this branch is unreachable and the chooser renders
  // exactly today's three rows.
  const landOwned = useApp((s) => s.entryPaid);
  const onboarding = useApp((s) => s.onboardingStepCode === 'first_raid');

  const requestCommand = useUserCommand();
  const go = (fn: () => void): void => { requestCommand(() => { onClose(); fn(); }); };
  const open = (c: RaidChoice): void => {
    if (c.id === 'auto') { go(() => { setRaidTarget(null); setScreen('battle'); }); return; }
    go(() => { setMapTab(c.id === 'campaign' ? 'campaign' : 'world'); setWorldIntent(c.id === 'campaign' ? null : 'find-rival'); setScreen('map'); });
  };

  return (
    <ModalWrap onBackdrop={onClose}>
      <Phead title="RAID" onClose={onClose} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: 13 }}>
        {/* Budget up front: every row below spends from the same pool, and the
            old flow only revealed that after it had already picked a fight. */}
        {energy && (
          <Chip>
            <Icon name="energy" size={17} />
            <span style={{ color: C.textDim, fontSize: 13 }}>FREE ENERGY</span>
            <Sp />
            <span style={{ color: energy.free === 0 ? C.danger : C.gold }}>
              {energy.free}/{energy.max}
            </span>
          </Chip>
        )}

        <RaidEntryCost />

        {raidChoices(landOwned, onboarding).map((c) => (
          <Choice key={c.id} id={c.id} icon={c.icon} title={c.title} sub={c.sub} gold={c.gold} onClick={() => open(c)} />
        ))}

        {/* The call to action, once, at the bottom — under the two things that DO
            work, so the chooser reads as "here is your game, and here is more of
            it" rather than as a paywall wearing a chooser's hat. */}
        {!landOwned && (
          <Chip accent={C.goldDp} onClick={() => go(() => useApp.getState().setLandPrompt('browse'))}>
            <Icon name="sol" size={16} />
            <span style={{ color: C.goldHi, fontSize: 14 }}>BUY LAND TO RAID LANDOWNERS</span>
          </Chip>
        )}
      </div>
    </ModalWrap>
  );
}
