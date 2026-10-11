package gg.pixelkingdomwars.nativeclient.audio

import kotlinx.coroutines.*
import java.io.Closeable
import java.io.File

interface MusicVoice : Closeable {
    /** Failed or closed media must throw so the owner can evict its retained content. */
    fun play()
    fun pause()
    /** Completion owns the content lease; asynchronous backends invoke it after
     * platform release, including when the voice has already failed or closed. */
    fun close(onReleased: () -> Unit) { try { close() } finally { onReleased() } }
}
fun interface MusicBackend { suspend fun prepare(file: File, volume: Float): MusicVoice }

/** Focus callbacks and all controller calls run on the owning main dispatcher. */
interface GameAudioFocus : Closeable {
    fun request(changed: (Boolean) -> Unit): Boolean
    fun abandon()
    override fun close() = abandon()
}

data class MusicContext(
    val pack: AudioPack?, val identity: Any?, val screen: String,
    val foreground: Boolean, val music: Boolean = true, val soundFx: Boolean = true,
)

/** Main-dispatcher owner of two streamed music players. It never waits on the game's work.
 * Track switches pause before starting the next mood. Background/focus loss holds positions;
 * identity or pack replacement releases both players and their immutable content leases. */
class MusicController(
    private val scope: CoroutineScope, private val source: AudioAssetSource,
    private val backend: MusicBackend, private val focus: GameAudioFocus,
    private val onAudioAdmission: (MusicContext?, focused: Boolean, explicitRetry: Boolean) -> Unit = { _, _, _ -> },
) : Closeable {
    private data class Ready(val voice: MusicVoice, val lease: AudioAssetLease)
    private val ready = mutableMapOf<MusicTrack, Ready>()
    private val failed = mutableSetOf<MusicTrack>()
    private var current: MusicContext? = null
    private var epoch = 0L
    private var focusEpoch = 0L
    private var hasFocus = false
    private var focusRequested = false
    private var pending: Job? = null
    private var closed = false

    fun update(context: MusicContext) {
        if (closed) return
        val previous = current
        if (previous == context && previous?.identity === context.identity) return
        epoch++
        pending?.cancel(); pending = null
        val replaced = previous?.identity !== context.identity || previous?.pack?.identity != context.pack?.identity
        if (replaced || previous?.screen?.let(MusicTrack::forScreen) != MusicTrack.forScreen(context.screen)
            || !context.foreground || !context.music || context.pack == null) pauseAll()
        if (replaced) {
            safely { onAudioAdmission(null, false, false) }
            releaseAll(); failed.clear(); focusEpoch++; hasFocus = false; focusRequested = false
            safely { focus.abandon() }
        }
        current = context
        val wantsFocus = context.foreground && context.pack != null && (context.music || context.soundFx)
        if (!wantsFocus) {
            focusEpoch++; hasFocus = false; focusRequested = false
            safely { focus.abandon() }
            publishAdmission()
            return
        }
        requestFocusIfNeeded()
        publishAdmission(explicitRetry = true)
        reconcile(retryFailed = true)
    }

    private fun requestFocusIfNeeded() {
        if (!focusRequested) {
            focusRequested = true
            val ticket = ++focusEpoch
            hasFocus = try { focus.request { granted ->
                if (!closed && ticket == focusEpoch && current?.foreground == true) {
                    hasFocus = granted
                    epoch++; pending?.cancel(); pending = null; pauseAll()
                    publishAdmission()
                    if (granted) reconcile()
                }
            } } catch (_: Exception) { false }
            // A denied request is retried only by a later explicit update/retry.
            if (!hasFocus) focusRequested = false
        }
    }

    /** A later user gesture/foreground event may retry failed optional media; no timer loops. */
    fun retry() {
        if (closed) return
        val context = current ?: return
        if (!context.foreground || context.pack == null || (!context.music && !context.soundFx)) return
        if (!hasFocus) {
            focusEpoch++; focusRequested = false
            safely { focus.abandon() }; requestFocusIfNeeded()
        }
        publishAdmission(explicitRetry = true)
        reconcile(retryFailed = true)
    }

    private fun publishAdmission(explicitRetry: Boolean = false) {
        safely { onAudioAdmission(current, !closed && hasFocus, explicitRetry) }
    }

    private fun reconcile(retryFailed: Boolean = false) {
        val context = current ?: return
        val pack = context.pack ?: return
        if (closed || !context.foreground || !context.music || !hasFocus) return
        val track = MusicTrack.forScreen(context.screen)
        if (!retryFailed && track in failed) return
        ready[track]?.let { entry ->
            try { entry.voice.play(); return }
            catch (_: Exception) {
                evict(track, entry); failed += track
                if (!retryFailed) return
            }
        }
        if (pending?.isActive == true) return
        failed.remove(track)
        val ticket = epoch
        fun admitted() = !closed && epoch == ticket && current === context && hasFocus
            && context.foreground && context.music
        pending = scope.launch {
            var lease: AudioAssetLease? = null
            var voice: MusicVoice? = null
            try {
                lease = source.acquire(pack, setOf(track.path))
                ensureActive(); if (!admitted()) return@launch
                voice = backend.prepare(lease.file(track.path), MusicTrack.VOLUME)
                ensureActive(); if (!admitted()) return@launch
                // Starting can fail even after prepare succeeds. Until it starts, this job
                // still owns both resources and must release them on failure/cancellation.
                voice.play()
                val selected = Ready(voice, lease)
                ready[track] = selected; voice = null; lease = null
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { if (admitted()) failed += track }
            finally { release(voice, lease) }
        }
    }

    private fun pauseAll() {
        ready.toMap().forEach { (track, entry) ->
            try { entry.voice.pause() }
            catch (_: Exception) { evict(track, entry); failed += track }
        }
    }
    private fun evict(track: MusicTrack, entry: Ready) {
        if (ready[track] === entry) ready.remove(track)
        release(entry.voice, entry.lease)
    }
    private fun releaseAll() {
        ready.values.forEach { release(it.voice, it.lease) }
        ready.clear()
    }
    private fun release(voice: MusicVoice?, lease: AudioAssetLease?) {
        if (voice == null) safely { lease?.close() }
        else safely { voice.close { lease?.close() } }
    }
    override fun close() {
        if (closed) return
        closed = true; epoch++; focusEpoch++
        safely { onAudioAdmission(null, false, false) }
        pending?.cancel(); pending = null
        pauseAll(); releaseAll(); safely { focus.close() }
        current = null; hasFocus = false
    }
    private inline fun safely(block: () -> Unit) { try { block() } catch (_: Exception) { /* silence */ } }
}
