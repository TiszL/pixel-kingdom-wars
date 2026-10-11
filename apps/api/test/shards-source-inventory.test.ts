/** Source inventory guard, not proof that these issuers already assess tax.
 * A new mint/helper caller must supply earning/exclusion evidence before it is
 * added here. Mixed Mine raid issuance and mail unwind must remain visible.
 */
import {readdirSync,readFileSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';
import ts from 'typescript';
import {expect,it} from 'vitest';

const root=join(__dirname,'../../..');
function files(dir:string):string[]{return readdirSync(dir).filter(name=>!['node_modules','dist','target','.git'].includes(name)&&!name.startsWith('.')).flatMap(name=>{const path=join(dir,name);return statSync(path).isDirectory()?files(path):/\.(?:ts|mjs|js)$/.test(path)&&!/(?:\.test\.|\.spec\.|\.d\.ts$)/.test(path)?[path]:[];});}
function references(path:string){
 const source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true),aliases=new Map<string,string>(),found={rewardBaseShards:0,rewardShards:0,genesisAccess:0};
 function imports(node:ts.Node){if(ts.isImportSpecifier(node))aliases.set(node.name.text,node.propertyName?.text??node.name.text);ts.forEachChild(node,imports);}imports(source);
 function visit(node:ts.Node){
  if(ts.isCallExpression(node)){
   const expr=node.expression,name=ts.isIdentifier(expr)?aliases.get(expr.text)??expr.text:ts.isPropertyAccessExpression(expr)?expr.name.text:null;
   if(name==='rewardBaseShards'||name==='rewardShards')found[name]++;
  }
  if(ts.isPropertyAccessExpression(node)&&node.name.text==='shard_genesis'||ts.isElementAccessExpression(node)&&ts.isStringLiteral(node.argumentExpression)&&node.argumentExpression.text==='shard_genesis')found.genesisAccess++;
  ts.forEachChild(node,visit);
 }visit(source);return found;
}
const runtime=files(join(root,'apps/api/src')).sort().map(path=>({path:relative(join(root,'apps/api/src'),path),...references(path)}));
const counts=(key:'rewardBaseShards'|'rewardShards'|'genesisAccess')=>Object.fromEntries(runtime.filter(row=>row[key]).map(row=>[row.path,row[key]]));
it('enumerates every stable-base and legacy SHARDS helper caller, including unresolved rewards and development grants',()=>{
 expect(counts('rewardBaseShards')).toEqual({'auth/routes.ts':1,'game/base.ts':2,'game/baseMining.ts':2,'game/campaign.ts':1,'game/leagues.ts':1,'game/quests.ts':2});
 expect(counts('rewardShards')).toEqual({'auth/routes.ts':1,'game/base.ts':5,'game/quests.ts':2,'game/raids.ts':1});
});
it('enumerates direct genesis access including Mine raid mint, legacy issuance, conversion and mail unwind',()=>{
 // 2026-10-10 (CI 37503885235): D153.196 (8cd3fda6a, 2026-09-29) exempts cache obstacles from tax; new claims pay
 // full value through the ordinary sources above and mining/shardsTaxCacheSource.ts no longer touches shard_genesis.
 // The historical taxed-cache issuance survives only as the test-only fixtures/historicalTaxedCache seed.
 expect(counts('genesisAccess')).toEqual({'game/baseEconomy.ts':1,'game/baseMining.ts':1,'game/emission.ts':2,'game/forge.ts':1,'game/gems.ts':1,'game/raidLoot.ts':1,'game/spend.ts':1,'mail/service.ts':2});
 // Generic helpers cannot silently acquire blanket taxation: conversions,
 // refunds, grants and historical custody need their own source semantics.
 for(const path of ['game/baseEconomy.ts','game/spend.ts'])expect(readFileSync(join(root,'apps/api/src',path),'utf8')).not.toMatch(/from ['"].*shardsTax/);
});
it('keeps synthetic fixture issuers explicit and separate from runtime earning coverage',()=>{
 const support=[...files(join(root,'apps/api/scripts')),...files(join(root,'scripts')),...files(join(root,'infra'))].map(path=>({path:relative(root,path),...references(path)}));
 expect(Object.fromEntries(support.filter(r=>r.rewardBaseShards||r.rewardShards||r.genesisAccess).map(r=>[r.path,{base:r.rewardBaseShards,legacy:r.rewardShards,genesis:r.genesisAccess}]))).toEqual({
  'apps/api/scripts/fantasy-acceptance-fixture.ts':{base:1,legacy:0,genesis:0},
  'apps/api/scripts/wall-acceptance-fixture.ts':{base:1,legacy:0,genesis:0},
  'scripts/candidate/progression.mjs':{base:1,legacy:0,genesis:0},
  // QA showcase seed: exact plan-cost grants (kingdom, tester upgrade), each training batch, a tester's raid purse and its refill top-up.
  'scripts/candidate/showcase.mjs':{base:5,legacy:0,genesis:0},
 });
});
