import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { profileOverviewModel, profileWalletModel, profileAccountModel, type ProfileOverviewInput, type ProfileWalletInput, type ProfileAccountInput } from './profileAdapters';
const overview=():ProfileOverviewInput=>({wallet:'current',player:{wallet:'current',name:'Ada',keepLevel:3,trophies:24,league:'Bronze',builders:1,expansions:0},loading:false,error:null});
const wallet=():ProfileWalletInput=>({wallet:'current',snapshot:{wallet:'current',gameCluster:'devnet',balances:{sol:0,tokens:{KEEP:12,SKR:null},asOf:17}},gameCluster:'devnet',tokens:[{symbol:'KEEP',cluster:'game'},{symbol:'SKR',cluster:'mainnet'},{symbol:'USDC',cluster:'mainnet'},{symbol:'USDT',cluster:'mainnet'}],loading:false,error:null,formatAmount:n=>n===null?'…':String(n)});
const account=():ProfileAccountInput=>({wallet:'current',snapshotWallet:'current',savedName:'Ada',draft:null,saving:false,nameError:null,providers:{WALLET:true,EMAIL:true},security:{totpEnabled:false,emailVerified:true},loading:false,error:null});

test('PROFILE displays only the authenticated current player snapshot',()=>{
 const m=profileOverviewModel(overview());assert.equal(m.rows[0]?.value,'Ada');assert.equal(m.rows.find(x=>x.id==='profile.keep')?.value,'3');
});
test('PROFILE does not expose the previous wallet player after an account switch',()=>{
 const x=overview();x.wallet='different';const m=profileOverviewModel(x);assert.ok(m.rows.every(r=>r.value!=='Ada'&&r.value!=='24'));assert.equal(m.rows[0]?.value,'…');
});
test('PROFILE missing read never fabricates a player or level',()=>{
 const x=overview();x.player=null;const m=profileOverviewModel(x);assert.equal(m.rows[0]?.value,'…');assert.equal(m.rows.find(r=>r.id==='profile.keep')?.value,'…');
});
test('PROFILE retains named settings invite security and economy doors',()=>{
 const ids=profileOverviewModel(overview()).rows.map(r=>r.action?.id);for(const id of ['account.settings','hub.invite','account.security','account.economy'])assert.ok(ids.includes(id),id);
});
test('wallet known zero remains zero while a failed token read remains unknown',()=>{
 const m=profileWalletModel(wallet());assert.equal(m.rows.find(r=>r.id==='wallet.SOL')?.value,'0');assert.equal(m.rows.find(r=>r.id==='wallet.SKR')?.value,'…');assert.equal(m.rows.find(r=>r.id==='wallet.SKR')?.tag,'UNAVAILABLE');
});
test('wallet tags preserve mainnet token origin on a devnet game',()=>{
 const m=profileWalletModel(wallet());assert.equal(m.rows.find(r=>r.id==='wallet.SKR')?.sub,'MAINNET');assert.equal(m.rows.find(r=>r.id==='wallet.KEEP')?.sub,'DEVNET');assert.equal(m.rows.find(r=>r.id==='wallet.SOL')?.sub,'DEVNET');
});
test('wallet source without configured token cluster cannot label a token live',()=>{
 const x=wallet();x.tokens=[{symbol:'KEEP',cluster:undefined as never}];const m=profileWalletModel(x);assert.equal(m.rows.find(r=>r.id==='wallet.KEEP')?.value,'…');assert.equal(m.rows.find(r=>r.id==='wallet.KEEP')?.sub,'CLUSTER UNAVAILABLE');
});
test('wallet has no Gems or custodial transfer row',()=>{
 const m=profileWalletModel(wallet());assert.ok(m.rows.every(r=>r.id!=='wallet.GEMS'));assert.doesNotMatch(JSON.stringify(m),/deposit|withdraw|custodial/i);
});
test('a balance snapshot belonging to another wallet is unavailable',()=>{
 const x=wallet();x.snapshot!.wallet='previous';assert.equal(profileWalletModel(x).rows.filter(r=>r.value!==undefined).length,5);assert.ok(profileWalletModel(x).rows.filter(r=>r.id.startsWith('wallet.')&&r.value!==undefined).every(r=>r.value==='…'));
});
test('a balance snapshot from a prior game cluster cannot be relabelled',()=>{
 const x=wallet();x.snapshot!.gameCluster='mainnet-beta';assert.equal(profileWalletModel(x).rows.find(r=>r.id==='wallet.SOL')?.value,'…');assert.equal(profileWalletModel(x).rows.find(r=>r.id==='wallet.KEEP')?.value,'…');
});
test('unlinked wallet shows connection rather than previous balances',()=>{
 const x=wallet();x.wallet=null;const m=profileWalletModel(x);assert.equal(m.primary?.id,'wallet.connect');assert.equal(m.rows.length,0);
});
for(const bad of [NaN,Infinity,-1])test(`invalid display balance is unknown: ${bad}`,()=>{
 const x=wallet();x.snapshot!.balances.sol=bad;assert.equal(profileWalletModel(x).rows.find(r=>r.id==='wallet.SOL')?.value,'…');
});
for(const cluster of ['mainnet-beta','unknown'] as const)test(`test SOL door is absent on ${cluster}`,()=>{
 const x=wallet();x.gameCluster=cluster;assert.equal(profileWalletModel(x).rows.some(r=>r.id==='wallet.test-sol'),false);
});
test('devnet test SOL is navigation into the existing faucet flow, not a claim',()=>{
 const row=profileWalletModel(wallet()).rows.find(r=>r.id==='wallet.test-sol');assert.equal(row?.action?.kind,'navigate');assert.equal(row?.action?.id,'wallet.test-sol');
});
test('a failed wallet refresh marks retained amounts stale',()=>{
 const x=wallet();x.error='Network unavailable';const m=profileWalletModel(x);assert.equal(m.load,'ERROR');assert.equal(m.rows.find(r=>r.id==='wallet.KEEP')?.tag,'LAST READ');assert.equal(m.rows.find(r=>r.id==='wallet.KEEP')?.value,'12');
});
test('ACCOUNT defaults its hoisted draft to the verified saved name',()=>{
 const m=profileAccountModel(account());assert.equal(m.draft,'Ada');assert.equal(m.saved,'Ada');assert.deepEqual(m.linked,{WALLET:true,EMAIL:true});
});
test('ACCOUNT preserves an explicitly cleared name draft',()=>{
 const x=account();x.draft='';assert.equal(profileAccountModel(x).draft,'');
});
test('ACCOUNT unknown security is unknown, never disabled or a fake backup count',()=>{
 const x=account();x.security=null;const m=profileAccountModel(x);assert.equal(m.rows.find(r=>r.id==='security.totp.status')?.value,'…');assert.equal(m.rows.find(r=>r.id==='security.backup.status')?.value,'…');
});
test('ACCOUNT known disabled TOTP is shown only from its source',()=>{
 assert.equal(profileAccountModel(account()).rows.find(r=>r.id==='security.totp.status')?.value,'OFF');
});
test('ACCOUNT old wallet data hides providers name and security',()=>{
 const x=account();x.snapshotWallet='previous';const m=profileAccountModel(x);assert.equal(m.saved,'');assert.deepEqual(m.linked,{});assert.equal(m.saving,true);assert.equal(m.rows.find(r=>r.id==='security.totp.status')?.value,'…');
});
test('ACCOUNT does not display a previous wallet name error',()=>{
 const x=account();x.snapshotWallet='previous';x.nameError='Private old name';assert.doesNotMatch(profileAccountModel(x).note??'',/Private old name/);
});
test('ACCOUNT retains name errors without treating them as a lost login',()=>{
 const x=account();x.nameError='Name already taken';const m=profileAccountModel(x);assert.equal(m.note,'Name already taken');assert.equal(m.saving,false);
});
test('profile mappers have only type imports and no transport security mutation or browser read',()=>{
 const src=readFileSync(new URL('./profileAdapters.ts',import.meta.url),'utf8');for(const line of src.split('\n').filter(l=>/^import\b/.test(l)))assert.match(line,/^import type /);
 assert.doesNotMatch(src,/\bfetch\s*\(|localStorage|indexedDB|signTransaction|window\.|document\.|setInterval/);
});
test('wallet renders SOL then every supplied catalogue symbol exactly once',()=>{const x=wallet();x.tokens=[...x.tokens,{symbol:'FUTURE',cluster:'mainnet'}];const m=profileWalletModel(x);assert.deepEqual(m.rows.filter(r=>r.value!==undefined).map(r=>r.title),['SOL','KEEP','SKR','USDC','USDT','FUTURE']);assert.equal(m.rows.find(r=>r.id==='wallet.exchange')?.action?.kind,'navigate');});
test('duplicate catalogue symbols cannot duplicate a wallet row',()=>{const x=wallet();x.tokens=[...x.tokens,...x.tokens,{symbol:'SOL',cluster:'mainnet'}];assert.equal(profileWalletModel(x).rows.filter(r=>r.value!==undefined).length,5);assert.equal(profileWalletModel(x).rows.find(r=>r.id==='wallet.SOL')?.sub,'DEVNET');});
test('PROFILE preserves a confirmed zero Keep level',()=>{const x=overview();x.player!.keepLevel=0;assert.equal(profileOverviewModel(x).rows.find(r=>r.id==='profile.keep')?.value,'0');});
test('known empty saved name permits editing while unread null remains locked',()=>{const x=account();x.savedName='';assert.equal(profileAccountModel(x).saving,false);x.savedName=null;assert.equal(profileAccountModel(x).saving,true);});
test('ProfileAdapterViews imports only the owned sheets and pure mapper',()=>{const src=readFileSync(new URL('./ProfileAdapterViews.tsx',import.meta.url),'utf8');const imports=[...src.matchAll(/^import[^\n]+from ['"]([^'"]+)['"]/gm)].map(m=>m[1]);assert.deepEqual(imports,['./AccountSheets','./profileAdapters']);assert.doesNotMatch(src,/screens\/|EconomyPanel|wallet-adapter|jupiter/i);});


import { WALLET_HUB } from '@shardkeep/shared';
test('the real shared wallet catalogue retains SOL KEEP SKR USDC USDT order and origins', () => {
 const x = wallet(); x.tokens = WALLET_HUB.tokens;
 const rows = profileWalletModel(x).rows.filter(row => row.value !== undefined);
 assert.deepEqual(rows.map(row => [row.title, row.sub]), [
  ['SOL', 'DEVNET'], ['KEEP', 'DEVNET'], ['SKR', 'MAINNET'], ['USDC', 'MAINNET'], ['USDT', 'MAINNET'],
 ]);
});
