/** Night 2026-10-06 devnet TEST profile (night chain plan, section H, slice S7). Off unless the
 * process environment names it explicitly, and keyed by ONE program id: only the id in
 * PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID gets PHASE_E_DEVNET_TEST's shorter auction and passes the
 * economy identity pins. The accepted economy id (the checked-in IDL address) never reads the
 * environment: it always keeps PHASE_E_POLICY's auction length and its identity, so a leaked
 * variable cannot change production. The term length is never overridden. Never set on
 * production; on QA only through the opt-in chainLane profile knob (docs/DECISIONS.md "Night
 * 2026-10-06 — QA chain lane"; scripts/candidate/policy.mjs). Server-side only: apps/web production code does not import packages/chain;
 * where no `process` exists (a browser) the profile reads as off. */
import { PublicKey } from '@solana/web3.js';
import { PHASE_E_POLICY, PHASE_E_DEVNET_TEST } from '@shardkeep/shared';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };

/** Accepted program ids (economy, craft, league, core, distributor) and the default key:
 * none of them may ever be named as the test economy program. */
const PROTECTED: ReadonlySet<string> = new Set([idl.address, '4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59',
  '2x3PP9GeyvcwvrBCwAjYacTaaLRMhXbzBnRLDAWtninE', 'mYYQFnpyGofG31y5oJkiKVmNwifbSXBMnQ5aUgQkL6b',
  '6Tgc32nfuEDwvVQii47eLKZXeu39evzG5142UheuxpKU', PublicKey.default.toBase58()]);

type Environment = Readonly<Record<string, string | undefined>>;
/** Read on every call (no cache), so the profile can never outlive its variables. */
function environment(): Environment {
  const host = (globalThis as unknown as { process?: { env?: Environment } }).process;
  const env = host && typeof host === 'object' ? host.env : undefined;
  return env && typeof env === 'object' ? env : {};
}
function refuse(reason: string): never { throw new Error(`Devnet test profile refused: ${reason}`); }

/** The one test economy program id, or null when the profile is off. Active only when
 * PKW_DEVNET_TEST_PROFILE equals PHASE_E_DEVNET_TEST.profile, SOLANA_CLUSTER is explicitly
 * 'devnet' and PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID is set. Throws when that id is not canonical
 * base58 or names an accepted program, so a misconfigured test host fails loudly. */
export function devnetTestEconomyProgram(): string | null {
  const env = environment();
  if (env.PKW_DEVNET_TEST_PROFILE !== PHASE_E_DEVNET_TEST.profile || env.SOLANA_CLUSTER !== 'devnet') return null;
  const id = env.PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID;
  if (id === undefined || id === '') return null;
  let canonical: string | null = null;
  try { canonical = new PublicKey(id).toBase58(); } catch { /* refused below */ }
  if (canonical !== id) refuse('PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID is not a canonical base58 public key');
  if (PROTECTED.has(id)) refuse('PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID names an accepted program id');
  return id;
}

/** True for the accepted economy id, and for the one test id while the profile is on. */
export function isEconomyProgramIdentity(id: string): boolean {
  return id === idl.address || (typeof id === 'string' && id === devnetTestEconomyProgram());
}

/** Auction length for a program's calendar. The accepted id (and every other id) keeps
 * PHASE_E_POLICY.seekerIsland.overlappingAuctionSec; only the test id gets the test length. */
export function seekerAuctionSecFor(programId: string): number {
  const accepted = PHASE_E_POLICY.seekerIsland.overlappingAuctionSec;
  if (typeof programId !== 'string' || programId === idl.address) return accepted;
  return programId === devnetTestEconomyProgram() ? PHASE_E_DEVNET_TEST.overlappingAuctionSec : accepted;
}
