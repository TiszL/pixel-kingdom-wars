package gg.pixelkingdomwars.nativeclient.renderer

/** A prepared reuse decision belongs to one target painting, even if another scene commits first. */
internal class GroundReuseAdmission(private val identity: String) {
    private var requested = false
    /** True keeps the replacement staged. A mismatched delivery requests CPU preparation once. */
    fun prepareIfChanged(activeIdentity: String?, prepare: () -> Unit): Boolean {
        if (activeIdentity == identity) return false
        if (!requested) { requested = true; prepare() }
        return true
    }
}
