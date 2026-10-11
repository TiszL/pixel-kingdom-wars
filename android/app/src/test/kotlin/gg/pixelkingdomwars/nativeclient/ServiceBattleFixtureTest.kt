package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.renderer.*
import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** This is a derived event fixture, not a new golden or recorded server history.
 * Its unchanged canonical bytes must bind any later GL observation. */
class ServiceBattleFixtureTest {
    private val bytes = File("src/androidTest/assets/service-art/phase-e-structures.json").readBytes()
    private val fixture = Json.parseToJsonElement(bytes.decodeToString()).jsonObject
    private val replay = fixture.getValue("replay").jsonObject
    private val events = replay.getValue("events").jsonArray
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    @Test fun `derived full replay retains exact original golden event fingerprint and canonical source identities`() {
        assertEquals("b9b793f619a01a0f7f2d6b6ee2d07ed82ac7390893fe6d9e5bc668ae31596907", sha(bytes))
        val p = fixture.getValue("provenance").jsonObject
        assertEquals("phase_e_structures", p.getValue("scenario").jsonPrimitive.content)
        assertEquals("124d22699b65dc9d13768b3b257a5f2f5d506b34", p.getValue("sourceCommit").jsonPrimitive.content)
        var hash = 0x811c9dc5.toInt()
        events.toString().forEach { hash = (hash xor it.code) * 0x01000193 }
        assertEquals("b26e3eac", hash.toUInt().toString(16)); assertEquals(550, events.size)
        assertEquals(replay.getValue("timeline").jsonObject.getValue("sha256").jsonPrimitive.content, sha(events.toString().toByteArray()))
        assertEquals(18, replay.getValue("simVersion").jsonPrimitive.int)
        assertEquals(320, replay.getValue("outcome").jsonObject.getValue("ticks").jsonPrimitive.int)
    }
    @Test fun `original ids and absent historical installation are preserved instead of fabricating current facts`() {
        val snapshot = replay.getValue("snapshot").jsonObject
        assertEquals(listOf("keep","workshop","lodge","market","harvester","berth"),
            snapshot.getValue("buildings").jsonArray.map { it.jsonObject.getValue("id").jsonPrimitive.content })
        for (owner in listOf(replay, snapshot)) {
            assertFalse(owner.containsKey("servicePresentation")); assertFalse(owner.containsKey("serviceActivity"))
            assertFalse(owner.containsKey("features")); assertFalse(owner.containsKey("visualContext"))
        }
        assertEquals("test-only-candidate-default-not-recorded-history",
            fixture.getValue("provenance").jsonObject.getValue("visualContext").jsonPrimitive.content)
    }
    @Test fun `canonical damage threshold precedes Lodge destruction and all five services remain destructible`() {
        val health = replay.getValue("buildingHealth").jsonArray.associate { row -> row.jsonObject.let {
            it.getValue("id").jsonPrimitive.content to (it.getValue("initialHp").jsonPrimitive.long to it.getValue("maxHp").jsonPrimitive.long)
        } }
        val buildings = replay.getValue("snapshot").jsonObject.getValue("buildings").jsonArray.map { row ->
            val b = row.jsonObject; val id = b.getValue("id").jsonPrimitive.content
            RenderBuilding(id, "fixture-only", b.getValue("tx").jsonPrimitive.float, b.getValue("ty").jsonPrimitive.float, 2f, 2f,
                initialHp = health.getValue(id).first, maxHp = health.getValue(id).second, type = b.getValue("type").jsonPrimitive.content)
        }
        val presentation = events.map { PresentationEvent.fromJson(it.toString()) }
        val threshold = Json.parseToJsonElement(File("src/main/assets/native/render-catalog.json").readText()).jsonObject
            .getValue("buildingDamageThreshold").jsonPrimitive.float
        val model = BuildingHealthVisualModel(buildings, presentation, threshold)
        val destroyed = events.map { it.jsonObject }.filter { it["e"] == JsonPrimitive("destroyed") }
            .associate { it.getValue("id").jsonPrimitive.content to it.getValue("t").jsonPrimitive.int }
        assertEquals(buildings.map { it.id }.toSet(), destroyed.keys)
        val lodgeTick = destroyed.getValue("lodge")
        assertTrue((0 until lodgeTick).any { model.at("lodge", it.toFloat())!!.damagedSinceTick != null })
        assertTrue(model.at("lodge", lodgeTick - 1f)!!.hp > 0)
        assertEquals(0L, model.at("lodge", lodgeTick.toFloat())!!.hp)
        assertTrue(destroyed.getValue("workshop") > lodgeTick)
        assertTrue(destroyed.getValue("keep") > destroyed.filterKeys { it != "keep" }.values.max())
    }
    @Test fun `live service observation window crosses canonical hits and expires before the next hit without inventing events`() {
        val catalogue = Json.parseToJsonElement(File("src/main/assets/native/catalogue.json").readText()).jsonObject
        val render = Json.parseToJsonElement(File("src/main/assets/native/render-catalog.json").readText()).jsonObject
        val tickMs = catalogue.getValue("presentation").jsonObject.getValue("tickMs").jsonPrimitive.float
        val lifetime = render.getValue("hitFeedback").jsonObject.getValue("star").jsonObject.getValue("durationMs").jsonPrimitive.float
        val hits = events.mapIndexedNotNull { ordinal, value -> value.jsonObject.let { event ->
            if (event["e"] == JsonPrimitive("hit") && event["target"]?.jsonPrimitive?.content in setOf("workshop","lodge","market","harvester")) ordinal to event else null
        } }
        fun visible(tick: Float) = hits.filter { (_, event) ->
            val at = event.getValue("t").jsonPrimitive.float
            at >= 44 && tick >= at && (tick - at) * tickMs < lifetime
        }
        assertTrue(visible(44f).isEmpty())
        assertEquals(listOf(78,79,80,81), visible(45f).map { it.first })
        assertEquals(listOf("workshop","harvester","lodge","market"), visible(45f).map { it.second.getValue("target").jsonPrimitive.content })
        assertEquals(6, visible(47f).size)
        val expiry = 47 + lifetime / tickMs
        assertTrue(expiry < 50)
        assertTrue(visible(expiry + .01f).isEmpty())
        assertEquals(3, visible(50f).size)
        val lodgeBefore = 600 - hits.filter { (_, event) -> event["target"] == JsonPrimitive("lodge") && event.getValue("t").jsonPrimitive.float < 45 }
            .sumOf { it.second.getValue("dmg").jsonPrimitive.int }
        assertEquals(312, lodgeBefore)
        assertEquals(296, lodgeBefore - visible(45f).single { it.second["target"] == JsonPrimitive("lodge") }.second.getValue("dmg").jsonPrimitive.int)
    }
}
