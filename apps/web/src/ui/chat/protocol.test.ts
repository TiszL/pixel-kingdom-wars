/** @vitest-environment happy-dom */
import { CHAT, type ChatMessage } from '@shardkeep/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import {
  chatDraft, chatSendRetryable, chatUnavailable, mergeChatMessages, startChatPoller,
  scheduleChatRetry,
} from './protocol';

const message = (id: string, clientMessageId = `client-${id}`): ChatMessage => ({
  id, clientMessageId, text: `message ${id}`, createdAt: `2026-08-13T00:00:${id.padStart(2, '0')}.000Z`,
  author: { name: 'KEEPER', avatarUrl: null, seekerVerified: false },
  canBlock: true,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('global chat protocol', () => {
  it('treats an old 404 API and an explicitly disabled API as capability-negative', () => {
    expect(chatUnavailable(new ApiError(404, 'missing'))).toBe(true);
    expect(chatUnavailable(new ApiError(503, 'off', 'CHAT_DISABLED'))).toBe(true);
    expect(chatUnavailable(new ApiError(503, 'down'))).toBe(false);
  });

  it('retries only ambiguous sends and an expiring server cooldown', () => {
    expect(chatSendRetryable(new ApiError(0, 'offline'))).toBe(true);
    expect(chatSendRetryable(new ApiError(503, 'down'))).toBe(true);
    expect(chatSendRetryable(new ApiError(429, 'slow', 'CHAT_RATE_LIMITED'))).toBe(true);
    expect(chatSendRetryable(new ApiError(400, 'invalid', 'CHAT_TEXT_INVALID'))).toBe(false);
    expect(chatSendRetryable(new ApiError(403, 'deed', 'CHAT_DEED_REQUIRED'))).toBe(false);
  });

  it('never overlaps a slow poll and fences its late completion after cleanup', async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const current: { read: () => boolean } = { read: () => false };
    let inFlight = 0;
    let peak = 0;
    let committed = 0;
    const poll = vi.fn((isCurrent: () => boolean) => {
      current.read = isCurrent;
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise<void>((done) => {
        resolve = () => {
          inFlight--;
          if (isCurrent()) committed++;
          done();
        };
      });
    });
    const stop = startChatPoller({ poll, delayMs: () => CHAT.pollOpenMs, active: () => true });
    await Promise.resolve();
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(CHAT.pollOpenMs * 2);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(peak).toBe(1);
    expect(current.read()).toBe(true);

    stop();
    expect(current.read()).toBe(false);
    resolve();
    await Promise.resolve();
    await vi.runAllTimersAsync();
    expect(committed).toBe(0);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('does not publish a late failure after cleanup', async () => {
    let reject!: (error: Error) => void;
    const onError = vi.fn();
    const stop = startChatPoller({
      poll: async () => new Promise<void>((_resolve, fail) => { reject = fail; }),
      delayMs: () => CHAT.pollOpenMs,
      active: () => true,
      onError,
    });
    await Promise.resolve();
    stop();
    reject(new Error('late outage'));
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
  });

  it('fully pauses while hidden/offline and resumes exactly once', async () => {
    vi.useFakeTimers();
    let active = false;
    const poll = vi.fn(async () => undefined);
    const stop = startChatPoller({ poll, delayMs: () => CHAT.pollOpenMs, active: () => active });
    await vi.advanceTimersByTimeAsync(CHAT.pollClosedMs * 3);
    expect(poll).not.toHaveBeenCalled();

    active = true;
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(1);
    stop();
  });

  it('keeps a visible retry armed when the tab hides before its due time', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    const callback = vi.fn();
    const stop = scheduleChatRetry(callback, CHAT.pollOpenMs);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(CHAT.pollOpenMs * 2);
    expect(callback).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.runAllTimersAsync();
    expect(callback).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.runAllTimersAsync();
    expect(callback).toHaveBeenCalledTimes(1);
    stop();

    const cancelled = vi.fn();
    const cancel = scheduleChatRetry(cancelled, CHAT.pollOpenMs);
    cancel();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(CHAT.pollOpenMs * 2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.runAllTimersAsync();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('replaces an optimistic retry with one canonical message by client UUID', () => {
    const optimistic = {
      ...message('pending:uuid', 'uuid'), id: 'pending:uuid', text: '<img src=x onerror=alert(1)>',
    };
    const canonical = { ...message('42', 'uuid'), text: optimistic.text };
    const merged = mergeChatMessages([optimistic], [canonical, canonical], CHAT.domMessageLimit);
    expect(merged).toEqual([canonical]);
  });

  it('validates graphemes, bytes and lines without splitting composed emoji', () => {
    expect(chatDraft('hello\r\nworld')).toMatchObject({ text: 'hello\nworld', lines: 2, valid: true });
    expect(chatDraft('👨‍👩‍👧‍👦').graphemes).toBe(1);
    expect(chatDraft(Array.from({ length: CHAT.maxLines + 1 }, () => 'x').join('\n')).valid).toBe(false);
    expect(chatDraft('🙂'.repeat(CHAT.maxGraphemes + 1)).valid).toBe(false);
  });
});
