package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.test.*
import org.junit.Test

class RendererContractsTest {
    private fun event(t: Int, kind: String = "pos") = PresentationEvent(t, kind, "{\"t\":$t,\"e\":\"$kind\"}")
    private fun revision(key: String, events: List<PresentationEvent>, sequence: Long = 1) =
        PresentationRevision("raid", key, 14, sequence, 0, events)

    @Test fun `native keep bottom meets the same footprint edge as the web renderer`() {
        val keep = RenderBuilding("keep", "bld_keep_l1", 3f, 4f, 2f, 2f)
        val placement = placeBuilding(keep, 64f, 144f, 136f, 1.25f, 0.5f)
        assertEquals(384f, placement.top + placement.height)
        assertEquals(256f, placement.left + placement.width / 2)
        assertEquals(384f, placement.depth)
    }

    @Test fun `pan pinch and cancellation never select a building on release`() {
        val touch = TouchIntent(10f)
        touch.down(0f, 0f); touch.move(20f, 0f); assertFalse(touch.up(0f, 0f))
        touch.down(0f, 0f); touch.pinch(); assertFalse(touch.up(0f, 0f))
        touch.down(0f, 0f); touch.cancel(); assertFalse(touch.up(0f, 0f))
        touch.down(0f, 0f); assertTrue(touch.up(3f, 4f))
        assertFalse(touch.up(3f, 4f))
    }

    @Test fun `home placement stays bounded while battle taps reach their versioned field validator`() {
        val ground=mutableListOf<Pair<Float,Float>>();var homeSelections=0
        val onGround: (Float,Float)->Unit={ x,y -> ground+=x to y }
        dispatchSceneTap(2.25f,3.5f,8,8,false,onGround) { homeSelections++ }
        assertEquals(listOf(2.25f to 3.5f),ground,"A home tile tap must reach placement even without a building hit")
        assertEquals(1,homeSelections,"Normal home building selection still runs through its existing footprint test")
        dispatchSceneTap(4.25f,5.5f,8,8,true,onGround) { homeSelections++ }
        assertEquals(listOf(2.25f to 3.5f,4.25f to 5.5f),ground);assertEquals(1,homeSelections)
        for((x,y) in listOf(-.01f to 2f,8f to 2f,2f to 8f,Float.NaN to 2f))
            dispatchSceneTap(x,y,8,8,true,onGround) { error("Battle must not select home buildings") }
        assertEquals(5,ground.size,"Finite outer-ground touches reach the snapshot validator; invalid coordinates do not")
        dispatchSceneTap(-1f,2f,8,8,false,onGround) { homeSelections++ }
        assertEquals(5,ground.size,"Home placement never expands outside its building grid")
    }
    @Test fun `visible scenery cannot masquerade as a selectable server building`() {
        val building=RenderBuilding("mine","mine",2f,3f,2f,2f)
        val obstacle=RenderBuilding("tree","tree",5f,3f,2f,2f)
        val ids=setOf(building.id)
        assertTrue(selectableBuildingHit(building,2.5f,3.5f,ids))
        assertFalse(selectableBuildingHit(obstacle,5.5f,3.5f,ids),"Drawing an obstacle with shared geometry must not send its ID as a building selection")
        assertFalse(selectableBuildingHit(building,4f,3.5f,ids),"Existing exclusive footprint edge stays unchanged")
        assertFalse(selectableBuildingHit(building,2.5f,3.5f,emptySet()),"Removed buildings cannot remain selectable after a snapshot change")
    }
    /** E-11: web `syncRemnants` hides a stump the moment anything stands on its tiles — the server already lists
     * the tile as buildable, so the remnant must never show through a building or a standing row, and a drop
     * that awaits the server (`held`) already covers its new seat, not its old one. */
    @Test fun `a remnant hides under a building or standing obstacle and shows on free ground`() {
        val stump = RenderRemnant("pine1", 31f, 12f, 1f, 1f)
        val bigStump = RenderRemnant("tree_old", 30f, 11f, 2f, 2f)
        val bare = BaseScene(listOf(RenderBuilding("mine", "mine", 2f, 3f, 2f, 2f)), 60, 60, 64f, minimumTileX = -15, minimumTileY = -15)
        assertFalse(bare.remnantCovered(stump), "Free ground shows the stump")
        val builtOver = bare.copy(buildings = listOf(RenderBuilding("farm", "farm", 30f, 11f, 2f, 2f)))
        assertTrue(builtOver.remnantCovered(stump), "A building over the seat hides the stump")
        assertTrue(builtOver.remnantCovered(bigStump), "Any overlapping tile of a 2×2 remnant hides it")
        assertFalse(builtOver.remnantCovered(RenderRemnant("pine1", 32f, 12f, 1f, 1f)), "The footprint edge is exclusive: the next tile east stays bare")
        val row = bare.copy(obstacles = listOf(RenderObstacle("row", "dec_bush", 31f, 12f, 1f, 1f, spriteKey = "bush")))
        assertTrue(row.remnantCovered(stump), "A standing row on the seat hides the stump")
        val dropped = mapOf("mine" to CarryTile(31, 12))
        assertTrue(bare.remnantCovered(stump, dropped), "A piece dropped on the seat covers it before the server confirms")
        assertFalse(builtOver.remnantCovered(stump, mapOf("farm" to CarryTile(0, 0))), "A piece dropped elsewhere frees its old seat")
    }

