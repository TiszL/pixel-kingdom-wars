package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import com.badlogic.gdx.utils.JsonValue

/**
 * The classifier's configuration (web `classify.js` `CLASS_CFG` + `classConfig(realm.json.classes)`). These are the web
 * engine's presentation constants, ported with the code that reads them; the golden suite checks every value against the
 * pinned `CLASS_CFG` (a drifted copy fails there). None is a game number.
 *
 * `classConfig` merges an override object key by key; a nested object is merged into the default group, `null` clears a
 * nullable group (classWarp, lakeWarp, riverMeander, claimRag), and `slopeT: null` means +∞.
 */
class NoiseCfg(val period: Double, val amp: Double, val seed: Int) {
    fun merge(j: JsonValue) = NoiseCfg(j.num("period", period), j.num("amp", amp), j.seed("seed", seed))
}

class IslandCfg(
    val base: Double, val corner: Double, val lobe: Double, val amp: Double, val period: Double, val amp2: Double, val period2: Double,
    val zig: Double, val zigCell: Double, val slope: Double, val shallow: Double, val shallowPeriod: Double, val k: Double, val seed: Int,
    val halo: Double, val haloFade: Double, val haloDeep: Double,
) {
    fun merge(j: JsonValue) = IslandCfg(j.num("base", base), j.num("corner", corner), j.num("lobe", lobe), j.num("amp", amp), j.num("period", period),
        j.num("amp2", amp2), j.num("period2", period2), j.num("zig", zig), j.num("zigCell", zigCell), j.num("slope", slope), j.num("shallow", shallow),
        j.num("shallowPeriod", shallowPeriod), j.num("k", k), j.seed("seed", seed), j.num("halo", halo), j.num("haloFade", haloFade), j.num("haloDeep", haloDeep))
}

class BendCfg(val clear: Double, val taper: Double, val taperK: Double, val iters: Int, val seed: Int) {
    fun merge(j: JsonValue) = BendCfg(j.num("clear", clear), j.num("taper", taper), j.num("taperK", taperK), j.num("iters", iters.toDouble()).toInt(), j.seed("seed", seed))
}

class ParcelCfg(val block: Int, val min: Int, val max: Int, val salt: Int) {
    fun merge(j: JsonValue) = ParcelCfg(j.num("block", block.toDouble()).toInt(), j.num("min", min.toDouble()).toInt(), j.num("max", max.toDouble()).toInt(), j.seed("salt", salt))
}

class ClearingCfg(val extra: Double, val corner: Double, val lobe: Double, val amp: Double, val period: Double, val amp2: Double, val period2: Double,
                  val seed: Int, val seed2: Int) {
    fun merge(j: JsonValue) = ClearingCfg(j.num("extra", extra), j.num("corner", corner), j.num("lobe", lobe), j.num("amp", amp), j.num("period", period),
        j.num("amp2", amp2), j.num("period2", period2), j.seed("seed", seed), j.seed("seed2", seed2))
}

class ApronCfg(val min: Double, val amp: Double, val period: Double, val seed: Int, val feather: Double) {
    fun merge(j: JsonValue) = ApronCfg(j.num("min", min), j.num("amp", amp), j.num("period", period), j.seed("seed", seed), j.num("feather", feather))
}

class RagCfg(val amp: Double, val period: Double, val seed: Int) {
    fun merge(j: JsonValue) = RagCfg(j.num("amp", amp), j.num("period", period), j.seed("seed", seed))
}

class WarpCfg(val amp: Double, val period: Double, val amp2: Double, val period2: Double, val amp3: Double, val cell3: Double, val zig: Double,
              val zigCell: Double, val seed: Int) {
    fun merge(j: JsonValue) = WarpCfg(j.num("amp", amp), j.num("period", period), j.num("amp2", amp2), j.num("period2", period2), j.num("amp3", amp3),
        j.num("cell3", cell3), j.num("zig", zig), j.num("zigCell", zigCell), j.seed("seed", seed))
}

