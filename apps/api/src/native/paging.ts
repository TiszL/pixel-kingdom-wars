import {parseRaidAdvancedPresentation} from '../game/raidAdvancedPresentation';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { LIVE_RAID, RAID_REPLAY_LIMITS } from '@shardkeep/shared';
import type { SimEvent } from '@shardkeep/sim';
import type { z } from 'zod';
import {parseRaidStarterPresentation} from '../game/raidStarterPresentation';
import { HttpError } from '../lib/errors';
import { NATIVE_PAGE_AGE_MS, NATIVE_PAGE_BYTES, NativePresentationPageSchema, NativePresentationStateSchema } from './contracts';

type State = z.infer<typeof NativePresentationStateSchema>;
export type NativePage = z.infer<typeof NativePresentationPageSchema>;
interface Timeline {
  raidId: string; revision: string; frozen: string;
  events: string[]; commands: string[]; ticks: number[]; bytes: number; expires: number;
}
interface Generation {
  id: string; wallet: string; timeline: string; parentRevision: string | null;
  replaceFromTick: number; start: number; expires: number; state: string; bytes: number;
}
export interface NativePagingLimits {
  cacheBytes: number; generations: number; timelines: number; pageBytes?: number; ageMs?: number;
}
const expired = () => new HttpError(410, 'presentation pages expired; restart from the last applied revision', 'NATIVE_PAGE_EXPIRED');
const invalid = () => new HttpError(400, 'invalid presentation page cursor', 'NATIVE_PAGE_INVALID');
const capacity = () => new HttpError(503, 'native presentation exceeds page capacity', 'NATIVE_PRESENTATION_CAPACITY');

/** Serialized canonical timelines are shared by all page generations. The
 * additional store has its own hard byte/count/TTL bounds beside the SIM cache;
 * pages themselves are not retained or duplicated. Cursors never authorize a
 * request: routes recheck current session/participant/deed authority every time. */
export class NativePresentationPages {
  private timelines = new Map<string, Timeline>();
  private generations = new Map<string, Generation>();
  private bytes = 0;
  private secret = randomBytes(32);
  private pageBytes: number;
  private ageMs: number;

  constructor(private limits: NativePagingLimits, private now = Date.now) {
    this.pageBytes = limits.pageBytes ?? NATIVE_PAGE_BYTES;
    this.ageMs = limits.ageMs ?? NATIVE_PAGE_AGE_MS;
    if (limits.cacheBytes <= 0 || limits.generations <= 0 || limits.timelines <= 0 || this.pageBytes < 512 || this.ageMs <= 0) {
      throw new RangeError('Invalid native paging limits');
    }
  }

