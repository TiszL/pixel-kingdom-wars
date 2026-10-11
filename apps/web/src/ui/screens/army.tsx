/**
 * Army action trays attached to base buildings (App barracks/forge/camp
 * sheets): local TRAIN selection followed by a confirmed SHARDS batch, plus
 * a whole-queue ⚡ FINISH ALL → POST /army/train/speedup, and a per-troop −1
 * tap-tap-tap cancel → POST /army/train/:id/cancel), RESEARCH (live
 * in-progress card + gated rows, POST /army/research), and VIEW ARMY (roster
 * from GET /army with pts/cap line). All costs are DISPLAY from
 * @shardkeep/shared; the server re-validates and debits. ArmyScreen at the
 * bottom is the same roster reached from the persistent HUD (D-096).
 */
import type { CSSProperties, ReactNode } from 'react';
import { TRAINING_PRESETS, TROOPS, TROOP_LEVELING, type TrainingComposition, type TrainingFinishAllConsent, type TrainingFreeFinishOffer, type TrainingFreeFinishReceipt, type TroopType } from '@shardkeep/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { selectedBasePath, withSelectedBase } from '../../lib/baseSelection';
import { playSfx } from '../../lib/audio';
import { bus } from '../../lib/events';
import { haptic } from '../../lib/juice';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { reloadBase } from '../sheets';
import {
  forgeLevelFromBase, holdTrainDelayMs, maxTrainableUnits, nextTrainingCancelTarget,
  queueRemainingSec, researchProgress, researchRowState, trainingCancelTarget,
  troopUnlockView, manualTrainingRoom,
} from './army.helpers';
import {
  troopRolloutGate, type DarkAttackerRosterFeature,
} from '../troopRollout';
import { TRAIN_TABLE, TROOP_DISPLAY } from '../copy';
import { CODEX } from './codex';
import { troopPortrait } from '../icons';
import { TrainingPresets, TrainingPurchaseOwner, ArmyActionSlot, armyOwnerDispatch, armyOwnerRequest, isArmyOwnerBinding, type ArmyOwnerBinding, type TrainingPurchaseModel } from './trainingPresets';
export type { ArmyOwnerBinding } from './trainingPresets';
import { clearFreeFinish, readFreeFinish, saveFreeFinish, verifyFreeFinish, type PendingFreeFinish } from './trainingFreeFinish';
import { useResearchSpeedupView } from '../../lib/researchSpeedup/context';
import { useTrainingFinishView } from '../../lib/trainingFinish/context';
import { useCancelJobConfirm } from '../CancelJobConfirm';
import { useFetch } from '../useFetch';
import { Btn, btnStyle, Chip, COLORS as C, fmtDur, fmtN, Icon, ModalWrap, Phead, Sprite } from '../primitives';
import './training.css';

const toast = (msg: string): void => bus.emit('ui:toast', { msg });

export interface ArmyState {
  counts: Record<string, number>;
  levels: Record<string, number>;
  research: Array<{
    troop: string; toLevel: number; finishesAt: string;
    /** Server verdict on the CANCEL control (tester request 2026-09-04);
     *  optional across rolling web/API cuts — absent reads "not cancellable". */
    canCancel?: boolean; refundShards?: string | null;
  }>;
  queue: Array<{
    id: string; troop: string; startedAt: string; finishesAt: string; scheduleVersion?: number;
    canCancel: boolean; refundShards: string | null;
  }>;
  rosterPts: number;
  campCapacityPts: number;
  barracksQueuePts: number;
  /** D-058 server verdict: which item-gated elite troops THIS wallet may train. */
  eliteUnlocks?: Record<string, boolean>;
  finishAllQuote?: TrainingFinishAllConsent;
  freeFinishAllOffer?: TrainingFreeFinishOffer | null;
  freeFinishAllReceipt?: TrainingFreeFinishReceipt | null;
  freeFinishAllReviewRequired?: boolean;
  features?: {
    trainingScheduling?: { version: number; mode: string; lanes: number; consentRequired: boolean };
    darkAttackerRoster?: DarkAttackerRosterFeature;
  };
}


export interface ArmyTrainingModel {
  data:ArmyState|null;error:string|null;loading:boolean;draft:TrainingComposition;busy:boolean;
  pendingCancelIds:ReadonlySet<string>;purchase:TrainingPurchaseModel;
  pendingFree:PendingFreeFinish|null;freeStorageError:boolean;finishFree():void;openHistory():void;
  selectOne(troop:string,delta?:number):void;clearDraft():void;cancelOne(troop:string):void;finishAll():void;refresh():void;
}
export interface ArmyResearchModel {
  data:ArmyState|null;error:string|null;loading:boolean;busy:boolean;cancelDialog:ReactNode;blockedReason:string|null;
  research(troop:string):void;finish(troop:string):void;cancel(troop:string,toLevel:number,refundShards:string):void;refresh():void;openHistory():void;
}
export function ArmyTrainingOwner({binding,children}:{binding:ArmyOwnerBinding;children:(model:ArmyTrainingModel)=>ReactNode}):React.JSX.Element|null {
  const wallet=useApp(s=>s.wallet),baseId=useApp(s=>s.selectedBaseId),epoch=useApp(s=>s.baseSelectionEpoch);
  if (!isArmyOwnerBinding(binding)) return null;
  return <ArmyActionSlot key={`${wallet}:${baseId}:${epoch}`} kind="training"><TrainTrayForBase binding={binding} children={children}/></ArmyActionSlot>;
}
export function ArmyResearchOwner({binding,children}:{binding:ArmyOwnerBinding;children:(model:ArmyResearchModel)=>ReactNode}):React.JSX.Element|null {
  const wallet=useApp(s=>s.wallet),baseId=useApp(s=>s.selectedBaseId),epoch=useApp(s=>s.baseSelectionEpoch);
  if (!isArmyOwnerBinding(binding)) return null;
  return <ArmyActionSlot key={`${wallet}:${baseId}:${epoch}`} kind="research"><ResearchTrayForBase binding={binding} children={children}/></ArmyActionSlot>;
}

/** 1-Hz re-render so the training countdown + progress bar tick live. */
function useTick(): void {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
}

const trpLabel = (key: string): string => TROOP_DISPLAY[key] ?? key.toUpperCase();

/** CoC-style training queue read from GET /army (R6): the in-progress unit
 * (earliest finish) shows a live "4m 30s" countdown + mini progress bar; the
 * units queued behind it are grouped by type as icon+count chips. The queue is
 * server-ordered by finishesAt, so queue[0] is in progress. Empty queue renders
 * nothing so the tray collapses to just the troop cards + footer line.
 * "⚡ FINISH ALL" (F1, owner 2026-08-03) completes the WHOLE queue — "getting
 * ready to attack" means the army. Paid review fetches the authoritative
 * complete queue, price ceiling and currency; local countdowns are display only.
 * Cancellation is tap-tap-tap (D-096, owner 2026-09-02): ONE 48px −1 chip per
 * troop type over the WHOLE queue, head included, no dialog and no second
 * control — the old head-card −1 and the waiting chip resolved to the SAME row
 * whenever the head troop also had queued rows, so "two −1 buttons" was one
 * action drawn twice. The chip count is optimistic (server rows minus the ids
 * taps already spoke for) so the number falls under the finger, not after the
 * round-trip. */
