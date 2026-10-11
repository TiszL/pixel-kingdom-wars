package gg.pixelkingdomwars.nativeclient.audio

import gg.pixelkingdomwars.nativeclient.renderer.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.Closeable
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** One immutable snapshot lets the GL thread capture admission before drawing. A pause/resume
 * changes the epoch even when Android draws no frame in between. */
class AudioFrameGate {
    private data class State(val epoch: Long, val allowed: Boolean)
    private val state = AtomicReference(State(0, false))
    fun epoch(): Long = state.get().let { if (it.allowed) it.epoch else -1 }
    fun change(allowed: Boolean) { state.updateAndGet { State(it.epoch + 1, allowed) } }
    fun accepts(epoch: Long) = epoch >= 0 && epoch() == epoch
}

/** One posted main task at a time. Dropping intermediate frames means dropping their sounds,
 * never replaying a backlog after a busy UI or wallet transition. */
class AudioFrameMailbox(private val post: (() -> Unit) -> Unit,
                        private val accepts: (BattleAudioRenderFrame) -> Boolean,
                        private val consume: (BattleAudioRenderFrame, gap: Boolean) -> Unit) : Closeable {
    private var pending: BattleAudioRenderFrame? = null
    private var gap = false
    private var posted = false
    private var closed = false
    @Synchronized fun offer(frame: BattleAudioRenderFrame) {
        if (closed || !accepts(frame)) return
        if (pending != null) gap = true
        pending = frame
        if (!posted) { posted = true; post(::drain) }
    }
    private fun drain() {
        val delivery = synchronized(this) {
            if (closed) return
            val frame = pending; val skipped = gap
            pending = null; gap = false; posted = false
            frame?.let { it to skipped }
        } ?: return
        if (accepts(delivery.first)) consume(delivery.first, delivery.second)
    }
    @Synchronized override fun close() { closed = true; pending = null }
}

data class BattleLoopChange(val atMs: Double, val actor: Int, val cue: BattleAudioCue?)
data class PreparedBattleAudio(val raidId: String, val revision: String, val tickMs: Long,
                               val cues: List<BattleAudioCue>, val loopChanges: List<BattleLoopChange>) {
    val loopTracks: Map<Int, List<BattleLoopChange>> = loopChanges.groupBy { it.actor }
    val primeCues: Map<String, BattleAudioCue> = cues.filter { it.dispatch == AudioDispatch.KEG_PRIME }.associateBy { it.variantKey }
    companion object {
        /** Runs with the accepted renderer revision on Default, never in a frame/main callback. */
        fun from(scene: BattleScene, catalogue: JsonObject, checkpoint: () -> Unit = {}): PreparedBattleAudio {
            val bounds = BattleAudioBounds.from(catalogue)
            val events = scene.revision.events.map { checkpoint(); Json.parseToJsonElement(it.json).jsonObject }
            val cues = BattleAudioPlan(bounds).plan(events, scene.base.buildings.mapNotNull { b -> b.type?.let { b.id to it } }.toMap(), checkpoint)
            val changes = cues.filter { it.dispatch == AudioDispatch.ACTOR_LOOP }.mapNotNull { cue ->
                cue.variantKey.substringBefore(':').toIntOrNull()?.let { BattleLoopChange(cue.atMs, it, cue) }
            }.toMutableList()
            events.forEach { event ->
                checkpoint()
                if (event["e"]?.jsonPrimitive?.content in setOf("emerge", "troopDeath", "detonate")) {
                    val id = event["id"]?.jsonPrimitive?.intOrNull
                    val tick = event["t"]?.jsonPrimitive?.doubleOrNull
                    if (id != null && tick != null && tick.isFinite() && tick >= 0)
                        changes += BattleLoopChange(tick * bounds.tickMs, id, null)
                }
            }
            // Stop after start at an equal authoritative tick: a dead/detonated actor owns no loop.
            changes.sortWith(compareBy<BattleLoopChange> { it.atMs }.thenBy { it.cue == null }.thenBy { it.actor })
            return PreparedBattleAudio(scene.revision.raidId, scene.revision.revision, bounds.tickMs, cues, changes)
        }
    }
}

