package gg.pixelkingdomwars.nativeclient.ui.layout

import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.LayoutPosition
import gg.pixelkingdomwars.nativeclient.model.Obstacle
import gg.pixelkingdomwars.nativeclient.model.PlotGeometry
import gg.pixelkingdomwars.nativeclient.network.DraftResult
import gg.pixelkingdomwars.nativeclient.network.LAYOUT_UNDO_LIMIT
import gg.pixelkingdomwars.nativeclient.network.LayoutDraft
import gg.pixelkingdomwars.nativeclient.network.LayoutGeometry
import gg.pixelkingdomwars.nativeclient.network.canonicalPositions
import gg.pixelkingdomwars.nativeclient.network.moveBuilding
import gg.pixelkingdomwars.nativeclient.network.undoDraft
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeTile
import org.junit.Assert.*
import org.junit.Test

/** Layout gestures rearrange the inventory already owned by this base. Each accepted operation is
 * one reversible draft edit; these helpers have no repository, purchase, or server-cost dependency. */
class LayoutWallEditsTest {
    private val buildings = listOf(
        Building("keep", "keep", 1, 10, 10),
        Building("cannon", "cannon", 1, 13, 10),
        Building("w1", "wall", 2, 10, 14),
        Building("w2", "wall", 2, 11, 14),
        Building("w3", "wall", 1, 12, 14),
    )
    private val geometry = LayoutGeometry(
        geometryVersion = 1, claimMin = 8, claimMax = 22,
        buildings = buildings, obstacles = listOf(Obstacle("rock", "boulder", 15, 15)),
        footprint = { if (it == "keep") 2 to 2 else 1 to 1 },
        obstacleSize = { if (it == "boulder") 2 else 1 },
        plotGeometry = PlotGeometry(1, 0, 30),
    )

    private fun draft(tray: List<String> = emptyList(), selected: String? = "keep") = LayoutDraft(
        canonicalPositions(buildings.filterNot { it.id in tray }.map { LayoutPosition(it.id, it.tx, it.ty) }),
        tray, selected,
    )

    private fun tiles(vararg coordinates: Pair<Int, Int>) = coordinates.map { WallStrokeTile(it.first, it.second) }

    private fun inventory(draft: LayoutDraft) = draft.positions.map { it.buildingId } + draft.trayIds

    private fun assertInventory(draft: LayoutDraft, expected: List<Building> = buildings) {
        val ids = inventory(draft)
        assertEquals("Every owned identity exists exactly once in the draft or tray", ids.size, ids.toSet().size)
        assertEquals(expected.map { it.id }.toSet(), ids.toSet())
    }

    private fun assertOneUndo(before: LayoutDraft, after: LayoutDraft) {
        assertEquals(minOf(LAYOUT_UNDO_LIMIT, before.history.size + 1), after.history.size)
        val restored = undoDraft(after)
        assertEquals(canonicalPositions(before.positions), restored.positions)
        assertEquals(before.trayIds, restored.trayIds)
        assertEquals(before.selectedId, restored.selectedId)
        assertEquals(before.history.takeLast(LAYOUT_UNDO_LIMIT - 1), restored.history)
    }

    private fun assertRefused(before: LayoutDraft, result: DraftResult) {
        assertNotNull("An invalid wall move needs a refusal", result.error)
        assertEquals("Refusal must not partially move identities or append history", before, result.draft)
    }

    @Test fun `paint consumes only matching owned wall levels in stable tray order`() {
        val before = draft(listOf("w2", "w3", "w1"))
        val originalInventory = geometry.buildings.toList()
        val result = layoutPaintWalls(before, geometry, 2,
            tiles(10 to 10, 9 to 9, 9 to 9, 15 to 15, 9 to 10, 9 to 11))
        assertNull(result.error)
        assertEquals(LayoutPosition("w2", 9, 9), result.draft.position("w2"))
        assertEquals(LayoutPosition("w1", 9, 10), result.draft.position("w1"))
        assertEquals(listOf("w3"), result.draft.trayIds)
        assertEquals(originalInventory, geometry.buildings)
        assertInventory(result.draft)
        assertOneUndo(before, result.draft)
    }

    @Test fun `paint never creates a missing wall level or invents exhausted inventory`() {
        val before = draft(listOf("w1", "w2"))
        assertRefused(before, layoutPaintWalls(before, geometry, 5, tiles(9 to 9)))
        val painted = layoutPaintWalls(before, geometry, 2, tiles(9 to 9, 9 to 10, 9 to 11)).draft
        assertEquals(2, painted.positions.count { it.buildingId in listOf("w1", "w2") })
        assertRefused(painted, layoutPaintWalls(painted, geometry, 2, tiles(9 to 12)))
        assertInventory(painted)
    }

