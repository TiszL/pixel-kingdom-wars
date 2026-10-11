import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useApp, type BaseStateDto } from '../../state/store';
import { hasBuildingActivityAccess, launchBuildingActivity, launchHistoryActivity } from './access';

const wallet = '11111111111111111111111111111111';
const baseId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const building = { id: 'market-1', type: 'market', level: 1, tx: 1, ty: 1, underConstruction: false };
const base = (rows = [building]) => ({ baseId, buildings: rows }) as BaseStateDto;
beforeEach(() => {
  useApp.getState().setAuth(wallet, true);
  useApp.getState().setSelectedBaseId(baseId, false);
  useApp.getState().setBase(base());
  useApp.getState().setScreen('base');
  useApp.getState().select(building.id);
});
afterEach(() => useApp.getState().setAuth(null));

describe('D153.298 building access is local navigation provenance, never server authority', () => {
  it('opens the completed selected building so the world is the primary entry', () => {
    expect(launchBuildingActivity('market', building.id)).toBe(true);
    expect(hasBuildingActivityAccess('market')).toBe(true);
  });
  it('refuses an absent, wrong-type or unfinished building so a menu cannot invent a door', () => {
    expect(launchBuildingActivity('harvesters', building.id)).toBe(false);
    expect(launchBuildingActivity('market', 'missing')).toBe(false);
    useApp.getState().setBase(base([{ ...building, underConstruction: true }]));
    expect(launchBuildingActivity('market', building.id)).toBe(false);
  });
  it('refuses level zero and stale base reads because selected identity alone is insufficient', () => {
    useApp.getState().setBase(base([{ ...building, level: 0 }]));
    expect(launchBuildingActivity('market', building.id)).toBe(false);
    useApp.getState().setBase({ ...base(), baseId: 'other' });
    expect(launchBuildingActivity('market', building.id)).toBe(false);
  });
  it('refuses a non-selected building and unauthenticated caller so arbitrary IDs grant nothing', () => {
    useApp.getState().select(null);
    expect(launchBuildingActivity('market', building.id)).toBe(false);
    useApp.getState().select(building.id);
    useApp.getState().setAuth(null);
    expect(launchBuildingActivity('market', building.id)).toBe(false);
  });
  it('invalidates on a base ABA even when the original kingdom is selected again', () => {
    launchBuildingActivity('market', building.id);
    useApp.getState().setSelectedBaseId('other', false);
    useApp.getState().setSelectedBaseId(baseId, false);
    useApp.getState().setBase(base());
    expect(hasBuildingActivityAccess('market')).toBe(false);
  });
  it('invalidates when the completed building disappears so stale panels cannot trade', () => {
    launchBuildingActivity('market', building.id);
    useApp.getState().setBase(base([]));
    expect(hasBuildingActivityAccess('market')).toBe(false);
  });
  it('history entry revokes earlier world access while preserving the screen for saved receipts', () => {
    launchBuildingActivity('market', building.id);
    launchHistoryActivity('market');
    expect(hasBuildingActivityAccess('market')).toBe(false);
  });
  it('a building-specific launch cannot authorize another service', () => {
    useApp.getState().setBase(base([{ ...building, type: 'harvester' }]));
    expect(launchBuildingActivity('harvesters', building.id)).toBe(true);
    expect(useApp.getState().screen).toBe('harvesters');
    expect(hasBuildingActivityAccess('harvesters')).toBe(true);
    expect(hasBuildingActivityAccess('starter-expeditions')).toBe(false);
  });
  it('leaving a service screen permanently revokes its access until another building tap', () => {
    useApp.getState().setBase(base([{ ...building, type: 'lodge' }]));
    launchBuildingActivity('starter-expeditions', building.id);
    useApp.getState().setScreen('base');
    useApp.getState().setScreen('starter-expeditions');
    expect(hasBuildingActivityAccess('starter-expeditions')).toBe(false);
  });
});
