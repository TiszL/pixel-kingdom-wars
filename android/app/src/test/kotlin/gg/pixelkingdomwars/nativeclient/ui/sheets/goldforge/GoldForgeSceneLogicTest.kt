package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The GoldForgeScene draw plan and maths (GF-A2): the native header must play the foundry exactly as the reference
 * player `gold-forge-scene/scene.js` does, at a whole-number pixel scale (design/final/goldforge/SPEC.md §1).
 */
class GoldForgeSceneLogicTest {
    private val plan = goldForgeScenePlan()
    private fun draws(t: Long, animate: Boolean = true, burst: Boolean = false) = goldForgeSceneDraws(plan, t, animate, burst).associateBy { it.id }

    // scene.js frame(): floor((t/1000 + phase) * fps) mod count. At the mock's t = 1840 the smith is on impact frame 6.
    @Test fun `frames step like the reference player`() {
        assertEquals(6, sceneFrameIndex(1_840L, fps = 12, frameCount = 16))
        assertEquals(2, sceneFrameIndex(0L, fps = 8, frameCount = 12, phaseMs = 250))
        assertEquals(0, sceneFrameIndex(4_000L, fps = 12, frameCount = 16))
        // Still scenes, still layers and single frames never animate.
        assertEquals(0, sceneFrameIndex(1_840L, fps = 12, frameCount = 16, animate = false))
        assertEquals(3, sceneFrameIndex(1_840L, fps = 12, frameCount = 16, animate = false, stillFrame = 3))
        assertEquals(0, sceneFrameIndex(1_840L, fps = 0, frameCount = 16))
        assertEquals(0, sceneFrameIndex(1_840L, fps = 12, frameCount = 1))
        // A once-only layer holds its last frame.
        assertEquals(7, sceneFrameIndex(60_000L, fps = 8, frameCount = 8, loop = false))
    }

    // scene.js carrier: out over 5 s, mirrored back over 5 s, 190 → 277 at foot y 188.
    @Test fun `the carrier walks out and back, mirrored on the return`() {
        val carrier = plan.first { it.id == "dwarf-carrier" }.track!!
        assertEquals(TrackPoint(190, 188, returning = false, visible = true), trackPoint(carrier, 0L))
        assertEquals(TrackPoint(234, 188, returning = false, visible = true), trackPoint(carrier, 2_500L))
        assertEquals(TrackPoint(277, 188, returning = true, visible = true), trackPoint(carrier, 5_000L))
        assertEquals(TrackPoint(234, 188, returning = true, visible = true), trackPoint(carrier, 7_500L))
        assertTrue(draws(7_500L).getValue("dwarf-carrier").mirrored)
        assertFalse(draws(2_500L).getValue("dwarf-carrier").mirrored)
    }

    // scene.js conveyor: the token shows only in the middle half of each 3.6 s cycle, arcing 5 px up at its middle.
    @Test fun `the conveyor token rides an arc in its window only`() {
        val token = plan.first { it.id == "keep-token-conveyor" }.track!!
        assertFalse(trackPoint(token, 900L).visible)
        assertEquals(TrackPoint(247, 124, returning = false, visible = true), trackPoint(token, 1_800L))
        assertFalse(trackPoint(token, 2_700L).visible)
        assertNull(draws(0L)["keep-token-conveyor"])
        assertEquals(247, draws(1_800L).getValue("keep-token-conveyor").left)
    }

    // scene.json impactFrames 5-7: sparks only on the smith's impact frames, only while animating; a SMELT receipt bursts.
    @Test fun `sparks follow the smith's impact frames`() {
        assertTrue(draws(1_840L).containsKey("forge-sparks"))
        assertFalse(draws(0L).containsKey("forge-sparks"))
        assertTrue(draws(0L, burst = true).containsKey("forge-sparks"))
        // Reduced motion / at rest: still frames, no sparks, no moving token, even with a burst.
        val still = draws(1_840L, animate = false, burst = true)
        assertFalse(still.containsKey("forge-sparks"))
        assertFalse(still.containsKey("keep-token-conveyor"))
        assertEquals(0, still.getValue("dwarf-smith").frame)
    }

