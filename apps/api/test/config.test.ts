/**
 * EnvSchema boot validation. WHY: every ops kill-switch must fail boot on a
 * typo, never silently fall back — WITHDRAWALS_ENABLED read raw meant `FALSE`,
 * `0` or `no` left the bootstrap withdrawal gate OPEN with zero signal
 * (audit 2026-07-26 B4). ENABLE_WORKERS / DEV_LOGIN already had this contract;
 * this pins WITHDRAWALS_ENABLED to it.
 */
import { createECDH } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { devLoginRealm, heroGearCombatEnabled, loadConfig, loadNativeServiceConfig, phaseECatalogEnabled, resolveSolanaRpcUrl } from '../src/config';

const BASE_ENV = {
  DATABASE_URL: 'postgres://x:y@localhost:5433/example',
  JWT_SECRET: 'test-secret-test-secret-test-secret!',
  WEB_ORIGIN: 'http://localhost:5173',
  NODE_ENV: 'test',
};

const REMOTE_SIGNER_ENV = {
  WITHDRAWAL_SIGNER_MODE: 'remote',
  WITHDRAWAL_POLICY_CUSTODY_BACKEND: 'file',
  WITHDRAWAL_POLICY_SIGNER_URL: 'http://withdrawal-signer:3003',
  WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP: 'true',
  WITHDRAWAL_POLICY_SIGNER_AUTH_TOKEN_FILE: '/run/secrets/withdrawal-policy-signer.token',
  WITHDRAWAL_POLICY_KEEP_MINT: '3HaPGBPEuEtckbc7peEkNCXZKQTEyDqtmrfnM9bEbpLf',
  WITHDRAWAL_POLICY_MAX_PER_TRANSFER_KEEP: '50000',
  WITHDRAWAL_POLICY_MAX_PER_WALLET_24H_KEEP: '100000',
  WITHDRAWAL_POLICY_MAX_AGGREGATE_24H_KEEP: '1000000',
} as const;

describe('EnvSchema — WITHDRAWALS_ENABLED', () => {
  it("defaults ON (the documented decision: devnet + steady state need no config)", () => {
    expect(loadConfig({ ...BASE_ENV }).WITHDRAWALS_ENABLED).toBe('true');
  });

  it('accepts exactly the two literals', () => {
    expect(loadConfig({ ...BASE_ENV, WITHDRAWALS_ENABLED: 'false' }).WITHDRAWALS_ENABLED).toBe('false');
    expect(loadConfig({ ...BASE_ENV, WITHDRAWALS_ENABLED: 'true' }).WITHDRAWALS_ENABLED).toBe('true');
  });

  it('FAILS BOOT on any other spelling — a typo must never mean "gate open"', () => {
    for (const bad of ['FALSE', '0', 'no', 'off', 'False']) {
      expect(() => loadConfig({ ...BASE_ENV, WITHDRAWALS_ENABLED: bad })).toThrow();
    }
  });
});

describe('EnvSchema — LEAGUE_REWARDS_ENABLED', () => {
  it('defaults dark and accepts only exact lowercase rollout literals', () => {
    expect(loadConfig({ ...BASE_ENV }).LEAGUE_REWARDS_ENABLED).toBe('false');
    expect(loadConfig({ ...BASE_ENV, LEAGUE_REWARDS_ENABLED: 'true' }).LEAGUE_REWARDS_ENABLED)
      .toBe('true');
    for (const bad of ['TRUE', 'FALSE', '1', 'yes', 'on']) {
      expect(() => loadConfig({ ...BASE_ENV, LEAGUE_REWARDS_ENABLED: bad }), bad)
        .toThrow(/LEAGUE_REWARDS_ENABLED/);
    }
  });

  it('accepts only a complete Monday UTC earning-window start', () => {
    expect(loadConfig({ ...BASE_ENV }).LEAGUE_REWARD_START_WEEK).toBe('2026-09-07');
    expect(loadConfig({ ...BASE_ENV, LEAGUE_REWARD_START_WEEK: '2026-09-14' })
      .LEAGUE_REWARD_START_WEEK).toBe('2026-09-14');
    for (const bad of ['2026-09-08', '2026-9-7', '2026-02-30', 'tomorrow']) {
      expect(() => loadConfig({ ...BASE_ENV, LEAGUE_REWARD_START_WEEK: bad }), bad)
        .toThrow(/LEAGUE_REWARD_START_WEEK/);
    }
  });
});

