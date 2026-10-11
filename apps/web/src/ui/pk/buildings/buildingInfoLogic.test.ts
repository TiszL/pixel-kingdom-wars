import { describe, expect, it } from 'vitest';
import type { PriceStatus, PriceUi } from '../types';
import {
  infoDrawState, infoPrimaryLook, infoPrimaryTap, statIconFramed, statSpoken,
} from './buildingInfoLogic';

/** Case-for-case port of Android BuildingInfoLogicTest: INFO navigates, FINISH gates spending, unknown stays unknown. */
describe('BuildingInfoLogic', () => {
  const shards = (status: PriceStatus): PriceUi => ({ currency: 'SHARDS', amount: '521', status });
  const gems = (status: PriceStatus): PriceUi => ({ currency: 'GEMS', amount: '38', status });

  it('upgrade entry is navigation even when the price is checking or short', () => {
    expect(infoPrimaryTap('READY', 'UPGRADE', 'ENABLED', null)).toBe('UPGRADE');
    expect(infoPrimaryTap('READY', 'UPGRADE', 'ENABLED', shards('CHECKING')),
      'correction 7: CHECKING is enabled navigation').toBe('UPGRADE');
    expect(infoPrimaryTap('READY', 'UPGRADE', 'SHORT', shards('SHORT')),
      'the UPGRADE sheet shows the shortfall; INFO never spends').toBe('UPGRADE');
    expect(infoDrawState('UPGRADE', 'SHORT', shards('SHORT'))).toBe('ENABLED');
  });

  it('finish opens the seal, or need-more when the gems are short', () => {
    expect(infoPrimaryTap('READY', 'FINISH', 'ENABLED', gems('OK'))).toBe('FINISH');
    expect(infoPrimaryTap('READY', 'FINISH', 'ENABLED', gems('CHECKING'))).toBe('FINISH');
    expect(infoPrimaryTap('READY', 'FINISH', 'ENABLED', gems('SHORT'))).toBe('NEED_MORE');
    expect(infoDrawState('FINISH', 'ENABLED', gems('SHORT'))).toBe('SHORT');
  });

  it('an unavailable price or a locked feature explains itself', () => {
    const look = infoPrimaryLook('READY', 'FINISH', 'FINISH', null, 'ENABLED', null, gems('UNAVAILABLE'));
    expect(look.state).toBe('DISABLED');
    expect(look.reason, 'an off button always says why').toBe('price unavailable right now');
    expect(infoPrimaryTap('READY', 'FINISH', 'ENABLED', gems('UNAVAILABLE'))).toBe('EXPLAIN');
    expect(infoPrimaryTap('READY', 'UPGRADE', 'LOCKED', null)).toBe('EXPLAIN');
    expect(infoPrimaryLook('READY', 'UPGRADE', 'UPGRADE TO LV 5', null, 'LOCKED', 'Opens 14 Oct', null).reason)
      .toBe('Opens 14 Oct');
  });

  it('loading never acts and an error waits for the server', () => {
    const loading = infoPrimaryLook('LOADING', 'UPGRADE', 'UPGRADE TO LV 5', 'Uses 1 builder', 'ENABLED', null, null);
    expect(loading.state).toBe('BUSY');
    expect(loading.label).toBe('Checking');
    expect(infoPrimaryTap('LOADING', 'UPGRADE', 'ENABLED', null)).toBe('NONE');
    const error = infoPrimaryLook('ERROR', 'UPGRADE', 'UPGRADE TO LV 5', 'Uses 1 builder', 'ENABLED', null, null);
    expect(error.state).toBe('DISABLED');
    expect(error.reason).toBe('waiting for the server');
    expect(infoPrimaryTap('ERROR', 'UPGRADE', 'ENABLED', null)).toBe('EXPLAIN');
  });

  it('max level is a plate, not a door', () => {
    expect(infoPrimaryTap('READY', 'MAX', 'ENABLED', null)).toBe('NONE');
    expect(infoPrimaryTap('READY', 'UPGRADE', 'BUSY', null)).toBe('NONE');
  });

  it('portraits get the frame, plain icons do not', () => {
    expect(statIconFramed('ui_portrait_dragon_t2')).toBe(true);
    expect(statIconFramed('troop-giant')).toBe(true);
    expect(statIconFramed('attack')).toBe(false);
    expect(statIconFramed('shield')).toBe(false);
  });

  it('stats are spoken with their change and unknown is the ellipsis', () => {
    expect(statSpoken('Hitpoints', '360', '430', null)).toBe('Hitpoints: 360, next level 430');
    expect(statSpoken('Range', '7 tiles', null, null)).toBe('Range: 7 tiles');
    expect(statSpoken('Hits flying troops', null, null, true)).toBe('Hits flying troops: yes');
    expect(statSpoken('Damage per second', null, null, null)).toBe('Damage per second: …');
  });
});
