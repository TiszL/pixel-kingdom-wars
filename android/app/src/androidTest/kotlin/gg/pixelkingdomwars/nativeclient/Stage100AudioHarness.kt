package gg.pixelkingdomwars.nativeclient

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import gg.pixelkingdomwars.nativeclient.audio.*
import gg.pixelkingdomwars.nativeclient.network.NativeContentFile
import gg.pixelkingdomwars.nativeclient.network.NativeContentManifest
import gg.pixelkingdomwars.nativeclient.renderer.BattleScene
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.Closeable
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/** Test APK only. Real battle cue planner, decoder, mixer, focus and AudioTrack; silent PCM
 * replaces sound masters so this exercises contention without claiming sound-asset fidelity.
 * No network, preference, account or production-content writes. */
internal class Stage100AudioHarness private constructor(
    activity: MainActivity, directory: File, catalogue: JsonObject, manifest: NativeContentManifest,
) : Closeable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val identity = Any()
    private val pack = AudioPack(manifest, AudioRuntime.from(catalogue))
    private val loads = AtomicInteger(); private val outputs = AtomicInteger(); private val wakes = AtomicInteger()
    private val closes = AtomicInteger(); private val decodeNanos = AtomicLong()
    private var peakVoices = 0
    private val source = AudioAssetSource { _, paths ->
        withContext(Dispatchers.IO) {
            paths.forEach { path ->
                val pin = manifest.files.single { it.path == path }
                val file = File(directory, path)
                check(file.length() == pin.size && sha(file.readBytes()) == pin.sha256)
            }
        }
        AudioAssetLease(directory, paths) {}
    }
    private val controller = SfxController(scope, source, SfxDecoder { file, budget ->
        val start = System.nanoTime()
        try { AndroidSfxDecoder().decode(file, budget).also { loads.incrementAndGet() } }
        finally { decodeNanos.addAndGet(System.nanoTime() - start) }
    }, SfxOutputFactory { mixer, failed ->
        outputs.incrementAndGet()
        val delegate = AndroidSfxOutputFactory(scope).create(mixer, failed)
        object : SfxOutput {
            override fun wake() { wakes.incrementAndGet(); delegate.wake() }
            override fun close() { closes.incrementAndGet(); delegate.close() }
        }
    }, SystemClock::elapsedRealtime)
    val bus = NativeAudioBus(scope, controller) { task -> Handler(Looper.getMainLooper()).post { task() }; Unit }
    private val music = MusicController(scope, source, AndroidMusicBackend(), AndroidGameAudioFocus(activity), bus::admission)
    private val lifecycle = activity.lifecycle
    private fun refresh() = music.update(MusicContext(pack, identity, "battle",
        lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED), music = false, soundFx = true))
    private val observer = LifecycleEventObserver { _, _ -> refresh() }
    init { check(Looper.myLooper() == Looper.getMainLooper()); bus.content(catalogue); lifecycle.addObserver(observer); refresh() }
    fun snapshot(): JsonObject {
        check(Looper.myLooper() == Looper.getMainLooper())
        val state = controller.diagnostics()
        peakVoices = maxOf(peakVoices, state.voicesAndLoops)
        return buildJsonObject {
            put("scope", "Production audio pipeline and Android focus/output with generated silent PCM; not sound-master fidelity")
            put("decodedSamples", loads.get()); put("outputInstances", outputs.get()); put("outputWakes", wakes.get())
            put("outputCloses", closes.get()); put("decodeMsTotal", decodeNanos.get() / 1e6)
            put("decodedBytes", state.decodedBytes); put("voicesAndLoops", state.voicesAndLoops); put("activeLoads", state.activeLoads)
            put("audibleAdmission", controller.isAudible); put("peakVoicesAndLoops", peakVoices)
        }
    }
    override fun close() {
        check(Looper.myLooper() == Looper.getMainLooper())
        lifecycle.removeObserver(observer); music.close(); bus.close(); scope.cancel()
    }
    companion object {
        private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        /** File preparation is called by the instrumentation thread, before Main installation. */
        fun prepare(directory: File, catalogue: JsonObject, scenes: Collection<BattleScene>): (MainActivity) -> Stage100AudioHarness {
            val cues = scenes.flatMap { PreparedBattleAudio.from(it, catalogue).cues }
            val families = (cues.map { it.family } + "sfx_ambience_battle").distinct()
            val samples = 9_600; val rate = 48_000
            val wav = ByteBuffer.allocate(44 + samples * 2).order(ByteOrder.LITTLE_ENDIAN).apply {
                put("RIFF".toByteArray()); putInt(36 + samples * 2); put("WAVEfmt ".toByteArray()); putInt(16)
                putShort(1); putShort(1); putInt(rate); putInt(rate * 2); putShort(2); putShort(16)
                put("data".toByteArray()); putInt(samples * 2); repeat(samples) { putShort(0) }
            }.array()
            val files = mutableListOf<NativeContentFile>()
            fun write(path: String, bytes: ByteArray) {
                File(directory, path).apply { parentFile!!.mkdirs(); writeBytes(bytes) }
                files += NativeContentFile(path, sha(bytes), bytes.size.toLong(), "optional")
            }
            write("audio/sfx-ai/stress.wav", wav)
            cues.mapNotNull { it.fallback }.distinct().forEach { write("audio/sfx/$it.wav", wav) }
            val audioManifest = buildJsonObject {
                put("schemaVersion", 1); put("entries", buildJsonArray {
                    families.forEach { family -> (1..3).forEach { variant -> add(buildJsonObject {
                        put("id", "${family}_v$variant"); put("file", "stress.wav")
                        put("loopStart", 0); put("loopEnd", .2)
                    }) } }
                })
            }.toString().toByteArray()
            write("audio/sfx-ai/manifest.json", audioManifest)
            val manifest = NativeContentManifest(catalogue.getValue("sourceCommit").jsonPrimitive.content,
                catalogue.getValue("simVersion").jsonPrimitive.int, sha(audioManifest), files)
            return { activity -> Stage100AudioHarness(activity, directory, catalogue, manifest) }
        }
    }
}
