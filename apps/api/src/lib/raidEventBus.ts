import Redis from 'ioredis';
import type { Db, DbOrTx, DbTx } from '../db/client';

const CHANNEL = 'shardkeep:base-raid-invalidations:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RaidInvalidationBus {
  publish(baseId: string): void;
  subscribe(listener: (baseId: string) => void): () => void;
}

/** Notifications contain identifiers only. Redis loss cannot change gameplay or
 * turn an already-committed raid into a failed response; subscribers reconcile. */
export class RedisRaidEventBus implements RaidInvalidationBus {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly listeners = new Set<(baseId: string) => void>();
  private subscribed = false;

  constructor(url: string, warn: (error: unknown) => void) {
    const options = {
      enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 500,
      retryStrategy: (attempt: number) => Math.min(attempt * 250, 30_000),
    };
    this.publisher = new Redis(url, options);
    this.subscriber = new Redis(url, options);
    this.publisher.on('error', warn);
    this.subscriber.on('error', warn);
    this.subscriber.on('ready', () => {
      void this.subscriber.subscribe(CHANNEL).then(() => { this.subscribed = true; }).catch(warn);
    });
    this.subscriber.on('close', () => { this.subscribed = false; });
    this.subscriber.on('message', (channel, baseId) => {
      if (channel === CHANNEL && UUID.test(baseId)) this.emit(baseId);
    });
  }

  get isSubscribed(): boolean { return this.subscribed; }

  private emit(baseId: string): void {
    for (const listener of this.listeners) listener(baseId);
  }

  publish(baseId: string): void {
    this.emit(baseId);
    if (this.publisher.status === 'ready') {
      void this.publisher.publish(CHANNEL, baseId).catch(() => undefined);
    }
  }

  subscribe(listener: (baseId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    this.listeners.clear();
    this.subscriber.disconnect();
    this.publisher.disconnect();
  }
}

const publishers = new WeakMap<DbOrTx, Set<RaidInvalidationBus>>();
const pending = new WeakMap<DbOrTx, Set<string>>();

export function registerRaidEventPublisher(db: Db, bus: RaidInvalidationBus): () => void {
  const registered = publishers.get(db) ?? new Set<RaidInvalidationBus>();
  registered.add(bus);
  publishers.set(db, registered);
  return () => {
    registered.delete(bus);
    if (!registered.size) publishers.delete(db);
  };
}

/** Only raid transaction boundaries opt in. Savepoints merge into the outer
 * transaction's buffer, and rollback discards their notifications. Unmanaged
 * callers remain safe: no pre-commit publish; reconciliation observes them. */
export async function raidEventTransaction<T>(
  db: DbOrTx, run: (tx: DbTx) => Promise<T>,
): Promise<T> {
  const parent = pending.get(db);
  const targets = publishers.get(db);
  if (!parent && !targets?.size) return (db as Db).transaction(run);
  const changed = new Set<string>();
  const result = await (db as Db).transaction(async (tx) => {
    pending.set(tx, changed);
    try { return await run(tx); }
    finally { pending.delete(tx); }
  });
  for (const baseId of changed) {
    if (parent) parent.add(baseId);
    else for (const bus of targets ?? []) {
      // Delivery is best-effort AFTER commit, never a reason to retry a spend.
      try { bus.publish(baseId); } catch { /* Periodic DB reconciliation recovers. */ }
    }
  }
  return result;
}

export function markRaidBaseChanged(tx: DbOrTx, baseId: string | null): void {
  if (baseId) pending.get(tx)?.add(baseId);
}
