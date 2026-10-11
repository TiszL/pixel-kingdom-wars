package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.model.BaseJob
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Quest
import gg.pixelkingdomwars.nativeclient.network.flag
import gg.pixelkingdomwars.nativeclient.network.objects
import gg.pixelkingdomwars.nativeclient.network.string
import java.time.Instant
import kotlinx.serialization.json.JsonObject

/** Where one tap on a first-run chain step sends the player (web `ui/onboardingChain.ts`). The server
 * owns which step the player is on; this only maps a template code to a destination in the shell. */
sealed interface StepDestination {
    data object Build : StepDestination
    data class ViewJob(val buildingId: String) : StepDestination
    data class FinishJob(val jobId: String, val free: Boolean, val buildingId: String?) : StepDestination
    data object Check : StepDestination
    data object Train : StepDestination
    data object BuyLand : StepDestination
    data object Raid : StepDestination
}
data class StepAction(val verb: String, val hint: String, val go: StepDestination)

/** Templates of the chain and their base building type (web `BUILD_TYPES`). */
val ONBOARDING_BUILD_TYPES: Map<String, String> = mapOf("first_camp" to "camp", "first_mine" to "mine", "first_barracks" to "barracks")

private val ACTIONS: Map<String, StepAction> = mapOf(
    "first_camp" to StepAction("BUILD", "Camps are the room your army lives in — no camps, no troops to raid with.", StepDestination.Build),
    "first_mine" to StepAction("BUILD", "Mines make Shards while you are away. Shards pay for everything you build.", StepDestination.Build),
    "first_barracks" to StepAction("BUILD", "The Barracks trains the troops you send into a raid.", StepDestination.Build),
    "first_troops" to StepAction("TRAIN", "Select troops, Review Training, then Add to Queue. Your first Finish All is free; remaining troops train in order.", StepDestination.Train),
    "first_land" to StepAction("BUY", "Your own spot on the pixel Earth — it unlocks PvP, KEEP and trading.", StepDestination.BuyLand),
    "first_raid" to StepAction("RAID", "Take your army out. Start with the Campaign — it teaches the fight and pays.", StepDestination.Raid),
)

fun isOnboardingStep(templateCode: String): Boolean = templateCode in ACTIONS

/** Web `trainingQueueBlocked`: training completion frees queue room independently of the larger Camp.
 * `trainingPts` and `barracksQueuePts` are read from the server's `armyStatus` as sent. */
fun trainingQueueBlocked(base: BaseSnapshot?): Boolean {
    val status = base?.armyStatus ?: return false
    val raw = base.raw["armyStatus"] as? JsonObject ?: return false
    val trainingPts = raw.string("trainingPts")?.toIntOrNull() ?: return false
    val queue = raw.string("barracksQueuePts")?.toIntOrNull() ?: return false
    return status.trainingTroopCount > 0 && (trainingPts >= queue || status.readyPts + trainingPts >= status.campCapacityPts)
}

/** Web `onboardingAction` needsTraining: nothing to raid with means no army unit with a count above zero
 * AND no available hero, both read from the base snapshot as the server sent them (`army[].count`,
 * `heroes[].available`). A player with an available hero is sent to RAID, not TRAIN. */
fun armyEmpty(base: BaseSnapshot): Boolean {
    val units = base.raw.objects("army").any { (it.string("count")?.toLongOrNull() ?: 0L) > 0L }
    val heroReady = base.raw.objects("heroes").any { it.flag("available") }
    return !units && !heroReady
}

/** The action for a step, or null for a template this build does not know (fail-soft: a readable
 * row with no button, never a dead tap). */
fun onboardingAction(step: Quest, base: BaseSnapshot?, landOwned: Boolean, nowMs: Long): StepAction? {
    val fallback = ACTIONS[step.templateCode] ?: return null
    val type = ONBOARDING_BUILD_TYPES[step.templateCode]
    if (type != null && base != null) {
        val building = base.buildings.firstOrNull { it.type == type }
        val job = base.jobs.firstOrNull { job -> job.kind == "build" && base.buildings.any { it.id == job.buildingId && it.type == type } }
        if (job != null) return jobAction(job, nowMs)
        if (building != null && !building.underConstruction) return StepAction("CHECK", "Your building is ready. Check your objective reward.", StepDestination.Check)
        if (base.freeBuilders <= 0 && base.jobs.isNotEmpty()) {
            val occupying = base.jobs.sortedBy { it.finishesAt.orEmpty() }.first()
            occupying.buildingId?.let { return StepAction("VIEW", "Your builder is working. Open that job to finish it or wait.", StepDestination.ViewJob(it)) }
        }
    }
    if (step.templateCode == "first_land" && landOwned) return StepAction("CHECK", "Your land is paid. Check your objective reward.", StepDestination.Check)
    val needsTraining = step.templateCode == "first_troops" || (step.templateCode == "first_raid" && base != null && armyEmpty(base))
    if (needsTraining) {
        if (trainingQueueBlocked(base)) {
            val status = requireNotNull(base?.armyStatus)
            return StepAction("WAIT", "${status.readyPts}/${status.campCapacityPts} army points ready. Wait for troop timers, then train the next group.", StepDestination.Train)
        }
        return requireNotNull(ACTIONS["first_troops"])
    }
    return fallback
}

/** Both objective surfaces share the server quote and the free action; paid jobs open their own sheet. */
private fun jobAction(job: BaseJob, nowMs: Long): StepAction {
    val elapsed = job.finishesAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }?.let { it <= nowMs } ?: false
    val free = job.finishCostKeep == "0"
    return StepAction(if (elapsed) "CHECK" else "FINISH",
        when { elapsed -> "Finishing your building — check its progress."; free -> "Finish this construction now for free, then claim your reward."; else -> "Open this building to review its finish cost." },
        if (elapsed) StepDestination.Check else StepDestination.FinishJob(job.id, free, job.buildingId))
}
