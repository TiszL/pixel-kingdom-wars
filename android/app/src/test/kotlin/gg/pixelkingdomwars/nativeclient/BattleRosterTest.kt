package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.network.LiveBattleState
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BattleRosterTest {
    private fun read(value:String)=BattleRoster.read(Json.parseToJsonElement(value))

    @Test fun `empty army types do not bury the troops reserved for this march`() {
        assertEquals(listOf("highlander","tunneler"),read("""{"counts":{"footman":0,"highlander":2,"tunneler":1}}""").troops)
    }

    @Test fun `depleted troop stays in roster while accepted orders disable its deployment`() {
        val army=Json.parseToJsonElement("""{"counts":{"highlander":1,"footman":0},"heroes":[]}""")
        val state=LiveBattleState(presentation=buildJsonObject { put("armySnapshot",army) },commands=listOf(
            Json.parseToJsonElement("""{"kind":"deploy","payload":{"troop":"highlander"}}""").jsonObject))
        assertEquals(0,state.available("highlander"))
        assertEquals(listOf("highlander"),BattleRoster.read(state.presentation?.get("armySnapshot")).troops)
    }

    @Test fun `hero levels never grant a reservation including empty and absent hero arrays`() {
        assertTrue(read("""{"heroLevels":{"vex":1,"theodor":1},"heroes":[]}""").heroes.isEmpty())
        assertTrue(read("""{"heroLevels":{"vex":1}}""").heroes.isEmpty())
        assertEquals(listOf("theodor"),read("""{"heroLevels":{"vex":1},"heroes":["theodor","theodor"]}""").heroes)
    }

    @Test fun `unknown or malformed shapes do not manufacture deployment controls`() {
        for(value in listOf("null","[]","true","{}","""{"counts":[],"heroes":{"vex":true}}""")) {
            assertEquals(BattleRoster(emptyList(),emptyList()),read(value))
        }
        assertEquals(BattleRoster(listOf("highlander"),listOf("theodor")),read("""{
            "counts":{"negative":-1,"fraction":1.5,"text":"2","overflow":999999999999,"null":null,"bool":true,"obj":{},"highlander":1},
            "heroes":[null,true,3,{},[],"","theodor"],"futureField":{"ignored":true}}
        """))
    }

    @Test fun `a selection from an older roster is not authorized by the next snapshot`() {
        val old=read("""{"counts":{"highlander":1},"heroes":["theodor"]}""")
        val next=read("""{"counts":{"highlander":0,"tunneler":2},"heroes":[],"heroLevels":{"theodor":1}}""")
        assertTrue(old.contains("deploy" to "highlander"))
        assertTrue(old.contains("hero" to "theodor"))
        assertFalse(next.contains("deploy" to "highlander"))
        assertFalse(next.contains("hero" to "theodor"))
        assertFalse(next.contains("unknown" to "tunneler"))
    }
}
