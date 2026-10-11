/** One DB-funded publication and real claims; explicit copied-genesis delay only. */
import { VEHICLE_CRAFT_PROGRAM } from '../packages/chain/src/vehicleIssuanceProtocol';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import anchorPkg, { type Idl } from '@coral-xyz/anchor';
import { AddressLookupTableProgram, Connection, Keypair, MessageV0, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  VersionedMessage, VersionedTransaction, SYSVAR_CLOCK_PUBKEY, type AccountInfo } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, MINT_SIZE, AuthorityType,
  createInitializeMint2Instruction, createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction, createSetAuthorityInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, AccountLayout, MintLayout } from '@solana/spl-token';
import { PHASE_E_MINING_PUBLICATION, PHASE_E_MINING_CLAIM_FORMAT, PHASE_E_POLICY, TOKEN } from '../packages/shared/src/constants';
import miningIdl from '../packages/chain/src/idl/shardkeep_economy.json' with { type: 'json' };
import { MINING_PROGRAM_ADDRESS, miningConfigPda, miningRootPda, miningEpochPda,
  minerClaimPda, renownRecordPda, buildOpenMinerRecordsInstruction, buildClaimMiningInstruction,
  decodeMiningConfig, decodeMinerClaim, decodeRenownRecord, decodeMiningRoot } from '../packages/chain/src/miningProgramProtocol';
import { decodeMiningAllocationLeaf, decodeMiningAllocationProof, verifyMiningAllocationProof } from '../packages/chain/src/miningAllocationProof';
import { withCharterValidator, type CharterFixtureInput, type CharterConstructedGenesis } from './charter-local-fixture';
import type { MiningPublicationTrust } from '../packages/chain/src/miningPublicationReceipt';
import type { PreparedMiningPublication } from '../apps/api/src/mining/publicationEnvelope';
// Programs has an isolated SDK install. Normalize only fixture object wrappers
// into the chain package SDK; all account/transaction bytes remain unchanged.
import {PublicKey as ClaimPublicKey,MessageV0 as ClaimMessageV0} from '../packages/chain/node_modules/@solana/web3.js';
import {buildMiningClaimMessages,type MiningClaimMessageInput} from '../packages/chain/src/miningClaimMessage';
import {copyMiningClaimFormat,miningClaimLookupAddresses,verifyMiningClaimV0Rpc,type MiningClaimFormat} from '../packages/chain/src/miningClaimFormat';
import {createMiningClaimReceiptVerifier,type MiningClaimReceiptReader} from '../packages/chain/src/miningClaimReceipt';
import {hashMiningAllocationLeaf,hashMiningAllocationNode,type MiningProofNode} from '../packages/chain/src/miningAllocationProof';
export interface FundedMiningProgramContext {
  connection: Connection; trust: MiningPublicationTrust; publisher: PublicKey;
  programData: Buffer; programDataAddress: PublicKey; upgradeAuthority: PublicKey;
}
export interface FundedMiningProgramBridge {
  prepare(context: FundedMiningProgramContext): Promise<PreparedMiningPublication>;
  acceptSigned(wire: Uint8Array): Promise<void>;
  settle(signature: string, wire: Uint8Array): Promise<{
    sourceHash: string; dbReplayStable: boolean; evidence: unknown;
    claims: { wallet: string; leafHex: string; proofHex: string }[];
  }>;
}
export interface FundedMiningProgramReport {
  genesisA: string; genesisB: string; sourceHash: string;
  claims: { wallet: string; keep: string; renown: string; days: string; replayPreserved: boolean }[];
  tamperRejected: boolean; dbReplayStable: boolean; allowedMutations: string[]; copiedAccounts: number;
  ordered?: {setupReceipt:unknown; packets:object[]; executions:object[]; receiptScope:string};
}
const { BorshCoder, BN } = anchorPkg;
const ECONOMY = new PublicKey(MINING_PROGRAM_ADDRESS), CRAFT = new PublicKey(VEHICLE_CRAFT_PROGRAM);
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const EXPECTED = {
  core: '69be69672220f4b5b0813e53cc4e2f3042dcac991f088b174bc7907dab4b2dee',
  craft: '702efa44374d473f862fb5e49bea49c87c6aec736fbc712f392939c9ca7423cd',
  economy: '1f729b39868b84cea8f2e5e8aacb13e1b317d0f7a06292bee226e6a674db532c',
  idl: 'e3d20bd91bcd0d2ef639878f6602656e33f798773f1a41b2b8c7e813a4247ff5',
};
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const bn = (value: bigint | number) => new BN(value.toString());
const day = BigInt(Date.parse('2020-01-01T00:00:00Z') / (PHASE_E_MINING_PUBLICATION.daySec * 1000));
type Copied = { address: PublicKey; account: AccountInfo<Buffer> };
async function artifact(name: string, expected: string) {
  const path = process.env[name]; assert(path && isAbsolute(path), `Explicit absolute ${name} required`);
  assert((await lstat(path)).isFile(), 'Artifact must be a regular file');
  const bytes = await readFile(path); assert.equal(hash(bytes), expected, `Unreviewed ${name}`);
  return { path, bytes };
}
function encodedAccount(row: Copied) {
  return { address: row.address.toBase58(), owner: row.account.owner.toBase58(), executable: row.account.executable,
    lamports: row.account.lamports, rentEpoch: row.account.rentEpoch ?? 0,
    dataBase64: row.account.data.toString('base64'), dataSha256: hash(row.account.data) };
}

