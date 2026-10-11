import { CHAT, type ChatEvent, type ChatMessage } from '@shardkeep/shared';
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
} from 'react';
import { API_URL, ApiError } from '../../lib/api';
import { useWindowSize } from '../layout';
import { Btn, COLORS as C, Icon } from '../primitives';
import { SeekerBadge } from '../screens/seeker';
import { useChatFrame } from './useChatFrame';
import {
  chatApi, chatSendRetryable, chatUnavailable, mergeChatMessages, startChatPoller,
  chatDraft, scheduleChatRetry, type ChatReportReason, type ChatStatus,
  type ChatBlock,
} from './protocol';

type Delivery = 'sending' | 'failed';

interface PendingMessage {
  message: ChatMessage;
  delivery?: Delivery;
}

const REPORT_REASONS: ReadonlyArray<{ id: ChatReportReason; label: string }> = [
  { id: 'spam', label: 'SPAM' },
  { id: 'harassment', label: 'HARASSMENT' },
  { id: 'hate', label: 'HATE' },
  { id: 'sexual', label: 'SEXUAL' },
  { id: 'personal_info', label: 'PERSONAL INFO' },
  { id: 'other', label: 'OTHER' },
];
const CHAT_CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export function chatAvatarUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const origin = typeof window === 'undefined' ? undefined : window.location.origin;
    // Public avatar DTOs use API-root paths (`/api/avatars/...`) in production.
    // A leading slash is already rooted and must not become `/api/api/...`.
    const base = new URL(`${API_URL.replace(/\/$/, '')}/`, origin);
    const url = raw.startsWith('/') ? new URL(raw, origin) : new URL(raw, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function initials(name: string): string {
  return Array.from(name.trim()).slice(0, 2).join('').toUpperCase() || '?';
}

function messageClock(raw: string): string {
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return '';
  return CHAT_CLOCK.format(date);
}

export function chatNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight < 56;
}

function applyEvents(current: ChatMessage[], events: ChatEvent[]): ChatMessage[] {
  let next = current;
  for (const event of events) {
    if (event.type === 'redaction') {
      next = next.filter((message) => message.id !== event.messageId);
    } else {
      next = mergeChatMessages(next, [event.message], CHAT.domMessageLimit);
    }
  }
  return next;
}

/** Only server-resolved spans receive mention styling; text remains inert. */
function MessageText({ message }: { message: ChatMessage }): React.JSX.Element {
  const parts: React.ReactNode[] = [];
  let end = 0;
  for (const span of message.mentions ?? []) {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end)
      || span.start < end || span.end <= span.start || span.end > message.text.length) continue;
    parts.push(message.text.slice(end, span.start));
    parts.push(<mark key={span.start} style={{ color: C.goldHi, background: 'rgba(227,174,60,.12)' }}>{message.text.slice(span.start, span.end)}</mark>);
    end = span.end;
  }
  parts.push(message.text.slice(end));
  return <>{parts}</>;
}

function blockedCopy(status: ChatStatus): string {
  if (status.canSend) return 'MESSAGE GLOBAL CHAT';
  if (status.sendBlockedReason === 'USERNAME_REQUIRED') return 'SET A USERNAME TO CHAT';
  if (status.sendBlockedReason === 'DEED_REQUIRED') return 'A DEED IS REQUIRED TO CHAT';
  if (status.sendBlockedReason === 'MUTED') return status.mutedUntil
    ? `MUTED UNTIL ${new Date(status.mutedUntil).toLocaleString()}`
    : 'CHAT MUTED';
  return 'READ ONLY';
}

