/** B6f executable fixture intent, authored before the craft bootstrap handler.
 * Only fresh owned loopback validators and generated fixture signers are used.
 * No NFT mint, Charter admission, public deployment or production craft pin.
 */
// Same identity miningProgramProtocol.ts exports (this IDL's address). That module default-imports
// @coral-xyz/anchor, which tsx cannot initialize from this CommonJS package (CI run 37503885236).
import economyIdl from '../packages/chain/src/idl/shardkeep_economy.json' with { type: 'json' };
import { VEHICLE_CRAFT_PROGRAM } from '../packages/chain/src/vehicleIssuanceProtocol';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import * as anchor from '@coral-xyz/anchor';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import type { ShardkeepCraft } from './target/types/shardkeep_craft';
import { withCharterValidator as localFixture, type CharterFixtureInput, type ExpectedError } from './charter-local-fixture';
type FixtureInput = CharterFixtureInput & { rawIdl: ShardkeepCraft };

const programs = dirname(resolve(process.argv[1]!)), root = resolve(programs, '..');
const requireChain = createRequire(join(root, 'packages/chain/package.json'));
const core: typeof import('../packages/chain/node_modules/@metaplex-foundation/mpl-core') = requireChain('@metaplex-foundation/mpl-core');
const umiApi: typeof import('../packages/chain/node_modules/@metaplex-foundation/umi') = requireChain('@metaplex-foundation/umi');
const umiBundle: typeof import('../packages/chain/node_modules/@metaplex-foundation/umi-bundle-defaults') = requireChain('@metaplex-foundation/umi-bundle-defaults');
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const CRAFT = new PublicKey(VEHICLE_CRAFT_PROGRAM); // Reviewed local identity only.
const MINING_PROGRAM_ADDRESS = economyIdl.address;
const ECONOMY = new PublicKey(MINING_PROGRAM_ADDRESS);
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const CORE_SHA256 = '69be69672220f4b5b0813e53cc4e2f3042dcac991f088b174bc7907dab4b2dee';
const CORE_BYTES = 809696;
// Exact craft instruction surface this bootstrap accepts (sorted). B6f exposed 1, B6g 3; charter transfer
// and vehicle issuance later grew craft to 11 without updating this list, so the runner refused every
// current craft IDL (KNOWN_ISSUES f5061e30). Re-review here when craft changes:
// scripts/src/phase-e-programs-ci.test.ts pins this list to the #[program] functions in shardkeep-craft.
const CRAFT_INSTRUCTION_SURFACE = ['consume_vehicle_randomness', 'execute_charter_transfer', 'initialize_charter_collection',
  'initialize_vehicle_collection', 'mint_charter', 'mint_vehicle', 'request_vehicle', 'rotate_vehicle_policy',
  'set_charter_admission_paused', 'set_vehicle_admission_paused', 'settle_vehicle_fee'];
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }

function verifyPlainEmptyCollection(data: Buffer, authority: PublicKey) {
  let at = 0;
  const take = (size: number) => {
    check(Number.isSafeInteger(size) && size >= 0 && at + size <= data.length, 'Truncated Core collection');
    const bytes = data.subarray(at, at + size); at += size; return bytes;
  };
  const string = () => new TextDecoder('utf-8', { fatal: true }).decode(take(take(4).readUInt32LE(0)));
  check(data.length <= 4096 && take(1)[0] === 5, 'Expected bounded actual Core CollectionV1');
  check(new PublicKey(take(32)).equals(authority), 'Collection authority is not the craft PDA');
  const name = string(), uri = string();
  check(take(4).readUInt32LE(0) === 0 && take(4).readUInt32LE(0) === 0, 'Bootstrap created a nonempty collection');
  check(at === data.length, 'Collection has plugin data, adapters, padding or unconsumed bytes');
  return { name, uri };
}

