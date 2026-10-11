/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { pvpAttackShardCostForKeepLevel, RAID_ENERGY } from '@shardkeep/shared';
import { useApp, type BaseStateDto } from '../state/store';
import { RaidEntryCost } from './RaidEntryCost';

const originalBase = useApp.getState().base;
afterEach(() => useApp.setState({ base: originalBase }));

it('discloses both charges from the selected server base and updates after a base switch', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    for (const keepLevel of [1, 5]) {
      await act(async () => {
        useApp.setState({ base: { player: { keepLevel } } as BaseStateDto });
        root.render(<RaidEntryCost />);
      });
      expect(host.textContent).toContain(`${RAID_ENERGY.perRaid} ENERGY + ${pvpAttackShardCostForKeepLevel(keepLevel)} SHARDS`);
      expect(host.textContent).toContain('Charged when a target is found. Retreat keeps these spent.');
    }
    await act(async () => useApp.setState({ base: null }));
    expect(host.textContent).toContain('— SHARDS'); // Unknown authority must never look free.
  } finally {
    await act(async () => root.unmount());
  }
});
