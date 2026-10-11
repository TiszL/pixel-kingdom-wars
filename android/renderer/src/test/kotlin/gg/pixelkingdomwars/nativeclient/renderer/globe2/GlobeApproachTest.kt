package gg.pixelkingdomwars.nativeclient.renderer.globe2

import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

/**
 * D-NEXT approach prefetch: the owner pinch-dives without opening a realm's panel, so every dive was cold (2.6–3.0 s,
 * 5.7 s the first, on the Seeker) where a prefetched one lands in 0.47 s. The globe tells the host a dive is coming
 * early enough to load the realm's core first — and only then: every answer costs a realm load (~8 MB of GL), so a
 * camera passing over, spinning or flying, or resting high up or over the sea must never ask, and one realm asks once
 * while the camera stays near it.
 */
class GlobeApproachTest {
    private val approach = GlobeApproach()
    private var t = 1_000.0
    private val asked = ArrayList<String>()

    /** [ms] of 60 Hz frames with the same camera; returns what was asked meanwhile. */
    private fun frames(ms: Double, realm: String?, alt: Double, targetAlt: Double = alt, pinching: Boolean = false, moving: Boolean = false,
                       spinning: Boolean = false, flying: Boolean = false): List<String> {
        val before = asked.size
        val end = t + ms
        while (t < end) {
            approach.step(t, realm, alt, targetAlt, pinching, moving, spinning, flying)?.let { asked += it }
            t += 16.0
        }
        return asked.subList(before, asked.size).toList()
    }

    @Test fun `a 400 ms rest low over a realm with a map asks once, and the host is woken for it`() {
        assertEquals(emptyList(), frames(384.0, "crownlands", 0.5), "no answer before the rest is 400 ms long")
        val left = approach.wakeInMs(t)
        assertTrue(left in 0.0..16.0, "a camera at rest at 0 fps gets its frame when the rest ends ($left ms left)")
        assertEquals(listOf("crownlands"), frames(32.0, "crownlands", 0.5))
        assertEquals(emptyList(), frames(3_000.0, "crownlands", 0.5), "once per realm while the camera stays near it")
        assertEquals(-1.0, approach.wakeInMs(t), "nothing left to wake for")
    }

    @Test fun `a moving camera never asks, a rest after it does`() {
        assertEquals(emptyList(), frames(3_000.0, "crownlands", 0.4, moving = true), "a camera passing over is not looking")
        assertEquals(-1.0, approach.wakeInMs(t))
        assertEquals(emptyList(), frames(384.0, "crownlands", 0.4))
        assertEquals(listOf("crownlands"), frames(32.0, "crownlands", 0.4), "the rest counts from the last movement")
    }

    @Test fun `a pinch aiming below 0_5 asks at once, one aiming above it does not`() {
        assertEquals(emptyList(), frames(1_000.0, "elderwood", 0.62, targetAlt = 0.55, pinching = true, moving = true))
        assertEquals(listOf("elderwood"), frames(16.0, "elderwood", 0.6, targetAlt = 0.48, pinching = true, moving = true),
            "the dive is coming: its first pinch frame below the approach altitude asks")
        assertEquals(emptyList(), frames(1_000.0, "elderwood", 0.4, targetAlt = 0.35, pinching = true, moving = true), "once")
    }

    @Test fun `another realm asks anew, and so does the first one when the camera comes back to it`() {
        assertEquals(listOf("crownlands"), frames(500.0, "crownlands", 0.5))
        assertEquals(emptyList(), frames(300.0, "elderwood", 0.5, moving = true))
        assertEquals(listOf("elderwood"), frames(500.0, "elderwood", 0.5))
        assertEquals(emptyList(), frames(300.0, "crownlands", 0.5, moving = true))
        assertEquals(listOf("crownlands"), frames(500.0, "crownlands", 0.5), "only the host knows whether it is still loaded")
    }

    @Test fun `resting above 0_6 or over the sea never asks, and leaving the zone re-arms the realm`() {
        assertEquals(emptyList(), frames(3_000.0, "crownlands", 0.65), "the realm is small at that height: no load for it")
        assertEquals(emptyList(), frames(3_000.0, null, 0.4), "the sea, or a realm without a map")
        assertEquals(listOf("crownlands"), frames(500.0, "crownlands", 0.55))
        assertEquals(emptyList(), frames(500.0, "crownlands", 0.8))
        assertEquals(listOf("crownlands"), frames(500.0, "crownlands", 0.55), "back after leaving: asked again (it may have been evicted)")
    }

    @Test fun `a spinning or flying camera never asks, even over a realm`() {
        assertEquals(emptyList(), frames(3_000.0, "sunscar", 0.4, spinning = true), "a fling passes over realms")
        assertEquals(emptyList(), frames(3_000.0, "sunscar", 0.4, flying = true), "a flight (a selection's, the dive's) is not the player")
        assertEquals(emptyList(), frames(1_000.0, "sunscar", 0.4, targetAlt = 0.3, pinching = true, flying = true))
        assertEquals(-1.0, approach.wakeInMs(t))
        assertEquals(listOf("sunscar"), frames(500.0, "sunscar", 0.4), "the rest after the flight lands asks")
    }

    @Test fun `the globe tells its host once when the camera rests low over a realm with a map, never over one without`() {
        val rig = GlobeRig(); rig.renderer.start(); rig.untilReady(); rig.frame()
        val crown = GlobeV2Pin.REALMS.indexOfFirst { it.id == "crownlands" }
        val (_, geoms) = GlobeRig.geography()
        val cam = rig.renderer.camera
        V.copy(cam.t, geoms[crown].c); cam.z = cam.zOf(0.5); cam.zT = cam.z
        repeat(60) { rig.frame() } // 1 s at rest
        assertTrue(rig.events.approaches.isEmpty(), "no map for crownlands in this build: nothing to load")
        rig.renderer.divable = setOf("crownlands")
        rig.frame()
        val wake = rig.renderer.approachWakeInMs(rig.now)
        assertTrue(wake > 0 && wake <= GlobeApproach.REST_MS, "the host is asked for the frame that ends the rest ($wake ms)")
        repeat(60) { rig.frame() }
        assertEquals(listOf("crownlands"), rig.events.approaches, "one answer, 400 ms into the rest")
        assertTrue(rig.events.dives.isEmpty(), "an approach loads; it never dives")
        assertEquals(-1.0, rig.renderer.approachWakeInMs(rig.now))
        // a flight to another realm (a panel's selection) is not an approach; resting there is
        val sun = GlobeV2Pin.REALMS.indexOfFirst { it.id == "sunscar" }
        rig.renderer.divable = setOf("crownlands", "sunscar")
        cam.flyTo(geoms[sun].c, cam.zOf(0.5), rig.now, 600.0)
        repeat(30) { rig.frame() } // mid-flight
        assertEquals(listOf("crownlands"), rig.events.approaches)
        repeat(90) { rig.frame() }
        assertEquals(listOf("crownlands", "sunscar"), rig.events.approaches)
    }

    @Test fun `a reset forgets the realm and the rest`() {
        frames(300.0, "frostveil", 0.5)
        approach.reset()
        assertEquals(-1.0, approach.wakeInMs(t))
        assertEquals(emptyList(), frames(384.0, "frostveil", 0.5), "the rest starts again")
        assertEquals(listOf("frostveil"), frames(32.0, "frostveil", 0.5))
    }
}
