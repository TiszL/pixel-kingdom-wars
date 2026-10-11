// @vitest-environment happy-dom
import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
let root: Root | undefined;
function render(node: React.ReactNode) { const div=document.createElement('div'); document.body.append(div); act(()=>{root=createRoot(div);root.render(node);}); }
function button(name:string|RegExp):HTMLButtonElement|null { return [...document.querySelectorAll('button')].find(b=>typeof name==='string'?(b.getAttribute('aria-label')??b.textContent)===name:name.test(b.getAttribute('aria-label')??b.textContent??''))??null; }
function click(name:string|RegExp) { const b=button(name); assert.ok(b, `Missing button ${name}`); act(()=>{b.dispatchEvent(new MouseEvent('click',{bubbles:true}));}); }
afterEach(()=>{act(()=>root?.unmount());root=undefined;document.body.replaceChildren();});
import { AccountSheet, LandDoneCard, ProfileAccountTab, ClanMembersTab, ProfileKingdomsTab, ProfileWalletTab, TitleScreen, RealmPickerSheet } from './AccountSheets';
test('unknown prices open review and never execute a purchase',()=>{const intent=vi.fn();render(<AccountSheet screen="LAND" title="CLAIM YOUR LAND" rows={[]} primary={{id:'settle',label:'SETTLE',state:'ENABLED',kind:'review',price:{currency:'SOL',amount:null,status:'CHECKING'}}} onIntent={intent}/>);click(/SETTLE/);assert.deepEqual(intent.mock.calls,[[{id:'settle',kind:'review'}]]);});
test('a busy action cannot duplicate the request',()=>{const intent=vi.fn();render(<AccountSheet screen="SUPPLIES" rows={[]} primary={{id:'buy',label:'BUY',state:'BUSY',kind:'review'}} onIntent={intent}/>);click('BUY');assert.equal(intent.mock.calls.length,0);});
test('an unavailable quote explains its disabled state instead of opening review',()=>{const intent=vi.fn();render(<AccountSheet screen="SUPPLIES" rows={[]} primary={{id:'buy',label:'BUY',state:'ENABLED',kind:'review',price:{currency:'SKR',amount:null,status:'UNAVAILABLE'}}} onIntent={intent}/>);assert.equal(button(/BUY/)?.getAttribute('aria-disabled'),'true');click(/BUY/);assert.deepEqual(intent.mock.calls,[[{id:'buy',kind:'explain',reason:'Price unavailable right now'}]]);});
test('a short quote routes to need-more',()=>{const intent=vi.fn();render(<AccountSheet screen="SUPPLIES" rows={[]} primary={{id:'buy',label:'BUY',state:'ENABLED',kind:'review',price:{currency:'SKR',amount:'12',status:'SHORT'}}} onIntent={intent}/>);click(/BUY/);assert.deepEqual(intent.mock.calls,[[{id:'buy',kind:'need-more'}]]);});
test('the SHORT price door opens need-more once without invoking the purchase intent',()=>{
 const intent=vi.fn();render(<AccountSheet screen="SUPPLIES" rows={[]} primary={{id:'supply',label:'BUY',state:'ENABLED',kind:'review',price:{currency:'SKR',amount:'12',status:'SHORT'}}} onIntent={intent}/>);
 const door=document.querySelector<HTMLButtonElement>('.pk-price-door');assert.ok(door);assert.match(door.getAttribute('aria-label')??'',/See where to get more/);
 act(()=>{door.dispatchEvent(new MouseEvent('click',{bubbles:true}));});assert.deepEqual(intent.mock.calls,[[{id:'supply',kind:'need-more'}]]);
});
for(const state of ['BUSY','LOCKED','DISABLED'] as const)test(`a SHORT pill cannot bypass the account ${state} guard`,()=>{
 const intent=vi.fn();render(<AccountSheet screen="SUPPLIES" rows={[]} primary={{id:'supply',label:'BUY',state,reason:'Unavailable now',kind:'review',price:{currency:'SKR',amount:'12',status:'SHORT'}}} onIntent={intent}/>);
 assert.equal(document.querySelector('.pk-price-door'),null);click(/BUY/);assert.deepEqual(intent.mock.calls,state==='BUSY'?[]:[[{id:'supply',kind:'explain',reason:'Unavailable now'}]]);
});
test('an unavailable account price stays informational and cannot bypass its disabled primary',()=>{
 render(<AccountSheet screen="SUPPLIES" rows={[]} primary={{id:'supply',label:'BUY',state:'ENABLED',kind:'review',price:{currency:'SKR',amount:null,status:'UNAVAILABLE'}}} onIntent={vi.fn()}/>);assert.equal(document.querySelector('.pk-price-door'),null);assert.equal(button(/BUY/)?.getAttribute('aria-disabled'),'true');
});

