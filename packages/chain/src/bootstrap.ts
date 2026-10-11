/**
 * Legacy devnet economy bootstrap (PLAN.md Phase 3, GDD §4.2 / §7 Phase 0).
 * Idempotent: every step checks on-chain/disk state before acting, so the
 * script can be re-run after any partial failure.
 *
 * Steps: KEEP mint → §4.2 allocation buckets → revoke mint+freeze authority →
 * SOL treasury wallets → initialize on-chain Config → write addresses file.
 * The pay_entry smoke test and Metaplex Core deed collection are separate
 * opt-in steps. The current branded devnet mint is managed by token:mint; do
 * not infer its live supply or authorities from this legacy allocation path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// Destructure from the runtime object: anchor 0.32 is CJS and Node's ESM named-export
// detection misses the BN re-export (runtime SyntaxError with a named import), while
// a bare default import is undefined under tsx's CJS transform. See anchorRuntime.ts.
import { anchorRuntime } from './anchorRuntime';
const { BN } = anchorRuntime;
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  AuthorityType,
  createMint,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  setAuthority,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { CAPS, ECONOMY, TOKEN } from '@shardkeep/shared';
import { configPda, coreProgram, makeProvider, playerPda } from './programs';

export interface BootstrapPaths {
  /** Repo root — keys go to infra/keys, addresses to infra/devnet.addresses.json. */
  root: string;
}

export type GameSolanaCluster = 'devnet' | 'mainnet-beta';

/** Exact reviewed state of one BPF Upgradeable Loader deployment. The hash is
 * SHA-256 over the complete ProgramData account `data` bytes returned by RPC,
 * including loader metadata and the deployed ELF. `null` means the program is
 * intentionally immutable; otherwise only the exact listed authority is
 * accepted. */
export interface ReviewedProgramDeployment {
  programDataAddress: string;
  programDataSha256: string;
  upgradeAuthority: string | null;
}

export interface ChainAddresses {
  cluster: GameSolanaCluster;
  coreProgram: string;
  /** Optional one-time claim program. Gameplay and custody never depend on it. */
  distributorProgram?: string;
  keepMint: string;
  /** Separate Phase E mint account, absent until its public ceremony evidence.
   * Never an alias for the legacy mint or the KEEP-MINT authority. */
  keepMintV4?: string;
  /** Manifest M-24: one cluster-specific SKR identity. Both keys or neither;
   * consumers must still prove classic Token ownership and these decimals at finalized. */
  skrMint?: string;
  skrDecimals?: number;
  /** Reviewed mainnet manifest policy. Each authority is either the exact key
   * intentionally retained or null when irrevocably revoked. Devnet may omit
   * this while the closed-alpha mint keeps its current authorities. */
  keepMintAuthorities?: {
    mintAuthority: string | null;
    freezeAuthority: string | null;
  };
  /** Required by mainnet attestation. Devnet deliberately remains outside this
   * release-manifest gate so ordinary closed-alpha upgrades are unaffected. */
  programDeployments?: {
    core: ReviewedProgramDeployment;
    distributor?: ReviewedProgramDeployment;
  };
  treasuries: { liquidity: string; dev: string; ops: string };
  config: string;
  merkleTree?: string;
  /** Land Deed Core collection (Phase 6) — written by scripts deed:collection. */
  deedCollection?: string;
  /** Current branded mint, written by scripts token:mint — NOT by this bootstrap. */
  keepMintBranded?: string;
  updatedAt: string;
}

/** Backward-compatible name for devnet-only operations and tests. */
export type DevnetAddresses = ChainAddresses;

/** Public-only preparation, not chain attestation or permission to activate.
 * D153.331 / review 5dd99ced and f3619833: no Gems reserve or purchase sink
 * belongs in mining recovery trust. MS-S owns serving/immutable-row checks. */
export interface PhaseEKeepV4Identity {
  keepMintV4: string;
  reserveOwner: string;
  reserveAta: string;
  operator: string;
}

