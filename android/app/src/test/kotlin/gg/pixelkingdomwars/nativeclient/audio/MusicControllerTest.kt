package gg.pixelkingdomwars.nativeclient.audio

import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class MusicControllerTest {
    private class Voice(val name: String, val events: MutableList<String>) : MusicVoice {
        var closed = false; var playing = false; var failPlay = false
        override fun play() { check(!closed && !failPlay); playing = true; events += "play:$name" }
        override fun pause() { check(!closed); playing = false; events += "pause:$name" }
        override fun close() { if (!closed) { closed = true; playing = false; events += "close:$name" } }
    }
    private class Focus : GameAudioFocus {
        var granted = true; var requests = 0; var abandons = 0
        val callbacks = mutableListOf<(Boolean) -> Unit>()
        override fun request(changed: (Boolean) -> Unit): Boolean { requests++; callbacks += changed; return granted }
        override fun abandon() { abandons++ }
    }
    private class Fixture(scope: CoroutineScope) {
        val events = mutableListOf<String>(); val focus = Focus(); val voices = mutableListOf<Voice>()
        var downloads = 0; var released = 0; var failSource = false; var failNextPlay = false
        var sourceWait: CompletableDeferred<Unit>? = null; var prepareWait: CompletableDeferred<Unit>? = null
        private val source = AudioAssetSource { _, paths ->
            downloads++
            val wait = sourceWait
            if (wait != null) withContext(NonCancellable) { wait.await() }
            if (failSource) error("offline")
            AudioAssetLease(File("/verified"), paths) { released++ }
        }
        private val backend = MusicBackend { file, volume ->
            assertEquals(MusicTrack.VOLUME, volume)
            val voice = Voice(file.name, events); voice.failPlay = failNextPlay; failNextPlay = false; voices += voice
            val wait = prepareWait
            if (wait != null) withContext(NonCancellable) { wait.await() }
            voice
        }
        val admissions = mutableListOf<Triple<MusicContext?, Boolean, Boolean>>()
        val controller = MusicController(scope, source, backend, focus) { context, focused, explicit ->
            admissions += Triple(context, focused, explicit)
        }
        val identity = Any()
        val context = MusicContext(audioPack(), identity, "base", true)
    }
    @Test fun `world navigation stays on one player while battle switches pause first and retain positions`() = runTest {
        val f = Fixture(this); f.controller.update(f.context); runCurrent()
        val world = f.voices.single()
        f.events.clear(); f.controller.update(f.context.copy(screen = "mail")); runCurrent()
        assertFalse(f.events.any { it.startsWith("pause:") }); assertEquals(1, f.downloads)
        f.events.clear(); f.controller.update(f.context.copy(screen = "battle")); runCurrent()
        assertTrue(f.events.indexOf("pause:bgmusic-world.mp3") < f.events.indexOf("play:bgmusic-battle.mp3"))
        val battle = f.voices.last(); assertFalse(world.playing); assertTrue(battle.playing)
        f.controller.update(f.context); runCurrent()
        assertEquals(2, f.voices.size); assertTrue(world.playing); assertFalse(battle.playing); assertEquals(0, f.released)
        f.controller.close(); f.controller.close(); assertEquals(2, f.released)
    }
    @Test fun `music and SFX switches remain independent and disabled music downloads nothing`() = runTest {
        val f = Fixture(this); f.controller.update(f.context.copy(music = false)); runCurrent()
        assertEquals(0, f.downloads)
        f.controller.update(f.context.copy(soundFx = false)); runCurrent(); assertTrue(f.voices.single().playing)
        f.controller.update(f.context.copy(music = false)); assertFalse(f.voices.single().playing)
        f.controller.update(f.context); runCurrent(); assertEquals(1, f.downloads); assertTrue(f.voices.single().playing)
        f.controller.close()
    }
    @Test fun `background cancels a stalled asset and late completion never creates a player`() = runTest {
        val f = Fixture(this); val wait = CompletableDeferred<Unit>(); f.sourceWait = wait
        f.controller.update(f.context); runCurrent(); f.controller.update(f.context.copy(foreground = false))
        wait.complete(Unit); runCurrent()
        assertTrue(f.voices.isEmpty()); assertEquals(1, f.released)
        f.controller.close()
    }
    @Test fun `mute during preparation closes the late voice and its content lease without play`() = runTest {
        val f = Fixture(this); val wait = CompletableDeferred<Unit>(); f.prepareWait = wait
        f.controller.update(f.context); runCurrent(); f.controller.update(f.context.copy(music = false))
        wait.complete(Unit); runCurrent()
        assertTrue(f.voices.single().closed); assertTrue(f.events.none { it.startsWith("play:") }); assertEquals(1, f.released)
        f.controller.close()
    }
    @Test fun `same wallet replacement discards old audio and ignores old focus callbacks`() = runTest {
        data class Identity(val wallet: String)
        val f = Fixture(this); val a = f.context.copy(identity = Identity("same")); f.controller.update(a); runCurrent()
        val old = f.voices.single(); val oldFocus = f.focus.callbacks.last()
        f.focus.granted = false
        f.controller.update(a.copy(identity = Identity("same"))); runCurrent()
        assertTrue(old.closed); assertEquals(1, f.released)
        oldFocus(true); runCurrent(); assertEquals(1, f.voices.size)
        f.focus.granted = true; f.controller.retry(); runCurrent(); assertTrue(f.voices.last().playing)
        f.controller.close()
    }
    @Test fun `pack change releases old bytes even when the track filename is identical`() = runTest {
        val f = Fixture(this); f.controller.update(f.context); runCurrent(); val old = f.voices.single()
        f.controller.update(f.context.copy(pack = audioPack("d".repeat(64)))); runCurrent()
        assertTrue(old.closed); assertEquals(1, f.released); assertEquals(2, f.downloads); assertTrue(f.voices.last().playing)
        f.controller.close()
    }
    @Test fun `focus loss holds positions and gain cannot restart after background`() = runTest {
        val f = Fixture(this); f.controller.update(f.context); runCurrent(); val voice = f.voices.single()
        val callback = f.focus.callbacks.last(); callback(false); assertFalse(voice.playing)
        callback(true); runCurrent(); assertTrue(voice.playing); assertEquals(1, f.downloads)
        f.controller.update(f.context.copy(foreground = false)); callback(true); runCurrent()
        assertFalse(voice.playing); assertFalse(voice.closed)
        f.controller.update(f.context); runCurrent(); assertTrue(voice.playing); assertEquals(1, f.downloads)
        f.controller.close()
    }
    @Test fun `optional failures stay silent until explicit retry and release is terminal`() = runTest {
        val f = Fixture(this); f.failSource = true; f.controller.update(f.context); runCurrent()
        assertTrue(f.voices.isEmpty()); assertEquals(1, f.downloads)
        advanceTimeBy(60_000); runCurrent(); assertEquals(1, f.downloads)
        f.failSource = false; f.controller.retry(); runCurrent(); assertTrue(f.voices.single().playing)
        f.controller.close(); f.controller.update(f.context); f.controller.retry(); f.focus.callbacks.last()(true); runCurrent()
        assertEquals(2, f.downloads); assertEquals(1, f.released)
    }
    @Test fun `missing admitted content and initially denied focus cannot begin a download`() = runTest {
        val f = Fixture(this); f.controller.update(f.context.copy(pack = null)); runCurrent()
        assertEquals(0, f.focus.requests); assertEquals(0, f.downloads)
        f.focus.granted = false; f.controller.update(f.context); runCurrent(); assertEquals(0, f.downloads)
        f.focus.granted = true; f.controller.retry(); runCurrent(); assertEquals(1, f.downloads)
        f.controller.close()
    }
    @Test fun `music and SFX share one synchronous admission and old focus callbacks cannot admit another identity`() = runTest {
        val f = Fixture(this); val context = f.context.copy(music = false)
        f.controller.update(context); runCurrent()
        assertTrue(f.voices.isEmpty()); assertEquals(1, f.focus.requests)
        assertEquals(Triple(context, true, true), f.admissions.last())
        val old = f.focus.callbacks.last(); old(false)
        assertEquals(Triple(context, false, false), f.admissions.last())
        old(true); assertEquals(Triple(context, true, false), f.admissions.last())
        f.controller.update(context.copy(identity = Any())); runCurrent()
        assertTrue(f.admissions.any { it.first == null && !it.second })
        val count = f.admissions.size; old(true); assertEquals(count, f.admissions.size)
        f.controller.close(); assertEquals(Triple<MusicContext?, Boolean, Boolean>(null, false, false), f.admissions.last())
    }
    @Test fun `decoder error after preparation evicts the poisoned player on explicit retry`() = runTest {
        val f = Fixture(this); f.controller.update(f.context); runCurrent()
        val old = f.voices.single(); old.close() // Platform onError can occur after prepare has returned.
        f.controller.retry(); runCurrent()
        assertEquals(1, f.released); assertEquals(2, f.voices.size); assertTrue(f.voices.last().playing)
        f.controller.close(); assertEquals(2, f.released)
    }
    @Test fun `failed focus resume stays silent without retry loops then explicit retry recovers`() = runTest {
        val f = Fixture(this); f.controller.update(f.context); runCurrent()
        val old = f.voices.single(); val callback = f.focus.callbacks.last()
        callback(false); old.failPlay = true; callback(true); runCurrent()
        assertTrue(old.closed); assertEquals(1, f.released); assertEquals(1, f.downloads)
        callback(true); advanceTimeBy(60_000); runCurrent(); assertEquals(1, f.downloads)
        f.controller.retry(); runCurrent(); assertEquals(2, f.downloads); assertTrue(f.voices.last().playing)
        f.controller.close()
    }
    @Test fun `a failed initial start never becomes Ready and releases both resources before retry`() = runTest {
        val f = Fixture(this); f.failNextPlay = true; f.controller.update(f.context); runCurrent()
        assertTrue(f.voices.single().closed); assertEquals(1, f.released)
        f.focus.callbacks.last()(true); runCurrent(); assertEquals(1, f.downloads)
        f.controller.retry(); runCurrent(); assertEquals(2, f.voices.size); assertTrue(f.voices.last().playing)
        f.controller.close()
    }
}
