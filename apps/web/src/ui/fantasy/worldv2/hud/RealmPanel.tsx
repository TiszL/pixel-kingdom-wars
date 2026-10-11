import { fmtN } from '../../../primitives';
import { WORLD_COPY, islandInfo, realmInfo, RESERVED_REALM_ID, type WorldHudIntent } from '../copy';
import { realmCtaRows, realmStats, type RealmCounts, type RealmCta } from './model';
import { HudIcon, HudPanel } from './HudPanel';

/**
 * The realm panel (concept main.js `realmPanel`, native GlobeHud.kt RealmPanelBody): kicker (numeral + nav), the
 * display name in the realm's light, epithet, lore, landscape, the server's counts (Solana Reach: its reserved
 * allocations), and the CTA foot from `realmCtaRows`, which offers Enter map in every mode, choose-land included.
 * [notice] is the failed-dive line shown with the reopened panel. Buttons only call the host.
 */
export function RealmPanel({ realmId, counts, mine, mapped = true, readiness, mineCta, intent, notice, portrait, onEnterMap, onChooseLand, onClose }: {
  realmId: string; counts: RealmCounts | null | undefined; mine: number;
  mapped?: boolean | undefined; readiness?: number | null | undefined; mineCta?: boolean | undefined;
  intent?: WorldHudIntent | null | undefined; notice?: string | null | undefined; portrait?: boolean | undefined;
  onEnterMap: (realmId: string, mine: boolean) => void; onChooseLand: (realmId: string) => void; onClose: () => void;
}): React.JSX.Element | null {
  const info = realmInfo(realmId);
  if (!info) return null;
  const P = WORLD_COPY.realmPanel;
  const rows = realmCtaRows({ realmId, open: counts?.available, mine: mine > 0, hasMap: mapped, ready: readiness, mineCta, choose: intent === 'choose-land' });
  const button = (cta: RealmCta): React.JSX.Element => {
    const cls = `hud-btn${cta.gold ? ' hud-btn--gold' : ''}`;
    switch (cta.kind) {
      case 'choose-land': return <button type="button" key={cta.kind} className={cls} onClick={() => onChooseLand(realmId)}><HudIcon name="map" />{P.chooseLand}</button>;
      case 'no-open-land': return <button type="button" key={cta.kind} className={cls} disabled>{P.noOpenLand}</button>;
      case 'my-base': return <button type="button" key={cta.kind} className={cls} onClick={() => onEnterMap(realmId, true)}><HudIcon name="locate" />{P.myBase}</button>;
      case 'enter-map': return <button type="button" key={cta.kind} className={cls} onClick={() => onEnterMap(realmId, false)}><HudIcon name="map" />{P.enterMap}</button>;
      case 'no-map': return <button type="button" key={cta.kind} className={cls} disabled>{P.noMap}</button>;
      case 'preparing': return <button type="button" key={cta.kind} className={cls} disabled aria-label={P.preparingLabel}><HudIcon name="map" />{P.preparing(cta.percent ?? 0)}</button>;
    }
  };
  const foot = <div className="wv2-cta">{rows.map((row, i) => <div key={i} className="wv2-cta-row">{row.map(button)}</div>)}</div>;
  return <HudPanel accent={info.accent} label={info.name} portrait={portrait} onClose={onClose} foot={foot}>
    <p className="hud-kicker" style={{ '--i': 0 } as React.CSSProperties}><span className="hud-numeral">{info.numeral}</span>{info.nav}</p>
    <h2 className="hud-display" style={{ '--i': 1 } as React.CSSProperties}>{info.name}</h2>
    <p className="hud-epithet" style={{ '--i': 2 } as React.CSSProperties}>{info.epithet}</p>
    {notice && <p className="hud-note" role="alert">{notice}</p>}
    <p className="hud-body" style={{ '--i': 3 } as React.CSSProperties}>{info.lore}</p>
    <p className="hud-cap" style={{ '--i': 4 } as React.CSSProperties}>{info.landscape}</p>
    <dl className="wv2-stats" style={{ '--i': 5 } as React.CSSProperties}>{realmStats(realmId, counts, mine).map(s =>
      <div key={s.label} className={`hud-stat${s.mine ? ' is-mine' : ''}`}><dd className="hud-num hud-num--lg">{s.value === null ? '—' : fmtN(s.value)}</dd><dt className="hud-cap">{s.label}</dt></div>)}</dl>
    {realmId === RESERVED_REALM_ID && <div className="hud-note"><b className="hud-kicker">{P.reservedTitle}</b>{P.reservedBody}</div>}
  </HudPanel>;
}

/**
 * An island panel (native PhaseEIslands.kt + GlobeHud.kt IslandPanelBody, owner's player copy 2026-09-26): the
 * "ISLAND · COMING SOON" kicker, the name, the lore, a "Coming soon" note built from PHASE_E_POLICY (copy.ts), and
 * the map button, always disabled: island maps come later (D-182, inert).
 */
export function IslandPanel({ islandId, portrait, onClose }: { islandId: string; portrait?: boolean | undefined; onClose: () => void }): React.JSX.Element | null {
  const info = islandInfo(islandId);
  if (!info) return null;
  const I = WORLD_COPY.island;
  const foot = <button type="button" className="hud-btn hud-btn--gold" disabled aria-label={I.mapLabel}><HudIcon name="map" />{I.soon}</button>;
  return <HudPanel accent={info.accent} label={info.title} portrait={portrait} onClose={onClose} foot={foot}>
    <p className="hud-kicker" style={{ '--i': 0 } as React.CSSProperties}>{I.kicker}</p>
    <h2 className="hud-display" style={{ '--i': 1 } as React.CSSProperties}>{info.title}</h2>
    <p className="hud-epithet" style={{ '--i': 2 } as React.CSSProperties}>{info.lore}</p>
    <div className="hud-note" style={{ '--i': 3 } as React.CSSProperties}><b className="hud-kicker">{I.soon}</b>{info.note()}</div>
  </HudPanel>;
}
