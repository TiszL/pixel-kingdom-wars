package gg.pixelkingdomwars.nativeclient.scene.world

/**
 * Who owns a `Graphics.setContinuousRendering` call on the world surface (GLOBE-NATIVE-PLAN §5.6, §5.9).
 *
 * The world surface always renders on demand; "continuous" means motion, which the frame pacer turns into paced frames.
 * One caller is different: libGDX 1.13.1's `AndroidFragmentApplication.onPause` (javap) reads `isContinuousRendering()`,
 * sets continuous rendering ON, calls `AndroidGraphics.pause()` (waits up to 4 s, then kills the process) and, when
 * the fragment is being removed, `destroy()` (waits with NO timeout), then restores the value it read. Those waits end
 * only when the GL thread draws a frame. If that call reached the pacer (which [handshake] stops first) instead of the
 * view's real render mode, leaving the World tab would hang the UI thread forever.
 *
 * So: inside [during] (the fragment wraps `super.onPause()` in it) calls go to the view ([setContinuous] returns true);
 * everywhere else they set the pacer's motion flag and the view stays on demand.
 */
class RenderModeGate {
    @Volatile var handshake = false; private set
    /** The motion flag the pacer follows. */
    @Volatile var paced = false; private set

    /** True: apply [on] to the view's real render mode (the pause handshake). False: [paced] took it. */
    fun setContinuous(on: Boolean): Boolean {
        if (handshake) return true
        paced = on
        return false
    }

    /** What `isContinuousRendering()` answers: the view's real mode inside the handshake, the motion flag otherwise. */
    fun isContinuous(viewContinuous: Boolean): Boolean = if (handshake) viewContinuous else paced

    inline fun <T> during(block: () -> T): T {
        enter()
        try { return block() } finally { exit() }
    }

    @PublishedApi internal fun enter() { handshake = true }
    @PublishedApi internal fun exit() { handshake = false }
}
