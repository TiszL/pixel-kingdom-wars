/**
 * THE QUEST BOARD — rebuilt 2026-08-28. Owner verdict on the shipped one:
 * "improve quest UI because it was awful."
 *
 * WHAT WAS ACTUALLY WRONG. It was a 342px modal holding ~56 identical `Chip`
 * rows in a 52vh scroller: one flat rectangle per quest, the label and the
 * reward and the button all on one line at one weight, and a bare word for
 * progress. Four separate failures, each fixed by something below:
 *
 *  1. NO HIERARCHY. Every row looked equally urgent, so the two rows that could
 *     actually pay you were invisible among fifty that could not. The board is
 *     now three named sections — the first-run chain, the weekly, the dailies —
 *     and CLAIMABLE is a different MATERIAL (the gold plate), not a different
 *     word at the end of a line.
 *  2. PROGRESS WAS TEXT. "· 2/5" told the player nothing at a glance. Every
 *     counted quest now has a real track in a recessed seat, so how close you
 *     are is readable without reading.
 *  3. IT WAS NOT PART OF THE GAME. Flat #14121A boxes with 2px borders next to
 *     a HUD that had just been re-crafted into forged pixel chrome. This screen
 *     is built from the SAME vocabulary — hudStripStyle for the header and the
 *     live objective, hudChipStyle for every recessed well, gold reserved for
 *     the active and the claimable state (ui/hudChrome.tsx).
 *  4. NOTHING TO DO. A quest you have not started offered no way to go and do
 *     it. The first-run chain's rows carry the verb and the route
 *     (ui/onboardingChain.ts) — the owner's "direct them to do things".
 *
 * MOBILE-FIRST, AND THAT IS A CONSTRAINT NOT A PREFERENCE: laid out for 360×800
 * and verified at 320×568. Every control is >= 44px on its short side, the row
 * is a column-in-a-row so a long label wraps instead of crushing the button, and
 * the shell is full-screen rather than a centred modal because 56 rows never fit
 * a 342px box without an inner scroller nobody can find the bottom of.
 *
 * NUMBERS: every value on this screen comes off the wire or out of
 * @shardkeep/shared. Nothing here decides what a quest pays.
 */
import { QUESTS } from '@shardkeep/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { selectedBasePath, withSelectedBase } from '../../lib/baseSelection';
import { playSfx } from '../../lib/audio';
import { bus } from '../../lib/events';
import { haptic } from '../../lib/juice';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { failToast } from '../actionError';
import { QUEST_LABELS } from '../copy';
import { HUD_FIELD, hudChipStyle, hudStripStyle } from '../hudChrome';
import { onboardingAction, type StepAction } from '../onboardingChain';
import { useFetch } from '../useFetch';
import { reloadBase } from '../sheets';
import { Btn, COLORS as C, Icon } from '../primitives';

const toast = (msg: string): void => bus.emit('ui:toast', { msg });
const home = (): void => useApp.getState().setScreen('base');

// ===========================================================================
// Wire shapes — GET /quests (apps/api game/quests.ts getQuestBoard)
// ===========================================================================

export interface Quest {
  id: string; scope: string; templateCode: string; target: number;
  /** SHARDS — the honest field (apps/api game/quests.ts getQuestBoard). */
  rewardShards?: number;
  /** @deprecated The same number under the wire name from when quests paid KEEP.
   *  Kept ONLY as the fallback for a server that predates `rewardShards`; it is
   *  never what the pill is labelled with. */
  rewardKeep?: number;
  progress: number; completed: boolean; claimed: boolean;
}
interface QuestBoard {
  day: string;
  allThreeBonus: number;
  quests: Quest[];
}

/** Order in the chain, for sorting the onboarding section. A code the server
 *  knows and this build does not sorts to the end rather than vanishing. */
const chainIndex = (templateCode: string): number => {
  const i = QUESTS.onboardingTemplates.findIndex((t) => t.id === templateCode);
  return i === -1 ? QUESTS.onboardingTemplates.length : i;
};

/** QUESTS PAY SHARDS (apps/api game/quests.ts claimQuest → rewardShards →
 *  shard_genesis, locked owner decision Q3 2026-08-09). Prefer the honest field,
 *  fall back to the deprecated one: `rewardKeep` is the legacy wire NAME for the
 *  same value, so the number is right against an old server too. */
