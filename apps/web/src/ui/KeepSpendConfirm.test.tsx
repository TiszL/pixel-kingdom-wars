/** @vitest-environment happy-dom */
/**
 * The KEEP confirmation's own contract (player report 2026-08-29). The per-screen
 * suites pin that every KEEP speed-up routes through this dialog; these pin what
 * the dialog itself must guarantee, because each rule below is a way the guard
 * could exist and still fail the player who reported it:
 *
 *  - asking must be the DEFAULT, or the fix ships off;
 *  - the amount shown is the caller's quote, verbatim — a dialog that rounds or
 *    re-derives the price is a new lie about money;
 *  - the KEEP price must be told apart from a shard cost at a glance (the
 *    report's second half: "so players do not confuse it with normal resources");
 *  - CANCEL must be the big, easy target and must run nothing;
 *  - DON'T ASK AGAIN must persist only on CONFIRM, and must be reversible.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEP_CONFIRM_KEY, keepConfirmOn, setKeepConfirm } from '../lib/keepConfirm';
import { KeepSpendConfirmDialog, useKeepSpendConfirm } from './KeepSpendConfirm';

let host: HTMLDivElement;
let root: Root;

const dialog = (): HTMLElement => {
  const found = document.querySelector('[role="alertdialog"]');
  if (!found) throw new Error('the KEEP confirmation did not render');
  return found as HTMLElement;
};
function dialogBtn(label: string): HTMLButtonElement {
  const found = [...dialog().querySelectorAll('button')]
    .find((button) => button.textContent?.includes(label));
  if (!found) throw new Error(`no ${label} button in the KEEP confirmation`);
  return found;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('the ask-first preference', () => {
  it('defaults ON — a money guard that ships opted-out is the reported bug again', () => {
    expect(keepConfirmOn()).toBe(true);
  });

  it('is reversible in both directions (the profile switch turns it back on)', () => {
    setKeepConfirm(false);
    expect(localStorage.getItem(KEEP_CONFIRM_KEY)).toBe('0');
    expect(keepConfirmOn()).toBe(false);
    setKeepConfirm(true);
    expect(keepConfirmOn()).toBe(true);
  });
});

describe('the dialog', () => {
  const render = async (
    intent: {
      costKeep: number | string; what: string; immediate?: boolean; onConfirm: () => void;
    },
    onCancel = vi.fn(),
  ): Promise<void> => {
    await act(async () => root.render(
      <KeepSpendConfirmDialog
        intent={intent}
        onCancel={onCancel}
        onConfirm={intent.onConfirm} />,
    ));
  };

  it('states the caller\'s exact cost and what it buys, and never re-derives it', async () => {
    await render({ costKeep: 250, what: 'FINISH THIS UPGRADE', onConfirm: vi.fn() });
    expect(dialog().textContent).toContain('SPEND 250 KEEP TO FINISH THIS UPGRADE IMMEDIATELY?');
    // A server-sent bigint string is passed through the shared thousands
    // formatter, not parsed into a float that could lose the last digits.
    await render({ costKeep: '1234567', what: 'RECOVER VEX', onConfirm: vi.fn() });
    expect(dialog().textContent).toContain('SPEND 1,234,567 KEEP TO RECOVER VEX IMMEDIATELY?');
  });

  it('keeps a long quoted amount exact in its own display and the explicit KEEP confirmation', async () => {
    const spend = vi.fn();
    await render({ costKeep: '184377600000', what: 'FINISH THIS UPGRADE', onConfirm: spend });
    expect(dialog().querySelector('[data-keep-spend-amount]')?.textContent).toBe('184,377,600,000');
    expect(dialog().querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('184,377,600,000 KEEP');
    expect(dialogBtn('CONFIRM').textContent).toContain('184,377,600,000 KEEP');
    expect(spend).not.toHaveBeenCalled();
    await act(async () => dialogBtn('CONFIRM').click());
    expect(spend).toHaveBeenCalledOnce();
  });

  it('drops "IMMEDIATELY" for a spend that hurries nothing (a hero level)', async () => {
    // Every speed-up caller buys TIME, so the default wording stays. A hero
    // upgrade (owner 2026-08-29) is a purchase: saying it happens "immediately"
    // would promise a slower free path to the same level that does not exist.
    await render({
      costKeep: '532000', what: 'UPGRADE VEX TO LEVEL 12', immediate: false, onConfirm: vi.fn(),
    });
    expect(dialog().textContent).toContain('SPEND 532,000 KEEP TO UPGRADE VEX TO LEVEL 12?');
    expect(dialog().textContent).not.toContain('IMMEDIATELY');
  });

  it('marks the cost as KEEP, not a resource: token art at headline size plus the word', async () => {
    await render({ costKeep: 250, what: 'FINISH THIS UPGRADE', onConfirm: vi.fn() });
    // Shard/KEEP costs on the buttons that opened this dialog are 13-14px icons.
    // The confirmation has to out-shout them or it teaches nothing.
    const keepArt = [...dialog().querySelectorAll('img')]
      .filter((img) => Number(img.getAttribute('width')) >= 20);
    expect(keepArt.length).toBeGreaterThan(0);
    expect(dialog().textContent).toContain('KEEP IS THE HARD CURRENCY — NOT SHARDS.');
  });

  it('gives CANCEL the larger touch target, and both rows clear the 48px minimum', async () => {
    await render({ costKeep: 250, what: 'FINISH THIS UPGRADE', onConfirm: vi.fn() });
    // happy-dom does not lay out, so the guarantee is pinned at its source: the
    // declared minimum height. CANCEL is the safe default, so it is the bigger
    // of the two and sits BELOW confirm — the region a stray second tap from
    // the (low-on-screen) FINISH button lands in.
    const cancel = dialogBtn('CANCEL');
    const confirm = dialogBtn('CONFIRM');
    expect(Number.parseInt(confirm.style.minHeight, 10)).toBeGreaterThanOrEqual(48);
    expect(Number.parseInt(cancel.style.minHeight, 10))
      .toBeGreaterThan(Number.parseInt(confirm.style.minHeight, 10));
    expect(cancel.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_PRECEDING)
      .toBeTruthy();
  });

  it('CANCEL runs the caller\'s cancel and never its spend', async () => {
    const spend = vi.fn();
    const cancel = vi.fn();
    await render({ costKeep: 250, what: 'FINISH THIS UPGRADE', onConfirm: spend }, cancel);
    await act(async () => dialogBtn('CANCEL').click());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(spend).not.toHaveBeenCalled();
  });

  it('CONFIRM runs the spend exactly once', async () => {
    const spend = vi.fn();
    await render({ costKeep: 250, what: 'FINISH THIS UPGRADE', onConfirm: spend });
    await act(async () => dialogBtn('CONFIRM').click());
    expect(spend).toHaveBeenCalledTimes(1);
  });

  it("does not persist DON'T ASK AGAIN when the player cancels", async () => {
    // Backing out of a purchase must never be the thing that silently removes
    // the warning from the NEXT one.
    await render({ costKeep: 250, what: 'FINISH THIS UPGRADE', onConfirm: vi.fn() }, vi.fn());
    await act(async () => (dialog().querySelector('span.interactive') as HTMLElement).click());
    await act(async () => dialogBtn('CANCEL').click());
    expect(keepConfirmOn()).toBe(true);
  });

  it("persists DON'T ASK AGAIN on CONFIRM", async () => {
    await render({ costKeep: 250, what: 'FINISH THIS UPGRADE', onConfirm: vi.fn() });
    await act(async () => (dialog().querySelector('span.interactive') as HTMLElement).click());
    await act(async () => dialogBtn('CONFIRM').click());
    expect(keepConfirmOn()).toBe(false);
  });

  it('leaves the preference alone when the switch is untouched', async () => {
    await render({ costKeep: 250, what: 'FINISH THIS UPGRADE', onConfirm: vi.fn() });
    await act(async () => dialogBtn('CONFIRM').click());
    expect(keepConfirmOn()).toBe(true);
  });
});

describe('a purchase WARNING is shown to everyone (duplicate hero contract, tester report 2026-09-16)', () => {
  // WHY: the opt-out was consent to skip "you are spending KEEP", not consent
  // to skip "this buys a COPY of a hero you already have". A warning intent
  // therefore renders first, in the danger colour, and `always` opens the
  // dialog even for an opted-out player.
  it('renders the warning line above the spend question', async () => {
    const onConfirm = vi.fn();
    await act(async () => root.render(<KeepSpendConfirmDialog
      intent={{ costKeep: 3_000, what: 'BUY AN UNUSED COPY OF HERO CONTRACT: VEX', immediate: false,
        warning: 'VEX IS ALREADY RECRUITED HERE. THIS BUYS AN UNUSED TRADEABLE COPY FOR YOUR BAG (BAG LIMIT 1). CONTINUE?', onConfirm }}
      onCancel={vi.fn()} onConfirm={onConfirm} />));
    const warning = dialog().querySelector('[data-keep-spend-warning]');
    expect(warning?.textContent).toContain('VEX IS ALREADY RECRUITED HERE');
    expect(dialog().textContent?.indexOf('VEX IS ALREADY RECRUITED HERE'))
      .toBeLessThan(dialog().textContent?.indexOf('SPEND 3,000 KEEP TO') ?? -1);
    expect(dialog().textContent).toContain('SPEND 3,000 KEEP TO BUY AN UNUSED COPY OF HERO CONTRACT: VEX?');
    await act(async () => dialogBtn('CONFIRM').click());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('`always` asks even after DON\'T ASK AGAIN; a plain spend still honours the opt-out', async () => {
    setKeepConfirm(false);
    const spent = vi.fn();
    let ask!: ReturnType<typeof useKeepSpendConfirm>['confirmKeepSpend'];
    function Harness(): React.JSX.Element {
      const { confirmKeepSpend, keepSpendDialog } = useKeepSpendConfirm();
      ask = confirmKeepSpend;
      return <>{keepSpendDialog}</>;
    }
    await act(async () => root.render(<Harness />));
    await act(async () => ask({ costKeep: 10, what: 'FINISH', onConfirm: spent }));
    expect(spent).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => ask({ costKeep: 3_000, what: 'BUY A COPY', always: true, warning: 'ALREADY RECRUITED', onConfirm: spent }));
    expect(spent).toHaveBeenCalledTimes(1);
    expect(dialog().textContent).toContain('ALREADY RECRUITED');
    await act(async () => dialogBtn('CONFIRM').click());
    expect(spent).toHaveBeenCalledTimes(2);
  });
});
