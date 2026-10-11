/** Lazy content. Hosts inject one existing controller owner and current intent dispatch. */
import { useId } from 'react';
import { PkPlate } from '../Plate';
import { PkPrimaryButton, PkQuietButton, PkTag } from '../Button';
import { HubSheet, type HubAction, type HubSheetProps, type HubIntent } from './HubSheets';
import { questBoardModel, mailListModel, mailLetterModel, type QuestBoardInput, type MailListInput, type MailLetterInput, type MailCategory } from './rewardAdapters';
import './RewardAdapters.css';
type Host = Pick<HubSheetProps, 'onIntent' | 'onClose' | 'onHistory'>;
function Action({ action, onIntent }: { action: HubAction; onIntent: Host['onIntent'] }) {
 return <PkPrimaryButton {...action} onClick={() => {
  if (action.state === 'BUSY') return;
  if (action.state !== 'ENABLED') { if (action.reason) onIntent({ id: action.id, kind: 'explain', reason: action.reason }); return; }
  onIntent({ id: action.id, kind: action.kind });
 }} />;
}
export interface QuestBoardIntent extends HubIntent {
 questClaimAll?: { readonly wallet: string; readonly baseId: string | null; readonly questIds: readonly string[] };
 questRecovery?: { readonly wallet: string; readonly baseId: string | null };
}
export function QuestBoardAdapter({ input, ...host }: Omit<Host, 'onIntent'> & { input: QuestBoardInput; onIntent: (intent: QuestBoardIntent) => void }) {
 const model = questBoardModel(input); const id = useId();
 const reviewed = model.hasSnapshot && input.wallet ? Object.freeze({ wallet: input.wallet, baseId: input.baseId, questIds: Object.freeze([...model.claimableIds]) }) : null;
 const original = input.wallet && input.operation?.wallet === input.wallet ? Object.freeze({ wallet: input.wallet, baseId: input.operation.baseId }) : null;
 const onIntent: Host['onIntent'] = intent => {
  if (intent.id === 'quests.all' && intent.kind === 'action') { if (reviewed) host.onIntent({ ...intent, questClaimAll: reviewed }); return; }
  if (intent.id === 'quests.recover' && intent.kind === 'recover') { if (original) host.onIntent({ ...intent, questRecovery: original }); return; }
  host.onIntent(intent.kind === 'recover' && intent.id === 'QUESTS' ? { id: 'quests.refresh', kind: 'recover' } : intent);
 };
 return <HubSheet {...host} onIntent={onIntent} title="QUESTS" rows={[]} primary={model.primary} load={model.load} note={model.note} hasData={model.hasSnapshot}>
  {model.hasSnapshot ? <div className="pk-rewards">
   {model.groups.map(group => <section key={group.id} aria-labelledby={`${id}-${group.id}`}>
    <h2 id={`${id}-${group.id}`}>{group.title}</h2>
    <div className="pk-hub-sheet__rows">{group.rows.map(row => <PkPlate key={row.id} kind="CREAM" className={`pk-hub-sheet__row pk-rewards__quest${row.state === 'READY' ? ' pk-rewards__quest--ready' : ''}`}>
     <div className="pk-hub-sheet__copy"><h3>{row.title}</h3>
      {row.live ? <PkTag text="CURRENT STEP" verb="STONE" /> : null}
      {row.hint ? <p>{row.hint}</p> : null}
      {row.state !== 'DONE' && row.target !== null && row.target > 1 ? <div className="pk-rewards__progress">
       {row.progress !== null ? <progress max={row.target} value={Math.min(row.target, row.progress)} aria-label={`${row.title}: ${row.progress}/${row.target}`} /> : null}
       <span>{`${row.progress ?? '…'}/${row.target}`}</span>
      </div> : null}
     </div><strong aria-label={`${row.reward} SHARDS`}>{row.reward} SHARDS</strong>
     {row.state === 'DONE' ? <PkTag text="CLAIMED" verb="MOSS" /> : row.action ? <Action action={row.action} onIntent={onIntent} /> : null}
    </PkPlate>)}</div>
   </section>)}
   {model.groups.some(g => g.id === 'daily') ? <PkPlate kind="CREAM" className="pk-hub-sheet__row"><div className="pk-hub-sheet__copy"><h3>DAILY BONUS</h3><p>CLAIM ANY {model.bonus.at} · BONUS</p></div><strong>{model.bonus.amount} SHARDS</strong></PkPlate> : null}
  </div> : null}
 </HubSheet>;
}
export function MailListAdapter({ input, onCategory, ...host }: Host & { input: MailListInput; onCategory: (category: MailCategory) => void }) {
 const model = mailListModel(input);
 const onIntent: Host['onIntent'] = intent => host.onIntent(intent.kind === 'recover' && intent.id === 'MAIL' ? { id: 'mail.refresh', kind: 'recover' } : intent);
 return <HubSheet {...host} {...model} title="MAIL" tabs={['ALL', 'REWARDS', 'NEWS']} tab={input.category}
  onTab={tab => { if (tab === 'ALL' || tab === 'REWARDS' || tab === 'NEWS') onCategory(tab); }} onIntent={onIntent}>
  <div className="pk-rewards__mail-nav"><PkQuietButton label={input.archived ? 'INBOX' : 'ARCHIVE'} onParchment
   onClick={() => host.onIntent({ id: input.archived ? 'mail.inbox' : 'mail.archive-list', kind: 'navigate' })} /></div>
  {model.load === 'READY' && !model.rows.length ? <p>{model.primary?.id === 'mail.more' ? 'No matching letters on this page. LOAD MORE to check the next page.' : input.archived ? 'No archived letters here.' : 'No letters in this category.'}</p> : null}
 </HubSheet>;
}
export function MailLetterAdapter({ input, ...host }: Host & { input: MailLetterInput }) {
 const model = mailLetterModel(input);
 const onIntent: Host['onIntent'] = intent => host.onIntent(intent.kind === 'recover' && intent.id === 'LETTER' ? { id: input.messageId ? `mail.read:${input.messageId}` : 'mail.refresh', kind: 'recover' } : intent);
 return <HubSheet {...host} onIntent={onIntent} title="LETTER" rows={[]} primary={model.primary} load={model.load} note={model.note} hasData={model.message !== null}>
  {model.message ? <article className="pk-rewards">
   <PkQuietButton label="BACK TO MAIL" onParchment onClick={() => host.onIntent({ id: 'mail.inbox', kind: 'navigate' })} />
   <p>{model.metadata}</p><h2>{model.message.subject}</h2><p className="pk-rewards__body">{model.message.body}</p>
   {model.rewards.length ? <section aria-label="Attached rewards" className="pk-hub-sheet__rows">
    {model.rewards.map(row => <PkPlate key={row.id} kind="CREAM" className="pk-hub-sheet__row"><strong>{row.value}</strong>{row.tag ? <PkTag text={row.tag} verb="STONE" /> : null}</PkPlate>)}
   </section> : null}
   {model.state === 'CLAIMED' || model.state === 'EXPIRED' || (model.state === 'READ' && model.rewards.length > 0) ? <PkTag text={model.state} verb={model.state === 'CLAIMED' ? 'MOSS' : 'STONE'} /> : null}
   {model.primary?.id === `mail.claim:${input.messageId}` && model.message.attachments.some(a => a.kind !== 'KEEP')
    ? <p>Rewards go to {input.targetBaseLabel?.trim() || 'your selected kingdom'}.</p> : null}
   {model.archive ? <Action action={model.archive} onIntent={onIntent} /> : null}
  </article> : null}
 </HubSheet>;
}
