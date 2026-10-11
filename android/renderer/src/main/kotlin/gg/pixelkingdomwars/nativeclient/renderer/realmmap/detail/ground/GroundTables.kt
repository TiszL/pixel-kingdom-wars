package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Classes
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPlotRules

/**
 * The integer / float tables ground.js builds on the CPU and hands its programs as uniforms: the rm-map noise bank, the
 * MAP slot tables, the TRUE record tables, the plot rows. Pure, built once per realm on the load worker; the golden
 * suite checks each against the pinned `ground.js` / `classify.js` output for every realm pack.
 */
object GroundTables {
    /**
     * ground.js `mapNoiseTable(cfg)`: rm-map's 28 noise slots (`uMpNz[28]`: period, seed as int32 bits, group, 0) — the
     * same period and seed each of P0's call sites passed. Groups: 1 class-edge warp, 2 shore, 4 water, 8 islet, 16 plot,
     * 32 claim, 64 foreign fade.
     */
    fun mapNoise(c: ClassCfg): IntArray {
        val lw = c.lakeWarp; val i = ClassCfg.DEFAULT.island; val br = c.bridge; val cl = c.clearing; val ap = c.apron
        fun u(x: Int, k: Int = 0) = x + k
        val s = arrayOf(
            doubleArrayOf(14.0, 0x7a13.toDouble(), 1.0), doubleArrayOf(14.0, 0x19c5.toDouble(), 1.0), doubleArrayOf(5.0, 0x4e2b.toDouble(), 1.0),
            doubleArrayOf(5.0, 0x6d07.toDouble(), 1.0), doubleArrayOf(11.0, 0x61b3.toDouble(), 1.0), doubleArrayOf(5.0, 0x2f71.toDouble(), 1.0),
            doubleArrayOf(lw?.period ?: 1.0, u(lw?.seed ?: 0, 0).toDouble(), 2.0), doubleArrayOf(lw?.period ?: 1.0, u(lw?.seed ?: 0, 1).toDouble(), 2.0),
            doubleArrayOf(lw?.period2 ?: 1.0, u(lw?.seed ?: 0, 2).toDouble(), 2.0), doubleArrayOf(lw?.period2 ?: 1.0, u(lw?.seed ?: 0, 3).toDouble(), 2.0),
            doubleArrayOf(c.coastNoise.period, c.coastNoise.seed.toDouble(), 2.0), doubleArrayOf(c.coastNoise2.period, c.coastNoise2.seed.toDouble(), 2.0),
            doubleArrayOf(c.inlandNoise.period, c.inlandNoise.seed.toDouble(), 4.0), doubleArrayOf(c.beachNoise.period, c.beachNoise.seed.toDouble(), 4.0),
            doubleArrayOf(i.period, u(i.seed, 0).toDouble(), 8.0), doubleArrayOf(i.period2, u(i.seed, 1).toDouble(), 8.0),
            doubleArrayOf(truncate(i.shallowPeriod), u(i.seed, 3).toDouble(), 8.0),
            doubleArrayOf(br.wobPeriod, br.seed.toDouble(), 16.0), doubleArrayOf(cl.period, cl.seed.toDouble(), 16.0), doubleArrayOf(ap.period, ap.seed.toDouble(), 16.0),
            doubleArrayOf(5.0, 0x6e21.toDouble(), 32.0),
            doubleArrayOf(48.0, 0x6f13.toDouble(), 64.0), doubleArrayOf(20.0, 0x1d27.toDouble(), 64.0), doubleArrayOf(7.0, 0x4f1d.toDouble(), 64.0), doubleArrayOf(3.0, 0x2a77.toDouble(), 64.0),
            doubleArrayOf(2.0, 0x5d19.toDouble(), 1.0), doubleArrayOf(i.zigCell, u(i.seed, 2).toDouble(), 8.0), doubleArrayOf(cl.period2, cl.seed2.toDouble(), 16.0),
        )
        val t = IntArray(28 * 4)
        for ((k, e) in s.withIndex()) {
            t[k * 4] = maxOf(1, GroundMath.toInt32(e[0])); t[k * 4 + 1] = GroundMath.toInt32(e[1]); t[k * 4 + 2] = e[2].toInt(); t[k * 4 + 3] = 0
        }
        return t
    }

    private fun truncate(x: Double) = if (x < 0) kotlin.math.ceil(x) else kotlin.math.floor(x)

