package gg.pixelkingdomwars.nativeclient.ui.economy

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticAppearance
import gg.pixelkingdomwars.nativeclient.data.BoundCosmeticWakeSourcePreview
import gg.pixelkingdomwars.nativeclient.ui.Palette
import kotlinx.coroutines.*

/** Read-only still; successful pixels never enable crafting or account On. */
@Composable internal fun AdmittedWakeSourcePreview(appearance: BoundCosmeticAppearance, art: BoundCosmeticWakeSourcePreview?,
    artGeneration: Long, selectedBase: String?, generation: Long, guard: () -> Unit, modifier: Modifier) {
    // Recreate remembered pixels synchronously, before a replacement producer runs.
    key(appearance, art, artGeneration, selectedBase, generation) {
        WakeSourcePixels(appearance, art, guard, modifier)
    }
}

@Composable private fun WakeSourcePixels(appearance: BoundCosmeticAppearance, art: BoundCosmeticWakeSourcePreview?,
    guard: () -> Unit, modifier: Modifier) {
    val pixels by produceState<Result<ImageBitmap>?>(null) {
        value = null
        val context = currentCoroutineContext()
        val checkpoint = { context.ensureActive(); guard() }
        try {
            val admitted = requireNotNull(art) { "Aurora source art is unavailable." }.wakePreview(appearance, checkpoint)
            val image = withContext(Dispatchers.IO) {
                checkpoint()
                val bytes = admitted.pngBytes
                val bitmap = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size)) { "Verified preview could not be decoded." }
                require(bitmap.width == admitted.cellW && bitmap.height == admitted.cellH)
                bitmap.asImageBitmap()
            }
            checkpoint(); value = Result.success(image)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            context.ensureActive()
            if (runCatching { guard(); true }.getOrDefault(false)) value = Result.failure(error)
        }
    }
    val image = pixels?.getOrNull()
    if (image != null) Image(image, "Aurora Wake source appearance", modifier, contentScale = ContentScale.Fit, filterQuality = FilterQuality.None)
    else Text(if (pixels == null) "Loading verified appearance…" else "Aurora source preview is unavailable in this client.", modifier, color = Palette.muted)
}
