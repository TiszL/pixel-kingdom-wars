/**
 * Berth presentation controller (P4 starter, P6a advanced): owns one completed
 * berth's texture once its family group is resident and the server names an
 * installation for it, exactly as MarketBuildingFx owns a Market body. Real
 * facts only, home scene and frozen raid alike:
 *
 *  - away:      the authored berth (ambient loop over the intact structure —
 *               the ambient frames keep the rigid structure of the intact
 *               master and animate only the water), no vehicle;
 *  - occupied:  the same berth plus the authored docked loop of the named
 *               vehicle, seated by that vehicle's ONE authored dock translation
 *               (berth attachment ↔ vehicle contact; starter [0,−27] top-left,
 *               [0,−34] origin-to-origin);
 *  - exhausted: the same berth plus the vehicle's authored exhausted still at
 *               the exact same dock offset (D-a; starter art has no such cell
 *               and its facts never name it);
 *  - reduced motion: the static intact berth and the vehicle's first frame.
 *
 * No departure/return playback, travel loop, gate effect or Wake attachment is
 * ever selected here; a presence change between refreshes simply re-rests. A
 * family or tier change is a different composition: the scene rebuilds. The
 * textures and the vehicle sprite are the ONLY things this controller touches:
 * the berth's seat, depth, hit area and footprint stay with the scene.
 */
import type Phaser from 'phaser';
import type { BoundCosmeticWakeCapture } from '@shardkeep/shared/boundCosmeticWakePresentation';
import type { FleetJourneyEvent } from '@shardkeep/shared/fleetJourneyPresentation';
import type { V2Ticker } from '../v2/ticker';
import type { MarketArtTable, MarketClip } from '../world/marketArt';
import {
  advancedDockedVehicleOffset, advancedVehicleArt,
  type AdvancedFleetArtTable, type AdvancedFleetFamily, type AdvancedFleetTier, type BerthInstallation,
} from '../world/advancedFleetArt';
import {
  BERTH_AMBIENT_CLIP, BERTH_INTACT_CLIP, FX_DEPARTURE_CLIP, FX_RETURN_CLIP, VEHICLE_DOCKED_CLIP, dockedVehicleOffset, starterFleetArtAvailable,
  type FleetClip, type StarterFleetArtTable, type TrackStep,
} from '../world/fleetArt';

export type BerthPresence = 'occupied' | 'away' | 'exhausted';

/** What one presented berth is composed of: its family's berth group and
 *  clips, and (for an installation) the named vehicle's group, clips and the
 *  ONE origin-to-origin dock offset from the berth seat. */
export interface BerthComposition {
  berthAtlas: string;
  intactClip: string;
  ambientClip: string;
  /** Frozen raid stills of the berth body (D-b). */
  damagedClip: string;
  destroyedClip: string;
  vehicle: null | {
    atlas: string;
    dockedClip: string;
    /** Authored exhausted still, or null for a family that has none (starter). */
    exhaustedClip: string | null;
    offset: readonly [number, number];
  };
  clips: Readonly<Record<string, FleetClip>>;
}

/** The P4 starter composition (byte-exact P4 behaviour), or null without art. */
export function starterComposition(art: StarterFleetArtTable): BerthComposition | null {
  const offset = dockedVehicleOffset(art);
  if (!starterFleetArtAvailable(art) || !offset) return null;
  return {
    berthAtlas: art.atlas, intactClip: BERTH_INTACT_CLIP, ambientClip: BERTH_AMBIENT_CLIP,
    damagedClip: 'pe_berth_starter_damaged', destroyedClip: 'pe_berth_starter_destroyed',
    vehicle: { atlas: art.atlas, dockedClip: VEHICLE_DOCKED_CLIP, exhaustedClip: null, offset },
    clips: art.clips,
  };
}

/** One advanced family at its applied tier, or null without that family/tier. */
export function advancedComposition(art: AdvancedFleetArtTable, family: AdvancedFleetFamily, tier: AdvancedFleetTier): BerthComposition | null {
  const berth = art.berths.get(family);
  const vehicle = advancedVehicleArt(art, family, tier);
  const offset = advancedDockedVehicleOffset(art, family, tier);
  if (!berth || !vehicle || !offset) return null;
  return {
    berthAtlas: berth.group, intactClip: `pe_berth_${family}_intact`, ambientClip: `pe_berth_${family}_ambient`,
    damagedClip: `pe_berth_${family}_damaged`, destroyedClip: `pe_berth_${family}_destroyed`,
    vehicle: { atlas: vehicle.group, dockedClip: `pe_veh_${family}_t${tier}_docked`, exhaustedClip: `pe_veh_${family}_t${tier}_exhausted`, offset },
    clips: art.clips,
  };
}

