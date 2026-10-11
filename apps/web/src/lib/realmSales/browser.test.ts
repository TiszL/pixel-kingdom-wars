/** @vitest-environment happy-dom */
import {Keypair,Message,PublicKey,Transaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {RealmSalePreparationSchema} from '@shardkeep/shared/realmSalesApi';
import {createRealmSalePurchaseArgs} from '../../../../../packages/chain/src/seekerRealmSaleProtocol';
import {buildRealmSaleMessage} from '../../../../../packages/chain/src/seekerRealmSaleMessage';
import idl from '../../../../../packages/chain/src/idl/shardkeep_economy.json' with {type:'json'};
import {authCookies} from '../../auth/authCookieCoordinator';
import type {GameWallet} from '../../auth/useGameWallet';
import {useApp} from '../../state/store';
import {mutationGate} from '../mutationGate';
import {realmSaleIdentity,createRealmSaleBrowserPorts} from './browser';
import {verifySignedRealmSale} from './signing';
import {failedRealmSaleOriginal,prepareRealmSaleOriginal,savedRealmSaleOriginal,reviewRealmSaleOriginal,submitRealmSaleOriginal} from './transport';
vi.mock('./transport',()=>({failedRealmSaleOriginal:vi.fn(),prepareRealmSaleOriginal:vi.fn(),savedRealmSaleOriginal:vi.fn(),reviewRealmSaleOriginal:vi.fn(),submitRealmSaleOriginal:vi.fn()}));
vi.mock('../mutationGate',()=>({mutationGate:{getSnapshot:vi.fn(()=>true)}}));
const key=(n:number)=>Keypair.fromSeed(Buffer.alloc(32,n));
function realmSaleSigningFixture(access=false,quota=false,alias='none'){
 const signer=key(1),other=key(2),dev=key(3),seller=alias==='buyer-seller'||alias==='all'?signer.publicKey:other.publicKey;
 const developer=alias==='buyer-dev'||alias==='all'?signer.publicKey:alias==='seller-dev'?seller:dev.publicKey;
 const args=createRealmSalePurchaseArgs({saleId:Buffer.alloc(16,5),spot:0,realm:0,round:0n,day:100n,seller,developer,priorExpiry:0n,validAfter:8_640_000n,validUntil:8_640_600n});
 const blockhash=key(4).publicKey.toBase58(),plan=buildRealmSaleMessage(new PublicKey(idl.address),{wallet:signer.publicKey,args,blockhash,needsAccess:access,needsQuota:quota});
 const rent=BigInt(plan.expectedNewAccounts.length)*1000n,fee=5000n,required=rent+fee+plan.buyerNetPaymentLamports;
 const p=RealmSalePreparationSchema.parse({version:1,wallet:signer.publicKey.toBase58(),idempotencyKey:'00000000-0000-4000-8000-000000000001',saleId:Buffer.from(args.saleId).toString('hex'),spot:0,realm:0,
  terms:{round:'0',day:'100',seller:seller.toBase58(),developer:developer.toBase58(),priorExpiry:'0',validAfter:args.validAfter.toString(),validUntil:args.validUntil.toString()},
  source:{revision:'test-r1',genesisHash:key(6).publicKey.toBase58(),programId:idl.address,programDataSha256:'ab'.repeat(32),reviewedDeploymentSlot:1,termProofHash:'cd'.repeat(32),snapshotHash:'ef'.repeat(32),termSlot:2,initialSlot:2,blockhashSlot:2,feeSlot:2,costSlot:2,admissionSlot:2},
  quote:{blockhash,lastValidBlockHeight:100,unixTimestamp:args.validAfter.toString(),needsAccess:access,needsQuota:quota,quotaRemaining:10,messageHex:Buffer.from(plan.messageBytes).toString('hex'),messageSha256:plan.messageSha256,packetBytes:plan.packetBytes,
   rents:plan.expectedNewAccounts.map(a=>({address:a.address,space:a.space,minimumBalanceLamports:'1000',existingLamports:'0',maxIncreaseLamports:'1000'})),feeLamports:fee.toString(),rentLamports:rent.toString(),paymentDebitLamports:plan.buyerNetPaymentLamports.toString(),requiredLamports:required.toString(),payerLamports:required.toString()},
  state:'prepared',currentSigningAuthorized:false,submissionAuthorized:false});
 const trust={genesisHash:p.source.genesisHash,programId:p.source.programId,developer:p.terms.developer,reviewedProgramDataSha256:p.source.programDataSha256,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,revision:p.source.revision};
 return {preparation:p,signed:()=>{const tx=Transaction.populate(Message.from(Buffer.from(p.quote.messageHex,'hex')),[bs58.encode(new Uint8Array(64))]);tx.partialSign(signer);return {wire:tx.serialize().toString('base64'),signature:bs58.encode(tx.signature!)};}};
}

beforeEach(()=>{vi.spyOn(authCookies,'assertSession').mockReturnValue('session');vi.spyOn(authCookies,'assertResponse').mockImplementation(()=>undefined);vi.spyOn(authCookies,'current').mockReturnValue(true);vi.mocked(mutationGate.getSnapshot).mockReturnValue(true);for(const fn of [failedRealmSaleOriginal,prepareRealmSaleOriginal,savedRealmSaleOriginal,reviewRealmSaleOriginal,submitRealmSaleOriginal])vi.mocked(fn).mockReset();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();useApp.getState().setAuth(null);});
function setup(trusted=true){
 const f=realmSaleSigningFixture(),p=f.preparation,identity=realmSaleIdentity(p.wallet),page={active:true,visible:true,epoch:0,actionsEnabled:true};useApp.getState().setAuth(identity.wallet,true);
 const trust=trusted?{genesisHash:p.source.genesisHash,programId:p.source.programId,developer:p.terms.developer,reviewedProgramDataSha256:p.source.programDataSha256,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,revision:p.source.revision}:null;
 const signer:GameWallet={publicKey:key(1).publicKey,signMessage:null,isEmbedded:false,sendTransaction:vi.fn(),signTransaction:vi.fn(async(tx:Transaction)=>{tx.partialSign(key(1));return tx;})};let current=signer;
 const ports=createRealmSaleBrowserPorts({identity,trust,wallet:()=>current,lifecycle:()=>page,clock:()=>123});return {...f,p,identity,page,trust,signer,ports,changeWallet(next:GameWallet){current=next;}};
}
describe('realm sale browser effect boundary',()=>{
 it('pins origin/API/cluster/session and is independent of base selection',()=>{
  const f=setup(),guard=f.ports.capture(false);useApp.getState().setSelectedBaseId(crypto.randomUUID(),false);expect(guard).not.toThrow();
  for(const patch of [{origin:'https://other.test'},{api:'https://other.test/api'},{cluster:'mainnet-beta' as const}]){const foreign=createRealmSaleBrowserPorts({identity:{...f.identity,...patch},trust:f.trust,wallet:()=>f.signer,lifecycle:()=>f.page});expect(()=>foreign.capture(false)).toThrow(/origin|server|network/);}
  vi.mocked(authCookies.current).mockReturnValue(false);expect(guard).toThrow();vi.mocked(authCookies.current).mockReturnValue(true);useApp.setState({wallet:key(9).publicKey.toBase58()});expect(guard).toThrow();
 });
 it('keeps paused recovery available with missing wallet/trust while all new effects refuse',async()=>{
  const f=setup(false),retain=vi.fn(async()=>{});f.page.actionsEnabled=false;f.changeWallet({...f.signer,publicKey:null,signTransaction:null});const guard=f.ports.capture(false),request={idempotencyKey:f.p.idempotencyKey,spot:0,realm:0};
  await f.ports.getPreparation(request,guard,retain);await f.ports.getSaved(request.idempotencyKey,guard,retain);await f.ports.getFailure(request.idempotencyKey,guard,retain);expect(failedRealmSaleOriginal).toHaveBeenCalledExactlyOnceWith({idempotencyKey:request.idempotencyKey,isCurrent:expect.any(Function),retain});expect(prepareRealmSaleOriginal).toHaveBeenCalledTimes(1);expect(savedRealmSaleOriginal).toHaveBeenCalledTimes(1);expect(()=>f.ports.capture(true)).toThrow();
  await expect(f.ports.sign(f.p,guard)).rejects.toThrow();await expect(f.ports.currentReview(f.p,guard)).rejects.toThrow();expect(f.signer.signTransaction).not.toHaveBeenCalled();
 });
 it('requires captured signer, visible active view, epoch and mutation gate for effects',()=>{
  const f=setup(),action=f.ports.capture(true),read=f.ports.capture(false);f.changeWallet({...f.signer,signTransaction:async tx=>tx});expect(action).toThrow();expect(read).not.toThrow();f.changeWallet(f.signer);
  f.page.actionsEnabled=false;expect(action).toThrow();expect(read).not.toThrow();f.page.actionsEnabled=true;vi.mocked(mutationGate.getSnapshot).mockReturnValue(false);expect(action).toThrow();expect(read).not.toThrow();f.page.visible=false;expect(read).toThrow();
  const g=setup(),guard=g.ports.capture(false);g.page.epoch+=2;expect(guard).toThrow();const h=setup(),other=h.ports.capture(false);vi.mocked(authCookies.assertResponse).mockImplementation(()=>{throw Error('retired revision');});expect(other).toThrow(/revision/);
 });
 it('refuses another tab or absent Web Locks without running the effect',async()=>{
  const f=setup(),run=vi.fn(async()=>1),request=vi.fn(async(_name:string,_options:unknown,callback:(lock:unknown)=>unknown)=>callback(null));vi.stubGlobal('navigator',{locks:{request}});
  await expect(f.ports.lock('scope',run)).rejects.toThrow(/tab/);expect(run).not.toHaveBeenCalled();expect(request.mock.calls[0]![1]).toEqual({mode:'exclusive',ifAvailable:true});
  request.mockImplementation(async(_name,_options,callback)=>callback({name:'scope'}));expect(await f.ports.lock('scope',run)).toBe(1);vi.stubGlobal('navigator',{});await expect(f.ports.lock('scope',run)).rejects.toThrow(/browser/);
 });
 it('copies independent trust, checks it before current review and owns preparation through crypto await',async()=>{
  const f=setup(),guard=f.ports.capture(true);f.trust!.developer=key(9).publicKey.toBase58();await f.ports.currentReview(f.p,guard);expect(reviewRealmSaleOriginal).toHaveBeenCalledTimes(1);expect(f.signer.signTransaction).not.toHaveBeenCalled();
  const changed=structuredClone(f.p);changed.terms.developer=key(9).publicKey.toBase58();await expect(f.ports.currentReview(changed,guard)).rejects.toThrow();expect(reviewRealmSaleOriginal).toHaveBeenCalledTimes(1);
 });
 it('rechecks lifecycle after async byte verification BEFORE calling wallet',async()=>{
  const f=setup(),guard=f.ports.capture(true),digest=crypto.subtle.digest.bind(crypto.subtle);let release!:()=>void,entered!:()=>void;const pending=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{entered();await pending;return digest(...args);});const sign=f.ports.sign(f.p,guard);await started;f.page.visible=false;release();await expect(sign).rejects.toThrow();expect(f.signer.signTransaction).not.toHaveBeenCalled();
 });
 it('returns a valid late signature after logout so controller can retain it first, never broadcasts',async()=>{
  const f=setup(),guard=f.ports.capture(true);vi.mocked(f.signer.signTransaction!).mockImplementation(async tx=>{tx.partialSign(key(1));useApp.setState({wallet:null,authed:false});f.page.visible=false;f.page.epoch++;return tx;});
  const signed=await f.ports.sign(f.p,guard);expect(await verifySignedRealmSale(f.p,signed.wire)).toEqual(signed);expect(f.signer.sendTransaction).not.toHaveBeenCalled();
 });
 it('delegates exact methods and durable callbacks without post-response lifecycle cancellation',async()=>{
  const f=setup(),guard=f.ports.capture(true),retain=vi.fn(async()=>{}),request={idempotencyKey:f.p.idempotencyKey,spot:0,realm:0};await f.ports.prepare(request,guard,retain,async()=>{});await f.ports.getPreparation(request,guard,retain);await f.ports.getSaved(request.idempotencyKey,guard,retain);await f.ports.submit({idempotencyKey:request.idempotencyKey,signedTransaction:f.signed().wire},guard,retain);
  expect(vi.mocked(prepareRealmSaleOriginal).mock.calls.map(([v])=>[v.method,v.request,v.retain])).toEqual([['POST',request,retain],['GET',request,retain]]);expect(vi.mocked(savedRealmSaleOriginal).mock.calls[0]![0]).toMatchObject({idempotencyKey:request.idempotencyKey,retain});expect(vi.mocked(submitRealmSaleOriginal).mock.calls[0]![0].retain).toBe(retain);
  const sent=vi.mocked(prepareRealmSaleOriginal).mock.calls[0]![0];f.page.visible=false;await sent.retain(f.p);expect(retain).toHaveBeenCalledOnce();expect(sent.isCurrent).toThrow();expect(f.ports.clock()).toBe(123);expect(f.ports.key()).toMatch(/^[0-9a-f-]{36}$/);
 });
 it('bounds oversized or non-string trust before invoking PublicKey decoding',()=>{
  const f=setup(),decode=vi.fn(()=>{throw Error('unbounded decode');}),hostile={};Object.defineProperty(hostile,'_bn',{get:decode});
  for(const value of ['1'.repeat(100000),hostile]){const ports=createRealmSaleBrowserPorts({identity:f.identity,trust:{...f.trust!,genesisHash:value as string},wallet:()=>f.signer,lifecycle:()=>f.page});expect(()=>ports.capture(true)).toThrow(/trust/i);expect(()=>ports.capture(false)).not.toThrow();}expect(decode).not.toHaveBeenCalled();
 });

});
