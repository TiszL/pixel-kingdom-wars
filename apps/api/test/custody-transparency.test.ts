/** Retirement metadata must never turn a fixture or unreadable evidence into
 * a reserve attestation, leak recipients, or rewrite historical PoR roots. */
import { GEMS } from '@shardkeep/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client';
import { readCustodyTransparency } from '../src/money/custodyTransparency';

const at = new Date('2026-09-24T12:00:00.000Z');
const before = { playerKeep:'50', withdrawalEscrow:'0', forgePayoutEscrow:'20',
  leagueEntitlementEscrow:'0', mailKeepEscrow:'30', emissionPool:'500', gemsMintedRetirement:'0' };
const after = { playerKeep:'0', withdrawalEscrow:'0', forgePayoutEscrow:'0',
  leagueEntitlementEscrow:'0', mailKeepEscrow:'0', emissionPool:'600',
  gemsMintedRetirement:(90n * BigInt(GEMS.gemsPerKeep)).toString() };
const record = () => ({phase:'frozen', changedAt:at, scope:'fixture',
  subcommand:'retire-l1-mail', dryRun:false, beforeState:before, afterState:after,
  createdAt:at, request:{ wallet:'secret-wallet' }, receipts:['secret-receipt'],
  operatorName:'secret-operator', databaseName:'secret-database' });
function fixture(rows: unknown[]) {
  const execute = vi.fn().mockResolvedValue(rows);
  return { db:{execute} as unknown as Db, execute };
}

describe('public custody transition metadata', () => {
  it('open with no journal reports no recorded retirement, never an attestation', async () => {
    const {db,execute} = fixture([{phase:'open',changedAt:at,scope:null}]);
    expect(await readCustodyTransparency(db)).toEqual({phase:'open',changedAt:at.toISOString(),
      evidence:{status:'none'}, reserveAttested:false});
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('publishes only aggregate recorded fixture amounts and explicit provenance', async () => {
    const result = await readCustodyTransparency(fixture([record()]).db);
    expect(result).toEqual({phase:'frozen',changedAt:at.toISOString(),reserveAttested:false,
      evidence:{status:'fixture_recorded',recordedAt:at.toISOString(),keepConverted:'90',
        gemsMinted:(90n * BigInt(GEMS.gemsPerKeep)).toString(),internalKeepSwept:'10'}});
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each([
    ['missing journal', {scope:null}],
    ['production-looking journal', {scope:'production'}],
    ['unknown operation', {subcommand:'approve-retirement'}],
    ['dry run', {dryRun:true}],
    ['noncanonical number', {beforeState:{...before,playerKeep:'050'}}],
    ['negative balance', {afterState:{...after,mailKeepEscrow:'-1'}}],
    ['remaining liability', {afterState:{...after,mailKeepEscrow:'1'}}],
    ['unbacked issuance', {afterState:{...after,emissionPool:'599'}}],
    ['over-issued Gems', {afterState:{...after,gemsMintedRetirement:(101n*BigInt(GEMS.gemsPerKeep)).toString()}}],
    ['invalid timestamp', {createdAt:'not-a-date'}],
    ['unfinished phase', {phase:'withdrawals_closed'}],
  ])('keeps %s evidence unknown', async (_name,patch) => {
    expect((await readCustodyTransparency(fixture([{...record(),...patch}]).db)).evidence)
      .toEqual({status:'unknown'});
  });

  it('rejects conflicting or unknown phase records and tolerates private-journal read denial', async () => {
    for (const rows of [[],[record(),record()],[{...record(),phase:'made-up'}]]) {
      expect(await readCustodyTransparency(fixture(rows).db)).toEqual({phase:'unknown',
        changedAt:null,evidence:{status:'unknown'},reserveAttested:false});
    }
    const db = {execute:vi.fn().mockRejectedValue(new Error('permission denied: secret-db'))} as unknown as Db;
    expect(await readCustodyTransparency(db)).toEqual({phase:'unknown',changedAt:null,
      evidence:{status:'unknown'},reserveAttested:false});
  });
});
