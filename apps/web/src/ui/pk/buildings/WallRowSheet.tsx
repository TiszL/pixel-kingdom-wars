import type { ReactNode } from 'react';
import { PkIconSquare, PkPrimaryButton, PkQuietButton, PkSecondaryButton, PkTag } from '../Button';
import { PkIcon } from '../Icon';
import { PkPlate, PkSheetTitlePlate } from '../Plate';
import { PkPriceChip } from '../PriceChip';
import { currencyIcon, currencyName, UNKNOWN } from '../kitLogic';
import type { Currency, PriceUi } from '../types';
import type { UpgradeState } from './buildingTypes';
import type { UpgradeStatUi } from './UpgradeSheet';
import GrassWell from './GrassWell';
import { quotePresentation, quoteTotalLine, wallRowHint, wallUnitPrice } from './quotePresentation';
import './WallRowSheet.css';

/** Server-mapped quote. World row selection, exclusions and taps remain with the original scene/controller. */
export interface WallRowSheetUi {
  fromLevel: string; toLevel: string;
  /** One existing wall-art node, repeated three times per native compare well. */
  artNow: ReactNode; artNext: ReactNode;
  count: number;
  rows: readonly UpgradeStatUi[];
  unitPrice: PriceUi; total: PriceUi;
  time: string | null; builders: string; state: UpgradeState;
  shortfall: string | null; builderFreeIn: string | null; reason: string | null;
  wallsStayUp: boolean;
}
export interface WallRowSheetActions {
  /** Pure live read from the original controller, rechecked on every commit tap. */
  canUpgrade: () => boolean;
  onUpgrade: () => void;
  /** Opens consent only; the existing controller owns Gems submission and idempotency. */
  onReviewGems: () => void;
  onCancelRow: () => void;
  onGetMore: (currency: Currency) => void;
  onRecheck: () => void;
  onBuilders: () => void;
  onReport: () => void;
}

