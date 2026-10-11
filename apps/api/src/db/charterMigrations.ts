/** Existing-clan registration storage. Current clan authority is captured in
 * SQL; registration evidence never grants historical liability clearance. */
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {CLANS,PHASE_E_CHARTER_ADMISSION} from '@shardkeep/shared';
import {CharterCreationOriginalSchema} from '@shardkeep/shared/charterApi';
import {charterAssetPda,charterConfigPda,charterCreationPda,charterExecutorPda,charterFreezePda,charterMintPda,charterPda,hashCharterMetadata,decodeCharterRegistrationPermit} from '@shardkeep/chain/charter-protocol';
import {verifyCharterCreationQuote,verifyCharterCreationPacket,type CharterCreationQuote,type CharterCreationPacket} from '@shardkeep/chain/charter-creation-preparation';
import type {CharterCreationCancellationOriginal} from '@shardkeep/chain/charter-creation-cancellation';
import {verifyCharterCreationSignedWire} from '@shardkeep/chain/charter-creation-wire';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbTx} from './client';
import {phaseECharterEnabled} from '../config';
import {HttpError} from '../lib/errors';
export type MigrationRequest={clanId:string;idempotencyKey:string};
export type MigrationConfiguration={domain:{genesisHash:string;economyProgram:string;craftProgram:string};metadataUriPrefix:string};
export type MigrationWire={signedTransactionHex:string;signature:string;wireSha256:string;messageSha256:string};
export interface MigrationState {
 readonly version:1;readonly id:string;readonly actor:string;readonly request:MigrationRequest;
 readonly clan:{id:string;name:string;tag:string;inviteMode:'open'|'invite'};
 readonly snapshot:{memberCount:number;chestShards:string;capturedAt:string;commitment:string};
 readonly snapshotHash:string;readonly original:CharterCreationCancellationOriginal;
 readonly status:'pending'|'issuing'|'prepared'|'signed'|'controlled'|'cancelled';
 readonly attempt:null|{id:string;candidateHex:string;policySigner:string;quote:CharterCreationQuote};
 readonly preparation:null|{policySignatureHex:string;packet:CharterCreationPacket};
 readonly signed:MigrationWire|null;readonly terminal:null|{id:string;outcome:'controlled'|'cancelled';record:unknown};
 readonly inventory:{version:1;revision:string;count:number;messages:readonly string[]};
}
const uuid=z.uuid().refine(v=>v===v.toLowerCase()&&v!=='00000000-0000-0000-0000-000000000000');
const address=z.string().refine(v=>{try{const p=new PublicKey(v);return p.toBase58()===v&&!p.equals(PublicKey.default);}catch{return false;}});
const hash=z.string().regex(/^[0-9a-f]{64}$/),natural=z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v=>BigInt(v)<(1n<<64n));
const requestSchema=z.object({clanId:uuid,idempotencyKey:uuid}).strict();
const configSchema=z.object({domain:z.object({genesisHash:address,economyProgram:address,craftProgram:address}).strict(),metadataUriPrefix:z.string().min(1).max(256).refine(v=>{try{const u=new URL(v);return Buffer.byteLength(v)<=256&&u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}})}).strict();
const wireSchema=z.object({signedTransactionHex:z.string().min(132).max(2464).regex(/^(?:[0-9a-f]{2})+$/),signature:z.string().min(64).max(88),wireSha256:hash,messageSha256:hash}).strict();
const stateSchema=z.object({version:z.literal(1),id:uuid,actor:address,request:requestSchema,
 clan:z.object({id:uuid,name:z.string().min(CLANS.nameMinLen).max(CLANS.nameMaxLen),tag:z.string().min(CLANS.tagMinLen).max(CLANS.tagMaxLen),inviteMode:z.enum(['open','invite'])}).strict(),
 snapshot:z.object({memberCount:z.number().int().min(1).max(CLANS.rosterCap),chestShards:natural,capturedAt:z.string(),commitment:hash}).strict(),
 snapshotHash:hash,original:CharterCreationOriginalSchema,status:z.enum(['pending','issuing','prepared','signed','controlled','cancelled']),
 attempt:z.object({id:uuid,candidateHex:z.string().regex(/^[0-9a-f]{322}$/),policySigner:address,quote:z.unknown()}).strict().nullable(),
 preparation:z.object({policySignatureHex:z.string().regex(/^[0-9a-f]{128}$/),packet:z.unknown()}).strict().nullable(),signed:wireSchema.nullable(),
 terminal:z.object({id:uuid,outcome:z.enum(['controlled','cancelled']),record:z.unknown()}).strict().nullable(),
 inventory:z.object({version:z.literal(1),revision:z.enum(['0','1']),count:z.number().int().min(0).max(1),messages:z.array(z.string().regex(/^[0-9a-f]{322}$/)).max(1)}).strict()}).strict();
