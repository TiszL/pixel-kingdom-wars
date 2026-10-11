import { publicKey } from '@metaplex-foundation/umi';
import { describe, expect, it } from 'vitest';
import type { AssetV1, CollectionV1 } from '@metaplex-foundation/mpl-core';
import { coreOwnershipFromAccounts } from './coreOwnership';

const OWNER = publicKey('SysvarC1ock11111111111111111111111111111111');
const COLLECTION = publicKey('56RemMwZRxL7xMMV8TbiErZX2YfrnuY65x3t7sTQxKrT');
const DELEGATE = publicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

function asset(overrides: Record<string, unknown> = {}): AssetV1 {
  return {
    publicKey: publicKey('So11111111111111111111111111111111111111112'),
    owner: OWNER,
    updateAuthority: { type: 'Collection', address: COLLECTION },
    key: 1,
    name: 'Land Deed',
    uri: 'https://example.invalid/deed.json',
    seq: null,
    ...overrides,
  } as unknown as AssetV1;
}

function collection(overrides: Record<string, unknown> = {}): CollectionV1 {
  return {
    publicKey: COLLECTION,
    updateAuthority: { type: 'Address', address: OWNER },
    key: 2,
    name: 'Land Deeds',
    uri: '',
    numMinted: 1,
    currentSize: 1,
    ...overrides,
  } as unknown as CollectionV1;
}

describe('finalized Core deed ownership projection', () => {
  it('returns a plain thawed wallet holding with its exact collection', () => {
    expect(coreOwnershipFromAccounts(asset(), collection())).toEqual({
      owner: OWNER.toString(),
      frozen: false,
      delegate: null,
      collection: COLLECTION.toString(),
    });
  });

  it('fails transfer eligibility closed when an address TransferDelegate exists', () => {
    expect(coreOwnershipFromAccounts(asset({
      transferDelegate: { authority: { type: 'Address', address: DELEGATE } },
    }), collection()).delegate).toBe(DELEGATE.toString());
  });

  it('derives collection-level freeze state instead of trusting asset fields alone', () => {
    expect(coreOwnershipFromAccounts(asset(), collection({
      permanentFreezeDelegate: {
        authority: { type: 'Address', address: DELEGATE },
        frozen: true,
      },
    })).frozen).toBe(true);
  });
});
