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
import { MapSheet, SeekerSpotSheet, DivineFragmentsSheet, DivineTrialsSheet, SolanaWorkshopSheet, RealmPermitSheet, SeekerPanel, IslandRewardsSheet } from './MapSheets';

// review 6d02afc4 N1-N4: additive cases before this follow-up correction.
for(const countdown of [null,'2h'])test(`not-open spot has one honest countdown: ${countdown}`,()=>{
 render(<SeekerSpotSheet state="NOT_OPEN" phase="OPENS_AT" loading={false} countdown={countdown} rows={[]} onIntent={vi.fn()}/>);
 assert.ok(button(/^BIDDING NOT OPEN/));assert.doesNotMatch(button(/^BIDDING NOT OPEN/)?.textContent??'',/…|2h/);
 assert.equal((document.body.textContent??'').split('2h').length-1,countdown===null?0:1);assert.doesNotMatch(document.body.textContent??'',/Bids close in/);
});
test('unopened spot in an open round does not mislabel a deadline as its opening time',()=>{
 render(<SeekerSpotSheet state="NOT_OPEN" phase="OPEN" loading={false} countdown="2h" rows={[]} onIntent={vi.fn()}/>);
 assert.doesNotMatch(document.body.textContent??'',/2h|Bids close in/);assert.ok(button(/^BIDDING NOT OPEN/));
});
test('panel with no countdown renders no permanent countdown placeholder',()=>{
 render(<SeekerPanel phase="OPEN" countdown={null} rows={[]} onIntent={vi.fn()}/>);assert.doesNotMatch(document.body.textContent??'',/Bids close in/);
});
for(const [loading,phase] of [[true,'OPEN'],[false,null]] as const)test(`retained spot and panel clocks are hidden for ${loading}/${phase}`,()=>{
 render(<><SeekerSpotSheet state="LIVE" phase={phase} loading={loading} countdown="2h" rows={[]} onIntent={vi.fn()}/><SeekerPanel phase={phase} loading={loading} countdown="2h" rows={[]} onIntent={vi.fn()}/></>);
 assert.doesNotMatch(document.body.textContent??'',/2h|Bids close in/);
});

