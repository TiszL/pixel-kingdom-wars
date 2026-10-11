package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases

import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmBases
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmGrid
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.JsMath
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases

/** A base the realm map draws (plan §6.1 `Base`): server data in production, [DemoBases] only in the debug fallback. */
class MapBase(
    /** The id the decor seed and the paths key on (the catalog tile id for server bases; the demo's deed index). */
    val id: Double, val x: Int, val y: Int, var level: Int, val name: String, val avatar: Int, val trophies: Int,
    val clan: String?, var mine: Boolean, var shield: Boolean?, var attackable: Boolean,
) {
    val idString: String get() = if (id == Math.floor(id) && Math.abs(id) < 1e15) id.toLong().toString() else id.toString()
}

/**
 * The demo base population (web `demo-bases.js`, pinned), DEBUG FALLBACK ONLY: a realm map with no server bases (the
 * guarded emulator, a debug build without a session) still shows a lived-in realm, deterministically (seed 7331) and
 * identical to the web's demo. Production never calls this: bases come from the server feed (native CLAUDE.md "server is
 * authoritative"); nothing here decides who may be attacked in the game.
 */
class DemoBases(private val t: DecorTables) {
    private val d = t.demo

    private class Rng(seed: Int) {
        private var s = seed
        fun next(): Double {
            s += 0x6D2B79F5
            var x = s
            x = (x xor (x ushr 15)) * (x or 1)
            x = x xor (x + (x xor (x ushr 7)) * (x or 61))
            return JsMath.u32(x xor (x ushr 14)) / 4294967296.0
        }
    }

    /** demo-bases.js `demoBases(meta, deedsU8)`: [deeds] one byte per deed (or RGBA, 4 per deed); [realmId] for the moat. */
    fun demoBases(realmId: String, cols: Int, rows: Int, deeds: ByteArray, thisRealm: Int): MutableList<MapBase> {
        val stride = if (deeds.size >= cols * rows * 4) 4 else 1
        // JS reads past the typed array as undefined (never own): a moat or hub outside a small grid is simply not own
        fun own(x: Int, y: Int): Boolean { val i = (y * cols + x) * stride; return i >= 0 && i < deeds.size && (deeds[i].toInt() and 0xff) >= thisRealm - 55 }
        val r = Rng(d.seed); val cells = ArrayList<IntArray>()
        fun vacant(x: Int, y: Int): Boolean {
            var h = ((x xor 0x5bd1e995) * 0x27d4eb2d) xor (JsMath.toInt32(y + 0x165667b1.toDouble()) * 0x85ebca6b.toInt())
            h = h xor (h ushr 15); h *= 0xc2b2ae35.toInt(); h = h xor (h ushr 13)
            return JsMath.u32(h) / 4294967296.0 < d.vacant
        }
        val grid = ByteArray(cols * rows)
        fun crowded(x: Int, y: Int): Boolean {
            var n = 0; var m = 0
            for (dy in -2..2) for (dx in -2..2) {
                val xx = x + dx; val yy = y + dy; if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue
                val v = grid[yy * cols + xx].toInt(); n += v; if (dx * dx <= 1 && dy * dy <= 1) m += v
            }
            return n >= d.localCap || m >= d.nearCap
        }
        for (y in 0 until rows) for (x in 0 until cols) if (own(x, y)) cells += intArrayOf(x, y)
        if (cells.isEmpty()) return ArrayList()
        val hubs = Array(d.hubs) { cells[Math.floor(r.next() * cells.size).toInt()] }
        val want = JsMath.round(cells.size * d.occupancy).toInt(); val used = HashSet<Int>(); val bases = ArrayList<MapBase>()
        var guard = 0
        while (bases.size < want && guard++ < want * 40) {
            val h = hubs[Math.floor(r.next() * hubs.size).toInt()]; val sp = 2 + r.next() * 9
            val x = JsMath.round(h[0] + (r.next() + r.next() + r.next() - 1.5) * sp).toInt(); val y = JsMath.round(h[1] + (r.next() + r.next() + r.next() - 1.5) * sp).toInt()
            val k = y * cols + x
            if (x < 0 || y < 0 || x >= cols || y >= rows || used.contains(k) || !own(x, y) || vacant(x, y) || crowded(x, y)) continue
            used += k; grid[k] = 1
            val level = 1 + Math.floor(JsMath.pow(r.next(), d.levelSkew) * 20).toInt(); val n = 2 + Math.floor(r.next() * 2).toInt()
            val name = StringBuilder(); for (i in 0 until n) name.append(t.syllables[Math.floor(r.next() * t.syllables.size).toInt()])
            val shield = r.next() < d.shieldShare; val clan = if (r.next() < d.clanShare) t.clans[Math.floor(r.next() * t.clans.size).toInt()] else null
            val avatar = Math.floor(r.next() * 256).toInt()
            // the web evaluates `avatar` before `trophies` inside one object literal: r() order kept
            bases += MapBase(k.toDouble(), x, y, level, name.substring(0, 1).uppercase() + name.substring(1), avatar,
                Math.floor(200 + level * 180 + r.next() * 400).toInt(), clan, false, shield, false)
        }
        var i = 0
        while (bases.size < want && i < cells.size * 4) {
            val c = cells[Math.floor(r.next() * cells.size).toInt()]; val x = c[0]; val y = c[1]; val k = y * cols + x
            i++
            if (used.contains(k) || vacant(x, y) || crowded(x, y)) continue
            used += k; grid[k] = 1
            val level = 1 + Math.floor(JsMath.pow(r.next(), d.levelSkew) * 20).toInt()
            val s1 = t.syllables[Math.floor(r.next() * t.syllables.size).toInt()]; val name = s1.substring(0, 1).uppercase() + s1.substring(1) + t.syllables[Math.floor(r.next() * t.syllables.size).toInt()]
            val avatar = Math.floor(r.next() * 256).toInt(); val trophies = Math.floor(200 + level * 180 + r.next() * 400).toInt()
            bases += MapBase(k.toDouble(), x, y, level, name, avatar, trophies, null, false, r.next() < d.shieldShare, false)
        }
        d.moat[realmId]?.let { mo ->
            val k = mo[1] * cols + mo[0]
            if (own(mo[0], mo[1]) && !used.contains(k)) { used += k; grid[k] = 1; bases += MapBase(k.toDouble(), mo[0], mo[1], mo[2], "Rivermoot", 77, 200 + mo[2] * 180, null, false, false, false) }
        }
        var cx = 0.0; var cy = 0.0; for (b in bases) { cx += b.x; cy += b.y }; cx /= bases.size; cy /= bases.size
        var me = bases[0]
        for (b in bases) if ((b.x - cx) * (b.x - cx) + (b.y - cy) * (b.y - cy) < (me.x - cx) * (me.x - cx) + (me.y - cy) * (me.y - cy)) me = b
        val meIdx = bases.indexOf(me)
        bases[meIdx] = MapBase(me.id, me.x, me.y, d.myLevel, "Your Kingdom", me.avatar, 2150, t.clans[0], true, true, me.attackable)
        me = bases[meIdx]
        var nb: MapBase? = null
        for (b in bases) if (b !== me && (nb == null || sq(b.x - me.x) + sq(b.y - me.y) < sq(nb.x - me.x) + sq(nb.y - me.y))) nb = b
        nb?.shield = true
        return withAttackable(bases)
    }
    private fun sq(v: Int) = (v * v).toDouble()

