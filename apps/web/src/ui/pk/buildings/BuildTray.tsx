/**
 * Props-only BUILD body (BuildTray.kt; buildings SPEC §3; accepted web P3 labelled scrolling tabs).
 * The owner supplies offers, reasons, art and routes. A card tap never places or purchases here.
 * F2c's SuppliesSheet is absent from base 3cbf0fcc: its owner may supply that body after composition.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { PkBadge, PkCloseSquare, PkTag } from '../Button';
import { PkIcon } from '../Icon';
import { priceDescription, UNKNOWN } from '../kitLogic';
import { PkPlate, PkSheetTitlePlate } from '../Plate';
import { PkPriceChip } from '../PriceChip';
import type { BadgeUi, PriceUi } from '../types';
import { cardPrice, cardTap, traySections } from './buildingsLogic';
import type { BuildCardUi, BuildSectionUi } from './buildingTypes';
import GrassWell from './GrassWell';
import './BuildTray.css';

/** Navigation identifiers from accepted P3, not a locally generated building catalogue. */
export const BUILD_TRAY_TABS = ['BUILDINGS', 'DEFENCES', 'TRAPS', 'HEROES', 'SUPPLIES', 'LAYOUTS'] as const;
export type BuildTrayTabId = typeof BUILD_TRAY_TABS[number];

export interface BuildTrayTabUi {
  id: BuildTrayTabId;
  icon?: string | null;
  locked?: boolean;
  badge?: BadgeUi | null;
}
export interface BuildUnavailableReasonUi { id: string; name: string; reason: string }
export interface BuildTrayUi {
  /** Optional art/badges/lock metadata; the six labels and their order are always present. */
  tabs?: readonly BuildTrayTabUi[];
  selectedTab: BuildTrayTabId;
  builders: string;
  buildersFree: boolean;
  sections: readonly BuildSectionUi[];
  firstTimeHint: boolean;
  focusType?: string | null;
  /** Supplied snapshot reason when no construction offers are available. */
  emptyReason: string | null;
  /** Missing server offers are explanations, never synthetic BuildCards. */
  unavailableReasons?: readonly BuildUnavailableReasonUi[];
}
export interface BuildTrayActions {
  onTab: (tab: BuildTrayTabId) => void;
  /** Called in every card state; the owning adapter routes using the accepted cardTap rule. */
  onCard: (type: string) => void;
  onClose: () => void;
  onBuilders: () => void;
}
export interface BuildTrayProps {
  ui: BuildTrayUi;
  on: BuildTrayActions;
  /** Mapper-owned art; names come directly from supplied card, section and tab records. */
  renderArt: (name: string, usage: 'card' | 'section' | 'tab') => ReactNode;
  /** F2c-owned presentation injected by the composed owner; never copied or reimplemented here. */
  suppliesContent?: ReactNode;
  suppliesUnavailableReason: string;
  /** Normally onTab(LAYOUTS) opens the existing editor. This optional body remains owner supplied. */
  layoutsContent?: ReactNode;
  /** Layout-owner availability, independent from the construction-offers empty reason. */
  layoutsUnavailableReason: string;
}

interface CardCue { type: string; kind: 'pulse' | 'shake'; tick: number }
/** Presentation gutter from native reveal(), not a game value. */
const REVEAL_GUTTER_PX = 8;

