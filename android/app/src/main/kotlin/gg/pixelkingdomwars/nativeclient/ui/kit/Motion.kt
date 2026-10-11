package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalInspectionMode
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion

/**
 * Design component: the enter / exit motion every transient kit surface shares (DESIGN-SYSTEM §7: toasts, banner, seal,
 * celebration). [Presence] keeps the last shown value on screen while it animates out, then drops it, so a caller only
 * ever passes "what should be showing now" (or null).
 *
 * Reduced motion: every change is a 120 ms cross-fade; callers must skip slides and scales when `reduced` is true.
 *
 * [onGone] runs once when a shown value has finished animating out and is no longer painted (not on a first
 * composition with null, and not when a new value interrupts the exit). The caller must keep composing the SAME
 * Presence with null through the exit for this to fire.
 */
@Composable internal fun <T : Any> Presence(value: T?, enterMs: Int, exitMs: Int, onGone: (() -> Unit)? = null,
    content: @Composable (shown: T, progress: () -> Float, active: Boolean, reduced: Boolean) -> Unit) {
    val reduced = LocalReducedMotion.current
    val retained = remember { mutableStateOf(value) }
    // Previews render one still frame: start a shown value fully in, so the preview is not blank.
    val inspection = LocalInspectionMode.current
    val progress = remember { Animatable(if (inspection && value != null) 1f else 0f) }
    SideEffect { if (value != null && retained.value != value) retained.value = value }
    val visible = value != null
    val currentOnGone by rememberUpdatedState(onGone)
    LaunchedEffect(visible, reduced) {
        if (visible) {
            progress.animateTo(1f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else enterMs, easing = PkwTokens.Motion.Out))
        } else {
            val wasShown = retained.value != null
            progress.animateTo(0f, tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else exitMs, easing = PkwTokens.Motion.In))
            retained.value = null
            if (wasShown) currentOnGone?.invoke()
        }
    }
    val shown = value ?: retained.value ?: return
    content(shown, { progress.value }, visible, reduced)
}
