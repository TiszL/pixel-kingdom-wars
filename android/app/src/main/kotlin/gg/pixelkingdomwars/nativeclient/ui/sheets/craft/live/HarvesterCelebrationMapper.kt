package gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftCelebrationUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.HarvesterYieldUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.groupDigits
import java.util.Locale

/*
 * The Harvester's COLLECT celebration (craft SPEC §4.2 `harvester-arrived.png`, dismiss rules SPEC 0.6; the title is the
 * one `CraftCelebrationUi` documents). Hauls are delivered by the server on their own (SPEC 0.2): COLLECT only moves the
 * client's seen marker, so this party is client-only and never makes a server call. It shows the haul the player was
 * shown on the COLLECT button, which is why the host builds it BEFORE it moves the marker: afterwards the same haul reads
 * as seen and there is nothing left to name.
 */

/** The HAUL ARRIVED party for the unseen haul in [harvest] ("+12 CROWN IRON ORE", "Already safe in your stores."); null when
 *  nothing is unseen, so COLLECT never celebrates nothing. [sourceKey] identifies the acknowledged haul (source and sequence). */
internal fun harvesterArrivedCelebration(harvest: HarvesterYieldUi, sourceKey: String): CraftCelebrationUi? {
    val unseen = harvest.arrived.unseenQuantity
    if (unseen <= 0L) return null
    // The server's resource name; an unknown one falls back to the noun of the live chip ("12 ore arrived"), never "…".
    val name = harvest.resourceName.takeIf { it.isNotBlank() && it != UNKNOWN } ?: harvest.arrivedNoun
    return CraftCelebrationUi(
        jobId = sourceKey,
        title = "HAUL ARRIVED",
        icon = harvest.resourceIcon,
        ribbon = "+${groupDigits(unseen)} ${name.uppercase(Locale.US)}",
        line = "Already safe in your stores.",
    )
}