/** The composition a named installation selects from the two tables, or null
 *  when its family (and tier) is not admitted. */
export function berthCompositionFor(
  installation: BerthInstallation, starter: StarterFleetArtTable, advanced: AdvancedFleetArtTable,
): BerthComposition | null {
  return installation.family === 'starter'
    ? starterComposition(starter)
    : advancedComposition(advanced, installation.family, installation.tier);
}

/** Every group a composition draws from for a presence: the berth group, plus
 *  the vehicle group only when a vehicle is shown (occupied/exhausted). */
export function berthCompositionGroups(composition: BerthComposition, presence: BerthPresence): string[] {
  const groups = [composition.berthAtlas];
  if (presence !== 'away' && composition.vehicle && !groups.includes(composition.vehicle.atlas)) groups.push(composition.vehicle.atlas);
  return groups;
}

/* ------------------------------------------------------------------------- *
 * C5 — fleet journey consumer (owner D153.248: the Aurora Wake follows the
 * craft over the EXISTING authored one-second departure/return track).
 *
 * The scene receives ONE typed event (`@shardkeep/shared/fleetJourneyPresentation`,
 * root's frozen contract) per actual fresh departure (a committed insert) or
 * return (a settlement in the current protected read) from root's producer. Nothing here derives a journey from a presence poll, a receipt
 * read, a reload or a `created` flag; the key below is honoured once.
 * ------------------------------------------------------------------------- */

export type FleetJourneyKind = FleetJourneyEvent['kind'];

export const WAKE_OUTPUT_ID = 'aurora_wake';
export const WAKE_CLIP = 'pe_cos_wake';

export interface JourneyFx {
  atlas: string;
  clipId: string;
  clip: FleetClip;
  /** The authored reduced-motion still frame key (effects ship one), or null. */
  stillFrame: string | null;
  /** Authored effect seat in berth cell pixels (the family track's effectAttachmentPx). */
  attachmentPx: readonly [number, number];
}
export interface JourneyWake { atlas: string; clip: MarketClip }
/** One authored journey, selected from the installation's OWN family track. */
export interface JourneyPlan {
  kind: FleetJourneyKind;
  fps: number;
  steps: readonly TrackStep[];
  fx: JourneyFx | null;
  wake: JourneyWake | null;
}

interface JourneyTrack {
  fps: number;
  departure: readonly TrackStep[];
  return: readonly TrackStep[];
  sharedFxRef: string | null;
  effectAttachmentPx: readonly [number, number];
}

/** The plan `event` selects for `installation`, or null when the event does not
 *  belong to this installation (family/tier mismatch), its family has no admitted
 *  track, or a named gate effect is not admitted. The starter path is never
 *  reused for another family: each family's own track, offsets and effect seat. */
export function journeyPlanFor(
  event: FleetJourneyEvent,
  installation: BerthInstallation,
  starter: StarterFleetArtTable,
  advanced: AdvancedFleetArtTable,
  cosmetics: MarketArtTable,
): JourneyPlan | null {
  if (event.version !== 1 || (event.kind !== 'departure' && event.kind !== 'return')) return null;
  if (event.kind === 'return' && !event.returnId) return null;
  if (installation.family !== event.vehicle.family) return null;
  if (installation.family !== 'starter' && event.vehicle.family !== 'starter' && installation.tier !== event.vehicle.tier) return null;
  const track: JourneyTrack | null = installation.family === 'starter'
    ? starter.tracks
    : advanced.tracks.get(installation.family) ?? null;
  if (!track || track.fps <= 0) return null;
  const steps = event.kind === 'departure' ? track.departure : track.return;
  if (steps.length === 0) return null;
  let fx: JourneyFx | null = null;
  if (track.sharedFxRef) {
    // The shared gate effects are authored once and packed with the starter fleet.
    const clipId = event.kind === 'departure' ? FX_DEPARTURE_CLIP : FX_RETURN_CLIP;
    const clip = starter.clips[clipId];
    if (!clip || clip.frames.length === 0) return null;
    const still = clip.reducedMotionClip
      ? starter.clips[clip.reducedMotionClip]?.frames[0] ?? null
      : clip.frames[clip.reducedMotionFrame] ?? null;
    fx = { atlas: clip.atlas, clipId, clip, stillFrame: still, attachmentPx: track.effectAttachmentPx };
  }
  return { kind: event.kind, fps: track.fps, steps, fx, wake: journeyWakeFor(event.wake, cosmetics) };
}

