/** @vitest-environment happy-dom */
import bs58 from 'bs58';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WALLET = 'RecentAuthWallet1111111111111111111111111';
const INTENT = {
  version: 1 as const,
  grossAmount: '125500000',
  feeBurned: '2510000',
  netAmount: '122990000',
  cluster: 'devnet' as const,
  keepMint: '5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC',
  destination: 'DestinationWallet11111111111111111111111',
  idempotencyKey: 'withdrawal-intent-7',
  mode: 'instant' as const,
  unbondingHours: 0,
};
const MAIL_INTENT = {
  recipientWallet: 'RewardWallet111111111111111111111111111111',
  idempotencyKey: 'mail-reward-intent-7',
  subject: 'Tournament reward',
  attachments: [{ kind: 'KEEP' as const, amount: '125' }],
  contentHash: 'a'.repeat(64),
};

const h = vi.hoisted(() => ({
  sessionWallet: 'RecentAuthWallet1111111111111111111111111',
  signMessage: vi.fn(),
  postRaw: vi.fn(),
  run: null as Promise<void> | null,
  mode: 'withdrawal' as 'withdrawal' | 'mail',
}));

vi.mock('../lib/api', () => ({
  api: { postRaw: h.postRaw },
}));

vi.mock('../state/store', () => ({
  useApp: (select: (state: { wallet: string | null }) => unknown) =>
    select({ wallet: h.sessionWallet }),
}));

vi.mock('./useGameWallet', () => ({
  useGameWallet: () => ({
    publicKey: { toBase58: () => h.sessionWallet },
    signMessage: h.signMessage,
  }),
}));

import { useRecentAuth } from './useRecentAuth';
import { WALLET_SIGNATURE_TIMEOUT_MS } from './walletSignature';

let root: Root | null = null;

function Harness(): React.JSX.Element {
  const { prove, proveWithdrawal } = useRecentAuth();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  function confirm(): void {
    setPending(true);
    setResult('');
    setError('');
    const proof = h.mode === 'mail'
      ? prove('admin_mail_reward', MAIL_INTENT)
      : proveWithdrawal(INTENT).then((result) => result.grant);
    h.run = proof
      .then(setResult)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setPending(false));
  }

  return (
    <div>
      <button type="button" onClick={confirm}>CONFIRM</button>
      <output data-testid="pending">{String(pending)}</output>
      <output data-testid="result">{result}</output>
      <output data-testid="error">{error}</output>
    </div>
  );
}

function button(): HTMLButtonElement {
  const element = document.querySelector('button');
  if (!(element instanceof HTMLButtonElement)) throw new Error('confirm button missing');
  return element;
}

beforeEach(async () => {
  vi.useRealTimers();
  h.sessionWallet = WALLET;
  h.signMessage.mockReset();
  h.postRaw.mockReset();
  h.run = null;
  h.mode = 'withdrawal';
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
});

describe('useRecentAuth wallet signature lifecycle', () => {
  it('binds an admin reward grant to its recipient, delivery key, and content digest', async () => {
    h.mode = 'mail';
    const signature = new Uint8Array([4, 3, 2, 1]);
    h.signMessage.mockResolvedValue(signature);
    h.postRaw.mockImplementation(async (path: string) => path === '/auth/reauth/challenge'
      ? {
          challengeToken: 'mail-challenge',
          message: 'Confirm reward mail\n125 KEEP\nTournament reward',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }
      : {
          grant: 'mail-grant', purpose: 'admin_mail_reward',
          expiresAt: '2099-01-01T00:00:00.000Z',
        });

    await act(async () => {
      button().click();
      await h.run;
    });

    expect(h.postRaw).toHaveBeenNthCalledWith(1, '/auth/reauth/challenge', {
      purpose: 'admin_mail_reward', intent: MAIL_INTENT,
    });
    expect(new TextDecoder().decode(h.signMessage.mock.calls[0]![0] as Uint8Array))
      .toContain('125 KEEP');
    expect(h.postRaw).toHaveBeenNthCalledWith(2, '/auth/reauth/verify', {
      challengeToken: 'mail-challenge', signature: bs58.encode(signature),
    });
    expect(document.querySelector('[data-testid="result"]')?.textContent).toBe('mail-grant');
  });

  it('signs and verifies the exact instant-withdrawal intent', async () => {
    const signature = new Uint8Array([7, 8, 9, 10]);
    h.signMessage.mockResolvedValue(signature);
    h.postRaw.mockImplementation(async (path: string) => {
      if (path === '/auth/reauth/challenge') {
        return {
          challengeToken: 'challenge-token-1',
          message: 'Confirm withdrawal 125.500000 to DestinationWallet',
          expiresAt: '2099-01-01T00:00:00.000Z',
        };
      }
      return {
        grant: 'recent-auth-grant-1',
        purpose: 'withdrawal',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
    });

    await act(async () => {
      button().click();
      await h.run;
    });

    expect(h.postRaw).toHaveBeenNthCalledWith(1, '/auth/reauth/challenge', {
      purpose: 'withdrawal',
      intent: INTENT,
    });
    expect(h.signMessage).toHaveBeenCalledOnce();
    expect(Array.from(h.signMessage.mock.calls[0]![0] as Uint8Array))
      .toEqual(Array.from(new TextEncoder().encode(
        'Confirm withdrawal 125.500000 to DestinationWallet',
      )));
    expect(h.postRaw).toHaveBeenNthCalledWith(2, '/auth/reauth/verify', {
      challengeToken: 'challenge-token-1',
      signature: bs58.encode(signature),
    });
    expect(document.querySelector('[data-testid="pending"]')?.textContent).toBe('false');
    expect(document.querySelector('[data-testid="result"]')?.textContent)
      .toBe('recent-auth-grant-1');
    expect(document.querySelector('[data-testid="error"]')?.textContent).toBe('');
  });

  it('returns a retryable error and clears pending when the wallet never settles', async () => {
    vi.useFakeTimers();
    h.postRaw.mockResolvedValue({
      challengeToken: 'challenge-token-timeout',
      message: 'Confirm exact sensitive action',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    h.signMessage.mockReturnValue(new Promise(() => undefined));

    await act(async () => {
      button().click();
      await Promise.resolve();
    });
    expect(h.signMessage).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="pending"]')?.textContent).toBe('true');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WALLET_SIGNATURE_TIMEOUT_MS);
      await h.run;
    });

    expect(document.querySelector('[data-testid="pending"]')?.textContent).toBe('false');
    expect(document.querySelector('[data-testid="error"]')?.textContent)
      .toMatch(/wallet signature timed out/i);
    expect(document.querySelector('[data-testid="result"]')?.textContent).toBe('');
    expect(h.postRaw).toHaveBeenCalledOnce();
    expect(h.postRaw).toHaveBeenCalledWith('/auth/reauth/challenge', {
      purpose: 'withdrawal',
      intent: INTENT,
    });
    expect(h.postRaw.mock.calls.some(([path]) => path === '/auth/reauth/verify')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
