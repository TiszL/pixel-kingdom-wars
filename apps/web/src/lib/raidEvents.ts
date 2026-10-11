import type { BaseRaidSnapshot, RaidEventError } from '@shardkeep/shared/raidEvents';
import { ApiError } from './api';

const MAX_FRAME_LENGTH = 16_384;
const invalid = (): ApiError => new ApiError(0, 'Live raid updates were interrupted.', 'RAID_EVENTS_INVALID');

export function parseRaidSnapshot(value: unknown, baseId: string): BaseRaidSnapshot {
  if (!value || typeof value !== 'object' || !('baseId' in value) || value.baseId !== baseId
    || !('activeRaid' in value)) throw invalid();
  const raid = value.activeRaid;
  if (raid !== null && (!raid || typeof raid !== 'object'
    || !('raidId' in raid) || typeof raid.raidId !== 'string' || !raid.raidId
    || !('state' in raid) || !['reserved', 'live', 'releasing'].includes(String(raid.state)))) throw invalid();
  return value as BaseRaidSnapshot;
}

/** Bounded SSE framing; no third-party runtime or EventSource cookie/header gap. */
export async function readRaidEvents(response: Response, options: {
  baseId: string;
  signal: AbortSignal;
  onSnapshot(snapshot: BaseRaidSnapshot): void;
  onActivity(): void;
}): Promise<void> {
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let frameLength = 0;
  let event = '';
  let data: string[] = [];
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  options.signal.addEventListener('abort', cancel, { once: true });
  const line = (text: string): void => {
    frameLength += text.length;
    if (frameLength > MAX_FRAME_LENGTH) throw invalid();
    if (text === '') {
      if (data.length && (event === 'snapshot' || event === 'error')) {
        let value: unknown;
        try { value = JSON.parse(data.join('\n')); } catch { throw invalid(); }
        if (event === 'snapshot') options.onSnapshot(parseRaidSnapshot(value, options.baseId));
        else {
          const error = value as RaidEventError | null;
          if (!error || !Number.isInteger(error.status) || error.status < 400 || error.status > 599
            || typeof error.message !== 'string' || (error.code !== undefined && typeof error.code !== 'string')) throw invalid();
          throw new ApiError(error.status, error.message, error.code);
        }
      }
      event = ''; data = []; frameLength = 0;
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    const value = colon === -1 ? '' : text.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  };
  try {
    options.signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      options.signal.throwIfAborted();
      if (done) throw new ApiError(0, 'Live raid connection closed.', 'RAID_EVENTS_CLOSED');
      pending += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.search(/[\r\n]/)) !== -1) {
        if (pending[end] === '\r' && end === pending.length - 1) break;
        const length = pending[end] === '\r' && pending[end + 1] === '\n' ? 2 : 1;
        line(pending.slice(0, end));
        pending = pending.slice(end + length);
      }
      if (pending.length + frameLength > MAX_FRAME_LENGTH) throw invalid();
      options.onActivity();
    }
  } finally {
    options.signal.removeEventListener('abort', cancel);
    // Cancellation must not wait for a broken peer's body to finish.
    cancel();
    reader.releaseLock();
  }
}
