/** @vitest-environment happy-dom */
import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { PublicKey, SendTransactionError } from '@solana/web3.js';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REFERENCE = '11111111111111111111111111111111';
const h = vi.hoisted(() => ({
  fundingRequired: 200_000_001,
  fundingBalance: 1_000_000_000,
  fundingError: false,
  postRaw: vi.fn(),
  get: vi.fn(),
  wallet: 'wallet-a',
  signerWallet: undefined as string | null | undefined,
  post: vi.fn(),
  sendTransaction: vi.fn(),
  buildPayEntryTx: vi.fn((..._args: unknown[]) => ({ kind: 'entry-tx' })),
  buildBuySinkTx: vi.fn((..._args: unknown[]) => ({ kind: 'deed-tx' })),
  setEntryPaid: vi.fn(),
  done: vi.fn(),
}));

vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection: {} }) }));
vi.mock('./landPayment', () => ({ prepareLandPayment: async (_connection: unknown, wallet: unknown, reference: unknown, reservation: { kind: string; amountLamports: number }) => {
  if (h.fundingError) throw new Error('SOL funding estimate unavailable');
  return { transaction: reservation.kind === 'entry' ? h.buildPayEntryTx(wallet, reference) : h.buildBuySinkTx(wallet, reference, 'deed', BigInt(reservation.amountLamports)),
    estimate: { requiredLamports: h.fundingRequired, balanceLamports: h.fundingBalance } };
} }));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: { get: h.get, postRaw: h.postRaw, post: h.post } }));
vi.mock('../lib/chain', () => ({
  buildPayEntryTx: h.buildPayEntryTx,
  buildBuySinkTx: h.buildBuySinkTx,
  isAlreadyPaidError: () => false,
}));
vi.mock('../state/store', () => ({
  useApp: Object.assign((select: (state: { wallet: string }) => unknown) => select({ wallet: h.wallet }), { getState: () => ({ wallet: h.wallet, setEntryPaid: h.setEntryPaid }) }),
}));
vi.mock('./useGameWallet', () => ({
  useGameWallet: () => ({
    publicKey: h.signerWallet === null ? null : { toBase58: () => h.signerWallet ?? h.wallet },
    sendTransaction: h.sendTransaction,
  }),
}));

import { landPaymentError, landReservationIdentity, usePayEntry, type LandPurchaseKind } from './useEntry';

let root: Root | null = null;

function Harness({ kind }: { kind: LandPurchaseKind }): React.JSX.Element {
  const flow = usePayEntry(kind, h.done);
  const [cell, setCell] = useState('1234');
  return <div>
    <input aria-label="cell" value={cell} onChange={(event) => setCell(event.target.value)} />
    <button onClick={() => void flow.reserve(Number(cell))}>RESERVE</button>
    <button onClick={() => void flow.reserve()}>RANDOM</button>
    <button onClick={() => void flow.submit()}>PAY</button>
    <button disabled={!flow.canRetryEntry} onClick={() => void flow.retryPayment()}>RETRY</button>
    <output data-testid="retry-seconds">{flow.retryEntryInSec ?? ''}</output>
    <output data-testid="reservation-retry-seconds">{flow.reservationRetryInSec ?? ''}</output>
    <output data-testid="phase">{flow.phase}</output>
    <output data-testid="reserved">{flow.reservation?.earthCell ?? ''}</output>
    <output data-testid="country">{flow.reservation ? `${flow.reservation.countryA3 ?? '-'}|${flow.reservation.countryName ?? '-'}` : ''}</output>
    <output data-testid="error">{flow.error ?? ''}</output>
  </div>;
}

async function mount(kind: LandPurchaseKind): Promise<void> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness kind={kind} />); });
}

function click(label: string): void {
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`${label} button missing`);
  button.click();
}

