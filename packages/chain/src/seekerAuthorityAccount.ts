/** Internal pure SeekerAuthority ABI decoder. These bytes alone establish no
 * RPC provenance, deployment trust, funding or signing authority. */
import { PublicKey } from '@solana/web3.js';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
export const SEEKER_AUTHORITY_ACCOUNT_BYTES = 213;
export interface SeekerAuthorityFacts {
  readonly address: string; readonly admin: string; readonly pendingAdmin: string | null; readonly guardian: string;
  readonly currentPolicyKey: string; readonly previousPolicyKey: string | null; readonly previousValidUntil: bigint;
  readonly clusterGenesis: string; readonly admissionPaused: boolean;
}
function need(value: unknown, label: string): asserts value { if (!value) throw new Error(`Invalid Seeker accounts: ${label}`); }
function key(value: PublicKey): string {
  need(value && typeof value.toBytes === 'function' && typeof value.toBase58 === 'function', 'public key type');
  const bytes = value.toBytes(); need(bytes instanceof Uint8Array && bytes.length === 32, 'public key bytes');
  const canonical = new PublicKey(bytes).toBase58(); need(value.toBase58() === canonical, 'public key text'); return canonical;
}
export function decodeSeekerAuthority(program: string, genesisHash: string, raw: {
  readonly address: PublicKey; readonly owner: PublicKey; readonly executable: boolean; readonly data: Uint8Array;
}): SeekerAuthorityFacts {
  const [canonical, bump] = PublicKey.findProgramAddressSync([Buffer.from('seeker_authority')], new PublicKey(program));
  need(raw && key(raw.address) === canonical.toBase58() && key(raw.owner) === program && raw.executable === false, 'SeekerAuthority identity/owner');
  need(raw.data instanceof Uint8Array && raw.data.length === SEEKER_AUTHORITY_ACCOUNT_BYTES, 'SeekerAuthority allocation');
  const data = Buffer.from(raw.data), discriminator = idl.accounts.find(row => row.name === 'SeekerAuthority')?.discriminator;
  need(discriminator?.length === 8 && data.subarray(0, 8).equals(Buffer.from(discriminator)), 'SeekerAuthority discriminator');
  let at = 8;
  const bytes = (length: number) => { const end = at + length; need(end <= data.length, 'truncated field');
    const result = data.subarray(at, end); at = end; return result; };
  const u8 = () => bytes(1)[0]!;
  const readKey = () => new PublicKey(bytes(32)).toBase58();
  const bool = () => { const tag = u8(); need(tag === 0 || tag === 1, 'boolean tag'); return tag === 1; };
  const optionKey = () => bool() ? readKey() : null;
  const nonzero = (value: string) => value !== PublicKey.default.toBase58();
  need(u8() === 1, 'authority version');
  const admin = readKey(), pendingAdmin = optionKey(), guardian = readKey(), currentPolicyKey = readKey();
  const previousPolicyKey = optionKey(), previousValidUntil = bytes(8).readBigInt64LE(), clusterGenesis = readKey();
  const admissionPaused = bool();
  need(u8() === bump && clusterGenesis === genesisHash && nonzero(genesisHash) && nonzero(admin) && nonzero(guardian) && nonzero(currentPolicyKey)
    && (pendingAdmin === null || (nonzero(pendingAdmin) && pendingAdmin !== admin))
    && (previousPolicyKey === null ? previousValidUntil === 0n : nonzero(previousPolicyKey) && previousPolicyKey !== currentPolicyKey), 'authority fields');
  // Fixed allocation can retain nonzero bytes after either Option shrinks.
  // Only parsed Borsh fields are state; never impose a zero-padding invariant.
  return Object.freeze({ address: canonical.toBase58(), admin, pendingAdmin, guardian, currentPolicyKey,
    previousPolicyKey, previousValidUntil, clusterGenesis, admissionPaused });
}
