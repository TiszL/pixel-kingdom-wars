package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.Assert.*

/** The floating HP bars need a display maximum for every attacker; the pack only freezes damaged-body ones.
 * The fallback must mirror web fx/stats.ts battleUnitMaxHp exactly, or a bar would deplete at the wrong rate. */
class ActorDisplayHealthTest {
    private fun json(value:String)=Json.parseToJsonElement(value).jsonObject
    private val render=json("""{"actors":[{"type":"hexbarrow","frameKey":"hex20","combatKey":"body","damagedBodyMaxHp":101}],"combatProfiles":{"body":{"damagedBody":{"healthRatio":0.5}}}}""")
    private val catalogue=json("""{"constants":{"HERO_KEYS":["vex","theodor"],"INVENTORY":{"modifierCapsBps":{"allied_troop_hp_bps":1500,"hero_hp_bps":4000}},
        "TROOPS":{"bowman":{"hp":45},"hexbarrow":{"hp":2200},"barrowling":{"hp":40},"wyrmling":{"hp":60}},
        "LEVEL_STEP_TROOP":[1,1.2,1.2,1.25],
        "HERO_LEVELING":{"maxLevel":20,"hp":{"vex":[1400,1500,1605],"theodor":[900,950]}},
        "HERO_DEFENCE":{"statPct":50}}}""")
    private val frames=mapOf("#1" to "hex20")
    private fun source(commands:String="", army:String="""{"levels":{"bowman":3},"heroLevels":{"vex":2},"heroLoadouts":{"vex":{"modifiers":{"allied_troop_hp_bps":1000,"hero_hp_bps":5000}}}}""")=json("""{
        "armySnapshot":$army,
        "snapshot":{"buildings":[],"defenderHeroes":[{"hero":"theodor","level":2,"loadout":{"modifiers":{"hero_hp_bps":-1000}}}]},
        "events":[{"e":"deploy","t":0,"id":1,"troop":"hexbarrow"},{"e":"deploy","t":0,"id":2,"troop":"bowman"},
            {"e":"deploy","t":1,"id":3,"troop":"highlander","hero":"vex"},{"e":"troopSpawn","t":2,"id":4,"troop":"barrowling","level":2},
            {"e":"spawn","t":3,"id":5,"from":"nest","troop":"wyrmling"},{"e":"deploy","t":4,"id":6,"troop":"highlander","hero":"theodor","side":"defender"},
            {"e":"deploy","t":5,"id":7,"troop":"unknown"}],
        $commands "fixture":true}""")

    @Test fun `pack maxima win and every other actor mirrors the web display formula at frozen levels`() {
        val maxima=actorDisplayMaxHp(source(""""commands":[{"kind":"hero","payload":{"hero":"vex"}}],"""),render,catalogue,frames)
        assertEquals("damagedBodyMaxHp with the army bonus, exactly as the damaged body reads it",111L,maxima[1])
        // bowman: round(45*1.2*1.2)=65, then floor(65*1.1)=71 with Vex's allied bonus.
        assertEquals(71L,maxima[2])
        // vex level 2: 1500 with hero_hp_bps clamped to the 4000 cap → floor(1500*1.4).
        assertEquals(2100L,maxima[3])
        // barrowling summon level 2: round(40*1.2)=48, no army bonus for summons.
        assertEquals(48L,maxima[4])
        // nest wyrmling: level 1 like the web, no bonus.
        assertEquals(60L,maxima[5])
        // defender theodor level 2: floor(950*50/100)=475, then his own -1000 bps → floor(475*0.9).
        assertEquals(427L,maxima[6])
        assertNull("unknown troop stats never invent a bar",maxima[7])
    }
    @Test fun `without a deployed hero no army bonus applies and a catalogue without the tables yields only pack maxima`() {
        assertEquals(65L,actorDisplayMaxHp(source(),render,catalogue,frames)[2])
        val bare=json("""{"constants":{"HERO_KEYS":["vex","theodor"],"INVENTORY":{"modifierCapsBps":{"allied_troop_hp_bps":1500}}}}""")
        assertEquals(mapOf(1 to 101L),actorDisplayMaxHp(source(),render,bare,frames))
        assertTrue(actorDisplayMaxHp(source(),json("""{"actors":[]}"""),bare,frames).isEmpty())
    }
}