    /** `uRmPlot[21]`: per keep level L (1…20) [claim, ring, half, R] at L·4 (ground.js setFieldUniforms). */
    fun plotRows(cls: Classify): FloatArray {
        val out = FloatArray(21 * 4)
        for (lv in 1..minOf(20, cls.plots.maxLevel)) { val g = cls.plotGeom(lv); out[lv * 4] = g.claim.toFloat(); out[lv * 4 + 1] = g.ring.toFloat(); out[lv * 4 + 2] = g.half.toFloat(); out[lv * 4 + 3] = g.r.toFloat() }
        return out
    }

    /** `uRmRoom4[6]` (ground.js ROOM4): the G8 offset room per level at index L. */
    fun room4(plots: RealmPlotRules): IntArray = IntArray(24).also { for (lv in 1..minOf(20, plots.maxLevel)) it[lv] = plots.room(lv) }

    /** ground.js `mapTables()`: the MAP band's slot tables, or null when realm.json has no `map.families`. */
    class MapTables(val table: BandTable, val lg: LegaliseTables, val terr: IntArray, val order: IntArray, val wild: String, val obst: Int, val clr: Int)

    fun mapTables(meta: JsonValue): MapTables? {
        val m = meta.get("map") ?: return null
        if (m.get("families") == null) return null
        val table = BandTable.map(m)
        val wild = m.getString("wild")
        fun slotOf(t: String?): Int = if (t == wild) 0 else if (t != null && Regex("^M[1-5]$").matches(t)) t[1] - '0' else 0
        val terr = IntArray(ClassNames.COUNT) { slotOf(table.terrainOf[it]) }
        val lo = m.get("layerOrder")
        val order = if (lo != null && lo.isArray) IntArray(lo.size) { lo.get(it).asString().substring(1).toIntOrNull() ?: 0 } else intArrayOf(5, 2, 1, 3, 4)
        var obst = 0; var ground = 0; var own = 0
        val obstacles = intArrayOf(Classes.FIELD, Classes.FOREST, Classes.SPECIAL, Classes.ROCK, Classes.SNOW)
        for (c in obstacles) obst = obst or (1 shl terr[c])
        for (c in intArrayOf(Classes.WILD, Classes.GROUND2, Classes.SHORE, Classes.ROAD)) ground = ground or (1 shl terr[c])
        val t2t = meta.get("true")?.get("classToTerrain")
        val wildT = t2t?.get("WILD")?.takeIf { it.isString }?.asString()
        for (c in obstacles) {
            val name = ClassNames.NAMES_IN_KEY_ORDER.firstOrNull { ClassNames.BY_NAME[it] == c }
            val mine = name?.let { t2t?.get(it) }?.takeIf { it.isString }?.asString()
            if (wildT == null || wildT.isEmpty() || mine != wildT) own = own or (1 shl terr[c])
        }
        obst = obst and ground.inv() and 1.inv()
        return MapTables(table, LegaliseTables.of(table), terr, order, wild, obst, obst and own.inv())
    }

    /** One water loop (realm.json `true.water` / `waterByClass`): first layer (global), frames, frame ms, phases, and the
     *  frames between its open-water phases (stage B [waterPhaseStep]: `uTgWater.w` / `uTgWater2.w`). */
    class WaterLoop(val first: Int, val frames: Int, val frameMs: Int, val phases: Int, val step: Int)

    /** ground.js trueSetup's tables. [off] = 1 unless the atlas reserves layer 0 itself (`atlas.reserved0`). */
    class TrueTables(val table: BandTable, val lg: LegaliseTables, val pair: IntArray, val famU: IntArray, val pure: IntArray, val layer: IntArray,
                     val terr: IntArray, val decalOf: IntArray, val groups: IntArray, val salts: IntArray, val water: WaterLoop, val inland: WaterLoop,
                     val off: Int, val waterSeaFirstPack: Int, val waterInlandFirstPack: Int)

