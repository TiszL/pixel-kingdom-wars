package gg.pixelkingdomwars.nativeclient.ui.features

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName

/**
 * A navigation address, never a payment, consent, callback, or authority to submit work.
 * The Home host revalidates registry gates and actor/selection identity before dispatch.
 * SheetStack owns restoration; restored money surfaces reopen their existing read/recovery state.
 */
@Serializable
sealed interface Destination {
    @Serializable data class BuildingInfo(val buildingId: String) : Destination {
        init { requiredAddress(buildingId) }
    }
    @Serializable data class Upgrade(val buildingId: String) : Destination {
        init { requiredAddress(buildingId) }
    }
    @Serializable data class Army(val tab: String = "TRAIN") : Destination {
        init { requiredAddress(tab) }
    }
    @Serializable data object Research : Destination
    @Serializable data class Heroes(val hero: String, val tab: String = "HERO") : Destination {
        init { requiredAddress(hero); requiredAddress(tab) }
    }
    @Serializable data class KeepStores(val tab: String = "BAG") : Destination {
        init { requiredAddress(tab) }
    }
    @Serializable data class BuildShop(val tab: String = "BUILDINGS") : Destination {
        init { requiredAddress(tab) }
    }
    @Serializable data class Workshop(val tab: String? = null) : Destination {
        init { optionalAddress(tab) }
    }
    @Serializable data class Lodge(
        val tab: String = "SEND", val mode: String? = null, val routeId: String? = null,
    ) : Destination {
        init { requiredAddress(tab); optionalAddress(mode); optionalAddress(routeId) }
    }
    @Serializable data class Berth(val tab: String = "FLEET", val section: String? = null) : Destination {
        init { requiredAddress(tab); optionalAddress(section) }
    }
    @Serializable data class Market(val tab: String = "BUY", val section: String? = null) : Destination {
        init { requiredAddress(tab); optionalAddress(section) }
    }
    @Serializable data class Harvester(val tab: String = "YIELD") : Destination {
        init { requiredAddress(tab) }
    }
    @Serializable data class GoldForge(val tab: String? = null, val section: String? = null) : Destination {
        init { optionalAddress(tab); optionalAddress(section) }
    }
    @Serializable data class RaidChooser(val tab: String = "MATCH") : Destination {
        init { requiredAddress(tab) }
    }
    @Serializable data class BattleLog(val tab: String = "DEFENCE") : Destination {
        init { requiredAddress(tab) }
    }
    @Serializable data class Quests(val tab: String = "DAILY") : Destination {
        init { requiredAddress(tab) }
    }
    @Serializable data object DailyCache : Destination
    @Serializable data class Event(val tab: String = "POINTS") : Destination {
        init { requiredAddress(tab) }
    }
    @Serializable data object Mail : Destination
    @Serializable data class Chat(val tab: String = "WORLD") : Destination {
        init { requiredAddress(tab) }
    }
    @Serializable data class Clan(val tab: String = "CLAN") : Destination {
        init { requiredAddress(tab) }
    }
    @Serializable data class Leagues(val tab: String = "LEAGUE") : Destination {
        init { requiredAddress(tab) }
    }
    @Serializable data class Profile(val tab: String = "PROFILE", val section: String? = null) : Destination {
        init { requiredAddress(tab); optionalAddress(section) }
    }
    @Serializable data class WalletHistory(val home: String = "all") : Destination {
        init { requiredAddress(home) }
    }
    @Serializable data class Settings(val tab: String = "GAME", val section: String? = null) : Destination {
        init { requiredAddress(tab); optionalAddress(section) }
    }
    @Serializable data object Feedback : Destination
    @Serializable data object Builders : Destination
    @Serializable data class IslandScene(val island: String) : Destination {
        init { requiredAddress(island) }
    }
    @Serializable data class IslandRewards(val island: String) : Destination {
        init { requiredAddress(island) }
    }
    @Serializable data class RealmPermit(val spot: Int) : Destination {
        init { require(spot >= 0) { "A realm permit needs an explicit nonnegative spot" } }
    }
    @Serializable data object DivineTrials : Destination
    @Serializable data object DivineFragments : Destination
    /** Transient host command. SheetStack excludes it from process-death restoration. */
    @Serializable data class FocusBuilding(@SerialName("buildingType") val type: String, val then: Destination? = null) : Destination {
        init { requiredAddress(type) }
    }

    // Corrected table additions; each retains the feature's existing runtime owner.
    @Serializable data class World(val level: String = "globe") : Destination {
        init { requiredAddress(level) }
    }
    @Serializable data object StoragePopover : Destination
    @Serializable data class LandGate(val mode: String = "browse", val tileId: Int? = null) : Destination {
        init {
            require(mode == "browse" || mode == "parcel") { "Unknown land address mode" }
            require(tileId == null || tileId >= 0) { "A land tile must be nonnegative" }
            require(mode != "parcel" || tileId != null) { "A parcel address needs its selected tile" }
        }
    }
    /** Existing SOL faucet, separate from [SkrFaucet]. */
    @Serializable data object Faucet : Destination
    @Serializable data object Expand : Destination
    @Serializable data object LayoutEditor : Destination
    @Serializable data class IslandSpot(val island: String, val spot: Int, val mode: String = "info") : Destination {
        init {
            requiredAddress(island); requiredAddress(mode)
            require(spot >= 0) { "An island address needs an explicit nonnegative spot" }
        }
    }
    @Serializable data object VehicleCraft : Destination
    @Serializable data class Resources(val resourceId: String? = null) : Destination {
        init { optionalAddress(resourceId) }
    }
    @Serializable data object SkrFaucet : Destination
    @Serializable data class SolanaReachUnlock(val tileId: Int) : Destination {
        init { require(tileId >= 0) { "A Reach address needs an explicit nonnegative tile" } }
    }
}

private fun requiredAddress(value: String) {
    require(value.isNotBlank()) { "Navigation identities must be nonblank" }
}

private fun optionalAddress(value: String?) {
    if (value != null) requiredAddress(value)
}
