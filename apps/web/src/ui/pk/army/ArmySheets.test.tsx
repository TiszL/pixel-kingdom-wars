/** @vitest-environment happy-dom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { featureId, type CommandUi } from '../types';
import armySheetCss from './ArmySheets.css?raw';
import craftSheetCss from '../craft/CraftSheets.css?raw';
import voyageSheetCss from '../voyage/VoyageSheets.css?raw';
import { PkBattleResultSheet, PkTrainSheet, type ArmyFrameUi } from './ArmySheets';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async (node: ReactNode) => { await act(async () => root.render(node)); };
const frame: ArmyFrameUi = {title:'Battle',level:null,status:'Current snapshot',loading:false,error:null,art:null};
const actions = () => ({onClose:vi.fn(),onHistory:vi.fn(),onRetry:vi.fn(),onCommand:vi.fn()});
const command = (patch: Partial<CommandUi> = {}): CommandUi => ({id:featureId('army.train'),caption:'TRAIN',icon:'shape:hammer',price:null,primary:true,state:'ENABLED',reason:null,badge:null,...patch});
const row = (name: string) => ({id:name,name,icon:'shape:chest',detail:'Snapshot detail',count:'snapshot count'});

describe('battle result claims require settlement and a real receipt', () => {
  for (const settlement of ['PENDING','REDACTED','FAILED','SETTLED'] as const) {
    for (const receiptId of [null,'','   ','receipt-proof']) {
      it(`${settlement} with ${JSON.stringify(receiptId)} gates all four result claims`, async () => {
        await render(<PkBattleResultSheet frame={frame} actions={actions()} outcome="OUTCOME-CLAIM" outcomeKind="DEFEAT" settlement={settlement}
          receiptId={receiptId} rewards={[row('LOOT-CLAIM')]} losses={[row('LOSSES-CLAIM')]} medals="MEDALS-CLAIM" primary={command()} />);
        const proven = settlement === 'SETTLED' && receiptId === 'receipt-proof';
        for (const claim of ['OUTCOME-CLAIM','LOOT-CLAIM','LOSSES-CLAIM','MEDALS-CLAIM']) {
          if (proven) expect(host.textContent).toContain(claim); else expect(host.textContent).not.toContain(claim);
        }
        if (proven) expect(host.querySelector('[data-outcome="defeat"]')).not.toBeNull();
      });
    }
  }
});
describe('rendered TRAIN command doors preserve the guarded route', () => {
  for (const [state, priceStatus, expected] of [
    ['ENABLED','CHECKING','OPEN'], ['ENABLED','SHORT','NEED_MORE'],
    ['LOCKED','OK','EXPLAIN'], ['BUSY','OK',null], ['ENABLED','UNAVAILABLE','EXPLAIN'],
  ] as const) {
    it(`${state}/${priceStatus} guards main button and price door`, async () => {
      const a = actions(); const primary = command({state,price:{currency:'SHARDS',amount:null,status:priceStatus}});
      await render(<PkTrainSheet frame={frame} actions={a} housing={{ready:0,training:0,draft:0,capacity:0,known:false,full:false}}
        troops={[]} queue={[]} primary={primary} onTab={vi.fn()} onTroop={vi.fn()} onRemove={vi.fn()} />);
      const main = host.querySelector<HTMLButtonElement>('.pk-primary .pk-btn');
      const price = host.querySelector<HTMLButtonElement>('.pk-price-door');
      expect(main).not.toBeNull(); expect(price).not.toBeNull();
      await act(async () => { main!.click(); price!.click(); });
      if (expected === null) expect(a.onCommand).not.toHaveBeenCalled();
      else { expect(a.onCommand).toHaveBeenCalledTimes(2); expect(a.onCommand).toHaveBeenLastCalledWith(primary,expected); }
    });
  }
  it('unknown housing explains checking instead of claiming the camp is full', async () => {
    const onTroop = vi.fn();
    await render(<PkTrainSheet frame={frame} actions={actions()} housing={{ready:0,training:0,draft:0,capacity:0,known:false,full:false}}
      troops={[{...row('Troop'),points:1,draft:0,state:'AVAILABLE',reason:null}]} queue={[]} primary={command()}
      onTab={vi.fn()} onTroop={onTroop} onRemove={vi.fn()} />);
    await act(async () => host.querySelector<HTMLButtonElement>('.pk-army__troop > button')!.click());
    expect(onTroop).toHaveBeenCalledWith('Troop','CHECKING');
  });
});

it('sheet tabs expose selection and support keyboard navigation',async()=>{
  const onTab=vi.fn();await render(<PkTrainSheet frame={frame} actions={actions()} housing={{ready:0,training:0,draft:0,capacity:0,known:false,full:false}}
    troops={[]} queue={[]} primary={command()} onTab={onTab} onTroop={vi.fn()} onRemove={vi.fn()} />);
  const tabs=[...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];expect(tabs).toHaveLength(2);
  expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');expect(tabs[1]!.tabIndex).toBe(-1);
  await act(async()=>{tabs[0]!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));});
  expect(onTab).toHaveBeenCalledWith('ARMY');expect(document.activeElement).toBe(tabs[1]);
});

// Universal descendant resets also reach the kit's structural cost-pill transform.
// Check leaf rules inside both OS media blocks and html[data-motion] selectors.
it('sheet reduced-motion rules preserve descendant structural transforms',()=>{
  const resets=Object.entries({army:armySheetCss,craft:craftSheetCss,voyage:voyageSheetCss}).flatMap(([domain,css])=>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([,selector,body])=>/(?:^|[\s,>+~])\*(?:\s|,|$)/.test(selector!) && /(?:^|;)\s*transform\s*:/.test(body!))
      .map(([,selector])=>`${domain}: ${selector!.trim()}`));
  expect(resets).toEqual([]);
});
