/** @vitest-environment happy-dom */
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {PHASE_E_VEHICLE_RECIPES} from '@shardkeep/shared';
import {useApp,type BaseStateDto} from '../../../state/store';
import {useVehicleCraft} from '../../../lib/vehicleCraft/useVehicleCraft';
import {craftFixture,wallet,baseId} from '../../../lib/vehicleCraft/fixtures.testHelpers';
import type {PanelSession} from '../panelSession';
import VehicleCraftBody from './VehicleCraftBody';
vi.mock('../../../lib/vehicleCraft/useVehicleCraft',()=>({useVehicleCraft:vi.fn()}));
let root:Root,host:HTMLDivElement,hook:ReturnType<typeof useVehicleCraft>,enabled:boolean,session:Pick<PanelSession,'dispatch'>;
const button=(label:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===label)!;
const render=()=>act(async()=>root.render(<VehicleCraftBody actionsEnabled={enabled} busy={false} session={session} onInstall={()=>undefined}/>));
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);enabled=true;
 const f=craftFixture();useApp.getState().setAuth(wallet,true);useApp.getState().setSelectedBaseId(baseId,false);useApp.getState().setBase({baseId,player:{wallet},buildings:[]} as unknown as BaseStateDto);
 hook={wallet,records:[f.record],cursor:null,loaded:true,busy:false,error:null,quote:f.quote,quoteError:null,quoting:false,preview:vi.fn(async()=>undefined),clearQuote:vi.fn(),refresh:vi.fn(async()=>undefined),more:vi.fn(async()=>undefined),recover:vi.fn(async()=>undefined)};
 vi.mocked(useVehicleCraft).mockImplementation(()=>hook);session={dispatch:vi.fn((_kind,action)=>{action();return true;})};
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('shows exact application charge and materials without presenting a complete payment or spend action',async()=>{
 await render();expect(host.textContent).toContain('Network, oracle and account costs are not included');expect(host.textContent).toContain('A total payment quote is unavailable');expect(host.textContent).toContain('New crafting is not available yet');
 expect(host.querySelector('[aria-label="Required vehicle materials"]')?.textContent).toContain(craftFixture().quote.ingredients[0]!.required);expect(hook.preview).not.toHaveBeenCalled();expect(button('PAY')).toBeUndefined();expect([...host.querySelectorAll('button')].map(b=>b.textContent?.trim())).toEqual(['PREVIEW MATERIALS','REFRESH CRAFT HISTORY','CHECK CRAFT OUTCOME']);
});
it('preview keeps the original request version and uses read dispatch',async()=>{
 await render();expect(button('PREVIEW MATERIALS').disabled).toBe(false);await act(async()=>button('PREVIEW MATERIALS').click());
 expect(hook.preview).toHaveBeenCalledWith({baseId,family:craftFixture().quote.recipe.family,tier:craftFixture().quote.recipe.tier,recipeVersion:PHASE_E_VEHICLE_RECIPES.recipeVersion});expect(session.dispatch).toHaveBeenCalledWith('read',expect.any(Function));
});
it('a capability loss clears advisory material preview and leaves original GET recovery available',async()=>{
 await render();enabled=false;await render();expect(hook.clearQuote).toHaveBeenCalled();expect(button('PREVIEW MATERIALS').disabled).toBe(true);expect(host.querySelector('[aria-label="Current vehicle recipe"]')).toBeNull();
 await act(async()=>button('CHECK CRAFT OUTCOME').click());expect(hook.recover).toHaveBeenCalledWith(craftFixture().record.idempotencyKey);expect(session.dispatch).toHaveBeenCalledWith('recover',expect.any(Function));
});
it('unminted or lost originals do not claim a currently owned NFT',async()=>{
 const record=craftFixture().record;hook.records=[{...record,status:'paid_loss',consumedAt:record.reservedAt,mintedAt:null}];await render();expect(host.textContent).toContain('No vehicle was minted');expect(button('FIND NFT TO INSTALL')).toBeUndefined();
 hook.records=[{...record,status:'won_unminted',consumedAt:record.reservedAt,mintedAt:null}];await render();expect(host.textContent).toContain('original mint is still pending');expect(button('FIND NFT TO INSTALL')).toBeUndefined();
});
it('foreign snapshots stay hidden and do not become zero balances',async()=>{
 hook={...hook,wallet:'foreign',quote:{...hook.quote!,wallet:'foreign'}};await render();expect(host.querySelector('[aria-label="Current vehicle recipe"]')).toBeNull();expect(host.textContent).not.toContain('Materials held');
});

it('a missing current kingdom view disables preview while retaining account recovery',async()=>{
 useApp.getState().setBase(null);await render();expect(button('PREVIEW MATERIALS').disabled).toBe(true);expect(hook.clearQuote).toHaveBeenCalled();await act(async()=>button('CHECK CRAFT OUTCOME').click());expect(hook.recover).toHaveBeenCalled();
});