function TrainQueue({ queue, levels, busy, paidEnabled, freeOffer, pendingCancelIds, onFinishAll, onCancelOne }: {
  queue: ArmyState['queue'];
  freeOffer?: TrainingFreeFinishOffer | null;
  levels: ArmyState['levels'];
  busy: boolean;
  paidEnabled: boolean;
  /** Rows a −1 tap already cancelled whose POST has not drained (D-096). */
  pendingCancelIds: ReadonlySet<string>;
  /** Paid review fetches the authoritative quote; countdowns are display only. */
  onFinishAll: () => void;
  onCancelOne: (troop: string) => void;
}): React.JSX.Element | null {
  useTick();
  if (queue.length === 0) return null;
  const head = queue[0]!;
  const start = new Date(head.startedAt).getTime();
  const end = new Date(head.finishesAt).getTime();
  const now = Date.now();
  const remSec = Math.max(0, Math.ceil((end - now) / 1000));
  const waiting = start > now;
  const pct = end > start ? Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100)) : 100;

  // Group EVERY row — head included — by troop type, counting only rows no tap
  // has spoken for: the badge shows what the queue will hold once the pending
  // POSTs land. A troop whose rows are all pending still lists at ×0 so the
  // chip stays put through the burst.
  const grouped = new Map<string, number>();
  for (const q of queue) grouped.set(q.troop, (grouped.get(q.troop) ?? 0) + (pendingCancelIds.has(q.id) ? 0 : 1));

  return (
    <div data-training-queue="" className="sk-training-queue">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <div style={{ position: 'relative', width: 44, height: 44, flex: 'none' }}>
          {/* Real /army levels → dragon/giant portraits show the researched
              tier's art; every other troop resolves to its legacy portrait
              (troopPortrait documents the level rule). */}
          <Sprite name={troopPortrait(head.troop, levels[head.troop])} w={44} h={44} />
        </div>
        <div style={{ flex: '1 1 100px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '3px 8px', fontSize: 15, color: C.textDim }}>
            <span>{waiting ? 'WAITING' : remSec > 0 ? 'RUNNING' : 'COMPLETING'} · {trpLabel(head.troop)}</span>
            <span style={{ color: C.gold }}>{waiting ? `STARTS IN ${fmtDur(Math.ceil((start - now) / 1000))}` : remSec > 0 ? fmtDur(remSec) : 'DONE'}</span>
          </span>
          <span style={{ height: 6, background: C.border, border: `1px solid ${C.ink}`, display: 'block' }}>
            <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: C.gold }} />
          </span>
        </div>
        <Btn data-tutorial-target={freeOffer ? "training-free-finish" : "training-paid-finish"} fontSize={15} disabled={busy || !freeOffer && !paidEnabled} style={{ minHeight: 48, padding: '6px 10px', flex: '1 1 150px', whiteSpace: 'normal' }} onClick={onFinishAll}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>⚡ FINISH ALL · {freeOffer ? 'FREE' : 'REVIEW'}</span>
        </Btn>
      </div>
      {freeOffer && <div style={{ color: C.goldHi, fontSize: 13, paddingTop: 5 }}>ONE FREE FINISH FOR YOUR FIRST ARMY · NO KEEP NEEDED</div>}
      <div style={{ color: C.textDim, fontSize: 16, paddingTop: 6 }}>
        ALL READY IN {fmtDur(queueRemainingSec(queue, now))} · {queue.filter((row) => new Date(row.startedAt).getTime() > now).length} WAITING
      </div>
      {/* Troop chips live on their OWN wrapping row (M23 a20): all 13 possible
          distinct types used to share one no-wrap flex row with the name column
          and the money button, which crushed the countdown to 0px and spilled
          overlapping chips on a 390px phone. The ×N badge hangs 2px outside
          each chip box, so the wrap row keeps 4px of breathing room and its own
          top padding instead of clipping neighbours. The badge is ALWAYS drawn:
          with the head grouped in, a chip without a number would be ambiguous
          between "one" and "unknown", and a burst must be able to read ×0. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '8px 3px 3px' }} aria-label="Queued troops; tap minus one to cancel one">
        {[...grouped].map(([troop, n]) => {
          // Refundable per the SERVER queue, ignoring pending taps: the element
          // must stay the same never-disabled button through a burst (never
          // swapped for the passive tile) so the tenth tap lands where the
          // first did. The label quotes the NEXT row's refund; once every row
          // is spoken for the tap is a no-op (onCancelOne resolves null).
          const refundable = trainingCancelTarget(queue, troop);
          const next = refundable && nextTrainingCancelTarget(queue, troop, pendingCancelIds);
          return refundable ? <button key={troop} type="button" className="interactive"
            aria-label={`Cancel one ${trpLabel(troop)} training for a ${(next ?? refundable).refundShards} SHARDS refund`}
            onClick={() => onCancelOne(troop)}
            style={{ position: 'relative', width: 48, height: 48, flex: 'none', opacity: 0.85, padding: 7, background: C.card, border: `2px solid ${C.border}` }}>
            <Sprite name={troopPortrait(troop, levels[troop])} w={34} h={34} />
            <span style={{ position: 'absolute', right: -3, top: -3, fontSize: 12, color: C.ink, background: C.gold, padding: '0 3px', border: `1px solid ${C.ink}` }}>×{n}</span>
            <span aria-hidden="true" style={{ position: 'absolute', right: -3, bottom: -3, minWidth: 20, color: C.ink, background: C.gold, border: `1px solid ${C.ink}`, fontSize: 14 }}>−1</span>
          </button> : <div key={troop} style={{ position: 'relative', width: 48, height: 48, flex: 'none', opacity: 0.6, padding: 7 }}>
            <Sprite name={troopPortrait(troop, levels[troop])} w={34} h={34} />
            <span style={{ position: 'absolute', right: -2, bottom: -2, fontSize: 12, color: C.ink, background: C.gold, padding: '0 3px', border: `1px solid ${C.ink}` }}>×{n}</span>
          </div>;
        })}
      </div>
      {queue.some((row) => !row.canCancel) && (
        <div style={{ color: C.textFaint, fontSize: 12, paddingTop: 5 }}>
          PRE-UPDATE TRAINING FINISHES NORMALLY · NO ESTIMATED REFUNDS
        </div>
      )}
    </div>
  );
}

function troopStats(key: string): (typeof TROOPS)[keyof typeof TROOPS] {
  return TROOPS[key as keyof typeof TROOPS];
}

/** Barracks: train every server-recognized, player-owned troop root. */
export function TrainTray(): React.JSX.Element {
  const wallet = useApp((s) => s.wallet);
  const epoch = useApp((s) => s.baseSelectionEpoch);
  const baseId = useApp((s) => s.selectedBaseId);
  return <ArmyActionSlot key={`${wallet}:${baseId}:${epoch}`} kind="training"><TrainTrayForBase /></ArmyActionSlot>;
}

/** The three steppers share a 108–116 px troop card: btnStyle's 48 px minimum width made
 * three of them 152 px wide, so on phones they spilled over the neighbouring cards (owner
 * 2026-09-17, iPhone). Zero minimum width, no side padding, equal thirds. */
const STEPPER_BTN: CSSProperties = { minWidth: 0, minHeight: 44, flex: '1 1 0', padding: '6px 0', letterSpacing: 0, gap: 0 };

/** Full Army DTO reads preserve refund/free-offer fields and never reuse old
 * payment/base generations for current queue or roster publication. */
export function useTrainingArmy() {
  const selectedBaseId = useApp(s => s.selectedBaseId), baseEpoch = useApp(s => s.baseSelectionEpoch), wallet = useApp(s => s.wallet);
  const money = useTrainingFinishView(), revision = money?.snapshotRevision ?? 0;
  const fetched = useFetch(async () => {
    const scope = captureBaseSnapshotGuard();
    const army = await api.get<ArmyState>(selectedBasePath('/army'), { isCurrent: () => isBaseSnapshotGuardCurrent(scope) });
    if (!isBaseSnapshotGuardCurrent(scope)) throw new Error('The training kingdom changed. Refresh its current army.');
    return { scope, revision, army };
  }, [wallet, selectedBaseId, baseEpoch, revision]);
  const loaded = fetched.data;
  return { ...fetched, data: loaded && !fetched.loading && !money?.state.busy && loaded.revision === revision && isBaseSnapshotGuardCurrent(loaded.scope) ? loaded.army : null };
}
function TrainTrayForBase({binding,children}:{binding?:ArmyOwnerBinding;children?:(model:ArmyTrainingModel)=>ReactNode}={}): React.JSX.Element {
  const access=useRef(binding);access.current=binding;
  const selectedBaseId = useApp((s) => s.selectedBaseId), money = useTrainingFinishView();
  const { data, error, loading, reload } = useTrainingArmy();
  const [draft, setDraft] = useState<TrainingComposition>([]);
  const draftRef = useRef(draft);
  const armyRef = useRef(data);
  armyRef.current = data;
  const mounted = useRef(true);
  const guard = useRef(captureBaseSnapshotGuard());
  const alive = (): boolean => mounted.current && isBaseSnapshotGuardCurrent(guard.current);
  const dispatch=<T,>(kind:'read'|'recover'|'mutate',action:()=>T):T=>armyOwnerDispatch(access,alive,kind,action);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // A purchase the barracks could not complete (TrainingPresets: failed batch
  // awaiting RETRY / CLOSE) blocks new selection. Tester report 2026-09-16:
  // the troop cards went dead with no word why — so the tap now SAYS why and
  // points at the notice on top instead of being a silent no-op. The ref is
  // what the pointer handlers read; the state mirror is what enables the cards.
  const purchasePendingRef = useRef(false);
  const [purchasePending, setPurchasePending] = useState(false);
  const onPendingChange = useCallback((pending: boolean): void => {
    purchasePendingRef.current = pending; setPurchasePending(pending);
  }, []);
  const explainBlockedPurchase = (): boolean => {
    if (!purchasePendingRef.current) return false;
    toast('TRAINING FAILED · RETRY OR CLOSE THE ORIGINAL PURCHASE ABOVE');
    return true;
  };
  const selectOne = (troop: string, delta = 1): void => {
    if (!alive()) return;
    if (delta > 0 && (explainBlockedPurchase() || !armyRef.current)) return;
    const rows = draftRef.current;
    // +N takes the smaller of N and the room the three gates leave — army
    // capacity, queue capacity, composition cap — through maxTrainableUnits,
    // the +1 rule generalised (MAX passes the room itself). No room is the
    // same no-op a +1 past capacity always was.
    const add = delta > 0 ? Math.min(delta, maxTrainableUnits(armyRef.current!, rows, troop)) : delta;
    if (add === 0) return;
    const found = rows.find((row) => row.troop === troop);
    const next = found
      ? rows.map((row) => row.troop === troop ? { ...row, count: Math.max(0, row.count + add) } : row).filter((row) => row.count > 0)
      : add > 0 ? [...rows, { troop: troop as TroopType, count: add }] : rows;
    draftRef.current = next; setDraft(next);
  };
  const clearDraft = (): void => { draftRef.current = []; setDraft([]); };
  const keepLevel = useApp((s) => s.base?.player.keepLevel);
  const [busy, setBusy] = useState(false);
  // D-096 tap-tap-tap cancellation. Each −1 tap decrements its chip at once
  // (optimistic: server rows minus the ids taps already spoke for) and enqueues
  // ONE exact POST on its own serialized chain — never two in flight, never a
  // disabled chip, never `busy` (a control disabled mid-burst swallows the next
  // tap). The ref is the truth the tap handler reads — state would lag a tap
  // that lands before React re-renders — and the state mirror is what draws.
  const pendingCancelRef = useRef<Set<string>>(new Set());
  const [pendingCancelIds, setPendingCancelIds] = useState<ReadonlySet<string>>(new Set());
  const syncPendingCancels = (): void => setPendingCancelIds(new Set(pendingCancelRef.current));
  const cancelChain = useRef<Promise<unknown>>(Promise.resolve());
  // One toast per burst, not per tap: refunds are summed while the chain drains.
  const cancelBurst = useRef<{ count: number; refund: number; troops: Set<string> }>({ count: 0, refund: 0, troops: new Set() });
  // Fresh /army data retires pending ids the server no longer lists: a landed
  // cancel is gone from the queue, so the optimistic decrement is dropped the
  // moment the truth arrives — never earlier, or the count would flash back up
  // between the POST resolving and the reload landing.
  useEffect(() => {
    if (!data) return;
    const live = new Set(data.queue.map((q) => q.id));
    let changed = false;
    for (const id of pendingCancelRef.current) {
      if (!live.has(id)) { pendingCancelRef.current.delete(id); changed = true; }
    }
    if (changed) setPendingCancelIds(new Set(pendingCancelRef.current));
  }, [data]);
  // Auto-refetch when the in-progress unit finishes so the queue advances
  // without a manual reload (mirrors the base-job auto-refetch; the server
  // completes training lazily). Robust to clock skew: an already-elapsed head
  // retries shortly rather than freezing the countdown at 0.
  useEffect(() => {
    const head = data?.queue[0];
    if (!head) return;
    const end = new Date(head.finishesAt).getTime();
    // setTimeout runs any delay above 2^31-1 ms after 1 ms: a head ~25+ days out reloaded in a tight loop. Cap it.
    const delay = Math.min(end <= Date.now() ? 2_000 : end - Date.now() + 1_500, 2_147_483_647);
    const t = setTimeout(() => reload(), delay);
    return () => clearTimeout(t);
  }, [data, reload]);
  // A gesture changes a local draft only. Dragging before the hold threshold
  // scrolls without selecting; no gesture can debit SHARDS.
  const HOLD_MS = 350;
  const MOVE_PX = 10;
  const holdRef = useRef<{
    troop: string; x: number; y: number; started: boolean; tick: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const clearGesture = (): void => {
    if (holdRef.current?.timer) clearTimeout(holdRef.current.timer);
    holdRef.current = null;
  };
  const repeat = (): void => {
    const hold = holdRef.current;
    if (!hold || !alive()) return;
    hold.started = true;
    selectOne(hold.troop);
    hold.timer = setTimeout(repeat, holdTrainDelayMs(hold.tick++));
  };
  const onPress = (troop: string, e: React.PointerEvent): void => {
    if (loading || e.button !== 0 || explainBlockedPurchase() || busy) return;
    clearGesture();
    holdRef.current = { troop, x: e.clientX, y: e.clientY, started: false, tick: 0, timer: setTimeout(repeat, HOLD_MS) };
  };
  const onMove = (e: React.PointerEvent): void => {
    const hold = holdRef.current;
    if (hold && (Math.abs(e.clientX - hold.x) > MOVE_PX || Math.abs(e.clientY - hold.y) > MOVE_PX)) clearGesture();
  };
  const onRelease = (): void => {
    const hold = holdRef.current;
    if (hold && !hold.started) selectOne(hold.troop);
    clearGesture();
  };
  useEffect(() => { if (busy) clearGesture(); }, [busy]);
  useEffect(() => clearGesture, []);
  const [pendingFree, setPendingFree] = useState<PendingFreeFinish | null>(null);
  const [freeStorageError, setFreeStorageError] = useState(false);
  const finishing = useRef(false);
  useEffect(() => {
    const wallet = guard.current.wallet;
    if (!wallet || !alive()) return;
    try {
      const saved = readFreeFinish(wallet);
      if (saved && data?.freeFinishAllReceipt?.idempotencyKey === saved.idempotencyKey) {
        if (data.freeFinishAllReceipt.baseId !== saved.baseId) throw new Error('Free finish receipt belongs to another base.');
        verifyFreeFinish({ cost: '0', completed: data.freeFinishAllReceipt.completed }, saved);
        clearFreeFinish(saved); setPendingFree(null);
      } else setPendingFree(saved);
      setFreeStorageError(false);
    } catch { setFreeStorageError(true); }
  }, [data]);
  const finishFree = (): void => {
    if (!alive() || finishing.current || busy || freeStorageError || !guard.current.wallet) return;
    try {
      const saved = readFreeFinish(guard.current.wallet);
      const offer = data?.freeFinishAllOffer;
      if (!saved && !offer) {
        try { dispatch('recover',reload); } catch (error) { toast((error as Error).message); }
        return;
      }
      if (binding) {
        try { dispatch('mutate', () => undefined); }
        catch (error) { toast((error as Error).message); return; }
      }
      const request: PendingFreeFinish = saved ?? {
        wallet: guard.current.wallet, baseId: selectedBaseId ?? null, idempotencyKey: crypto.randomUUID(),
        freeOffer: offer!.offer, consent: structuredClone(offer!.consent),
      };
      saveFreeFinish(request); setPendingFree(request); finishing.current = true; setBusy(true);
      void armyOwnerRequest(()=>dispatch('mutate',()=>api.post('/army/train/speedup', { idempotencyKey: request.idempotencyKey,
        ...(request.baseId ? { baseId: request.baseId } : {}), freeOffer: request.freeOffer, consent: request.consent })))
        .then((result: unknown) => { verifyFreeFinish(result, request); clearFreeFinish(request); if (alive()) { setPendingFree(null); toast('FREE TRAINING COMPLETE — TROOPS IN CAMP'); reload(); return reloadBase(); } })
        .catch((error: Error & { code?: string }) => {
          if (!alive()) return;
          // Definitive refusal cannot spend KEEP. Unknown responses retain the
          // same key and block paid/new requests until receipt recovery.
          if (['TRAINING_FREE_FINISH_UNAVAILABLE', 'TRAINING_FREE_FINISH_MISMATCH', 'TRAINING_FREE_FINISH_REVIEW_REQUIRED', 'TRAINING_FINISH_QUOTE_CHANGED', 'BASE_NOT_OWNED'].includes(error.code ?? '')) {
            clearFreeFinish(request); setPendingFree(null);
          }
          toast(error.message); reload();
        }).finally(() => { finishing.current = false; if (alive()) setBusy(false); });
    } catch (error) { setFreeStorageError(true); toast((error as Error).message); }
  };
  const finishAll = (): void => {
    if (data?.freeFinishAllOffer || pendingFree) { finishFree(); return; }
    if (!alive() || freeStorageError || finishing.current || busy || !money || !selectedBaseId || !money.actionsEnabled || money.state.busy) return;
    try{dispatch('mutate',()=>money.begin({ baseId: selectedBaseId }));}catch(error){toast((error as Error).message);}
  };
  // The burst is over when the last enqueued POST settles with nothing tapped
  // behind it: one toast summing the refunds ("3 BOWMAN" or, across types,
  // "5 TROOPS"), then the queue + shard balance reload — whose fresh queue is
  // what retires the pending ids (effect above).
  const settleCancels = (): void => {
    if (!alive()) return;
    const b = cancelBurst.current;
    cancelBurst.current = { count: 0, refund: 0, troops: new Set() };
    if (b.count > 0) {
      playSfx('sfx_confirm');
      const what = b.troops.size === 1 ? trpLabel([...b.troops][0]!) : 'TROOPS';
      toast(`${b.count} ${what} CANCELLED · +${b.refund} SHARDS`);
    }
    reload(); void reloadBase({ background: true });
  };
  const cancelOne = (troop: string): void => {
    if (!alive()) return;
    const target = nextTrainingCancelTarget(data?.queue ?? [], troop, pendingCancelRef.current);
    if (!target) return; // every refundable row of this troop is already spoken for
    if (binding) {
      try { dispatch('mutate', () => undefined); }
      catch (error) { toast((error as Error).message); return; }
    }
    // Queue cancellation targets only an exact server row; draft minus controls
    // never reach this path. Stop an active selection gesture first.
    clearGesture();
    pendingCancelRef.current.add(target.id); syncPendingCancels();
    const run = cancelChain.current
      .catch(() => undefined)
      .then(() => alive() ? dispatch('mutate',()=>api.post(`/army/train/${target.id}/cancel`, selectedBaseId ? { baseId: selectedBaseId } : {})) : undefined)
      .then((result: unknown) => {
        if (!alive()) return;
        const refund = (result as { refundShards?: string }).refundShards ?? target.refundShards;
        haptic('light');
        const b = cancelBurst.current;
        b.count += 1; b.refund += Number(refund); b.troops.add(troop);
      })
      // A refusal (the row completed or was cancelled from another tab) rolls
      // THIS tap back and says why; the reload replaces the stale queue the tap
      // read. Later taps still run — each is its own exact row.
      .catch((e: Error) => {
        if (!alive()) return;
        pendingCancelRef.current.delete(target.id); syncPendingCancels();
        playSfx('sfx_error'); toast(e.message); reload();
      });
    cancelChain.current = run;
    void run.then(() => { if (cancelChain.current === run) settleCancels(); });
  };
  const queuedPts = data?.queue.reduce((s, q) => s + (TROOPS[q.troop as keyof typeof TROOPS]?.pts ?? 0), 0) ?? 0;
  const room = data ? manualTrainingRoom(data, draft) : null;
  // The failed-purchase notice renders HERE, at the top (tester report
  // 2026-09-16 "move the failed panel to the top"): TrainingPresets owns the
  // recovery state and sits at the tray's foot, so it portals the notice into
  // this host — one component still owns the receipt, the eye finds it first.
  const [noticeHost, setNoticeHost] = useState<HTMLDivElement | null>(null);
  if(binding && children)return <TrainingPurchaseOwner binding={binding} draft={draft} onDraftAccepted={clearDraft} onBusyChange={setBusy} onPendingChange={onPendingChange} onTrained={()=>{reload();void reloadBase({background:true});}}>{purchase=>children({data,error,loading,draft,busy,pendingCancelIds,purchase,pendingFree,freeStorageError,finishFree,
    openHistory:()=>{try{dispatch('recover',()=>money?.openHistory());}catch(error){toast((error as Error).message);}},
    selectOne:(troop,delta)=>{try{dispatch('mutate',()=>selectOne(troop,delta));}catch(error){toast((error as Error).message);}},
    clearDraft:()=>{try{dispatch('read',clearDraft);}catch(error){toast((error as Error).message);}},cancelOne,finishAll,
    refresh:()=>{try{dispatch('recover',reload);}catch(error){toast((error as Error).message);}},
  })}</TrainingPurchaseOwner>;

  return (
    <div className="sk-training-tray">
      <div data-onboarding-caption-slot="training" />
      <div className="sk-training-heading">
        <strong>TRAIN TROOPS</strong>
        <span>Choose your troops, then review your training.</span>
      </div>
      <div ref={setNoticeHost} data-training-failed-host="" />
      {error && <div role="status">{error} <Btn variant="sec" onClick={reload}>RETRY ARMY</Btn></div>}
      {pendingFree && <div role="status" data-training-recovery="">CHECK YOUR FREE FINISH BEFORE ANOTHER REQUEST
        <Btn disabled={busy} data-tutorial-target="training-free-recovery" onClick={finishFree}>CHECK FREE FINISH</Btn>
      </div>}
      {money && <Btn variant="sec" style={{ minHeight: 44 }} onClick={money.openHistory}>TRAINING PAYMENTS & RECEIPTS</Btn>}
      {data?.freeFinishAllReviewRequired && <div role="status" style={{ color: C.textDim, padding: '6px 0' }}>YOUR FREE FINISH ELIGIBILITY REQUIRES REVIEW. YOUR TROOPS STILL TRAIN NORMALLY.</div>}
      {freeStorageError && <div role="status">Saved training recovery is unavailable. Refresh before finishing training.</div>}
      {data && <TrainQueue queue={data.queue} levels={data.levels} paidEnabled={!!money && money.actionsEnabled && !money.state.busy && !!selectedBaseId} freeOffer={data.freeFinishAllOffer ?? null} busy={busy || !!pendingFree || freeStorageError}
        pendingCancelIds={pendingCancelIds} onFinishAll={finishAll} onCancelOne={cancelOne} />}
      <div className="sk-training-capacity">
        <div className="sk-training-capacity-row">
          <span className="sk-training-capacity-values"><span>ARMY</span><span>{data ? data.rosterPts + queuedPts : '—'} / {data?.campCapacityPts ?? '—'} PTS</span></span>
          <span className="sk-training-meter" aria-hidden="true"><span style={{ width: `${data?.campCapacityPts ? Math.min(100, ((data.rosterPts + queuedPts) / data.campCapacityPts) * 100) : 0}%` }} /></span>
        </div>
        <div className="sk-training-capacity-row">
          <span className="sk-training-capacity-values"><span>TRAINING QUEUE</span><span>{data ? queuedPts : '—'} / {data?.barracksQueuePts ?? '—'} PTS</span></span>
          <span className="sk-training-meter" aria-hidden="true"><span style={{ width: `${data?.barracksQueuePts ? Math.min(100, (queuedPts / data.barracksQueuePts) * 100) : 0}%` }} /></span>
        </div>
        {!!room?.draftPts && <div className="sk-training-selection-note">{room.draftPts} PTS SELECTED · NO PURCHASE UNTIL CONFIRMED</div>}
        <div className="sk-training-capacity-tools">
          <details className="sk-training-capacity-details">
            <summary>CAPACITY DETAILS</summary>
            <div className="sk-training-help">
              <div>ARMY CAPACITY · {data?.rosterPts ?? '—'} READY + {data ? queuedPts : '—'} QUEUED / {data?.campCapacityPts ?? '—'} PTS</div>
              <div>TRAINING QUEUE CAPACITY · {data ? queuedPts : '—'} / {data?.barracksQueuePts ?? '—'} PTS</div>
              <p>Each troop uses population points in both limits. Camp holds the army; Barracks limit the training queue.</p>
              {data?.queue.some((row) => row.scheduleVersion === 2) && <p>ONE TRAINING LANE FOR NEW TROOPS</p>}
              {data?.queue.some((row) => row.scheduleVersion !== 2) && <p>EARLIER TRAINING KEEPS ITS ORIGINAL TIMERS</p>}
            </div>
          </details>
          <Btn variant="ghost" fontSize={14} style={{ minHeight: 48, padding: '5px 8px', position: 'absolute', right: 0, top: 0 }} disabled={loading || busy} onClick={reload}>REFRESH CAPACITY</Btn>
        </div>
      </div>
      <div className="sk-training-kicker">SELECT TROOPS <span>TAP OR HOLD TO ADD</span></div>
      {loading && !data && <div role="status" className="sk-training-help">Loading your army…</div>}
      <div className="sk-training-troops">
        {TRAIN_TABLE.map((t) => {
          const stats = troopStats(t.key);
          // D-058: elite troops are writ-gated per the SERVER's eliteUnlocks
          // verdict; the label names the unlock path (forge drop / KEEP writ).
          const unlock = troopUnlockView(t.key, keepLevel, data?.eliteUnlocks);
          const rollout = troopRolloutGate(t.key, data?.features?.darkAttackerRoster);
          const locked = unlock.locked || rollout.locked;
          const selected = draft.find((row) => row.troop === t.key)?.count ?? 0;
          const capacityReason = room && t.pts > room.campFreePts ? 'ARMY CAPACITY LIMIT'
            : room && t.pts > room.queueFreePts ? 'TRAINING QUEUE CAPACITY LIMIT'
            : draft.reduce((sum, row) => sum + row.count, 0) >= TRAINING_PRESETS.maxCompositionUnits ? 'SELECTION LIMIT' : null;
          const level = data?.levels[t.key];
          // Room for +10 / MAX through the SAME gate the +1 tap uses.
          const maxMore = data && !locked ? maxTrainableUnits(data, draft, t.key) : 0;
          const stepDisabled = (busy && !purchasePending) || loading || !!error || locked || maxMore === 0;
          const mult = level === undefined
            ? null
            : Math.pow(TROOP_LEVELING.statMultPerLevel, level - 1);
          return (
          // Taps and holds change only the local draft; dragging scrolls. The
          // gesture-suppression styles + onContextMenu/onDragStart kill the OS
          // long-press callout, text/image selection and image-drag on the troop
          // sprite so a long press selects instead of firing the native image menu.
          <div key={t.key} className="sk-training-troop" data-selected={selected > 0 ? 'true' : undefined}>
          <button data-train-troop={t.key} data-selected-count={selected} className="interactive" disabled={(busy && !purchasePending) || loading || !!error || locked || !!capacityReason}
            title={rollout.locked
              ? rollout.message
              : unlock.locked ? unlock.label : capacityReason ?? 'SELECT TROOPS · NO PURCHASE UNTIL CONFIRMED'}
            onPointerDown={(e) => onPress(t.key, e)}
            onPointerMove={onMove} onPointerUp={onRelease}
            onPointerLeave={clearGesture} onPointerCancel={clearGesture}
            onClick={(e) => { if (e.detail === 0) selectOne(t.key); }}
            onContextMenu={(e) => e.preventDefault()} onDragStart={(e) => e.preventDefault()}
            style={{ width: '100%', minHeight: 184, height: '100%', background: C.card, border: `2px solid ${selected ? C.gold : C.borderLt}`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, padding: '10px 6px', cursor: 'pointer', touchAction: 'manipulation', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}>
            <span className="sk-training-portrait"><Sprite name={troopPortrait(t.key, data?.levels[t.key])} w={56} h={56} /></span>
            <span style={{ fontSize: 17, color: selected ? C.goldHi : C.text, lineHeight: 1.1 }}>{t.label}</span>
            {level !== undefined && <span className="sk-training-level">LEVEL {level}</span>}
            {mult !== null && (
              <span style={{ fontSize: 13, color: C.textDim, lineHeight: 1.2 }}>
                HP {Math.round(stats.hp * mult)} · DMG {Math.round(stats.dps * mult)}
              </span>
            )}
            <span style={{ fontSize: 13, color: C.textDim, lineHeight: 1.2 }}>
              SPD {stats.speedTilesPerSec} · RNG {stats.range === 'melee' ? 'M' : stats.range}
            </span>
            {rollout.locked ? (
              <span style={{ fontSize: 13, color: C.textFaint }}>{rollout.message}</span>
            ) : unlock.locked ? (
              // The writ labels ("DROPS FROM GOLD FORGE") are longer than the
              // Writ unlock copy — smaller type, wrapped, still the danger color.
              <span style={{ fontSize: 13, color: C.goldHi, lineHeight: 1.2, textAlign: 'center' }}>{unlock.label}</span>
            ) : (
              <span style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 17, color: C.goldHi, marginTop: 'auto', whiteSpace: 'nowrap' }}>
                <Icon name="shard" size={14} />{t.shardCost} · {t.pts}P
              </span>
            )}
            <span className="sk-training-selected">SELECTED {selected}</span>
            {!locked && capacityReason && <span style={{ fontSize: 13, color: C.textDim }}>{capacityReason}</span>}
          </button>
          {/* −1 · +10 · MAX (tester request 2026-09-16: "I need to keep clicking
              until it maxes out"). +10 and MAX pass through selectOne like the
              tap, so MAX lands exactly where tap-tap-tap would have stopped and
              the server still re-validates the batch. */}
          <div className="sk-training-steppers">
            <button type="button" className="interactive" aria-label={`Remove one selected ${t.label}`} disabled={busy || !selected}
              style={{ ...btnStyle('sec', 13, busy || !selected), ...STEPPER_BTN }} onClick={() => selectOne(t.key, -1)}>−1</button>
            <button type="button" className="interactive" aria-label={`Add ten ${t.label}`} disabled={stepDisabled}
              style={{ ...btnStyle('sec', 13, stepDisabled), ...STEPPER_BTN }} onClick={() => selectOne(t.key, 10)}>+10</button>
            {/* `data-train-max` is the first-run coach mark's anchor (tutorial/
                guideCues.ts): one tap here fills the L1 camp the first_troops
                objective asks for. */}
            <button type="button" className="interactive" data-train-max={t.key} aria-label={`Select the maximum ${t.label}`} disabled={stepDisabled}
              style={{ ...btnStyle('sec', 13, stepDisabled), ...STEPPER_BTN }} onClick={() => selectOne(t.key, maxMore)}>MAX</button>
          </div>
          </div>
          );
        })}
      </div>
      <TrainingPresets draft={draft} onDraftAccepted={clearDraft} onBusyChange={setBusy}
        noticeHost={noticeHost} onPendingChange={onPendingChange}
        onTrained={() => { reload(); void reloadBase({ background: true }); }} />
    </div>
  );
}

/** Research progress is display-only. Paid completion gets its episode,
 * maximum price and exact currency from the server in the shared review. */
function ResearchActive({ r, levels, busy, finishDisabled, onFinish, onCancel }: {
  r: ArmyState['research'][number];
  levels: ArmyState['levels'];
  busy: boolean;
  finishDisabled: boolean;
  onFinish: () => void;
  /** Cancellation remains a separate server-quoted SHARDS refund. */
  onCancel: (refundShards: string) => void;
}): React.JSX.Element {
  useTick();
  const { remSec, pct } = researchProgress(r.toLevel, r.finishesAt, Date.now());
  return (
    // Pinned (D2, owner phone report 2026-08-03): the sheet body now scrolls
    // (sheets.tsx D1) and this card is the ONE place with countdown/FINISH —
    // sticky keeps it visible at the tray top however far the 11 rows are
    // scrolled, so the FINISH button can never sit above the viewport again.
    // Opaque panel background so rows slide UNDER it, not through it.
    <div className="sk-training-queue" style={{ position: 'sticky', top: 0, zIndex: 1 }}>
      <div className="sk-training-kicker">RESEARCH IN PROGRESS</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <div style={{ position: 'relative', width: 44, height: 44, flex: 'none' }}>
          <Sprite name={troopPortrait(r.troop, levels[r.troop])} w={44} h={44} />
        </div>
        <div style={{ flex: '1 1 120px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 4, fontSize: 15, color: C.textDim }}>
            <span>{trpLabel(r.troop)} <span style={{ color: C.goldHi }}>L{r.toLevel - 1}→L{r.toLevel}</span></span>
            {/* Unit label like the build-job chip — a 5-day research as raw
                m:ss would read "7200:00". */}
            <span style={{ color: C.gold }}>{remSec > 0 ? fmtDur(remSec) : 'DONE'}</span>
          </span>
          <span style={{ height: 6, background: C.border, border: `1px solid ${C.ink}`, display: 'block' }}>
            <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: C.gold }} />
          </span>
        </div>
        <Btn fontSize={15} disabled={busy || finishDisabled} style={{ minHeight: 48, padding: '6px 10px', flex: '1 1 140px' }} onClick={onFinish}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>⚡ FINISH · REVIEW</span>
        </Btn>
      </div>
      {/* Pre-update research carries no receipt: no control, and it says why
          rather than leaving a silent gap where the button should be. */}
      {r.canCancel && r.refundShards != null ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 4 }}>
          <Btn variant="ghost" fontSize={14} disabled={busy} style={{ minHeight: 48, padding: '5px 10px' }}
            onClick={() => onCancel(r.refundShards!)}>
            ✕ CANCEL · <Icon name="shard" size={12} />+{fmtN(r.refundShards)}
          </Btn>
        </div>
      ) : (
        <div style={{ color: C.textFaint, fontSize: 12, paddingTop: 3, textAlign: 'right' }}>PRE-UPDATE RESEARCH FINISHES NORMALLY</div>
      )}
    </div>
  );
}

