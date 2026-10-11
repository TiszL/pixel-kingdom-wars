package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureRegistry

internal val LocalPhaseEBaseSnapshot = staticCompositionLocalOf<() -> BaseSnapshot?> { { null } }
internal val LocalPhaseEBuildingDispatcher = staticCompositionLocalOf<PhaseEBuildingDispatcher?> { null }

/** Install inside HomeShell, where the single Home dispatcher exists. No second router or body owner. */
@Composable internal fun PhaseEBuildingDispatcherScope(dispatcher: PhaseEBuildingDispatcher?,
    content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalPhaseEBuildingDispatcher provides dispatcher) { content() }
}

/** A mount of existing navigation only. Every callback checks its owner's current identity and feature read at use. */
@Composable internal fun PhaseEBuildingDoor(base: BaseSnapshot, building: Building, onClose: () -> Unit) {
    val currentBase=LocalPhaseEBaseSnapshot.current
    val dispatcher = LocalPhaseEBuildingDispatcher.current
    if (dispatcher != null) {
        val feature = PhaseEBuildingActions.canonicalFeature(base, building.id, base.baseId, building.type) ?: return
        val title = remember { FeatureRegistry.canonical() }[feature]?.title ?: return
        OutlinedButton(onClick = { dispatcher.openBuilding(base.baseId, building, currentBase()) }) { Text(title) }
        // The Unit callback only enqueues; Home consumption decides whether to keep or release selection.
        return
    }
    val registry = rememberPhaseEActivityRegistry() ?: return
    val actions = PhaseEBuildingActions.actions(base,building.id,base.baseId,registry.launchable.toSet())
    actions.forEach { activity ->
        OutlinedButton(onClick={
            val live=currentBase()
            val stillPresent=PhaseEBuildingActions.actions(live,building.id,live?.baseId,registry.launchable.toSet()).contains(activity)
            val opened = if (!stillPresent) false else if (activity == PhaseEActivity.VEHICLES) {
                when (live?.buildings?.singleOrNull { it.id == building.id }?.type) {
                    "lodge" -> registry.launchFeature(VehicleEntryPoint.LODGE.featureId)
                    "berth" -> registry.launchFeature(VehicleEntryPoint.BERTH.featureId)
                    else -> false
                }
            } else registry.launch(activity)
            if (opened) onClose()
        }) { Text(activity.title) }
    }
}
