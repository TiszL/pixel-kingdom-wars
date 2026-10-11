import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { relayLimited, relayUnavailable, type RelayCost } from './solanaRpcRelay';

export interface RelayIdentity { ip: string; sessionId?: string; wallet?: string }
export interface RelayLease { renew(): Promise<void>; release(): Promise<void> }
export interface RelayAdmission {
  charge(identity: RelayIdentity, cost: RelayCost, count?: number): Promise<void>;
  acquire(identity: RelayIdentity, kind: 'http' | 'ws'): Promise<RelayLease>;
  close(): Promise<void>;
}
// Redis TIME avoids independently skewed API clocks. All keys share one cluster
// slot, so a second API cannot multiply provider budgets. The finite global rate
// also bounds key cardinality when clients rotate IPs; rejected buckets aren't made.
const RATE = `
local now = redis.call('TIME'); local ms = now[1] * 1000 + math.floor(now[2] / 1000)
for i,key in ipairs(KEYS) do
  local count = tonumber(redis.call('GET', key) or '0')
  if count + tonumber(ARGV[1]) > tonumber(ARGV[i+1]) then return 0 end
end
for _,key in ipairs(KEYS) do
  redis.call('INCRBY', key, ARGV[1]); if redis.call('PTTL', key) < 0 then redis.call('PEXPIRE', key, 60000) end
end
return 1`;
const LEASE = `
local now = redis.call('TIME'); local ms = now[1] * 1000 + math.floor(now[2] / 1000)
for i,key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE', key, '-inf', ms)
  if ARGV[1] == 'renew' then
    if not redis.call('ZSCORE', key, ARGV[2]) then return 0 end
  elseif redis.call('ZCARD', key) >= tonumber(ARGV[i+3]) then return 0 end
end
for _,key in ipairs(KEYS) do
  redis.call('ZADD', key, ms + tonumber(ARGV[3]), ARGV[2]); redis.call('PEXPIRE', key, tonumber(ARGV[3]) + 1000)
end
return 1`;
const RELEASE = `for _,key in ipairs(KEYS) do redis.call('ZREM', key, ARGV[1]) end return 1`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** These rates/leases deliberately fail closed on Redis failure. The ordinary
 * game's availability-first limiter must not expose a paid provider unbounded. */
export class RedisRelayAdmission implements RelayAdmission {
  private readonly redis: Redis;
  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      connectTimeout: 500, commandTimeout: 750, maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    // Errors are caught at admission; never log connection URLs or credentials.
    this.redis.on('error', () => undefined);
  }
  private async execute(script: string, keys: string[], values: Array<string | number>): Promise<void> {
    let result: unknown;
    try { result = await this.redis.eval(script, keys.length, ...keys, ...values); }
    catch { throw relayUnavailable(); }
    if (Number(result) !== 1) throw relayLimited();
  }
  async charge(identity: RelayIdentity, cost: RelayCost, count = 1): Promise<void> {
    const prefix = 'pkw:{rpc-relay}:rate:';
    const buckets: Array<[string, number]> = [];
    const ip = digest(identity.ip); const session = identity.sessionId && digest(identity.sessionId);
    // All upstream requests share an aggregate ceiling, regardless of method,
    // source IP or authentication. Independent category budgets cap costly work.
    if (cost !== 'notification' && cost !== 'admission') {
      buckets.push(['all', 6_000], [`ip:${ip}`, session ? 600 : 120]);
      if (session) buckets.push([`session:${session}`, 240]);
    }
    if (cost === 'admission') {
      buckets.push(['admission', 6_000], [`admission:ip:${ip}`, 600]);
    } else if (cost === 'simulate') {
      buckets.push(['simulate', 300], [`simulate:ip:${ip}`, session ? 60 : 10]);
      if (session) buckets.push([`simulate:session:${session}`, 20]);
    } else if (cost === 'send') {
      if (!session) throw relayUnavailable();
      buckets.push(['send', 300], [`send:ip:${ip}`, 60], [`send:session:${session}`, 10]);
    } else if (cost === 'connect') {
      buckets.push(['connect', 300], [`connect:ip:${ip}`, 30]);
      if (session) buckets.push([`connect:session:${session}`, 10]);
    } else if (cost === 'notification') {
      buckets.push(['notification', 30_000], [`notification:ip:${ip}`, 3_000]);
    }
    await this.execute(RATE, buckets.map(([key]) => prefix + key), [count, ...buckets.map(([, max]) => max)]);
  }
  async acquire(identity: RelayIdentity, kind: 'http' | 'ws'): Promise<RelayLease> {
    const prefix = `pkw:{rpc-relay}:lease:${kind}:`;
    const buckets: Array<[string, number]> = [['all', kind === 'http' ? 128 : 1024],
      [`ip:${digest(identity.ip)}`, kind === 'http' ? 4 : 16]];
    if (identity.sessionId) buckets.push([`session:${digest(identity.sessionId)}`, kind === 'http' ? 4 : 2]);
    const keys = buckets.map(([key]) => prefix + key); const id = randomUUID();
    const values = [id, kind === 'http' ? 15_000 : 30_000, ...buckets.map(([, max]) => max)];
    await this.execute(LEASE, keys, ['acquire', ...values]);
    let released = false;
    return {
      renew: async () => { if (released) throw relayUnavailable(); await this.execute(LEASE, keys, ['renew', ...values]); },
      release: async () => {
        if (released) return; released = true;
        // Expiring leases also release after process death or a Redis outage.
        await this.redis.eval(RELEASE, keys.length, ...keys, id).catch(() => undefined);
      },
    };
  }
  async close(): Promise<void> { this.redis.disconnect(); }
}
