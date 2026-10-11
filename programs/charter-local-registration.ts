/** Actual local Core mint + economy kind5 registration, never an admission issuer.
 * All signers/permits/ALT accounts are generated in an owned disposable genesis.
 * This fixture supplies no backend settlement readiness or public authority.
 */
// Same identity miningProgramProtocol.ts exports (this IDL's address). That module default-imports
// @coral-xyz/anchor, which tsx cannot initialize from this CommonJS package (CI run 37503885236).
import economyIdl from '../packages/chain/src/idl/shardkeep_economy.json' with { type: 'json' };
import { VEHICLE_CRAFT_PROGRAM } from '../packages/chain/src/vehicleIssuanceProtocol';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import * as anchor from '@coral-xyz/anchor';
import { AddressLookupTableProgram, ComputeBudgetProgram, Ed25519Program, Keypair, PublicKey,
  SYSVAR_CLOCK_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { PHASE_E_SEEKER_AUCTION } from '../packages/shared/src/constants';
import { charterAssetPda, charterClanIdBytes, charterConfigPda, charterCreationPda, charterExecutorPda,
  charterFreezePda, charterMintPda, charterPda, encodeCharterRegistrationPermit,
  hashCharterMetadata, hashCharterRegistrationPayload } from '../packages/chain/src/charterProtocol';
import { seekerAuthorityPda, seekerPermitReceiptPda } from '../packages/chain/src/seekerAuctionProtocol';
import { withCharterValidator, type CharterFixtureInput, type CharterConstructedGenesis, type ExpectedError } from './charter-local-fixture';
import { verifyCharterAuthority } from './charter-local-authority';
import type { ShardkeepCraft } from './target/types/shardkeep_craft';
import type { ShardkeepEconomy } from './target/types/shardkeep_economy';
import type { SeekerCpiProbe } from './target/types/seeker_cpi_probe';

const programs = dirname(resolve(process.argv[1]!)), root = resolve(programs, '..');
const CRAFT = new PublicKey(VEHICLE_CRAFT_PROGRAM);
const MINING_PROGRAM_ADDRESS = economyIdl.address;
const ECONOMY = new PublicKey(MINING_PROGRAM_ADDRESS);
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const PROBE = new PublicKey('GGRZUzCunNTqAkny7sLZW6ZkCcj918nDJuzt7SQUYNbK');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const CORE_SHA = '69be69672220f4b5b0813e53cc4e2f3042dcac991f088b174bc7907dab4b2dee';
const CLAN = '12345678-1234-5678-9abc-def012345678', INTENT = '87654321-4321-4321-8abc-def012345678';
const NAME = 'Fixture Charter', URI = 'https://invalid.example/charter.json';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const pda = (seed: string, program: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(seed)], program)[0];
function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
const RETENTION_CASES = ['constructed elapsed receipt preserves original records', 'actual generic permit receipt closes',
  'closed generic receipt cannot release permanent creation intent', 'fresh intent succeeds under preserved policy domain'] as const;
const CASES = ['initial immutable configuration', 'economy paused', 'craft paused', 'wrong policy signer', 'wrong permit purpose',
  'changed signed metadata', 'changed admission commitment', 'changed leader', 'wrong own executable', 'CPI forwarding refuses', 'CPI catch refuses',
  'Core failure rolls back mint and all records', 'actual atomic frozen mint and registration', 'permanent receipt recovers lost acknowledgement',
  'same registration cannot mint again', 'intent cannot be reused for another clan', 'clan cannot acquire a second asset',
  'paused historical records remain original', 'direct craft lacks the executor signature', 'foreign signed executor is refused',
  'substituted craft program is refused', 'substituted control is refused', 'substituted asset is refused', 'missing leader signature is refused',
  'remaining registration accounts are refused', 'later failure rolls back a successful Core mint', 'second distinct clan increments collection once',
  'former craft upgrade authority loses pause capability', 'new craft upgrade authority controls pause'] as const;

