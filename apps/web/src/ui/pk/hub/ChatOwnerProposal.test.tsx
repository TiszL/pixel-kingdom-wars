// @vitest-environment happy-dom
// UNAPPLIED proposal test. Cedar3 runs only after the exact ChatScreen proposal is admitted/applied.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import ChatScreen, { REPORT_REASONS, type ChatOwnerProjection, type ChatOwnerBridge } from '../../chat/ChatScreen';
import { chatApi, type ChatStatus } from '../../chat/protocol';
vi.mock('../../layout',()=>({useWindowSize:()=>({w:400,h:800})}));
vi.mock('../../chat/useChatFrame',()=>({useChatFrame:()=>({top:0,height:800})}));
vi.mock('../../screens/seeker',()=>({SeekerBadge:()=>null}));
vi.mock('../../chat/protocol',async original=>{const real=await original<typeof import('../../chat/protocol')>();return {...real,startChatPoller:vi.fn(()=>()=>undefined),scheduleChatRetry:vi.fn(()=>()=>undefined)};});
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const status:ChatStatus={enabled:true,canSend:true,sendBlockedReason:null,mutedUntil:null,pollOpenMs:1,pollClosedMs:1,latestEventId:'cursor'};
let root:Root;let host:HTMLDivElement;let read:(()=>ChatOwnerProjection|null)|null;let current=true;let cleanup:ReturnType<typeof vi.fn<()=>void>>;
const bridge=():ChatOwnerBridge=>({wallet:'wallet',sessionKey:'session',isCurrent:()=>current,attach:get=>{read=get;return cleanup;}});
const paint=async(b?:ChatOwnerBridge)=>{await act(async()=>{root.render(<ChatScreen initialStatus={status} initialCursor="cursor" onClose={()=>undefined} {...(b?{ownerBridge:b}:{})}/>);await Promise.resolve();await Promise.resolve();});};
beforeEach(()=>{host=document.createElement('div');document.body.append(host);root=createRoot(host);read=null;current=true;cleanup=vi.fn();vi.spyOn(chatApi,'history').mockResolvedValue({messages:[],nextBefore:null});vi.spyOn(chatApi,'send').mockImplementation(()=>new Promise(()=>undefined));vi.spyOn(chatApi,'blocks').mockResolvedValue({blocks:[],nextBefore:null});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();});
test('existing chat without bridge keeps its original UI and history owner',async()=>{await paint();assert.ok(host.querySelector('textarea'));assert.equal(vi.mocked(chatApi.history).mock.calls.length,1);assert.equal(read,null);});
test('attached accessor reads the same committed draft and never performs a request',async()=>{await paint(bridge());const before=vi.mocked(chatApi.history).mock.calls.length;const v=read!()!;assert.equal(v.data.body,'');await act(async()=>{assert.equal(v.actions.setBody('Same owner'),true);});assert.equal(read!()!.data.body,'Same owner');for(let i=0;i<3;i++)read!();assert.equal(vi.mocked(chatApi.history).mock.calls.length,before);assert.equal(vi.mocked(chatApi.send).mock.calls.length,0);assert.equal(host.querySelector('textarea')?.value,'Same owner');});
test('old committed callbacks refuse after a newer owner commit',async()=>{await paint(bridge());const old=read!()!;await act(async()=>{old.actions.setBody('changed');});assert.equal(old.actions.setBody('stale'),false);assert.equal(read!()!.data.body,'changed');});
test('stale session getter hides the projection and refuses held callbacks',async()=>{await paint(bridge());const old=read!()!;current=false;assert.equal(read!(),null);assert.equal(old.actions.send(),false);assert.equal(vi.mocked(chatApi.send).mock.calls.length,0);});
test('throwing current predicate fails closed without making requests',async()=>{await paint({...bridge(),isCurrent:()=>{throw new Error('gone');}});assert.equal(read!(),null);assert.equal(vi.mocked(chatApi.send).mock.calls.length,0);});
test('changing bridge wallet cannot relabel existing chat state',async()=>{const b=bridge();await paint(b);await paint({...b,wallet:'other'});assert.equal(read!(),null);});
test('detached owner invalidates a previously retained accessor',async()=>{await paint(bridge());const held=read!;await act(async()=>root.render(null));assert.equal(held(),null);assert.equal(cleanup.mock.calls.length,1);});
test('report catalogue is the original six owner entries and remains immutable in projection',async()=>{await paint(bridge());assert.deepEqual(read!()!.data.reportReasons,REPORT_REASONS);assert.deepEqual(REPORT_REASONS.map(x=>x.id),['spam','harassment','hate','sexual','personal_info','other']);assert.equal(read!()!.data.reportReasons.find(x=>x.id==='sexual')?.label,'SEXUAL');assert.ok(Object.isFrozen(read!()!.data.status));});
test('send export invokes the existing owner once with its current body',async()=>{await paint(bridge());await act(async()=>{read!()!.actions.setBody('Same request owner');});await act(async()=>{assert.equal(read!()!.actions.send(),true);});assert.equal(vi.mocked(chatApi.send).mock.calls.length,1);assert.equal(vi.mocked(chatApi.send).mock.calls[0]![1],'Same request owner');});
test('blocks-more export stays absent when the existing inline handler does not render',async()=>{await paint(bridge());assert.equal(read!()!.actions.moreBlocks(),false);assert.equal(vi.mocked(chatApi.blocks).mock.calls.length,0);});