/** Narrow presentation sink keeps frame admission tests independent of Android's decoder. */
interface BattleAudioSink : Closeable {
    fun replace(cues: List<BattleAudioCue>, fromMs: Double)
    fun advance(toMs: Double, audible: Boolean)
    fun actorLoop(actor: String, cue: BattleAudioCue)
    fun actorEnded(actor: String)
    fun actorCue(cue: BattleAudioCue) {}
}

/** Main-thread state machine. Only actual admitted frames move this cursor. */
class BattleFramePlayback(private val sink: BattleAudioSink) : Closeable {
    private var plan: PreparedBattleAudio? = null
    private var position: Double? = null
    private var frameEpoch = -1L
    private var control = -1L
    private var nextLoop = 0
    private val active = mutableMapOf<Int, BattleAudioCue>()
    private val playingLoops = mutableMapOf<Int, BattleAudioCue>()
    private var fresh = false
    private var primeCues = emptyMap<String,BattleAudioCue>()
    private var wasPlaying = false
    fun replace(value: PreparedBattleAudio, freshStart: Boolean = false, fromMs: Double = 0.0) {
        stopLoops(); plan = value; position = null; nextLoop = 0; active.clear(); fresh = freshStart
        primeCues=value.primeCues
        sink.replace(value.cues, fromMs)
    }
    fun frame(frame: BattleAudioRenderFrame, gap: Boolean) {
        val selected = plan ?: return
        if (frame.raidId != selected.raidId || frame.revision != selected.revision || !frame.tick.isFinite() || frame.tick < 0) return
        val now = frame.tick.toDouble() * selected.tickMs
        val reset = position == null || now < requireNotNull(position) || control != frame.controlToken || frameEpoch != frame.admissionEpoch || gap || wasPlaying != frame.playing
        if (reset) {
            stopLoops(); active.clear()
            nextLoop = loopPosition(selected.loopChanges, now)
            selected.loopTracks.forEach { (actor, changes) ->
                changes.getOrNull(loopPosition(changes, now) - 1)?.cue?.let { active[actor] = it }
            }
            sink.replace(selected.cues, now)
        }
        // A fresh, actually drawn zero frame may own its zero-tick cues. A cold prefix,
        // resumed scene, seek, late plan or queued gap has no historical one-shot ownership.
        val initial = position == null && fresh && now == 0.0 && !gap
        sink.advance(now, frame.playing && (!reset || initial))
        while (nextLoop < selected.loopChanges.size && selected.loopChanges[nextLoop].atMs <= now) {
            val change = selected.loopChanges[nextLoop++]
            if (change.cue == null) active.remove(change.actor) else active[change.actor] = change.cue
        }
        val proof = frame.actors.associateBy { it.id }
        if(frame.playing && (!reset || initial))for(actor in proof.values) {
            val prime=actor.kegPrime ?: continue
            if(actor.identity!="kegrunner" || actor.burrowed || !prime.startTick.isFinite() ||
                prime.startTick<0 || prime.startTick>=prime.detonateTick ||
                frame.tick<prime.startTick || frame.tick>=prime.detonateTick)continue
            val start=prime.startTick.toDouble()*selected.tickMs
            // Proof is attached only to the actual prime sprite. A reset cannot own its
            // first resumed frame; subsequent frames cannot turn a missed start into a cue.
            if(!(initial && start==0.0) && !(position?.let { it<start }==true && start<=now))continue
            val key="${actor.id}:${prime.detonateTick}:detonate:prime"
            primeCues[key]?.takeIf { it.atMs==prime.detonateTick.toDouble()*selected.tickMs }?.let(sink::actorCue)
        }
        val desired = if (!frame.playing) emptyMap() else active.filter { (id, cue) ->
            proof[id]?.let { actor -> when {
                cue.family == "sfx_troop_kegrunner_fuse_loop" -> actor.identity == "kegrunner"
                cue.family == "sfx_troop_${actor.identity}_burrow_loop" -> actor.burrowed && actor.identity in setOf("tunneler", "bilgewraith")
                else -> false
            } } == true
        }
        playingLoops.keys.filter { playingLoops[it] != desired[it] }.forEach { sink.actorEnded(it.toString()); playingLoops.remove(it) }
        desired.forEach { (id, cue) -> if (playingLoops[id] != cue) { sink.actorLoop(id.toString(), cue); playingLoops[id] = cue } }
        position = now; frameEpoch = frame.admissionEpoch; control = frame.controlToken; fresh = false; wasPlaying = frame.playing
    }
    private fun loopPosition(changes: List<BattleLoopChange>, now: Double): Int {
        var low = 0; var high = changes.size
        while (low < high) { val mid = (low + high) ushr 1; if (changes[mid].atMs <= now) low = mid + 1 else high = mid }
        return low
    }
    private fun stopLoops() { playingLoops.keys.forEach { sink.actorEnded(it.toString()) }; playingLoops.clear() }
    override fun close() { stopLoops(); sink.close(); plan = null }
}

