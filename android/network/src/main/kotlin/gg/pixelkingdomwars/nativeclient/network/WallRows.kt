package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.Building

/** `packages/shared/src/wallConnect.ts` wallRowThrough: the longest contiguous straight run through
 * the tapped wall, horizontal winning ties. The server quotes exactly this row (`wallRowQuoteLocked`),
 * so the walls the player sees highlighted are the walls the purchase prices. */
fun <T> wallRowThrough(walls: List<T>, selectedId: String, id: (T) -> String, tx: (T) -> Int, ty: (T) -> Int): List<T> {
    val start = walls.firstOrNull { id(it) == selectedId } ?: return emptyList()
    val at = walls.associateBy { tx(it) to ty(it) }
    fun run(dx: Int, dy: Int): List<T> {
        val out = mutableListOf(start)
        for (sign in intArrayOf(1, -1)) {
            var x = tx(start) + sign * dx; var y = ty(start) + sign * dy
            while (true) { val next = at[x to y] ?: break; out += next; x += sign * dx; y += sign * dy }
        }
        return out
    }
    val horizontal = run(1, 0); val vertical = run(0, 1)
    return if (horizontal.size >= vertical.size) horizontal else vertical
}

/** The row through a server wall row; non-wall buildings never join a run. */
fun wallRowThrough(buildings: List<Building>, selectedId: String): List<Building> =
    wallRowThrough(buildings.filter { it.type == "wall" }, selectedId, { it.id }, { it.tx }, { it.ty })