/** Forge: RESEARCH per-troop level upgrades (GDD Addendum B1). The running
 * research renders as a live card with a currency review; idle rows state their
 * gate (NEEDS ALCHEMY LAB Lx / ALCHEMY LAB BUSY) instead of a dead button.
 * The building is the ALCHEMY LAB to the player (BuildingInfo/sheets names;
 * `forge` is only its saved-base identity) — tester report 2026-09-16: FORGE
 * copy here read as the Gold Forge. */
export function ResearchTray(): React.JSX.Element {
  const wallet=useApp(s=>s.wallet),baseId=useApp(s=>s.selectedBaseId),epoch=useApp(s=>s.baseSelectionEpoch);
  return <ArmyActionSlot key={`${wallet}:${baseId}:${epoch}`} kind="research"><ResearchTrayForBase/></ArmyActionSlot>;
}
function ResearchTrayForBase({binding,children}:{binding?:ArmyOwnerBinding;children?:(model:ArmyResearchModel)=>ReactNode}={}):React.JSX.Element {
  const access=useRef(binding);access.current=binding;
  const mounted=useRef(true),guard=useRef(captureBaseSnapshotGuard()),sending=useRef(false);
  const alive=()=>mounted.current&&isBaseSnapshotGuardCurrent(guard.current);
  const dispatch=<T,>(kind:'read'|'recover'|'mutate',action:()=>T):T=>armyOwnerDispatch(access,alive,kind,action);
  useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const selectedBaseId = useApp((s) => s.selectedBaseId), baseEpoch = useApp((s) => s.baseSelectionEpoch), wallet = useApp((s) => s.wallet);
  const money = useResearchSpeedupView(), revision = money?.snapshotRevision ?? 0;
  // Preserve the full roster DTO (including cancellation/refund capabilities).
  // Receipt evidence never supplies current levels, and an older base/refresh
  // response cannot become this view after A → B → A navigation.
  const { data: loaded, reload, loading, error } = useFetch(async () => {
    const scope = captureBaseSnapshotGuard();
    const army = await api.get<ArmyState>(selectedBasePath('/army'), { isCurrent: () => isBaseSnapshotGuardCurrent(scope) });
    if (!isBaseSnapshotGuardCurrent(scope)) throw new Error('The research kingdom changed. Refresh its current roster.');
    return { scope, revision, army };
  }, [wallet, selectedBaseId, baseEpoch, revision]);
  const data = loaded && !loading && !money?.state.busy && loaded.revision === revision && isBaseSnapshotGuardCurrent(loaded.scope) ? loaded.army : null;
  const base = useApp((s) => s.base);
  const keepLevel = useApp((s) => s.base?.player.keepLevel);
  const [busy, setBusy] = useState(false);
  const { confirmCancel, cancelDialog } = useCancelJobConfirm();
  const active = data?.research[0] ?? null; // concurrentResearch = 1, so [0] is THE research
  const [blockedReason,setBlockedReason]=useState<string|null>(null);
  const currentData=useRef(data);currentData.current=data;
  const submittedView=useRef<ArmyState|null>(null);
  useEffect(()=>{if(data && data!==submittedView.current){submittedView.current=null;setBlockedReason(null);}},[data]);
  const refuseResearch = (reason:string):void => { if (alive()) setBlockedReason(reason);toast(reason); };

  const forgeLv = forgeLevelFromBase(base?.buildings ?? [], base?.jobs ?? []);

  // Auto-refetch when the research completes (mirrors TrainTray; the server
  // completes lazily on GET /army). An already-elapsed row retries shortly
  // rather than freezing the card at 0:00.
  useEffect(() => {
    const head = data?.research[0];
    if (!head) return;
    const end = new Date(head.finishesAt).getTime();
    // Same 2^31-1 ms setTimeout cap as the training queue above (an overflowing delay fires after 1 ms).
    const delay = Math.min(end <= Date.now() ? 2_000 : end - Date.now() + 1_500, 2_147_483_647);
    const t = setTimeout(() => reload(), delay);
    return () => clearTimeout(t);
  }, [data, reload]);

  // Celebrate the completion we OBSERVE (research row gone + level at target),
  // not the timer firing — truthful under clock skew, and the same transition
  // covers ⚡ FINISH (whose reload produces it), so there is exactly ONE
  // celebration path for both.
  const prevResearch = useRef<ArmyState['research']>([]);
  useEffect(() => { prevResearch.current = []; }, [wallet, selectedBaseId, baseEpoch]);
  useEffect(() => {
    if (!data) return;
    for (const was of prevResearch.current) {
      const still = data.research.some((r) => r.troop === was.troop);
      if (!still && (data.levels[was.troop] ?? 1) >= was.toLevel) {
        playSfx('sfx_confirm');
        toast(`${trpLabel(was.troop)} L${was.toLevel} RESEARCHED`);
      }
    }
    prevResearch.current = data.research;
  }, [data]);

  const research = (troop: string): void => {
    // The legacy branch keeps its known issue; the new owner never copies that re-entry gap.
    if (binding) {
      const view = currentData.current, current = useApp.getState();
      if (!alive() || current.base?.baseId !== current.selectedBaseId) {
        refuseResearch('This army panel is no longer current. Close it and reopen Army.');return;
      }
      if (access.current?.actionsEnabled !== true) {
        refuseResearch('New army actions are paused. You can still check saved requests.');return;
      }
      if (sending.current) {refuseResearch('A research request is already being checked.');return;}
      if (!view || submittedView.current === view) {
        refuseResearch('The previous research request needs a fresh army check. Use CHECK ARMY before trying again.');return;
      }
      if (!TRAIN_TABLE.some(row=>row.key===troop)
        || troopUnlockView(troop,current.base?.player.keepLevel,view.eliteUnlocks).locked
        || troopRolloutGate(troop,view.features?.darkAttackerRoster).locked
        || researchRowState(troop,view.levels[troop]??1,view.research[0]?.troop??null,
          forgeLevelFromBase(current.base?.buildings??[],current.base?.jobs??[])).kind!=='ready') {
        refuseResearch('This troop is not available for research. Check the current army and its requirements.');return;
      }
      setBlockedReason(null);
      sending.current = true;
    }
    setBusy(true);
    void armyOwnerRequest(()=>dispatch('mutate',()=>{if(binding)submittedView.current=currentData.current;return api.post('/army/research', withSelectedBase({ troop }));})) // original api.post owns its key
      .then(() => { if(binding&&!alive())return;playSfx('sfx_confirm'); haptic('light'); toast(`RESEARCHING ${trpLabel(troop)}`); reload(); return reloadBase(); })
      .catch((e: Error) => {
        if(binding&&!alive())return;
        if(binding)setBlockedReason(submittedView.current
          ? 'The previous research request needs a fresh army check. Use CHECK ARMY before trying again.' : e.message);
        playSfx('sfx_error');toast(e.message);
      })
      .finally(() => {sending.current=false;if(!binding||alive())setBusy(false);});
  };
  const finish = (troop: string): void => {
    if (!money || !selectedBaseId || !money.actionsEnabled || money.state.busy) return;
    try{dispatch('mutate',()=>money.begin({ troop: troop as TroopType, baseId: selectedBaseId }));}catch(error){toast((error as Error).message);}
  };
  // CANCEL (tester request 2026-09-04) asks first, quoting the server's own
  // refund; the troop in the path pins the exact research the card showed, so
  // a row that changed underneath is a clean 409 rather than a surprise.
  const postCancel = (troop: string): void => {
    if(binding){
      if(!alive()){refuseResearch('This army panel is no longer current. Close it and reopen Army.');return;}
      if(access.current?.actionsEnabled!==true){refuseResearch('New army actions are paused. You can still check saved requests.');return;}
      if(sending.current){refuseResearch('A research request is already being checked.');return;}
      setBlockedReason(null);sending.current=true;
    }
    setBusy(true);
    void armyOwnerRequest(()=>dispatch('mutate',()=>api.post<{ refundShards: string }>(`/army/research/${troop}/cancel`, withSelectedBase({}))))
      .then((r) => {
        if(binding&&!alive())return;playSfx('sfx_confirm'); haptic('light');
        toast(`${trpLabel(troop)} RESEARCH CANCELLED · +${r.refundShards} SHARDS`);
        reload(); return reloadBase();
      })
      .catch((e: Error) => { if(binding&&!alive())return;playSfx('sfx_error'); toast(e.message); })
      .finally(() => {sending.current=false;if(!binding||alive())setBusy(false);});
  };
  const cancel = (troop: string, toLevel: number, refundShards: string): void => {try{dispatch('mutate',()=>confirmCancel({
    kind: 'RESEARCH',
    what: `${trpLabel(troop)} L${toLevel - 1}→L${toLevel}`,
    refundShards,
    onConfirm: () => postCancel(troop),
  }));}catch(error){toast((error as Error).message);}};

  if(binding&&children)return <>{children({data,error,loading,busy,cancelDialog,blockedReason,research,finish,cancel,openHistory:()=>{try{dispatch('recover',()=>money?.openHistory());}catch(error){toast((error as Error).message);}},refresh:()=>{try{dispatch('recover',reload);}catch(error){toast((error as Error).message);}}})}</>;
  return (
    <div className="sk-training-tray">
      {cancelDialog}
      {money && <Btn variant="sec" fontSize={15} style={{ minHeight: 44 }} onClick={money.openHistory}>RESEARCH PAYMENTS & RECEIPTS</Btn>}
      {error && <p role="alert" style={{ color: C.danger }}>{error}</p>}
      <div className="sk-training-heading"><strong>UPGRADE TROOPS</strong><span>Research your next troop level at the Alchemy Lab.</span></div>
      {active && data && (
        <ResearchActive r={active} levels={data.levels} busy={busy} finishDisabled={!money || !selectedBaseId || !money.actionsEnabled || money.state.busy || !money.state.loaded}
          onFinish={() => finish(active.troop)}
          onCancel={(refund) => cancel(active.troop, active.toLevel, refund)} />
      )}
      <div className="sk-research-grid">{TRAIN_TABLE.map((t) => {
        const lv = data?.levels[t.key] ?? 1;
        // D-058: research shares the training writ gate (server-enforced too).
        const unlock = troopUnlockView(t.key, keepLevel, data?.eliteUnlocks);
        const rollout = troopRolloutGate(t.key, data?.features?.darkAttackerRoster);
        // Row state only once /army has answered — a loading-time "NEEDS FORGE
        // L2" flash would be the client inventing the player's level.
        const row = data ? researchRowState(t.key, lv, active?.troop ?? null, forgeLv) : null;
        return (
          <Chip key={t.key} style={{ display: 'grid', gridTemplateColumns: '44px minmax(0, 1fr)', alignItems: 'center', gap: 10, padding: 10, borderColor: C.borderLt }}>
            <div style={{ position: 'relative', width: 44, height: 44, flex: 'none' }}>
              {/* data?.levels[t.key], NOT lv: while /army is loading, lv's ?? 1
                  fallback is for gated row computation only. Until current
                  data arrives the badge stays unknown and undefined keeps
                  the legacy portrait rather than inventing a level. */}
              <Sprite name={troopPortrait(t.key, data?.levels[t.key])} w={44} h={44} />
              <span data-research-level={t.key} style={{ position: 'absolute', right: -2, bottom: -2, fontSize: 12, color: C.ink, background: C.gold, padding: '0 3px', border: `1px solid ${C.ink}` }}>{data ? `L${lv}` : '—'}</span>
            </div>
            <span style={{ fontSize: 18, color: C.text }}>{t.label}</span>
            <div className="sk-research-offer">
            {rollout.locked ? (
              <span style={{ color: C.textFaint, fontSize: 14 }}>{rollout.message}</span>
            ) : unlock.locked ? (
              <span style={{ color: C.danger, fontSize: 13 }}>{unlock.label}</span>
            ) : row === null ? null : row.kind === 'maxed' ? (
              <span style={{ color: C.textFaint, fontSize: 14 }}>MAX</span>
            ) : row.kind === 'researching' ? (
              // D2 (owner phone report): this row used to say "RESEARCHING…"
              // while the pinned card above ALSO tracked the same research —
              // two in-progress truths, and the one with the FINISH button was
              // the one off-screen. The card owns countdown/progress/FINISH;
              // the row just points up at it.
              <span style={{ color: C.textFaint, fontSize: 14 }}>IN PROGRESS ↑</span>
            ) : row.kind === 'forgeBusy' ? (
              // The one-at-a-time rule made visible instead of a dead button.
              <span style={{ color: C.textFaint, fontSize: 14 }}>ALCHEMY LAB BUSY · 1 AT A TIME</span>
            ) : row.kind === 'needsForge' ? (
              <span style={{ color: C.textFaint, fontSize: 14 }}>NEEDS ALCHEMY LAB L{row.forgeLevel}</span>
            ) : (
              // Shard icon, not keep: researchTroop debits spendShards
              // ('army.research') — the old keep icon predated the
              // dual-currency split. Cost + duration shown BEFORE committing.
              <Btn fontSize={15} disabled={busy} style={{ minHeight: 48, padding: '6px 10px', width: '100%' }} onClick={() => research(t.key)}>
                <Icon name="shard" size={14} />{row.costShards} · {fmtDur(row.durationSec)} · L{row.toLevel}
              </Btn>
            )}
            </div>
          </Chip>
        );
      })}</div>
    </div>
  );
}

