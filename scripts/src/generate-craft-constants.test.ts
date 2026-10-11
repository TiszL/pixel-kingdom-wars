import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import { CRAFT_CONSTANTS_FILE, generateCraftConstants } from './generate-craft-constants';

it('keeps the compiled craft fee policy identical to shared authority', async () => {
  expect(await readFile(CRAFT_CONSTANTS_FILE, 'utf8')).toBe(generateCraftConstants());
  const p = PHASE_E_POLICY;
  // Neither fee leg may absorb a separately quoted oracle charge or rounding loss.
  const fee = BigInt(p.craft.applicationFeeLamports), bps = BigInt(p.basisPoints);
  expect(fee * BigInt(p.craft.operatorBps) % bps).toBe(0n);
  expect(fee * BigInt(p.craft.projectBps) % bps).toBe(0n);
  expect(p.craft.operatorBps + p.craft.projectBps).toBe(p.basisPoints);
});
