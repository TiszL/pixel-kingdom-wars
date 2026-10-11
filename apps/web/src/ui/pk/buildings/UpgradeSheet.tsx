import { useEffect, useState, type ReactNode } from 'react';
import { Chunky, PkBadge, PkIconSquare, PkPrimaryButton, PkQuietButton, PkTag } from '../Button';
import { PkIcon } from '../Icon';
import { PkPlate, PkSheetTitlePlate } from '../Plate';
import { PkPriceChip } from '../PriceChip';
import { currencyIcon, currencyName, UNKNOWN } from '../kitLogic';
import type { Currency, PriceUi, Verb } from '../types';
import type { UpgradeState } from './buildingTypes';
import { foldRows, upgradePrimaryLook, type UpgradePrimaryLook } from './buildingsLogic';
import GrassWell from './GrassWell';
import './UpgradeSheet.css';

/** StatDeltaUi, already formatted by the server/catalogue mapper. */
export interface UpgradeStatUi {
  icon: string;
  label: string;
  old: string | null;
  new: string | null;
  unlock: boolean;
}

/** Android UpgradeSheetUi, with art supplied by the existing web art renderer. */
export interface UpgradeSheetUi {
  buildingId: string;
  name: string;
  levelFrom: string;
  levelTo: string;
  artNow: ReactNode;
  artNext: ReactNode;
  newLook: boolean;
  rows: readonly UpgradeStatUi[];
  price: PriceUi;
  time: string | null;
  builders: string | null;
  state: UpgradeState;
  shortfall: string | null;
  bestDoorLabel: string | null;
  builderFreeIn: string | null;
  reason: string | null;
  /** Mapper's complete "Uses … builder …" sentence; no local builder count or duration calculation. */
  primaryDetail?: string | null;
}

export interface UpgradeSheetActions {
  /** Original controller's synchronous single-shot latch; rechecked on every tap, never a captured React render flag. */
  canUpgrade: () => boolean;
  /** Original Shards controller sets its latch synchronously and retains one idempotency key per request. */
  onUpgrade: () => void;
  /** Opens the existing controller's Gems consent; this callback must not spend. */
  onReviewGems: () => void;
  onGetMore: (currency: Currency) => void;
  onBuilders: () => void;
  onClose: () => void;
  onReport: () => void;
}

// Android UpgradeSheet.kt BUSY_CLOSE_HOLD_MS: presentation timing, not an economy/game value.
const BUSY_CLOSE_HOLD_MS = 500;

/**
 * Props-only UPGRADE body. 81654ea8/LW P3 supersedes the older HALF mock with TALL.
 * The shared host owns positioning, insets, dismissal and its sole dialog. Mount through a lazy feature.
 * Gems route to a separate shared Seal consumer; this body never confirms a Gems spend.
 */
