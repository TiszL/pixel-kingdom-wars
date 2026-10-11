import { CHAT, type ChatEvent, type ChatMessage, type ChatSendBlockedReason } from '@shardkeep/shared';
import { api, ApiError } from '../../lib/api';

const chatGraphemes = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

export interface ChatStatus {
  enabled: boolean;
  canSend: boolean;
  sendBlockedReason: ChatSendBlockedReason | null;
  mutedUntil: string | null;
  pollOpenMs: number;
  pollClosedMs: number;
  latestEventId: string;
}

export interface ChatHistory {
  /** The API is newest-first; the view reverses each page before merging. */
  messages: ChatMessage[];
  nextBefore: string | null;
}

export interface ChatEvents {
  /** Cursor order, oldest to newest. */
  events: ChatEvent[];
  nextAfter: string;
}

export type ChatReportReason =
  | 'spam' | 'harassment' | 'hate' | 'sexual' | 'personal_info' | 'other';

export interface ChatBlock {
  id: string;
  createdAt: string;
  author: ChatMessage['author'];
}
export interface ChatBlocks { blocks: ChatBlock[]; nextBefore: string | null }

export const chatApi = {
  status: (): Promise<ChatStatus> => api.get<ChatStatus>('/chat/status'),
  history: (before?: string | null): Promise<ChatHistory> => api.get<ChatHistory>(
    `/chat/messages?limit=${CHAT.pageSize}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
  ),
  events: (after: string): Promise<ChatEvents> => api.get<ChatEvents>(
    `/chat/events?after=${encodeURIComponent(after)}&limit=${CHAT.pageSize}`,
  ),
  send: (clientMessageId: string, text: string): Promise<ChatMessage> =>
    api.postRaw<ChatMessage>('/chat/messages', { clientMessageId, text }),
  report: (messageId: string, reason: ChatReportReason): Promise<void> =>
    api.postRaw<void>(`/chat/messages/${encodeURIComponent(messageId)}/report`, { reason }),
  blocks: (before?: string | null): Promise<ChatBlocks> => api.get<ChatBlocks>(
    `/chat/blocks?limit=${CHAT.pageSize}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
  ),
  block: (messageId: string): Promise<{ block: ChatBlock }> =>
    api.postRaw<{ block: ChatBlock }>(`/chat/messages/${encodeURIComponent(messageId)}/block`, {}),
  unblock: (blockId: string): Promise<void> =>
    api.del<void>(`/chat/blocks/${encodeURIComponent(blockId)}`),
};

/** Old/rolling APIs advertise chat by answering status. A 404 is capability
 * negative, not an error toast and never a reason to leave a dead launcher. */
export function chatUnavailable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.code === 'CHAT_DISABLED');
}

/** Only an ambiguous transport/server failure, or a cooldown that can expire,
 * keeps the exact optimistic UUID available for retry. A definite 4xx restores
 * the draft for editing instead of offering a retry that can never succeed. */
export function chatSendRetryable(error: unknown): boolean {
  return !(error instanceof ApiError)
    || error.status === 0
    || error.status >= 500
    || error.code === 'CHAT_RATE_LIMITED';
}

/** One in-flight request at a time. Await-before-schedule prevents overlap on a
 * slow cellular response; cancellation fences a late response after close. */
