/** Saved plans describe additional troops; a server preview is required before
 * every batch. A failed response retries the same durable purchase receipt. */
import { TRAINING_PRESETS, type PreviousArmy, type TrainingBatchResult, type TrainingComposition, type TrainingPreset, type TrainingQuote, type TroopType } from '@shardkeep/shared';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type MutableRefObject } from 'react';
import type { PanelSession } from '../pk/panelSession';
import { createPortal } from 'react-dom';
import { ApiError, api } from '../../lib/api';
import { bus } from '../../lib/events';
import { selectedBasePath, withSelectedBase } from '../../lib/baseSelection';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { TRAIN_TABLE, TROOP_DISPLAY } from '../copy';
import { troopPortrait } from '../icons';
import { Btn, btnStyle, COLORS as C, fmtDur, Icon, ModalWrap, Phead, Sprite } from '../primitives';
import './training.css';

import { clearTrainingPurchase, readTrainingPurchase, saveTrainingPurchase, verifyTrainingBatch, verifyTrainingRecovery, verifyTrainingQuote, type TrainingPurchase } from './trainingPurchase';

const label = (troop: string): string => TROOP_DISPLAY[troop] ?? troop.toUpperCase();
const toast = (msg: string): void => bus.emit('ui:toast', { msg });
const smallButton = { minHeight: 48, minWidth: 48, padding: '6px 10px', fontSize: 15, lineHeight: 1.15 };


/** Proposed PK access port; the legacy presentation remains on its original path. */
export interface ArmyOwnerBinding {
  actionsEnabled: boolean;
  session: Pick<PanelSession, 'dispatch'>;
}
export function isArmyOwnerBinding(value: ArmyOwnerBinding | undefined): value is ArmyOwnerBinding {
  return !!value && typeof value.actionsEnabled === 'boolean' && typeof value.session?.dispatch === 'function';
}
export interface TrainingPurchaseModel {
  quote: TrainingQuote|null; pending: TrainingPurchase|null; busy:boolean; storageError:boolean; message:string;
  preview(composition:TrainingComposition):Promise<void>; confirm():Promise<void>;
  recover(intent:TrainingPurchase):Promise<void>;
  requestClose():void; closeDialog:ReactNode; retrySavedPurchase():void;
  openSaved():Promise<void>; previous():Promise<void>;
}
// A second presentation never mounts another set of closures for this owner kind/base.
const armyOwnerSlots = new Map<string, symbol>();
export function ArmyActionSlot({kind, children}: {kind: string; children: ReactNode}): React.JSX.Element | null {
  const wallet = useApp(s => s.wallet), baseId = useApp(s => s.selectedBaseId);
  const tag = `${kind}:${wallet}:${baseId}`, token = useRef(Symbol('army-owner'));
  const [claimed, setClaimed] = useState(false);
  useLayoutEffect(() => {
    if (armyOwnerSlots.has(tag)) return;
    armyOwnerSlots.set(tag, token.current);
    setClaimed(true);
    return () => {
      if (armyOwnerSlots.get(tag) === token.current) armyOwnerSlots.delete(tag);
    };
  }, [tag]);
  return claimed ? <>{children}</> : <p role="status">
    Army actions are already open for this kingdom. Close this panel and reopen it after the other panel closes.
  </p>;
}
/** Called at the original dispatch boundary, including queued continuations.
 * An absent binding is solely the existing legacy entry; public PK owners require one. */
export function armyOwnerDispatch<T>(
  binding: MutableRefObject<ArmyOwnerBinding | undefined>, alive: () => boolean,
  kind: 'read' | 'recover' | 'mutate', action: () => T,
): T {
  const current = binding.current;
  if (!current) return action();
  const check = () => {
    if (!alive() || binding.current !== current) throw Error('This army panel is no longer current. Close it and reopen Army.');
    if (kind === 'mutate' && current.actionsEnabled !== true) throw Error('New army actions are paused. You can still check saved requests.');
  };
  check();
  let invoked = false, result!: T;
  const accepted = current.session.dispatch(kind, () => {
    check(); invoked = true; result = action();
  });
  if (!accepted || !invoked) throw Error('This army panel is no longer current. Close it and reopen Army.');
  return result;
}

/** Preserve the original synchronous request start, while turning a refused
 * dispatch into the same caught promise path as a transport refusal. */
