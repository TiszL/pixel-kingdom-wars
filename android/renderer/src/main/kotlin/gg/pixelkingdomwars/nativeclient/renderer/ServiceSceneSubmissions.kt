package gg.pixelkingdomwars.nativeclient.renderer

/** Main publishes scenes while GL can refresh on resume. Capture and dispatch
 * share one reentrant lock, so a captured old scene cannot replace a newer one.
 * Dispatch only queues existing preparation work; it never waits for IO or GL. */
internal class ServiceSceneSubmissions {
    private var current: (() -> Unit)? = null
    @Synchronized fun replace(request: () -> Unit) { current = request; request() }
    @Synchronized fun refresh() { current?.invoke() }
    @Synchronized fun change(change: () -> Boolean) { if (change()) current?.invoke() }
    @Synchronized fun clear() { current = null }
}
