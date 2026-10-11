/** Profile display models over existing web contracts. No account or wallet side effects. */
import type { BaseStateDto } from '../../../state/store';
import type { WalletBalancesDto } from '../../screens/wallet';
import type { TwoFaStatus } from '../../screens/menu';
import type { AccountRow } from './AccountSheets';
import type { AccountAdapterModel } from './accountAdapters';
import type { WalletHubCluster } from '@shardkeep/shared';

export interface ProfileOverviewInput {
  wallet: string | null;
  player: BaseStateDto['player'] | null;
  loading: boolean;
  error: string | null;
}
const count = (value: number | undefined): string => value !== undefined && Number.isSafeInteger(value) && value >= 0 ? String(value) : '…';
const text = (value: string | null | undefined): string => value?.trim() || '…';
const door = (id: string, label: string): AccountRow => ({ id, title: label, action: { id, label, state: 'ENABLED', kind: 'navigate' } });

export function profileOverviewModel(input: ProfileOverviewInput): AccountAdapterModel {
  const player = input.wallet !== null && input.player?.wallet === input.wallet ? input.player : null;
  return { primary: null, load: input.loading ? 'LOADING' : input.error ? 'ERROR' : 'READY', note: input.error,
    rows: [
      { id: 'profile.name', title: 'PLAYER', value: text(player?.name) },
      { id: 'profile.keep', title: 'KEEP', value: count(player?.keepLevel) },
      { id: 'profile.trophies', title: 'TROPHIES', value: count(player?.trophies) },
      { id: 'profile.league', title: 'LEAGUE', value: text(player?.league), action: { id: 'hub.leagues', label: 'LEAGUES', state: 'ENABLED', kind: 'navigate' } },
      door('hub.invite', 'INVITE'), door('account.settings', 'SETTINGS'), door('account.security', 'SECURITY'), door('account.economy', 'ECONOMY'),
    ],
  };
}

export interface ProfileWalletInput {
  wallet: string | null;
  /** Wallet binding captured by the existing authenticated balance producer. */
  snapshot: { wallet: string; gameCluster: 'devnet' | 'mainnet-beta' | 'unknown'; balances: WalletBalancesDto } | null;
  gameCluster: 'devnet' | 'mainnet-beta' | 'unknown';
  /** Existing WALLET_HUB/approved token catalogue labels, never inferred from the game cluster. */
  tokens: ReadonlyArray<{ symbol: string; cluster: WalletHubCluster }>;
  loading: boolean;
  error: string | null;
  /** Existing fmtBalance behavior; input remains the legacy server display DTO, not a signing amount. */
  formatAmount: (amount: number | null) => string;
}

export function profileWalletModel(input: ProfileWalletInput): AccountAdapterModel {
  const model: AccountAdapterModel = { rows: [], primary: null, load: input.loading ? 'LOADING' : input.error ? 'ERROR' : 'READY',
    note: input.error ?? 'In your wallet · yours, not the game’s' };
  if (!input.wallet) return { ...model, primary: { id: 'wallet.connect', label: 'CONNECT WALLET', state: 'ENABLED', kind: 'navigate' }, note: 'Link a wallet to buy land and hold KEEP.' };
  const balances = input.snapshot?.wallet === input.wallet && input.snapshot.gameCluster === input.gameCluster ? input.snapshot.balances : null;
  const gameLabel = input.gameCluster === 'devnet' ? 'DEVNET' : input.gameCluster === 'mainnet-beta' ? 'MAINNET' : 'CLUSTER UNAVAILABLE';
  const seen = new Set<string>();
  const catalogue = [{ symbol: 'SOL', cluster: 'game' as const }, ...input.tokens].filter(token => {
    if (seen.has(token.symbol)) return false;
    seen.add(token.symbol); return true;
  });
  const rows: AccountRow[] = catalogue.map(({ symbol, cluster: configured }): AccountRow => {
    const cluster = configured === 'mainnet' ? 'MAINNET' : configured === 'game' ? gameLabel : 'CLUSTER UNAVAILABLE';
    const value = symbol === 'SOL' ? balances?.sol : balances?.tokens[symbol];
    const known = cluster !== 'CLUSTER UNAVAILABLE' && value !== null && value !== undefined && Number.isFinite(value) && value >= 0;
    return { id: `wallet.${symbol}`, title: symbol, sub: cluster, value: known ? input.formatAmount(value) : '…',
      tag: known ? input.error || input.loading ? 'LAST READ' : cluster : input.loading ? 'CHECKING' : 'UNAVAILABLE',
      ...(symbol === 'KEEP' ? { action: { id: 'goldforge.forge', label: 'GOLD FORGE', state: 'ENABLED', kind: 'navigate' } as const }
        : symbol === 'SKR' ? { action: { id: 'map.seeker', label: 'SEEKER ISLAND', state: 'ENABLED', kind: 'navigate' } as const } : {}),
    };
  });
  if (input.gameCluster === 'devnet') rows.push(door('wallet.test-sol', 'TEST SOL'));
  rows.push(door('wallet.exchange', 'EXCHANGE (JUPITER)'));
  rows.push({ id: 'wallet.refresh', title: 'WALLET READ', action: { id: 'wallet.refresh', label: 'REFRESH', state: input.loading ? 'BUSY' : 'ENABLED', kind: 'recover' } });
  return { ...model, rows };
}

export interface ProfileAccountInput {
  wallet: string | null;
  /** Verified producer scope for saved name, linked methods and security read. */
  snapshotWallet: string | null;
  /** null = not read yet; empty string = known to have no saved name. */
  savedName: string | null;
  draft: string | null;
  saving: boolean;
  nameError: string | null;
  providers: Record<string, boolean> | null;
  security: Pick<TwoFaStatus, 'totpEnabled' | 'emailVerified'> | null;
  loading: boolean;
  error: string | null;
}
export interface ProfileAccountModel extends AccountAdapterModel {
  draft: string;
  saved: string;
  saving: boolean;
  linked: Record<string, boolean>;
}

export function profileAccountModel(input: ProfileAccountInput): ProfileAccountModel {
  const current = input.wallet !== null && input.snapshotWallet === input.wallet;
  const saved = current ? input.savedName ?? '' : '';
  const security = current ? input.security : null;
  return { draft: current ? input.draft ?? saved : '', saved, saving: input.saving || input.loading || !current || input.savedName === null,
    linked: current ? { ...input.providers } : {}, primary: null,
    rows: [
      { id: 'security.totp.status', title: '2-STEP CODE', value: security ? security.totpEnabled ? 'ON' : 'OFF' : '…' },
      { id: 'security.email.status', title: 'RECOVERY EMAIL', value: security ? security.emailVerified ? 'VERIFIED' : 'NOT VERIFIED' : '…' },
      // The existing status DTO does not provide a remaining backup-code count.
      { id: 'security.backup.status', title: 'BACKUP CODES', value: '…' },
    ], load: input.loading || !current ? 'LOADING' : input.error ? 'ERROR' : 'READY', note: current ? input.nameError ?? input.error : 'Checking the current account.',
  };
}
