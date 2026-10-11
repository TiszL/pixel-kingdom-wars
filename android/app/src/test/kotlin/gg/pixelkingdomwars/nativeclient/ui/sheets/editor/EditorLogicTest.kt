package gg.pixelkingdomwars.nativeclient.ui.sheets.editor

import gg.pixelkingdomwars.nativeclient.ui.kit.GLYPH_CELLS
import gg.pixelkingdomwars.nativeclient.ui.kit.KIT_GLYPHS
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The layout editor's rules (DESIGN-SYSTEM §6 "Layout editor", design correction 6, owner addenda 2-3). Why they matter:
 * the editor moves walls the player owns and saves a layout the server enforces in raids. A SAVE that fires with an
 * unconfirmed run is refused by the server, a second SAVE after a lost answer can race the first, a tooltip that shows a
 * made-up 0 or a "blocked" count the client cannot know misleads, and a tool strip wider than a 360 dp phone hides SAVE.
 */
class EditorLogicTest {

    @Test fun `the wall count never invents a zero`() {
        assertEquals("34 walls · 6 stored", wallCountLine(34, 6))
        assertEquals("1 wall · 0 stored", wallCountLine(1, 0))
        assertEquals("unknown counts read as the ellipsis", "… walls · … stored", wallCountLine(null, null))
        assertEquals("a negative count is a mapper bug, shown as unknown", "… walls · 2 stored", wallCountLine(-1, 2))
    }

    @Test fun `save sends only real changes with no pending run and nothing in flight`() {
        val ok = saveLook(2, canSave = true, strokePending = false, save = EditorSaveState.IDLE)
        assertTrue(ok.sends); assertEquals(CommandState.ENABLED, ok.state); assertEquals("2 changes", ok.sub)
        assertEquals("1 change", saveLook(1, true, false, EditorSaveState.IDLE).sub)
        assertFalse("nothing changed", saveLook(0, true, false, EditorSaveState.IDLE).sends)
        val pending = saveLook(3, true, strokePending = true, save = EditorSaveState.IDLE)
        assertFalse("the data lane's save rejects a pending wall proposal", pending.sends)
        assertEquals(CommandState.DISABLED, pending.state)
        val blocked = saveLook(3, canSave = false, strokePending = false, save = EditorSaveState.IDLE, blockedReason = "Place the Keep first")
        assertFalse(blocked.sends); assertEquals("an off SAVE says why", "Place the Keep first", blocked.spoken)
    }

    @Test fun `a lost save answer is being checked and can never be sent again`() {
        val checking = saveLook(2, true, false, EditorSaveState.CHECKING)
        assertFalse(checking.sends)
        assertEquals(CommandState.BUSY, checking.state)
        assertTrue("uncertain copy, never 'nothing was saved'", checking.spoken.contains("Checking"))
        assertFalse(saveLook(2, true, false, EditorSaveState.SAVING).sends)
    }

    @Test fun `the tooltip shows walls to place and walls left, never a blocked count`() {
        val paint = strokeTooltip(EditorTool.WALLS, count = 7, requested = 7, wallsLeft = 13)!!
        assertEquals("7 TO PLACE", paint.headline); assertEquals("13 walls left", paint.detail); assertFalse(paint.out)
        assertEquals("1 wall left", strokeTooltip(EditorTool.WALLS, 1, 1, 1)!!.detail)
        assertEquals("unknown stock is the ellipsis", "… walls left", strokeTooltip(EditorTool.WALLS, 3, 3, null)!!.detail)
        assertFalse("correction 6: no blocked figure", paint.detail.contains("blocked", ignoreCase = true))
    }

    @Test fun `running out of owned walls turns red and points at BUILD, never at a purchase`() {
        val out = strokeTooltip(EditorTool.WALLS, count = 4, requested = 9, wallsLeft = 0)!!
        assertTrue(out.out)
        assertEquals("4 TO PLACE", out.headline)
        assertEquals("0 left · BUILD more", out.detail)
        assertTrue("an exact fit is still out of walls", strokeTooltip(EditorTool.WALLS, 4, 4, 0)!!.out)
    }

