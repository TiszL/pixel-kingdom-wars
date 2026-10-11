import { LAND_CHECKOUT_RECOVERY, MARKETPLACE } from '@shardkeep/shared';
import { useConnection } from '@solana/wallet-adapter-react';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useApp } from '../state/store';
import { useGameWallet } from './useGameWallet';
import { MarketJournalStore } from '../lib/market/journal';
import { MarketController, type MarketControllerState } from '../lib/market/controller';
import { createMarketBrowserPorts, marketIdentity } from '../lib/market/browser';

const EMPTY: MarketControllerState = { loaded: false, busy: false, journal: null, error: null, networkFee: null };
const emptySnapshot = (): MarketControllerState => EMPTY;
const emptySubscribe = (): (() => void) => () => undefined;
type ConfirmationStart = { elapsed: number; wall: number };
export function marketConfirmationWithinWindow(start: ConfirmationStart | null, now: ConfirmationStart): boolean {
  return start !== null && now.elapsed >= start.elapsed && now.wall >= start.wall
    && Math.max(now.elapsed - start.elapsed, now.wall - start.wall) < MARKETPLACE.itemMarket.settleTimeoutSec * 1000;
}
const now = (): ConfirmationStart => ({ elapsed: performance.now(), wall: Date.now() });

/** Screen lifetime owns observations, never the durable receipt. Opening/return
 * is GET-only; only an explicit Pay/Check starts bounded original settlement. */
export function useMarketRecovery(): {
  controller: MarketController | null;
  state: MarketControllerState;
  pay(): Promise<void>;
  check(): Promise<void>;
} {
  const account = useApp((s) => s.wallet);
  const wallet = useGameWallet(); const signer = useRef(wallet);
  useEffect(() => { signer.current = wallet; }, [wallet]);
  const { connection } = useConnection();
  const owned = useMemo(() => {
    if (!account) return null;
    const lifecycle = { active: true, visible: document.visibilityState !== 'hidden', epoch: 0 };
    const store = new MarketJournalStore(marketIdentity(account));
    const handoff = { active: false };
    const ports = createMarketBrowserPorts({ identity: store.identity,
      connection, wallet: () => signer.current, lifecycle: () => lifecycle });
    const sign = ports.sign;
    ports.sign = async (payment, buyer) => {
      handoff.active = true;
      try { return await sign(payment, buyer); } finally { handoff.active = false; }
    };
    const controller = new MarketController(store, ports);
    return { store, controller, lifecycle, handoff, confirmingStarted: null as ConfirmationStart | null };
  }, [account, connection]);
  const controller = owned?.controller ?? null;
  const state = useSyncExternalStore(controller?.subscribe ?? emptySubscribe, controller?.snapshot ?? emptySnapshot);
  useEffect(() => {
    if (!owned) return;
    owned.lifecycle.active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observe = async (): Promise<void> => {
      if (!owned.lifecycle.active) return;
      if (owned.lifecycle.visible && !owned.controller.snapshot().busy) {
        const purchase = owned.controller.snapshot().journal?.purchase;
        const settling = purchase?.attempted && ['reserved', 'committed'].includes(purchase.receipt.state);
        if (settling && marketConfirmationWithinWindow(owned.confirmingStarted, now())) await owned.controller.recoverPayment();
        else if (settling) await owned.controller.open();
        if (owned.controller.snapshot().error) owned.confirmingStarted = null;
      }
      if (owned.lifecycle.active) timer = setTimeout(() => { void observe(); }, LAND_CHECKOUT_RECOVERY.pollMs);
    };
    const visibility = (): void => {
      owned.lifecycle.visible = document.visibilityState !== 'hidden';
      // Leaving an unpaid review invalidates it. A deliberate external wallet
      // handoff may hide this page; its return still must pass the core's fresh
      // receipt, auth, wall/elapsed deadline and visible-page guards.
      if (!owned.lifecycle.visible && !owned.handoff.active) owned.lifecycle.epoch += 1;
      if (owned.lifecycle.visible && !owned.controller.snapshot().busy) void owned.controller.open();
    };
    const suspend = (): void => { owned.lifecycle.epoch += 1; owned.confirmingStarted = null; };
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('freeze', suspend); window.addEventListener('pagehide', suspend);
    void owned.controller.open().then(() => { if (owned.lifecycle.active) timer = setTimeout(() => { void observe(); }, LAND_CHECKOUT_RECOVERY.pollMs); });
    return () => {
      owned.lifecycle.active = false; owned.lifecycle.epoch += 1; owned.confirmingStarted = null;
      clearTimeout(timer); document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('freeze', suspend); window.removeEventListener('pagehide', suspend);
      // Let a pending sign-only callback persist its public signature before
      // closing IDB. StrictMode's immediate effect remount does not close it.
      queueMicrotask(() => {
        if (owned.lifecycle.active) return;
        if (!owned.controller.snapshot().busy) { void owned.store.close().catch(() => undefined); return; }
        const stop = owned.controller.subscribe(() => {
          if (!owned.controller.snapshot().busy) { stop(); if (!owned.lifecycle.active) void owned.store.close().catch(() => undefined); }
        });
      });
    };
  }, [owned]);
  const explicit = async (pay: boolean): Promise<void> => {
    if (!owned) return;
    owned.confirmingStarted = now();
    if (pay) await owned.controller.pay(); else await owned.controller.recoverPayment();
    if (owned.controller.snapshot().error) owned.confirmingStarted = null;
  };
  return { controller, state, pay: () => explicit(true), check: () => explicit(false) };
}
