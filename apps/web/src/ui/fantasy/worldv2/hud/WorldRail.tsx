import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { FantasySearchResult } from '../../data';
import { WORLD_COPY } from '../copy';
import { RAIL_ENTRIES } from './model';
import { HudIcon } from './HudPanel';

export interface RailSelection { kind: 'realm' | 'island'; id: string }
export interface GlobeSearchProps {
  query: string; onQuery: (query: string) => void;
  results: readonly FantasySearchResult[] | null | undefined;
  pending?: boolean | undefined; error?: boolean | undefined; onRetry?: (() => void) | undefined;
  onPick: (result: FantasySearchResult) => void;
}

/**
 * The globe rail (native GlobeHud.kt, concept main.js `destinations`): the 8 realms then the 3 islands, the same
 * recessed well each, identity only in the accent pip (D-166.1). A realm whose map is open carries the map icon;
 * in the "View deeds" intent your realms are marked. Then the keeper search. Taps go to the host.
 */
export function WorldRail({ selected, mapped, mineRealms, onRealm, onIsland, search }: {
  selected: RailSelection | null | undefined;
  /** Realms that can be entered; all eight by default (D-186: the pinned packs count as ready). */
  mapped?: ReadonlySet<string> | undefined;
  /** Marked realms ("Your realms are marked"): only while the my-deeds intent is active. */
  mineRealms?: ReadonlySet<string> | undefined;
  onRealm: (realmId: string) => void; onIsland: (islandId: string) => void;
  search: GlobeSearchProps;
}): React.JSX.Element {
  const R = WORLD_COPY.rail, rail = useRef<HTMLDivElement>(null);
  const selectedKey = selected ? `${selected.kind}:${selected.id}` : '';
  useEffect(() => {
    // Scroll only this rail to the selection (a page scroll would move the world under the player).
    const node = rail.current?.querySelector<HTMLElement>(`[data-dest="${selectedKey}"]`);
    node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selectedKey]);
  return <nav className="hud wv2-rail" aria-label={R.label}>
    <div ref={rail} className="wv2-rail-row">
      {RAIL_ENTRIES.map(d => {
        const key = `${d.kind}:${d.id}`, map = d.kind === 'realm' && (mapped ? mapped.has(d.id) : true), mine = d.kind === 'realm' && !!mineRealms?.has(d.id);
        return <button type="button" key={key} data-dest={key} className={`hud-filter hud-dest${mine ? ' is-mine' : ''}`}
          style={{ '--hud-acc': d.accent } as CSSProperties} aria-pressed={selectedKey === key}
          aria-label={`${d.name}${map ? `: ${R.mapOpen}` : ''}${mine ? `, ${R.yourBases}` : ''}`}
          onClick={() => (d.kind === 'realm' ? onRealm(d.id) : onIsland(d.id))}>{map && <HudIcon name="map" />}{d.name}</button>;
      })}
    </div>
    <GlobeSearch {...search} />
  </nav>;
}

/** "Find a keeper…": the owner search (`/globe/fantasy/search`), closed to a scout tool until opened. */
export function GlobeSearch({ query, onQuery, results, pending, error, onRetry, onPick }: GlobeSearchProps): React.JSX.Element {
  const S = WORLD_COPY.globeSearch, [open, setOpen] = useState(query.length > 0);
  const close = (): void => { onQuery(''); setOpen(false); };
  if (!open) return <button type="button" className="hud-tool hud-tool--icon wv2-search-tool" aria-label={S.label} onClick={() => setOpen(true)}><HudIcon name="scout" /></button>;
  const asked = query.trim().length >= 2;
  return <form role="search" className="wv2-search" onSubmit={e => { e.preventDefault(); const first = results?.[0]; if (first) onPick(first); }}>
    <input className="hud-input" type="search" aria-label={S.label} placeholder={S.placeholder} autoComplete="off" maxLength={96} autoFocus
      value={query} onChange={e => onQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); close(); } }} />
    <button type="button" className="hud-x" aria-label={S.close} onClick={close} />
    {asked && !pending && (error || results) && <div className="hud-panel wv2-results" aria-live="polite">
      {error ? <p className="hud-body hud-dim">{S.unavailable} {onRetry && <button type="button" className="hud-btn hud-btn--sm" onClick={onRetry}>{S.retry}</button>}</p>
        : results?.length === 0 ? <p className="hud-body hud-dim">{S.none}</p>
        : results?.map(row => <button type="button" key={row.tileId} className="hud-row wv2-row" onClick={() => onPick(row)}>
          <span className="wv2-row-name">{row.name}</span><span className="hud-num hud-gold">L{row.keepLevel}</span></button>)}
    </div>}
  </form>;
}