/** One surface lease. Scene/control changes fence the producer before the renderer command is
 * enqueued. Cancelling a preparation cannot install a plan into a new identity or catalogue. */
class BattleAudioBridge(
    private val scope: CoroutineScope, private val gate: AudioFrameGate,
    private val catalogue: () -> JsonObject?, private val sink: () -> BattleAudioSink?,
    post: (() -> Unit) -> Unit,
    private val prepare: suspend (BattleScene, JsonObject) -> PreparedBattleAudio = { scene, tree ->
        withContext(Dispatchers.Default) { PreparedBattleAudio.from(scene, tree) { ensureActive() } }
    },
) : Closeable {
    private val expected = AtomicLong(-1)
    private var scene: BattleScene? = null
    private var tree: JsonObject? = null
    private var prepared: PreparedBattleAudio? = null
    private var job: Job? = null
    private var playback: BattleFramePlayback? = null
    private var closed = false
    private var fresh = false
    val mailbox = AudioFrameMailbox(post, { frame -> expected.get() == frame.controlToken && gate.accepts(frame.admissionEpoch) }, ::frame)
    fun epoch() = gate.epoch()
    fun change(value: BattleScene?): Long {
        val token = tokens.incrementAndGet(); expected.set(token)
        val old = scene
        fresh = old == null && value?.playheadTick == 0f && value.presentationStart == BattlePresentationStart.Continuous
        scene = value
        playback?.close(); playback = null
        if (old?.revision != value?.revision || old?.base != value?.base) { prepared = null; job?.cancel(); job = null }
        refresh()
        return token
    }
    fun control(): Long {
        val token = tokens.incrementAndGet(); expected.set(token); fresh = false
        playback?.close(); playback = null
        return token
    }
    /** An old surface cannot inherit another wallet or pack merely because it draws again. */
    fun sourceReplaced() {
        expected.set(-1); fresh = false; scene = null; prepared = null
        job?.cancel(); job = null; playback?.close(); playback = null
    }
    /** Called synchronously before/after admission changes; no GL frame is needed to stop loops. */
    fun environmentChanged() {
        fresh = false; playback?.close(); playback = null
        if (tree !== catalogue()) { prepared = null; job?.cancel(); job = null }
        refresh()
    }
    private fun refresh() {
        if (closed || prepared != null || job?.isActive == true) return
        val selected = scene ?: return
        val selectedTree = catalogue() ?: return
        tree = selectedTree
        job = scope.launch {
            try {
                val result = prepare(selected, selectedTree)
                ensureActive()
                if (!closed && scene?.revision == selected.revision && tree === selectedTree) {
                    prepared = result
                    // Start bounded rolling-bank warming while the renderer prepares. No event
                    // or actor loop is dispatched until an actual frame proves ownership.
                    if (gate.epoch() >= 0) install(result, selected.playheadTick.toDouble() * result.tickMs)
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* Optional audio cannot block or alter the accepted battle. */ }
        }
    }
    private fun frame(frame: BattleAudioRenderFrame, gap: Boolean) {
        if (closed || !gate.accepts(frame.admissionEpoch) || expected.get() != frame.controlToken) return
        val selected = prepared ?: return
        val player = playback ?: install(selected, frame.tick.toDouble() * selected.tickMs) ?: return
        player.frame(frame, gap)
    }
    private fun install(selected: PreparedBattleAudio, fromMs: Double): BattleFramePlayback? = sink()?.let {
        BattleFramePlayback(it).also { player ->
            player.replace(selected, fresh, fromMs); playback = player; fresh = false
        }
    }
    override fun close() {
        closed = true; expected.set(-1); mailbox.close(); job?.cancel(); playback?.close()
        prepared = null; scene = null; tree = null; playback = null
    }
    companion object { private val tokens = AtomicLong() }
}
