// @vitest-environment happy-dom
import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProfileOverviewAdapter, ProfileWalletAdapter, ProfileAccountAdapter } from './ProfileAdapterViews';
import type { ProfileWalletInput, ProfileAccountInput } from './profileAdapters';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|undefined;
function render(node:React.ReactNode){const el=document.createElement('div');document.body.append(el);act(()=>{root=createRoot(el);root.render(node);});}
function click(label:string){const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')??x.textContent??'')===label);assert.ok(b);act(()=>b.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
afterEach(()=>{act(()=>root?.unmount());root=undefined;document.body.replaceChildren();});
const wallet=():ProfileWalletInput=>({wallet:'wallet',snapshot:null,gameCluster:'devnet',tokens:[{symbol:'KEEP',cluster:'game'},{symbol:'SKR',cluster:'mainnet'},{symbol:'USDC',cluster:'mainnet'},{symbol:'USDT',cluster:'mainnet'}],loading:false,error:null,formatAmount:n=>n===null?'…':String(n)});
const account=():ProfileAccountInput=>({wallet:'wallet',snapshotWallet:'wallet',savedName:'Ada',draft:'Ada',saving:false,nameError:null,providers:{WALLET:true},security:null,loading:false,error:null});
test('wallet adapter has exactly one history control with supplied counts',()=>{
 const history=vi.fn();render(<ProfileWalletAdapter input={wallet()} history={{needs:2,done:3}} onHistory={history} onIntent={vi.fn()}/>);click('HISTORY');assert.equal(history.mock.calls.length,1);assert.equal([...document.querySelectorAll('button')].filter(b=>(b.getAttribute('aria-label')??'').toUpperCase()==='HISTORY').length,1);
});
test('wallet connect navigation remains available without displaying a linked address',()=>{
 const x=wallet();x.wallet=null;const intent=vi.fn();render(<ProfileWalletAdapter input={x} onIntent={intent}/>);click('CONNECT WALLET');assert.deepEqual(intent.mock.calls,[[{id:'wallet.connect',kind:'navigate'}]]);assert.equal([...document.querySelectorAll('button')].some(b=>b.textContent==='COPY ADDRESS'),false);
});
test('account adapter retains last-linked-method protection',()=>{
 const intent=vi.fn();render(<ProfileAccountAdapter input={account()} onName={vi.fn()} onIntent={intent}/>);click('UNLINK');assert.equal(intent.mock.calls.length,0);assert.match(document.body.textContent??'',/Keep at least one/);
});
test('account adapter keeps security in the existing navigation path',()=>{
 const intent=vi.fn();render(<ProfileAccountAdapter input={account()} onName={vi.fn()} onIntent={intent}/>);click('2-STEP CODE');assert.deepEqual(intent.mock.calls,[[{id:'security.totp',kind:'navigate'}]]);
});
test('profile overview emits navigation to the existing economy destination',()=>{
 const intent=vi.fn();render(<ProfileOverviewAdapter input={{wallet:'wallet',player:null,loading:true,error:null}} onIntent={intent}/>);click('ECONOMY');assert.deepEqual(intent.mock.calls,[[{id:'account.economy',kind:'navigate'}]]);
});
test('wallet retains USDC USDT and existing exchange navigation',()=>{const intent=vi.fn();render(<ProfileWalletAdapter input={wallet()} onIntent={intent}/>);assert.match(document.body.textContent??'',/USDC/);assert.match(document.body.textContent??'',/USDT/);click('EXCHANGE (JUPITER)');assert.deepEqual(intent.mock.calls,[[{id:'wallet.exchange',kind:'navigate'}]]);});
