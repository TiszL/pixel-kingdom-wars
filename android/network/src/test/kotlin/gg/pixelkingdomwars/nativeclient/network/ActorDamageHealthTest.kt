package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.Assert.*

class ActorDamageHealthTest {
    private fun json(value:String)=Json.parseToJsonElement(value).jsonObject
    private val render=json("""{"actors":[{"type":"hexbarrow","frameKey":"hex20","combatKey":"body","damagedBodyMaxHp":101}],"combatProfiles":{"body":{"damagedBody":{"healthRatio":0.5}}}}""")
    private val catalogue=json("""{"constants":{"HERO_KEYS":["vex","theodor"],"INVENTORY":{"modifierCapsBps":{"allied_troop_hp_bps":1500}}}}""")
    private val frames=mapOf("#1" to "hex20","#2" to "hex20")
    private fun source(selection:String="",modifiers:String=""""vex":{"modifiers":{"allied_troop_hp_bps":1000}},"theodor":{"modifiers":{"allied_troop_hp_bps":1200}}""")=json("""{
        "armySnapshot":{"heroLoadouts":{$modifiers}},
        "events":[{"e":"deploy","t":0,"id":1,"troop":"hexbarrow"},{"e":"troopSpawn","t":1,"id":2,"troop":"barrowling"}],
        $selection "fixture":true}""")
    private fun maxima(value:JsonObject)=actorDamageMaxHp(value,render,catalogue,frames)
    @Test fun `accepted future hero orders contribute before their actor exists while summoned troops remain unmodified`() {
        val orders=""""orders":{"heroDeploys":[{"hero":"vex","t":900},{"hero":"theodor","t":950}]},"""
        assertEquals(mapOf(1 to 116L,2 to 101L),maxima(source(orders)))
        assertEquals("Available loadouts without accepted hero orders do not contribute",mapOf(1 to 101L,2 to 101L),maxima(source()))
    }
    @Test fun `live revisions use complete accepted commands and ignore absent or superseded hero selections`() {
        val commands=""""commands":[{"kind":"hero","payload":{"hero":"vex"}},{"kind":"hero","payload":{"hero":"vex"}}],"""
        assertEquals(111L,maxima(source(commands))[1])
        assertEquals(101L,maxima(source(""""commands":[],"""))[1])
        assertEquals("Archived orders take precedence over a transport command field",101L,maxima(source(""""orders":{"heroDeploys":[]},$commands"""))[1])
    }
    @Test fun `frozen order loadout wins over army fallback and negative bonuses retain floor rounding`() {
        val orders=""""orders":{"heroDeploys":[{"hero":"vex","loadout":{"modifiers":{"allied_troop_hp_bps":-1000}}}]},"""
        assertEquals(90L,maxima(source(orders))[1])
        assertEquals(116L,maxima(source(""""orders":{"heroDeploys":[{"hero":"vex"}]},""", """"vex":{"modifiers":{"allied_troop_hp_bps":99999}}"""))[1])
    }
    @Test fun `missing historical metadata stays absent and malformed frozen modifier is never replaced with a current value`() {
        assertTrue(actorDamageMaxHp(source(),json("""{"actors":[]}"""),catalogue,frames).isEmpty())
        assertThrows(IllegalArgumentException::class.java) { maxima(source(""""orders":{"heroDeploys":[{"hero":"vex"}]},""", """"vex":{"modifiers":{"allied_troop_hp_bps":1.5}}""")) }
        assertThrows(IllegalArgumentException::class.java) { maxima(source(""""orders":{"heroDeploys":[{"hero":"future"}]},""")) }
        assertThrows(IllegalArgumentException::class.java) { maxima(source(""""orders":{"heroDeploys":[{"hero":"vex","loadout":"future"}]},""")) }
        assertThrows(IllegalArgumentException::class.java) { maxima(source(""""orders":{"heroDeploys":"future"},""")) }
        assertThrows(IllegalArgumentException::class.java) { maxima(source(""""orders":{"heroDeploys":["future"]},""")) }
    }
    @Test fun `explicit null archived orders and frozen loadouts preserve historical absence`() {
        val value=json("""{"orders":null,"armySnapshot":{"heroLoadouts":null},"events":[{"e":"deploy","t":0,"id":1,"troop":"hexbarrow"}]}""")
        assertEquals(mapOf(1 to 101L),maxima(value))
    }
}