// Public role bindings accepted by review 68d06fbe/70ccd9ad. No key access.
const phaseEReserveOwner = 'CVKo5i8ax2kiKe9nSB4LfCpBEbyfaLcq8S8bWXsvKo1Q';
const phaseEOperator = 'AvsebCwRDs63UMwKv2xSVCRKB8cxUS4W3B4sNR9SHpKv';
const phaseENonMintRoles = new Set([
  phaseEReserveOwner, phaseEOperator,
  'A3MRaRRDw6qJfYu8Z8xZfHcSWNEZuMc91nQ2cCurQXEP', // KEEP-MINT authority
  '9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q', // TREASURY
  'Ce5HrbPJ2naKQAbQ6Xga55WeFwVDavHhBzc2AsWd6KY8', // UA-E
  '5cYNJabvsfTUAZBK31yp6ZknKiv9dRdJoBKjggWpDWLV', // UA-C
  'GV1DHT162yYFfFeZh7yXcPyCYamMj7bmDa77tNTupMXb', // retired role; no v4 allocation
  'AKssxaa5uy51qRirVcTWjoVxnjufvS9Fzw3HCDNCpfhm', // FAUCET-FUNDER
  '5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC', // protected legacy mint, regardless of registry
  SystemProgram.programId.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
]);

function containsRegistryValue(value: unknown, address: string): boolean {
  if (value === address) return true;
  return value !== null && typeof value === 'object'
    && Object.values(value).some((entry) => containsRegistryValue(entry, address));
}

function validateKeepMintV4(addresses: Partial<ChainAddresses>): string {
  const value = addresses.keepMintV4;
  try {
    if (typeof value !== 'string' || new PublicKey(value).toBase58() !== value) throw new Error();
  } catch {
    throw new Error('keepMintV4 must be a canonical base58 public mint account');
  }
  if (phaseENonMintRoles.has(value)) {
    throw new Error('keepMintV4 must not be a role, mint authority, legacy mint or known program address');
  }
  const { keepMintV4: _mint, ...otherRegistryFields } = addresses;
  if (containsRegistryValue(otherRegistryFields, value)) {
    throw new Error('keepMintV4 must be distinct from every other registry key');
  }
  return value;
}

function refuseObsoleteGemsReserve(value: unknown, surface: 'registry' | 'env'): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    // Registry identities are strict at every depth. Env keeps legacy uppercase
    // GEMS_RESERVE_* config intact; direct obsolete identity fields still refuse.
    if ((/gems[\W_]*reserve/i.test(key) && (surface === 'registry' || key.startsWith('PHASE_E_')))
      || ['gemsReserveOwner', 'gemsReserveAta', 'gems_reserve_owner', 'gems_reserve_ata'].includes(key)) {
      throw new Error(`obsolete gems-reserve identity field: ${key}`);
    }
    refuseObsoleteGemsReserve(entry, surface);
  }
}

/** Resolve explicit public preparation inputs without reading environment,
 * keys, RPC or database state. Disabled means no Phase E identity, not v3.
 * Caller must additionally verify deployment/mint evidence and the immutable
 * Phase E row before any runtime is admitted; this helper enables nothing. */
export function resolvePhaseEKeepV4Identity(
  addresses: ChainAddresses | null,
  env: Readonly<Record<string, string | undefined>>,
  operator: string | undefined,
): PhaseEKeepV4Identity | null {
  const selector = env.PHASE_E_KEEP_IDENTITY ?? 'disabled';
  if (selector === 'disabled') return null;
  if (selector !== 'keep-v4') throw new Error('PHASE_E_KEEP_IDENTITY must be disabled or keep-v4');
  refuseObsoleteGemsReserve(env, 'env');
  if (env.SOLANA_CLUSTER !== 'devnet') throw new Error('keep-v4 requires SOLANA_CLUSTER=devnet');
  if (!addresses) throw new Error('keep-v4 requires the public address registry');
  refuseObsoleteGemsReserve(addresses, 'registry');
  if (addresses.cluster !== 'devnet') throw new Error('keep-v4 requires the devnet registry');
  const keepMintV4 = validateKeepMintV4(addresses);
  if (env.PHASE_E_KEEP_RESERVE_OWNER !== phaseEReserveOwner) {
    throw new Error('PHASE_E_KEEP_RESERVE_OWNER must equal the reviewed RESERVE owner');
  }
  if (operator !== phaseEOperator) throw new Error('keep-v4 requires the reviewed operator public key');
  return {
    keepMintV4,
    reserveOwner: phaseEReserveOwner,
    reserveAta: getAssociatedTokenAddressSync(new PublicKey(keepMintV4), new PublicKey(phaseEReserveOwner)).toBase58(),
    operator,
  };
}

