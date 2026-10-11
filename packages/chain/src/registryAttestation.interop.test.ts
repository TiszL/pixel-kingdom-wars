/** Reproduce the namespace-only Anchor shape produced by the programs/ CommonJS
 * TSX entrypoint. The actual entrypoint startup is also checked before banking. */
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@coral-xyz/anchor', async importOriginal => {
  const actual = await importOriginal<typeof import('@coral-xyz/anchor')>();
  return { ...actual, default: undefined };
});
import { decodeUpgradeableProgramDataAddress, decodeProgramDataUpgradeAuthority } from './registryAttestation';

describe('registry attestation with namespace-only Anchor import', () => {
  it('starts without a default export and retains strict loader decoding', () => {
    const address = new PublicKey(new Uint8Array(32).fill(7));
    const program = Buffer.alloc(36); program.writeUInt32LE(2); address.toBuffer().copy(program, 4);
    expect(decodeUpgradeableProgramDataAddress(program).equals(address)).toBe(true);
    const data = Buffer.alloc(45); data.writeUInt32LE(3); data[12] = 1; address.toBuffer().copy(data, 13);
    expect(decodeProgramDataUpgradeAuthority(data)?.equals(address)).toBe(true);
    program.writeUInt32LE(3);
    expect(() => decodeUpgradeableProgramDataAddress(program)).toThrow('malformed upgradeable-loader state');
    data[12] = 2;
    expect(() => decodeProgramDataUpgradeAuthority(data)).toThrow('invalid upgrade-authority option');
  });
});
