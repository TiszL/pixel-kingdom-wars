/** Content only. F2ab binds the existing producer and dispatch; no duplicate service lifecycle. */
import { AccountSheet, type AccountSheetProps } from './AccountSheets';
import { economyModel, testSolModel, type EconomyInput, type TestSolInput } from './serviceAdapters';
type Host = Pick<AccountSheetProps, 'onIntent' | 'onClose' | 'onHistory'>;
export function TestSolAdapter({ input, ...host }: Host & { input: TestSolInput }) {
 const model = testSolModel(input);
 return model ? <AccountSheet {...host} {...model} screen="wallet.test-sol" title="TEST SOL" /> : null;
}
export function EconomyAdapter({ input, ...host }: Host & { input: EconomyInput }) {
 const { custodyNote, ...model } = economyModel(input);
 return <AccountSheet {...host} {...model} screen="account.economy" title="KEEP ECONOMY"><p>{custodyNote}</p></AccountSheet>;
}
