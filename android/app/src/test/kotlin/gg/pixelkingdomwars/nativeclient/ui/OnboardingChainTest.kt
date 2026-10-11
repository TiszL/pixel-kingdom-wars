package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.baseJson
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Quest
import gg.pixelkingdomwars.nativeclient.ui.kingdom.StepDestination
import gg.pixelkingdomwars.nativeclient.ui.kingdom.onboardingAction
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

/** The first-run chain maps a server step to one destination in the shell (web `onboardingChain.ts`); it never invents a step. */
class OnboardingChainTest {
    private fun step(code: String) = Quest(questId = "q", templateCode = code, target = "1", progress = "0")
    private val now = 1_789_120_800_000L
    private fun base(buildings: String = """[{"id":"k","type":"keep","level":1,"tx":14,"ty":14,"underConstruction":false}]""", jobs: String = "[]", freeBuilders: Int = 1, armyStatus: String? = null,
                     army: String = "[]", heroes: String? = null): BaseSnapshot {
        val raw = json(baseJson(jobs = jobs).toString().replace("\"freeBuilders\":1", "\"freeBuilders\":$freeBuilders"))
        val parse = { text: String -> kotlinx.serialization.json.Json.parseToJsonElement(text) }
        val withBuildings = JsonObject(raw + ("buildings" to parse(buildings)) + ("army" to parse(army)) + listOfNotNull(heroes?.let { "heroes" to parse(it) }))
        return BaseSnapshot.from(if (armyStatus == null) withBuildings else JsonObject(withBuildings + ("armyStatus" to parse(armyStatus))))
    }

    @Test fun `structure steps build, then finish their own job for free, then check`() {
        assertEquals(StepDestination.Build, onboardingAction(step("first_camp"), base(), false, now)!!.go)
        val job = """[{"id":"j1","kind":"build","buildingId":"c","finishesAt":"2026-09-11T10:05:00.000Z","finishCostKeep":"0"}]"""
        val building = """[{"id":"c","type":"camp","level":1,"tx":1,"ty":1,"underConstruction":true}]"""
        val finish = onboardingAction(step("first_camp"), base(building, job), false, now)!!
        assertEquals("FINISH", finish.verb); assertEquals(StepDestination.FinishJob("j1", true, "c"), finish.go)
        val paid = onboardingAction(step("first_camp"), base(building, job.replace("\"0\"", "\"4\"")), false, now)!!
        assertEquals(StepDestination.FinishJob("j1", false, "c"), paid.go); assertTrue(paid.hint.contains("finish cost"))
        assertEquals("CHECK", onboardingAction(step("first_camp"), base(building, job), false, now + 10 * 60_000)!!.verb)
        assertEquals(StepDestination.Check, onboardingAction(step("first_camp"), base(building.replace("true", "false")), false, now)!!.go)
        val busy = onboardingAction(step("first_mine"), base(jobs = """[{"id":"j2","kind":"upgrade","buildingId":"k","finishesAt":"2026-09-11T10:05:00.000Z"}]""", freeBuilders = 0), false, now)!!
        assertEquals("VIEW", busy.verb); assertEquals(StepDestination.ViewJob("k"), busy.go)
    }
    @Test fun `land, troops and raid steps route to the gate, the army and the campaign`() {
        val land = onboardingAction(step("first_land"), base(), false, now)!!
        assertEquals(StepDestination.BuyLand, land.go); assertEquals("BUY", land.verb)
        assertEquals("Hint copy is the web's, verbatim (ui/onboardingChain.ts first_land)", "Your own spot on the pixel Earth — it unlocks PvP, KEEP and trading.", land.hint)
        assertEquals("CHECK", onboardingAction(step("first_land"), base(), true, now)!!.verb)
        assertEquals(StepDestination.Train, onboardingAction(step("first_troops"), base(), false, now)!!.go)
        // Web needsTraining: no unit with count > 0 AND no available hero. Either one is an army to raid with.
        assertEquals("An empty army with no hero trains first", StepDestination.Train, onboardingAction(step("first_raid"), base(), false, now)!!.go)
        assertEquals("Zero-count rows are no army", StepDestination.Train, onboardingAction(step("first_raid"), base(army = """[{"troop":"bowman","count":0}]"""), false, now)!!.go)
        assertEquals(StepDestination.Raid, onboardingAction(step("first_raid"), base(army = """[{"troop":"bowman","count":0},{"troop":"highlander","count":2}]"""), false, now)!!.go)
        assertEquals("An available hero raids without troops", StepDestination.Raid, onboardingAction(step("first_raid"), base(heroes = """[{"hero":"knight","available":true}]"""), false, now)!!.go)
        assertEquals("A recovering hero is not an army", StepDestination.Train, onboardingAction(step("first_raid"), base(heroes = """[{"hero":"knight","available":false,"recoveryUntil":"2026-09-11T12:00:00.000Z"}]"""), false, now)!!.go)
        val blocked = onboardingAction(step("first_troops"), base(armyStatus = """{"readyTroopCount":10,"readyPts":20,"trainingPts":10,"campCapacityPts":20,"barracksQueuePts":10,"trainingTroopCount":5}"""), false, now)!!
        assertEquals("WAIT", blocked.verb); assertEquals(StepDestination.Train, blocked.go); assertTrue(blocked.hint.startsWith("20/20"))
        assertNull("An unknown template renders without a dead tap", onboardingAction(step("sixth_step"), base(), false, now))
    }
}