    @Test fun `an entirely blocked paint stroke leaves the draft and its history unchanged`() {
        val before = draft(listOf("w1"))
        assertRefused(before, layoutPaintWalls(before, geometry, 2,
            tiles(10 to 10, 11 to 11, 15 to 15, 16 to 16, 7 to 8, 22 to 8)))
    }

    @Test fun `replaying painted cells cannot consume another trayed wall or add undo history`() {
        val before = draft(listOf("w1", "w2"))
        val first = layoutPaintWalls(before, geometry, 2, tiles(9 to 9)).draft
        val replay = layoutPaintWalls(first, geometry, 2, tiles(9 to 9, 9 to 9))
        assertEquals(first, replay.draft)
        assertEquals(listOf("w2"), replay.draft.trayIds)
        assertOneUndo(before, first)
    }

    @Test fun `erase returns each touched owned wall once and leaves buildings and obstacles alone`() {
        val before = draft(listOf("w3"))
        val originalInventory = geometry.buildings.toList()
        val result = eraseLayoutWalls(before, geometry,
            tiles(11 to 14, 11 to 14, 10 to 10, 15 to 15, 9 to 9, 10 to 14))
        assertNull(result.error)
        assertEquals(listOf("w3", "w2", "w1"), result.draft.trayIds)
        assertEquals(setOf("keep", "cannon"), result.draft.positions.map { it.buildingId }.toSet())
        assertEquals(originalInventory, geometry.buildings)
        assertEquals(listOf(Obstacle("rock", "boulder", 15, 15)), geometry.obstacles)
        assertInventory(result.draft)
        assertOneUndo(before, result.draft)
    }

    @Test fun `erase empty and nonwall strokes are noops and repeating an erase adds no history`() {
        val before = draft()
        for (stroke in listOf(emptyList(), tiles(10 to 10, 13 to 10, 15 to 15, 9 to 9))) {
            assertEquals(before, eraseLayoutWalls(before, geometry, stroke).draft)
        }
        val erased = eraseLayoutWalls(before, geometry, tiles(10 to 14, 11 to 14)).draft
        assertEquals(erased, eraseLayoutWalls(erased, geometry, tiles(10 to 14, 11 to 14)).draft)
        assertOneUndo(before, erased)
    }

    @Test fun `erase follows draft coordinates and cannot erase a wall at its old live position`() {
        val moved = moveBuilding(draft(), geometry, "w1", 8, 8).draft
        assertEquals(moved, eraseLayoutWalls(moved, geometry, tiles(10 to 14)).draft)
        val erased = eraseLayoutWalls(moved, geometry, tiles(8 to 8)).draft
        assertNull(erased.position("w1"))
        assertTrue(erased.inTray("w1"))
        assertOneUndo(moved, erased)
    }

    @Test fun `selection returns only touched placed wall identities once in stroke order`() {
        val before = draft(listOf("w3"))
        assertEquals(listOf("w2", "w1"), layoutWallSelection(before, geometry,
            tiles(11 to 14, 10 to 10, 15 to 15, 11 to 14, 12 to 14, 10 to 14)))
        assertEquals(emptyList<String>(), layoutWallSelection(before, geometry, emptyList()))
        assertEquals(draft(listOf("w3")), before)
    }

    @Test fun `selection tracks the saved draft rather than live building coordinates`() {
        val moved = moveBuilding(draft(), geometry, "w1", 8, 8).draft
        assertEquals(emptyList<String>(), layoutWallSelection(moved, geometry, tiles(10 to 14)))
        assertEquals(listOf("w1"), layoutWallSelection(moved, geometry, tiles(8 to 8)))
    }

    @Test fun `erase and selection hit the complete current wall footprint`() {
        val wide = geometry.copy(footprint = { if (it == "wall" || it == "keep") 2 to 2 else 1 to 1 })
        val before = draft(listOf("w2", "w3"))
        assertEquals(listOf("w1"), layoutWallSelection(before, wide, tiles(11 to 15)))
        val erased = eraseLayoutWalls(before, wide, tiles(11 to 15)).draft
        assertNull(erased.position("w1"))
        assertInventory(erased)
        assertOneUndo(before, erased)
    }

    @Test fun `moving a run validates the final arrangement and permits self vacated cells`() {
        val before = draft(selected = "w2")
        val levels = geometry.buildings.associate { it.id to it.level }
        val result = moveLayoutWallRun(before, geometry, listOf("w1", "w2", "w3"), 1, 0)
        assertNull(result.error)
        assertEquals(LayoutPosition("w1", 11, 14), result.draft.position("w1"))
        assertEquals(LayoutPosition("w2", 12, 14), result.draft.position("w2"))
        assertEquals(LayoutPosition("w3", 13, 14), result.draft.position("w3"))
        assertEquals(before.position("keep"), result.draft.position("keep"))
        assertEquals(before.position("cannon"), result.draft.position("cannon"))
        assertEquals(levels, geometry.buildings.associate { it.id to it.level })
        assertInventory(result.draft)
        assertOneUndo(before, result.draft)
    }

