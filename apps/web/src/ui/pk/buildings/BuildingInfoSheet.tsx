/**
 * BuildingInfo HALF-sheet body (Android BuildingInfoSheet.kt; buildings/SPEC §2A).
 * The mapper supplies art and formatted values. The host owns placement, motion, dismissal and navigation;
 * onFinish only requests the Gems Seal, which owns confirmation. This body never fetches or spends.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Chunky, PkCloseSquare, PkPrimaryButton, PkSecondaryButton, PkTag } from '../Button';
import { PkIcon } from '../Icon';
import { currencyName, UNKNOWN } from '../kitLogic';
import { PkPlate, PkSheetTitlePlate } from '../Plate';
import { PkPriceChip } from '../PriceChip';
import type { CommandState, Currency, PriceUi, Verb } from '../types';
import GrassWell from './GrassWell';
import {
  INFO_MAX_STATS, infoPrimaryLook, infoPrimaryTap, statIconFramed, statSpoken,
  type InfoLoad, type InfoPrimaryKind,
} from './buildingInfoLogic';
import './BuildingInfoSheet.css';

export interface InfoTagUi { text: string; verb: Verb }

export interface InfoStatUi {
  /** Android icon name determines whether the supplied art gets a portrait frame. */
  icon: string;
  /** Mapper-rendered art, including the correct pixel scale. */
  art: ReactNode;
  label: string;
  now: string | null;
  next?: string | null;
  yesNo?: boolean | null;
}

export interface InfoPrimaryUi {
  kind: InfoPrimaryKind;
  label: string;
  sub: string | null;
  /** Default ENABLED, as on Android. */
  state?: CommandState;
  reason?: string | null;
  /** FINISH's price; UPGRADE's cost is normally in the cost row. */
  price?: PriceUi | null;
}

export interface InfoExtraUi {
  art: ReactNode;
  label: string;
  /** Defaults to label. */
  description?: string;
}

export interface BuildingInfoUi {
  buildingId: string;
  name: string;
  levelTag: string;
  role: string;
  category: InfoTagUi;
  stateTag: InfoTagUi;
  /** Building world art, with any idle/reduced-motion behavior supplied by the mapper. */
  headerArt: ReactNode;
  stats: readonly InfoStatUi[];
  nextLegend: string | null;
  upgrading?: boolean;
  price: PriceUi | null;
  time: string | null;
  builders: string | null;
  shortfall?: string | null;
  primary: InfoPrimaryUi;
  extra?: InfoExtraUi | null;
  /** Default READY. */
  load?: InfoLoad;
}

export interface BuildingInfoActions {
  onClose: () => void;
  /** Replace INFO with UPGRADE; navigation only. */
  onUpgrade: () => void;
  /** Open the Gems Seal; does not confirm a spend. */
  onFinish: () => void;
  onGetMore: (currency: Currency) => void;
  onExtra?: () => void;
  onAllLevels?: () => void;
  onRetry?: () => void;
  onExplain?: (reason: string) => void;
}

export interface BuildingInfoSheetProps { ui: BuildingInfoUi; on: BuildingInfoActions }