describe('EnvSchema — PUSH_NOTIFICATIONS_ENABLED', () => {
  const privateKey = Buffer.alloc(32, 2);
  const pair = createECDH('prime256v1');
  pair.setPrivateKey(privateKey);
  const vapid = {
    VAPID_PUBLIC_KEY: pair.getPublicKey().toString('base64url'),
    VAPID_PRIVATE_KEY: privateKey.toString('base64url'),
    VAPID_SUBJECT: 'mailto:support@pixelkingdomwars.com',
  };

  it('defaults dark, accepts only exact rollout literals, and trims blank optional keys', () => {
    expect(loadConfig({ ...BASE_ENV }).PUSH_NOTIFICATIONS_ENABLED).toBe('false');
    expect(loadConfig({ ...BASE_ENV, VAPID_PUBLIC_KEY: '   ' }).VAPID_PUBLIC_KEY).toBeUndefined();
    for (const bad of ['TRUE', 'FALSE', '1', 'yes', 'on']) {
      expect(() => loadConfig({ ...BASE_ENV, PUSH_NOTIFICATIONS_ENABLED: bad }), bad)
        .toThrow(/PUSH_NOTIFICATIONS_ENABLED/);
    }
  });

  it('refuses to burn claimed events behind an incomplete VAPID identity', () => {
    expect(() => loadConfig({ ...BASE_ENV, PUSH_NOTIFICATIONS_ENABLED: 'true' }))
      .toThrow(/requires ALL of VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT/);
    expect(() => loadConfig({
      ...BASE_ENV, PUSH_NOTIFICATIONS_ENABLED: 'true',
      VAPID_PUBLIC_KEY: vapid.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: vapid.VAPID_PRIVATE_KEY,
    })).toThrow(/VAPID/);
    expect(loadConfig({ ...BASE_ENV, PUSH_NOTIFICATIONS_ENABLED: 'true', ...vapid }))
      .toMatchObject({ PUSH_NOTIFICATIONS_ENABLED: 'true', ...vapid });
    for (const broken of [
      { ...vapid, VAPID_PUBLIC_KEY: vapid.VAPID_PUBLIC_KEY.slice(1) },
      { ...vapid, VAPID_PRIVATE_KEY: `${vapid.VAPID_PRIVATE_KEY}=` },
      {
        ...vapid,
        VAPID_PRIVATE_KEY: Buffer.alloc(32, 3).toString('base64url'),
      },
    ]) {
      expect(() => loadConfig({ ...BASE_ENV, PUSH_NOTIFICATIONS_ENABLED: 'true', ...broken }))
        .toThrow(/VAPID_(PUBLIC|PRIVATE)_KEY|matching P-256 pair/);
    }
  });

  it('requires an operator-contact mailto or https URL', () => {
    for (const subject of ['support@example.com', 'http://example.com', 'ftp://example.com']) {
      expect(() => loadConfig({ ...BASE_ENV, ...vapid, VAPID_SUBJECT: subject }), subject)
        .toThrow(/VAPID_SUBJECT/);
    }
    expect(loadConfig({ ...BASE_ENV, ...vapid, VAPID_SUBJECT: 'https://example.com/support' }).VAPID_SUBJECT)
      .toBe('https://example.com/support');
  });
});

describe('EnvSchema — MINE_FULL_NOTIFICATIONS_ENABLED', () => {
  it('defaults dark, accepts exact literals, and cannot outrun the parent push gate', () => {
    expect(loadConfig({ ...BASE_ENV }).MINE_FULL_NOTIFICATIONS_ENABLED).toBe('false');
    expect(() => loadConfig({
      ...BASE_ENV, MINE_FULL_NOTIFICATIONS_ENABLED: 'true',
    })).toThrow(/requires PUSH_NOTIFICATIONS_ENABLED=true/);
    for (const bad of ['TRUE', 'FALSE', '1', 'yes', 'on']) {
      expect(() => loadConfig({ ...BASE_ENV, MINE_FULL_NOTIFICATIONS_ENABLED: bad }), bad)
        .toThrow(/MINE_FULL_NOTIFICATIONS_ENABLED/);
    }
  });
});

describe('EnvSchema — RAID_EVENTS_ENABLED', () => {
  it('defaults to status polling and accepts only explicit boolean literals', () => {
    expect(loadConfig({ ...BASE_ENV }).RAID_EVENTS_ENABLED).toBe('false');
    expect(loadConfig({ ...BASE_ENV, RAID_EVENTS_ENABLED: 'true' }).RAID_EVENTS_ENABLED).toBe('true');
    for (const bad of ['TRUE', '1', 'yes', 'on']) {
      expect(() => loadConfig({ ...BASE_ENV, RAID_EVENTS_ENABLED: bad })).toThrow(/RAID_EVENTS_ENABLED/);
    }
  });
});

describe('EnvSchema — LIVE_RAID_V2_ENABLED', () => {
  it('fails closed and accepts only exact boolean literals', () => {
    expect(loadConfig({ ...BASE_ENV }).LIVE_RAID_V2_ENABLED).toBe('false');
    expect(loadConfig({ ...BASE_ENV, LIVE_RAID_V2_ENABLED: 'true' }).LIVE_RAID_V2_ENABLED)
      .toBe('true');
    for (const bad of ['TRUE', '1', 'yes', 'on']) {
      expect(() => loadConfig({ ...BASE_ENV, LIVE_RAID_V2_ENABLED: bad }), bad)
        .toThrow(/LIVE_RAID_V2_ENABLED/);
    }
  });
});

describe('public hot-wallet identity and worker payout cadence', () => {
  const PUBKEY = '3HaPGBPEuEtckbc7peEkNCXZKQTEyDqtmrfnM9bEbpLf';

  it('validates the public custody address without requiring a keypair path', () => {
    const cfg = loadConfig({ ...BASE_ENV, HOT_WALLET_PUBKEY: PUBKEY });
    expect(cfg.HOT_WALLET_PUBKEY).toBe(PUBKEY);
    expect(cfg.HOT_WALLET_KEYPAIR_PATH).toBeUndefined();
    for (const bad of ['not-a-wallet', '0xdeadbeef', PUBKEY.slice(0, 20)]) {
      expect(() => loadConfig({ ...BASE_ENV, HOT_WALLET_PUBKEY: bad }), bad)
        .toThrow(/HOT_WALLET_PUBKEY/);
    }
  });

  it('rejects the retired arbitrary reserve-owner list instead of counting LP or treasury holdings', () => {
    expect(loadConfig({ ...BASE_ENV, KEEP_RESERVE_EXTRA_OWNERS: '' }).KEEP_RESERVE_EXTRA_OWNERS)
      .toBeUndefined();
    expect(() => loadConfig({ ...BASE_ENV, KEEP_RESERVE_EXTRA_OWNERS: PUBKEY }))
      .toThrow(/KEEP_RESERVE_EXTRA_OWNERS/);
  });

  it('keeps instant payout polling in seconds and rejects unsafe cadence values', () => {
    expect(loadConfig({ ...BASE_ENV }).WITHDRAWAL_PAYOUT_POLL_MS).toBe(10_000);
    expect(loadConfig({ ...BASE_ENV, WITHDRAWAL_PAYOUT_POLL_MS: '2500' })
      .WITHDRAWAL_PAYOUT_POLL_MS).toBe(2_500);
    expect(() => loadConfig({ ...BASE_ENV, WITHDRAWAL_PAYOUT_POLL_MS: '999' }))
      .toThrow(/WITHDRAWAL_PAYOUT_POLL_MS/);
    expect(() => loadConfig({ ...BASE_ENV, WITHDRAWAL_PAYOUT_POLL_MS: '60001' }))
      .toThrow(/WITHDRAWAL_PAYOUT_POLL_MS/);
  });
});