/** Retired allocation-bootstrap output. Current infra addresses intentionally
 * omit these buckets because they belong to the superseded unbranded mint. */
export interface LegacyBootstrapAddresses extends ChainAddresses {
  buckets: Record<keyof typeof TOKEN.allocation, { owner: string; ata: string; amount: number }>;
}

const log = (msg: string): void => console.log(`[bootstrap] ${msg}`);

/** The retired allocation's fifth owner was created under the historical
 * `questBucket` filename. Current terminology calls that unused target slice
 * `unallocated`, but a legacy rerun must reuse the same key rather than minting
 * another 50M KEEP to a newly generated owner. */
export function legacyBootstrapBucketKey(
  name: keyof typeof TOKEN.allocation,
): string {
  return name === 'unallocated' ? 'questBucket' : name;
}

function loadOrCreateKeypair(path: string): Keypair {
  if (existsSync(path)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  }
  const kp = Keypair.generate();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  log(`created keypair ${path} -> ${kp.publicKey.toBase58()}`);
  return kp;
}

export function addressesFileName(cluster: GameSolanaCluster): string {
  return cluster === 'mainnet-beta' ? 'mainnet.addresses.json' : 'devnet.addresses.json';
}

/** Load the public address registry for exactly one economy cluster. A missing
 * mainnet registry is an honest not-configured state; a mislabeled file is a
 * fatal configuration error rather than permission to cross clusters. */
export function loadAddresses(
  root: string,
  cluster: GameSolanaCluster = 'devnet',
): ChainAddresses | null {
  const p = join(root, 'infra', addressesFileName(cluster));
  if (!existsSync(p)) return null;
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<ChainAddresses>;
  if (parsed.cluster !== cluster) {
    throw new Error(`address registry ${p} declares ${String(parsed.cluster)}, expected ${cluster}`);
  }
  const required = [
    parsed.coreProgram, parsed.keepMint,
    parsed.config, parsed.treasuries?.liquidity, parsed.treasuries?.dev, parsed.treasuries?.ops,
  ];
  if (required.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error(`address registry ${p} is missing a required public address`);
  }
  for (const value of required) new PublicKey(value!);
  if (parsed.distributorProgram) new PublicKey(parsed.distributorProgram);
  if (parsed.deedCollection) new PublicKey(parsed.deedCollection);
  if ('keepMintV4' in parsed) validateKeepMintV4(parsed);
  if ((parsed.skrMint !== undefined) !== (parsed.skrDecimals !== undefined)) {
    throw new Error(`address registry ${p} requires skrMint and skrDecimals together`);
  }
  if (parsed.skrMint !== undefined) {
    if (typeof parsed.skrMint !== 'string' || !parsed.skrMint
        || !Number.isSafeInteger(parsed.skrDecimals) || parsed.skrDecimals! < 0 || parsed.skrDecimals! > 19) {
      throw new Error(`address registry ${p} has an invalid SKR identity`);
    }
    if (new PublicKey(parsed.skrMint).toBase58() !== parsed.skrMint) {
      throw new Error(`address registry ${p} has a noncanonical SKR mint`);
    }
  }
  return parsed as ChainAddresses;
}

