package gg.pixelkingdomwars.nativeclient.scene.probe

import com.badlogic.gdx.backends.android.AndroidFragmentApplication
import gg.pixelkingdomwars.nativeclient.MainActivity
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * libGDX 1.13.1's `AndroidFragmentApplication.onAttach` throws "Missing AndroidFragmentApplication.Callbacks" unless the
 * host activity (or a parent fragment) implements them. The first guarded emulator run (2026-09-25) found the device
 * probe crashing at launch for exactly this reason, which no other JVM test could see. Debug-only: the probe exists
 * only in the debug source set.
 */
class DeviceProbeHostTest {
    @Test fun `every activity that hosts a libGDX fragment implements its callbacks`() {
        for (host in listOf(DeviceProbeActivity::class.java, MainActivity::class.java,
                gg.pixelkingdomwars.nativeclient.scene.world.WorldEngineSmokeActivity::class.java))
            assertTrue("${host.simpleName} hosts a libGDX fragment and must implement AndroidFragmentApplication.Callbacks",
                AndroidFragmentApplication.Callbacks::class.java.isAssignableFrom(host))
    }
}
