package gg.pixelkingdomwars.nativeclient.audio

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

@OptIn(ExperimentalCoroutinesApi::class)
class SfxControllerTest {
    private class Output(val mixer: SfxMixer, val failed: () -> Unit) : SfxOutput {
        var wakes = 0; var closed = false
        override fun wake() { check(!closed); wakes++ }
        override fun close() { closed = true }
        fun drain() { repeat(2) { mixer.render(FloatArray(64), 4) } }
    }
    private class Fixture(val scope: CoroutineScope, runtime: AudioRuntime = audioRuntime(), manifest: String? = null, additionalPaths: List<String> = emptyList(), nowMs: () -> Long = { 1_000L }) : AutoCloseable {
        val directory: File = Files.createTempDirectory("pkw-sfx-test").toFile()
        val outputs = mutableListOf<Output>(); val requested = mutableListOf<String>(); val decoded = mutableListOf<String>()
        var sourceFailure: Exception? = null
        var released = 0; var waitForDecode: CompletableDeferred<Unit>? = null; var active = 0; var peakActive = 0; var peakBytes = 0L
        val paths = (('a'..'h').map { "audio/sfx/sfx_$it.wav" } + listOf("audio/sfx-ai/manifest.json", "audio/sfx-ai/tap.mp3", "audio/sfx-ai/bed.wav")) + additionalPaths
        val pack = audioPack(paths = paths).copy(runtime = runtime)
        val context = MusicContext(pack, Any(), "mail", true)
        init { if (manifest != null) File(directory, "audio/sfx-ai/manifest.json").apply { requireNotNull(parentFile).mkdirs(); writeText(manifest) } }
        val controller = SfxController(scope, AudioAssetSource { _, paths ->
            val path = paths.single(); requested += path
            sourceFailure?.let { throw it }
            if (path.endsWith("manifest.json") && manifest == null) error("Optional manifest absent")
            AudioAssetLease(directory, paths) { released++ }
        }, SfxDecoder { file, budget ->
            decoded += file.name; active++; peakActive = maxOf(peakActive, active)
            var clip: PcmClip? = null
            try {
                clip = pcm(budget); peakBytes = maxOf(peakBytes, budget.usedBytes())
                waitForDecode?.let { withContext(NonCancellable) { it.await() } }
                requireNotNull(clip).also { clip = null }
            } finally { clip?.close(); active-- }
        }, SfxOutputFactory { mixer, failed -> Output(mixer, failed).also { outputs += it } }, nowMs, planningDispatcher = requireNotNull(scope.coroutineContext[kotlin.coroutines.ContinuationInterceptor]) as CoroutineDispatcher)
        override fun close() { controller.close(); directory.deleteRecursively() }
    }
    @Test fun `repeated battle cues wait out failed optional loads and still play warm samples`() = runTest {
        var now = 0L
        Fixture(this, nowMs = { now }).use { f ->
            f.controller.update(f.context, true)
            f.controller.bank(listOf("sfx_a")).ready.await()
            val retryMs = f.pack.runtime.manifestRetryDelayMs + 14_000
            f.sourceFailure = AudioRetryException(retryMs)
            f.controller.warm("sfx_b"); runCurrent()
            val attempts = f.requested.size
            repeat(100) { f.controller.warm("sfx_b"); f.controller.play("sfx_b") }
            runCurrent(); assertEquals(attempts, f.requested.size)
            assertTrue(f.controller.play("sfx_a"))
            now = retryMs - 1
            f.controller.warm("sfx_b"); runCurrent(); assertEquals(attempts, f.requested.size)
            now++; f.sourceFailure = null
            f.controller.warm("sfx_b"); runCurrent()
            assertEquals(attempts + 1, f.requested.size); assertTrue(f.controller.play("sfx_b"))
        }
    }

