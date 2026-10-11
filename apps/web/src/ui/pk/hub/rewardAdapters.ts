/** Quest/mail display adapters. Existing screen owners retain requests and recovery. */
import type { Quest } from '../../screens/quests';
import type { StepAction } from '../../onboardingChain';
import type { MailMessageDto } from '../../screens/mail';
import type { HubAction, HubRow } from './HubSheets';
import type { LoadState, LetterState } from './HubLogic';

const count = (value: number | null | undefined): number | null => value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
const groupDigits = (value: string): string => value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const displayCount = (value: number | null | undefined): string => count(value) === null ? '…' : groupDigits(String(value));
const readLoad = (present: boolean, loading: boolean, error: string | null, fresh: boolean): LoadState =>
 loading ? 'LOADING' : error ? 'ERROR' : !present ? 'LOADING' : !fresh ? 'STALE' : 'READY';

export interface QuestBoardInput {
 wallet: string | null;
 baseId: string | null;
 /** Existing /quests read plus producer-captured identity; no new wire fields. */
 snapshot: { wallet: string; baseId: string | null; quests: Quest[]; allThreeBonus: number | null } | null;
 loading: boolean;
 error: string | null;
 fresh: boolean;
 actionsAllowed: boolean;
 /** Existing owner's in-flight or unresolved original operation, not a new journal. */
 operation: { wallet: string; baseId: string | null; busyId: string | null; uncertain: boolean } | null;
 labels: Readonly<Record<string, string>>;
 onboardingOrder: readonly string[];
 onboardingActions: Readonly<Record<string, Pick<StepAction, 'verb' | 'hint' | 'disabled'> | undefined>>;
 /** From shared QUESTS; an unread rule does not acquire a local default. */
 dailyBonusAt: number | null;
}
export interface QuestViewRow {
 id: string; title: string; state: 'READY' | 'GO' | 'DONE'; progress: number | null; target: number | null;
 reward: string; live: boolean; hint: string | null; action: HubAction | null;
}
export interface QuestBoardModel {
 groups: { id: string; title: string; rows: QuestViewRow[] }[];
 claimableIds: string[];
 bonus: { at: string; amount: string };
 primary: HubAction | null;
 load: LoadState;
 note: string | null;
 hasSnapshot: boolean;
}
export function questBoardModel(input: QuestBoardInput): QuestBoardModel {
 const snapshot = input.wallet !== null && input.snapshot?.wallet === input.wallet && input.snapshot.baseId === input.baseId ? input.snapshot : null;
 const operation = input.wallet !== null && input.operation?.wallet === input.wallet ? input.operation : null;
 const busy = operation?.busyId !== null && operation?.busyId !== undefined;
 const checking = operation?.uncertain === true;
 const fresh = snapshot !== null && input.fresh && !input.loading && !input.error && input.actionsAllowed;
 const actionState = busy ? 'BUSY' : checking || !fresh ? 'DISABLED' : 'ENABLED';
 const blockedReason = checking ? 'Check the original claim before claiming again.' : !fresh ? 'Refresh current quest availability first.' : null;
 const quests = snapshot?.quests ?? [];
 const chainIndex = (q: Quest): number => { const i = input.onboardingOrder.indexOf(q.templateCode); return i < 0 ? input.onboardingOrder.length : i; };
 const chain = quests.filter(q => q.scope === 'onboarding').slice().sort((a, b) => chainIndex(a) - chainIndex(b));
 const liveId = chain.find(q => !q.claimed)?.id;
 const label = (q: Quest): string => input.labels[q.templateCode] || q.templateCode.toUpperCase();
 const rank = (q: Quest): number => q.claimed ? 3 : q.completed ? 0 : (count(q.progress) ?? 0) > 0 ? 1 : 2;
 const completion = (q: Quest): number => count(q.progress) !== null && count(q.target) !== null && q.target > 0 ? q.progress / q.target : 0;
 const dailies = quests.filter(q => q.scope === 'daily').slice().sort((a, b) => rank(a) - rank(b)
  || (rank(a) === 1 ? completion(b) - completion(a) : 0) || label(a).localeCompare(label(b)));
 const row = (q: Quest): QuestViewRow => {
  const state = q.claimed ? 'DONE' : q.completed ? 'READY' : 'GO';
  const destination = q.scope === 'onboarding' ? input.onboardingActions[q.templateCode] : undefined;
  const action: HubAction | null = state === 'READY'
   ? { id: `quest.claim:${q.id}`, label: 'CLAIM REWARD', state: actionState, kind: 'action', reason: blockedReason }
   : state === 'GO' && destination ? { id: `quest.go:${q.id}`, label: destination.verb,
     state: actionState === 'ENABLED' && destination.disabled ? 'DISABLED' : actionState,
     kind: 'navigate', reason: destination.disabled ? 'Open the current quest step first.' : blockedReason } : null;
  return { id: q.id, title: label(q), state, progress: count(q.progress), target: count(q.target),
   reward: displayCount(q.rewardShards ?? q.rewardKeep), live: q.scope === 'onboarding' && q.id === liveId,
   hint: q.id === liveId && state === 'GO' ? destination?.hint ?? null : null, action };
 };
 const groups: QuestBoardModel['groups'] = [];
 const add = (id: string, title: string, rows: Quest[]): void => { if (rows.length) groups.push({ id, title, rows: rows.map(row) }); };
 if (!chain.every(q => q.claimed)) add('onboarding', 'YOUR FIRST STEPS', chain);
 add('weekly', 'THIS WEEK', quests.filter(q => q.scope === 'weekly'));
 add('daily', 'TODAY', dailies);
 add('other', 'OTHER QUESTS', quests.filter(q => !['onboarding', 'weekly', 'daily'].includes(q.scope)));
 const claimableIds = quests.filter(q => q.completed && !q.claimed).map(q => q.id);
 const primary: HubAction | null = checking ? { id: 'quests.recover', label: 'CHECK ORIGINAL CLAIMS', state: busy ? 'BUSY' : 'ENABLED', kind: 'recover' }
  : claimableIds.length ? { id: 'quests.all', label: `CLAIM ${claimableIds.length}`, state: actionState, kind: 'action', reason: blockedReason } : null;
 return { groups, claimableIds, bonus: { at: displayCount(input.dailyBonusAt), amount: displayCount(snapshot?.allThreeBonus) }, primary,
  hasSnapshot: snapshot !== null, load: readLoad(snapshot !== null, input.loading, input.error, input.fresh),
  note: checking ? 'The original claims are being checked. Keep the original kingdom and request until their outcomes are known.'
   : busy ? 'A quest action is in progress.' : input.error ?? (snapshot && !input.fresh ? 'Showing the last read. Refresh before claiming.' : null) };
}

