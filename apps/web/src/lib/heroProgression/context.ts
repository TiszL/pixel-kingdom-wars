import { createContext, useContext } from 'react';
import type { useHeroProgression } from './useHeroProgression';
import type { HeroReviewInput } from './controller';

// Keep imports from consumers type-only: opening a building sheet must not
// create another journal/controller or import the provider's UI through a barrel.
export type HeroProgressionView = ReturnType<typeof useHeroProgression> & { begin(input: HeroReviewInput): void; openHistory(): void };
export const HeroProgressionContext = createContext<HeroProgressionView | null>(null);
export const useHeroProgressionView = () => useContext(HeroProgressionContext);