describe('EnvSchema — DARK_ATTACKER_ROSTER_ENABLED', () => {
  it('defaults OFF so a compatible deploy cannot expose the roster early', () => {
    expect(loadConfig({ ...BASE_ENV }).DARK_ATTACKER_ROSTER_ENABLED).toBe('false');
  });

  it('accepts only exact lowercase rollout literals', () => {
    expect(loadConfig({ ...BASE_ENV, DARK_ATTACKER_ROSTER_ENABLED: 'false' })
      .DARK_ATTACKER_ROSTER_ENABLED).toBe('false');
    expect(loadConfig({ ...BASE_ENV, DARK_ATTACKER_ROSTER_ENABLED: 'true' })
      .DARK_ATTACKER_ROSTER_ENABLED).toBe('true');
    for (const bad of ['TRUE', 'FALSE', '1', 'yes', 'on']) {
      expect(() => loadConfig({ ...BASE_ENV, DARK_ATTACKER_ROSTER_ENABLED: bad }), bad)
        .toThrow(/DARK_ATTACKER_ROSTER_ENABLED/);
    }
  });
});

describe('EnvSchema — HERO_GEAR_COMBAT_ENABLED', () => {
  // D-059 (owner 2026-08-16): the counter-sim activation gate is proven in
  // packages/sim/tests/hero-gear.test.ts, so gear combat ships ON. The default
  // and the live-env reader must agree, or an unset production env would boot a
  // Config that says 'true' while raids silently freeze no loadouts.
  it('defaults ON — D-059 turned gear combat on after the counter-sim proof', () => {
    expect(loadConfig({ ...BASE_ENV }).HERO_GEAR_COMBAT_ENABLED).toBe('true');
    expect(heroGearCombatEnabled({})).toBe(true);
  });

  it("'false' stays an explicit emergency rollback in both the schema and the reader", () => {
    expect(loadConfig({ ...BASE_ENV, HERO_GEAR_COMBAT_ENABLED: 'false' })
      .HERO_GEAR_COMBAT_ENABLED).toBe('false');
    expect(heroGearCombatEnabled({ HERO_GEAR_COMBAT_ENABLED: 'false' })).toBe(false);
    expect(heroGearCombatEnabled({ HERO_GEAR_COMBAT_ENABLED: 'true' })).toBe(true);
  });

  it('accepts only exact lowercase rollout literals', () => {
    expect(loadConfig({ ...BASE_ENV, HERO_GEAR_COMBAT_ENABLED: 'true' })
      .HERO_GEAR_COMBAT_ENABLED).toBe('true');
    for (const bad of ['TRUE', 'FALSE', '1', 'yes', 'on']) {
      expect(() => loadConfig({ ...BASE_ENV, HERO_GEAR_COMBAT_ENABLED: bad }), bad)
        .toThrow(/HERO_GEAR_COMBAT_ENABLED/);
    }
  });
});

describe('EnvSchema — MAIL_DELIVERY_ENABLED', () => {
  it('defaults OFF and rejects ambiguous spellings', () => {
    expect(loadConfig({ ...BASE_ENV }).MAIL_DELIVERY_ENABLED).toBe('false');
    expect(loadConfig({ ...BASE_ENV, MAIL_DELIVERY_ENABLED: 'true' }).MAIL_DELIVERY_ENABLED).toBe('true');
    for (const bad of ['TRUE', '1', 'yes', 'on']) {
      expect(() => loadConfig({ ...BASE_ENV, MAIL_DELIVERY_ENABLED: bad }), bad)
        .toThrow(/MAIL_DELIVERY_ENABLED/);
    }
  });
});

