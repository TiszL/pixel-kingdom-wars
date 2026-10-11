import type { BadgeUi, ContextChipUi, DeckButtonUi, EdgeButtonUi, HeraldUi, HomeHudUi, ResourceChipUi, Verb } from '../hudModel';
import { UNKNOWN, shown } from '../hudModel';
import { PK_BUDGET } from '../homeHudLogic';
import { badgeCount, exactAmount } from '../kitLogic';
import { fmtDur } from '../../../lib/duration';

/** Minimal passive projection seam permitted by review f315f363 on base 3cbf.
 * The composed registry adapter supplies metadata and evaluated visibility; no
 * registry, store, command, callback, repository or timer is imported here.
 */
export interface HudFeatureProjection {
  id: string;
  title: string;
  hostKind: string;
  surface: string;
  icon: { state: 'RESOLVED' | 'SHAPE_CONTRACT' | 'UNRESOLVED'; key: string | null };
  visible: boolean;
  enabled: boolean;
}

export interface HudHomeSnapshot {
  baseId: string;
  player: { wallet?: string | null; keepLevel?: number | null; trophies?: string | null };
  /** Omission remains unknown. Never copy a decoded default into this field. */
  freeBuilders?: number | null;
  /** Existing owner's catalogue-validated overview; null when catalogue is unavailable. */
  builderOverview?: { free: number; owned: number } | null;
  jobs?: readonly { startedAt?: string | null; finishesAt?: string | null }[];
  /** Existing shield owner's formatted value; omitted = unknown, null = observed absence. */
  shield?: string | null;
  energy?: { free?: number | null; max?: number | null } | null;
  armyStatus?: { readyPts?: number | null; campCapacityPts?: number | null } | null;
  quests?: readonly { completed?: boolean; claimed?: boolean }[] | null;
  dailyClaimable?: boolean | null;
}

export interface HomeHudInput {
  account: { signedIn: boolean; wallet: string | null; selectedBaseId: string | null };
  home: HudHomeSnapshot | null;
  community: { unread: number | null } | null;
  chat: { enabled: boolean; cursor?: string | null; unread?: number | null; mentions?: number | null } | null;
  event: EdgeButtonUi | null;
  resources: readonly ResourceChipUi[];
  registry: readonly HudFeatureProjection[];
  nowMs: number | null;
  unreadRaids: number | null;
  selectionOpen: boolean;
  herald: HeraldUi | null;
  context: ContextChipUi | null;
  mirrored: boolean;
}

/** Port of HomeHudMapper.kt. Callers must pass null for snapshots whose current
 * wallet/base/epoch/generation they cannot prove. ID equality rejects conflicts;
 * it cannot establish A→B→A freshness. Resource formatting and event content are
 * already admitted by their owners. ALWAYS doors remain for the live dispatcher
 * to explain locks. Selection preserves content for the kit's exit animation.
 *
 * Two native helper seams stay explicit: builderOverview and hudShield outputs.
 * Their live web adapters, and all navigation/mounting, await the composed base.
 */