test('account layout uses the token bridge and all viewport classes without local pixel breakpoints',()=>{
 const css=readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'AccountSheets.css'),'utf8');assert.doesNotMatch(css,/\d+(?:\.\d+)?px\b/);assert.doesNotMatch(css,/@media/);assert.match(css,/var\(--pk-min-tap\)/);
 for(const viewport of ['phone-portrait','phone-landscape','tablet-portrait','tablet-landscape','desktop'])assert.ok(css.includes(`html[data-pk-vp="${viewport}"]`),viewport);
});
for(const receiptId of ['', '  ', null, 'r-1'])test(`land completion requires a trimmed receipt: ${JSON.stringify(receiptId)}`,()=>{
 render(<LandDoneCard receiptId={receiptId} rows={[]} onIntent={vi.fn()}/>);assert.equal(document.querySelector('.pk-frame')!==null,receiptId==='r-1');
});
test('account roles and provider keys use player copy',()=>{
 render(<><ProfileAccountTab rows={[]} draft="A" saved="A" saving={false} linked={{EMAIL:true}} onName={vi.fn()} onIntent={vi.fn()}/><ClanMembersTab role="MEMBER" sort="TROPHIES" onSort={vi.fn()} members={[{id:'m',name:'Ada',role:'LEADER',isYou:false,online:true,trophies:null,wins:null}]} onIntent={vi.fn()}/></>);
 assert.doesNotMatch(document.body.textContent??'',/EMAIL|LEADER/);assert.match(document.body.textContent??'',/Email|Captain/);
});


// V4: authored before the presentation delta; execution is reserved for Cedar3.
for(const [landless,count,copy] of [[true,0,'Choose a realm to start your kingdom.'],[false,1,'Your kingdom'],[false,2,'Your kingdoms']] as const)test(`kingdom summary renders its controlled mode ${count}`,()=>{
 render(<ProfileKingdomsTab summary={{landless,count,additionalLandPrice:null}} rows={[]} onIntent={vi.fn()}/>);assert.equal(document.querySelector('[data-kingdom-summary]')?.textContent,copy);
});
for(const [status,copy] of [['SERVER_ZERO','Your second land is free'],['CHECKING','Another land: … SOL']] as const)test(`additional land copy preserves quote state ${status}`,()=>{
 render(<ProfileKingdomsTab summary={{landless:false,count:1,additionalLandPrice:{currency:'SOL',amount:null,status}}} rows={[]} onIntent={vi.fn()}/>);assert.ok(document.body.textContent?.includes(copy));
});
for(const [needs,done,copy] of [[null,null,'… need you · … done'],[2,3,'2 need you · 3 done']] as const)test(`wallet history renders supplied receipt counts ${needs}`,()=>{
 const history=vi.fn();render(<ProfileWalletTab address={null} history={{needs,done}} onHistory={history} rows={[]} onIntent={vi.fn()}/>);assert.ok(document.body.textContent?.includes(copy));click('HISTORY');assert.equal(history.mock.calls.length,1);
});
for(const [busy,label] of [[null,'CONTINUE AS Ada'],['WALLET_CHECK','CHECK WALLET'],['WALLET_SENDING','SENDING'],['SOCIAL','CONTINUE AS Ada']] as const)test(`title connection preserves busy routing ${busy}`,()=>{
 const intent=vi.fn();render(<TitleScreen connect={{lastPlayer:'Ada',busy}} rows={[]} onIntent={intent}/>);assert.ok(button(label));click(label);assert.deepEqual(intent.mock.calls,busy===null?[[{id:'title.connect',kind:'navigate'}]]:[]);
});
for(const [outcome,copy] of [['IN_FLIGHT',null],['CHECKING','We are checking your payment. Your land is safe if it went through.'],['REFUSED','Realm is full. Nothing was spent.']] as const)test(`land payment content preserves the supplied outcome ${outcome}`,()=>{
 render(<RealmPickerSheet realms={[]} selected={null} price={{currency:'SOL',amount:null,status:'CHECKING'}} payment={{outcome,reason:'Realm is full.'}} onSelect={vi.fn()} onIntent={vi.fn()}/>);
 assert.equal(document.querySelector('[data-land-payment]')?.textContent??null,copy);
});


