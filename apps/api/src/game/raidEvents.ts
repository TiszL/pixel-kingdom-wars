import type { ActiveBaseRaid, BaseRaidSnapshot, RaidEventError } from '@shardkeep/shared/raidEvents';
import type { FastifyReply } from 'fastify';
import { HttpError } from '../lib/errors';
import type { RaidInvalidationBus } from '../lib/raidEventBus';

// Transport/operational bounds, not game rules.
const RECONCILE_MS = 15_000;
const MAX_CONNECTIONS = 512;
const MAX_WALLET_CONNECTIONS = 4;
const MAX_BUFFER_BYTES = 64 * 1024;

interface Client {
  wallet: string;
  validate: () => Promise<void>;
  write: (frame: string) => boolean;
  close: () => void;
  last?: string;
}
interface Group {
  clients: Set<Client>;
  running: boolean;
  dirty: boolean;
}

/** One serialized authoritative read per subscribed base, regardless of tabs.
 * Subscribe before reading. An invalidation during an in-flight read discards
 * that result and reads again, so an older null never unlocks a newer raid. */
export class RaidEventHub {
  private readonly groups = new Map<string, Group>();
  private readonly wallets = new Map<string, number>();
  private count = 0;
  private closed = false;
  private readonly stop: () => void;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    bus: RaidInvalidationBus,
    private readonly read: (baseId: string) => Promise<ActiveBaseRaid | null>,
    private readonly reportError: (error: unknown) => void = () => {},
  ) {
    this.stop = bus.subscribe((baseId) => this.refresh(baseId));
    this.timer = setInterval(() => {
      for (const baseId of this.groups.keys()) this.refresh(baseId);
    }, RECONCILE_MS);
    this.timer.unref();
  }

  assertCapacity(wallet: string): void {
    if (this.closed) throw new HttpError(503, 'raid updates are restarting');
    if (this.count >= MAX_CONNECTIONS || (this.wallets.get(wallet) ?? 0) >= MAX_WALLET_CONNECTIONS) {
      throw new HttpError(429, 'too many raid update connections; retry shortly');
    }
  }

  add(baseId: string, client: Client): () => void {
    this.assertCapacity(client.wallet);
    const group = this.groups.get(baseId) ?? { clients: new Set<Client>(), running: false, dirty: false };
    this.groups.set(baseId, group);
    group.clients.add(client);
    this.count += 1;
    this.wallets.set(client.wallet, (this.wallets.get(client.wallet) ?? 0) + 1);
    this.refresh(baseId);
    return () => this.remove(baseId, group, client);
  }

  private remove(baseId: string, group: Group, client: Client): void {
    if (!group.clients.delete(client)) return;
    this.count -= 1;
    const remaining = (this.wallets.get(client.wallet) ?? 1) - 1;
    if (remaining) this.wallets.set(client.wallet, remaining);
    else this.wallets.delete(client.wallet);
    client.close();
    if (!group.clients.size && !group.running && this.groups.get(baseId) === group) this.groups.delete(baseId);
  }

  private fail(baseId: string, group: Group, client: Client, error: unknown): void {
    const body: RaidEventError = error instanceof HttpError
      ? { status: error.statusCode, message: error.message, ...(error.code ? { code: error.code } : {}) }
      : { status: 503, message: 'raid updates are temporarily unavailable' };
    client.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
    this.remove(baseId, group, client);
  }

  private refresh(baseId: string): void {
    const group = this.groups.get(baseId);
    if (!group || this.closed) return;
    group.dirty = true;
    if (!group.running) void this.flush(baseId, group);
  }

  private async flush(baseId: string, group: Group): Promise<void> {
    group.running = true;
    try {
      while (!this.closed && group.dirty && group.clients.size) {
        group.dirty = false;
        const snapshot: BaseRaidSnapshot = { baseId, activeRaid: await this.read(baseId) };
        // Authorize after the potentially slow recovery/read too: a session or
        // deed transfer during that work must not receive the completed result.
        await Promise.all([...group.clients].map(async (client) => {
          try { await client.validate(); }
          catch (error) { this.fail(baseId, group, client, error); }
        }));
        if (!group.clients.size || this.closed) break;
        if (group.dirty) continue;
        const value = JSON.stringify(snapshot);
        for (const client of group.clients) {
          const frame = client.last === value ? ': heartbeat\n\n' : `event: snapshot\ndata: ${value}\n\n`;
          if (!client.write(frame)) this.remove(baseId, group, client);
          else client.last = value;
        }
      }
    } catch (error) {
      this.reportError(error);
      for (const client of group.clients) this.fail(baseId, group, client, error);
    } finally {
      group.running = false;
      if (!group.clients.size && this.groups.get(baseId) === group) this.groups.delete(baseId);
    }
  }

  close(): void {
    this.closed = true;
    this.stop();
    clearInterval(this.timer);
    for (const [baseId, group] of this.groups) {
      for (const client of group.clients) this.remove(baseId, group, client);
    }
  }
}

export function openRaidEventStream(
  hub: RaidEventHub, reply: FastifyReply, baseId: string, wallet: string,
  validate: () => Promise<void>,
): void {
  hub.assertCapacity(wallet);
  reply.hijack();
  const response = reply.raw;
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) response.setHeader(name, value);
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'private, no-store, no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  response.setTimeout(0);
  response.flushHeaders();
  const disconnect = hub.add(baseId, {
    wallet, validate,
    write(frame) {
      if (response.destroyed || response.writableEnded) return false;
      if (response.writableLength > MAX_BUFFER_BYTES || !response.write(frame)) {
        response.destroy();
        return false;
      }
      return true;
    },
    close() { response.end(); },
  });
  response.once('close', disconnect);
  if (response.destroyed) disconnect();
}