// V5 m4/m9 tests first; preserve every earlier assertion.
test('entered workshop draw announces its supplied deadline exactly once',()=>{
 render(<SolanaWorkshopSheet rows={[]} licence="OPEN" entered closesIn="2d 4h" hasClaim={false} onIntent={vi.fn()}/>);
 assert.equal((document.body.textContent??'').split('2d 4h').length-1,1);assert.match(document.body.textContent??'',/Drawn in 2d 4h/);
});
test('unentered workshop draw retains one closes-in line',()=>{
 render(<SolanaWorkshopSheet rows={[]} licence="OPEN" entered={false} closesIn="2d 4h" hasClaim={false} onIntent={vi.fn()}/>);
 assert.equal((document.body.textContent??'').split('2d 4h').length-1,1);assert.match(document.body.textContent??'',/Draw closes in 2d 4h/);
});
test('a supplied leader remains visibly test data and never receives a live label',()=>{
 render(<SeekerSpotSheet state="LIVE" phase="OPEN" loading={false} testData leader={{name:'Fixture leader',price:{currency:'SKR',amount:'17',status:'OK'}}} rows={[]} onIntent={vi.fn()}/>);
 assert.equal(document.querySelector('[data-spot-leader] strong')?.textContent,'Fixture leader');assert.match(document.body.textContent??'',/TEST DATA/);assert.doesNotMatch(document.body.textContent??'',/Live bidding/);
});
test('server-off has no bid primary',()=>{render(<SeekerSpotSheet state="LIVE" phase="SERVER_OFF" loading={false} rows={[]} onIntent={vi.fn()}/>);assert.equal(button(/BID/),null);assert.ok(document.body.textContent?.includes('Auctions are not open on this server yet'));});
test('fragment recovery exposes a saved-receipt action and prevents deliver',()=>{const intent=vi.fn();render(<DivineFragmentsSheet recoveryPending rows={[]} primary={{id:'deliver',label:'DELIVER',state:'ENABLED',kind:'review'}} onIntent={intent}/>);click('CHECK SAVED RECEIPT');assert.deepEqual(intent.mock.calls,[[{id:'fragments',kind:'recover'}]]);assert.equal(button('DELIVER'),null);});
test('an unavailable bid quote explains instead of opening review',()=>{const intent=vi.fn();render(<MapSheet rows={[]} primary={{id:'bid',label:'BID',state:'ENABLED',kind:'review',price:{currency:'SOL',amount:null,status:'UNAVAILABLE'}}} onIntent={intent}/>);assert.equal(button(/BID/)?.getAttribute('aria-disabled'),'true');click(/BID/);assert.deepEqual(intent.mock.calls,[[{id:'bid',kind:'explain',reason:'Price unavailable right now'}]]);});
test('a short row quote routes to need-more',()=>{const intent=vi.fn();render(<MapSheet rows={[{id:'permit',title:'Realm permit',action:{id:'permit',label:'BUY PERMIT',state:'ENABLED',kind:'review',price:{currency:'SOL',amount:'1',status:'SHORT'}}}]} onIntent={intent}/>);click(/BUY PERMIT/);assert.deepEqual(intent.mock.calls,[[{id:'permit',kind:'need-more'}]]);});
test('the SHORT map row price door opens need-more once without a purchase review',()=>{
 const intent=vi.fn();render(<MapSheet rows={[{id:'permit',title:'Realm permit',action:{id:'permit',label:'BUY PERMIT',state:'ENABLED',kind:'review',price:{currency:'SOL',amount:'1',status:'SHORT'}}}]} onIntent={intent}/>);
 const door=document.querySelector<HTMLButtonElement>('.pk-price-door');assert.ok(door);assert.match(door.getAttribute('aria-label')??'',/See where to get more/);
 act(()=>{door.dispatchEvent(new MouseEvent('click',{bubbles:true}));});assert.deepEqual(intent.mock.calls,[[{id:'permit',kind:'need-more'}]]);
});
for(const state of ['BUSY','LOCKED','DISABLED'] as const)test(`a SHORT pill cannot bypass the map ${state} guard`,()=>{
 const intent=vi.fn();render(<MapSheet rows={[]} primary={{id:'bid',label:'BID',state,reason:'Bids unavailable',kind:'review',price:{currency:'SKR',amount:'12',status:'SHORT'}}} onIntent={intent}/>);
 assert.equal(document.querySelector('.pk-price-door'),null);click(/BID/);assert.deepEqual(intent.mock.calls,state==='BUSY'?[]:[[{id:'bid',kind:'explain',reason:'Bids unavailable'}]]);
});
test('an unavailable map price has no separate action door',()=>{
 render(<MapSheet rows={[]} primary={{id:'bid',label:'BID',state:'ENABLED',kind:'review',price:{currency:'SKR',amount:null,status:'UNAVAILABLE'}}} onIntent={vi.fn()}/>);assert.equal(document.querySelector('.pk-price-door'),null);assert.equal(button(/BID/)?.getAttribute('aria-disabled'),'true');
});
test('server-off preserves an authorized saved spot recovery without bidding or stepping',()=>{
 const intent=vi.fn(), step=vi.fn();render(<SeekerSpotSheet state="LIVE" phase="SERVER_OFF" loading={false} rows={[]} recoveryPending bidState="ENABLED" bid={{currency:'SKR',amount:'12',status:'OK'}} onBidStep={step} onIntent={intent}/>);
 assert.equal(button(/BID/),null);assert.equal(button('LESS'),null);assert.equal(button('MORE'),null);assert.equal(button('CLAIM'),null);click('CHECK SAVED RECEIPT');
 assert.deepEqual(intent.mock.calls,[[{id:'spot.saved',kind:'recover'}]]);assert.equal(step.mock.calls.length,0);
});
test('server-off without a saved request offers no invented recovery action',()=>{
 render(<SeekerSpotSheet state="LIVE" phase="SERVER_OFF" loading={false} rows={[]} onIntent={vi.fn()}/>);assert.equal(button('CHECK SAVED RECEIPT'),null);assert.equal(button(/BID/),null);
});