export default function ChatScreen({
  initialStatus, initialCursor, onClose,
  ownerBridge,
}: {
  ownerBridge?: ChatOwnerBridge;
  initialStatus: ChatStatus;
  initialCursor: string;
  onClose(cursor: string, status: ChatStatus): void;
}): React.JSX.Element {
  const [status, setStatus] = useState(initialStatus);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<Map<string, PendingMessage>>(() => new Map());
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [body, setBody] = useState('');
  const [notice, setNotice] = useState('CONNECTING TO GLOBAL CHAT…');
  const [newCount, setNewCount] = useState(0);
  const [reporting, setReporting] = useState<string | null>(null);
  const [reported, setReported] = useState<Set<string>>(() => new Set());
  const [blocksOpen, setBlocksOpen] = useState(false);
  const [blocks, setBlocks] = useState<ChatBlock[]>([]);
  const [blocksNext, setBlocksNext] = useState<string | null>(null);
  const [blocksBusy, setBlocksBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [eventEpoch, setEventEpoch] = useState(0);
  const cursor = useRef(initialCursor);
  const eventFence = useRef(0);
  const eventsPaused = useRef(false);
  const statusRef = useRef(status);
  statusRef.current = status;
  const root = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const pinAfterRender = useRef(true);
  const olderScroll = useRef<{ height: number; top: number } | null>(null);

  const atBottom = useCallback((): boolean => {
    const el = log.current;
    return !el || chatNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
  }, []);
  const scrollBottom = useCallback((): void => {
    const el = log.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setNewCount(0);
  }, []);
  const sizeComposer = useCallback((): void => {
    const target = composer.current;
    if (!target) return;
    target.style.height = 'auto';
    target.style.height = `${Math.min(104, target.scrollHeight)}px`;
    target.style.overflowY = target.scrollHeight > 104 ? 'auto' : 'hidden';
  }, []);

  const close = useCallback(() => onClose(cursor.current, statusRef.current), [onClose]);

  // Desktop dock threshold — same breakpoint RaidUI uses for its desktop deck.
  // Below it (every phone, and the 915×311 Seeker webview via height) chat
  // stays the full-screen modal it shipped as.
  const { w: winW, h: winH } = useWindowSize();
  const frame = useChatFrame(winH);
  const dock = winW >= 900 && frame.height >= 600;

  useEffect(() => {
    if (!status.enabled) onClose(cursor.current, status);
  }, [onClose, status]);

  useEffect(() => startChatPoller({
    delayMs: () => status.pollClosedMs,
    poll: async (isCurrent) => {
      const fresh = await chatApi.status();
      if (isCurrent()) setStatus(fresh);
    },
  }), [status.pollClosedMs]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const focusable = (): HTMLElement[] => [...el.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((node) => !node.hidden);
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      // Tab stays trapped only in the mobile modal; the desktop dock is
      // non-modal, so Tab may leave it for the game chrome behind it.
      if (event.key !== 'Tab' || dock) return;
      const nodes = focusable();
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    el.addEventListener('keydown', key);
    requestAnimationFrame(() => {
      if (status.canSend) composer.current?.focus();
      else closeButton.current?.focus();
    });
    return () => el.removeEventListener('keydown', key);
  }, [close, status.canSend, dock]);

  useEffect(() => {
    let live = true;
    let cancelRetry: (() => void) | null = null;
    void chatApi.history().then((history) => {
      if (!live) return;
      setMessages([...history.messages].reverse().slice(-CHAT.domMessageLimit));
      setNextBefore(history.nextBefore);
      setNotice(history.messages.length ? '' : 'NO MESSAGES YET — START THE CONVERSATION');
      pinAfterRender.current = true;
      setReady(true);
    }).catch((error: unknown) => {
      if (!live) return;
      if (chatUnavailable(error)) {
        setNotice('GLOBAL CHAT IS NOT AVAILABLE');
        onClose(cursor.current, { ...statusRef.current, enabled: false });
      } else {
        setNotice('CHAT COULD NOT LOAD — RETRYING');
        cancelRetry = scheduleChatRetry(() => {
          if (live) setHistoryAttempt((attempt) => attempt + 1);
        }, status.pollOpenMs);
      }
    });
    return () => {
      live = false;
      cancelRetry?.();
    };
  }, [historyAttempt, onClose, status.pollOpenMs]);

  useEffect(() => {
    if (!ready) return;
    return startChatPoller({
    delayMs: () => status.pollOpenMs,
    poll: async (isCurrent) => {
      if (eventsPaused.current) return;
      const fence = eventFence.current;
      const wasPinned = atBottom();
      const page = await chatApi.events(cursor.current);
      if (!isCurrent() || eventsPaused.current || fence !== eventFence.current) return;
      cursor.current = page.nextAfter;
      if (page.events.length === 0) return;
      const added = page.events.filter((event) => event.type === 'message').length;
      pinAfterRender.current = wasPinned;
      if (!wasPinned && added > 0) setNewCount((count) => count + added);
      setMessages((current) => applyEvents(current, page.events));
      setPending((current) => {
        const next = new Map(current);
        for (const event of page.events) {
          if (event.type === 'message') next.delete(event.message.clientMessageId);
        }
        return next;
      });
      setNotice((current) => current === 'RECONNECTING…' ? '' : current);
    },
    onError: (error) => {
      if (chatUnavailable(error)) {
        onClose(cursor.current, { ...statusRef.current, enabled: false });
      } else {
        setNotice('RECONNECTING…');
      }
    },
    });
  }, [atBottom, eventEpoch, onClose, ready, status.pollOpenMs]);

  useLayoutEffect(() => {
    const el = log.current;
    if (!el) return;
    if (olderScroll.current) {
      const previous = olderScroll.current;
      olderScroll.current = null;
      el.scrollTop = previous.top + (el.scrollHeight - previous.height);
    } else if (pinAfterRender.current) {
      pinAfterRender.current = false;
      el.scrollTop = el.scrollHeight;
      setNewCount(0);
    }
  }, [messages, pending]);

  useLayoutEffect(sizeComposer, [body, sizeComposer]);

  const loadOlder = (): void => {
    if (!nextBefore || loadingOlder) return;
    const el = log.current;
    if (el) olderScroll.current = { height: el.scrollHeight, top: el.scrollTop };
    setLoadingOlder(true);
    const fence = eventFence.current;
    void chatApi.history(nextBefore).then((page) => {
      if (fence !== eventFence.current) { olderScroll.current = null; return; }
      setMessages((current) => {
        const byId = new Map<string, ChatMessage>();
        for (const message of [...page.messages].reverse()) byId.set(message.id, message);
        for (const message of current) byId.set(message.id, message);
        return [...byId.values()]
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(0, CHAT.domMessageLimit);
      });
      setNextBefore(page.nextBefore);
    }).catch(() => {
      if (fence === eventFence.current) setNotice('OLDER MESSAGES COULD NOT LOAD');
    }).finally(() => setLoadingOlder(false));
  };

  const send = (clientMessageId?: string): void => {
    const draft = chatDraft(clientMessageId ? pending.get(clientMessageId)?.message.text ?? '' : body);
    const text = draft.text.trim();
    if (!status.canSend || !draft.valid) return;
    const id = clientMessageId ?? crypto.randomUUID();
    if (!clientMessageId) {
      const optimistic: ChatMessage = {
        id: `pending:${id}`, clientMessageId: id, text,
        createdAt: new Date().toISOString(),
        author: { name: 'YOU', avatarUrl: null, seekerVerified: false },
        canBlock: false,
      };
      setBody('');
      pinAfterRender.current = true;
      setPending((current) => new Map(current).set(id, { message: optimistic, delivery: 'sending' }));
    } else {
      setPending((current) => {
        const next = new Map(current);
        const prior = next.get(id);
        if (prior) next.set(id, { ...prior, delivery: 'sending' });
        return next;
      });
    }
    void chatApi.send(id, text).then((canonical) => {
      pinAfterRender.current = atBottom();
      setMessages((current) => mergeChatMessages(current, [canonical], CHAT.domMessageLimit));
      setPending((current) => { const next = new Map(current); next.delete(id); return next; });
      setNotice('MESSAGE SENT');
    }).catch((error: unknown) => {
      const retryable = chatSendRetryable(error);
      setPending((current) => {
        const next = new Map(current);
        const prior = next.get(id);
        if (prior && retryable) next.set(id, { ...prior, delivery: 'failed' });
        else next.delete(id);
        return next;
      });
      if (retryable) {
        setNotice(error instanceof ApiError && error.code === 'CHAT_RATE_LIMITED'
          ? 'SLOW DOWN — MESSAGE KEPT FOR RETRY'
          : 'NOT SENT — TAP RETRY');
      } else {
        setBody((current) => current || text);
        setNotice(error instanceof ApiError && error.code === 'CHAT_TEXT_INVALID'
          ? 'MESSAGE NOT ALLOWED — EDIT AND TRY AGAIN'
          : 'MESSAGE REFUSED — EDIT AND TRY AGAIN');
      }
      if (error instanceof ApiError && [
        'CHAT_USERNAME_REQUIRED', 'CHAT_DEED_REQUIRED', 'CHAT_MUTED', 'CHAT_DISABLED',
      ].includes(error.code ?? '')) {
        void chatApi.status().then(setStatus).catch(() => undefined);
      }
    });
  };

  const mentionAuthor = (name: string): void => {
    if (!status.canSend) return;
    const start = composer.current?.selectionStart ?? body.length;
    const end = composer.current?.selectionEnd ?? start;
    const prefix = body.slice(0, start);
    const insert = `${prefix && !/\s$/.test(prefix) ? ' ' : ''}@${name} `;
    const next = prefix + insert + body.slice(end);
    if (!chatDraft(next).valid) { setNotice('MESSAGE IS FULL — MAKE ROOM FOR THE MENTION'); return; }
    setBody(next);
    requestAnimationFrame(() => {
      composer.current?.focus();
      composer.current?.setSelectionRange(start + insert.length, start + insert.length);
    });
  };

  const report = (messageId: string, reason: ChatReportReason): void => {
    void chatApi.report(messageId, reason).then(() => {
      setReported((current) => new Set(current).add(messageId));
      setReporting(null);
      setNotice('REPORT RECEIVED');
    }).catch((error: unknown) => {
      if (error instanceof ApiError && error.code === 'CHAT_ALREADY_REPORTED') {
        setReported((current) => new Set(current).add(messageId));
        setReporting(null);
        setNotice('ALREADY REPORTED');
      } else {
        setNotice('REPORT COULD NOT BE SENT');
      }
    });
  };

  const refreshFilteredHistory = (): void => {
    eventsPaused.current = true;
    eventFence.current++;
    const fence = eventFence.current;
    setEventEpoch((value) => value + 1);
    void chatApi.history().then((page) => {
      if (fence !== eventFence.current) return;
      setMessages([...page.messages].reverse().slice(-CHAT.domMessageLimit));
      setNextBefore(page.nextBefore);
    }).catch(() => {
      if (fence === eventFence.current) setNotice('CHAT COULD NOT REFRESH');
    }).finally(() => {
      if (fence !== eventFence.current) return;
      eventsPaused.current = false;
      eventFence.current++;
      setEventEpoch((value) => value + 1);
    });
  };
  const openBlocks = (): void => {
    setBlocksOpen(true); setBlocksBusy(true);
    void chatApi.blocks().then((page) => { setBlocks(page.blocks); setBlocksNext(page.nextBefore); })
      .catch(() => setNotice('BLOCKED PLAYERS COULD NOT LOAD'))
      .finally(() => setBlocksBusy(false));
  };
  const block = (messageId: string): void => {
    setBlocksBusy(true);
    void chatApi.block(messageId).then(({ block: added }) => {
      setBlocks((current) => [added, ...current.filter((item) => item.id !== added.id)]);
      setMessages((current) => current.filter((message) => message.id !== messageId));
      setReporting(null); setNotice(`${added.author.name} BLOCKED`);
      refreshFilteredHistory();
    }).catch((error: unknown) => {
      setNotice(error instanceof ApiError && error.code === 'CHAT_SELF_BLOCK'
        ? 'YOU CANNOT BLOCK YOURSELF' : 'PLAYER COULD NOT BE BLOCKED');
    }).finally(() => setBlocksBusy(false));
  };
  const unblock = (item: ChatBlock): void => {
    setBlocksBusy(true);
    void chatApi.unblock(item.id).then(() => {
      setBlocks((current) => current.filter((block) => block.id !== item.id));
      setNotice(`${item.author.name} UNBLOCKED`); refreshFilteredHistory();
    }).catch(() => setNotice('PLAYER COULD NOT BE UNBLOCKED'))
      .finally(() => setBlocksBusy(false));
  };

  const rows: PendingMessage[] = [
    ...messages.map((message) => ({ message })),
    ...pending.values(),
  ].sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt))
    .slice(-CHAT.domMessageLimit);
  const draft = chatDraft(body);

  // Additive export only. Every existing state/effect/request/UI statement below is retained.
  const ownerBirth = useRef(ownerBridge ? { wallet: ownerBridge.wallet, sessionKey: ownerBridge.sessionKey } : null);
  const ownerAlive = useRef(false);
  const ownerCommit = useRef<{ bridge: ChatOwnerBridge; view: ChatOwnerProjection } | null>(null);
  const readOwner = useCallback((): ChatOwnerProjection | null => {
    const committed = ownerCommit.current; const birth = ownerBirth.current;
    if (!ownerAlive.current || !committed || !birth || committed.bridge.wallet !== birth.wallet
      || committed.bridge.sessionKey !== birth.sessionKey) return null;
    try { return committed.bridge.isCurrent() === true ? committed.view : null; } catch { return null; }
  }, []);
  // Capture the existing inline handler unchanged; no second pagination request implementation.
  let ownerMoreBlocks: (() => void) | null = null;
  const exposeOwnerMoreBlocks = (handler: () => void): (() => void) => { ownerMoreBlocks = handler; return handler; };
  useLayoutEffect(() => {
    if (!ownerBridge) { ownerCommit.current = null; return; }
    const invoke = (callback: () => void): boolean => {
      if (readOwner() !== view) return false;
      callback(); return true;
    };
    // One committed view cannot enqueue the same mutation twice before React commits.
    // Block-list operations share a slot because all set the same legacy busy state.
    const used = new Set<string>();
    const once = (key: string, enabled: boolean, callback: () => void): boolean => {
      if (!enabled || used.has(key)) return false;
      return invoke(() => { used.add(key); callback(); });
    };
    const renderedSettledMessage = (id: string): ChatMessage | undefined => {
      if (blocksOpen || !rows.some(row => row.message.id === id && !row.delivery)) return undefined;
      return messages.find(message => message.id === id);
    };
    const view: ChatOwnerProjection = Object.freeze({
      wallet: ownerBridge.wallet, sessionKey: ownerBridge.sessionKey,
      data: chatOwnerCopy({ status, rows, blocks, nextBefore, blocksNext, newCount, reported: [...reported], reporting,
        body, draft, ready, loadingOlder, blocksBusy, blocksOpen, notice, limits: CHAT, reportReasons: REPORT_REASONS, dock, frame }),
      refs: Object.freeze({ root, closeButton, log, composer }),
      actions: Object.freeze({
        setBody: (value: string) => status.canSend && invoke(() => setBody(value)),
        send: (originalClientMessageId?: string) => once('send', status.canSend
          && (originalClientMessageId === undefined || pending.get(originalClientMessageId)?.delivery === 'failed')
          && chatDraft(originalClientMessageId ? pending.get(originalClientMessageId)?.message.text ?? '' : body).valid,
          () => send(originalClientMessageId)),
        loadOlder: () => once('history', !!nextBefore && !loadingOlder, loadOlder), scrollBottom: () => invoke(scrollBottom),
        mentionAuthor: (name: string) => status.canSend && invoke(() => mentionAuthor(name)),
        setReporting: (id: string | null) => invoke(() => setReporting(id)),
        report: (id: string, reason: ChatReportReason) => once('report', !!renderedSettledMessage(id)
          && reporting === id && !reported.has(id), () => report(id, reason)),
        openBlocks: () => once('blocks', !blocksOpen, openBlocks), showMessages: () => invoke(() => setBlocksOpen(false)),
        block: (id: string) => once('blocks', !blocksBusy && renderedSettledMessage(id)?.canBlock === true, () => block(id)),
        unblock: (id: string) => { const item = blocks.find(b => b.id === id); return item ? once('blocks', !blocksBusy, () => unblock(item)) : false; },
        moreBlocks: () => ownerMoreBlocks ? once('blocks', !blocksBusy, ownerMoreBlocks) : false,
        close: () => invoke(close),
      }),
    });
    ownerCommit.current = { bridge: ownerBridge, view };
    return () => { if (ownerCommit.current?.view === view) ownerCommit.current = null; };
  });
  useLayoutEffect(() => {
    if (!ownerBridge) return;
    ownerAlive.current = true;
    let release: (() => void) | undefined;
    try { release = ownerBridge.attach(readOwner); } catch { ownerAlive.current = false; }
    return () => { ownerAlive.current = false; ownerCommit.current = null; release?.(); };
  }, [ownerBridge?.attach, ownerBridge?.wallet, ownerBridge?.sessionKey, readOwner]);


  return (
    <div
      ref={root}
      className="interactive"
      role="dialog"
      // The dock is deliberately NON-modal (M23 a5): on a desktop the game
      // stays visible and playable beside the conversation, so trapping focus
      // or claiming aria-modal would lie to assistive tech. Mobile keeps the
      // full-viewport modal dialog and its on-screen-keyboard tracking.
      aria-modal={dock ? undefined : 'true'}
      aria-labelledby="global-chat-title"
      style={{
        position: 'fixed', zIndex: 3000,
        boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
        background: C.bg, color: C.text,
        ...(dock
          ? {
              right: 12, top: frame.top + frame.height - Math.min(560, frame.height - 24) - 12, width: 380,
              height: Math.min(560, frame.height - 24),
              border: `2px solid ${C.borderLt}`, outline: `2px solid ${C.ink}`,
              boxShadow: `6px 6px 0 ${C.ink}`,
            }
          : {
              left: 0, right: 0,
              top: frame.top, height: frame.height,
              padding: 'env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left)',
            }),
      }}>
      {/* Panel9's corner rivets, dock only — the docked panel is game chrome
          like every other Panel9; the mobile full screen (a ScrollPage-like
          surface) stays rivet-free, matching ScrollPage. Header padding is 14px
          (Phead's) so neither 44px corner control sits under a rivet. */}
      {dock && (
        <>
          <span aria-hidden="true" style={{ position: 'absolute', top: 6, left: 6, width: 6, height: 6, background: C.gold, zIndex: 1 }} />
          <span aria-hidden="true" style={{ position: 'absolute', top: 6, right: 6, width: 6, height: 6, background: C.gold, zIndex: 1 }} />
        </>
      )}
      <header style={{
        minHeight: 56, flex: 'none', display: 'flex', alignItems: 'center', gap: 10,
        padding: '6px 14px', boxSizing: 'border-box', background: C.ink,
        borderBottom: `2px solid ${C.borderLt}`,
      }}>
        <button ref={closeButton} type="button" aria-label="Close global chat" onClick={close} style={{
          width: 44, height: 44, flex: 'none', display: 'grid', placeItems: 'center', padding: 0,
          background: C.card, border: `2px solid ${C.borderLt}`, cursor: 'pointer',
          boxShadow: 'inset 0 2px 0 rgba(244,215,123,.12), inset 0 -3px 0 rgba(0,0,0,.5)',
        }}><Icon name="close" size={22} /></button>
        <div style={{ minWidth: 0, flex: 1, textAlign: 'center' }}>
          <div id="global-chat-title" style={{ color: C.gold, fontSize: 23, letterSpacing: '2px', whiteSpace: 'nowrap' }}>GLOBAL CHAT</div>
          <div style={{ color: C.textFaint, fontSize: 14, letterSpacing: '1px' }}>ALL ACTIVE KEEPERS</div>
        </div>
        <button type="button" aria-expanded={blocksOpen} onClick={blocksOpen ? () => setBlocksOpen(false) : openBlocks}
          style={{ flex: 'none', minHeight: 44, padding: '4px 9px', letterSpacing: '1px',
            color: blocksOpen ? C.goldHi : C.textDim, background: C.card,
            border: `2px solid ${blocksOpen ? C.goldDp : C.border}`, cursor: 'pointer',
            boxShadow: 'inset 0 2px 0 rgba(244,215,123,.08), inset 0 -3px 0 rgba(0,0,0,.5)',
            fontFamily: 'inherit', fontSize: 13 }}>
          {blocksOpen ? 'MESSAGES' : 'BLOCKED'}
        </button>
      </header>

      {blocksOpen ? (
        <section aria-label="Blocked players" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 }}>
          <h2 style={{ color: C.gold, fontSize: 19, letterSpacing: '2px', fontWeight: 400, margin: '2px 0 4px' }}>BLOCKED PLAYERS</h2>
          <p style={{ color: C.textFaint, fontSize: 15, lineHeight: 1.25, marginTop: 0 }}>Their messages are hidden. Unblocking restores future and available recent messages.</p>
          {blocksBusy && blocks.length === 0 && <div role="status" style={{ color: C.textFaint, textAlign: 'center', padding: '18px 0' }}>LOADING…</div>}
          {!blocksBusy && blocks.length === 0 && <div style={{ color: C.textFaint, textAlign: 'center', padding: '18px 0' }}>NO BLOCKED PLAYERS</div>}
          {blocks.map((item) => (
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 56,
              background: C.card, border: `2px solid ${C.border}`, padding: '4px 6px 4px 10px', marginBottom: 8,
              boxShadow: 'inset 0 1px 0 rgba(244,215,123,.07), inset 0 -3px 0 rgba(0,0,0,.4)' }}>
              <span style={{ overflowWrap: 'anywhere' }}>{item.author.name}</span>
              <button type="button" disabled={blocksBusy} aria-label={`Unblock ${item.author.name}`} onClick={() => unblock(item)}
                style={{ marginLeft: 'auto', minHeight: 44, padding: '5px 10px', color: C.goldHi, letterSpacing: '1px',
                  background: C.card, border: `2px solid ${C.borderLt}`, fontFamily: 'inherit', cursor: 'pointer',
                  boxShadow: 'inset 0 2px 0 rgba(244,215,123,.1), inset 0 -3px 0 rgba(0,0,0,.5)' }}>UNBLOCK</button>
            </div>
          ))}
          {blocksNext && <button type="button" disabled={blocksBusy} onClick={exposeOwnerMoreBlocks(() => {
            setBlocksBusy(true); void chatApi.blocks(blocksNext).then((page) => {
              setBlocks((current) => [...current, ...page.blocks]); setBlocksNext(page.nextBefore);
            }).catch(() => setNotice('MORE BLOCKED PLAYERS COULD NOT LOAD')).finally(() => setBlocksBusy(false));
          })} style={{ display: 'block', minHeight: 44, margin: '10px auto', padding: '5px 14px', color: C.text,
            background: C.card, border: `2px solid ${C.borderLt}`, fontFamily: 'inherit', letterSpacing: '1px', cursor: 'pointer',
            boxShadow: 'inset 0 2px 0 rgba(244,215,123,.08), inset 0 -3px 0 rgba(0,0,0,.5)' }}>LOAD MORE</button>}
        </section>
      ) : (

      <div
        ref={log}
        role="log"
        // Player-authored text stays copyable under the global a3
        // user-select:none rule — chat is data, not chrome.
        className="copyable"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Global chat messages"
        onScroll={() => { if (atBottom()) setNewCount(0); }}
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch', padding: '10px clamp(8px, 3vw, 18px)',
          contentVisibility: 'auto',
        }}>
        {nextBefore && (
          <button type="button" disabled={loadingOlder} onClick={loadOlder} style={{
            display: 'block', minHeight: 44, margin: '0 auto 10px', padding: '7px 14px',
            color: C.textDim, background: C.card, border: `2px solid ${C.border}`,
            fontFamily: 'inherit', fontSize: 16, letterSpacing: '1px', cursor: 'pointer',
            boxShadow: 'inset 0 2px 0 rgba(244,215,123,.08), inset 0 -3px 0 rgba(0,0,0,.5)',
          }}>{loadingOlder ? 'LOADING…' : 'LOAD EARLIER'}</button>
        )}
        {rows.map(({ message, delivery }) => {
          // The server stamps canBlock=false exactly when the author wallet is
          // the viewer's own (chat/service.ts), and the optimistic pending rows
          // are ours by construction — so !canBlock IS the "own message" bit.
          // Own rows carry the gold rail + tint; the accent is styling only.
          const own = !message.canBlock;
          return (
          <article key={message.id} aria-label={message.mentioned ? 'Message mentioning you' : undefined} style={{
            display: 'grid', gridTemplateColumns: '42px minmax(0, 1fr)', gap: 9,
            padding: own ? '8px 0 8px 8px' : '8px 0', borderBottom: `1px solid ${C.border}`,
            opacity: delivery === 'sending' ? 0.72 : 1,
            ...((own || message.mentioned) && {
              background: 'linear-gradient(90deg, rgba(227,174,60,.08), rgba(227,174,60,0) 72%)',
              boxShadow: `inset 2px 0 0 ${C.goldDp}`,
            }),
          }}>
            <div style={{
              position: 'relative', width: 40, height: 40, overflow: 'hidden', display: 'grid', placeItems: 'center',
              color: C.goldHi, background: C.panel, border: `2px solid ${own ? C.goldDp : C.ink}`, fontSize: 18,
              boxShadow: 'inset 0 2px 0 rgba(244,215,123,.14), inset 0 -2px 0 rgba(0,0,0,.5)',
            }}>
              {initials(message.author.name)}
              {chatAvatarUrl(message.author.avatarUrl) && (
                <img key={chatAvatarUrl(message.author.avatarUrl)!} src={chatAvatarUrl(message.author.avatarUrl)!} alt="" width={40} height={40}
                  onError={(event) => { event.currentTarget.hidden = true; }}
                  onLoad={(event) => { event.currentTarget.hidden = false; }}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'auto' }} />
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                {message.author.seekerVerified && <SeekerBadge />}
                {!own && status.canSend ? <button type="button" aria-label={`Mention ${message.author.name}`}
                  onClick={() => mentionAuthor(message.author.name)} style={{ minHeight: 44, padding: '2px 0',
                    color: C.textDim, background: 'transparent', border: 0, font: 'inherit',
                    letterSpacing: '1px', overflowWrap: 'anywhere', textAlign: 'left', cursor: 'pointer' }}>{message.author.name}</button>
                  : <strong style={{ color: own ? C.goldHi : C.textDim, fontWeight: 400, letterSpacing: '1px', overflowWrap: 'anywhere' }}>{message.author.name}</strong>}
                <time dateTime={message.createdAt} style={{ marginLeft: 'auto', color: C.textFaint, fontSize: 13 }}>
                  {messageClock(message.createdAt)}
                </time>
              </div>
              {message.mentioned && <div style={{ color: C.goldHi, fontSize: 13 }}>@ YOU WERE MENTIONED</div>}
              <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.15 }}><MessageText message={message} /></div>
              <div style={{ minHeight: 24, display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                {delivery === 'failed' ? (
                  <button type="button" onClick={() => send(message.clientMessageId)} style={{
                    minHeight: 44, padding: '2px 10px', fontFamily: 'inherit', fontSize: 14,
                    letterSpacing: '1px', cursor: 'pointer',
                    color: C.goldHi, background: C.card, border: `2px solid ${C.danger}`,
                    boxShadow: 'inset 0 2px 0 rgba(244,215,123,.1), inset 0 -3px 0 rgba(0,0,0,.5)',
                  }}>RETRY</button>
                ) : delivery === 'sending' ? (
                  <span role="status" style={{ color: C.textFaint, fontSize: 13 }}>SENDING…</span>
                ) : (
                  <>
                    {reported.has(message.id) ? <span style={{ color: C.textFaint, fontSize: 13 }}>REPORTED</span> :
                    <button type="button" aria-label={`Report message from ${message.author.name}`}
                      onClick={() => setReporting(reporting === message.id ? null : message.id)} style={{
                        minHeight: 44, padding: '2px 8px', fontFamily: 'inherit', fontSize: 13, letterSpacing: '1px',
                        color: C.textFaint, background: 'transparent', border: `2px solid ${C.border}`, cursor: 'pointer',
                      }}>REPORT</button>}
                    {message.canBlock && <button type="button" disabled={blocksBusy}
                      aria-label={`Block ${message.author.name}`} onClick={() => block(message.id)} style={{ minHeight: 44,
                        padding: '2px 8px', fontFamily: 'inherit', fontSize: 13, letterSpacing: '1px', color: C.danger,
                        background: 'transparent', border: `2px solid ${C.border}`, cursor: 'pointer' }}>BLOCK</button>}
                  </>
                )}
              </div>
              {reporting === message.id && (
                <div role="group" aria-label="Report reason" style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '5px 0' }}>
                  {REPORT_REASONS.map((reason) => (
                    <button key={reason.id} type="button" onClick={() => report(message.id, reason.id)} style={{
                      minHeight: 44, padding: '5px 10px', fontFamily: 'inherit', fontSize: 14, letterSpacing: '1px',
                      color: C.ink, background: C.textFaint, border: `2px solid ${C.ink}`, cursor: 'pointer',
                      boxShadow: `inset 0 3px 0 ${C.textDim}, inset 0 -4px 0 ${C.stoneDark}`,
                    }}>{reason.label}</button>
                  ))}
                </div>
              )}
            </div>
          </article>
          );
        })}
        {notice && rows.length === 0 && <p role="status" style={{ color: C.textFaint, textAlign: 'center' }}>{notice}</p>}
      </div>
      )}

      {!blocksOpen && newCount > 0 && (
        <button type="button" onClick={scrollBottom} style={{
          position: 'absolute', left: '50%', bottom: 90, transform: 'translateX(-50%)',
          minHeight: 44, padding: '7px 14px', color: C.ink, background: C.gold,
          border: `2px solid ${C.ink}`, cursor: 'pointer',
          boxShadow: `inset 0 3px 0 ${C.goldHi}, inset 0 -4px 0 ${C.goldDp}`,
          fontFamily: 'inherit', fontSize: 16, letterSpacing: '1px',
        }}>{newCount} NEW ↓</button>
      )}

      {!blocksOpen && <footer style={{
        flex: 'none', background: C.surface, borderTop: `2px solid ${C.borderLt}`,
        padding: '8px 10px max(8px, env(safe-area-inset-bottom))',
      }}>
        <div role="status" aria-live="polite" style={{ minHeight: 17, color: C.textFaint, fontSize: 13, marginBottom: 4 }}>
          {notice || blockedCopy(status)}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 7 }}>
          <textarea
            ref={composer}
            value={body}
            disabled={!status.canSend}
            rows={1}
            maxLength={CHAT.maxUtf8Bytes}
            aria-label="Global chat message"
            aria-invalid={body.length > 0 && !draft.valid}
            placeholder={blockedCopy(status)}
            onChange={(event) => setBody(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault(); send();
              }
            }}
            style={{
              minWidth: 0, flex: 1, minHeight: 44, maxHeight: 104, resize: 'none', boxSizing: 'border-box',
              padding: '9px 10px', color: C.text, background: C.bg, border: `2px solid ${C.border}`,
              borderRadius: 0, font: 'inherit', fontSize: 18, lineHeight: 1.15,
              boxShadow: 'inset 0 2px 0 rgba(0,0,0,.55)',
            }} />
          <Btn fontSize={16} disabled={!status.canSend || !draft.valid} onClick={() => send()}
            style={{ minWidth: 68, minHeight: 44, padding: '7px 10px' }}>SEND</Btn>
        </div>
        <div style={{ color: C.textFaint, fontSize: 12, textAlign: 'right', marginTop: 3 }}>
          <span style={{ color: draft.valid || body.length === 0 ? C.textFaint : C.danger }}>
            {draft.graphemes}/{CHAT.maxGraphemes} · {draft.lines}/{CHAT.maxLines} LINES
          </span> · CTRL/⌘+ENTER SENDS
        </div>
      </footer>}
    </div>
  );
}