describe('economy cluster cutover', () => {
  it('preserves devnet as the default without requiring a redundant endpoint', () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.SOLANA_CLUSTER).toBe('devnet');
    expect(config.SOLANA_RPC_URL).toBe('https://api.devnet.solana.com');
    expect(config.SOLANA_RPC_URL_2).toBeUndefined();
    expect(config.WITHDRAWAL_POLICY_CUSTODY_BACKEND).toBe('file');
    expect(() => loadConfig({
      ...BASE_ENV, WITHDRAWAL_POLICY_CUSTODY_BACKEND: 'hsm',
    })).toThrow(/WITHDRAWAL_POLICY_CUSTODY_BACKEND/);
  });

  it('requires two different RPC provider hosts and refuses file custody on mainnet-beta', () => {
    const mainnet = {
      ...BASE_ENV,
      ...REMOTE_SIGNER_ENV,
      SOLANA_CLUSTER: 'mainnet-beta',
      SOLANA_RPC_URL: 'https://mainnet.provider-a.example',
      SOLANA_RPC_URL_2: 'https://mainnet.provider-b.example',
      SOLANA_RPC_PROVIDER: 'provider-a',
      SOLANA_RPC_PROVIDER_2: 'provider-b',
    };
    expect(() => loadConfig(mainnet)).toThrow(/forbids file-backed withdrawal custody/);
    expect(() => loadConfig({ ...mainnet, SOLANA_RPC_URL_2: '' }))
      .toThrow(/second independent economy RPC/);
    expect(() => loadConfig({
      ...mainnet,
      SOLANA_RPC_URL_2: 'https://mainnet.provider-a.example/another-path',
    })).toThrow(/different provider hosts/);
    expect(() => loadConfig({ ...mainnet, SOLANA_RPC_PROVIDER_2: '' }))
      .toThrow(/two explicit RPC vendor labels/);
    expect(() => loadConfig({ ...mainnet, SOLANA_RPC_PROVIDER_2: 'PROVIDER-A' }))
      .toThrow(/different vendors/);
  });

  it('requires the independently limited remote signer before mainnet can boot', () => {
    const mainnet = {
      ...BASE_ENV,
      ...REMOTE_SIGNER_ENV,
      SOLANA_CLUSTER: 'mainnet-beta',
      SOLANA_RPC_URL: 'https://mainnet.provider-a.example',
      SOLANA_RPC_URL_2: 'https://mainnet.provider-b.example',
      SOLANA_RPC_PROVIDER: 'provider-a',
      SOLANA_RPC_PROVIDER_2: 'provider-b',
    };
    expect(() => loadConfig({ ...mainnet, WITHDRAWAL_SIGNER_MODE: 'legacy' }))
      .toThrow(/independent remote withdrawal policy signer/);
    expect(() => loadConfig({ ...mainnet, WITHDRAWAL_POLICY_MAX_AGGREGATE_24H_KEEP: '' }))
      .toThrow(/remote signer requires WITHDRAWAL_POLICY_MAX_AGGREGATE_24H_KEEP/);
    expect(() => loadConfig({
      ...mainnet,
      WITHDRAWAL_POLICY_MAX_PER_TRANSFER_KEEP: '100001',
      WITHDRAWAL_POLICY_MAX_PER_WALLET_24H_KEEP: '100000',
    })).toThrow(/transfer <= wallet <= aggregate/);
    expect(() => loadConfig({
      ...mainnet,
      WITHDRAWAL_POLICY_SIGNER_URL: 'http://user:password@withdrawal-signer:3003/path',
    })).toThrow(/bare http\(s\) origin/);
  });

  it('allows only HTTPS, loopback HTTP, or the explicitly opted-in private signer origin', () => {
    expect(loadConfig({ ...BASE_ENV, ...REMOTE_SIGNER_ENV })
      .WITHDRAWAL_POLICY_SIGNER_URL).toBe('http://withdrawal-signer:3003');
    expect(loadConfig({
      ...BASE_ENV, ...REMOTE_SIGNER_ENV,
      WITHDRAWAL_POLICY_SIGNER_URL: 'http://127.0.0.1:3003',
      WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP: 'false',
    }).WITHDRAWAL_POLICY_SIGNER_URL).toBe('http://127.0.0.1:3003');
    expect(loadConfig({
      ...BASE_ENV, ...REMOTE_SIGNER_ENV,
      WITHDRAWAL_POLICY_SIGNER_URL: 'https://signer.example.com',
      WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP: 'false',
    }).WITHDRAWAL_POLICY_SIGNER_URL).toBe('https://signer.example.com');
    expect(() => loadConfig({
      ...BASE_ENV, ...REMOTE_SIGNER_ENV,
      WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP: 'false',
    })).toThrow(/explicit private-network opt-in/);
    expect(() => loadConfig({
      ...BASE_ENV, ...REMOTE_SIGNER_ENV,
      WITHDRAWAL_POLICY_SIGNER_URL: 'http://attacker.example:3003',
    })).toThrow(/exactly http:\/\/withdrawal-signer:3003/);
    expect(() => loadConfig({
      ...BASE_ENV, ...REMOTE_SIGNER_ENV,
      WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP: 'TRUE',
    })).toThrow(/WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP/);
  });

  it('rejects every unsupported cluster literal', () => {
    for (const cluster of ['mainnet', 'testnet', 'DEVNET', '']) {
      expect(() => loadConfig({ ...BASE_ENV, SOLANA_CLUSTER: cluster }), cluster)
        .toThrow(/SOLANA_CLUSTER/);
    }
  });

  it('keeps mainnet admin KEEP campaigns explicitly disabled by default', () => {
    expect(loadConfig({ ...BASE_ENV }).MAINNET_COMMUNITY_KEEP_MAIL_ENABLED).toBe('false');
    expect(loadConfig({ ...BASE_ENV, MAINNET_COMMUNITY_KEEP_MAIL_ENABLED: 'true' })
      .MAINNET_COMMUNITY_KEEP_MAIL_ENABLED).toBe('true');
    expect(() => loadConfig({ ...BASE_ENV, MAINNET_COMMUNITY_KEEP_MAIL_ENABLED: 'yes' }))
      .toThrow(/MAINNET_COMMUNITY_KEEP_MAIL_ENABLED/);
  });

  it('requires a safe campaign id and positive cumulative budget before mainnet KEEP mail can open', () => {
    const mainnet = {
      ...BASE_ENV,
      ...REMOTE_SIGNER_ENV,
      SOLANA_CLUSTER: 'mainnet-beta',
      SOLANA_RPC_URL: 'https://mainnet.provider-a.example',
      SOLANA_RPC_URL_2: 'https://mainnet.provider-b.example',
      SOLANA_RPC_PROVIDER: 'provider-a',
      SOLANA_RPC_PROVIDER_2: 'provider-b',
      MAINNET_COMMUNITY_KEEP_MAIL_ENABLED: 'true',
    };
    expect(() => loadConfig(mainnet)).toThrow(/campaign id and cumulative budget/);
    const completeCampaign = {
      MAINNET_COMMUNITY_KEEP_MAIL_CAMPAIGN_ID: 'founders_week_1',
      MAINNET_COMMUNITY_KEEP_MAIL_BUDGET: '500000',
    } as const;
    expect(loadConfig({ ...BASE_ENV, ...completeCampaign })).toMatchObject({
      MAINNET_COMMUNITY_KEEP_MAIL_CAMPAIGN_ID: 'founders_week_1',
      MAINNET_COMMUNITY_KEEP_MAIL_BUDGET: '500000',
    });
    expect(() => loadConfig({ ...mainnet, ...completeCampaign }))
      .toThrow(/forbids file-backed withdrawal custody/);
    expect(() => loadConfig({
      ...mainnet,
      MAINNET_COMMUNITY_KEEP_MAIL_CAMPAIGN_ID: 'Bad Campaign',
      MAINNET_COMMUNITY_KEEP_MAIL_BUDGET: '500000',
    })).toThrow(/campaign slug/);
    expect(() => loadConfig({
      ...mainnet,
      MAINNET_COMMUNITY_KEEP_MAIL_CAMPAIGN_ID: 'campaign',
      MAINNET_COMMUNITY_KEEP_MAIL_BUDGET: '0',
    })).toThrow(/positive decimal KEEP amount/);
  });
});