    @Test fun `cold one shot warms only and never plays later until a new current event arrives`() = runTest {
        Fixture(this).use { f ->
            f.controller.update(f.context, true)
            assertFalse(f.controller.play("sfx_a")); runCurrent()
            assertEquals(0, f.controller.diagnostics().voicesAndLoops); assertEquals(0, f.outputs.single().wakes)
            assertTrue(f.controller.play("sfx_a")); assertEquals(1, f.outputs.single().wakes)
            assertEquals(16L, f.controller.diagnostics().decodedBytes)
        }
    }
    @Test fun `prepared production family wins deterministically and cold production uses only current ready fallback`() = runTest {
        val manifest = """{"schemaVersion":1,"entries":[{"id":"sfx_ui_tap_v1","file":"tap.mp3"}]}"""
        Fixture(this, manifest = manifest).use { f ->
            f.controller.update(f.context, true); f.controller.awaitDefinitions()
            val fallback = f.controller.bank(listOf("sfx_a")); fallback.ready.await()
            assertTrue(f.controller.playFamily("sfx_ui_tap", "first", "sfx_a")); runCurrent()
            assertEquals(1, f.outputs.single().mixer.retained("sfx_a"))
            assertEquals(0, f.outputs.single().mixer.retained("sfx_ui_tap_v1"))
            assertTrue(f.controller.playFamily("sfx_ui_tap", "next", "sfx_a"))
            assertEquals(1, f.outputs.single().mixer.retained("sfx_ui_tap_v1")); fallback.close()
        }
    }
    @Test fun `queued banks obey source concurrency and cancellation releases every in flight reservation`() = runTest {
        Fixture(this, audioRuntime().copy(preloadConcurrency = 2)).use { f ->
            f.waitForDecode = CompletableDeferred()
            f.controller.update(f.context, true)
            val bank = f.controller.bank(('a'..'f').map { "sfx_$it" }); runCurrent()
            assertEquals(2, f.active); assertEquals(2, f.decoded.size)
            bank.close(); f.waitForDecode!!.complete(Unit); runCurrent()
            assertEquals(2, f.peakActive); assertEquals(0, f.active); assertEquals(0L, f.controller.diagnostics().decodedBytes)
            assertEquals(0, f.controller.diagnostics().voicesAndLoops); assertEquals(2, f.released)
        }
    }
    @Test fun `identity replacement shares old in flight PCM ceiling and never admits the old result`() = runTest {
        Fixture(this, audioRuntime().copy(maxDecodedBytes = 16)).use { f ->
            f.waitForDecode = CompletableDeferred(); f.controller.update(f.context, true)
            f.controller.warm("sfx_a"); runCurrent(); assertEquals(16L, f.controller.diagnostics().decodedBytes)
            f.controller.update(f.context.copy(identity = Any()), true)
            f.controller.warm("sfx_b"); runCurrent()
            assertEquals(16L, f.peakBytes); assertEquals(0, f.controller.diagnostics().voicesAndLoops)
            f.waitForDecode!!.complete(Unit); runCurrent()
            assertEquals(0L, f.controller.diagnostics().decodedBytes); assertTrue(f.outputs.first().closed)
            // Explicit new context clears no old audio into playback. A freed-capacity event may retry.
            f.controller.update(f.context.copy(identity = Any()), true); f.waitForDecode = null
            f.controller.warm("sfx_b"); runCurrent(); assertTrue(f.controller.play("sfx_b"))
        }
    }
    @Test fun `live voices retain cache pages while unpinned LRU samples make space for a new bank`() = runTest {
        Fixture(this, audioRuntime().copy(maxDecodedBytes = 32)).use { f ->
            f.controller.update(f.context, true)
            val first = f.controller.bank(listOf("sfx_a")); first.ready.await(); assertTrue(f.controller.play("sfx_a")); first.close()
            f.controller.warm("sfx_b"); runCurrent(); f.controller.warm("sfx_c"); runCurrent()
            assertEquals(32L, f.controller.diagnostics().decodedBytes); assertEquals(1, f.outputs.single().mixer.retained("sfx_a"))
            assertEquals(1, f.released); assertTrue(f.controller.play("sfx_c"))
            f.outputs.single().drain(); f.controller.warm("sfx_d"); runCurrent()
            assertEquals(32L, f.controller.diagnostics().decodedBytes); assertEquals(2, f.released)
        }
    }
    @Test fun `a pinned bank cannot be evicted by another decode and releasing it allows a later load`() = runTest {
        Fixture(this, audioRuntime().copy(maxDecodedBytes = 16)).use { f ->
            f.controller.update(f.context, true); val pinned = f.controller.bank(listOf("sfx_a")); pinned.ready.await()
            f.controller.warm("sfx_b"); runCurrent(); val attempts = f.decoded.size
            f.controller.warm("sfx_b"); runCurrent(); assertEquals(attempts, f.decoded.size)
            assertEquals(16L, f.controller.diagnostics().decodedBytes)
            pinned.close(); f.controller.warm("sfx_b"); runCurrent(); assertEquals(attempts + 1, f.decoded.size)
            assertTrue(f.controller.play("sfx_b"))
        }
    }
    @Test fun `bank readiness deadline releases pending demand without waiting for cold optional media`() = runTest {
        Fixture(this).use { f ->
            f.waitForDecode = CompletableDeferred(); f.controller.update(f.context, true)
            val bank = f.controller.bank(listOf("sfx_a")); runCurrent()
            advanceTimeBy(f.pack.runtime.bankReadyDeadlineMs); runCurrent(); assertTrue(bank.ready.isCompleted)
            f.waitForDecode!!.complete(Unit); runCurrent()
            assertEquals(0L, f.controller.diagnostics().decodedBytes); assertEquals(0, f.outputs.single().wakes); bank.close()
        }
    }
    @Test fun `muting or backgrounding flushes output and closes cold loop intent before completion`() = runTest {
        for (background in listOf(false, true)) Fixture(this).use { f ->
            f.waitForDecode = CompletableDeferred(); f.controller.update(f.context, true)
            val loop = f.controller.loopFamily("absent", "actor", "sfx_a"); runCurrent()
            f.controller.update(if (background) f.context.copy(foreground = false) else f.context.copy(soundFx = false), true)
            assertTrue(f.outputs.single().closed)
            f.waitForDecode!!.complete(Unit); runCurrent()
            assertEquals(0, f.controller.diagnostics().voicesAndLoops); assertEquals(0L, f.controller.diagnostics().decodedBytes)
            f.controller.update(f.context, true); runCurrent(); assertEquals(0, f.controller.diagnostics().voicesAndLoops)
            loop.close()
        }
    }
    @Test fun `actor loop handles share one source and closed cold handles never resurrect`() = runTest {
        Fixture(this).use { f ->
            f.controller.update(f.context, true)
            val a = f.controller.loopFamily("absent", "actor1", "sfx_a", .25f)
            val b = f.controller.loopFamily("absent", "actor2", "sfx_a", .75f); runCurrent()
            assertEquals(1, f.controller.diagnostics().voicesAndLoops)
            a.close(); assertEquals(1, f.controller.diagnostics().voicesAndLoops)
            b.close(); b.close(); assertEquals(0, f.controller.diagnostics().voicesAndLoops)
            f.waitForDecode = CompletableDeferred()
            val cold = f.controller.loopFamily("absent", "actor3", "sfx_b"); runCurrent(); cold.close()
            f.waitForDecode!!.complete(Unit); runCurrent(); assertEquals(0, f.controller.diagnostics().voicesAndLoops)
        }
    }
    @Test fun `failed output cannot restart from stale or repeated focus callbacks but explicit retry recovers`() = runTest {
        Fixture(this).use { f ->
            f.controller.update(f.context, true); f.controller.bank(listOf("sfx_a")).ready.await()
            assertTrue(f.controller.play("sfx_a")); val old = f.outputs.single(); old.failed()
            assertTrue(old.closed); assertEquals(0, f.controller.diagnostics().voicesAndLoops)
            repeat(3) { f.controller.update(f.context, true, explicitRetry = false) }
            assertEquals(1, f.outputs.size); assertFalse(f.controller.play("sfx_a"))
            f.controller.update(f.context, true, explicitRetry = true); assertEquals(2, f.outputs.size)
            old.failed(); assertFalse(f.outputs.last().closed); assertTrue(f.controller.play("sfx_a"))
        }
    }
    @Test fun `battle cursor plays only current authoritative cues and silence or jumps discard elapsed events`() = runTest {
        Fixture(this).use { f ->
            f.controller.update(f.context, true)
            val playback = BattleSfxPlayback(f.controller, f.pack.runtime)
            playback.replace(listOf(BattleAudioCue(0.0, "absent", "a", "sfx_a"),
                BattleAudioCue(10.0, "absent", "b", "sfx_b"), BattleAudioCue(20.0, "absent", "c", "sfx_c")), 0.0)
            runCurrent(); playback.advance(0.0, true); playback.advance(10.0, false); playback.advance(20.0, true)
            assertEquals(1, f.outputs.single().mixer.retained("sfx_a")); assertEquals(0, f.outputs.single().mixer.retained("sfx_b"))
            assertEquals(1, f.outputs.single().mixer.retained("sfx_c")); playback.close()
        }
    }
    @Test fun `battle actor ownership ends shared loops and identity replacement fences the old battle plan`() = runTest {
        Fixture(this).use { f ->
            f.controller.update(f.context, true)
            val playback = BattleSfxPlayback(f.controller, f.pack.runtime)
            val loop = BattleAudioCue(0.0, "absent", "actor", "sfx_a", loop = true, dispatch = AudioDispatch.ACTOR_LOOP)
            playback.replace(listOf(loop, BattleAudioCue(100.0, "absent", "one", "sfx_b")), 0.0); runCurrent()
            playback.actorLoop("one", loop); playback.actorLoop("two", loop); runCurrent()
            assertEquals(1, f.controller.diagnostics().voicesAndLoops)
            playback.actorEnded("one"); assertEquals(1, f.controller.diagnostics().voicesAndLoops)
            playback.actorEnded("two"); assertEquals(0, f.controller.diagnostics().voicesAndLoops)
            f.controller.update(f.context.copy(identity = Any()), true); runCurrent()
            val requests = f.requested.size; playback.advance(100.0, true); playback.actorLoop("old", loop); runCurrent()
            assertEquals(requests, f.requested.size); assertEquals(0, f.controller.diagnostics().voicesAndLoops)
            playback.close()
        }
    }

