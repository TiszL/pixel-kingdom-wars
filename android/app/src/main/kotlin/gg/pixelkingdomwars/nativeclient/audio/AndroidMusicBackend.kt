package gg.pixelkingdomwars.nativeclient.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.os.HandlerThread
import kotlinx.coroutines.*
import kotlinx.coroutines.android.asCoroutineDispatcher
import kotlinx.coroutines.sync.Semaphore
import java.io.File
import java.io.FileInputStream

private fun gameAttributes() = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME)
    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()

/** One process-scoped Looper and two retained music seats, including retiring players.
 * Thread startup/getLooper can wait; both run on IO, never the UI thread. */
private object MusicLooper {
    val capacity = Semaphore(MusicTrack.entries.size)
    private val dispatcher = CoroutineScope(SupervisorJob() + Dispatchers.IO).async {
        val thread = HandlerThread("PKW-music").apply { start() }
        Handler(thread.looper).asCoroutineDispatcher("PKW-music")
    }
    suspend fun worker(): CoroutineDispatcher = dispatcher.await()
}

/** Stream verified local MP3s. MediaPlayer creation, setup, callbacks, controls and
 * release all run on the dedicated Looper, as required by MediaPlayer's contract. */
class AndroidMusicBackend : MusicBackend {
    private val queued = QueuedMusicBackend(MusicLooper::worker, MusicLooper.capacity) {
        val player = MediaPlayer()
        object : MusicDevice {
            override fun prepare(file: File, volume: Float, ready: () -> Unit, failed: (Exception) -> Unit) {
                player.setOnPreparedListener {
                    try { player.isLooping = true; player.setVolume(volume, volume); ready() }
                    catch (error: Exception) { failed(error) }
                }
                player.setOnErrorListener { _, _, _ -> failed(IllegalStateException("Optional music could not be played")); true }
                player.setAudioAttributes(gameAttributes())
                FileInputStream(file).use { player.setDataSource(it.fd) }
                player.prepareAsync()
            }
            override fun play() = player.start()
            override fun pause() { if (player.isPlaying) player.pause() }
            override fun close() {
                try { player.setOnPreparedListener(null); player.setOnErrorListener(null) }
                finally { player.release() }
            }
        }
    }
    override suspend fun prepare(file: File, volume: Float): MusicVoice = queued.prepare(file, volume)
}

/** No background service or wake lock. Focus loss immediately revokes admission and requests pause, including ducking;
 * only a current foreground controller may resume on GAIN. A denied request stays silent. */
class AndroidGameAudioFocus(context: Context) : GameAudioFocus {
    private val manager = context.applicationContext.getSystemService(AudioManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var request: AudioFocusRequest? = null
    override fun request(changed: (Boolean) -> Unit): Boolean {
        abandon()
        val value = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(gameAttributes()).setAcceptsDelayedFocusGain(false)
            .setWillPauseWhenDucked(true)
            .setOnAudioFocusChangeListener({ state -> changed(state == AudioManager.AUDIOFOCUS_GAIN) }, main)
            .build()
        request = value
        return manager?.requestAudioFocus(value) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }
    override fun abandon() { request?.let { runCatching { manager?.abandonAudioFocusRequest(it) } }; request = null }
}
