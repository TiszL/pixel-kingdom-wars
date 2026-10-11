/** Unmounted voyage presentation. Route snapshots, recovery, shared Seal and receipts belong to the host. */
import type { ReactNode } from 'react';
import { fmtDur } from '@shardkeep/shared';
import { PkCloseSquare, PkIconSquare, PkPrimaryButton, PkSecondaryButton } from '../Button';
import { PkIcon } from '../Icon';
import { PkSheetTitlePlate } from '../Plate';
import { commandDrawState, commandRoute, type CommandRoute } from '../kitLogic';
import type { CommandUi } from '../types';
import { collectable, islandCopy, islandTileState, orderTrips, passportSourceLine, rewardText, sealIntent, sendGate, vehicleCardState, vehicleCopy, type RouteGate, type SendGateUi, type VehicleGate } from './voyageLogic';
import { hasReceipt } from '../craft/receiptEvidence';
import './VoyageSheets.css';

/** Host-confirmed operation state. Generic transport errors never establish authoritative=true. */
export interface VoyageOperationUi { stage:'IDLE'|'ARMED'|'ERROR'|'CHECK_WALLET'|'SENDING'|'SENT'; authoritative:boolean }
export interface VoyageFrameUi { title: string; level: string | null; status: string; art: ReactNode; loading: boolean; error: string | null; operation?:VoyageOperationUi }
export interface VoyageActions {
  onClose: () => void; onHistory: () => void; onRetry: () => void; onCheckSaved: () => void;
  /** OPEN navigates to a review. Network cost and money consent exist only inside the shared Seal. */
  onCommand: (command: CommandUi, route: Exclude<CommandRoute, 'IGNORE'>) => void;
}
interface BaseProps { frame: VoyageFrameUi; actions: VoyageActions }
export interface VoyageVehicle extends VehicleGate { id: string; name: string; icon: string; tierLabel: string; tripsLabel: string; note: string }
export interface VoyageRoute extends RouteGate { name: string; realm: string; icon: string; gradeLabel: string; yieldLabel: string; durationSeconds: number | null; note: string }
export interface VoyageReward { id: string; name: string; icon: string; quantity: string | null }
export interface VoyageTrip { id: string; name: string; icon: string; vehicle: string; state: 'AT_SEA' | 'READY' | 'COLLECTING' | 'COLLECTED'; secondsLeft: number | null; returned: readonly VoyageReward[] | null; note: string }

