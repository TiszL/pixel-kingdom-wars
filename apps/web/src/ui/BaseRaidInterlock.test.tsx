import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_RAID_MESSAGE, activeBaseRaidPath, BaseRaidInterlockView,
  deedActionsAllowed, raidInterlockVisible, type ActiveBaseRaid,
} from './BaseRaidInterlock';

const liveRaid: ActiveBaseRaid = { raidId: 'raid-1', state: 'live' };

describe('selected-deed live raid interlock', () => {
  it('uses the selected stable base route and disables deed actions only while locked', () => {
    const baseId = '00000000-0000-4000-8000-000000000123';
    expect(activeBaseRaidPath(baseId)).toBe(`/bases/${baseId}/active-raid`);
    expect(deedActionsAllowed(true, null)).toBe(true);
    expect(deedActionsAllowed(true, liveRaid)).toBe(false);
    expect(deedActionsAllowed(true, undefined)).toBe(false);
    expect(deedActionsAllowed(false, null)).toBe(false);
  });

  it('renders the owner-approved blocking message and live/history/deed exits', () => {
    const html = renderToStaticMarkup(<BaseRaidInterlockView
      raid={liveRaid} onWatch={vi.fn()} onHistory={vi.fn()} onSwitchBase={vi.fn()}
    />);
    expect(html).toContain(ACTIVE_RAID_MESSAGE);
    expect(html).toContain('WATCH LIVE');
    expect(html).toContain('BATTLE HISTORY');
    expect(html).toContain('SWITCH DEED');
    expect(html).toContain('role="alertdialog"');
  });

  it('covers already-open deed screens while leaving only watch, history and switch exits open', () => {
    for (const screen of ['base', 'build', 'forge', 'inventory', 'shop', 'quests', 'map'] as const) {
      expect(raidInterlockVisible(screen, liveRaid, 'base-1')).toBe(true);
    }
    expect(raidInterlockVisible('battle', liveRaid, 'base-1')).toBe(false);
    expect(raidInterlockVisible('raidlog', liveRaid, 'base-1')).toBe(false);
    expect(raidInterlockVisible('bases', liveRaid, 'base-1')).toBe(false);
    expect(raidInterlockVisible('forge', null, 'base-1')).toBe(false);
  });
});
