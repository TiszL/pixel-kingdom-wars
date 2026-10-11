import { createContext, useContext } from 'react';
import type { useResearchSpeedup } from './useResearchSpeedup';
import type { ResearchReviewInput } from './controller';

// Keep imports from consumers type-only: opening a building sheet must not
// create another journal/controller or import the provider's UI through a barrel.
export type ResearchSpeedupView = ReturnType<typeof useResearchSpeedup> & { begin(input: ResearchReviewInput): void; openHistory(): void };
export const ResearchSpeedupContext = createContext<ResearchSpeedupView | null>(null);
export const useResearchSpeedupView = () => useContext(ResearchSpeedupContext);
