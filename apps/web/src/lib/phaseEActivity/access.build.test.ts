import { afterEach, expect, it } from 'vitest';
import { useApp, type BaseStateDto } from '../../state/store';
import { hasBuildingActivityAccess, launchBuildingActivity } from './access';
afterEach(() => useApp.getState().setAuth(null));
it.each(['market', 'harvesters'] as const)('a completed %s door works while BUILD owns the same base sheet', activity => {
  const baseId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', id = 'building-1';
  useApp.getState().setAuth('11111111111111111111111111111111', true);
  useApp.getState().setSelectedBaseId(baseId, false);
  useApp.getState().setBase({ baseId, buildings: [{ id, type: activity === 'market' ? 'market' : 'harvester', level: 1, tx: 0, ty: 0, underConstruction: false }] } as BaseStateDto);
  useApp.getState().setScreen('build'); useApp.getState().select(id);
  expect(launchBuildingActivity(activity, id)).toBe(true);
  expect(hasBuildingActivityAccess(activity)).toBe(true);
  expect(useApp.getState().screen).toBe(activity === 'market' ? 'build' : 'harvesters');
});