function moveTab(event: React.KeyboardEvent<HTMLElement>, onTab: (id:string)=>void): void {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
  const current = tabs.indexOf(event.target as HTMLButtonElement);
  if (current < 0 || !tabs.length) return;
  event.preventDefault();
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  const target = tabs[index]!; target.focus(); onTab(target.dataset['tab']!);
}
function Tabs({ entries, selected, onTab }: { entries: readonly {id: string; label: string}[]; selected: string; onTab: (id: string) => void }): React.JSX.Element {
  return <nav className="pk-voyage__tabs" role="tablist" aria-label="Sheet sections" onKeyDown={event => moveTab(event,onTab)}>{entries.map(t => <button type="button" key={t.id} role="tab" data-tab={t.id} aria-selected={selected === t.id} tabIndex={selected === t.id ? 0 : -1} onClick={() => onTab(t.id)}>{t.label}</button>)}</nav>;
}
function Frame({ frame, actions, tabs, footer, children }: BaseProps & { tabs?: ReactNode; footer?: ReactNode; children: ReactNode }): React.JSX.Element {
  return <section className="pk-voyage" aria-label={frame.title} aria-busy={frame.loading}><header className="pk-voyage__header">
    <div className="pk-voyage__art" aria-hidden="true">{frame.art}</div><div className="pk-voyage__title"><PkSheetTitlePlate ui={{title:frame.title,titleTag:frame.level}} /></div>
    <div className="pk-voyage__tools"><PkIconSquare icon="replay" verb="STONE" contentDescription="Voyage history" onClick={actions.onHistory} /><PkCloseSquare onClick={actions.onClose} /></div><p className="pk-voyage__status">{frame.status}</p></header>
    {tabs}<div className="pk-voyage__scroll" role={tabs ? 'tabpanel' : undefined} tabIndex={0} aria-label={`${frame.title} contents`}>{frame.loading ? <p role="status">Checking…</p> : null}
      {frame.error ? <div className="pk-voyage__notice" role="status"><p>{frame.error}</p><PkSecondaryButton label="REFRESH" onClick={actions.onRetry} /></div> : null}{children}</div>
    {footer ? <footer className="pk-voyage__footer">{footer}</footer> : null}</section>;
}
function Command({ ui, pending, busy, actions, operation }: { ui: CommandUi; pending: boolean; busy: boolean; actions: VoyageActions; operation:VoyageOperationUi|null }): React.JSX.Element {
  const intent = operation ? sealIntent(operation.stage,operation.authoritative) : 'SHARED_SEAL';
  const checking = pending || intent === 'CHECK';
  const inert = !checking && (busy || intent === 'NONE');
  const act = () => { if (checking) { actions.onCheckSaved(); return; } if (inert) return; const route = commandRoute(ui); if (route !== 'IGNORE') actions.onCommand(ui, route); };
  return <PkPrimaryButton label={checking ? 'CHECK EARLIER REQUEST' : inert ? 'Being checked' : intent === 'RETRY' ? 'RETRY' : ui.caption} state={checking ? 'ENABLED' : inert ? 'BUSY' : commandDrawState(ui)}
    verb={checking || inert ? 'STONE' : ui.verb ?? 'GOLD'} reason={ui.reason} price={null} sub={checking || inert ? null : ui.sub ?? null} onClick={act} />;
}
function Rewards({ items }: { items: readonly VoyageReward[] }): React.JSX.Element {
  return <div className="pk-voyage__rewards">{items.map(r => <div key={r.id}><PkIcon name={r.icon} size={48} /><strong>{rewardText(r.quantity)}</strong><span>{r.name}</span></div>)}</div>;
}
function Vehicle({ vehicle, selected, grade, onChoose }: { vehicle: VoyageVehicle; selected: string | null; grade: number | null; onChoose: (id: string, state: string) => void }): React.JSX.Element {
  const state = vehicleCardState(vehicle, selected, grade); const available = state === 'ELIGIBLE' || state === 'SELECTED';
  return <button type="button" className="pk-voyage__vehicle" aria-pressed={state === 'SELECTED'} aria-disabled={!available} onClick={() => onChoose(vehicle.id, state)}>
    <span className="pk-voyage__well"><PkIcon name={vehicle.icon} size={64} /></span><strong>{vehicle.name}</strong><span>{vehicle.tierLabel}</span><span>{vehicle.tripsLabel}</span><span>{vehicle.note}</span>
    {!available ? <span>{vehicleCopy(state)}</span> : null}</button>;
}
export interface LodgeSendUi { gate: SendGateUi; route: VoyageRoute | null; vehicles: readonly VoyageVehicle[]; /** Deprecated adapter field; selection is derived from gate.vehicle.installationId. */ selectedInstallation: string | null; primary: CommandUi; supplies: readonly VoyageReward[]; mode: 'HOME' | 'PAID' | 'ADVANCED'; permitLine: string | null }
export function PkLodgeSendSheet({ frame, actions, ui, onTab, onChooseRoute, onVehicle, onSendIntent, onBerth }: BaseProps & {
  ui: LodgeSendUi; onTab: (id: string) => void; onChooseRoute: () => void; onVehicle: (id: string, state: string) => void;
  onSendIntent: (intent: 'EXPLAIN' | 'PERMIT' | 'SEND', reason: string | null) => void; onBerth: () => void;
}): React.JSX.Element {
  const phase = frame.operation ? sealIntent(frame.operation.stage,frame.operation.authoritative) : 'SHARED_SEAL';
  const normalGate = sendGate(ui.gate);
  const gate = normalGate.action === 'CHECK' ? normalGate : phase === 'CHECK' ? {action:'CHECK' as const,reason:'Your departure is being checked'} : phase === 'NONE' ? {action:'NONE' as const,reason:'Being checked'} : normalGate;
  const send = () => {
    if (gate.action === 'CHECK') { actions.onCheckSaved(); return; }
    if (gate.action === 'NONE') return;
    if (gate.action === 'EXPLAIN') { onSendIntent('EXPLAIN', gate.reason); return; }
    const route = commandRoute(ui.primary);
    if (route === 'OPEN') onSendIntent(gate.action, gate.reason);
    else if (route !== 'IGNORE') actions.onCommand(ui.primary, route);
  };
  return <Frame frame={frame} actions={actions} tabs={<Tabs entries={[{id:'SEND',label:'SEND'},{id:'UNDER_WAY',label:'TRIPS'},{id:'PASSPORT',label:'PASSPORT'}]} selected="SEND" onTab={onTab} />}
    footer={<PkPrimaryButton label={gate.action === 'CHECK' ? 'CHECK EARLIER DEPARTURE' : gate.action === 'NONE' ? gate.reason ?? 'Checking…' : ui.primary.caption}
      state={gate.action === 'NONE' ? 'BUSY' : gate.action === 'EXPLAIN' ? 'DISABLED' : gate.action === 'CHECK' ? 'ENABLED' : commandDrawState(ui.primary)} reason={gate.reason ?? ui.primary.reason} verb={gate.action === 'CHECK' ? 'STONE' : ui.primary.verb ?? 'GOLD'} sub={ui.permitLine} onClick={send} />}>
    <h2>Where shall we sail?</h2><button type="button" className="pk-voyage__route" onClick={onChooseRoute}>
      <span className="pk-voyage__well"><PkIcon name={ui.route?.icon ?? 'shape:anchor'} size={64} /></span><strong>{ui.route?.name ?? 'Choose an island'}</strong><span>{ui.route?.realm ?? 'The route chart'}</span>
      {ui.route ? <><span>{ui.route.gradeLabel} · {ui.route.durationSeconds === null ? '…' : fmtDur(ui.route.durationSeconds)}</span><span>{ui.route.yieldLabel}</span></> : null}<span>CHANGE</span></button>
    <h2>{ui.mode === 'ADVANCED' ? 'Your crafted vehicle' : 'Choose a vehicle'}</h2><div className="pk-voyage__fleet">{ui.vehicles.map(v => <Vehicle key={v.id} vehicle={v} selected={ui.gate.vehicle?.installationId ?? null} grade={ui.gate.routeGrade} onChoose={onVehicle} />)}</div>
    {!ui.vehicles.length ? <div className="pk-voyage__notice"><p>Install a vehicle at the Berth before sailing.</p><PkSecondaryButton label="GO TO BERTH" verb="BLUE" onClick={onBerth} /></div> : null}
    <h2>Supplies</h2><div className="pk-voyage__supplies">{ui.supplies.map(s => <div key={s.id}><PkIcon name={s.icon} size={32} /><span>{s.name}</span><strong>{s.quantity ?? '…'}</strong></div>)}</div>
    {ui.gate.preview?.supplies.filter(s => s.short).map(s => <p className="pk-voyage__notice" key={s.name}>{s.shortLine ?? `Need more ${s.name}`}</p>)}
    {ui.mode === 'PAID' ? <p>A permit is reviewed before this departure.</p> : null}{ui.route?.note ? <p>{ui.route.note}</p> : null}
  </Frame>;
}
export function PkRoutePickerSheet({ frame, actions, routes, tier, selected, filter, onFilter, onRoute }: BaseProps & {
  routes: readonly VoyageRoute[]; tier: number | null; selected: string | null; filter: string; onFilter: (id: string) => void; onRoute: (id: string, state: string) => void;
}): React.JSX.Element {
  return <Frame frame={frame} actions={actions} tabs={<Tabs entries={[{id:'ALL',label:'ALL'},{id:'CAN_SAIL',label:'CAN SAIL'},{id:'HOME',label:'HOME'}]} selected={filter} onTab={onFilter} />}>
    <h2>Choose an island</h2><div className="pk-voyage__routes">{routes.map(r => { const state = islandTileState(r, tier, selected); return <button type="button" className="pk-voyage__route" key={r.routeId} aria-pressed={state === 'SELECTED'}
      aria-disabled={state === 'LOCKED_TIER' || state === 'LOCKED_PERMIT'} onClick={() => onRoute(r.routeId, state)}><span className="pk-voyage__well"><PkIcon name={r.icon} size={64} /></span><strong>{r.name}</strong><span>{r.realm}</span><span>{r.gradeLabel}</span><span>{r.yieldLabel}</span><span>{islandCopy(state)}</span><span>{r.note}</span></button>; })}</div>
    {!routes.length ? <p>No routes in this view.</p> : null}</Frame>;
}
export function PkLodgeTripsSheet({ frame, actions, trips, primary, pending, onTab, onCollect, onTrip }: BaseProps & {
  trips: readonly VoyageTrip[]; primary: CommandUi | null; pending: boolean; onTab: (id: string) => void; onCollect: (id: string) => void; onTrip: (id: string) => void;
}): React.JSX.Element {
  const visible = orderTrips(trips);
  return <Frame frame={frame} actions={actions} tabs={<Tabs entries={[{id:'SEND',label:'SEND'},{id:'UNDER_WAY',label:'TRIPS'},{id:'PASSPORT',label:'PASSPORT'}]} selected="UNDER_WAY" onTab={onTab} />}
    footer={primary ? <Command operation={frame.operation ?? null} ui={primary} pending={pending} busy={trips.some(t => t.state === 'COLLECTING')} actions={actions} /> : null}>
    <h2>AT SEA AND BACK</h2>{visible.map(t => <article className="pk-voyage__trip" key={t.id}><div className="pk-voyage__trip-head"><span className="pk-voyage__well"><PkIcon name={t.icon} size={64} /></span><div><h3>{t.name}</h3><p>{t.vehicle}</p>
      <p>{t.state === 'READY' ? 'Back at the Lodge' : t.state === 'COLLECTING' ? 'Collection is being checked' : t.secondsLeft === null ? '…' : t.secondsLeft <= 0 ? 'Due back · checking' : fmtDur(t.secondsLeft)}</p></div></div><p>{t.note}</p>
      {t.state === 'READY' && t.returned !== null ? <Rewards items={t.returned} /> : null}<PkSecondaryButton label={collectable(t) ? 'COLLECT' : 'VIEW'} verb={collectable(t) ? 'GREEN' : 'BLUE'} enabled={!pending && t.state !== 'COLLECTING'} onClick={() => { if (collectable(t)) onCollect(t.id); else onTrip(t.id); }} /></article>)}
    {!visible.length ? <p>No voyages at sea. Choose where to sail next.</p> : null}</Frame>;
}
export interface PassportStamp { id: string; name: string; icon: string; count: string | null; reached: boolean }
export interface PassportEntry { id: string; when: string; destination: string; items: readonly VoyageReward[] }
export function PkPassportSheet({ frame, actions, sourceState, stamps, recent, onTab, onRecord }: BaseProps & {
  sourceState: string; stamps: readonly PassportStamp[]; recent: readonly PassportEntry[]; onTab: (id: string) => void; onRecord: (id: string) => void;
}): React.JSX.Element {
  const note = passportSourceLine(sourceState);
  return <Frame frame={frame} actions={actions} tabs={<Tabs entries={[{id:'SEND',label:'SEND'},{id:'UNDER_WAY',label:'TRIPS'},{id:'PASSPORT',label:'PASSPORT'}]} selected="PASSPORT" onTab={onTab} />}>
    <h2>Your passport</h2><p>A record of places reached.</p>{note ? <p className="pk-voyage__notice" role="status">{note}</p> : null}
    <div className="pk-voyage__stamps">{stamps.map(s => <div key={s.id} data-reached={s.reached}><PkIcon name={s.icon} size={48} /><strong>{s.name}</strong><span>{sourceState !== 'OK' ? '…' : s.reached ? s.count ?? '…' : 'not yet'}</span></div>)}</div>
    <h2>Recent voyages</h2>{sourceState === 'OK' ? recent.length ? recent.map(r => <article className="pk-voyage__trip" key={r.id}><h3>{r.destination}</h3><p>{r.when}</p><Rewards items={r.items} /><PkSecondaryButton label="RECORD" verb="BLUE" onClick={() => onRecord(r.id)} /></article>) : <p>No voyages recorded yet.</p> : <PkSecondaryButton label="CHECK RECORDS" onClick={actions.onRetry} />}
  </Frame>;
}
export interface ServiceOption { id: string; title: string; description: string; result: string; available: boolean; reason: string | null }
export function PkBerthSheet({ frame, actions, tab, vehicles, selected, service, selectedService, primary, pending, busy, onTab, onVehicle, onService, onInstall }: BaseProps & {
  tab: 'FLEET' | 'SERVICE'; vehicles: readonly VoyageVehicle[]; selected: string | null; service: readonly ServiceOption[]; selectedService: string | null; primary: CommandUi | null;
  pending: boolean; busy: boolean; onTab: (id: string) => void; onVehicle: (id: string, state: string) => void; onService: (id: string, available: boolean) => void; onInstall: () => void;
}): React.JSX.Element {
  return <Frame frame={frame} actions={actions} tabs={<Tabs entries={[{id:'FLEET',label:'FLEET'},{id:'SERVICE',label:'SERVICE'}]} selected={tab} onTab={onTab} />}
    footer={primary ? <Command operation={frame.operation ?? null} ui={primary} pending={pending} busy={busy} actions={actions} /> : null}>
    <h2>{tab === 'FLEET' ? 'At your Berth' : 'Ready for another journey'}</h2><div className="pk-voyage__fleet">{vehicles.map(v => <Vehicle key={v.id} vehicle={v} selected={selected} grade={null} onChoose={onVehicle} />)}</div>
    {!vehicles.length ? <div className="pk-voyage__notice"><p>Your Berth is waiting for its first vehicle.</p><PkSecondaryButton label="CHOOSE A VEHICLE" verb="BLUE" enabled={!pending && !busy} onClick={onInstall} /></div> : null}
    {tab === 'SERVICE' ? <div className="pk-voyage__services">{service.map(s => <button type="button" key={s.id} aria-pressed={selectedService === s.id} aria-disabled={!s.available} disabled={busy || pending} onClick={() => onService(s.id, s.available)}><strong>{s.title}</strong><span>{s.description}</span><span>{s.result}</span>{s.reason ? <span>{s.reason}</span> : null}</button>)}</div> : <p>Choose a vehicle to see what it can do next.</p>}
  </Frame>;
}
export function PkBerthInstallSheet({ frame, actions, walletVehicles, selected, primary, pending, busy, walletLinked, onChoose, onLinkWallet }: BaseProps & {
  walletVehicles: readonly VoyageVehicle[]; selected: string | null; primary: CommandUi; pending: boolean; busy: boolean; walletLinked: boolean; onChoose: (id: string) => void; onLinkWallet: () => void;
}): React.JSX.Element {
  return <Frame frame={frame} actions={actions} footer={<Command operation={frame.operation ?? null} ui={primary} pending={pending} busy={busy} actions={actions} />}><h2>Choose a wallet vehicle</h2>
    {!walletLinked ? <PkSecondaryButton label="LINK WALLET" verb="BLUE" onClick={onLinkWallet} /> : <div className="pk-voyage__fleet">{walletVehicles.map(v => <button className="pk-voyage__vehicle" key={v.id} type="button" aria-pressed={selected === v.id} disabled={pending || busy} onClick={() => onChoose(v.id)}>
      <span className="pk-voyage__well"><PkIcon name={v.icon} size={64} /></span><strong>{v.name}</strong><span>{v.tierLabel}</span><span>{v.tripsLabel}</span></button>)}</div>}
    {walletLinked && !walletVehicles.length ? <p>No available vehicles were found in this wallet.</p> : null}<p>Review the installation before confirming.</p></Frame>;
}
export function PkVoyageCollectionSheet({ frame, actions, state, receiptId, rewards, onDone, nextTrip }: BaseProps & {
  state: 'CHECKING' | 'COLLECTED' | 'FAILED'; receiptId: string | null; rewards: readonly VoyageReward[]; onDone: () => void;
  /** Navigation only: prepare another trip or open Berth; never repeat a departure directly. */
  nextTrip?: {kind:'SEND_AGAIN'|'BERTH';onOpen:()=>void}|null;
}): React.JSX.Element {
  const proven = state === 'COLLECTED' && hasReceipt(receiptId);
  return <Frame frame={proven ? frame : {...frame,status:'Your collection is being checked'}} actions={actions} footer={proven ? <><PkPrimaryButton label="OK" verb="GREEN" onClick={onDone} />{nextTrip ? <PkSecondaryButton label={nextTrip.kind === 'BERTH' ? 'GO TO BERTH' : 'SEND AGAIN'} verb="BLUE" onClick={nextTrip.onOpen} /> : null}</> : <PkPrimaryButton label="CHECK COLLECTION" verb="STONE" onClick={actions.onCheckSaved} />}>
    <h2>{proven ? 'EXPEDITION BACK' : 'Checking the collection'}</h2>{proven ? <><Rewards items={rewards} /><p>Added to your stores.</p></> : <p role="status">{state === 'FAILED' ? 'The collection could not be verified. Check the earlier request before collecting again.' : 'Your collection is being checked.'}</p>}
  </Frame>;
}
