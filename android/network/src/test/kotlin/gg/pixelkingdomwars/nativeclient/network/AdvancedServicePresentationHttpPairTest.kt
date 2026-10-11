package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.BaseServiceFacts
import gg.pixelkingdomwars.nativeclient.model.BerthPresentation
import gg.pixelkingdomwars.nativeclient.model.PresentationHead
import gg.pixelkingdomwars.nativeclient.model.AdvancedBerthPresentation
import gg.pixelkingdomwars.nativeclient.model.AdvancedInstallationPresentation
import gg.pixelkingdomwars.nativeclient.model.AdvancedPresence
import java.security.MessageDigest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Exact authenticated buildApp.inject response bodies, not native HTTP or Android rendering.
 * The primary fixture proves genuine installation/dispatch/return, started-retreat archive
 * creation and custody transfer, with declared synthetic encoded Core/finality/facilities
 * and original journal timestamps shifted seven days only in the isolated fixture. There is
 * no captured current-base or custody response; those lifecycle proofs belong to the primary test.
 * Both v2 captures are complete replacements, not captured parent/suffix responses. */
class AdvancedServicePresentationHttpPairTest {
    private fun pair(): JsonObject {
        val bytes = requireNotNull(javaClass.getResource("/advanced/frozen-raid-http-pair.json")).readBytes()
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        assertEquals("63c618fd817f17c4867c3be4d084a2249ae29f15f47b6da33929cae0959b7a81", digest)
        return Json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject.also {
            assertEquals("normal-buildApp-authenticated-inject-response-bodies",
                it.getValue("provenance").jsonObject.getValue("kind").jsonPrimitive.content)
        }
    }

    private fun body(pair: JsonObject, name: String): JsonObject =
        Json.parseToJsonElement(pair.getValue(name).jsonPrimitive.content).jsonObject

    private fun assertFrozenAway(raw: JsonObject, raidId: String, berthId: String) {
        assertEquals(raidId, raw.battleString("raidId"))
        val snapshot = raw.getValue("snapshot").jsonObject
        val berthIds = snapshot.getValue("buildings").jsonArray.map { it.jsonObject }
            .filter { it.getValue("type").jsonPrimitive.content == "berth" }
            .map { it.getValue("id").jsonPrimitive.content }.sorted()
        assertEquals(listOf(berthId), berthIds)
        val expected = listOf(AdvancedBerthPresentation(berthId,
            AdvancedInstallationPresentation("survey_balloon", 1, AdvancedPresence.AWAY)))
        val facts = BaseServiceFacts.frozen(raw, snapshot)
        assertEquals(expected, facts.advancedPresentation?.berths)
        // A separate no-starter row cannot erase the installed advanced vessel.
        assertEquals(listOf(BerthPresentation(berthId, null)), facts.presentation?.berths)
        assertEquals(expected, PresentationHead.from(raw).advancedServicePresentation?.berths)
        // Original facts require their original building closure; they cannot stand alone.
        assertNull(BaseServiceFacts.frozen(raw, null).advancedPresentation)
        assertNull(facts.phaseEArt)
        assertNull(facts.activity)
        val wire = raw.getValue("advancedServicePresentation").jsonObject
        assertEquals(setOf("version", "berths"), wire.keys)
        val row = wire.getValue("berths").jsonArray.single().jsonObject
        assertEquals(setOf("buildingId", "installation"), row.keys)
        assertEquals(setOf("family", "tier", "presence"), row.getValue("installation").jsonObject.keys)
    }

    @Test fun `actual live and canonical archive retain original advanced away after primary return and transfer`() {
        val pair = pair()
        val provenance = pair.getValue("provenance").jsonObject
        val raidId = provenance.getValue("raidId").jsonPrimitive.content
        val berthId = provenance.getValue("berthId").jsonPrimitive.content
        val live = body(pair, "live")
        val archive = body(pair, "archive")
        assertEquals("live", live.battleString("source"))
        assertEquals("pending_orders", live.battleString("status"))
        assertEquals("archive", archive.battleString("source"))
        assertEquals("resolved", archive.battleString("status"))
        for (raw in listOf(live, archive)) {
            validatePresentation(raw, raidId, raw.battleInt("simVersion"))
            assertFrozenAway(raw, raidId, berthId)
        }
        assertEquals(live["advancedServicePresentation"], archive["advancedServicePresentation"])
        assertEquals(live["servicePresentation"], archive["servicePresentation"])
        assertEquals(live.getValue("snapshot").jsonObject["buildings"],
            archive.getValue("snapshot").jsonObject["buildings"])
        assertNotEquals(live["revision"], archive["revision"])
        assertTrue(live.getValue("events").jsonArray.isEmpty())
        assertTrue(archive.getValue("events").jsonArray.isNotEmpty())
    }

    @Test fun `actual protocol two full replacements keep each original snapshot and archive timeline together`() {
        val pair = pair()
        val provenance = pair.getValue("provenance").jsonObject
        val raidId = provenance.getValue("raidId").jsonPrimitive.content
        val berthId = provenance.getValue("berthId").jsonPrimitive.content
        var previous: JsonObject? = null
        for ((pageName, envelopeName) in listOf("livePage" to "live", "archivePage" to "archive")) {
            val page = body(pair, pageName)
            val envelope = body(pair, envelopeName)
            assertEquals(JsonNull, page["parentRevision"])
            assertEquals(JsonNull, page["nextCursor"])
            assertEquals(0, page.battleInt("replaceFromTick"))
            val assembly = PresentationAssembly(raidId, envelope.battleInt("simVersion"), previous,
                CLIENT_EVENT_CEILING, CLIENT_PAGE_BYTE_CEILING, CLIENT_COMMAND_CEILING)
            assertNull(assembly.accept(page))
            val complete = assembly.complete()
            for (field in listOf("raidId", "revision", "source", "status", "simVersion", "snapshot",
                "armySnapshot", "commands", "events", "servicePresentation", "advancedServicePresentation")) {
                assertEquals("$pageName must preserve its own $field", envelope[field], complete[field])
            }
            assertEquals(2, complete.battleInt("transportProtocolVersion"))
            assertFrozenAway(complete, raidId, berthId)
            previous = complete
        }
        assertEquals("archive", previous?.battleString("source"))
        assertEquals("resolved", previous?.battleString("status"))
    }
}