    @Test fun `ambience uses canonical screen variant gain and lifecycle without reviving a closed scene`() = runTest {
        val manifest = """{"schemaVersion":1,"entries":[
            {"id":"sfx_ambience_base_day_v1","file":"bed.wav","loopStart":0.25,"loopEnd":0.75},
            {"id":"sfx_ambience_base_day_v2","file":"bed.wav","loopStart":0.25,"loopEnd":0.75},
            {"id":"sfx_ambience_base_day_v3","file":"bed.wav","loopStart":0.25,"loopEnd":0.75}]}"""
        Fixture(this, manifest = manifest).use { f ->
            val base = f.context.copy(screen = "base")
            f.controller.update(base, true); f.controller.awaitDefinitions(); runCurrent()
            assertEquals(1, f.controller.diagnostics().voicesAndLoops)
            assertEquals(1, f.outputs.single().mixer.retained("sfx_ambience_base_day_v3")) // Source FNV family:base.
            f.controller.update(base.copy(screen = "build"), true); runCurrent()
            assertEquals(0, f.outputs.single().mixer.retained("sfx_ambience_base_day_v3"))
            assertEquals(1, f.outputs.single().mixer.retained("sfx_ambience_base_day_v1")) // Same family, source key changes.
            val samples = FloatArray(2); f.outputs.single().mixer.render(samples, 4)
            assertEquals(.25f * f.pack.runtime.ambienceVolume, samples[0], .00001f)
            f.controller.update(base.copy(screen = "mail"), true); assertEquals(0, f.controller.diagnostics().voicesAndLoops)
            f.controller.update(base, true); runCurrent(); assertEquals(1, f.controller.diagnostics().voicesAndLoops)
            f.controller.update(base.copy(foreground = false), false); assertTrue(f.outputs.single().closed)
            assertEquals(0, f.controller.diagnostics().voicesAndLoops)
        }
    }

