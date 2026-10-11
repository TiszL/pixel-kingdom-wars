/** Props-only F2b craft artifacts. No transport, fee calculation, optimistic receipt or wallet call. */
import type { ReactNode } from 'react';
import { fmtDur } from '@shardkeep/shared';
import { PkCloseSquare, PkIconSquare, PkPrimaryButton, PkSecondaryButton } from '../Button';
import { PkIcon } from '../Icon';
import { PkSheetTitlePlate } from '../Plate';
import { commandDrawState, commandRoute, type CommandRoute } from '../kitLogic';
import type { CommandUi } from '../types';
import { collectionAction, craftGate, ingredientState, ingotCastMax, marketOrderCopy, marketTabs, stepQuantity, submitNotice, workshopTabs, type CollectionUi } from './craftLogic';
import { hasReceipt } from './receiptEvidence';
import './CraftSheets.css';

export interface CraftFrameUi {
  title: string; level: string | null; status: string; art: ReactNode;
  hydration: 'READY' | 'LOADING' | 'ERROR'; error: string | null;
  submit: 'IDLE' | 'SENDING' | 'CHECKING' | 'REFUSED'; authoritativeRefusal: string | null; savedRequest: boolean;
}
export interface CraftActions {
  onClose: () => void; onHistory: () => void; onRetry: () => void; onCheckSaved: () => void;
  /** OPEN only opens the existing review/controller; confirmation is a separate shared Seal. */
  onCommand: (command: CommandUi, route: Exclude<CommandRoute, 'IGNORE'>) => void;
}
interface BaseProps { frame: CraftFrameUi; actions: CraftActions }
export interface CraftItem { id: string; name: string; icon: string; detail: string; amount: string | null; tag: string | null }
/** need is the total required for the selected quantity from the server quote, never a locally multiplied unit cost. */
export interface CraftIngredient { id: string; name: string; icon: string; source: string; have: number | bigint | null; need: number | bigint }
export interface CraftRecipe extends CraftItem { secondsEach: number | null; ingredients: readonly CraftIngredient[]; quantity: number; minimum: number; maximum: number | null; reason: string | null }
export interface CraftJob extends CollectionUi { name: string; icon: string; quantity: string | null; secondsLeft: number | null; statusLabel: string }

