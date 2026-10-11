package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.ui.layout.layoutGrid
import org.junit.Assert.*
import org.junit.Test

class LayoutGridTest {
    private val buildings = listOf(Building("keep", "keep", 1, 1, 1), Building("wall", "wall", 1, 3, 1))
    private val geometry = LayoutGeometry(1, 0, 6, buildings, listOf(Obstacle("rock", "boulder", 4, 4)),
        { if (it == "keep") 2 to 2 else 1 to 1 }, { 2 }, PlotGeometry(1, 0, 6))
    private val draft = LayoutDraft(buildings.map { LayoutPosition(it.id, it.tx, it.ty) }, emptyList(), null)
    private fun cells(draft: LayoutDraft = this.draft, shape: LayoutGeometry = geometry) =
        layoutGrid(shape, draft).filter { it.kind == SceneHighlightKind.FILL }.associateBy { it.tileX.toInt() to it.tileY.toInt() }

    @Test fun `all footprint cells walls and real obstacles stay occupied including selected building`() {
        val cells = cells(draft.copy(selectedId = "keep"))
        val occupied = setOf(1 to 1, 2 to 1, 1 to 2, 2 to 2, 3 to 1, 4 to 4, 5 to 4, 4 to 5, 5 to 5)
        assertEquals(36, cells.size)
        for ((tile, cell) in cells) {
            assertEquals(tile.toString(), if (tile in occupied) HighlightColors.BLOCKED else HighlightColors.VALID, cell.color)
            assertEquals(if (tile in occupied) .30f else .09f, cell.alpha)
        }
        val grid = layoutGrid(geometry, draft).last()
        assertEquals(SceneHighlightKind.GRID_OVERLAY, grid.kind)
        assertEquals(0xFFFFFF, grid.color); assertEquals(.10f, grid.alpha)
    }

    @Test fun `move tray and undo show draft coordinates without changing the live base`() {
        val moved = moveBuilding(draft, geometry, "wall", 3, 3).draft
        assertEquals(HighlightColors.VALID, cells(moved).getValue(3 to 1).color)
        assertEquals(HighlightColors.BLOCKED, cells(moved).getValue(3 to 3).color)
        val trayed = moveToTray(moved, buildings, "keep").draft
        assertEquals(HighlightColors.VALID, cells(trayed).getValue(2 to 2).color)
        assertEquals(cells(moved), cells(undoDraft(trayed)))
        assertEquals(cells(), cells(undoDraft(moved)))
        assertEquals(1, buildings.first().tx)
    }

    @Test fun `tray and missing draft positions override stale live footprints`() {
        val staleTray = draft.copy(trayIds = listOf("wall"))
        assertEquals(HighlightColors.VALID, cells(staleTray).getValue(3 to 1).color)
        assertEquals(HighlightColors.VALID, cells(draft.copy(positions = emptyList())).getValue(1 to 1).color)
        assertEquals(HighlightColors.BLOCKED, cells(draft.copy(positions = emptyList())).getValue(5 to 5).color)
    }

    @Test fun `claim extent and expanded negative tiles are respected without expanding obstacle rectangles`() {
        val shape = geometry.copy(claimMin = -10, claimMax = 40, plotGeometry = PlotGeometry(2, -10, 40))
        val expanded = cells(shape = shape)
        assertEquals(2500, expanded.size); assertTrue(-10 to -10 in expanded); assertTrue(39 to 39 in expanded)
        assertFalse(-11 to 0 in expanded); assertFalse(40 to 0 in expanded)
        val clipped = cells(shape = geometry.copy(claimMin = 5, claimMax = 6))
        assertEquals(setOf(5 to 5), clipped.keys); assertEquals(HighlightColors.BLOCKED, clipped.values.single().color)
        assertTrue(layoutGrid(geometry.copy(claimMin = 6, claimMax = 6), draft).isEmpty())
    }

    @Test fun `occupancy agrees with placement refusal for a one tile probe across the whole claim`() {
        val probe = Building("probe", "wall", 1, 0, 0)
        val probeGeometry = geometry.copy(buildings = buildings + probe)
        for ((tile, cell) in cells()) assertEquals("A free cell must be a legal wall target: $tile",
            validatePlacement(probeGeometry, draft.positions, "probe", tile.first, tile.second) == null,
            cell.color == HighlightColors.VALID)
    }
}
