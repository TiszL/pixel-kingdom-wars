package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

/** A registration composes and registers within a frame or two, or after its first GET; past this it is not open here. */
internal const val PHASE_E_PENDING_LAUNCH_MS = 4_000L

/** What a caller tells the player when a pending launch settles false. */
internal const val PHASE_E_NOT_OPEN_LINE = "That activity is not open on this server yet"

/** A route argument's activity; a missing or unknown name is null, never a guess. */
internal fun phaseEActivityNamed(name: String?): PhaseEActivity? = PhaseEActivity.entries.firstOrNull { it.name == name }

/** Waits until [activity]'s own registration can launch, then launches it once through the registry. False when it never
 *  became launchable in time. Navigation only: the registration's onLaunch decides what opens. */
internal suspend fun phaseELaunchWhenRegistered(registry: PhaseEActivityRegistry, activity: PhaseEActivity,
    timeoutMs: Long = PHASE_E_PENDING_LAUNCH_MS): Boolean {
    val ready = withTimeoutOrNull(timeoutMs) { snapshotFlow { activity in registry.launchable }.first { it } }
    return ready == true && registry.launch(activity)
}

/** Opens [activity] once its registration has registered (a sibling tab, or a World door into Bases). [onSettled] gets
 *  false when nothing opened, so the caller can say why; null does nothing. */
@Composable internal fun PhaseEPendingLaunch(activity: PhaseEActivity?, onSettled: (Boolean) -> Unit) {
    val registry = rememberPhaseEActivityRegistry()
    val settled by rememberUpdatedState(onSettled)
    LaunchedEffect(activity, registry) {
        if (activity == null) return@LaunchedEffect
        settled(registry != null && phaseELaunchWhenRegistered(registry, activity))
    }
}
