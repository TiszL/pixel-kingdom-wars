import { useState, type ReactNode } from 'react';
import type { FantasySearchResult } from '../../data';
import { LEVEL_RANGE, WORLD_COPY, levelLabel, realmInfo } from '../copy';
import { levelFiltered, splitSearch, type RealmFilter } from './model';
import { HudIcon } from './HudPanel';

/**
 * The realm map's chrome (native RealmMapHud.kt, concept realm/ui.js as restyled by HUD-STYLE §13): the Globe exit,
 * the kingdom search (this realm's results select in place, others offer "Go to ‹realm›"), the filter chips
 * All / Mine / Unshielded / Level, and the WARZONE chip while a warzone is active. The Unshielded chip (D-191: the
 * raider's target; a kingdom that fails a filter is hidden, not dimmed) is absent until a read has carried the
 * `shielded` key ([shieldKnown], D-181: hidden, never faked). No Clan chip (OQ-16), no
 * "Next open deed" (it needs the occupancy route, OQ-1). Everything calls the host.
 */
export function RealmMapChrome({ realmId, onExit, query, onQuery, results, pending, onPick, onGoTo, filter, onFilter, shieldKnown,
  warzoneActive, warzoneOpen, onWarzone, warzonePanel }: {
  realmId: string; onExit: () => void;
  query: string; onQuery: (query: string) => void; results: readonly FantasySearchResult[] | null | undefined; pending?: boolean | undefined;
  onPick: (result: FantasySearchResult) => void; onGoTo: (result: FantasySearchResult) => void;
  filter: RealmFilter; onFilter: (filter: RealmFilter) => void; shieldKnown: boolean;
  warzoneActive: boolean; warzoneOpen?: boolean | undefined; onWarzone?: (() => void) | undefined; warzonePanel?: ReactNode;
}): React.JSX.Element {
  const M = WORLD_COPY.realmMap, S = WORLD_COPY.realmSearch;
  const [searching, setSearching] = useState(query.length > 0), [levelOpen, setLevelOpen] = useState(false);
  const { here, elsewhere } = splitSearch(results, realmId);
  const asked = query.trim().length >= 2 && !pending && !!results;
  const closeSearch = (): void => { onQuery(''); setSearching(false); };
  const chip = (kind: RealmFilter['kind'], label: string, short?: string): React.JSX.Element =>
    <button type="button" key={kind} className="hud-filter" aria-pressed={filter.kind === kind} aria-label={label}
      onClick={() => onFilter({ ...filter, kind })}>{short ? <><span className="wv2-lg">{label}</span><span className="wv2-sm">{short}</span></> : label}</button>;
  const setLevel = (edge: 'lo' | 'hi', value: number): void => {
    const lo = edge === 'lo' ? Math.min(value, filter.hi) : filter.lo, hi = edge === 'hi' ? Math.max(value, filter.lo) : filter.hi;
    onFilter({ ...filter, lo, hi });
  };
  return <div className="hud wv2-realm-chrome" style={{ '--hud-acc': realmInfo(realmId)?.accent ?? '#e3ae3c' } as React.CSSProperties}>
    <div className="wv2-realm-top">
      <button type="button" className="hud-btn hud-btn--sm" aria-label={M.exitLabel} onClick={onExit}><HudIcon name="prev" /><span className="wv2-lg">{M.exit}</span></button>
      {searching ? <form role="search" className="wv2-search" onSubmit={e => { e.preventDefault(); const first = here[0] ?? elsewhere[0]; if (first) (first.realmId === realmId ? onPick : onGoTo)(first); }}>
        <input className="hud-input" type="search" aria-label={S.label} placeholder={S.placeholder} autoComplete="off" maxLength={96} autoFocus
          value={query} onChange={e => onQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } }} />
        <button type="button" className="hud-x" aria-label={S.close} onClick={closeSearch} />
        {asked && <div className="hud-panel wv2-results" aria-live="polite">
          {here.length === 0 && elsewhere.length === 0 && <p className="hud-body hud-dim">{S.none}</p>}
          {here.map(r => <button type="button" key={r.tileId} className="hud-row wv2-row" onClick={() => onPick(r)}>
            <span className="wv2-row-name">{r.name}</span><span className="hud-num hud-gold">L{r.keepLevel}</span></button>)}
          {elsewhere.map(r => <button type="button" key={r.tileId} className="hud-row wv2-row" onClick={() => onGoTo(r)}>
            <span className="wv2-row-name">{r.name}<small className="hud-cap">{M.goTo(realmInfo(r.realmId)?.name ?? r.realmId)}</small></span>
            <span className="hud-num hud-gold">L{r.keepLevel}</span></button>)}
        </div>}
      </form> : <button type="button" className="hud-tool hud-tool--icon" aria-label={S.label} onClick={() => setSearching(true)}><HudIcon name="scout" /></button>}
      {warzoneActive && <button type="button" className="hud-filter wv2-warzone" aria-pressed={!!warzoneOpen}
        aria-label={warzoneOpen ? M.warzoneHide : M.warzoneShow} onClick={onWarzone}>{M.warzone}</button>}
    </div>
    <div className="wv2-chips" role="toolbar" aria-label={M.filters}>
      {chip('all', M.all)}{chip('mine', M.mine)}{shieldKnown && chip('unshielded', M.unshielded, M.unshieldedShort)}
      <button type="button" className={`hud-filter${levelFiltered(filter) ? ' is-on' : ''}`} aria-expanded={levelOpen} aria-label={levelLabel(filter.lo, filter.hi)}
        onClick={() => setLevelOpen(!levelOpen)}><span className="wv2-lg">{levelLabel(filter.lo, filter.hi)}</span><span className="wv2-sm">{levelLabel(filter.lo, filter.hi, true)}</span></button>
    </div>
    {levelOpen && <div className="hud-panel wv2-level">
      <input className="hud-range" type="range" min={LEVEL_RANGE.min} max={LEVEL_RANGE.max} value={filter.lo} aria-label={M.minLevel} onChange={e => setLevel('lo', Number(e.target.value))} />
      <input className="hud-range" type="range" min={LEVEL_RANGE.min} max={LEVEL_RANGE.max} value={filter.hi} aria-label={M.maxLevel} onChange={e => setLevel('hi', Number(e.target.value))} />
    </div>}
    {warzoneActive && warzoneOpen && warzonePanel && <div className="hud-panel wv2-warzone-panel" aria-label={M.warzoneShow}>{warzonePanel}</div>}
  </div>;
}
