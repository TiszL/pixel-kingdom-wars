/** @vitest-environment happy-dom */
/**
 * A crash the boundary catches is still a crash: it used to be visible only in
 * the player's own devtools, so overlay bugs never reached Sentry at all
 * (audit 2026-09-05 WEB-01). The boundary must report through the same
 * denylisted, de-duplicated path as window errors — name/message/screen, no
 * stack — and still recover the UI.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  captureError: vi.fn(),
  setScreen: vi.fn(),
  state: { screen: 'raid', base: null as unknown, setScreen: vi.fn() },
}));
vi.mock('../lib/analytics', () => ({ captureError: h.captureError }));
vi.mock('../state/store', () => ({ useApp: { getState: () => h.state } }));

import { ErrorBoundary } from './ErrorBoundary';

function Boom({ when }: { when: boolean }): React.JSX.Element {
  if (when) throw new TypeError('hooks order changed');
  return <div>fine</div>;
}

let root: Root | null = null;
beforeEach(() => {
  h.captureError.mockReset();
  h.state.setScreen.mockReset();
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

describe('ErrorBoundary', () => {
  it('reports the caught render crash with boundary + screen and shows the recovery panel', async () => {
    await act(async () => { root!.render(<ErrorBoundary><Boom when /></ErrorBoundary>); });
    expect(document.body.textContent).toContain('SOMETHING BROKE');
    expect(h.captureError).toHaveBeenCalledTimes(1);
    expect(h.captureError).toHaveBeenCalledWith('error', {
      message: 'hooks order changed', name: 'TypeError', source: 'react-boundary', boundary: 'overlay', screen: 'raid',
    });
    // Recovery still routes to a safe screen first (title with no base loaded).
    const button = document.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('recovery button missing');
    await act(async () => { button.click(); });
    expect(h.state.setScreen).toHaveBeenCalledWith('title');
  });

  it('reports nothing while children render', async () => {
    await act(async () => { root!.render(<ErrorBoundary><Boom when={false} /></ErrorBoundary>); });
    expect(document.body.textContent).toContain('fine');
    expect(h.captureError).not.toHaveBeenCalled();
  });
});
