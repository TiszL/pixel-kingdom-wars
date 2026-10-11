package gg.pixelkingdomwars.nativeclient.ui.features

import java.util.Collections

sealed interface GateFact {
    data object Unknown : GateFact
    data object Allowed : GateFact
    data class Denied(val reason: String) : GateFact {
        init { require(reason.isNotBlank()) }
    }
}

sealed interface GateResult {
    data object Pass : GateResult
    data class Locked(
        val reason: String,
        val unknown: Boolean = false,
        val unlockHint: Destination? = null,
    ) : GateResult {
        init { require(reason.isNotBlank()) }
    }
    data object Hidden : GateResult
}

sealed interface Gate {
    data object Open : Gate
    data class BuildingCompleted(val type: String, val minLevel: Int = 1) : Gate {
        init { require(type.isNotBlank() && minLevel > 0) }
    }
    data class KeepLevel(val min: Int) : Gate { init { require(min >= 0) } }
    data class ServerFeature(val key: String) : Gate { init { require(key.isNotBlank()) } }
    data class OwnerFact(val key: String) : Gate { init { require(key.isNotBlank()) } }
    data class HasHistory(val key: String) : Gate { init { require(key.isNotBlank()) } }
    data class WalletLinked(val required: Boolean = true) : Gate
    data class Not(val gate: Gate) : Gate
    class AllOf(gates: List<Gate>) : Gate {
        val gates: List<Gate> = Collections.unmodifiableList(ArrayList(gates))
    }
    class AnyOf(gates: List<Gate>) : Gate {
        val gates: List<Gate> = Collections.unmodifiableList(ArrayList(gates))
    }
}

/** Pure truth evaluation. The host separately evaluates visibility and current owner identity. */
fun Gate.check(ctx: GateContext): GateResult = when (this) {
    Gate.Open -> GateResult.Pass
    is Gate.ServerFeature -> ctx.serverFeatures[key].result()
    is Gate.OwnerFact -> ctx.ownerFacts[key].result()
    is Gate.HasHistory -> ctx.history[key].result()
    is Gate.BuildingCompleted -> ctx.buildings[type]?.let { state ->
        if (state.complete && state.level >= minLevel) GateResult.Pass
        else GateResult.Locked("Complete the required building first")
    } ?: unknownGate()
    is Gate.KeepLevel -> ctx.keepLevel?.let { current ->
        if (current >= min) GateResult.Pass else GateResult.Locked("Upgrade your Keep first")
    } ?: unknownGate()
    is Gate.WalletLinked -> if (required) ctx.walletLinked.result() else negate(ctx.walletLinked.result())
    is Gate.Not -> negate(gate.check(ctx))
    is Gate.AllOf -> {
        if (gates.isEmpty()) GateResult.Locked("Availability rules are incomplete", unknown = true)
        else {
            val results = gates.map { it.check(ctx) }
            results.filterIsInstance<GateResult.Locked>().firstOrNull { !it.unknown }
                ?: results.filterIsInstance<GateResult.Locked>().firstOrNull()
                ?: if (results.any { it == GateResult.Hidden }) unknownGate() else GateResult.Pass
        }
    }
    is Gate.AnyOf -> {
        if (gates.isEmpty()) GateResult.Locked("Availability rules are incomplete", unknown = true)
        else {
            val results = gates.map { it.check(ctx) }
            if (GateResult.Pass in results) GateResult.Pass
            else results.filterIsInstance<GateResult.Locked>().firstOrNull { it.unknown }
                ?: if (results.any { it == GateResult.Hidden }) unknownGate()
                else results.filterIsInstance<GateResult.Locked>().first()
        }
    }
}

private fun GateFact?.result(): GateResult = when (this) {
    null, GateFact.Unknown -> unknownGate()
    GateFact.Allowed -> GateResult.Pass
    is GateFact.Denied -> GateResult.Locked(reason)
}

private fun unknownGate(): GateResult.Locked = GateResult.Locked("Checking availability", unknown = true)

private fun negate(result: GateResult): GateResult = when (result) {
    GateResult.Pass -> GateResult.Locked("This action is not available now")
    is GateResult.Locked -> if (result.unknown) result else GateResult.Pass
    GateResult.Hidden -> unknownGate()
}