export type MailCategory = 'ALL' | 'REWARDS' | 'NEWS';
export interface MailListInput {
 wallet: string | null;
 archived: boolean;
 category: MailCategory;
 snapshot: { wallet: string; archived: boolean; messages: MailMessageDto[]; nextCursor: string | null } | null;
 loading: boolean;
 error: string | null;
 fresh: boolean;
 formatTime: (iso: string) => string;
}
export interface MailListModel { rows: HubRow[]; primary: HubAction | null; load: LoadState; note: string | null; hasData: boolean }
const hasPayableMailRewards = (message: MailMessageDto): boolean => message.attachments.some(a => a.kind !== 'KEEP' || !('retired' in a && a.retired === true));
export function mailListModel(input: MailListInput): MailListModel {
 const snapshot = input.wallet !== null && input.snapshot?.wallet === input.wallet && input.snapshot.archived === input.archived ? input.snapshot : null;
 const rows = (snapshot?.messages ?? []).filter(m => input.category === 'ALL' || (input.category === 'REWARDS' ? m.kind === 'reward' : m.kind === 'info'))
  .map((m): HubRow => ({ id: m.id, title: m.subject, sub: `${m.sender.toUpperCase()} · ${input.formatTime(m.createdAt)}`,
   tag: [!m.readAt ? 'UNREAD' : '', m.rewardState === 'pending' ? (hasPayableMailRewards(m) ? 'REWARD' : m.attachments.length ? 'RETIRED' : '') : m.rewardState?.toUpperCase() ?? ''].filter(Boolean).join(' · ') || null,
   action: { id: `mail.open:${m.id}`, label: 'OPEN LETTER', state: 'ENABLED', kind: 'navigate' } }));
 return { rows, hasData: snapshot !== null, load: readLoad(snapshot !== null, input.loading, input.error, input.fresh),
  note: input.error ?? (snapshot && !input.fresh ? 'Showing the last read of your mail.' : null),
  primary: snapshot?.nextCursor ? { id: 'mail.more', label: 'LOAD MORE', kind: 'recover',
   state: input.loading ? 'BUSY' : input.error || !input.fresh ? 'DISABLED' : 'ENABLED', reason: input.error || !input.fresh ? 'Refresh this mailbox first.' : null } : null };
}

