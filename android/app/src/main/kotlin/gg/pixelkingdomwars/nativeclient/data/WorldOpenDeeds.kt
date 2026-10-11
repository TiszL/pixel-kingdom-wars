package gg.pixelkingdomwars.nativeclient.data

/**
 * Choose mode's "Next open deed ▶" as far as today's data allows (GLOBE-PRODUCTION-PLAN §1.3 step 3; OQ-1's recorded
 * default: no occupancy feed). Without the feed the client cannot know every held or assigned tile, so a candidate is:
 *  - an ORDINARY catalog tile of the open realm (the frozen catalog, server truth; Genesis/Seeker allocations never), and
 *  - not a tile the client already knows is taken: kingdoms in the bounded viewport read, your own deeds, and tiles the
 *    metered parcel read has refused this visit.
 * The card's metered read (`GET /globe/fantasy/parcels/:tileId`, after the dwell) is still the only authority on
 * availability; CHOOSE THIS LAND appears only when it says `available`. Pure: JVM-tested, no Android.
 */
object WorldOpenDeeds {
    /** Chebyshev rings searched around the origin (≤ 16,641 cells), so a tap never scans a whole realm on the UI thread. */
    const val MAX_RING = 64

    /**
     * The open-deed candidate nearest ([fromX], [fromY]) in catalog columns/rows: rings outward, row-major inside a ring;
     * columns wrap at the dateline (Cinderfall), rows do not. [skip] holds tiles already offered this visit, so repeated
     * taps walk on instead of bouncing between two deeds. Null when no candidate lies within [maxRing].
     */
    fun next(fromX: Int, fromY: Int, columns: Int, rows: Int, open: (Int) -> Boolean, known: Set<Int>, skip: Set<Int>, maxRing: Int = MAX_RING): Int? {
        if (columns <= 0 || rows <= 0) return null
        val x0 = Math.floorMod(fromX, columns)
        for (r in 0..maxRing) {
            for (dy in -r..r) {
                val y = fromY + dy
                if (y < 0 || y >= rows) continue
                val edgeRow = dy == -r || dy == r
                var dx = -r
                while (dx <= r) {
                    val tile = y * columns + Math.floorMod(x0 + dx, columns)
                    if (tile !in skip && tile !in known && open(tile)) return tile
                    // Inside a ring only its two edge columns are new cells.
                    dx = if (edgeRow || dx == r) dx + 1 else r
                }
            }
        }
        return null
    }

    /** [next] over the frozen [catalog]: an ORDINARY tile of [realmId] (a Genesis or Seeker allocation never). */
    fun next(catalog: FantasyCatalog, realmId: String, fromX: Int, fromY: Int, known: Set<Int>, skip: Set<Int>): Int? =
        next(fromX, fromY, catalog.columns, catalog.rows, { id -> catalog.tile(id)?.let { it.realmId == realmId && it.ordinary } == true }, known, skip)
}
