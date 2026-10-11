package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Assert.*
import org.junit.Test

/** Web `BaseScene` hold-to-lift: a quick swipe over a wall must pan, a still hold must lift, and the local
 * footprint check must read the same occupancy the app supplied. */
class BuildingCarryInputTest {
    private val keep = CarryRect("keep", 14, 14, 2, 2)
    private val walls = listOf(CarryRect("w1", 10, 12, 1, 1), CarryRect("w2", 11, 12, 1, 1), CarryRect("w3", 12, 12, 1, 1))
    private val rock = CarryRect(null, 18, 18, 2, 2)
    private fun mode(line: Set<String> = emptySet(), holds: Map<String, CarryTile> = emptyMap(), epoch: Long = 0) =
        CarryMode("A", setOf("keep", "w1", "w2", "w3"), line, 8, 22, listOf(keep) + walls + rock, holds, epoch)
    private class Fixture(mode: CarryMode) {
        val events = mutableListOf<CarryEvent>(); val input = BuildingCarryInput({ events += it }) { 12f }
        init { frame(mode) }
        fun frame(next: CarryMode? = null, base: String = "A", battle: Boolean = false) = input.frame(next, base, battle)
        fun released() = events.filterIsInstance<CarryEvent.Released>()
    }

    @Test fun `a swipe that starts on a building before the hold elapses is a camera pan and never arms`() {
        val f = Fixture(mode()); f.input.down(0, "keep", 100f, 100f, 1000)
        assertTrue("Below the slop the press owns the move (no pan hitch under a thumb)", f.input.move(0, 104f, 104f, 14.5f, 14.5f, 1050))
        assertFalse("Crossing the slop at 150 ms hands the gesture to the camera", f.input.move(0, 120f, 100f, 15f, 14.5f, 1150))
        f.input.tick(1400)
        assertFalse(f.input.move(0, 200f, 100f, 16f, 14.5f, 1450))
        assertFalse("The release is the camera's, not a carry", f.input.up(0, 1500))
        assertTrue(f.events.isEmpty()); assertTrue(f.input.visual.lifted.isEmpty())
    }
    @Test fun `a press still for 200 ms arms with one cue then movement carries by whole tiles`() {
        val f = Fixture(mode()); f.input.down(0, "keep", 100f, 100f, 1000)
        f.input.tick(1199); assertTrue(f.events.isEmpty())
        f.input.tick(1200); assertEquals(listOf<CarryEvent>(CarryEvent.Armed("keep")), f.events)
        f.input.tick(1300); assertEquals("One cue per press", 1, f.events.size)
        // Rewritten 2026-10-06 (was "no highlights until the first move", the web's timing): the owner's demo asked for the
        // placement visuals at lift (buildings/SPEC.md §4), so the grid and the piece's own, valid tile show once it arms.
        assertEquals(listOf(SceneHighlightKind.GRID, SceneHighlightKind.FOOTPRINT), f.input.highlights.map { it.kind })
        assertEquals(listOf(CarryPiece("keep", 14, 14)), f.input.visual.lifted)
        // Finger at tile 17.4 centres a 2×2 footprint at round(17.4 - 1) = 16.
        assertTrue(f.input.move(0, 140f, 100f, 17.4f, 14.6f, 1300))
        assertEquals(CarryEvent.Preview("keep", 16, 14, true), f.events.last())
        val grid = f.input.highlights.first(); assertEquals(SceneHighlightKind.GRID, grid.kind); assertEquals(8f, grid.tileX); assertEquals(14f, grid.width)
        val tint = f.input.highlights.last(); assertEquals(SceneHighlightKind.FOOTPRINT, tint.kind); assertEquals(HighlightColors.VALID, tint.color); assertEquals(16f, tint.tileX)
        assertTrue(f.input.up(0, 1400))
        assertEquals(CarryEvent.Released(listOf(CarryPiece("keep", 16, 14)), true), f.events.last())
        assertEquals("The dropped tile is held until the app answers", mapOf("keep" to CarryTile(16, 14)), f.input.visual.held)
        f.frame(mode(epoch = 1)); assertTrue("The app's answer replaces the renderer's own hold", f.input.visual.held.isEmpty())
    }
    @Test fun `a movement that breaches the slop after the hold elapsed arms and carries on the same move`() {
        val f = Fixture(mode()); f.input.down(0, "w1", 100f, 100f, 1000)
        assertTrue(f.input.move(0, 130f, 100f, 12.5f, 12.5f, 1250))
        assertEquals(listOf(CarryEvent.Armed("w1"), CarryEvent.Preview("w1", 12, 12, false)), f.events)
        assertEquals("w3 already sits on 12,12", HighlightColors.BLOCKED, f.input.highlights.last().color)
    }
    @Test fun `the placement visuals show at lift`() {
        // Design buildings/SPEC.md §1.2 item 4 + §4: a long press moves the building and "uses the same visuals" as placement,
        // so the plot grid and a valid tint on the piece's own tile appear the moment it lifts, before any drag. The hold
        // stays production's HOLD_TO_LIFT_MS = 200 (web BaseScene parity); the design's 450 ms is the owner's call.
        val f = Fixture(mode()); f.input.down(0, "keep", 100f, 100f, 1000)
        f.input.tick(1000 + BuildingCarryInput.HOLD_TO_LIFT_MS - 1)
        assertTrue("Before the hold elapses the press is still a tap or a pan: nothing is drawn", f.input.highlights.isEmpty())
        f.input.tick(1000 + BuildingCarryInput.HOLD_TO_LIFT_MS)
        val (grid, tint) = f.input.highlights
        assertEquals(SceneHighlightKind.GRID, grid.kind); assertEquals(8f, grid.tileX); assertEquals(14f, grid.width)
        assertEquals(SceneHighlightKind.FOOTPRINT, tint.kind); assertEquals(14f, tint.tileX); assertEquals(14f, tint.tileY); assertEquals(2f, tint.width)
        assertEquals("Its own footprint never blocks the lifted piece", HighlightColors.VALID, tint.color)
        assertFalse("A slow tap that never moved stays a tap", f.input.up(0, 1300))
        assertTrue("and leaves nothing drawn", f.input.highlights.isEmpty())
    }
    @Test fun `an armed press released without moving is still a tap`() {
        val f = Fixture(mode()); f.input.down(0, "keep", 100f, 100f, 1000); f.input.tick(1300)
        assertFalse(f.input.up(0, 1400)); assertTrue(f.released().isEmpty())
    }
    @Test fun `every armed press ends in exactly one terminal event, so nothing the app hid on Armed stays hidden`() {
        // The app hides map chrome (army chips) on Armed and shows it again on Released / Cancelled. A slow tap arms
        // at 200 ms and lifts without moving: with no terminal event the chrome stayed hidden after the sheet closed.
        val f = Fixture(mode()); f.input.down(0, "keep", 100f, 100f, 1000); f.input.tick(1300)
        assertFalse("Still a tap: the caller opens the sheet", f.input.up(0, 1400))
        assertEquals(listOf(CarryEvent.Armed("keep"), CarryEvent.Cancelled), f.events)
        f.input.cancel(); f.input.reset(); assertEquals("The press is gone: no second terminal event", 2, f.events.size)
        // A sub-slop wobble while armed is the same slow tap.
        val g = Fixture(mode()); g.input.down(0, "keep", 100f, 100f, 1000); g.input.tick(1300)
        assertTrue(g.input.move(0, 103f, 102f, 14.5f, 14.5f, 1350)); assertFalse(g.input.up(0, 1400))
        assertEquals(listOf(CarryEvent.Armed("keep"), CarryEvent.Cancelled), g.events)
        // A quick tap never armed, so it owes no terminal event.
        val h = Fixture(mode()); h.input.down(0, "keep", 100f, 100f, 1000); assertFalse(h.input.up(0, 1100)); assertTrue(h.events.isEmpty())
    }
    @Test fun `blocked tint reads plot bounds other buildings and obstacles and ignores the carried piece itself`() {
        val m = mode()
        assertTrue(m.fits(listOf(CarryPiece("keep", 14, 14)), 2, 2))
        assertTrue(m.fits(listOf(CarryPiece("keep", 20, 20)), 2, 2))
        assertFalse("Outside the half-open claim", m.fits(listOf(CarryPiece("keep", 21, 20)), 2, 2))
        assertFalse("Over a wall", m.fits(listOf(CarryPiece("keep", 10, 11)), 2, 2))
        assertFalse("Over the boulder", m.fits(listOf(CarryPiece("keep", 17, 17)), 2, 2))
        assertTrue("The moving line vacates its own tiles", m.fits(listOf(CarryPiece("w1", 11, 12), CarryPiece("w2", 12, 12), CarryPiece("w3", 13, 12)), 1, 1))
        assertFalse("A line member over the keep", m.fits(listOf(CarryPiece("w1", 13, 14), CarryPiece("w2", 14, 14)), 1, 1))
    }
    @Test fun `a wall of the selected line carries every member by the same delta and releases one batch`() {
        val f = Fixture(mode(line = setOf("w1", "w2", "w3"))); f.input.down(0, "w2", 100f, 100f, 1000); f.input.tick(1300)
        assertTrue(f.input.move(0, 100f, 160f, 11.5f, 15.5f, 1300))
        assertEquals(listOf(CarryPiece("w2", 11, 15), CarryPiece("w1", 10, 15), CarryPiece("w3", 12, 15)), f.input.visual.lifted)
        assertEquals(3, f.input.highlights.count { it.kind == SceneHighlightKind.FOOTPRINT })
        assertTrue(f.input.up(0, 1400))
        val release = f.released().single(); assertTrue(release.valid)
        assertEquals(setOf("w1", "w2", "w3"), release.moves.mapTo(HashSet()) { it.id }); assertTrue(release.moves.all { it.ty == 15 })
    }
    @Test fun `a wall outside the selected line and a single-wall line carry alone`() {
        val f = Fixture(mode(line = setOf("w1", "w2"))); f.input.down(0, "w3", 100f, 100f, 1000); f.input.tick(1300)
        f.input.move(0, 100f, 160f, 12.5f, 15.5f, 1300); f.input.up(0, 1400)
        assertEquals(listOf(CarryPiece("w3", 12, 15)), f.released().single().moves)
        val g = Fixture(mode(line = setOf("w1"))); g.input.down(0, "w1", 100f, 100f, 1000); g.input.tick(1300)
        g.input.move(0, 100f, 160f, 10.5f, 15.5f, 1300); g.input.up(0, 1400)
        assertEquals(listOf(CarryPiece("w1", 10, 15)), g.released().single().moves)
    }
    @Test fun `a second finger a lost mode a base change and a platform cancel revert without a release`() {
        for (way in 0..4) {
            val f = Fixture(mode()); f.input.down(0, "keep", 100f, 100f, 1000); f.input.tick(1300)
            assertTrue(f.input.move(0, 140f, 100f, 17.4f, 14.6f, 1300))
            when (way) { 0 -> f.input.down(1, null, 200f, 200f, 1350); 1 -> f.frame(null); 2 -> f.frame(mode(), base = "B"); 3 -> f.input.cancel(0); else -> f.input.reset() }
            assertTrue(f.input.visual.lifted.isEmpty()); assertTrue(f.input.highlights.isEmpty())
            assertEquals(CarryEvent.Cancelled, f.events.last())
            f.input.up(0, 1500); assertTrue("way $way", f.released().isEmpty())
        }
    }
    @Test fun `while a finger stays down after a pinch nothing arms until every contact lifts`() {
        val f = Fixture(mode()); f.input.down(0, "keep", 100f, 100f, 1000); f.input.down(1, null, 200f, 200f, 1010)
        f.input.up(1, 1100); f.input.tick(1400); assertTrue(f.events.isEmpty())
        f.input.up(0, 1500)
        f.input.down(0, "keep", 100f, 100f, 2000); f.input.tick(2200); assertEquals(CarryEvent.Armed("keep"), f.events.single())
    }
    @Test fun `a refresh mid-carry keeps the carry and only re-reads occupancy`() {
        val f = Fixture(mode()); f.input.down(0, "keep", 100f, 100f, 1000); f.input.tick(1300)
        f.input.move(0, 140f, 100f, 17.4f, 14.6f, 1300)
        f.frame(mode().copy(occupied = listOf(keep, CarryRect("new", 16, 14, 1, 1))))
        assertEquals(listOf(CarryPiece("keep", 16, 14)), f.input.visual.lifted)
        assertEquals(HighlightColors.BLOCKED, f.input.highlights.last().color)
        f.frame(mode().copy(movableIds = setOf("w1")))
        assertTrue("The carried building is no longer movable", f.input.visual.lifted.isEmpty())
    }
    @Test fun `the app's holds seat pieces and a battle scene admits no mode`() {
        val f = Fixture(mode(holds = mapOf("keep" to CarryTile(16, 14))))
        assertEquals(mapOf("keep" to CarryTile(16, 14)), f.input.visual.held)
        f.frame(mode(), battle = true); f.input.down(0, "keep", 100f, 100f, 1000); f.input.tick(1300)
        assertTrue(f.events.isEmpty()); assertTrue(f.input.movableIds.isEmpty())
    }
}
