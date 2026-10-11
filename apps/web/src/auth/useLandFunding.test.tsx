/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LandReservation } from './useEntry';

const h = vi.hoisted(() => ({ connection: {}, prepare: vi.fn() }));
vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection: h.connection }) }));
vi.mock('./landPayment', () => ({ prepareLandPayment: h.prepare }));
import { useLandFunding } from './useLandFunding';

const KEY = '11111111111111111111111111111111';
let root: Root;
let host: HTMLDivElement;
let result: ReturnType<typeof useLandFunding>;
function Harness({ wallet, reference }: { wallet: string; reference: string }) {
  result = useLandFunding(wallet, { id: 'reservation', reference, kind: 'entry', amountLamports: 200_000_000 } as LandReservation);
  return <output>{result.unavailable ? 'unavailable' : result.estimate ? 'ready' : 'checking'}</output>;
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); h.prepare.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

it.each([
  { wallet: 'invalid wallet', reference: KEY },
  { wallet: KEY, reference: 'invalid reference' },
])('keeps checkout recoverable when a public key is malformed: %j', async (props) => {
  // A bad cache/server value must show an unknown estimate, never crash checkout.
  await act(async () => root.render(<Harness {...props} />));
  expect(host.textContent).toBe('unavailable');
  expect(h.prepare).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('ignores a late estimate after the player switches wallets', async () => {
  let resolveOld!: (value: unknown) => void;
  h.prepare.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  await act(async () => root.render(<Harness wallet={KEY} reference={KEY} />));
  await act(async () => root.render(<Harness wallet="invalid wallet" reference={KEY} />));
  await act(async () => resolveOld({ estimate: { requiredLamports: 1, balanceLamports: 1 } }));
  expect(host.textContent).toBe('unavailable');
  expect(result.estimate).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
