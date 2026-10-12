package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.network.BattleClock
import gg.pixelkingdomwars.nativeclient.network.BattlePhase
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.data.ContentState
import java.io.File
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A complete decoded presentation, separate from the independently arriving result receipt. */
internal data class PreparedLiveBattle(val scene: BattleScene, val terminal: Boolean,
    val commandTiming: gg.pixelkingdomwars.nativeclient.diagnostics.LocalCommandDrawTiming.Prepared? = null,
    val mappingKey: LiveBattleMappingKey? = null,
    val preparationOrdinal: Long? = null)

/** Only a successfully accepted mapping can be reused. Clock samples, transport receipt
 * times and optional diagnostic ordinals do not change its canonical scene. */
internal data class LiveBattleMappingKey(val raidId: String, val revision: String, val terminal: Boolean,
    val assets: File, val catalogue: JsonObject, val renderCatalogue: JsonObject,
    val contentVersion: String?, val retry: Int)

internal fun liveBattleMappingKey(data: JsonObject, content: ContentState, retry: Int): LiveBattleMappingKey? {
    if (!content.ready) return null
    return LiveBattleMappingKey(
        data.string("raidId") ?: return null, data.string("revision") ?: return null,
        data.string("source") == "archive" || data.string("status") == "resolved",
        requireNotNull(content.assets), requireNotNull(content.catalogue), requireNotNull(content.renderCatalogue),
        content.manifest?.contentVersion, retry)
}

internal fun retainedLiveMapping(current: PreparedLiveBattle?, key: LiveBattleMappingKey): PreparedLiveBattle? =
    current?.takeIf { it.mappingKey == key && it.scene.revision.raidId == key.raidId &&
        it.scene.revision.revision == key.revision && it.terminal == key.terminal }

/** Keep recovery's historical prefix fixed across complete presentation replacements.
 * Advancing it with each poll would repeatedly suppress newly started body/effect cues. */
internal fun prepareLiveStart(current: PreparedLiveBattle?, candidate: PreparedLiveBattle,
    canonicalPlayheadMs: Double): PreparedLiveBattle {
    require(canonicalPlayheadMs.isFinite() && canonicalPlayheadMs >= 0)
    // A cold archive opens at its event end. A retained running clock may be
    // ahead of an early finish and cannot define that archive's hydration boundary.
    val tick = if(candidate.terminal) candidate.scene.revision.events.lastOrNull()?.t?.toDouble() ?: 0.0
        else canonicalPlayheadMs / candidate.scene.tickDurationMs
    require(tick <= Int.MAX_VALUE)
    val start = current?.takeIf { it.scene.revision.raidId == candidate.scene.revision.raidId }
        ?.scene?.presentationStart ?: BattlePresentationStart.ColdPrefix(tick.toFloat())
    return candidate.copy(scene = candidate.scene.copy(presentationStart = start))
}

internal fun acceptLivePresentation(current: PreparedLiveBattle?, candidate: PreparedLiveBattle,
    resultReceived: Boolean, expectedRaidId: String?): PreparedLiveBattle? {
    // A coordinator survives NEXT TARGET. Its old battlefield must not survive
    // the reservation changing, including the gap before the next raid exists.
    val retained = current?.takeIf { it.scene.revision.raidId == expectedRaidId }
    return if(candidate.scene.revision.raidId != expectedRaidId || (resultReceived && !candidate.terminal)) retained else candidate
}

internal fun livePlaybackScene(prepared: PreparedLiveBattle, playheadMs: Double,
    phase: BattlePhase, resultReceived: Boolean, rate: Float): BattleScene {
    val hold = resultReceived && !prepared.terminal
    // A receipt cannot certify the future of an older prediction. Pause at the
    // renderer's actual tick, then retain that tick when the final archive replaces it.
    return prepared.scene.copy(
        playheadTick = if(prepared.terminal) prepared.scene.revision.events.lastOrNull()?.t?.toFloat() ?: 0f
            else (playheadMs / prepared.scene.tickDurationMs).toFloat(),
        playing = prepared.terminal || (!hold && phase == BattlePhase.RUNNING),
        retainPlaybackTick = hold || prepared.terminal,
        rate = rate, liveClock = true)
}