    fun trueTables(meta: JsonValue): TrueTables? {
        val t = meta.get("true") ?: return null
        val a = t.get("atlas") ?: return null
        val off = if (a.get("reserved0")?.let { it.isBoolean && it.asBoolean() } == true) 0 else 1
        val terrIds = ArrayList<String>()
        var e = t.get("terrains")?.child
        while (e != null) { terrIds += e.getString("id"); e = e.next }
        fun ti(id: String?): Int { val i = if (id == null) -1 else terrIds.indexOf(id); return if (i < 0) 15 else i }
        val table = BandTable.trueBand(t)
        val pair = IntArray(256) { -1 }
        val famU = IntArray(48 * 4)
        var s = 0
        var f = t.get("families")?.child
        while (f != null) {
            val lo = ti(f.getString("lower", null)); val up = ti(f.getString("upper", null))
            pair[lo * 16 + up] = s; pair[up * 16 + lo] = s
            if (s < 48) { famU[s * 4] = f.getInt("first", 0) + off; famU[s * 4 + 1] = up; famU[s * 4 + 2] = lo; famU[s * 4 + 3] = 0 }
            s++; f = f.next
        }
        val pure = IntArray(16 * 4); val layer = IntArray(16) { 99 }
        var i = 0; e = t.get("terrains")?.child
        while (e != null) {
            if (i < 16) {
                val p = e.get("pure")
                val p0 = p?.takeIf { it.isArray && it.size > 0 }?.get(0)?.asInt() ?: 0
                val p1 = p?.takeIf { it.isArray && it.size > 1 }?.get(1)?.asInt() ?: 1
                pure[i * 4] = p0 + off; pure[i * 4 + 1] = maxOf(1, p1); pure[i * 4 + 2] = if (e.getString("kind", "") == "water") 1 else 0; pure[i * 4 + 3] = 0
                layer[i] = GroundMath.jsRound((e.get("layer")?.takeIf { it.isNumber }?.asDouble() ?: 1.0) * 10).toInt()
            }
            i++; e = e.next
        }
        val terr = IntArray(14) { 15 }
        var c = t.get("classToTerrain")?.child
        while (c != null) { val id = ClassNames.BY_NAME[c.name]; if (id != null && c.isString && c.asString().isNotEmpty()) terr[id] = ti(c.asString()); c = c.next }
        val decalOf = IntArray(14); val groups = IntArray(8 * 4); val salts = IntArray(8 * 2)
        var k = 0; var g = t.get("decalGroups")?.child
        while (g != null && k < 8) {
            ClassNames.BY_NAME[g.getString("class", "")]?.let { decalOf[it] = k + 1 }
            val salt = g.get("salt")?.takeIf { it.isNumber }?.asInt() ?: k
            groups[k * 4] = GroundMath.jsRound(g.getDouble("density", 0.0) * 10000).toInt(); groups[k * 4 + 1] = g.getInt("first", 0); groups[k * 4 + 2] = g.getInt("count", 1); groups[k * 4 + 3] = 0
            salts[k * 2] = ((salt + 1) * 0x9e37) xor 0x5a5a; salts[k * 2 + 1] = ((salt + 1) * 0x7f4a) xor 0x3c3c
            k++; g = g.next
        }
        // (stage B: each loop's phase step comes from the loop object ground.js picked, the default one included — so a loop
        // is parsed together with its JSON; JS `??` passes over a JSON null as well as an absent key)
        fun loop(j: JsonValue?, def: WaterLoop): WaterLoop = if (j == null || !j.isObject) def else
            WaterLoop(j.getInt("first", def.first), j.getInt("frames", def.frames), j.getInt("frameMs", def.frameMs), j.getInt("phases", def.phases), waterPhaseStep(j))
        val w = loop(nn(t.get("water")), WaterLoop(0, 8, 200, 4, waterPhaseStep(null)))
        val wbc = nn(t.get("waterByClass"))
        val wSea = loop(nn(wbc?.get("SEA")) ?: nn(wbc?.get("DEEP")), w); val wIn = loop(nn(wbc?.get("WATER")), w)
        return TrueTables(table, LegaliseTables.of(table), pair, famU, pure, layer, terr, decalOf, groups, salts,
            WaterLoop(wSea.first + off, wSea.frames, wSea.frameMs, wSea.phases, wSea.step), WaterLoop(wIn.first + off, wIn.frames, wIn.frameMs, wIn.phases, wIn.step), off, wSea.first, wIn.first)
    }

    /** JavaScript `v ?? …`: a JSON null reads as absent. */
    private fun nn(v: JsonValue?): JsonValue? = if (v == null || v.isNull) null else v

    // ---------------------------------------------------------------- stage B (ground.js c87af40d, 36956b3d, f3cbda55, 2d134d40)