    @Test fun `move refuses a wall outside the selected run without partially moving the others`() {
        val before = draft()
        assertRefused(before, moveLayoutWallRun(before, geometry, listOf("w1", "w2"), 1, 0))
    }

    @Test fun `run moves refuse building footprints and obstacle footprints atomically`() {
        val before = draft()
        val ids = listOf("w1", "w2", "w3")
        assertRefused(before, moveLayoutWallRun(before, geometry, ids, 0, -3))
        assertRefused(before, moveLayoutWallRun(before, geometry, ids, 5, 1))
        assertRefused(before, moveLayoutWallRun(before, geometry, ids, 6, 2))
    }

    @Test fun `move refuses unknown nonwall repeated and trayed identities`() {
        val before = draft(listOf("w3"))
        for (ids in listOf(listOf("ghost"), listOf("keep"), listOf("w1", "cannon"),
                listOf("w1", "w1"), listOf("w1", "ghost"), listOf("w1", "w3"))) {
            assertRefused(before, moveLayoutWallRun(before, geometry, ids, 0, 1))
        }
    }

    @Test fun `empty and zero delta moves never dirty a draft or create undo history`() {
        val before = draft()
        assertEquals(before, moveLayoutWallRun(before, geometry, emptyList(), 1, 0).draft)
        assertEquals(before, moveLayoutWallRun(before, geometry, listOf("w1", "w2"), 0, 0).draft)
        assertFalse(before.dirty)
    }

    @Test fun `a translated run preserves spacing and tray order and undoes as one operation`() {
        val before = draft(listOf("w3"), selected = "w1")
        val result = moveLayoutWallRun(before, geometry, listOf("w2", "w1"), -2, -1)
        assertNull(result.error)
        assertEquals(LayoutPosition("w1", 8, 13), result.draft.position("w1"))
        assertEquals(LayoutPosition("w2", 9, 13), result.draft.position("w2"))
        assertEquals(before.trayIds, result.draft.trayIds)
        assertInventory(result.draft)
        assertOneUndo(before, result.draft)
    }

    @Test fun `signed plot movement accepts negative cells and refuses every half open boundary`() {
        val signed = geometry.copy(claimMin = -10, claimMax = 40, plotGeometry = PlotGeometry(2, -10, 40))
        val before = draft(listOf("w2", "w3"))
        assertNull(moveLayoutWallRun(before, signed, listOf("w1"), -20, -24).error)
        assertNull(moveLayoutWallRun(before, signed, listOf("w1"), 29, 25).error)
        for ((dx, dy) in listOf(-21 to 0, 0 to -25, 30 to 0, 0 to 26)) {
            assertRefused(before, moveLayoutWallRun(before, signed, listOf("w1"), dx, dy))
        }
    }

    @Test fun `run movement checks the full wall footprint at claim edges`() {
        val wide = geometry.copy(footprint = { if (it == "wall" || it == "keep") 2 to 2 else 1 to 1 })
        val before = draft(listOf("w2", "w3"))
        assertNull(moveLayoutWallRun(before, wide, listOf("w1"), 10, 6).error)
        assertRefused(before, moveLayoutWallRun(before, wide, listOf("w1"), 11, 6))
        assertRefused(before, moveLayoutWallRun(before, wide, listOf("w1"), 10, 7))
    }

    @Test fun `integer overflow cannot turn a huge requested move into a valid draft coordinate`() {
        val before = draft(listOf("w2", "w3"))
        for ((dx, dy) in listOf(Int.MAX_VALUE to 0, Int.MIN_VALUE to 0, 0 to Int.MAX_VALUE, 0 to Int.MIN_VALUE)) {
            assertRefused(before, moveLayoutWallRun(before, geometry, listOf("w1"), dx, dy))
        }
        // Without a PlotGeometry, Int.MAX_VALUE + footprint must still not wrap past claimMax.
        val legacy = geometry.copy(plotGeometry = null,
            footprint = { if (it == "wall" || it == "keep") 2 to 2 else 1 to 1 })
        assertRefused(before, moveLayoutWallRun(before, legacy, listOf("w1"), Int.MAX_VALUE - 11, 0))
    }