export function armyOwnerRequest<T>(start: () => Promise<T>): Promise<T> {
  try { return start(); }
  catch (error) { return Promise.reject(error); }
}

interface TrainingPresetsProps {
  binding?: ArmyOwnerBinding;
  children?: (model:TrainingPurchaseModel)=>ReactNode;
  onTrained: () => void;
  onBusyChange: (busy: boolean) => void;
  draft?: TrainingComposition;
  onDraftAccepted?: () => void;
  /** Where the failed-purchase notice renders (the TOP of the barracks tray,
   *  tester report 2026-09-16); inline at the foot when absent. */
  noticeHost?: HTMLElement | null;
  /** True while a saved purchase waits on the player (RETRY / CLOSE) and no
   *  request is in flight — the tray's cue to explain a blocked tap. */
  onPendingChange?: (pending: boolean) => void;
}
export function TrainingPresets(props: TrainingPresetsProps): React.JSX.Element {
  const wallet = useApp((s) => s.wallet);
  const baseId = useApp((s) => s.selectedBaseId);
  const epoch = useApp((s) => s.baseSelectionEpoch);
  return <ArmyActionSlot key={`${wallet}:${baseId}:${epoch}`} kind="purchase"><TrainingPurchases {...props} /></ArmyActionSlot>;
}
export function TrainingPurchaseOwner(props:TrainingPresetsProps & {binding:ArmyOwnerBinding;children:(model:TrainingPurchaseModel)=>ReactNode}):React.JSX.Element|null {
  if (!isArmyOwnerBinding(props.binding)) return null;
  return <TrainingPresets {...props}/>;
}
function TrainingPurchases({ onTrained, onBusyChange, draft, onDraftAccepted, noticeHost, onPendingChange, binding, children }: TrainingPresetsProps): React.JSX.Element {
  const access=useRef(binding);access.current=binding;
  const working=useRef(false);
  const deferredStorageRead=useRef(false);
  const [presets, setPresets] = useState<TrainingPreset[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<TrainingPreset | null>(null);
  const [quote, setQuote] = useState<TrainingQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<TrainingPurchase | null>(null);
  const pendingRef = useRef<TrainingPurchase | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [recoveryRead, setRecoveryRead] = useState(0);
  const [closing, setClosing] = useState(false);
  const [closeIntent,setCloseIntent]=useState<TrainingPurchase|null>(null);
  const [nextQuote, setNextQuote] = useState<TrainingQuote | null>(null);
  const mounted = useRef(true);
  const current = useRef(captureBaseSnapshotGuard());
  const alive = (): boolean => mounted.current && isBaseSnapshotGuardCurrent(current.current);
  const dispatch=<T,>(kind:'read'|'recover'|'mutate',action:()=>T):T=>armyOwnerDispatch(access,alive,kind,action);
  const setWorking = (value: boolean): void => {
    working.current=value;
    if (alive()) {
      setBusy(value);
      if (!value && deferredStorageRead.current) { deferredStorageRead.current=false;setRecoveryRead(n=>n+1); }
    }
  };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { onBusyChange(busy || !!pending || storageError); return () => onBusyChange(false); }, [busy, pending, storageError, onBusyChange]);
  useEffect(() => { onPendingChange?.(!!pending && !busy); return () => onPendingChange?.(false); }, [busy, pending, onPendingChange]);
  // HIDE folds the notice to one line for THIS receipt only; a new failure
  // (new key) unfolds again. Dismissible, never gone: the retry must stay reachable.
  const [hiddenKey, setHiddenKey] = useState<string | null>(null);
  const samePending = (value:TrainingPurchase|null, expected:TrainingPurchase):boolean => !!value
    && value.wallet===expected.wallet && value.baseId===expected.baseId && value.idempotencyKey===expected.idempotencyKey;
  const retain = (value: TrainingPurchase | null): void => {
    pendingRef.current = value; setPending(value);
    // A saved original has its own consent. Never leave an unrelated quote open.
    if (binding && value) setQuote(null);
  };
  const acknowledge = (intent: TrainingPurchase, status: 'accepted' | 'closed'): void => {
    clearTrainingPurchase(intent);
    const remaining = readTrainingPurchase(intent.wallet);
    retain(remaining); setQuote(status === 'closed' && !remaining ? nextQuote : null); setNextQuote(null); setClosing(false); setCloseIntent(null);
    if (remaining) setRecoveryRead((n) => n + 1);
    setMessage(status === 'accepted' ? 'PURCHASE CONFIRMED · REFRESHING LIVE ARMY' : 'REQUEST CLOSED · NO FUTURE PURCHASE CAN USE THIS KEY');
    if (status === 'accepted') { onTrained(); if (intent.baseId === current.current.selectedBaseId) onDraftAccepted?.(); }
  };
  const recover = async (intent: TrainingPurchase, close = false, alreadyOwned = false): Promise<void> => {
    if (!alive() || (binding && (!samePending(pendingRef.current,intent) || working.current && !alreadyOwned))) return;
    setWorking(true); setMessage('CHECKING ORIGINAL PURCHASE…');
    try {
      const receipt: unknown = close
        ? await dispatch('recover',()=>api.post('/army/training/close', { idempotencyKey: intent.idempotencyKey, confirmed: true }))
        : await dispatch('recover',()=>api.get(`/army/training/receipt?idempotencyKey=${encodeURIComponent(intent.idempotencyKey)}`));
      if (!alive() || !samePending(pendingRef.current,intent)) return;
      const status = verifyTrainingRecovery(receipt, intent);
      if (status === 'unknown') setMessage('PURCHASE NOT YET CONFIRMED · CHECK AGAIN, RETRY THE EXACT REQUEST, OR CLOSE IT BEFORE A NEW PURCHASE.');
      else acknowledge(intent, status);
    } catch (error) { if (alive()) setMessage((error as Error).message); }
    finally { setWorking(false); }
  };
  useEffect(() => {
    const load = (): void => {
      if (!alive() || !current.current.wallet) return;
      // Storage events never replace the intent or release a running request's latch.
      if (binding && working.current) { deferredStorageRead.current=true;return; }
      try {
        const saved = readTrainingPurchase(current.current.wallet);
        setStorageError(false); retain(saved);
        if (saved) void recover(saved);
      } catch (error) { setStorageError(true); setMessage((error as Error).message); }
    };
    load();
    window.addEventListener('storage', load);
    return () => window.removeEventListener('storage', load);
  }, [recoveryRead]);
  const purchaseBlocked = busy || !!pending || storageError;
  const openSaved = async (): Promise<void> => {
    if (expanded) { setExpanded(false); return; }
    setWorking(true); setMessage('');
    try {
      const data = await dispatch('read',()=>api.get<{ presets: TrainingPreset[] }>('/army/presets'));
      if (alive()) { setPresets(data.presets); setExpanded(true); }
    } catch (error) { if (alive()) setMessage((error as Error).message); }
    finally { setWorking(false); }
  };
  const preview = async (composition: TrainingComposition): Promise<void> => {
    if (purchaseBlocked || !alive()) return;
    setMessage(''); setWorking(true);
    try {
      const data = await dispatch('mutate',()=>api.post<TrainingQuote>('/army/training/quote', withSelectedBase({ composition })));
      if (alive()) {
        verifyTrainingQuote(data);
        setQuote(data);
      }
    } catch (error) { if (alive()) setMessage((error as Error).message); }
    finally { setWorking(false); }
  };
  const previous = async (): Promise<void> => {
    setMessage(''); setWorking(true);
    try {
      const data = await dispatch('read',()=>api.get<PreviousArmy>(selectedBasePath('/army/previous')));
      if (!alive()) return;
      if (data.composition.length) await preview(data.composition);
      else setMessage(data.message ?? 'No troops in the previous attack.');
    } catch (error) { if (alive()) setMessage((error as Error).message); }
    finally { setWorking(false); }
  };
  const save = async (): Promise<void> => {
    if (!editing) return;
    setWorking(true); setMessage('');
    try {
      const saved = await dispatch('mutate',()=>api.put<TrainingPreset>(`/army/presets/${editing!.slot}`, editing!));
      if (alive()) { setPresets((rows) => [...rows.filter((p) => p.slot !== saved.slot), saved]); setEditing(null); }
    } catch (error) { if (alive()) setMessage((error as Error).message); }
    finally { setWorking(false); }
  };
  const remove = async (slot: number): Promise<void> => {
    setWorking(true); setMessage('');
    try { await dispatch('mutate',()=>api.del(`/army/presets/${slot}`)); if (alive()) { setPresets((rows) => rows.filter((p) => p.slot !== slot)); setEditing(null); } }
    catch (error) { if (alive()) setMessage((error as Error).message); }
    finally { setWorking(false); }
  };
  const confirm = async (): Promise<void> => {
    if (busy || (binding && working.current) || !alive() || !current.current.wallet || storageError) return;
    let intent = pendingRef.current;
    if (intent && intent.baseId !== current.current.selectedBaseId) {
      if (binding) setMessage('This saved training request belongs to another kingdom. Select its original kingdom to retry it.');
      return;
    }
    // Refusal precedes minting/persisting a key. The POST boundary checks again.
    if (binding) {
      try { dispatch('mutate', () => undefined); }
      catch (error) { if (alive()) setMessage((error as Error).message); return; }
    }
    setWorking(true); setMessage('');
    try {
      if (!intent) {
        if (!quote) return;
        if (!quote.queueable.length) {
          setMessage('No troops can be queued from this review. Check the army and choose another batch.');return;
        }
        const saved = readTrainingPurchase(current.current.wallet);
        if (saved) { retain(saved); await recover(saved,false,true); return; }
        intent = { version: 1, wallet: current.current.wallet, baseId: current.current.selectedBaseId,
          idempotencyKey: crypto.randomUUID(), composition: quote.queueable.map((row) => ({ ...row })),
          confirmedCostShards: quote.costShards, ...(quote.consent ? { consent: quote.consent } : {}) };
        saveTrainingPurchase(intent); // Storage failure must happen before any POST.
        retain(intent);
      }
      const result = await dispatch('mutate',()=>api.post<TrainingBatchResult>('/army/training/batch', {
        idempotencyKey: intent!.idempotencyKey, composition: intent!.composition, confirmedCostShards: intent!.confirmedCostShards,
        ...(intent!.baseId ? { baseId: intent!.baseId } : {}), ...(intent!.consent ? { consent: intent!.consent } : {}),
      }));
      if (!alive()) return;
      verifyTrainingBatch(result, intent);
      acknowledge(intent, 'accepted');
      setMessage(`${result.queue.length} TROOPS PURCHASED · ${result.costShards} SHARDS · REFRESHING LIVE ARMY`);
    } catch (error) {
      if (!alive()) return;
      // Even a quote refusal does not close the durable key. A delayed attempt
      // may still exist; explicit closure or an accepted receipt resolves it.
      setQuote(null);
      if (error instanceof ApiError && error.code === 'TRAINING_QUOTE_CHANGED' && error.details?.quote) {
        try { const replacement = error.details.quote as unknown as TrainingQuote; verifyTrainingQuote(replacement); setNextQuote(replacement); } catch { setNextQuote(null); }
      }
      setMessage((error as Error).message);
      // The moment it fails, say so (tester report 2026-09-16: "no alert unless
      // I check the Barracks") — the notice on top carries the RETRY.
      toast('TRAINING FAILED · RETRY AT THE TOP OF TRAIN TROOPS');
    } finally { setWorking(false); }
  };
  const changeRow = (index: number, count: number): void => setEditing((p) => p && ({ ...p, composition: p.composition.map((row, i) => i === index ? { ...row, count } : row) }));
  const move = (index: number, direction: number): void => setEditing((p) => {
    if (!p) return p;
    const rows = [...p.composition]; const destination = index + direction;
    if (destination < 0 || destination >= rows.length) return p;
    [rows[index], rows[destination]] = [rows[destination]!, rows[index]!];
    return { ...p, composition: rows };
  });
  const report = (error:unknown):void => { if (alive()) setMessage((error as Error).message); };
  const requestClose = ():void => {
    if (!alive() || working.current) return;
    try { dispatch('recover',()=>{
      const intent=pendingRef.current;if (!intent) return;
      setCloseIntent(intent);setClosing(true);
    }); } catch (error) { report(error); }
  };
  const keepRequest = ():void => { if (!working.current) {setClosing(false);setCloseIntent(null);} };
  const confirmClose = ():Promise<void> => {
    const intent=binding ? closeIntent : pending;
    if (!closing || !intent || working.current || !alive()) return Promise.resolve();
    if (binding && !samePending(pendingRef.current,intent)) {
      setClosing(false);setCloseIntent(null);setMessage('The saved training request changed. Check it before closing a request.');
      return Promise.resolve();
    }
    return recover(intent,true);
  };
  const retrySavedPurchase = ():void => {
    if (!alive() || working.current) return;
    try { dispatch('recover',()=>setRecoveryRead(n=>n+1)); } catch (error) { report(error); }
  };
  // Public methods share the original owner's request latch; internal chained reads keep it.
  const idle = (action:()=>Promise<void>):Promise<void> => working.current ? Promise.resolve() : action();
  const closeDialog = closing && (binding ? closeIntent : pending) && createPortal(<ModalWrap onBackdrop={() => { if (!busy) keepRequest(); }}>
      <Phead title="CLOSE TRAINING REQUEST?" />
      <div role="alertdialog" aria-modal="true" aria-label="Close unaccepted training request" style={{ padding: 12, display: 'grid', gap: 8 }}>
        <div>This permanently prevents this unaccepted request from purchasing later. Already accepted troops are kept, with no cancellation or refund.</div>
        <Btn disabled={busy} onClick={() => void confirmClose()}>CONFIRM CLOSE REQUEST</Btn>
        <Btn variant="sec" disabled={busy} onClick={() => keepRequest()}>KEEP REQUEST</Btn>
      </div>
    </ModalWrap>, document.body);
  if(binding && children)return <>{children({quote,pending,busy,storageError,message,
    preview:composition=>idle(()=>preview(composition)),confirm,
    recover:intent=>idle(()=>recover(intent)),requestClose,closeDialog,retrySavedPurchase,
    openSaved:()=>idle(openSaved),previous:()=>idle(previous),
  })}</>;
  return <div className="sk-training-presets" data-training-presets="">
    <div className="sk-training-actionbar">
      {draft && <Btn data-tutorial-target="training-review" disabled={purchaseBlocked || !draft.length} style={smallButton} onClick={() => void preview(draft)}>REVIEW TRAINING · {draft.reduce((sum, row) => sum + row.count, 0)}</Btn>}
      <Btn variant="sec" disabled={purchaseBlocked} style={smallButton} onClick={() => void previous()}>RETRAIN PREVIOUS ARMY</Btn>
      <Btn variant="ghost" disabled={purchaseBlocked} style={smallButton} onClick={() => void openSaved()}>SAVED ARMIES</Btn>
    </div>
    {pending && (() => {
      // Prominent, at the top of the tray via noticeHost, titled by state: a
      // request in flight is CHECKING; one waiting on the player is FAILED and
      // leads with RETRY (tester reports 2026-09-16 ×2).
      const hidden = hiddenKey === pending.idempotencyKey;
      const notice = hidden
        ? <div className="sk-training-notice" data-training-recovery="" role="status" style={{ color: C.danger, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          TRAINING FAILED · RETRY
          <Btn variant="ghost" style={smallButton} onClick={() => setHiddenKey(null)}>SHOW</Btn>
        </div>
        : <div className="sk-training-notice" data-training-recovery="" role="status" style={{ color: busy ? C.goldHi : C.danger, borderColor: busy ? undefined : C.danger }}>
          <strong style={{ display: 'block', fontSize: 17 }}>{busy ? 'CHECKING PURCHASE…' : 'TRAINING FAILED · RETRY'}</strong>
          <span style={{ color: C.goldHi }}>ORIGINAL PURCHASE · {pending.composition.map((row) => `${row.count} ${label(row.troop)}`).join(', ')} · {pending.confirmedCostShards} SHARDS</span>
          {pending.baseId !== current.current.selectedBaseId && <div>FOR ANOTHER BASE · RECOVERY DOES NOT MOVE TROOPS HERE</div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <Btn disabled={busy || pending.baseId !== current.current.selectedBaseId} style={smallButton} onClick={() => void confirm()}>RETRY CONFIRMED BATCH</Btn>
            <Btn data-tutorial-target="training-purchase-recovery" disabled={busy} style={smallButton} onClick={() => void recover(pending)}>CHECK PURCHASE STATUS</Btn>
            <Btn variant="sec" disabled={busy} style={smallButton} onClick={() => setClosing(true)}>CLOSE UNACCEPTED REQUEST</Btn>
            <Btn variant="ghost" disabled={busy} style={smallButton} aria-label="Hide the failed training notice" onClick={() => setHiddenKey(pending.idempotencyKey)}>HIDE</Btn>
          </div>
        </div>;
      return noticeHost ? createPortal(notice, noticeHost) : notice;
    })()}
    {storageError && <div className="sk-training-notice" role="status">Browser storage is unavailable. Training purchases are blocked until recovery is available.
      <Btn variant="sec" style={smallButton} onClick={() => setRecoveryRead((n) => n + 1)}>RETRY SAVED PURCHASE</Btn>
    </div>}
    {closeDialog}
    {expanded && <div className="sk-training-saved">
      <div className="sk-training-kicker">SAVED ARMIES</div>
      <div className="sk-training-help">Adds troops to this base. Saved armies are shared across your owned bases.</div>
      {Array.from({ length: TRAINING_PRESETS.slots }, (_, i) => i + 1).map((slot) => {
        const preset = presets.find((p) => p.slot === slot);
        return <div key={slot} className="sk-training-saved-slot">
          <div className="sk-training-saved-name">{slot}. {preset?.name ?? 'EMPTY SLOT'}</div>
          {preset && <div className="sk-training-saved-units">{preset.composition.map((row) => <span key={row.troop}>
            <Sprite name={troopPortrait(row.troop)} w={24} h={24} />{row.count} {label(row.troop)}
          </span>)}</div>}
          {preset && <Btn disabled={purchaseBlocked} style={smallButton} onClick={() => void preview(preset.composition)}>PREVIEW</Btn>}
          <Btn variant="sec" disabled={busy} style={smallButton} onClick={() => { setMessage(''); setEditing(preset ? { ...preset, composition: preset.composition.map((row) => ({ ...row })) } : { slot, name: `ARMY ${slot}`, composition: [] }); }}>EDIT</Btn>
        </div>;
      })}
    </div>}
    {message && !editing && !quote && <div role="status" className="sk-training-notice" style={{ color: C.goldHi }}>{message}</div>}
    {editing && createPortal(<ModalWrap onBackdrop={() => { if (!busy) { setEditing(null); setMessage(''); } }}>
      <Phead title={`SAVED ARMY ${editing.slot}`} />
      <div role="dialog" aria-modal="true" aria-label="Edit saved army" className="sk-training-editor" style={{ padding: 12, display: 'grid', gap: 10 }}>
        <input aria-label="Army preset name" maxLength={TRAINING_PRESETS.nameMaxLength} value={editing.name} disabled={busy}
          onChange={(e) => setEditing({ ...editing, name: e.target.value })} style={{ width: '100%', boxSizing: 'border-box', minHeight: 48 }} />
        <div style={{ color: C.textDim, fontSize: 14 }}>Additional troops, filled in this order. Saving spends nothing.</div>
        {editing.composition.map((row, index) => <div key={row.troop} className="sk-training-editor-row">
          <span style={{ flex: '1 1 120px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 17 }}><Sprite name={troopPortrait(row.troop)} w={32} h={32} />{label(row.troop)}</span>
          <input type="number" aria-label={`${label(row.troop)} count`} min={1} max={TRAINING_PRESETS.maxCompositionUnits} value={row.count} disabled={busy}
            onChange={(e) => changeRow(index, Number(e.target.value))} style={{ width: 60, minHeight: 48, boxSizing: 'border-box' }} />
          <button type="button" className="interactive" disabled={busy || index === 0} style={{ ...btnStyle('ghost', 15, busy || index === 0), ...smallButton }} onClick={() => move(index, -1)} aria-label={`Move ${label(row.troop)} earlier`}>↑</button>
          <button type="button" className="interactive" disabled={busy || index === editing.composition.length - 1} style={{ ...btnStyle('ghost', 15, busy || index === editing.composition.length - 1), ...smallButton }} onClick={() => move(index, 1)} aria-label={`Move ${label(row.troop)} later`}>↓</button>
          <button type="button" className="interactive" disabled={busy} style={{ ...btnStyle('ghost', 15, busy), ...smallButton }} onClick={() => setEditing({ ...editing, composition: editing.composition.filter((_, i) => i !== index) })} aria-label={`Remove ${label(row.troop)}`}>×</button>
        </div>)}
        <select aria-label="Add troop to preset" value="" disabled={busy} style={{ minHeight: 48, maxWidth: '100%' }} onChange={(e) => {
          if (e.target.value) setEditing({ ...editing, composition: [...editing.composition, { troop: e.target.value as TroopType, count: 1 }] });
        }}><option value="">ADD TROOP…</option>{TRAIN_TABLE.filter((t) => !editing.composition.some((row) => row.troop === t.key)).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select>
        {message && <div role="status" style={{ color: C.danger }}>{message}</div>}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Btn disabled={busy || !editing.name.trim() || editing.composition.length === 0} style={smallButton} onClick={() => void save()}>SAVE</Btn>
          {presets.some((p) => p.slot === editing.slot) && <Btn variant="ghost" disabled={busy} style={smallButton} onClick={() => void remove(editing.slot)}>DELETE PRESET</Btn>}
          <Btn variant="sec" disabled={busy} style={smallButton} onClick={() => { setEditing(null); setMessage(''); }}>CANCEL</Btn>
        </div>
      </div>
    </ModalWrap>, document.body)}
    {quote && createPortal(<ModalWrap onBackdrop={() => { if (!busy) { setQuote(null); setMessage(''); } }}>
      <div className="sk-training-review-title"><Phead title="REVIEW TRAINING" /></div>
      <div role="alertdialog" aria-modal="true" aria-label="Confirm training batch" data-training-confirmation="" className="sk-training-confirmation">
        <div data-onboarding-caption-slot="training" />
        <div className="sk-training-help">Additional troops for this base. Only the listed queueable troops will be purchased.</div>
        {quote.requested.map((row) => {
          const accepted = quote.queueable.find((r) => r.troop === row.troop)?.count ?? 0;
          const rest = quote.remaining.find((r) => r.troop === row.troop);
          return <div key={row.troop} className="sk-training-quote-troop">
            <Sprite name={troopPortrait(row.troop)} w={44} h={44} />
            <div style={{ minWidth: 0 }}><strong>{label(row.troop)}</strong>
              <div>REQUESTED {row.count} · QUEUE {accepted}</div>
              {rest && <div style={{ color: C.goldHi }}>REMAINING {rest.count} · {rest.reason}</div>}
            </div>
          </div>;
        })}
        <div className="sk-training-quote-total"><Icon name="shard" size={22} /><div><span className="sk-training-kicker">TRAINING COST</span><div>SHARDS {quote.costShards} / {quote.availableShards} AVAILABLE</div></div></div>
        <div className="sk-training-quote-capacity">
          <div>CAMP {quote.camp.used} → {quote.camp.after}/{quote.camp.capacity} PTS</div>
          <div>BARRACKS {quote.barracks.used} → {quote.barracks.after}/{quote.barracks.capacity} PTS</div>
        </div>
        {quote.queueable.length ? <div>ALL READY IN {fmtDur(Math.ceil(quote.completionSec))} · NORMAL TRAINING TIMERS</div> : <div>NO TROOPS AVAILABLE TO QUEUE</div>}
        {quote.schedule && quote.queueable.length > 0 && <>
          <div>ONE TRAINING LANE · WAIT {fmtDur(Math.ceil(quote.schedule.waitMs / 1000))} · TRAIN {fmtDur(Math.ceil(quote.schedule.durationMs / 1000))}</div>
          {quote.consent.unitDurations[0] && <div>NEXT TROOP IN {fmtDur(Math.ceil((quote.schedule.waitMs + quote.consent.unitDurations[0].durationMs) / 1000))}</div>}
          <div>STARTS {new Date(quote.schedule.startsAt).toLocaleTimeString()} · FINISHES {new Date(quote.schedule.finishesAt).toLocaleTimeString()}</div>
        </>}
        {quote.remaining.length > 0 && <div style={{ color: C.goldHi }}>The remainder will not train automatically. Preview it again when you have room or SHARDS.</div>}
        {message && <div role="status" style={{ color: C.danger }}>{message}</div>}
        <div className="sk-training-confirm-actions">
          <Btn data-tutorial-target="training-add-to-queue" aria-busy={busy} disabled={purchaseBlocked || !quote.queueable.length} style={smallButton} onClick={() => void confirm()}>{`ADD TO QUEUE · ${quote.queueable.reduce((sum, row) => sum + row.count, 0)} · ${quote.costShards} SHARDS`}</Btn>
          <Btn data-tutorial-target="training-review-close" variant="sec" disabled={busy} style={smallButton} onClick={() => { setQuote(null); setMessage(''); }}>CLOSE</Btn>
        </div>
      </div>
    </ModalWrap>, document.body)}
  </div>;
}