function reducedMotion(): boolean {
  return document.documentElement.dataset.motion === 'reduce'
    || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** Empty primitive slots must not resemble a loaded tab. The owner supplies valid non-primitive bodies. */
function suppliedBody(content: ReactNode, unavailableReason: string): ReactNode {
  const absent = content == null || typeof content === 'boolean' || (typeof content === 'string' && content.trim() === '');
  return absent ? <p className="pk-t-body" role="status">{unavailableReason}</p> : content;
}

export default function BuildTray({ ui, on, renderArt, suppliesContent, suppliesUnavailableReason, layoutsContent, layoutsUnavailableReason }: BuildTrayProps): React.JSX.Element {
  const id = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabsRef = useRef<HTMLDivElement>(null);
  const [cue, setCue] = useState<CardCue | null>(null);
  const sections = useMemo(() => traySections(ui.sections), [ui.sections]);
  const cueCard = useCallback((type: string, kind: CardCue['kind']) => {
    setCue((current) => ({ type, kind, tick: (current?.tick ?? 0) + 1 }));
  }, []);
  const reveal = useCallback((type: string) => {
    const viewport = scrollRef.current;
    const target = cardRefs.current.get(type);
    if (!viewport || !target) return;
    const top = Math.max(0, viewport.scrollTop + target.getBoundingClientRect().top
      - viewport.getBoundingClientRect().top - REVEAL_GUTTER_PX);
    viewport.scrollTo?.({ top, behavior: reducedMotion() ? 'auto' : 'smooth' });
    cueCard(type, 'pulse');
  }, [cueCard]);
  useEffect(() => {
    if (ui.focusType != null) reveal(ui.focusType);
  }, [ui.focusType, ui.selectedTab, reveal]);

  const tapCard = (card: BuildCardUi) => {
    switch (cardTap(card.state)) {
      case 'SHOW_REQUIRED': if (card.requires != null) reveal(card.requires); break;
      case 'EXPLAIN_LOCKED': cueCard(card.type, 'shake'); break;
      default: break;
    }
    on.onCard(card.type);
  };
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    switch (event.key) {
      case 'ArrowRight': next = (index + 1) % BUILD_TRAY_TABS.length; break;
      case 'ArrowLeft': next = (index + BUILD_TRAY_TABS.length - 1) % BUILD_TRAY_TABS.length; break;
      case 'Home': next = 0; break;
      case 'End': next = BUILD_TRAY_TABS.length - 1; break;
      default: return;
    }
    event.preventDefault();
    tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    on.onTab(BUILD_TRAY_TABS[next]!);
  };
  let cardIndex = 0;
  return (
    <section className="pk-build-tray" role="region" aria-label="BUILD" data-sheet-size="TALL">
      <PkPlate kind="WOOD" className="pk-build-tray__wood">
        <header className="pk-build-tray__header">
          <div role="heading" aria-level={2}><PkSheetTitlePlate ui={{ title: 'BUILD' }} /></div>
          <button type="button" className="pk-build-tray__builders interactive pk-focusable" onClick={on.onBuilders}
            aria-label={`Builders ${ui.builders}${ui.buildersFree ? ' free' : ''}. Opens builders`}>
            <PkPlate kind="VEIL"><span className="pk-build-tray__builders-copy" aria-hidden="true">
              <PkIcon name="builder" size={30} /><span className="pk-t-caption">{ui.builders}</span>
              {ui.buildersFree ? <span className="pk-t-small">free</span> : null}
            </span></PkPlate>
          </button>
          <PkCloseSquare onClick={on.onClose} contentDescription="Close build" />
        </header>
        <div className="pk-build-tray__tabs" role="tablist" aria-label="Build categories" ref={tabsRef}>
          {BUILD_TRAY_TABS.map((tabId, index) => {
            const tab = ui.tabs?.find((item) => item.id === tabId);
            const selected = tabId === ui.selectedTab;
            const spoken = [tabId, tab?.locked ? 'locked' : null, tab?.badge?.description].filter(Boolean).join(', ');
            return (
              <button type="button" role="tab" id={`${id}-${tabId}`} key={tabId} className="pk-build-tray__tab interactive pk-focusable"
                aria-label={spoken} aria-selected={selected} aria-controls={`${id}-panel`} tabIndex={selected ? 0 : -1}
                onClick={() => on.onTab(tabId)} onKeyDown={(event) => tabKey(event, index)}>
                {tab?.icon ? <span className="pk-build-tray__tab-art" data-locked={tab.locked ?? false} aria-hidden="true">
                  {renderArt(tab.icon, 'tab')}{tab.locked ? <PkIcon name="shape:lock" size={16} /> : null}
                </span> : null}
                <span className="pk-t-caption">{tabId}</span>
                {tab?.badge ? <PkBadge ui={tab.badge} className="pk-build-tray__tab-badge" /> : null}
              </button>
            );
          })}
        </div>
        <PkPlate kind="PARCHMENT" className="pk-build-tray__parchment">
          <div className="pk-build-tray__scroll" ref={scrollRef} data-build-scroll="" role="tabpanel"
            id={`${id}-panel`} aria-labelledby={`${id}-${ui.selectedTab}`} tabIndex={0}>
            {ui.selectedTab === 'SUPPLIES' ? suppliedBody(suppliesContent, suppliesUnavailableReason)
              : ui.selectedTab === 'LAYOUTS' ? suppliedBody(layoutsContent, layoutsUnavailableReason)
                : <div className="pk-build-tray__catalogue" key={ui.selectedTab}>
                  {ui.unavailableReasons?.map((reason) => <p key={reason.id} className="pk-t-body pk-build-tray__unavailable" data-unavailable-offer={reason.id}>
                    <strong>{reason.name}</strong> {reason.reason}
                  </p>)}
                  {sections.length === 0 ? <p className="pk-t-body" role="status">{ui.emptyReason ?? UNKNOWN}</p> : null}
                  {sections.map((section, sectionIndex) => (
                    <section key={section.id} data-build-section={section.id} aria-label={section.title} className="pk-build-tray__section">
                      <header className="pk-build-tray__section-head">
                        <span className="pk-build-tray__section-art" aria-hidden="true">{renderArt(section.icon, 'section')}</span>
                        <h3 className="pk-t-label">{section.title}</h3><span className="pk-t-small">{section.count}</span>
                      </header>
                      {ui.firstTimeHint && sectionIndex === 0 ? <p className="pk-t-small pk-build-tray__hint">Tap one to place it. You pay on PLACE.</p> : null}
                      <div className="pk-build-tray__grid">
                        {section.cards.map((card) => {
                          const index = cardIndex++;
                          return <BuildCard key={card.type} card={card} renderArt={renderArt} onClick={() => tapCard(card)}
                            cue={cue?.type === card.type ? cue : null} index={index}
                            cardRef={(node) => { if (node) cardRefs.current.set(card.type, node); else cardRefs.current.delete(card.type); }} />;
                        })}
                      </div>
                    </section>
                  ))}
                </div>}
          </div>
        </PkPlate>
      </PkPlate>
    </section>
  );
}

