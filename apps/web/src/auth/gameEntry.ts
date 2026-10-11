import { create } from 'zustand';

/** Shared by the title and paid-land recovery surface; no second wallet proof
 * is needed merely because authenticated game hydration failed. */
export const useGameEntryState = create<{ busy: boolean; error: string | null }>(() => ({ busy: false, error: null }));
export interface GameEntryResult { ok: boolean }