  create(wallet: string, raidId: string, revision: string, state: unknown, events: readonly SimEvent[], parentRevision?: string): NativePage {
    this.prune();
    const key = `${raidId}:${revision}`;
    // The revision intentionally excludes moving serverNow/simNowMs. Each
    // immutable page generation captures a fresh clock while sharing events.
    // Canonical live readers return Date objects; Fastify normally serializes
    // them at the HTTP boundary. Page validation happens earlier, so normalize
    // to those exact JSON wire values before applying the transport schema.
    const canonical = NativePresentationStateSchema.parse(JSON.parse(JSON.stringify(state)));
    parseRaidStarterPresentation(canonical.servicePresentation,canonical.snapshot);
    parseRaidAdvancedPresentation(canonical.advancedServicePresentation,canonical.snapshot);
    const serialized = JSON.stringify({ ...canonical, commands: [] });
    const stateBytes = Buffer.byteLength(serialized);
    let timeline = this.timelines.get(key);
    if (!timeline) {
      if (events.length > RAID_REPLAY_LIMITS.maxEvents || canonical.commands.length > LIVE_RAID.maxCommands) throw capacity();
      let bytes = 64; // Retained frozen-input hash, plus event bytes/ticks below.
      const commands = canonical.commands.map((command) => {
        const value = JSON.stringify(command); bytes += Buffer.byteLength(value);
        if (bytes > this.limits.cacheBytes) throw capacity();
        return value;
      });
      let previous = -1;
      const ticks: number[] = [];
      const encoded = events.map((event) => {
        if (!Number.isSafeInteger(event.t) || event.t < previous || event.t < 0) throw capacity();
        previous = event.t; ticks.push(event.t);
        const value = JSON.stringify(event); bytes += Buffer.byteLength(value) + 8;
        if (bytes > this.limits.cacheBytes) throw capacity();
        return value;
      });
      if (bytes > this.limits.cacheBytes) throw capacity();
      timeline = { raidId, revision, frozen: createHash('sha256').update(JSON.stringify({
        snapshot: canonical.snapshot, armySnapshot: canonical.armySnapshot, simVersion: canonical.simVersion,
        ...(canonical.servicePresentation===undefined?{}:{servicePresentation:canonical.servicePresentation}),
        ...(canonical.advancedServicePresentation===undefined?{}:{advancedServicePresentation:canonical.advancedServicePresentation}),
      })).digest('hex'), events: encoded, commands, ticks, bytes, expires: this.now() + this.ageMs };
      while (this.timelines.size && (this.bytes + bytes > this.limits.cacheBytes || this.timelines.size >= this.limits.timelines)) {
        this.removeTimeline(this.timelines.keys().next().value!);
      }
      this.timelines.set(key, timeline); this.bytes += bytes;
    }
    // Old viewer metadata is reclaimed first. If necessary evict other event
    // timelines, never the timeline needed by this response. All duplication
    // from per-viewer snapshot/clock state remains inside the same byte budget.
    while (this.generations.size && (this.generations.size >= this.limits.generations || this.bytes + stateBytes > this.limits.cacheBytes)) {
      this.removeGeneration(this.generations.keys().next().value!);
    }
    while (this.bytes + stateBytes > this.limits.cacheBytes) {
      const other = [...this.timelines.keys()].find((candidate) => candidate !== key);
      if (!other) throw capacity();
      this.removeTimeline(other);
    }
    timeline.expires = this.now() + this.ageMs;
    const parent = parentRevision ? this.timelines.get(`${raidId}:${parentRevision}`) : undefined;
    let replaceFromTick = 0;
    let acceptedParent: string | null = null;
    if (parent && parent.frozen === timeline.frozen) {
      acceptedParent = parent.revision;
      let changed = 0;
      while (changed < parent.events.length && changed < timeline.events.length && parent.events[changed] === timeline.events[changed]) changed++;
      // Replace an entire tick even if some events at that tick are identical.
      // Clients retain only t < boundary, preventing same-tick duplicates.
      replaceFromTick = Math.min(parent.ticks[changed] ?? Infinity, timeline.ticks[changed] ?? Infinity);
      if (!Number.isFinite(replaceFromTick)) replaceFromTick = Math.max(parent.ticks.at(-1) ?? -1, timeline.ticks.at(-1) ?? -1) + 1;
    }
    let start = 0;
    while (start < timeline.ticks.length && timeline.ticks[start]! < replaceFromTick) start++;
    const generation: Generation = { id: randomBytes(16).toString('hex'), wallet, timeline: key,
      parentRevision: acceptedParent, replaceFromTick, start, expires: this.now() + this.ageMs,
      state: serialized, bytes: stateBytes };
    this.generations.set(generation.id, generation); this.bytes += stateBytes;
    try { return this.page(generation, timeline, 0, 0); }
    catch (error) { this.removeGeneration(generation.id); throw error; }
  }

  read(wallet: string, raidId: string, cursor: string): NativePage {
    this.prune();
    const match = /^([a-f0-9]{32})\.([0-9]{1,9})\.([0-9]{1,9})\.([a-f0-9]{64})$/.exec(cursor);
    if (!match) throw invalid();
    const [, id, commandOffset, eventOffset, signature] = match;
    const generation = this.generations.get(id!);
    if (!generation) throw expired();
    if (!timingSafeEqual(Buffer.from(signature!, 'hex'), Buffer.from(this.mac(`${id}.${commandOffset}.${eventOffset}`), 'hex'))) throw invalid();
    const timeline = this.timelines.get(generation.timeline);
    if (!timeline) throw expired();
    if (generation.wallet !== wallet || timeline.raidId !== raidId) throw invalid();
    return this.page(generation, timeline, Number(commandOffset), Number(eventOffset));
  }

