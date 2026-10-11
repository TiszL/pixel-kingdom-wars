/** Wallet-private in-game mail and owner-only delivery console (M22). */
import { MAIL } from '@shardkeep/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useRecentAuth, type AdminMailRewardRecentAuthIntent,
} from '../../auth/useRecentAuth';
import { api, ApiError, idemKey } from '../../lib/api';
import { bus } from '../../lib/events';
import { reloadCurrentBaseSnapshot } from '../../state/baseSnapshot';
import { useApp } from '../../state/store';
import { Btn, COLORS as C, fmtN, ScrollPage } from '../primitives';
import { useIsAdmin } from './adminAccess';
import {
  adminRewardMailContentHash, mailRewardNeedsBase, parseAdminMailRewardDraft,
  type MailAttachment,
} from './mailModel';
import './mail.css';

export interface MailMessageDto {
  id: string;
  sender: 'system' | 'admin';
  kind: 'info' | 'reward';
  subject: string;
  body: string;
  attachments: MailAttachment[];
  rewardState: 'pending' | 'claimed' | 'expired' | null;
  claimBaseId: string | null;
  createdAt: string;
  expiresAt: string | null;
  readAt: string | null;
  archivedAt: string | null;
  claimedAt: string | null;
  expiredAt: string | null;
}

export interface MailStatusDto { total: number; unread: number; pendingRewards: number }
interface MailPageDto { messages: MailMessageDto[]; nextCursor: string | null }

function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError && cause.code === 'MAIL_DELIVERY_DISABLED') {
    return 'NEW MAIL DELIVERY IS TEMPORARILY PAUSED';
  }
  return (cause instanceof Error ? cause.message : 'MAIL ACTION FAILED').toUpperCase();
}

