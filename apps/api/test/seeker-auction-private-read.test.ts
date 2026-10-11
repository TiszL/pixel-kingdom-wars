/** review 4dbfed12: only issuer/crank may pre-read one successor. No route selector. */
import {expect,it} from 'vitest';
import {readSeekerAuctionRound,readSeekerAuctionPrivateRound} from '../src/seeker/auctionReadModel';
import {registerSeekerAuctionRoutes} from '../src/seeker/auctionRoutes';
import {createSeekerAuctionFixture,program,wallet} from '../../../packages/chain/src/testFixtures/seekerAuctionRead.fixture';
async function successor(){
 const f=await createSeekerAuctionFixture({round:1n,biddingRound:0n}),previous=await createSeekerAuctionFixture({round:0n,biddingRound:0n});
 f.store.set(previous.termAddress.toBase58(),previous.account(previous.termAddress));return {...f,previous};
}
it('admits the next private round before first operating start with its canonical predecessor',async()=>{
 const f=await successor();expect(f.nowSec<f.firstStart).toBe(true);
 const result=await readSeekerAuctionPrivateRound(f.source,wallet.toBase58(),1n);
 expect(result.view).toMatchObject({round:'1',biddingRound:'0'});expect(result.term?.round).toBe(1n);
 expect(f.calls.some(call=>call.keys.includes(f.previous.termAddress.toBase58()))).toBe(true);
 await expect(readSeekerAuctionRound(f.source,wallet.toBase58(),1n)).rejects.toThrow();
});
it('refuses plus two, a missing predecessor, and a malformed predecessor even when the target exists',async()=>{
 const f=await successor();await expect(readSeekerAuctionPrivateRound(f.source,wallet.toBase58(),2n)).rejects.toThrow();
 f.store.delete(f.previous.termAddress.toBase58());await expect(readSeekerAuctionPrivateRound(f.source,wallet.toBase58(),1n)).rejects.toThrow();
 f.store.set(f.previous.termAddress.toBase58(),f.previous.account(f.previous.termAddress));
 f.account(f.previous.termAddress).data[0]!^=1;await expect(readSeekerAuctionPrivateRound(f.source,wallet.toBase58(),1n)).rejects.toThrow();
});
it('can observe an absent successor only with its predecessor, retaining all absence checks',async()=>{
 const f=await successor();f.store.delete(f.termAddress.toBase58());for(const address of [...f.auctionAddresses,...f.bidAddresses])f.store.delete(address.toBase58());
 expect((await readSeekerAuctionPrivateRound(f.source,wallet.toBase58(),1n)).term).toBeNull();
 f.store.delete(f.previous.termAddress.toBase58());await expect(readSeekerAuctionPrivateRound(f.source,wallet.toBase58(),1n)).rejects.toThrow();
});
it('keeps the future reader unreachable through the registered round route',async()=>{
 const f=await successor();let handler:((request:{wallet:string;params:{round:string};query:{}})=>Promise<unknown>)|undefined;
 const app={authenticate:()=>{},get:(path:string,_options:unknown,callback:typeof handler)=>{if(path==='/seeker/auctions/round/:round')handler=callback;},post:()=>{}};
 registerSeekerAuctionRoutes(app as never,f.source as never);expect(handler).toBeDefined();
 await expect(handler!({wallet:wallet.toBase58(),params:{round:'1'},query:{}})).rejects.toMatchObject({statusCode:503});
 // A valid predecessor never weakens deployment proof.
 f.account(program).executable=false;await expect(readSeekerAuctionPrivateRound(f.source,wallet.toBase58(),1n)).rejects.toThrow();
});