test('map layout uses the token bridge and all viewport classes without local pixel breakpoints',()=>{
 const css=readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MapSheets.css'),'utf8');assert.doesNotMatch(css,/\d+(?:\.\d+)?px\b/);assert.doesNotMatch(css,/@media/);assert.match(css,/var\(--pk-min-tap\)/);
 for(const viewport of ['phone-portrait','phone-landscape','tablet-portrait','tablet-landscape','desktop'])assert.ok(css.includes(`html[data-pk-vp="${viewport}"]`),viewport);
});
for(const state of ['BUSY','LOCKED','DISABLED','SHORT'] as const)test(`bid stepper follows drawn ${state} precedence`,()=>{
 const step=vi.fn();render(<SeekerSpotSheet state="LIVE" phase="OPEN" loading={false} rows={[]} bidState={state} bid={{currency:'SKR',amount:'12',status:'OK'}} onBidStep={step} onIntent={vi.fn()}/>);
 assert.equal(button('LESS')?.disabled,state!=='SHORT');assert.equal(button('MORE')?.disabled,state!=='SHORT');click('LESS');click('MORE');assert.deepEqual(step.mock.calls,state==='SHORT'?[['less'],['more']]:[]);
});
test('an unavailable bid quote disables both stepper controls even when caller state is enabled',()=>{
 const step=vi.fn();render(<SeekerSpotSheet state="LIVE" phase="OPEN" loading={false} rows={[]} bidState="ENABLED" bid={{currency:'SKR',amount:null,status:'UNAVAILABLE'}} onBidStep={step} onIntent={vi.fn()}/>);assert.equal(button('LESS')?.disabled,true);assert.equal(button('MORE')?.disabled,true);click('MORE');assert.deepEqual(step.mock.calls,[]);
});
test('pending recovery hides stepper controls during an open auction',()=>{
 render(<SeekerSpotSheet state="LIVE" phase="OPEN" loading={false} rows={[]} recoveryPending bidState="ENABLED" onBidStep={vi.fn()} onIntent={vi.fn()}/>);assert.equal(button('LESS'),null);assert.equal(button('MORE'),null);
});
test('an entered licence player sees ENTERED and their draw countdown',()=>{
 render(<SolanaWorkshopSheet rows={[]} licence="OPEN" entered closesIn="2d 4h" hasClaim={false} onIntent={vi.fn()}/>);assert.ok(button(/^ENTERED/));assert.equal(button(/^ENTERED/)?.getAttribute('data-state'),'disabled');assert.match(document.body.textContent??'',/Drawn in 2d 4h/);assert.doesNotMatch(document.body.textContent??'',/DRAW OPENS LATER/);
});
test('an unopened licence draw keeps the ENTER DRAW label with a locked reason',()=>{
 render(<SolanaWorkshopSheet rows={[]} licence="NONE" entered={false} closesIn={null} hasClaim={false} onIntent={vi.fn()}/>);assert.ok(button(/^ENTER DRAW/));assert.equal(button(/^ENTER DRAW/)?.getAttribute('data-state'),'locked');
});
test('a nonpending fragment sheet exposes the actual supplied delivery review',()=>{
 const intent=vi.fn();render(<DivineFragmentsSheet recoveryPending={false} rows={[]} primary={{id:'deliver',label:'DELIVER',state:'ENABLED',kind:'review'}} onIntent={intent}/>);click('DELIVER');assert.deepEqual(intent.mock.calls,[[{id:'deliver',kind:'review'}]]);
});
for(const surface of ['fragments','trials'] as const)test(`${surface} pending recovery blocks a supplied mutation row`,()=>{
 const intent=vi.fn();const rows=[{id:'row',title:'Current request',action:{id:'new',label:'START ANOTHER',state:'ENABLED' as const,kind:'review' as const}}];render(surface==='fragments'?<DivineFragmentsSheet recoveryPending rows={rows} onIntent={intent}/>:<DivineTrialsSheet attemptChecking rows={rows} onIntent={intent}/>);assert.equal(button(/^START ANOTHER/)?.getAttribute('aria-disabled'),'true');click(/^START ANOTHER/);assert.equal(intent.mock.calls[0]?.[0]?.kind,'explain');
});
test('spot and permit enum states use player copy',()=>{
 render(<><SeekerSpotSheet state="LICENCE_LATER" phase="OPERATING" loading={false} rows={[]} onIntent={vi.fn()}/><RealmPermitSheet rows={[]} realms={[{id:'x',name:'Realm',state:'NOT_SOLD',coveredUntil:null}]} selected={null} onSelect={vi.fn()} onIntent={vi.fn()}/></>);assert.doesNotMatch(document.body.textContent??'',/LICENCE LATER|NOT SOLD/);assert.match(document.body.textContent??'',/Licence draw opens later|Not sold here/);
});


