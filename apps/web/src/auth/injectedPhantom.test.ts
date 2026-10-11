import { describe, expect, it, vi } from 'vitest';
import {
  injectedPhantomProvider, isMobileInjectedPhantom,
  type InjectedPhantomProvider,
} from './injectedPhantom';

function provider(over: Partial<InjectedPhantomProvider> = {}): InjectedPhantomProvider {
  return {
    isPhantom: true,
    connect: vi.fn().mockResolvedValue(undefined),
    signMessage: vi.fn().mockResolvedValue({ signature: new Uint8Array(64) }),
    signTransaction: vi.fn(async (transaction) => transaction),
    on: vi.fn(),
    ...over,
  };
}

describe('injected Phantom recovery seam', () => {
  it('uses only the official window.phantom.solana provider on mobile', () => {
    const phantom = provider();
    expect(injectedPhantomProvider({ phantom: { solana: phantom } })).toBe(phantom);
    expect(isMobileInjectedPhantom('android', 'Phantom', phantom)).toBe(true);
    expect(isMobileInjectedPhantom('ios', 'PHANTOM', phantom)).toBe(true);
    expect(isMobileInjectedPhantom('android', 'Phantom Mobile', phantom)).toBe(true);
    expect(isMobileInjectedPhantom('desktop', 'Phantom', phantom)).toBe(false);
    expect(isMobileInjectedPhantom('android', 'Solflare', phantom)).toBe(false);
  });

  it('treats a missing, incomplete, impostor, or throwing provider as unavailable', () => {
    expect(injectedPhantomProvider({})).toBeNull();
    expect(injectedPhantomProvider({ phantom: { solana: provider({ isPhantom: false }) } })).toBeNull();
    expect(injectedPhantomProvider({
      phantom: { solana: { ...provider(), signMessage: undefined } as unknown as InjectedPhantomProvider },
    })).toBeNull();
    const source = Object.defineProperty({}, 'phantom', {
      get: () => { throw new Error('provider blocked'); },
    });
    expect(injectedPhantomProvider(source)).toBeNull();
  });

});
