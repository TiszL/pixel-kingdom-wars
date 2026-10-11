/** One fixture bank links actual signed sales to quota days and expedition access.
 * All validators stay real; only finalized RPC observations are injected. */
import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {PHASE_E_MINING_PUBLICATION} from '@shardkeep/shared';
import type {RealmSalePreparationView} from '@shardkeep/shared/realmSalesApi';
import {realmSaleQuoteFixture} from '../../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {spotSalesQuotaPda} from '../../../../packages/chain/src/seekerRealmSaleProtocol';
import {settleNativeRealmSaleBank} from '../../../../packages/chain/src/testFixtures/realmSalePreparedFinality';
import {createMiningTermFixture} from '../../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
export async function createRealmSaleRenewalPair(){
 const bank=await realmSaleQuoteFixture(),daySec=BigInt(PHASE_E_MINING_PUBLICATION.daySec);
 // This fixture time puts the later renewal-expiry day after the next auction
 // round's opening, so the existing midnight-completion term fixture is valid.
 const firstAt=(bank.controls.now/daySec+1n)*daySec+3600n;
 function setTime(unix:bigint){bank.controls.now=unix;bank.controls.slot++;}
 setTime(firstAt);
 const operatingTerms=new Map<bigint,Awaited<ReturnType<typeof createMiningTermFixture>>>();
 function nextUtcDay(){const at=(bank.controls.now/daySec+1n)*daySec;setTime(at);return at;}
 async function settle(preparation:RealmSalePreparationView,wire:Buffer){
  const day=BigInt(preparation.terms.day),originalAddress=bank.addresses.quota.toBase58(),originalRow=bank.store.get(originalAddress)!,originalModel={...bank.models.quota};
  const address=spotSalesQuotaPda(bank.accessTrust.programId,preparation.spot,day),bytes=Buffer.alloc(8);bytes.writeBigUInt64LE(day);
  const [,bump]=PublicKey.findProgramAddressSync([Buffer.from('spot_sales'),Buffer.of(preparation.spot),bytes],bank.accessTrust.programId);
  if(address.toBase58()===originalAddress||bank.store.has(address.toBase58()))throw Error('Composed fixture requires a fresh canonical spot/day quota');
  const previousBodies=new Map(bank.bodies);Object.assign(bank.models.quota,{spot:preparation.spot,day,sales:0,bump});
  try{
   await settleNativeRealmSaleBank(bank,preparation,wire);
   // The existing fixture repacks at its captured original address. Relocate
   // precisely that encoded new-day account; never replace old quota history.
   bank.store.set(address.toBase58(),bank.store.get(originalAddress)!);
  }finally{
   bank.store.set(originalAddress,originalRow);Object.assign(bank.models.quota,originalModel);
   for(const [signature,body]of previousBodies)if(!bank.bodies.has(signature))bank.bodies.set(signature,body);
  }
 }
 async function operatingTermAt(unix:bigint){
  const first=bank.models.config.first_operating_start,round=(unix-first)/bank.models.config.term_sec,day=new Date(Number(unix)*1000).toISOString().slice(0,10);
  if(unix<first||BigInt(Date.parse(`${day}T00:00:00.000Z`)/1000)<first+round*bank.models.config.term_sec)throw Error('Fixture midnight must be inside its operating round');
  let term=operatingTerms.get(round);
  if(!term){term=await createMiningTermFixture({day,round,firstOperatingStart:first,programId:bank.termPolicy.programId,genesisHash:bank.termPolicy.genesisHash,
   mint:bank.termPolicy.mint,prizeOwner:bank.termPolicy.prizeOwner,programData:bank.programData,programDataAddress:bank.programDataAddress,upgradeAuthority:bank.upgradeAuthority,
   winners:[{spotId:0,wallet:bank.seller}]});
  if(!term.policy.config.equals(bank.termPolicy.config)||JSON.stringify(term.policy.deployment)!==JSON.stringify(bank.termPolicy.deployment))throw Error('Operating authority must preserve original source pins');
  operatingTerms.set(round,term);}
  term.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(unix,32);return term;
 }
 return {bank,firstAt,setTime,nextUtcDay,settle,operatingTermAt};
}