/** The Wake this client may draw for the ORIGINAL frozen capture: only an
 *  `available` Aurora whose three hashes EQUAL the admitted binding, resolved to
 *  the packed clip. Legacy, unavailable, a foreign output or any hash
 *  disagreement draws no Wake (the journey itself still plays). */
function journeyWakeFor(capture: BoundCosmeticWakeCapture, cosmetics: MarketArtTable): JourneyWake | null {
  if (capture.state !== 'available' || !capture.visual.wake) return null;
  const appearance = capture.visual.wake;
  if (appearance.outputId !== WAKE_OUTPUT_ID) return null;
  const binding = cosmetics.bindings[appearance.outputId];
  if (!binding || binding.sha256 !== appearance.bindingSha256
    || binding.sourceManifestSha256 !== appearance.sourceManifestSha256
    || binding.sourceIndexSha256 !== appearance.sourceIndexSha256
    || !binding.clips.includes(WAKE_CLIP)) return null;
  const clip = cosmetics.clips[WAKE_CLIP];
  if (!clip || clip.frames.length === 0 || clip.fps <= 0) return null;
  return { atlas: clip.atlas, clip };
}

/** The presence an ACCEPTED journey event implies once it has played, or null when the
 *  current snapshot already carries the truth. A departure's originating snapshot
 *  necessarily still says occupied, so the event's 'away' outranks it until a
 *  genuinely newer snapshot, return or lifecycle fact arrives. A return arrives WITH
 *  its settlement: the current sibling already states the post-return fact
 *  (occupied, or exhausted after an advanced craft's last use), and that fact — never a
 *  pinned 'occupied' — is what rests at the dock. */
export function journeyOutcomePresence(kind: FleetJourneyKind): BerthPresence | null {
  return kind === 'departure' ? 'away' : null;
}

/** How long the authored journey is live on screen (eight steps at 8 fps = 1000 ms). */
export function journeyDurationMs(plan: JourneyPlan): number {
  return Math.round(plan.steps.length * 1000 / plan.fps);
}

/** Every group a journey draws from: the berth, its vehicle (shown even when the
 *  server already says away), the gate effect's and the Wake's groups. */
export function journeyPlanGroups(composition: BerthComposition, plan: JourneyPlan): string[] {
  const groups = [composition.berthAtlas];
  for (const group of [composition.vehicle?.atlas, plan.fx?.atlas, plan.wake?.atlas]) {
    if (group && !groups.includes(group)) groups.push(group);
  }
  return groups;
}

export interface BerthBuildingDeps {
  ticker: V2Ticker;
  composition: BerthComposition;
  presence: BerthPresence;
  /** Base ambience only. */
  restLoopSpeed?: number;
  /** prefers-reduced-motion: static intact berth, vehicle first frame. */
  reducedMotion?: boolean;
  /** Scene-owned sprite for the vehicle (non-interactive) on the given group. */
  addVehicle: (atlas: string) => Phaser.GameObjects.Sprite;
  /** Scene-owned, non-interactive sprite for a journey's gate effect or Wake on
   *  the given group (C5). Absent: the craft travels alone. */
  addEffect?: ((atlas: string) => Phaser.GameObjects.Sprite) | undefined;
}

/** Depth nudge that keeps the docked vehicle above its own berth without
 *  crossing the next structure row (rows are whole tiles apart). */
const VEHICLE_DEPTH_ABOVE_BERTH = 0.5;
/** The Wake trails the hull: over the berth water, under the craft. */
const WAKE_DEPTH_ABOVE_BERTH = 0.4;
/** The gate effect bursts over the craft. */
const EFFECT_DEPTH_ABOVE_BERTH = 0.6;

interface Journey {
  plan: JourneyPlan;
  step: number;
  wake: Phaser.GameObjects.Sprite | null;
  effect: Phaser.GameObjects.Sprite | null;
  onDone: (() => void) | undefined;
}

export class BerthBuildingFx {
  /** The berth group this controller keys from. */
  readonly atlas: string;
  private presence: BerthPresence;
  private vehicle: Phaser.GameObjects.Sprite | null = null;
  private vehicleClip: string | null = null;
  private damaged = false;
  private collapsed = false;
  private destroyed = false;
  private journey: Journey | null = null;