export default function UpgradeSheet({ ui, on }: { ui: UpgradeSheetUi; on: UpgradeSheetActions }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const busy = ui.state === 'BUSY';
  const [closeHeld, setCloseHeld] = useState(busy);
  useEffect(() => {
    setCloseHeld(busy);
    if (!busy) return;
    const timer = window.setTimeout(() => setCloseHeld(false), BUSY_CLOSE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [busy]);
  const rows = foldRows(ui.rows, expanded);
  // 01080e6f: retain the accepted pure helper; this surface only owns Shards submission or Gems review.
  const supportedCurrency = ui.price.currency === 'SHARDS' || ui.price.currency === 'GEMS';
  const look: UpgradePrimaryLook = supportedCurrency ? upgradePrimaryLook(ui.state, ui.price, ui.reason)
    : { kind: 'OFF', sends: false, reason: ui.reason ?? 'This upgrade currency is not supported here.' };
  const unknown = (value: string | null) => value ?? UNKNOWN;
  const name = currencyName(ui.price.currency);

  const activate = () => {
    if (look.sends) {
      if (!supportedCurrency || !on.canUpgrade()) return;
      if (ui.price.currency === 'SHARDS') on.onUpgrade();
      else if (ui.price.currency === 'GEMS') on.onReviewGems();
      return;
    }
    if (look.kind === 'NEED_MORE') on.onGetMore(ui.price.currency);
    else if (look.kind === 'NEED_BUILDER') on.onBuilders();
  };
  const waiting = look.kind === 'WAIT_PRICE' || look.kind === 'STARTING' || look.kind === 'VERIFYING';
  const primaryLabel = look.kind === 'WAIT_PRICE' ? 'Checking the price'
    : look.kind === 'STARTING' ? 'Starting…'
      : look.kind === 'VERIFYING' ? 'Checking the upgrade' : 'UPGRADE';
  const primary = <div className="pk-upgrade__primary-row">
    <PkPrimaryButton label={primaryLabel} verb="GREEN" state={waiting ? 'BUSY' : look.sends ? 'ENABLED' : 'DISABLED'}
      sub={look.sends ? ui.primaryDetail ?? null : look.kind === 'NEED_MORE' ? `needs ${name}` : look.kind === 'NEED_BUILDER' ? 'needs a builder' : null}
      reason={look.kind === 'OFF' ? look.reason : null} onClick={activate} />
    {look.kind === 'NEED_MORE' ? <Door label={`GET ${name.toUpperCase()}`} verb="BLUE"
      icon={currencyIcon(ui.price.currency, ui.price.icon ?? null)} sub={ui.bestDoorLabel} onClick={() => on.onGetMore(ui.price.currency)} /> : null}
    {look.kind === 'NEED_BUILDER' ? <Door label="BUILDERS" verb="STONE" icon="builder"
      sub={ui.builderFreeIn != null ? `Free in ${ui.builderFreeIn}` : null} onClick={on.onBuilders} /> : null}
  </div>;

  return <div className="pk-upgrade" data-sheet-size="TALL" data-building-id={ui.buildingId} aria-busy={waiting}>
    <section className="pk-frame" aria-label={`${ui.name} upgrade`}>
      <PkPlate kind="WOOD" className="pk-frame__wood">
        <header className="pk-frame__head">
          <PkSheetTitlePlate ui={{ title: ui.name, titleTag: ui.levelFrom, titleTagTo: ui.levelTo }} />
          <span className="pk-frame__tools"><PkIconSquare icon="shape:close" verb="RED" contentDescription="Close"
            enabled={!closeHeld} onClick={() => { if (!closeHeld) on.onClose(); }} /></span>
        </header>
        <PkPlate kind="PARCHMENT" className="pk-frame__body">
      <div key={ui.buildingId} className="pk-upgrade__compare" aria-label="Building appearance before and after upgrade">
        <div className="pk-upgrade__well" role="img" aria-label={`${ui.name} now, ${ui.levelFrom}`}><GrassWell className="pk-upgrade__grass">
          <div className="pk-upgrade__art">{ui.artNow}</div><span className="pk-upgrade__tier-tag"><PkTag text="NOW" verb="STONE" /></span>
        </GrassWell></div>
        <span className="pk-upgrade__arrow" aria-hidden="true">→</span>
        <div className="pk-upgrade__well" data-new-look={ui.newLook} role="img"
          aria-label={`${ui.name} after the upgrade, ${ui.levelTo}${ui.newLook ? ', new look' : ''}`}>
          <GrassWell className="pk-upgrade__grass" goldRim>
            <div className="pk-upgrade__art">{ui.artNext}</div><span className="pk-upgrade__tier-tag"><PkTag text={ui.levelTo} verb="GREEN" /></span>
          </GrassWell>
          {ui.newLook ? <PkBadge className="pk-upgrade__new-look" ui={{ text: 'NEW LOOK', tone: 'REWARD', description: 'New look' }} /> : null}
        </div>
      </div>
      {ui.rows.length > 0 ? <section className="pk-upgrade__stats" aria-label="What improves">
        {rows.shown.map((row, index) => <div key={`${row.label}:${index}`} className="pk-upgrade__stat" data-upgrade-stat="" role="img"
          aria-label={row.unlock ? `${row.label}: unlocks` : row.old != null ? `${row.label}: ${row.old} to ${unknown(row.new)}` : `${row.label}: ${unknown(row.new)}`}>
          <PkIcon name={row.icon} size={row.icon.startsWith('ui:') || row.icon.startsWith('pkw_ui_') ? 32 : 24} /><span>{row.label}</span>
          {row.unlock ? <PkTag text="UNLOCK" verb="GOLD" />
            : <span className="pk-upgrade__delta">{row.old != null ? <><span>{row.old}</span><span aria-hidden="true">→</span></> : null}<strong>{unknown(row.new)}</strong></span>}
        </div>)}
        {rows.hidden > 0 ? <PkQuietButton label={`+${rows.hidden} more`} onParchment contentDescription={`Show ${rows.hidden} more improvements`} onClick={() => setExpanded(true)} /> : null}
      </section> : null}
      <div className="pk-upgrade__costs" aria-label="Upgrade requirements">
        <PkPriceChip ui={look.kind === 'NEED_MORE' && ui.price.status === 'OK' ? { ...ui.price, status: 'SHORT' } : ui.price} />
        {look.kind === 'NEED_MORE' ? <p className="pk-upgrade__shortfall">Need {unknown(ui.shortfall)} more {name}</p> : <>
          <span className="pk-upgrade__readout" role="img" aria-label={`Takes ${unknown(ui.time)}`}><PkIcon name="timer" size={24} />{unknown(ui.time)}</span>
          <span className="pk-upgrade__readout" role="img" aria-label={`Builders ${unknown(ui.builders)}`}><PkIcon name="builder" size={30} />{unknown(ui.builders)}</span>
        </>}
      </div>
        </PkPlate>
        <footer className="pk-frame__foot">{primary}
          {look.kind === 'VERIFYING' ? <div className="pk-upgrade__verification" role="status">
            {look.reason != null ? <p>{look.reason}</p> : null}<PkQuietButton label="Report" onParchment contentDescription="Report a problem with this upgrade" onClick={on.onReport} />
          </div> : null}
        </footer>
      </PkPlate>
    </section>
  </div>;
}

function Door({ label, verb, icon, sub, onClick }: {
  label: string; verb: Verb; icon: string; sub: string | null; onClick: () => void;
}): React.JSX.Element {
  return <Chunky className="pk-upgrade__door" size="primary" verb={verb}
    label={[label, sub].filter(value => value != null).join('. ')} onClick={onClick}>
    <PkIcon name={icon} size={36} /><span className="pk-btn__labels">
      <span className="pk-t-primary pk-ol2">{label}</span>{sub != null ? <span className="pk-t-small">{sub}</span> : null}
    </span>
  </Chunky>;
}