async function main() {
  const names = ['core-binary', 'craft-binary', 'craft-idl', 'economy-binary', 'economy-idl', 'probe-binary', 'probe-idl', 'verifier'];
  const args = process.argv.slice(2);
  check(args.length === names.length * 2 && names.every((name, i) => args[i * 2] === '--' + name), 'Expected explicit Core/craft/economy/probe binary+IDL paths and host verifier');
  const paths = Object.fromEntries(names.map((name, i) => [name, args[i * 2 + 1]!])) as Record<string, string>;
  for (const path of Object.values(paths)) check(isAbsolute(path) && (await lstat(path)).isFile(), 'Expected absolute regular artifact: ' + path);
  const coreBinary = await readFile(paths['core-binary']!), craftBinary = await readFile(paths['craft-binary']!);
  const economyBinary = await readFile(paths['economy-binary']!), probeBinary = await readFile(paths['probe-binary']!);
  check(coreBinary.length === 809696 && hash(coreBinary) === CORE_SHA, 'Wrong reviewed Core executable');
  for (const bytes of [coreBinary, craftBinary, economyBinary, probeBinary]) check(bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])), 'Expected compiled ELF');
  const craftIdlBytes = await readFile(paths['craft-idl']!), economyIdlBytes = await readFile(paths['economy-idl']!), probeIdlBytes = await readFile(paths['probe-idl']!);
  const craftIdl = JSON.parse(craftIdlBytes.toString('utf8')) as ShardkeepCraft;
  const economyIdl = JSON.parse(economyIdlBytes.toString('utf8')) as ShardkeepEconomy;
  const probeIdl = JSON.parse(probeIdlBytes.toString('utf8')) as SeekerCpiProbe;
  check(craftIdl.address === CRAFT.toBase58() && economyIdl.address === ECONOMY.toBase58() && probeIdl.address === PROBE.toBase58(), 'Wrong fixture artifact identity');
  const version = spawnSync('solana-test-validator', ['--version'], { encoding: 'utf8', timeout: 10000 });
  check(!version.error && version.status === 0 && /solana-test-validator 2\.3\.13(?:\s|\(|$)/.test(version.stdout), 'Require pinned validator2.3.13');
  const coreSdkVersion: unknown = JSON.parse(await readFile(join(root, 'packages/chain/node_modules/@metaplex-foundation/mpl-core/package.json'), 'utf8')).version;
  const umiVersion: unknown = JSON.parse(await readFile(join(root, 'packages/chain/node_modules/@metaplex-foundation/umi/package.json'), 'utf8')).version;
  check(coreSdkVersion === '1.10.0' && umiVersion === '1.5.1', 'Re-review the pinned SDK versions');
  const input: CharterFixtureInput = { corePath: paths['core-binary']!, craftPath: paths['craft-binary']!, coreBinary, craftBinary, craft: CRAFT,
    additionalPrograms: [{ id: ECONOMY, path: paths['economy-binary']!, binary: economyBinary }, { id: PROBE, path: paths['probe-binary']!, binary: probeBinary }],
    idlSha256: hash(Buffer.concat([craftIdlBytes, economyIdlBytes, probeIdlBytes])), validatorVersion: version.stdout.trim(), coreSdkVersion, umiVersion,
    scope: 'Actual local policy-authorized atomic Charter mint/registration; no backend admission issuer or public deployment authority' };
  let authorityOutcomes: string[] = [];
  const retained: { value?: { seed: CharterConstructedGenesis; policy: Keypair; permitId: Buffer; audit: object } } = {};
  const outcomes = await withCharterValidator(input, 'registration', async fixture => {
    const { connection, payer, stranger: leader, working, execute, executeInstructions, snapshots, record, rotateCraftUpgradeAuthority, coreAuthority } = fixture;
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: 'confirmed', preflightCommitment: 'confirmed' });
    const craft = new anchor.Program<ShardkeepCraft>(craftIdl, provider), economy = new anchor.Program<ShardkeepEconomy>(economyIdl, provider);
    const probe = new anchor.Program<SeekerCpiProbe>(probeIdl, provider), policy = Keypair.generate();
    const craftControl = pda('charter_control', CRAFT), collection = pda('charter_collection', CRAFT), collectionAuthority = pda('charter_collection_authority', CRAFT);
    const authority = seekerAuthorityPda(ECONOMY), config = charterConfigPda(ECONOMY);
    const craftProgramData = PublicKey.findProgramAddressSync([CRAFT.toBuffer()], LOADER)[0], economyProgramData = PublicKey.findProgramAddressSync([ECONOMY.toBuffer()], LOADER)[0];
    const genesisHash = new PublicKey(await connection.getGenesisHash());
    const clock = async () => {
      const actual = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
      check(actual?.data.length === 40, 'Missing actual Clock sysvar'); return actual.data.readBigInt64LE(32);
    };
    await execute('bootstrap-craft', await craft.methods.initializeCharterCollection('Charters', 'https://invalid.example/charters.json').accountsStrict({
      admin: payer.publicKey, program: CRAFT, programData: craftProgramData, config: craftControl, collection, collectionAuthority, mplCoreProgram: CORE, systemProgram: SystemProgram.programId }).instruction());
    await execute('initialize-real-policy-authority', await economy.methods.initializeSeekerAuthority(payer.publicKey, policy.publicKey, Array.from(genesisHash.toBytes())).accountsStrict({
      admin: payer.publicKey, program: ECONOMY, programData: economyProgramData, authority, systemProgram: SystemProgram.programId }).instruction());
    await execute('initialize-charter-config', await economy.methods.initializeCharterConfig().accountsStrict({ admin: payer.publicKey, program: ECONOMY,
      programData: economyProgramData, authority, config, craftProgram: CRAFT, craftControl, collection, collectionAuthority, systemProgram: SystemProgram.programId }).instruction());
    const immutableConfig = await economy.account.charterConfig.fetch(config);
    check(immutableConfig.version === 1 && immutableConfig.authority.equals(authority) && immutableConfig.craftProgram.equals(CRAFT)
      && immutableConfig.craftControl.equals(craftControl) && immutableConfig.collection.equals(collection)
      && immutableConfig.collectionAuthority.equals(collectionAuthority), 'Wrong immutable original Charter configuration');
    record('initial immutable configuration');
    const pauseEconomy = (paused: boolean) => economy.methods.setAdmissionPaused(paused).accountsStrict({ signer: payer.publicKey, authority }).instruction();
    const pauseCraft = (paused: boolean) => craft.methods.setCharterAdmissionPaused(paused).accountsStrict({ admin: payer.publicKey,
      program: CRAFT, programData: craftProgramData, config: craftControl }).instruction();
    const error = (name: string, owner: typeof economy | typeof craft = economy): ExpectedError => {
      const found = owner.rawIdl.errors?.find(item => item.name === name); check(found, 'Missing exact IDL error ' + name);
      return { program: owner.programId, code: found.code, anchorName: name };
    };
    const permitId = randomBytes(16), expiry = await clock() + BigInt(PHASE_E_SEEKER_AUCTION.issuedPolicyPermitTtlSec);
    const admissionCommitment = Buffer.alloc(32, 19); // Explicit local policy fact, never backend readiness evidence.
    function addresses(clanId = CLAN, creationIntentId = INTENT, id: Uint8Array = permitId) {
      const asset = charterMintPda(CRAFT, clanId);
      return { leader: leader.publicKey, authority, config, charter: charterPda(ECONOMY, clanId), assetBinding: charterAssetPda(ECONOMY, asset),
        creationReceipt: charterCreationPda(ECONOMY, creationIntentId), receipt: seekerPermitReceiptPda(ECONOMY, id), executor: charterExecutorPda(ECONOMY, clanId),
        craftProgram: CRAFT, craftControl, asset, collection, collectionAuthority, freezeAuthority: charterFreezePda(CRAFT, clanId),
        mplCoreProgram: CORE, instructions: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId, economyProgram: ECONOMY };
    }
    const original = addresses();
    const payload = (a: ReturnType<typeof addresses>, clanId: string, creationIntentId: string) => hashCharterRegistrationPayload({
      config, craftProgram: CRAFT, craftControl, collection, collectionAuthority, charter: a.charter, asset: a.asset,
      assetBinding: a.assetBinding, freezeAuthority: a.freezeAuthority, executor: a.executor, creationReceipt: a.creationReceipt,
      clanId, leader: a.leader, creationIntentId, metadataHash: hashCharterMetadata({ name: NAME, uri: URI }), admissionCommitment });
    async function attempt(options: { clanId?: string; intent?: string; id?: Buffer; nativeIndex?: number; purpose?: number; signer?: Keypair;
      name?: string; commitment?: Buffer; leader?: PublicKey; economyProgram?: PublicKey; actor?: Keypair;
      accounts?: Partial<ReturnType<typeof addresses>> } = {}) {
      const clanId = options.clanId ?? CLAN, intent = options.intent ?? INTENT, id = options.id ?? permitId;
      const actor = options.actor ?? leader, a = { ...addresses(clanId, intent, id), leader: actor.publicKey };
      const message = encodeCharterRegistrationPermit({ genesisHash, programId: ECONOMY, kind: 5, permitId: id, wallet: a.leader, expiry, payloadHash: payload(a, clanId, intent) });
      if (options.purpose !== undefined) message[72] = options.purpose; // Correct signature over the deliberately wrong purpose.
      const native = Ed25519Program.createInstructionWithPrivateKey({ privateKey: (options.signer ?? policy).secretKey, message });
      const ix = await economy.methods.registerCharter(Array.from(charterClanIdBytes(clanId)), Array.from(charterClanIdBytes(intent)),
        Array.from(options.commitment ?? admissionCommitment), options.name ?? NAME, URI,
        { permitId: Array.from(id), expiry: new anchor.BN(expiry.toString()), ed25519Instruction: options.nativeIndex ?? 1 })
        .accountsStrict({ ...a, leader: options.leader ?? a.leader, economyProgram: options.economyProgram ?? ECONOMY, ...options.accounts }).instruction();
      return { a, actor, native, ix, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), native, ix] };
    }
    // Real immutable lookup table, observed after freeze; no injected ALT bytes.
    const lookupKeys = [...Object.values(original), ECONOMY, PROBE].filter((key, i, all) => all.findIndex(item => item.equals(key)) === i)
      .sort((a, b) => a.toBase58().localeCompare(b.toBase58()));
    const [create, lookup] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: await connection.getSlot('finalized') });
    await execute('create-real-lookup-table', create);
    await execute('extend-real-lookup-table', AddressLookupTableProgram.extendLookupTable({ lookupTable: lookup, authority: payer.publicKey, payer: payer.publicKey, addresses: lookupKeys }));
    const frozen = await execute('freeze-real-lookup-table', AddressLookupTableProgram.freezeLookupTable({ lookupTable: lookup, authority: payer.publicKey }));
    const table = (await connection.getAddressLookupTable(lookup, { commitment: 'confirmed', minContextSlot: frozen.slot })).value;
    const tableRow = await connection.getAccountInfo(lookup, { commitment: 'confirmed', minContextSlot: frozen.slot });
    check(table && tableRow && tableRow.owner.equals(AddressLookupTableProgram.programId) && !tableRow.executable
      && table.state.authority === undefined && table.state.deactivationSlot === (1n << 64n) - 1n
      && JSON.stringify(table.state.addresses.map(key => key.toBase58())) === JSON.stringify(lookupKeys.map(key => key.toBase58())), 'Actual ALT differs from the frozen exact keys');
    const until = Date.now() + 5000;
    while (await connection.getSlot('confirmed') <= table.state.lastExtendedSlot) { check(Date.now() < until, 'ALT did not become active'); await sleep(150); }
    await writeFile(join(working, 'lookup-table.json'), JSON.stringify({ key: lookup.toBase58(), authority: null, deactivationSlot: table.state.deactivationSlot.toString(),
      addresses: lookupKeys.map(key => key.toBase58()), data: tableRow.data.toString('hex'), owner: tableRow.owner.toBase58(), frozenSlot: frozen.slot }, null, 2), { mode: 0o600, flag: 'wx' });
    const tables = [table];
    const tracked = (a = original) => [config, craftControl, collection, a.charter, a.assetBinding, a.creationReceipt, a.receipt, a.asset];
    async function refuse(label: typeof CASES[number], candidate: Awaited<ReturnType<typeof attempt>>, expected: ExpectedError, signers = [candidate.actor]) {
      const watched = [...tracked(), ...tracked(candidate.a)].filter((key, index, keys) => keys.findIndex(other => other.equals(key)) === index);
      const before = await snapshots(watched);
      const result = await executeInstructions(label, candidate.instructions, signers, expected, tables);
      check(JSON.stringify(await snapshots(watched)) === JSON.stringify(before), label + ': changed protected records/Core bytes');
      record(label); return result;
    }
    const donation = await connection.getMinimumBalanceForRentExemption(0, 'confirmed');
    await execute('donate-canonical-asset', SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: original.asset, lamports: donation }));
    await refuse('economy paused', await attempt(), error('Paused'));
    await execute('open-economy-admission', await pauseEconomy(false));
    await refuse('craft paused', await attempt(), error('Paused'));
    await execute('open-craft-admission', await pauseCraft(false));
    await refuse('wrong policy signer', await attempt({ signer: Keypair.generate() }), error('InvalidPermit'));
    await refuse('wrong permit purpose', await attempt({ purpose: 6 }), error('InvalidPermit'));
    await refuse('changed signed metadata', await attempt({ name: 'Changed' }), error('InvalidPermit'));
    await refuse('changed admission commitment', await attempt({ commitment: Buffer.alloc(32, 20) }), error('InvalidPermit'));
    await refuse('changed leader', await attempt({ leader: payer.publicKey }), error('InvalidPermit'), []);
    await refuse('wrong own executable', await attempt({ economyProgram: CORE }), { program: ECONOMY, code: 3008, anchorName: 'InvalidProgramId' });
    for (const [label, changed, code, anchorName] of [
      ['substituted craft program is refused', { craftProgram: CORE }, 2001, 'ConstraintHasOne'],
      ['substituted control is refused', { craftControl: leader.publicKey }, 2001, 'ConstraintHasOne'],
      ['substituted asset is refused', { asset: Keypair.generate().publicKey }, 2006, 'ConstraintSeeds'],
    ] as const) await refuse(label, await attempt({ accounts: changed }), { program: ECONOMY, code, anchorName });
    const unsignedLeader = await attempt();
    unsignedLeader.ix.keys.find(key => key.pubkey.equals(leader.publicKey))!.isSigner = false;
    await refuse('missing leader signature is refused', unsignedLeader, { program: ECONOMY, code: 3010, anchorName: 'AccountNotSigner' }, []);
    const extra = await attempt(); extra.ix.keys.push({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false });
    await refuse('remaining registration accounts are refused', extra, error('CharterIdentity'));
    const mintAccounts = { leader: leader.publicKey, executor: original.executor, economyProgram: ECONOMY, config: craftControl,
      charter: original.charter, asset: original.asset, collection, collectionAuthority, freezeAuthority: original.freezeAuthority,
      mplCoreProgram: CORE, systemProgram: SystemProgram.programId };
    async function directMint(executor: PublicKey) {
      return craft.methods.mintCharter(Array.from(charterClanIdBytes(CLAN)), Array.from(charterClanIdBytes(INTENT)),
        Array.from(admissionCommitment), NAME, URI, Array.from(permitId)).accountsStrict({ ...mintAccounts, executor }).instruction();
    }
    const unsignedExecutor = await directMint(original.executor);
    unsignedExecutor.keys.find(key => key.pubkey.equals(original.executor))!.isSigner = false;
    await refuse('direct craft lacks the executor signature', { ...await attempt(), instructions: [unsignedExecutor] },
      { program: CRAFT, code: 3010, anchorName: 'AccountNotSigner' });
    await refuse('foreign signed executor is refused', { ...await attempt(), instructions: [await directMint(leader.publicKey)] },
      { program: CRAFT, code: 2006, anchorName: 'ConstraintSeeds' });
    for (const catchFailure of [false, true]) {
      const originalAttempt = await attempt({ nativeIndex: 0 });
      const forwarded = await probe.methods.forward(originalAttempt.ix.data, catchFailure).accountsStrict({ targetProgram: ECONOMY })
        .remainingAccounts(originalAttempt.ix.keys).instruction();
      const label = catchFailure ? 'CPI catch refuses' : 'CPI forwarding refuses';
      const result = await refuse(label, { ...originalAttempt, instructions: [originalAttempt.native, forwarded] }, error('CharterTopLevelOnly'));
      check(result.logs.includes(`Program ${ECONOMY.toBase58()} invoke [2]`) && !result.logs.some(line => line.includes('Probe caught CPI failure:'))
        && !result.logs.some(line => line.startsWith(`Program ${CRAFT.toBase58()} invoke`) || line.startsWith(`Program ${CORE.toBase58()} invoke`)), 'Top-level refusal did not precede craft/Core execution');
    }

    const sizes = ['clanCharter', 'charterAssetBinding', 'charterCreationReceipt', 'permitReceipt'].map(name => economy.coder.accounts.size(name));
    const rent = (await Promise.all(sizes.map(size => connection.getMinimumBalanceForRentExemption(size, 'confirmed')))).reduce((sum, value) => sum + value, 0);
    const leaderBalance = await connection.getBalance(leader.publicKey, 'confirmed');
    await execute('limit-leader-to-record-rent', SystemProgram.transfer({ fromPubkey: leader.publicKey, toPubkey: payer.publicKey, lamports: leaderBalance - rent - 1 }), [leader]);
    const rollback = await refuse('Core failure rolls back mint and all records', await attempt(), { program: SystemProgram.programId, code: 1 });
    check(rollback.logs.includes(`Program ${CRAFT.toBase58()} invoke [2]`) && rollback.logs.includes(`Program ${CORE.toBase58()} invoke [3]`), 'Insufficient-rent failure did not reach actual Core through craft');
    check(await connection.getBalance(leader.publicKey, 'confirmed') === rent + 1, 'Rejected registration lost leader rent or retained the swept donation');
    await execute('refund-leader', SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: leader.publicKey, lamports: 1_000_000_000 }));
    const valid = await attempt();
    const minted = await executeInstructions('valid-atomic-registration', valid.instructions, [leader], undefined, tables);
    check(minted.logs.includes(`Program ${CRAFT.toBase58()} invoke [2]`) && minted.logs.includes(`Program ${CORE.toBase58()} invoke [3]`), 'Actual two-program Core mint was not executed');
    const charter = await economy.account.clanCharter.fetch(original.charter), binding = await economy.account.charterAssetBinding.fetch(original.assetBinding);
    const creation = await economy.account.charterCreationReceipt.fetch(original.creationReceipt), receipt = await economy.account.permitReceipt.fetch(original.receipt);
    check(charter.version === 1 && charter.config.equals(config) && charter.asset.equals(original.asset) && charter.collection.equals(collection)
      && charter.leader.equals(leader.publicKey) && charter.revision === 0 && charter.state === 1 && charter.lockKind === 0
      && Buffer.from(charter.lockId).equals(Buffer.alloc(16)) && Buffer.from(charter.clanId).equals(charterClanIdBytes(CLAN))
      && Buffer.from(charter.creationIntentId).equals(charterClanIdBytes(INTENT)) && Buffer.from(charter.creationPermitId).equals(permitId)
      && Buffer.from(charter.metadataHash).equals(hashCharterMetadata({ name: NAME, uri: URI })) && Buffer.from(charter.admissionCommitment).equals(admissionCommitment), 'Incomplete original Charter record');
    check(binding.version === 1 && binding.asset.equals(original.asset) && binding.charter.equals(original.charter) && Buffer.from(binding.clanId).equals(charterClanIdBytes(CLAN)), 'Wrong permanent asset binding');
    check(creation.version === 1 && creation.charter.equals(original.charter) && creation.asset.equals(original.asset) && creation.leader.equals(leader.publicKey)
      && Buffer.from(creation.intentId).equals(charterClanIdBytes(INTENT)) && Buffer.from(creation.clanId).equals(charterClanIdBytes(CLAN))
      && Buffer.from(creation.permitId).equals(permitId), 'Wrong permanent creation receipt');
    check(receipt.version === 1 && receipt.kind === 5 && receipt.wallet.equals(leader.publicKey) && Buffer.from(receipt.permitId).equals(permitId)
      && receipt.expiry.toString() === expiry.toString() && Buffer.from(receipt.payloadHash).equals(payload(original, CLAN, INTENT)), 'Native permit was not consumed for the exact original payload');
    const coreRows = await connection.getMultipleAccountsInfoAndContext([original.asset, collection], { commitment: 'confirmed', minContextSlot: minted.slot });
    for (const row of coreRows.value) check(row && row.owner.equals(CORE) && !row.executable && row.data.length <= 4096, 'Wrong actual Core account identity');
    const assetPath = join(working, 'actual-asset.bin'), collectionPath = join(working, 'actual-collection.bin');
    await writeFile(assetPath, coreRows.value[0]!.data, { mode: 0o600, flag: 'wx' }); await writeFile(collectionPath, coreRows.value[1]!.data, { mode: 0o600, flag: 'wx' });
    const verified = spawnSync(paths.verifier!, ['--asset', assetPath, '--collection', collectionPath, '--asset-key', original.asset.toBase58(),
      '--collection-key', collection.toBase58(), '--owner', leader.publicKey.toBase58(), '--freeze-authority', original.freezeAuthority.toBase58(),
      '--collection-authority', collectionAuthority.toBase58()], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    await writeFile(join(working, 'actual-decoder.json'), JSON.stringify({ status: verified.status, stdout: verified.stdout, stderr: verified.stderr }, null, 2), { mode: 0o600, flag: 'wx' });
    check(!verified.error && verified.signal === null && verified.status === 0, 'Actual minted Core profile refused by production decoder: ' + verified.stderr);
    record('actual atomic frozen mint and registration');
    authorityOutcomes = await verifyCharterAuthority(fixture, original.asset, collection, leader);
    // Capture actual confirmed account rows before the later independent pause/
    // loader-rotation cases. Only receipt time fields will be constructed anew.
    const copiedKeys = [...tracked(), authority, payer.publicKey, leader.publicKey];
    const source = await connection.getMultipleAccountsInfoAndContext(copiedKeys, { commitment: 'confirmed', minContextSlot: minted.slot });
    const originalReceipt = source.value[copiedKeys.findIndex(key => key.equals(original.receipt))];
    check(originalReceipt && originalReceipt.owner.equals(ECONOMY) && !originalReceipt.executable
      && originalReceipt.data.length === 107 && economy.coder.accounts.size('permitReceipt') === 107
      && originalReceipt.data.equals(await economy.coder.accounts.encode('permitReceipt', receipt)), 'Original canonical PermitReceipt bytes/layout mismatch');
    const [receiptKey, receiptBump] = PublicKey.findProgramAddressSync([Buffer.from('permit'), permitId], ECONOMY);
    check(receiptKey.equals(original.receipt) && originalReceipt.data[106] === receiptBump
      && originalReceipt.data.readBigInt64LE(58) === BigInt(receipt.expiry.toString())
      && originalReceipt.data.readBigInt64LE(66) === BigInt(receipt.consumedAt.toString()), 'Permit receipt offsets/PDA mismatch');
    const sourceClock = await clock(), oldExpiry = originalReceipt.data.readBigInt64LE(58), oldConsumed = originalReceipt.data.readBigInt64LE(66);
    check(oldConsumed <= oldExpiry && oldConsumed === BigInt(charter.createdAt.toString()), 'Original permit consumption clock mismatch');
    const constructedExpiry = sourceClock - BigInt(PHASE_E_SEEKER_AUCTION.permitReceiptRetentionSec) - 1n;
    const constructedConsumed = oldConsumed + constructedExpiry - oldExpiry;
    const agedReceipt = Buffer.from(originalReceipt.data);
    agedReceipt.writeBigInt64LE(constructedExpiry, 58); agedReceipt.writeBigInt64LE(constructedConsumed, 66);
    const changedOffsets = [...agedReceipt.keys()].filter(index => agedReceipt[index] !== originalReceipt.data[index]);
    check(changedOffsets.length > 0 && changedOffsets.every(index => index >= 58 && index < 74), 'Constructed time touched another permit field');
    const accounts = source.value.map((account, index) => {
      check(account, 'Missing actual account for constructed retention genesis');
      return { address: copiedKeys[index]!, account: { ...account, data: copiedKeys[index]!.equals(original.receipt) ? agedReceipt : Buffer.from(account.data) } };
    });
    const audit = { scope: 'R1 explicitly constructed elapsed receipt state, not natural elapsed-time evidence', sourceWorking: working,
      sourceGenesis: genesisHash.toBase58(), sourceSlot: source.context.slot, sourceClock: sourceClock.toString(),
      originalMint: { signature: minted.signature, slot: minted.slot }, receipt: original.receipt.toBase58(), changedOffsets,
      originalReceiptHex: originalReceipt.data.toString('hex'), constructedReceiptHex: agedReceipt.toString('hex'),
      fields: [{ name: 'expiry', offset: 58, length: 8, original: oldExpiry.toString(), constructed: constructedExpiry.toString() },
        { name: 'consumed_at', offset: 66, length: 8, original: oldConsumed.toString(), constructed: constructedConsumed.toString() }],
      accounts: accounts.map((row, index) => ({ key: row.address.toBase58(), owner: row.account.owner.toBase58(), lamports: row.account.lamports,
        executable: row.account.executable, rentEpoch: row.account.rentEpoch,
        originalSha256: hash(source.value[index]!.data), constructedSha256: hash(row.account.data) })) };
    await writeFile(join(working, 'retention-source-audit.json'), JSON.stringify(audit, null, 2), { mode: 0o600, flag: 'wx' });
    retained.value = { seed: { sourceWorking: working, sourceGenesis: genesisHash.toBase58(), sourceSlot: source.context.slot,
      payer, stranger: leader, coreAuthority, craftUpgradeAuthority: payer, accounts }, policy, permitId: Buffer.from(permitId), audit };
    const saved = await snapshots(tracked());
    const recovered = await economy.account.charterCreationReceipt.fetch(charterCreationPda(ECONOMY, INTENT));
    check(recovered.charter.equals(original.charter) && recovered.asset.equals(original.asset) && recovered.leader.equals(leader.publicKey)
      && JSON.stringify(await snapshots(tracked())) === JSON.stringify(saved), 'Lost acknowledgement lookup changed or rebased the original creation');
    record('permanent receipt recovers lost acknowledgement');
    await refuse('same registration cannot mint again', await attempt(), { program: SystemProgram.programId, code: 0 });
    const secondLeader = Keypair.generate();
    await execute('fund-distinct-second-leader', SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: secondLeader.publicKey, lamports: 1_000_000_000 }));
    await refuse('intent cannot be reused for another clan', await attempt({ clanId: '12345679-1234-5678-9abc-def012345678', id: randomBytes(16), actor: secondLeader }), { program: SystemProgram.programId, code: 0 });
    await refuse('clan cannot acquire a second asset', await attempt({ intent: '87654322-4321-4321-8abc-def012345678', id: randomBytes(16) }), { program: SystemProgram.programId, code: 0 });
    const second = await attempt({ clanId: '12345678-1234-5678-9abc-def012345679', intent: '87654321-4321-4321-8abc-def012345679', id: randomBytes(16), actor: secondLeader });
    const secondBefore = await snapshots([...tracked(), ...tracked(second.a)]);
    const balanceBefore = await connection.getBalance(secondLeader.publicKey, 'confirmed');
    const failAfterMint = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: leader.publicKey, lamports: Number.MAX_SAFE_INTEGER });
    const later = await executeInstructions('mint-then-fail-later-instruction', [...second.instructions, failAfterMint], [secondLeader],
      { program: SystemProgram.programId, code: 1, instructionIndex: 3 }, tables);
    check(later.logs.includes(`Program ${CORE.toBase58()} success`) && later.logs.includes(`Program ${CRAFT.toBase58()} success`)
      && later.logs.includes(`Program ${ECONOMY.toBase58()} success`), 'Later failure did not follow a genuinely successful mint/register instruction');
    check(JSON.stringify(await snapshots([...tracked(), ...tracked(second.a)])) === JSON.stringify(secondBefore)
      && await connection.getBalance(secondLeader.publicKey, 'confirmed') === balanceBefore, 'Later failure committed Core counters, asset, records or leader rent');
    record('later failure rolls back a successful Core mint');
    const secondResult = await executeInstructions('second-distinct-clan', second.instructions, [secondLeader], undefined, tables);
    check(secondResult.logs.includes(`Program ${CORE.toBase58()} invoke [3]`), 'Second registration did not mint through Core');
    const secondSaved = await economy.account.clanCharter.fetch(second.a.charter);
    check(secondSaved.state === 1 && secondSaved.asset.equals(second.a.asset) && secondSaved.leader.equals(secondLeader.publicKey), 'Wrong second original Charter');
    const counts = await connection.getAccountInfo(collection, { commitment: 'confirmed', minContextSlot: secondResult.slot });
    check(counts !== null, 'Missing actual shared collection');
    check(counts.owner.equals(CORE) && counts.data[0] === 5, 'Invalid actual shared collection');
    let at = 33;
    for (let i = 0; i < 2; i++) { const length = counts.data.readUInt32LE(at); at += 4 + length; check(at <= counts.data.length, 'Truncated collection metadata'); }
    check(at + 8 === counts.data.length && counts.data.readUInt32LE(at) === 2 && counts.data.readUInt32LE(at + 4) === 2,
      'Two successful distinct clans did not produce exactly two collection members');
    record('second distinct clan increments collection once');
    await execute('pause-economy-after-original', await pauseEconomy(true)); await execute('pause-craft-after-original', await pauseCraft(true));
    const immutable = tracked().filter(key => !key.equals(craftControl));
    const afterPause = await snapshots(immutable);
    await economy.account.charterCreationReceipt.fetch(original.creationReceipt); await economy.account.clanCharter.fetch(original.charter);
    check(JSON.stringify(await snapshots(immutable)) === JSON.stringify(afterPause), 'Paused historical reads changed original records');
    record('paused historical records remain original');
    const newUpgradeAuthority = Keypair.generate();
    await rotateCraftUpgradeAuthority(newUpgradeAuthority);
    const originalControl = await snapshots([craftControl]);
    await execute('former-initializer-cannot-unpause', await pauseCraft(false), [], error('Unauthorized', craft));
    check(JSON.stringify(await snapshots([craftControl])) === JSON.stringify(originalControl), 'Former upgrade authority changed control');
    record('former craft upgrade authority loses pause capability');
    await execute('new-upgrade-authority-can-unpause', await craft.methods.setCharterAdmissionPaused(false).accountsStrict({ admin: newUpgradeAuthority.publicKey,
      program: CRAFT, programData: craftProgramData, config: craftControl }).instruction(), [newUpgradeAuthority]);
    const changedControl = await craft.account.charterControl.fetch(craftControl);
    check(changedControl.admissionPaused === false && changedControl.bootstrapAdmin.equals(payer.publicKey), 'Rotation rebased immutable original bootstrap identity');
    record('new craft upgrade authority controls pause');
  });
  check(outcomes.length === CASES.length && new Set(outcomes).size === CASES.length && CASES.every(name => outcomes.includes(name)), 'Registration matrix did not exercise every boundary');
  check(retained.value, 'Missing actual first-mint checkpoint for constructed retention acceptance');
  const originalCheckpoint = retained.value;
  const retention = await withCharterValidator({ ...input, constructedGenesis: originalCheckpoint.seed,
    scope: 'R1 constructed elapsed PermitReceipt state copied from actual confirmed mint; unchanged original policy domain, no natural elapsed-time claim' },
  'registration-retention-constructed', async fixture => {
    const { connection, payer, stranger: originalLeader, working, execute, executeInstructions, snapshots, record } = fixture;
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: 'confirmed', preflightCommitment: 'confirmed' });
    const economy = new anchor.Program<ShardkeepEconomy>(economyIdl, provider);
    const authority = seekerAuthorityPda(ECONOMY), config = charterConfigPda(ECONOMY);
    const craftControl = pda('charter_control', CRAFT), collection = pda('charter_collection', CRAFT), collectionAuthority = pda('charter_collection_authority', CRAFT);
    const originalAsset = charterMintPda(CRAFT, CLAN), originalReceipt = seekerPermitReceiptPda(ECONOMY, originalCheckpoint.permitId);
    const originalPermanent = [config, craftControl, authority, collection, charterPda(ECONOMY, CLAN), charterAssetPda(ECONOMY, originalAsset), charterCreationPda(ECONOMY, INTENT), originalAsset];
    const preserved = await snapshots(originalPermanent);
    const policyAuthority = await economy.account.seekerAuthority.fetch(authority);
    const policyDomain = new PublicKey(policyAuthority.clusterGenesis);
    check(policyDomain.toBase58() === originalCheckpoint.seed.sourceGenesis && policyDomain.toBase58() !== await connection.getGenesisHash()
      && policyAuthority.currentPolicyKey.equals(originalCheckpoint.policy.publicKey) && !policyAuthority.admissionPaused,
      'Preserved policy domain/key differs from the actual original authority');
    const clock = async () => { const actual = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
      check(actual?.data.length === 40, 'Missing actual second-genesis Clock'); return actual.data.readBigInt64LE(32); };
    const aged = await economy.account.permitReceipt.fetch(originalReceipt);
    check(await clock() > BigInt(aged.expiry.toString()) + BigInt(PHASE_E_SEEKER_AUCTION.permitReceiptRetentionSec),
      'Constructed receipt has not crossed the actual close boundary');
    await writeFile(join(working, 'retention-audit.json'), JSON.stringify({ ...originalCheckpoint.audit,
      runtimeGenesis: await connection.getGenesisHash(), preservedPolicyDomain: policyDomain.toBase58(), actualSecondClock: (await clock()).toString() }, null, 2), { mode: 0o600, flag: 'wx' });
    record('constructed elapsed receipt preserves original records');
    const beforeClose = await connection.getMultipleAccountsInfo([originalReceipt, originalLeader.publicKey], 'confirmed');
    check(beforeClose[0] && beforeClose[1], 'Missing actual close balances');
    const closed = await execute('close-actual-aged-generic-permit', await economy.methods.closePermitReceipt().accountsStrict({ wallet: originalLeader.publicKey, receipt: originalReceipt }).instruction(), [originalLeader]);
    check(await connection.getAccountInfo(originalReceipt, { commitment: 'confirmed', minContextSlot: closed.slot }) === null
      && await connection.getBalance(originalLeader.publicKey, 'confirmed') === beforeClose[1].lamports + beforeClose[0].lamports
      && JSON.stringify(await snapshots(originalPermanent)) === JSON.stringify(preserved), 'Actual generic close changed permanent history or failed to refund original wallet');
    record('actual generic permit receipt closes');
    const clanId = '12345678-1234-5678-9abc-def012345680', freshIntent = '87654321-4321-4321-8abc-def012345680';
    const actor = payer; // Different actual leader from the copied first mint.
    check(!actor.publicKey.equals(originalLeader.publicKey), 'Retention retry must use a different leader');
    const admissionCommitment = Buffer.alloc(32, 29), newPermitId = randomBytes(16);
    const asset = charterMintPda(CRAFT, clanId);
    const common = { leader: actor.publicKey, authority, config, charter: charterPda(ECONOMY, clanId), assetBinding: charterAssetPda(ECONOMY, asset),
      receipt: seekerPermitReceiptPda(ECONOMY, newPermitId), executor: charterExecutorPda(ECONOMY, clanId), craftProgram: CRAFT, craftControl,
      asset, collection, collectionAuthority, freezeAuthority: charterFreezePda(CRAFT, clanId), mplCoreProgram: CORE,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY, systemProgram: SystemProgram.programId, economyProgram: ECONOMY };
    const reusedCreation = charterCreationPda(ECONOMY, INTENT), freshCreation = charterCreationPda(ECONOMY, freshIntent);
    const lookupKeys = [...Object.values(common), reusedCreation, freshCreation].filter((key, index, keys) => keys.findIndex(other => other.equals(key)) === index)
      .sort((a, b) => a.toBase58().localeCompare(b.toBase58()));
    const [create, lookup] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: await connection.getSlot('finalized') });
    await execute('retention-create-real-lookup-table', create);
    await execute('retention-extend-real-lookup-table', AddressLookupTableProgram.extendLookupTable({ lookupTable: lookup, authority: payer.publicKey, payer: payer.publicKey, addresses: lookupKeys }));
    const frozen = await execute('retention-freeze-real-lookup-table', AddressLookupTableProgram.freezeLookupTable({ lookupTable: lookup, authority: payer.publicKey }));
    const table = (await connection.getAddressLookupTable(lookup, { commitment: 'confirmed', minContextSlot: frozen.slot })).value;
    const tableRow = await connection.getAccountInfo(lookup, { commitment: 'confirmed', minContextSlot: frozen.slot });
    check(table && tableRow && tableRow.owner.equals(AddressLookupTableProgram.programId) && !tableRow.executable
      && table.state.authority === undefined && table.state.deactivationSlot === (1n << 64n) - 1n
      && JSON.stringify(table.state.addresses.map(key => key.toBase58())) === JSON.stringify(lookupKeys.map(key => key.toBase58())), 'Second-genesis frozen lookup table differs');
    const until = Date.now() + 5000;
    while (await connection.getSlot('confirmed') <= table.state.lastExtendedSlot) { check(Date.now() < until, 'Second ALT did not activate'); await sleep(150); }
    await writeFile(join(working, 'lookup-table.json'), JSON.stringify({ key: lookup.toBase58(), authority: null,
      data: tableRow.data.toString('hex'), owner: tableRow.owner.toBase58(), frozenSlot: frozen.slot, addresses: lookupKeys.map(key => key.toBase58()) }, null, 2), { mode: 0o600, flag: 'wx' });
    const expiry = await clock() + BigInt(PHASE_E_SEEKER_AUCTION.issuedPolicyPermitTtlSec);
    async function candidate(intent: string) {
      const creationReceipt = charterCreationPda(ECONOMY, intent), accounts = { ...common, creationReceipt };
      const payloadHash = hashCharterRegistrationPayload({ config, craftProgram: CRAFT, craftControl, collection, collectionAuthority,
        charter: common.charter, asset, assetBinding: common.assetBinding, freezeAuthority: common.freezeAuthority, executor: common.executor,
        creationReceipt, clanId, leader: actor.publicKey, creationIntentId: intent, metadataHash: hashCharterMetadata({ name: NAME, uri: URI }), admissionCommitment });
      // The immutable authority still names the FIRST genesis. Sign that field,
      // never the second runtime genesis and never patch policy account bytes.
      const message = encodeCharterRegistrationPermit({ genesisHash: policyDomain, programId: ECONOMY, kind: 5, permitId: newPermitId,
        wallet: actor.publicKey, expiry, payloadHash });
      const native = Ed25519Program.createInstructionWithPrivateKey({ privateKey: originalCheckpoint.policy.secretKey, message });
      const register = await economy.methods.registerCharter(Array.from(charterClanIdBytes(clanId)), Array.from(charterClanIdBytes(intent)),
        Array.from(admissionCommitment), NAME, URI, { permitId: Array.from(newPermitId), expiry: new anchor.BN(expiry.toString()), ed25519Instruction: 1 }).accountsStrict(accounts).instruction();
      return [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), native, register];
    }
    const allProtected = [...originalPermanent, originalReceipt, common.charter, common.assetBinding, common.receipt, asset, freshCreation];
    const beforeReplay = await snapshots(allProtected);
    const rejected = await executeInstructions('retained-intent-refuses-after-generic-close', await candidate(INTENT), [], { program: SystemProgram.programId, code: 0 }, [table]);
    check(rejected.logs.some(line => line === `Allocate: account Address { address: ${reusedCreation.toBase58()}, base: None } already in use`)
      && !rejected.logs.some(line => line.startsWith(`Program ${CRAFT.toBase58()} invoke`) || line.startsWith(`Program ${CORE.toBase58()} invoke`))
      && JSON.stringify(await snapshots(allProtected)) === JSON.stringify(beforeReplay), 'Replay did not fail specifically at the existing permanent creation receipt without effects');
    record('closed generic receipt cannot release permanent creation intent');
    const control = await executeInstructions('fresh-intent-under-preserved-policy-domain', await candidate(freshIntent), [], undefined, [table]);
    check(control.logs.includes(`Program ${CORE.toBase58()} invoke [3]`), 'Independent fresh intent did not reach actual Core');
    const created = await economy.account.charterCreationReceipt.fetch(freshCreation), active = await economy.account.clanCharter.fetch(common.charter);
    check(created.leader.equals(actor.publicKey) && created.asset.equals(asset) && active.state === 1 && active.leader.equals(actor.publicKey)
      && Buffer.from(created.intentId).equals(charterClanIdBytes(freshIntent)), 'Fresh control did not establish the independent original intent');
    const actualCollection = await connection.getAccountInfo(collection, { commitment: 'confirmed', minContextSlot: control.slot });
    const originalCollection = originalCheckpoint.seed.accounts.find(row => row.address.equals(collection))!.account;
    check(actualCollection && actualCollection.owner.equals(originalCollection.owner), 'Missing control collection');
    const expectedCollection = Buffer.from(originalCollection.data), countAt = expectedCollection.length - 8;
    expectedCollection.writeUInt32LE(expectedCollection.readUInt32LE(countAt) + 1, countAt);
    expectedCollection.writeUInt32LE(expectedCollection.readUInt32LE(countAt + 4) + 1, countAt + 4);
    check(actualCollection.data.equals(expectedCollection), 'Fresh control did not increment exactly the two original collection counters');
    const immutableKeys = originalPermanent.filter(key => !key.equals(collection));
    const immutableBefore = originalCheckpoint.seed.accounts.filter(row => immutableKeys.some(key => key.equals(row.address)));
    const immutableAfter = await connection.getMultipleAccountsInfo(immutableBefore.map(row => row.address), 'confirmed');
    check(immutableAfter.every((row, index) => row && row.data.equals(immutableBefore[index]!.account.data)
      && row.owner.equals(immutableBefore[index]!.account.owner) && row.lamports === immutableBefore[index]!.account.lamports
      && row.executable === immutableBefore[index]!.account.executable), 'Fresh control changed copied permanent or policy accounts');
    check(await connection.getAccountInfo(originalReceipt, 'confirmed') === null, 'Control recreated the closed generic receipt');
    record('fresh intent succeeds under preserved policy domain');
  });
  check(retention.length === RETENTION_CASES.length && new Set(retention).size === RETENTION_CASES.length
    && RETENTION_CASES.every(name => retention.includes(name)), 'Constructed retention matrix incomplete');
  check(authorityOutcomes.length === 7 && new Set(authorityOutcomes).size === 7, 'Actual Core authority matrix incomplete');
  console.log(JSON.stringify({ status: 'passed', cases: outcomes.length + retention.length + authorityOutcomes.length, originalCases: outcomes.length,
    authorityCases: authorityOutcomes.length, constructedRetentionCases: retention.length, scope: 'Local atomic mint/registration plus explicitly constructed elapsed receipt state only' }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
