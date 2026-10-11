package gg.pixelkingdomwars.nativeclient.ui.world

import java.util.Locale
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * The pure half of the approved realm-map HUD (`src/realm/ui.js` + `map.js` browse logic at the pin; D-167): filters,
 * search, the next/previous walk, the scale bar, the FAR cluster counters and the name-tag placement. No Compose, no
 * Android: every function runs on the JVM, and the ones the web exports are checked against golden vectors exported
 * from the pinned modules (`tools/world-hud.mjs` → `RealmHudModelTest`). Units are dp (the web's CSS px).
 */

/** A base as the realm-map HUD knows it: catalog deed column/row, the feed's fields; null = the feed does not carry it.
 *  [avatarUrl]: the owner's profile image path, drawn in the name tag ([RealmAvatars]); null draws the default portrait.
 *  [nameless]: the feed had no name, so [name] is [kingdomName]'s stand-in ("Keeper" / "Your kingdom"), shown but never
 *  searched ([RealmHudModel.search]). */
data class RealmHudBase(val tileId: Int, val x: Int, val y: Int, val name: String, val level: Int, val mine: Boolean,
    val shield: Boolean? = null, val attackable: Boolean? = null, val clan: String? = null, val avatarUrl: String? = null,
    val nameless: Boolean = false)

/** map.js `filterState`: one kind and a keep-level range (the level chip), combined. */
data class RealmFilter(val kind: String = "all", val lo: Int = 1, val hi: Int = 20) {
    val active: Boolean get() = kind != "all" || lo > 1 || hi < 20
    /** map.js `passes(b)`. "unshielded" (SHARDKEEP D-191) keeps only a kingdom whose read said `shielded: false`: a null
     *  shield (the read carried no bit) is unknown, never a raid target the map may promise (D-169 / D-181). */
    fun passes(b: RealmHudBase, myClan: String?): Boolean {
        if (b.level < lo || b.level > hi) return false
        return when (kind) {
            "mine" -> b.mine
            "clan" -> b.clan != null && b.clan == myClan
            "attack" -> b.attackable == true
            "unshielded" -> b.shield == false
            else -> true
        }
    }
    /** The level chip's labels after a slider move (ui.js `E.lvl` input handler). */
    fun levelLabels(): Pair<String, String> = "Level $lo–$hi" to "Lv $lo–$hi"
    /** The two sliders never cross: the one that moved drags the other (ui.js). */
    fun withLevel(index: Int, value: Int): RealmFilter {
        var a = if (index == 0) value else lo; var b = if (index == 1) value else hi
        if (a > b) { if (index == 0) b = a else a = b }
        return copy(lo = a.coerceIn(1, 20), hi = b.coerceIn(1, 20))
    }
}

object RealmHudModel {
    /** The game's `fmtN`: en-US thousands separators. */
    fun fmtN(value: Long): String = String.format(Locale.US, "%,d", value)
    fun fmtN(value: Int): String = fmtN(value.toLong())

    private val NICE = intArrayOf(1, 2, 5, 10, 20, 50, 100, 200, 500, 1000)
    /** ui.js `scaleBar(s)`: a whole, round count of the game's units whose bar is 40–100 dp long — deeds while a deed is
     *  ≤ 100 dp, tiles ([tilesPerDeed], from the catalogue) closer in. → (bar dp, label). */
    fun scaleBar(s: Double, tilesPerDeed: Int): Pair<Int, String> {
        val tiles = s > 100; val per = if (tiles) s / tilesPerDeed else s
        val n = NICE.firstOrNull { it * per >= 40 } ?: NICE.last()
        val unit = if (tiles) (if (n == 1) "tile" else "tiles") else (if (n == 1) "deed" else "deeds")
        return jsRound(n * per) to "${fmtN(n)} $unit"
    }

    /** ui.js `head()`: the title's second line. Counts are the server's (`/globe/fantasy` realms[]), never geography. */
    fun subtitle(deeds: Int?, kingdoms: Int?, shown: Int, filtered: Boolean): String =
        "${deeds?.let(::fmtN) ?: "—"} deeds · ${kingdoms?.let(::fmtN) ?: "—"} kingdoms" + if (filtered) " · ${fmtN(shown)} shown" else ""

    /** ui.js card `lonlat(x, y)` for a catalog deed column/row (0.5° deeds, D-128). */
    fun lonLat(x: Int, y: Int, columns: Int, rows: Int): String {
        val lon = -180 + (x + 0.5) * 360.0 / columns; val lat = 90 - (y + 0.5) * 180.0 / rows
        return String.format(Locale.US, "%.2f°%s %.2f°%s", abs(lat), if (lat >= 0) "N" else "S", abs(lon), if (lon >= 0) "E" else "W")
    }

    /**
     * ui.js `card(b)` facts of an occupied deed, in the approved order (D-167): Trophies when the read carries them; Clan as
     * the read's tag, "—" for none, and not shown at all when the read has no clan field (D-169: nothing is faked); Claim,
     * `plotRule(L).claim` squared tiles, from the catalogue table (null = not shown, never a Kotlin number); Location.
     */
    fun cardFacts(trophies: Long?, clanInRead: Boolean, clanTag: String?, claimTiles: Int?, x: Int, y: Int, columns: Int, rows: Int): List<Pair<String, String>> =
        buildList {
            trophies?.let { add("Trophies" to fmtN(it)) }
            if (clanInRead) add("Clan" to (clanTag?.takeIf { it.isNotBlank() } ?: "—"))
            claimTiles?.let { add("Claim" to "$it×$it tiles") }
            add("Location" to lonLat(x, y, columns, rows))
        }

    /** ui.js search: prefix matches over the name-sorted index first, then substring matches, ≤ 8 results. A nameless
     *  kingdom is not indexed: its "Keeper" / "Your kingdom" is our stand-in, not a name a player typed (review of 560fe54:
     *  "kee" filled the list with nameless kingdoms, crowding out real players named Keeper…). */
    fun search(bases: List<RealmHudBase>, query: String): List<RealmHudBase> {
        val q = query.trim().lowercase(Locale.ROOT); if (q.isEmpty()) return emptyList()
        val index = bases.filterNot { it.nameless }.map { it.name.lowercase(Locale.ROOT) to it }.sortedBy { it.first }
        val out = ArrayList<RealmHudBase>(8)
        var i = index.binarySearchBy(q) { it.first }.let { if (it < 0) -it - 1 else it }
        while (i > 0 && index[i - 1].first >= q) i-- // lower bound on equal keys
        while (i < index.size && out.size < 8 && index[i].first.startsWith(q)) { out += index[i].second; i++ }
        if (out.size < 8) for ((n, b) in index) { if (out.size >= 8) break; if (!n.startsWith(q) && n.contains(q)) out += b }
        return out
    }

    /** map.js `step(dir)`: the proximity walk inside the filtered list (the prototype's scoring). */
    fun step(filtered: List<RealmHudBase>, selected: RealmHudBase?, camX: Double, camY: Double, dir: Int): RealmHudBase? {
        if (filtered.isEmpty()) return null
        val ox = selected?.x?.toDouble() ?: camX; val oy = selected?.y?.toDouble() ?: camY
        var best: RealmHudBase? = null; var bd = Double.POSITIVE_INFINITY
        for (b in filtered) {
            if (b == selected) continue
            val dx = (b.x - ox) * dir; if (dx <= 0) continue
            val s = jsHypot(b.x - ox, b.y - oy) + abs(b.y - oy) * 0.6
            if (s < bd) { bd = s; best = b }
        }
        return best ?: filtered.reduce { a, b -> if (if (dir > 0) b.x < a.x else b.x > a.x) b else a }
    }

    // ---- FAR cluster counters (plan §8.2, V1 "count sum = bases"; ui.js clusterCounters) ------------------------------
    const val SEP = 44.0; const val MAX_COUNTERS = 40; const val MAX_TAGS = 16; const val PAD = 4.0; const val CLEAR = 12.0
    const val COUNTER_H = 28.0
    /** `.hud-count` width: VT323 20 dp digits, advance 0.4 em (HUD-STYLE §9). */
    fun counterW(n: Int): Double = max(28.0, 16.0 + 8.0 * n.toString().length).toDouble()

    class Counter(var n: Int = 0, var sx: Double = 0.0, var sy: Double = 0.0, var u: Double = 0.0, var v: Double = 0.0,
        var mine: Boolean = false, var px: Double = 0.0, var py: Double = 0.0, var w: Double = 0.0)
    class Counters(val list: List<Counter>, val onScreen: Int)

    /**
     * ui.js `clusterCounters`. [bx]/[by] are deed columns/rows relative to the camera's deed space, [cam] its centre,
     * [s] dp per deed, [W]×[H] the viewport, [chrome] padded control rects (l, t, r, b), [box] the safe viewport.
     * World-anchored cells on a √2 ladder grow until ≤ [max] cells hold the on-screen bases; every on-screen base lands
     * in exactly one counter; counters are pushed off the chrome and any two too close merge, keeping the sum.
     */
    fun clusterCounters(bx: IntArray, by: IntArray, mine: BooleanArray, n: Int, camX: Double, camY: Double, s: Double, W: Double, H: Double,
        chrome: List<DoubleArray>, box: DoubleArray, sep: Double = SEP, max: Int = MAX_COUNTERS, clear: Double = CLEAR): Counters {
        val rects = if (clear != 0.0) chrome.map { doubleArrayOf(it[0] - clear, it[1] - clear, it[2] + clear, it[3] + clear) } else chrome
        var k = max(0.0, ceil(2 * log2(sep / s))).toInt()
        val cells = LinkedHashMap<Long, Counter>()
        var on = 0
        for (guard in 0 until 48) {
            val g = StrictMath.pow(SQRT2, k.toDouble()); cells.clear(); on = 0
            for (i in 0 until n) {
                val sx = (bx[i] + 0.5 - camX) * s + W / 2; val sy = (by[i] + 0.5 - camY) * s + H / 2
                if (sx < 0 || sy < 0 || sx > W || sy > H) continue
                on++
                val key = floor((bx[i] + 0.5) / g).toLong() * 65536L + floor((by[i] + 0.5) / g).toLong()
                val c = cells.getOrPut(key) { Counter() }
                c.n++; c.sx += sx; c.sy += sy; c.u += bx[i] + 0.5; c.v += by[i] + 0.5; if (mine[i]) c.mine = true
            }
            if (cells.size <= max) break
            k++
        }
        val list = cells.values.toList()
        for (c in list) placeCounter(c, rects, box)
        var changed = true; var it = 0
        while (changed && it < 16) {
            changed = false
            for (i in list.indices) for (j in i + 1 until list.size) {
                val a = list[i]; val b = list[j]; if (a.n == 0 || b.n == 0) continue
                val dx = abs(a.px - b.px); val dy = abs(a.py - b.py)
                if (jsHypot(dx, dy) >= sep && (dx >= (a.w + b.w) / 2 + PAD || dy >= COUNTER_H + PAD)) continue
                a.n += b.n; a.sx += b.sx; a.sy += b.sy; a.u += b.u; a.v += b.v; a.mine = a.mine || b.mine; b.n = 0
                placeCounter(a, rects, box); changed = true
            }
            it++
        }
        return Counters(list.filter { it.n > 0 }, on)
    }

    /** ui.js `placeCounter`: centroid → inside the safe box and off every chrome rect (nearest free side, else a spiral). */
    private fun placeCounter(c: Counter, chrome: List<DoubleArray>, box: DoubleArray) {
        val w = counterW(c.n); val h = COUNTER_H
        val x0 = clamp(c.sx / c.n, box[0] + w / 2, box[2] - w / 2); val y0 = clamp(c.sy / c.n, box[1] + h / 2, box[3] - h / 2)
        fun inBox(x: Double, y: Double) = x - w / 2 >= box[0] && x + w / 2 <= box[2] && y - h / 2 >= box[1] && y + h / 2 <= box[3]
        fun hits(x: Double, y: Double): DoubleArray? {
            for (r in chrome) if (x - w / 2 < r[2] && x + w / 2 > r[0] && y - h / 2 < r[3] && y + h / 2 > r[1]) return r
            return null
        }
        var x = x0; var y = y0
        var pass = 0
        while (pass < 6) {
            val r = hits(x, y) ?: break
            var best: DoubleArray? = null; var bd = Double.POSITIVE_INFINITY
            for (p in arrayOf(doubleArrayOf(r[0] - w / 2, y), doubleArrayOf(r[2] + w / 2, y), doubleArrayOf(x, r[1] - h / 2), doubleArrayOf(x, r[3] + h / 2))) {
                if (!inBox(p[0], p[1])) continue
                val d = abs(p[0] - x0) + abs(p[1] - y0); if (d < bd) { bd = d; best = p }
            }
            if (best == null) break
            x = best[0]; y = best[1]; pass++
        }
        if (hits(x, y) != null) spiral@ for (rad in 8 until 480 step 8) for (a in 0 until 16) {
            val px = x0 + StrictMath.cos(a * Math.PI / 8) * rad; val py = y0 + StrictMath.sin(a * Math.PI / 8) * rad
            if (inBox(px, py) && hits(px, py) == null) { x = px; y = py; break@spiral }
        }
        c.px = x; c.py = y; c.w = w
    }

    // ---- name tags (s ≥ uiDots; ui.js tags()) ----------------------------------------------------------------------
    /** One tag candidate: its anchor in dp (the plot top, already lifted), priority, and whether it is the selected
     *  base's big tag. [anchorY] is where the tag's bottom edge sits + 4. [compact]: the map-range tag (D-NEXT, owner
     *  2026-09-26: "on this range only player profile picture and name should be visible"), shown while the kingdom has
     *  no drawn base: the avatar and [mapTagName], no keep level. */
    data class TagCandidate(val base: RealmHudBase, val x: Double, val anchorY: Double, val priority: Double, val compact: Boolean = false)
    /** A placed tag and what it shows: [name] and [level] (null in the compact map-range tag). */
    data class PlacedTag(val base: RealmHudBase, val x: Double, val bottom: Double, val w: Double, val h: Double, val big: Boolean,
        val name: String = base.name, val level: Int? = base.level) {
        val rect: DoubleArray get() = doubleArrayOf(x - w / 2 - 3, bottom - h, x + w / 2 + 3, bottom)
    }
    /** `.hud-nametag` width estimate (ui.js `tagW`): avatar + rule, gaps, pad, border; VT323 advance 0.4 em. A null
     *  [level] (the compact tag, D-NEXT) drops the level's gap and digits. */
    fun tagW(name: String, level: Int?, big: Boolean, capFs: Double, bodyFs: Double): Double {
        val w = (if (big) 35 else 23) + 5 + name.length * 0.4 * (if (big) bodyFs else capFs)
        return if (level == null) w + 8 else w + 5 + level.toString().length * 0.4 * bodyFs + 8
    }
    /** The compact tag's name cap in characters (D-NEXT; the web's tags have none, they only ever carry a level). */
    const val MAP_TAG_NAME = 12
    /** The compact tag's name: up to [MAP_TAG_NAME] characters, a longer one cut to MAP_TAG_NAME − 1 and "…". It
     *  counts code points, so a cut never splits an emoji. */
    fun mapTagName(name: String): String =
        if (name.codePointCount(0, name.length) <= MAP_TAG_NAME) name else name.substring(0, name.offsetByCodePoints(0, MAP_TAG_NAME - 1)) + "…"

    /**
     * ui.js `tags()`: at most 16 tags, highest priority first; the selected base's tag is skipped while its card is open
     * (the card names it); in TRUE only the selected tag shows; own/selected tags slide in at the screen edge; a tag that
     * would leave the safe [box] or touch a padded [chrome] rect or an earlier tag is dropped. Pure: no tag ever
     * intersects the chrome it was given.
     */
    fun placeTags(candidates: List<TagCandidate>, selected: RealmHudBase?, cardOpen: Boolean, trueBand: Boolean, chrome: List<DoubleArray>,
        box: DoubleArray, capFs: Double, bodyFs: Double, max: Int = MAX_TAGS): List<PlacedTag> {
        val placed = ArrayList<DoubleArray>(chrome.size + max); placed.addAll(chrome)
        val out = ArrayList<PlacedTag>(max)
        for (v in candidates.sortedByDescending { it.priority }) {
            if (out.size >= max) break
            val b = v.base; val isSel = b == selected
            if (isSel && cardOpen) continue
            if (trueBand && !isSel) continue
            val big = isSel; val name = if (v.compact) mapTagName(b.name) else b.name; val level = if (v.compact) null else b.level
            val w = tagW(name, level, big, capFs, bodyFs); val h = if (big) 36.0 else 24.0
            var x = v.x; if (b.mine || isSel) x = clamp(x, box[0] + w / 2 + 3, box[2] - w / 2 - 3)
            val r = doubleArrayOf(x - w / 2 - 3, v.anchorY - 4 - h, x + w / 2 + 3, v.anchorY - 4)
            if (!(r[0] >= box[0] && r[1] >= box[1] && r[2] <= box[2] && r[3] <= box[3])) continue
            if (placed.any { p -> r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1] }) continue
            placed += r; out += PlacedTag(b, x, v.anchorY - 4, w, h, big, name, level)
        }
        return out
    }

    /** ui.js `defaultCandidates` priority: the selected base, then yours, then filtered-in, then level, then centrality. */
    fun tagPriority(selected: Boolean, mine: Boolean, filteredIn: Boolean, level: Int, sx: Double, sy: Double, W: Double, H: Double): Double =
        (if (selected) 1e9 else 0.0) + (if (mine) 1e8 else 0.0) + (if (filteredIn) 1e6 else 0.0) + level * 1e3 - jsHypot(sx - W / 2, sy - H / 2)

    /** The cluster counter under a tap (dp), within 22 dp (ui.js `hitCluster`): the map zooms into it instead of picking. */
    fun hitCluster(counters: List<Counter>, x: Double, y: Double): Counter? {
        var best: Counter? = null; var bd = Double.POSITIVE_INFINITY
        for (c in counters) { val d = jsHypot(c.px - x, c.py - y); if (d < 22 && d < bd) { bd = d; best = c } }
        return best
    }

    // ---- JS number semantics ----------------------------------------------------------------------------------------
    private const val SQRT2 = 1.4142135623730951 // Math.SQRT2
    private fun clamp(x: Double, a: Double, b: Double) = max(a, min(b, x))
    /** JS `Math.round` (half up, towards +∞). */
    fun jsRound(x: Double): Int = floor(x + 0.5).toInt()
    /** `Math.log2` for the √2-ladder start; only its ceiling is used, so an ulp against V8 changes nothing off a boundary. */
    private fun log2(x: Double) = StrictMath.log(x) / StrictMath.log(2.0)
    /** V8's `Math.hypot` (max-scaled Kahan sum, then sqrt × max), so distance thresholds agree with the web to the bit. */
    fun jsHypot(a: Double, b: Double): Double {
        val x = abs(a); val y = abs(b)
        if (x == Double.POSITIVE_INFINITY || y == Double.POSITIVE_INFINITY) return Double.POSITIVE_INFINITY
        if (x.isNaN() || y.isNaN()) return Double.NaN
        val m = max(x, y); if (m == 0.0) return 0.0
        var sum = 0.0; var comp = 0.0
        for (v in doubleArrayOf(x, y)) { val q = v / m; val summand = q * q - comp; val pre = sum + summand; comp = (pre - sum) - summand; sum = pre }
        return sqrt(sum) * m
    }
}