/** Camp: VIEW ARMY roster (pts/cap line). */
export function ArmyRoster(): React.JSX.Element {
  const { data } = useTrainingArmy();
  // M23 a7: tapping a tile shows the troop's authored Codex prose in place —
  // this screen is already a lazy chunk, so importing the Codex copy is free.
  // Troops without authored copy (K-007: giant/troll/dragon/mage/bilgewraith)
  // show a stats-only note; lore is never invented.
  const [infoKey, setInfoKey] = useState<string | null>(null);
  const infoTroop = infoKey ? TRAIN_TABLE.find((t) => t.key === infoKey) ?? null : null;
  const infoEntry = infoTroop ? CODEX.TROOPS.find((e) => e.name === infoTroop.label) ?? null : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Each tile NAMES its troop (owner report 2026-07-26: the roster was 11
          name-less portraits, so the two troops you owned were unidentifiable
          among nine dimmed ×0 tiles). Geometry/label copied from TrainTray above
          — width 86 + fontSize 14, because Tailwind Preflight makes these
          border-box and "BILGEWRAITH" in VT323 needs ~77px of content width.
          TRAIN_TABLE order is deliberate: it matches the deploy tray, which
          iterates TROOP_TYPES. A gold border marks what you actually have. */}
      <div className="sk-training-roster">
        {TRAIN_TABLE.map((t) => {
          const n = data ? data.counts[t.key] ?? 0 : null;
          return (
            <button key={t.key} type="button" className="interactive"
              aria-pressed={infoKey === t.key}
              onClick={() => setInfoKey(infoKey === t.key ? null : t.key)}
              style={{ minWidth: 0, width: '100%', background: C.card, border: `2px solid ${infoKey === t.key ? C.goldHi : (n ?? 0) > 0 ? C.gold : C.borderLt}`, padding: '10px 4px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, opacity: n === 0 ? 0.75 : 1, cursor: 'pointer', fontFamily: 'inherit' }}>
              <Sprite name={troopPortrait(t.key, data?.levels[t.key])} w={56} h={56} />
              <span style={{ fontSize: 16, color: C.textDim, lineHeight: 1 }}>{t.label}</span>
              <span style={{ fontSize: 22, color: (n ?? 0) > 0 ? C.goldHi : C.text, lineHeight: 1 }}>{n === null ? '—' : `×${n}`}</span>
            </button>
          );
        })}
      </div>
      {infoTroop && (
        <div style={{ background: C.card, border: `2px solid ${C.border}`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ color: C.goldHi, fontSize: 15 }}>{infoTroop.label}</span>
          {infoEntry ? (
            <>
              <span style={{ color: C.textDim, fontSize: 13, lineHeight: 1.4 }}>{infoEntry.who}</span>
              {infoEntry.strat && <span style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.4 }}>{infoEntry.strat}</span>}
            </>
          ) : (
            <span style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.4 }}>
              Field reports on this troop are still being written. Its numbers in the Barracks are live.
            </span>
          )}
        </div>
      )}
      <div style={{ color: C.textFaint, fontSize: 15 }}>
        ARMY {data?.rosterPts ?? 0}/{data?.campCapacityPts ?? '—'} PTS · LIVES HERE BETWEEN RAIDS
      </div>
    </div>
  );
}

