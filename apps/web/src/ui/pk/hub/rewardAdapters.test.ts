import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { questBoardModel, mailListModel, mailLetterModel, type QuestBoardInput, type MailListInput, type MailLetterInput } from './rewardAdapters';
import type { Quest } from '../../screens/quests';
import type { MailMessageDto } from '../../screens/mail';
const quest = (id = 'quest', extra: Partial<Quest> = {}): Quest => ({ id, scope: 'daily', templateCode: id,
 target: 5, progress: 2, completed: false, claimed: false, rewardShards: 25, ...extra });
const quests = (): QuestBoardInput => ({ wallet: 'wallet', baseId: 'base', snapshot: { wallet: 'wallet', baseId: 'base',
 quests: [quest()], allThreeBonus: 50 }, loading: false, error: null, fresh: true, actionsAllowed: true,
 operation: null, labels: {}, onboardingOrder: ['first_camp', 'first_raid'], onboardingActions: {}, dailyBonusAt: 3 });
const allRows = (input: QuestBoardInput) => questBoardModel(input).groups.flatMap(g => g.rows);
test('quest reads are bound to the current wallet and selected kingdom', () => {
 for (const patch of [{ wallet: 'other' }, { baseId: 'other' }]) {
  const x = quests(); Object.assign(x.snapshot!, patch);
  assert.equal(allRows(x).length, 0); assert.equal(questBoardModel(x).primary, null);
 }
});
test('unread quests have no invented bonus or empty-board success', () => {
 const m = questBoardModel({ ...quests(), snapshot: null });
 assert.equal(m.load, 'LOADING'); assert.equal(m.bonus.amount, '…'); assert.equal(m.hasSnapshot, false);
});
test('quest rewards prefer SHARDS and the old rewardKeep field remains labelled SHARDS', () => {
 const x = quests(); const legacy = quest('legacy', { rewardKeep: 60 }); delete legacy.rewardShards;
 x.snapshot!.quests = [quest('both', { rewardKeep: 90 }), legacy];
 assert.deepEqual(allRows(x).map(q => q.reward), ['25', '60']);
});
test('unknown and unsafe quest rewards never become zero or a rounded amount', () => {
 const x = quests(); const unknown = quest('unknown'); delete unknown.rewardShards;
 x.snapshot!.quests = [unknown, quest('unsafe', { rewardShards: Number.MAX_SAFE_INTEGER + 1 })];
 assert.deepEqual(allRows(x).map(q => q.reward), ['…', '…']);
});
test('confirmed zero quest reward stays a numeric zero', () => {
 const x = quests(); x.snapshot!.quests = [quest('zero', { rewardShards: 0 })]; assert.equal(allRows(x)[0]?.reward, '0');
});
test('first steps keep the shared catalogue order and the live step hint', () => {
 const x = quests(); x.snapshot!.quests = [quest('raid', { scope: 'onboarding', templateCode: 'first_raid' }), quest('camp', { scope: 'onboarding', templateCode: 'first_camp' })];
 x.onboardingActions = { first_camp: { verb: 'BUILD', hint: 'Make room for your army.' } };
 const m = questBoardModel(x); assert.deepEqual(m.groups[0]?.rows.map(q => q.id), ['camp', 'raid']);
 assert.equal(m.groups[0]?.rows[0]?.live, true); assert.equal(m.groups[0]?.rows[0]?.hint, 'Make room for your army.');
 assert.equal(m.groups[0]?.rows[0]?.action?.id, 'quest.go:camp');
});
test('a completed first-run chain disappears without hiding weekly or daily quests', () => {
 const x = quests(); x.snapshot!.quests = [quest('done', { scope: 'onboarding', claimed: true }), quest('weekly', { scope: 'weekly' }), quest()];
 assert.deepEqual(questBoardModel(x).groups.map(g => g.id), ['weekly', 'daily']);
});
test('daily quests retain ready then progress then untouched then claimed priority', () => {
 const x = quests(); x.snapshot!.quests = [quest('done', { claimed: true, completed: true }), quest('blank', { progress: 0 }), quest('half', { progress: 2, target: 4 }), quest('ready', { completed: true }), quest('most', { progress: 3, target: 4 })];
 assert.deepEqual(allRows(x).map(q => q.id), ['ready', 'most', 'half', 'blank', 'done']);
});
test('unknown quest scopes remain visible with the server identifier', () => {
 const x = quests(); x.snapshot!.quests = [quest('future', { scope: 'new-season' })];
 assert.equal(questBoardModel(x).groups[0]?.id, 'other'); assert.equal(allRows(x)[0]?.title, 'FUTURE');
});
test('claim all carries only the current completed unclaimed ids', () => {
 const x = quests(); x.snapshot!.quests = [quest('ready', { completed: true }), quest('done', { claimed: true, completed: true }), quest()];
 const m = questBoardModel(x); assert.deepEqual(m.claimableIds, ['ready']); assert.equal(m.primary?.label, 'CLAIM 1');
 assert.equal(m.primary?.id, 'quests.all'); assert.equal(m.primary?.state, 'ENABLED');
});
test('stale or loading board data cannot admit a new quest claim', () => {
 for (const patch of [{ fresh: false }, { loading: true }, { error: 'Read failed' }, { actionsAllowed: false }]) {
  const x = { ...quests(), ...patch }; x.snapshot!.quests = [quest('ready', { completed: true })];
  assert.equal(allRows(x)[0]?.action?.state, 'DISABLED'); assert.equal(questBoardModel(x).primary?.state, 'DISABLED');
 }
});
test('a busy claim blocks row claims and claim all', () => {
 const x = quests(); x.snapshot!.quests = [quest('ready', { completed: true })];
 x.operation = { wallet: 'wallet', baseId: 'base', busyId: 'ready', uncertain: false };
 assert.equal(allRows(x)[0]?.action?.state, 'BUSY'); assert.equal(questBoardModel(x).primary?.state, 'BUSY');
});
test('uncertain claims keep original-scope recovery across a kingdom selection change', () => {
 const x = quests(); x.snapshot!.quests = [quest('ready', { completed: true })];
 x.operation = { wallet: 'wallet', baseId: 'original-base', busyId: null, uncertain: true };
 const m = questBoardModel(x); assert.equal(m.primary?.id, 'quests.recover'); assert.equal(m.primary?.kind, 'recover');
 assert.equal(allRows(x)[0]?.action?.state, 'DISABLED'); assert.doesNotMatch(m.note!, /nothing was spent|all.*claimed/i);
});
test('foreign wallet operation details cannot leak into the current quest board', () => {
 const x = quests(); x.operation = { wallet: 'other', baseId: 'secret', busyId: null, uncertain: true };
 assert.notEqual(questBoardModel(x).primary?.id, 'quests.recover'); assert.doesNotMatch(questBoardModel(x).note ?? '', /secret/);
});
test('bonus policy comes from the caller and amount from the server', () => {
 const x = quests(); x.dailyBonusAt = null; x.snapshot!.allThreeBonus = null;
 assert.deepEqual(questBoardModel(x).bonus, { at: '…', amount: '…' });
 x.dailyBonusAt = 4; x.snapshot!.allThreeBonus = 1234;
 assert.deepEqual(questBoardModel(x).bonus, { at: '4', amount: '1,234' });
});
test('mapper ordering and formatting do not mutate the original board', () => {
 const x = quests(); const before = JSON.stringify(x); questBoardModel(x); assert.equal(JSON.stringify(x), before);
});