/** HALF body only: shared host owns placement, dismissal/insets and dialog; mount lazily through features.ts. */
export default function WallRowSheet({ ui, on }: { ui: WallRowSheetUi; on: WallRowSheetActions }): React.JSX.Element {
  // review 01080e6f: this surface admits Shards or a Gems review only; other money paths stay closed.
  const supportedCurrency = ui.total.currency === 'SHARDS' || ui.total.currency === 'GEMS';
  const currenciesMatch = ui.unitPrice.currency === ui.total.currency;
  const look = !supportedCurrency
    ? { kind: 'OFF' as const, sends: false, reason: 'This row upgrade is not available for this currency.' }
    : !currenciesMatch ? { kind: 'OFF' as const, sends: false, reason: 'Price unavailable right now' }
      : quotePresentation(ui.state, ui.total, ui.reason, ui.count <= 0 && ui.state !== 'CHECKING', `All walls are ${ui.toLevel}`);
  const short = look.kind === 'NEED_MORE';
  const waiting = look.kind === 'WAIT_PRICE' || look.kind === 'STARTING' || look.kind === 'VERIFYING';
  const closeEnabled = look.kind !== 'STARTING';
  // review 80bc41c6: conflicting quote currencies cannot show or authorize a price, including stale speech.
  const pill: PriceUi = currenciesMatch ? wallUnitPrice(ui.count, ui.unitPrice, ui.total, short)
    : { ...ui.total, amount: null, status: 'UNAVAILABLE', description: null };
  const name = currencyName(ui.total.currency);
  const getMore = () => on.onGetMore(ui.total.currency);
  const supportedPillCurrency = pill.currency === 'SHARDS' || pill.currency === 'GEMS';
  const onPill = !supportedCurrency || !supportedPillCurrency || !currenciesMatch ? undefined
    : pill.status === 'SHORT' ? getMore : pill.status === 'CHECKING' ? on.onRecheck : undefined;
  const admits = () => { try { return on.canUpgrade() === true; } catch { return false; } };
  const activate = () => {
    if (look.sends) {
      if (!admits()) return;
      if (ui.total.currency === 'GEMS') on.onReviewGems();
      else if (ui.total.currency === 'SHARDS') on.onUpgrade();
    } else if (look.kind === 'NEED_MORE') getMore();
    else if (look.kind === 'NEED_BUILDER') on.onBuilders();
  };
  const label = look.kind === 'WAIT_PRICE' ? 'Checking price' : look.kind === 'STARTING' ? 'Starting…'
    : look.kind === 'VERIFYING' ? 'Being checked' : `UPGRADE ${ui.count}`;
  return <div className="pk-wall-row" data-sheet-size="HALF" aria-busy={waiting}>
    <section className="pk-frame" aria-label="Upgrade wall row">
      <PkPlate kind="WOOD" className="pk-frame__wood">
        <header className="pk-frame__head">
          <PkSheetTitlePlate ui={{ title: 'UPGRADE ROW', titleTag: ui.fromLevel, titleTagTo: ui.toLevel }} />
          <PkIconSquare icon="shape:close" verb="RED" contentDescription="Close" enabled={closeEnabled} onClick={on.onCancelRow} />
        </header>
        <PkPlate kind="PARCHMENT" className="pk-frame__body">
          <div className="pk-wall-row__compare">
            <WallWell art={ui.artNow} spoken={`Walls now, ${ui.fromLevel}`} />
            <span className="pk-wall-row__arrow" aria-hidden="true">→</span>
            <WallWell art={ui.artNext} spoken={`Walls after the upgrade, ${ui.toLevel}`} />
          </div>
          {ui.rows.length > 0 ? <section className="pk-wall-row__stats" aria-label="What improves">
            {ui.rows.map((row, index) => <div key={`${row.label}:${index}`} className="pk-wall-row__stat" data-wall-stat="" role="img"
              aria-label={row.unlock ? `${row.label}: unlocks` : row.old != null ? `${row.label}: ${row.old} to ${row.new ?? UNKNOWN}` : `${row.label}: ${row.new ?? UNKNOWN}`}>
              <PkIcon name={row.icon} size={row.icon.startsWith('ui:') || row.icon.startsWith('pkw_ui_') ? 32 : 24} /><span>{row.label}</span>
              {row.unlock ? <PkTag text="UNLOCK" verb="GOLD" /> : <span className="pk-wall-row__delta">
                {row.old != null ? <><span>{row.old}</span><span aria-hidden="true">→</span></> : null}<strong>{row.new ?? UNKNOWN}</strong>
              </span>}
            </div>)}
          </section> : null}
          <div className="pk-wall-row__costs" aria-label="Row upgrade requirements">
            <PkPriceChip ui={pill} onClick={onPill} />
            {short ? <p className="pk-wall-row__shortfall">Need {ui.shortfall ?? UNKNOWN} more {name}</p> : <>
              {ui.time != null ? <span className="pk-wall-row__readout" role="img" aria-label={`Takes ${ui.time}`}><PkIcon name="timer" size={24} />{ui.time}</span> : null}
              <span className="pk-wall-row__readout" role="img" aria-label={`Builders ${ui.builders}`}><PkIcon name="builder" size={30} />{ui.builders}</span>
            </>}
          </div>
          <p className="pk-wall-row__hint" role={look.kind === 'VERIFYING' ? 'status' : undefined}>
            {look.kind === 'VERIFYING' ? look.reason : wallRowHint(ui.wallsStayUp)}
          </p>
          <div className="pk-wall-row__actions">
            <div className="pk-wall-row__cancel"><PkSecondaryButton label="CANCEL ROW" onClick={on.onCancelRow} enabled={closeEnabled} /></div>
            <div className="pk-wall-row__primary">
              <div className="pk-wall-row__primary-row"><PkPrimaryButton label={label} onClick={activate} verb="GREEN" icon="shape:up"
                state={waiting ? 'BUSY' : look.sends ? 'ENABLED' : 'DISABLED'} reason={look.kind === 'OFF' ? look.reason : null}
                sub={look.sends ? quoteTotalLine(ui.total) : short ? `needs ${name}` : look.kind === 'NEED_BUILDER' ? 'needs a builder' : null} />
                {short ? <PkPrimaryButton label={`GET ${name.toUpperCase()}`} onClick={getMore} verb="BLUE" icon={currencyIcon(ui.total.currency, ui.total.icon ?? null)} /> : null}
                {look.kind === 'NEED_BUILDER' ? <PkPrimaryButton label="BUILDERS" onClick={on.onBuilders} verb="STONE" icon="builder"
                  sub={ui.builderFreeIn != null ? `Free in ${ui.builderFreeIn}` : null} /> : null}
              </div>
              {look.kind === 'VERIFYING' ? <PkQuietButton label="Report" onClick={on.onReport} onParchment contentDescription="Report a problem with this upgrade" /> : null}
            </div>
          </div>
        </PkPlate>
      </PkPlate>
    </section>
  </div>;
}

function WallWell({ art, spoken }: { art: ReactNode; spoken: string }): React.JSX.Element {
  // Native wall compare uses three pieces as presentation, not an inferred row count.
  return <div role="img" aria-label={spoken} className="pk-wall-row__well"><GrassWell className="pk-wall-row__grass">
    <span data-wall-piece="">{art}</span><span data-wall-piece="">{art}</span><span data-wall-piece="">{art}</span>
  </GrassWell></div>;
}
