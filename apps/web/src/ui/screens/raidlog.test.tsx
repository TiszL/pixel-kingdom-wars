import { RAID_RULES } from '@shardkeep/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { useApp } from '../../state/store';
import {
  battleAttacker, battleHistoryPath, battleReplayPath, BattleHistoryView,
  historyReplayRequestPath, legacyBattle, participantHistoryPath, participantReplayPath, priorParticipantRows,
  type BattleHistoryRow, raidLogContinuationTarget, revengeLabel, revengeTarget, settledLootLabel,
  startRevenge,
} from './raidlog';

describe('pending raid log recovery', () => {
  it('uses only the server raid id as continuation navigation state', () => {
    // The complete payload stays on the authenticated pending endpoint; this
    // test pins the minimal store contract used by the screen.
    expect(raidLogContinuationTarget('raid-pvp')).toEqual({
      kind: 'pvp', raidId: 'raid-pvp',
    });
  });
});

const defense: BattleHistoryRow = {
  baseId: 'defender-base',
  raidId: '00000000-0000-4000-8000-000000000777',
  role: 'defender', result: 'defeat', stars: 2, destructionPct: 71,
  mode: 'pvp', opponentLabel: null,
  lootDeltaShards: '-90071992547409931234', lootRedacted: false,
  settledAmount: '-90071992547409931234', settledCurrency: 'SHARDS',
  opponent: {
    baseId: 'attacker-base', wallet: 'AttackerWallet123456789', name: 'BLACKBEARD', seeker: true,
  },
  createdAt: new Date().toISOString(),
};

describe('deed battle history contract', () => {
  it('preserves the authoritative destruction percentage in legacy history', () => {
    // Legacy flag-off players still receive the same stored RaidResult as a
    // replay. Replacing its destruction with zero made a 3-star campaign win
    // read "0%" even though the result screen and replay both read 100%.
    expect(legacyBattle({
      id: '00000000-0000-4000-8000-000000000776',
      role: 'attacker', opponent: null, opponentName: '', opponentSeeker: false,
      status: 'resolved', result: { stars: 3, destructionPct: 100, lootShards: 400 },
      createdAt: new Date().toISOString(), resumable: false,
    }).destructionPct).toBe(100);
  });

  it('uses base-scoped cursor and replay routes', () => {
    expect(battleHistoryPath('base/id', 'next/cursor')).toBe('/bases/base%2Fid/battles?cursor=next%2Fcursor');
    expect(battleReplayPath('base/id', 'raid/id')).toBe('/bases/base%2Fid/battles/raid%2Fid/replay');
    expect(participantHistoryPath('next/cursor')).toBe('/battles/participated?cursor=next%2Fcursor');
    expect(participantReplayPath('raid/id')).toBe('/battles/participated/raid%2Fid/replay');
  });

  it('dedupes the selected deed while preserving sold-deed participant authority', () => {
    const selected = { ...defense, baseId: 'selected-base' };
    const sold = { ...defense, baseId: 'sold-base', raidId: '00000000-0000-4000-8000-000000000778' };
    expect(priorParticipantRows([selected, sold], 'selected-base')).toEqual([
      { ...sold, replayAccess: 'participant' },
    ]);
    expect(historyReplayRequestPath(true, { ...sold, replayAccess: 'participant' }))
      .toBe('/battles/participated/00000000-0000-4000-8000-000000000778/replay');
    expect(historyReplayRequestPath(true, { ...selected, replayAccess: 'deed' }))
      .toBe('/bases/selected-base/battles/00000000-0000-4000-8000-000000000777/replay');
  });

  it('names the attacker and preserves exact integer loot without Number coercion', () => {
    expect(battleAttacker(defense)).toEqual({ label: 'BLACKBEARD', seeker: true });
    expect(settledLootLabel(defense)).toBe('-90,071,992,547,409,931,234 SHARDS');
    expect(battleAttacker({ ...defense, role: 'attacker' })).toEqual({ label: 'YOU', seeker: false });
    expect(settledLootLabel({ ...defense, lootDeltaShards: null, settledAmount: null, lootRedacted: true }))
      .toBe('LOOT REDACTED');
    expect(settledLootLabel({
      ...defense, lootDeltaShards: '0', settledAmount: '77', settledCurrency: 'KEEP',
    })).toBe('+77 KEEP');
  });

  it('separates inherited deed history from exact prior participation and paginates both', () => {
    const priorCampaign: BattleHistoryRow = {
      ...defense,
      baseId: 'sold-deed-base',
      raidId: '00000000-0000-4000-8000-000000000778',
      role: 'attacker',
      mode: 'campaign',
      opponentLabel: 'CAMPAIGN STAGE 17',
      opponent: null,
      lootDeltaShards: '300',
      settledAmount: '300',
      replayAccess: 'participant',
    };
    const html = renderToStaticMarkup(<BattleHistoryView
      deedBattles={[defense]} participantBattles={[priorCampaign]} pending={[]}
      stable deedSelected loading={false} deedLoadingMore={false} participantLoadingMore={false}
      error={null} deedNextCursor="older-deed" participantNextCursor="older-participant"
      onReplay={vi.fn()} onRevenge={vi.fn()} onResume={vi.fn()} onMoreDeed={vi.fn()} onMoreParticipant={vi.fn()}
    />);
    expect(html).toContain('SELECTED DEED HISTORY');
    expect(html).toContain('OTHER / PRIOR DEED PARTICIPATION');
    expect(html).toContain('YOUR EXACT PRIVATE RECORD SURVIVES A DEED SALE');
    expect(html).toContain('ATTACKER ·');
    expect(html).toContain('BLACKBEARD');
    expect(html).toContain('2★ · 71%');
    expect(html).toContain('DEFEAT');
    expect(html).toContain('-90,071,992,547,409,931,234 SHARDS');
    expect(html).toContain('VS CAMPAIGN STAGE 17');
    expect(html).toContain('FOUGHT FROM DEED SOLD-DEE');
    expect(html).toContain('REPLAY');
    expect(html).toContain('LOAD OLDER DEED BATTLES');
    expect(html).toContain('LOAD OLDER PARTICIPATED BATTLES');
  });
});

