/** Existing account service display contracts. No hooks, requests, timers, storage or signing. */
import type { FaucetPhase, FaucetStatus } from '../../../auth/useDevnetFaucet';
import type { AccountAdapterModel } from './accountAdapters';
import type { AccountRow } from './AccountSheets';

type Cluster = 'devnet' | 'mainnet-beta' | 'unknown';
export interface TestSolInput {
 wallet: string | null;
 cluster: Cluster;
 /** Scope captured when the existing useDevnetFaucet producer observed this state. */
 snapshot: { wallet: string; cluster: Cluster; phase: FaucetPhase; status: FaucetStatus | null } | null;
 fresh: boolean;
 /** Existing host countdown, bound to exactly the server-provided target. */
 countdown: { target: string; label: string } | null;
 formatSol: (displayAmount: number) => string;
}
const recheck = { id: 'faucet.sol.refresh', label: 'CHECK AGAIN', state: 'ENABLED', kind: 'recover' } as const;
const reasonCopy: Record<FaucetStatus['reason'], string> = {
 ok: 'Test SOL is available from the faucet.', disabled: 'The test SOL faucet is unavailable.',
 not_devnet: 'Test SOL is available only on devnet.', pending: 'We are checking your existing request.',
 balance_ok: 'Your wallet already has enough test SOL.', cap_reached: 'This wallet has reached the test SOL faucet limit.',
 cooldown: 'The next test SOL grant is not ready yet.', no_player: 'Finish connecting your account, then check again.',
 rpc_unavailable: 'The wallet balance could not be checked. Try again.',
};
/** D-098 SOL faucet, never the separate daily SKR faucet. The existing producer owns claim/recovery. */
export function testSolModel(input: TestSolInput): AccountAdapterModel | null {
 if (input.cluster !== 'devnet') return null;
 if (!input.wallet) return { rows: [], primary: { id: 'wallet.connect', label: 'CONNECT WALLET', state: 'ENABLED', kind: 'navigate' }, load: 'READY', note: 'Connect a wallet to check for test SOL.' };
 const read = input.snapshot?.wallet === input.wallet && input.snapshot.cluster === input.cluster ? input.snapshot : null;
 const status = read?.status;
 const known = status !== null && status !== undefined && Number.isFinite(status.grantSol) && status.grantSol > 0;
 const model: AccountAdapterModel = { rows: [{ id: 'faucet.sol.amount', title: 'TEST SOL',
  sub: 'DEVNET · no real value', value: known ? `${input.formatSol(status.grantSol)} SOL` : '…',
  tag: known && !input.fresh ? 'LAST READ' : 'DEVNET' }], primary: recheck, load: 'READY', note: 'Check the faucet status.' };
 if (!read || !status) return model;
 // An unresolved original request takes precedence over new eligibility and feature availability.
 if (read.phase === 'funding' || status.reason === 'pending' || status.last?.status === 'requested')
  return { ...model, note: 'We are checking your existing request. Check again for its result.' };
 if (!input.fresh) return { ...model, note: 'Showing the last read. Check again before requesting test SOL.' };
 if (read.phase === 'funded') return { ...model, note: status.last?.status === 'sent' && !!status.last.txSignature?.trim()
  ? 'Your test SOL has arrived. You can return to your kingdom.' : 'We are checking your existing request.' };
 // A lost POST answer is not permission to resubmit. refresh lets the existing producer reconcile it.
 if (read.phase === 'unavailable' && !status.enabled) return { ...model, note: reasonCopy.disabled };
 if (read.phase === 'failed' || read.phase === 'unavailable') return { ...model, note: 'We could not confirm the current request. Check again before requesting another grant.' };
 if (read.phase === 'checking') return { ...model, load: 'LOADING', note: 'Checking test SOL eligibility.' };
 if (!status.enabled) return { ...model, note: reasonCopy.disabled };
 if (status.eligible && status.reason === 'ok' && known)
  return { ...model, primary: { id: 'faucet.sol.claim', label: 'CLAIM TEST SOL', state: 'ENABLED', kind: 'action' }, note: 'Test SOL has no real value. The server decides the grant and eligibility.' };
 const countdown = status.reason === 'cooldown' && status.nextEligibleAt && input.countdown?.target === status.nextEligibleAt
  ? input.countdown.label.trim() : '';
 return { ...model, note: !known && status.eligible ? 'The grant amount is unavailable. Check again.'
  : countdown ? `Next test SOL grant in ${countdown}.` : reasonCopy[status.reason] };
}