export default function BuildingInfoSheet({ ui, on }: BuildingInfoSheetProps): React.JSX.Element {
  const load = ui.load ?? 'READY';
  return (
    <section className="pk-building-info" role="region" aria-label={`${ui.name} info`} data-sheet-size="HALF">
      <PkPlate kind="WOOD" className="pk-building-info__wood">
        <header className="pk-building-info__header">
          <div className="pk-building-info__well" role="img" aria-label={`${ui.name}, ${ui.levelTag}`}>
            <GrassWell>
            <span className="pk-building-info__art" aria-hidden="true">{ui.headerArt}</span>
            <span className="pk-building-info__level" aria-hidden="true"><PkTag text={ui.levelTag} verb="BLUE" /></span>
            </GrassWell>
          </div>
          <div className="pk-building-info__identity">
            <div className="pk-building-info__title-row">
              <div className="pk-building-info__title" role="heading" aria-level={2} aria-label={`${ui.name}, ${ui.levelTag}`}>
                <PkSheetTitlePlate ui={{ title: ui.name }} />
              </div>
              <PkCloseSquare onClick={on.onClose} contentDescription={`Close ${ui.name} info`} />
            </div>
            <p className="pk-t-body pk-building-info__role">{ui.role}</p>
            <div className="pk-building-info__tags">
              <PkTag text={ui.category.text} verb={ui.category.verb} />
              <PkTag text={ui.stateTag.text} verb={ui.stateTag.verb} />
            </div>
          </div>
        </header>
        <PkPlate kind="PARCHMENT" className="pk-building-info__body">
          <div className="pk-building-info__legend">
            <h3 className="pk-t-label">STATS</h3>
            {load === 'READY' && ui.nextLegend != null ? (
              <span className="pk-t-small">now <span aria-hidden="true">▸</span> <span className="pk-building-info__next">{ui.nextLegend}</span></span>
            ) : null}
          </div>
          <Stats ui={ui} load={load} on={on} />
          {/* Android keeps the fifth action available while loading; only the primary is gated by InfoLoad. */}
          {ui.extra ? <StoneRow art={ui.extra.art} label={ui.extra.label} description={ui.extra.description ?? ui.extra.label}
            onClick={() => on.onExtra?.()} /> : null}
          {load === 'READY' && ui.primary.kind !== 'MAX' ? <Costs ui={ui} on={on} /> : null}
          <Primary ui={ui} load={load} on={on} />
        </PkPlate>
      </PkPlate>
    </section>
  );
}

function Stats({ ui, load, on }: { ui: BuildingInfoUi; load: InfoLoad; on: BuildingInfoActions }): React.JSX.Element {
  const shown = ui.stats.slice(0, INFO_MAX_STATS);
  const hidden = Math.max(0, ui.stats.length - INFO_MAX_STATS);
  return (
    <>
      <div className="pk-building-info__stats" role="list" aria-label="Building stats" aria-busy={load === 'LOADING'}>
        {load === 'LOADING' ? Array.from({ length: 4 }, (_, index) => (
          <div className="pk-building-info__skeleton" key={index} role="listitem" aria-label="Loading">
            <span className="pk-t-label" aria-hidden="true">{UNKNOWN}</span>
          </div>
        )) : load === 'ERROR' ? (
          <div className="pk-building-info__error" role="listitem">
            <span className="pk-t-label">{UNKNOWN}</span>
            <PkSecondaryButton label="TRY AGAIN" onClick={() => on.onRetry?.()} contentDescription="Try loading the stats again" />
          </div>
        ) : shown.map((stat, index) => {
          const next = stat.next ?? null;
          const yesNo = stat.yesNo ?? null;
          return (
            <div className="pk-building-info__stat" key={`${ui.buildingId}:${index}`} role="listitem" data-info-stat=""
              aria-label={statSpoken(stat.label, stat.now, next, yesNo)} style={{ '--pk-info-row': index } as CSSProperties}>
              <span className="pk-building-info__stat-art" data-framed={statIconFramed(stat.icon)} aria-hidden="true">{stat.art}</span>
              <span className="pk-t-body pk-building-info__stat-label" aria-hidden="true">{stat.label}</span>
              <span className="pk-t-label pk-building-info__values" aria-hidden="true">
                {yesNo != null ? <PkTag text={yesNo ? 'YES' : 'NO'} verb={yesNo ? 'GREEN' : 'STONE'} /> : next != null ? (
                  <><span>{stat.now ?? UNKNOWN}</span><span className="pk-building-info__arrow">▸</span>
                    <span className="pk-building-info__next" data-pending={ui.upgrading ?? false}>{next}</span></>
                ) : stat.now ?? UNKNOWN}
              </span>
            </div>
          );
        })}
      </div>
      {load === 'READY' && hidden > 0 ? (
        <StoneRow art={<PkIcon name="shape:info" size={24} />} label="All levels" description={`All levels: ${hidden} more stats`}
          onClick={() => on.onAllLevels?.()} />
      ) : null}
    </>
  );
}