// The pre-sign read is independent of later /paid or /verify responses.
async function freshReservedRead(path: string): Promise<unknown> {
  if (path === '/me') return { wallet: h.wallet, entryPaid: false };
  const index = h.postRaw.mock.calls.map(([url]) => url === '/deposits').lastIndexOf(true);
  const row = index >= 0 ? await h.postRaw.mock.results[index]?.value : RESUMABLE;
  return { ...row, status: row?.status ?? 'pending',
    payableUntil: row?.payableUntil ?? new Date(Date.now() + 20 * 60_000).toISOString() };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  for (const mock of Object.values(h)) if (typeof mock === 'function') mock.mockReset();
  h.fundingRequired = 200_000_001; h.fundingBalance = 1_000_000_000; h.fundingError = false;
  h.wallet = 'wallet-a'; h.signerWallet = undefined;
  localStorage.clear();
  h.buildPayEntryTx.mockReturnValue({ kind: 'entry-tx' });
  h.buildBuySinkTx.mockReturnValue({ kind: 'deed-tx' });
  h.sendTransaction.mockResolvedValue('signature');
  h.get.mockImplementation(freshReservedRead);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('land checkout reservation before wallet approval', () => {
  it('freezes and exposes the requested entry cell before opening the wallet', async () => {
    h.postRaw.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001', reference: REFERENCE,
      kind: 'entry', baseId: '00000000-0000-4000-8000-000000000002',
      earthCell: 1234, amountLamports: 200_000_000,
    });
    h.post.mockResolvedValue({ id: 'deposit-1', status: 'credited' });
    await mount('entry');

    await act(async () => { click('RESERVE'); await Promise.resolve(); });
    expect(h.postRaw).toHaveBeenCalledWith('/deposits', { kind: 'entry', earthCell: 1234 }, { signal: expect.any(AbortSignal) });
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('ready');
    expect(document.querySelector('[data-testid="reserved"]')?.textContent).toBe('1234');
    expect(h.sendTransaction).not.toHaveBeenCalled();

    await act(async () => { click('PAY'); await Promise.resolve(); await Promise.resolve(); });
    expect(h.buildPayEntryTx).toHaveBeenCalledOnce();
    expect(h.sendTransaction).toHaveBeenCalledOnce();
    expect(h.post).toHaveBeenCalledWith('/deposits/00000000-0000-4000-8000-000000000001/verify', undefined, { signal: expect.any(AbortSignal) });
    expect(h.setEntryPaid).toHaveBeenCalledWith(true);
    expect(h.done).toHaveBeenCalledWith(expect.objectContaining({ kind: 'entry', earthCell: 1234 }));
  });

  it('uses a repeatable deed sink only after a random cell is returned', async () => {
    h.postRaw.mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000003', reference: REFERENCE,
      kind: 'deed', baseId: '00000000-0000-4000-8000-000000000004',
      earthCell: 5678, amountLamports: 200_000_000,
    });
    h.post.mockResolvedValue({ id: 'deposit-2', status: 'credited' });
    await mount('deed');

    await act(async () => { click('RANDOM'); await Promise.resolve(); });
    expect(h.postRaw).toHaveBeenCalledWith('/deposits', { kind: 'deed' }, { signal: expect.any(AbortSignal) });
    expect(h.sendTransaction).not.toHaveBeenCalled();

    await act(async () => { click('PAY'); await Promise.resolve(); await Promise.resolve(); });
    expect(h.buildBuySinkTx).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'deed', 200_000_000n,
    );
    expect(h.setEntryPaid).not.toHaveBeenCalled();
    expect(h.done).toHaveBeenCalledWith(expect.objectContaining({ kind: 'deed', earthCell: 5678 }));
  });

  it('carries the country the server froze, and null (never a guess) when an older API sent none', async () => {
    // D-103: the parcel must read as LAND before the wallet prompt, so the
    // reservation carries the frozen country. It is presentation only — the
    // cell/quote/reference contract is unchanged — and a rolling deploy against
    // an API without the field must still reserve and pay exactly as before.
    h.postRaw.mockResolvedValueOnce({
      id: '00000000-0000-4000-8000-000000000005', reference: REFERENCE,
      kind: 'entry', baseId: '00000000-0000-4000-8000-000000000006',
      earthCell: 4321, amountLamports: 200_000_000, countryA3: 'GEO', countryName: 'Georgia',
    });
    await mount('entry');
    await act(async () => { click('RANDOM'); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('ready');
    expect(document.querySelector('[data-testid="country"]')?.textContent).toBe('GEO|Georgia');

    await act(async () => { root?.unmount(); });
    localStorage.clear(); // This case explicitly exercises a new intent from an older API.
    h.postRaw.mockResolvedValueOnce({
      id: '00000000-0000-4000-8000-000000000007', reference: REFERENCE,
      kind: 'entry', baseId: '00000000-0000-4000-8000-000000000008',
      earthCell: 4321, amountLamports: 200_000_000,
    });
    await mount('entry');
    await act(async () => { click('RANDOM'); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('ready');
    expect(document.querySelector('[data-testid="country"]')?.textContent).toBe('-|-');
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });
});


const RESUMABLE = {
  id: '00000000-0000-4000-8000-000000000021', reference: REFERENCE, kind: 'entry' as const,
  baseId: '00000000-0000-4000-8000-000000000022', earthCell: 5432, amountLamports: 200_000_000,
  countryA3: 'GEO', countryName: 'Georgia', status: 'pending' as const,
};

describe('funding before wallet handoff', () => {
  it('does not open a wallet when SOL covers the price but not its fees', async () => {
    h.postRaw.mockResolvedValue(RESUMABLE);
    h.fundingBalance = RESUMABLE.amountLamports;
    await mount('entry');
    await act(async () => { click('RANDOM'); });
    await act(async () => { click('PAY'); });
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('ready');
    expect(document.querySelector('[data-testid="error"]')?.textContent).toContain('NOT ENOUGH SOL');
    expect(localStorage.getItem('shardkeep:land:devnet:wallet-a:entry')).not.toContain('submitted');
  });
  it('an unknown fee leaves the same reservation retryable without pretending payment was submitted', async () => {
    h.postRaw.mockResolvedValue(RESUMABLE);
    h.fundingError = true;
    await mount('entry');
    await act(async () => { click('RANDOM'); });
    await act(async () => { click('PAY'); });
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="error"]')?.textContent).toContain('COULD NOT CHECK SOL AND FEES');
    expect(localStorage.getItem('shardkeep:land:devnet:wallet-a:entry')).not.toContain('submitted');
    h.fundingError = false;
    h.post.mockResolvedValue({ id: RESUMABLE.id, status: 'credited' });
    await act(async () => { click('PAY'); });
    expect(h.sendTransaction).toHaveBeenCalledOnce();
    expect(h.postRaw.mock.calls.filter(([url]) => url === '/deposits')).toHaveLength(1);
    expect(h.setEntryPaid).toHaveBeenCalledWith(true);
  });
});
async function remount(): Promise<void> {
  await act(async () => { root?.unmount(); });
  document.body.replaceChildren();
  h.get.mockImplementation(freshReservedRead);
  await mount('entry');
}

describe('durable land intent and payment recovery', () => {
  it('resumes an unsigned reservation after reload without creating a second payable reference', async () => {
    h.postRaw.mockResolvedValue(RESUMABLE);
    await mount('entry');
    await act(async () => { click('RANDOM'); });
    await remount();
    expect(h.get).toHaveBeenCalledWith(`/deposits/${RESUMABLE.id}`, { signal: expect.any(AbortSignal) });
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('ready');
    expect(document.querySelector('[data-testid="reserved"]')?.textContent).toBe('5432');
    expect(h.postRaw).toHaveBeenCalledOnce();
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it('resumes a submitted signature after reload, scanning even while the paid endpoint is unavailable', async () => {
    h.postRaw.mockResolvedValue(RESUMABLE);
    h.post.mockResolvedValue({ status: 'pending' });
    await mount('entry');
    await act(async () => { click('RANDOM'); });
    await act(async () => { click('PAY'); });
    h.postRaw.mockRejectedValue(new Error('confirmed RPC catching up'));
    h.post.mockResolvedValue({ status: 'credited' });
    await remount();
    expect(h.post).toHaveBeenCalledWith(`/deposits/${RESUMABLE.id}/verify`, undefined, { signal: expect.any(AbortSignal) });
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('credited');
    await act(async () => { click('PAY'); });
    expect(h.sendTransaction).toHaveBeenCalledOnce();
  });

  it('fresh /me payment truth prevents PAY when a restored older intent still says pending', async () => {
    h.postRaw.mockResolvedValue(RESUMABLE);
    await mount('entry');
    await act(async () => { click('RANDOM'); });
    await act(async () => { root?.unmount(); });
    document.body.replaceChildren();
    h.get.mockImplementation(async (path: string) => path === '/me'
      ? { wallet: h.wallet, entryPaid: true } : RESUMABLE);
    await mount('entry');
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('credited');
    await act(async () => { click('PAY'); });
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });

  it('double tapping PAY produces one signature and a credit never returns to ready', async () => {
    h.postRaw.mockResolvedValue(RESUMABLE);
    h.post.mockResolvedValue({ status: 'credited' });
    await mount('entry');
    await act(async () => { click('RANDOM'); });
    await act(async () => { click('PAY'); click('PAY'); });
    expect(h.sendTransaction).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('credited');
  });

  it('a signature returned after wallet switching is retained for its original wallet without crediting the new one', async () => {
    h.postRaw.mockResolvedValue(RESUMABLE);
    let sent!: (signature: string) => void;
    h.sendTransaction.mockReturnValue(new Promise<string>((resolve) => { sent = resolve; }));
    await mount('entry');
    await act(async () => { click('RANDOM'); });
    await act(async () => { click('PAY'); });
    h.wallet = 'wallet-b';
    await act(async () => { root!.render(<Harness kind="entry" />); });
    await act(async () => { sent('late-signature'); });
    expect(h.setEntryPaid).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('idle');
    expect(Object.values(localStorage).join(' ')).toContain('late-signature');
  });

  it('a deed send that loses its acknowledgement cannot be paid again, including after reload', async () => {
    const deed = { ...RESUMABLE, kind: 'deed' as const };
    h.postRaw.mockResolvedValue(deed);
    h.post.mockResolvedValue({ status: 'pending' });
    // The wallet broadcast successfully, but the transport rejected before it
    // returned a signature. A fresh blockhash on another PAY would charge twice.
    h.sendTransaction.mockRejectedValue(new Error('fetch failed after broadcast'));
    await mount('deed');
    await act(async () => { click('RANDOM'); });
    await act(async () => { click('PAY'); });
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('confirming');
    expect(Object.values(localStorage).join(' ')).toContain('"submitted":true');
    await act(async () => { click('PAY'); });
    expect(h.sendTransaction).toHaveBeenCalledOnce();
    expect(h.post).toHaveBeenCalledWith(`/deposits/${deed.id}/verify`, undefined, { signal: expect.any(AbortSignal) });
    await act(async () => { root?.unmount(); });
    document.body.replaceChildren();
    h.get.mockImplementation(async (path: string) => path === '/me'
      ? { wallet: h.wallet, entryPaid: true } : deed);
    await mount('deed');
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('confirming');
    await act(async () => { click('PAY'); });
    expect(h.sendTransaction).toHaveBeenCalledOnce();
  });

  it.each([
    Object.assign(new Error('User rejected transaction'), { code: 4001 }),
    new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'insufficient funds for rent' }),
  ])('a proven pre-broadcast refusal permits a later explicit payment attempt', async (failure) => {
    h.postRaw.mockResolvedValue(RESUMABLE);
    h.sendTransaction.mockRejectedValue(failure);
    await mount('entry');
    await act(async () => { click('RANDOM'); });
    await act(async () => { click('PAY'); });
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('ready');
    expect(Object.values(localStorage).join(' ')).not.toContain('"submitted":true');
    expect(h.post).not.toHaveBeenCalled();
  });

  it('an interrupted network request called cancelled is not mistaken for user payment rejection', async () => {
    h.postRaw.mockResolvedValue(RESUMABLE);
    h.post.mockResolvedValue({ status: 'pending' });
    h.sendTransaction.mockRejectedValue(new Error('network request cancelled'));
    await mount('entry');
    await act(async () => { click('RANDOM'); });
    await act(async () => { click('PAY'); });
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('confirming');
    expect(Object.values(localStorage).join(' ')).toContain('"submitted":true');
  });

  it('an ambiguous rejection after wallet switching leaves the original wallet unresolved without changing the next wallet', async () => {
    h.postRaw.mockResolvedValue(RESUMABLE);
    let reject!: (error: Error) => void;
    h.sendTransaction.mockReturnValue(new Promise<string>((_resolve, fail) => { reject = fail; }));
    await mount('entry');
    await act(async () => { click('RANDOM'); });
    await act(async () => { click('PAY'); });
    h.wallet = 'wallet-b';
    await act(async () => { root!.render(<Harness kind="entry" />); });
    await act(async () => { reject(new Error('lost acknowledgement')); });
    expect(h.setEntryPaid).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('idle');
    expect(Object.values(localStorage).join(' ')).toContain('"submitted":true');
  });

  it('normalizes cancellation and insufficient funds into recoverable player actions', () => {
    expect(landPaymentError(new Error('User rejected transaction'))).toContain('STILL RESERVED');
    expect(landPaymentError(new Error('insufficient lamports'))).toContain('NETWORK FEE');
  });
});

describe('wrong-network and delayed land payment recovery', () => {
  const phase = () => document.querySelector('[data-testid="phase"]')?.textContent;
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  async function ready(): Promise<void> {
    h.postRaw.mockResolvedValue(RESUMABLE);
    h.post.mockResolvedValue({ status: 'pending' });
    await mount('entry');
    await act(async () => { click('RANDOM'); });
  }

  it('checks a never-returning wallet response without requesting a second payment', async () => {
    vi.useFakeTimers();
    let finish!: (signature: string) => void;
    h.sendTransaction.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    await ready();
    h.post.mockResolvedValue({ status: 'credited' });
    await act(async () => { click('PAY'); });
    expect(phase()).toBe('paying');
    await advance(LAND_CHECKOUT_RECOVERY.walletResponseGraceMs);
    expect(phase()).toBe('credited');
    expect(h.done).toHaveBeenCalledOnce();
    const checks = h.post.mock.calls.length;
    await act(async () => { finish('late-signature'); click('PAY'); });
    await advance(LAND_CHECKOUT_RECOVERY.pollMs * 2);
    expect(phase()).toBe('credited');
    expect(h.done).toHaveBeenCalledOnce();
    expect(h.post).toHaveBeenCalledTimes(checks);
    expect(h.sendTransaction).toHaveBeenCalledOnce();
  });

  it('an old wallet rejection cannot regress a replacement reservation that already credited', async () => {
    vi.useFakeTimers();
    let rejectOld!: (error: Error) => void;
    h.sendTransaction.mockReturnValueOnce(new Promise<string>((_, reject) => { rejectOld = reject; }));
    await ready();
    h.post.mockResolvedValue({ status: 'expired' });
    await act(async () => { click('PAY'); });
    await advance(LAND_CHECKOUT_RECOVERY.walletResponseGraceMs);
    expect(phase()).toBe('idle');
    const replacement = { ...RESUMABLE, id: '00000000-0000-4000-8000-000000000031' };
    h.postRaw.mockResolvedValue(replacement);
    h.sendTransaction.mockResolvedValue('new-payment');
    h.post.mockResolvedValue({ status: 'credited' });
    await act(async () => { click('RANDOM'); });
    await act(async () => { click('PAY'); });
    expect(phase()).toBe('credited');
    await act(async () => { rejectOld(Object.assign(new Error('User rejected transaction'), { code: 4001 })); });
    expect(phase()).toBe('credited');
    expect(h.done).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="error"]')?.textContent).toBe('');
    expect(Object.values(localStorage).join(' ')).toContain('new-payment');
  });

  it('a stuck paid acknowledgement cannot stop reference verification from crediting', async () => {
    vi.useFakeTimers();
    await ready();
    h.postRaw.mockReturnValue(new Promise(() => undefined));
    h.post.mockResolvedValue({ status: 'credited' });
    await act(async () => { click('PAY'); });
    expect(phase()).toBe('credited');
    expect(h.done).toHaveBeenCalledOnce();
    await advance(LAND_CHECKOUT_RECOVERY.requestTimeoutMs + LAND_CHECKOUT_RECOVERY.pollMs);
    expect(h.done).toHaveBeenCalledOnce();
    expect(h.sendTransaction).toHaveBeenCalledOnce();
  });

  it('retries a stalled verifier and ignores its late response after a newer check credits', async () => {
    vi.useFakeTimers();
    let resolveOld!: (row: { status: string }) => void;
    await ready();
    h.post.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue({ status: 'credited' });
    await act(async () => { click('PAY'); });
    expect(phase()).toBe('confirming');
    await advance(LAND_CHECKOUT_RECOVERY.requestTimeoutMs + LAND_CHECKOUT_RECOVERY.pollMs);
    expect(phase()).toBe('credited');
    await act(async () => { resolveOld({ status: 'expired' }); });
    expect(phase()).toBe('credited');
    expect(h.done).toHaveBeenCalledOnce();
  });

  it.each(['/me', 'deposit'])('recovers a stalled %s restoration without another wallet signature', async (stalled) => {
    vi.useFakeTimers();
    await ready();
    await act(async () => { click('PAY'); });
    await act(async () => { root?.unmount(); });
    document.body.replaceChildren();
    let stalledOnce = false;
    h.get.mockImplementation((path: string) => {
      if (!stalledOnce && (stalled === '/me' ? path === '/me' : path !== '/me')) {
        stalledOnce = true;
        return new Promise(() => undefined);
      }
      return Promise.resolve(path === '/me' ? { wallet: h.wallet, entryPaid: false } : RESUMABLE);
    });
    h.post.mockResolvedValue({ status: 'credited' });
    await mount('entry');
    expect(phase()).toBe('restoring');
    await advance(LAND_CHECKOUT_RECOVERY.requestTimeoutMs + LAND_CHECKOUT_RECOVERY.pollMs);
    expect(phase()).toBe('credited');
    expect(h.sendTransaction).toHaveBeenCalledOnce();
  });

  it('keeps an ambiguous wrong-network attempt pending through reload until the server expires it', async () => {
    vi.useFakeTimers();
    await ready();
    h.sendTransaction.mockRejectedValue(new Error('Backpack network request failed'));
    await act(async () => { click('PAY'); });
    expect(phase()).toBe('confirming');
    await remount();
    await act(async () => { click('PAY'); });
    expect(h.sendTransaction).toHaveBeenCalledOnce();
    // Local elapsed time is never a substitute for the server's negative scan.
    await advance(LAND_CHECKOUT_RECOVERY.pollMs * 2);
    expect(phase()).toBe('confirming');
    h.post.mockResolvedValue({ status: 'expired' });
    await advance(LAND_CHECKOUT_RECOVERY.pollMs);
    expect(phase()).toBe('idle');
    expect(Object.values(localStorage).join(' ')).not.toContain('submitted');
    expect(document.querySelector('[data-testid="error"]')?.textContent).toContain('CHOOSE YOUR LAND AGAIN');
    h.postRaw.mockResolvedValue({ ...RESUMABLE, id: 'replacement-id' });
    h.sendTransaction.mockResolvedValue('devnet-payment');
    h.post.mockResolvedValue({ status: 'credited' });
    await act(async () => { click('RANDOM'); });
    await act(async () => { click('PAY'); });
    expect(phase()).toBe('credited');
    expect(h.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it('a delayed wallet from the previous account cannot start polling for the next account', async () => {
    vi.useFakeTimers();
    h.sendTransaction.mockReturnValue(new Promise(() => undefined));
    await ready();
    await act(async () => { click('PAY'); });
    h.wallet = 'wallet-b';
    await act(async () => { root!.render(<Harness kind="entry" />); });
    await advance(LAND_CHECKOUT_RECOVERY.walletResponseGraceMs * 2);
    expect(phase()).toBe('idle');
    expect(h.post).not.toHaveBeenCalled();
    expect(h.done).not.toHaveBeenCalled();
  });
});

describe('leaving checkout and returning to the same payment', () => {
  it('stops local checks on exit and restores the intent after a late wallet signature', async () => {
    vi.useFakeTimers();
    let finish!: (signature: string) => void;
    h.postRaw.mockResolvedValue(RESUMABLE);
    h.sendTransaction.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    await mount('entry');
    await act(async () => { click('RANDOM'); });
    await act(async () => { click('PAY'); });
    await act(async () => { root?.unmount(); });
    document.body.replaceChildren();
    await act(async () => { finish('paid-while-away'); await vi.advanceTimersByTimeAsync(LAND_CHECKOUT_RECOVERY.walletResponseGraceMs); });
    expect(h.done).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
    expect(Object.values(localStorage).join(' ')).toContain('paid-while-away');
    h.get.mockImplementation(async (path: string) => path === '/me' ? { wallet: h.wallet, entryPaid: false } : RESUMABLE);
    h.post.mockResolvedValue({ status: 'credited' });
    await mount('entry');
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('credited');
    expect(h.done).toHaveBeenCalledOnce();
    expect(h.sendTransaction).toHaveBeenCalledOnce();
  });
});

describe('one-minute retry of the same one-time entry payment', () => {
  const start = Date.parse('2026-09-06T16:00:00Z');
  const quoted = () => ({ ...RESUMABLE, serverNow: new Date(Date.now()).toISOString(), payableUntil: new Date(start + 20 * 60_000).toISOString(), retryAt: new Date(start + 30 * 60_000).toISOString() });
  const phase = () => document.querySelector('[data-testid="phase"]')?.textContent;
  const retryButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'RETRY')!;
  const advance = async (ms: number = LAND_CHECKOUT_RECOVERY.firstEntryRetryMs) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  async function waiting(kind: LandPurchaseKind = 'entry', reservation = quoted()): Promise<void> {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const row = { ...reservation, kind, serverNow: new Date(start).toISOString() };
    h.postRaw.mockResolvedValue(row); h.post.mockResolvedValue(row);
    h.get.mockImplementation(async (path: string) => path === '/me' ? { wallet: h.wallet, entryPaid: false } : row);
    h.sendTransaction.mockReturnValueOnce(new Promise(() => undefined));
    await mount(kind);
    await act(async () => { click('RANDOM'); });
    await act(async () => { click('PAY'); });
  }

  it('requires one minute and an explicit click, then signs the same parcel once despite double tapping', async () => {
    await waiting();
    await advance(LAND_CHECKOUT_RECOVERY.firstEntryRetryMs - 1000);
    expect(retryButton().disabled).toBe(true);
    await advance(1000);
    expect(retryButton().disabled).toBe(false);
    expect(h.sendTransaction).toHaveBeenCalledOnce();
    await act(async () => { click('RETRY'); click('RETRY'); });
    expect(h.sendTransaction).toHaveBeenCalledTimes(2);
    expect(h.buildPayEntryTx).toHaveBeenNthCalledWith(2, expect.anything(), new PublicKey(REFERENCE));
    expect(h.postRaw.mock.calls.filter(([path]) => path === '/deposits')).toHaveLength(1);
    expect(Object.values(localStorage).join(' ')).toContain(RESUMABLE.id);
  });

  it.each(['me', 'deposit'])('never resigns when fresh %s proves the first payment already credited', async (source) => {
    await waiting(); await advance();
    if (source === 'me') h.get.mockResolvedValue({ wallet: h.wallet, entryPaid: true });
    else h.post.mockResolvedValue({ ...quoted(), status: 'credited' });
    await act(async () => { click('RETRY'); });
    expect(phase()).toBe('credited');
    expect(h.sendTransaction).toHaveBeenCalledOnce();
    expect(h.done).toHaveBeenCalledOnce();
  });

  it.each(['deed', 'closed-window'])('does not enable this exception for %s', async (caseName) => {
    await waiting(caseName === 'deed' ? 'deed' : 'entry', {
      ...quoted(), payableUntil: new Date(start + (caseName === 'closed-window' ? 30_000 : 20 * 60_000)).toISOString(),
    });
    await advance();
    expect(retryButton().disabled).toBe(true);
    await act(async () => { click('RETRY'); click('PAY'); });
    expect(h.sendTransaction).toHaveBeenCalledOnce();
    expect(phase()).toBe('confirming');
  });

  it('adopts a server-known first payment during retry without another wallet request or fee', async () => {
    await waiting(); await advance();
    h.post.mockResolvedValue({ ...quoted(), paymentSignature: 'other-device-entry-payment' });
    await act(async () => { click('RETRY'); });
    expect(phase()).toBe('confirming');
    expect(h.sendTransaction).toHaveBeenCalledOnce();
    expect(Object.values(localStorage).join(' ')).toContain('other-device-entry-payment');
    expect(h.postRaw).toHaveBeenCalledWith(`/deposits/${RESUMABLE.id}/paid`, { signature: 'other-device-entry-payment' }, { signal: expect.any(AbortSignal) });
  });

  it('rechecks the payable window after verification instead of trusting the enabled button', async () => {
    await waiting(); await advance();
    h.post.mockResolvedValue({ ...quoted(), payableUntil: new Date(start).toISOString() });
    await act(async () => { click('RETRY'); });
    expect(h.sendTransaction).toHaveBeenCalledOnce();
    expect(phase()).toBe('confirming');
    expect(document.querySelector('[data-testid="error"]')?.textContent).toContain('COULD NOT CONFIRM A SAFE RETRY');
    expect(retryButton().disabled).toBe(true);
  });

  it('preserves the original unknown payment when the new wallet prompt is rejected', async () => {
    await waiting(); await advance();
    h.sendTransaction.mockRejectedValue(Object.assign(new Error('User rejected transaction'), { code: 4001 }));
    await act(async () => { click('RETRY'); });
    expect(phase()).toBe('confirming');
    expect(Object.values(localStorage).join(' ')).toContain('"submitted":true');
    expect(retryButton().disabled).toBe(true);
    await act(async () => { click('PAY'); });
    expect(h.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it('does not let a superseded signature replace the new attempt or regress a credited result', async () => {
    await waiting();
    // Replace the first unresolved promise with a controllable original attempt.
    await act(async () => { root?.unmount(); }); document.body.replaceChildren(); localStorage.clear();
    let oldResolve!: (signature: string) => void;
    h.sendTransaction.mockReset().mockReturnValueOnce(new Promise<string>((resolve) => { oldResolve = resolve; })).mockResolvedValue('new-signature');
    await mount('entry');
    await act(async () => { click('RANDOM'); }); await act(async () => { click('PAY'); }); await advance();
    await act(async () => { click('RETRY'); });
    h.post.mockResolvedValue({ ...quoted(), status: 'credited' });
    await advance(LAND_CHECKOUT_RECOVERY.pollMs);
    expect(phase()).toBe('credited');
    await act(async () => { oldResolve('superseded-signature'); });
    expect(Object.values(localStorage).join(' ')).toContain('new-signature');
    expect(Object.values(localStorage).join(' ')).not.toContain('superseded-signature');
    expect(phase()).toBe('credited');
    expect(h.done).toHaveBeenCalledOnce();
  });

  it.each([null, 'other-wallet'])('keeps reference checking when the signer is %s before retry', async (signer) => {
    await waiting(); await advance();
    h.signerWallet = signer;
    await act(async () => { root!.render(<Harness kind="entry" />); });
    expect(retryButton().disabled).toBe(true);
    await act(async () => { click('RETRY'); });
    h.post.mockResolvedValue({ ...quoted(), status: 'credited' });
    await advance(LAND_CHECKOUT_RECOVERY.pollMs);
    expect(phase()).toBe('credited');
    expect(h.sendTransaction).toHaveBeenCalledOnce();
  });

  it('resumes original checking when the signer disconnects during retry preflight', async () => {
    await waiting(); await advance();
    let verified!: (row: unknown) => void;
    h.post.mockReturnValueOnce(new Promise(resolve => { verified = resolve; }));
    await act(async () => { click('RETRY'); });
    h.signerWallet = null;
    await act(async () => { root!.render(<Harness kind="entry" />); });
    await act(async () => { verified(quoted()); });
    expect(phase()).toBe('confirming');
    expect(Object.values(localStorage).join(' ')).toContain('"submitted":true');
    h.post.mockResolvedValue({ ...quoted(), status: 'credited' });
    await advance(LAND_CHECKOUT_RECOVERY.pollMs);
    expect(phase()).toBe('credited');
    expect(h.sendTransaction).toHaveBeenCalledOnce();
  });

  it('starts a one-minute grace for old saved submissions and preserves it through another reload', async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    localStorage.setItem('shardkeep:land:devnet:wallet-a:entry', JSON.stringify({ id: RESUMABLE.id, submitted: true }));
    h.get.mockImplementation(async (path: string) => path === '/me' ? { wallet: h.wallet, entryPaid: false } : quoted());
    h.post.mockResolvedValue(quoted());
    await mount('entry'); await advance(30_000);
    expect(retryButton().disabled).toBe(true);
    await act(async () => { root?.unmount(); }); document.body.replaceChildren();
    await mount('entry'); await advance(30_000);
    expect(retryButton().disabled).toBe(false);
    expect(h.sendTransaction).not.toHaveBeenCalled();
  });
});

describe('land deadlines anchored to server time', () => {
  it.each([-3_600_000, 3_600_000])('shows truthful countdowns with a device clock skew of %ims', async (skew) => {
    vi.useFakeTimers();
    const serverNow = Date.parse('2026-09-06T16:00:00Z');
    vi.setSystemTime(serverNow + skew);
    const row = { ...RESUMABLE, serverNow: new Date(serverNow).toISOString(),
      payableUntil: new Date(serverNow + 20 * 60_000).toISOString(), retryAt: new Date(serverNow + 30 * 60_000).toISOString() };
    h.postRaw.mockResolvedValue(row); h.post.mockResolvedValue(row);
    h.sendTransaction.mockRejectedValue(new Error('unknown network outcome'));
    await mount('entry');
    await act(async () => { click('RANDOM'); }); await act(async () => { click('PAY'); });
    expect(h.sendTransaction).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="reservation-retry-seconds"]')?.textContent).toBe('1800');
    expect(document.querySelector('[data-testid="retry-seconds"]')?.textContent).toBe('60');
    // Changing the device date while the screen is open cannot skip its grace.
    vi.setSystemTime(serverNow + 10 * 3_600_000);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(document.querySelector('[data-testid="retry-seconds"]')?.textContent).toBe('30');
    expect(document.querySelector('[data-testid="reservation-retry-seconds"]')?.textContent).toBe('1770');
    expect([...document.querySelectorAll('button')].find(b => b.textContent === 'RETRY')?.disabled).toBe(true);
  });

  it('keeps reservation countdown current while reviewing and waiting for the wallet', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const row = { ...RESUMABLE, serverNow: new Date(start).toISOString(),
      payableUntil: new Date(start + 20 * 60_000).toISOString(), retryAt: new Date(start + 30 * 60_000).toISOString() };
    h.postRaw.mockResolvedValue(row);
    h.sendTransaction.mockReturnValue(new Promise(() => undefined));
    await mount('entry'); await act(async () => { click('RANDOM'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(document.querySelector('[data-testid="reservation-retry-seconds"]')?.textContent).toBe('1790');
    h.get.mockImplementation(async (path: string) => path === '/me' ? { wallet: h.wallet, entryPaid: false }
      : { ...row, serverNow: new Date().toISOString() });
    await act(async () => { click('PAY'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('paying');
    expect(document.querySelector('[data-testid="reservation-retry-seconds"]')?.textContent).toBe('1780');
  });

  it('keeps old server responses recoverable without inventing a deadline or enabling an unanchored retry', async () => {
    vi.useFakeTimers();
    h.postRaw.mockResolvedValue({ ...RESUMABLE, payableUntil: new Date(Date.now() + 120_000).toISOString() });
    h.post.mockResolvedValue({ status: 'pending' });
    h.sendTransaction.mockRejectedValue(new Error('unknown network outcome'));
    await mount('entry');
    await act(async () => { click('RANDOM'); }); await act(async () => { click('PAY'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(document.querySelector('[data-testid="reservation-retry-seconds"]')?.textContent).toBe('');
    expect([...document.querySelectorAll('button')].find(b => b.textContent === 'RETRY')?.disabled).toBe(true);
    h.post.mockResolvedValue({ status: 'credited' });
    await act(async () => { await vi.advanceTimersByTimeAsync(LAND_CHECKOUT_RECOVERY.pollMs); });
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('credited');
    expect(h.sendTransaction).toHaveBeenCalledOnce();
  });
});


describe('fresh authority before every wallet signature', () => {
  const start = Date.parse('2026-09-06T16:00:00Z');
  const deed = () => ({ ...RESUMABLE, kind: 'deed' as const,
    serverNow: new Date(start).toISOString(), payableUntil: new Date(start + 20 * 60_000).toISOString() });
  async function prepare(): Promise<void> {
    vi.useFakeTimers(); vi.setSystemTime(start);
    h.postRaw.mockResolvedValue(deed());
    await mount('deed');
    await act(async () => { click('RANDOM'); });
  }

  it.each(['expired', 'closed-pending'])('never signs a %s deed after OS sleep pauses the monotonic clock', async (status) => {
    await prepare();
    const observed = performance.now();
    vi.setSystemTime(start + 31 * 60_000); // Server advances; performance does not.
    expect(performance.now()).toBe(observed);
    const row = { ...deed(), status: status === 'expired' ? 'expired' : 'pending', serverNow: new Date().toISOString() };
    h.get.mockImplementation(async (path: string) => path === '/me' ? { wallet: h.wallet, entryPaid: true } : row);
    h.post.mockResolvedValue(row);
    await act(async () => { click('PAY'); click('PAY'); });
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(h.buildBuySinkTx).not.toHaveBeenCalled();
    expect(Object.values(localStorage).join(' ')).not.toContain('submitted');
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe(status === 'expired' ? 'idle' : 'confirming');
  });

  it('resumes another device’s pending deed signature instead of paying the repeatable sink again', async () => {
    await prepare();
    const row = { ...deed(), status: 'pending', paymentSignature: 'other-device-deed-payment' };
    h.get.mockImplementation(async (path: string) => path === '/me' ? { wallet: h.wallet, entryPaid: true } : row);
    h.post.mockResolvedValue(row);
    await act(async () => { click('PAY'); });
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(h.buildBuySinkTx).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('confirming');
    expect(Object.values(localStorage).join(' ')).toContain('other-device-deed-payment');
    expect(h.postRaw).toHaveBeenCalledWith(`/deposits/${RESUMABLE.id}/paid`, { signature: 'other-device-deed-payment' }, { signal: expect.any(AbortSignal) });
    await act(async () => { root?.unmount(); }); document.body.replaceChildren();
    await mount('deed');
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('confirming');
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(Object.values(localStorage).join(' ')).toContain('other-device-deed-payment');
  });

  it.each(['reference', 'baseId', 'earthCell', 'amountLamports'])('does not purchase when the authoritative %s differs from the reviewed parcel', async (field) => {
    await prepare();
    const row = { ...deed(), [field]: field === 'earthCell' || field === 'amountLamports' ? 99 : 'changed', status: 'pending' };
    h.get.mockImplementation(async (path: string) => path === '/me' ? { wallet: h.wallet, entryPaid: false } : row);
    await act(async () => { click('PAY'); });
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(Object.values(localStorage).join(' ')).not.toContain('submitted');
    expect(document.querySelector('[data-testid="error"]')?.textContent).toContain('NO NEW PAYMENT WAS REQUESTED');
  });

  it('times out a pre-sign read without marking submitted, and ignores its late response after an account switch', async () => {
    await prepare();
    let finish!: (value: unknown) => void;
    h.get.mockImplementation((path: string) => path === '/me' ? Promise.resolve({ wallet: h.wallet, entryPaid: false })
      : new Promise(resolve => { finish = resolve; }));
    await act(async () => { click('PAY'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(LAND_CHECKOUT_RECOVERY.requestTimeoutMs); });
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('ready');
    expect(Object.values(localStorage).join(' ')).not.toContain('submitted');
    h.wallet = 'wallet-b';
    await act(async () => { root!.render(<Harness kind="deed" />); });
    await act(async () => { finish({ ...deed(), status: 'pending' }); });
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('idle');
  });

  it('honors fresh entry credit between review and initial PAY without another signature', async () => {
    h.postRaw.mockResolvedValue(RESUMABLE);
    await mount('entry'); await act(async () => { click('RANDOM'); });
    h.get.mockImplementation(async (path: string) => path === '/me' ? { wallet: h.wallet, entryPaid: true } : RESUMABLE);
    await act(async () => { click('PAY'); });
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('credited');
  });
});


describe('fantasy payment location identity', () => {
  it('does not alias a native tile to an old Earth cell during recovery', () => {
    const address = { kind: 'fantasy', worldId: 'fantasy-v1', tileId: 96291 } as const;
    expect(landReservationIdentity({ landAddress: address })).toBe('fantasy-v1:96291');
    expect(landReservationIdentity({ earthCell: 96291 })).toBe('earth:96291');
    expect(landReservationIdentity({ landAddress: { ...address, tileId: 96292 } }))
      .not.toBe(landReservationIdentity({ landAddress: address }));
  });
  it('refuses missing or fractional native identities before payment', () => {
    expect(landReservationIdentity({})).toBeNull();
    expect(landReservationIdentity({ earthCell: 96291, landAddress: { kind: 'fantasy', worldId: 'fantasy-v1', tileId: 96291 } })).toBeNull();
    expect(landReservationIdentity({ earthCell: 1, landAddress: { kind: 'legacy-earth', earthCell: 2 } })).toBeNull();
    expect(landReservationIdentity({ landAddress: { kind: 'fantasy', worldId: 'fantasy-v1', tileId: 999999 } })).toBeNull();
    expect(landReservationIdentity({ landAddress: { kind: 'fantasy', worldId: 'fantasy-v1', tileId: 1.5 } })).toBeNull();
  });
});
