package gg.pixelkingdomwars.nativeclient.network

/** Optional, local-only milestones for the first HTTP page of one assembly attempt. */
enum class BattlePreparationStage { CALL_ENQUEUED, RESPONSE_HEADERS, BODY_READ, JSON_PARSED, ASSEMBLY_COMPLETE }
enum class BattlePreparationOutcome { CANCELLED, FAILED, UNCHANGED, SUPERSEDED }
interface BattlePreparationTiming {
    val ordinal: Long
    fun stage(stage: BattlePreparationStage)
    /** Ephemeral exact-revision association. Never export this value. */
    fun assembled(revision: String)
    fun finish(outcome: BattlePreparationOutcome)
}
internal fun BattlePreparationTiming?.observe(stage: BattlePreparationStage) { runCatching { this?.stage(stage) } }
internal fun BattlePreparationTiming?.end(outcome: BattlePreparationOutcome) { runCatching { this?.finish(outcome) } }