class MeanderCfg(val amp: Double, val period: Double, val amp2: Double, val period2: Double, val hw: Double, val hwPeriod: Double, val step: Double, val seed: Int) {
    fun merge(j: JsonValue) = MeanderCfg(j.num("amp", amp), j.num("period", period), j.num("amp2", amp2), j.num("period2", period2), j.num("hw", hw),
        j.num("hwPeriod", hwPeriod), j.num("step", step), j.seed("seed", seed))
}

class LakeWarpCfg(val amp: Double, val period: Double, val amp2: Double, val period2: Double, val seed: Int) {
    fun merge(j: JsonValue) = LakeWarpCfg(j.num("amp", amp), j.num("period", period), j.num("amp2", amp2), j.num("period2", period2), j.seed("seed", seed))
}

class BridgeCfg(val max: Double, val w: Double, val wAdd: Double, val head: Double, val wob: Double, val wobPeriod: Double, val taper: Double,
                val dirs: Int, val k: Double, val seed: Int) {
    fun merge(j: JsonValue) = BridgeCfg(j.num("max", max), j.num("w", w), j.num("wAdd", wAdd), j.num("head", head), j.num("wob", wob),
        j.num("wobPeriod", wobPeriod), j.num("taper", taper), j.num("dirs", dirs.toDouble()).toInt(), j.num("k", k), j.seed("seed", seed))
}

