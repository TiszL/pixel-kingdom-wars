package gg.pixelkingdomwars.nativeclient.ui.battle

import gg.pixelkingdomwars.nativeclient.data.StagingReservationStatus
import gg.pixelkingdomwars.nativeclient.network.BattlePhase
import gg.pixelkingdomwars.nativeclient.network.LiveBattleState
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.Copy
import kotlinx.serialization.json.JsonObject

/** The last value a battle HUD element showed. A replacement revision recomputes its progress index off the
 * main thread, and a first deploy can still be refused; neither may blank, dim or bring back text that was
 * already on screen (owner 2026-09-18: deploying fast flashed "—%", dimmed the stars and rewrote the hint).
 * Display only: automatic FINISH keeps reading the unlatched index, so no game decision uses a held value. */
internal class BattleHudLatch<T : Any> {
    var value: T? = null; private set
    fun offer(next: T?): T? { if (next != null) value = next; return value }
}

/** The deploy prompt is shown only until the first troop or hero of the battle is committed. After that the
 * line is blank and its slot stays reserved (see BattleHud), so a deploy, its receipt or an invalid tap can
 * neither rewrite nor resize the HUD. The gold-framed card already shows the selection. */
internal fun battleDeployPrompt(running: Boolean, committed: Boolean, selection: String?): String =
    if (committed) "" else (if (running) "DEPLOY RESERVES" else "TAP THE FIELD TO DEPLOY") + (selection?.let { " · $it" } ?: "")

/** The HUD's single hint line, null only when the battle has no line at all (no march, or a settled one).
 * Everything here other than [battleDeployPrompt] is a battle state message (a reservation check, an unconfirmed
 * retreat, a destroyed target, a wiped field — web RaidUI's D-106 fight-open band), none of which a successful
 * deploy produces. [destroyed] and [field] are the latched display values. An invalid tap is dropped silently
 * like the web; it no longer borrows this line. */
internal fun battleHintLine(live: LiveBattleState, stagingInputAllowed: Boolean, stagingReservation: StagingReservationStatus,
    nextTargetIntent: Boolean, retreating: Boolean, destroyed: Int?, field: BattleHudProgress.Field?, reservesLeft: Boolean,
    committed: Boolean, selection: String?): String? {
    if (live.terminal || live.pending == null) return null
    return when {
        live.phase == BattlePhase.STAGING && !stagingInputAllowed -> when (stagingReservation) {
            StagingReservationStatus.WAITING -> "WAITING FOR BATTLE STATUS…"
            StagingReservationStatus.WINDOW_CLOSED -> "DEPLOYMENT WINDOW CLOSED"
            StagingReservationStatus.FAILED -> "RECONNECT TO CHECK THIS MARCH"
            else -> "CHECKING THIS MARCH…"
        }
        nextTargetIntent -> if (retreating) Copy.CONFIRMING_RETREAT else Copy.RETREAT_UNCONFIRMED
        // Web `battle:done` → commitRaid and the D-106 fight-open band: an empty field under a running clock must say why.
        live.phase == BattlePhase.RUNNING && (destroyed ?: 0) >= 100 -> "TARGET DESTROYED · CONFIRMING RESULT…"
        live.phase == BattlePhase.RUNNING && field != null && field.deployed > 0 && field.alive == 0 ->
            if (reservesLeft) "YOUR TROOPS FELL · THE FIGHT IS STILL ON · DEPLOY MORE OR RETREAT" else "NO TROOPS LEFT · RESULT AT THE CLOCK END"
        else -> battleDeployPrompt(live.phase == BattlePhase.RUNNING, committed, selection)
    }
}

/** True once any deploy or hero order of this battle is accepted, saved or being admitted. */
internal fun battleTroopsCommitted(live: LiveBattleState): Boolean {
    val kinds = setOf("deploy", "hero")
    return live.commands.any { it.string("kind") in kinds } ||
        (live.pending?.writes.orEmpty() + live.preparingWrites).any { (it.body["command"] as? JsonObject)?.string("kind") in kinds }
}

/** Red lines under the pills. The coordinator's line shows only while it blocks the battle: its ordinary value is
 * set by a failed send and cleared by the next receipt or presentation page, so it appeared and vanished with
 * deploys and resized the HUD. A refused deploy already answers on the field (its marker leaves, the card counter
 * returns) and an unconfirmed one through the recovery pill; start, finish, speed and rally errors still arrive
 * as [domainError], and a lost connection keeps its own RAID OFFLINE line. */
internal fun battleErrorLines(live: LiveBattleState, domainError: String?, notice: String?, createFailed: Boolean): List<String> =
    listOfNotNull(live.error?.takeIf { !createFailed && live.blocked }, domainError?.takeIf { !createFailed }, notice).distinct()
