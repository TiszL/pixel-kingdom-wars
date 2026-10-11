package gg.pixelkingdomwars.nativeclient.ui.nav

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.staticCompositionLocalOf

/** Android Back priorities mirroring the web registry (`lib/mobileBackGuard.ts`). */
object BackPriority {
    const val CONFIRM = 1000      // MobileBackConfirm (sign out, discard layout, retreat, next target)
    const val SHEET = 220         // action / build / train / research sheets
    const val LAYOUT_EDITOR = 160
    const val BATTLE = 140        // RaidUI: retreat confirm
    const val SCOUT = 120
    const val REALM_CARD = 118    // realm map: search, level panel, then the base card (ui.js escape order)
    const val GLOBE_LIST = 110    // legacy globe: the Nearby keeps cluster list; GL30 globe: the search overlay
    const val REALM_MAP = 105     // realm map → back to the globe (GLOBE-NATIVE-PLAN §3.5)
    const val GLOBE_LAYERS = 100  // fantasy world / campaign layers: the globe selection and its panel
    const val SCREEN = 50         // any non-Home screen returns to Home
    const val HOME = 10           // Home: double-back exit
}

/** Highest enabled priority wins; registration order only breaks ties (latest first). */
class BackRegistry {
    class Registration internal constructor(val priority: Int, val order: Long, internal val handler: () -> Unit, private val changed: () -> Unit) {
        @Volatile var enabled: Boolean = true
            set(value) { if (field != value) { field = value; changed() } }
    }
    private val handlers = mutableListOf<Registration>()
    private var counter = 0L
    private val _changes = MutableStateFlow(0L)
    /** Lets deferred navigation recheck the existing winner after Back closes an interaction. */
    val changes = _changes.asStateFlow()
    @Synchronized private fun changed() { _changes.value++ }

    @Synchronized fun register(priority: Int, enabled: Boolean = true, handler: () -> Unit): Registration =
        Registration(priority, counter++, handler, ::changed).also { it.enabled = enabled; handlers += it; changed() }
    @Synchronized fun unregister(registration: Registration) { handlers.remove(registration); changed() }
    @Synchronized fun active(): Registration? = handlers.filter { it.enabled }.maxWithOrNull(compareBy({ it.priority }, { it.order }))
    /** Runs the winning handler; false when nothing is registered so the caller applies the default. */
    fun dispatch(): Boolean { val winner = active() ?: return false; winner.handler(); return true }
    @Synchronized fun size(): Int = handlers.size
}

val LocalBackRegistry = staticCompositionLocalOf<BackRegistry> { error("BackRegistry is provided by the app root") }

/** Registers a Back handler at [priority]; the system event is routed through the registry so a
 * lower-priority handler composed later (for example a screen under a sheet) never wins. */
@Composable fun BackHandlerAt(priority: Int, enabled: Boolean = true, onBack: () -> Unit) {
    val registry = LocalBackRegistry.current
    val current = rememberUpdatedState(onBack)
    DisposableEffect(registry, priority, enabled) {
        val registration = registry.register(priority, enabled) { current.value() }
        onDispose { registry.unregister(registration) }
    }
    BackHandler(enabled) { registry.dispatch() }
}