    // Anchors place the cell; a mirrored cell flips its anchor (scene.js ctx.scale(-1, 1) around the anchor).
    @Test fun `anchors and mirroring place each cell`() {
        val smith = draws(1_840L).getValue("dwarf-smith")
        assertEquals(169 - 32, smith.left)
        assertEquals(176 - 58, smith.top)
        val layer = GoldForgeLayerSpec("x", "x.png", 0, 64, 64, anchorX = 10, anchorY = 4, x = 100, y = 50)
        assertEquals(90, goldForgeSceneDraws(listOf(layer), 0L, true).single().left)
        assertEquals(46, goldForgeSceneDraws(listOf(layer.copy(mirrored = true)), 0L, true).single().left)
    }

    // Draw order is the plan's order, whatever order the mapper hands the layers in; the background is first.
    @Test fun `layers draw back to front by order`() {
        val ids = goldForgeSceneDraws(plan.reversed(), 1_840L, true).map { it.id }
        assertEquals("background", ids.first())
        assertTrue(ids.indexOf("dwarf-smith") < ids.indexOf("anvil"))
        assertTrue(ids.indexOf("anvil") < ids.indexOf("forge-sparks"))
    }

    // The committed cart nudges only while animating; a hidden cart is not planned at all.
    @Test fun `the ingot cart follows the cart stage`() {
        assertNull(goldForgeScenePlan(CartStage.HIDDEN).firstOrNull { it.id == "ingot-cart" })
        val committed = goldForgeScenePlan(CartStage.COMMITTED)
        assertEquals(38 - 32, goldForgeSceneDraws(committed, 2_500L, animate = false).first { it.id == "ingot-cart" }.left)
        assertEquals(46 - 32, goldForgeSceneDraws(committed, 2_500L, animate = true).first { it.id == "ingot-cart" }.left)
    }

    // SPEC §1: s = ceil(width / 320), never fractional; centred on art x 155 and clamped; bottom-anchored.
    @Test fun `the viewport scales by whole pixels and keeps the dwarves' feet on the edge`() {
        assertEquals(SceneViewport(3, -67, -168), goldForgeViewport(796, 408))   // 2.0x density: art y 56..192 shows
        assertEquals(SceneViewport(4, -98, -233), goldForgeViewport(1045, 535))  // Seeker 2.625x
        assertEquals(SceneViewport(1, 0, 0), goldForgeViewport(320, 192))
        assertEquals(0, goldForgeViewport(960, 612).offsetX)                     // centring would leave a gap: clamped
        assertEquals(4, goldForgeViewport(961, 612).scale)
        assertEquals(1, goldForgeViewport(0, 0).scale)
    }

    // Atlases are horizontal strips; a wider-than-one-row atlas wraps.
    @Test fun `atlas cells are found by frame`() {
        assertEquals(384 to 0, atlasCell(6, 64, 64, 1024))
        assertEquals(64 to 80, atlasCell(5, 64, 80, 256))
    }

    // The plan carries scene.json's gate, the furnace-light clip and one decode per shared asset.
    @Test fun `the plan matches scene json and scene js`() {
        assertEquals(setOf(5, 6, 7), plan.first { it.id == "forge-sparks" }.gate?.frames)
        assertEquals(SceneRect(49, 96, 36, 53), plan.first { it.id == "furnace-light" }.clip)
        assertEquals(16, plan.first { it.id == "dwarf-smith" }.frameCount)
        val art = goldForgeSceneArt(plan)
        assertEquals(plan.size - 1, art.size)  // the two KEEP tokens share one bitmap
        assertTrue("source/background.png" in art)
    }
}