// D-099 (owner 2026-09-02): "no good raid logs button to be able to revenge".
describe('REVENGE on a defence row', () => {
  const view = (rows: BattleHistoryRow[]): string => renderToStaticMarkup(<BattleHistoryView
    deedBattles={rows} participantBattles={[]} pending={[]}
    stable deedSelected loading={false} deedLoadingMore={false} participantLoadingMore={false}
    error={null} deedNextCursor={null} participantNextCursor={null}
    onReplay={vi.fn()} onRevenge={vi.fn()} onResume={vi.fn()} onMoreDeed={vi.fn()} onMoreParticipant={vi.fn()}
  />);

  it('offers REVENGE on a fresh PvP defence and ATTACK BACK once the revenge lock has lapsed', () => {
    // Inside revengeLockHours the server treats the counter-attack as revenge;
    // after that it is an ordinary attack, and the button must not promise more.
    expect(view([defense])).toContain('REVENGE');
    expect(revengeLabel(defense)).toBe('REVENGE');
    const lockMs = RAID_RULES.revengeLockHours * 3_600_000;
    const stale = { ...defense, createdAt: new Date(Date.now() - lockMs - 60_000).toISOString() };
    expect(view([stale])).toContain('ATTACK BACK');
    expect(view([stale])).not.toContain('REVENGE');
    expect(revengeLabel(defense, Date.parse(defense.createdAt) + lockMs)).toBe('REVENGE');
    expect(revengeLabel(defense, Date.parse(defense.createdAt) + lockMs + 1)).toBe('ATTACK BACK');
  });

  it('offers nothing on your own attacks or on PvE / campaign rows — there is nobody to avenge', () => {
    const attack = { ...defense, role: 'attacker' as const };
    const pve = { ...defense, mode: 'pve' as const, opponent: null, opponentLabel: 'PVE CAMP' };
    const campaign = { ...defense, mode: 'campaign' as const, opponent: null, opponentLabel: 'CAMPAIGN STAGE 3' };
    const nameless = { ...defense, opponent: null };
    for (const row of [attack, pve, campaign, nameless]) {
      expect(revengeTarget(row)).toBeNull();
      const html = view([row]);
      expect(html).not.toContain('REVENGE');
      expect(html).not.toContain('ATTACK BACK');
    }
  });

  it('presses through the normal raid path: the map’s exact target shape, then the battle screen', () => {
    // No client-side attackability check — createRaid decides and its 422
    // reaches the player through RaidUI's existing error path.
    useApp.getState().setRaidTarget(null);
    useApp.getState().setScreen('raidlog');
    expect(startRevenge(defense)).toBe(true);
    expect(useApp.getState().raidTarget).toEqual({
      kind: 'pvp', wallet: 'AttackerWallet123456789', defenderBaseId: 'attacker-base', name: 'BLACKBEARD',
    });
    expect(useApp.getState().screen).toBe('battle');
    // A legacy row has no deed id: the auto-match target shape still routes it.
    expect(revengeTarget({ ...defense, opponent: { ...defense.opponent!, baseId: '', name: '' } }))
      .toEqual({ kind: 'pvp', wallet: 'AttackerWallet123456789', defenderBaseId: undefined, name: undefined });
    useApp.getState().setScreen('raidlog');
    expect(startRevenge({ ...defense, role: 'attacker' })).toBe(false);
    expect(useApp.getState().screen).toBe('raidlog');
  });
});
