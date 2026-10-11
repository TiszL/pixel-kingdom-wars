package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.test.*
import org.junit.Test
import java.io.File

class SceneCameraControlsTest {
    @Test fun `rapid accessible button presses retain order through a fit reset`() {
        val controls = SceneCameraControls(1.25f)
        controls.zoomIn(); controls.zoomIn(); controls.fit(); controls.zoomOut()
        assertEquals(listOf(SceneCameraControls.Command.IN, SceneCameraControls.Command.IN,
            SceneCameraControls.Command.FIT, SceneCameraControls.Command.OUT), generateSequence(controls::take).toList())
        assertNull(controls.take())
    }
    @Test fun `an absent camera contract disables only zoom and cannot manufacture its step`() {
        val controls = SceneCameraControls(null)
        controls.zoomIn(); controls.zoomOut(); controls.fit()
        assertEquals(SceneCameraControls.Command.FIT, controls.take()); assertNull(controls.take())
        assertFailsWith<IllegalArgumentException> { SceneCameraControls(Float.NaN) }
        assertFailsWith<IllegalArgumentException> { SceneCameraControls(1f) }
    }
    @Test fun `commands queued in an outgoing scene do not transfer to its replacement`() {
        val old = SceneCameraControls(1.25f); old.zoomIn()
        val replacement = SceneCameraControls(1.25f)
        assertNull(replacement.take())
        replacement.fit(); assertEquals(SceneCameraControls.Command.FIT, replacement.take())
    }

    /** The realm map's Enter-base seam hands the Home scene its opening camera. OPEN BASE selects the base and switches
     * to the Kingdom tab, which can first draw the previous selection while the new one loads: that base must never take
     * the camera (the player would see his other kingdom at a stranger's framing), and a raid or replay of the same base
     * is not the base scene. The camera applies once; a second OPEN BASE replaces the first. */
    @Test fun `an Enter-base camera opens only its own base scene, once, whatever frames come first`() {
        val controls = SceneCameraControls(null)
        controls.enterAt("mine", 960f, 992f, 1.17f)
        assertNull(controls.entryFor("previous", battle = false), "the previous selection's first frame leaves it waiting")
        assertNull(controls.entryFor(null, battle = false), "a scene without a base id is no base of the player's")
        assertNull(controls.entryFor("mine", battle = true), "a raid or replay on that base is not the base scene")
        val entry = assertNotNull(controls.entryFor("mine", battle = false), "the base's own first frame takes it")
        assertEquals(listOf(960f, 992f, 1.17f), listOf(entry.worldX, entry.worldY, entry.zoom))
        assertNull(controls.entryFor("mine", battle = false), "once: a later visit opens on the base's own fit")
        controls.enterAt("mine", 1f, 2f, 1f); controls.enterAt("mine", 3f, 4f, 2f)
        assertEquals(3f, controls.entryFor("mine", battle = false)?.worldX, "the newest OPEN BASE wins")
        controls.enterAt("mine", 1f, 2f, 1f); controls.cancelEntry()
        assertNull(controls.entryFor("mine", battle = false))
        assertFailsWith<IllegalArgumentException> { controls.enterAt("mine", 0f, 0f, 0f) }
        assertFailsWith<IllegalArgumentException> { controls.enterAt("mine", Float.NaN, 0f, 1f) }
    }

    /** "First frame" is the renderer's destination change: the entry is read only there, after that destination's fit
     * (else the fit would overwrite it), marked as the player's framing (else an inset refit or the next revision of the
     * same base would snap back), and clamped into the base's own band like a pinch. */
    @Test fun `the renderer applies the entry on a new destination's first frame, after its fit, as the player's framing`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/renderer/NativeGameRenderer.kt").readText()
        val fit = source.indexOf("if (destinationChanged && !cameraFraming.moved) fitCamera()")
        val entry = source.indexOf("if (destinationChanged) cameraControls.get()?.entryFor(active.baseId, battle != null)")
        assertTrue(fit >= 0 && entry > fit, "the entry follows the destination's fit")
        assertEquals(1, Regex("""entryFor\(""").findAll(source).count(), "no other frame reads the entry")
        val applied = source.substring(entry, source.indexOf("\n            }\n", entry))
        assertTrue("cameraFraming.moved = true; clampCamera()" in applied, "kept as the player's framing, clamped to the base band")
    }
}