export function homeHudUi(input: HomeHudInput): HomeHudUi {
  if (input.resources.length > PK_BUDGET.MAX_RESOURCE_ROWS) {
    throw new Error('The admitted Home resource stack exceeds its budget');
  }
  const projected = new Map<string, HudFeatureProjection>();
  for (const row of input.registry) {
    if (projected.has(row.id)) throw new Error(`Duplicate Home feature metadata: ${row.id}`);
    projected.set(row.id, row);
  }
  function row(id: string): HudFeatureProjection {
    const feature = projected.get(id);
    if (!feature) throw new Error(`Required Home feature metadata is missing: ${id}`);
    if (feature.hostKind !== 'HUD' || feature.surface !== 'HUD_SLOT') {
      throw new Error(`Required Home feature is not a HUD slot: ${id}`);
    }
    return feature;
  }
  function permanent(id: string): HudFeatureProjection {
    const feature = row(id);
    if (!feature.visible) throw new Error(`Required Home feature is not visible: ${id}`);
    return feature;
  }

  const { account } = input;
  const base = account.signedIn && account.wallet?.trim() && account.selectedBaseId?.trim() &&
    input.home?.baseId === account.selectedBaseId &&
    (input.home.player.wallet == null || input.home.player.wallet === account.wallet) ? input.home : null;
  const profile = permanent('hud.profile');
  const trophiesRow = permanent('hud.leagues');
  const builders = permanent('hud.builders');
  const shield = permanent('hud.shield');
  const keepLevel = base?.player.keepLevel;
  const level = wholeCount(keepLevel) ? String(keepLevel) : UNKNOWN;
  const trophyCount = base?.player.trophies;
  const trophies = trophyCount != null && /^[0-9]+$/.exec(trophyCount)?.[0] === trophyCount ? exactAmount(trophyCount) : UNKNOWN;

  const candidateOverview = base?.builderOverview;
  const observedFree = base?.freeBuilders;
  const overview = candidateOverview && wholeCount(observedFree) &&
    wholeCount(candidateOverview.owned) && candidateOverview.owned > 0 &&
    candidateOverview.free === observedFree && candidateOverview.free <= candidateOverview.owned
    ? candidateOverview : null;
  const free = overview && overview.free > 0 ? overview.free : null;
  const builderValue = free != null && overview ? `${free}/${overview.owned}`
    : overview && base ? nextBuilderCountdown(base, input.nowMs) ?? UNKNOWN : UNKNOWN;
  const builderDescription = free != null && overview ? `Builders: ${free} of ${overview.owned} free`
    : overview && builderValue !== UNKNOWN ? `Builders: all busy, ${builderValue}` : `Builders: ${UNKNOWN}`;
  const raided = wholeCount(input.unreadRaids) && input.unreadRaids > 0;
  const shieldValue = raided ? `RAIDED ×${input.unreadRaids}`
    : !base || base.shield === undefined ? UNKNOWN : base.shield === null ? '—' : shown(base.shield);

  const quests = row('hud.quests');
  const daily = row('hud.dailyCache');
  const eventRow = row('hud.event');
  if (input.event && (input.event.id !== eventRow.id || input.event.icon !== hudIcon(eventRow))) {
    throw new Error('The admitted event must use canonical Home event metadata');
  }
  const right: EdgeButtonUi[] = [];
  const questCount = base?.quests?.filter(quest => quest.completed === true && quest.claimed === false).length;
  const questBadge = countBadge(questCount);
  if (quests.visible && quests.enabled && questBadge != null) right.push({
    id: quests.id, icon: hudIcon(quests), label: 'QUESTS', glow: false,
    badge: { text: questBadge, tone: 'COUNT', description: `${questCount} quests ready to claim` },
  });
  if (daily.visible && daily.enabled && base?.dailyClaimable === true) right.push({
    id: daily.id, icon: hudIcon(daily), label: 'DAILY', glow: false,
    badge: { text: '!', tone: 'READY', description: 'Daily cache ready' },
  });
  if (eventRow.visible && eventRow.enabled && input.event?.badge != null) right.push(input.event);

  const mail = row('hud.mail');
  const chatRow = row('hud.chat');
  const left: EdgeButtonUi[] = [];
  const unread = input.community?.unread;
  const mailBadge = countBadge(unread);
  if (mail.visible && mail.enabled && mailBadge != null) left.push({
    id: mail.id, icon: hudIcon(mail), label: 'MAIL', glow: false,
    badge: { text: mailBadge, tone: 'COUNT', description: `${unread} unread letters` },
  });
  // The accepted native successor retains enabled CHAT even with no unread badge.
  if (chatRow.visible && chatRow.enabled && input.chat?.enabled === true) left.push({
    id: chatRow.id, icon: hudIcon(chatRow), label: 'CHAT', glow: false, badge: chatBadge(input.chat),
  });
  function deck(id: string, primary: boolean, verb: Verb, pips: [number, number] | null = null): DeckButtonUi {
    const feature = permanent(id);
    return { id: feature.id, icon: hudIcon(feature), label: feature.title, primary, badge: null, pips, verb };
  }
  return {
    profile: { id: profile.id, level, portrait: null, description: `Profile, Keep level ${level}` },
    builders: { id: builders.id, icon: hudIcon(builders), value: builderValue, description: builderDescription, dot: free != null },
    shield: { id: shield.id, icon: hudIcon(shield), value: shieldValue, tone: raided ? 'DANGER' : 'NORMAL',
      description: raided ? `${input.unreadRaids} unread raids. Opens the defence log` : `Shield: ${shieldValue}. Opens the defence log` },
    resources: detachedList(input.resources), rightEdge: detachedList(right), leftEdge: detachedList(left), herald: input.herald,
    deck: detachedList([deck('hud.attack', true, 'RED', validPips(base?.energy?.free, base?.energy?.max)),
      deck('hud.army', false, 'CHARCOAL', validPips(base?.armyStatus?.readyPts, base?.armyStatus?.campCapacityPts)),
      deck('hud.map', false, 'BLUE'), deck('hud.build', true, 'GREEN')]),
    deckVisible: !input.selectionOpen,
    trophies: { id: trophiesRow.id, icon: hudIcon(trophiesRow), value: trophies, description: `Trophies: ${trophies}` },
    context: input.context, mirrored: input.mirrored,
  };
}

