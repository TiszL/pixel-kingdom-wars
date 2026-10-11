package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.network.BaseOrderPrice
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import kotlinx.serialization.json.JsonObject

/** Session-only display history. Stores no balance, affordability or permission. Never persisted. */
internal class LiveBuildPriceMemory {
    private class Scope(val account: AccountSession, val baseId: String, val baseGeneration: Long,
        val catalogue: JsonObject, val contentGeneration: Long) {
        fun matches(other: Scope) = account === other.account && baseId == other.baseId &&
            baseGeneration == other.baseGeneration && catalogue === other.catalogue && contentGeneration == other.contentGeneration
    }
    private data class Key(val type: String, val level: Int)
    private var scope: Scope? = null
    private val prices = mutableMapOf<Key, BaseOrderPrice>()
    private fun scopeOf(snapshot: LiveBuildingCostSnapshot?): Scope? {
        val s = snapshot?.state ?: return null
        val base = s.selectedBaseId?.takeIf { it.isNotBlank() && it == s.base?.baseId } ?: return null
        if (s.wallet != snapshot.account.wallet) return null
        return Scope(snapshot.account, base, s.baseGeneration, s.catalogue ?: return null, snapshot.contentGeneration)
    }
    /** A scope change retires history, including a switch away and back. An unreadable owner holds nothing. */
    @Synchronized fun observe(snapshot: LiveBuildingCostSnapshot?) {
        val next = scopeOf(snapshot)
        if (next == null || scope?.matches(next) != true) { prices.clear(); scope = next }
    }
    /** Called only after the unchanged M3 mapper admitted a current, positive catalogue price. */
    @Synchronized fun admitted(snapshot: LiveBuildingCostSnapshot, type: String, price: BaseOrderPrice?, level: Int = 1) {
        val current = scopeOf(snapshot) ?: return
        if (scope?.matches(current) != true) return
        if (price == null) prices.remove(Key(type, level)) else prices[Key(type, level)] = price
    }
    @Synchronized fun price(snapshot: LiveBuildingCostSnapshot, type: String, level: Int = 1): BaseOrderPrice? {
        val current = scopeOf(snapshot) ?: return null
        return if (scope?.matches(current) == true) prices[Key(type, level)] else null
    }
    @Synchronized fun forget(type: String, level: Int = 1) { prices.remove(Key(type, level)) }
}