    /** ground.js `FAM_CLAMP`: the MAP family grade's per-channel range for the three realms whose MAP art is far darker than
     *  their paintings (at GA2-05's 1.8 their d 48 hand-over left ΔE up to 22.4), and [FAM_CLAMP0] for every other realm. */
    val FAM_CLAMP: Map<String, DoubleArray> = mapOf("elderwood" to doubleArrayOf(0.6, 2.4), "thornwake" to doubleArrayOf(0.6, 2.4), "seeker-reach" to doubleArrayOf(0.6, 2.4))
    val FAM_CLAMP0 = doubleArrayOf(0.6, 1.8)
    /** ground.js `WATER_GEMS`: the share of MAP sea cells lit by a gem sparkle (Solana Reach's gem sea); every other realm off. */
    val WATER_GEMS: Map<String, Double> = mapOf("seeker-reach" to 0.03)
    /** ground.js `GEM_D`: the MAP gem sparkle grows in over this d range (log d; the painting at FAR has none). */
    const val GEM_D0 = 48.0
    const val GEM_D1 = 150.0
    /** ground.js `GEM_HL`: TRUE's depth tint eases off loop texels above this luma in a gem-sea realm (fix pass #5). */
    const val GEM_HL = 0.45

    private fun idOf(meta: JsonValue?): String? = meta?.get("id")?.takeIf { it.isString }?.asString()
    /** JavaScript `Number.isFinite(v)`: a JSON number that is finite (a string never is). */
    private fun finite(v: JsonValue?): Double? = v?.takeIf { it.isNumber }?.asDouble()?.takeIf { it.isFinite() }
    /** JavaScript `+v` of a key (an absent key is `undefined`: NaN). */
    private fun num(o: JsonValue?, key: String): Double = o?.get(key)?.let { Classify.jsNumber(it) } ?: Double.NaN

    /** ground.js `waterGems(meta)`: realm.json `map.waterGems` (a finite number in 0…0.2), else [WATER_GEMS], else 0 (off). */
    fun waterGems(meta: JsonValue?): Double {
        val o = finite(meta?.get("map")?.get("waterGems"))
        return if (o != null && o >= 0 && o <= 0.2) o else WATER_GEMS[idOf(meta)] ?: 0.0
    }

    /** ground.js `famClamp(meta)`: realm.json `map.famClamp` (two finite numbers, 0 < lo < 1 < hi ≤ 4), else [FAM_CLAMP], else
     *  [FAM_CLAMP0]. → [lo, hi] (a fresh array). */
    fun famClamp(meta: JsonValue?): DoubleArray {
        val o = meta?.get("map")?.get("famClamp")
        if (o != null && o.isArray && o.size == 2) {
            val lo = finite(o.get(0)); val hi = finite(o.get(1))
            if (lo != null && hi != null && lo > 0 && lo < 1 && hi > 1 && hi <= 4) return doubleArrayOf(lo, hi)
        }
        return (FAM_CLAMP[idOf(meta)] ?: FAM_CLAMP0).copyOf()
    }

    /**
     * ground.js `waterPhaseStep(w)`: frames between the TRUE water loop's open-water phases (the record's 2-bit phase × this).
     * The loop's `phaseStep` when it is a positive integer (Solana Reach's 16-frame gem loop: 4), else floor(frames / phases)
     * (the 8-frame loops: 2), clamped to 1…frames. JS coercion as the web: `frames | 0 || 8`, `phases | 0 || 4` (a numeric
     * string counts, a fraction truncates), `Number.isInteger(phaseStep)` (a string or 2.5 does not). [w] null = absent.
     */
    fun waterPhaseStep(w: JsonValue?): Int {
        val f = maxOf(1, GroundMath.toInt32(num(w, "frames")).let { if (it == 0) 8 else it })
        val ph = maxOf(1, GroundMath.toInt32(num(w, "phases")).let { if (it == 0) 4 else it })
        val ps = finite(w?.get("phaseStep"))
        val s = if (ps != null && ps == kotlin.math.floor(ps) && ps > 0) ps else kotlin.math.floor(f.toDouble() / ph)
        return GroundMath.clamp(s, 1.0, f.toDouble()).toInt()
    }

