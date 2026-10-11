/**
 * The bus is the seam between Phaser and React, and it must not depend on
 * Phaser: eleven first-paint React modules import `{ bus }` from it, so a value
 * import of Phaser here pins the whole engine into the entry chunk and makes
 * lazy-loading the canvas save nothing.
 *
 * These pin the two behaviours the call sites actually rely on. The
 * unsubscribe-during-dispatch case is not hypothetical — React effects do it on
 * every unmount, and a naive Set iteration throws or skips handlers there.
 */
import { describe, expect, it } from 'vitest';
import { bus, walletErrorNotice } from './events';

describe('the event bus', () => {
  it('delivers a payload to every subscriber', () => {
    const seen: Array<string | null> = [];
    const off1 = bus.on('base:select', (p) => seen.push(p.buildingId));
    const off2 = bus.on('base:select', (p) => seen.push(p.buildingId));
    bus.emit('base:select', { buildingId: 'keep' });
    off1(); off2();
    expect(seen).toEqual(['keep', 'keep']);
  });

  it('stops delivering after unsubscribe', () => {
    let hits = 0;
    const off = bus.on('base:refresh', () => { hits++; });
    bus.emit('base:refresh', undefined);
    off();
    bus.emit('base:refresh', undefined);
    expect(hits).toBe(1);
  });

  it('survives a handler that unsubscribes DURING dispatch', () => {
    // React unmounts do this. Iterating the live Set would skip the sibling.
    const order: string[] = [];
    const offA = bus.on('battle:done', () => { order.push('a'); offA(); });
    const offB = bus.on('battle:done', () => { order.push('b'); });
    expect(() => bus.emit('battle:done', undefined)).not.toThrow();
    offB();
    expect(order).toEqual(['a', 'b']);
  });

  it('emitting an event nobody listens to is a no-op, not a crash', () => {
    expect(() => bus.emit('battle:exit', undefined)).not.toThrow();
  });
});

describe('walletErrorNotice — provider objects stop at the app boundary', () => {
  it('keeps only compact fields the connect sheet can safely display', () => {
    const providerError = {
      name: 'WalletConnectionError',
      message: '  User\n rejected\t the request.  ',
      stack: 'private extension internals',
      cause: { account: 'must-not-cross-the-bus' },
    };
    expect(walletErrorNotice(providerError, 'Phantom')).toEqual({
      walletName: 'Phantom',
      name: 'WalletConnectionError',
      message: 'User rejected the request.',
    });
  });

  it('bounds extension-owned text and supplies a stable error name', () => {
    const notice = walletErrorNotice({ message: 'x'.repeat(500) }, null);
    expect(notice.walletName).toBeNull();
    expect(notice.name).toBe('WalletError');
    expect(notice.message).toHaveLength(240);
  });
});
