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
import { GateCard, LetterSheet, FeedbackSheet, LeaguesSheet, DailyCacheSheet, EventSheet, FeedbackReportsTab } from './HubSheets';
test('uncertain letters cannot archive or claim again',()=>{render(<LetterSheet state="CHECKING" hasRewards title="Letter" rows={[]} onIntent={vi.fn()}/>);assert.equal(button('ARCHIVE'),null);assert.equal(button('CLAIM'),null);assert.ok(button('CHECK AGAIN'));});
test('feedback close asks to discard a draft',()=>{const intent=vi.fn();render(<FeedbackSheet title="draft" body="" category="BUG" send="READY" onDraft={vi.fn()} onIntent={intent}/>);click('Close');assert.deepEqual(intent.mock.calls,[[{id:'feedback',kind:'discard'}]]);});
test('league progress presents attacks not wins',()=>{render(<LeaguesSheet rows={[]} attacks={2} required={5} onIntent={vi.fn()}/>);assert.ok(document.body.textContent?.includes('ATTACKS 2/5'));});
for(const kind of ['UPDATE_REQUIRED','MAINTENANCE'] as const)test(`${kind} cannot expose a caller-supplied local close button`,()=>{
 const close=vi.fn();render(<GateCard kind={kind} rows={[]} onIntent={vi.fn()} onClose={close}/>);assert.equal(button('Close'),null);assert.equal(close.mock.calls.length,0);
});
test('optional update delegates a local close exactly once',()=>{
 const close=vi.fn();render(<GateCard kind="UPDATE_OPTIONAL" rows={[]} onIntent={vi.fn()} onClose={close}/>);click('Close');assert.equal(close.mock.calls.length,1);assert.deepEqual(close.mock.calls,[[]]);
});
test('controlled feedback close delegates once without firing a second local discard or close',()=>{
 const close=vi.fn(), intent=vi.fn();render(<FeedbackSheet title="draft" body="unsent" category="BUG" send="READY" onDraft={vi.fn()} onIntent={intent} onRequestClose={close}/>);click('Close');assert.equal(close.mock.calls.length,1);assert.deepEqual(intent.mock.calls,[]);assert.deepEqual(close.mock.calls,[[{dirty:true}]]);
});

test('hub layout uses the token bridge and all viewport classes without local pixel breakpoints',()=>{
 const css=readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'HubSheets.css'),'utf8');assert.doesNotMatch(css,/\d+(?:\.\d+)?px\b/);assert.doesNotMatch(css,/@media/);assert.match(css,/var\(--pk-min-tap\)/);
 for(const viewport of ['phone-portrait','phone-landscape','tablet-portrait','tablet-landscape','desktop'])assert.ok(css.includes(`html[data-pk-vp="${viewport}"]`),viewport);
});
test('controlled clean feedback close supplies only a clean-draft request',()=>{
 const close=vi.fn();render(<FeedbackSheet title="" body="" category={null} send="READY" onDraft={vi.fn()} onIntent={vi.fn()} onRequestClose={close}/>);click('Close');assert.deepEqual(close.mock.calls,[[{dirty:false}]]);
});
test('cache, event and report enum values become player copy',()=>{
 render(<><DailyCacheSheet rows={[]} day={1} days={2} state="READY" nextIn={null} onIntent={vi.fn()}/><EventSheet rows={[]} phase="UPCOMING" joined={false} onIntent={vi.fn()}/><FeedbackReportsTab rows={[{id:'r',title:'A report',unread:0,status:'NOT_SENT'}]} onIntent={vi.fn()}/></>);assert.doesNotMatch(document.body.textContent??'',/TODAY|FUTURE|UPCOMING|NOT SENT/);assert.match(document.body.textContent??'',/Today|Coming next|Opens soon|Not sent/);
});
