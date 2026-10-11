package gg.pixelkingdomwars.nativeclient.scene.world

import com.badlogic.gdx.Gdx
import com.badlogic.gdx.backends.android.AndroidGL20
import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import java.lang.reflect.Proxy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GLOBE-NATIVE-PLAN §3.3 and §5.9: the two lifecycle traps of putting one GLES 3 surface next to GLES 2 ones in
 * libGDX 1.13.1 (both read from its bytecode).
 */
class WorldLifecycleRulesTest {
    private val saved = arrayOf<Any?>(Gdx.gl, Gdx.gl20, Gdx.gl30, Gdx.gl31, Gdx.gl32)

    @After fun restoreStatics() {
        Gdx.gl = saved[0] as GL20?; Gdx.gl20 = saved[1] as GL20?; Gdx.gl30 = saved[2] as GL30?
        Gdx.gl31 = saved[3] as com.badlogic.gdx.graphics.GL31?; Gdx.gl32 = saved[4] as com.badlogic.gdx.graphics.GL32?
    }

    private fun fakeGl30(): GL30 = Proxy.newProxyInstance(GL30::class.java.classLoader, arrayOf(GL30::class.java)) { p, m, a ->
        when (m.name) { "hashCode" -> System.identityHashCode(p); "equals" -> p === a?.get(0); "toString" -> "fake GL30"; else -> null }
    } as GL30

    @Test fun `leaving the World tab leaves no GL30 handle for Kingdom or battle`() {
        // after a World visit on GLES 3: what AndroidGraphics.setupGL's GL30 branch wrote
        val world = fakeGl30()
        Gdx.gl = world; Gdx.gl20 = world; Gdx.gl30 = world
        assertTrue("the leak was there", WorldGdxStatics.clearGl30())
        assertNull("SpriteBatch picks the VAO path whenever Gdx.gl30 is set", Gdx.gl30)
        assertNull(Gdx.gl31); assertNull(Gdx.gl32)
        assertFalse(Gdx.gl is GL30); assertFalse(Gdx.gl20 is GL30)
        assertTrue("a plain GL20 (libGDX's own AndroidGL20) stands in", Gdx.gl is AndroidGL20)
        assertSame(Gdx.gl, Gdx.gl20)
    }

    @Test fun `clearing when nothing leaked leaves a GLES 2 surface's handles untouched`() {
        val kingdom = AndroidGL20()
        Gdx.gl = kingdom; Gdx.gl20 = kingdom; Gdx.gl30 = null
        assertFalse(WorldGdxStatics.clearGl30())
        assertSame(kingdom, Gdx.gl); assertSame(kingdom, Gdx.gl20)
    }

    @Test fun `a World tab that comes back from the background gets its own GL30 handle again`() {
        val world = fakeGl30()
        Gdx.gl = world; Gdx.gl20 = world; Gdx.gl30 = world
        WorldGdxStatics.clearGl30() // pause
        WorldGdxStatics.restoreGl30(world) // resume: libGDX's setupGL returns early and would leave it null
        assertSame(world, Gdx.gl30); assertSame(world, Gdx.gl); assertSame(world, Gdx.gl20)
        WorldGdxStatics.restoreGl30(null) // an ES 2 world surface has nothing to restore
        assertSame(world, Gdx.gl30)
    }

    /**
     * libGDX 1.13.1 `AndroidFragmentApplication.onPause`, as javap shows it: read the mode, force continuous rendering,
     * `pause()` (waits ≤ 4 s for a GL-thread frame, then kills the process), `destroy()` when removing (waits with NO
     * timeout for a GL-thread frame), restore the mode. [viewMode] is the GLSurfaceView's real render mode.
     */
    private class LibGdxPause(val gate: RenderModeGate) {
        var viewContinuous = false
        var pacerMotion = false
        var continuousDuringWaits = false
        fun set(on: Boolean) { if (gate.setContinuous(on)) viewContinuous = on else pacerMotion = gate.paced }
        fun onPause() {
            val was = gate.isContinuous(viewContinuous)
            set(true)
            continuousDuringWaits = viewContinuous // pause() and destroy() wait for a frame the view must draw
            set(was)
        }
    }

    @Test fun `libGDX's pause handshake reaches the view's real render mode, so leaving World never deadlocks`() {
        val gate = RenderModeGate()
        val libgdx = LibGdxPause(gate)
        libgdx.set(true) // the legacy globe animates: motion for the pacer
        assertTrue(libgdx.pacerMotion); assertFalse("the view itself stays on demand", libgdx.viewContinuous)
        gate.during { libgdx.onPause() }
        assertTrue("during pause()/destroy() the GL thread must keep drawing or the UI thread waits forever", libgdx.continuousDuringWaits)
        assertFalse("afterwards the view is back on demand", libgdx.viewContinuous)
        assertTrue("the motion flag survived the handshake", libgdx.pacerMotion)
        assertFalse(gate.handshake)
    }

    @Test fun `outside the handshake a continuous request never reaches the view`() {
        val gate = RenderModeGate()
        val libgdx = LibGdxPause(gate)
        libgdx.onPause() // without the gate: the pacer would swallow it
        assertFalse("this is the deadlock the gate exists for", libgdx.continuousDuringWaits)
        assertEquals(false, gate.isContinuous(viewContinuous = true))
    }
}
