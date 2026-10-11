/** @vitest-environment happy-dom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMobileBackGuard, type MobileBackHistory, type MobileBackWindow,
  useMobileBackHandler,
} from '../lib/mobileBackGuard';
import { MobileBackConfirm } from './MobileBackConfirm';

class BackWindow extends EventTarget implements MobileBackWindow {
  readonly location = { href: 'https://play.pixelkingdomwars.com/?client=solana-mobile' };
  private entries: unknown[] = [{ page: 'game' }];
  private cursor = 0;
  readonly history: MobileBackHistory;

  constructor() {
    super();
    const owner = this;
    this.history = {
      get state() { return owner.entries[owner.cursor]; },
      pushState(data) {
        owner.entries.splice(owner.cursor + 1);
        owner.entries.push(data);
        owner.cursor = owner.entries.length - 1;
      },
      back() {
        if (owner.cursor === 0) return;
        owner.cursor -= 1;
        owner.dispatchEvent(new Event('popstate'));
      },
    };
  }

  setTimeout(handler: () => void, timeout: number): number {
    return window.setTimeout(handler, timeout);
  }
  clearTimeout(id: number): void { window.clearTimeout(id); }
}

function Harness(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  // This is the underlying dirty surface. If it wins the second Back it will
  // simply reopen the already-open confirmation—the regression under test.
  useMobileBackHandler(() => { setOpen(true); return true; }, true, 140);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>OPEN</button>
      {open && (
        <MobileBackConfirm
          title="RETREAT?"
          body="Deployed troops and raid energy remain spent."
          confirmLabel="RETREAT"
          onConfirm={() => undefined}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}

describe('MobileBackConfirm Back ownership', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('open then Back closes the confirmation instead of reopening it', async () => {
    await act(async () => root.render(<Harness />));
    const open = host.querySelector('button');
    await act(async () => open!.click());
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();

    const backWindow = new BackWindow();
    const goToBase = vi.fn();
    const dispose = createMobileBackGuard({
      win: backWindow,
      enabled: true,
      trustedActivation: () => true,
      getScreen: () => 'battle',
      goToBase,
      toast: vi.fn(),
    });
    backWindow.dispatchEvent(new Event('pointerdown'));
    await act(async () => backWindow.history.back());

    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(goToBase).not.toHaveBeenCalled();
    dispose();
  });
});
