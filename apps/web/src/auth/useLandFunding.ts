import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useState } from 'react';
import type { LandReservation } from './useEntry';
import { prepareLandPayment, type LandFundingEstimate } from './landPayment';

/** A failed estimate stays unknown. Every PAY still performs a fresh read. */
export function useLandFunding(wallet: string | null, reservation: LandReservation | null) {
  const { connection } = useConnection();
  const identity = wallet && reservation ? `${wallet}:${reservation.id}` : null;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    identity: string | null; estimate: LandFundingEstimate | null; unavailable: boolean;
  }>({ identity: null, estimate: null, unavailable: false });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!wallet || !reservation || !identity) return;
    let live = true;
    setResult({ identity, estimate: null, unavailable: false });
    const timer = setTimeout(() => {
      live = false;
      setResult({ identity, estimate: null, unavailable: true });
    }, LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
    void Promise.resolve().then(() => prepareLandPayment(
      connection, new PublicKey(wallet), new PublicKey(reservation.reference), reservation,
    ))
      .then(({ estimate }) => { if (live) setResult({ identity, estimate, unavailable: false }); })
      .catch(() => { if (live) setResult({ identity, estimate: null, unavailable: true }); })
      .finally(() => clearTimeout(timer));
    return () => { live = false; clearTimeout(timer); };
  }, [connection, wallet, identity, reservation?.reference, reservation?.kind, reservation?.amountLamports, revision]);
  return { estimate: result.identity === identity ? result.estimate : null,
    unavailable: result.identity === identity && result.unavailable, refresh };
}
