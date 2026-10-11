/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../lib/events';
import { readRaidResumePointer, writeRaidResumePointer } from '../lib/raidResume';
import { baseAuthorityRequestScope, recoverBaseAuthority } from './baseAuthorityRecovery';
import { useApp, type BaseStateDto } from './store';

vi.mock('../lib/analytics', () => ({ captureError: vi.fn() }));
const wallet = 'authority-wallet';
const baseId = 'owned-base';
describe('recoverable authority and presentation-only exits', () => {
  let off: Array<() => void>;
  beforeEach(() => {
    useApp.getState().setAuth(wallet);
    useApp.setState({ screen: 'battle', selectedBaseId: baseId,
      base: { id: baseId } as unknown as BaseStateDto,
      raidTarget: { kind: 'campaign', stage: 100 } });
    writeRaidResumePointer(localStorage, { version: 1, wallet, baseId, raidId: 'raid',
      mode: 'campaign', role: 'attacker', phase: 'playing', target: { stage: 100 },
      clock: { revision: 1, rate: 1 }, inFlightSpeed: null });
    off = [];
  });
  afterEach(() => {
    off.forEach((dispose) => dispose());
    localStorage.clear();
    useApp.getState().setAuth(null);
    vi.restoreAllMocks();
  });

  it('keeps uncertain chain authority in place with the exact base and durable raid pointer', () => {
    const before = useApp.getState();
    const exit = vi.fn(); const toast = vi.fn();
    off.push(bus.on('battle:exit', exit), bus.on('ui:toast', toast));
    recoverBaseAuthority('DEED_AUTHORITY_UNAVAILABLE');
    expect(useApp.getState()).toBe(before);
    expect(exit).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({ msg: expect.stringContaining('RETRY YOUR ACTION') });
    expect(readRaidResumePointer(localStorage, wallet, baseId)?.raidId).toBe('raid');
  });

  it('retires battle presentation before confirmed-loss selection and preserves canonical recovery', () => {
    const transitions: string[] = [];
    off.push(bus.on('battle:exit', () => transitions.push(`exit:${useApp.getState().screen}`)));
    off.push(useApp.subscribe((state) => { if (state.screen === 'bases') transitions.push('picker'); }));
    recoverBaseAuthority('DEED_OWNERSHIP_CHANGED');
    expect(transitions).toEqual(['exit:battle', 'picker']);
    expect(useApp.getState()).toMatchObject({ screen: 'bases', base: null, selectedBaseId: null,
      raidTarget: null, scoutReport: null });
    expect(readRaidResumePointer(localStorage, wallet, baseId)?.raidId).toBe('raid');
  });

  it('does not trap navigation behind an individual visual cleanup failure', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    off.push(bus.on('battle:exit', () => { throw new Error('bad effect'); }));
    expect(() => recoverBaseAuthority('BASE_NOT_OWNED')).not.toThrow();
    expect(useApp.getState().screen).toBe('bases');
    expect(readRaidResumePointer(localStorage, wallet, baseId)?.raidId).toBe('raid');
  });

  it('invalidates request authority on wallet changes and same-base reselection', () => {
    const first = baseAuthorityRequestScope();
    useApp.setState((state) => ({ baseSelectionEpoch: state.baseSelectionEpoch + 1 }));
    expect(baseAuthorityRequestScope()).not.toBe(first);
    const second = baseAuthorityRequestScope();
    useApp.getState().setAuth('other-wallet');
    expect(baseAuthorityRequestScope()).not.toBe(second);
  });
});
