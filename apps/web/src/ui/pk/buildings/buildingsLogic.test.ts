import { describe, expect, it } from 'vitest';
import { priceText } from '../kitLogic';
import type { BuildingMarkerUi, PriceStatus, PriceUi } from '../types';
import type { BuildCardState, BuildCardUi, BuildSectionUi } from './buildingTypes';
import {
  cardPrice, cardTap, failureLine, foldRows, placementHint, placeLook,
  tileStep, traySections, upgradePrimaryLook, visibleMarkers,
} from './buildingsLogic';

/** Case-for-case port of Android BuildingsLogicTest.kt at 28609e71 (15 cases).
 * These rules prevent unknown-price sends, double sends after lost answers, and false spend assurances.
 * Fixture values below mirror Android; no fixture price is used by production logic.
 */
describe('BuildingsLogicTest', () => {
  const shards = (amount: string | null, status: PriceStatus = 'OK'): PriceUi => ({ currency: 'SHARDS', amount, status });
  const priced = shards('40,000');

  it('upgrade sends only at a server price the player can pay', () => {
    expect(upgradePrimaryLook('READY', priced, null).sends).toBe(true);
    expect(upgradePrimaryLook('READY', shards('0', 'SERVER_ZERO'), null).sends, 'a server zero is a real price').toBe(true);
    expect(upgradePrimaryLook('READY', shards(null), null).sends, 'OK without an amount is still unknown').toBe(false);
    expect(upgradePrimaryLook('READY', shards(null, 'CHECKING'), null).kind).toBe('WAIT_PRICE');
    expect(upgradePrimaryLook('CHECKING', priced, null).kind).toBe('WAIT_PRICE');
    const unavailable = upgradePrimaryLook('READY', shards(null, 'UNAVAILABLE'), null);
    expect(unavailable.kind).toBe('OFF');
    expect(unavailable.sends).toBe(false);
    expect(Boolean(unavailable.reason?.trim()), 'an off button always says why').toBe(true);
  });

  it('short and no-builder route to the place that fixes them, never to a spend', () => {
    const short = upgradePrimaryLook('SHORT', shards('40,000', 'SHORT'), null);
    expect(short.kind).toBe('NEED_MORE');
    expect(short.sends).toBe(false);
    expect(upgradePrimaryLook('READY', shards('40,000', 'SHORT'), null).kind, 'a SHORT price on a READY sheet is still short').toBe('NEED_MORE');
    const builder = upgradePrimaryLook('NO_BUILDER', priced, null);
    expect(builder.kind).toBe('NEED_BUILDER');
    expect(builder.sends).toBe(false);
  });

  it('a refused upgrade may be retried but a lost answer may not be re-sent', () => {
    expect(upgradePrimaryLook('ERROR', priced, null).sends, 'ERROR returns to READY (the server said no, nothing moved)').toBe(true);
    const verifying = upgradePrimaryLook('VERIFYING', priced, 'Checking whether the upgrade went through.');
    expect(verifying.kind).toBe('VERIFYING');
    expect(verifying.sends, 'the first order may have landed: never send twice').toBe(false);
    expect(upgradePrimaryLook('BUSY', priced, null).sends).toBe(false);
  });

  it('max level and a read-only base are off with a reason', () => {
    const max = upgradePrimaryLook('MAX', priced, null);
    expect(max.kind).toBe('OFF');
    expect(max.sends).toBe(false);
    expect(Boolean(max.reason?.trim())).toBe(true);
    expect(upgradePrimaryLook('READ_ONLY', priced, 'Viewing another kingdom').reason, "the herald's words win").toBe('Viewing another kingdom');
  });

  it('only an authoritative refusal may say nothing was spent', () => {
    expect(failureLine('upgrade', true)).toBe("The upgrade didn't start. Nothing was spent.");
    expect(failureLine('placement', true, 'Someone built there first.')).toBe('Someone built there first. Nothing was spent.');
    const uncertain = failureLine('upgrade', false, 'timeout');
    expect(uncertain.includes('Nothing was spent'), 'a timeout must not claim nothing was spent').toBe(false);
    expect(uncertain.includes('Checking')).toBe(true);
  });

  it('stat rows fold after four into a plus-n-more row', () => {
    const rows = [1, 2, 3, 4, 5, 6];
    expect(foldRows(rows, false)).toEqual({ shown: [1, 2, 3, 4], hidden: 2 });
    expect(foldRows(rows, true)).toEqual({ shown: rows, hidden: 0 });
    expect(foldRows([1, 2, 3], false)).toEqual({ shown: [1, 2, 3], hidden: 0 });
  });

  const card = (type: string, state: BuildCardState, price: PriceUi | null = priced, isNew = false): BuildCardUi => ({
    type, name: type.toUpperCase(), purpose: '', art: `ui:${type}-t1-idle`, count: '0/1', countTone: 'BLUE',
    state, price, time: '2h', reason: null, isNew, requires: null,
  });

  it('a card tap goes to placement only when the building can be placed', () => {
    expect(cardTap('AVAILABLE')).toBe('PLACE');
    expect(cardTap('CHECKING'), 'an unknown price still opens placement; PLACE waits').toBe('PLACE');
    expect(cardTap('SHORT'), 'short never enters placement').toBe('NEED_MORE');
    expect(cardTap('REQUIRES')).toBe('SHOW_REQUIRED');
    expect(cardTap('LOCKED')).toBe('EXPLAIN_LOCKED');
    expect(cardTap('MAX')).toBe('EXPLAIN_MAX');
    expect(cardTap('UNAVAILABLE')).toBe('EXPLAIN_UNAVAILABLE');
  });

  it("a card's pill never shows an amount it does not know and is red when short", () => {
    expect(cardPrice(card('lodge', 'SHORT'))?.status).toBe('SHORT');
    const checking = cardPrice(card('mine', 'CHECKING', shards('1,200')));
    expect(checking?.status).toBe('CHECKING');
    expect(priceText(checking!)).toBe('…');
    expect(cardPrice(card('market', 'LOCKED')), 'a locked card shows its lock bar, not a price').toBeNull();
    expect(cardPrice(card('berth', 'REQUIRES'))).toBeNull();
    expect(cardPrice(card('workshop', 'AVAILABLE'))).toEqual(priced);
  });

  it('empty sections hide and a section with something new comes first', () => {
    const economy: BuildSectionUi = { id: 'economy', title: 'ECONOMY', icon: 'shards', count: '1', cards: [card('mine', 'AVAILABLE')] };
    const army: BuildSectionUi = { id: 'army', title: 'ARMY', icon: 'army', count: '0', cards: [] };
    const realm: BuildSectionUi = { id: 'realm', title: 'REALM TRADE', icon: 'ui:workshop-menu', count: '1', cards: [card('workshop', 'AVAILABLE', priced, true)] };
    const clan: BuildSectionUi = { id: 'clan', title: 'CLAN', icon: 'shield', count: '1', cards: [card('castle', 'LOCKED')] };
    expect(traySections([economy, army, realm, clan]).map(section => section.id)).toEqual(['realm', 'economy', 'clan']);
    expect(traySections([economy, clan]).map(section => section.id), "without NEW the mapper's order is kept").toEqual(['economy', 'clan']);
  });

  it('PLACE sends only from a free spot at a payable price', () => {
    const valid = placeLook('VALID', priced, null);
    expect(valid.tap).toBe('PLACE');
    expect(valid.verb).toBe('GREEN');
    const blocked = placeLook('BLOCKED', priced, null);
    expect(blocked.tap).toBe('NONE');
    expect(blocked.verb).toBe('OFF');
    expect(blocked.reason).toBe('Spot is blocked');
    expect(blocked.draggable, 'the player can still drag it clear').toBe(true);
    const waiting = placeLook('VALID', shards(null, 'CHECKING'), null);
    expect(waiting.tap).toBe('NONE');
    expect(waiting.dots).toBe(true);
    expect(placeLook('VALID', shards(null, 'UNAVAILABLE'), null).tap).toBe('NONE');
  });

  it('short and no-builder placement route to their fix instead of sending', () => {
    expect(placeLook('SHORT', shards('40,000', 'SHORT'), null).tap).toBe('NEED_MORE');
    const builder = placeLook('NO_BUILDER', priced, null);
    expect(builder.tap).toBe('BUILDERS');
    expect(builder.reason).toBe('No free builder');
  });

  it('a sent or uncertain placement locks the ghost and cannot be sent again', () => {
    const sending = placeLook('SENDING', priced, null);
    expect(sending.tap).toBe('NONE');
    expect(sending.draggable).toBe(false);
    const verifying = placeLook('VERIFYING', priced, null);
    expect(verifying.tap).toBe('NONE');
    expect(verifying.draggable).toBe(false);
    expect(Boolean(verifying.reason?.trim())).toBe(true);
    expect(placeLook('ERROR', priced, null).tap, 'a refusal returns to VALID').toBe('PLACE');
  });

  it('the hint explains blocked tiles and the mapper may override it', () => {
    expect(placementHint('BLOCKED', null)).toBe('Red tiles are taken. Drag it clear.');
    expect(placementHint('VALID', null)).toBe('Drag to move · PLACE when green');
    expect(placementHint('BLOCKED', 'Move it')).toBe('Move it');
  });

  it('a drag snaps to the nearest whole tile', () => {
    expect(tileStep(14, -14, 30)).toEqual([0, 0]);
    expect(tileStep(16, -16, 30)).toEqual([1, -1]);
    expect(tileStep(95, 61, 30)).toEqual([3, 2]);
    expect(tileStep(95, 61, 0), 'no tile size, no movement').toEqual([0, 0]);
  });

  it('at most three markers, nearest the screen centre first', () => {
    const marker = (id: string, x: number, y: number): BuildingMarkerUi => ({
      buildingId: id, anchor: { left: x - 10, top: y - 10, right: x + 10, bottom: y + 10 },
      kind: 'READY', icon: 'shards', text: null, progress: null, description: id,
    });
    const all = [marker('far', 0, 0), marker('near', 210, 410), marker('mid', 300, 500), marker('centre', 200, 400), marker('edge', 400, 800)];
    expect(visibleMarkers(all, 200, 400).map(item => item.buildingId)).toEqual(['centre', 'near', 'mid']);
    expect(visibleMarkers(all, 200, 400, 0)).toEqual([]);
  });
});