const rewardOf = (q: Quest): number => q.rewardShards ?? q.rewardKeep ?? 0;

// ===========================================================================
// Chrome — the forged pieces this board is assembled from
// ===========================================================================

/**
 * The reward, as a recessed shard well.
 *
 * The SHARD icon is load-bearing, not decoration: this pill once carried the
 * KEEP icon, which advertised the WITHDRAWABLE currency for a reward that is not
 * withdrawable. landLocked.test.tsx pins the icon and the number against all
 * three server shapes, and it should keep doing so.
 *
 * A PLAIN FUNCTION, CALLED — never `<Reward/>`. That test asserts on the element
 * tree QuestRow RETURNS, without a renderer; a child component element would
 * hide its icon and its number behind an unevaluated function and the currency
 * check would silently pass on an empty tree. Same reason `track()` below is
 * called rather than mounted.
 */
function reward({ n, dim }: { n: number; dim?: boolean }): React.JSX.Element {
  return (
    <span style={{
      ...hudChipStyle('shard'),
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 7px',
      color: dim ? C.textFaint : C.goldHi, fontSize: 16, whiteSpace: 'nowrap',
      opacity: dim ? 0.75 : 1,
    }}>
      <Icon name="shard" size={14} />{n}
    </span>
  );
}

/**
 * A counted quest's progress, in a recessed seat with a gold fill.
 *
 * Whole-pixel edges and no gradient — the same rule the HUD chrome states about
 * its own animations. A blurred bar is the web-UI mush the forged look exists to
 * keep off this screen.
 */
function track({ progress, target }: { progress: number; target: number }): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, Math.round((progress / Math.max(1, target)) * 100)));
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
      <span style={{
        flex: 1, minWidth: 0, height: 8, background: HUD_FIELD,
        border: `1px solid ${C.ink}`, boxShadow: `inset 0 1px 0 ${C.ink}`, display: 'block',
      }}>
        <span style={{
          display: 'block', height: '100%', width: `${pct}%`,
          background: C.gold, boxShadow: `inset 0 2px 0 ${C.goldHi}`,
        }} />
      </span>
      {/* ONE text node, not three children: `{progress}/{target}` splits into
          '2', '/', '5', and any reader that joins children with a space — the
          element-tree reader in landLocked.test.tsx, and a screen reader — then
          says "2 slash 5" instead of the "2/5" on screen. */}
      <span style={{ color: C.textFaint, fontSize: 14, whiteSpace: 'nowrap' }}>
        {`${progress}/${target}`}
      </span>
    </span>
  );
}

/** A named band of the board. Reading order is the whole point of the rebuild,
 *  so each section says what it is and how many of it are ready to pay. */
