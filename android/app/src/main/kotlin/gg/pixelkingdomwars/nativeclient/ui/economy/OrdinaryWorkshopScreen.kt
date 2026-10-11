package gg.pixelkingdomwars.nativeclient.ui.economy

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.boundcosmetics.BoundCosmeticAppearance
import gg.pixelkingdomwars.nativeclient.data.BoundCosmeticArtAdmission
import gg.pixelkingdomwars.nativeclient.data.BoundCosmeticWakeSourcePreview
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.GamePage
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** One page and one active section; leaving a section disposes its admission review. */
@Composable fun OrdinaryWorkshopScreen(materials: OrdinaryCraftingViewModel?, awnings: BoundCosmeticWorkshopViewModel?, wake: BoundCosmeticWakeWorkshopViewModel?,
    wallet: String, selectedBase: String?, generation: Long, actionsAllowed: Boolean,
    art: BoundCosmeticArtAdmission, artGeneration: Long, previewGuard: () -> Unit,
    wakeSourcePreview: BoundCosmeticWakeSourcePreview? = null, onBack: () -> Unit) {
    val back = { materials?.dismiss(); awnings?.dismiss(); wake?.dismiss(); onBack() }
    BackHandlerAt(BackPriority.SCREEN) { back() }
    val parentHost = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.LocalWorkshopOwnerHost.current
    var selectedTab by rememberSaveable(wallet, selectedBase, parentHost?.selectedTab) {
        mutableStateOf(parentHost?.selectedTab ?: gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.REFINE)
    }
    val current = { parentHost?.current?.invoke() == true && runCatching { previewGuard() }.isSuccess }
    val capacity = runCatching { previewGuard(); art.maxConcurrentPerBase() }.getOrNull()
    val host = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopOwnerHost(selectedTab,
        onTab = { tab ->
            if (current()) {
                if (tab in setOf(gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.INGOTS,
                        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.EQUIPMENT) && parentHost != null) parentHost.onTab(tab)
                else selectedTab = tab
            }
        }, onClose = back, benchCapacity = capacity, current = current)
    CompositionLocalProvider(gg.pixelkingdomwars.nativeclient.ui.sheets.craft.LocalWorkshopOwnerHost provides host) {
        Box(Modifier.fillMaxSize()) {
            if (selectedTab == gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.REFINE && materials != null) {
                OrdinaryCraftingContent(materials, wallet, selectedBase, generation, actionsAllowed)
            } else if (selectedTab == gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.COSMETICS) {
                WorkshopStyleOwnerScreen(awnings, wake, wallet, selectedBase, generation, actionsAllowed,
                    art, artGeneration, previewGuard, wakeSourcePreview, host)
            } else {
                val reason = when (selectedTab) {
                    gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.EQUIPMENT ->
                        "Tools information is unavailable. A complete current travelling-tool view has not been observed."
                    gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab.INGOTS ->
                        "The original Forge Ingot owner is unavailable here."
                    else -> "Saved refining recovery could not be opened. Keep this app's data and reopen when storage is available."
                }
                gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopSheet(
                    gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopSheetUi(
                        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftFrameUi("WORKSHOP", null, null, false,
                            gg.pixelkingdomwars.nativeclient.ui.sheets.craft.workshopTabs(), selectedTab),
                        gg.pixelkingdomwars.nativeclient.ui.sheets.craft.CraftHeaderUi(null),
                        observation = gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopObservationUi(reason)),
                    gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopSheetActions(onClose = back, onTab = host.onTab), Modifier.fillMaxSize())
            }
        }
    }

}

/** Only the admitted adapter can supply pixels. No source URL, asset substitution or
 * readiness flag can replace a successful guarded lease and crop verification. */
@Composable internal fun AdmittedAwningPreview(appearance: BoundCosmeticAppearance, art: BoundCosmeticArtAdmission,
    artGeneration: Long, selectedBase: String?, generation: Long, guard: () -> Unit, modifier: Modifier) {
    val pixels by produceState<Result<ImageBitmap>?>(null, appearance, art, artGeneration, selectedBase, generation) {
        value = null
        val context = currentCoroutineContext()
        val checkpoint = { context.ensureActive(); guard(); check(art.applicationReady()) { "Awning content is unavailable." } }
        try {
            val admitted = art.preview(appearance, checkpoint)
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
            // A superseded producer may fail with an ordinary IO exception.
            // It must not overwrite the next account/base/content preview.
            if (runCatching { guard(); true }.getOrDefault(false)) value = Result.failure(error)
        }
    }
    val image = pixels?.getOrNull()
    if (image != null) Image(image, awningLabel(appearance.outputId), modifier, contentScale = ContentScale.Fit, filterQuality = FilterQuality.None)
    else Text(if (pixels == null) "Loading verified appearance…" else "Verified preview is unavailable. Reopen the Workshop to try again.", modifier, color = Palette.muted)
}
