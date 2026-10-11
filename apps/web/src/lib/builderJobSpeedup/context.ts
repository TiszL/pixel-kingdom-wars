import { createContext, useContext } from 'react';
import type { useBuilderJobSpeedup } from './useBuilderJobSpeedup';
import type { BuilderReviewInput } from './controller';

// Keep imports from consumers type-only: opening a building sheet must not
// create another journal/controller or import the provider's UI through a barrel.
export type BuilderJobSpeedupView = ReturnType<typeof useBuilderJobSpeedup> & { begin(input: BuilderReviewInput): void; openHistory(): void };
export const BuilderJobSpeedupContext = createContext<BuilderJobSpeedupView | null>(null);
export const useBuilderJobSpeedupView = () => useContext(BuilderJobSpeedupContext);