/**
 * The Seeker badge is verified against a SECOND cluster, and nothing else in the
 * config says which one it is. Aim this at devnet and every SGT check silently
 * answers "no badge" — or, on a cluster where anyone can create accounts under
 * the authorities the predicate trusts, silently grants one (security review
 * F8). This is the cheap half; the boot-time genesis-hash assertion
 * (assertMainnetCluster, wired in server.ts) is the authoritative one.
 */
describe('EnvSchema — SOLANA_MAINNET_RPC_URL must be mainnet', () => {
  it('accepts a mainnet endpoint, and absence (the feature is optional)', () => {
    expect(loadConfig({ ...BASE_ENV }).SOLANA_MAINNET_RPC_URL).toBeUndefined();
    expect(loadConfig({ ...BASE_ENV, SOLANA_MAINNET_RPC_URL: 'https://api.mainnet-beta.solana.com' })
      .SOLANA_MAINNET_RPC_URL).toBe('https://api.mainnet-beta.solana.com');
  });

  it('FAILS BOOT on a demonstrably non-mainnet host', () => {
    for (const bad of [
      'https://api.devnet.solana.com', // the copy-paste that motivated this
      'https://devnet.helius-rpc.com/?api-key=x',
      'https://api.testnet.solana.com',
      'http://localhost:8899',
      'http://127.0.0.1:8899',
    ]) {
      expect(() => loadConfig({ ...BASE_ENV, SOLANA_MAINNET_RPC_URL: bad }), bad).toThrow(/mainnet-beta/);
    }
  });
});

describe('WEB_ORIGIN is a validated CORS allowlist', () => {
  const base = {
    DATABASE_URL: 'postgres://x/y',
    JWT_SECRET: 'test-secret-test-secret-test-secret!',
    NODE_ENV: 'test' as const,
  };

  it('accepts one origin', () => {
    expect(loadConfig({ ...base, WEB_ORIGIN: 'https://play.example.com' }).WEB_ORIGIN)
      .toEqual(['https://play.example.com']);
  });

  it('accepts several, comma-separated, preserving order', () => {
    // Order matters: the FIRST is the host written into the sign-in message the
    // wallet shows the player (auth/routes.ts).
    expect(loadConfig({
      ...base,
      WEB_ORIGIN: 'https://play.example.com, http://localhost:5173 ,http://localhost:4173',
    }).WEB_ORIGIN).toEqual([
      'https://play.example.com', 'http://localhost:5173', 'http://localhost:4173',
    ]);
  });

  it('dedupes', () => {
    expect(loadConfig({ ...base, WEB_ORIGIN: 'http://a.test,http://a.test' }).WEB_ORIGIN)
      .toEqual(['http://a.test']);
  });

  it('REFUSES a wildcard', () => {
    // Credentials are sent on every request, so `*` is both forbidden by the CORS
    // spec with credentials and would expose every authenticated route to any
    // site on the internet. Fail at boot, not at runtime.
    expect(() => loadConfig({ ...base, WEB_ORIGIN: '*' })).toThrow(/WEB_ORIGIN/);
  });

  it('REFUSES a trailing slash or a path', () => {
    // A browser's Origin header never carries a path, so 'https://x/' would match
    // nothing and every request would fail with an opaque "Failed to fetch".
    // Rejecting it at boot names the real problem.
    expect(() => loadConfig({ ...base, WEB_ORIGIN: 'https://play.example.com/' })).toThrow(/WEB_ORIGIN/);
    expect(() => loadConfig({ ...base, WEB_ORIGIN: 'https://play.example.com/app' })).toThrow(/WEB_ORIGIN/);
  });

  it('REFUSES a non-URL entry, naming it', () => {
    expect(() => loadConfig({ ...base, WEB_ORIGIN: 'https://ok.test,not-a-url' }))
      .toThrow(/not-a-url/);
  });

  it('REFUSES empty', () => {
    expect(() => loadConfig({ ...base, WEB_ORIGIN: '  ,  ' })).toThrow(/WEB_ORIGIN/);
  });
});

describe('ALPHA_WALLETS — the closed-alpha gate, default OFF', () => {
  const base = {
    DATABASE_URL: 'postgres://x/y',
    JWT_SECRET: 'test-secret-test-secret-test-secret!',
    WEB_ORIGIN: 'https://play.example.com',
    NODE_ENV: 'test' as const,
  };
  const W = '3HaPGBPEuEtckbc7peEkNCXZKQTEyDqtmrfnM9bEbpLf';

  it('unset means OPEN, not locked', () => {
    // This variable is meant to be DELETED when the alpha opens. If an unset value
    // meant "closed", the deploy that opens the game would lock out everyone.
    expect(loadConfig(base).ALPHA_WALLETS).toBeUndefined();
  });

  it('a blank value means OPEN too', () => {
    // A leftover empty line in an env file must not brick the game.
    expect(loadConfig({ ...base, ALPHA_WALLETS: '   ' }).ALPHA_WALLETS).toBeUndefined();
  });

  it('parses, trims and dedupes a list', () => {
    expect(loadConfig({ ...base, ALPHA_WALLETS: ` ${W} , ${W} ` }).ALPHA_WALLETS).toEqual([W]);
  });

  it('FAILS BOOT on a malformed entry rather than guessing', () => {
    // Both silent outcomes are worse than a crash: dropping the entry locks the
    // owner out of his own game, and ignoring the variable leaves the alpha open.
    for (const bad of [W.slice(0, 10), `${W},nope`, '0xdeadbeef']) {
      expect(() => loadConfig({ ...base, ALPHA_WALLETS: bad }), bad).toThrow(/ALPHA_WALLETS/);
    }
  });
});

