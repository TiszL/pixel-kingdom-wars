/** Account content for the shared host; security and wallet effects remain with current owners. */
import { AccountSheet, ProfileWalletTab, ProfileAccountTab, type AccountSheetProps } from './AccountSheets';
import { profileOverviewModel, profileWalletModel, profileAccountModel, type ProfileOverviewInput, type ProfileWalletInput, type ProfileAccountInput } from './profileAdapters';

type Host = Pick<AccountSheetProps, 'onIntent' | 'onClose' | 'onHistory' | 'tabs' | 'tab' | 'onTab'>;

export function ProfileOverviewAdapter({ input, ...host }: Host & { input: ProfileOverviewInput }) {
  return <AccountSheet {...host} {...profileOverviewModel(input)} screen="PROFILE" />;
}

export function ProfileWalletAdapter({ input, history, ...host }: Host & { input: ProfileWalletInput; history?: { needs: number | null; done: number | null } }) {
  const model = profileWalletModel(input);
  return input.wallet
    ? <ProfileWalletTab {...host} {...model} address={input.wallet} {...(history ? { history } : {})} />
    : <AccountSheet {...host} {...model} screen="WALLET" />;
}

export function ProfileAccountAdapter({ input, onName, ...host }: Host & { input: ProfileAccountInput; onName: (name: string) => void }) {
  return <ProfileAccountTab {...host} {...profileAccountModel(input)} onName={onName} />;
}
