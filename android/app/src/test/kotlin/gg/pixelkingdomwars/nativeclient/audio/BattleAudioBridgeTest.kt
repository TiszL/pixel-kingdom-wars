package gg.pixelkingdomwars.nativeclient.audio

import gg.pixelkingdomwars.nativeclient.renderer.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class BattleAudioBridgeTest {
    private val tree = audioReference.getValue("catalogue").jsonObject
    private fun scene(revision: String = "v1", events: List<String> = emptyList()) = BattleScene(
        BaseScene(emptyList(), 1, 1, 1f), PresentationRevision("raid", revision, 14, 1, 0, events.map(PresentationEvent::fromJson)),
        emptyMap(), 256f, 100f, 1, 1)
    private fun frame(tick: Float, token: Long = 1, epoch: Long = 1, playing: Boolean = true, actors: List<BattleAudioActor> = emptyList()) =
        BattleAudioRenderFrame("raid", "v1", tick, playing, token, epoch, actors)
    private val shot = BattleAudioCue(100.0, "sfx_battle_star_1", "star:1:star")
    private val fuse = BattleAudioCue(0.0, "sfx_troop_kegrunner_fuse_loop", "1:0:deploy:fuse", loop = true, dispatch = AudioDispatch.ACTOR_LOOP)
    private val burrow = BattleAudioCue(100.0, "sfx_troop_tunneler_burrow_loop", "2:1:burrow", loop = true, dispatch = AudioDispatch.ACTOR_LOOP)
    private fun plan(cues: List<BattleAudioCue> = listOf(shot), changes: List<BattleLoopChange> = emptyList()) =
        PreparedBattleAudio("raid", "v1", 100, cues, changes)
    private class Sink : BattleAudioSink {
        val cursor = BattleAudioCursor(); val shots = mutableListOf<BattleAudioCue>(); val loops = mutableMapOf<String, BattleAudioCue>()
        val advances = mutableListOf<Double>(); var closed = false
        override fun replace(cues: List<BattleAudioCue>, fromMs: Double) { cursor.replace(cues, fromMs) }
        override fun advance(toMs: Double, audible: Boolean) { advances += toMs; shots += cursor.advance(toMs, audible) }
        override fun actorLoop(actor: String, cue: BattleAudioCue) { loops[actor] = cue }
        override fun actorEnded(actor: String) { loops.remove(actor) }
        override fun close() { closed = true; loops.clear() }
    }
    @Test fun `no drawn frame during pause resume still invalidates the old admission`() {
        val gate = AudioFrameGate(); gate.change(true); val old = gate.epoch()
        gate.change(false); gate.change(true)
        assertFalse(gate.accepts(old)); assertTrue(gate.accepts(gate.epoch())); assertFalse(gate.accepts(-1))
    }
    @Test fun `queued pre pause frame cannot consume or overwrite current resumed cursor`() {
        val tasks = ArrayDeque<() -> Unit>(); val gate = AudioFrameGate(); gate.change(true)
        val received = mutableListOf<Float>()
        val mailbox = AudioFrameMailbox({ tasks += it }, { gate.accepts(it.admissionEpoch) }, { f, _ -> received += f.tick })
        val old = frame(9f, epoch = gate.epoch()); mailbox.offer(old)
        gate.change(false); gate.change(true); tasks.removeFirst()()
        assertTrue(received.isEmpty())
        mailbox.offer(frame(1f, epoch = gate.epoch())); mailbox.offer(old); tasks.removeFirst()()
        assertEquals(listOf(1f), received); mailbox.close()
    }
    @Test fun `main thread congestion has one mailbox task and explicitly drops elapsed sounds`() {
        val tasks = ArrayDeque<() -> Unit>(); val received = mutableListOf<Pair<Float, Boolean>>()
        val mailbox = AudioFrameMailbox({ tasks += it }, { true }, { f, gap -> received += f.tick to gap })
        repeat(100) { mailbox.offer(frame(it.toFloat())) }
        assertEquals(1, tasks.size); tasks.removeFirst()()
        assertEquals(listOf(99f to true), received)
        mailbox.offer(frame(100f)); tasks.removeFirst()()
        assertEquals(100f to false, received.last()); mailbox.close()
    }
    @Test fun `destroyed mailbox does not deliver its already queued frame`() {
        val tasks = ArrayDeque<() -> Unit>(); var calls = 0
        val mailbox = AudioFrameMailbox({ tasks += it }, { true }, { _, _ -> calls++ })
        mailbox.offer(frame(1f)); mailbox.close(); tasks.removeFirst()(); mailbox.offer(frame(2f))
        assertEquals(0, calls); assertTrue(tasks.isEmpty())
    }
    @Test fun `ordinary consecutive drawn frames dispatch exact current deterministic cue once`() {
        val sink = Sink(); val player = BattleFramePlayback(sink); player.replace(plan())
        player.frame(frame(0f), false); player.frame(frame(1f), false); player.frame(frame(1f), false)
        assertEquals(listOf(shot), sink.shots); player.close()
    }
    @Test fun `first resumed frame discards missing one shots even without an intermediate paused frame`() {
        val sink = Sink(); val player = BattleFramePlayback(sink); player.replace(plan())
        player.frame(frame(0f), false); player.frame(frame(2f, epoch = 3), false)
        assertTrue(sink.shots.isEmpty()); player.close()
    }
    @Test fun `same raid revision explicit seek never consumes cues crossed by control mutation`() {
        val sink = Sink(); val player = BattleFramePlayback(sink); player.replace(plan())
        player.frame(frame(0f), false); player.frame(frame(2f, token = 2), false)
        assertTrue(sink.shots.isEmpty())
        player.frame(frame(0f, token = 3), false); player.frame(frame(1f, token = 3), false)
        assertEquals(listOf(shot), sink.shots); player.close()
    }
    @Test fun `cold prefix late plan pause and conflated gap cannot replay their boundary cues`() {
        for (kind in listOf("cold", "pause", "gap")) {
            val sink = Sink(); val player = BattleFramePlayback(sink); player.replace(plan())
            if (kind != "cold") player.frame(frame(0f), false)
            player.frame(frame(1f, playing = kind != "pause"), kind == "gap")
            assertTrue(kind, sink.shots.isEmpty()); player.close()
        }
    }
    @Test fun `fresh actually drawn zero may play zero cues but silent replacement cannot`() {
        val zero = shot.copy(atMs = 0.0)
        for (fresh in listOf(true, false)) {
            val sink = Sink(); val player = BattleFramePlayback(sink); player.replace(plan(listOf(zero)), fresh)
            player.frame(frame(0f), false)
            assertEquals(if (fresh) listOf(zero) else emptyList<BattleAudioCue>(), sink.shots); player.close()
        }
    }
    @Test fun `rehydrated actor loops require present matching visual ownership and current burrow state`() {
        val sink = Sink(); val player = BattleFramePlayback(sink)
        player.replace(plan(listOf(fuse, burrow), listOf(BattleLoopChange(0.0, 1, fuse), BattleLoopChange(100.0, 2, burrow))))
        player.frame(frame(2f), false); assertTrue(sink.loops.isEmpty())
        player.frame(frame(3f, actors = listOf(BattleAudioActor(1, "tunneler", true), BattleAudioActor(2, "tunneler", false))), false)
        assertTrue(sink.loops.isEmpty())
        player.frame(frame(4f, actors = listOf(BattleAudioActor(1, "kegrunner", false), BattleAudioActor(2, "tunneler", true))), false)
        assertEquals(setOf("1", "2"), sink.loops.keys)
        player.frame(frame(5f, actors = listOf(BattleAudioActor(2, "tunneler", true))), false)
        assertEquals(setOf("2"), sink.loops.keys)
        player.frame(frame(6f, playing = false), false); assertTrue(sink.loops.isEmpty()); player.close()
    }
    @Test fun `authoritative death emerge and detonate terminate loops including simultaneous start death`() {
        val selected = PreparedBattleAudio.from(scene(events = listOf(
            """{"e":"deploy","t":0,"id":1,"troop":"kegrunner"}""",
            """{"e":"deploy","t":0,"id":2,"troop":"tunneler"}""",
            """{"e":"burrow","t":1,"id":2}""",
            """{"e":"emerge","t":2,"id":2}""",
            """{"e":"detonate","t":2,"id":1}""",
            """{"e":"deploy","t":2,"id":3,"troop":"kegrunner"}""",
            """{"e":"troopDeath","t":2,"id":3}""")), tree)
        val sink = Sink(); val player = BattleFramePlayback(sink); player.replace(selected)
        val proof = listOf(BattleAudioActor(1, "kegrunner", false), BattleAudioActor(2, "tunneler", true), BattleAudioActor(3, "kegrunner", false))
        player.frame(frame(1f, actors = proof), false); assertEquals(setOf("1", "2"), sink.loops.keys)
        player.frame(frame(2f, actors = proof), false); assertTrue(sink.loops.isEmpty())
        assertFalse("A detonation does not prove the earlier prime body was drawn", sink.shots.any { it.dispatch == AudioDispatch.KEG_PRIME })
        player.close()
    }
    @Test fun `unrelated raid and replacement revision never advance the current playback`() {
        val sink = Sink(); val player = BattleFramePlayback(sink); player.replace(plan())
        player.frame(frame(0f), false)
        player.frame(frame(1f).copy(raidId = "other"), false); player.frame(frame(1f).copy(revision = "new"), false)
        assertEquals(listOf(0.0), sink.advances); player.close()
    }
    @Test fun `bridge rejects queued old same revision control before touching current sink`() = runTest {
        val gate = AudioFrameGate().also { it.change(true) }; val tasks = ArrayDeque<() -> Unit>(); val sinks = mutableListOf<Sink>()
        val bridge = BattleAudioBridge(this, gate, { tree }, { Sink().also { sinks += it } }, { tasks += it }, { _, _ -> plan() })
        val old = bridge.change(scene()); runCurrent()
        bridge.mailbox.offer(frame(0f, old, gate.epoch())); tasks.removeFirst()()
        bridge.mailbox.offer(frame(1f, old, gate.epoch()))
        val current = bridge.control(); tasks.removeFirst()()
        assertTrue(sinks.first().closed); assertEquals(1, sinks.size)
        bridge.mailbox.offer(frame(2f, current, gate.epoch())); tasks.removeFirst()()
        assertTrue(sinks.all { it.shots.isEmpty() }); assertEquals(listOf(200.0), sinks.last().advances)
        bridge.close()
    }
    @Test fun `canceled old revision plan cannot install after current revision or identity replacement`() = runTest {
        val gate = AudioFrameGate().also { it.change(true) }; val tasks = ArrayDeque<() -> Unit>(); val sink = Sink()
        val old = CompletableDeferred<Unit>(); var calls = 0
        var catalogue = tree
        val bridge = BattleAudioBridge(this, gate, { catalogue }, { sink }, { tasks += it }, { _, _ ->
            if (++calls == 1) withContext(NonCancellable) { old.await() }
            plan()
        })
        bridge.change(scene()); runCurrent()
        catalogue = JsonObject(tree.toMap()); gate.change(false); bridge.environmentChanged(); gate.change(true)
        runCurrent(); old.complete(Unit); runCurrent()
        val token = bridge.control(); bridge.mailbox.offer(frame(0f, token, gate.epoch())); tasks.removeFirst()()
        bridge.mailbox.offer(frame(1f, token, gate.epoch())); tasks.removeFirst()()
        assertEquals(2, calls); assertEquals(listOf(shot), sink.shots); bridge.close()
    }
    @Test fun `new identity cannot adopt the old scene on its next drawn frame`() = runTest {
        val gate = AudioFrameGate().also { it.change(true) }; val tasks = ArrayDeque<() -> Unit>(); val sinks = mutableListOf<Sink>()
        val bridge = BattleAudioBridge(this, gate, { tree }, { Sink().also { sinks += it } }, { tasks += it }, { _, _ -> plan() })
        val old = bridge.change(scene()); runCurrent()
        bridge.mailbox.offer(frame(0f, old, gate.epoch())); tasks.removeFirst()()
        gate.change(false); bridge.sourceReplaced(); gate.change(true)
        bridge.mailbox.offer(frame(1f, old, gate.epoch()))
        assertTrue(tasks.isEmpty()); assertTrue(sinks.single().closed)
        val next = bridge.change(scene()); runCurrent()
        bridge.mailbox.offer(frame(0f, next, gate.epoch())); tasks.removeFirst()()
        bridge.mailbox.offer(frame(1f, next, gate.epoch())); tasks.removeFirst()()
        assertEquals(listOf(shot), sinks.last().shots); bridge.close()
    }
    @Test fun `closing bridge cancels preparation and never creates a sink from late success`() = runTest {
        val gate = AudioFrameGate().also { it.change(true) }; val blocked = CompletableDeferred<Unit>(); var sinks = 0
        val bridge = BattleAudioBridge(this, gate, { tree }, { sinks++; Sink() }, { it() }, { _, _ ->
            withContext(NonCancellable) { blocked.await() }; plan()
        })
        val token = bridge.change(scene()); runCurrent(); bridge.close(); blocked.complete(Unit); runCurrent()
        bridge.mailbox.offer(frame(1f, token, gate.epoch())); assertEquals(0, sinks)
    }
}
