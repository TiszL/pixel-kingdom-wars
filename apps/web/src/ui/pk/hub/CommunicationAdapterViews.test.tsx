// @vitest-environment happy-dom
import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatContentAdapter, FeedbackContentAdapter } from './CommunicationAdapterViews';
import type { ChatContentInput, FeedbackContentInput } from './communicationAdapters';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root:Root|undefined;
function render(node:React.ReactNode){const el=document.createElement('div');document.body.append(el);act(()=>{root=createRoot(el);root.render(node);});}
function click(label:string){const b=[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')??b.textContent??'').startsWith(label));assert.ok(b,label);act(()=>b.dispatchEvent(new MouseEvent('click',{bubbles:true})));}
afterEach(()=>{act(()=>root?.unmount());root=undefined;document.body.replaceChildren();});
const chat=():ChatContentInput=>({wallet:'w',snapshot:{wallet:'w',status:{enabled:true,canSend:true,sendBlockedReason:null,mutedUntil:null,pollOpenMs:1,pollClosedMs:1,latestEventId:'c'},rows:[{message:{id:'m',clientMessageId:'original',text:'<script>bad()</script>',createdAt:'when',author:{name:'Keeper',avatarUrl:null,seekerVerified:false},canBlock:true},delivery:'failed'}],blocks:[],nextBefore:null,blocksNext:null,newCount:0,reported:[],reporting:null},body:'Hello',draft:{text:'Hello',graphemes:5,bytes:5,lines:1,valid:true},limits:{maxGraphemes:12,maxUtf8Bytes:40,maxLines:3},reportReasons:[{id:'spam',label:'SPAM'},{id:'harassment',label:'HARASSMENT'},{id:'hate',label:'HATE'},{id:'sexual',label:'SEXUAL'},{id:'personal_info',label:'PERSONAL INFO'},{id:'other',label:'OTHER'}],ready:true,fresh:true,loadingOlder:false,blocksBusy:false,blocksOpen:false,notice:null,formatTime:s=>s});
const feedback=():FeedbackContentInput=>({wallet:'w',snapshot:{wallet:'w',category:'bug',title:'Bug',body:'Steps observed',pending:null,busy:false,storageError:null,notice:null,evidenceIssue:null,recurrence:false,localImageIds:[],reports:[],loading:false,error:null,nextCursor:null},limits:{categories:['bug','balance','ux','idea','other'],titleMaxLen:20,bodyMinLen:4,bodyMaxLen:60},formatTime:s=>s});
test('chat retry dispatches original client UUID with no render side effect',()=>{const intent=vi.fn();render(<ChatContentAdapter input={chat()} onIntent={intent} onDraft={vi.fn()}/>);assert.equal(intent.mock.calls.length,0);click('RETRY MESSAGE');assert.deepEqual(intent.mock.calls,[[{id:'chat.retry:original',kind:'action'}]]);});
test('chat text stays inert and copyable',()=>{render(<ChatContentAdapter input={chat()} onIntent={vi.fn()} onDraft={vi.fn()}/>);assert.equal(document.querySelector('script'),null);assert.match(document.querySelector('[role="log"]')?.textContent??'',/<script>bad\(\)<\/script>/);});
test('no clan send destination is invented',()=>{render(<ChatContentAdapter input={chat()} onIntent={vi.fn()} onDraft={vi.fn()}/>);assert.doesNotMatch(document.body.textContent??'',/CLAN/);});
test('chat moderation never appears on a failed outgoing row',()=>{render(<ChatContentAdapter input={chat()} onIntent={vi.fn()} onDraft={vi.fn()}/>);assert.ok([...document.querySelectorAll('button')].every(b=>!/^REPORT|^BLOCK Keeper/.test(b.getAttribute('aria-label')??'')));});
test('blocked-player pagination preserves existing owner route',()=>{const x=chat();x.blocksOpen=true;x.snapshot!.blocksNext='cursor';const intent=vi.fn();render(<ChatContentAdapter input={x} onIntent={intent} onDraft={vi.fn()}/>);click('MORE BLOCKED PLAYERS');assert.deepEqual(intent.mock.calls,[[{id:'chat.blocks.more',kind:'recover'}]]);});
test('foreign chat hides composer draft and private content',()=>{const x=chat();x.wallet='other';render(<ChatContentAdapter input={x} onIntent={vi.fn()} onDraft={vi.fn()}/>);assert.equal(document.querySelector('textarea'),null);assert.doesNotMatch(document.body.textContent??'',/bad\(\)/);});
test('feedback uses current categories with accessible labels',()=>{render(<FeedbackContentAdapter input={feedback()} onIntent={vi.fn()} onDraft={vi.fn()}/>);assert.ok(document.querySelector('select[aria-label="Feedback category"]'));assert.match(document.body.textContent??'',/BALANCE/);assert.doesNotMatch(document.body.textContent??'',/PAYMENT/);});
test('saved feedback locks original text and emits original retry',()=>{const x=feedback();x.snapshot!.pending={requestId:'saved',category:'bug',title:'Original',body:'Original body',context:{}};const intent=vi.fn();render(<FeedbackContentAdapter input={x} onIntent={intent} onDraft={vi.fn()}/>);assert.equal(document.querySelector('input')?.value,'Original');assert.equal(document.querySelector('input')?.disabled,true);click('RETRY SAVED REPORT');assert.deepEqual(intent.mock.calls,[[{id:'feedback.retry:saved',kind:'recover'}]]);});
test('foreign feedback omits private slots and current draft',()=>{const x=feedback();x.wallet='other';render(<FeedbackContentAdapter input={x} onIntent={vi.fn()} onDraft={vi.fn()} screenshots={() => <div>Private image</div>}/>);assert.equal(document.querySelector('textarea'),null);assert.doesNotMatch(document.body.textContent??'',/Private image|Steps observed/);});
test('report list failure retains retry without deleting composer',()=>{const x=feedback();x.snapshot!.error='Read failed';const intent=vi.fn();render(<FeedbackContentAdapter input={x} onIntent={intent} onDraft={vi.fn()}/>);assert.ok(document.querySelector('textarea'));click('RETRY REPORTS');assert.deepEqual(intent.mock.calls,[[{id:'feedback.reports.refresh',kind:'recover'}]]);});
test('screenshot slot receives the busy disabled state',()=>{const x=feedback();x.snapshot!.busy=true;const slot=vi.fn(()=>null);render(<FeedbackContentAdapter input={x} onIntent={vi.fn()} onDraft={vi.fn()} screenshots={slot}/>);assert.equal(slot.mock.calls.length,1);assert.deepEqual(slot.mock.calls[0],[{disabled:true,missingImages:0,pending:null}]);});
test('saved feedback close requests preserve the saved journal',()=>{const x=feedback();x.snapshot!.pending={requestId:'saved',category:'bug',title:'Original',body:'Original body',context:{}};const close=vi.fn();render(<FeedbackContentAdapter input={x} onIntent={vi.fn()} onDraft={vi.fn()} onRequestClose={close}/>);click('Close');assert.deepEqual(close.mock.calls,[['saved']]);});
test('own canonical chat message has no MENTION action',()=>{const x=chat();delete x.snapshot!.rows[0]!.delivery;x.snapshot!.rows[0]!.message.canBlock=false;render(<ChatContentAdapter input={x} onIntent={vi.fn()} onDraft={vi.fn()}/>);assert.ok([...document.querySelectorAll('button')].every(b=>!(b.getAttribute('aria-label')??'').startsWith('MENTION')));});
test('sending chat row offers no RETRY REPORT or BLOCK action',()=>{const x=chat();x.snapshot!.rows[0]!.delivery='sending';render(<ChatContentAdapter input={x} onIntent={vi.fn()} onDraft={vi.fn()}/>);assert.match(document.body.textContent??'',/SENDING/);assert.ok([...document.querySelectorAll('button')].every(b=>! /^(RETRY MESSAGE|REPORT Keeper|BLOCK Keeper)/.test(b.getAttribute('aria-label')??'')));});
test('report reason buttons retain six owner ids and original labels',()=>{const x=chat();delete x.snapshot!.rows[0]!.delivery;x.snapshot!.reporting='m';const intent=vi.fn();render(<ChatContentAdapter input={x} onIntent={intent} onDraft={vi.fn()}/>);for(const label of ['SPAM','HARASSMENT','HATE','SEXUAL','PERSONAL INFO','OTHER'])click(label);assert.deepEqual(intent.mock.calls.map(c=>c[0].id),['chat.report:m:spam','chat.report:m:harassment','chat.report:m:hate','chat.report:m:sexual','chat.report:m:personal_info','chat.report:m:other']);});
test('stale chat keeps textarea enabled and SEND disabled',()=>{const x=chat();x.fresh=false;const intent=vi.fn();render(<ChatContentAdapter input={x} onIntent={intent} onDraft={vi.fn()}/>);assert.equal(document.querySelector('textarea')?.disabled,false);const send=[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')??'').startsWith('SEND'));assert.equal(send?.getAttribute('aria-disabled'),'true');click('SEND');assert.ok(intent.mock.calls.every(c=>c[0].kind!=='action'));});
test('busy feedback close emits only an explanation',()=>{const x=feedback();x.snapshot!.busy=true;const intent=vi.fn();render(<FeedbackContentAdapter input={x} onIntent={intent} onDraft={vi.fn()}/>);click('Close');assert.deepEqual(intent.mock.calls,[[{id:'feedback.close',kind:'explain',reason:'Wait for the current report operation.'}]]);});
test('dirty feedback close emits a confirmation request',()=>{const intent=vi.fn();render(<FeedbackContentAdapter input={feedback()} onIntent={intent} onDraft={vi.fn()}/>);click('Close');assert.deepEqual(intent.mock.calls,[[{id:'feedback.close',kind:'confirm'}]]);});
test('saved report keeps its original retired category visible after catalogue changes',()=>{const x=feedback();x.snapshot!.pending={requestId:'saved',category:'retired-category',title:'Original',body:'Original body',context:{}};render(<FeedbackContentAdapter input={x} onIntent={vi.fn()} onDraft={vi.fn()}/>);const select=document.querySelector('select');assert.equal(select?.value,'retired-category');assert.match(select?.selectedOptions[0]?.textContent??'',/RETIRED-CATEGORY.*SAVED/);assert.equal(select?.disabled,true);});


test('report reason group preserves the exact ordered owner labels and cancel control', () => {
 const x = chat(); delete x.snapshot!.rows[0]!.delivery; x.snapshot!.reporting = 'm';
 render(<ChatContentAdapter input={x} onIntent={vi.fn()} onDraft={vi.fn()} />);
 const group = document.querySelector('[role="group"][aria-label="Report reason"]'); assert.ok(group);
 assert.deepEqual([...group.querySelectorAll('button')].map(button => button.getAttribute('aria-label')),
  ['SPAM', 'HARASSMENT', 'HATE', 'SEXUAL', 'PERSONAL INFO', 'OTHER', 'CANCEL REPORT']);
});
test('an injected OTHER-only catalogue renders exactly one report reason and dispatches its id', () => {
 const x = chat(); delete x.snapshot!.rows[0]!.delivery; x.snapshot!.reporting = 'm';
 x.reportReasons = [{ id: 'other', label: 'OTHER' }];
 const intent = vi.fn(); render(<ChatContentAdapter input={x} onIntent={intent} onDraft={vi.fn()} />);
 const group = document.querySelector('[role="group"][aria-label="Report reason"]'); assert.ok(group);
 const buttons = [...group.querySelectorAll('button')];
 assert.deepEqual(buttons.map(button => button.getAttribute('aria-label')), ['OTHER', 'CANCEL REPORT']);
 act(() => buttons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
 assert.deepEqual(intent.mock.calls, [[{ id: 'chat.report:m:other', kind: 'action' }]]);
});
test('a fresh ready canonical message can mention its author while stale or unread chat cannot', () => {
 const x = chat(); delete x.snapshot!.rows[0]!.delivery; x.snapshot!.rows[0]!.message.canBlock = true;
 const intent = vi.fn(); const draft = vi.fn();
 render(<ChatContentAdapter input={x} onIntent={intent} onDraft={draft} />);
 const mention = document.querySelector('button[aria-label="MENTION Keeper"]'); assert.ok(mention);
 act(() => mention.dispatchEvent(new MouseEvent('click', { bubbles: true })));
 assert.deepEqual(intent.mock.calls, [[{ id: 'chat.mention:m', kind: 'action' }]]);
 for (const current of [{ fresh: false, ready: true }, { fresh: true, ready: false }]) {
  Object.assign(x, current);
  act(() => root!.render(<ChatContentAdapter input={x} onIntent={intent} onDraft={draft} />));
  assert.equal(document.querySelector('button[aria-label="MENTION Keeper"]'), null);
  assert.match(document.querySelector('[role="log"]')?.textContent ?? '', /Keeper/);
  assert.equal(intent.mock.calls.length, 1);
 }
});