const fail=(suffix:string,status=503):never=>{throw new HttpError(status,'Clan Charter migration is unavailable','CLAN_CHARTER_MIGRATION_'+suffix);};
function translate(error:unknown):never {if(error instanceof HttpError)throw error;let c=error;for(let n=0;n<8&&c&&typeof c==='object';n++){
 if('code'in c){if(['55P03','40P01'].includes(String(c.code)))return fail('BUSY',409);if(c.code==='23505')return fail('CONFLICT',409);if(c.code==='42501')return fail('OWNER');}
 if('message'in c&&typeof c.message==='string'&&/^CLAN_CHARTER_MIGRATION_[A-Z_]+$/.test(c.message)){const suffix=c.message.slice('CLAN_CHARTER_MIGRATION_'.length);return fail(suffix,suffix==='NOT_FOUND'?404:suffix==='CONFLICT'?409:503);}c='cause'in c?c.cause:undefined;}return fail('HELD');}
const json=(v:unknown)=>JSON.stringify(v,(_k,x:unknown)=>typeof x==='bigint'?x.toString():x);
const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
function identity(actor:string,id?:string){if(!address.safeParse(actor).success||id!==undefined&&!uuid.safeParse(id).success)return fail('INPUT',400);}
function quoteFor(s:MigrationState,input:unknown){const q=verifyCharterCreationQuote(input);if(!isDeepStrictEqual(q.packetInput.original,s.original)||s.attempt&&(q.packetInput.candidateHex!==s.attempt.candidateHex||q.packetInput.policySigner!==s.attempt.policySigner))return fail('HELD');return q;}
function preparationFor(s:MigrationState,input:unknown){if(!s.attempt)return fail('HELD');const p=stateSchema.shape.preparation.unwrap().parse(input),q=quoteFor(s,s.attempt.quote),{candidateHex,...rest}=q.packetInput;
 return {policySignatureHex:p.policySignatureHex,packet:verifyCharterCreationPacket({...rest,candidate:Buffer.from(candidateHex,'hex'),policySignature:Buffer.from(p.policySignatureHex,'hex')},p.packet)};}
function wireFor(s:MigrationState,input:unknown){if(!s.preparation)return fail('HELD');const v=wireSchema.parse(input),w=verifyCharterCreationSignedWire({wallet:new PublicKey(s.actor),intentBytes:Buffer.from(s.preparation.packet.messageHex,'hex'),signedTransaction:Buffer.from(v.signedTransactionHex,'hex')});
 if(w.signature!==v.signature||w.wireSha256!==v.wireSha256||w.messageSha256!==v.messageSha256)return fail('HELD');return v;}