// V4.1 tests first: unresolved payments suppress default and host-driven primaries.
for(const outcome of ['IN_FLIGHT','CHECKING'] as const)for(const custom of [false,true])test(`${outcome} payment blocks ${custom?'host':'default'} land primary and SHORT door`,()=>{
 const intent=vi.fn();const primary=custom?{primary:{id:'host.settle',label:'CONFIRM LAND',state:'ENABLED' as const,kind:'review' as const,price:{currency:'SOL' as const,amount:'1',status:'SHORT' as const}}}:{};
 render(<RealmPickerSheet realms={[{id:'r',name:'Fir',lock:'NONE',sub:''}]} selected="r" price={{currency:'SOL',amount:'1',status:'OK'}} payment={{outcome,reason:null}} {...primary} onSelect={vi.fn()} onIntent={intent}/>);
 const label=custom?'CONFIRM LAND':'SETTLE IN FIR';assert.equal(button(new RegExp(label))?.getAttribute('data-state'),'busy');assert.equal(document.querySelector('.pk-price-door'),null);click(new RegExp(label));assert.deepEqual(intent.mock.calls,[]);
});
test('realm picker preserves a host-disabled primary when no payment is pending',()=>{
 const intent=vi.fn();render(<RealmPickerSheet realms={[{id:'r',name:'Fir',lock:'NONE',sub:''}]} selected="r" price={{currency:'SOL',amount:'1',status:'OK'}} primary={{id:'host',label:'WAIT FOR HOST',state:'DISABLED',kind:'review'}} onSelect={vi.fn()} onIntent={intent}/>);
 assert.equal(button('SETTLE IN FIR'),null);assert.equal(button('WAIT FOR HOST')?.getAttribute('data-state'),'disabled');click('WAIT FOR HOST');assert.deepEqual(intent.mock.calls,[]);
});
test('realm picker accepts an explicitly absent host primary',()=>{
 render(<RealmPickerSheet realms={[{id:'r',name:'Fir',lock:'NONE',sub:''}]} selected="r" price={{currency:'SOL',amount:'1',status:'OK'}} primary={null} onSelect={vi.fn()} onIntent={vi.fn()}/>);assert.equal(button(/SETTLE IN FIR/),null);
});