const message = (id = 'message', extra: Partial<MailMessageDto> = {}): MailMessageDto => ({ id, sender: 'system', kind: 'reward',
 subject: 'A reward', body: 'For your kingdom', attachments: [{ kind: 'SHARDS', amount: '9007199254740993' }], rewardState: 'pending',
 claimBaseId: null, createdAt: 'created', expiresAt: null, readAt: null, archivedAt: null, claimedAt: null, expiredAt: null, ...extra });
const mail = (): MailListInput => ({ wallet: 'wallet', archived: false, category: 'ALL',
 snapshot: { wallet: 'wallet', archived: false, messages: [message()], nextCursor: null }, loading: false, error: null, fresh: true, formatTime: s => s });
const letter = (): MailLetterInput => ({ wallet: 'wallet', messageId: 'message', snapshot: { wallet: 'wallet', message: message() },
 loading: false, busy: false, error: null, fresh: true, actionsAllowed: true, operation: null,
 targetBaseId: 'base', targetBaseAvailable: true, targetBaseLabel: 'Your kingdom', formatTime: s => s, itemLabel: id => id });
test('mail hides snapshots from another wallet or archive view', () => {
 const x = mail(); x.snapshot!.wallet = 'other'; assert.equal(mailListModel(x).rows.length, 0);
 x.snapshot!.wallet = 'wallet'; x.archived = true; assert.equal(mailListModel(x).rows.length, 0);
});
test('mail filters preserve reward and news categories without inferring a reward count', () => {
 const x = mail(); x.snapshot!.messages.push(message('news', { kind: 'info', attachments: [], rewardState: null }));
 x.category = 'REWARDS'; assert.deepEqual(mailListModel(x).rows.map(r => r.id), ['message']);
 x.category = 'NEWS'; assert.deepEqual(mailListModel(x).rows.map(r => r.id), ['news']);
});
test('mail load-more follows the server cursor and blocks concurrent pagination', () => {
 const x = mail(); assert.equal(mailListModel(x).primary, null); x.snapshot!.nextCursor = 'cursor';
 assert.equal(mailListModel(x).primary?.id, 'mail.more'); x.loading = true;
 assert.equal(mailListModel(x).primary?.state, 'BUSY');
});
test('mail unread and reward state remain distinct visible labels', () => {
 const m = mailListModel(mail()); assert.match(m.rows[0]?.tag ?? '', /UNREAD/); assert.match(m.rows[0]?.tag ?? '', /REWARD/);
 assert.equal(m.rows[0]?.action?.id, 'mail.open:message');
});
test('a foreign or mismatched selected letter never exposes private body or attachments', () => {
 const x = letter(); x.snapshot!.wallet = 'other'; assert.equal(mailLetterModel(x).message, null);
 x.snapshot!.wallet = 'wallet'; x.messageId = 'different'; assert.equal(mailLetterModel(x).message, null);
});
test('mail attachments retain exact canonical amounts and their own currency', () => {
 const x = letter(); x.snapshot!.message.attachments.push({ kind: 'KEEP', amount: '0' }, { kind: 'ITEM', itemId: 'shield', qty: 2 });
 assert.deepEqual(mailLetterModel(x).rewards.map(r => r.value), ['9,007,199,254,740,993 SHARDS', '0 KEEP', '2 × shield']);
});
test('malformed mail amounts remain unknown without dropping the attachment', () => {
 const x = letter(); x.snapshot!.message.attachments = [{ kind: 'SHARDS', amount: '1e20' }, { kind: 'ITEM', itemId: 'shield', qty: NaN }];
 const m = mailLetterModel(x); assert.equal(m.rewards.length, 2); assert.deepEqual(m.rewards.map(r => r.value), ['… SHARDS', '… × shield']);
});
test('SHARDS and item mail require an authorized target kingdom before claim', () => {
 const x = letter(); x.targetBaseAvailable = false;
 assert.equal(mailLetterModel(x).primary?.id, 'mail.select-base'); assert.equal(mailLetterModel(x).primary?.kind, 'navigate');
});
test('KEEP-only mail never acquires an invented selected-base requirement', () => {
 const x = letter(); x.targetBaseId = null; x.targetBaseAvailable = false; x.snapshot!.message.attachments = [{ kind: 'KEEP', amount: '12' }];
 assert.equal(mailLetterModel(x).primary?.id, 'mail.claim:message');
});
test('a current requested claim preserves GET recovery and prevents archive', () => {
 const x = letter(); x.operation = { wallet: 'wallet', messageId: 'message', baseId: 'base', phase: 'checking' }; x.actionsAllowed = false;
 const m = mailLetterModel(x); assert.equal(m.primary?.id, 'mail.claim.check'); assert.equal(m.primary?.kind, 'recover'); assert.equal(m.archive, null);
 assert.equal(m.rewards[0]?.value, '9,007,199,254,740,993 SHARDS');
 assert.doesNotMatch(m.note!, /nothing was spent/);
});
test('claim in flight remains busy and cannot be archived or reposted', () => {
 const x = letter(); x.operation = { wallet: 'wallet', messageId: 'message', baseId: 'base', phase: 'claiming' };
 const m = mailLetterModel(x); assert.equal(m.primary?.state, 'BUSY'); assert.equal(m.archive, null);
});
test('switching letters cannot redirect an unresolved original claim', () => {
 const x = letter(); x.operation = { wallet: 'wallet', messageId: 'original', baseId: 'original-base', phase: 'checking' };
 const m = mailLetterModel(x); assert.equal(m.primary?.id, 'mail.claim.check'); assert.equal(m.archive, null); assert.match(m.note!, /original/);
});
test('original mail recovery survives an unread or removed selected letter', () => {
 const x = letter(); x.snapshot = null; x.operation = { wallet: 'wallet', messageId: 'original', baseId: 'original-base', phase: 'checking' };
 const m = mailLetterModel(x); assert.equal(m.message, null); assert.equal(m.primary?.id, 'mail.claim.check'); assert.equal(m.archive, null);
});
test('an ordinary read error does not become a definitive refusal or retry mutation', () => {
 const x = letter(); x.error = 'Network lost';
 const m = mailLetterModel(x); assert.notEqual(m.primary?.id, 'mail.claim:message'); assert.equal(m.primary?.kind, 'recover'); assert.equal(m.archive?.state, 'DISABLED');
});
test('only the explicitly supplied authoritative refusal can offer retry', () => {
 const x = letter(); x.operation = { wallet: 'wallet', messageId: 'message', baseId: 'base', phase: 'refused' };
 assert.equal(mailLetterModel(x).primary?.label, 'RETRY CLAIM'); assert.equal(mailLetterModel(x).primary?.id, 'mail.claim:message');
});
test('claimed and expired server rewards never offer claim again', () => {
 for (const rewardState of ['claimed', 'expired'] as const) { const x = letter(); x.snapshot!.message.rewardState = rewardState;
  const m = mailLetterModel(x); assert.equal(m.primary, null); assert.ok(m.archive); assert.equal(m.state, rewardState.toUpperCase()); }
});
test('client display dates do not expire pending rewards', () => {
 const x = letter(); x.snapshot!.message.expiresAt = '2000-01-01T00:00:00Z';
 assert.equal(mailLetterModel(x).state, 'CLAIMABLE'); assert.equal(mailLetterModel(x).primary?.id, 'mail.claim:message');
});
test('stale mail rewards remain visible but cannot claim or archive', () => {
 const x = letter(); x.fresh = false; const m = mailLetterModel(x);
 assert.equal(m.rewards[0]?.value, '9,007,199,254,740,993 SHARDS'); assert.equal(m.primary?.kind, 'recover'); assert.equal(m.archive?.state, 'DISABLED');
});
test('archived letters have no duplicate archive action', () => {
 const x = letter(); x.snapshot!.message.archivedAt = 'archived'; assert.equal(mailLetterModel(x).archive, null);
});
test('hub reward mappers own no request timer storage wallet or controller lifecycle', () => {
 const source = readFileSync(new URL('./rewardAdapters.ts', import.meta.url), 'utf8');
 assert.doesNotMatch(source, /\bfetch\s*\(|localStorage|indexedDB|\bDate\b|setInterval|signTransaction|useEffect/);
 for (const line of source.split('\n').filter(x => /^import\b/.test(x))) assert.match(line, /^import type /);
});
test('null selected base matches the server-resolved active-base board', () => { const x=quests();x.baseId=null;x.snapshot!.baseId=null;x.snapshot!.quests[0]!.completed=true;const m=questBoardModel(x);assert.equal(m.hasSnapshot,true);assert.equal(m.primary?.state,'ENABLED');assert.equal(m.groups[0]?.rows[0]?.action?.state,'ENABLED'); });
test('null and explicit base selections do not share a quest snapshot', () => { const x=quests();x.baseId=null;assert.equal(questBoardModel(x).hasSnapshot,false);x.baseId='base';x.snapshot!.baseId=null;assert.equal(questBoardModel(x).hasSnapshot,false); });
test('retired KEEP attachment retains its amount but is labelled retired', () => { const x=letter();x.snapshot!.message.attachments=[{kind:'KEEP',amount:'9007199254740993',...{retired:true}}];const m=mailLetterModel(x);assert.equal(m.rewards[0]?.value,'9,007,199,254,740,993 KEEP · RETIRED'); });
test('definitive original refusal has honest copy when another letter is selected', () => { const x=letter();x.operation={wallet:'wallet',messageId:'original',baseId:'base',phase:'refused'};const m=mailLetterModel(x);assert.equal(m.state,'FAILED');assert.match(m.note!,/refused/);assert.doesNotMatch(m.note!,/being checked/);assert.equal(m.primary?.kind,'recover');assert.equal(m.archive,null); });
test('definitive original refusal remains explicit when selected letter is absent', () => { const x=letter();x.snapshot=null;x.operation={wallet:'wallet',messageId:'original',baseId:null,phase:'refused'};assert.equal(mailLetterModel(x).primary?.label,'CHECK REFUSED ORIGINAL CLAIM');assert.equal(mailLetterModel(x).state,'FAILED'); });


test('an all-retired KEEP letter is read-only historical value with no payout action', () => {
 const x = letter(); x.snapshot!.message.attachments = [
  { kind: 'KEEP', amount: '9007199254740993', ...{ retired: true } },
  { kind: 'KEEP', amount: '12', ...{ retired: true } },
 ];
 for (const refused of [false, true]) {
  x.operation = refused ? { wallet: 'wallet', messageId: 'message', baseId: 'base', phase: 'refused' } : null;
  const m = mailLetterModel(x);
  assert.equal(m.state, 'READ'); assert.equal(m.primary, null);
  assert.equal(m.archive?.id, 'mail.archive:message');
  assert.deepEqual(m.rewards.map(row => row.value), ['9,007,199,254,740,993 KEEP · RETIRED', '12 KEEP · RETIRED']);
 }
});
test('retired KEEP alongside a payable attachment does not hide the payable claim', () => {
 const payable: MailMessageDto['attachments'] = [
  { kind: 'SHARDS', amount: '25' }, { kind: 'ITEM', itemId: 'shield', qty: 1 }, { kind: 'KEEP', amount: '12' },
 ];
 for (const attachment of payable) {
  const x = letter(); x.snapshot!.message.attachments = [{ kind: 'KEEP', amount: '9', ...{ retired: true } }, attachment];
  const m = mailLetterModel(x);
  assert.equal(m.state, 'CLAIMABLE'); assert.equal(m.primary?.id, 'mail.claim:message');
  assert.equal(m.primary?.label, 'CLAIM REWARD'); assert.equal(m.rewards.length, 2);
 }
});
test('all-retired attachment copy cannot remove an unresolved original mail operation', () => {
 for (const phase of ['claiming', 'checking'] as const) {
  const x = letter(); x.snapshot!.message.attachments = [{ kind: 'KEEP', amount: '9', ...{ retired: true } }];
  x.operation = { wallet: 'wallet', messageId: 'message', baseId: 'base', phase };
  const m = mailLetterModel(x);
  assert.equal(m.primary?.id, 'mail.claim.check'); assert.equal(m.primary?.kind, 'recover');
  assert.equal(m.state, phase === 'claiming' ? 'CLAIMING' : 'CHECKING'); assert.equal(m.archive, null);
 }
});


test('mail list uses payable rewards for pending tags and preserves unread and terminal states', () => {
 const retired: MailMessageDto['attachments'] = [{ kind: 'KEEP', amount: '12', ...{ retired: true } }];
 const x = mail(); x.snapshot!.messages = [
  message('retired-unread', { attachments: retired }),
  message('retired-read', { attachments: retired, readAt: 'read' }),
  message('mixed', { attachments: [...retired, { kind: 'SHARDS', amount: '5' }] }),
  message('payable-keep', { attachments: [{ kind: 'KEEP', amount: '12' }] }),
  message('empty', { attachments: [], readAt: 'read' }),
  message('claimed', { attachments: retired, rewardState: 'claimed' }),
  message('expired', { attachments: retired, rewardState: 'expired' }),
 ];
 const rows = mailListModel(x).rows;
 assert.deepEqual(rows.map(row => [row.id, row.tag]), [
  ['retired-unread', 'UNREAD · RETIRED'], ['retired-read', 'RETIRED'],
  ['mixed', 'UNREAD · REWARD'], ['payable-keep', 'UNREAD · REWARD'],
  ['empty', null], ['claimed', 'UNREAD · CLAIMED'], ['expired', 'UNREAD · EXPIRED'],
 ]);
 assert.deepEqual(rows.map(row => row.action?.id), x.snapshot!.messages.map(row => `mail.open:${row.id}`));
});
