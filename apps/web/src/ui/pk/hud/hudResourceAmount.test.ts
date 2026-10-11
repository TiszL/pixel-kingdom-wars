import { describe, expect, it } from 'vitest';
import { hudAmountText, type HudResourceAmount } from './hudResourceAmount';

const known = (value: string, decimals = 0, unit: 'BASE_UNITS' | 'DECIMAL' = 'BASE_UNITS'): HudResourceAmount =>
  ({ status: 'known', value, decimals, unit });

/** All 16 original HudResourceAmountTest names. Authored only; Cedar3 owns execution. */
describe('HudResourceAmount native parity', () => {
  it('loadingRemainsUnknown', () => { expect(hudAmountText({ status: 'loading' })).toBe('…'); });
  it('unavailableRemainsUnknownWithoutExposingProviderDetails', () => {
    const amount = { status: 'unavailable', reason: 'private provider detail' } as const;
    expect(hudAmountText(amount)).toBe('…');
  });
  it('absentRemainsDistinctFromLoadingAndKnownZero', () => { expect(hudAmountText({ status: 'absent' })).toBe('—'); });
  it('admittedBaseUnitZeroIsReallyZero', () => { expect(hudAmountText(known('0', 9))).toBe('0'); });
  it('admittedDecimalZeroIsReallyZero', () => { expect(hudAmountText(known('0.000000', 6, 'DECIMAL'))).toBe('0'); });
  it('integerCurrenciesRetainEveryDigit', () => { expect(hudAmountText(known('9007199254740993'))).toBe('9007199254740993'); });
  it('tokenBaseUnitsApplyTheProvidedDecimalsExactly', () => {
    expect(hudAmountText(known('18446744073709551615', 9))).toBe('18446744073.709551615');
  });
  it('oneBaseUnitDoesNotRoundToZero', () => { expect(hudAmountText(known('1', 9))).toBe('0.000000001'); });
  it('decimalUnitsAreNotScaledTwice', () => { expect(hudAmountText(known('12.345678', 6, 'DECIMAL'))).toBe('12.345678'); });
  it('insignificantDecimalZeroesDoNotImplyExtraPrecision', () => {
    expect(hudAmountText(known('1200.5000', 6, 'DECIMAL'))).toBe('1200.5');
  });
  it('decimalPrecisionBeyondMintDecimalsIsUnknown', () => { expect(hudAmountText(known('1.0000001', 6, 'DECIMAL'))).toBe('…'); });
  it('negativeAndNoncanonicalBaseUnitsAreUnknown', () => {
    for (const raw of ['-1', '+1', '01', ' 1', '1 ', '1\n', '1.0', '1e3', 'NaN', '', '１']) {
      expect(hudAmountText(known(raw, 6))).toBe('…');
    }
  });
  it('negativeExponentAndNoncanonicalDecimalsAreUnknown', () => {
    for (const raw of ['-1.0', '+1', '01', ' 1', '1 ', '1\n', '.1', '1.', '1e3', 'Infinity', '']) {
      expect(hudAmountText(known(raw, 6, 'DECIMAL'))).toBe('…');
    }
  });
  it('invalidDecimalsAreUnknown', () => {
    for (const decimals of [-1, 256, 2_147_483_647, 0.5, NaN, Infinity]) expect(hudAmountText(known('1', decimals))).toBe('…');
  });
  it('boundedInputAvoidsUnboundedNumberParsing', () => { expect(hudAmountText(known('1'.repeat(257)))).toBe('…'); });
  it('displayUsesNoScientificNotationEvenAtMaximumDecimals', () => {
    expect(hudAmountText(known('1', 255))).toBe(`0.${'0'.repeat(254)}1`);
  });
});