    @Test fun `erase returns walls to storage and selection has no tooltip`() {
        val erase = strokeTooltip(EditorTool.ERASE, 5, 6, null)!!
        assertEquals("5 TO REMOVE", erase.headline); assertEquals("back to storage", erase.detail)
        assertNull(strokeTooltip(EditorTool.MOVE, 3, 3, null))
        assertNull(strokeTooltip(null, 3, 3, null))
    }

    @Test fun `a picked run keeps MOVE lit after the data lane drops the select tool`() {
        assertEquals(EditorTool.MOVE, activeTool(null, selectedRunCount = 4))
        assertNull(activeTool(null, 0))
        assertEquals(EditorTool.ERASE, activeTool(EditorTool.ERASE, 0))
    }

    @Test fun `the hint follows what the finger will do`() {
        assertEquals("Drag across tiles to paint walls you own", editorHint(EditorTool.WALLS, 0, false))
        assertEquals("Keep this run or drop it", editorHint(EditorTool.WALLS, 0, strokePending = true))
        assertEquals("Tap a tile to move the run", editorHint(null, 5, false))
        assertTrue(editorHint(null, 0, false).contains("look around"))
    }

    @Test fun `undo is offered for a confirmed step or a pending run, not while saving`() {
        assertTrue(undoEnabled(2, false, EditorSaveState.IDLE))
        assertTrue("undo drops a pending run", undoEnabled(0, true, EditorSaveState.IDLE))
        assertFalse(undoEnabled(0, false, EditorSaveState.IDLE))
        assertFalse(undoEnabled(2, false, EditorSaveState.SAVING))
    }

    @Test fun `the tooltip floats above the finger and stays on screen`() {
        // 412 dp phone at 1 px/dp: finger at (354, 566), plate 212 × 64, 40 above.
        val (x, y) = tooltipTopLeft(354f, 566f, 212f, 64f, 40f, 8f, 404f, 120f, 800f)
        assertEquals("clamped to the right margin", 404f - 212f, x, 0.01f)
        assertEquals(566f - 40f - 64f, y, 0.01f)
        val (_, below) = tooltipTopLeft(200f, 130f, 212f, 64f, 40f, 8f, 404f, 120f, 800f)
        assertEquals("no room above: it goes below the finger", 170f, below, 0.01f)
        val (left, _) = tooltipTopLeft(10f, 500f, 212f, 64f, 40f, 8f, 404f, 120f, 800f)
        assertEquals(8f, left, 0.01f)
    }

    @Test fun `the tool strip fits the design phone and a 360 dp phone with 48 dp targets`() {
        assertEquals(ToolStripWidths(62f, 126f), toolStripWidths(412f))
        val narrow = toolStripWidths(360f)
        assertTrue(narrow.cell >= 56f)
        assertTrue(narrow.save >= 104f)
        assertTrue("everything fits", 4f + 4 * narrow.cell + 12f + 6f + narrow.save + 8f <= 360f + 0.01f)
        assertTrue("never under the minimum target", toolStripWidths(300f).cell >= 48f)
    }

    @Test fun `glyph rotation turns the up arrow into the other three nudges`() {
        val up = KIT_GLYPHS.getValue("up")
        assertEquals(up, rotateGlyph(up, 0))
        assertEquals(up, rotateGlyph(up, 4))
        assertEquals("clockwise: the arrow's tip moves from the top row to the right column", '#', rotateGlyph(up, 1)[5][11])
        assertEquals(rotateGlyph(up, 3), rotateGlyph(up, -1))
        assertEquals(up, rotateGlyph(rotateGlyph(up, 2), 2))
    }

    @Test fun `every editor glyph fits the kit's 12 x 12 grid and letters`() {
        EDITOR_GLYPHS.forEach { (name, rows) ->
            assertEquals(name, GLYPH_CELLS, rows.size)
            rows.forEach { row ->
                assertEquals(name, GLYPH_CELLS, row.length)
                assertTrue(name, row.all { it in "#hx." })
            }
        }
    }

    @Test fun `the nudge pad covers four directions with spoken labels`() {
        assertEquals(setOf(-1 to 0, 0 to -1, 0 to 1, 1 to 0), NUDGE_STEPS.map { it.first to it.second }.toSet())
        assertEquals("Move the run left one tile", nudgeDescription(-1, 0))
        assertEquals("Move the run down one tile", nudgeDescription(0, 1))
    }
}
