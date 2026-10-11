// @vitest-environment happy-dom
import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QuestBoardAdapter, MailListAdapter, MailLetterAdapter } from './RewardAdapterViews';
import type { QuestBoardInput, MailLetterInput } from './rewardAdapters';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
function render(node: React.ReactNode) { const el = document.createElement('div'); document.body.append(el); act(() => { root = createRoot(el); root.render(node); }); }
function click(label: string) { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') ?? x.textContent ?? '').startsWith(label)); assert.ok(b, label); act(() => b.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.replaceChildren(); });
const board = (): QuestBoardInput => ({ wallet: 'wallet', baseId: 'base', snapshot: { wallet: 'wallet', baseId: 'base',
 quests: [{ id: 'q', scope: 'daily', templateCode: 'raid', target: 5, progress: 2, completed: true, claimed: false, rewardShards: 25 }], allThreeBonus: 50 },
 loading: false, error: null, fresh: true, actionsAllowed: true, operation: null, labels: { raid: 'Win raids' }, onboardingOrder: [], onboardingActions: {}, dailyBonusAt: 3 });
const letter = (): MailLetterInput => ({ wallet: 'wallet', messageId: 'm', snapshot: { wallet: 'wallet', message: {
 id: 'm', sender: 'system', kind: 'reward', subject: 'Reward', body: '<script>unsafe()</script>', attachments: [{ kind: 'SHARDS', amount: '25' }], rewardState: 'pending',
 claimBaseId: null, createdAt: 'created', expiresAt: null, readAt: null, archivedAt: null, claimedAt: null, expiredAt: null } },
 loading: false, busy: false, error: null, fresh: true, actionsAllowed: true, operation: null, targetBaseId: 'base', targetBaseAvailable: true, targetBaseLabel: 'Home', formatTime: s => s, itemLabel: s => s });
test('quest adapter preserves a named section progress and SHARDS reward', () => {
  const x = board(); x.snapshot!.quests[0]!.completed = false;
  render(<QuestBoardAdapter input={x} onIntent={vi.fn()} />);
  assert.ok([...document.querySelectorAll('h2')].some(x => x.textContent === 'TODAY'));
  const progress = document.querySelector('progress'); assert.equal(progress?.getAttribute('max'), '5'); assert.equal(progress?.getAttribute('value'), '2');
  assert.match(document.body.textContent ?? '', /25 SHARDS/); assert.doesNotMatch(document.body.textContent ?? '', /25 KEEP/);
});
test('quest row claim is an intent and nothing dispatches during render', () => {
  const intent = vi.fn(); render(<QuestBoardAdapter input={board()} onIntent={intent} />); assert.equal(intent.mock.calls.length, 0);
  click('CLAIM REWARD'); assert.deepEqual(intent.mock.calls, [[{ id: 'quest.claim:q', kind: 'action' }]]);
});
test('busy claim-all cannot dispatch another mutation', () => {
  const x = board(); x.operation = { wallet: 'wallet', baseId: 'base', busyId: 'all', uncertain: false };
  const intent = vi.fn(); render(<QuestBoardAdapter input={x} onIntent={intent} />); click('CLAIM 1'); assert.equal(intent.mock.calls.length, 0);
});
test('quest retry uses a stable feature intent instead of the visible heading', () => {
  const x = board(); x.error = 'Failed'; const intent = vi.fn(); render(<QuestBoardAdapter input={x} onIntent={intent} />);
  click('RETRY'); assert.deepEqual(intent.mock.calls, [[{ id: 'quests.refresh', kind: 'recover' }]]);
});
test('mail body is plain text and never parsed as markup', () => {
  render(<MailLetterAdapter input={letter()} onIntent={vi.fn()} />);
  assert.match(document.body.textContent ?? '', /<script>unsafe\(\)<\/script>/); assert.equal(document.querySelector('script'), null);
});
test('uncertain mail has recovery and no archive or fresh claim control', () => {
  const x = letter(); x.operation = { wallet: 'wallet', messageId: 'm', baseId: 'base', phase: 'checking' };
  const intent = vi.fn(); render(<MailLetterAdapter input={x} onIntent={intent} />); click('CHECK ORIGINAL CLAIM');
  assert.deepEqual(intent.mock.calls, [[{ id: 'mail.claim.check', kind: 'recover' }]]);
  assert.ok([...document.querySelectorAll('button')].every(b => !/^(ARCHIVE|CLAIM REWARD)/.test(b.getAttribute('aria-label') ?? b.textContent ?? '')));
});
test('mail requiring a base navigates to the existing base chooser', () => {
  const x = letter(); x.targetBaseId = null; x.targetBaseAvailable = false;
  const intent = vi.fn(); render(<MailLetterAdapter input={x} onIntent={intent} />); click('CHOOSE KINGDOM');
  assert.deepEqual(intent.mock.calls, [[{ id: 'mail.select-base', kind: 'navigate' }]]);
});
test('mail archive and inbox remain named navigation doors', () => {
  const intent = vi.fn(); render(<MailListAdapter input={{ wallet: 'wallet', archived: false, category: 'ALL', snapshot: { wallet: 'wallet', archived: false, messages: [], nextCursor: null }, loading: false, error: null, fresh: true, formatTime: s => s }} onIntent={intent} onCategory={vi.fn()} />);
  click('ARCHIVE'); assert.deepEqual(intent.mock.calls, [[{ id: 'mail.archive-list', kind: 'navigate' }]]);
});
test('an initial mail read failure does not claim a previous view was kept', () => {
  render(<MailListAdapter input={{ wallet: 'wallet', archived: false, category: 'ALL', snapshot: null, loading: false, error: 'Read failed', fresh: false, formatTime: s => s }} onIntent={vi.fn()} onCategory={vi.fn()} />);
  assert.equal(document.querySelectorAll('[role="alert"]').length, 1);
  assert.doesNotMatch(document.body.textContent ?? '', /Your last view is kept/);
});
test('unread selected letter still renders the original claim recovery control', () => {
  const x = letter(); x.snapshot = null; x.operation = { wallet: 'wallet', messageId: 'original', baseId: 'base', phase: 'checking' };
  const intent = vi.fn(); render(<MailLetterAdapter input={x} onIntent={intent} />); click('CHECK ORIGINAL CLAIM');
  assert.deepEqual(intent.mock.calls, [[{ id: 'mail.claim.check', kind: 'recover' }]]);
});
test('null selected base board renders and emits a claim', () => { const x=board();x.baseId=null;x.snapshot!.baseId=null;const intent=vi.fn();render(<QuestBoardAdapter input={x} onIntent={intent}/>);assert.match(document.body.textContent??'',/TODAY/);click('CLAIM REWARD');assert.deepEqual(intent.mock.calls,[[{id:'quest.claim:q',kind:'action'}]]); });
test('claim all captures reviewed ids and nullable scope at render', () => { const x=board();x.baseId=null;x.snapshot!.baseId=null;const intent=vi.fn();render(<QuestBoardAdapter input={x} onIntent={intent}/>);x.snapshot!.quests.push({...x.snapshot!.quests[0]!,id:'unreviewed'});x.baseId='changed';click('CLAIM 1');assert.deepEqual(intent.mock.calls,[[{id:'quests.all',kind:'action',questClaimAll:{wallet:'wallet',baseId:null,questIds:['q']}}]]); });
test('quest recovery carries original nullable base rather than current selection', () => { const x=board();x.operation={wallet:'wallet',baseId:null,busyId:null,uncertain:true};const intent=vi.fn();render(<QuestBoardAdapter input={x} onIntent={intent}/>);click('CHECK ORIGINAL CLAIMS');assert.deepEqual(intent.mock.calls,[[{id:'quests.recover',kind:'recover',questRecovery:{wallet:'wallet',baseId:null}}]]); });
test('filtered empty mail points to later server pages', () => { render(<MailListAdapter input={{wallet:'wallet',archived:false,category:'NEWS',snapshot:{wallet:'wallet',archived:false,messages:[],nextCursor:'cursor'},loading:false,error:null,fresh:true,formatTime:s=>s}} onIntent={vi.fn()} onCategory={vi.fn()}/>);assert.match(document.body.textContent??'',/No matching letters on this page\. LOAD MORE/);assert.doesNotMatch(document.body.textContent??'',/No letters in this category/); });
test('a board without daily quests does not render a daily bonus', () => { const x=board();x.snapshot!.quests[0]!.scope='weekly';render(<QuestBoardAdapter input={x} onIntent={vi.fn()}/>);assert.doesNotMatch(document.body.textContent??'',/DAILY BONUS/); });


test('a board with daily quests renders DAILY BONUS and CLAIM ANY 3', () => {
 render(<QuestBoardAdapter input={board()} onIntent={vi.fn()} />);
 assert.ok([...document.querySelectorAll('h3')].some(node => node.textContent === 'DAILY BONUS'));
 assert.ok([...document.querySelectorAll('p')].some(node => node.textContent === 'CLAIM ANY 3 · BONUS'));
 assert.match(document.body.textContent ?? '', /50 SHARDS/);
});
test('an all-retired KEEP letter displays READ and historical rewards without a claim control', () => {
 const x = letter(); x.snapshot!.message.attachments = [{ kind: 'KEEP', amount: '12', ...{ retired: true } }];
 const intent = vi.fn(); render(<MailLetterAdapter input={x} onIntent={intent} />);
 assert.match(document.body.textContent ?? '', /12 KEEP · RETIRED/);
 assert.deepEqual([...document.querySelectorAll('article.pk-rewards > .pk-tag')].map(tag => tag.textContent), ['READ']);
 assert.ok([...document.querySelectorAll('button')].every(button => !/^(CLAIM REWARD|RETRY CLAIM|CHOOSE KINGDOM)/.test(button.getAttribute('aria-label') ?? button.textContent ?? '')));
 assert.equal(intent.mock.calls.length, 0);
});


test('clicking every all-retired letter button never dispatches a claim or base selection', () => {
 const x = letter(); x.snapshot!.message.attachments = [{ kind: 'KEEP', amount: '12', ...{ retired: true } }];
 const intent = vi.fn(); render(<MailLetterAdapter input={x} onIntent={intent} />);
 const buttons = [...document.querySelectorAll('button')]; assert.ok(buttons.length > 0);
 for (const button of buttons) act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
 const ids = intent.mock.calls.map(call => call[0].id);
 assert.ok(ids.includes('mail.inbox')); assert.ok(ids.includes('mail.archive:m'));
 assert.ok(ids.every(id => !id.startsWith('mail.claim') && id !== 'mail.select-base'));
});
test('daily bonus wording follows a supplied threshold different from the default fixture', () => {
 const x = board(); x.dailyBonusAt = 4;
 render(<QuestBoardAdapter input={x} onIntent={vi.fn()} />);
 assert.ok([...document.querySelectorAll('h3')].some(node => node.textContent === 'DAILY BONUS'));
 assert.ok([...document.querySelectorAll('p')].some(node => node.textContent === 'CLAIM ANY 4 · BONUS'));
 assert.ok([...document.querySelectorAll('p')].every(node => node.textContent !== 'CLAIM ANY 3 · BONUS'));
});
