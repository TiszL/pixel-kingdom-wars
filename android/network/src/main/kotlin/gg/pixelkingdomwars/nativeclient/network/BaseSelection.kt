package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*

/** /bases already scopes ownership to the authenticated wallet. A deed without an active slot
 * cannot be selected for gameplay; a saved ID alone never overrides the current server list. */
fun resolveBaseSelection(saved: JsonObject?, wallet: String, ownedBases: List<JsonObject>): String? {
    val active = ownedBases.filter { it.string("status") == "active" && it["slot"] != null && it["slot"] != JsonNull }
    val previous = saved?.takeIf { it.string("wallet") == wallet }?.string("baseId")
    return previous?.takeIf { id -> active.any { it.string("id") == id } }
        ?: active.firstOrNull()?.string("id")
}
