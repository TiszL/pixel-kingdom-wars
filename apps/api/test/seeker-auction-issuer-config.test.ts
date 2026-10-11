/** Dedicated kind-7 settings contain public pins only; this test reads no files. */
import {describe,expect,it} from 'vitest';
import {Keypair} from '@solana/web3.js';
import {loadCharterPolicyIssuerConfig} from '../src/charterPolicyIssuerConfig';
const key=(n:number)=>Keypair.fromSeed(Buffer.alloc(32,n)).publicKey.toBase58();
function fixture(){
 const env:NodeJS.ProcessEnv={CHARTER_ISSUER_CLUSTER:'devnet',CHARTER_ISSUER_READ_RPC_URL:'https://issuer.example.invalid',CHARTER_ISSUER_CURRENT_PUBLIC_KEY:key(1),CHARTER_ISSUER_SECRET_KEY_FILE:'/test/key',CHARTER_ISSUER_AUTH_TOKEN_FILE:'/test/token',CHARTER_ISSUER_JOURNAL_FILE:'/test/journal',CHARTER_ISSUER_STATE_PROVENANCE:'fresh-reviewed-deployment'};
 for(const[family,n]of [['ECONOMY',2],['CRAFT',3],['CORE',4]]as const){env[`CHARTER_ISSUER_${family}_PROGRAM_ID`]=family==='CORE'?'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d':key(n);env[`CHARTER_ISSUER_${family}_DEPLOYMENT_SLOT`]='7';env[`CHARTER_ISSUER_${family}_PROGRAM_DATA_SHA256`]='a'.repeat(64);env[`CHARTER_ISSUER_${family}_UPGRADE_AUTHORITY`]='none';}
 const enabled={...env,CHARTER_ISSUER_SEEKER_AUCTION_ENABLED:'true',CHARTER_ISSUER_SEEKER_AUCTION_MINT:key(5),CHARTER_ISSUER_SEEKER_AUCTION_PRIZE_OWNER:key(6),CHARTER_ISSUER_SEEKER_AUCTION_CRANK_PUBKEY:key(7)};
 const registry={cluster:'devnet',skrMint:key(5),skrDecimals:6};return {env,enabled,registry};
}
describe('SA-3 default-off dedicated issuer pins',()=>{
 it('omits kind-7 capability unless the dedicated flag is exactly true',()=>{
  const f=fixture();for(const patch of [{},{CHARTER_ISSUER_SEEKER_AUCTION_ENABLED:'false'}])expect(loadCharterPolicyIssuerConfig({...f.env,...patch},f.registry).seekerAuction).toBeUndefined();
  expect(()=>loadCharterPolicyIssuerConfig({...f.env,CHARTER_ISSUER_SEEKER_AUCTION_ENABLED:'yes'},f.registry)).toThrow();
 });
 it('binds existing reviewed economy/genesis pins, registry identity and crank without a signer path',()=>{
  const f=fixture(),config=loadCharterPolicyIssuerConfig(f.enabled,f.registry);
  expect(config.seekerAuction).toEqual({crankPublicKey:key(7),trust:{programId:key(2),genesisHash:config.domain.genesisHash,mint:key(5),decimals:6,prizeOwner:key(6),deploymentSlot:7,programDataSha256:'a'.repeat(64),upgradeAuthority:null,stateProvenance:'fresh-reviewed-deployment'}});
  expect(Object.isFrozen(config.seekerAuction!.trust)).toBe(true);
 });
 it('refuses every missing pin, missing registry, identity mismatch and unsafe decimals',()=>{
  const f=fixture();for(const suffix of ['MINT','PRIZE_OWNER','CRANK_PUBKEY']){const env:NodeJS.ProcessEnv={...f.enabled};delete env[`CHARTER_ISSUER_SEEKER_AUCTION_${suffix}`];expect(()=>loadCharterPolicyIssuerConfig(env,f.registry)).toThrow();}
  for(const registry of [null,{}, {...f.registry,cluster:'mainnet-beta'}, {...f.registry,skrMint:key(8)}, {...f.registry,skrDecimals:-1}, {...f.registry,skrDecimals:1.5}, {...f.registry,skrDecimals:20}])expect(()=>loadCharterPolicyIssuerConfig(f.enabled,registry)).toThrow();
 });
 it('never substitutes API auction or withdrawal settings for dedicated pins',()=>{
  const f=fixture(),env:NodeJS.ProcessEnv={...f.enabled,SEEKER_AUCTION_MINT:key(5)};delete env.CHARTER_ISSUER_SEEKER_AUCTION_MINT;
  expect(()=>loadCharterPolicyIssuerConfig(env,f.registry)).toThrow();
 });
});
