import { Chunky, PkBusyDots, PkQuietButton } from '../Button';
import { PkIcon } from '../Icon';
import { PkPlate } from '../Plate';
import { PkPriceChip } from '../PriceChip';
import { currencyName, priceDescription } from '../kitLogic';
import type { Currency, PriceUi } from '../types';
import type { PlacementState } from './buildingTypes';
import { placeLook, placementHint } from './buildingsLogic';
import './PlacementBar.css';

/** The strip-only subset of Android PlacementUi. The world owner retains tile/ghost/footprint geometry. */
export interface PlacementBarUi {
  type: string;
  name: string;
  price: PriceUi;
  /** Already formatted by the mapper; unknown values arrive as the shared ellipsis. */
  time: string;
  builders: string;
  state: PlacementState;
  hint: string | null;
  reason: string | null;
}

export interface PlacementBarActions {
  /** Pure current admission from the original controller, including occupancy, price and in-flight order checks. */
  canPlace: () => boolean;
  /** Original placement controller; it keeps build:start, idempotency and submission ownership. */
  onPlace: () => void;
  /** Navigation only: review Gems through the existing controller's Seal; never confirm a spend here. */
  onReviewGems: () => void;
  /** Restore the existing tray and its scroll position. */
  onCancel: () => void;
  onNeedMore?: (currency: Currency) => void;
  onBuilders?: () => void;
  onReport?: () => void;
}

export interface PlacementBarProps { ui: PlacementBarUi; on: PlacementBarActions }

/**
 * Android PlacementMode.kt PlacementStrip, inside the host's bounded placement area (safe insets owned by the host).
 * Only the real controls and info plate intercept input. This component owns no ghost, gestures, rotation, store or API.
 * Consumer adaptation agreed by W4 parent: native's generic Place callback splits Gems into consent navigation, as in
 * UpgradeSheet. Both routes recheck the original controller's live admission; that controller owns all later execution.
 */
export default function PlacementBar({ ui, on }: PlacementBarProps): React.JSX.Element {
  const nativeLook = placeLook(ui.state, ui.price, ui.reason);
  const supportedCurrency = ui.price.currency === 'SHARDS' || ui.price.currency === 'GEMS';
  // Lantern01080e6f: only SHARDS may commit and GEMS may open consent; keep the frozen pure port unchanged.
  const look: ReturnType<typeof placeLook> = supportedCurrency ? nativeLook : {
    ...nativeLook, verb: 'OFF', dots: false, tap: 'NONE',
    reason: `Placement with ${currencyName(ui.price.currency)} is unavailable`,
  };
  const hint = placementHint(ui.state, ui.hint);
  const pill: PriceUi = ui.state === 'SHORT' && ui.price.status === 'OK'
    ? { ...ui.price, status: 'SHORT', description: null }
    : ui.state === 'CHECKING_PRICE' ? { ...ui.price, status: 'CHECKING', description: null } : ui.price;
  // Native describes the original price; describe the normalized pill so CHECKING cannot speak a stale amount.
  const spoken = [`Place ${ui.name}`, priceDescription(pill), look.reason,
    look.dots ? 'waiting for the server' : null].filter(value => value != null).join('. ');
  // Admission may be unavailable during render or at the tap; retain the bar and Cancel in either case.
  const admits = () => { try { return on.canPlace() === true; } catch { return false; } };
  const allowed = look.tap !== 'NONE' && (look.tap !== 'PLACE' || admits());
  const activate = () => {
    if (ui.price.currency !== 'SHARDS' && ui.price.currency !== 'GEMS') return;
    switch (look.tap) {
      case 'PLACE':
        if (!admits()) return;
        if (ui.price.currency === 'GEMS') on.onReviewGems();
        else if (ui.price.currency === 'SHARDS') on.onPlace();
        break;
      case 'NEED_MORE': on.onNeedMore?.(ui.price.currency); break;
      case 'BUILDERS': on.onBuilders?.(); break;
      case 'NONE': break;
    }
  };
  const cancel = () => { if (ui.state !== 'SENDING') on.onCancel(); };

  return <section className="pk-placement-bar" role="region" aria-label={`${ui.name} placement controls`}
    data-placement-state={ui.state} data-building-type={ui.type}>
    <p className="pk-placement-bar__hint pk-t-body" role="status" aria-live="polite" aria-atomic="true">{hint}</p>
    <div className="pk-placement-bar__shelf" aria-hidden="true" />
    <div className="pk-placement-bar__cancel">
      <Chunky verb="RED" size="square" label="Cancel placement" onClick={cancel} inert={ui.state === 'SENDING'}>
        <PkIcon name="shape:close" size={36} tint="k-label" />
      </Chunky>
      <span className="pk-t-caption pk-ol1" aria-hidden="true">CANCEL</span>
    </div>
    <div className="pk-placement-bar__info" role="img" aria-label={`${ui.name}. Takes ${ui.time}. Builders ${ui.builders}`}>
      <PkPlate kind="CHARCOAL">
        <div aria-hidden="true" className="pk-placement-bar__info-content">
          <span className="pk-t-label pk-ol1 pk-placement-bar__name">{ui.name}</span>
          <span className="pk-placement-bar__details">
            <PkIcon name="timer" size={24} /><span className="pk-t-body">{ui.time}</span>
            <PkIcon name="builder" size={30} /><span className="pk-t-body">{ui.builders}</span>
          </span>
        </div>
      </PkPlate>
    </div>
    <div className="pk-placement-bar__place">
      <PkPriceChip ui={pill} onClick={look.tap === 'NEED_MORE' ? () => on.onNeedMore?.(ui.price.currency) : undefined} />
      <Chunky verb={look.verb} size="primary" label={spoken} onClick={activate} inert={!allowed}
        className="pk-placement-bar__primary">
        {look.dots ? <PkBusyDots /> : <PkIcon name="shape:check" size={40} tint={look.verb === 'OFF' ? 'text' : 'k-label'} />}
        <span className="pk-t-primary pk-ol2" data-off={look.verb === 'OFF'}>PLACE</span>
      </Chunky>
    </div>
    {look.reason != null ? <p className="pk-placement-bar__reason pk-t-small">{look.reason}</p> : null}
    {ui.state === 'VERIFYING' ? <div className="pk-placement-bar__report">
      <PkQuietButton label="Report" contentDescription="Report a problem with this placement" onClick={() => on.onReport?.()} />
    </div> : null}
  </section>;
}
