import type { PLAYTEST_COMPETITIONS } from '@shardkeep/shared';
export interface CampaignStanding {
  rank: number; wallet: string; username: string; points: number; activeDays: number;
  longestStreak: number; revenge: number; stages: number; achievedAt: string | null;
  eligible: boolean; guaranteed: boolean;
}
export interface CampaignParticipant {
  wallet: string; username?: string; joinedAt: string; disqualifiedAt: string | null;
  disqualificationReason: string | null; bonusAt: string | null;
}
export interface CampaignSubmission {
  id: string; wallet?: string; username?: string; kind: 'report' | 'video';
  reportId: string | null; url: string | null; createdAt: string;
}
export interface CampaignAward {
  prizeId: string; wallet: string; username: string; amountUsd: number;
  category: string; evidence?: unknown; decidedAt?: string; paidAt?: string | null;
  paymentReference?: string | null;
}
export interface CampaignView {
  id: string; kind: 'founding' | 'rewarded'; name: string;
  phase: 'draft' | 'scheduled' | 'running' | 'ended' | 'finalized' | 'cancelled';
  startAt: string | null; endAt: string | null; registrationOpen: boolean;
  revision: number; reconciledAt: string | null; snapshotAt: string | null;
  checkpoint: { count: number | null; target: number; frozen: boolean; available: boolean; verification?: { status: 'verified' | 'stale' | 'unavailable'; lastSuccessAt: string | null; lastAttemptAt: string | null } } | null;
  spots: { reserved: number; ranked: number; total: number } | null;
  stale: boolean; measurementSince: string | null; participant: CampaignParticipant | null;
  standings: CampaignStanding[]; founders: Array<{ wallet: string; username: string; position: number }>;
  winners: CampaignAward[]; prizes: readonly (typeof PLAYTEST_COMPETITIONS.prizes)[number][];
  ownSubmissions: CampaignSubmission[];
}
export interface AdminCampaignView extends CampaignView {
  participants: CampaignParticipant[]; submissions: CampaignSubmission[]; awards: CampaignAward[];
  closeVerification?: { complete: boolean; missingAssets: Array<{ assetId: string; wallet: string; reason: string }> };
  mintVerification: { complete: boolean; unresolvedAssets: string[]; verifiedUniqueWallets: number; inventoryCompletedAt: string | null; status?: 'verified' | 'stale' | 'unavailable'; lastAttemptAt?: string | null; lastSuccessAt?: string | null; reason?: string | null; diagnostics?: { attempts: number; stage?: string; contextRetries?: number } | null };
}