/** Structural copy of the existing private EconomyStatsDto in screens/menu.tsx.
 * Display-only aggregate read; no route or response shape is added. Optional legacy fields stay optional. */
export interface EconomyStatsRead {
 pool: { emissionPool: string; playPoolInitial: string; poolPct: number; circulating: string;
  withdrawalEscrow: string; forgePayoutEscrow: string; leagueEntitlementEscrow: string };
 keepFlows: { emittedTotal: string; emittedToday: string; recycledTotal: string; expiredReturnedTotal: string };
 shards: { circulating: string; forgeEscrow: string; clanChest: string; burned: string;
  walletCompatibility?: string; deedBalances?: string; legacyForgeEscrow?: string; deedForgeEscrow?: string;
  flows: { issuedTotal: string; minedTotal: string; minedToday: string; cacheClaimedTotal: string;
   starterGrantedTotal: string; convertedTotal: string; otherIssuedTotal: string } };
 onchain: { withdrawnNet: string; withdrawnTotal: string; withdrawnToday: string; feesBurned: string; deposited: string };
 health: { netEmissionDrain: string };
}
export interface EconomyInput {
 cluster: Cluster;
 snapshot: { cluster: Cluster; data: EconomyStatsRead } | null;
 loading: boolean;
 error: string | null;
 fresh: boolean;
 /** Takes the exact display decimal string, never a Number conversion. */
 formatAmount: (exact: string) => string;
}
const unsignedDecimal = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const signedDecimal = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
export function economyModel(input: EconomyInput): AccountAdapterModel & { custodyNote: string } {
 const data = input.cluster !== 'unknown' && input.snapshot?.cluster === input.cluster ? input.snapshot.data : null;
 const stale = !input.fresh || input.loading || !!input.error;
 const rows: AccountRow[] = [];
 const add = (id: string, title: string, group: string, value: string | undefined, signed = false): void => {
  const known = value !== undefined && (signed ? signedDecimal : unsignedDecimal).test(value);
  rows.push({ id: `economy.${id}`, title, sub: group, value: known ? input.formatAmount(value) : '…', ...(known && stale ? { tag: 'LAST READ' } : {}) });
 };
 add('pool.emissionPool', 'EMISSION POOL', 'KEEP POOL', data?.pool.emissionPool);
 add('pool.playPoolInitial', 'INITIAL PLAY POOL', 'KEEP POOL', data?.pool.playPoolInitial);
 const pct = data?.pool.poolPct;
 rows.push({ id: 'economy.pool.poolPct', title: 'POOL REMAINING', sub: 'KEEP POOL',
  value: pct !== undefined && Number.isFinite(pct) && pct >= 0 ? `${pct}%` : '…', ...(pct !== undefined && Number.isFinite(pct) && pct >= 0 && stale ? { tag: 'LAST READ' } : {}) });
 add('pool.circulating', 'CIRCULATING (players)', 'KEEP POOL', data?.pool.circulating);
 add('pool.withdrawalEscrow', 'WITHDRAWAL ESCROW', 'KEEP POOL', data?.pool.withdrawalEscrow);
 add('pool.forgePayoutEscrow', 'FORGE PAYOUT ESCROW', 'KEEP POOL', data?.pool.forgePayoutEscrow);
 add('pool.leagueEntitlementEscrow', 'LEAGUE PRIZE ESCROW', 'KEEP POOL', data?.pool.leagueEntitlementEscrow);
 add('keepFlows.emittedToday', 'EMITTED TODAY', 'KEEP FLOWS', data?.keepFlows.emittedToday);
 add('keepFlows.emittedTotal', 'EMITTED (all-time)', 'KEEP FLOWS', data?.keepFlows.emittedTotal);
 add('keepFlows.recycledTotal', 'RECYCLED TO POOL', 'KEEP FLOWS', data?.keepFlows.recycledTotal);
 add('keepFlows.expiredReturnedTotal', 'EXPIRED ALLOCATIONS RETURNED', 'KEEP FLOWS', data?.keepFlows.expiredReturnedTotal);
 add('health.netEmissionDrain', 'NET KEEP EMISSION DRAIN', 'KEEP FLOWS', data?.health.netEmissionDrain, true);
 const drain = data?.health.netEmissionDrain;
 if (!stale && drain !== undefined && signedDecimal.test(drain)) {
  const shrinking = !drain.startsWith('-') && /[1-9]/.test(drain);
  rows[rows.length - 1]!.sub = `KEEP FLOWS · ${shrinking ? 'POOL SHRINKING' : 'POOL HEALTHY'}`;
 }
 add('shards.circulating', 'CIRCULATING SHARDS', 'SHARDS ISSUANCE', data?.shards.circulating);
 add('shards.flows.minedToday', 'MINED TODAY', 'SHARDS ISSUANCE', data?.shards.flows.minedToday);
 add('shards.flows.minedTotal', 'MINED (all-time)', 'SHARDS ISSUANCE', data?.shards.flows.minedTotal);
 add('shards.flows.cacheClaimedTotal', 'DAILY CACHE CLAIMS', 'SHARDS ISSUANCE', data?.shards.flows.cacheClaimedTotal);
 add('shards.flows.starterGrantedTotal', 'STARTER GRANTS + TOP-UPS', 'SHARDS ISSUANCE', data?.shards.flows.starterGrantedTotal);
 add('shards.flows.convertedTotal', 'KEEP CONVERSIONS', 'SHARDS ISSUANCE', data?.shards.flows.convertedTotal);
 add('shards.flows.otherIssuedTotal', 'OTHER SHARDS ISSUED', 'SHARDS ISSUANCE', data?.shards.flows.otherIssuedTotal, true);
 add('shards.flows.issuedTotal', 'TOTAL SHARDS ISSUED', 'SHARDS ISSUANCE', data?.shards.flows.issuedTotal);
 add('shards.burned', 'SHARDS BURNED', 'SHARDS ISSUANCE', data?.shards.burned);
 add('onchain.withdrawnToday', 'WITHDRAWN TODAY', 'ON-CHAIN MOVEMENT', data?.onchain.withdrawnToday);
 add('onchain.withdrawnNet', 'WITHDRAWN (net out)', 'ON-CHAIN MOVEMENT', data?.onchain.withdrawnNet, true);
 add('onchain.deposited', 'DEPOSITED (in)', 'ON-CHAIN MOVEMENT', data?.onchain.deposited);
 add('onchain.feesBurned', 'FEES BURNED', 'ON-CHAIN MOVEMENT', data?.onchain.feesBurned);
 return { rows, primary: null, load: input.loading ? 'LOADING' : input.error ? 'ERROR' : 'READY',
  custodyNote: 'Quests award SHARDS. Gold Forge payouts, eligible Ruined Keep KEEP bounties and explicitly budgeted alpha rewards debit the single bounded gameplay emission pool. Deposits mirror player-owned KEEP in custody and never fund rewards. Withdrawals are the on-chain KEEP outflow.',
  note: input.error ?? (data && stale ? 'Showing the last read. Refresh to check the current economy.' : 'Read-only economy totals from the server.') };
}
