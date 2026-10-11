/** Lazy content only. F2ab supplies its existing host and current controller callbacks. */
import { AccountSheet, ProfileKingdomsTab, type AccountSheetProps } from './AccountSheets';
import { accountLandModel, accountKingdomsModel, type LandAdapterInput, type KingdomsAdapterInput } from './accountAdapters';

type Host = Pick<AccountSheetProps, 'onIntent' | 'onClose' | 'onHistory'>;

export function AccountLandAdapter({ input, ...host }: Host & { input: LandAdapterInput }) {
  return <AccountSheet {...host} {...accountLandModel(input)} screen="CLAIM YOUR LAND" />;
}

export function AccountKingdomsAdapter({ input, ...host }: Host & { input: KingdomsAdapterInput }) {
  return <ProfileKingdomsTab {...host} {...accountKingdomsModel(input)} />;
}
