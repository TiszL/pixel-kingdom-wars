import { ApiError } from './api';
export type CustodyRefusal = 'frozen' | 'closing';

/** Machine codes only; a translated server message is never a capability. */
export function custodyRefusal(error: unknown): CustodyRefusal | null {
  if (!(error instanceof ApiError) || error.status !== 423) return null;
  return error.code === 'KEEP_CUSTODY_FROZEN' ? 'frozen' : error.code === 'KEEP_CUSTODY_CLOSING' ? 'closing' : null;
}
export function deedRequiredRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409
    && (error.code === 'KEEP_EQUIPMENT_MARKET_DEED_REQUIRED' || error.code === 'DEED_REQUIRED_TO_TRADE');
}
/** Disable first, refresh once, never retry the mutation. Preserve the original
 * server error if the read fails too. Global base-selection errors are handled
 * solely by api.ts and deliberately do not enter this path. */
export async function refreshCustodyRefusal(error: unknown, disable: (phase: CustodyRefusal) => void,
  refresh: () => Promise<unknown>): Promise<boolean> {
  const phase = custodyRefusal(error);
  if (!phase) return false;
  disable(phase);
  try { await refresh(); } catch { /* Keep the action disabled and the original refusal visible. */ }
  return true;
}