  close(): void { this.timelines.clear(); this.generations.clear(); this.bytes = 0; }
  stats() { this.prune(); return { bytes: this.bytes, timelines: this.timelines.size, generations: this.generations.size }; }

  private page(generation: Generation, timeline: Timeline, commandOffset: number, offset: number): NativePage {
    const totalEvents = timeline.events.length - generation.start;
    const totalCommands = timeline.commands.length;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalEvents || !Number.isSafeInteger(commandOffset)
        || commandOffset < 0 || commandOffset > totalCommands || (commandOffset < totalCommands && offset > 0)
        || (offset === totalEvents && commandOffset === totalCommands && totalEvents + totalCommands > 0)) throw invalid();
    const frame: NativePage = { protocolVersion: 2, raidId: timeline.raidId, revision: timeline.revision,
      parentRevision: generation.parentRevision, replaceFromTick: generation.replaceFromTick,
      generation: generation.id, eventOffset: offset, totalEvents, events: [],
      commandOffset, totalCommands, commands: [],
      nextCursor: null, state: offset === 0 && commandOffset === 0 ? JSON.parse(generation.state) as State : null };
    // Reserve the largest possible cursor before adding complete events. The
    // final measured JSON bytes remain the authority, including first-page state.
    const cursorBudget = this.cursor(generation.id, LIVE_RAID.maxCommands, RAID_REPLAY_LIMITS.maxEvents);
    const overhead = Buffer.byteLength(JSON.stringify({ ...frame, nextCursor: cursorBudget }));
    if (overhead > this.pageBytes) throw capacity();
    let bytes = overhead;
    let commandCount = 0;
    for (let i = commandOffset; i < timeline.commands.length; i++) {
      const command = timeline.commands[i]!;
      const size = Buffer.byteLength(command) + (commandCount ? 1 : 0);
      if (bytes + size > this.pageBytes) break;
      frame.commands.push(JSON.parse(command) as NativePage['commands'][number]); bytes += size; commandCount++;
    }
    let count = 0;
    for (let i = generation.start + offset; commandOffset + commandCount === totalCommands && i < timeline.events.length; i++) {
      const event = timeline.events[i]!;
      const size = Buffer.byteLength(event) + (count ? 1 : 0);
      if (bytes + size > this.pageBytes) break;
      frame.events.push(JSON.parse(event) as NativePage['events'][number]); bytes += size; count++;
    }
    if (offset + count < totalEvents || commandOffset + commandCount < totalCommands) {
      if (count + commandCount === 0) throw capacity();
      frame.nextCursor = this.cursor(generation.id, commandOffset + commandCount, offset + count);
    }
    if (Buffer.byteLength(JSON.stringify(frame)) > this.pageBytes) throw capacity();
    return frame;
  }

  private mac(value: string) { return createHmac('sha256', this.secret).update(value).digest('hex'); }
  private cursor(id: string, commandOffset: number, eventOffset: number) {
    const value = `${id}.${commandOffset}.${eventOffset}`; return `${value}.${this.mac(value)}`;
  }
  private removeGeneration(id: string) {
    const generation = this.generations.get(id);
    if (generation) this.bytes -= generation.bytes;
    this.generations.delete(id);
  }
  private removeTimeline(key: string) {
    const timeline = this.timelines.get(key);
    if (timeline) this.bytes -= timeline.bytes;
    this.timelines.delete(key);
    for (const [id, generation] of this.generations) if (generation.timeline === key) this.removeGeneration(id);
  }
  private prune() {
    const now = this.now();
    for (const [key, timeline] of this.timelines) if (timeline.expires <= now) this.removeTimeline(key);
    for (const [id, generation] of this.generations) if (generation.expires <= now) this.removeGeneration(id);
  }
}
