import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  totpDraft, landSealUi, landHeraldShown, coachPlateTop, providerLetter, faucetRowLine,
  stackedTabScrollTarget, scrollingTabWidthDp, supplyBuyLook, clanNameError, clanTagError,
  clanTagDraft, stepMinTrophies, clanCreateLook, tourneySteps, tourneyLook, charterToolsLock,
} from './AccountLogic';
import type { PriceUi } from '../types';
const sol = (status: PriceUi['status'] = 'OK'): PriceUi => ({ currency: 'SOL', amount: '0.2', status });
// Native reference fixtures, not production game policy. The caller supplies shared CLANS rules.
const rules = { nameMinLen: 3, nameMaxLen: 16, tagMinLen: 3, tagMaxLen: 4 };

test('TOTP draft keeps ASCII digits only and bounds the security code width', () => {
  assert.equal(totpDraft('12a3'), '123'); assert.equal(totpDraft('1234567'), '123456');
  assert.equal(totpDraft('１２3 ٤5'), '35'); assert.equal(totpDraft('1234', 2), '12');
});
test('the land seal pays SOL for the deed and keeps the fee in its fine print', () => {
  const seal = landSealUi('Crownlands', sol(), 7);
  assert.equal(seal.title, 'BUY LAND IN CROWNLANDS?'); assert.equal(seal.confirmLabel, 'BUY LAND');
  assert.equal(seal.armedAtMs, 7); assert.equal(seal.gets?.icon, 'itm_deed_earth');
  assert.match(seal.lines.at(-1)!, /network fee/); assert.ok(seal.lines.slice(0, -1).every(x => !x.includes('fee')));
  assert.equal(landSealUi('Crownlands', sol('CHECKING'), 7).price.status, 'CHECKING');
});
test('the land herald shows on the first three landless sessions only', () => {
  assert.equal(landHeraldShown(true, 1, 3), true); assert.equal(landHeraldShown(true, 3, 3), true);
  assert.equal(landHeraldShown(true, 4, 3), false); assert.equal(landHeraldShown(false, 1, 3), false);
  assert.equal(landHeraldShown(true, 0, 3), false); assert.equal(landHeraldShown(true, 1, null), false);
});
test('the tutorial plate sits under the target when it fits, else above, never off screen', () => {
  assert.equal(coachPlateTop(400, 500, 60, 900, 20), 520);
  assert.equal(coachPlateTop(400, 850, 60, 900, 20), 320);
  assert.equal(coachPlateTop(30, 880, 60, 900, 20), 0);
});
test('provider letters preserve the native wallet Google X and email representations', () => {
  assert.equal(providerLetter('WALLET'), ''); assert.equal(providerLetter('GOOGLE'), 'G');
  assert.equal(providerLetter('X'), 'X'); assert.equal(providerLetter('EMAIL'), '@');
});
test('the faucet wallet row follows the deed rule and honest outcomes', () => {
  assert.equal(faucetRowLine({ state: 'HIDDEN', amount: null }), null);
  assert.equal(faucetRowLine({ state: 'NEEDS_DEED', amount: null }), 'Needs a Kingdom Deed');
  assert.equal(faucetRowLine({ state: 'READY', amount: '1,000' }), '+1,000 ready today');
  assert.equal(faucetRowLine({ state: 'CLAIMING', amount: '1,000' }), '+1,000 on its way');
  assert.equal(faucetRowLine({ state: 'CLAIMED', amount: null, nextIn: '7h 12m' }), 'Claimed · next in 7h 12m');
  assert.equal(faucetRowLine({ state: 'UNAVAILABLE', amount: null, reason: 'Paused' }), 'Paused');
  assert.equal(faucetRowLine({ state: 'CHECKING', amount: null }), 'Checking your claim');
});
test('the shop primary buys the selected offer and sends a shortage to need-more', () => {
  const gems: PriceUi = { currency: 'GEMS', amount: '150', status: 'OK' };
  assert.equal(supplyBuyLook(null, null, null, null).state, 'DISABLED');
  assert.equal(supplyBuyLook('BUY SHIELD', 'Shield offer', gems, null).sub, 'Shield offer');
  assert.equal(supplyBuyLook('BUY', null, { ...gems, status: 'SHORT' }, null).state, 'SHORT');
  assert.equal(supplyBuyLook('BUY', null, gems, 'Not open').reason, 'Not open');
  assert.equal(supplyBuyLook('BUY', null, { ...gems, status: 'UNAVAILABLE' }, null).state, 'DISABLED');
  assert.equal(supplyBuyLook('BUY', null, { ...gems, status: 'CHECKING' }, null).state, 'ENABLED');
});
test('the tab strip scrolls the active tab into view with the next one peeking', () => {
  const widths = [100, 100, 100, 100, 100, 100];
  assert.equal(stackedTabScrollTarget(widths, 4, 0, 380, 28), 0);
  assert.equal(stackedTabScrollTarget(widths, 4, 4, 380, 28), 168);
  assert.equal(stackedTabScrollTarget(widths, 4, 5, 380, 28), 240);
  assert.equal(stackedTabScrollTarget(widths, 4, 1, 380, 28, 240), 104);
  assert.equal(stackedTabScrollTarget([], 4, 0, 380, 28), 0);
  assert.equal(scrollingTabWidthDp('HQ'), 72); assert.equal(scrollingTabWidthDp('SUPPLIES'), 106);
});
test('clan name and tag rules and the min trophies stepper', () => {
  assert.equal(clanNameError('', rules), null); assert.equal(clanNameError('Iron Wardens', rules), null);
  assert.equal(clanNameError('Ir', rules), '3 to 16 letters'); assert.equal(clanNameError('A'.repeat(17), rules), '3 to 16 letters');
  assert.equal(clanNameError('Iron_Wardens', rules), null);
  assert.equal(clanTagError('IRN', rules), null); assert.equal(clanTagError('IRONW', rules), '3 or 4 letters');
  assert.equal(clanTagDraft('i-r n4x', rules), 'IRN4');
  assert.equal(stepMinTrophies(600, 1, 100, 0, 5000), 700);
  assert.equal(stepMinTrophies(50, -1, 100, 0, 5000), 0);
  assert.equal(stepMinTrophies(4950, 1, 100, 0, 5000), 5000);
});
test('production clan limits are supplied by the caller rather than frozen native literals', () => {
  const current = { nameMinLen: 3, nameMaxLen: 24, tagMinLen: 2, tagMaxLen: 5 };
  assert.equal(clanNameError('A'.repeat(24), current), null); assert.equal(clanTagError('AB', current), null);
  assert.equal(clanTagDraft('abcdef', current), 'ABCDE');
  assert.equal(clanNameError('რკინის რაზმი', current), 'ASCII letters, numbers, spaces, . _ and - only');
  assert.equal(clanTagError('A', current), '2 to 5 letters');
});
test('create clan locks without a hall and stays enabled while the price is unknown', () => {
  assert.equal(clanCreateLook('Build a Clan Hall', 'Iron Wardens', 'IRN', null, rules).state, 'LOCKED');
  assert.equal(clanCreateLook(null, 'Ir', 'IRN', null, rules).state, 'DISABLED');
  assert.equal(clanCreateLook(null, 'Iron Wardens', 'IRN', null, rules).state, 'ENABLED');
  assert.equal(clanCreateLook(null, 'Iron Wardens', 'IRN', sol('CHECKING'), rules).state, 'ENABLED');
  assert.equal(clanCreateLook(null, 'Iron Wardens', 'IRN', sol('SHORT'), rules).state, 'SHORT');
  assert.equal(clanCreateLook(null, 'Iron Wardens', 'IRN', { currency: 'SHARDS', amount: '5000', status: 'SHORT' }, rules).reason, 'Not enough SHARDS');
});
test('the tournament track lights done, current and to-come steps', () => {
  assert.deepEqual(tourneySteps('ENTRY', true), ['DONE', 'CURRENT', 'TODO']);
  assert.deepEqual(tourneySteps('ENTRY', false), ['CURRENT', 'TODO', 'TODO']);
  assert.deepEqual(tourneySteps('RESULTS', true), ['DONE', 'DONE', 'CURRENT']);
  assert.deepEqual(tourneySteps('CLOSED', false), ['DONE', 'DONE', 'DONE']);
});
test('find match is red only while battles are open for a rostered player with fights left', () => {
  assert.equal(tourneyLook('BATTLES', true, false, true, 1, 3, null, false).verb, 'RED');
  assert.equal(tourneyLook('BATTLES', true, false, true, 1, 3, null, false).state, 'ENABLED');
  assert.equal(tourneyLook('ENTRY', true, false, true, 0, 3, 'Battles open soon', false).reason, 'Battles open soon');
  assert.equal(tourneyLook('BATTLES', true, false, false, 0, 3, null, false).reason, 'You joined after the roster locked');
  assert.equal(tourneyLook('BATTLES', true, false, true, 3, 3, null, false).state, 'DISABLED');
  assert.equal(tourneyLook('ENTRY', false, true, false, null, null, null, false).label, 'ENTER CLAN');
  assert.equal(tourneyLook('ENTRY', false, false, false, null, null, null, false).reason, 'Your captain enters the clan');
  assert.equal(tourneyLook('RESULTS', true, false, true, 3, 3, null, true).label, 'CLAIM PRIZE');
});
test('charter tools are the captain\'s, and a pause locks them for everyone', () => {
  assert.equal(charterToolsLock(true, null), null); assert.equal(charterToolsLock(false, null), 'captain');
  assert.equal(charterToolsLock(true, 'Charter changes are paused'), 'Charter changes are paused');
});
test('clan ASCII server punctuation and tag rules are preserved',()=>{assert.equal(clanNameError('Iron._- Wardens',rules),null);assert.equal(clanTagError('iRn',rules),null);assert.equal(clanTagError('გაA',rules),'ASCII letters and numbers only');assert.equal(clanTagDraft('გა-a_ß1',rules),'A1');assert.equal(clanNameError('Wård',rules),'ASCII letters, numbers, spaces, . _ and - only');});
