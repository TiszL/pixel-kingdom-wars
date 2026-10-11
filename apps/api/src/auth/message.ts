/**
 * Canonical SIWS-style sign-in message (ARCHITECTURE §5).
 * Built EXCLUSIVELY from server-stored values (wallet, nonce, issuedAt) so the
 * client signs exactly what the server later reconstructs and verifies.
 */
export interface SignInMessageParams {
  /** Host shown to the user, derived from WEB_ORIGIN. */
  domain: string;
  /** base58 wallet pubkey. */
  wallet: string;
  nonce: string;
  issuedAt: Date;
}

export type RecentAuthMessagePurpose =
  | 'factor_change' | 'key_export' | 'withdrawal' | 'admin_mail_reward' | 'totp_recovery';

interface RecentAuthMessageParams {
  domain: string;
  wallet: string;
  sessionId: string;
  purpose: RecentAuthMessagePurpose;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  intent?:
    | {
        version: 1;
        grossAmount: string;
        feeBurned: string;
        netAmount: string;
        cluster: 'devnet' | 'mainnet-beta';
        keepMint: string;
        destination: string;
        idempotencyKey: string;
        mode: 'standard' | 'instant';
        unbondingHours: number;
      }
    | {
        recipientWallet: string;
        idempotencyKey: string;
        subject: string;
        attachments: Array<
          | { kind: 'KEEP' | 'SHARDS'; amount: string }
          | { kind: 'ITEM'; itemId: string; qty: number }
        >;
        contentHash: string;
      }
    | {
        recoveryId: string;
        action: 'start' | 'complete';
      };
}

/**
 * Distinct from sign-in and Seeker linking. The purpose, session and (for an
 * instant withdrawal) exact request are visible in the wallet prompt and signed,
 * so a proof collected for one sensitive action cannot authorize another.
 */
export function buildRecentAuthMessage(params: RecentAuthMessageParams): string {
  const action = params.purpose === 'factor_change'
    ? 'Manage account email and authenticator factors'
    : params.purpose === 'key_export'
      ? 'Export this account’s private key'
      : params.purpose === 'withdrawal'
        ? 'Authorize a KEEP withdrawal'
        : params.purpose === 'totp_recovery'
          ? (params.intent && 'recoveryId' in params.intent && params.intent.action === 'complete'
              ? 'Complete lost-authenticator recovery'
              : 'Start lost-authenticator recovery')
          : 'Send an in-game reward mail';
  const intentLines = params.intent
    ? ('grossAmount' in params.intent ? [
        'Authorization version: 1',
        `Gross amount: ${params.intent.grossAmount} KEEP`,
        `Withdrawal fee: ${params.intent.feeBurned} KEEP`,
        `Net wallet payout: ${params.intent.netAmount} KEEP`,
        `Solana cluster: ${params.intent.cluster}`,
        `KEEP mint: ${params.intent.keepMint}`,
        `Destination: ${params.intent.destination}`,
        `Request ID: ${params.intent.idempotencyKey}`,
        `Mode: ${params.intent.mode}`,
        `Security hold: ${params.intent.unbondingHours} hours`,
      ] : 'recoveryId' in params.intent ? [
        `Recovery ID: ${params.intent.recoveryId}`,
        `Recovery phase: ${params.intent.action}`,
      ] : [
        `Recipient: ${params.intent.recipientWallet}`,
        `Request ID: ${params.intent.idempotencyKey}`,
        `Subject: ${JSON.stringify(params.intent.subject)}`,
        ...params.intent.attachments.map((attachment, index) => attachment.kind === 'ITEM'
          ? `Attachment ${index + 1}: ${attachment.qty} × ${attachment.itemId}`
          : `Attachment ${index + 1}: ${attachment.amount} ${attachment.kind}`),
        `Reward content SHA-256: ${params.intent.contentHash}`,
      ])
    : [];
  return [
    `${params.domain} wants you to confirm a sensitive Pixel Kingdom Wars action:`,
    params.wallet,
    '',
    `Action: ${action}`,
    ...intentLines,
    `Session: ${params.sessionId}`,
    'This signature authorizes only the action shown above. It triggers no blockchain transaction and costs no fees.',
    '',
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt.toISOString()}`,
    `Expiration Time: ${params.expiresAt.toISOString()}`,
  ].join('\n');
}

/**
 * Canonical Seeker-LINK message. Deliberately a DIFFERENT string from the
 * sign-in message and it names BOTH wallets, so a signature collected here can
 * never be replayed as a sign-in for the Seeker wallet, nor onto another game
 * account. (The nonce row is also scoped by `purpose`; this is the second lock.)
 */
export function buildSeekerLinkMessage(
  { domain, seekerWallet, gameWallet, nonce, issuedAt }: {
    domain: string; seekerWallet: string; gameWallet: string; nonce: string; issuedAt: Date;
  },
): string {
  return [
    `${domain} wants you to link a Solana Mobile Seeker wallet:`,
    seekerWallet,
    '',
    `Linking to Pixel Kingdom Wars account: ${gameWallet}`,
    'This proves you control the Seeker wallet. It grants no spending permission, triggers no blockchain transaction, and costs no fees.',
    '',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
  ].join('\n');
}

export function buildSignInMessage({ domain, wallet, nonce, issuedAt }: SignInMessageParams): string {
  return [
    `${domain} wants you to sign in with your Solana account:`,
    wallet,
    '',
    'Sign to authenticate with Pixel Kingdom Wars. This request will not trigger a blockchain transaction or cost any fees.',
    '',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
  ].join('\n');
}