// V5 m5/m6/m7/m9: tests authored before the presentation corrections.
for(const outcome of ['IN_FLIGHT','CHECKING'] as const)test(`default SHORT land primary cannot bypass ${outcome}`,()=>{
 const intent=vi.fn();render(<RealmPickerSheet realms={[{id:'r',name:'Fir',lock:'NONE',sub:''}]} selected="r" price={{currency:'SOL',amount:'1',status:'SHORT'}} payment={{outcome,reason:null}} onSelect={vi.fn()} onIntent={intent}/>);
 assert.equal(document.querySelector('.pk-price-door'),null);assert.equal(button(/SETTLE IN FIR/)?.getAttribute('data-state'),'busy');click(/SETTLE IN FIR/);assert.deepEqual(intent.mock.calls,[]);
});
test('host-disabled land primary replaces every default settle button including its price text',()=>{
 render(<RealmPickerSheet realms={[{id:'r',name:'Fir',lock:'NONE',sub:''}]} selected="r" price={{currency:'SOL',amount:'1',status:'OK'}} primary={{id:'host',label:'HOST WAIT',kind:'review',state:'DISABLED'}} onSelect={vi.fn()} onIntent={vi.fn()}/>);
 assert.equal([...document.querySelectorAll('button')].some(b=>(b.textContent??'').includes('SETTLE IN FIR')),false);assert.equal(button('HOST WAIT')?.getAttribute('aria-disabled'),'true');
});
test('checking land payment remains a non-error status announcement',()=>{
 render(<RealmPickerSheet realms={[]} selected={null} price={{currency:'SOL',amount:null,status:'CHECKING'}} payment={{outcome:'CHECKING',reason:null}} onSelect={vi.fn()} onIntent={vi.fn()}/>);assert.equal(document.querySelector('[data-land-payment]')?.getAttribute('role'),'status');
});
test('wallet history has one quiet door and no duplicate header control',()=>{
 const history=vi.fn();render(<ProfileWalletTab address={null} history={{needs:1,done:2}} onHistory={history} rows={[]} onIntent={vi.fn()}/>);
 const doors=[...document.querySelectorAll('button')].filter(b=>(b.getAttribute('aria-label')??b.textContent??'').toUpperCase()==='HISTORY');
 assert.equal(doors.length,1);assert.ok(doors[0]?.className.includes('pk-quiet'));click('HISTORY');assert.equal(history.mock.calls.length,1);
});
test('land refusal is announced as an alert and checking remains a status',()=>{
 render(<RealmPickerSheet realms={[]} selected={null} price={{currency:'SOL',amount:null,status:'CHECKING'}} payment={{outcome:'REFUSED',reason:'Realm is full.'}} onSelect={vi.fn()} onIntent={vi.fn()}/>);
 assert.equal(document.querySelector('[data-land-payment]')?.getAttribute('role'),'alert');
});
test('landless summary suppresses an additional-land quote even when supplied',()=>{
 render(<ProfileKingdomsTab summary={{landless:true,count:0,additionalLandPrice:{currency:'SOL',amount:'27',status:'OK'}}} rows={[]} onIntent={vi.fn()}/>);
 assert.doesNotMatch(document.body.textContent??'',/Another land|27 SOL|second land is free/);
});
test('omitted kingdom summary preserves rows without invented mode or price',()=>{
 render(<ProfileKingdomsTab rows={[{id:'k',title:'Original kingdom'}]} onIntent={vi.fn()}/>);
 assert.equal(document.querySelector('[data-kingdom-summary]'),null);assert.match(document.body.textContent??'',/Original kingdom/);assert.doesNotMatch(document.body.textContent??'',/Another land/);
});
test('omitted wallet history preserves the existing header history door',()=>{
 const history=vi.fn();render(<ProfileWalletTab address={null} rows={[]} onHistory={history} onIntent={vi.fn()}/>);
 click('History');assert.equal(history.mock.calls.length,1);assert.doesNotMatch(document.body.textContent??'',/need you|done/);
});
test('omitted title connection preserves the original host primary',()=>{
 const intent=vi.fn();render(<TitleScreen rows={[]} primary={{id:'host',label:'HOST SIGN IN',kind:'navigate',state:'ENABLED'}} onIntent={intent}/>);
 click('HOST SIGN IN');assert.deepEqual(intent.mock.calls,[[{id:'host',kind:'navigate'}]]);
});
test('supplied title connection deliberately takes precedence over a host primary',()=>{
 render(<TitleScreen rows={[]} connect={{lastPlayer:null,busy:'WALLET_CHECK'}} primary={{id:'host',label:'HOST SIGN IN',kind:'navigate',state:'ENABLED'}} onIntent={vi.fn()}/>);
 assert.equal(button('HOST SIGN IN'),null);assert.equal(button('CHECK WALLET')?.getAttribute('data-state'),'busy');
});