    @Test fun `reconnect rebuilds past state without replaying sound effects or deployment cues`() {
        val timeline = BattleTimeline(setOf(14))
        val initial = timeline.replace(revision("a", listOf(event(0,"deploy"), event(5), event(10))), 5)!!
        assertTrue(initial.reset)
        assertEquals(listOf(0, 5), initial.stateEvents.map { it.t })
        assertTrue(initial.transientEvents.isEmpty())
        assertEquals(listOf(10), timeline.advanceTo(10).transientEvents.map { it.t })
        assertTrue(timeline.advanceTo(10).transientEvents.isEmpty())
    }

    @Test fun `accepted replacement removes stale predicted future events`() {
        val timeline = BattleTimeline(setOf(14))
        timeline.replace(revision("a", listOf(event(0), event(10,"troopDeath"))), 5, 1)
        val replacement = timeline.replace(revision("b", listOf(event(0), event(8), event(12)), 2), 5, 2)!!
        assertTrue(replacement.reset)
        assertEquals(listOf(8), timeline.advanceTo(10).stateEvents.map { it.t })
        assertNull(timeline.replace(revision("a", listOf(event(0))), 5, 1))
        assertEquals("b", timeline.revision)
    }

    @Test fun `rewinding archive rebuilds state and preserves canonical same tick ordering`() {
        val timeline = BattleTimeline(setOf(14))
        timeline.replace(revision("a", listOf(event(0,"deploy"), event(0,"hit"), event(10))), 0)
        timeline.advanceTo(10)
        val rewind = timeline.advanceTo(0)
        assertTrue(rewind.reset)
        assertEquals(listOf("deploy", "hit"), rewind.stateEvents.map { it.e })
        assertTrue(rewind.transientEvents.isEmpty())
    }

    @Test fun `protocol mismatch fails before replacing current event state`() {
        val timeline = BattleTimeline(setOf(14))
        timeline.replace(revision("a", listOf(event(0))), 0)
        assertFailsWith<IllegalArgumentException> { timeline.replace(revision("b", listOf(event(0))).copy(simVersion = 15), 0) }
        assertFailsWith<IllegalArgumentException> { timeline.replace(revision("b", listOf(event(0))).copy(replaceFromTick = 1), 0) }
        assertFailsWith<IllegalArgumentException> { timeline.replace(revision("b", listOf(event(10), event(0))), 0) }
        assertEquals("a", timeline.revision)
    }

    @Test fun `event input list cannot mutate a published revision`() {
        val events = mutableListOf(event(0), event(10))
        val timeline = BattleTimeline(setOf(14))
        timeline.replace(revision("a", events), 0)
        events.clear()
        assertEquals(1, timeline.advanceTo(10).stateEvents.size)
    }
}
