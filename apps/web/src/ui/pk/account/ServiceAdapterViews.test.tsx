// @vitest-environment happy-dom
import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TestSolAdapter, EconomyAdapter } from './ServiceAdapterViews';
import type { TestSolInput } from './serviceAdapters';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
function render(node: React.ReactNode) { const el = document.createElement('div'); document.body.append(el); act(() => { root = createRoot(el); root.render(node); }); }
function click(label: string) { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') ?? x.textContent) === label); assert.ok(b); act(() => b.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.replaceChildren(); });
const input = (): TestSolInput => ({ wallet: 'wallet', cluster: 'devnet', snapshot: null, fresh: false, countdown: null, formatSol: String });
test('TEST SOL content is absent on mainnet', () => {
  render(<TestSolAdapter input={{ ...input(), cluster: 'mainnet-beta' }} onIntent={vi.fn()} />);
  assert.equal(document.body.textContent, '');
});
test('test SOL refresh dispatches the existing status intent', () => {
  const intent = vi.fn(); render(<TestSolAdapter input={input()} onIntent={intent} />);
  click('CHECK AGAIN'); assert.deepEqual(intent.mock.calls, [[{ id: 'faucet.sol.refresh', kind: 'recover' }]]);
});
test('economy retry stays a read recovery intent', () => {
  const intent = vi.fn(); render(<EconomyAdapter input={{ cluster: 'devnet', snapshot: null, loading: false, error: 'Read failed', fresh: false, formatAmount: s => s }} onIntent={intent} />);
  click('RETRY'); assert.deepEqual(intent.mock.calls, [[{ id: 'account.economy', kind: 'recover' }]]);
  assert.equal(document.querySelectorAll('[role="alert"]').length, 1);
});
test('economy retains custody explanation without inferring a health verdict on unread data',()=>{render(<EconomyAdapter input={{cluster:'devnet',snapshot:null,loading:true,error:null,fresh:false,formatAmount:s=>s}} onIntent={vi.fn()}/>);assert.match(document.body.textContent??'',/Deposits mirror player-owned KEEP in custody and never fund rewards/);assert.doesNotMatch(document.body.textContent??'',/POOL HEALTHY|POOL SHRINKING/);});