/**
 * The roster as a screen of its own, opened from the task rail's ARMY button
 * (D-096 troop stock, owner 2026-09-02). Before it, the only way to see what
 * you had was camp → sheet → VIEW ARMY: a primary surface three taps deep.
 *
 * The header is the base-wide readiness the /base read ALREADY carries — no
 * request of its own — and it describes what the camp holds, never whether a
 * raid is ready (D-094: capacity figures are capacity, not a verdict). An
 * older API cut omits armyStatus; then there is no header rather than a fake
 * zero. The per-troop counts below come from the roster's own GET /army,
 * exactly as the camp tray fetches them.
 */
export function ArmyScreen(): React.JSX.Element {
  const researchMoney = useResearchSpeedupView(), trainingMoney = useTrainingFinishView();
  const armyStatus = useApp((s) => s.base?.armyStatus);
  const setScreen = useApp((s) => s.setScreen);
  const home = (): void => setScreen('base');
  return (
    <ModalWrap onBackdrop={home} width={640}>
      <div className="sk-training-review-title"><Phead title="ARMY" onClose={home} /></div>
      <div className="sk-training-army-body" style={{ padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {armyStatus && (
          <div className="sk-training-notice" style={{ color: C.textDim, fontSize: 16 }}>
            BASE ARMY · {armyStatus.readyTroopCount} READY
            {' · '}{armyStatus.readyPts}/{armyStatus.campCapacityPts} PTS
            {' · '}{armyStatus.trainingTroopCount} TRAINING
          </div>
        )}
        {trainingMoney && <Btn variant="sec" fontSize={16} style={{ minHeight: 44 }} onClick={trainingMoney.openHistory}>TRAINING PAYMENTS & RECEIPTS</Btn>}
        {researchMoney && <Btn variant="sec" fontSize={16} style={{ minHeight: 44 }} onClick={researchMoney.openHistory}>RESEARCH PAYMENTS & RECEIPTS</Btn>}
        <ArmyRoster />
      </div>
    </ModalWrap>
  );
}