export function startChatPoller({
  poll, delayMs, active = () => document.visibilityState === 'visible' && navigator.onLine,
  onError = () => undefined,
}: {
  poll(isCurrent: () => boolean): Promise<void>;
  delayMs(): number;
  active?: () => boolean;
  onError?(error: unknown): void;
}): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let running = false;
  let wakeAfterRun = false;

  const schedule = (delay: number): void => {
    if (!live) return;
    timer = setTimeout(() => { void run(); }, delay);
  };
  const run = async (): Promise<void> => {
    if (!live) return;
    if (running) {
      wakeAfterRun = true;
      return;
    }
    if (!active()) {
      // Hidden/offline means fully paused — visibilitychange/online wakes it.
      // A 2s timer here was measurable battery churn with the phone locked.
      return;
    }
    running = true;
    try {
      await poll(() => live);
      if (live) failures = 0;
    } catch (error) {
      if (live) {
        failures++;
        onError(error);
      }
    }
    running = false;
    if (!live) return;
    if (wakeAfterRun && active()) {
      wakeAfterRun = false;
      void run();
      return;
    }
    wakeAfterRun = false;
    // A bounded exponential retry keeps a weak connection responsive without
    // turning an outage into a battery-draining hot loop.
    schedule(Math.min(delayMs() * (2 ** Math.min(failures, 3)), CHAT.pollClosedMs));
  };
  const resume = (): void => {
    if (!live || !active()) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    // Multiple resume signals commonly arrive together (online + visibility).
    // A settled first poll may finish between them, so coalesce within the task.
    if (running || wakeAfterRun) {
      wakeAfterRun = true;
      return;
    }
    wakeAfterRun = true;
    queueMicrotask(() => {
      if (!live || !wakeAfterRun || !active()) return;
      wakeAfterRun = false;
      void run();
    });
  };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('online', resume);
  void run();
  return () => {
    live = false;
    if (timer !== null) clearTimeout(timer);
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('online', resume);
  };
}

/** One-shot retry that consumes no timer/network while the page is hidden or
 * offline. Visibility/online resumes immediately; callers still own cleanup. */
export function scheduleChatRetry(callback: () => void, delay: number): () => void {
  let live = true;
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const dueAt = Date.now() + delay;
  const active = (): boolean => document.visibilityState === 'visible' && navigator.onLine;
  const cleanup = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    document.removeEventListener('visibilitychange', sync);
    window.removeEventListener('online', sync);
    window.removeEventListener('offline', sync);
  };
  const run = (): void => {
    timer = null;
    if (!live || fired || !active()) return;
    fired = true;
    cleanup();
    callback();
  };
  function sync(): void {
    if (!live || fired) return;
    if (!active()) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      return;
    }
    if (timer !== null) return;
    const remaining = Math.max(0, dueAt - Date.now());
    timer = setTimeout(run, remaining);
  }
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
  sync();
  return () => { live = false; cleanup(); };
}

export function mergeChatMessages(
  current: ChatMessage[], incoming: ChatMessage[], limit: number,
): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  const optimisticByClient = new Map(
    current.filter((message) => message.id.startsWith('pending:'))
      .map((message) => [message.clientMessageId, message.id]),
  );
  for (const message of incoming) {
    const pendingId = optimisticByClient.get(message.clientMessageId);
    if (pendingId) byId.delete(pendingId);
    byId.set(message.id, message);
  }
  return [...byId.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || compareDecimalId(a.id, b.id))
    .slice(-limit);
}

export function chatDraft(text: string): {
  text: string; graphemes: number; bytes: number; lines: number; valid: boolean;
} {
  const normalized = text.replace(/\r\n?/g, '\n');
  const graphemes = chatGraphemes
    ? [...chatGraphemes.segment(normalized)].length
    : Array.from(normalized).length;
  const bytes = new TextEncoder().encode(normalized).byteLength;
  const lines = normalized.split('\n').length;
  return {
    text: normalized,
    graphemes,
    bytes,
    lines,
    valid: normalized.trim().length > 0
      && graphemes <= CHAT.maxGraphemes
      && bytes <= CHAT.maxUtf8Bytes
      && lines <= CHAT.maxLines,
  };
}

function compareDecimalId(a: string, b: string): number {
  if (a.startsWith('pending:') || b.startsWith('pending:')) return a.localeCompare(b);
  try {
    const aa = BigInt(a);
    const bb = BigInt(b);
    return aa < bb ? -1 : aa > bb ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}
