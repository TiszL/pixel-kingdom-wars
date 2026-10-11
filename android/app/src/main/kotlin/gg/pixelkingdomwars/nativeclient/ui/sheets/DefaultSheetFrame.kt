package gg.pixelkingdomwars.nativeclient.ui.sheets

import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi

/**
 * Fixed frame metadata for the routes whose complete frame needs no domain snapshot.
 *
 * A non-null frame does not admit an action or claim that a body is bound. The caller retains [entry] for the owning
 * renderer, including History's filter and any nested presentation. Null preserves the existing owner's route: unknown
 * destinations, dynamic headers and unsupported Settings addresses must never open a fabricated placeholder card.
 */
fun defaultSheetFrame(entry: SheetEntry): SheetFrameUi? = when (val destination = entry.destination) {
    Destination.Mail -> SheetFrameUi(
        title = "MAIL", portrait = null, size = SheetSize.FULL, tabs = emptyList(), selectedTab = null,
    )
    is Destination.WalletHistory -> SheetFrameUi(
        title = "HISTORY", portrait = null, size = SheetSize.FULL, tabs = emptyList(), selectedTab = null,
    )
    is Destination.Settings -> settingsFrame(entry, destination)
    else -> null
}

private fun settingsFrame(entry: SheetEntry, destination: Destination.Settings): SheetFrameUi? {
    // An entry hint cannot legitimize an unsupported address, and this frame does not own Settings subsections.
    if (destination.section != null || destination.tab !in SETTINGS_TABS) return null
    val selected = entry.selectedTab ?: destination.tab
    if (selected !in SETTINGS_TABS) return null
    return SheetFrameUi(
        title = "SETTINGS",
        portrait = null,
        size = SheetSize.FULL,
        tabs = listOf(
            TabUi("GAME", "star", "GAME", badge = null, locked = false),
            TabUi("ACCOUNT", "shield", "ACCOUNT", badge = null, locked = false),
            TabUi("HELP", "info", "HELP", badge = null, locked = false),
        ),
        selectedTab = selected,
    )
}

private val SETTINGS_TABS = setOf("GAME", "ACCOUNT", "HELP")