describe('production 2FA/email secrets fail closed at boot', () => {
  const production = {
    DATABASE_URL: 'postgres://x/y',
    JWT_SECRET: 'test-secret-test-secret-test-secret!',
    WEB_ORIGIN: 'https://play.example.com',
    NODE_ENV: 'production' as const,
    SOLANA_RPC_URL: 'https://devnet.helius-rpc.com/?api-key=test',
  };
  const keyring = 'prod-2026:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
  const email = { RESEND_API_KEY: 're_x', EMAIL_FROM: 'x@example.com' };

  it('requires a dedicated valid 32-byte 2FA keyring in production', () => {
    expect(() => loadConfig(production)).toThrow(/TWOFA_ENCRYPTION_KEYS/);
    expect(() => loadConfig({ ...production, TWOFA_ENCRYPTION_KEYS: 'bad:not-base64' }))
      .toThrow(/TWOFA_ENCRYPTION_KEYS/);
    expect(loadConfig({ ...production, TWOFA_ENCRYPTION_KEYS: keyring, ...email }).TWOFA_ENCRYPTION_KEYS)
      .toBe(keyring);
  });

  it('requires a complete production Resend sender (missing or half-configured)', () => {
    expect(() => loadConfig({ ...production, TWOFA_ENCRYPTION_KEYS: keyring }))
      .toThrow(/BOTH RESEND_API_KEY and EMAIL_FROM/);
    expect(() => loadConfig({ ...production, TWOFA_ENCRYPTION_KEYS: keyring, RESEND_API_KEY: 're_x' }))
      .toThrow(/BOTH RESEND_API_KEY and EMAIL_FROM/);
    expect(() => loadConfig({ ...production, TWOFA_ENCRYPTION_KEYS: keyring, EMAIL_FROM: 'x@example.com' }))
      .toThrow(/BOTH RESEND_API_KEY and EMAIL_FROM/);
  });
});


describe('EnvSchema — REALM_KIT_PREVIEW_MANIFESTS (dev/QA unpinned kit)', () => {
  const production = { ...BASE_ENV, NODE_ENV: 'production',
    SOLANA_RPC_URL: 'https://devnet.helius-rpc.com/?api-key=test',
    TWOFA_ENCRYPTION_KEYS: 'test:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
    RESEND_API_KEY: 're_test', EMAIL_FROM: 'test@example.com' };
  const manifest = `crownlands=atlas/fantasy/layered-ground/${'a'.repeat(64)}/manifest.json`;
  it('accepts <realmId>=atlas/.../manifest.json entries in development and refuses anything else', () => {
    expect(loadConfig({ ...BASE_ENV, REALM_KIT_PREVIEW_MANIFESTS: manifest }).REALM_KIT_PREVIEW_MANIFESTS).toBe(manifest);
    // One kit per realm under review (REALM-THEMES-PLAN §3 P0): the map takes several realms at once.
    const two = `${manifest}, frostveil=atlas/fantasy/layered-ground/${'b'.repeat(64)}/manifest.json`;
    expect(loadConfig({ ...BASE_ENV, REALM_KIT_PREVIEW_MANIFESTS: two }).REALM_KIT_PREVIEW_MANIFESTS).toBe(two);
    expect(loadConfig({ ...BASE_ENV, REALM_KIT_PREVIEW_MANIFESTS: '' }).REALM_KIT_PREVIEW_MANIFESTS).toBeUndefined();
    for (const bad of ['crownlands', 'atlantis=atlas/fantasy/layered-ground/' + 'a'.repeat(64) + '/manifest.json', 'crownlands=/etc/passwd', 'crownlands=atlas/fantasy/layered-ground/abc/manifest.json']) {
      expect(() => loadConfig({ ...BASE_ENV, REALM_KIT_PREVIEW_MANIFESTS: bad }), bad).toThrow(/REALM_KIT_PREVIEW_MANIFESTS/);
    }
  });
  it('FAILS BOOT in production — a production host learns kits only from the catalogue pin', () => {
    expect(() => loadConfig({ ...production, REALM_KIT_PREVIEW_MANIFESTS: manifest })).toThrow(/refused in production/);
  });
});

