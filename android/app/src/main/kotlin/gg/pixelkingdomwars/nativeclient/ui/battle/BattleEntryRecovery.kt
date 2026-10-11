package gg.pixelkingdomwars.nativeclient.ui.battle

import gg.pixelkingdomwars.nativeclient.network.LiveBattleState

internal enum class BattleEntryRetry { CREATE, CHECK, PLAYBACK }
internal data class BattleEntryRecovery(val message: String? = null, val retry: BattleEntryRetry? = null,
    val leaveSavedView: Boolean = false)

/** Entry errors must replace the indefinite loader without confusing a safe preflight retry with a new paid raid.
 * Leaving an acknowledged but unread battlefield only hides the view; its durable march remains recoverable. */
internal fun battleEntryRecovery(live: LiveBattleState, domainError: String?, hasTarget: Boolean,
    playbackError: String?): BattleEntryRecovery {
    if (live.creating) return BattleEntryRecovery()
    val error = live.error ?: domainError
    val pending = live.pending
    val message = when {
        pending?.create != null -> error ?: "Your raid request is awaiting confirmation. Check its status or retry the same saved request."
        pending == null && live.candidates.isNotEmpty() -> "An unfinished raid is available. Resume it below."
        playbackError != null -> "Your battle is saved. Try opening it again."
        else -> error
    }
    val retry = when {
        message == null || live.blocked || live.inFlight.isNotEmpty() -> null
        pending?.create != null || (pending == null && live.candidates.isNotEmpty()) -> BattleEntryRetry.CHECK
        playbackError != null -> BattleEntryRetry.PLAYBACK
        pending?.raidId != null -> BattleEntryRetry.CHECK
        pending == null && hasTarget -> BattleEntryRetry.CREATE
        else -> null
    }
    return BattleEntryRecovery(message, retry,
        leaveSavedView = pending?.raidId != null && live.presentation == null && message != null && !live.terminal)
}