/** Optional same-instance observation bridge. It does not replace the existing chat owner or UI.
 * F2ab must key this owner by authenticated wallet/session and unmount it on lease loss.
 * isCurrent is a synchronous, side-effect-free host lease read; a throw means no projection.
 * Returned action booleans mean original callback invoked, not server permission/success.
 */
export type ChatOwnerReadonly<T> = T extends readonly (infer U)[] ? readonly ChatOwnerReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: ChatOwnerReadonly<T[K]> } : T;
export interface ChatOwnerProjection {
  readonly wallet: string;
  readonly sessionKey: string;
  readonly data: ChatOwnerReadonly<{
    status: ChatStatus; rows: PendingMessage[]; blocks: ChatBlock[];
    nextBefore: string | null; blocksNext: string | null; newCount: number;
    reported: string[]; reporting: string | null; body: string; draft: ReturnType<typeof chatDraft>;
    ready: boolean; loadingOlder: boolean; blocksBusy: boolean; blocksOpen: boolean; notice: string;
    limits: typeof CHAT; reportReasons: typeof REPORT_REASONS; dock: boolean; frame: ReturnType<typeof useChatFrame>;
  }>;
  /** Original refs: attach only to the one existing host/composer/log; never a second mounted body. */
  readonly refs: { readonly root: { current: HTMLDivElement | null }; readonly closeButton: { current: HTMLButtonElement | null };
    readonly log: { current: HTMLDivElement | null }; readonly composer: { current: HTMLTextAreaElement | null } };
  readonly actions: {
    setBody(value: string): boolean; send(originalClientMessageId?: string): boolean;
    loadOlder(): boolean; scrollBottom(): boolean; mentionAuthor(name: string): boolean;
    setReporting(id: string | null): boolean; report(id: string, reason: ChatReportReason): boolean;
    openBlocks(): boolean; showMessages(): boolean; block(id: string): boolean; unblock(id: string): boolean;
    moreBlocks(): boolean; close(): boolean;
  };
}
export interface ChatOwnerBridge {
  readonly wallet: string; readonly sessionKey: string;
  isCurrent(): boolean;
  /** Called at commit. Return cleanup for this attachment only, not for a newer attachment. */
  attach(readCurrent: () => ChatOwnerProjection | null): () => void;
}
function chatOwnerCopy<T>(value: T): ChatOwnerReadonly<T> {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy); return copy as ChatOwnerReadonly<T>;
}
export { REPORT_REASONS };
