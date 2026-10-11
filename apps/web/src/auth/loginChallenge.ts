import { create } from 'zustand';

/** Limited-login identity is deliberately outside the authenticated game store. */
export const useLoginChallenge = create<{
  wallet: string | null;
  revision: number;
  setWallet: (wallet: string | null) => void;
}>((set) => ({ wallet: null, revision: 0, setWallet: (wallet) => set((s) => ({ wallet, revision: s.revision + 1 })) }));

export interface LoginResponse {
  wallet: string;
  entryPaid?: boolean;
  loginRequired?: boolean;
}

export function acceptLoginResponse(
  response: LoginResponse, setAuth: (wallet: string | null, entryPaid?: boolean) => void,
): void {
  if (response.loginRequired) {
    setAuth(null);
    useLoginChallenge.getState().setWallet(response.wallet);
  } else {
    useLoginChallenge.getState().setWallet(null);
    setAuth(response.wallet, response.entryPaid === true);
  }
}
