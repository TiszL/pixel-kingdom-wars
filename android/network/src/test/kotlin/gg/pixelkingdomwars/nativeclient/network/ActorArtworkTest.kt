package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ActorArtworkTest {
    private fun obj(value:String)=Json.parseToJsonElement(value).jsonObject
    @Test fun `flat scout reports have no actors and need no battle snapshot`() {
        assertTrue(actorArtwork(obj("""{"buildings":[],"claimMin":8,"claimMax":22}"""), obj("{}")).isEmpty())
        assertTrue(actorArtwork(obj("""{"events":[{"e":"end","t":0}]}"""), obj("{}")).isEmpty())
    }
    @Test fun `pending artwork exists before any events and retains attacker research and own hero skin`() {
        val source=obj("""{"armySnapshot":{"counts":{"giant":2,"archer":0},"levels":{"giant":7},"heroLevels":{"theodor":9}},"snapshot":{"defenderHeroes":[{"hero":"theodor","level":2}]},"events":[]}""")
        val art=obj("""{"actors":[{"type":"giant","level":1,"frameKey":"wrong"},{"type":"giant","level":7,"frameKey":"giant7"},{"type":"theodor","level":1,"frameKey":"own-hero"}]}""")
        assertEquals(mapOf("giant" to "giant7","theodor" to "own-hero"),deploymentArtwork(source,art))
        assertTrue(deploymentArtwork(obj("{}"),art).isEmpty())
        assertThrows(IllegalStateException::class.java) {deploymentArtwork(source,obj("""{"actors":[]}"""))}
    }
    @Test fun `nest hatchlings use defender building level despite attacker research`() {
        val replay=obj("""{"armySnapshot":{"levels":{"wyrmling":9}},"snapshot":{"buildings":[{"id":"nest","level":3}]},"events":[{"e":"spawn","id":7,"from":"nest","troop":"wyrmling"}]}""")
        val art=obj("""{"actors":[{"type":"wyrmling","level":9,"frameKey":"wrong-attacker"},{"type":"wyrmling","level":3,"frameKey":"defender"}]}""")
        assertEquals("defender",actorArtwork(replay,art)["#7"])
    }
    @Test fun `summons retain explicit inherited level and authored variant`() {
        val replay=obj("""{"snapshot":{"buildings":[]},"events":[{"e":"troopSpawn","id":8,"troop":"barrowling","level":5,"variant":2}]}""")
        val art=obj("""{"actors":[{"type":"barrowling","level":5,"variant":0,"frameKey":"wrong-variant"},{"type":"barrowling","level":5,"variant":2,"frameKey":"summon"}]}""")
        assertEquals("summon",actorArtwork(replay,art)["#8"])
    }
    @Test fun `same hero on each side receives the corresponding frozen tier`() {
        val replay=obj("""{"armySnapshot":{"heroLevels":{"vex":8}},"snapshot":{"buildings":[],"defenderHeroes":[{"hero":"vex","level":2}]},"events":[{"e":"deploy","id":1,"troop":"plunderer","hero":"vex"},{"e":"deploy","id":2,"troop":"plunderer","hero":"vex","side":"defender"}]}""")
        val art=obj("""{"actors":[{"type":"vex","level":8,"frameKey":"attacker"},{"type":"vex","level":2,"frameKey":"defender"}]}""")
        assertEquals(mapOf("#1" to "attacker","#2" to "defender"),actorArtwork(replay,art))
    }
    @Test fun `high level attacking and defending heroes use the single authored skin`() {
        val replay=obj("""{"armySnapshot":{"heroLevels":{"vex":20}},"snapshot":{"buildings":[],"defenderHeroes":[{"hero":"vex","level":19}]},"events":[{"e":"deploy","id":1,"troop":"plunderer","hero":"vex"},{"e":"deploy","id":2,"troop":"plunderer","hero":"vex","side":"defender"}]}""")
        val art=obj("""{"actors":[{"type":"vex","level":1,"frameKey":"vex-authored"}]}""")
        assertEquals(mapOf("#1" to "vex-authored","#2" to "vex-authored"),actorArtwork(replay,art))
    }
    @Test fun `single hero skin fallback cannot substitute another variant or an ambiguous tier`() {
        val replay=obj("""{"armySnapshot":{"heroLevels":{"vex":20}},"snapshot":{},"events":[{"e":"deploy","id":1,"troop":"plunderer","hero":"vex","variant":2}]}""")
        val exactVariant=obj("""{"actors":[{"type":"vex","level":1,"variant":2,"frameKey":"variant2"}]}""")
        assertEquals(mapOf("#1" to "variant2"),actorArtwork(replay,exactVariant))
        val otherVariant=obj("""{"actors":[{"type":"vex","level":1,"frameKey":"variant0"}]}""")
        assertThrows(IllegalStateException::class.java) { actorArtwork(replay,otherVariant) }
        val ambiguous=obj("""{"actors":[{"type":"vex","level":1,"variant":2,"frameKey":"base"},{"type":"vex","level":8,"variant":2,"frameKey":"tier8"}]}""")
        assertThrows(IllegalStateException::class.java) { actorArtwork(replay,ambiguous) }
    }
    @Test fun `missing art fails visibly instead of using a different tier`() {
        val replay=obj("""{"snapshot":{"buildings":[]},"events":[{"e":"troopSpawn","id":8,"troop":"barrowling","level":5,"variant":2}]}""")
        assertThrows(IllegalStateException::class.java) { actorArtwork(replay,obj("""{"actors":[]}""")) }
    }
}
