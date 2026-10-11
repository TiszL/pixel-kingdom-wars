import { describe, expect, it } from 'vitest';
import {
  addKeepDepositAmount, MAX_KEEP_DEPOSIT, normalizeKeepDepositInput,
  parseKeepDepositAmount,
} from './keepDepositAmount';

describe('editable whole-KEEP deposit amount', () => {
  it('accepts direct large entry and friendly pasted separators', () => {
    expect(normalizeKeepDepositInput('100000')).toBe('100000');
    expect(normalizeKeepDepositInput('100,000')).toBe('100000');
    expect(normalizeKeepDepositInput(' 100 000 ')).toBe('100000');
    expect(normalizeKeepDepositInput('000100')).toBe('100');
    expect(parseKeepDepositAmount('100000')).toBe(100_000n);
  });

  it('keeps the field editable while rejecting fractions and non-digits', () => {
    expect(normalizeKeepDepositInput('')).toBe('');
    expect(normalizeKeepDepositInput('10.5')).toBeNull();
    expect(normalizeKeepDepositInput('100k')).toBeNull();
    expect(parseKeepDepositAmount('')).toBeNull();
    expect(parseKeepDepositAmount('0')).toBeNull();
  });

  it('bounds typed and shortcut values before any wallet transaction is built', () => {
    expect(parseKeepDepositAmount(MAX_KEEP_DEPOSIT.toString())).toBe(MAX_KEEP_DEPOSIT);
    expect(parseKeepDepositAmount((MAX_KEEP_DEPOSIT + 1n).toString())).toBeNull();
    expect(addKeepDepositAmount('', 100n)).toBe('100');
    expect(addKeepDepositAmount('100000', 1_000n)).toBe('101000');
    expect(addKeepDepositAmount(MAX_KEEP_DEPOSIT.toString(), 1n)).toBeNull();
  });
});
