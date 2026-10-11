package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Test
import kotlin.test.*

class HpBarsTest {
    private fun event(json: String) = PresentationEvent.fromJson(json)

    @Test fun `fill bands and geometry follow the web bar at the 64 px tile and scale with the scene tile`() {
        // Bands are strict: exactly half is gold, exactly a quarter is ember (web fillColor).
        assertEquals(HpBars.MEADOW, HpBars.fillColor(.51f)); assertEquals(HpBars.GOLD, HpBars.fillColor(.5f))
        assertEquals(HpBars.GOLD, HpBars.fillColor(.26f)); assertEquals(HpBars.EMBER, HpBars.fillColor(.25f))
        val full = HpBars.geometry(HpBars.Kind.TROOP, 100f, 50f, 1f, 64f)
        assertEquals(listOf(84f, 40f, 32f, 6f), listOf(full.fillX, full.fillY, full.fillWidth, full.fillHeight))
        assertEquals(listOf(83f, 39f, 34f, 8f), listOf(full.outlineX, full.outlineY, full.outlineWidth, full.outlineHeight))
        val building = HpBars.geometry(HpBars.Kind.BUILDING, 100f, 50f, .3f, 64f)
        assertEquals(listOf(76f, 36f, 14f, 8f), listOf(building.fillX, building.fillY, building.fillWidth, building.fillHeight))
        assertEquals(HpBars.GOLD, building.fillColor)
        // Any remaining health paints at least one authored pixel; none paints nothing.
        assertEquals(1f, HpBars.geometry(HpBars.Kind.TROOP, 0f, 0f, .001f, 64f).fillWidth)
        assertEquals(0f, HpBars.geometry(HpBars.Kind.TROOP, 0f, 0f, 0f, 64f).fillWidth)
        assertEquals(HpBars.EMBER, HpBars.geometry(HpBars.Kind.TROOP, 0f, 0f, 0f, 64f).fillColor)
        // A 128 px tile doubles every extent, lift and outline.
        val scaled = HpBars.geometry(HpBars.Kind.TROOP, 100f, 50f, 1f, 128f)
        assertEquals(listOf(68f, 30f, 64f, 12f), listOf(scaled.fillX, scaled.fillY, scaled.fillWidth, scaled.fillHeight))
        assertEquals(listOf(66f, 28f, 68f, 16f), listOf(scaled.outlineX, scaled.outlineY, scaled.outlineWidth, scaled.outlineHeight))
        assertEquals(2f, HpBars.geometry(HpBars.Kind.TROOP, 0f, 0f, .001f, 128f).fillWidth)
        assertEquals(1f, HpBars.geometry(HpBars.Kind.TROOP, 0f, 0f, 2f, 64f).fillWidth / 32f)
    }

    @Test fun `troop bars show only once damaged and never on the dead while building bars start full except walls`() {
        assertFalse(HpBars.troopVisible(100.0, 100, alive = true))
        assertTrue(HpBars.troopVisible(99.0, 100, alive = true))
        assertFalse(HpBars.troopVisible(99.0, 100, alive = false))
        assertFalse(HpBars.troopVisible(50.0, 0, alive = true))
        assertTrue(HpBars.buildingVisible(100, 100, wall = false, destroyed = false))
        assertFalse(HpBars.buildingVisible(100, 100, wall = true, destroyed = false))
        assertTrue(HpBars.buildingVisible(99, 100, wall = true, destroyed = false))
        assertFalse(HpBars.buildingVisible(50, 100, wall = false, destroyed = true))
        assertFalse(HpBars.buildingVisible(0, 100, wall = false, destroyed = false))
        assertFalse(HpBars.buildingVisible(0, 0, wall = false, destroyed = false), "Untargetable structures get no bar")
        assertEquals(.5f, HpBars.fraction(50.0, 100)); assertEquals(0f, HpBars.fraction(50.0, 0)); assertEquals(1f, HpBars.fraction(150.0, 100))
    }

    @Test fun `actor health depletes per canonical hit and chain hop, heals to the maximum and is absent without one`() {
        val model = ActorHealthVisualModel(mapOf(1 to 100L, 2 to 40L, 3 to 0L), listOf(
            event("""{"t":0,"e":"deploy","id":1,"troop":"bowman","x":1,"y":1}"""),
            event("""{"t":0,"e":"deploy","id":3,"troop":"mage","x":1,"y":1}"""),
            event("""{"t":1,"e":"troopSpawn","id":2,"from":1,"troop":"barrowling","level":1,"variant":0,"x":1,"y":1}"""),
            event("""{"t":2,"e":"hit","target":1,"dmg":30}"""),
            event("""{"t":2,"e":"hit","target":"1","dmg":30}"""),
            event("""{"t":3,"e":"chain","id":"tower","targets":[1,2,9],"dmg":[10,50,5]}"""),
            event("""{"t":4,"e":"heal","id":1,"amount":500}"""),
            event("""{"t":5,"e":"hit","target":1,"dmg":70}"""),
            event("""{"t":6,"e":"troopDeath","id":1}""")))
        assertNull(model.at(1, -1f), "Not yet deployed")
        assertEquals(ActorHealthVisualModel.Health(100.0, 100), model.at(1, 0f))
        assertEquals(ActorHealthVisualModel.Health(100.0, 100), model.at(1, 1.9f))
        assertEquals(70.0, model.at(1, 2f)!!.hp, "A string target is a building named 1, not this troop")
        assertEquals(60.0, model.at(1, 3f)!!.hp)
        assertEquals(0.0, model.at(2, 3f)!!.hp, "Chain damage clamps at zero")
        assertEquals(100.0, model.at(1, 4f)!!.hp, "Heals clamp at the display maximum")
        assertEquals(30.0, model.at(1, 5.5f)!!.hp)
        assertEquals(0.0, model.at(1, 6f)!!.hp)
        assertNull(model.at(3, 1f), "A zero maximum is no maximum")
        assertNull(model.at(9, 3f), "Chain hops on unknown actors are ignored")
        assertNull(model.at(2, 0.5f), "Summons exist only from their spawn tick")
    }
}
