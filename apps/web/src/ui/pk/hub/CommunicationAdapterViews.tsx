/** Lazy body adapters; the shared host and existing owners retain focus, sockets/polls and persistence. */
import { useId, type ReactNode, type Ref, type UIEventHandler } from 'react';
import type { ChatMessage } from '@shardkeep/shared';
import type { FeedbackSubmission } from '../../feedback/feedbackSubmission';
import { PkPrimaryButton, PkSecondaryButton, PkTag } from '../Button';
import { PkPlate } from '../Plate';
import { HubSheet, type HubAction, type HubIntent } from './HubSheets';
import { chatContentModel, feedbackContentModel, feedbackCategoryLabel, mentionSegments, type ChatContentInput, type FeedbackContentInput, type FeedbackCloseState } from './communicationAdapters';
import './CommunicationAdapters.css';
type Dispatch = (intent: HubIntent) => void;
function Action({ action, onIntent }: { action: HubAction; onIntent: Dispatch }) {
 return <PkPrimaryButton {...action} onClick={() => {
  if (action.state === 'BUSY') return;
  if (action.state !== 'ENABLED') { if (action.reason) onIntent({ id: action.id, kind: 'explain', reason: action.reason }); return; }
  onIntent({ id: action.id, kind: action.kind });
 }} />;
}
export interface ChatContentProps {
 input: ChatContentInput; onIntent: Dispatch; onDraft: (body: string) => void;
 logRef?: Ref<HTMLDivElement>; composerRef?: Ref<HTMLTextAreaElement>; onLogScroll?: UIEventHandler<HTMLDivElement>;
 /** Existing sanitized-avatar renderer; no raw URLs are mounted here. */
 authorArt?: (message: ChatMessage) => ReactNode;
}
export function ChatContentAdapter({ input, onIntent, onDraft, logRef, composerRef, onLogScroll, authorArt }: ChatContentProps) {
 const m = chatContentModel(input); const id = useId();
 const send = () => { if (m.send.state === 'ENABLED') onIntent({ id: 'chat.send', kind: 'action' }); };
 return <section className="pk-communication pk-chat-content" aria-label="Global chat content">
  <div className="pk-communication__toolbar"><h2>GLOBAL CHAT</h2>
   <PkSecondaryButton label={input.blocksOpen ? 'MESSAGES' : 'BLOCKED PLAYERS'} enabled={m.bound} onClick={() => onIntent({ id: input.blocksOpen ? 'chat.messages' : 'chat.blocks', kind: 'navigate' })} />
  </div>
  {!m.bound ? <p role="status">{m.reason}</p> : input.blocksOpen ? <section aria-label="Blocked players" className="pk-communication__stack">
   <p>Their messages are hidden. Unblocking restores future and available recent messages.</p>
   {input.blocksBusy ? <p role="status">LOADING BLOCKED PLAYERS…</p> : !m.blocks.length ? <p>NO BLOCKED PLAYERS</p> : null}
   {m.blocks.map(b => <PkPlate key={b.id} kind="CREAM" className="pk-hub-sheet__row"><strong>{b.author.name}</strong><PkSecondaryButton label={`UNBLOCK ${b.author.name}`} enabled={m.canModerate && !input.blocksBusy} onClick={() => onIntent({ id: `chat.unblock:${b.id}`, kind: 'action' })} /></PkPlate>)}
   {m.blocksNext ? <PkSecondaryButton label="MORE BLOCKED PLAYERS" enabled={!input.blocksBusy && input.fresh} onClick={() => onIntent({ id: 'chat.blocks.more', kind: 'recover' })} /> : null}
  </section> : <>
   <div ref={logRef} onScroll={onLogScroll} role="log" aria-label="Global chat messages" aria-live="polite" className="pk-communication__log copyable">
    {m.nextBefore ? <PkSecondaryButton label={input.loadingOlder ? 'LOADING OLDER…' : 'OLDER MESSAGES'} enabled={!input.loadingOlder && input.fresh} onClick={() => onIntent({ id: 'chat.older', kind: 'recover' })} /> : null}
    {!input.ready ? <p role="status">READING GLOBAL CHAT…</p> : !m.rows.length ? <p>NO MESSAGES YET</p> : null}
    {m.rows.map(({ message, delivery }) => <article key={message.id} className="pk-communication__message" aria-label={message.mentioned ? 'Message mentioning you' : undefined}>
     <div className="pk-communication__toolbar">{authorArt?.(message)}
      {message.canBlock && !delivery && m.canCompose ? <PkSecondaryButton label={`MENTION ${message.author.name}`} onClick={() => onIntent({ id: `chat.mention:${message.id}`, kind: 'action' })} /> : <strong>{message.author.name}</strong>}
      {message.author.seekerVerified ? <PkTag text="SEEKER VERIFIED" verb="STONE" /> : null}<time dateTime={message.createdAt}>{input.formatTime(message.createdAt)}</time>
     </div>
     {message.mentioned ? <p>@ YOU WERE MENTIONED</p> : null}
     <p className="pk-communication__body">{mentionSegments(message.text, message.mentions).map((part, i) => part.mention ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>)}</p>
     <div className="pk-communication__toolbar">
      {delivery === 'sending' ? <span role="status">SENDING…</span> : delivery === 'failed' ? <PkSecondaryButton label="RETRY MESSAGE" enabled={m.canCompose} onClick={() => onIntent({ id: `chat.retry:${message.clientMessageId}`, kind: 'action' })} /> : <>
       {m.reported.includes(message.id) ? <span>REPORTED</span> : <PkSecondaryButton label={`REPORT ${message.author.name}`} enabled={m.canModerate} onClick={() => onIntent({ id: `chat.report.open:${message.id}`, kind: 'navigate' })} />}
       {message.canBlock ? <PkSecondaryButton label={`BLOCK ${message.author.name}`} enabled={m.canModerate && !input.blocksBusy} onClick={() => onIntent({ id: `chat.block:${message.id}`, kind: 'action' })} /> : null}
      </>}
     </div>
     {!delivery && m.reporting === message.id ? <div role="group" aria-label="Report reason" className="pk-communication__toolbar">{input.reportReasons.map(r => <PkSecondaryButton key={r.id} label={r.label} enabled={m.canModerate} onClick={() => onIntent({ id: `chat.report:${message.id}:${r.id}`, kind: 'action' })} />)}<PkSecondaryButton label="CANCEL REPORT" onClick={() => onIntent({ id: 'chat.report.cancel', kind: 'navigate' })} /></div> : null}
    </article>)}
   </div>
   {m.newCount > 0 ? <PkSecondaryButton label={`${m.newCount} NEW MESSAGES`} onClick={() => onIntent({ id: 'chat.bottom', kind: 'navigate' })} /> : null}
   <label htmlFor={`${id}-message`}>GLOBAL CHAT MESSAGE</label>
   <textarea ref={composerRef} id={`${id}-message`} value={input.body} disabled={!m.canEdit} maxLength={input.limits.maxUtf8Bytes} aria-invalid={!!input.body && !input.draft.valid}
    onChange={e => { if (m.canEdit) onDraft(e.currentTarget.value); }} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
   <small>{input.draft.graphemes}/{input.limits.maxGraphemes} · {input.draft.lines}/{input.limits.maxLines} LINES · CTRL/⌘+ENTER SENDS</small>
   <Action action={m.send} onIntent={onIntent} />
  </>}
  {m.bound ? <p role="status">{m.notice || m.reason}</p> : null}
 </section>;
}
export interface FeedbackContentProps {
 input: FeedbackContentInput; onIntent: Dispatch;
 onDraft: (next: Partial<{ category: string; title: string; body: string; recurrence: boolean }>) => void;
 onRequestClose?: (state: FeedbackCloseState) => void;
 /** Owned existing components, already wired to the same wallet/controller. */
 suggestions?: ReactNode; savedImages?: ReactNode;
 screenshots?: (state: { disabled: boolean; missingImages: number; pending: FeedbackSubmission | null }) => ReactNode;
}
export function FeedbackContentAdapter({ input, onIntent, onDraft, onRequestClose, suggestions, screenshots, savedImages }: FeedbackContentProps) {
 const m = feedbackContentModel(input); const id = useId();
 const close = () => { if (onRequestClose) { onRequestClose(m.closeState); return; }
  onIntent({ id: 'feedback.close', kind: m.closeState === 'busy' ? 'explain' : m.closeState === 'dirty' ? 'confirm' : 'close', ...(m.closeState === 'busy' ? { reason: 'Wait for the current report operation.' } : {}) }); };
 return <HubSheet title="FEEDBACK" rows={[]} onIntent={onIntent} onClose={close} primary={m.send} hasData={m.bound}>
  {!m.bound ? <p>Sign in with the report wallet.</p> : <div className="pk-communication">
   <p>Only you and the support team can see your report, replies and screenshots. Points are awarded after review; submitting or replying does not automatically earn points.</p>
   <label htmlFor={`${id}-category`}>CATEGORY</label><select id={`${id}-category`} aria-label="Feedback category" value={m.category} disabled={!m.editable} onChange={e => { if (m.editable) onDraft({ category: e.currentTarget.value }); }}>
    {m.pending && !input.limits.categories.includes(m.category) ? <option value={m.category}>{feedbackCategoryLabel(m.category)} · SAVED</option> : null}
    {input.limits.categories.map(c => <option key={c} value={c}>{feedbackCategoryLabel(c)}</option>)}
   </select>
   {m.editable ? suggestions : null}
   {m.evidence ? <section aria-label="Private evidence"><p>PRIVATE EVIDENCE FOR: {m.evidence.title}</p><p>Evidence joins your existing private conversation when available. It earns no points automatically.</p>
    {m.recurrenceNeeded ? <label className="pk-communication__check"><input type="checkbox" checked={m.evidence.mode === 'recurrence'} disabled={!m.editable} onChange={e => { if (m.editable) onDraft({ recurrence: e.currentTarget.checked }); }} />THIS FIXED OR CLOSED ISSUE IS HAPPENING AGAIN — NEW RECURRENCE</label> : null}
    {m.editable ? <PkSecondaryButton label="REPORT A DIFFERENT PROBLEM" onClick={() => onIntent({ id: 'feedback.different', kind: 'navigate' })} /> : null}
   </section> : null}
   <label htmlFor={`${id}-title`}>TITLE</label><input id={`${id}-title`} value={m.title} disabled={!m.editable} maxLength={input.limits.titleMaxLen} onChange={e => { if (m.editable) onDraft({ title: e.currentTarget.value }); }} />
   <label htmlFor={`${id}-body`}>WHAT HAPPENED?</label><textarea id={`${id}-body`} value={m.body} disabled={!m.editable} maxLength={input.limits.bodyMaxLen} onChange={e => { if (m.editable) onDraft({ body: e.currentTarget.value }); }} />
   <small>{m.body.trim().length}/{input.limits.bodyMaxLen}</small>
   {savedImages}{screenshots?.({ disabled: !m.canPickImages, missingImages: m.missingImages, pending: m.pending })}
   {m.missingImages ? <div role="status"><p>{m.missingImages} LOCAL SCREENSHOTS NEED REATTACHING. SELECT THE ORIGINAL FILES IN THE SAME ORDER.</p><PkSecondaryButton label="CLEAR MISSING FILES" enabled={m.canClearMissing} onClick={() => onIntent({ id: 'feedback.clear-missing', kind: 'confirm' })} /></div> : null}
   {m.notice ? <p role="status">{m.notice}</p> : null}{m.pendingNote ? <p role="status">{m.pendingNote}</p> : null}
   <section aria-labelledby={`${id}-reports`} className="pk-communication__stack"><h2 id={`${id}-reports`}>MY REPORTS</h2>
    {m.listLoading ? <p role="status">LOADING REPORTS…</p> : null}
    {m.listError ? <div role="alert"><p>{m.listError}</p><PkSecondaryButton label="RETRY REPORTS" onClick={() => onIntent({ id: 'feedback.reports.refresh', kind: 'recover' })} /></div> : null}
    {m.hasReports && !m.reports.length ? <p>NOTHING SENT YET.</p> : null}
    {m.reports.map(r => <PkPlate kind="CREAM" key={r.id} className="pk-communication__report"><article><h3>{r.title}</h3><strong>{r.points} POINTS</strong>
     <p>{feedbackCategoryLabel(r.category)} · {r.fixedAt ? 'FIXED' : r.status.toUpperCase()}{r.importance ? ` · ${r.importance.toUpperCase()}` : ''} · {r.date}</p>
     <p className="pk-communication__body">{r.body}</p>{r.adminNote ? <p>TEAM: {r.adminNote}</p> : null}
     {r.unread ? <PkTag text="UNREAD TEAM UPDATES" verb="STONE" /> : null}{r.fixedRef ? <p>FIX REFERENCE: {r.fixedRef}</p> : null}
     <PkSecondaryButton label="OPEN REPORT" onClick={() => onIntent({ id: `feedback.open:${r.id}`, kind: 'navigate' })} />
    </article></PkPlate>)}
    {m.nextCursor ? <PkSecondaryButton label="LOAD MORE REPORTS" enabled={!m.listLoading} onClick={() => onIntent({ id: 'feedback.reports.more', kind: 'recover' })} /> : null}
   </section>
  </div>}
 </HubSheet>;
}
