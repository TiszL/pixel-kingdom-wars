/** Local manual browser proof. Uses a fresh loopback-only disposable database,
 * actual private services/routes and explicitly declared facility/stock/time
 * fixtures. Never run against a deployed server or treat fixture login as auth
 * acceptance. SIGINT closes only this server and its owned database. */
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import {sql} from 'drizzle-orm';
import {cosmeticVisualDatabase} from '../fixtures/boundCosmeticVisualDatabase';
import {boundCosmeticFixture,pendingOrdinary,cosmeticMaterials} from '../fixtures/boundCosmetics';
import {settleDueOrdinaryCrafting} from '../../src/game/ordinaryCrafting';
import {createBoundCosmeticWorkshop} from '../../src/game/boundCosmeticWorkshop';
import {registerBoundCosmeticRoutes} from '../../src/game/boundCosmeticRoutes';
import {registerBoundCosmeticCollection} from '../../src/game/boundCosmeticCollection';
import {getBaseState} from '../../src/game/base';
import {HttpError} from '../../src/lib/errors';

for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_CATALOG_ENABLED','ORDINARY_CRAFTING_ENABLED'])process.env[flag]='true';
const conn=cosmeticVisualDatabase();await conn.setup();
const f=await boundCosmeticFixture(conn.db),shift=Date.now()-86400000-+f.now;
// Shift newly created facility fixtures before any immutable job references them.
await conn.db.execute(sql`update builder_jobs set started_at=started_at+${shift}*interval '1 millisecond',finishes_at=finishes_at+${shift}*interval '1 millisecond',completed_at=completed_at+${shift}*interval '1 millisecond' where base_id=${f.baseId}`);
f.now=new Date(+f.now+shift);const earned=await pendingOrdinary(f);f.now=earned.job.readyAt;
await conn.db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.baseId,f.now));
await cosmeticMaterials(f,'craft_artisan_market_awning_t1_v1');
const provider=createBoundCosmeticWorkshop(conn.db,{awningApplicationReady:true,clock:()=>f.now});
const app=Fastify(),token=randomBytes(24).toString('hex');
await app.register(cors,{origin:'http://127.0.0.1:5178',credentials:true,methods:['GET','HEAD','POST','PUT','OPTIONS']});await app.register(cookie);
app.decorate('authenticate',async req=>{if(req.cookies['workshop-proof']!==token)throw new HttpError(401,'Local proof session required');req.wallet=f.wallet;});
app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof HttpError?error.statusCode:500).send({error:{code:error instanceof HttpError?error.code:'INTERNAL',message:error instanceof Error?error.message:String(error)}}));
registerBoundCosmeticCollection(app,provider);registerBoundCosmeticRoutes(app,provider);
app.get('/base',{preHandler:[app.authenticate]},async()=>getBaseState(conn.db,f.wallet,f.now,f.baseId,f.authority.assertAuthority,()=>f.now,2));
app.get('/__fixture/session',async(_req,reply)=>{reply.setCookie('workshop-proof',token,{httpOnly:true,sameSite:'lax',path:'/'});return {wallet:f.wallet,baseId:f.baseId};});
app.post('/__fixture/complete',{preHandler:[app.authenticate]},async()=>{
 const [next]=await conn.db.execute<{ready_at:Date|null}>(sql`select max(j.ready_at) ready_at from bound_cosmetic_jobs j where j.actor_wallet=${f.wallet} and not exists(select 1 from bound_cosmetic_completions c where c.job_id=j.id)`);
 if(next?.ready_at)f.now=new Date(next.ready_at);
 return provider.view(f.wallet,f.baseId);
});
const address=await app.listen({host:'127.0.0.1',port:0});
writeFileSync('/tmp/bound-cosmetic-workshop-browser-address.json',JSON.stringify({address,wallet:f.wallet,baseId:f.baseId,fixtureTime:f.now.toISOString()}));
console.log('Bound cosmetic browser proof ready at '+address+'; local fixture session, no public application acceptance.');
let closing=false;const close=async()=>{if(closing)return;closing=true;await app.close();await conn.close();process.exit(0);};
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
