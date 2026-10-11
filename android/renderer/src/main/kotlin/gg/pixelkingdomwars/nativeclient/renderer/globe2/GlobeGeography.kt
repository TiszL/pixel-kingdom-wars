package gg.pixelkingdomwars.nativeclient.renderer.globe2

import gg.pixelkingdomwars.nativeclient.renderer.world.ExactPng
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.min

/**
 * The frozen display geography on the globe's 768×384 grid (the concept's geo.js `decodeGeography` + `buildFields`
 * land/region/explore), read from the client pack's two masks the legacy globe already ships:
 * - `surface-mask.png`: R ≠ 0 on visible land, G ≠ 0 where a deed is eligible, B = exploration chain + 1;
 * - `realm-mask.png`: R = realm index + 1 (geo.js REALMS order, the render catalogue's `regions` order).
 * Picking and realm framing read this, never a tile (plan §7 "picking never yields a tile"); `GlobePickingGoldenTest`
 * pins it to the web's tap rule at 5,000 points.
 */
class GlobeGeography(val width: Int, val height: Int, val land: BooleanArray, val region: ByteArray, val explore: ByteArray) {
    init { require(land.size == width * height && region.size == land.size && explore.size == land.size) { "Ragged geography" } }

    /** geo.js geoIndex(lon, lat). */
    fun index(lon: Double, lat: Double): Int {
        val x = min(width - 1, floor(((((lon + 180) % 360) + 360) % 360) / 360 * width).toInt())
        val y = min(height - 1, maxOf(0, floor((90 - lat) / 180 * height).toInt()))
        return y * width + x
    }

    /** The concept's tap rule: the realm index on visible land, else -1 (main.js tap). */
    fun realmAt(lon: Double, lat: Double): Int { val i = index(lon, lat); return if (land[i]) region[i].toInt() else -1 }

    /** main.js realmIdAt: the realm index under (lon, lat) whether or not the cell is land (the dive rule reads this). */
    fun regionAt(lon: Double, lat: Double): Int = region[index(lon, lat)].toInt()

    /** The exploration code (chain + 1, 0 = none) under (lon, lat). */
    fun exploreAt(lon: Double, lat: Double): Int = explore[index(lon, lat)].toInt()

    private fun inRealm(i: Int, r: Int): Boolean = land[i] && region[i].toInt() == r

    /**
     * main.js realmGeom(r): the realm's main landmass (islets under 30 px get no ring of their own), its outline points
     * (decimated to ≤ ~900) and the centre of their bounding box in the landmass's tangent plane. Set-up work (a flood
     * fill over the grid): computed once per realm, off the GL thread's frame path.
     */
    fun realmGeom(r: Int): GlobeRealmGeom {
        val n = width * height; val gw = width; val gh = height
        val lab = IntArray(n) { -1 }; val sizes = ArrayList<Int>()
        var bestId = -1; var bestN = 0; var id = 0
        val stack = IntArray(n)
        for (s0 in 0 until n) {
            if (lab[s0] >= 0 || !inRealm(s0, r)) continue
            var count = 0; var sp = 0; stack[sp++] = s0; lab[s0] = id
            while (sp > 0) {
                val i = stack[--sp]; val x = i % gw; val y = i / gw; count++
                val nb0 = y * gw + (x + 1) % gw; val nb1 = y * gw + (x + gw - 1) % gw
                val nb2 = if (y > 0) i - gw else -1; val nb3 = if (y < gh - 1) i + gw else -1
                for (j in intArrayOf(nb0, nb1, nb2, nb3)) if (j >= 0 && lab[j] < 0 && inRealm(j, r)) { lab[j] = id; stack[sp++] = j }
            }
            sizes += count; if (count > bestN) { bestN = count; bestId = id }; id++
        }
        val pts = ArrayList<DoubleArray>(); val s = DoubleArray(3)
        for (y in 0 until gh) for (x in 0 until gw) {
            val i = y * gw + x
            if (lab[i] != bestId) continue
            val d = geoDir(x, y); s[0] += d[0]; s[1] += d[1]; s[2] += d[2]
            if (y == 0 || y == gh - 1 || !inRealm(i - gw, r) || !inRealm(i + gw, r) || !inRealm(y * gw + (x + 1) % gw, r) || !inRealm(y * gw + (x + gw - 1) % gw, r)) pts += d
        }
        val c0 = V.norm(DoubleArray(3), s); val e0 = V.norm(DoubleArray(3), V.crossUp(DoubleArray(3), c0)); val n0 = V.cross(DoubleArray(3), c0, e0)
        var u0 = 9.0; var u1 = -9.0; var v0 = 9.0; var v1 = -9.0
        for (p in pts) {
            val zz = V.dot(p, c0); if (zz < 0.05) continue
            val u = V.dot(p, e0) / zz; val v = V.dot(p, n0) / zz
            u0 = minOf(u0, u); u1 = maxOf(u1, u); v0 = minOf(v0, v); v1 = maxOf(v1, v)
        }
        val cu = (u0 + u1) / 2; val cv = (v0 + v1) / 2
        // c = norm(add(c0, add(mulS(e0, cu), mulS(n0, cv))))
        val c = V.norm(DoubleArray(3), doubleArrayOf(c0[0] + (e0[0] * cu + n0[0] * cv), c0[1] + (e0[1] * cu + n0[1] * cv), c0[2] + (e0[2] * cu + n0[2] * cv)))
        val stride = maxOf(1, ceil(pts.size / 900.0).toInt())
        val kept = pts.filterIndexed { i, _ -> i % stride == 0 }
        val packed = DoubleArray(kept.size * 3)
        kept.forEachIndexed { i, p -> packed[i * 3] = p[0]; packed[i * 3 + 1] = p[1]; packed[i * 3 + 2] = p[2] }
        return GlobeRealmGeom(r, c, packed, kept.size, pts.size)
    }

    /** main.js geoDir(x, y): the unit vector of a geography cell centre. */
    fun geoDir(x: Int, y: Int): DoubleArray = V.dirOf((x + 0.5) / width * 360 - 180, 90 - (y + 0.5) / height * 180)

    companion object {
        /**
         * Decode the two client-pack masks (exact PNG, never BitmapFactory: they are data). Null when either is not a
         * PNG this decoder accepts, or when their sizes differ.
         */
        fun fromMasks(surfacePng: ByteArray, realmPng: ByteArray): GlobeGeography? {
            val surface = ExactPng.decode(surfacePng) ?: return null
            val realm = ExactPng.decode(realmPng) ?: return null
            if (surface.width != realm.width || surface.height != realm.height) return null
            val n = surface.width * surface.height
            val land = BooleanArray(n); val region = ByteArray(n); val explore = ByteArray(n)
            for (i in 0 until n) {
                land[i] = surface.rgba[i * 4].toInt() and 0xFF != 0
                explore[i] = (surface.rgba[i * 4 + 2].toInt() and 0xFF).toByte()
                region[i] = ((realm.rgba[i * 4].toInt() and 0xFF) - 1).toByte()
            }
            return GlobeGeography(surface.width, surface.height, land, region, explore)
        }
    }
}

/** A realm's framing geometry: [c] the frame centre, [pts] outline points (x, y, z packed, [count] of them). */
class GlobeRealmGeom(val realm: Int, val c: DoubleArray, val pts: DoubleArray, val count: Int, val outlineCells: Int)
