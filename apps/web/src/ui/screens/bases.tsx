/** Lazy, device-local base selector. Ownership always comes from fresh GET /bases;
 * localStorage holds only a preferred ID and never grants access by itself. */
import { useEffect, useState } from 'react';
import {
  api, baseSelectorAvailable, resolveFreshBaseId,
  type BasesDto,
} from '../../lib/api';
import { baseLocationLabel, fantasyDirectory } from '../../lib/baseLocation';
import { useResearchSpeedupView } from '../../lib/researchSpeedup/context';
import { useBuilderJobSpeedupView } from '../../lib/builderJobSpeedup/context';
import { useTrainingFinishView } from '../../lib/trainingFinish/context';
import { bus } from '../../lib/events';
import { selectBaseSnapshot } from '../../state/baseSnapshot';
import { clearBaseSnapshot, useApp } from '../../state/store';
import { Btn, Icon, Panel9 } from '../primitives';
import './bases.css';

interface BasesViewProps {
  directory: BasesDto | null;
  selectedBaseId: string | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  replaceBaseId: string | null;
  canClose: boolean;
  onClose(): void;
  onRetry(): void;
  onOpen(baseId: string): void;
  onReplace(baseId: string): void;
  onActivate(baseId: string): void;
  onBuyDeed(): void;
}

export function BasesView(props: BasesViewProps): React.JSX.Element {
  const researchMoney = useResearchSpeedupView();
  const trainingMoney = useTrainingFinishView();
  const builderMoney = useBuilderJobSpeedupView();
  const active = props.directory?.bases.filter((base) => base.status === 'active' && base.slot !== null) ?? [];
  const inactive = props.directory?.bases.filter((base) => base.status === 'inactive' || base.slot === null) ?? [];
  const writes = props.directory?.capabilities.baseScopedMutations === true;
  const full = !!props.directory && active.length >= props.directory.maxActive;
  const fantasy = fantasyDirectory(props.directory);
  const updateRequired = fantasy && import.meta.env.VITE_FEATURE_FANTASY_WORLD !== '1';

  return (
    <div className="bases-screen interactive" role="dialog" aria-modal="true" aria-label="Your bases">
      <header className="bases-header">
        <div><span>LAND DEED COMMAND</span><h1>YOUR BASES</h1></div>
        <button aria-label="Back to selected base" onClick={props.onClose} disabled={!props.canClose}>
          <Icon name="close" size={24} />
        </button>
      </header>

      {builderMoney && <div className="bases-state"><Btn variant="sec" style={{ minHeight: 44 }} onClick={builderMoney.openHistory}>BUILDER PAYMENTS & RECEIPTS</Btn></div>}
      {trainingMoney && <div className="bases-state"><Btn variant="sec" style={{ minHeight: 44 }} onClick={trainingMoney.openHistory}>TRAINING PAYMENTS & RECEIPTS</Btn></div>}
      {researchMoney && <div className="bases-state"><Btn variant="sec" style={{ minHeight: 44 }} onClick={researchMoney.openHistory}>RESEARCH PAYMENTS & RECEIPTS</Btn></div>}
      {props.loading && <div className="bases-state">VERIFYING FRESH DEED OWNERSHIP…</div>}
      {props.error && <div className="bases-state is-error" role="alert">{props.error.toUpperCase()}<Btn onClick={props.onRetry}>RETRY</Btn></div>}
      {props.directory && !baseSelectorAvailable(props.directory) && (
        <div className="bases-state">MULTI-BASE IS NOT ACTIVE ON THIS SERVER.</div>
      )}

      {props.directory && baseSelectorAvailable(props.directory) && (
        <main className="bases-layout">
          <section>
            <div className="bases-section-title">
              <h2>ACTIVE DEEDS</h2><span>{active.length} / {props.directory.maxActive}</span>
            </div>
            {!writes && (
              <div className="bases-readonly" role="status">
                BASE-SCOPED READS ARE LIVE. BUILDING, RAIDING, ACTIVATION AND REPLACEMENT STAY LOCKED UNTIL
                SERVER MUTATIONS ARE BASE-SCOPED.
              </div>
            )}
            <div className="bases-grid">
              {Array.from({ length: props.directory.maxActive }, (_, index) => {
                const base = active.find((candidate) => candidate.slot === index + 1);
                return base ? (
                  <Panel9 key={base.id} className={`bases-card ${base.id === props.selectedBaseId ? 'is-selected' : ''}`}>
                    <span className="bases-slot">SLOT {base.slot}</span>
                    <h3>KEEP {base.keepLevel}</h3>
                    <p>{baseLocationLabel(base, fantasy)}</p>
                    <small>{base.deedAssetId ? `DEED ${base.deedAssetId.slice(0, 6)}…${base.deedAssetId.slice(-4)}`
                      : base.landPaidAt ? 'LAND PAID · DEED PENDING' : 'FREE BASE · NO DEED'}</small>
                    <Btn onClick={() => props.onOpen(base.id)} disabled={props.busy || base.id === props.selectedBaseId}>
                      {base.id === props.selectedBaseId ? 'CURRENT BASE' : 'OPEN BASE'}
                    </Btn>
                  </Panel9>
                ) : (
                  <div className="bases-empty" key={index}>SLOT {index + 1}<span>EMPTY</span></div>
                );
              })}
            </div>
          </section>

          <section>
            <div className="bases-section-title"><h2>INACTIVE DEEDS</h2><span>{inactive.length}</span></div>
            {inactive.length === 0 ? <div className="bases-empty-list">NO EXTRA DEEDS DETECTED</div> : (
              <div className="bases-inactive">
                {inactive.map((base) => (
                  <Panel9 className="bases-inactive-card" key={base.id}>
                    <div><h3>KEEP {base.keepLevel}</h3><p>{baseLocationLabel(base, fantasy)}</p></div>
                    {full && writes && (
                      <label>REPLACE ACTIVE SLOT
                        <select value={props.replaceBaseId ?? ''} onChange={(event) => props.onReplace(event.target.value)}>
                          <option value="">CHOOSE…</option>
                          {active.map((candidate) => <option key={candidate.id} value={candidate.id}>SLOT {candidate.slot} · KEEP {candidate.keepLevel}</option>)}
                        </select>
                      </label>
                    )}
                    <Btn onClick={() => props.onActivate(base.id)} disabled={props.busy || !writes || (full && !props.replaceBaseId)}>
                      {writes ? 'ACTIVATE DEED' : 'ACTIVATION LOCKED'}
                    </Btn>
                  </Panel9>
                ))}
              </div>
            )}
          </section>

          <aside className="bases-reservation">
            <h2>{fantasy ? 'YOUR NEXT LAND TILE' : 'YOUR NEXT EARTH CELL'}</h2>
            {props.directory.capabilities.cellReservations ? (
              <>
                <p>{fantasy ? 'CHOOSE AN AVAILABLE TILE IN AN ORDINARY REALM. THE SERVER RESERVES YOUR LAND BEFORE SIGNING. GENESIS AND SEEKER ALLOCATIONS REMAIN RESERVED.' : 'CHOOSE A CLAIMABLE EARTH CELL BEFORE SIGNING, OR LEAVE IT OPEN FOR THE SERVER TO SECURELY CHOOSE AN AVAILABLE CELL.'}</p>
                {full && <p>ALL ACTIVE SLOTS ARE OCCUPIED. AN ADDITIONAL DEED STAYS INACTIVE UNTIL YOU REPLACE AN ACTIVE SLOT.</p>}
                {updateRequired && <p role="status">UPDATE THE GAME TO CHOOSE LAND IN THE FANTASY WORLD.</p>}
                <Btn variant="gold" onClick={props.onBuyDeed} disabled={props.busy || updateRequired}>BUY ANOTHER LAND DEED</Btn>
              </>
            ) : (
              <p>{fantasy ? 'LAND RESERVATION IS NOT AVAILABLE ON THIS SERVER.' : 'CELL RESERVATION IS NOT LIVE YET. A FUTURE PURCHASE WILL FREEZE YOUR CHOSEN CELL BEFORE SIGNING; IF OMITTED, THE SERVER CHOOSES AN AVAILABLE EARTH CELL SECURELY.'}</p>
            )}
          </aside>
        </main>
      )}
    </div>
  );
}

