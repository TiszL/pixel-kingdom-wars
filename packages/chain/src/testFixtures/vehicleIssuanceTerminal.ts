/** Synthetic reviewed codec bank only. Odds are explicit boundary-test inputs,
 * not vehicle recipe policy; no on-chain transaction or deployed trust exists. */
import { vehicleIssuanceFixture } from './vehicleIssuance';
import { normalizeVehicleIssuanceOriginal } from '../vehicleIssuanceAccounts';
import { vehicleTermsHash, vehicleTermsBytes, vehicleVrfRequest, vehicleKeccak } from '../vehicleIssuanceProtocol';
export function vehicleIssuanceTerminalFixture(outcome: 'won' | 'lost' = 'won', options: { minted?: boolean; oddsBps?: number; rootId?: string } = {}) {
  const f = vehicleIssuanceFixture(options.rootId), { originalHash: _oldHash, ...saved } = f.original;
  const original = normalizeVehicleIssuanceOriginal({ ...saved, terms: { ...saved.terms,
    oddsBps: options.oddsBps ?? (outcome === 'lost' ? 0 : saved.terms.oddsBps) } });
  const termsHash = vehicleTermsHash(original), requestHash = vehicleKeccak(vehicleVrfRequest(original.rootId, original.attemptId, termsHash));
  const root = Buffer.from(f.rows[7]!.data), attempt = Buffer.from(f.rows[8]!.data), permit = Buffer.from(f.rows[9]!.data);
  Buffer.from(termsHash, 'hex').copy(root, 137); vehicleTermsBytes(original.terms).copy(attempt, 185);
  Buffer.from(termsHash, 'hex').copy(attempt, 393); requestHash.copy(attempt, 425); Buffer.from(termsHash, 'hex').copy(permit, 121);
  attempt.fill(outcome === 'lost' ? 255 : 0, 481, 513); attempt[513] = outcome === 'lost' ? 1 : 2;
  attempt[515] = options.minted ? 1 : 0; attempt.writeBigUInt64LE(options.minted ? 13n : 0n, 548);
  f.rows[7]!.data = root; f.rows[8]!.data = attempt; f.rows[9]!.data = permit;
  if (!options.minted) f.rows.splice(10, 2);
  return { ...f, original };
}
