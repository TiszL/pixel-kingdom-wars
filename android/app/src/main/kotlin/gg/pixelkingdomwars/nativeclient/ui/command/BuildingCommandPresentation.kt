package gg.pixelkingdomwars.nativeclient.ui.command

import gg.pixelkingdomwars.nativeclient.ui.features.BuildingSelection
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.GateFact
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import java.util.Collections

/**
 * Detached observations from the current selected-building owners. This carries no
 * callback or authority to act. The mount retires it whenever its admitted context
 * changes; [buildingCommands] also refuses a mismatched [selection].
 *
 * [atMaxLevel] is a catalogue observation, never inferred from a denied upgrade.
 * Missing order permission stays unknown. The registry remains authoritative for
 * feature gates, host ownership and routes.
 */
class BuildingCommandPresentation(
    val selection: BuildingSelection? = null,
    val ordersAllowed: GateFact = GateFact.Unknown,
    val atMaxLevel: GateFact = GateFact.Unknown,
    entries: Map<FeatureId, BuildingCommandEntry> = emptyMap(),
) {
    val entries: Map<FeatureId, BuildingCommandEntry> =
        Collections.unmodifiableMap(LinkedHashMap(entries))

    init {
        require(entries.keys.all { it.value.isNotBlank() })
    }
}

/**
 * Already admitted presentation, not an alternate CommandUi or a capability decoder.
 * An icon is an exact existing resolver key. A price/badge is already formatted by
 * its owner; no amount or timer is calculated here.
 *
 * [spending] defaults conservatively: a read-only snapshot disables this command
 * until its producer classifies it as nonspending. It does not say that a tap spends.
 * [readyToCollect] changes a known owner door's caption only. In particular it cannot
 * turn auto-delivered output into a server collect call.
 * [value] and [timer] are the owner's already formatted primary value ("+24", "x3") and
 * running-job time; they are drawn as given (CommandUi.value / CommandUi.timer).
 */
data class BuildingCommandEntry(
    val icon: String? = null,
    val price: PriceUi? = null,
    val badge: BadgeUi? = null,
    val spending: Boolean = true,
    val busy: Boolean = false,
    val readyToCollect: Boolean = false,
    val usableWhileUpgrading: GateFact = GateFact.Unknown,
    val sub: String? = null,
    val iconSecondary: String? = null,
    val value: String? = null,
    val timer: String? = null,
)
