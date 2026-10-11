package gg.pixelkingdomwars.nativeclient.scene

import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.composed
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import gg.pixelkingdomwars.nativeclient.renderer.SceneInputGeometry
import gg.pixelkingdomwars.nativeclient.renderer.SceneInputCancellation
import gg.pixelkingdomwars.nativeclient.renderer.SceneInputRegion
import kotlin.math.ceil
import kotlin.math.floor

/** One registry per scene and its floating controls; it adds no layout or touch-consuming host. */
@Composable fun SceneInputScope(content: @Composable () -> Unit) {
    val own = remember { SceneInputRegions() }
    val regions = LocalSceneInputRegions.current ?: own
    CompositionLocalProvider(LocalSceneInputRegions provides regions, content = content)
}
internal val LocalSceneInputRegions = staticCompositionLocalOf<SceneInputRegions?> { null }
internal class SceneInputRegions {
    data class Measured(val window: Any?, val rectangle: Rect)
    val bounds = mutableStateMapOf<Any, Measured>()
    val cancellation = SceneInputCancellation()
    fun geometry(surface: Rect?, window: Any?): SceneInputGeometry {
        if (surface == null || window == null) return SceneInputGeometry(0, 0, emptyList(), cancellation)
        return SceneInputGeometry(surface.width.toInt(), surface.height.toInt(), bounds.values.mapNotNull { region ->
            if (region.window != window) return@mapNotNull null
            val clipped = region.rectangle.intersect(surface)
            if (clipped.isEmpty) null else SceneInputRegion(floor(clipped.left - surface.left).toInt(),
                floor(clipped.top - surface.top).toInt(), ceil(clipped.right - surface.left).toInt(),
                ceil(clipped.bottom - surface.top).toInt())
        }, cancellation)
    }
}

/** Apply only to painted controls/panels, never transparent placement hosts. The pointer node
 * shields the underlying AndroidView; measured regions also fence an already-active GL gesture. */
fun Modifier.sceneInputRegion(): Modifier = composed {
    val registry = LocalSceneInputRegions.current
    val view = LocalView.current
    val token = remember { Any() }
    DisposableEffect(registry, token) { onDispose { registry?.bounds?.remove(token) } }
    this.onGloballyPositioned { coordinates -> registry?.bounds?.set(token, SceneInputRegions.Measured(view.windowToken, coordinates.boundsInWindow())) }
        .pointerInput(registry) {
            var held = false
            try {
                awaitPointerEventScope {
                    while (true) {
                        val pressed = awaitPointerEvent(PointerEventPass.Initial).changes.any { it.pressed }
                        if (pressed && !held) { registry?.cancellation?.beginContact(); held = true }
                        if (!pressed && held) { registry?.cancellation?.endContact(); held = false }
                    }
                }
            } finally { if (held) registry?.cancellation?.endContact() }
        }
}