// V4: authored before the presentation delta; execution is reserved for Cedar3.
for(const [phase,copy] of [['OPEN','Bids close in 2h'],['OPENS_AT','Bidding opens 2h'],['OPERATING','Operating · next auction in 2h'],['SERVER_OFF',null]] as const)test(`Seeker panel countdown follows authoritative phase ${phase}`,()=>{
 render(<SeekerPanel phase={phase} countdown="2h" rows={[]} onIntent={vi.fn()}/>);
 if(copy)assert.match(document.body.textContent??'',new RegExp(copy));else assert.doesNotMatch(document.body.textContent??'',/2h|Bids close in|Bidding opens/);
});
for(const [name,copy] of [['  Ada  ','Ada'],['  ','a Seeker player']] as const)test(`spot top bidder uses the supplied name or fallback: ${JSON.stringify(name)}`,()=>{
 render(<SeekerSpotSheet state="LIVE" phase="OPEN" loading={false} countdown="2h" leader={{name,price:{currency:'SKR',amount:'12',status:'OK'}}} rows={[]} onIntent={vi.fn()}/>);
 const card=document.querySelector('[data-spot-leader]');assert.ok(card);assert.match(card.textContent??'',/TOP BID/);assert.equal(card.querySelector('strong')?.textContent,copy);assert.match(card.textContent??'',/12/);assert.match(document.body.textContent??'',/Bids close in 2h/);
});
test('server-off hides retained top bidder and countdown content',()=>{
 render(<SeekerSpotSheet state="LIVE" phase="SERVER_OFF" loading={false} countdown="2h" leader={{name:'Ada',price:{currency:'SKR',amount:'12',status:'OK'}}} rows={[]} onIntent={vi.fn()}/>);
 assert.equal(document.querySelector('[data-spot-leader]'),null);assert.doesNotMatch(document.body.textContent??'',/Ada|2h/);
});
for(const [licence,copy] of [['OPEN','Draw closes in 2h'],['NONE','Licence draw opens later']] as const)test(`workshop countdown follows licence ${licence}`,()=>{
 render(<SolanaWorkshopSheet licence={licence} entered={false} closesIn="2h" hasClaim={false} rows={[]} onIntent={vi.fn()}/>);assert.ok(document.body.textContent?.includes(copy));if(licence==='NONE')assert.doesNotMatch(document.body.textContent??'',/2h/);
});
for(const [tab,selected] of [[null,'MATERIALS'],['old-route','MATERIALS'],['REALMS_CUT',"REALM'S CUT"]] as const)test(`controlled rewards tab normalizes ${JSON.stringify(tab)} without callback on render`,()=>{
 const onTab=vi.fn();render(<IslandRewardsSheet tab={tab} onTab={onTab} terms={[]} kingdom="Home" kingdomMissing={false} rows={[]} onIntent={vi.fn()}/>);
 assert.equal(document.querySelector('.pk-map-sheet__tabs [aria-pressed="true"]')?.textContent,selected);assert.equal(onTab.mock.calls.length,0);assert.equal((document.body.textContent??'').includes('INTO Home'),tab!=='REALMS_CUT');click('SHARDS');assert.deepEqual(onTab.mock.calls,[['SHARDS']]);
});


// V4.1 tests first: truthful optional content and quote layout ownership.
test('TOP BID quote layout belongs to the inner content, not the plate shell',()=>{
 render(<SeekerSpotSheet state="LIVE" phase="OPEN" loading={false} leader={{name:'Ada',price:null}} rows={[]} onIntent={vi.fn()}/>);const card=document.querySelector('[data-spot-leader]');assert.ok(card);assert.equal(card.classList.contains('pk-map-sheet__quote'),true);assert.equal(card.closest('.pk-plate')?.classList.contains('pk-map-sheet__quote'),false);
});
for(const provided of [false,true])test(`${provided?'null':'omitted'} spot countdown adds no permanent placeholder`,()=>{
 render(<SeekerSpotSheet state="LIVE" phase="OPEN" loading={false} {...(provided?{countdown:null}:{})} rows={[]} onIntent={vi.fn()}/>);assert.doesNotMatch(document.body.textContent??'',/Bids close in|Operating · next auction in|Bidding opens/);
});
for(const [loading,phase] of [[true,'OPEN'],[false,null]] as const)test(`loading or unknown-phase spot hides retained leader: ${loading}/${phase}`,()=>{
 render(<SeekerSpotSheet state="LIVE" phase={phase} loading={loading} leader={{name:'Ada',price:{currency:'SKR',amount:'12',status:'OK'}}} rows={[]} onIntent={vi.fn()}/>);assert.equal(document.querySelector('[data-spot-leader]'),null);assert.doesNotMatch(document.body.textContent??'',/Ada/);
});

// 861478c1 B1 challenger: locked primary reasons must also occur once.
for(const [licence,copy] of [['NONE','Licence draw opens later'],['OCCUPIED','Next draw opens later']] as const)test(`locked workshop reason appears once: ${licence}`,()=>{
 render(<SolanaWorkshopSheet rows={[]} licence={licence} entered={false} closesIn={null} hasClaim={false} onIntent={vi.fn()}/>);
 assert.equal((document.body.textContent??'').split(copy).length-1,1);assert.ok(button(/^ENTER DRAW/));
});