    /** attackable = not yours, not shielded, within ±attackRange keep levels of yours (the prototype's rule; demo only). */
    fun withAttackable(bases: MutableList<MapBase>): MutableList<MapBase> {
        val me = bases.firstOrNull { it.mine }
        for (b in bases) b.attackable = me != null && !b.mine && b.shield != true && Math.abs(b.level - me.level) <= d.attackRange
        return bases
    }

    /** demo-bases.js `ladderBases` (QA level ladder): seven bases on the nearest run of own deeds to yours. */
    fun ladderBases(bases: MutableList<MapBase>, cols: Int, rows: Int, deeds: ByteArray, thisRealm: Int, levels: IntArray = d.ladder): MutableList<MapBase> {
        val stride = if (deeds.size >= cols * rows * 4) 4 else 1
        // JS reads past the typed array as undefined (never own): a moat or hub outside a small grid is simply not own
        fun own(x: Int, y: Int): Boolean { val i = (y * cols + x) * stride; return i >= 0 && i < deeds.size && (deeds[i].toInt() and 0xff) >= thisRealm - 55 }
        val me = bases.firstOrNull { it.mine }; val mx = me?.x ?: (cols shr 1); val my = me?.y ?: (rows shr 1); val n = levels.size
        var best: IntArray? = null; var bd = Double.POSITIVE_INFINITY
        for (y in 0 until rows) { var x = 0; while (x + n <= cols) {
            var ok = true; var i = 0
            while (i < n && ok) { ok = own(x + i, y) && !(x + i == mx && y == my); i++ }
            if (ok) { val dd = (x + n / 2.0 - mx) * (x + n / 2.0 - mx) + ((y - my) * (y - my)).toDouble(); if (dd < bd) { bd = dd; best = intArrayOf(x, y) } }
            x++ } }
        val b0 = best ?: return bases
        val taken = HashSet<Int>(); for (i in levels.indices) taken += b0[1] * cols + b0[0] + i
        val kept = bases.filter { !taken.contains(it.y * cols + it.x) }.toMutableList()
        for ((i, level) in levels.withIndex()) kept += MapBase((b0[1] * cols + b0[0] + i).toDouble(), b0[0] + i, b0[1], level, "Ladder L$level", 40 + i * 30,
            200 + level * 180, null, false, level == 9 || level == 17, false)
        return withAttackable(kept)
    }

    /**
     * DEBUG FALLBACK ONLY (the host gates it behind a debug build with no server feed): the demo population as the engine's
     * bases snapshot, in catalog columns/rows through [grid] (the engine maps them back to local deeds), with the FLAG bits
     * the web's `writeState` sets (clan = the same clan as yours). Pair it with `BasesLane.demoSeeds = true` so each
     * kingdom seeds from its deed index like the web demo.
     */
    fun snapshot(realmId: String, grid: RealmGrid, deeds: ByteArray, thisRealm: Int, epoch: Long): WorldBases {
        val list = demoBases(realmId, grid.cols, grid.rows, deeds, thisRealm)
        val me = list.firstOrNull { it.mine }
        val n = list.size; val xs = IntArray(n); val ys = IntArray(n); val lv = IntArray(n); val fl = IntArray(n)
        for ((i, b) in list.withIndex()) {
            val t = grid.tileId(b.x, b.y)
            xs[i] = if (t < 0) -1 else t % RealmGrid.LATTICE_W; ys[i] = if (t < 0) -1 else t / RealmGrid.LATTICE_W; lv[i] = b.level
            var f = RealmBases.FLAG_OCCUPIED
            if (b.mine) f = f or RealmBases.FLAG_MINE
            if (b.shield == true) f = f or RealmBases.FLAG_SHIELD
            if (b.attackable) f = f or RealmBases.FLAG_ATTACKABLE
            if (me != null && b.clan != null && b.clan == me.clan) f = f or RealmBases.FLAG_CLAN
            fl[i] = f
        }
        return WorldBases(epoch, realmId, xs, ys, lv, fl)
    }
}
