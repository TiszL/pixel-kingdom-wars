package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.FantasyMarker
import gg.pixelkingdomwars.nativeclient.model.FantasyRect
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.sqrt

/**
 * The realm map's kingdoms come from the SAME bounded parcel-viewport read the globe used (`GET /globe/fantasy/parcels`,
 * `WorldRepository.markers`); no new server call exists or is implied (the occupancy feed is OQ-1). This plans the read
 * for a visible catalog deed window with the globe's own rules (`GlobeGeometry.viewportRects` / `boundedScope`):
 * split at the dateline, quantised to the server's cells, chunked by `maxSpan`/`maxCells`, nearest the centre first,
 * at most `maxRequests`; anything left over is disclosed as truncated, never drawn as a falsely complete realm.
 * Every bound is the server's catalogue constant (`GLOBE.parcelViewport*`), passed in.
 */
object WorldRealmFeed {
    /** A visible window in catalog deed columns/rows (x may run past either edge; Cinderfall wraps the dateline). */
    data class Window(val x0: Double, val y0: Double, val x1: Double, val y1: Double)
    data class Scope(val rects: List<FantasyRect>, val truncated: Boolean)

    fun scope(window: Window, columns: Int, rows: Int, quantum: Int, maxCells: Int, maxSpan: Int, maxRequests: Int): Scope {
        require(columns > 0 && rows > 0 && quantum > 0 && maxCells > 0 && maxSpan > 0 && maxRequests > 0)
        fun floorQ(v: Double) = floor(v / quantum).toInt() * quantum
        fun ceilQ(v: Double) = ceil(v / quantum).toInt() * quantum - 1
        val left = floorQ(floor(window.x0) - 2); val right = min(left + columns - 1, ceilQ(floor(window.x1) + 3))
        val top = maxOf(0, floorQ(floor(window.y0) - 2)); val bottom = min(rows - 1, ceilQ(floor(window.y1) + 3))
        if (right < left || bottom < top) return Scope(emptyList(), false)
        val sorted = (left..right).map { ((it % columns) + columns) % columns }.distinct().sorted()
        val ranges = mutableListOf<IntRange>()
        for (x in sorted) { val last = ranges.lastOrNull(); if (last != null && last.last + 1 == x) ranges[ranges.lastIndex] = last.first..x else ranges += x..x }
        val side = min(maxSpan, sqrt(maxCells.toDouble()).toInt()).coerceAtLeast(1)
        val all = buildList { for (range in ranges) for (y in top..bottom step side) for (x in range step side) add(FantasyRect(x, y, min(range.last, x + side - 1), min(bottom, y + side - 1))) }
        val cx = (window.x0 + window.x1) / 2; val cy = (window.y0 + window.y1) / 2
        fun distance(r: FantasyRect): Double {
            var dx = (r.x0 + r.x1 + 1) / 2.0 - cx
            dx -= Math.round(dx / columns) * columns.toDouble() // the nearer way round the dateline
            val dy = (r.y0 + r.y1 + 1) / 2.0 - cy
            return dx * dx + dy * dy
        }
        val nearest = all.sortedWith(compareBy<FantasyRect> { distance(it) }.thenBy { it.y0 }.thenBy { it.x0 })
        return Scope(nearest.take(maxRequests), all.size > maxRequests)
    }

    /** The feed side of a device run (`WorldLog`, once per completed realm read): the kingdoms the read carried (every
     *  realm in the window, after the repository's checks) and how many the server called shielded, so a map without a
     *  dome can be told apart from a feed without a shield. */
    fun feedLine(realmId: String?, markers: Collection<FantasyMarker>): String =
        "[world-feed] realm ${realmId ?: "?"} markers ${markers.size} shielded ${markers.count { it.shieldUp }}"
}
