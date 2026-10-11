import { describe, expect, it } from 'vitest';
import { heroRecoveryLabel, heroRecoveryRevision } from './heroRecovery';

describe('hero recovery display', () => {
  const now = Date.parse('2026-08-12T10:00:00.000Z');

  it('shows the server deadline as a live hour/minute or minute/second countdown', () => {
    expect(heroRecoveryLabel('2026-08-12T11:03:05.000Z', now)).toBe('RECOVERING · 1H 3M');
    expect(heroRecoveryLabel('2026-08-12T10:03:05.000Z', now)).toBe('RECOVERING · 3M 5S');
  });

  it('never invents recovery after the authoritative deadline', () => {
    expect(heroRecoveryLabel(null, now)).toBeNull();
    expect(heroRecoveryLabel('2026-08-12T09:59:59.000Z', now)).toBeNull();
    expect(heroRecoveryLabel('not-a-date', now)).toBeNull();
  });

  it('keeps the server unavailable state truthful across device-clock skew', () => {
    expect(heroRecoveryLabel('2026-08-12T09:59:59.000Z', now, false))
      .toBe('RECOVERING · VERIFYING');
    expect(heroRecoveryLabel('2026-08-12T11:03:05.000Z', now, true)).toBeNull();
  });

  it('changes the refresh revision only when authoritative recovery state changes', () => {
    expect(heroRecoveryRevision(undefined)).toBeNull();
    expect(heroRecoveryRevision([
      { hero: 'theodor', recoveryUntil: '2026-08-12T11:00:00.000Z', available: false },
    ])).toBe('theodor:0:2026-08-12T11:00:00.000Z');
    expect(heroRecoveryRevision([
      { hero: 'theodor', recoveryUntil: '2026-08-12T11:00:00.000Z', available: true },
    ])).toBe('theodor:1:2026-08-12T11:00:00.000Z');
  });
});
