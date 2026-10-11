import { describe, expect, it } from 'vitest';
import { PHASE_E_POLICY } from './constants';
import { DIVINE_FRAGMENT_POLICY, divineFragmentWeekAt } from './divineFragments';
import * as A from './divineFragmentsApi';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wallet = '11111111111111111111111111111111', other = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const time = '2026-09-28T00:00:00.000Z';
const award: A.DivineFragmentAward = { version: 1, resourceId: 'crystal_fragment', economicLineage: 'shardkeep',
  domain: { genesisHash: wallet, economyProgram: other }, eventId: id(1), wallet, site: 'divine-individual-001',
  weekStart: divineFragmentWeekAt(time), earnedAt: time, sourceHash: 'a'.repeat(64), termId: id(2), termHash: 'b'.repeat(64),
  winnerCount: 2, poolDisposition: 'original_winning_spots', gross: '14', net: '12', tax: '2', carryBefore: '0', carryAfter: '8000', settledAt: time };
const request = { idempotencyKey: id(3), baseId: id(4) };
const receipt: A.DivineFragmentDeliveryReceipt = { version: 1, resourceId: 'crystal_fragment', ...request, eventId: id(1), wallet,
  quantity: '12', stockBefore: '5', stockAfter: '17', deliveredAt: time };
const consent: A.DivineFragmentDeliveryConsent = { version: 1, wallet, eventId: id(1), request, award };
const claimRequest = { ...request, termId: id(2), spotId: 0 };
const claim: A.DivineFragmentSeekerClaimReceipt = { version: 1, resourceId: 'crystal_fragment', ...claimRequest, wallet,
  termHash: award.termHash, winnerCount: 2, poolTotal: '11', previousTotal: '2', cumulativeTotal: '5', quantity: '3', stockBefore: '4', stockAfter: '7', claimedAt: time };
const entitlement: A.DivineFragmentSeekerEntitlement = { termId: id(2), termHash: award.termHash, startsAt: time,
  endsAt: new Date(Date.parse(time) + PHASE_E_POLICY.seekerIsland.operatingTermSec * 1000).toISOString(), spotId: 0,
  winnerCount: 2, poolTotal: '11', previousTotal: '2', cumulativeTotal: '5', claimable: '3' };