function when(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function rewardLabel(attachment: MailAttachment): string {
  if (attachment.kind === 'ITEM') return `${attachment.itemId.replaceAll('_', ' ').toUpperCase()} ×${attachment.qty}`;
  return `${fmtN(attachment.amount)} ${attachment.kind}`;
}

function replaceMessage(messages: MailMessageDto[], next: MailMessageDto): MailMessageDto[] {
  return messages.map((message) => message.id === next.id ? next : message);
}

function claimTargetBaseId(): string | null {
  const state = useApp.getState();
  const active = state.baseDirectory?.bases.filter((base) => base.status === 'active') ?? [];
  if (state.selectedBaseId && active.some((base) => base.id === state.selectedBaseId)) {
    return state.selectedBaseId;
  }
  if (active.length === 1) return active[0]!.id;
  return state.base?.baseId ?? null;
}

export default function MailScreen(): React.JSX.Element {
  const setScreen = useApp((state) => state.setScreen);
  const isAdmin = useIsAdmin();
  const [view, setView] = useState<'inbox' | 'archive' | 'send'>('inbox');
  const [messages, setMessages] = useState<MailMessageDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<MailMessageDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const archived = view === 'archive';
  const load = useCallback(async (append = false): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const cursor = append && nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : '';
      const page = await api.get<MailPageDto>(`/mail?archived=${archived ? 'true' : 'false'}${cursor}`);
      setMessages((current) => append ? [...current, ...page.messages] : page.messages);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [archived, nextCursor]);

  useEffect(() => {
    if (view === 'send') return;
    setSelected(null);
    setNextCursor(null);
    void load(false);
    // `load` includes the cursor needed only by the explicit LOAD MORE action;
    // changing a page cursor must not auto-fetch another page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const open = async (message: MailMessageDto): Promise<void> => {
    setError('');
    try {
      const next = message.readAt
        ? await api.get<MailMessageDto>(`/mail/${message.id}`)
        : await api.postRaw<MailMessageDto>(`/mail/${message.id}/read`, {});
      setSelected(next);
      setMessages((current) => replaceMessage(current, next));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const archive = async (): Promise<void> => {
    if (!selected) return;
    setLoading(true);
    try {
      await api.postRaw(`/mail/${selected.id}/archive`, {});
      setSelected(null);
      await load(false);
    } catch (cause) {
      setError(errorMessage(cause));
      setLoading(false);
    }
  };

  const claim = async (): Promise<void> => {
    if (!selected || selected.rewardState !== 'pending') return;
    const needsBase = mailRewardNeedsBase(selected);
    const baseId = needsBase ? claimTargetBaseId() : null;
    if (needsBase && !baseId) {
      bus.emit('ui:toast', { msg: 'SELECT THE BASE THAT SHOULD RECEIVE THIS REWARD' });
      setScreen('bases');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const next = await api.postRaw<MailMessageDto>(
        `/mail/${selected.id}/claim`, baseId ? { baseId } : {},
      );
      setSelected(next);
      setMessages((current) => replaceMessage(current, next));
      await reloadCurrentBaseSnapshot();
      bus.emit('base:refresh', undefined);
      bus.emit('ui:toast', { msg: 'MAIL REWARD CLAIMED' });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  const tabs = (
    <div className="mail-tabs">
      <Btn variant={view === 'inbox' ? 'gold' : 'ghost'} fontSize={17} onClick={() => setView('inbox')}>INBOX</Btn>
      <Btn variant={view === 'archive' ? 'gold' : 'ghost'} fontSize={17} onClick={() => setView('archive')}>ARCHIVE</Btn>
      {isAdmin && <Btn variant={view === 'send' ? 'gold' : 'ghost'} fontSize={17} onClick={() => setView('send')}>SEND</Btn>}
    </div>
  );

  return (
    <ScrollPage title="KEEP MAIL" onClose={() => setScreen('base')} tabs={tabs}>
      {view === 'send' ? <AdminMailComposer /> : selected ? (
        <MailDetail message={selected} loading={loading} error={error}
          onBack={() => setSelected(null)} onArchive={archive} onClaim={claim} />
      ) : (
        <MailList messages={messages} loading={loading} error={error} nextCursor={nextCursor}
          archived={archived} onOpen={(message) => void open(message)}
          onRetry={() => void load(false)} onMore={() => void load(true)} />
      )}
    </ScrollPage>
  );
}

function MailList({ messages, loading, error, nextCursor, archived, onOpen, onRetry, onMore }: {
  messages: MailMessageDto[]; loading: boolean; error: string; nextCursor: string | null;
  archived: boolean; onOpen: (message: MailMessageDto) => void; onRetry: () => void; onMore: () => void;
}): React.JSX.Element {
  return (
    <div className="mail-list">
      {error && <div className="mail-error" role="alert">{error}<Btn variant="sec" fontSize={16} onClick={onRetry}>RETRY</Btn></div>}
      {!loading && !error && messages.length === 0 && (
        <div className="mail-empty">{archived ? 'NO ARCHIVED MESSAGES' : 'YOUR INBOX IS CLEAR'}</div>
      )}
      {messages.map((message) => (
        <button className={`mail-row${message.readAt ? '' : ' unread'}`} type="button" key={message.id}
          onClick={() => onOpen(message)}>
          <span className="mail-row-mark">{message.kind === 'reward' ? '◆' : '▰'}</span>
          <span className="mail-row-copy">
            <span className="mail-row-title">{message.subject}</span>
            <span className="mail-row-meta">{message.sender.toUpperCase()} · {when(message.createdAt)}</span>
          </span>
          {message.rewardState === 'pending' && <span className="mail-pending">CLAIM</span>}
        </button>
      ))}
      {loading && <div className="mail-empty" role="status">LOADING MAIL…</div>}
      {!loading && nextCursor && <Btn variant="ghost" fontSize={17} onClick={onMore}>LOAD MORE</Btn>}
    </div>
  );
}

function MailDetail({ message, loading, error, onBack, onArchive, onClaim }: {
  message: MailMessageDto; loading: boolean; error: string;
  onBack: () => void; onArchive: () => void; onClaim: () => void;
}): React.JSX.Element {
  return (
    <article className="mail-detail">
      <Btn variant="ghost" fontSize={16} onClick={onBack}>‹ BACK TO MAIL</Btn>
      <header>
        <div className="mail-kicker">{message.sender.toUpperCase()} · {when(message.createdAt)}</div>
        <h2>{message.subject}</h2>
      </header>
      <div className="mail-body">{message.body}</div>
      {message.attachments.length > 0 && (
        <section className="mail-rewards" aria-label="Attached rewards">
          <div className="mail-kicker">ATTACHED REWARD</div>
          {message.attachments.map((attachment) => (
            <div className="mail-reward" key={attachment.kind === 'ITEM' ? `${attachment.kind}:${attachment.itemId}` : attachment.kind}>
              {rewardLabel(attachment)}
            </div>
          ))}
          <div className={`mail-state ${message.rewardState ?? ''}`}>
            {message.rewardState === 'pending' && message.expiresAt ? `EXPIRES ${when(message.expiresAt)}` :
              message.rewardState === 'claimed' ? `CLAIMED ${when(message.claimedAt)}` :
                message.rewardState === 'expired' ? `EXPIRED ${when(message.expiredAt)}` : ''}
          </div>
        </section>
      )}
      {error && <div className="mail-error" role="alert">{error}</div>}
      <div className="mail-actions">
        {message.rewardState === 'pending' && <Btn disabled={loading} onClick={onClaim}>CLAIM REWARD</Btn>}
        {!message.archivedAt && <Btn variant="sec" disabled={loading} onClick={onArchive}>ARCHIVE</Btn>}
      </div>
    </article>
  );
}

interface ComposeFields {
  recipientWallet: string;
  subject: string;
  body: string;
  keep: string;
  shards: string;
  itemId: string;
  qty: string;
}

const EMPTY_COMPOSE: ComposeFields = {
  recipientWallet: '', subject: '', body: '', keep: '', shards: '', itemId: '', qty: '',
};

function AdminMailComposer(): React.JSX.Element {
  const { prove } = useRecentAuth();
  const [broadcast, setBroadcast] = useState(false);
  const [fields, setFields] = useState<ComposeFields>(EMPTY_COMPOSE);
  const [deliveryKey, setDeliveryKey] = useState(() => idemKey());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const rewardDraft = useMemo(() => parseAdminMailRewardDraft(fields), [fields]);
  const attachments = rewardDraft.ok ? rewardDraft.attachments : [];
  const rewardDrafted = fields.keep !== '' || fields.shards !== '' || fields.itemId !== '' || fields.qty !== '';

  const set = (key: keyof ComposeFields, value: string): void => {
    setFields((current) => ({ ...current, [key]: value }));
  };

  const send = async (): Promise<void> => {
    setError('');
    const subject = fields.subject.trim();
    const body = fields.body.trim();
    if ((!broadcast && (fields.recipientWallet.length < 32 || fields.recipientWallet.length > 44))
      || !subject || [...subject].length > MAIL.subjectMaxChars
      || !body || [...body].length > MAIL.bodyMaxChars) {
      setError('CHECK THE RECIPIENT, SUBJECT, AND MESSAGE');
      return;
    }
    if (broadcast && rewardDrafted) {
      setError('BROADCAST MAIL CANNOT CONTAIN REWARDS');
      return;
    }
    if (!broadcast && !rewardDraft.ok) {
      setError(rewardDraft.error);
      return;
    }
    setPending(true);
    try {
      if (broadcast) {
        await api.postRaw('/admin/mail/broadcast', { idempotencyKey: deliveryKey, subject, body });
      } else {
        const request = {
          recipientWallet: fields.recipientWallet,
          idempotencyKey: deliveryKey,
          subject,
          body,
          ...(attachments.length > 0 ? { attachments } : {}),
        };
        if (attachments.length > 0) {
          const intent: AdminMailRewardRecentAuthIntent = {
            recipientWallet: fields.recipientWallet,
            idempotencyKey: deliveryKey,
            subject,
            attachments,
            contentHash: await adminRewardMailContentHash({ ...request, attachments }),
          };
          const grant = await prove('admin_mail_reward', intent);
          await api.postRecent('/admin/mail/send', request, grant);
        } else {
          await api.postRaw('/admin/mail/send', request);
        }
      }
      bus.emit('ui:toast', { msg: broadcast ? 'UPDATE DELIVERED TO ALL PLAYERS' : 'MAIL DELIVERED' });
      setFields(EMPTY_COMPOSE);
      setDeliveryKey(idemKey());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mail-compose">
      <div className="mail-compose-mode">
        <Btn variant={!broadcast ? 'gold' : 'ghost'} fontSize={17} onClick={() => setBroadcast(false)}>ONE PLAYER</Btn>
        <Btn variant={broadcast ? 'gold' : 'ghost'} fontSize={17} onClick={() => setBroadcast(true)}>ALL PLAYERS</Btn>
      </div>
      {!broadcast && <MailField label="RECIPIENT WALLET" value={fields.recipientWallet}
        onChange={(value) => set('recipientWallet', value)} maxLength={44} />}
      <MailField label={`SUBJECT · ${[...fields.subject].length}/${MAIL.subjectMaxChars}`} value={fields.subject}
        onChange={(value) => set('subject', value)} maxLength={MAIL.subjectMaxChars * 2} />
      <label className="mail-field">
        <span>MESSAGE · {[...fields.body].length}/{MAIL.bodyMaxChars}</span>
        <textarea value={fields.body} onChange={(event) => set('body', event.target.value)}
          maxLength={MAIL.bodyMaxChars * 2} rows={8} />
      </label>
      {!broadcast && (
        <fieldset className="mail-attachment-editor">
          <legend>OPTIONAL REWARD · MAX {MAIL.maxAttachments}</legend>
          <MailField label={`KEEP · MAX ${fmtN(MAIL.rewardKeepMax)}`} value={fields.keep}
            onChange={(value) => set('keep', value)} inputMode="numeric" />
          <MailField label={`SHARDS · MAX ${fmtN(MAIL.rewardShardsMax)}`} value={fields.shards}
            onChange={(value) => set('shards', value)} inputMode="numeric" />
          <label className="mail-field">
            <span>STACKABLE CONSUMABLE</span>
            <select value={fields.itemId} onChange={(event) => set('itemId', event.target.value)}>
              <option value="">NONE</option>
              {MAIL.approvedStackableConsumableIds.map((id) => (
                <option key={id} value={id}>{id.replaceAll('_', ' ').toUpperCase()}</option>
              ))}
            </select>
          </label>
          {fields.itemId && <MailField label={`QUANTITY · MAX ${MAIL.rewardConsumableQtyMax}`} value={fields.qty}
            onChange={(value) => set('qty', value)} inputMode="numeric" />}
        </fieldset>
      )}
      {error && <div className="mail-error" role="alert">{error}</div>}
      <Btn disabled={pending} onClick={() => void send()}>
        {pending ? 'CONFIRMING…' : broadcast ? 'SEND UPDATE TO ALL' : rewardDrafted ? 'SIGN & SEND REWARD' : 'SEND MESSAGE'}
      </Btn>
      <div className="mail-compose-note">
        Reward sends reserve currency immediately and require a wallet signature. Broadcasts are information-only.
      </div>
    </div>
  );
}

function MailField({ label, value, onChange, maxLength, inputMode }: {
  label: string; value: string; onChange: (value: string) => void;
  maxLength?: number; inputMode?: 'numeric';
}): React.JSX.Element {
  return (
    <label className="mail-field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)}
        {...(maxLength ? { maxLength } : {})} {...(inputMode ? { inputMode } : {})} />
    </label>
  );
}