    @Test fun `many wall edits retain the existing bounded undo history`() {
        var current = draft(listOf("w2", "w3"))
        repeat(LAYOUT_UNDO_LIMIT + 5) { index ->
            val next = moveLayoutWallRun(current, geometry, listOf("w1"), if (index % 2 == 0) -1 else 1, 0)
            assertNull(next.error)
            assertOneUndo(current, next.draft)
            current = next.draft
        }
        assertEquals(LAYOUT_UNDO_LIMIT, current.history.size)
        assertInventory(current)
    }

    @Test fun `paint mode uses draft occupancy and releases live cells vacated by trayed buildings`() {
        val before = draft(listOf("w1", "cannon"))
        val moved = moveBuilding(before, geometry, "w2", 8, 8).draft
        val mode = requireNotNull(layoutWallStrokeMode("paint-1", "base", moved, geometry, LayoutWallTool.PAINT, 2))
        assertEquals("paint-1", mode.token)
        assertEquals("base", mode.baseId)
        assertTrue(WallStrokeTile(10, 14) in mode.validTiles)
        assertTrue(WallStrokeTile(11, 14) in mode.validTiles)
        assertTrue(WallStrokeTile(13, 10) in mode.validTiles)
        assertFalse(WallStrokeTile(8, 8) in mode.validTiles)
        assertFalse(WallStrokeTile(12, 14) in mode.validTiles)
        assertFalse(WallStrokeTile(10, 10) in mode.validTiles)
        assertFalse(WallStrokeTile(11, 11) in mode.validTiles)
        assertFalse(WallStrokeTile(15, 15) in mode.validTiles)
        assertFalse(WallStrokeTile(16, 16) in mode.validTiles)
    }

    @Test fun `paint mode is unavailable without an owned trayed wall of the requested level`() {
        assertNull(layoutWallStrokeMode("paint", "base", draft(), geometry, LayoutWallTool.PAINT, 2))
        val before = draft(listOf("w3", "keep"))
        assertNull(layoutWallStrokeMode("paint", "base", before, geometry, LayoutWallTool.PAINT, 2))
        assertNull(layoutWallStrokeMode("paint", "base", before, geometry, LayoutWallTool.PAINT, null))
        assertNotNull(layoutWallStrokeMode("paint", "base", before, geometry, LayoutWallTool.PAINT, 1))
    }

    @Test fun `erase and selection modes admit placed draft walls and exclude tray nonwalls and empty cells`() {
        val moved = moveBuilding(draft(listOf("w1")), geometry, "w2", 8, 8).draft
        for (tool in listOf(LayoutWallTool.ERASE, LayoutWallTool.SELECT)) {
            val mode = requireNotNull(layoutWallStrokeMode("owned", "base", moved, geometry, tool, null))
            assertTrue(WallStrokeTile(8, 8) in mode.validTiles)
            assertTrue(WallStrokeTile(12, 14) in mode.validTiles)
            for (tile in tiles(10 to 14, 11 to 14, 10 to 10, 13 to 10, 15 to 15, 9 to 9)) {
                assertFalse("$tool cannot acquire $tile", tile in mode.validTiles)
            }
        }
    }

    @Test fun `signed stroke modes retain the plot origin while clipping admission to the active claim`() {
        val signed = geometry.copy(claimMin = -8, claimMax = 20, plotGeometry = PlotGeometry(2, -10, 40))
        val mode = requireNotNull(layoutWallStrokeMode("signed", "base", draft(listOf("w1")), signed, LayoutWallTool.PAINT, 2))
        assertEquals(-10, mode.minimumTileX)
        assertEquals(-10, mode.minimumTileY)
        assertEquals(50, mode.columns)
        assertEquals(50, mode.rows)
        assertTrue(WallStrokeTile(-8, -8) in mode.validTiles)
        assertTrue(WallStrokeTile(19, 19) in mode.validTiles)
        for (tile in tiles(-9 to -8, -8 to -9, 20 to 19, 19 to 20)) assertFalse(tile in mode.validTiles)
    }

    @Test fun `paint mode checks the whole requested wall footprint against boundaries and obstacles`() {
        val wide = geometry.copy(footprint = { if (it == "wall" || it == "keep") 2 to 2 else 1 to 1 })
        val mode = requireNotNull(layoutWallStrokeMode("wide", "base", draft(listOf("w1", "w2", "w3")), wide, LayoutWallTool.PAINT, 2))
        assertEquals(2, mode.footprintWidth)
        assertEquals(2, mode.footprintHeight)
        assertTrue(WallStrokeTile(20, 20) in mode.validTiles)
        for (tile in tiles(21 to 20, 20 to 21, 14 to 14, 14 to 15, 16 to 16, 9 to 9)) {
            assertFalse("The entire footprint must fit at $tile", tile in mode.validTiles)
        }
    }
}
