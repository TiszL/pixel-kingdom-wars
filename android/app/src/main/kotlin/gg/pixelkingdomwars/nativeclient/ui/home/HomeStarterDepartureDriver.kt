package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.*
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.ui.economy.StarterExpeditionViewModel
import kotlinx.coroutines.awaitCancellation

/** Same ordinary registration's foreground responsibility while its new Home sheet replaces the old form. */
@Composable internal fun HomeStarterDepartureDriver(model: StarterExpeditionViewModel?, visible: Boolean,
    generation: Long, contentIdentity: Any?, ordersAllowed: Boolean) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(model, lifecycle, visible) {
        val observer = LifecycleEventObserver { _, event ->
            if (visible && event == Lifecycle.Event.ON_STOP) model?.dismiss()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); if (visible) model?.dismiss() }
    }
    LaunchedEffect(model, lifecycle, visible, generation, contentIdentity, ordersAllowed) {
        if (visible) {
            model?.dismiss()
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model?.foreground(); awaitCancellation() }
        }
    }
}
