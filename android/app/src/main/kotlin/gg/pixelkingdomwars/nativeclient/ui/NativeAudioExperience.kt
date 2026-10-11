package gg.pixelkingdomwars.nativeclient.ui

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.compose.runtime.*
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.audio.*
import gg.pixelkingdomwars.nativeclient.data.ApiRouting
import gg.pixelkingdomwars.nativeclient.data.SessionApiClient
import gg.pixelkingdomwars.nativeclient.contentVerifierFingerprint
import gg.pixelkingdomwars.nativeclient.network.storageNamespace
import kotlinx.coroutines.flow.combine
import java.io.File

val LocalNativeAudio = staticCompositionLocalOf<NativeAudioBus?> { null }

/** The current Activity owns playback. Lifecycle callbacks read live identity/preferences and
 * pause directly on PAUSE; they never depend on a background Compose frame being delivered. */
@Composable fun rememberNativeAudioExperience(graph: AppGraph, screen: String): NativeAudioBus {
    val scope = rememberCoroutineScope()
    val latestScreen = rememberUpdatedState(screen)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val audio = remember(graph, lifecycle) {
        val assets = AudioContent(File(graph.application.noBackupFilesDir, storageNamespace(graph.origin, "audio-content")),
            graph.origin, verifier = contentVerifierFingerprint(graph.application))
        // Capabilities are public metadata. Optional-media failure must not route the game to
        // an auth/maintenance gate; encoded downloads use AudioContent's cookie-free client.
        val api = SessionApiClient(graph.gameApi, null, ApiRouting())
        val source = assets.source(api)
        val main = Handler(Looper.getMainLooper())
        val bus = NativeAudioBus(scope, SfxController(scope, source, AndroidSfxDecoder(),
            AndroidSfxOutputFactory(scope), SystemClock::elapsedRealtime)) { task -> main.post { task() }; Unit }
        val music = MusicController(scope, source, AndroidMusicBackend(), AndroidGameAudioFocus(graph.application), bus::admission)
        music to bus
    }
    val controller = audio.first
    val bus = audio.second
    val refresh = remember(graph, audio, lifecycle) {
        var admitted: gg.pixelkingdomwars.nativeclient.data.ContentState? = null
        var pack: AudioPack? = null
        {
            val content = graph.content.state.value
            if (admitted?.catalogue !== content.catalogue || admitted?.manifest !== content.manifest || admitted?.ready != content.ready) {
                admitted = content
                pack = if (!content.ready) null else runCatching {
                    AudioPack.from(requireNotNull(content.catalogue), requireNotNull(content.manifest))
                }.getOrNull()
                bus.content(content.catalogue.takeIf { pack != null })
            }
            controller.update(MusicContext(pack, graph.holder.current, latestScreen.value,
                foreground = lifecycle.currentState == Lifecycle.State.RESUMED,
                music = graph.preferences.state.value.music, soundFx = graph.preferences.state.value.soundFx))
        }
    }
    DisposableEffect(controller, lifecycle) {
        val observer = LifecycleEventObserver { _, _ -> refresh() }
        lifecycle.addObserver(observer)
        refresh()
        onDispose { lifecycle.removeObserver(observer); controller.close(); bus.close() }
    }
    LaunchedEffect(graph, controller, lifecycle) {
        combine(graph.holder.session, graph.content.state, graph.preferences.state) { _, _, _ -> Unit }
            .collect { refresh() }
    }
    SideEffect { refresh() }
    return bus
}