    /** ground.js `gemDrift(w)`: the MAP gem drift in map art px per second from a water loop (`drift` = kit px a frame, 7 kit px
     *  per map art px): [drift x, drift y] × 1000 / frameMs / 7 when the loop has a 2-long drift and frameMs > 0, else 0, 0. */
    fun gemDrift(w: JsonValue?): DoubleArray {
        val d = w?.get("drift"); val fm = num(w, "frameMs")
        if (d == null || !d.isArray || d.size != 2 || !(fm > 0)) return doubleArrayOf(0.0, 0.0)
        return DoubleArray(2) { Classify.jsNumber(d.get(it)) * 1000 / fm / 7 }
    }

    /** The loop ground.js drawMap takes the gem drift from: `meta.true?.waterByClass?.SEA ?? meta.true?.water` (not DEEP). */
    fun gemDriftLoop(meta: JsonValue?): JsonValue? { val t = meta?.get("true"); return nn(nn(t?.get("waterByClass"))?.get("SEA")) ?: nn(t?.get("water")) }

    /** ground.js `deepTint(deep, meta)`: TRUE's deep-water tint (× the loop, by depth step) from the painting's DEEP colour,
     *  clamp(deep × 1.6, 0.4, 1); a gem-sea realm takes a third of it (its kit teal stays teal). MAP's kit-water ends use it. */
    fun deepTint(deep: DoubleArray, meta: JsonValue?): DoubleArray {
        val gems = waterGems(meta) > 0
        return DoubleArray(3) { val t = GroundMath.clamp(deep[it] * 1.6, 0.4, 1.0); if (gems) 1 + (t - 1) / 3 else t }
    }

    /** ground.js `gemHighlight(meta)`: [GEM_HL] in a gem-sea realm, else 0 (TRUE's depth tint covers every loop texel). */
    fun gemHighlight(meta: JsonValue?): Double = if (waterGems(meta) > 0) GEM_HL else 0.0

    /**
     * ground.js `gemColours(px, W, ox, oy, cell)`: the two gem colours of a water loop frame (RGBA [px] of its [cell]² cell at
     * [ox], [oy] in a [w]-wide image): its highlight texels (luma more than 30 over the mean luma of the opaque texels, alpha ≥
     * 128) split warm (r > g) and cool, each group's mean / 255 → [first group, last group] (both the same group when only
     * one has texels), or null when the cell has no opaque texel or no highlight. (Texels outside the image are skipped, as
     * trueSetup's `meanOf` skips them natively.)
     */
    fun gemColours(px: ByteArray, w: Int, ox: Int, oy: Int, cell: Int = 32): Array<DoubleArray>? {
        fun b(o: Int) = px[o].toInt() and 0xff
        fun lum(o: Int) = 0.299 * b(o) + 0.587 * b(o + 1) + 0.114 * b(o + 2)
        fun at(x: Int, y: Int): Int { val o = ((oy + y) * w + ox + x) * 4; return if (o < 0 || o + 3 >= px.size || b(o + 3) < 128) -1 else o }
        var m = 0.0; var n = 0
        for (y in 0 until cell) for (x in 0 until cell) { val o = at(x, y); if (o < 0) continue; m += lum(o); n++ }
        if (n == 0) return null
        m /= n
        val grp = Array(2) { DoubleArray(4) }
        for (y in 0 until cell) for (x in 0 until cell) {
            val o = at(x, y); if (o < 0 || lum(o) <= m + 30) continue
            val q = grp[if (b(o) > b(o + 1)) 0 else 1]; q[0] += b(o).toDouble(); q[1] += b(o + 1).toDouble(); q[2] += b(o + 2).toDouble(); q[3]++
        }
        val got = grp.filter { it[3] > 0 }.map { q -> DoubleArray(3) { q[it] / q[3] / 255 } }
        return if (got.isEmpty()) null else arrayOf(got[0], got[got.size - 1])
    }

    /** ground.js trueSetup's `T.gemK`: each gem colour ÷ the loop's mean colour, clamp 0…8 per channel (MAP multiplies the
     *  water under a gem by it, so gems keep TRUE's gem-to-water contrast at every depth); null without colours or a mean. */
    fun gemK(colours: Array<DoubleArray>?, kitWater: DoubleArray?): Array<DoubleArray>? =
        if (colours == null || kitWater == null) null else Array(colours.size) { g -> DoubleArray(3) { GroundMath.clamp(colours[g][it] / maxOf(kitWater[it], 0.02), 0.0, 8.0) } }
}
