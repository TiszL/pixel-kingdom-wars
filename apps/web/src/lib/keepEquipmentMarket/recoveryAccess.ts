import { createContext } from 'react';
/** Only the host's ordinary mutation permission can allow an already-signed
 * Market obligation to finish from history. This grants no new order/signature. */
export const MarketHistoryRecovery = createContext(false);