describe('EnvSchema — DEV_LOGIN_REALM (dev realm switch, REALM-THEMES-PLAN §3 P0)', () => {
  const production = { ...BASE_ENV, NODE_ENV: 'production',
    SOLANA_RPC_URL: 'https://devnet.helius-rpc.com/?api-key=test',
    TWOFA_ENCRYPTION_KEYS: 'test:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
    RESEND_API_KEY: 're_test', EMAIL_FROM: 'test@example.com' };
  // A host that reviews a realm may run the fantasy world (a fresh dev base is then seeded in
  // the realm) or not (a legacy base with no fantasy address presents the realm); only
  // DEV_LOGIN=true is required, because only that login is the switch's subject.
  const switched = { ...BASE_ENV, DEV_LOGIN: 'true', MULTI_BASE_ENABLED: 'true', FANTASY_WORLD_ENABLED: 'true' };
  it('accepts exactly a realm id, treats blank as unset, and FAILS BOOT on a misspelling', () => {
    expect(loadConfig({ ...switched, DEV_LOGIN_REALM: 'frostveil' }).DEV_LOGIN_REALM).toBe('frostveil');
    expect(loadConfig({ ...BASE_ENV, DEV_LOGIN_REALM: '' }).DEV_LOGIN_REALM).toBeUndefined();
    expect(loadConfig(BASE_ENV).DEV_LOGIN_REALM).toBeUndefined();
    // A typo must not quietly seat the dev base in Crownlands while the owner reviews another realm.
    for (const bad of ['Frostveil', 'frost', 'seeker reach', 'atlantis']) {
      expect(() => loadConfig({ ...switched, DEV_LOGIN_REALM: bad }), bad).toThrow(/DEV_LOGIN_REALM/);
    }
  });
  it('FAILS BOOT without FANTASY_WORLD_ENABLED=true and DEV_LOGIN=true — with no fantasy claim to present through, the dev base would silently show Crownlands', () => {
    // .env.example's defaults (FANTASY_WORLD_ENABLED=false) plus a realm: the case that once
    // booted and had the owner reviewing Frostveil while looking at Crownlands.
    // The fantasy world is NOT a prerequisite: the local review host runs without it and a
    // base with no fantasy address presents the switch realm (game/baseVisual.ts).
    expect(loadConfig({ ...switched, FANTASY_WORLD_ENABLED: 'false', MULTI_BASE_ENABLED: 'false', DEV_LOGIN_REALM: 'frostveil' }).DEV_LOGIN_REALM)
      .toBe('frostveil');
    expect(() => loadConfig({ ...switched, DEV_LOGIN: 'false', DEV_LOGIN_REALM: 'frostveil' }))
      .toThrow(/DEV_LOGIN_REALM requires DEV_LOGIN=true/);
    expect(() => loadConfig({ ...BASE_ENV, DEV_LOGIN_REALM: 'frostveil' })).toThrow(/DEV_LOGIN_REALM requires DEV_LOGIN=true/);
    // Unset, the flags are not required: today's behaviour is untouched.
    expect(() => loadConfig({ ...BASE_ENV, DEV_LOGIN_REALM: '' })).not.toThrow();
  });
  it('FAILS BOOT in production — the switch makes a base PRESENT a realm other than its persisted address, and a production host presents persisted addresses only', () => {
    // The switch never moves a claim (an assigned fantasy claim is immutable by trigger,
    // drizzle/0118 fantasy_claim_identity_guard; game/baseVisual.ts resolveBaseVisual only
    // changes what a dev-fixture base presents). What production is protected from is a
    // paid player's base — deed render, kit obstacles, raid contexts — showing a realm its
    // address does not say, so the env is a misconfiguration to fail on, not a value to ignore.
    expect(() => loadConfig({ ...production, DEV_LOGIN_REALM: 'frostveil' })).toThrow(/DEV_LOGIN_REALM is refused in production/);
  });
  it('the live reader carries the same double gate as /auth/dev-login — DEV_LOGIN=true and not production — so the boot refusal is not the only defence', () => {
    // devLoginRealm() reads the live env per call and every presentation reader
    // (game/baseVisual.ts resolveBaseVisual) trusts it directly, while the boot refusals above
    // are bypassed wherever a Config is built by hand (buildApp in tests, any future tool).
    // Without this gate a dev host with DEV_LOGIN=false and a stale DEV_LOGIN_REALM would
    // present every dev-fixture base in that realm, and .env.example's "REQUIRES DEV_LOGIN=true"
    // would be true only at boot.
    const on = { DEV_LOGIN: 'true', NODE_ENV: 'development', DEV_LOGIN_REALM: 'frostveil' };
    expect(devLoginRealm(on)).toBe('frostveil');
    expect(devLoginRealm({ ...on, DEV_LOGIN: 'false' })).toBeUndefined();
    expect(devLoginRealm({ ...on, DEV_LOGIN: undefined })).toBeUndefined();
    expect(devLoginRealm({ ...on, NODE_ENV: 'production' })).toBeUndefined();
    expect(devLoginRealm({ ...on, DEV_LOGIN_REALM: '' })).toBeUndefined();
    // Past the gate an unknown id throws (as at boot); off the gate the value is inert, not
    // validated — a host the switch does not apply to never fails a request over it.
    expect(() => devLoginRealm({ ...on, DEV_LOGIN_REALM: 'atlantis' })).toThrow(/unknown realm/);
    expect(devLoginRealm({ ...on, DEV_LOGIN: 'false', DEV_LOGIN_REALM: 'atlantis' })).toBeUndefined();
  });
});

describe('private production RPC configuration', () => {
  const production = { ...BASE_ENV, NODE_ENV: 'production',
    SOLANA_RPC_URL: 'https://devnet.helius-rpc.com/?api-key=test',
    TWOFA_ENCRYPTION_KEYS: 'test:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
    RESEND_API_KEY: 're_test', EMAIL_FROM: 'test@example.com' };
  it('requires an explicit primary and rejects shared public RPCs even on devnet', () => {
    expect(() => loadConfig({ ...production, SOLANA_RPC_URL: undefined })).toThrow(/private Solana RPC/);
    for (const host of ['api.devnet.solana.com', 'api.testnet.solana.com', 'api.mainnet-beta.solana.com', 'API.DEVNET.SOLANA.COM.']) {
      for (const key of ['SOLANA_RPC_URL', 'SOLANA_RPC_URL_2', 'MINT_EVIDENCE_RPC_URL']) {
        expect(() => loadConfig({ ...production, [key]: `https://${host}/?api-key=secret` })).toThrow(/private Solana RPC/);
      }
    }
  });
  it('keeps a mint override separate from general RPC and makes empty optional values unset', () => {
    const mint = 'https://archive.example/?api-key=test';
    const config = loadConfig({ ...production, MINT_EVIDENCE_RPC_URL: mint, RPC_RELAY_ENABLED: 'true' });
    expect(config.MINT_EVIDENCE_RPC_URL).toBe(mint);
    expect(config.SOLANA_RPC_URL).toBe(production.SOLANA_RPC_URL);
    expect(config.SOLANA_RPC_URL_2).toBeUndefined();
    expect(config.RPC_RELAY_ENABLED).toBe('true');
    expect(loadConfig({ ...production, MINT_EVIDENCE_RPC_URL: '' }).MINT_EVIDENCE_RPC_URL).toBeUndefined();
    expect(loadConfig(production).RPC_RELAY_ENABLED).toBe('false');
    expect(() => loadConfig({ ...production, RPC_RELAY_ENABLED: 'yes' })).toThrow(/RPC_RELAY_ENABLED/);
  });
  it('retains local defaults without making malformed provider URLs usable', () => {
    expect(loadConfig(BASE_ENV).SOLANA_RPC_URL).toBe('https://api.devnet.solana.com');
    expect(() => loadConfig({ ...BASE_ENV, MINT_EVIDENCE_RPC_URL: 'file:///secret' })).toThrow(/HTTP/);
  });
});