function moveTab(event: React.KeyboardEvent<HTMLElement>, onTab: (id:string)=>void): void {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
  const current = tabs.indexOf(event.target as HTMLButtonElement);
  if (current < 0 || !tabs.length) return;
  event.preventDefault();
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  const target = tabs[index]!; target.focus(); onTab(target.dataset['tab']!);
}
function Tabs({ entries, selected, onTab, disabled = false }: { entries: readonly {id: string; label: string}[]; selected: string; onTab: (id: string) => void; disabled?: boolean }): React.JSX.Element {
  return <nav className="pk-craft__tabs" role="tablist" aria-label="Sheet sections" onKeyDown={event => moveTab(event,onTab)}>{entries.map(t => <button type="button" key={t.id} disabled={disabled} role="tab" data-tab={t.id} aria-selected={selected === t.id} tabIndex={selected === t.id ? 0 : -1} onClick={() => onTab(t.id)}>{t.label}</button>)}</nav>;
}
function Primary({ ui, frame, actions }: BaseProps & { ui: CommandUi }): React.JSX.Element {
  const gate = craftGate(frame.hydration, frame.submit, frame.savedRequest);
  const act = () => {
    if (gate?.action === 'NONE') return;
    if (gate?.action === 'CHECK') { actions.onCheckSaved(); return; }
    if (gate?.action === 'RETRY') { actions.onRetry(); return; }
    const route = commandRoute(ui); if (route !== 'IGNORE') actions.onCommand(ui, route);
  };
  return <PkPrimaryButton label={gate?.label ?? ui.caption} state={gate ? gate.action === 'NONE' ? 'BUSY' : 'ENABLED' : commandDrawState(ui)}
    verb={gate ? 'STONE' : ui.verb ?? 'GOLD'} price={gate ? null : ui.price} sub={gate ? null : ui.sub ?? null} reason={ui.reason} onClick={act} onPrice={act} />;
}
function Frame({ frame, actions, tabs, primary, children, showHistory = true }: BaseProps & { tabs: ReactNode; primary: CommandUi | null; children: ReactNode; showHistory?: boolean }): React.JSX.Element {
  const notice = submitNotice(frame.submit, frame.authoritativeRefusal);
  return <section className="pk-craft" aria-label={frame.title} aria-busy={frame.hydration === 'LOADING' || frame.submit === 'SENDING'}>
    <header className="pk-craft__header"><div className="pk-craft__art" aria-hidden="true">{frame.art}</div><div className="pk-craft__title"><PkSheetTitlePlate ui={{title:frame.title,titleTag:frame.level}} /></div>
      <div className="pk-craft__tools">{showHistory ? <PkIconSquare icon="replay" verb="STONE" contentDescription="History" onClick={actions.onHistory} /> : null}<PkCloseSquare onClick={actions.onClose} /></div><p className="pk-craft__status">{frame.status}</p></header>
    {tabs}<div className="pk-craft__scroll" role={tabs ? 'tabpanel' : undefined} tabIndex={0} aria-label={`${frame.title} contents`}>
      {frame.hydration === 'LOADING' ? <p role="status">Checking…</p> : null}
      {frame.error ? <div className="pk-craft__notice" role="status"><p>{frame.error}</p><PkSecondaryButton label="REFRESH" onClick={actions.onRetry} /></div> : null}
      {notice ? <p className="pk-craft__notice" role="status">{notice}</p> : null}
      {frame.savedRequest ? <div className="pk-craft__notice" role="status"><p>A request from earlier is waiting.</p><p>Check it before starting another.</p><PkSecondaryButton label="CHECK" enabled={frame.submit !== 'SENDING' && frame.submit !== 'CHECKING'} onClick={actions.onCheckSaved} /></div> : null}{children}</div>
    {primary ? <footer className="pk-craft__footer"><Primary frame={frame} actions={actions} ui={primary} /></footer> : null}
  </section>;
}
function Item({ ui, children }: { ui: CraftItem; children?: ReactNode }): React.JSX.Element {
  return <article className="pk-craft__item"><div className="pk-craft__well"><PkIcon name={ui.icon} size={64} /></div><div><h3>{ui.name}</h3><p>{ui.detail}</p>{ui.tag ? <span className="pk-craft__tag">{ui.tag}</span> : null}</div><strong>{ui.amount ?? '…'}</strong>{children}</article>;
}
function Ingredients({ items, onSource }: { items: readonly CraftIngredient[]; onSource: (id: string) => void }): React.JSX.Element {
  return <div className="pk-craft__ingredients">{items.map(item => { const look = ingredientState(item.have, item.need); return <article key={item.id} className="pk-craft__ingredient" data-short={look.short}>
    <PkIcon name={item.icon} size={32} /><div><h3>{item.name}</h3><p>{item.source}</p></div><span role="img" aria-label={`${item.name}, have and need ${look.count}`}><strong>{look.count}</strong></span>
    {look.short ? <PkSecondaryButton label="GO" verb="BLUE" onClick={() => onSource(item.id)} /> : <span>{look.ok ? 'OK' : '…'}</span>}</article>; })}</div>;
}
function Job({ job, onCollection }: { job: CraftJob; onCollection: (id: string, action: 'MARK_SEEN' | 'REVIEW_COLLECTION' | 'CELEBRATE') => void }): React.JSX.Element {
  const action = collectionAction(job);
  if (job.mode === 'SERVER' && job.state === 'DELIVERED' && !hasReceipt(job.receiptId)) return <p className="pk-craft__notice" role="status">The collection is being checked.</p>;
  return <article className="pk-craft__job"><PkIcon name={job.icon} size={64} /><div><h3>{job.name}</h3><strong>{job.quantity ?? '…'}</strong><p>{job.statusLabel}</p>
    {job.state === 'WORKING' ? <p>{job.secondsLeft === null ? '…' : job.secondsLeft <= 0 ? 'Finishing · checking' : fmtDur(job.secondsLeft)}</p> : null}</div>
    {action !== 'NONE' ? <PkSecondaryButton label={action === 'MARK_SEEN' ? 'GOT IT' : action === 'CELEBRATE' ? 'VIEW RECEIPT' : 'COLLECT'} verb={action === 'MARK_SEEN' ? 'STONE' : 'GREEN'} onClick={() => onCollection(job.id, action)} /> : null}</article>;
}
export function PkWorkshopSheet({ frame, actions, tab, recipes, selectedRecipe, job, primary, onTab, onRecipe, onQuantity, onSource, onCollection, ingotLimits, children }: BaseProps & {
  children?: ReactNode;
  ingotLimits?: {batch:number|null;daily:number|null;holding:number|null};
  tab: 'REFINE' | 'INGOTS' | 'EQUIPMENT' | 'COSMETICS'; recipes: readonly CraftItem[]; selectedRecipe: CraftRecipe | null; job: CraftJob | null; primary: CommandUi;
  onTab: (id: string) => void; onRecipe: (id: string) => void; onQuantity: (quantity: number) => void; onSource: (id: string) => void;
  onCollection: (id: string, action: 'MARK_SEEN' | 'REVIEW_COLLECTION' | 'CELEBRATE') => void;
}): React.JSX.Element {
  const locked = frame.submit === 'SENDING' || frame.submit === 'CHECKING' || frame.savedRequest;
  const r = selectedRecipe;
  const maximum = tab === 'INGOTS' ? ingotCastMax(ingotLimits?.batch ?? null, ingotLimits?.daily ?? null, ingotLimits?.holding ?? null) : r?.maximum ?? null;
  return <Frame frame={frame} actions={actions} tabs={<Tabs entries={workshopTabs} selected={tab} onTab={onTab} disabled={locked} />} primary={primary}>
    <h2>{tab === 'REFINE' ? 'At the workbench' : tab === 'INGOTS' ? 'At the forge' : tab === 'EQUIPMENT' ? 'Make something useful' : 'Made for your kingdom'}</h2>
    <nav className="pk-craft__strip" aria-label="Choose recipe">{recipes.map(i => <button type="button" key={i.id} data-recipe-id={i.id} disabled={locked} aria-pressed={r?.id === i.id} onClick={() => onRecipe(i.id)}><PkIcon name={i.icon} size={48} /><strong>{i.name}</strong><span>{i.amount ?? '…'}</span></button>)}</nav>
    {job ? <Job job={job} onCollection={onCollection} /> : null}
    {r ? <><Item ui={r} /><p className="pk-craft__duration">{r.secondsEach === null ? '…' : fmtDur(r.secondsEach)} each</p><Ingredients items={r.ingredients} onSource={onSource} />
      {tab !== 'EQUIPMENT' ? <div className="pk-craft__quantity" role="group" aria-label="Batch quantity"><button type="button" aria-label="Decrease quantity" disabled={locked || r.quantity <= r.minimum || maximum === null} onClick={() => { if (maximum !== null) onQuantity(stepQuantity(r.quantity, -1, r.minimum, maximum)); }}>−</button>
        <output aria-live="polite"><strong>{r.quantity}</strong><span>max {maximum ?? '…'}</span></output>
        <button type="button" aria-label="Increase quantity" disabled={locked || maximum === null || r.quantity >= maximum} onClick={() => { if (maximum !== null) onQuantity(stepQuantity(r.quantity, 1, r.minimum, maximum)); }}>+</button></div> : null}{r.reason ? <p className="pk-craft__notice">{r.reason}</p> : null}</> : <p>{frame.hydration === 'LOADING' ? 'Checking recipes…' : 'Choose a recipe to see what it needs.'}</p>}
    {children}
  </Frame>;
}
export interface MarketOrder extends CraftItem { status: 'OPEN' | 'SOLD' | 'WITHDRAWING' | 'CLOSED' | 'CHECKING'; proceeds: string | null }
export function PkMarketSheet({ frame, actions, tab, section, items, selected, orders, owned, primary, listingNote, onTab, onSection, onChoose, onOffer, onOwned }: BaseProps & {
  tab: 'BUY' | 'SELL' | 'MY ORDERS' | 'COLLECTION'; section: 'KEEP' | 'SOL'; items: readonly CraftItem[]; selected: string | null; orders: readonly MarketOrder[];
  owned: readonly CraftItem[]; primary: CommandUi | null; listingNote: string | null; onTab: (id: string) => void; onSection: (id: 'KEEP' | 'SOL') => void;
  onChoose: (id: string) => void; onOffer: (id: string, intent: 'VIEW' | 'REVIEW_WITHDRAW' | 'CHECK') => void; onOwned: (id: string) => void;
}): React.JSX.Element {
  const selecting = frame.submit === 'SENDING' || frame.submit === 'CHECKING';
  return <Frame frame={frame} actions={actions} tabs={<Tabs entries={marketTabs} selected={tab} onTab={onTab} disabled={selecting} />} primary={primary}>
    {tab === 'BUY' ? <nav className="pk-craft__filters" aria-label="Market stalls">{(['KEEP','SOL'] as const).map(s => <button type="button" key={s} disabled={selecting} aria-pressed={section === s} onClick={() => onSection(s)}>{s} STALL</button>)}</nav> : null}
    {tab === 'BUY' || tab === 'SELL' ? <><h2>{tab === 'SELL' ? 'Set out your goods' : 'Browse the stall'}</h2><div className="pk-craft__goods">{items.map(i => <button className="pk-craft__goods-choice" key={i.id} type="button" disabled={selecting} aria-pressed={selected === i.id} onClick={() => onChoose(i.id)}>
      <PkIcon name={i.icon} size={64} /><strong>{i.name}</strong><span>{i.detail}</span><span>{i.amount ?? '…'}</span>{i.tag ? <span>{i.tag}</span> : null}</button>)}</div>{listingNote ? <p className="pk-craft__notice">{listingNote}</p> : null}</> : null}
    {tab === 'MY ORDERS' ? <><h2>Your stall</h2>{orders.length ? orders.map(o => <Item key={o.id} ui={o}><div><p>{o.status === 'SOLD' ? o.proceeds ?? 'Proceeds are being checked' : marketOrderCopy(o.status)}</p>
      <PkSecondaryButton label={o.status === 'OPEN' ? 'TAKE BACK' : o.status === 'CHECKING' ? 'CHECK' : 'VIEW'} enabled={o.status !== 'WITHDRAWING'} onClick={() => onOffer(o.id, o.status === 'OPEN' ? 'REVIEW_WITHDRAW' : o.status === 'CHECKING' ? 'CHECK' : 'VIEW')} /></div></Item>) : <p>Your stall is empty.</p>}</> : null}
    {tab === 'COLLECTION' ? <><h2>In your stores</h2>{owned.length ? owned.map(i => <Item key={i.id} ui={i}><PkSecondaryButton label="INFO" verb="BLUE" onClick={() => onOwned(i.id)} /></Item>) : <p>Nothing in your stores yet.</p>}</> : null}
  </Frame>;
}
export interface HarvestReceipt { id: string; when: string; source: string; items: readonly CraftItem[]; state: 'VERIFIED' | 'CHECKING' | 'UNAVAILABLE' }
export function PkHarvesterSheet({ frame, actions, tab, yieldItems, job, history, primary, onTab, onCollection, onReceipt }: BaseProps & {
  tab: 'YIELD' | 'HISTORY'; yieldItems: readonly CraftItem[]; job: CraftJob | null; history: readonly HarvestReceipt[]; primary: CommandUi | null;
  onTab: (id: string) => void; onCollection: (id: string, action: 'MARK_SEEN' | 'REVIEW_COLLECTION' | 'CELEBRATE') => void; onReceipt: (id: string) => void;
}): React.JSX.Element {
  const delivered = job?.state === 'DELIVERED';
  const proven = delivered && (job.mode === 'AUTO' || hasReceipt(job.receiptId));
  return <Frame frame={delivered && !proven ? {...frame,status:'The collection is being checked'} : frame} actions={actions} showHistory={false} tabs={<Tabs entries={[{id:'YIELD',label:'YIELD'},{id:'HISTORY',label:'HISTORY'}]} selected={tab} onTab={onTab} />} primary={primary}>
    {tab === 'YIELD' ? <><h2>{proven ? 'Your haul arrived' : 'Gathering for your kingdom'}</h2>{job ? <Job job={job} onCollection={onCollection} /> : null}
      {!delivered || proven ? yieldItems.map(i => <Item key={i.id} ui={i} />) : null}{!yieldItems.length ? <p>The next haul is being checked.</p> : null}</> : <><h2>Past hauls</h2>{history.length ? history.map(h => <article className="pk-craft__receipt" key={h.id}><h3>{h.when}</h3><p>{h.source}</p>
        {h.state === 'VERIFIED' ? h.items.map(i => <Item key={i.id} ui={i} />) : <p>{h.state === 'CHECKING' ? 'This haul is being checked.' : 'This haul could not be verified.'}</p>}
        <PkSecondaryButton label="RECEIPT" verb="BLUE" onClick={() => onReceipt(h.id)} /></article>) : <p>No past hauls yet.</p>}</>}
  </Frame>;
}
