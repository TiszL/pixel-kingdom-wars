package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.*
import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionReview

/** Presentation only. The registration still owns its model, journal, lifecycle and single foreground driver. */
class HomeVoyageVisibility {
    private var leases by mutableStateOf<Map<Any, HomeRouteIdentity>>(emptyMap())
    fun attach(value: HomeRouteIdentity): Any = Any().also { leases = leases + (it to value) }
    fun detach(value: Any) { leases = leases - value }
    fun isCurrent(value: HomeRouteIdentity?): Boolean = value != null && leases.values.any { it == value }
}

/** Explicit actions borrowed from the existing ordinary StarterExpedition registration. No new repository or driver. */
data class HomeStarterCommands(
    val visibility: HomeVoyageVisibility,
    val current: () -> Boolean,
    val reviewRoute: suspend (String) -> Unit,
    val reviewSaved: suspend () -> Unit,
    val confirm: suspend (StarterExpeditionReview) -> Unit,
    val dismiss: () -> Unit,
    val finishAccepted: suspend () -> Unit,
    /** The registration's archive of an unsent draft or a declined request (GET by key, local archive; never a POST). */
    val archiveUnused: suspend () -> Unit = {},
)

/** Supplies-only dispatch and return collection; install/service wallet operations are not exported. */
data class HomeVehicleCommands(
    val visibility: HomeVoyageVisibility,
    val dispatch: suspend (base: String, installation: String, route: String) -> Boolean,
    val collect: suspend (base: String) -> Boolean,
)

@Composable internal fun HomeVoyageVisibilityLease(identity: HomeRouteIdentity, starter: HomeStarterCommands?, vehicle: HomeVehicleCommands?) {
    DisposableEffect(identity, starter, vehicle) {
        val starterToken = starter?.visibility?.attach(identity)
        val vehicleToken = vehicle?.visibility?.attach(identity)
        onDispose {
            starterToken?.let { starter?.visibility?.detach(it) }
            vehicleToken?.let { vehicle?.visibility?.detach(it) }
        }
    }
}