function BuildCard({ card, renderArt, onClick, cue, index, cardRef }: {
  card: BuildCardUi; renderArt: BuildTrayProps['renderArt']; onClick: () => void;
  cue: CardCue | null; index: number; cardRef: (node: HTMLButtonElement | null) => void;
}): React.JSX.Element {
  const normalizedPrice = cardPrice(card);
  // A custom description from the previous quote must not override normalized CHECKING/SHORT speech.
  const price = normalizedPrice != null && (card.state === 'CHECKING' || (card.state === 'SHORT' && card.price?.status === 'OK'))
    ? { ...normalizedPrice, description: null } : normalizedPrice;
  const pricedState = card.state === 'AVAILABLE' || card.state === 'SHORT' || card.state === 'CHECKING';
  const spoken = [card.name, card.count, card.purpose, pricedState ? price ? priceDescription(price) : null : card.reason,
    price && card.time != null ? `takes ${card.time}` : null, card.isNew ? 'new' : null].filter((value) => value != null).join('. ');
  const locked = card.state === 'LOCKED';
  return (
    <div className="pk-build-tray__card-wrap" data-staggered={index < 6} style={{ '--pk-build-card-i': index } as CSSProperties}>
      <button type="button" className="pk-build-tray__card interactive pk-focusable" data-build-type={card.type} data-state={card.state}
        data-cue={cue?.kind} aria-label={spoken} onClick={onClick} ref={cardRef}>
        <div className="pk-build-tray__card-motion" data-cue={cue?.kind} key={cue ? `${cue.kind}:${cue.tick}` : 'still'} aria-hidden="true">
          <PkPlate kind="CREAM" className="pk-build-tray__card-plate">
            <div className="pk-build-tray__well">
              <GrassWell>
                <span className="pk-build-tray__art" data-locked={locked}>{renderArt(card.art, 'card')}</span>
                {locked ? <span className="pk-build-tray__lock"><PkIcon name="shape:lock" size={38} tint="gold" /></span> : null}
                <span className="pk-build-tray__count"><PkTag text={card.count} verb={locked ? 'STONE' : card.countTone} /></span>
              </GrassWell>
            </div>
            <span className="pk-t-label pk-build-tray__card-name">{card.name}</span>
            <span className="pk-t-small pk-build-tray__purpose">{card.purpose}</span>
            <CardFooter card={card} price={price} />
          </PkPlate>
        </div>
      </button>
      {card.isNew ? <PkBadge ui={{ text: 'NEW', tone: 'REWARD', description: 'New building' }} className="pk-build-tray__new" /> : null}
    </div>
  );
}

function CardFooter({ card, price }: { card: BuildCardUi; price: PriceUi | null }): React.JSX.Element {
  switch (card.state) {
    case 'AVAILABLE':
    case 'SHORT':
    case 'CHECKING': return <div className="pk-build-tray__footer">
      {price ? <PkPriceChip ui={price} /> : <span className="pk-t-caption">{UNKNOWN}</span>}
      {card.time != null ? <span className="pk-build-tray__time pk-t-caption"><PkIcon name="timer" size={24} />{card.time}</span> : null}
    </div>;
    case 'MAX': return <div className="pk-build-tray__footer"><PkTag text="MAX" verb="STONE" />
      {card.reason != null ? <span className="pk-t-small">{card.reason}</span> : null}</div>;
    case 'REQUIRES':
    case 'LOCKED':
    case 'UNAVAILABLE': return <div className="pk-build-tray__footer"><span className="pk-build-tray__reason pk-t-small">
      <PkIcon name="shape:lock" size={24} tint="gold" />{card.reason ?? UNKNOWN}</span></div>;
  }
}
