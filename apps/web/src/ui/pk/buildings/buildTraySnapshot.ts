/**
 * UNBOUND BUILD projection approved by review e0f48b9f (2026-10-04).
 * No live producer exists on the pinned base. Inputs below are an explicit normalization boundary, not an API DTO.
 * The future owner supplies authoritative offers, categories, availability, prices, count labels and missing reasons.
 * This module does not discover types, read constants/catalogues, infer offers, compute caps/costs, or invent reasons.
 */
import type { BuildTrayTabId, BuildTrayTabUi, BuildTrayUi } from './BuildTray';
import type { BuildCardState, BuildCardUi, BuildSectionUi } from './buildingTypes';

/** Count is the supplied owned/cap/count label. No local counting or cap arithmetic occurs here.
 * UNAVAILABLE is an explicit record with a required reason; an absent record is never turned into a card. */
export type BuildTrayOfferFact = Readonly<Omit<BuildCardUi, 'state' | 'reason'>> & (
  | { readonly status: 'OFFERED'; readonly state: BuildCardState; readonly reason: string | null }
  | { readonly status: 'UNAVAILABLE'; readonly reason: string }
  | { readonly status: 'UNKNOWN'; readonly reason: string | null }
);

/** Supplied category metadata and order are preserved, including the count label. */
export interface BuildTrayCategoryFact extends Readonly<Omit<BuildSectionUi, 'cards'>> {
  readonly tab: BuildTrayTabId;
  readonly offers: readonly BuildTrayOfferFact[];
}

/** Missing offers are explanations only. Reasons and names must be supplied by the future authoritative producer. */
export interface BuildTrayMissingOfferFact {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
  readonly tab: BuildTrayTabId;
}

export interface BuildTraySnapshotFacts {
  readonly selectedTab: BuildTrayTabId;
  readonly categories: readonly BuildTrayCategoryFact[];
  readonly missingOffers: readonly BuildTrayMissingOfferFact[];
  readonly builders: string;
  readonly buildersFree: boolean;
  readonly firstTimeHint: boolean;
  readonly focusType: string | null;
  /** Optional visual metadata; the six navigation labels are fixed by accepted P3. */
  readonly tabs?: readonly BuildTrayTabUi[];
  readonly emptyReason: string | null;
  /** Separate owner-supplied fallback bodies, required by 2223dbad and 80bc41c6. */
  readonly suppliesUnavailableReason: string;
  readonly layoutsUnavailableReason: string;
}

export interface BuildTraySnapshot {
  readonly ui: BuildTrayUi;
  readonly suppliesUnavailableReason: string;
  readonly layoutsUnavailableReason: string;
}

// Presentation navigation only. Type-only imports keep this pure mapper from loading the React BUILD chunk.
const TABS: readonly BuildTrayTabId[] = ['BUILDINGS', 'DEFENCES', 'TRAPS', 'HEROES', 'SUPPLIES', 'LAYOUTS'];

/** UNBOUND: only projects supplied records; the live producer is explicitly post-demo and outside W4 scope. */
export function buildTraySnapshot(facts: BuildTraySnapshotFacts): BuildTraySnapshot {
  return {
    ui: {
      tabs: TABS.map(id => {
        const metadata = facts.tabs?.find(tab => tab.id === id);
        return metadata ? { ...metadata, ...(metadata.badge ? { badge: { ...metadata.badge } } : {}) } : { id };
      }),
      selectedTab: facts.selectedTab,
      builders: facts.builders,
      buildersFree: facts.buildersFree,
      firstTimeHint: facts.firstTimeHint,
      focusType: facts.focusType,
      emptyReason: facts.emptyReason,
      sections: facts.categories.filter(category => category.tab === facts.selectedTab).map(category => ({
        id: category.id,
        title: category.title,
        icon: category.icon,
        count: category.count,
        cards: category.offers.map(projectOffer),
      })),
      unavailableReasons: facts.missingOffers.filter(missing => missing.tab === facts.selectedTab)
        .map(({ id, name, reason }) => ({ id, name, reason })),
    },
    suppliesUnavailableReason: facts.suppliesUnavailableReason,
    layoutsUnavailableReason: facts.layoutsUnavailableReason,
  };
}

function projectOffer(offer: BuildTrayOfferFact): BuildCardUi {
  return {
    type: offer.type,
    name: offer.name,
    purpose: offer.purpose,
    art: offer.art,
    count: offer.count,
    countTone: offer.countTone,
    state: projectOfferState(offer),
    // The existing PriceChip contract masks a stale amount when a supplied record is UNKNOWN.
    price: offer.price == null ? null : { ...offer.price, ...(offer.status === 'UNKNOWN' ? { status: 'CHECKING' as const } : {}) },
    time: offer.time,
    reason: offer.reason,
    isNew: offer.isNew,
    requires: offer.requires,
  };
}

/** 554c60eb: reconcile only navigable OFFERED states with the supplied price; keep all other precedence. */
function projectOfferState(offer: BuildTrayOfferFact): BuildCardState {
  if (offer.status === 'UNAVAILABLE') return 'UNAVAILABLE';
  if (offer.status === 'UNKNOWN') return 'CHECKING';
  if (offer.state !== 'AVAILABLE' && offer.state !== 'CHECKING' && offer.state !== 'SHORT') return offer.state;
  const price = offer.price;
  if (price == null) return 'CHECKING';
  if (price.status === 'UNAVAILABLE') return 'UNAVAILABLE';
  if (price.status === 'CHECKING') return 'CHECKING';
  if (price.status === 'SHORT') return 'SHORT';
  if (price.status === 'OK' && !price.amount?.trim()) return 'CHECKING';
  return offer.state;
}
