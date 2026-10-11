// @vitest-environment happy-dom
// UNAPPLIED proposal test. No new delivery implementation; all calls below use the original FeedbackTab.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
const mocks=vi.hoisted(()=>({state:{wallet:'wallet',screen:'tester',selectedBaseId:null as string|null},saved:null as unknown,read:vi.fn(),save:vi.fn(),deliver:vi.fn(),reload:vi.fn(),more:vi.fn()}));
vi.mock('../../../state/store',()=>({useApp:Object.assign((selector:(s:typeof mocks.state)=>unknown)=>selector(mocks.state),{getState:()=>mocks.state})}));
vi.mock('../../feedback/feedbackSubmission',()=>({readFeedbackSubmission:()=>mocks.read(),saveFeedbackSubmission:(...a:unknown[])=>mocks.save(...a),clearFeedbackSubmission:vi.fn(),advanceFeedbackSubmission:vi.fn()}));
vi.mock('../../feedback/feedbackReportDelivery',()=>({deliverFeedbackReport:(...a:unknown[])=>mocks.deliver(...a)}));
vi.mock('../../feedback/useFeedbackPages',()=>({useFeedbackPages:()=>({data:{feedback:[]},loading:false,error:null,nextCursor:null,reload:mocks.reload,more:mocks.more})}));
vi.mock('../../feedback/KnownIssueSuggestions',()=>({default:()=>null}));
vi.mock('../../feedback/FeedbackScreenshotPicker',()=>({default:()=>null}));
vi.mock('../../feedback/FeedbackThreadScreenshots',()=>({FeedbackPrivateImage:()=>null}));
vi.mock('../../feedback/FeedbackThread',()=>({default:()=> <div>Existing private thread</div>}));
import { FeedbackTab, type FeedbackOwnerBridge, type FeedbackOwnerProjection } from '../../screens/tester';
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;let host:HTMLDivElement;let read:(()=>FeedbackOwnerProjection|null)|null;let current=true;let cleanup:ReturnType<typeof vi.fn<()=>void>>;
const bridge=():FeedbackOwnerBridge=>({wallet:'wallet',sessionKey:'session',isCurrent:()=>current,attach:get=>{read=get;return cleanup;}});
const paint=async(b?:FeedbackOwnerBridge)=>{await act(async()=>{root.render(<FeedbackTab wallet="wallet" {...(b?{ownerBridge:b}:{})}/>);await Promise.resolve();});};
beforeEach(()=>{host=document.createElement('div');document.body.append(host);root=createRoot(host);read=null;current=true;cleanup=vi.fn();mocks.state.wallet='wallet';mocks.saved=null;mocks.read.mockReset().mockImplementation(()=>mocks.saved);mocks.save.mockReset();mocks.deliver.mockReset().mockImplementation(()=>new Promise(()=>undefined));mocks.more.mockClear();mocks.reload.mockClear();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
test('legacy feedback without bridge retains the existing form',async()=>{await paint();assert.ok(host.querySelector('textarea'));assert.equal(read,null);assert.equal(mocks.deliver.mock.calls.length,0);});
test('feedback accessor reads committed original draft without extra persistence or requests',async()=>{await paint(bridge());const reads=mocks.read.mock.calls.length;await act(async()=>{read!()!.actions.setTitle('Same owner');read!()!.actions.setBody('Original body');});assert.equal(read!()!.data.title,'Same owner');assert.equal(host.querySelector<HTMLInputElement>('input[aria-label="Feedback title"]')?.value,'Same owner');for(let i=0;i<3;i++)read!();assert.equal(mocks.read.mock.calls.length,reads);assert.equal(mocks.save.mock.calls.length,0);assert.equal(mocks.deliver.mock.calls.length,0);});
test('feedback saved retry calls the existing submit with the original request',async()=>{mocks.saved={requestId:'original',category:'bug',title:'Original',body:'The original report body is retained.',context:{screen:'tester'}};await paint(bridge());await act(async()=>{assert.equal(read!()!.actions.submit(),true);});assert.equal(mocks.deliver.mock.calls.length,1);assert.deepEqual(mocks.deliver.mock.calls[0]![1],mocks.saved);assert.equal(read!()!.data.busy,true);});
test('current wallet change hides projection and rejects retained mutation callback',async()=>{await paint(bridge());const old=read!()!;mocks.state.wallet='other';assert.equal(read!(),null);assert.equal(old.actions.submit(),false);assert.equal(mocks.deliver.mock.calls.length,0);});
test('feedback inactive lease and thrown predicate both fail closed',async()=>{const b=bridge();await paint(b);current=false;assert.equal(read!(),null);current=true;await paint({...b,isCurrent:()=>{throw new Error('gone');}});assert.equal(read!(),null);});
test('feedback newer commit invalidates old setter callbacks',async()=>{await paint(bridge());const old=read!()!;await act(async()=>{old.actions.setTitle('New');});assert.equal(old.actions.setTitle('Stale'),false);assert.equal(read!()!.data.title,'New');});
test('feedback detach invalidates retained getter and releases only its attachment',async()=>{await paint(bridge());const held=read!;await act(async()=>root.render(null));assert.equal(held(),null);assert.equal(cleanup.mock.calls.length,1);});
test('original recovery storage failure is exposed without pretending it was cleared',async()=>{mocks.read.mockImplementation(()=>{throw new Error('Storage unavailable');});await paint(bridge());assert.equal(read!()!.data.recoveryError,'Storage unavailable');assert.equal(mocks.deliver.mock.calls.length,0);});
test('feedback bridge scope change cannot relabel the original draft',async()=>{const b=bridge();await paint(b);await act(async()=>{read!()!.actions.setTitle('Private');});await paint({...b,sessionKey:'new-session'});assert.equal(read!(),null);});
test('read-only projection cannot mutate the saved command or categories',async()=>{mocks.saved={requestId:'original',category:'bug',title:'Original',body:'Original body',context:{screen:'tester'}};await paint(bridge());assert.ok(Object.isFrozen(read!()!.data.pending));assert.ok(Object.isFrozen(read!()!.data.limits.categories));assert.equal((mocks.saved as {title:string}).title,'Original');});

// Bridge v1.1: synthetic bodies derive their minimum length from shared constants.
import { TESTER_PROGRAM } from '@shardkeep/shared';
const validBody = 'x'.repeat(TESTER_PROGRAM.feedback.bodyMinLen);
const savedReport = () => ({ requestId: 'original', category: 'bug', title: 'Original', body: validBody, context: { screen: 'tester' } });
test('submit twice in one act creates exactly one save, delivery and UUID', async () => {
  await paint(bridge());
  await act(async () => { read!()!.actions.setTitle('A report'); read!()!.actions.setBody(validBody); });
  const uuid = vi.spyOn(crypto, 'randomUUID'); const view = read!()!;
  try {
    await act(async () => {
      assert.equal(view.actions.submit(), true); assert.equal(view.actions.submit(), false);
      assert.equal(view.actions.setTitle('Must not replace pending title'), false);
    });
    assert.equal(mocks.save.mock.calls.length, 1); assert.equal(mocks.deliver.mock.calls.length, 1);
    assert.equal(uuid.mock.calls.length, 1);
    assert.equal(mocks.save.mock.calls[0]![1], mocks.deliver.mock.calls[0]![1]);
    assert.equal(read!()!.actions.submit(), false);
  } finally { uuid.mockRestore(); }
});
test('all disabled draft setters refuse pending edits while saved retry still delivers original bytes', async () => {
  const original = savedReport(); mocks.saved = original; const bytes = JSON.stringify(original);
  await paint(bridge()); const view = read!()!;
  await act(async () => {
    assert.equal(view.actions.setCategory('other'), false);
    assert.equal(view.actions.setTitle('Changed'), false);
    assert.equal(view.actions.setBody('Changed'), false);
    assert.equal(view.actions.setRecurrence(true), false);
    assert.equal(view.actions.submit(), true); assert.equal(view.actions.submit(), false);
  });
  assert.equal(JSON.stringify(original), bytes);
  assert.equal(mocks.deliver.mock.calls.length, 1); assert.equal(mocks.save.mock.calls.length, 1);
  assert.equal(mocks.deliver.mock.calls[0]![1], original);
  const busy = read!()!;
  assert.equal(busy.actions.setCategory('other'), false); assert.equal(busy.actions.setTitle('Changed'), false);
  assert.equal(busy.actions.setBody('Changed'), false); assert.equal(busy.actions.setRecurrence(true), false);
});
test('saved retry with a now-invalid title or body refuses without a save or delivery', async () => {
  mocks.saved = { ...savedReport(), body: '' };
  await paint(bridge()); assert.equal(read!()!.actions.submit(), false);
  assert.equal(mocks.save.mock.calls.length, 0); assert.equal(mocks.deliver.mock.calls.length, 0);
  await act(async () => root.unmount()); root = createRoot(host);
  mocks.saved = { ...savedReport(), title: ' ' };
  await paint(bridge()); assert.equal(read!()!.actions.submit(), false);
  assert.equal(mocks.save.mock.calls.length, 0); assert.equal(mocks.deliver.mock.calls.length, 0);
});
test('new submission respects current validation and recurrence before consuming the one-shot', async () => {
  await paint(bridge()); assert.equal(read!()!.actions.submit(), false);
  await act(async () => {
    read!()!.actions.setTitle('A recurrence'); read!()!.actions.setBody(validBody);
    read!()!.actions.setEvidenceIssue({ id: 'issue', title: 'Resolved', status: 'fixed', category: 'bug' });
  });
  assert.equal(read!()!.actions.submit(), false);
  await act(async () => { read!()!.actions.setRecurrence(true); });
  await act(async () => { assert.equal(read!()!.actions.submit(), true); });
  assert.equal(mocks.deliver.mock.calls.length, 1);
});
test('bridge title and body edits mirror legacy success-notice clearing', async () => {
  for (const field of ['setTitle', 'setBody'] as const) {
    mocks.deliver.mockResolvedValueOnce({ request: savedReport(), id: 'report', basePoints: 0 });
    await paint(bridge());
    await act(async () => { read!()!.actions.setTitle('Title'); read!()!.actions.setBody(validBody); });
    await act(async () => { read!()!.actions.submit(); });
    assert.equal(read!()!.data.notice?.kind, 'ok');
    await act(async () => { read!()!.actions.setOpened(null); });
    await act(async () => { assert.equal(read!()!.actions[field]('Edited'), true); });
    assert.equal(read!()!.data.notice, null);
  }
});
test('bridge title and body edits preserve legacy error notices', async () => {
  mocks.read.mockImplementation(() => { throw new Error('Recovery unavailable'); });
  await paint(bridge());
  await act(async () => { read!()!.actions.setTitle('Title'); read!()!.actions.setBody(validBody); });
  assert.deepEqual(read!()!.data.notice, { kind: 'err', msg: 'Recovery unavailable' });
});
test('feedback DOM is identical on separate bridge-off and bridge-on mounts', async () => {
  await paint(); const legacy = host.innerHTML;
  await act(async () => root.unmount()); root = createRoot(host);
  await paint(bridge()); assert.ok(read!()); assert.equal(host.innerHTML, legacy);
  assert.equal(host.querySelectorAll('textarea').length, 1);
});

test('evidence setter refuses pending recovery, same-view submit and committed busy state', async () => {
  const issue = { id: 'replacement', title: 'Replacement issue', status: 'active', category: 'bug' };
  const original = { ...savedReport(), evidence: { issueId: 'original-issue', mode: 'evidence' } };
  mocks.saved = original; const originalBytes = JSON.stringify(original);
  await paint(bridge());
  const pending = read!()!;
  assert.equal(pending.actions.setEvidenceIssue(issue), false);
  assert.equal(pending.actions.setEvidenceIssue(null), false);
  assert.equal(read!()!.data.evidenceIssue?.id, 'original-issue');
  assert.equal(JSON.stringify(original), originalBytes);
  assert.equal(mocks.save.mock.calls.length, 0); assert.equal(mocks.deliver.mock.calls.length, 0);
  await act(async () => root.unmount()); root = createRoot(host); mocks.saved = null;
  await paint(bridge());
  await act(async () => {
    assert.equal(read!()!.actions.setEvidenceIssue(issue), true);
    read!()!.actions.setTitle('New report'); read!()!.actions.setBody(validBody);
  });
  const draft = read!()!;
  await act(async () => {
    assert.equal(draft.actions.submit(), true);
    assert.equal(draft.actions.setEvidenceIssue(null), false);
  });
  const busy = read!()!;
  assert.equal(busy.data.busy, true); assert.equal(busy.actions.setEvidenceIssue(null), false);
  assert.equal(busy.data.evidenceIssue?.id, issue.id);
  assert.equal(mocks.save.mock.calls.length, 1); assert.equal(mocks.deliver.mock.calls.length, 1);
});