export async function runBootstrap(opts: {
  connection: Connection;
  admin: Keypair;
  paths: BootstrapPaths;
  /** ISO timestamp injected by the caller (kept out of the library for testability). */
  now: string;
}): Promise<LegacyBootstrapAddresses> {
  const { connection, admin, paths } = opts;
  const keysDir = join(paths.root, 'infra', 'keys');
  const addressesPath = join(paths.root, 'infra', 'devnet.addresses.json');
  const prior = loadAddresses(paths.root);

  // --- 1) KEEP mint -------------------------------------------------------
  // SAFETY (security review 2026-07-28, finding #1): this bootstrap owns the
  // ORIGINAL unbranded mint keypair. Once a BRANDED mint exists (token:mint),
  // re-running bootstrap — a documented step of the deploy runbook — would
  // repoint custody at the orphaned original: the api derives the hot-wallet
  // ATA, the deposit verifier and the PoR reserve from addresses.keepMint, so
  // reserves would read a near-empty account against live liability. Refuse.
  const brandedPrior = prior?.keepMintBranded;
  if (brandedPrior) {
    throw new Error(
      `legacy bootstrap refuses to run after token:mint established branded KEEP mint ${brandedPrior}; ` +
      'use the current token/deployment runbook instead.',
    );
  }
  const mintKp = loadOrCreateKeypair(join(keysDir, 'keep-mint.keypair.json'));
  const mintInfo = await connection.getAccountInfo(mintKp.publicKey);
  if (!mintInfo) {
    await createMint(connection, admin, admin.publicKey, admin.publicKey, TOKEN.decimals, mintKp);
    log(`KEEP mint created: ${mintKp.publicKey.toBase58()}`);
  } else {
    log(`KEEP mint exists: ${mintKp.publicKey.toBase58()}`);
  }

  // --- 2) Allocation buckets (GDD §4.2) ------------------------------------
  const buckets = {} as LegacyBootstrapAddresses['buckets'];
  const unit = 10n ** BigInt(TOKEN.decimals);
  for (const [name, amount] of Object.entries(TOKEN.allocation) as Array<
    [keyof typeof TOKEN.allocation, number]
  >) {
    const owner = loadOrCreateKeypair(
      join(keysDir, `bucket-${legacyBootstrapBucketKey(name)}.keypair.json`),
    );
    const ata = await getOrCreateAssociatedTokenAccount(connection, admin, mintKp.publicKey, owner.publicKey);
    if (ata.amount === 0n) {
      await mintTo(connection, admin, mintKp.publicKey, ata.address, admin, BigInt(amount) * unit);
      log(`minted ${amount.toLocaleString()} KEEP -> ${name}`);
    } else {
      log(`${name} already funded (${ata.amount / unit} KEEP)`);
    }
    buckets[name] = { owner: owner.publicKey.toBase58(), ata: ata.address.toBase58(), amount };
  }

  // --- 3) Fixed supply: revoke mint + freeze authority ----------------------
  const mint = await getMint(connection, mintKp.publicKey);
  const supply = mint.supply / unit;
  if (supply !== BigInt(TOKEN.totalSupply)) {
    throw new Error(`supply mismatch: ${supply} != ${TOKEN.totalSupply} — refusing to revoke`);
  }
  if (mint.mintAuthority) {
    await setAuthority(connection, admin, mintKp.publicKey, admin, AuthorityType.MintTokens, null);
    log('mint authority revoked — supply fixed at 1,000,000,000');
  }
  if (mint.freezeAuthority) {
    await setAuthority(connection, admin, mintKp.publicKey, admin, AuthorityType.FreezeAccount, null);
    log('freeze authority revoked');
  }

  // --- 4) SOL treasuries (GDD §4.6 split destinations) ----------------------
  const liquidity = loadOrCreateKeypair(join(keysDir, 'treasury-liquidity.keypair.json'));
  const dev = loadOrCreateKeypair(join(keysDir, 'treasury-dev.keypair.json'));
  const ops = loadOrCreateKeypair(join(keysDir, 'treasury-ops.keypair.json'));

  // --- 5) Initialize on-chain Config ----------------------------------------
  const provider = makeProvider(connection, admin);
  const core = coreProgram(provider);
  const cfgAddr = configPda();
  const cfgInfo = await connection.getAccountInfo(cfgAddr);
  if (!cfgInfo) {
    await core.methods['initialize']!({
        keepMint: mintKp.publicKey,
        treasuryLiquidity: liquidity.publicKey,
        treasuryDev: dev.publicKey,
        treasuryOps: ops.publicKey,
        splits: [ECONOMY.solSplitBps.liquidity, ECONOMY.solSplitBps.dev, ECONOMY.solSplitBps.ops],
        prices: {
          entryLamports: new BN(Math.round(ECONOMY.entryFeeSol * LAMPORTS_PER_SOL)),
          builderLamports: [
            new BN(CAPS.builderPricesSol[0] * LAMPORTS_PER_SOL),
            new BN(CAPS.builderPricesSol[1] * LAMPORTS_PER_SOL),
          ],
          expansionLamports: new BN(Math.round(CAPS.expansionPriceSol * LAMPORTS_PER_SOL)),
        },
      })
      .accounts({ admin: admin.publicKey })
      .rpc();
    log(`Config initialized at ${cfgAddr.toBase58()}`);
  } else {
    log(`Config exists at ${cfgAddr.toBase58()}`);
  }

  // --- 6) Addresses file -----------------------------------------------------
  const addresses: LegacyBootstrapAddresses = {
    // Spread PRIOR first so keys this bootstrap does not own (deedCollection,
    // the branded-mint chain, future additions) survive a re-run instead of
    // being silently dropped (security review 2026-07-28, finding #1).
    ...(prior ?? {}),
    cluster: 'devnet',
    coreProgram: core.programId.toBase58(),
    distributorProgram: prior?.distributorProgram ?? '6Tgc32nfuEDwvVQii47eLKZXeu39evzG5142UheuxpKU',
    keepMint: mintKp.publicKey.toBase58(),
    buckets,
    treasuries: {
      liquidity: liquidity.publicKey.toBase58(),
      dev: dev.publicKey.toBase58(),
      ops: ops.publicKey.toBase58(),
    },
    config: cfgAddr.toBase58(),
    ...(prior?.merkleTree ? { merkleTree: prior.merkleTree } : {}),
    updatedAt: opts.now,
  };
  writeFileSync(addressesPath, JSON.stringify(addresses, null, 2) + '\n');
  log(`addresses written -> ${addressesPath}`);
  return addresses;
}

