import { createHash } from 'node:crypto';
import {
  Keypair, PublicKey, type AccountInfo, type Connection,
} from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChainAddresses } from './bootstrap';
import { CORE_PROGRAM_ID } from './programs';
import {
  assertMainnetAddressRegistry, assertReviewedKeepMintAuthorities,
  assertReviewedProgramDeployment,
} from './registryAttestation';

const address = (): string => Keypair.generate().publicKey.toBase58();
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

function account(data: Buffer, executable: boolean): AccountInfo<Buffer> {
  return { data, executable, owner: loader, lamports: 1, rentEpoch: 0 };
}

function programState(programData: PublicKey): Buffer {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2, 0);
  programData.toBuffer().copy(data, 4);
  return data;
}

function programDataState(authority: PublicKey | null, body = 'reviewed-elf'): Buffer {
  const data = Buffer.alloc(45 + Buffer.byteLength(body));
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(42n, 4);
  data[12] = authority ? 1 : 0;
  authority?.toBuffer().copy(data, 13);
  data.write(body, 45);
  return data;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function programConnection(
  programId: PublicKey,
  programDataAddress: PublicKey,
  programData: Buffer,
): Connection {
  const accounts = new Map<string, AccountInfo<Buffer>>([
    [programId.toBase58(), account(programState(programDataAddress), true)],
    [programDataAddress.toBase58(), account(programData, false)],
  ]);
  return {
    getAccountInfo: vi.fn(async (key: PublicKey) => accounts.get(key.toBase58()) ?? null),
  } as unknown as Connection;
}

function registry(overrides: Partial<ChainAddresses> = {}): ChainAddresses {
  return {
    cluster: 'mainnet-beta',
    coreProgram: address(),
    keepMint: address(),
    treasuries: { liquidity: address(), dev: address(), ops: address() },
    config: address(),
    deedCollection: address(),
    updatedAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('mainnet address-registry attestation', () => {
  it('refuses use outside mainnet-beta before making an RPC call', async () => {
    const connection = { getAccountInfo: (): never => { throw new Error('must not call'); } } as unknown as Connection;
    await expect(assertMainnetAddressRegistry(connection, {
      ...registry(), cluster: 'devnet',
    })).rejects.toThrow(/reserved for mainnet-beta/);
  });

  it('refuses a registry program that differs from the reviewed IDL', async () => {
    const connection = { getAccountInfo: (): never => { throw new Error('must not call'); } } as unknown as Connection;
    await expect(assertMainnetAddressRegistry(connection, registry()))
      .rejects.toThrow(/core program must equal reviewed IDL/);
  });

  it('requires an exact reviewed ProgramData policy before mainnet RPC access', async () => {
    const connection = {
      getAccountInfo: vi.fn((): never => { throw new Error('must not call'); }),
    } as unknown as Connection;
    await expect(assertMainnetAddressRegistry(connection, registry({
      coreProgram: CORE_PROGRAM_ID.toBase58(),
    }))).rejects.toThrow(/reviewed Anchor ProgramData policies/);
    expect(connection.getAccountInfo).not.toHaveBeenCalled();
  });

  it('requires an explicit reviewed mint and freeze authority policy', () => {
    const authority = Keypair.generate().publicKey;
    expect(() => assertReviewedKeepMintAuthorities(registry(), {
      mintAuthority: authority, freezeAuthority: null,
    })).toThrow(/explicit KEEP mint\/freeze authority policy/);
    expect(() => assertReviewedKeepMintAuthorities({
      ...registry(), keepMintAuthorities: { mintAuthority: authority.toBase58() },
    } as unknown as ChainAddresses, {
      mintAuthority: authority, freezeAuthority: null,
    })).toThrow(/missing freezeAuthority/);
  });

  it('accepts either revoked or exact retained authorities when the reviewed policy matches', () => {
    const mintAuthority = Keypair.generate().publicKey;
    const freezeAuthority = Keypair.generate().publicKey;
    expect(() => assertReviewedKeepMintAuthorities({
      ...registry(),
      keepMintAuthorities: {
        mintAuthority: mintAuthority.toBase58(),
        freezeAuthority: freezeAuthority.toBase58(),
      },
    }, { mintAuthority, freezeAuthority })).not.toThrow();
    expect(() => assertReviewedKeepMintAuthorities({
      ...registry(),
      keepMintAuthorities: { mintAuthority: null, freezeAuthority: null },
    }, { mintAuthority: null, freezeAuthority: null })).not.toThrow();
  });

  it('fails closed when either live authority differs from the reviewed policy', () => {
    const authority = Keypair.generate().publicKey;
    const impostor = Keypair.generate().publicKey;
    const reviewed = {
      ...registry(),
      keepMintAuthorities: { mintAuthority: authority.toBase58(), freezeAuthority: null },
    };
    expect(() => assertReviewedKeepMintAuthorities(reviewed, {
      mintAuthority: impostor, freezeAuthority: null,
    })).toThrow(/mintAuthority mismatch/);
    expect(() => assertReviewedKeepMintAuthorities(reviewed, {
      mintAuthority: authority, freezeAuthority: impostor,
    })).toThrow(/freezeAuthority mismatch/);
  });
});

describe('reviewed upgradeable-program deployment', () => {
  it.each([
    ['retained', Keypair.generate().publicKey],
    ['immutable', null],
  ] as const)('accepts exact ProgramData bytes and %s authority state', async (_state, authority) => {
    const programId = Keypair.generate().publicKey;
    const programDataAddress = Keypair.generate().publicKey;
    const data = programDataState(authority);
    await expect(assertReviewedProgramDeployment(
      programConnection(programId, programDataAddress, data),
      programId,
      {
        programDataAddress: programDataAddress.toBase58(),
        programDataSha256: sha256(data),
        upgradeAuthority: authority?.toBase58() ?? null,
      },
      'core',
    )).resolves.toBeUndefined();
  });

  it('rejects a Program account redirected away from the reviewed ProgramData', async () => {
    const programId = Keypair.generate().publicKey;
    const reviewed = Keypair.generate().publicKey;
    const redirected = Keypair.generate().publicKey;
    const data = programDataState(null);
    await expect(assertReviewedProgramDeployment(
      programConnection(programId, redirected, data),
      programId,
      {
        programDataAddress: reviewed.toBase58(),
        programDataSha256: sha256(data), upgradeAuthority: null,
      },
      'core',
    )).rejects.toThrow(/ProgramData address mismatch/);
  });

  it('rejects one changed ProgramData byte even when address and authority match', async () => {
    const programId = Keypair.generate().publicKey;
    const programDataAddress = Keypair.generate().publicKey;
    const authority = Keypair.generate().publicKey;
    const reviewed = programDataState(authority, 'reviewed-elf');
    const changed = Buffer.from(reviewed);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    await expect(assertReviewedProgramDeployment(
      programConnection(programId, programDataAddress, changed),
      programId,
      {
        programDataAddress: programDataAddress.toBase58(),
        programDataSha256: sha256(reviewed), upgradeAuthority: authority.toBase58(),
      },
      'core',
    )).rejects.toThrow(/ProgramData SHA-256 mismatch/);
  });

  it('rejects an unreviewed authority even when the full-byte hash is exact', async () => {
    const programId = Keypair.generate().publicKey;
    const programDataAddress = Keypair.generate().publicKey;
    const actualAuthority = Keypair.generate().publicKey;
    const reviewedAuthority = Keypair.generate().publicKey;
    const data = programDataState(actualAuthority);
    await expect(assertReviewedProgramDeployment(
      programConnection(programId, programDataAddress, data),
      programId,
      {
        programDataAddress: programDataAddress.toBase58(),
        programDataSha256: sha256(data), upgradeAuthority: reviewedAuthority.toBase58(),
      },
      'distributor',
    )).rejects.toThrow(/upgrade authority mismatch/);
  });

  it('rejects missing/invalid hash and authority declarations before RPC access', async () => {
    const connection = {
      getAccountInfo: vi.fn((): never => { throw new Error('must not call'); }),
    } as unknown as Connection;
    const programId = Keypair.generate().publicKey;
    const programDataAddress = Keypair.generate().publicKey.toBase58();
    await expect(assertReviewedProgramDeployment(connection, programId, {
      programDataAddress, programDataSha256: 'not-a-hash', upgradeAuthority: null,
    }, 'core')).rejects.toThrow(/invalid ProgramData SHA-256/);
    await expect(assertReviewedProgramDeployment(connection, programId, {
      programDataAddress, programDataSha256: 'a'.repeat(64),
    }, 'core')).rejects.toThrow(/missing expected upgrade authority/);
    expect(connection.getAccountInfo).not.toHaveBeenCalled();
  });
});
