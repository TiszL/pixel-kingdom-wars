package gg.pixelkingdomwars.nativeclient.renderer.globe2

import gg.pixelkingdomwars.nativeclient.renderer.world.FrameCost
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderKnobs
import gg.pixelkingdomwars.nativeclient.renderer.world.PassCost
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrameCost

/**
 * The flat globe's GPU cost model (GLOBE-NATIVE-PLAN §5.2 GlobeCost): texture fetches per fragment of each program
 * of the pinned `src/globe/flat.glsl.js`, per configuration, and the frame's [PassCost]s for [WorldFrameCost].
 *
 * Fetches per fragment (the shader text is counted against this table by `GlobeCostTest`):
 * - 'globe-flat' (full screen): on the sphere, albedo + sea/shore/glow (2), the cloud shadow and the cloud shell (2,
 *   with clouds on), the selection field (1, while something is selected). Sky fragments fetch nothing.
 * - 'globe-isles' (each island's padded quad: the 32 exploration islands, and the 3 Phase E islands' boxes when that
 *   layer is on, D-172): past the exact box test, the atlas (1 per box a pixel lies in), then on that island's land
 *   texels only the cloud shadow (1, clouds on) and the selection field (1, selected). Islands' land (a Phase E island's
 *   shallows halo included) never overlaps (D-165: ≥ 1° of open water between them), so a pixel pays the land reads
 *   once however many boxes cover it.
 * - 'globe-fx' (pixel squares): none.
 * - 'rm-lowres-blit' (ladder L2+ only, [renderScale] ½): the flat pass runs into a half-size target and this one bilinear
 *   read per screen px upscales it, so the flat pass pays a quarter of its fragments.
 * The budget is per canvas px of the whole globe frame: the flat pass plus [overlap] island boxes over one pixel (the
 * most boxes any pixel of the view lies in) and one island's land reads, ≤ [BUDGET_FETCHES] (plan §1.2). No
 * full-screen procedural noise.
 */
object GlobeCost {
    const val BUDGET_FETCHES = 12.0

    /** [scale]: the flat pass's target px per buffer px (1, or [HALF_SCALE] at ladder L2+). */
    class Config(val selection: Boolean, val clouds: Boolean, val scale: Double = 1.0) {
        override fun toString() = "selection=$selection clouds=$clouds scale=$scale"
    }

    /** The half-scale step's render scale and its upscale's reads per screen px. */
    const val HALF_SCALE = 0.5
    const val BLIT_FETCHES = 1

    /**
     * The flat pass's render scale at a ladder level (plan §5.4 globe column; fix pass): L0 and L1 draw the ray–sphere
     * pass at full scale; L2 and L3 draw it at ½ into the globe's own half-size target and upscale it, so L2 cuts the
     * motion frame (not only the idle animation) and every globe step cuts the modelled load by at least a fifth.
     */
    fun renderScale(knobs: LadderKnobs?): Double = if ((knobs?.level ?: 0) >= 2) HALF_SCALE else 1.0

    fun flatFetches(onSphere: Boolean, c: Config): Int = if (!onSphere) 0 else 2 + (if (c.clouds) 2 else 0) + (if (c.selection) 1 else 0)
    /** Per island box a pixel lies in: the atlas read. */
    const val ISLE_BOX_FETCHES = 1
    /** On the island's land texels (once per pixel): the cloud shadow and the selection field. */
    fun isleLandFetches(c: Config): Int = (if (c.clouds) 1 else 0) + (if (c.selection) 1 else 0)
    /** An island pixel's reads when it lies in one box and on its land (the per-fragment figure of the pass). */
    fun isleFetches(onLand: Boolean, c: Config): Int = ISLE_BOX_FETCHES + (if (onLand) isleLandFetches(c) else 0)

    /** The worst pixel: on the sphere, under [overlap] island boxes, on one island's land. */
    fun worstFetchesPerPx(c: Config, overlap: Int): Int = flatFetches(true, c) + overlap * ISLE_BOX_FETCHES + (if (overlap > 0) isleLandFetches(c) else 0)

    /** The configuration a ladder level draws (plan §5.4 globe column): L1 turns the cloud shell (and its shadow) off,
     *  L2 also halves the flat pass's scale. */
    fun config(knobs: LadderKnobs, selection: Boolean): Config = Config(selection, clouds = knobs.cloudShell, scale = renderScale(knobs))

    /**
     * The frame's passes for [WorldFrameCost.evaluate]: [sphere] is the fraction of the buffer the sphere covers,
     * [isleBoxes] the summed island box area over the buffer, [fxInstances] the drawn feature points. At a [Config.scale]
     * below 1 the flat passes are k× target passes (`onGround`: evaluate with `groundK = c.scale`, as [frame] does) and
     * the upscale is added. ALU is NaN (not measured: malioc is not installed, plan §4.5), which the frame cost reports as
     * unmodelled. The one globe model: the realm and whole-frame models take the globe's passes from here (Rule 7).
     */
    fun passes(c: Config, sphere: Double, isleBoxes: Double, fxInstances: Int): List<PassCost> {
        val low = c.scale < 1.0
        return listOfNotNull(
            PassCost("globe-flat-sphere", onGround = low, coverage = sphere, fetchesPerFragment = flatFetches(true, c).toDouble(), trilinear = true),
            PassCost("globe-flat-sky", onGround = low, coverage = 1 - sphere, fetchesPerFragment = 0.0),
            if (low) PassCost("globe-lowres-blit", coverage = 1.0, fetchesPerFragment = BLIT_FETCHES.toDouble()) else null,
            PassCost("globe-isles", coverage = isleBoxes, fetchesPerFragment = isleFetches(true, c).toDouble(), trilinear = true),
            PassCost("globe-fx", vertices = 6L * fxInstances, vsFetchesPerVertex = 0.0),
        )
    }

    /** The reference worst frame's island box area over the buffer: a placeholder until the device overlay measures it. */
    const val REFERENCE_ISLE_BOXES = 0.05

    /**
     * The globe's reference worst frame for the whole-frame and realm-map models (one model, Rule 7): zoomed in so the
     * sphere fills the buffer, a realm selected, island boxes over [REFERENCE_ISLE_BOXES] of it. [scaled] false prices
     * the sphere at full scale at every level (the dive/leave fades draw the globe without its half-scale step);
     * evaluate a scaled frame with `groundK = renderScale(knobs)`.
     */
    fun referencePasses(knobs: LadderKnobs, scaled: Boolean = true): List<PassCost> {
        val c = config(knobs, selection = true)
        return passes(if (scaled) c else Config(c.selection, c.clouds), 1.0, REFERENCE_ISLE_BOXES, 0)
    }

    fun frame(knobs: LadderKnobs, selection: Boolean, bufferW: Int, bufferH: Int, sphere: Double, isleBoxes: Double, fxInstances: Int): FrameCost {
        val c = config(knobs, selection)
        return WorldFrameCost.evaluate(passes(c, sphere, isleBoxes, fxInstances), bufferW, bufferH, c.scale, knobs.targetFps)
    }
}