function StoneRow({ art, label, description, onClick }: {
  art: ReactNode; label: string; description: string; onClick: () => void;
}): React.JSX.Element {
  return (
    <Chunky verb="STONE" size="secondary" label={description} onClick={onClick} className="pk-building-info__stone">
      <span className="pk-building-info__extra-art">{art}</span>
      <span className="pk-t-body pk-ol1 pk-building-info__stone-label">{label}</span>
      <PkIcon name="shape:go" size={24} />
    </Chunky>
  );
}

function Costs({ ui, on }: { ui: BuildingInfoUi; on: BuildingInfoActions }): React.JSX.Element {
  const price = ui.price;
  return (
    <div className="pk-building-info__costs">
      <div className="pk-building-info__chips">
        {price ? <PkPriceChip ui={price} onClick={price.status === 'SHORT' ? () => on.onGetMore(price.currency) : undefined} /> : null}
        {ui.time != null ? <CreamChip icon="timer" text={ui.time} description={`Takes ${ui.time}`} /> : null}
        {ui.builders != null ? <CreamChip icon="builder" text={ui.builders} description={`Builders ${ui.builders}`} /> : null}
      </div>
      {price?.status === 'SHORT' ? (
        <p className="pk-t-body pk-building-info__short">Need {ui.shortfall ?? UNKNOWN} more {currencyName(price.currency)}</p>
      ) : null}
    </div>
  );
}

function CreamChip({ icon, text, description }: { icon: string; text: string; description: string }): React.JSX.Element {
  return (
    <span className="pk-building-info__chip" role="img" aria-label={description}>
      <span aria-hidden="true"><PkIcon name={icon} size={icon === 'builder' ? 30 : 24} /><span className="pk-t-caption">{text}</span></span>
    </span>
  );
}

function Primary({ ui, load, on }: { ui: BuildingInfoUi; load: InfoLoad; on: BuildingInfoActions }): React.JSX.Element {
  const p = ui.primary;
  if (p.kind === 'MAX' && load === 'READY') {
    return (
      <div role="img" aria-label={[p.label, p.sub].filter(Boolean).join('. ')}>
        <PkPlate kind="CHARCOAL" blocksScene={false} className="pk-building-info__max">
          <span className="pk-t-primary pk-ol2" aria-hidden="true">{p.label}</span>
          {p.sub != null ? <span className="pk-t-small" aria-hidden="true">{p.sub}</span> : null}
        </PkPlate>
      </div>
    );
  }
  const state = p.state ?? 'ENABLED';
  const price = p.price ?? null;
  const look = infoPrimaryLook(load, p.kind, p.label, p.sub, state, p.reason ?? null, price);
  const tap = () => {
    switch (infoPrimaryTap(load, p.kind, state, price)) {
      case 'UPGRADE': on.onUpgrade(); break;
      case 'FINISH': on.onFinish(); break;
      case 'NEED_MORE': on.onGetMore(price?.currency ?? 'GEMS'); break;
      case 'EXPLAIN': on.onExplain?.(look.reason ?? 'Not available right now'); break;
      case 'NONE': break;
    }
  };
  const finish = p.kind === 'FINISH';
  return <PkPrimaryButton label={look.label} onClick={tap} verb={finish ? 'GOLD' : 'GREEN'}
    sub={look.sub} state={look.state} reason={look.reason} icon={!finish && look.state === 'ENABLED' ? 'shape:up' : null}
    price={finish && load === 'READY' ? price : null}
    onPrice={finish && price?.status === 'SHORT' ? () => on.onGetMore(price.currency) : null} />;
}