// Every refusal must be a confirmed, executed transaction with its precise
// program error and unchanged canonical config/collection/authority accounts.
// No account injection, test-only handler, source substitution or preflight-only
// exception can satisfy these cases.
const CASES = [
  'current ProgramData upgrade authority creates the canonical empty collection',
  'config is initially paused and bound to the fixed economy and craft authority',
  'foreign initializer cannot bootstrap',
  'foreign ProgramData cannot authenticate the initializer',
  'foreign executable cannot replace the own Program account',
  'wrong Core program is refused',
  'wrong System program is refused',
  'wrong config PDA is refused',
  'wrong collection PDA is refused',
  'wrong collection authority PDA is refused',
  'additional accounts are refused',
  'empty name is refused',
  'empty URI is refused',
  'name bounds count UTF8 bytes',
  'URI beyond the technical byte bound is refused',
  'a pre-funded canonical collection follows the reviewed Core creation contract',
  'genuine Core CPI failure restores the donation and config absence',
  'duplicate initialization cannot rewrite the saved config or collection',
  'former initializer cannot update the collection through Core',
  'former initializer cannot reassign the collection through Core',
  'former initializer cannot burn the collection through Core',
] as const;

async function bootstrapCases(input: FixtureInput, prefunded: boolean) {
  return localFixture(input, prefunded ? 'prefunded' : 'clean', async fixture => {
    const { connection, payer, stranger, programData, execute, snapshots, record } = fixture;
    const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: 'confirmed', preflightCommitment: 'confirmed' });
    const program = new anchor.Program<ShardkeepCraft>(input.rawIdl, provider);
    check(program.programId.equals(CRAFT), 'Typed program does not match the reviewed local craft identity');
    const [config, bump] = PublicKey.findProgramAddressSync([Buffer.from('charter_control')], CRAFT);
    const [collection, collectionBump] = PublicKey.findProgramAddressSync([Buffer.from('charter_collection')], CRAFT);
    const [collectionAuthority, authorityBump] = PublicKey.findProgramAddressSync([Buffer.from('charter_collection_authority')], CRAFT);
    const accounts = { admin: payer.publicKey, program: CRAFT, programData, config, collection,
      collectionAuthority, mplCoreProgram: CORE, systemProgram: SystemProgram.programId };
    const tracked = [config, collection, collectionAuthority, programData];
    const name = prefunded ? 'é'.repeat(32) : 'Local Charter Collection';
    const uri = prefunded ? 'u'.repeat(512) : 'https://invalid.example/charters.json';
    const instruction = (values: Partial<typeof accounts> = {}, metadata = { name, uri }) =>
      program.methods.initializeCharterCollection(metadata.name, metadata.uri).accountsStrict({ ...accounts, ...values }).instruction();
    const craftError = (errorName: string): ExpectedError => {
      const error = program.rawIdl.errors?.find(value => value.name === errorName);
      check(error, 'Missing expected craft error ' + errorName);
      return { program: CRAFT, code: error.code, anchorName: errorName };
    };
    const frameworkError = (anchorName: string, code: number): ExpectedError => ({ program: CRAFT, code, anchorName });
    async function refuse(caseName: typeof CASES[number], ix: TransactionInstruction, error: ExpectedError, signers: Keypair[] = []) {
      const addresses = [...tracked, ...ix.keys.map(key => key.pubkey)]
        .filter((key, index, all) => !key.equals(payer.publicKey) && all.findIndex(value => value.equals(key)) === index);
      const before = await snapshots(addresses);
      await execute(caseName, ix, signers, error);
      check(JSON.stringify(await snapshots(addresses)) === JSON.stringify(before), caseName + ': rejected instruction changed protected accounts');
      record(caseName);
    }
    check((await connection.getMultipleAccountsInfo([config, collection, collectionAuthority], 'confirmed')).every(row => row === null),
      'Fresh fixture already has canonical state');
    if (!prefunded) {
      await refuse('foreign initializer cannot bootstrap', await instruction({ admin: stranger.publicKey }), craftError('Unauthorized'), [stranger]);
      const foreignProgramData = PublicKey.findProgramAddressSync([CORE.toBuffer()], LOADER)[0];
      await refuse('foreign ProgramData cannot authenticate the initializer', await instruction({ programData: foreignProgramData }), craftError('Unauthorized'));
      await refuse('foreign executable cannot replace the own Program account', await instruction({ program: CORE }), frameworkError('InvalidProgramId', 3008));
      await refuse('wrong Core program is refused', await instruction({ mplCoreProgram: SystemProgram.programId }), craftError('InvalidCore'));
      await refuse('wrong System program is refused', await instruction({ systemProgram: CORE }), frameworkError('InvalidProgramId', 3008));
      for (const [field, caseName] of [
        ['config', 'wrong config PDA is refused'], ['collection', 'wrong collection PDA is refused'],
        ['collectionAuthority', 'wrong collection authority PDA is refused'],
      ] as const) {
        await refuse(caseName, await instruction({ [field]: Keypair.generate().publicKey }), frameworkError('ConstraintSeeds', 2006));
      }
      const extra = await instruction(); extra.keys.push({ pubkey: stranger.publicKey, isSigner: false, isWritable: false });
      await refuse('additional accounts are refused', extra, craftError('RemainingAccounts'));
      for (const [caseName, metadata] of [
        ['empty name is refused', { name: '', uri }], ['empty URI is refused', { name, uri: '' }],
        ['name bounds count UTF8 bytes', { name: 'é'.repeat(33), uri }],
        ['URI beyond the technical byte bound is refused', { name, uri: 'u'.repeat(513) }],
      ] as const) await refuse(caseName, await instruction({}, metadata), craftError('InvalidMetadata'));
    }

    let prefund = 0;
    if (prefunded) {
      // A real rent-exempt System donation, not a seeded/injected account.
      prefund = await connection.getMinimumBalanceForRentExemption(0, 'confirmed');
      await execute('donate-to-canonical-collection', SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: collection, lamports: prefund }));
      const funded = await connection.getAccountInfo(collection, 'confirmed');
      check(funded && funded.owner.equals(SystemProgram.programId) && !funded.executable && funded.data.length === 0 && funded.lamports === prefund,
        'Donation did not create the exact canonical empty System account');
      const configSize = program.coder.accounts.size('charterControl');
      check(configSize === 141, 'Re-review the generated bootstrap config size');
      const configRent = await connection.getMinimumBalanceForRentExemption(configSize, 'confirmed');
      const collectionSize = 1 + 32 + 4 + Buffer.byteLength(name) + 4 + Buffer.byteLength(uri) + 4 + 4;
      const collectionRent = await connection.getMinimumBalanceForRentExemption(collectionSize, 'confirmed');
      check(prefund + 1 < collectionRent, 'Fixture donation is too large to exercise genuine Core rent failure');
      const init = await instruction();
      const feeFor = async (ix: TransactionInstruction) => {
        const latest = await connection.getLatestBlockhash('confirmed');
        const message = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(ix).compileMessage();
        const fee = (await connection.getFeeForMessage(message, 'confirmed')).value;
        check(fee !== null && Number.isSafeInteger(fee), 'Missing actual fixture fee'); return fee;
      };
      const initFee = await feeFor(init), balance = await connection.getBalance(payer.publicKey, 'confirmed');
      const drain = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: stranger.publicKey, lamports: 1 });
      const drainFee = await feeFor(drain), retained = configRent + initFee + 1;
      check(balance > retained + drainFee, 'Insufficient initial fixture balance');
      await execute('funds-limited-initializer', SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: stranger.publicKey,
        lamports: balance - retained - drainFee }));
      check(await connection.getBalance(payer.publicKey, 'confirmed') === retained, 'Initializer balance is not the exact failure fixture');
      const before = await snapshots(tracked);
      const refused = await execute('genuine-core-rent-failure', init, [], { program: SystemProgram.programId, code: 1 });
      check(refused.logs.includes(`Program ${CORE.toBase58()} invoke [2]`), 'Rent failure did not reach genuine Core CPI');
      check(JSON.stringify(await snapshots(tracked)) === JSON.stringify(before), 'Core CPI failure retained config or changed the donation');
      const payerAfter = await connection.getBalance(payer.publicKey, 'confirmed');
      check(payerAfter === retained - initFee, 'Failed bootstrap did not roll back the swept donation and config rent');
      record('genuine Core CPI failure restores the donation and config absence');
      await execute('refund-fixture-initializer', SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: payer.publicKey,
        lamports: 1_000_000_000 }), [stranger]);
    }

    const initialized = await execute('initialize-charter-collection', await instruction());
    check(initialized.logs.includes(`Program ${CORE.toBase58()} invoke [2]`), 'Bootstrap did not execute actual Core');
    const actual = await connection.getMultipleAccountsInfoAndContext([config, collection, collectionAuthority],
      { commitment: 'confirmed', minContextSlot: initialized.slot });
    const [configRow, collectionRow, authorityRow] = actual.value;
    check(configRow && !configRow.executable && configRow.owner.equals(CRAFT) && configRow.data.length === 141, 'Wrong actual config account');
    const saved = program.coder.accounts.decode<anchor.IdlAccounts<ShardkeepCraft>['charterControl']>('charterControl', configRow.data);
    check(saved.version === 1 && saved.bootstrapAdmin.equals(payer.publicKey) && saved.economyProgram.equals(ECONOMY)
      && saved.collection.equals(collection) && saved.collectionAuthority.equals(collectionAuthority)
      && saved.admissionPaused === true && saved.bump === bump && saved.collectionBump === collectionBump && saved.authorityBump === authorityBump,
      'Saved config changed the fixed bootstrap contract');
    check(collectionRow && !collectionRow.executable && collectionRow.owner.equals(CORE), 'Collection was not created and owned by actual Core');
    const metadata = verifyPlainEmptyCollection(collectionRow.data, collectionAuthority);
    check(metadata.name === name && metadata.uri === uri, 'Core metadata differs from the exact requested UTF8 values');
    check(authorityRow === null, 'Bootstrap gave the readonly authority PDA account state or funds');
    const events = [...new anchor.EventParser(CRAFT, program.coder).parseLogs(initialized.logs)];
    check(events.length === 1 && events[0]!.name === 'charterCollectionInitialized', 'Missing or extra bootstrap event');
    const event = events[0]!.data as anchor.IdlEvents<ShardkeepCraft>['charterCollectionInitialized'];
    check(event.config.equals(config) && event.admin.equals(payer.publicKey) && event.economyProgram.equals(ECONOMY)
      && event.collection.equals(collection) && event.collectionAuthority.equals(collectionAuthority)
      && event.prefundReturned.toString() === String(prefund) && event.admissionPaused === true,
      'Bootstrap event does not match actual saved keys, refund or pause state');
    await snapshots(tracked);
    if (prefunded) record('a pre-funded canonical collection follows the reviewed Core creation contract');
    else {
      record('current ProgramData upgrade authority creates the canonical empty collection');
      record('config is initially paused and bound to the fixed economy and craft authority');
      await refuse('duplicate initialization cannot rewrite the saved config or collection', await instruction(), { program: SystemProgram.programId, code: 0 });
      const umi = umiBundle.createUmi(connection.rpcEndpoint).use(core.mplCore());
      const admin = umiApi.createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(payer.secretKey));
      umi.use(umiApi.keypairIdentity(admin));
      const coreAccounts = { collection: umiApi.publicKey(collection.toBase58()), payer: admin, authority: admin };
      for (const [caseName, builder] of [
        ['former initializer cannot update the collection through Core', core.updateCollectionV1(umi, { ...coreAccounts, newName: 'Unauthorized' })],
        ['former initializer cannot reassign the collection through Core', core.updateCollectionV1(umi, { ...coreAccounts, newUpdateAuthority: umiApi.publicKey(payer.publicKey.toBase58()) })],
        ['former initializer cannot burn the collection through Core', core.burnCollectionV1(umi, { ...coreAccounts, compressionProof: null })],
      ] as const) {
        const instructions = builder.getInstructions(); check(instructions.length === 1, 'Expected exactly one direct Core instruction');
        const coreIx = instructions[0]!; check(coreIx.programId.toString() === CORE.toBase58(), 'Wrong direct Core instruction target');
        const ix = new TransactionInstruction({ programId: CORE, data: Buffer.from(coreIx.data),
          keys: coreIx.keys.map(key => ({ pubkey: new PublicKey(key.pubkey), isSigner: key.isSigner, isWritable: key.isWritable })) });
        await refuse(caseName, ix, { program: CORE, code: 9 });
      }
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  check(args.length === 6 && args[0] === '--core-binary' && args[2] === '--craft-binary' && args[4] === '--craft-idl',
    'Usage: charter-local-bootstrap.ts --core-binary ABSOLUTE_PATH --craft-binary ABSOLUTE_PATH --craft-idl ABSOLUTE_PATH');
  const corePath = args[1]!, craftPath = args[3]!, idlPath = args[5]!;
  for (const path of [corePath, craftPath, idlPath]) check(isAbsolute(path) && (await lstat(path)).isFile(), 'Expected explicit absolute regular artifact: ' + path);
  const [coreBinary, craftBinary, idlBytes] = await Promise.all([readFile(corePath), readFile(craftPath), readFile(idlPath)]);
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  check(coreBinary.length === CORE_BYTES && coreBinary.subarray(0, 4).equals(elf) && hash(coreBinary) === CORE_SHA256, 'Wrong official Core executable');
  check(craftBinary.length > 4 && craftBinary.subarray(0, 4).equals(elf), 'Craft artifact is not a compiled ELF');
  const rawIdl = JSON.parse(idlBytes.toString('utf8')) as ShardkeepCraft;
  check(rawIdl.address === CRAFT.toBase58() && JSON.stringify(rawIdl.instructions.map(item => item.name).sort())
    === JSON.stringify(CRAFT_INSTRUCTION_SURFACE), 'Unexpected craft identity or exposed instruction surface');
  const coreSdkVersion: unknown = JSON.parse(await readFile(join(root, 'packages/chain/node_modules/@metaplex-foundation/mpl-core/package.json'), 'utf8')).version;
  const umiVersion: unknown = JSON.parse(await readFile(join(root, 'packages/chain/node_modules/@metaplex-foundation/umi/package.json'), 'utf8')).version;
  check(coreSdkVersion === '1.10.0' && umiVersion === '1.5.1', 'Re-review the installed Core/Umi SDK versions');
  const version = spawnSync('solana-test-validator', ['--version'], { encoding: 'utf8', timeout: 10000 });
  check(!version.error && version.status === 0 && /solana-test-validator 2\.3\.13(?:\s|\(|$)/.test(version.stdout), 'Require pinned validator2.3.13; no fallback');
  const input: FixtureInput = { corePath, craftPath, coreBinary, craftBinary, craft: CRAFT, rawIdl,
    idlSha256: hash(idlBytes), validatorVersion: version.stdout.trim(), coreSdkVersion, umiVersion };
  const outcomes = [...await bootstrapCases(input, false), ...await bootstrapCases(input, true)];
  check(outcomes.length === CASES.length && new Set(outcomes).size === CASES.length && CASES.every(name => outcomes.includes(name)),
    'The planned bootstrap boundaries were not all exercised exactly once');
  console.log(JSON.stringify({ result: 'passed', checks: outcomes.length, ownedFreshGeneses: 2,
    scope: 'Local collection bootstrap only; no NFT mint or Charter registration' }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
