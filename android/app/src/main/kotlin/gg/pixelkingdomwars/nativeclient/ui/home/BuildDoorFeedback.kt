package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi

/** Copy for the existing BUILD gates, in recovery-first order (review 5066e276). No new admission. [savedClosable]: the
 *  server answered `unknown` for the saved construction, so its card offers CLOSE and the toast says so (owner 2026-10-06). */
internal fun homeBuildRefusalReason(savedConstruction: Boolean, busy: Boolean, baseLoaded: Boolean,
    deedActionsAllowed: Boolean, raidKnown: Boolean, raidActive: Boolean, ordersAllowed: Boolean,
    savedClosable: Boolean = false): String? = when {
    savedConstruction && savedClosable -> SAVED_CONSTRUCTION_CLOSABLE
    // Owner field result 2026-10-06: a toast shows two lines, so the sentence fits them (was 84 characters and cut).
    savedConstruction -> SAVED_CONSTRUCTION_CHECK
    busy || !baseLoaded -> "Your kingdom is updating. Wait, then try BUILD again."
    !deedActionsAllowed && raidActive -> Copy.ACTIVE_RAID_MESSAGE
    !deedActionsAllowed && !raidKnown -> "Raid status is unavailable. Wait for your kingdom to reconnect, then try BUILD again."
    !deedActionsAllowed -> "This base is read-only. Open an available kingdom from your bases."
    !ordersAllowed -> "Install the available native app update before submitting game orders. Your account is preserved."
    else -> null
}

/** Legacy hosts can omit the new metadata; their existing gates still refuse with visible feedback. */
internal fun homeBuildDoorReason(enabled: Boolean, readOnly: Boolean, reason: String?): String? =
    if (enabled && !readOnly) null else reason?.takeIf { it.isNotBlank() }
        ?: "BUILD is unavailable right now. Check the notices on Home, then try again."

/** The BUILD toast while the saved construction is unanswered: two toast lines at most, pointing at its card. */
internal const val SAVED_CONSTRUCTION_CHECK = "Check the saved request on its card below your kingdom name."

/** The BUILD toast once the saved construction can be closed: two toast lines at most, naming the card's CLOSE door. */
internal const val SAVED_CONSTRUCTION_CLOSABLE = "The server has no record of the saved request. CLOSE it above."

/** A refusal caused by a saved construction ([savedConstruction]) also asks Home to bring its recovery card into view
 *  ([showRecovery]: unfold the herald, step the selection aside), so the toast never points at a card the player cannot see. */
internal fun dispatchHomeBuildDoor(enabled: Boolean, readOnly: Boolean, reason: String?,
    open: () -> Unit, explain: (String) -> Unit, savedConstruction: Boolean = false, showRecovery: () -> Unit = {}) {
    val refusal = homeBuildDoorReason(enabled, readOnly, reason)
    if (refusal == null) { open(); return }
    explain(refusal)
    if (savedConstruction) showRecovery()
}

/** Keep the button tappable: its action explains, and its state description says the same sentence. */
internal fun homeHudWithBuildRefusal(ui: HomeHudUi, reason: String?): HomeHudUi = ui.copy(
    deck = ui.deck.map { if (it.id == HudIds.BUILD) it.copy(stateDescription = reason) else it },
)
