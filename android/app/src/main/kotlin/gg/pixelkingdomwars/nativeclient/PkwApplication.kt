package gg.pixelkingdomwars.nativeclient

import android.app.Application
import gg.pixelkingdomwars.nativeclient.data.LaunchMode

/** Owns the single [AppGraph]. The launch mode is fixed by the first activity intent: a debug
 * fixture preview never becomes an account session, and an account launch never reads fixtures. */
class PkwApplication : Application() {
    @Volatile private var graph: AppGraph? = null
    @Synchronized fun graph(mode: LaunchMode): AppGraph = graph ?: run {
        gg.pixelkingdomwars.nativeclient.telemetry.NativeTelemetryRuntime.start(this, mode.offline)
        AppGraph(this, mode).also { graph = it }
    }
}