function state(input:unknown,actor:string,id?:string):MigrationState {
 const v=stateSchema.parse(input);if(v.actor!==actor||id!==undefined&&v.id!==id)return fail('NOT_FOUND',404);
 if(v.request.clanId!==v.clan.id||v.original.clanId!==v.clan.id||v.original.payer!==actor||v.original.creationIntentId!==v.id||v.original.metadata.name!==v.clan.name
  ||v.snapshot.commitment!==v.original.admissionCommitment||v.inventory.count!==v.inventory.messages.length||v.inventory.revision!==String(v.inventory.count)
  ||v.status!==(v.terminal?.outcome??(v.signed?'signed':v.preparation?'prepared':v.attempt?'issuing':'pending')))return fail('HELD');
 const s=v as MigrationState;if(s.attempt){if(s.inventory.count!==1||s.inventory.messages[0]!==s.attempt.candidateHex)return fail('HELD');s.attempt.quote=quoteFor(s,s.attempt.quote);}
 else if(s.inventory.count!==0||s.preparation||s.signed)return fail('HELD');
 if(s.preparation)Object.assign(s.preparation,preparationFor(s,s.preparation));if(s.signed)wireFor(s,s.signed);if(s.terminal)observationFor(s,s.terminal.record);
 return freeze(s);
}
async function readIn(tx:DbTx,actor:string,id:string){const [r]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_migration_read(${actor},${id}::uuid) value`);return state(r?.value,actor,id);}
async function byKeyIn(tx:DbTx,actor:string,key:string){await tx.execute(sql`select public.shardkeep_charter_migration_owner(),public.shardkeep_charter_retirement_source()`);
 const [r]=await tx.execute<{id:string}>(sql`select id from public.charter_migrations where actor=${actor} and idempotency_key=${key}::uuid`);return r?readIn(tx,actor,r.id):null;}
export function createClanCharterMigrationsStore(db:Db){
 if('rollback'in db)return fail('TOP_LEVEL');
 async function read(actor:string,id:string){identity(actor,id);try{return await db.transaction(tx=>readIn(tx,actor,id),{isolationLevel:'read committed'});}catch(e){return translate(e);}}
 async function readByKey(actor:string,key:string){identity(actor,key);try{return await db.transaction(tx=>byKeyIn(tx,actor,key),{isolationLevel:'read committed'});}catch(e){return translate(e);}}
 async function create(actor:string,input:MigrationRequest,configuration:MigrationConfiguration|null){identity(actor);const request=requestSchema.parse(input);
  try{return await db.transaction(async tx=>{const prior=await byKeyIn(tx,actor,request.idempotencyKey);if(prior){if(prior.request.clanId!==request.clanId)return fail('CONFLICT',409);return prior;}
   if(!phaseECharterEnabled())return fail('DISABLED');const config=configSchema.parse(configuration),id=randomUUID();
   const [row]=await tx.execute<{name:string}>(sql`select name from public.clans where id=${request.clanId}::uuid and leader_wallet=${actor}`);if(!row)return fail('NOT_FOUND',404);
   const economy=new PublicKey(config.domain.economyProgram),craft=new PublicKey(config.domain.craftProgram),cid=request.clanId,asset=charterMintPda(craft,cid),cp=(seed:string)=>PublicKey.findProgramAddressSync([Buffer.from(seed)],craft)[0].toBase58();
   const metadata={name:row.name,uri:config.metadataUriPrefix+cid},original={creationIntentId:id,clanId:cid,payer:actor,metadata:{...metadata,hash:hashCharterMetadata(metadata).toString('hex')},
    chain:{...config.domain,config:charterConfigPda(economy).toBase58(),craftControl:cp('charter_control'),collection:cp('charter_collection'),collectionAuthority:cp('charter_collection_authority'),charter:charterPda(economy,cid).toBase58(),asset:asset.toBase58(),assetBinding:charterAssetPda(economy,asset).toBase58(),freezeAuthority:charterFreezePda(craft,cid).toBase58(),executor:charterExecutorPda(economy,cid).toBase58(),creationReceipt:charterCreationPda(economy,id).toBase58()}};
   CharterCreationOriginalSchema.parse({...original,admissionCommitment:'0'.repeat(64)});
   await tx.execute(sql`insert into public.charter_migrations(id,actor,idempotency_key,clan_id,original) values(${id}::uuid,${actor},${request.idempotencyKey}::uuid,${cid}::uuid,${json(original)}::jsonb)`);
   if(!phaseECharterEnabled())return fail('DISABLED');return readIn(tx,actor,id);
  },{isolationLevel:'read committed'});}catch(e){return translate(e);}}
 async function beginAttempt(actor:string,id:string,input:unknown,timing:{elapsedMs:number}){const saved=await read(actor,id);if(saved.terminal||saved.attempt)return saved;if(!phaseECharterEnabled())return fail('DISABLED');
  try{const quote=quoteFor(saved,input),elapsed=z.number().finite().min(0).max(PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs).parse(timing.elapsedMs),started=performance.now();
   return await db.transaction(async tx=>{const s=await readIn(tx,actor,id);if(s.terminal||s.attempt)return s;quoteFor(s,quote);const age=elapsed+performance.now()-started;
    if(!phaseECharterEnabled())return fail('DISABLED');if(age>PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs)return fail('STALE');
    await tx.execute(sql`insert into public.charter_migration_attempts(migration_id,record) values(${id}::uuid,${json({quote,elapsedMs:age})}::jsonb)`);if(!phaseECharterEnabled())return fail('DISABLED');return readIn(tx,actor,id);
   },{isolationLevel:'read committed'});}catch(e){return translate(e);}}
 async function artifact(actor:string,id:string,kind:'preparation'|'signed',input:unknown,attemptId?:string){const saved=await read(actor,id);if(saved.terminal)return saved;
  try{if(kind==='preparation'&&saved.attempt?.id!==attemptId)return fail('CONFLICT',409);const check=kind==='preparation'?preparationFor:wireFor,value=check(saved,input),prior=kind==='preparation'?saved.preparation:saved.signed;
   if(prior){if(!isDeepStrictEqual(prior,value))return fail('CONFLICT',409);return saved;}
   return await db.transaction(async tx=>{const s=await readIn(tx,actor,id);if(s.terminal)return s;check(s,value);const prior=kind==='preparation'?s.preparation:s.signed;if(prior){if(!isDeepStrictEqual(prior,value))return fail('CONFLICT',409);return s;}
    if(kind==='preparation')await tx.execute(sql`insert into public.charter_migration_preparations(migration_id,record) values(${id}::uuid,${json(value)}::jsonb)`);
    else await tx.execute(sql`insert into public.charter_migration_wires(migration_id,record) values(${id}::uuid,${json(value)}::jsonb)`);return readIn(tx,actor,id);
   },{isolationLevel:'read committed'});}catch(e){return translate(e);}}
 async function terminal(actor:string,id:string,outcome:'controlled'|'cancelled',input:unknown){const saved=await read(actor,id);if(saved.terminal)return saved;
  try{const value=observationFor(saved,input);if((value.outcome==='minted')!==(outcome==='controlled'))return fail('EVIDENCE');
   return await db.transaction(async tx=>{const s=await readIn(tx,actor,id);if(s.terminal)return s;observationFor(s,value);
    await tx.execute(sql`insert into public.charter_migration_terminals(migration_id,outcome,observation) values(${id}::uuid,${outcome},${json(value)}::jsonb)`);return readIn(tx,actor,id);
   },{isolationLevel:'read committed'});}catch(e){return translate(e);}}
 return Object.freeze({create,read,readByKey,beginAttempt,retainPreparation:(actor:string,id:string,attemptId:string,input:{policySignatureHex:string;packet:unknown})=>artifact(actor,id,'preparation',input,attemptId),
  retainSigned:(actor:string,id:string,input:MigrationWire)=>artifact(actor,id,'signed',input),complete:(actor:string,id:string,input:unknown)=>terminal(actor,id,'controlled',input),cancel:(actor:string,id:string,input:unknown)=>terminal(actor,id,'cancelled',input)});
}

const slot = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const integer = z.string().max(20).regex(/^-?(?:0|[1-9][0-9]*)$/).refine(value => BigInt(value) >= -(1n << 63n) && BigInt(value) < (1n << 63n));
const positive = integer.refine(value => BigInt(value) > 0n);
const account = z.object({ address, owner: address.nullable(), executable: z.boolean().nullable(), dataSha256: hash.nullable() }).strict();
const source = z.object({ trust: z.literal('trusted-finalized-rpc-reviewed-program'), stateProvenance: z.literal('fresh-reviewed-deployment'), genesisHash: address,
  programs: z.array(z.object({ programId: address, reviewedDeploymentSlot: slot, reviewedProgramDataSha256: hash, upgradeAuthority: address.nullable() }).strict()).length(3),
  accounts: z.array(account).length(14) }).strict();
const noAuthority = { transactionProofVerified: z.literal(false), paymentAuthorized: z.literal(false), activationAuthorized: z.literal(false),
  reservationReleaseAuthorized: z.literal(false) };
const mint = z.object({ version: z.literal(1), creationIntentId: uuid, clanId: uuid, payer: address, charter: address, asset: address, creationReceipt: address,
  metadataHash: hash, admissionCommitment: hash, permitId: z.string().length(32).regex(/^[0-9a-f]+$/), slot, unixTimestamp: positive, createdAt: integer,
  source, finalizedMintObserved: z.literal(true), ...noAuthority }).strict();
const baseObservation = { version: z.literal(1), original: z.unknown(),
  inventory: z.object({ version: z.literal(1), revision: z.enum(['0', '1']), count: z.union([z.literal(0), z.literal(1)]),
    messages: z.array(z.object({ messageHex: z.string().length(322).regex(/^[0-9a-f]+$/),
      permitId: z.string().length(32).regex(/^[0-9a-f]+$/), expiry: integer }).strict()).max(1) }).strict(),
  slot, unixTimestamp: positive, source, inventoryAuthenticated: z.literal(false), signingAuthorized: z.literal(false), refundAuthorized: z.literal(false), ...noAuthority };
const observationSchema = z.discriminatedUnion('outcome', [z.object({ ...baseObservation, outcome: z.literal('minted'), mint }).strict(),
  z.object({ ...baseObservation, outcome: z.literal('absent-after-expiry') }).strict()]);
function observationFor(state:MigrationState,value:unknown) {
  const messages=state.inventory.messages.map(messageHex=>{const p=decodeCharterRegistrationPermit(Buffer.from(messageHex,'hex'));return {messageHex,permitId:Buffer.from(p.permitId).toString('hex'),expiry:p.expiry};});
  const saved={permitInventory:{...state.inventory,messages},admission:{commitment:state.original.admissionCommitment}};
  const v=observationSchema.parse(JSON.parse(json(value))),record={original:state.original},c=state.original;
  if (!isDeepStrictEqual(v.original, record.original) || v.inventory.revision !== saved.permitInventory.revision || v.inventory.count !== saved.permitInventory.count
    || !isDeepStrictEqual(v.inventory.messages, saved.permitInventory.messages.map(m => ({ messageHex: m.messageHex, permitId: m.permitId, expiry: m.expiry.toString() })))) return fail('STALE_INVENTORY');
  if(state.attempt&&!isDeepStrictEqual(v.source.programs,state.attempt.quote.observation.source.programs))return fail('HELD');
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const programIds = [c.chain.economyProgram, c.chain.craftProgram, 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'];
  const addresses = programIds.flatMap(id => [id, PublicKey.findProgramAddressSync([new PublicKey(id).toBuffer()], loader)[0].toBase58()]);
  addresses.push(c.chain.config, c.chain.craftControl, c.chain.charter, c.chain.creationReceipt, c.chain.assetBinding, c.chain.asset,
    c.chain.collection, SYSVAR_CLOCK_PUBKEY.toBase58());
  if (v.source.genesisHash !== c.chain.genesisHash || v.source.programs.some((p, i) => p.programId !== programIds[i] || p.reviewedDeploymentSlot > v.slot)
    || v.source.accounts.some((a, i) => a.address !== addresses[i])) return fail('HELD');
  for (const [i, a] of v.source.accounts.entries()) {
    const absent = v.outcome === 'absent-after-expiry' && i >= 8 && i <= 11;
    if (absent ? a.owner !== null || a.executable !== null || a.dataSha256 !== null : a.owner === null || a.executable === null || a.dataSha256 === null) return fail('HELD');
    if (i < 6 && (a.owner !== loader.toBase58() || a.executable !== (i % 2 === 0))) return fail('HELD');
    if (i < 6 && i % 2 === 1 && a.dataSha256 !== v.source.programs[Math.floor(i / 2)]!.reviewedProgramDataSha256) return fail('HELD');
    const owner = i === 7 ? c.chain.craftProgram : i === 11 || i === 12 ? programIds[2]
      : i === 13 ? 'Sysvar1111111111111111111111111111111111111' : c.chain.economyProgram;
    if (i >= 6 && !absent && (a.owner !== owner || a.executable !== false)) return fail('HELD');
  }
  if (v.outcome === 'minted') {
    const m = v.mint;
    if (saved.permitInventory.count !== 1 || m.creationIntentId !== c.creationIntentId || m.clanId !== c.clanId || m.payer !== c.payer
      || m.charter !== c.chain.charter || m.asset !== c.chain.asset || m.creationReceipt !== c.chain.creationReceipt
      || m.metadataHash !== c.metadata.hash || m.admissionCommitment !== saved.admission.commitment || m.permitId !== saved.permitInventory.messages[0]!.permitId
      || m.slot !== v.slot || m.unixTimestamp !== v.unixTimestamp || BigInt(m.createdAt) <= 0n || BigInt(m.createdAt) > BigInt(v.unixTimestamp)
      || !isDeepStrictEqual(m.source, v.source)) return fail('HELD');
  } else if (saved.permitInventory.messages.some(m => m.expiry >= BigInt(v.unixTimestamp))) return fail('HELD');
  return v;
}
