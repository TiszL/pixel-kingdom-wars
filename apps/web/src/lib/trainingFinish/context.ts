import { createContext, useContext } from 'react';
import type { useTrainingFinish } from './useTrainingFinish';
import type { TrainingReviewInput } from './controller';

// Keep imports from consumers type-only: opening a building sheet must not
// create another journal/controller or import the provider's UI through a barrel.
export type TrainingFinishView = ReturnType<typeof useTrainingFinish> & { begin(input: TrainingReviewInput): void; openHistory(): void };
export const TrainingFinishContext = createContext<TrainingFinishView | null>(null);
export const useTrainingFinishView = () => useContext(TrainingFinishContext);
