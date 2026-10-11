/** Synthetic serialized pre-request bank. No live deployment or supplier authority. */
import { PublicKey, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { vehicleIssuanceFixture } from './vehicleIssuance';
import { type VehicleIssuanceEvidenceRpc, type VehicleIssuanceRawAccount } from '../vehicleIssuanceAccounts';
export function vehicleIssuanceAdmissionFixture() {
  const f = vehicleIssuanceFixture(), rows: VehicleIssuanceRawAccount[] = [...f.rows.slice(0, 7), f.rows[12]!, f.rows[13]!];
  const control = Buffer.from(rows[6]!.data); control[177] = 0; rows[6] = { ...rows[6]!, data: control };
  const rent = Buffer.alloc(17); rent.writeBigUInt64LE(3480n); rent.writeDoubleLE(2, 8); rent[16] = 50;
  rows.push({ address: SYSVAR_RENT_PUBKEY, owner: new PublicKey('Sysvar1111111111111111111111111111111111111'), executable: false, data: rent });
  const rpc: VehicleIssuanceEvidenceRpc = { getGenesisHash: async () => f.original.genesisHash, getSlot: async () => 20,
    getMultipleAccountsInfoAndContext: async addresses => ({ context: { slot: 20 }, value: addresses.map(a => rows.find(r => r.address.equals(a)) ?? null) }) };
  return { original: f.original, trust: f.trust, policyAuthority: new PublicKey(control.subarray(41, 73)).toBase58(), rows, rpc };
}
