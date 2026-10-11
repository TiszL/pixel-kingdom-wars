/** @vitest-environment happy-dom */
/**
 * The game boundary catches exactly two things: a stale tab's chunk-load
 * failure after a deploy (noise the denylist drops) and a real canvas boot
 * crash (a bug). Both must be handed to the relay so the DENYLIST decides —
 * not this component — and the reload panel must still render.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock('../lib/analytics', () => ({ captureError: h.captureError }));
vi.mock('../state/store', () => ({ useApp: { getState: () => ({ screen: 'loading' }) } }));

import { GameLoadBoundary } from './GameLoadBoundary';

function FailedImport(): React.JSX.Element {
  throw new TypeError('Failed to fetch dynamically imported module: https://play.pixelkingdomwars.com/assets/PhaserGame-AbCd1234.js');
}

let root: Root | null = null;
beforeEach(() => {
  h.captureError.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('GameLoadBoundary', () => {
  it('hands the failed import to the relay (denylist decides) and shows the reload panel', async () => {
    await act(async () => { root!.render(<GameLoadBoundary><FailedImport /></GameLoadBoundary>); });
    expect(document.body.textContent).toContain('Couldn’t load your kingdom');
    expect(h.captureError).toHaveBeenCalledTimes(1);
    expect(h.captureError).toHaveBeenCalledWith('error', expect.objectContaining({
      name: 'TypeError', source: 'react-boundary', boundary: 'game', screen: 'loading',
    }));
    expect(String(h.captureError.mock.calls[0]![1].message)).toContain('dynamically imported module');
  });
});