describe('D192 strict original fragment contracts', () => {
  it('accepts frozen policy, award, delivery and separate protected stock', () => {
    expect(A.DivineFragmentPolicySchema.parse(DIVINE_FRAGMENT_POLICY)).toEqual(DIVINE_FRAGMENT_POLICY);
    expect(A.DivineFragmentAwardSchema.parse(award)).toEqual(award);
    expect(A.matchDivineFragmentDeliveryReceipt(receipt, consent)).toEqual(receipt);
    expect(A.DivineFragmentStockViewSchema.parse({ version: 1, resourceId: 'crystal_fragment', wallet, baseId: id(4), available: '9223372036854775807' }).available).toBe('9223372036854775807');
  });
  it.each([{ weeklyGross: '10001' }, { playerBps: 10000 }, { recipe: 'awning' }])('rejects policy replacement %j', patch => expect(A.DivineFragmentPolicySchema.safeParse({ ...DIVINE_FRAGMENT_POLICY, ...patch }).success).toBe(false));
  it.each([{ gross: '15' }, { net: '14', tax: '0' }, { carryAfter: '0' }, { carryBefore: '10000' }, { weekStart: time },
    { site: 'divine-individual-501' }, { site: 'divine-individual-000' }, { wallet: '1'.repeat(33) }, { economicLineage: 'v2' },
    { winnerCount: 0 }, { sourceHash: 'A'.repeat(64) }, { granted: true }])('rejects malformed or altered award %j', patch => expect(A.DivineFragmentAwardSchema.safeParse({ ...award, ...patch }).success).toBe(false));
  it('retains positively proven zero-winner liability without inventing a payee', () => {
    expect(A.DivineFragmentAwardSchema.parse({ ...award, winnerCount: 0, poolDisposition: 'held_zero_winners' }).tax).toBe('2');
    expect(A.DivineFragmentSeekerClaimReceiptSchema.safeParse({ ...claim, winnerCount: 0 }).success).toBe(false);
  });
  it.each(['01', '-1', '1.0', '1e2', '9223372036854775808', 'NaN'])('rejects noncanonical or overflowing fragment quantity %s without throwing parse internals', quantity => {
    expect(A.DivineFragmentDeliveryReceiptSchema.safeParse({ ...receipt, quantity }).success).toBe(false);
    expect(A.DivineFragmentSeekerClaimReceiptSchema.safeParse({ ...claim, quantity }).success).toBe(false);
  });
  it('cannot inject amount, source authority or alternate resource through commands', () => {
    for (const fields of [{ quantity: '14' }, { termId: id(8) }, { certificate: {} }, { eventId: id(8) }]) expect(A.DivineFragmentDeliveryRequestSchema.safeParse({ ...request, ...fields }).success).toBe(false);
    expect(A.DivineFragmentSeekerClaimRequestSchema.safeParse({ ...claimRequest, resourceId: 'frost_quartz' }).success).toBe(false);
  });
  it('rejects changed destination, actor, event or key against saved consent', () => {
    for (const fields of [{ baseId: id(8) }, { wallet: other }, { eventId: id(8) }, { idempotencyKey: id(8) }]) expect(() => A.matchDivineFragmentDeliveryReceipt({ ...receipt, ...fields }, consent)).toThrow();
    expect(A.matchDivineFragmentDeliveryReceipt(receipt, JSON.parse(JSON.stringify(consent)))).toEqual(receipt);
  });
  it('checks event settlement and delivery identity without requiring new admission', () => {
    const view = { version: 1, wallet, eventId: id(1), enrolled: true, settled: true, award, delivery: receipt };
    expect(A.matchDivineFragmentEventView(view, wallet, id(1)).delivery).toEqual(receipt);
    for (const patch of [{ enrolled: false }, { settled: false }, { award: null }, { delivery: { ...receipt, quantity: '11', stockAfter: '16' } }]) expect(A.DivineFragmentEventViewSchema.safeParse({ ...view, ...patch }).success).toBe(false);
    expect(A.DivineFragmentEventViewSchema.safeParse({ ...view, award: null, delivery: null }).success).toBe(true); // settled nonwinner
  });
  it('binds lost-reply envelopes to original wallet and key', () => {
    expect(A.DivineFragmentDeliveryEnvelopeSchema.safeParse({ version: 1, wallet, idempotencyKey: id(3), receipt }).success).toBe(true);
    expect(A.DivineFragmentDeliveryEnvelopeSchema.safeParse({ version: 1, wallet, idempotencyKey: id(8), receipt }).success).toBe(false);
    expect(A.DivineFragmentSeekerClaimEnvelopeSchema.safeParse({ version: 1, wallet: other, idempotencyKey: id(3), receipt: claim }).success).toBe(false);
  });
  it('pays cumulative original spots once with dust retained and no second earning', () => {
    expect(A.matchDivineFragmentSeekerClaimReceipt(claim, { version: 1, wallet, request: claimRequest })).toEqual(claim);
    for (const patch of [{ quantity: '4', stockAfter: '8' }, { cumulativeTotal: '6' }, { previousTotal: '6' }, { stockAfter: '8' }]) expect(A.DivineFragmentSeekerClaimReceiptSchema.safeParse({ ...claim, ...patch }).success).toBe(false);
    expect(() => A.matchDivineFragmentSeekerClaimReceipt(claim, { version: 1, wallet, request: { ...claimRequest, spotId: 1 } })).toThrow();
  });
  it('binds bounded pages to wallet/cursor and rejects duplicates or mixed term rights', () => {
    const awards = { version: 1, wallet, rows: [{ award, delivery: receipt }], nextCursor: id(1) };
    expect(A.matchDivineFragmentAwardsPage(awards, wallet).rows).toHaveLength(1);
    expect(() => A.matchDivineFragmentAwardsPage(awards, wallet, id(1))).toThrow();
    expect(A.DivineFragmentAwardsPageSchema.safeParse({ ...awards, rows: [...awards.rows, ...awards.rows] }).success).toBe(false);
    const page = { version: 1, wallet, rows: [entitlement], nextCursor: id(2) };
    expect(A.matchDivineFragmentClaimablePage(page, wallet).rows).toHaveLength(1);
    expect(() => A.matchDivineFragmentClaimablePage(page, other)).toThrow();
    for (const second of [entitlement, { ...entitlement, spotId: 1, termId: id(8) }, { ...entitlement, spotId: 1, poolTotal: '10' }]) expect(A.DivineFragmentClaimablePageSchema.safeParse({ ...page, rows: [entitlement, second] }).success).toBe(false);
  });
});

describe('D193 compatible strict clan award branch',()=>{
 const clanAward={...award,site:'divine-clan-001',gross:'13',net:'10',tax:'3',carryBefore:'8000',carryAfter:'4000',
  clan:{clanId:id(8),entryId:id(9),rosterSize:3,rosterHash:'c'.repeat(64),siteGross:'40',tournamentDomain:{...award.domain,craftProgram:wallet,treasury:other}}};
 it('preserves old individual bytes and adds a source-specific original roster share',()=>{
  expect(JSON.stringify(A.DivineFragmentAwardSchema.parse(award))).toBe(JSON.stringify(award));
  expect(A.DivineFragmentAwardSchema.parse(clanAward)).toEqual(clanAward);
  const delivery={...receipt,quantity:'10',stockAfter:'15'},original={...consent,award:clanAward};
  expect(A.matchDivineFragmentDeliveryReceipt(delivery,original)).toEqual(delivery);
  expect(A.DivineFragmentPolicySchema.parse(DIVINE_FRAGMENT_POLICY)).toEqual(DIVINE_FRAGMENT_POLICY);
 });
 it('rejects stripping or mixing clan identity with an individual branch',()=>{
  const {clan,...stripped}=clanAward;
  for(const bad of [stripped,{...award,clan},{...clanAward,site:'divine-individual-001'},{...clanAward,site:'divine-clan-051'},
   {...clanAward,clan:{...clan,siteGross:'41'}},{...clanAward,clan:{...clan,rosterSize:2}},
   {...clanAward,clan:{...clan,tournamentDomain:{...clan.tournamentDomain,genesisHash:other}}},
   {...clanAward,clan:{...clan,currentLeader:wallet}},{...clanAward,tax:'0',net:'13'}])
    expect(A.DivineFragmentAwardSchema.safeParse(bad).success).toBe(false);
 });
});
