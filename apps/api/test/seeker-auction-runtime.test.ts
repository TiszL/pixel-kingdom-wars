/** T10/T11: auction configuration is independent, complete-or-refuse and default-off. */
import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { loadConfig } from '../src/config';
import { createSeekerAuctionRuntime } from '../src/seeker/auctionRuntime';
const pk=(n:number)=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const base={DATABASE_URL:'postgres://x:y@localhost:5433/example',JWT_SECRET:'test-secret-test-secret-test-secret!',WEB_ORIGIN:'http://localhost:5173',NODE_ENV:'test'};
const pins={SEEKER_AUCTION_PROGRAM_ID:pk(4),SEEKER_AUCTION_DEPLOYMENT_SLOT:'100',SEEKER_AUCTION_PROGRAM_DATA_SHA256:'a'.repeat(64),
 SEEKER_AUCTION_UPGRADE_AUTHORITY:'none',SEEKER_AUCTION_MINT:pk(5),SEEKER_AUCTION_PRIZE_OWNER:pk(6),SEEKER_AUCTION_STATE_PROVENANCE:'fresh-reviewed-deployment'};
const registry={cluster:'devnet' as const,skrMint:pk(5),skrDecimals:6};
describe('SA-1 auction runtime configuration',()=>{
 it('T10 has no runtime or worker by default and accepts only explicit lowercase flags',()=>{
  const config=loadConfig(base);expect(config.PHASE_E_SEEKER_AUCTION_ENABLED).toBeUndefined();expect(config.SEEKER_AUCTION_CRANK_ENABLED).toBeUndefined();
  expect(createSeekerAuctionRuntime(config,registry)).toBeNull();
  for(const flag of ['PHASE_E_SEEKER_AUCTION_ENABLED','SEEKER_AUCTION_CRANK_ENABLED'])for(const value of ['TRUE','yes','1'])
   expect(()=>loadConfig({...base,[flag]:value})).toThrow();
 });
 it('T10 refuses each missing pin and enabled-with-no-pins rather than borrowing another lane',()=>{
  expect(()=>createSeekerAuctionRuntime(loadConfig({...base,PHASE_E_SEEKER_AUCTION_ENABLED:'true'}),registry)).toThrow();
  for(const name of Object.keys(pins)){
   const env:Record<string,string>={...base,...pins};delete env[name];
   expect(()=>createSeekerAuctionRuntime(loadConfig(env),registry)).toThrow();
  }
 });
 it('T11 refuses missing/mismatched registry SKR, cluster or decimals; mint is never an environment fallback',()=>{
  const config=loadConfig({...base,...pins,PHASE_E_SEEKER_AUCTION_ENABLED:'true'});
  for(const bad of [null,{cluster:'devnet'}, {...registry,skrMint:pk(7)},{...registry,cluster:'mainnet-beta'},{...registry,skrDecimals:20}])
   expect(()=>createSeekerAuctionRuntime(config,bad as never)).toThrow();
 });
 it('pins chain identity without reading RPC, secrets or enabling worker execution',()=>{
  const runtime=createSeekerAuctionRuntime(loadConfig({...base,...pins,PHASE_E_SEEKER_AUCTION_ENABLED:'true'}),registry)!;
  expect(runtime.source.trust).toMatchObject({programId:pins.SEEKER_AUCTION_PROGRAM_ID,mint:registry.skrMint,decimals:6,
   deploymentSlot:100,programDataSha256:pins.SEEKER_AUCTION_PROGRAM_DATA_SHA256,upgradeAuthority:null,stateProvenance:'fresh-reviewed-deployment'});
  runtime.close();expect(()=>runtime.source.connect(new AbortController().signal)).toThrow();
 });
 // K-night-08 (2026-10-10): the owner may move ONLY the auction source to a single-node RPC; the
 // primary SOLANA_RPC_URL (every other chain path) is untouched, and the override obeys the same provider policy.
 it('uses an optional SEEKER_AUCTION_RPC_URL for the auction source only, defaulting to SOLANA_RPC_URL',async()=>{
  const urls:string[]=[];
  vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{urls.push(String(input));const {id}=JSON.parse(String(init?.body));
   return new Response(JSON.stringify({jsonrpc:'2.0',id,result:'genesis'}),{status:200,headers:{'content-type':'application/json'}});});
  try{
   const env={...base,...pins,PHASE_E_SEEKER_AUCTION_ENABLED:'true',SOLANA_RPC_URL:'https://pool.example/?api-key=primary'};
   for(const [extra,expected] of [[{},'https://pool.example/?api-key=primary'],[{SEEKER_AUCTION_RPC_URL:'https://node.example/rpc'},'https://node.example/rpc']] as const){
    const config=loadConfig({...env,...extra}),runtime=createSeekerAuctionRuntime(config,registry)!;
    expect(config.SOLANA_RPC_URL).toBe(env.SOLANA_RPC_URL);
    expect(await runtime.source.connect(new AbortController().signal).getGenesisHash()).toBe('genesis');runtime.close();
    expect(urls.splice(0)).toEqual([expected]);
   }
  }finally{vi.unstubAllGlobals();}
  expect(()=>loadConfig({...base,SEEKER_AUCTION_RPC_URL:'https://node.example/rpc#fragment'})).toThrow();
 });
 it('requires both worker-only public identity and an absolute keypair-file path when crank is selected',()=>{
  const env={...base,...pins,SEEKER_AUCTION_CRANK_ENABLED:'true'};
  for(const extra of [{},{SEEKER_AUCTION_CRANK_PUBKEY:pk(8)},{SEEKER_AUCTION_CRANK_KEYPAIR_FILE:'/not/read.json'},
   {SEEKER_AUCTION_CRANK_PUBKEY:pk(8),SEEKER_AUCTION_CRANK_KEYPAIR_FILE:'relative.json'}])
   expect(()=>createSeekerAuctionRuntime(loadConfig({...env,...extra}),registry)).toThrow();
  const runtime=createSeekerAuctionRuntime(loadConfig({...env,SEEKER_AUCTION_CRANK_PUBKEY:pk(8),SEEKER_AUCTION_CRANK_KEYPAIR_FILE:'/not/read.json'}),registry)!;
  expect(runtime.source.trust.mint).toBe(registry.skrMint);runtime.close();
 });
});
