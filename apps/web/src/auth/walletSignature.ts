/**
 * Wallet providers are outside our process and some leave a rejected/closed
 * signature prompt pending forever. Never let that strand the title screen in
 * SIGNING IN…: fail back to a retryable error after a generous approval window.
 */
export const WALLET_SIGNATURE_TIMEOUT_MS = 45_000;

/** Native sign-in owns one approval until it settles or the player cancels.
 * A slow wallet handoff is a visible wait, never an automatic second prompt. */
export function waitForWalletApproval<T>(request: Promise<T>, signal: AbortSignal, onWaiting: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(onWaiting, WALLET_SIGNATURE_TIMEOUT_MS);
    const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = (): void => { cleanup(); reject(new Error('Sign-in cancelled.')); };
    signal.addEventListener('abort', abort, { once: true });
    request.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

export async function waitForWalletSignature<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Wallet signature timed out. Reopen your wallet and try again.'));
        }, WALLET_SIGNATURE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