  constructor(
    private deps: BerthBuildingDeps,
    private berth: Phaser.GameObjects.Sprite,
  ) {
    this.atlas = deps.composition.berthAtlas;
    this.presence = deps.presence;
    this.rest();
  }

  /** Register one clip with the per-clip ticker. Statics (fps 0) and reduced
   *  motion display a single held frame; the ticker sets the texture itself. */
  private play(sprite: Phaser.GameObjects.Sprite, clipId: string, loop: boolean): boolean {
    const clip = this.deps.composition.clips[clipId];
    if (!clip || !sprite.active) return false;
    if (this.deps.reducedMotion || clip.fps <= 0) {
      const frame = clip.frames[clip.reducedMotionFrame] ?? clip.frames[0]!;
      this.deps.ticker.play(sprite, { atlas: clip.atlas, base: clipId, seq: [frame], fps: 0, loop: false });
      return true;
    }
    this.deps.ticker.play(sprite, {
      atlas: clip.atlas, base: clipId, seq: [...clip.frames],
      fps: clip.fps * (loop ? this.deps.restLoopSpeed ?? 1 : 1),
      loop,
    });
    return true;
  }

  /** The vehicle clip a presence shows, or null when none is shown. */
  private vehicleClipFor(presence: BerthPresence): string | null {
    const vehicle = this.deps.composition.vehicle;
    if (!vehicle || presence === 'away') return null;
    return presence === 'exhausted' ? vehicle.exhaustedClip : vehicle.dockedClip;
  }

  private rest(): void {
    if (this.destroyed || this.collapsed || !this.berth.active) return;
    this.restBerth();
    this.restVehicle();
    this.layout();
  }

  /** Berth: the authored damaged still below half HP (frozen raids), else the
   *  ambient loop (its frames carry the intact structure), the static intact
   *  cell under reduced motion or when the loop is absent. */
  private restBerth(): void {
    const { intactClip, ambientClip, damagedClip } = this.deps.composition;
    if (this.damaged) {
      this.play(this.berth, damagedClip, false);
    } else if (this.deps.reducedMotion || !this.play(this.berth, ambientClip, true)) {
      this.play(this.berth, intactClip, false);
    }
  }

  /** Vehicle: the presence's clip at the dock, or no vehicle at all. */
  private restVehicle(): void {
    const vehicle = this.deps.composition.vehicle;
    const clipId = this.vehicleClipFor(this.presence);
    if (clipId && vehicle) {
      if (!this.vehicle) this.vehicle = this.deps.addVehicle(vehicle.atlas);
      this.vehicleClip = clipId;
      if (!this.play(this.vehicle, clipId, this.presence === 'occupied')) this.dropVehicle();
    } else {
      this.dropVehicle();
    }
  }

  private dropVehicle(): void {
    this.vehicleClip = null;
    if (!this.vehicle) return;
    this.deps.ticker.unregister(this.vehicle);
    this.vehicle.destroy();
    this.vehicle = null;
  }

  /** The server's presence for this berth (a poll-observed or frozen fact, not a
   *  journey event). A journey in flight finishes first and then rests on the
   *  LATEST presence — the poll never yanks a departing craft back to the dock. */
  setPresence(presence: BerthPresence): void {
    if (this.presence === presence) return;
    this.presence = presence;
    // Reduced motion has no craft in flight (only the effect's held still): the
    // authored contract is an immediate transition, so rest at once.
    if (!this.journey || this.deps.reducedMotion) this.rest();
  }

  /** Frozen raid HP mirror (same rule as the M22/Market bodies): below half
   *  the berth rests on its authored damaged still; the vehicle stays (D-b). */
  setDamaged(damaged: boolean): void {
    if (this.damaged === damaged) return;
    this.damaged = damaged;
    if (this.journey) this.restBerth();
    else this.rest();
  }

  /** Frozen raid destruction: the berth rests on its authored destroyed still
   *  and the vehicle leaves with it (D-b); nothing re-rests afterwards. A
   *  journey in flight is cancelled with it. */
  collapse(): void {
    if (this.collapsed || this.destroyed) return;
    this.collapsed = true;
    this.dropJourney();
    this.dropVehicle();
    this.play(this.berth, this.deps.composition.destroyedClip, false);
  }

