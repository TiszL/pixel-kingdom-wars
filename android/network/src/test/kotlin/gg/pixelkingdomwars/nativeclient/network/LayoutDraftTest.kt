package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The draft is the client twin of `layouts.ts validateTarget`: claim, overlap and obstacle rules refuse
 * a move before it is ever sent; every edit is reversible; a repair never guesses positions. */
class LayoutDraftTest {
    private val keep = Building("keep", "keep", 1, 10, 10)
    private val cannon = Building("cannon", "cannon", 1, 13, 10)
    private val w1 = Building("w1", "wall", 2, 10, 14); private val w2 = Building("w2", "wall", 2, 11, 14); private val w3 = Building("w3", "wall", 1, 12, 14)
    private val buildings = listOf(keep, cannon, w1, w2, w3)
    private val geometry = LayoutGeometry(1, 8, 22, buildings, listOf(Obstacle("rock", "boulder", 15, 15)),
        footprint = { type -> if (type == "keep") 2 to 2 else 1 to 1 }, obstacleSize = { if (it == "boulder") 2 else 1 })
    private fun slot(compatibility: String, positions: List<LayoutPosition> = emptyList()) = LayoutSlot("HOME", false, "sha256:x", positions, compatibility)

    @Test fun `signed layout keeps obstacle and entire footprint exclusion through all plot edges`() {
        val signed=geometry.copy(claimMin=-10,claimMax=40,obstacles=listOf(Obstacle("negative-rock","boulder",-8,-8)),plotGeometry=PlotGeometry.supported(2))
        val draft=createDraft(buildings,slot("empty"))
        assertNull(moveBuilding(draft,signed,"keep",-10,-10).error)
        assertNull(moveBuilding(draft,signed,"keep",38,38).error)
        assertEquals("OUTSIDE THE ACTIVE CLAIM",moveBuilding(draft,signed,"keep",39,38).error)
        assertEquals("OUTSIDE THE ACTIVE CLAIM",moveBuilding(draft,signed,"keep",-11,-10).error)
        assertEquals("AN OBSTACLE BLOCKS THOSE TILES",moveBuilding(draft,signed,"keep",-8,-8).error)
        val moved=moveBuilding(draft,signed,"keep",-10,-10).draft
        assertEquals(draft.positions,undoDraft(moved).positions)
    }
    @Test fun `a ready slot seeds the draft and anything else starts clean from the live base`() {
        val saved = listOf(LayoutPosition("keep", 12, 12), LayoutPosition("cannon", 9, 9), LayoutPosition("w1", 10, 14), LayoutPosition("w2", 11, 14), LayoutPosition("w3", 12, 14))
        val ready = createDraft(buildings, slot("ready", saved))
        assertEquals(canonicalPositions(saved), ready.positions); assertFalse(ready.dirty)
        val repair = createDraft(buildings, slot("needs_repair", saved.take(2)))
        assertEquals("Live positions, never the malformed copy", 10, repair.position("keep")!!.tx); assertTrue(repair.dirty)
        assertTrue(createDraft(buildings, slot("empty")).dirty)
    }
    @Test fun `moves are refused outside the claim, over another building or over an obstacle`() {
        val draft = createDraft(buildings, slot("empty"))
        assertEquals("OUTSIDE THE ACTIVE CLAIM", moveBuilding(draft, geometry, "keep", 21, 21).error)
        assertEquals("ANOTHER BUILDING OCCUPIES THOSE TILES", moveBuilding(draft, geometry, "cannon", 11, 11).error)
        assertEquals("AN OBSTACLE BLOCKS THOSE TILES", moveBuilding(draft, geometry, "cannon", 16, 16).error)
        assertEquals("BUILDING NO LONGER EXISTS", moveBuilding(draft, geometry, "ghost", 9, 9).error)
        val moved = moveBuilding(draft, geometry, "cannon", 9, 9)
        assertNull(moved.error); assertEquals(9, moved.draft.position("cannon")!!.tx); assertEquals("cannon", moved.draft.selectedId); assertTrue(moved.draft.dirty)
        assertEquals("A no-op move commits nothing", moved.draft, moveBuilding(moved.draft, geometry, "cannon", 9, 9).draft)
    }
    @Test fun `nudge needs a placed selection and tray round-trips keep identities`() {
        val draft = createDraft(buildings, slot("empty"))
        assertEquals("SELECT A BUILDING FIRST", nudgeSelected(draft, geometry, 1, 0).error)
        val trayed = moveToTray(draft, buildings, "cannon").draft
        assertTrue(trayed.inTray("cannon")); assertNull(trayed.position("cannon")); assertEquals("cannon", trayed.selectedId)
        assertEquals("PLACE THIS BUILDING FROM THE TRAY FIRST", nudgeSelected(trayed, geometry, 1, 0).error)
        assertEquals("Already trayed is a harmless no-op", trayed, moveToTray(trayed, buildings, "cannon").draft)
        val placed = moveBuilding(trayed, geometry, "cannon", 9, 9).draft
        assertFalse(placed.inTray("cannon")); assertEquals(9, placed.position("cannon")!!.ty)
        val nudged = nudgeSelected(placed, geometry, 0, 1).draft
        assertEquals(10, nudged.position("cannon")!!.ty)
        val all = pickUpAll(nudged, buildings)
        assertTrue(all.positions.isEmpty()); assertEquals(buildings.map { it.id }, all.trayIds); assertNull(all.selectedId)
        assertEquals("LAYOUT MUST PLACE EVERY BUILDING", validateCompleteLayout(geometry, all.positions))
        assertNull(validateCompleteLayout(geometry, nudged.positions))
    }
    @Test fun `wall paint consumes trayed walls of one level in tray order and skips invalid tiles`() {
        val all = pickUpAll(createDraft(buildings, slot("empty")), buildings)
        assertEquals("PUT LEVEL 3 WALLS IN THE TRAY BEFORE PAINTING", paintWalls(all, geometry, 3, listOf(9 to 9)).error)
        assertEquals("NO FREE WALL TILES IN THAT STROKE", paintWalls(all, geometry, 2, listOf(15 to 15, 30 to 30)).error)
        val painted = paintWalls(all, geometry, 2, listOf(9 to 9, 9 to 9, 16 to 16, 9 to 10, 9 to 11)).draft
        assertEquals(listOf(LayoutPosition("w1", 9, 9), LayoutPosition("w2", 9, 10)), painted.positions.sortedBy { it.buildingId })
        assertEquals("Only the two level-2 walls were consumed", listOf("keep", "cannon", "w3"), painted.trayIds); assertEquals("w2", painted.selectedId)
    }
    @Test fun `undo restores the previous snapshot within the forty-step limit`() {
        var draft = createDraft(buildings, slot("ready", buildings.map { LayoutPosition(it.id, it.tx, it.ty) }))
        assertEquals("Nothing to undo", draft, undoDraft(draft))
        for (i in 1..LAYOUT_UNDO_LIMIT + 5) draft = nudgeSelected(selectBuilding(draft, "cannon"), geometry, if (i % 2 == 0) 1 else -1, 0).draft
        assertEquals(LAYOUT_UNDO_LIMIT, draft.history.size)
        val undone = undoDraft(draft)
        assertEquals(LAYOUT_UNDO_LIMIT - 1, undone.history.size); assertTrue(undone.dirty); assertNotEquals(draft.positions, undone.positions)
        val replaced = replaceDraftPositions(undone, buildings.map { LayoutPosition(it.id, it.tx, it.ty) })
        assertNull(replaced.selectedId); assertTrue(replaced.trayIds.isEmpty())
    }
    @Test fun `applying the draft to the base moves buildings withholds trayed ones and suppresses jobs`() {
        val base = Json.parseToJsonElement("""{"baseId":"b","buildings":[{"id":"keep","type":"keep","level":1,"tx":10,"ty":10},{"id":"cannon","type":"cannon","level":1,"tx":13,"ty":10}],
            "jobs":[{"id":"j","kind":"upgrade","buildingId":"cannon"}],"obstacles":[{"id":"o","spriteKey":"bush","tx":3,"ty":3}]}""").jsonObject
        val draft = moveToTray(moveBuilding(createDraft(buildings.take(2), slot("empty")), geometry, "cannon", 9, 9).draft, buildings, "keep").draft
        val applied = draft.applyToBase(base)
        val rows = applied.objects("buildings")
        assertEquals(listOf("cannon"), rows.map { it.string("id") }); assertEquals("9", rows.single().string("tx"))
        assertTrue(applied.objects("jobs").isEmpty()); assertEquals("b", applied.string("baseId")); assertEquals(1, applied.objects("obstacles").size)
    }
}
