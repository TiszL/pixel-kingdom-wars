package gg.pixelkingdomwars.nativeclient.diagnostics

/** A document picker returning after clear/disable/re-enable never renews its previous consent. */
internal class LocalReportConsent {
    @Volatile var enabled = false
        private set
    @Volatile var generation = 0L
        private set
    @Synchronized fun change(on: Boolean): Long? {
        if (enabled == on) return null
        generation++; enabled = on
        return generation
    }
    @Synchronized fun invalidate(): Long { generation++; return generation }
    @Synchronized fun active(expected: Long) = enabled && expected == generation
    @Synchronized fun permit(raw: Boolean) = if (enabled) LocalExportPermit(generation, raw) else null
}
data class LocalExportPermit internal constructor(internal val generation: Long, internal val raw: Boolean)
