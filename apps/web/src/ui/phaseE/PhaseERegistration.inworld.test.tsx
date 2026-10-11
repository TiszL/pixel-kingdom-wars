/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApp, type BaseStateDto } from '../../state/store';
import { PhaseEBuildingDoor, PhaseERegistration } from './PhaseERegistration';
import { launchBuildingActivity, launchHistoryActivity } from '../../lib/phaseEActivity/access';
vi.mock('./KeepEquipmentMarketEntry', () => ({ KeepEquipmentMarketEntry: (p: { buildingId?: string }) => <div data-market-building={p.buildingId ?? 'history'} /> }));
vi.mock('./HarvesterScreen', () => ({ HarvesterScreen: (p: { actionsEnabled: boolean; historyOnly?: boolean }) => <div data-harvester-actions={String(p.actionsEnabled)} data-history={String(p.historyOnly)} /> }));
let host: HTMLDivElement, root: Root;
const baseId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const building = { id: 'building-1', type: 'market', level: 1, tx: 0, ty: 0, underConstruction: false };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useApp.getState().setAuth('11111111111111111111111111111111', true); useApp.getState().setSelectedBaseId(baseId, false);
  useApp.getState().setBase({ baseId, buildings: [building] } as BaseStateDto); useApp.getState().setScreen('base'); useApp.getState().select(building.id);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useApp.getState().setAuth(null); vi.unstubAllGlobals(); });
async function settled(selector: string) { await vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); expect(host.querySelector(selector)).not.toBeNull(); }); }
it('Market building is connected through the existing building-door registration', async () => {
  await act(async () => root.render(<PhaseEBuildingDoor buildingType="market" />)); await settled('[data-market-building]');
  expect(host.querySelector('[data-market-building]')?.getAttribute('data-market-building')).toBe(building.id);
});
it('direct Harvester history navigation cannot start a new selection', async () => {
  launchHistoryActivity('harvesters');
  await act(async () => root.render(<PhaseERegistration screen="harvesters" inBase={false} authed actionsEnabled />)); await settled('[data-harvester-actions]');
  expect(host.querySelector('[data-harvester-actions]')?.getAttribute('data-harvester-actions')).toBe('false');
  expect(host.querySelector('[data-history]')?.getAttribute('data-history')).toBe('true');
});
it('a completed Harvester tap enables that screen only while its base binding remains current', async () => {
  useApp.getState().setBase({ baseId, buildings: [{ ...building, type: 'harvester' }] } as BaseStateDto);
  launchBuildingActivity('harvesters', building.id);
  await act(async () => root.render(<PhaseERegistration screen="harvesters" inBase={false} authed actionsEnabled />)); await settled('[data-harvester-actions]');
  expect(host.querySelector('[data-harvester-actions]')?.getAttribute('data-harvester-actions')).toBe('true');
  await act(async () => useApp.getState().setSelectedBaseId('other', false));
  expect(host.querySelector('[data-harvester-actions]')?.getAttribute('data-harvester-actions')).toBe('false');
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