// Bridge v1.1: authored before the wrapper changes; Cedar3 owns execution.
import { startChatPoller } from '../../chat/protocol';
const otherMessage = { id: 'message', clientMessageId: 'message-request', text: 'Other keeper',
  createdAt: '2026-10-04T00:00:00.000Z', author: { name: 'Keeper', avatarUrl: null, seekerVerified: false }, canBlock: true };
const blockedKeeper = { id: 'blocked', createdAt: '2026-10-04T00:00:00.000Z', author: otherMessage.author };
test('bridge attachment starts only the existing open-chat poller', async () => {
  vi.mocked(startChatPoller).mockClear();
  await paint(bridge());
  // ChatScreen has always owned two pollers: the status poll (since a4bfcf63f) and the open-chat events poll. The
  // proposal assumed one; the rule is that the bridge adds none, so a third start still fails (night 2026-10-06).
  assert.equal(vi.mocked(startChatPoller).mock.calls.length, 2);
  assert.equal(vi.mocked(chatApi.history).mock.calls.length, 1);
});
test('chat DOM is identical on separate bridge-off and bridge-on mounts', async () => {
  await paint(); const legacy = host.innerHTML;
  await act(async () => root.unmount()); root = createRoot(host);
  await paint(bridge());
  assert.ok(read!()); assert.equal(host.innerHTML, legacy);
  assert.equal(host.querySelectorAll('textarea').length, 1);
});
test('send is one-shot within one committed view and allocates one request UUID', async () => {
  await paint(bridge());
  await act(async () => { read!()!.actions.setBody('Exactly one message'); });
  const uuid = vi.spyOn(crypto, 'randomUUID'); const view = read!()!;
  await act(async () => {
    assert.equal(view.actions.send(), true);
    assert.equal(view.actions.send(), false);
  });
  assert.equal(vi.mocked(chatApi.send).mock.calls.length, 1);
  assert.equal(uuid.mock.calls.length, 1);
  assert.equal(read!()!.actions.send(), false); // emptied draft
});
test('read-only chat bridge refuses the disabled composer and send control', async () => {
  await act(async () => { root.render(<ChatScreen initialStatus={{ ...status, canSend: false }} initialCursor="cursor"
    onClose={() => undefined} ownerBridge={bridge()} />); });
  assert.equal(host.querySelector('textarea')?.disabled, true);
  assert.equal(read!()!.actions.setBody('Refused'), false);
  assert.equal(read!()!.actions.send(), false);
  assert.equal(read!()!.actions.mentionAuthor('Keeper'), false);
  assert.equal(vi.mocked(chatApi.send).mock.calls.length, 0);
});
test('positive moreBlocks calls the original cursor handler once and blocks re-entry', async () => {
  vi.mocked(chatApi.blocks).mockResolvedValueOnce({ blocks: [blockedKeeper], nextBefore: 'page-two' })
    .mockImplementationOnce(() => new Promise(() => undefined));
  await paint(bridge()); await act(async () => { read!()!.actions.openBlocks(); });
  const view = read!()!;
  await act(async () => {
    assert.equal(view.actions.moreBlocks(), true);
    assert.equal(view.actions.moreBlocks(), false);
  });
  assert.deepEqual(vi.mocked(chatApi.blocks).mock.calls, [[], ['page-two']]);
  assert.equal(read!()!.data.blocksBusy, true);
  assert.equal(read!()!.actions.moreBlocks(), false);
});
test('block is one-shot and busy blocks refuse block, unblock and pagination', async () => {
  vi.mocked(chatApi.history).mockResolvedValue({ messages: [otherMessage], nextBefore: null });
  vi.mocked(chatApi.blocks).mockResolvedValue({ blocks: [blockedKeeper], nextBefore: 'page-two' });
  const block = vi.spyOn(chatApi, 'block').mockImplementation(() => new Promise(() => undefined));
  const unblock = vi.spyOn(chatApi, 'unblock').mockImplementation(() => new Promise(() => undefined));
  await paint(bridge()); await act(async () => { read!()!.actions.openBlocks(); });
  await act(async () => { read!()!.actions.showMessages(); });
  const view = read!()!;
  await act(async () => {
    assert.equal(view.actions.block(otherMessage.id), true);
    assert.equal(view.actions.block(otherMessage.id), false);
    assert.equal(view.actions.unblock(blockedKeeper.id), false);
    assert.equal(view.actions.moreBlocks(), false);
  });
  const busy = read!()!;
  assert.equal(busy.actions.block(otherMessage.id), false);
  assert.equal(busy.actions.unblock(blockedKeeper.id), false);
  assert.equal(busy.actions.moreBlocks(), false);
  assert.equal(block.mock.calls.length, 1); assert.equal(unblock.mock.calls.length, 0);
  assert.equal(vi.mocked(chatApi.blocks).mock.calls.length, 1);
});
test('unblock is one-shot in the committed view', async () => {
  vi.mocked(chatApi.blocks).mockResolvedValue({ blocks: [blockedKeeper], nextBefore: null });
  const unblock = vi.spyOn(chatApi, 'unblock').mockImplementation(() => new Promise(() => undefined));
  await paint(bridge()); await act(async () => { read!()!.actions.openBlocks(); });
  const view = read!()!;
  await act(async () => {
    assert.equal(view.actions.unblock(blockedKeeper.id), true);
    assert.equal(view.actions.unblock(blockedKeeper.id), false);
  });
  assert.deepEqual(unblock.mock.calls, [[blockedKeeper.id]]);
});
test('report is one-shot in the committed view', async () => {
  vi.mocked(chatApi.history).mockResolvedValue({ messages: [otherMessage], nextBefore: null });
  const report = vi.spyOn(chatApi, 'report').mockImplementation(() => new Promise(() => undefined));
  await paint(bridge());
  await act(async () => { read!()!.actions.setReporting(otherMessage.id); });
  const view = read!()!;
  await act(async () => {
    assert.equal(view.actions.report(otherMessage.id, 'spam'), true);
    assert.equal(view.actions.report(otherMessage.id, 'spam'), false);
  });
  assert.deepEqual(report.mock.calls, [[otherMessage.id, 'spam']]);
});
test('loading older messages refuses a second page request', async () => {
  vi.mocked(chatApi.history).mockResolvedValueOnce({ messages: [], nextBefore: 'older' })
    .mockImplementationOnce(() => new Promise(() => undefined));
  await paint(bridge()); const view = read!()!;
  await act(async () => {
    assert.equal(view.actions.loadOlder(), true); assert.equal(view.actions.loadOlder(), false);
  });
  assert.equal(read!()!.actions.loadOlder(), false);
  assert.deepEqual(vi.mocked(chatApi.history).mock.calls, [[], ['older']]);
});