function Section({ title, ready, children }: {
  title: string; ready?: number; children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '2px 2px 4px',
        borderBottom: `2px solid ${C.border}`,
      }}>
        <span style={{ color: C.gold, fontSize: 17, letterSpacing: '2px' }}>{title}</span>
        <span style={{ flex: 1 }} />
        {ready ? (
          <span style={{ color: C.goldHi, fontSize: 14, letterSpacing: '1px' }}>{ready} READY</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

// ===========================================================================
// The row
// ===========================================================================

/**
 * ONE QUEST.
 *
 * Exported and HOOK-FREE, because landLocked.test.tsx calls it as a plain
 * function to assert the currency a money surface advertises — the only way to
 * pin that in a package with no jsdom. Do not add a hook here.
 *
 * THE THREE STATES ARE THREE MATERIALS, not three words:
 *   claimable → the gold plate, a CLAIM button, and it sorts to the top
 *   in progress → the recessed shard well with a live track
 *   claimed → the same well, dimmed, with the reward struck through in grey
 *
 * @param weekly the weekly row: prefixed, and it shows its reward in EVERY
 *   state (App L1160) including next to a CLAIM button.
 * @param action the first-run chain's verb + route. Absent for dailies, whose
 *   "go and do it" is the whole game.
 */
export function QuestRow({ q, weekly, busy, onClaim, action, live }: {
  q: Quest; weekly?: boolean; busy: boolean; onClaim: () => void;
  action?: StepAction | undefined;
  /** The chain step the player is ON — gets the forged strip and the hint. */
  live?: boolean | undefined;
}): React.JSX.Element {
  const label = QUEST_LABELS[q.templateCode] ?? q.templateCode.toUpperCase();
  const claimable = q.completed && !q.claimed;
  const rewardWell = reward({ n: rewardOf(q), dim: q.claimed });
  // A claimable row is cut from the gold plate; the live chain step gets the
  // bar's own forged strip; everything else sits in the ordinary shard well.
  const shell = claimable
    ? {
      background: C.gold, border: `2px solid ${C.ink}`,
      boxShadow: `inset 0 3px 0 ${C.goldHi}, inset 0 -4px 0 ${C.goldDp}`,
    }
    : live ? hudStripStyle() : hudChipStyle('shard');
  const ink = claimable ? C.ink : q.claimed ? C.textFaint : C.text;
  return (
    <div style={{
      ...shell,
      display: 'flex', alignItems: 'center', gap: 9,
      padding: live && !claimable ? '9px 11px' : '7px 9px',
      minHeight: 44, opacity: q.claimed ? 0.62 : 1,
    }}>
      <Icon name={q.completed ? 'star' : 'quest'} size={22} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 16, lineHeight: 1.15, color: ink,
          // Wrap rather than clip: at 320px "WIN YOUR FIRST RAID" plus a button
          // does not fit one line, and a truncated instruction is not one.
          overflowWrap: 'anywhere',
        }}>
          {weekly ? `WEEKLY: ${label}` : label}
        </div>
        {/* Counted quests get the track. A single-shot quest would render a
            meaningless 0/1, which is exactly what the old board did. */}
        {q.target > 1 && !q.claimed && track({ progress: q.progress, target: q.target })}
        {/* The hint replaces the tutorial card this step retired, so it only
            appears on the step the player is actually standing on. */}
        {live && action && !claimable && (
          <div style={{ color: C.textDim, fontSize: 14, lineHeight: 1.3, marginTop: 4 }}>
            {action.hint}
          </div>
        )}
      </div>
      {/* EVERY row shows what it pays, in every state — including the claimable
          one. The old board hid the reward exactly when the player was about to
          take it, which is the one moment "what it pays" is the question being
          asked. The recessed well reads as an inset on the gold plate. */}
      {rewardWell}
      {/* THE LIVE CHAIN ROW WEARS THE COACH-MARK HOOKS (ui/tutorial/guideCues.ts).
          The quest board unmounts the base HUD, so when the player is standing
          here this button is the only control the guided flow can point at — and
          it must be the LIVE step's, never a row further down the chain that the
          player cannot act on yet. On a wrapper because Btn forwards no data-*
          props and an aria-label would overwrite CLAIM / BUILD / RAID. */}
      {claimable ? (
        <span {...(live ? { 'data-onboarding-claim': '1' } : {})} style={{ display: 'inline-flex' }}>
          <Btn fontSize={16} disabled={busy} style={{ minHeight: 44, minWidth: 78, padding: '6px 14px 8px' }} onClick={onClaim}>
            CLAIM
          </Btn>
        </span>
      ) : q.claimed ? (
        <span aria-label="Claimed" style={{ color: C.success, fontSize: 15, minWidth: 44, textAlign: 'right' }}>DONE</span>
      ) : action ? (
        <span {...(live ? { 'data-onboarding-cta': '1' } : {})} style={{ display: 'inline-flex' }}>
          <Btn variant={live ? 'gold' : 'sec'} fontSize={16} disabled={busy || !!action.disabled}
            style={{ minHeight: 44, minWidth: 78, padding: '6px 14px 8px' }} onClick={action.go}>
            {action.verb}
          </Btn>
        </span>
      ) : null}
    </div>
  );
}

// ===========================================================================
// The screen
// ===========================================================================