/* Owner 2026-10-11 (Seeker, code 33): after ATTACK the troops stood still, then the battle played "accelerated". The
 * first simulated revision reaches the phone seconds after the server clock starts. The field used to open it at server
 * time (mid-march) and then seek forward on every later update. Now the field shows the battle a fixed lag L behind the
 * server clock, so it plays from the troops' deploy points at the clock's own rate. L never shrinks: there is no
 * speed-up, and the last L seconds play after the result through the hold path above. Deploy orders, the countdown,
 * the clock-due finish and settlement stay on server time. */

/** Where a prepared scene's shown time may begin: its cold boundary (0 for a battle first prepared before its start). */
private fun PreparedLiveBattle.coldBoundaryMs(): Double =
    ((scene.presentationStart as? BattlePresentationStart.ColdPrefix)?.fromTick?.toDouble() ?: 0.0) * scene.tickDurationMs

/** L is fixed once, by the first live (non-terminal) revision with events accepted after the clock started, as the
 * server playhead then minus where that revision's battle begins: its first event, never before its cold boundary
 * (0 for staged troops; a reopened battle continues from where it opened). Afterwards [fixed] is returned unchanged.
 * L is at most [LIVE_BATTLE_MAX_PRESENTATION_LAG_MS] (K-night-L2, 2026-10-12): a first revision that arrives very late
 * (app backgrounded after ATTACK, dropped connection, slow server) opens once at server time minus the cap instead of
 * holding the whole battle that far behind; the cap is then held like any other L. */
internal fun livePresentationLagMs(fixed: Double?, accepted: PreparedLiveBattle?, serverPlayheadMs: Double,
    clockStarted: Boolean): Double? {
    if (fixed != null) return fixed
    val prepared = accepted?.takeIf { clockStarted && !it.terminal } ?: return null
    val first = prepared.scene.revision.events.firstOrNull() ?: return null
    val startMs = maxOf(first.t * prepared.scene.tickDurationMs.toDouble(), prepared.coldBoundaryMs())
    return (serverPlayheadMs - startMs).coerceIn(0.0, LIVE_BATTLE_MAX_PRESENTATION_LAG_MS)
}

/** The time the field and its progress show, never ahead of the server clock. Before L exists an accepted scene holds
 * at its cold boundary (the troops wait where they were placed); with no scene yet, the server clock still defines the
 * cold boundary of the first one. The server clock stops at its duration; the shown battle keeps its pace through its
 * last L. */
internal fun liveShownPlayheadMs(clock: BattleClock?, nowNanos: Long, lagMs: Double?, scene: PreparedLiveBattle?): Double {
    val server = clock?.playheadMs(nowNanos) ?: 0.0
    if (lagMs == null) return if (scene == null) server else minOf(scene.coldBoundaryMs(), server)
    val running = clock?.takeIf { it.value.anchorWallAt != null }?.let { started ->
        started.value.simNowMs + ((nowNanos - started.receivedAtNanos).coerceAtLeast(0) / 1_000_000.0) * started.value.rate } ?: server
    return (running - lagMs).coerceIn(0.0, server)
}

internal fun BattlePlaybackFrame.matches(scene: BattleScene): Boolean =
    raidId == scene.revision.raidId && revision == scene.revision.revision

/** WATCH AGAIN must pass the same raid identity fence as the live presentation. */
internal fun archivedSpectatorReplay(presentation: JsonObject?, result: JsonObject?, raidId: String): JsonObject? =
    presentation?.takeIf { result != null && it.string("source") == "archive" && it.string("raidId") == raidId }
        ?.let { JsonObject(it + ("id" to JsonPrimitive(raidId))) }