export interface MailLetterInput {
 wallet: string | null;
 messageId: string | null;
 snapshot: { wallet: string; message: MailMessageDto } | null;
 loading: boolean;
 busy: boolean;
 error: string | null;
 fresh: boolean;
 actionsAllowed: boolean;
 /** Local operation state belongs to the existing producer. A generic error is never 'refused'. */
 operation: { wallet: string; messageId: string; baseId: string | null; phase: 'claiming' | 'checking' | 'refused' } | null;
 /** Resolved by the existing claimTargetBaseId/ownership path, not inferred from reward data. */
 targetBaseId: string | null;
 targetBaseAvailable: boolean;
 targetBaseLabel: string | null;
 formatTime: (iso: string) => string;
 itemLabel: (itemId: string) => string;
}
export interface MailLetterModel {
 message: MailMessageDto | null;
 rewards: HubRow[];
 state: LetterState | 'LOADING';
 primary: HubAction | null;
 archive: HubAction | null;
 load: LoadState;
 note: string | null;
 metadata: string | null;
}
const mailAmount = (value: string): string => /^(?:0|[1-9][0-9]*)$/.test(value) ? groupDigits(value) : '…';
export function mailLetterModel(input: MailLetterInput): MailLetterModel {
 const message = input.wallet !== null && input.messageId !== null && input.snapshot?.wallet === input.wallet
  && input.snapshot.message.id === input.messageId ? input.snapshot.message : null;
 const model: MailLetterModel = { message, rewards: [], state: 'LOADING', primary: null, archive: null,
  load: readLoad(message !== null, input.loading, input.error, input.fresh), note: input.error, metadata: null };
 if (message) {
  model.metadata = `${message.sender.toUpperCase()} · ${input.formatTime(message.createdAt)}`;
  model.rewards = message.attachments.map((a, index): HubRow => ({ id: `mail.reward:${index}`, title: a.kind === 'ITEM' ? input.itemLabel(a.itemId) : a.kind,
   value: a.kind === 'ITEM' ? `${displayCount(a.qty)} × ${input.itemLabel(a.itemId)}` : `${mailAmount(a.amount)} ${a.kind}${a.kind === 'KEEP' && 'retired' in a && a.retired === true ? ' · RETIRED' : ''}`,
   ...(!input.fresh || input.loading || input.error ? { tag: 'LAST READ' } : {}) }));
 }
 const operation = input.wallet !== null && input.operation?.wallet === input.wallet ? input.operation : null;
 // Recovery is independent of whether the currently selected letter can still be read.
 if (operation && (!message || operation.phase !== 'refused' || operation.messageId !== message.id)) {
  const claiming = operation.phase === 'claiming';
  const refused = operation.phase === 'refused';
  return { ...model, state: claiming ? 'CLAIMING' : refused ? 'FAILED' : 'CHECKING', archive: null,
   primary: { id: 'mail.claim.check', label: claiming ? 'CLAIMING' : refused ? 'CHECK REFUSED ORIGINAL CLAIM' : 'CHECK ORIGINAL CLAIM', state: claiming || input.busy ? 'BUSY' : 'ENABLED', kind: 'recover' },
   note: refused ? 'The original mail claim was refused. Check that original letter before continuing; this does not retry the claim.' : 'The original mail claim is being checked. Its original reward and kingdom stay attached to that request.' };
 }
 if (!message) return model;
 const fresh = input.fresh && !input.loading && !input.error && !input.busy && input.actionsAllowed;
 model.archive = message.archivedAt ? null : { id: `mail.archive:${message.id}`, label: 'ARCHIVE',
  state: input.busy || input.loading ? 'BUSY' : fresh ? 'ENABLED' : 'DISABLED', kind: 'action', reason: fresh ? null : 'Refresh this letter before archiving.' };
 const hasRewards = hasPayableMailRewards(message);
 model.state = message.rewardState === 'claimed' ? 'CLAIMED' : message.rewardState === 'expired' ? 'EXPIRED'
  : message.rewardState === 'pending' && hasRewards ? operation?.phase === 'refused' ? 'FAILED' : 'CLAIMABLE' : 'READ';
 if (model.state === 'CLAIMED') model.note = message.claimedAt ? `Claimed ${input.formatTime(message.claimedAt)}.` : 'The server reports these rewards claimed.';
 else if (model.state === 'EXPIRED') model.note = 'The server reports these rewards expired.';
 else if (model.state === 'CLAIMABLE' || model.state === 'FAILED') {
  if (!fresh) model.primary = { id: `mail.read:${message.id}`, label: 'CHECK LETTER', state: input.busy || input.loading ? 'BUSY' : 'ENABLED', kind: 'recover' };
  else if (message.attachments.some(a => a.kind === 'SHARDS' || a.kind === 'ITEM') && (!input.targetBaseId || !input.targetBaseAvailable))
   model.primary = { id: 'mail.select-base', label: 'CHOOSE KINGDOM', state: 'ENABLED', kind: 'navigate' };
  else model.primary = { id: `mail.claim:${message.id}`, label: model.state === 'FAILED' ? 'RETRY CLAIM' : 'CLAIM REWARD', state: 'ENABLED', kind: 'action' };
  model.note = input.error ?? (!fresh ? 'Showing the last read. Check the letter before claiming.'
   : message.expiresAt ? `Expires ${input.formatTime(message.expiresAt)}.` : null);
 }
 return model;
}
