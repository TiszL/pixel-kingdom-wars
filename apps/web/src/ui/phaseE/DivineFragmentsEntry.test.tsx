/** @vitest-environment happy-dom */
import {IDBFactory} from 'fake-indexeddb';
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {api} from '../../lib/api';
import {useApp} from '../../state/store';
import {DivineFragmentsJournalStore} from '../../lib/divineFragments/journal';
import {divineFragmentsIdentity} from '../../lib/divineFragments/browser';
import {delivery,identity,DIVINE_FRAGMENT_POLICY,proof} from '../../lib/divineFragments/fixtures.test-support';
import {DivineFragmentsEntry} from './DivineFragmentsEntry';
let host:HTMLDivElement,root:Root;
const until=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});check();});
async function mount(){await act(async()=>root.render(<DivineFragmentsEntry actionsEnabled={false}/>));await until(()=>expect(api.getPrivate).toHaveBeenCalled());await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});}
async function save(archive=false){const store=new DivineFragmentsJournalStore(divineFragmentsIdentity(identity.wallet));try{let row=await store.read();row=await store.compareAndSet(row.revision,j=>({...j,operation:{command:delivery,attemptRevision:null,proof:null}}));if(archive){row=await store.compareAndSet(row.revision,j=>({...j,operation:{...j.operation!,proof:proof(delivery,true) as never}}));await store.compareAndSet(row.revision,j=>({...j,operation:null,archives:[{operation:j.operation!,reason:'accepted',evidence:null}]}));}}finally{await store.close();}}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('indexedDB',new IDBFactory());vi.spyOn(api,'getPrivate').mockRejectedValue(Error('DIVINE_FRAGMENT_DISABLED'));useApp.getState().setAuth(identity.wallet,true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();useApp.getState().setAuth(null);});
it('empty local history and the null production provider never advertise a new fragment feature',async()=>{await mount();expect(host.querySelector('button')).toBeNull();expect(api.getPrivate).toHaveBeenCalledExactlyOnceWith('/divine-fragments/policy',expect.objectContaining({signal:expect.any(AbortSignal),isCurrent:expect.any(Function)}));});
it('only a fully validated positive policy reveals the configured entry, including during source pause',async()=>{vi.mocked(api.getPrivate).mockResolvedValue(DIVINE_FRAGMENT_POLICY);await mount();await until(()=>expect(host.textContent).toContain('CRYSTAL FRAGMENTS'));});
it('a malformed or historical-looking error response cannot masquerade as configured policy',async()=>{vi.mocked(api.getPrivate).mockResolvedValue({...DIVINE_FRAGMENT_POLICY,weeklyGross:'20000'});await mount();expect(host.querySelector('button')).toBeNull();});
it.each([false,true])('retains entry for an original local request or archive while source is unavailable: archive=%s',async archive=>{await save(archive);await mount();await until(()=>expect(host.textContent).toContain('FRAGMENTS & HISTORY'));});
it('actor changes cannot display another wallet journal or accept its delayed policy discovery',async()=>{let release:(value:unknown)=>void=()=>undefined;vi.mocked(api.getPrivate).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));await save();await mount();await until(()=>expect(host.textContent).toContain('FRAGMENTS & HISTORY'));await act(async()=>useApp.getState().setAuth('11111111111111111111111111111112',true));await act(async()=>release(DIVINE_FRAGMENT_POLICY));await until(()=>expect(api.getPrivate).toHaveBeenCalledTimes(2));expect(host.querySelector('button')).toBeNull();});
it('storage unavailability does not convert a disabled provider into positive feature discovery',async()=>{vi.stubGlobal('indexedDB',undefined);await mount();expect(host.querySelector('button')).toBeNull();});
it('unauthenticated sessions perform no discovery and reveal no entry',async()=>{useApp.getState().setAuth(null);await act(async()=>root.render(<DivineFragmentsEntry actionsEnabled={false}/>));expect(api.getPrivate).not.toHaveBeenCalled();expect(host.querySelector('button')).toBeNull();});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });

vi.mock('./DivineFragmentsScreen', () => ({ DivineFragmentsScreen: () => <span data-original-fragment-screen /> }));
it.each(['policy', 'original', 'archive'] as const)('forwards %s discovery to the optional map producer without changing its label', async evidence => {
  if (evidence === 'policy') vi.mocked(api.getPrivate).mockResolvedValue(DIVINE_FRAGMENT_POLICY);
  else await save(evidence === 'archive');
  const onOpen = vi.fn(); await act(async () => root.render(<DivineFragmentsEntry actionsEnabled={false} onOpen={onOpen} />));
  const label = evidence === 'policy' ? 'CRYSTAL FRAGMENTS' : 'FRAGMENTS & HISTORY';
  await until(() => expect(host.textContent).toContain(label));
  await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); await Promise.resolve(); });
  expect(onOpen).toHaveBeenCalledOnce(); expect(host.querySelector('[data-original-fragment-screen]')).toBeNull();
  expect(host.textContent).not.toContain('Opening fragment history…');
});
it('retains the original fragment modal when no map callback is supplied', async () => {
  await save(); await mount(); await until(() => expect(host.textContent).toContain('FRAGMENTS & HISTORY'));
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  await until(() => expect(host.querySelector('[data-original-fragment-screen]')).not.toBeNull());
});
