package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot

/** Captured only after a successful current feature read. A -> B -> A is a different generation. */
internal data class PhaseEDoorIdentity(val session: Any?, val wallet: String, val baseId: String?,
    val generation: Long, val content: Any?)

internal fun phaseEDoorIdentityCurrent(captured: PhaseEDoorIdentity?, current: PhaseEDoorIdentity): Boolean =
    captured != null && captured.session != null && captured.session === current.session &&
        captured.wallet == current.wallet && captured.baseId != null && captured.baseId == current.baseId &&
        captured.generation == current.generation && captured.content != null && captured.content === current.content

internal fun phaseEDoorAdmitted(captured: PhaseEDoorIdentity?, current: PhaseEDoorIdentity, base: BaseSnapshot?,
    type: String, advertised: Boolean, foreground: Boolean, battleActive: Boolean, ordersAllowed: Boolean): Boolean =
    phaseEDoorIdentityCurrent(captured,current) && foreground && !battleActive && ordersAllowed && advertised &&
        base?.baseId == current.baseId && base?.buildings?.any { it.type == type && it.level > 0 && !it.underConstruction } == true

internal fun phaseEDoorAvailable(graph: gg.pixelkingdomwars.nativeclient.AppGraph,
    session: gg.pixelkingdomwars.nativeclient.SessionGraph, lifecycle: androidx.lifecycle.Lifecycle,
    observed: PhaseEDoorIdentity?, type: String, advertised: Boolean): Boolean {
    val battle=session.battle.state.value
    return phaseEDoorAdmitted(observed,phaseEDoorIdentity(graph),session.base.state.value.base,type,advertised,
        lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED),
        battle.battleVisible || battle.replay != null || battle.spectator != null,
        graph.content.state.value.allowsGameOrders(graph.versionCode) && session.interlock.state.value.actionsAllowed)
}
