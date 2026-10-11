package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.math.Matrix4
import com.badlogic.gdx.math.Vector3
import org.junit.Test
import kotlin.test.*

class BaseCameraViewTest {
    @Test fun `world chrome hides before motion and returns only after the current camera settles without contacts`() {
        val gate = BaseCameraOverlay(); val start = BaseCameraView("base", 640f, 640f, 1f, 1080, 2400)
        assertTrue(gate.frame(start, false)!!.overlayVisible)
        assertFalse(gate.frame(start, true)!!.overlayVisible, "pointer down hides before GL pan, even at unchanged camera")
        val moved = start.copy(cameraX = 800f, zoom = .7f)
        assertFalse(gate.frame(moved, true)!!.overlayVisible)
        repeat(3) { assertFalse(gate.frame(moved, true)!!.overlayVisible, "a pause with fingers still down is not settled") }
        assertFalse(gate.frame(moved, false)!!.overlayVisible)
        assertEquals(moved, gate.frame(moved, false), "restores the latest projection, never the pre-pan coordinates")
        assertFalse(gate.frame(moved, true)!!.overlayVisible)
        // ACTION_CANCEL and release both clear contacts; two drawn frames recover without requiring another gesture.
        assertFalse(gate.frame(moved, false)!!.overlayVisible)
        assertTrue(gate.frame(moved, false)!!.overlayVisible)
        assertNull(gate.frame(null, false))
        assertTrue(gate.frame(start.copy(baseId = "other"), false)!!.overlayVisible, "new renderer/base cannot inherit a stuck gesture")
    }

    @Test fun `a fit or resize cannot restore chrome while its projection is still changing`() {
        val gate = BaseCameraOverlay(); val start = BaseCameraView("base", 640f, 640f, 1f, 1080, 2400)
        gate.frame(start, false)
        val first = start.copy(cameraX = 700f); val final = first.copy(width = 2400, height = 1080)
        assertFalse(gate.frame(first, false)!!.overlayVisible)
        assertFalse(gate.frame(final, false)!!.overlayVisible)
        assertFalse(gate.frame(final, false)!!.overlayVisible)
        assertEquals(final, gate.frame(final, false))
    }
    /** libGDX `OrthographicCamera.update` + `Camera.project` for `setToOrtho(true)` (y-down: up = -Y, looking down +Z),
     * assembled from its own matrix maths; the camera class itself needs the native Frustum, absent on the JVM. */
    private fun drawn(x: Float, y: Float, cameraX: Float, cameraY: Float, zoom: Float, width: Int, height: Int): Pair<Float, Float> {
        val position = Vector3(cameraX, cameraY, 0f)
        val projection = Matrix4().setToOrtho(zoom * -width / 2f, zoom * (width / 2f), zoom * -(height / 2f), zoom * height / 2f, 0f, 100f)
        val view = Matrix4().setToLookAt(position, Vector3(position).add(0f, 0f, 1f), Vector3(0f, -1f, 0f))
        val point = Vector3(x, y, 0f).prj(projection.mul(view))
        return width * (point.x + 1) / 2 to height - height * (point.y + 1) / 2 // GL y grows upward; the surface and Compose grow downward
    }
    /** A chip that projects differently from the frame slides off its building during a pan or pinch. */
    @Test fun `app projection is the y-down orthographic mapping the base frame was drawn with`() {
        for ((width, height) in listOf(1080 to 2400, 2400 to 1080)) for (zoom in listOf(.35f, 1f, 2.75f)) {
            val view = BaseCameraView("base", 1234.5f, 987.25f, zoom, width, height)
            for ((x, y) in listOf(0f to 0f, 1234.5f to 987.25f, 1600f to 640f, -320f to 2048f)) {
                val (screenX, screenY) = drawn(x, y, view.cameraX, view.cameraY, zoom, width, height)
                assertEquals(screenX, view.screenX(x), .05f); assertEquals(screenY, view.screenY(y), .05f)
            }
            assertEquals(width / 2f, view.screenX(view.cameraX)); assertEquals(height / 2f, view.screenY(view.cameraY))
            assertEquals(1f / zoom, view.scale)
        }
    }
    @Test fun `a camera that cannot project is refused rather than placing chips at infinity`() {
        assertFailsWith<IllegalArgumentException> { BaseCameraView("base", 0f, 0f, 0f, 1080, 2400) }
        assertFailsWith<IllegalArgumentException> { BaseCameraView("base", Float.NaN, 0f, 1f, 1080, 2400) }
        assertFailsWith<IllegalArgumentException> { BaseCameraView("base", 0f, 0f, 1f, 0, 2400) }
    }
}
