import { describe, expect, it } from 'vitest';
import { PHASE_E_POLICY, PHASE_E_STARTER_ROUTES } from './constants';
import { RAW_RESOURCE_STORAGE_MAX } from './phaseEResources';
import { splitResourceEarnings } from './phaseEResourceTax';

const denominator = BigInt(PHASE_E_POLICY.basisPoints);
const islandPoolBps = BigInt(PHASE_E_POLICY.taxes.resources.islandPoolBps);

describe('D-150 resource earnings split', () => {
  it('assigns the locked 80/20 player/island split without another developer leg', () => {
    expect(PHASE_E_POLICY.taxes.resources.devBps).toBe(0);
    expect(splitResourceEarnings(100n, 0n)).toEqual({ gross: 100n, net: 80n, tax: 20n, nextCarry: 0n });
  });

  it('charges the same total when each tiny earning is collected separately', () => {
    let carry = 0n;
    let net = 0n;
    let tax = 0n;
    for (let i = 0; i < 137; i++) {
      const part = splitResourceEarnings(1n, carry);
      expect(part.net + part.tax).toBe(1n);
      expect(part.tax === 0n || part.tax === 1n).toBe(true);
      carry = part.nextCarry;
      net += part.net;
      tax += part.tax;
    }
    expect({ gross: 137n, net, tax, nextCarry: carry }).toEqual(splitResourceEarnings(137n, 0n));
    expect(tax).toBe(27n);
    expect(carry).toBe(4_000n);
  });

  it('consumes a crossing fractional carry once, never paying it on an empty earning', () => {
    const first = splitResourceEarnings(1n, denominator - 1n);
    expect(first).toEqual({ gross: 1n, net: 0n, tax: 1n, nextCarry: islandPoolBps - 1n });
    expect(splitResourceEarnings(0n, first.nextCarry)).toEqual({
      gross: 0n, net: 0n, tax: 0n, nextCarry: first.nextCarry,
    });
    const second = splitResourceEarnings(1n, first.nextCarry);
    expect(first.tax + second.tax).toBe(splitResourceEarnings(2n, denominator - 1n).tax);
    expect(second.nextCarry).toBe(splitResourceEarnings(2n, denominator - 1n).nextCarry);
  });

  it('preserves every valid carry on zero gross without rounding or clearing it', () => {
    for (let carry = 0n; carry < denominator; carry++) {
      expect(splitResourceEarnings(0n, carry)).toEqual({ gross: 0n, net: 0n, tax: 0n, nextCarry: carry });
    }
  });

  it('retains exactness through the full signed-int64 gross despite larger intermediate multiplication', () => {
    expect(splitResourceEarnings(RAW_RESOURCE_STORAGE_MAX, 0n)).toEqual({
      gross: RAW_RESOURCE_STORAGE_MAX, net: 7_378_697_629_483_820_646n,
      tax: 1_844_674_407_370_955_161n, nextCarry: 4_000n,
    });
    expect(splitResourceEarnings(RAW_RESOURCE_STORAGE_MAX, denominator - 1n)).toEqual({
      gross: RAW_RESOURCE_STORAGE_MAX, net: 7_378_697_629_483_820_645n,
      tax: 1_844_674_407_370_955_162n, nextCarry: 3_999n,
    });
  });

  it('is invariant under unequal partitions, including zero chunks and values beyond Number precision', () => {
    const amounts = [0n, 1n, 5n, 19n, 99n, 163n, 9_007_199_254_740_993n, RAW_RESOURCE_STORAGE_MAX];
    for (const gross of amounts) {
      for (const initialCarry of [0n, 1n, islandPoolBps - 1n, denominator - 1n]) {
        const chunks: bigint[] = [];
        let remaining = gross;
        for (let i = 0; i < 19; i++) {
          const quantity = remaining / BigInt(i % 7 + 2);
          chunks.push(0n, quantity);
          remaining -= quantity;
        }
        chunks.push(remaining);
        let carry = initialCarry;
        let net = 0n;
        let tax = 0n;
        for (const chunk of chunks) {
          const split = splitResourceEarnings(chunk, carry);
          expect(split.net + split.tax).toBe(chunk);
          expect(split.tax * denominator + split.nextCarry).toBe(chunk * islandPoolBps + carry);
          expect(split.net >= 0n && split.tax >= 0n && split.nextCarry >= 0n && split.nextCarry < denominator).toBe(true);
          net += split.net;
          tax += split.tax;
          carry = split.nextCarry;
        }
        expect({ gross, net, tax, nextCarry: carry }).toEqual(splitResourceEarnings(gross, initialCarry));
      }
    }
  });

  it('preserves existing carry for each exact-yield starter route instead of silently resetting its lineage', () => {
    for (const route of Object.values(PHASE_E_STARTER_ROUTES.routes)) {
      const gross = BigInt(route.grossRaw);
      expect(gross * islandPoolBps % denominator).toBe(0n);
      const wholeTax = gross * islandPoolBps / denominator;
      for (const carry of [0n, 1n, islandPoolBps - 1n, denominator - 1n]) {
        expect(splitResourceEarnings(gross, carry)).toEqual({ gross, net: gross - wholeTax, tax: wholeTax, nextCarry: carry });
      }
    }
  });

  it.each([0, 1, Number.MAX_SAFE_INTEGER, Number.NaN, Number.POSITIVE_INFINITY,
    '0', '1', '01', '+1', '-0', '1.0', '1e3', ' 1', '1\n', null, undefined,
    true, {}, Object(1n)])('rejects non-bigint input %s without coercing or losing precision', invalid => {
    expect(() => splitResourceEarnings(invalid as bigint, 0n)).toThrow(TypeError);
    expect(() => splitResourceEarnings(1n, invalid as bigint)).toThrow(TypeError);
  });

  it('rejects storage overflow, negative gross and corrupt carry instead of wrapping them', () => {
    for (const gross of [-1n, RAW_RESOURCE_STORAGE_MAX + 1n, RAW_RESOURCE_STORAGE_MAX * denominator])
      expect(() => splitResourceEarnings(gross, 0n)).toThrow(RangeError);
    for (const carry of [-1n, denominator, denominator + 1n, RAW_RESOURCE_STORAGE_MAX])
      expect(() => splitResourceEarnings(0n, carry)).toThrow(RangeError);
  });

  it('returns independent results and leaves the caller inputs unchanged', () => {
    const input = Object.freeze({ gross: 17n, carry: 9_999n });
    const first = splitResourceEarnings(input.gross, input.carry);
    const second = splitResourceEarnings(input.gross, input.carry);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(input).toEqual({ gross: 17n, carry: 9_999n });
  });
});
