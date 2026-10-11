/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApp, type BaseStateDto } from '../../state/store';
import { KeepEquipmentMarketEntry } from './KeepEquipmentMarketEntry';
vi.mock('./KeepEquipmentMarketScreen', () => ({ KeepEquipmentMarketScreen: (props: { actionsEnabled: boolean; historyOnly?: boolean }) =>
  <div role="dialog" data-actions={String(props.actionsEnabled)} data-history={String(props.historyOnly)} /> }));
let host: HTMLDivElement, root: Root;
const baseId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const market = { id: 'market-1', type: 'market', level: 1, underConstruction: false, tx: 0, ty: 0 };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useApp.getState().setAuth('11111111111111111111111111111111', true);
  useApp.getState().setSelectedBaseId(baseId, false);
  useApp.getState().setBase({ baseId, buildings: [market] } as BaseStateDto);
  useApp.getState().setScreen('base'); useApp.getState().select(market.id);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useApp.getState().setAuth(null); vi.unstubAllGlobals(); });
async function open() {
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  await vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); expect(host.querySelector('[role="dialog"]')).not.toBeNull(); });
}
it('the secondary Market entry opens only saved history even when ordinary actions are enabled', async () => {
  await act(async () => root.render(<KeepEquipmentMarketEntry actionsEnabled />));
  await open();
  expect(host.querySelector('[role="dialog"]')?.getAttribute('data-actions')).toBe('false');
  expect(host.querySelector('[role="dialog"]')?.getAttribute('data-history')).toBe('true');
});
it('a completed Market door enables the existing panel while keeping server gates authoritative', async () => {
  await act(async () => root.render(<KeepEquipmentMarketEntry actionsEnabled buildingId={market.id} />));
  await open();
  expect(host.querySelector('[role="dialog"]')?.getAttribute('data-actions')).toBe('true');
  expect(host.querySelector('[role="dialog"]')?.getAttribute('data-history')).toBe('false');
});
it('switching base closes a Market door so its old building cannot authorize the new kingdom', async () => {
  await act(async () => root.render(<KeepEquipmentMarketEntry actionsEnabled buildingId={market.id} />)); await open();
  await act(async () => useApp.getState().setSelectedBaseId('other', false));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});
it('an unfinished Market never opens a new-trade panel even with a forged building prop', async () => {
  useApp.getState().setBase({ baseId, buildings: [{ ...market, underConstruction: true }] } as BaseStateDto);
  await act(async () => root.render(<KeepEquipmentMarketEntry actionsEnabled buildingId={market.id} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button')?.click());
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