export default function BasesScreen(): React.JSX.Element {
  const directory = useApp((state) => state.baseDirectory);
  const selectedBaseId = useApp((state) => state.selectedBaseId);
  const setDirectory = useApp((state) => state.setBaseDirectory);
  const setScreen = useApp((state) => state.setScreen);
  const setLandPurchase = useApp((state) => state.setLandPurchase);
  const setMapTab = useApp((state) => state.setMapTab);
  const setWorldIntent = useApp((state) => state.setWorldIntent);
  const currentBase = useApp((state) => state.base);
  const [loading, setLoading] = useState(directory === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replaceBaseId, setReplaceBaseId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void api.get<BasesDto>('/bases').then((next) => {
      if (!live) return;
      setDirectory(next);
      const currentSelection = useApp.getState().selectedBaseId;
      if (currentSelection && resolveFreshBaseId(next, currentSelection) !== currentSelection) {
        clearBaseSnapshot();
        setError('The selected deed is no longer active or owned by this wallet.');
      } else setError(null);
    }).catch((cause: Error) => { if (live) setError(cause.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [reload, setDirectory]);

  const open = async (baseId: string): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const committed = await selectBaseSnapshot(baseId);
      if (!committed) return;
      setScreen('base');
      bus.emit('base:refresh', undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to open that base.');
    } finally { setBusy(false); }
  };

  const activate = async (baseId: string): Promise<void> => {
    if (!directory?.capabilities.baseScopedMutations) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/bases/${encodeURIComponent(baseId)}/activate`, replaceBaseId ? { replaceBaseId } : {});
      setReplaceBaseId(null);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to activate that deed.');
    } finally { setBusy(false); }
  };

  return <BasesView
    directory={directory} selectedBaseId={selectedBaseId} loading={loading} busy={busy} error={error}
    replaceBaseId={replaceBaseId} canClose={currentBase !== null}
    onClose={() => setScreen('base')} onRetry={() => setReload((value) => value + 1)}
    onOpen={(baseId) => { void open(baseId); }} onReplace={(baseId) => setReplaceBaseId(baseId || null)}
    onActivate={(baseId) => { void activate(baseId); }}
    onBuyDeed={() => {
      // A wallet that never bought its FIRST land must go through the entry
      // purchase — sending it into the add-a-base deed flow dead-ends on the
      // server's ENTRY_REQUIRED refusal (live-stuck report 2026-08-16). The
      // server stays authoritative either way; useEntry also falls back on
      // the 409 in case this client-side read is stale.
      const kind = directory?.nextLandPurchaseKind ?? (useApp.getState().entryPaid ? 'deed' as const : 'entry' as const);
      setLandPurchase({ kind, earthCell: null });
      if (fantasyDirectory(directory)) { setMapTab('world'); setWorldIntent('choose-land'); setScreen('map'); }
      else setScreen('entry');
    }}
  />;
}
