import type { ReactNode } from 'react';
import { PkIconSquare, PkPrimaryButton, PkQuietButton } from '../Button';
import { PkIcon } from '../Icon';
import { PkPlate, PkSheetTitlePlate } from '../Plate';
import { PkPriceChip } from '../PriceChip';
import { currencyIcon, currencyName, UNKNOWN } from '../kitLogic';
import type { Currency, PriceUi } from '../types';
import type { UpgradeState } from './buildingTypes';
import GrassWell from './GrassWell';
import { quotePresentation } from './quotePresentation';
import './ObstacleRemoveSheet.css';

/** Quote values are supplied by the original server mapper; this body never invents a reward or builder count. */
export interface ObstacleRemoveUi {
  obstacleId: string; name: string; title: string; art: ReactNode;
  price: PriceUi; time: string; builders: string; reward: string | null; state: UpgradeState;
  shortfall: string | null; builderFreeIn: string | null; reason: string | null;
  /** Complete server-mapped "Uses … builder …" sentence, with duration from shared fmtDur. */
  primaryDetail: string | null;
}
export interface ObstacleRemoveActions {
  /** Pure live controller read; never replace with a captured render flag. */
  canRemove: () => boolean;
  onRemove: () => void;
  /** Opens the original controller's Gems consent without submitting. */
  onReviewGems: () => void;
  onBuilders: () => void;
  onGetMore: (currency: Currency) => void;
  onClose: () => void;
  onReport: () => void;
}

/** Props-only HALF quote. Shared host owns geometry, insets and dialog; selection/clearing effects stay in the scene. */
export default function ObstacleRemoveSheet({ ui, on }: { ui: ObstacleRemoveUi; on: ObstacleRemoveActions }): React.JSX.Element {
  // review 01080e6f: never route another currency through the Shards-removal controller.
  const supportedCurrency = ui.price.currency === 'SHARDS' || ui.price.currency === 'GEMS';
  const look = supportedCurrency ? quotePresentation(ui.state, ui.price, ui.reason)
    : { kind: 'OFF' as const, sends: false, reason: 'This removal is not available for this currency.' };
  const short = look.kind === 'NEED_MORE';
  const waiting = look.kind === 'WAIT_PRICE' || look.kind === 'STARTING' || look.kind === 'VERIFYING';
  const name = currencyName(ui.price.currency);
  const time = ui.time.trim() ? ui.time : UNKNOWN;
  const builders = ui.builders.trim() ? ui.builders : UNKNOWN;
  const getMore = () => on.onGetMore(ui.price.currency);
  // A failed controller read closes admission; mutation callback errors remain outside this guard.
  const admits = () => { try { return on.canRemove() === true; } catch { return false; } };
  const activate = () => {
    if (look.sends) {
      if (!admits()) return;
      if (ui.price.currency === 'GEMS') on.onReviewGems();
      else if (ui.price.currency === 'SHARDS') on.onRemove();
    } else if (short) getMore();
    else if (look.kind === 'NEED_BUILDER') on.onBuilders();
  };
  const label = look.kind === 'WAIT_PRICE' ? 'Checking price' : look.kind === 'STARTING' ? 'Starting…'
    : look.kind === 'VERIFYING' ? 'Being checked' : short ? `GET ${name.toUpperCase()}` : look.kind === 'NEED_BUILDER' ? 'BUILDERS' : 'REMOVE';
  return <div className="pk-obstacle-remove" data-sheet-size="HALF" data-obstacle-id={ui.obstacleId} aria-busy={waiting}>
    <section className="pk-frame" aria-label={ui.title}>
      <PkPlate kind="WOOD" className="pk-frame__wood">
        <header className="pk-frame__head">
          <PkSheetTitlePlate ui={{ title: ui.title }} />
          <PkIconSquare icon="shape:close" verb="RED" contentDescription="Close" enabled={look.kind !== 'STARTING'} onClick={on.onClose} />
        </header>
        <PkPlate kind="PARCHMENT" className="pk-frame__body">
          <div className="pk-obstacle-remove__intro">
            <div className="pk-obstacle-remove__well" role="img" aria-label={ui.name}><GrassWell className="pk-obstacle-remove__grass"><div className="pk-obstacle-remove__art">{ui.art}</div></GrassWell></div>
            <div className="pk-obstacle-remove__copy"><p>A builder clears it. The ground is free to build on after.</p>
              {ui.reward != null ? <p data-obstacle-reward="" className="pk-obstacle-remove__reward">{ui.reward}</p> : null}
            </div>
          </div>
          <div className="pk-obstacle-remove__costs" aria-label="Removal requirements">
            <PkPriceChip ui={short && ui.price.status === 'OK' ? { ...ui.price, status: 'SHORT' } : ui.price} onClick={short ? getMore : undefined} />
            {short ? <p className="pk-obstacle-remove__shortfall">Need {ui.shortfall ?? UNKNOWN} more {name}</p> : <>
              <span className="pk-obstacle-remove__readout" role="img" aria-label={`Takes ${time}`}><PkIcon name="timer" size={24} />{time}</span>
              <span className="pk-obstacle-remove__readout" role="img" aria-label={`Builders ${builders}`}><PkIcon name="builder" size={30} />{builders}</span>
            </>}
          </div>
          <PkPrimaryButton label={label} onClick={activate} verb={short ? 'BLUE' : look.kind === 'NEED_BUILDER' ? 'STONE' : 'GREEN'}
            state={waiting ? 'BUSY' : look.kind === 'OFF' ? 'DISABLED' : 'ENABLED'}
            icon={short ? currencyIcon(ui.price.currency, ui.price.icon ?? null) : look.kind === 'NEED_BUILDER' ? 'builder' : 'itm_hammer'}
            sub={look.sends ? ui.primaryDetail : short ? `REMOVE needs ${name}` : look.kind === 'NEED_BUILDER' && ui.builderFreeIn != null ? `Free in ${ui.builderFreeIn}` : null}
            reason={look.kind === 'OFF' ? look.reason : null} />
          {look.kind === 'VERIFYING' ? <div className="pk-obstacle-remove__verification" role="status">
            <p>{look.reason}</p><PkQuietButton label="Report" onClick={on.onReport} onParchment contentDescription="Report a problem with this removal" />
          </div> : null}
        </PkPlate>
      </PkPlate>
    </section>
  </div>;
}
