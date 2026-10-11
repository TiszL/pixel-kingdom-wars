/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PkSeal } from './Seal';
import { PK_KIT } from './kitLogic';
// Cedar3 composes the accepted F2c map artifact before running this suite.
import { permitSealCanArm } from './map/MapLogic';
import type { MoneyStage, PriceStatus, SealUi } from './types';

const review = (status: PriceStatus = 'OK'): SealUi => ({
  title: 'Realm permit', lines: ['The original controller owns the reviewed request.'],
  price: { currency: 'KEEP', amount: status === 'SERVER_ZERO' ? '0' : '1', status },
  confirmLabel: 'CONFIRM PERMIT', armedAtMs: 0,
});
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const confirmButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="CONFIRM PERMIT"]')!;
const prices: PriceStatus[] = ['OK', 'SERVER_ZERO', 'CHECKING', 'UNAVAILABLE', 'SHORT'];
const stages: MoneyStage[] = ['READY', 'FAILED', 'CHECK_WALLET', 'SENDING', 'SENT'];
it.each(prices.flatMap(price => stages.map(stage => [price, stage] as const)))
('checks the permit price %s and stage %s at the real Seal primary', async (price, stage) => {
  // Arming time alone must never turn an unknown price or in-flight request into consent.
  const onConfirm = vi.fn(), onCancel = vi.fn();
  await act(async () => root.render(<PkSeal ui={review(price)} onConfirm={onConfirm} onCancel={onCancel}
    canConfirm={() => permitSealCanArm(price, stage)} clock={() => PK_KIT.SEAL_ARM_MS} />));
  const allowed = (price === 'OK' || price === 'SERVER_ZERO') && (stage === 'READY' || stage === 'FAILED');
  expect(confirmButton().disabled).toBe(!allowed);
  act(() => confirmButton().click()); expect(onConfirm).toHaveBeenCalledTimes(allowed ? 1 : 0);
  expect(onCancel).not.toHaveBeenCalled();
});
it('fails closed when the controller has not supplied confirm eligibility', async () => {
  const onConfirm = vi.fn();
  const missingPredicate = (
    // @ts-expect-error An omitted original-owner predicate must fail type checking.
    <PkSeal ui={review()} onConfirm={onConfirm} onCancel={vi.fn()} clock={() => PK_KIT.SEAL_ARM_MS} />
  );
  await act(async () => root.render(missingPredicate));
  expect(confirmButton().disabled).toBe(true);
  act(() => confirmButton().click()); expect(onConfirm).not.toHaveBeenCalled();
});
it('preserves the full arming guard and never queues an early eligible tap', async () => {
  let now = PK_KIT.SEAL_ARM_MS - 1; const onConfirm = vi.fn();
  await act(async () => root.render(<PkSeal ui={review()} onConfirm={onConfirm} onCancel={vi.fn()}
    canConfirm={() => true} clock={() => now} />));
  act(() => confirmButton().click()); expect(onConfirm).not.toHaveBeenCalled();
  now = PK_KIT.SEAL_ARM_MS;
  expect(onConfirm).not.toHaveBeenCalled();
  act(() => confirmButton().click()); expect(onConfirm).toHaveBeenCalledTimes(1);
});
it('rechecks live eligibility when the price or stage changes before React paints', async () => {
  let price: PriceStatus = 'OK'; let stage: MoneyStage = 'READY'; const onConfirm = vi.fn();
  await act(async () => root.render(<PkSeal ui={review()} onConfirm={onConfirm} onCancel={vi.fn()}
    canConfirm={() => permitSealCanArm(price, stage)} clock={() => PK_KIT.SEAL_ARM_MS} />));
  expect(confirmButton().disabled).toBe(false);
  price = 'SHORT'; act(() => confirmButton().click()); expect(onConfirm).not.toHaveBeenCalled();
  price = 'OK'; stage = 'SENDING'; act(() => confirmButton().click()); expect(onConfirm).not.toHaveBeenCalled();
  stage = 'FAILED'; act(() => confirmButton().click()); expect(onConfirm).toHaveBeenCalledTimes(1);
});
it.each(['BACK', 'Escape', 'scrim'] as const)('keeps %s cancellation available while confirmation is refused', async action => {
  const onConfirm = vi.fn(), onCancel = vi.fn();
  await act(async () => root.render(<PkSeal ui={review('CHECKING')} onConfirm={onConfirm} onCancel={onCancel}
    canConfirm={() => false} clock={() => PK_KIT.SEAL_ARM_MS} />));
  act(() => {
    if (action === 'BACK') host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click();
    else if (action === 'Escape') host.querySelector('[role="alertdialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else host.querySelector<HTMLElement>('.pk-seal__scrim')!.click();
  });
  expect(onCancel).toHaveBeenCalledTimes(1); expect(onConfirm).not.toHaveBeenCalled();
});
it('cannot confirm from the retained exit picture after logical dismissal', async () => {
  const onConfirm = vi.fn(), onCancel = vi.fn(), canConfirm = () => true;
  await act(async () => root.render(<PkSeal ui={review()} onConfirm={onConfirm} onCancel={onCancel}
    canConfirm={canConfirm} clock={() => PK_KIT.SEAL_ARM_MS} />));
  await act(async () => root.render(<PkSeal ui={null} onConfirm={onConfirm} onCancel={onCancel}
    canConfirm={canConfirm} clock={() => PK_KIT.SEAL_ARM_MS} />));
  expect(host.querySelector('.pk-seal-root--leaving')).not.toBeNull();
  expect(confirmButton().disabled).toBe(true);
  act(() => confirmButton().click()); expect(onConfirm).not.toHaveBeenCalled();
});

it('refuses a throwing render predicate while retaining the safe cancel choice', async () => {
  const onConfirm = vi.fn(), onCancel = vi.fn();
  await act(async () => root.render(<PkSeal ui={review()} onConfirm={onConfirm} onCancel={onCancel}
    canConfirm={() => { throw Error('owner unavailable'); }} clock={() => PK_KIT.SEAL_ARM_MS} />));
  expect(confirmButton().disabled).toBe(true); act(() => confirmButton().click());
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click());
  expect(onConfirm).not.toHaveBeenCalled(); expect(onCancel).toHaveBeenCalledOnce();
});
it('refuses a predicate that starts throwing after paint without losing cancellation', async () => {
  let throws = false; const onConfirm = vi.fn(), onCancel = vi.fn();
  await act(async () => root.render(<PkSeal ui={review()} onConfirm={onConfirm} onCancel={onCancel}
    canConfirm={() => { if (throws) throw Error('owner retired'); return true; }} clock={() => PK_KIT.SEAL_ARM_MS} />));
  expect(confirmButton().disabled).toBe(false); throws = true;
  act(() => confirmButton().click()); expect(onConfirm).not.toHaveBeenCalled();
  act(() => host.querySelector('[role="alertdialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(onCancel).toHaveBeenCalledOnce();
});
