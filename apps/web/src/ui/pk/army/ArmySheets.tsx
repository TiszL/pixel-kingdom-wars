/** Unmounted F2b presentation surfaces. Controllers own snapshots, reviews, receipts and navigation. */
import { useId, type ReactNode } from 'react';
import { fmtDur } from '@shardkeep/shared';
import { PkCloseSquare, PkIconSquare, PkPrimaryButton, PkSecondaryButton } from '../Button';
import { PkIcon } from '../Icon';
import { PkSheetTitlePlate } from '../Plate';
import { commandDrawState, type CommandRoute } from '../kitLogic';
import type { CommandUi } from '../types';
import { canAddTroop, commandTap, housingFractions, researchTap, revengeLook, scoutCommands, settlementRows, type HousingUi } from './armyLogic';
import { hasReceipt } from '../craft/receiptEvidence';
import './ArmySheets.css';

export interface ArmyFrameUi {
  title: string; level: string | null; status: string; loading: boolean; error: string | null;
  /** Native living-header composition or its reduced-motion idle frame. Never a replacement world. */
  art: ReactNode;
}
export interface ArmyRow { id: string; name: string; icon: string; detail: string; count: string | null }
export interface ArmyActions {
  onClose: () => void; onHistory: () => void; onRetry: () => void;
  /** OPEN navigates to the existing review/controller. It never directly spends or signs. */
  onCommand: (command: CommandUi, route: Exclude<CommandRoute, 'IGNORE'>) => void;
}
interface BaseProps { frame: ArmyFrameUi; actions: ArmyActions }
function Command({ ui, actions }: { ui: CommandUi; actions: ArmyActions }): React.JSX.Element {
  const act = () => { const route = commandTap(ui); if (route !== 'IGNORE') actions.onCommand(ui, route === 'RUN' ? 'OPEN' : route); };
  return <PkPrimaryButton label={ui.caption} state={commandDrawState(ui)} verb={ui.verb ?? 'GOLD'}
    reason={ui.reason} price={ui.price} sub={ui.sub ?? null} onClick={act} onPrice={act} />;
}
function moveTab(event: React.KeyboardEvent<HTMLElement>, onTab: (id:string)=>void): void {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
  const current = tabs.indexOf(event.target as HTMLButtonElement);
  if (current < 0 || !tabs.length) return;
  event.preventDefault();
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  const target = tabs[index]!; target.focus(); onTab(target.dataset['tab']!);
}
function Tabs({ labels, selected, onTab }: { labels: readonly string[]; selected: string; onTab: (id: string) => void }): React.JSX.Element {
  return <nav className="pk-army__tabs" role="tablist" aria-label="Sheet sections" onKeyDown={event => moveTab(event,onTab)}>{labels.map(id => <button key={id}
    type="button" role="tab" data-tab={id} aria-selected={selected === id} tabIndex={selected === id ? 0 : -1} onClick={() => onTab(id)}>{id}</button>)}</nav>;
}
function Frame({ frame, actions, tabs, footer, children }: BaseProps & { tabs?: ReactNode; footer?: ReactNode; children: ReactNode }): React.JSX.Element {
  const id = useId();
  return <section className="pk-army" aria-label={frame.title} aria-busy={frame.loading}>
    <header className="pk-army__header"><div className="pk-army__art" aria-hidden="true">{frame.art}</div>
      <div className="pk-army__title"><PkSheetTitlePlate ui={{title: frame.title, titleTag: frame.level}} /></div>
      <div className="pk-army__tools"><PkIconSquare icon="replay" verb="STONE" contentDescription="Battle history" onClick={actions.onHistory} /><PkCloseSquare onClick={actions.onClose} /></div>
      <p className="pk-army__status">{frame.status}</p></header>
    {tabs}<div className="pk-army__scroll" role={tabs ? 'tabpanel' : undefined} id={id} tabIndex={0} aria-label={`${frame.title} contents`}>
      {frame.error ? <div className="pk-army__notice" role="status"><p>{frame.error}</p><PkSecondaryButton label="REFRESH" onClick={actions.onRetry} /></div> : null}
      {frame.loading ? <p role="status">Checking…</p> : null}{children}</div>
    {footer ? <footer className="pk-army__footer">{footer}</footer> : null}
  </section>;
}
function Row({ ui, children }: { ui: ArmyRow; children?: ReactNode }): React.JSX.Element {
  return <article className="pk-army__row"><PkIcon name={ui.icon} size={48} /><div><h3>{ui.name}</h3><p>{ui.detail}</p></div>
    <strong>{ui.count ?? '…'}</strong>{children}</article>;
}
export function PkHousingMeter({ ui, showDraft = true }: { ui: HousingUi; showDraft?: boolean }): React.JSX.Element {
  const fill = housingFractions(ui, showDraft);
  const label = ui.known ? `${ui.ready} ready · ${ui.training} training${showDraft ? ` · ${ui.draft} chosen` : ''} · capacity ${ui.capacity}` : 'Housing is being checked';
  return <div className="pk-army__housing"><p>{ui.known ? <>{ui.ready + ui.training}{showDraft && ui.draft > 0 ? <span className="pk-army__chosen">+{ui.draft}</span> : null} / {ui.capacity}</> : '… / …'}</p>
    <div className="pk-army__meter" role="img" aria-label={label}><i style={{width: `${fill.ready * 100}%`}} /><i style={{width: `${fill.training * 100}%`}} /><i style={{width: `${fill.draft * 100}%`}} /></div>
    <p>{ui.known ? `${ui.ready} ready · ${ui.training} training${showDraft ? ` · ${ui.draft} chosen` : ''}` : 'Housing is being checked'}{ui.full ? <span className="pk-army__full"> · full</span> : null}</p>
    {ui.full ? <p className="pk-army__notice">Camp and queue are full. FINISH or raid.</p> : null}</div>;
}
export interface TrainTroop extends ArmyRow { points: number; draft: number; state: 'AVAILABLE' | 'SHORT' | 'LOCKED' | 'BUSY'; reason: string | null }
export function PkTrainSheet({ frame, actions, housing, troops, queue, primary, onTab, onTroop, onRemove }: BaseProps & {
  housing: HousingUi; troops: readonly TrainTroop[]; queue: readonly ArmyRow[]; primary: CommandUi;
  onTab: (id: string) => void; onTroop: (id: string, intent: 'ADD' | 'NEED_MORE' | 'LOCKED' | 'NO_ROOM' | 'CHECKING') => void; onRemove: (id: string) => void;
}): React.JSX.Element {
  const sending = primary.state === 'BUSY';
  return <Frame frame={frame} actions={actions} tabs={<Tabs labels={['TRAIN', 'ARMY']} selected="TRAIN" onTab={onTab} />} footer={<Command ui={primary} actions={actions} />}>
    <PkHousingMeter ui={housing} /><h2>Choose your troops</h2><div className="pk-army__grid">{troops.map(t => <article className="pk-army__troop" key={t.id}>
      <button type="button" disabled={sending || t.state === 'BUSY'} aria-label={`${t.name}. ${t.count ?? 'Count being checked'} ready. ${t.draft} chosen. ${t.reason ?? t.detail}. Add to draft`}
        onClick={() => onTroop(t.id, t.state === 'LOCKED' ? 'LOCKED' : t.state === 'SHORT' ? 'NEED_MORE' : !housing.known ? 'CHECKING' : canAddTroop(housing, t.points) ? 'ADD' : 'NO_ROOM')}>
        <PkIcon name={t.icon} size={64} /><strong>{t.name}</strong><span>{t.detail}</span><span>{t.count ?? '…'}</span>{t.reason ? <span>{t.reason}</span> : null}</button>
      {t.draft > 0 ? <div className="pk-army__draft"><span>Draft ×{t.draft}</span><button type="button" disabled={sending} aria-label={`Remove one ${t.name}`} onClick={() => onRemove(t.id)}>−</button></div> : null}</article>)}</div>
    <h2>Training queue</h2>{queue.length ? queue.map(q => <Row key={q.id} ui={q} />) : <p>No troops training.</p>}
  </Frame>;
}
export function PkArmyOverviewSheet({ frame, actions, housing, troops, heroes, primary, onTab, onInspect }: BaseProps & {
  housing: HousingUi; troops: readonly ArmyRow[]; heroes: readonly ArmyRow[]; primary: CommandUi; onTab: (id: string) => void; onInspect: (id: string) => void;
}): React.JSX.Element {
  return <Frame frame={frame} actions={actions} tabs={<Tabs labels={['TRAIN', 'ARMY']} selected="ARMY" onTab={onTab} />} footer={<Command ui={primary} actions={actions} />}>
    <PkHousingMeter ui={housing} showDraft={false} /><h2>Ready for battle</h2>{troops.length ? troops.map(t => <Row key={t.id} ui={t}><PkSecondaryButton label="INFO" verb="BLUE" onClick={() => onInspect(t.id)} /></Row>) : <p>Your army is waiting to be trained.</p>}
    <h2>Heroes</h2>{heroes.map(h => <Row key={h.id} ui={h}><PkSecondaryButton label="HERO" verb="BLUE" onClick={() => onInspect(h.id)} /></Row>)}
  </Frame>;
}
export interface ResearchRow extends ArmyRow { state: string; reason: string | null }
export function PkResearchSheet({ frame, actions, cards, selected, labBusy, remainingSeconds, progressLabel, primary, onResearch }: BaseProps & {
  cards: readonly ResearchRow[]; selected: string | null; labBusy: boolean; remainingSeconds: number | null; progressLabel: string;
  primary: CommandUi; onResearch: (id: string, intent: string) => void;
}): React.JSX.Element {
  return <Frame frame={frame} actions={actions} footer={<Command ui={primary} actions={actions} />}>
    {labBusy ? <div className="pk-army__notice" role="status"><h2>Research in progress</h2><p>{progressLabel}</p><p>{remainingSeconds === null ? '…' : fmtDur(remainingSeconds)}</p></div> : <h2>Choose a research</h2>}
    <div className="pk-army__grid">{cards.map(c => <button className="pk-army__choice" type="button" key={c.id} aria-pressed={selected === c.id}
      onClick={() => { const intent = researchTap(c.state, labBusy); if (intent !== 'NONE') onResearch(c.id, intent); }}>
      <PkIcon name={c.icon} size={64} /><strong>{c.name}</strong><span>{c.detail}</span><span>{c.count ?? '…'}</span>{c.reason ? <span>{c.reason}</span> : null}</button>)}</div>
  </Frame>;
}
export interface HeroDetail { portrait: string; name: string; description: string; health: string; stats: readonly ArmyRow[]; skills: readonly ArmyRow[]; gear: readonly ArmyRow[]; awaken: string }
export function PkHeroesSheet({ frame, actions, hero, tab, primary, onTab, onSwitchHero, onInspect }: BaseProps & {
  hero: HeroDetail; tab: 'HERO' | 'SKILLS' | 'GEAR'; primary: CommandUi; onTab: (id: string) => void; onSwitchHero: () => void; onInspect: (id: string) => void;
}): React.JSX.Element {
  const rows = tab === 'HERO' ? hero.stats : tab === 'SKILLS' ? hero.skills : hero.gear;
  return <Frame frame={frame} actions={actions} tabs={<Tabs labels={['HERO', 'SKILLS', 'GEAR']} selected={tab} onTab={onTab} />} footer={<Command ui={primary} actions={actions} />}>
    <div className="pk-army__hero"><PkIcon name={hero.portrait} size={96} /><div><h2>{hero.name}</h2><p>{hero.description}</p><p>{hero.health}</p></div><PkSecondaryButton label="SWITCH" onClick={onSwitchHero} /></div>
    {tab === 'GEAR' ? <p className="pk-army__notice">{hero.awaken}</p> : null}
    {rows.map(r => <Row ui={r} key={r.id}><PkSecondaryButton label="INFO" verb="BLUE" onClick={() => onInspect(r.id)} /></Row>)}
    {!rows.length ? <p>{tab === 'GEAR' ? 'No gear equipped.' : 'Details are being checked.'}</p> : null}
  </Frame>;
}
export interface RevengeRow extends ArmyRow { state: string; action: string; gate: string | null; unavailableNote: string | null }
export interface CampaignStage extends ArmyRow { locked: boolean; selected: boolean }
export function PkRaidChooserSheet({ frame, actions, tab, summary, stages, revenge, primary, onTab, onStage, onRevenge }: BaseProps & {
  tab: 'MATCH' | 'CAMPAIGN' | 'REVENGE'; summary: readonly string[]; stages: readonly CampaignStage[]; revenge: readonly RevengeRow[]; primary: CommandUi;
  onTab: (id: string) => void; onStage: (id: string, locked: boolean) => void; onRevenge: (id: string, intent: string) => void;
}): React.JSX.Element {
  return <Frame frame={frame} actions={actions} tabs={<Tabs labels={['MATCH', 'CAMPAIGN', 'REVENGE']} selected={tab} onTab={onTab} />} footer={<Command ui={primary} actions={actions} />}>
    {summary.map((s, i) => <p key={i}>{s}</p>)}
    {tab === 'MATCH' ? <div className="pk-army__notice"><h2>Find a rival</h2><p>Scout the base, then choose whether to attack.</p></div> : null}
    {tab === 'CAMPAIGN' ? <div className="pk-army__campaign">{stages.map(s => <button type="button" className="pk-army__choice" key={s.id} aria-pressed={s.selected} aria-disabled={s.locked} onClick={() => onStage(s.id, s.locked)}><PkIcon name={s.icon} size={48} /><strong>{s.name}</strong><span>{s.detail}</span><span>{s.count ?? '…'}</span></button>)}</div> : null}
    {tab === 'REVENGE' ? revenge.length ? revenge.map(r => { const look = revengeLook(r.state, r.action, r.name, r.gate, r.unavailableNote); return <Row key={r.id} ui={r}>
      <div><PkSecondaryButton label={look.label} verb={look.kind === 'REVENGE' ? 'RED' : 'STONE'} enabled={look.kind !== 'BUSY' && look.kind !== 'ANSWERED'} onClick={() => onRevenge(r.id, look.kind)} />{look.note ? <p>{look.note}</p> : null}</div></Row>; }) : <p>No unanswered raids.</p> : null}
  </Frame>;
}
export function PkBattleLogSheet({ frame, actions, entries, tab, onTab, onReplay, onRevenge }: BaseProps & {
  entries: readonly (ArmyRow & { replay: boolean; revenge: RevengeRow | null })[]; tab: 'ATTACKS' | 'DEFENCES'; onTab: (id: string) => void;
  onReplay: (id: string) => void; onRevenge: (id: string, intent: string) => void;
}): React.JSX.Element {
  return <Frame frame={frame} actions={actions} tabs={<Tabs labels={['ATTACKS', 'DEFENCES']} selected={tab} onTab={onTab} />}>
    {entries.length ? entries.map(e => <Row key={e.id} ui={e}><div className="pk-army__row-actions">{e.replay ? <PkSecondaryButton label="REPLAY" verb="BLUE" onClick={() => onReplay(e.id)} /> : null}
      {e.revenge ? (() => { const r = e.revenge; const look = revengeLook(r.state, r.action, r.name, r.gate, r.unavailableNote); return <><PkSecondaryButton label={look.label} verb={look.kind === 'REVENGE' ? 'RED' : 'STONE'} enabled={look.kind !== 'BUSY' && look.kind !== 'ANSWERED'} onClick={() => onRevenge(e.id, look.kind)} />{look.note ? <p>{look.note}</p> : null}</>; })() : null}</div></Row>) : <p>No battles recorded yet.</p>}
  </Frame>;
}
/** Place over the existing opponent world. No travel timer or local attack executor. */
export function PkScoutSheet({ target, source, loot, home, skip, attack, actions }: {
  target: string; source: 'MATCH' | 'MAP' | 'CAMPAIGN' | 'REVENGE'; loot: readonly ArmyRow[];
  home: CommandUi; skip: CommandUi | null; attack: CommandUi; actions: ArmyActions;
}): React.JSX.Element {
  const commands = scoutCommands(source, home, skip, attack);
  return <section className="pk-army-scout" aria-label={`Scout ${target}`}><div className="pk-army-scout__intel"><h2>{target}</h2><h3>Available loot</h3>{loot.map(r => <Row ui={r} key={r.id} />)}</div>
    <nav className="pk-army-scout__actions" aria-label="Scout actions">{commands.map(c => <Command key={c.id} ui={c} actions={actions} />)}</nav></section>;
}
/** The only clock-shaped duration is the caller's existing in-battle m:ss clock. onRetreat opens the host confirmation. */
export function PkBattleHud({ clock, status, units, selected, onSelect, onRetreat }: {
  clock: string; status: string; units: readonly ArmyRow[]; selected: string | null; onSelect: (id: string) => void; onRetreat: () => void;
}): React.JSX.Element {
  return <section className="pk-army-battle" aria-label="Battle controls"><div className="pk-army-battle__top"><PkSecondaryButton label="RETREAT" verb="RED" onClick={onRetreat} /><p role="timer" aria-label={`Battle time ${clock}`}>{clock}</p><p>{status}</p></div>
    <nav className="pk-army-battle__units" aria-label="Select deployment unit">{units.map(u => <button type="button" key={u.id} aria-pressed={selected === u.id} onClick={() => onSelect(u.id)}><PkIcon name={u.icon} size={48} /><strong>{u.name}</strong><span>{u.count ?? '…'}</span></button>)}</nav></section>;
}
export function PkBattleResultSheet({ frame, actions, outcome, outcomeKind, settlement, receiptId, rewards, losses, medals, primary }: BaseProps & {
  outcome: string; outcomeKind: 'VICTORY' | 'DEFEAT' | 'DRAW'; settlement: 'PENDING' | 'SETTLED' | 'REDACTED' | 'FAILED'; receiptId: string | null;
  rewards: readonly ArmyRow[]; losses: readonly ArmyRow[]; medals: string; primary: CommandUi;
}): React.JSX.Element {
  const proven = settlement === 'SETTLED' && hasReceipt(receiptId);
  const note = settlement === 'REDACTED' ? 'Battle details are hidden.' : settlement === 'FAILED' ? 'The result could not be verified. Check battle history.' : 'The result is being checked.';
  const paid = settlementRows(proven ? 'SETTLED' : 'PENDING', rewards);
  return <Frame frame={proven ? frame : {...frame,status:note}} actions={actions} footer={<Command ui={primary} actions={actions} />}>
    {proven ? <><h2 className="pk-army__result" data-outcome={outcomeKind.toLowerCase()}>{outcome}</h2><p>{medals}</p>
      <h2>Loot</h2>{paid.map(r => <Row key={r.id} ui={r} />)}<h2>Army after battle</h2>{losses.map(r => <Row key={r.id} ui={r} />)}</> : <p role="status">{note}</p>}
  </Frame>;
}