/** pay_entry smoke test from a throwaway wallet; asserts the exact 40/35/25 split. */
export async function smokeTestPayEntry(opts: {
  connection: Connection;
  admin: Keypair;
  addresses: DevnetAddresses;
}): Promise<void> {
  const { connection, admin, addresses } = opts;
  const player = Keypair.generate();
  const reference = Keypair.generate().publicKey;

  // fund the throwaway from admin: entry fee + fees/rent headroom
  const fund = Math.round(ECONOMY.entryFeeSol * LAMPORTS_PER_SOL) + 50_000_000;
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: player.publicKey, lamports: fund }),
    ),
    [admin],
  );

  const before = await Promise.all(
    [addresses.treasuries.liquidity, addresses.treasuries.dev, addresses.treasuries.ops].map((a) =>
      connection.getBalance(new PublicKey(a)),
    ),
  );

  const provider = makeProvider(connection, player);
  const core = coreProgram(provider);
  await core.methods['payEntry']!()
    .accounts({
      playerWallet: player.publicKey,
      treasuryLiquidity: new PublicKey(addresses.treasuries.liquidity),
      treasuryDev: new PublicKey(addresses.treasuries.dev),
      treasuryOps: new PublicKey(addresses.treasuries.ops),
      reference,
    })
    .rpc();

  const after = await Promise.all(
    [addresses.treasuries.liquidity, addresses.treasuries.dev, addresses.treasuries.ops].map((a) =>
      connection.getBalance(new PublicKey(a)),
    ),
  );
  const deltas = after.map((v, i) => v - (before[i] ?? 0));
  const entry = Math.round(ECONOMY.entryFeeSol * LAMPORTS_PER_SOL);
  const want = [
    Math.floor((entry * ECONOMY.solSplitBps.liquidity) / 10_000),
    Math.floor((entry * ECONOMY.solSplitBps.dev) / 10_000),
    Math.floor((entry * ECONOMY.solSplitBps.ops) / 10_000),
  ];
  // remainder dust (if any) goes to the liquidity leg
  want[0]! += entry - (want[0]! + want[1]! + want[2]!);

  if (deltas[0] !== want[0] || deltas[1] !== want[1] || deltas[2] !== want[2]) {
    throw new Error(`split mismatch: got ${deltas.join('/')}, want ${want.join('/')}`);
  }
  const playerAcc = await connection.getAccountInfo(playerPda(player.publicKey));
  if (!playerAcc) throw new Error('Player PDA was not created');
  log(`smoke test OK — splits ${deltas.join('/')} lamports, Player PDA ${playerPda(player.publicKey).toBase58()}`);
}
