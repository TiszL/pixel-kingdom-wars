package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.renderer.BaseCameraView
import gg.pixelkingdomwars.nativeclient.renderer.RenderBuilding
import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import org.junit.Assert.*
import org.junit.Test

class BuildingSelectionAnchorTest {
    private val building = RenderBuilding("workshop", "service:workshop", 2f, 3f, 2f, 3f)
    private val camera = BaseCameraView("home", 0f, 0f, 1f, 200, 400)

    @Test fun `an unmeasured service roof still anchors the plate to its footprint`() {
        assertEquals(PxRect(120f, 230f, 140f, 260f),
            buildingSelectionAnchor(building, null, "home", 10f, camera))
    }

    @Test fun `a measured roof keeps its height and the footprint sides and bottom`() {
        assertEquals(PxRect(120f, 212f, 140f, 260f),
            buildingSelectionAnchor(building, 12f, "home", 10f, camera))
    }

    @Test fun `the fallback projects the current pan and zoom through the same camera`() {
        assertEquals(PxRect(105f, 205f, 115f, 220f),
            buildingSelectionAnchor(building, null, "home", 10f,
                camera.copy(cameraX = 10f, cameraY = 20f, zoom = 2f)))
    }

    @Test fun `no selected building gives no anchor`() {
        assertNull(buildingSelectionAnchor(null, null, "home", 10f, camera))
    }

    @Test fun `an absent camera never invents a projection`() {
        assertNull(buildingSelectionAnchor(building, null, "home", 10f, null))
    }

    @Test fun `a camera from another base stays hidden even without a roof`() {
        assertNull(buildingSelectionAnchor(building, null, "home", 10f, camera.copy(baseId = "other")))
    }

    @Test fun `motion hides both the measured and fallback anchors`() {
        for (roof in listOf(null, 12f)) {
            assertNull(buildingSelectionAnchor(building, roof, "home", 10f, camera.copy(overlayVisible = false)))
        }
    }
}
