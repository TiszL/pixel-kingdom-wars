package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ResearchTest {
    private fun json(value: String)=Json.parseToJsonElement(value).jsonObject
    private val catalogue=json("""{"display":{"research":{"troops":["unit","elite","dark"],"darkTroops":["dark"],"eliteItems":{"elite":"writ"},"speedup":{"rate":3,"granularitySec":10,"quadraticSoftUnits":4}}},"constants":{"TROOPS":{"unit":{},"elite":{},"dark":{}},"TROOP_LEVELING":{"maxLevel":3,"researchCostKeep":[91,182],"researchTimeSec":[72,144]}}}""")
    private val base=json("""{"player":{"keepLevel":3},"buildings":[{"id":"f","type":"forge","level":3}],"jobs":[]}""")
    private val balances=json("""{"shards":"1000","keep":"1000"}""")
    private val idle=json("""{"levels":{"unit":1,"elite":1,"dark":1},"research":[],"eliteUnlocks":{"elite":false},"features":{"researchConsent":{"version":1},"darkAttackerRoster":{"enabled":false}}}""")
    private val target=json("""{"action":"start","troop":"unit","level":"1","toLevel":2,"price":"91","baseId":"base-a"}""")
    private val order=buildJsonObject { put("target",target);put("body",json("""{"baseId":"base-a","troop":"unit","idempotencyKey":"fixed-order"}""")) }
    private fun active()=JsonObject(idle+mapOf("research" to Json.parseToJsonElement("""[{"troop":"unit","episodeId":"episode-a","toLevel":2,"finishesAt":"2030-01-01T00:00:20Z"}]""")))
    @Test fun `generated prices and server unlocks control research availability`() {
        val choices=researchChoices(catalogue,base,idle,balances)
        assertEquals("91",choices[0].cost.toString());assertEquals(72L,choices[0].seconds);assertNull(choices[0].reason)
        assertTrue(choices[1].reason!!.contains("writ"));assertEquals("Coming soon",choices[2].reason)
        assertTrue(researchChoices(buildJsonObject {},base,idle,balances).isEmpty())
    }
    @Test fun `old server remains readable but cannot authorize conditional orders`() {
        val old=JsonObject(idle+mapOf("features" to buildJsonObject {}))
        assertFalse(researchConsentSupported(old))
        assertTrue(researchChoices(catalogue,base,old,balances).all { it.reason!=null })
        assertEquals(json("""{"currentLevel":1,"maxCostShards":"91"}"""),researchConsent(target))
        val finish=JsonObject(target+active().objects("research").single()+mapOf("action" to JsonPrimitive("finish")))
        assertEquals(json("""{"currentLevel":1,"episodeId":"episode-a","toLevel":2,"finishesAt":"2030-01-01T00:00:20Z","maxCostKeep":"91"}"""),researchConsent(finish))
    }
    @Test fun `unfinished forge and busy lane never authorize another research`() {
        val building=JsonObject(base+mapOf("jobs" to Json.parseToJsonElement("""[{"kind":"build","buildingId":"f"}]""")))
        assertTrue(researchChoices(catalogue,building,idle,balances)[0].reason!!.contains("Forge level"))
        assertEquals("Forge is researching",researchChoices(catalogue,base,active(),balances)[0].reason)
        assertFalse(researchActionMatches(target,active()))
    }
    @Test fun `speedup uses generated coefficients and never offers paid finish after deadline`() {
        val row=active().objects("research").single();val now=java.time.Instant.parse("2030-01-01T00:00:00Z").toEpochMilli()
        assertEquals("9",researchSpeedupPrice(catalogue,row,now).toString())
        assertNull(researchSpeedupPrice(catalogue,row,now+20_000))
    }
    @Test fun `episode change does not authorize cancellation of replacement research`() {
        val row=active().objects("research").single()
        val cancel=JsonObject(target+row+mapOf("action" to JsonPrimitive("cancel")))
        assertTrue(researchActionMatches(cancel,active()))
        val changed=JsonObject(active()+mapOf("research" to buildJsonArray {add(JsonObject(row+mapOf("finishesAt" to JsonPrimitive("2031-01-01T00:00:20Z"))))}))
        assertFalse(researchActionMatches(cancel,changed));assertTrue(researchStateAdvanced(buildJsonObject {put("target",cancel)},changed))
    }
    @Test fun `equal deadline replacement still requires original episode and legacy null is explicit`() {
        val row=active().objects("research").single()
        val cancel=JsonObject(target+row+mapOf("action" to JsonPrimitive("cancel")))
        val replacement=JsonObject(active()+mapOf("research" to buildJsonArray {add(JsonObject(row+mapOf("episodeId" to JsonPrimitive("episode-b"))))}))
        assertFalse(researchActionMatches(cancel,replacement))
        assertFalse(researchActionMatches(JsonObject(cancel-"episodeId"),active()))
        val legacy=JsonObject(row+mapOf("episodeId" to JsonNull))
        val legacyArmy=JsonObject(active()+mapOf("research" to buildJsonArray {add(legacy)}))
        assertTrue(researchActionMatches(JsonObject(cancel+mapOf("episodeId" to JsonNull)),legacyArmy))
        assertEquals(JsonNull,researchConsent(JsonObject(cancel+mapOf("episodeId" to JsonNull)))["episodeId"])
    }
}