class ClassCfg(
    val coastNoise: NoiseCfg, val coastNoise2: NoiseCfg, val inlandNoise: NoiseCfg, val beachNoise: NoiseCfg,
    val coastK: Double, val inlandK: Double, val force: Double, val rimGap: Double,
    val island: IslandCfg, val bend: BendCfg,
    val deepT: Double, val beachW: Double, val hasShore: Boolean,
    val rockT: Double, val slopeT: Double, val slopeStep: Double, val snowT: Double,
    val rockWaterGap: Double, val rockPlotGap: Double, val roadInland: Double, val roadCoast: Double,
    val fieldT: Double, val forestT: Double, val specialT: Double, val g2T: Double,
    val parcel: ParcelCfg, val plotMargin: Double, val cornerRadius: Double, val ringNoise: NoiseCfg,
    val clearing: ClearingCfg, val apron: ApronCfg, val claimRag: RagCfg?, val classWarp: WarpCfg?, val warpFine: Double,
    val riverMeander: MeanderCfg?, val lakeWarp: LakeWarpCfg?, val bridge: BridgeCfg,
    val riverNoiseReach: Double, val far: Double,
) {
    /** classify.js `latticeCfg`: the MAP lattice resolves with the class warp's fine octave off (G11). */
    fun lattice(): ClassCfg = if (warpFine == 0.0) this else copy(warpFine = 0.0)

    fun copy(warpFine: Double = this.warpFine, hasShore: Boolean = this.hasShore) = ClassCfg(coastNoise, coastNoise2, inlandNoise, beachNoise, coastK,
        inlandK, force, rimGap, island, bend, deepT, beachW, hasShore, rockT, slopeT, slopeStep, snowT, rockWaterGap, rockPlotGap, roadInland, roadCoast,
        fieldT, forestT, specialT, g2T, parcel, plotMargin, cornerRadius, ringNoise, clearing, apron, claimRag, classWarp, warpFine, riverMeander,
        lakeWarp, bridge, riverNoiseReach, far)

    companion object {
        /** classify.js `CLASS_CFG` at the pin (every value checked by the golden suite). */
        val DEFAULT = ClassCfg(
            coastNoise = NoiseCfg(20.0, 3.0, 0x1c0a), coastNoise2 = NoiseCfg(7.0, 2.2, 0x7c33),
            inlandNoise = NoiseCfg(9.0, 1.0, 0x1a4e), beachNoise = NoiseCfg(8.0, 1.6, 0x2b17),
            coastK = 8.0, inlandK = 2.0, force = 3.0, rimGap = 0.0,
            island = IslandCfg(base = 4.0, corner = 12.0, lobe = 9.0, amp = 3.5, period = 11.0, amp2 = 2.0, period2 = 5.0, zig = 1.2, zigCell = 3.0,
                slope = 2.0, shallow = 0.8, shallowPeriod = 17.0, k = 4.0, seed = 0x71c3, halo = 10.0, haloFade = 8.0, haloDeep = 300.0),
            bend = BendCfg(clear = 1.5, taper = 26.0, taperK = 2.0, iters = 3, seed = 0x3b5d),
            deepT = 12.0, beachW = 2.0, hasShore = false,
            rockT = 0.5, slopeT = Double.POSITIVE_INFINITY, slopeStep = 6.0, snowT = 0.5,
            rockWaterGap = 2.0, rockPlotGap = 2.0, roadInland = 2.0, roadCoast = 3.0,
            fieldT = 0.5, forestT = 0.5, specialT = 0.5, g2T = 0.5,
            parcel = ParcelCfg(block = 28, min = 10, max = 18, salt = 0x9a3c),
            plotMargin = 2.0, cornerRadius = 3.0, ringNoise = NoiseCfg(9.0, 3.0, 0x5b1e),
            clearing = ClearingCfg(extra = 4.0, corner = 10.0, lobe = 4.0, amp = 2.0, period = 9.0, amp2 = 5.0, period2 = 4.0, seed = 0x5b1e, seed2 = 0x3c71),
            apron = ApronCfg(min = 1.0, amp = 1.5, period = 7.0, seed = 0x2e9d, feather = 2.0),
            claimRag = RagCfg(amp = 2.2, period = 5.0, seed = 0x6e21),
            classWarp = WarpCfg(amp = 12.0, period = 44.0, amp2 = 4.0, period2 = 14.0, amp3 = 2.0, cell3 = 6.0, zig = 1.6, zigCell = 5.0, seed = 0x3a91),
            warpFine = 1.0,
            riverMeander = MeanderCfg(amp = 2.6, period = 26.0, amp2 = 1.0, period2 = 9.0, hw = 0.3, hwPeriod = 21.0, step = 5.0, seed = 0x6b2d),
            lakeWarp = LakeWarpCfg(amp = 5.0, period = 29.0, amp2 = 2.6, period2 = 11.0, seed = 0x5e11),
            bridge = BridgeCfg(max = 30.0, w = 4.0, wAdd = 2.0, head = 1.6, wob = 1.2, wobPeriod = 5.0, taper = 0.35, dirs = 24, k = 3.0, seed = 0x4d3b),
            riverNoiseReach = 2.0, far = 1e4,
        )

        /** classify.js `classConfig(over)`: [over] is `realm.json` `classes` (null or absent = the defaults). */
        fun from(over: JsonValue?): ClassCfg {
            val d = DEFAULT
            if (over == null || !over.isObject) return d
            fun grp(name: String) = over.get(name)
            fun cleared(name: String) = over.has(name) && over.get(name).isNull
            fun n(name: String, def: Double) = over.num(name, def)
            val slope = if (over.has("slopeT") && over.get("slopeT").isNull) Double.POSITIVE_INFINITY else n("slopeT", d.slopeT)
            return ClassCfg(
                coastNoise = grp("coastNoise")?.takeIf { it.isObject }?.let { d.coastNoise.merge(it) } ?: d.coastNoise,
                coastNoise2 = grp("coastNoise2")?.takeIf { it.isObject }?.let { d.coastNoise2.merge(it) } ?: d.coastNoise2,
                inlandNoise = grp("inlandNoise")?.takeIf { it.isObject }?.let { d.inlandNoise.merge(it) } ?: d.inlandNoise,
                beachNoise = grp("beachNoise")?.takeIf { it.isObject }?.let { d.beachNoise.merge(it) } ?: d.beachNoise,
                coastK = n("coastK", d.coastK), inlandK = n("inlandK", d.inlandK), force = n("force", d.force),
                rimGap = grp("rim")?.takeIf { it.isObject }?.num("gap", d.rimGap) ?: d.rimGap,
                island = grp("island")?.takeIf { it.isObject }?.let { d.island.merge(it) } ?: d.island,
                bend = grp("bend")?.takeIf { it.isObject }?.let { d.bend.merge(it) } ?: d.bend,
                deepT = n("deepT", d.deepT), beachW = n("beachW", d.beachW),
                hasShore = if (over.has("hasShore")) truthy(over.get("hasShore")) else d.hasShore,
                rockT = n("rockT", d.rockT), slopeT = slope, slopeStep = n("slopeStep", d.slopeStep), snowT = n("snowT", d.snowT),
                rockWaterGap = n("rockWaterGap", d.rockWaterGap), rockPlotGap = n("rockPlotGap", d.rockPlotGap),
                roadInland = n("roadInland", d.roadInland), roadCoast = n("roadCoast", d.roadCoast),
                fieldT = n("fieldT", d.fieldT), forestT = n("forestT", d.forestT), specialT = n("specialT", d.specialT), g2T = n("g2T", d.g2T),
                parcel = grp("parcel")?.takeIf { it.isObject }?.let { d.parcel.merge(it) } ?: d.parcel,
                plotMargin = n("plotMargin", d.plotMargin), cornerRadius = n("cornerRadius", d.cornerRadius),
                ringNoise = grp("ringNoise")?.takeIf { it.isObject }?.let { d.ringNoise.merge(it) } ?: d.ringNoise,
                clearing = grp("clearing")?.takeIf { it.isObject }?.let { d.clearing.merge(it) } ?: d.clearing,
                apron = grp("apron")?.takeIf { it.isObject }?.let { d.apron.merge(it) } ?: d.apron,
                claimRag = if (cleared("claimRag")) null else grp("claimRag")?.takeIf { it.isObject }?.let { d.claimRag!!.merge(it) } ?: d.claimRag,
                classWarp = if (cleared("classWarp")) null else grp("classWarp")?.takeIf { it.isObject }?.let { d.classWarp!!.merge(it) } ?: d.classWarp,
                warpFine = n("warpFine", d.warpFine),
                riverMeander = if (cleared("riverMeander")) null else grp("riverMeander")?.takeIf { it.isObject }?.let { d.riverMeander!!.merge(it) } ?: d.riverMeander,
                lakeWarp = if (cleared("lakeWarp")) null else grp("lakeWarp")?.takeIf { it.isObject }?.let { d.lakeWarp!!.merge(it) } ?: d.lakeWarp,
                bridge = grp("bridge")?.takeIf { it.isObject }?.let { d.bridge.merge(it) } ?: d.bridge,
                riverNoiseReach = n("riverNoiseReach", d.riverNoiseReach), far = n("far", d.far),
            )
        }

        private fun truthy(v: JsonValue): Boolean = when {
            v.isNull -> false
            v.isBoolean -> v.asBoolean()
            v.isNumber -> v.asDouble().let { it != 0.0 && !it.isNaN() }
            v.isString -> v.asString().isNotEmpty()
            else -> true
        }
    }
}

internal fun JsonValue.num(name: String, def: Double): Double {
    val v = get(name) ?: return def
    return if (v.isNumber) v.asDouble() else def
}

/** A seed: an integer as the web keeps it (`seed >>> 0` / `Math.imul` read its low 32 bits). */
internal fun JsonValue.seed(name: String, def: Int): Int {
    val v = get(name) ?: return def
    return if (v.isNumber) GroundMath.toInt32(v.asDouble()) else def
}