it('direct worker helpers never restore an implicit public production fallback', () => {
  for (const nodeEnv of [undefined, 'production', 'staging']) {
    expect(() => resolveSolanaRpcUrl(undefined, nodeEnv)).toThrow(/explicitly configured/);
    expect(() => resolveSolanaRpcUrl('https://api.devnet.solana.com', nodeEnv)).toThrow(/private Solana RPC/);
    expect(() => resolveSolanaRpcUrl('http://private.example/rpc', nodeEnv)).toThrow(/HTTPS/);
  }
  expect(resolveSolanaRpcUrl(undefined, 'test')).toBe('https://api.devnet.solana.com');
  expect(resolveSolanaRpcUrl('http://localhost:8899', 'test')).toBe('http://localhost:8899');
});

describe('EnvSchema — native presentation admission fails closed', () => {
  // WHY: the isolated companion always refused to enable without a tester list, but the
  // ordinary API silently admitted every alpha player when the list was left empty
  // (security review 2026-09-11, finding 1). Public admission must be an explicit switch.
  const WALLET = '11111111111111111111111111111111';

  it('refuses to boot when enabled with neither a tester list nor the OPEN switch', () => {
    expect(() => loadConfig({ ...BASE_ENV, NATIVE_PRESENTATION_ENABLED: 'true' })).toThrow(/tester list or NATIVE_PRESENTATION_OPEN/);
    expect(() => loadConfig({ ...BASE_ENV, NATIVE_PRESENTATION_ENABLED: 'true', NATIVE_PRESENTATION_WALLETS: '' })).toThrow();
  });

  it('boots with a tester list, or with the explicit OPEN switch, and stays dark by default', () => {
    expect(loadConfig({ ...BASE_ENV, NATIVE_PRESENTATION_ENABLED: 'true', NATIVE_PRESENTATION_WALLETS: WALLET }).NATIVE_PRESENTATION_WALLETS).toEqual([WALLET]);
    expect(loadConfig({ ...BASE_ENV, NATIVE_PRESENTATION_ENABLED: 'true', NATIVE_PRESENTATION_OPEN: 'true' }).NATIVE_PRESENTATION_OPEN).toBe('true');
    expect(loadConfig({ ...BASE_ENV }).NATIVE_PRESENTATION_ENABLED).toBeUndefined();
  });

  it('never lets the isolated companion open to the public', () => {
    const companion = { ...BASE_ENV, REDIS_URL: 'redis://localhost:6380', NATIVE_PRESENTATION_SERVICE: 'true',
      NATIVE_PRESENTATION_ENABLED: 'true', NATIVE_PRESENTATION_WALLETS: WALLET };
    expect(loadNativeServiceConfig(companion).NATIVE_PRESENTATION_WALLETS).toEqual([WALLET]);
    expect(() => loadNativeServiceConfig({ ...companion, NATIVE_PRESENTATION_OPEN: 'true' })).toThrow(/NATIVE_PRESENTATION_OPEN|never admits the public/);
  });
});

describe('EnvSchema — PHASE_E_CATALOG_ENABLED', () => {
  it('defaults dark in both boot config and the game-route reader', () => {
    expect(loadConfig({ ...BASE_ENV }).PHASE_E_CATALOG_ENABLED).toBe('false');
    expect(phaseECatalogEnabled({})).toBe(false);
  });

  it('accepts only explicit true and false and keeps the reader consistent', () => {
    for (const value of ['true', 'false'] as const) {
      expect(loadConfig({ ...BASE_ENV, PHASE_E_CATALOG_ENABLED: value }).PHASE_E_CATALOG_ENABLED).toBe(value);
      expect(phaseECatalogEnabled({ PHASE_E_CATALOG_ENABLED: value })).toBe(value === 'true');
    }
  });

  it('fails boot on misspellings and cannot accidentally open the reader', () => {
    for (const bad of ['', 'TRUE', 'FALSE', '1', '0', 'yes', 'on', 'true ']) {
      expect(() => loadConfig({ ...BASE_ENV, PHASE_E_CATALOG_ENABLED: bad }), bad)
        .toThrow(/PHASE_E_CATALOG_ENABLED/);
      expect(phaseECatalogEnabled({ PHASE_E_CATALOG_ENABLED: bad }), bad).toBe(false);
    }
  });
});

describe.each([
  { flag: 'PHASE_E_VEHICLES_ENABLED', parents: ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED'] },
  { flag: 'PHASE_E_CHARTER_ENABLED', parents: ['MULTI_BASE_ENABLED'] },
  { flag: 'KEEP_EQUIPMENT_MARKET_ENABLED', parents: ['MULTI_BASE_ENABLED'] },
] as const)('EnvSchema — $flag', ({ flag, parents }) => {
  const admitted = Object.fromEntries(parents.map(parent => [parent, 'true']));

  it('declares a false startup default instead of silently stripping an implemented family', () => {
    expect(loadConfig({ ...BASE_ENV })[flag]).toBe('false');
  });

  it('accepts explicit false without requiring its gameplay parents', () => {
    expect(loadConfig({ ...BASE_ENV, [flag]: 'false' })[flag]).toBe('false');
  });

  it('accepts explicit true only with the existing gameplay prerequisites', () => {
    expect(loadConfig({ ...BASE_ENV, ...admitted, [flag]: 'true' })[flag]).toBe('true');
  });

  it.each(['', 'TRUE', 'FALSE', '1', '0', 'yes', 'on', 'true '])('rejects malformed startup value %j instead of silently ignoring it', value => {
    expect(() => loadConfig({ ...BASE_ENV, ...admitted, [flag]: value })).toThrow(flag);
  });

  for (const parent of parents) {
    it.each([undefined, 'false'])('rejects enabled admission when ' + parent + ' is %j', value => {
      expect(() => loadConfig({ ...BASE_ENV, ...admitted, [flag]: 'true', [parent]: value }))
        .toThrow(`${flag}=true requires`);
    });
  }
});