  /** True while an authored journey is being played. */
  get journeyActive(): boolean {
    return this.journey !== null;
  }

  /**
   * Play ONE authored journey (C5). The craft is translated from its dock by the
   * track's offsets AND opacity, one step per track frame through the existing
   * ticker (its docked frames cycle underneath — no in-base travel loop); the
   * Wake, when the plan admits one, is centred on the craft's contact and follows
   * the same offsets/opacity; the gate effect plays once at its authored berth
   * seat. When the track ends the controller rests on the LATEST presence — the
   * event's own outcome unless a newer presence fact arrived meanwhile. Under
   * reduced motion the authored contract applies: an immediate transition, no
   * movement, the effect's authored still for the track's duration, no Wake.
   * Returns false when nothing can be played (no vehicle art, collapsed, destroyed).
   */
  playJourney(plan: JourneyPlan, onDone?: () => void): boolean {
    const vehicle = this.deps.composition.vehicle;
    if (this.destroyed || this.collapsed || !this.berth.active || !vehicle) return false;
    const docked = this.deps.composition.clips[vehicle.dockedClip];
    if (!docked || docked.frames.length === 0 || plan.steps.length === 0 || plan.fps <= 0) return false;
    this.cancelJourney();
    // An accepted departure supersedes the originating snapshot's pre-journey presence:
    // without this it rested on the SAME stale 'occupied' and the craft reappeared at
    // the dock. A return keeps the CURRENT post-settlement presence (occupied or
    // exhausted). A newer presence fact (setPresence) still overrides either.
    const outcome = journeyOutcomePresence(plan.kind);
    if (outcome) this.presence = outcome;
    if (this.deps.reducedMotion) {
      this.rest();
      const effect = plan.fx?.stillFrame ? this.addEffect(plan.fx.atlas) : null;
      if (!effect || !plan.fx) {
        onDone?.();
        return true;
      }
      this.journey = { plan, step: plan.steps.length - 1, wake: null, effect, onDone };
      this.placeEffect(effect, plan.fx);
      this.deps.ticker.play(effect, {
        atlas: plan.fx.atlas, base: plan.fx.clipId, seq: plan.steps.map(() => plan.fx!.stillFrame!),
        fps: plan.fps, loop: false, onComplete: () => this.finishJourney(),
      });
      return true;
    }
    if (!this.vehicle) this.vehicle = this.deps.addVehicle(vehicle.atlas);
    this.vehicleClip = vehicle.dockedClip;
    const craft = this.vehicle;
    const wake = plan.wake ? this.addEffect(plan.wake.atlas) : null;
    const effect = plan.fx ? this.addEffect(plan.fx.atlas) : null;
    this.journey = { plan, step: 0, wake, effect, onDone };
    this.layout();
    // The docked loop entry must not absorb a look-alike one-shot ("identical —
    // keep playing"); the journey registers its own frame callbacks.
    this.deps.ticker.unregister(craft);
    this.deps.ticker.play(craft, {
      atlas: docked.atlas, base: vehicle.dockedClip,
      seq: plan.steps.map((_, index) => docked.frames[index % docked.frames.length]!),
      fps: plan.fps, loop: false,
      onFrame: (frame1) => this.applyJourneyStep(frame1 - 1),
      onComplete: () => this.finishJourney(),
    });
    if (wake && plan.wake) {
      const clip = plan.wake.clip;
      wake.setOrigin(clip.anchorPx[0] / clip.cellW, clip.anchorPx[1] / clip.cellH);
      this.deps.ticker.play(wake, {
        atlas: plan.wake.atlas, base: WAKE_CLIP,
        seq: plan.steps.map((_, index) => clip.frames[index % clip.frames.length]!),
        fps: plan.fps, loop: false,
      });
      this.applyJourneyStep(this.journey.step);
    }
    if (effect && plan.fx) {
      this.placeEffect(effect, plan.fx);
      const fx = plan.fx;
      this.deps.ticker.play(effect, {
        atlas: fx.atlas, base: fx.clipId, seq: [...fx.clip.frames], fps: fx.clip.fps, loop: false,
        onComplete: () => {
          if (this.journey?.effect === effect) this.journey.effect = null;
          this.deps.ticker.unregister(effect);
          effect.destroy();
        },
      });
    }
    return true;
  }

  /** Abandon a journey in flight (scene sleep, base change, incompatible facts)
   *  and rest on the latest presence. No callback: nothing finished. */
  cancelJourney(): void {
    if (!this.journey) return;
    this.dropJourney();
    this.rest();
  }