/** Retain the kit's array shape while matching native detached, unmodifiable lists. */
function detachedList<T>(values: readonly T[]): T[] {
  const snapshot = [...values];
  Object.freeze(snapshot);
  return snapshot;
}

function hudIcon(feature: HudFeatureProjection): string {
  if ((feature.icon.state !== 'RESOLVED' && feature.icon.state !== 'SHAPE_CONTRACT') || !feature.icon.key?.trim()) {
    throw new Error(`Required Home icon is not admitted: ${feature.id}`);
  }
  return feature.icon.key;
}

function wholeCount(value: number | null | undefined): value is number {
  return value != null && Number.isSafeInteger(value) && value >= 0;
}
function countBadge(value: number | null | undefined): string | null {
  return wholeCount(value) ? badgeCount(value) : null;
}
function validPips(current: number | null | undefined, capacity: number | null | undefined): [number, number] | null {
  return wholeCount(current) && wholeCount(capacity) && capacity > 0 && current <= capacity ? [current, capacity] : null;
}
function chatBadge(chat: NonNullable<HomeHudInput['chat']>): BadgeUi | null {
  if (chat.cursor == null || !wholeCount(chat.unread) || !wholeCount(chat.mentions) || chat.mentions > chat.unread) return null;
  const mentions = countBadge(chat.mentions);
  if (mentions != null) return { text: `@${mentions}`, tone: 'REWARD', description: `${chat.unread} unread messages, ${chat.mentions} mentions` };
  const unread = countBadge(chat.unread);
  return unread == null ? null : { text: unread, tone: 'COUNT', description: `${chat.unread} unread messages` };
}

/** Presentation-only job countdown. D-070 / review 633d49b3 override the native
 * zero-unit wording: use the existing shared fmtDur vocabulary. The milliseconds
 * conversion is not a game timer. Reaching zero never completes a job.
 * Date.parse reads explicit instants only; no wall-clock or locale-dependent date.
 */
function nextBuilderCountdown(base: HudHomeSnapshot, nowMs: number | null): string | null {
  if (nowMs == null || !Number.isSafeInteger(nowMs)) return null;
  let earliest: number | null = null;
  for (const job of base.jobs ?? []) {
    const start = instantMs(job.startedAt); const end = instantMs(job.finishesAt);
    if (start == null || end == null || end < start) continue;
    if (earliest == null || end < earliest) earliest = end;
  }
  if (earliest == null) return null;
  const seconds = Math.max(0, Math.ceil((earliest - nowMs) / 1_000));
  if (seconds === 0) return 'Finishing…';
  return `${fmtDur(seconds)} remaining`;
}
function instantMs(value: string | null | undefined): number | null {
  if (value == null) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!parts || parts[0] !== value) return null;
  // Date.parse normalizes February 30; Instant.parse rejects it. Keep that refusal.
  const year = Number(parts[1]); const month = Number(parts[2]); const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (days == null || day < 1 || day > days) return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