export async function runFundedMiningProgram(input: {
  claimants: readonly Keypair[]; bridge: FundedMiningProgramBridge; orderedV0?:boolean;
}): Promise<FundedMiningProgramReport> {
  assert.equal(input.claimants.length, 2); assert.equal(new Set(input.claimants.map(k => k.publicKey.toBase58())).size, 2);
  const [core, craft, economy, idl] = await Promise.all([
    artifact('PHASE_E_MINING_CORE_BINARY', EXPECTED.core), artifact('PHASE_E_MINING_CRAFT_BINARY', EXPECTED.craft),
    artifact('PHASE_E_MINING_ECONOMY_BINARY', EXPECTED.economy), artifact('PHASE_E_MINING_ECONOMY_IDL', EXPECTED.idl),
  ]);
  assert.equal(core.bytes.length, 809696);
  for (const binary of [core.bytes, craft.bytes, economy.bytes]) assert(binary.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])));
  const generated = JSON.parse(idl.bytes.toString()) as typeof miningIdl;
  assert.equal(generated.address, MINING_PROGRAM_ADDRESS);
  // Accepted generated IDL adds Charter definitions. Every shared mining ABI
  // definition must remain byte-for-byte equivalent as JSON, not just named alike.
  for (const section of ['instructions', 'accounts', 'types', 'events', 'errors'] as const)
    for (const definition of miningIdl[section])
      assert.deepEqual(generated[section].find(row => row.name === definition.name), definition);
  const version = spawnSync('solana-test-validator', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  assert(!version.error && version.status === 0 && /solana-test-validator 2\.3\.13(?:\s|\(|$)/.test(version.stdout), 'Pinned validator2.3.13 required');
  const fixtures: CharterFixtureInput = {
    corePath: core.path, coreBinary: core.bytes, craftPath: craft.path, craftBinary: craft.bytes, craft: CRAFT,
    additionalPrograms: [{ id: ECONOMY, path: economy.path, binary: economy.bytes }],
    idlSha256: hash(idl.bytes), validatorVersion: version.stdout.trim(), coreSdkVersion: 'unused', umiVersion: 'unused',
    scope: 'One DB-funded mining root and actual paid/free claims; explicit copied-genesis audit delay, no Charter or live historical source authority',
  };
  const directory = await mkdtemp('/tmp/mining-funded-program-');
  console.log('Owned funded-mining evidence directory: ' + directory);
  const coder = new BorshCoder(miningIdl as Idl);
  const instruction = (name: string, args: object, accounts: Record<string, PublicKey>) => {
    const definition = miningIdl.instructions.find(row => row.name === name); assert(definition);
    return new TransactionInstruction({ programId: ECONOMY, data: coder.instruction.encode(name, args),
      keys: definition.accounts.map(meta => {
        const key = accounts[meta.name]; assert(key, `Missing ${name}.${meta.name}`);
        if ('address' in meta) assert.equal(key.toBase58(), meta.address);
        return { pubkey: key, isSigner: 'signer' in meta && meta.signer === true, isWritable: 'writable' in meta && meta.writable === true };
      }) });
  };
  const config = miningConfigPda(ECONOMY), root = miningRootPda(ECONOMY, 1n), epoch = miningEpochPda(ECONOMY, day);
  const authority = PublicKey.findProgramAddressSync([Buffer.from('seeker_authority')], ECONOMY)[0];
  const programDataAddress = PublicKey.findProgramAddressSync([ECONOMY.toBuffer()], LOADER)[0];
  const mint = Keypair.generate(), publisher = Keypair.generate();
  const vault = getAssociatedTokenAddressSync(mint.publicKey, config, true);
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint.publicKey, owner, true);
  const transactions: object[] = [];
  let orderedReserveOwner:PublicKey|undefined;
  let lookupAddress:PublicKey|undefined,lookupPin:{address:string;dataSha256:string}|undefined,setupReceipt:unknown;
  const orderedPackets:object[]=[],orderedExecutions:object[]=[];
  let sequence = 0;
  const retained: { seed?: CharterConstructedGenesis; prepared?: PreparedMiningPublication;
    settlement?: Awaited<ReturnType<FundedMiningProgramBridge['settle']>>; genesisA?: string;
    rootAudit?: object; programData?: Buffer; originals?: Copied[] } = {};

  // The connection comes only from the owned validator helper: loopback fetch,
  // exact program/authority identity, bounded startup/watchdog/child-PGID cleanup.
  function transport(connection: Connection, genesis: string, pdHash: string, phase: string) {
    return async (label: string, payer: Keypair, instructions?: TransactionInstruction[],
      originalWire?: Uint8Array, expectedError?: string, extraSigners: Keypair[] = []) => {
      assert.equal(await connection.getGenesisHash(), genesis);
      const pd = await connection.getAccountInfo(programDataAddress, 'confirmed'); assert(pd);
      assert.equal(hash(pd.data), pdHash, 'Reviewed runtime ProgramData changed');
      let wire: Buffer;
      if (originalWire) { assert(!instructions); wire = Buffer.from(originalWire); }
      else {
        assert(instructions?.length);
        const latest = await connection.getLatestBlockhash('confirmed');
        const transaction = new Transaction({ feePayer: payer.publicKey, recentBlockhash: latest.blockhash }).add(...instructions);
        transaction.sign(payer, ...extraSigners); wire = transaction.serialize();
      }
      assert(wire.length <= 1232); const transaction = VersionedTransaction.deserialize(wire);
      assert(transaction.message.staticAccountKeys[0]!.equals(payer.publicKey));
      if(transaction.version==='legacy')assert(Transaction.from(wire).verifySignatures());
      else{assert.equal(transaction.version,0);assert.equal(transaction.signatures.length,1);const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),payer.publicKey.toBuffer()]),format:'der',type:'spki'});assert(verifySignature(null,transaction.message.serialize(),key,transaction.signatures[0]!));}
      const signature = anchorPkg.utils.bytes.bs58.encode(transaction.signatures[0]!);
      const entry = { phase, label, signature, feePayer: payer.publicKey.toBase58(), wireBase64: wire.toString('base64'), wireSha256: hash(wire), expectedError: expectedError ?? null };
      transactions.push(entry);
      await writeFile(join(directory, 'transactions.json'), json(transactions), { mode: 0o600 });
      assert.equal(await connection.sendRawTransaction(wire, { skipPreflight: true, maxRetries: 0 }), signature);
      const until = Date.now() + 60_000; let retryAt = Date.now() + 2000;
      for (;;) {
        const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
        if (status?.confirmationStatus === 'finalized') break;
        assert(Date.now() < until, `Actual transaction failed to finalize: ${label}`);
        if (!status && Date.now() >= retryAt) {
          assert.equal(await connection.sendRawTransaction(wire, { skipPreflight: true, maxRetries: 0 }), signature);
          retryAt = Date.now() + 2000;
        }
        await sleep(150);
      }
      const receipt = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
      assert(receipt?.meta, `Missing actual receipt: ${label}`);
      if (expectedError) {
        const error = miningIdl.errors.find(row => row.name === expectedError); assert(error);
        assert.deepEqual(receipt.meta.err, { InstructionError: [transaction.version===0?1:0, { Custom: error.code }] });
        assert(receipt.meta.logMessages?.some(line => line.includes(`Error Code: ${expectedError}.`)));
      } else assert.equal(receipt.meta.err, null, `Actual ${label} failed: ${json(receipt.meta)}`);
      await writeFile(join(directory, `${String(sequence++).padStart(2, '0')}-${phase}-${label}.json`), json({ ...entry, receipt }), { mode: 0o600, flag: 'wx' });
      return { signature, wire, receipt };
    };
  }
  async function copy(connection: Connection, addresses: PublicKey[]) {
    const bank = await connection.getMultipleAccountsInfoAndContext(addresses, 'finalized');
    return { slot: bank.context.slot, rows: bank.value.map((account, index) => {
      assert(account, `Missing executed account ${addresses[index]}`);
      return { address: addresses[index]!, account: { ...account, data: Buffer.from(account.data) } };
    }) };
  }
  async function orderedPlan(connection:Connection,who:Keypair,earned:{leafHex:string;proofHex:string},prepared:PreparedMiningPublication,needsSetup:boolean){
    assert(lookupAddress&&lookupPin);const bank=await connection.getAccountInfoAndContext(lookupAddress,'finalized');assert(bank.value);
    const latest=await connection.getLatestBlockhashAndContext({commitment:'finalized',minContextSlot:bank.context.slot});
    const format=copyMiningClaimFormat({version:1,preset:'ordered-v0',lookupTable:{address:lookupAddress.toBase58(),owner:bank.value.owner.toBase58(),executable:bank.value.executable,dataHex:bank.value.data.toString('hex'),slot:bank.context.slot},expectedLookupTable:lookupPin,blockhashContextSlot:latest.context.slot},{programId:new ClaimPublicKey(ECONOMY.toBytes()),keepMint:new ClaimPublicKey(mint.publicKey.toBytes()),reserveOwner:new ClaimPublicKey(orderedReserveOwner!.toBytes())});
    const plan:MiningClaimMessageInput={wallet:new ClaimPublicKey(who.publicKey.toBytes()),root:Buffer.from(prepared.publication.root,'hex'),sequence:1n,day,totalCumulative:BigInt(prepared.publication.total),leaf:decodeMiningAllocationLeaf(Buffer.from(earned.leafHex,'hex')),proof:decodeMiningAllocationProof(Buffer.from(earned.proofHex,'hex')),blockhash:latest.value.blockhash,needsAta:needsSetup,needsMinerRecords:needsSetup};
    return {format,plan,messages:buildMiningClaimMessages({programId:new ClaimPublicKey(ECONOMY.toBytes()),keepMint:new ClaimPublicKey(mint.publicKey.toBytes()),reserveOwner:new ClaimPublicKey(orderedReserveOwner!.toBytes())},plan,format)};
  }
  function signOrdered(who:Keypair,bytes:Uint8Array){const tx=new VersionedTransaction(MessageV0.deserialize(bytes));tx.sign([who]);return tx.serialize();}
  function claimSdkReceipt(tx:Awaited<ReturnType<Connection['getTransaction']>>){
    assert(tx?.meta&&tx.transaction.message.version===0);const loaded=tx.meta.loadedAddresses;assert(loaded);
    return {...tx,transaction:{...tx.transaction,message:ClaimMessageV0.deserialize(tx.transaction.message.serialize())},meta:{...tx.meta,loadedAddresses:{writable:loaded.writable.map(k=>new ClaimPublicKey(k.toBytes())),readonly:loaded.readonly.map(k=>new ClaimPublicKey(k.toBytes()))}}};
  }
  function recordOrdered(label:string,sent:Awaited<ReturnType<ReturnType<typeof transport>>>,format:MiningClaimFormat){
    const tx=VersionedTransaction.deserialize(sent.wire);verifyMiningClaimV0Rpc(claimSdkReceipt(sent.receipt),tx.message.serialize(),sent.signature,format);
    assert.equal(typeof sent.receipt.meta!.computeUnitsConsumed,'number');assert(sent.receipt.meta!.computeUnitsConsumed!<=PHASE_E_MINING_CLAIM_FORMAT.computeUnitLimit);
    orderedExecutions.push({label,format,signature:sent.signature,slot:sent.receipt.slot,packetBytes:sent.wire.length,computeUnitsConsumed:sent.receipt.meta!.computeUnitsConsumed,err:sent.receipt.meta!.err});
  }
  await withCharterValidator(fixtures, 'funded-mining-publication-A', async fixture => {
    const { connection, payer, stranger, coreAuthority, working } = fixture;
    const genesisA = await connection.getGenesisHash(); retained.genesisA = genesisA;
    const pd = await connection.getAccountInfo(programDataAddress, 'confirmed'); assert(pd);
    retained.programData = Buffer.from(pd.data);
    const send = transport(connection, genesisA, hash(pd.data), 'A'), reserve = ata(payer.publicKey);
    const inventory = BigInt(PHASE_E_POLICY.mining.grossDailyCeilingKeep) * 10n ** BigInt(TOKEN.decimals);
    await send('authority-and-generated-wallets', payer, [
      instruction('initialize_seeker_authority', { guardian: stranger.publicKey, policy_key: publisher.publicKey, cluster_genesis: [...new PublicKey(genesisA).toBytes()] },
        { admin: payer.publicKey, program: ECONOMY, program_data: programDataAddress, authority, system_program: SystemProgram.programId }),
      ...[publisher, ...input.claimants].map(who => SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: who.publicKey, lamports: 100_000_000 })),
    ]);
    await send('create-actual-spl-inventory', payer, [
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint.publicKey, TOKEN.decimals, payer.publicKey, payer.publicKey),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, reserve, payer.publicKey, mint.publicKey),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, vault, config, mint.publicKey),
      createMintToInstruction(mint.publicKey, reserve, payer.publicKey, inventory),
      createSetAuthorityInstruction(mint.publicKey, payer.publicKey, AuthorityType.MintTokens, null),
      createSetAuthorityInstruction(mint.publicKey, payer.publicKey, AuthorityType.FreezeAccount, null),
    ], undefined, undefined, [mint]);
    await send('initialize-and-fund-economy', payer, [
      instruction('initialize_economy', { publisher: publisher.publicKey, genesis_day: bn(day) }, {
        admin: payer.publicKey, upgrade_authority: payer.publicKey, program: ECONOMY, program_data: programDataAddress,
        authority, config, mint: mint.publicKey, reserve_owner: payer.publicKey, reserve_ata: reserve, mining_vault: vault,
        token_program: TOKEN_PROGRAM_ID, associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID, system_program: SystemProgram.programId,
      }),
      createTransferCheckedInstruction(reserve, mint.publicKey, vault, payer.publicKey, inventory, TOKEN.decimals),
      instruction('set_mining_flags', { flags: 0 }, { signer: payer.publicKey, authority, config }),
    ]);
    const identity = { programId: ECONOMY, keepMint: mint.publicKey, reserveOwner: payer.publicKey };
    orderedReserveOwner=payer.publicKey;
    if(input.orderedV0){
      const [create,address]=AddressLookupTableProgram.createLookupTable({authority:payer.publicKey,payer:payer.publicKey,recentSlot:await connection.getSlot('finalized')});lookupAddress=address;
      await send('create-and-populate-common-lookup',payer,[create,AddressLookupTableProgram.extendLookupTable({lookupTable:address,authority:payer.publicKey,payer:payer.publicKey,addresses:miningClaimLookupAddresses(identity)})]);
      await send('freeze-common-lookup',payer,[AddressLookupTableProgram.freezeLookupTable({lookupTable:address,authority:payer.publicKey})]);
      const row=await connection.getAccountInfo(address,'finalized');assert(row);lookupPin={address:address.toBase58(),dataSha256:hash(row.data)};
    }
    for (const claimant of input.orderedV0?[]:input.claimants) {
      const before = await connection.getBalance(claimant.publicKey, 'finalized');
      const opened = await send('claimant-opens-' + claimant.publicKey.toBase58(), claimant, [
        buildOpenMinerRecordsInstruction(identity, { payer: claimant.publicKey, wallet: claimant.publicKey }),
        createAssociatedTokenAccountIdempotentInstruction(claimant.publicKey, ata(claimant.publicKey), claimant.publicKey, mint.publicKey),
      ]);
      const created = await copy(connection, [minerClaimPda(ECONOMY, claimant.publicKey), renownRecordPda(ECONOMY, claimant.publicKey), ata(claimant.publicKey)]);
      assert.equal(before - await connection.getBalance(claimant.publicKey, 'finalized'),
        opened.receipt.meta!.fee + created.rows.reduce((sum, row) => sum + row.account.lamports, 0), 'Claimant pays exact creation rent and fee');
      const raw = (row: Copied) => ({ address: row.address, ...row.account });
      assert.equal(decodeMinerClaim(raw(created.rows[0]!), { programId: ECONOMY, wallet: claimant.publicKey }).claimedTotal, 0n);
      const renown = decodeRenownRecord(raw(created.rows[1]!), { programId: ECONOMY, wallet: claimant.publicKey });
      assert.equal(renown.renownTotal, 0n); assert.equal(renown.daysAttested, 0n);
      assert.equal(AccountLayout.decode(created.rows[2]!.account.data).amount, 0n);
    }
    const trust: MiningPublicationTrust = { ...identity, expectedGenesisHash: genesisA,
      reviewedDeploymentSlot: Number(pd.data.readBigUInt64LE(4)), reviewedProgramDataSha256: hash(pd.data) };
    const prepared = await input.bridge.prepare({ connection, trust, publisher: publisher.publicKey,
      programData: Buffer.from(pd.data), programDataAddress, upgradeAuthority: payer.publicKey });
    assert.equal(prepared.publication.sequence, '1'); assert.equal(prepared.publication.day, day.toString());
    assert.equal(hash(prepared.manifestJson), prepared.sourceHash);
    const transaction = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(prepared.intentHex, 'hex')));
    transaction.sign([publisher]); const wire = transaction.serialize();
    await input.bridge.acceptSigned(wire);
    const published = await send('actual-source-publication', publisher, undefined, wire);
    const settlement = await input.bridge.settle(published.signature, wire);
    assert.equal(settlement.sourceHash, prepared.sourceHash); assert.equal(settlement.claims.length, 2);
    retained.prepared = prepared; retained.settlement = settlement;
    if(input.orderedV0){
      const who=input.claimants[0]!,earned=settlement.claims.find(c=>c.wallet===who.publicKey.toBase58())!;
      const ordered=await orderedPlan(connection,who,earned,prepared,true),setup=ordered.messages.transactions[0]!;assert.equal(setup.kind,'setup');
      const sent=await send('ordered-setup-original-A',who,undefined,signOrdered(who,setup.messageBytes));recordOrdered('original-A-setup',sent,ordered.format);
      const reader:MiningClaimReceiptReader={getGenesisHash:()=>connection.getGenesisHash(),getSlot:c=>connection.getSlot(c),getTransaction:async(sig,options)=>{const tx=await connection.getTransaction(sig,options);return tx?claimSdkReceipt(tx):null;},getMultipleAccountsInfoAndContext:async(keys,options)=>{const bank=await connection.getMultipleAccountsInfoAndContext(keys,options);return {context:bank.context,value:bank.value.map((r,i)=>r?{...r,address:keys[i]!,owner:new ClaimPublicKey(r.owner.toBytes())}:null)};}};
      setupReceipt=await createMiningClaimReceiptVerifier(reader,trust)({signature:sent.signature,signedTransaction:sent.wire,plan:ordered.plan,kind:'setup',format:ordered.format,blockhashContextSlot:ordered.format.blockhashContextSlot,sourceHash:prepared.sourceHash});
      assert.equal((setupReceipt as {paidKeepBaseUnits:string}).paidKeepBaseUnits,'0');
      // Measure real instruction lists at every specified depth without inventing
      // a production source/root: these synthetic paths are serialization only.
      for(const depth of [14,15,16]){let proof:MiningProofNode[]=[],r=hashMiningAllocationLeaf(ordered.plan.leaf),total=ordered.plan.leaf.cumulativeKeep;
        for(let i=0;i<depth;i++){const n={hash:hashMiningAllocationLeaf({...ordered.plan.leaf,wallet:Keypair.generate().publicKey.toBase58()}),sum:0n,isLeft:false};r=hashMiningAllocationNode(r,total,n.hash,0n);proof.push(n);}
        const measured=buildMiningClaimMessages({programId:new ClaimPublicKey(ECONOMY.toBytes()),keepMint:new ClaimPublicKey(mint.publicKey.toBytes()),reserveOwner:new ClaimPublicKey(payer.publicKey.toBytes())},{...ordered.plan,root:r,totalCumulative:total,proof},ordered.format);
        orderedPackets.push({depth,scope:'synthetic path packet measurement only',transactions:measured.transactions.map(t=>({kind:t.kind,packetBytes:t.packetBytes,messageSha256:t.messageSha256}))});
      }
    }
    const addresses = [payer.publicKey, stranger.publicKey, publisher.publicKey, mint.publicKey, reserve, vault, config, authority, root, epoch,
      ...input.claimants.flatMap((who,i) => input.orderedV0&&i===1?[who.publicKey]:[who.publicKey, minerClaimPda(ECONOMY, who.publicKey), renownRecordPda(ECONOMY, who.publicKey), ata(who.publicKey)]),...(input.orderedV0?[lookupAddress!]:[])];
    assert.equal(new Set(addresses.map(key => key.toBase58())).size, addresses.length);
    const original = await copy(connection, addresses); retained.originals = original.rows;
    const originalRoot = original.rows.find(row => row.address.equals(root)); assert(originalRoot);
    const decoded = coder.accounts.decode('AllocationRoot', originalRoot.account.data);
    assert((await coder.accounts.encode('AllocationRoot', decoded)).equals(originalRoot.account.data), 'Canonical root round-trip before mutation');
    assert.equal(BigInt(decoded.claims_count.toString()), 0n);
    const publishedAt = BigInt(decoded.published_at.toString()), agedAt = publishedAt - BigInt(PHASE_E_MINING_PUBLICATION.claimDelaySec);
    assert(agedAt >= 0n);
    const agedData = await coder.accounts.encode('AllocationRoot', { ...decoded, published_at: bn(agedAt) });
    const reconstructed = coder.accounts.decode('AllocationRoot', agedData);
    assert((await coder.accounts.encode('AllocationRoot', { ...reconstructed, published_at: bn(publishedAt) })).equals(originalRoot.account.data),
      'Only the explicit publishedAt field can change');
    const staged = original.rows.map(row => ({ address: row.address, account: {
      ...row.account, data: row.address.equals(root) ? agedData : Buffer.from(row.account.data),
    } }));
    retained.rootAudit = { address: root.toBase58(), originalPublishedAt: publishedAt.toString(), agedPublishedAt: agedAt.toString(),
      delaySeconds: PHASE_E_MINING_PUBLICATION.claimDelaySec, originalSha256: hash(originalRoot.account.data), agedSha256: hash(agedData) };
    retained.seed = { sourceWorking: working, sourceGenesis: genesisA, sourceSlot: original.slot, payer, stranger,
      coreAuthority, craftUpgradeAuthority: payer, accounts: staged };
    await writeFile(join(directory, 'original-publication-and-copy.json'), json({ genesisA, sourceHash: prepared.sourceHash,
      programArtifacts: EXPECTED, rootAudit: retained.rootAudit, originalAccounts: original.rows.map(encodedAccount),
      stagedAccounts: staged.map(encodedAccount), actualDatabaseEvidence: settlement.evidence }), { mode: 0o600, flag: 'wx' });
  });
  assert(retained.seed && retained.prepared && retained.settlement && retained.genesisA && retained.programData && retained.originals);
  const { seed, prepared, settlement, genesisA, programData, originals } = retained;
  const report: FundedMiningProgramReport = { genesisA, genesisB: '', sourceHash: prepared.sourceHash, claims: [],
    tamperRejected: false, dbReplayStable: settlement.dbReplayStable, allowedMutations: ['AllocationRoot.publishedAt'], copiedAccounts: seed.accounts.length };
  const conservation: Record<string, string> = {};
  await withCharterValidator({ ...fixtures, constructedGenesis: seed }, 'funded-mining-claims-B', async fixture => {
    const { connection } = fixture, genesisB = await connection.getGenesisHash();
    assert.notEqual(genesisB, genesisA); report.genesisB = genesisB;
    const pd = await connection.getAccountInfo(programDataAddress, 'finalized'); assert(pd);
    assert(pd.data.equals(programData), 'Copied runtime must preserve full reviewed ProgramData bytes and original generated authority');
    const actual = await copy(connection, seed.accounts.map(row => row.address));
    assert.deepEqual(actual.rows.map(encodedAccount), seed.accounts.map(encodedAccount));
    const originalByAddress = new Map(originals.map(row => [row.address.toBase58(), row]));
    for (const row of actual.rows) {
      const original = originalByAddress.get(row.address.toBase58()); assert(original);
      assert.equal(row.account.lamports, original.account.lamports); assert(row.account.owner.equals(original.account.owner));
      if (!row.address.equals(root)) assert(row.account.data.equals(original.account.data));
    }
    const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'finalized'); assert(clock?.data.length === 40);
    const actualRoot = actual.rows.find(row => row.address.equals(root)); assert(actualRoot);
    const rootState = decodeMiningRoot({ address: root, ...actualRoot.account }, { programId: ECONOMY, sequence: 1n });
    assert(clock.data.readBigInt64LE(32) >= rootState.publishedAt + BigInt(PHASE_E_MINING_PUBLICATION.claimDelaySec));
    const send = transport(connection, genesisB, hash(pd.data), 'B');
    const identity = { programId: ECONOMY, keepMint: mint.publicKey, reserveOwner: seed.payer.publicKey };
    if(input.orderedV0){
      // B is explicitly a distinct genesis. Keep A's table byte-identical in the
      // copied audit and create B's table by real instructions: no forged warm
      // slot, edited ALT metadata, or host-dependent warp-cache work is needed.
      const [create,address]=AddressLookupTableProgram.createLookupTable({authority:seed.payer.publicKey,payer:seed.payer.publicKey,recentSlot:await connection.getSlot('finalized')});lookupAddress=address;
      await send('create-and-populate-B-common-lookup',seed.payer,[create,AddressLookupTableProgram.extendLookupTable({lookupTable:address,authority:seed.payer.publicKey,payer:seed.payer.publicKey,addresses:miningClaimLookupAddresses(identity)})]);
      await send('freeze-B-common-lookup',seed.payer,[AddressLookupTableProgram.freezeLookupTable({lookupTable:address,authority:seed.payer.publicKey})]);
      const row=await connection.getAccountInfo(address,'finalized');assert(row);lookupPin={address:address.toBase58(),dataSha256:hash(row.data)};
    }
    // Fee payers' SOL changes are explicitly measured separately; all protected
    // program/token account bytes, owners, lamports and rent epochs must persist.
    const protectedKeys = seed.accounts.filter(row => !input.claimants.some(who => who.publicKey.equals(row.address))).map(row => row.address);
    const snapshot = async () => (await copy(connection, protectedKeys)).rows.map(encodedAccount);
    const allBefore = await snapshot();
    const claimOrder=input.orderedV0?input.claimants.map(who=>settlement.claims.find(c=>c.wallet===who.publicKey.toBase58())!):settlement.claims;
    for (const [index, earned] of claimOrder.entries()) {
      const who = input.claimants.find(key => key.publicKey.toBase58() === earned.wallet); assert(who);
      const leaf = decodeMiningAllocationLeaf(Buffer.from(earned.leafHex, 'hex'));
      const proof = decodeMiningAllocationProof(Buffer.from(earned.proofHex, 'hex'));
      assert.equal(leaf.wallet, earned.wallet); assert.equal(leaf.sequence, 1n);
      assert(verifyMiningAllocationProof(leaf, proof, Buffer.from(prepared.publication.root, 'hex'), BigInt(prepared.publication.total)));
      assert(leaf.cumulativeKeep > 0n && leaf.cumulativeRenown === 1n && leaf.cumulativeDays === 1n);
      const before = await snapshot();
      if (index === 0) {
        await send('tampered-earned-renown', who, [buildClaimMiningInstruction(identity, {
          leaf: { ...leaf, cumulativeRenown: 0n }, proof,
        })], undefined, 'InvalidMiningProof');
        assert.deepEqual(await snapshot(), before, 'Tampered earned counter must preserve all protected state');
        assert(proof.length > 0); const tampered = proof.map(node => ({ ...node, hash: Uint8Array.from(node.hash) }));
        tampered[0]!.hash[0] = tampered[0]!.hash[0]! ^ 1;
        await send('tampered-allocation-proof', who, [buildClaimMiningInstruction(identity, { leaf, proof: tampered })], undefined, 'InvalidMiningProof');
        assert.deepEqual(await snapshot(), before, 'Tampered proof must preserve all protected state');
        report.tamperRejected = true;
      }

      const ordered=input.orderedV0?await orderedPlan(connection,who,earned,prepared,index===1):null;
      if(ordered&&index===1){const setup=ordered.messages.transactions[0]!;assert.equal(setup.kind,'setup');const opened=await send('ordered-setup-B-'+index,who,undefined,signOrdered(who,setup.messageBytes));recordOrdered('B-setup-'+index,opened,ordered.format);protectedKeys.push(minerClaimPda(ECONOMY,who.publicKey),renownRecordPda(ECONOMY,who.publicKey),ata(who.publicKey));}
      const beforeRows = (await copy(connection, [config, vault, ata(who.publicKey), root])).rows;
      const configBefore = decodeMiningConfig({ address: config, ...beforeRows[0]!.account }, identity);
      const balanceBefore = await connection.getBalance(who.publicKey, 'finalized');
      const claimed = ordered?await send('ordered-claim-'+index,who,undefined,signOrdered(who,ordered.messages.transactions.at(-1)!.messageBytes)):await send('claim-' + index, who, [buildClaimMiningInstruction(identity, { leaf, proof })]);
      if(ordered)recordOrdered('B-claim-'+index,claimed,ordered.format);
      assert.equal(balanceBefore - await connection.getBalance(who.publicKey, 'finalized'), claimed.receipt.meta!.fee,
        'Claimant alone pays the actual claim transaction fee');
      const afterRows = (await copy(connection, [config, vault, ata(who.publicKey), root,
        minerClaimPda(ECONOMY, who.publicKey), renownRecordPda(ECONOMY, who.publicKey)])).rows;
      const configAfter = decodeMiningConfig({ address: config, ...afterRows[0]!.account }, identity);
      assert.equal(configAfter.totalClaimed - configBefore.totalClaimed, leaf.cumulativeKeep);
      assert.equal(configAfter.taxHighwater, configBefore.taxHighwater); assert.equal(configAfter.taxPaid, configBefore.taxPaid);
      assert.equal(AccountLayout.decode(beforeRows[1]!.account.data).amount - AccountLayout.decode(afterRows[1]!.account.data).amount, leaf.cumulativeKeep);
      assert.equal(AccountLayout.decode(afterRows[2]!.account.data).amount - AccountLayout.decode(beforeRows[2]!.account.data).amount, leaf.cumulativeKeep);
      const miner = decodeMinerClaim({ address: afterRows[4]!.address, ...afterRows[4]!.account }, { programId: ECONOMY, wallet: who.publicKey });
      const renown = decodeRenownRecord({ address: afterRows[5]!.address, ...afterRows[5]!.account }, { programId: ECONOMY, wallet: who.publicKey });
      assert.equal(miner.claimedTotal, leaf.cumulativeKeep); assert.equal(miner.lastSequence, leaf.sequence);
      assert.equal(renown.renownTotal, leaf.cumulativeRenown); assert.equal(renown.daysAttested, leaf.cumulativeDays); assert.equal(renown.lastSequence, leaf.sequence);
      const after = await snapshot();
      if(ordered){const replay=await orderedPlan(connection,who,earned,prepared,false),failed=await send('ordered-replay-'+index,who,undefined,signOrdered(who,replay.messages.transactions[0]!.messageBytes),'InvalidMiningClaim');recordOrdered('B-failed-replay-'+index,failed,replay.format);}
      else await send('replay-' + index, who, [buildClaimMiningInstruction(identity, { leaf, proof })], undefined, 'InvalidMiningClaim');
      assert.deepEqual(await snapshot(), after, 'Claim replay cannot pay or increment any protected record');
      report.claims.push({ wallet: earned.wallet, keep: leaf.cumulativeKeep.toString(), renown: renown.renownTotal.toString(), days: renown.daysAttested.toString(), replayPreserved: true });
      await writeFile(join(directory, `claim-${index}-measured.json`), json({ earned, before: beforeRows.map(encodedAccount),
        after: afterRows.map(encodedAccount), miner, renown, signature: claimed.signature, fee: claimed.receipt.meta!.fee }), { mode: 0o600, flag: 'wx' });
    }
    const finalRows = await copy(connection, [config, vault, root, ata(seed.payer.publicKey), mint.publicKey,
      ...input.claimants.map(who => ata(who.publicKey))]);
    const finalConfig = decodeMiningConfig({ address: config, ...finalRows.rows[0]!.account }, identity);
    const finalRoot = decodeMiningRoot({ address: root, ...finalRows.rows[2]!.account }, { programId: ECONOMY, sequence: 1n });
    assert.equal(finalConfig.totalClaimed, BigInt(prepared.publication.total)); assert.equal(finalRoot.claimsCount, 2n);
    const vaultAfter = AccountLayout.decode(finalRows.rows[1]!.account.data).amount;
    const reserveAfter = AccountLayout.decode(finalRows.rows[3]!.account.data).amount;
    const supply = MintLayout.decode(finalRows.rows[4]!.account.data).supply;
    const recipients = finalRows.rows.slice(5).reduce((sum, row) => sum + AccountLayout.decode(row.account.data).amount, 0n);
    const capturedFunding = JSON.parse(prepared.manifestJson).funding as { vaultAmount: string };
    const funded = BigInt(capturedFunding.vaultAmount), budget = BigInt(prepared.publication.budgetGross);
    const gross = BigInt(prepared.publication.freeGross) + BigInt(prepared.publication.deedGross);
    const recycle = BigInt(prepared.publication.recycle), tax = finalConfig.taxHighwater - finalConfig.taxPaid;
    // A funded ceiling is not an instruction to spend the whole vault. D149's
    // denominator intentionally leaves unallocated surplus in this small cohort.
    assert.equal(funded, budget); assert(gross <= budget); const unallocated = funded - gross;
    assert.equal(gross, BigInt(prepared.publication.playerNet) + recycle + BigInt(prepared.publication.tax));
    assert.equal(vaultAfter, funded - recycle - finalConfig.totalClaimed);
    assert.equal(vaultAfter, unallocated + tax); assert(vaultAfter >= tax);
    const originalReserve = originals.find(row => row.address.equals(ata(seed.payer.publicKey))); assert(originalReserve);
    assert.equal(reserveAfter, AccountLayout.decode(originalReserve.account.data).amount);
    assert.equal(reserveAfter, recycle); assert.equal(recipients, finalConfig.totalClaimed);
    assert.equal(vaultAfter + reserveAfter + recipients, supply);
    Object.assign(conservation, { funded: funded.toString(), sourceGross: gross.toString(), unallocated: unallocated.toString(),
      paidClaims: recipients.toString(), reserveRecycle: reserveAfter.toString(), outstandingTax: tax.toString(), vaultAfter: vaultAfter.toString(), mintSupply: supply.toString() });
    await writeFile(join(directory, 'claims-protected-before-after.json'), json({ genesisA, genesisB, before: allBefore, after: await snapshot() }), { mode: 0o600, flag: 'wx' });
  });
  if(input.orderedV0)report.ordered={setupReceipt,packets:orderedPackets,executions:orderedExecutions,receiptScope:'A and B each create and freeze their own real common table; A table is copied byte-identical for audit, never rewritten to fabricate warmth. Production historical setup verifier accepted actual genesisA; copied-genesisB claim/failure exercise exactv0/loaded keys and direct SBF conservation only. No B historical receipt or same-genesis API settlement claim.'};
  await writeFile(join(directory, 'result.json'), json({ ...report, programArtifacts: EXPECTED, rootAudit: retained.rootAudit,
    actualFinalizedTransactions: transactions.length, conservation,
    scope: 'Executed source-derived paid/free claims under explicit copied-genesis elapsed fixture; no natural-delay, same-genesis API claim settlement, upstream live-history or Charter authority',
  }), { mode: 0o600, flag: 'wx' });
  console.log('Funded-mining source/SBF report: ' + join(directory, 'result.json'));
  return report;
}