export function QuestsScreen(): React.JSX.Element {
  const selectedBaseId = useApp((state) => state.selectedBaseId);
  useApp((state) => state.base);
  useApp((state) => state.placing);
  useApp((state) => state.entryPaid);
  const { data, error, reload } = useFetch<QuestBoard>(
    () => api.get<QuestBoard>(selectedBasePath('/quests')),
    [selectedBaseId],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const pending = useRef(false);
  const claimGeneration = useRef(0);
  useEffect(() => () => { claimGeneration.current++; }, []);
  useEffect(() => {
    const off = [bus.on('base:refresh', reload), bus.on('onboarding:refresh', reload)];
    return () => { off.forEach((unsubscribe) => unsubscribe()); };
  }, [reload]);

  const claim = (id: string): void => {
    if (pending.current) return;
    pending.current = true;
    const guard = captureBaseSnapshotGuard();
    setBusy(id);
    void api.post(`/quests/${id}/claim`, withSelectedBase({}))
      .then(() => {
        if (!isBaseSnapshotGuardCurrent(guard)) return;
        playSfx('sfx_quest_done'); haptic('light');
        toast(data?.quests.find((q) => q.id === id)?.templateCode === 'first_raid'
          ? 'FIRST STEPS COMPLETE — EXPLORE THE CAMPAIGN AND DAILY QUESTS' : 'QUEST CLAIMED');
        reload();
        // The chain's objective strip reads GET /tutorial, so a claim made here
        // has to tell it to move on — otherwise the base screen keeps offering a
        // step the player has already been paid for.
        bus.emit('onboarding:refresh', undefined);
        return reloadBase();
      })
      .catch((e: Error) => failToast(e, e.message))
      .finally(() => { pending.current = false; setBusy(null); });
  };

  const claimAll = async (): Promise<void> => {
    if (pending.current) return;
    // Freeze both the reviewed quests and the deed. A refresh must never add
    // claims to this click or send its remaining requests to another base.
    const ids = (data?.quests ?? []).filter((q) => q.completed && !q.claimed).map((q) => q.id);
    if (!ids.length) return;
    const guard = captureBaseSnapshotGuard();
    const body = withSelectedBase({});
    const generation = ++claimGeneration.current;
    const current = (): boolean => generation === claimGeneration.current
      && isBaseSnapshotGuardCurrent(guard);
    pending.current = true;
    setBusy('all');
    let confirmed = 0;
    let interrupted = false;
    try {
      for (const id of ids) {
        if (!current()) return;
        await api.post(`/quests/${id}/claim`, body);
        confirmed++;
      }
    } catch {
      // A lost response can mean the claim paid. Re-read the board; never
      // repeat that mutation blindly or call the whole batch successful.
      interrupted = true;
    } finally {
      if (current()) {
        if (confirmed > 0) { playSfx('sfx_quest_done'); haptic('light'); }
        toast(interrupted ? `${confirmed} CLAIMS CONFIRMED — REFRESHING; RETRY REMAINING QUESTS`
          : `${confirmed} ${confirmed === 1 ? 'QUEST' : 'QUESTS'} CLAIMED`);
        reload();
        bus.emit('onboarding:refresh', undefined);
        void reloadBase().catch(() => {
          if (current()) toast('REWARDS REFRESH FAILED — REOPEN QUESTS TO CHECK');
        });
      }
      if (generation === claimGeneration.current) { pending.current = false; setBusy(null); }
    }
  };

  const actionFor = (q: Quest): StepAction | undefined => {
    const action = onboardingAction(q.templateCode);
    if (!action) return undefined;
    return { ...action, go: () => {
      if (pending.current) return;
      pending.current = true;
      setBusy(q.id);
      void Promise.resolve().then(action.go)
        .catch((e: Error) => failToast(e, e.message))
        .finally(() => { pending.current = false; setBusy(null); });
    } };
  };

  const all = data?.quests ?? [];
  const readyCount = all.filter((q) => q.completed && !q.claimed).length;
  // THE CHAIN IS THE FIRST THING A NEW PLAYER SEES, in its authored order, and
  // it disappears entirely once every step is claimed — a veteran's board must
  // not carry five permanent DONE rows.
  const chain = all.filter((q) => q.scope === 'onboarding')
    .slice()
    .sort((a, b) => chainIndex(a.templateCode) - chainIndex(b.templateCode));
  const chainDone = chain.length > 0 && chain.every((q) => q.claimed);
  // The step the player is ON: the first one not yet claimed. Same rule the
  // server uses for the objective strip (getOnboardingStep), so the two surfaces
  // can never disagree about where the player is.
  const liveStep = chain.find((q) => !q.claimed);

  const weekly = all.filter((q) => q.scope === 'weekly');
  // With ~50 rows the ORDER is the UX: claimable first (the payoff), then
  // in-progress by how close they are, then untouched, claimed at the bottom.
  const dailies = all.filter((q) => q.scope === 'daily')
    .slice()
    .sort((a, b) => {
      const rank = (q: Quest): number =>
        q.completed && !q.claimed ? 0 : !q.completed && q.progress > 0 ? 1 : !q.completed ? 2 : 3;
      const ra = rank(a); const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 1) return (b.progress / b.target) - (a.progress / a.target);
      return (QUEST_LABELS[a.templateCode] ?? a.templateCode)
        .localeCompare(QUEST_LABELS[b.templateCode] ?? b.templateCode);
    });
  const claimable = dailies.filter((q) => q.completed && !q.claimed).length;
  const chainReady = chain.filter((q) => q.completed && !q.claimed).length;

  return (
    <div className="interactive" style={{
      position: 'absolute', inset: 0, background: C.bg, display: 'flex', flexDirection: 'column',
    }}>
      {/* The header is the bar's own plate, so the board reads as a piece of the
          same chrome the player just tapped to get here. */}
      <div style={{
        ...hudStripStyle(),
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
        paddingTop: 'calc(8px + env(safe-area-inset-top))', flex: 'none',
      }}>
        <Icon name="quest" size={22} />
        <span style={{ color: C.goldHi, fontSize: 22, letterSpacing: '2px' }}>QUESTS</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="interactive"
          aria-label="Close quests"
          onClick={home}
          style={{
            ...hudChipStyle('shard'), display: 'grid', placeItems: 'center',
            width: 44, height: 44, cursor: 'pointer', background: 'transparent',
          }}>
          <Icon name="close" size={20} />
        </button>
      </div>

      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        padding: '12px 12px calc(14px + env(safe-area-inset-bottom))',
      }}>
        {error && (
          <div style={{ ...hudChipStyle('shard'), padding: '10px 12px', color: C.danger, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {readyCount > 0 && (
          <Btn disabled={busy !== null} onClick={() => { void claimAll(); }}
            style={{ minHeight: 44, width: '100%', marginBottom: 12 }} fontSize={18}>
            {busy === 'all' ? 'CLAIMING…' : `CLAIM ALL READY · ${readyCount}`}
          </Btn>
        )}

        {chain.length > 0 && !chainDone && (
          <Section title="YOUR FIRST STEPS" ready={chainReady}>
            {chain.map((q) => (
              <QuestRow
                key={q.id}
                q={q}
                busy={busy !== null}
                onClaim={() => claim(q.id)}
                action={actionFor(q)}
                live={q.id === liveStep?.id}
              />
            ))}
          </Section>
        )}

        {weekly.length > 0 && (
          <Section title="THIS WEEK">
            {weekly.map((q) => (
              <QuestRow key={q.id} q={q} weekly busy={busy !== null} onClaim={() => claim(q.id)} />
            ))}
          </Section>
        )}

        <Section title="TODAY" ready={claimable}>
          {/* The all-three bonus, as its own forged strip: it is a reward you can
              still earn, not one of the fifty things you might do. */}
          <div style={{
            ...hudStripStyle(), display: 'flex', alignItems: 'center', gap: 9,
            padding: '8px 11px', minHeight: 44,
          }}>
            <Icon name="star" size={20} />
            <span style={{ fontSize: 16, color: C.text, flex: 1, minWidth: 0 }}>
              CLAIM ANY {QUESTS.dailyBonusAt} · BONUS
            </span>
            {/* SHARDS, like every quest reward: quests.ts pays the bonus through
                the same rewardShards() call (allThreeBonusShards → shard_genesis). */}
            {reward({ n: data?.allThreeBonus ?? QUESTS.allThreeBonusShards })}
          </div>
          {dailies.map((q) => (
            <QuestRow key={q.id} q={q} busy={busy !== null} onClaim={() => claim(q.id)} />
          ))}
        </Section>
      </div>
    </div>
  );
}
