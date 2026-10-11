package gg.pixelkingdomwars.nativeclient.audio

import java.io.Closeable
import kotlinx.coroutines.Job

/** Immutable, worker-built bank metadata; resetting the cursor never walks the event journal. */
data class PreparedBattleBanks(val windows: List<BattleAudioWindow>, val fallbackLast: Map<String, Double>)

/** Attach to the authoritative native playback clock. This does not create a timer, advance
 * simulation, or derive combat. The renderer owns actor-loop starts/stops and keg-prime phase. */
class BattleSfxPlayback(private val audio: SfxController, private val runtime: AudioRuntime) : BattleAudioSink {
    private val cursor = BattleAudioCursor()
    private var plan = emptyList<BattleAudioCue>()
    private var prepared: PreparedBattleBanks? = null
    private var preparation: Job? = null
    private var planVersion = 0L
    private var fromMs = 0.0
    private var definitionsRevision = -1L
    private var fallback: SfxBank? = null
    private val banks = mutableMapOf<Long, SfxBank>()
    private val actors = mutableMapOf<String, Closeable>()
    private var position = 0.0
    private var closed = false
    private var generation = audio.contentGeneration

    override fun replace(cues: List<BattleAudioCue>, fromMs: Double) {
        if (closed) return
        releasePlayback(); generation = audio.contentGeneration
        if (plan !== cues) { plan = cues; prepared = null; preparation?.cancel(); preparation = null; definitionsRevision = -1; planVersion++ }
        position = fromMs; this.fromMs = fromMs
        cursor.replace(plan, fromMs)
        refreshBanks()
    }
    override fun advance(toMs: Double, audible: Boolean) = advance(toMs, audible, false)
    fun advance(toMs: Double, audible: Boolean, jumped: Boolean) {
        if (closed) return
        if (generation != audio.contentGeneration) { releasePlayback(); return }
        if (!audible || jumped) { actors.values.forEach { it.close() }; actors.clear() }
        cursor.advance(toMs, audible, jumped).forEach {
            audio.playFamily(it.family, it.variantKey, it.fallback, it.volume, it.priority)
        }
        position = toMs; refreshBanks()
    }
    private fun refreshBanks() {
        if (!audio.isAudible) return
        banks.keys.filter { banks[it]?.isClosed == true }.forEach { banks.remove(it) }
        if (definitionsRevision != audio.definitionsRevision) {
            definitionsRevision = audio.definitionsRevision
            prepared = null; preparation?.cancel()
            val version = ++planVersion
            preparation = audio.prepareBattleBanks(plan) { value ->
                if (!closed && version == planVersion && generation == audio.contentGeneration) { prepared = value; refreshBanks() }
            }
        }
        val data = prepared ?: return
        if (fallback?.isClosed != false) fallback = audio.bank(data.fallbackLast.filterValues { it >= fromMs }.keys)
        val desired = data.windows.filter {
            it.startMs - runtime.battleBankPreloadLeadMs <= position &&
                it.startMs + runtime.battleBankWindowMs + runtime.battleBankPreloadLeadMs > position
        }.associateBy { it.startMs }
        banks.keys.filter { it !in desired }.forEach { banks.remove(it)?.close() }
        desired.forEach { (start, window) -> if (start !in banks) banks[start] = audio.bank(window.definitions.map { it.id }) }
    }
    override fun actorLoop(actor: String, cue: BattleAudioCue) {
        if (closed || generation != audio.contentGeneration || cue.dispatch != AudioDispatch.ACTOR_LOOP) return
        actors.remove(actor)?.close()
        actors[actor] = audio.loopFamily(cue.family, cue.variantKey, cue.fallback, cue.volume)
    }
    override fun actorEnded(actor: String) { actors.remove(actor)?.close() }
    override fun actorCue(cue: BattleAudioCue) {
        if (!closed && generation == audio.contentGeneration && cue.dispatch == AudioDispatch.KEG_PRIME)
            audio.playFamily(cue.family, cue.variantKey, cue.fallback, cue.volume, cue.priority)
    }
    private fun releasePlayback() {
        fallback?.close(); fallback = null
        banks.values.forEach { it.close() }; banks.clear()
        actors.values.forEach { it.close() }; actors.clear()
    }
    override fun close() { if (!closed) { closed = true; preparation?.cancel(); preparation = null; releasePlayback(); plan = emptyList(); prepared = null } }
}