  private addEffect(atlas: string): Phaser.GameObjects.Sprite | null {
    return this.deps.addEffect?.(atlas) ?? null;
  }

  private placeEffect(effect: Phaser.GameObjects.Sprite, fx: JourneyFx): void {
    // The berth sprite's origin is its full-cell bottom pivot; the effect seat is
    // authored in the same cell pixels.
    const anchor = this.deps.composition.clips[this.deps.composition.intactClip]?.anchorPx ?? [0, 0];
    effect.setOrigin(fx.clip.anchorPx[0] / fx.clip.cellW, fx.clip.anchorPx[1] / fx.clip.cellH);
    effect.setScale(this.berth.scaleX, this.berth.scaleY);
    effect.setPosition(
      this.berth.x + (fx.attachmentPx[0] - anchor[0]) * this.berth.scaleX,
      this.berth.y + (fx.attachmentPx[1] - anchor[1]) * this.berth.scaleY,
    );
    effect.setDepth(this.berth.depth + EFFECT_DEPTH_ABOVE_BERTH);
    effect.setVisible(this.berth.visible);
    effect.setAlpha(this.berth.alpha);
  }

  /** Seat the craft (and its Wake) at the dock plus the step's authored offset,
   *  at the step's authored opacity. */
  private applyJourneyStep(index: number): void {
    const journey = this.journey;
    const craft = this.vehicle;
    const composition = this.deps.composition.vehicle;
    if (!journey || !craft || !composition) return;
    const step = journey.plan.steps[Math.min(Math.max(index, 0), journey.plan.steps.length - 1)]!;
    journey.step = index;
    const sx = this.berth.scaleX;
    const sy = this.berth.scaleY;
    const x = this.berth.x + (composition.offset[0] + step.offsetPx[0]) * sx;
    const y = this.berth.y + (composition.offset[1] + step.offsetPx[1]) * sy;
    const alpha = this.berth.alpha * step.opacity;
    craft.setPosition(x, y);
    craft.setAlpha(alpha);
    const wake = journey.wake;
    if (wake) {
      wake.setScale(sx, sy);
      wake.setPosition(x, y);
      wake.setDepth(this.berth.depth + WAKE_DEPTH_ABOVE_BERTH);
      wake.setVisible(this.berth.visible);
      wake.setAlpha(alpha);
    }
  }

  private finishJourney(): void {
    const journey = this.journey;
    if (!journey) return;
    this.dropJourney();
    // The LATEST presence decides what rests at the dock, not the event's implication.
    this.rest();
    journey.onDone?.();
  }

  private dropJourney(): void {
    const journey = this.journey;
    if (!journey) return;
    this.journey = null;
    for (const sprite of [journey.wake, journey.effect]) {
      if (!sprite) continue;
      this.deps.ticker.unregister(sprite);
      sprite.destroy();
    }
  }

  /** Follow the berth sprite: the vehicle sits at the composition's dock offset
   *  from the berth's seat and shares its scale, visibility and alpha, one nudge
   *  above it in depth; a journey in flight re-applies its current step and
   *  effect seat. Called by the scene whenever the berth is (re)positioned. */
  layout(): void {
    const vehicle = this.vehicle;
    const composition = this.deps.composition.vehicle;
    const clip = this.vehicleClip ? this.deps.composition.clips[this.vehicleClip] : undefined;
    if (vehicle && composition && clip) {
      vehicle.setOrigin(clip.anchorPx[0] / clip.cellW, clip.anchorPx[1] / clip.cellH);
      vehicle.setScale(this.berth.scaleX, this.berth.scaleY);
      vehicle.setPosition(this.berth.x + composition.offset[0] * this.berth.scaleX, this.berth.y + composition.offset[1] * this.berth.scaleY);
      vehicle.setDepth(this.berth.depth + VEHICLE_DEPTH_ABOVE_BERTH);
      vehicle.setVisible(this.berth.visible);
      vehicle.setAlpha(this.berth.alpha);
    }
    const journey = this.journey;
    if (!journey) return;
    if (journey.effect && journey.plan.fx) this.placeEffect(journey.effect, journey.plan.fx);
    if (!this.deps.reducedMotion) this.applyJourneyStep(journey.step);
  }

  destroy(): void {
    this.destroyed = true;
    this.dropJourney();
    this.deps.ticker.unregister(this.berth);
    this.dropVehicle();
  }
}