// v1.2 / 522ac48d: match the original rendered-control eligibility.
test('retry refuses a sending row, then retries a failed row with the same request UUID once', async () => {
  let rejectSend!: (reason: Error) => void;
  vi.mocked(chatApi.send).mockImplementationOnce(() => new Promise((_, reject) => { rejectSend = reject; }));
  const uuid = vi.spyOn(crypto, 'randomUUID');
  await paint(bridge());
  await act(async () => { read!()!.actions.setBody('Retry this exact message'); });
  await act(async () => { assert.equal(read!()!.actions.send(), true); });
  const id = vi.mocked(chatApi.send).mock.calls[0]![0];
  const sending = read!()!;
  assert.equal(sending.data.rows.find(row => row.message.clientMessageId === id)?.delivery, 'sending');
  await act(async () => { assert.equal(sending.actions.send(id), false); });
  assert.equal(vi.mocked(chatApi.send).mock.calls.length, 1);
  await act(async () => { rejectSend(new Error('Network interrupted')); });
  const failed = read!()!;
  assert.equal(failed.data.rows.find(row => row.message.clientMessageId === id)?.delivery, 'failed');
  await act(async () => {
    assert.equal(failed.actions.send(id), true);
    assert.equal(failed.actions.send(id), false);
  });
  assert.deepEqual(vi.mocked(chatApi.send).mock.calls.map(call => call[0]), [id, id]);
  assert.equal(uuid.mock.calls.length, 1);
});
test('report refuses pending and unknown rows, closed reason controls and the blocked panel', async () => {
  vi.mocked(chatApi.history).mockResolvedValue({ messages: [otherMessage], nextBefore: null });
  const report = vi.spyOn(chatApi, 'report').mockImplementation(() => new Promise(() => undefined));
  await paint(bridge());
  await act(async () => { read!()!.actions.setBody('Still sending'); });
  await act(async () => { read!()!.actions.send(); });
  const pendingId = read!()!.data.rows.find(row => row.delivery === 'sending')!.message.id;
  await act(async () => { read!()!.actions.setReporting(pendingId); });
  assert.equal(read!()!.actions.report(pendingId, 'spam'), false);
  await act(async () => { read!()!.actions.setReporting('missing'); });
  assert.equal(read!()!.actions.report('missing', 'spam'), false);
  await act(async () => { read!()!.actions.setReporting(null); });
  assert.equal(read!()!.actions.report(otherMessage.id, 'spam'), false);
  await act(async () => { read!()!.actions.setReporting(otherMessage.id); });
  await act(async () => { read!()!.actions.openBlocks(); });
  assert.equal(read!()!.actions.report(otherMessage.id, 'spam'), false);
  assert.equal(report.mock.calls.length, 0);
  await act(async () => { read!()!.actions.showMessages(); });
  await act(async () => { assert.equal(read!()!.actions.report(otherMessage.id, 'spam'), true); });
  assert.deepEqual(report.mock.calls, [[otherMessage.id, 'spam']]);
});
test('block refuses own, missing and panel-hidden rows before allowing a rendered blockable row', async () => {
  const ownMessage = { ...otherMessage, id: 'own-message', clientMessageId: 'own-request', canBlock: false };
  vi.mocked(chatApi.history).mockResolvedValue({ messages: [ownMessage, otherMessage], nextBefore: null });
  const block = vi.spyOn(chatApi, 'block').mockImplementation(() => new Promise(() => undefined));
  await paint(bridge());
  assert.equal(read!()!.actions.block(ownMessage.id), false);
  assert.equal(read!()!.actions.block('missing'), false);
  await act(async () => { read!()!.actions.openBlocks(); });
  assert.equal(read!()!.actions.block(otherMessage.id), false);
  assert.equal(block.mock.calls.length, 0);
  await act(async () => { read!()!.actions.showMessages(); });
  await act(async () => { assert.equal(read!()!.actions.block(otherMessage.id), true); });
  assert.deepEqual(block.mock.calls, [[otherMessage.id]]);
});
