import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { parseRaidSnapshot, readRaidEvents } from './raidEvents';

const snapshot = { baseId: 'base-a', activeRaid: { raidId: 'raid-a', state: 'live' } };
function fixture() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ start: (value) => { writer = value; }, cancel }));
  const controller = new AbortController();
  const onSnapshot = vi.fn();
  const onActivity = vi.fn();
  const result = readRaidEvents(response, { baseId: 'base-a', signal: controller.signal, onSnapshot, onActivity }).catch((error: unknown) => error);
  const write = (text: string): void => writer.enqueue(new TextEncoder().encode(text));
  return { controller, writer, result, write, cancel, onSnapshot, onActivity };
}
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('bounded raid event framing', () => {
  it('handles split CRLF, multibyte UTF-8, multiline JSON and comments without inventing a snapshot', async () => {
    const f = fixture();
    f.write(': heartbeat\r');
    f.write('\n\r\nevent: snapshot\r\ndata: {"baseId":"base-a",\r\ndata: "activeRaid":null}\r\n\r\n');
    await flush();
    expect(f.onSnapshot).toHaveBeenCalledExactlyOnceWith({ baseId: 'base-a', activeRaid: null });
    const bytes = new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({ ...snapshot, extra: 'მ' })}\n\n`);
    const split = bytes.indexOf(0xe1) + 1;
    f.writer.enqueue(bytes.slice(0, split));
    f.writer.enqueue(bytes.slice(split));
    await flush();
    expect(f.onSnapshot).toHaveBeenCalledTimes(2);
    f.controller.abort();
    await f.result;
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    'event: snapshot\ndata: invalid\n\n',
    'event: snapshot\ndata: {"baseId":"base-b","activeRaid":null}\n\n',
    'event: snapshot\ndata: {"baseId":"base-a","activeRaid":{"raidId":"x","state":"done"}}\n\n',
    'data: ' + 'x'.repeat(16_385),
  ])('rejects malformed, cross-base or unbounded frames', async (wire) => {
    const f = fixture();
    f.write(wire);
    expect(await f.result).toMatchObject({ code: 'RAID_EVENTS_INVALID' });
    expect(f.onSnapshot).not.toHaveBeenCalled();
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it('retains typed session/ownership stream errors for canonical fallback recovery', async () => {
    const f = fixture();
    f.write('event: error\ndata: {"status":401,"code":"SESSION_EXPIRED","message":"Session expired"}\n\n');
    expect(await f.result).toEqual(new ApiError(401, 'Session expired', 'SESSION_EXPIRED'));
  });

  it('treats EOF and partial snapshots as unavailable, never unlocked', async () => {
    const f = fixture();
    f.write('event: snapshot\ndata: {"baseId":"base-a","activeRaid":null}');
    f.writer.close();
    expect(await f.result).toMatchObject({ code: 'RAID_EVENTS_CLOSED' });
    expect(f.onSnapshot).not.toHaveBeenCalled();
  });

  it('accepts all server lock states and explicit null only', () => {
    for (const state of ['reserved', 'live', 'releasing']) {
      expect(parseRaidSnapshot({ ...snapshot, activeRaid: { raidId: 'raid-a', state } }, 'base-a').activeRaid?.state).toBe(state);
    }
    expect(() => parseRaidSnapshot({ baseId: 'base-a' }, 'base-a')).toThrow();
  });
});
