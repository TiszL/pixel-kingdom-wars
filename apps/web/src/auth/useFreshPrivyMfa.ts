import { useMfa, usePrivy } from '@privy-io/react-auth';
import { useCallback } from 'react';

const PRIVY_ENABLED = !!import.meta.env.VITE_PRIVY_APP_ID;

/** Stable code for the one failure a screen can act on: the embedded wallet
 * has no Privy Authenticator yet, so the ceremony cannot even start. Screens
 * match on this code — never on the message — and point the player at Privy
 * enrolment instead of surfacing a raw toast (D-098, owner 2026-09-02). */
export const PRIVY_MFA_NOT_ENROLLED = 'PRIVY_MFA_NOT_ENROLLED';

export class PrivyMfaNotEnrolledError extends Error {
  readonly code = PRIVY_MFA_NOT_ENROLLED;
  constructor() {
    super('Privy Authenticator must be enrolled before this security action.');
    this.name = 'PrivyMfaNotEnrolledError';
  }
}

export function isPrivyMfaNotEnrolled(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === PRIVY_MFA_NOT_ENROLLED;
}

export async function requireFreshPrivyTotp(input: {
  isEmbedded: boolean;
  ready: boolean;
  mfaMethods: string[] | undefined;
  clear: () => Promise<void>;
  init: (method: 'totp') => Promise<unknown>;
  promptMfa: () => Promise<unknown>;
}): Promise<void> {
  if (!input.isEmbedded) return;
  if (!input.ready || !input.mfaMethods?.includes('totp')) {
    throw new PrivyMfaNotEnrolledError();
  }
  await input.clear();
  await input.init('totp');
  await input.promptMfa();
}

/** Privy caches successful MFA briefly. Key export and lost-factor recovery are
 * intentionally stronger: clear that cache, then let Privy's own UI prompt the
 * enrolled Authenticator again. `init('totp')` selects verification in Privy's
 * manual-flow API; it does not re-enroll the factor. The production dashboard's
 * Authenticator-only policy remains authoritative. */
function useFreshPrivyMfaEnabled(isEmbedded: boolean): () => Promise<void> {
  const { ready, user } = usePrivy();
  const { clear, init, promptMfa } = useMfa();
  return useCallback(() => requireFreshPrivyTotp({
    isEmbedded,
    ready,
    mfaMethods: user?.mfaMethods,
    clear,
    init,
    promptMfa,
  }), [clear, init, isEmbedded, promptMfa, ready, user]);
}

function useFreshPrivyMfaDisabled(_isEmbedded: boolean): () => Promise<void> {
  return useCallback(async () => undefined, []);
}

export const useFreshPrivyMfa: (isEmbedded: boolean) => () => Promise<void> = PRIVY_ENABLED
  ? useFreshPrivyMfaEnabled
  : useFreshPrivyMfaDisabled;