    @Test fun `visible base bank warms only its aliases and all current variants within shared pins without playing`() = runTest {
        val manifest = """{"schemaVersion":1,"entries":[
          {"id":"sfx_ui_tap_v1","file":"tap.mp3"},
          {"id":"sfx_ui_tap_v2","file":"tap2.mp3"},
          {"id":"sfx_ui_tap_v3","file":"tap3.mp3"},
          {"id":"sfx_troop_highlander_deploy_v1","file":"battle.mp3"}]}"""
        Fixture(this, audioRuntime().copy(maxDecodedBytes = 64), manifest,
            listOf("audio/sfx/sfx_tap.wav", "audio/sfx-ai/tap2.mp3", "audio/sfx-ai/tap3.mp3", "audio/sfx-ai/battle.mp3")).use { f ->
            f.controller.update(f.context, true)
            val bank = UiSfxBank(this, f.controller) { true }; bank.refresh(); f.controller.awaitDefinitions(); runCurrent()
            assertTrue(f.requested.containsAll(listOf("audio/sfx/sfx_tap.wav", "audio/sfx-ai/tap.mp3", "audio/sfx-ai/tap2.mp3", "audio/sfx-ai/tap3.mp3")))
            assertFalse(f.requested.contains("audio/sfx-ai/battle.mp3"))
            assertEquals(64L, f.controller.diagnostics().decodedBytes)
            assertEquals(0, f.controller.diagnostics().voicesAndLoops); assertEquals(0, f.outputs.sumOf { it.wakes })
            f.controller.warm("sfx_a"); runCurrent(); assertFalse(f.controller.play("sfx_a"))
            bank.close(); f.controller.warm("sfx_a"); runCurrent(); assertTrue(f.controller.play("sfx_a"))
            assertTrue(f.controller.diagnostics().decodedBytes <= 64)
        }
    }
    @Test fun `leaving base while its bank decodes cancels leases and never plays on late completion`() = runTest {
        Fixture(this, additionalPaths = listOf("audio/sfx/sfx_tap.wav")).use { f ->
            var visible = true; f.waitForDecode = CompletableDeferred(); f.controller.update(f.context, true)
            val bank = UiSfxBank(this, f.controller) { visible }; bank.refresh(); runCurrent()
            assertTrue(f.active > 0)
            visible = false; bank.refresh(); f.waitForDecode!!.complete(Unit); runCurrent()
            assertEquals(0, f.controller.diagnostics().activeLoads); assertEquals(0L, f.controller.diagnostics().decodedBytes)
            assertEquals(0, f.outputs.sumOf { it.wakes }); bank.close()
        }
    }
    @Test fun `base bank rebinds to new definitions and releases pins at mute until visible return`() = runTest {
        val manifest = """{"schemaVersion":1,"entries":[{"id":"sfx_ui_tap_v1","file":"tap.mp3"}]}"""
        Fixture(this, manifest = manifest, additionalPaths = listOf("audio/sfx/sfx_tap.wav")).use { f ->
            f.controller.update(f.context, true); val bank = UiSfxBank(this, f.controller) { true }; bank.refresh(); f.controller.awaitDefinitions(); runCurrent()
            val initial = f.requested.size
            f.controller.update(f.context.copy(soundFx = false), true); bank.refresh()
            f.controller.update(f.context.copy(identity = Any()), true); bank.refresh(); f.controller.awaitDefinitions(); runCurrent()
            assertTrue(f.requested.size > initial)
            assertTrue(f.requested.count { it == "audio/sfx-ai/tap.mp3" } >= 2)
            assertEquals(0, f.outputs.sumOf { it.wakes }); bank.close()
        }
    }

}
