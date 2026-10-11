import type { CSSProperties, ReactNode } from 'react';
import { fmtN } from '../../../primitives';
import { parcelActionBlockText } from '../../../screens/globe/parcelDetail';
import type { FantasyOwnedTile, FantasyParcelData } from '../../data';
import { LEVEL_RANGE, WORLD_COPY, kingdomName } from '../copy';
import { cardTags, tileXY } from './model';
import { HudIcon, HudPanel } from './HudPanel';

export interface CardFailure { kind: 'land-gate' | 'other'; message: string }
export interface KingdomCardActions {
  onOpenBase: (baseId: string) => void; onManageDeed: () => void;
  onScout: () => void; onRaid: () => void;
  onChooseLand: () => void; onLandGate: () => void; onRetry: () => void;
  onLookCloser?: (() => void) | undefined; onClose: () => void;
}

/**
 * The base card on a realm map (concept realm/ui.js `card(b)`, native ParcelCard.kt): one server-driven body from
 * the parcel read (`/globe/fantasy/parcels/:tileId`). The tags come from `cardTags`: "You can attack" only when the
 * server's `actions.attack.allowed` is true. SCOUT and RAID are enabled exactly as the server's actions say, with its
 * `blockedBy` in the host's words; OPEN BASE for your own active deed, MANAGE DEED for an inactive one; CHOOSE THIS
 * LAND on open land. Every button calls the host. While the read runs the card shows the map's [silhouette] (name and
 * level from the viewport markers). [children] is the host's slot (shield clock, deed picture). Portrait = bottom sheet.
 */
export function KingdomCard({ tileId, realmName, accent, parcel, pending, failure, own, silhouette, busy, portrait, actions, children }: {
  tileId: number; realmName?: string | null | undefined; accent?: string | undefined;
  parcel: FantasyParcelData | null | undefined; pending?: boolean | undefined; failure?: CardFailure | null | undefined;
  own?: FantasyOwnedTile | null | undefined; silhouette?: { name: string; keepLevel?: number | undefined } | null | undefined;
  busy?: boolean | undefined; portrait?: boolean | undefined; actions: KingdomCardActions; children?: ReactNode;
}): React.JSX.Element {
  const C = WORLD_COPY.card, { x, y } = tileXY(tileId), yours = !!own;
  const detail = parcel?.detail ?? null;
  const level = detail ? detail.player.keepLevel : silhouette?.keepLevel;
  const title = detail ? kingdomName(detail.player.name, yours)
    : parcel ? (parcel.availability === 'available' ? C.openDeed : yours ? C.yourDeed : C.deedAt(x, y))
    : silhouette ? kingdomName(silhouette.name, yours) : own ? kingdomName(own.name, true) : C.deedAt(x, y);
  const subline = detail ? null : parcel ? (parcel.availability === 'available' ? C.wild : parcel.availability === 'held' ? C.held
    : parcel.availability === 'reserved' ? C.reserved(parcel.tile.allocation) : C.assigned) : null;
  const tags = cardTags(yours, detail);
  const attack = detail?.actions.attack, scout = detail?.actions.scout;
  const blocked = !yours && detail ? [
    attack && !attack.allowed ? parcelActionBlockText(attack.blockedBy, { ...(attack.keepReach ? { keepReach: attack.keepReach } : {}), shield: detail.shield }) : null,
    scout && !scout.allowed && scout.blockedBy !== attack?.blockedBy ? parcelActionBlockText(scout.blockedBy, { shield: detail.shield }) : null,
  ].filter((line): line is string => !!line) : [];
  const primary = own ? <button type="button" className="hud-btn hud-btn--gold" disabled={!!busy}
      onClick={() => (own.active ? actions.onOpenBase(own.baseId) : actions.onManageDeed())}>{own.active ? C.openBase : C.manageDeed}</button>
    : detail ? <>
      <button type="button" className="hud-btn" disabled={!!busy || !scout?.allowed} onClick={actions.onScout}><HudIcon name="scout" />{C.scout}</button>
      <button type="button" className="hud-btn hud-btn--gold" disabled={!!busy || !attack?.allowed} onClick={actions.onRaid}><HudIcon name="attack" />{C.raid}</button></>
    // land-globe-confirm: the tutorial's CHOOSE LAND anchor (guideCues first_land), as on the host panel.
    : parcel?.availability === 'available' ? <button type="button" className="hud-btn hud-btn--gold" data-tutorial-target="land-globe-confirm" disabled={!!busy} onClick={actions.onChooseLand}>{C.chooseThisLand}</button>
    : failure?.kind === 'land-gate' ? <button type="button" className="hud-btn hud-btn--gold" disabled={!!busy} onClick={actions.onLandGate}>{C.chooseLand}</button>
    : failure ? <button type="button" className="hud-btn" onClick={actions.onRetry}>{C.retry}</button> : null;
  const foot = <div className="wv2-cta-row" aria-label={C.actions}>{primary}
    {actions.onLookCloser && <button type="button" className="hud-btn hud-btn--ghost" onClick={actions.onLookCloser}>{detail || silhouette ? C.lookCloser : C.viewDeed}</button>}</div>;
  return <HudPanel accent={accent ?? '#e3ae3c'} label={title} portrait={portrait} onClose={actions.onClose} foot={foot} className="wv2-card">
    <div className="wv2-card-head">
      <h2 className="hud-title wv2-card-title">{title}</h2>
      {level !== undefined && <div className="hud-level" aria-label={`${C.keepLevel} ${level} of ${LEVEL_RANGE.max}`}>
        <span>{C.keepLevel} <b>{level}</b>/{LEVEL_RANGE.max}</span><span className="hud-meter" style={{ '--p': `${(level / LEVEL_RANGE.max) * 100}%` } as CSSProperties}><i /></span></div>}
      {tags.length > 0 && <div className="wv2-tags">{tags.map(t => <span key={t.label} className={`hud-tag hud-tag--${t.tone}`}>{t.label}</span>)}</div>}
    </div>
    {subline && <p className="hud-cap">{subline}</p>}
    {!parcel && !failure && (pending ?? true) && <p className="hud-cap">{silhouette || own ? C.loading : C.checking}</p>}
    {failure && <p className={`hud-body${failure.kind === 'other' ? ' wv2-danger' : ' hud-dim'}`} role="alert">{failure.message}</p>}
    <dl className="wv2-facts">
      {realmName && <div><dt className="hud-cap">{C.realm}</dt><dd>{realmName}</dd></div>}
      <div><dt className="hud-cap">{C.parcel}</dt><dd className="hud-num">{x}, {y}</dd></div>
      {detail && <div><dt className="hud-cap">{C.trophies}</dt><dd className="hud-num">{fmtN(detail.player.trophies)}</dd></div>}
      {detail?.player.clanTag && <div><dt className="hud-cap">{C.clan}</dt><dd>{detail.player.clanTag}</dd></div>}
    </dl>
    {blocked.map(line => <p key={line} className="hud-cap hud-dim">{line}</p>)}
    {children}
  </HudPanel>;
}
