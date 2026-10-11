package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.fleetjourney.FleetJourneyEvent
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.CurrentFleetIdentity
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

internal const val JOURNEY_BERTH = "00000000-0000-4000-8000-000000000001"
internal const val JOURNEY_INSTALLATION = "00000000-0000-4000-8000-000000000002"
internal fun journeyEvent(kind: String = "return", family: String = "starter", tier: Int = 1, receipt: Int = 4, installationId: String = JOURNEY_INSTALLATION): JsonObject = buildJsonObject {
    put("version", 1); put("kind", kind); put("baseId", BASE_ID); put("berthId", JOURNEY_BERTH)
    put("installationId", installationId)
    put("expeditionId", "00000000-0000-4000-8000-000000000003")
    put("at", "2026-10-01T10:00:00.000Z")
    put("vehicle", buildJsonObject { put("family", family); if (family != "starter") put("tier", tier) })
    put("wake", buildJsonObject { put("state", "legacy"); put("visual", JsonNull) })
    if (kind == "return") put("returnId", "00000000-0000-4000-8000-${receipt.toString().padStart(12, '0')}")
}
internal fun journeyBatch(vararg events: JsonObject) = buildJsonObject { put("version", 1); put("events", JsonArray(events.toList())) }
/** CONTINUITY: the fixture body carries the SAME-response current identity of its one installed berth (starterFleet.installation for the
 *  starter, the advancedFleetIdentity sibling for advanced craft); [identityInstallationId] null omits it, so continuity must refuse. */
internal fun journeyBase(presence: String = "occupied", family: String = "starter", tier: Int = 1,
    revision: Int = 1, construction: Boolean = false, events: JsonElement? = null, identityInstallationId: String? = JOURNEY_INSTALLATION): JsonObject {
    val building = buildJsonObject { put("id", JOURNEY_BERTH); put("type", "berth"); put("level", 1); put("tx", 1); put("ty", 1); put("underConstruction", construction) }
    val facts = buildJsonObject {
        put("version", 1); put("berths", buildJsonArray { add(buildJsonObject {
            put("buildingId", JOURNEY_BERTH); put("installation", buildJsonObject {
                put("family", family); put("presence", presence); if (family != "starter") put("tier", tier)
            })
        }) })
    }
    return JsonObject(baseJson() + buildJsonObject {
        put("buildings", JsonArray(listOf(building))); put("freeBuilders", revision)
        put(if (family == "starter") "servicePresentation" else "advancedServicePresentation", facts)
        if (identityInstallationId != null) {
            if (family == "starter") put("starterFleet", buildJsonObject {
                put("installation", buildJsonObject { put("installationId", identityInstallationId); put("baseId", BASE_ID); put("berthId", JOURNEY_BERTH); put("family", "starter")
                    put("completedBuildJobId", "00000000-0000-4000-8000-000000000009"); put("berthCompletedAt", "2026-09-30T00:00:00.000Z"); put("installedAt", "2026-09-30T00:00:00.000Z") })
                put("eligibleBerths", JsonArray(emptyList())); put("serverNow", "2026-10-01T10:00:00.000Z") })
            else put("advancedFleetIdentity", buildJsonObject { put("version", 1); put("berths", buildJsonArray { add(buildJsonObject {
                put("buildingId", JOURNEY_BERTH); put("installation", buildJsonObject { put("installationId", identityInstallationId); put("family", family); put("tier", tier) }) }) }) })
        }
        events?.let { put("fleetJourneyEvents", it) }
    })
}

class FleetJourneyPublicationTest {
    private class Fixture {
        val holder = testHolder(); val session = signedIn(holder)
        val publication = FleetJourneyPublication(session, holder)
        val events = mutableListOf<FleetJourneyEvent>()
        val base = BaseSnapshot.from(journeyBase())
        var visible = true
        fun attach(consume: (FleetJourneyEvent) -> Unit = { events += it }) =
            publication.attach(Any(), BASE_ID, Any(), { visible }, consume)
        fun capture(guard: () -> Unit = {}) = publication.capture(BASE_ID, base, guard)
        fun warm() { publication.publishReturns(null, base, capture()) { true } }
        fun returned(raw: JsonElement = journeyBatch(journeyEvent()), snapshot: BaseSnapshot = base) {
            publication.publishReturns(raw, snapshot, capture()) { true }
        }
    }

    @Test fun `absent and cold consumers never queue a return for a later mount`() {
        val f = Fixture()
        assertNull(f.capture()); f.returned()
        f.attach(); f.returned(); assertTrue(f.events.isEmpty())
        f.returned(); assertEquals(1, f.events.size)
    }

    @Test fun `resume and lease replacement start cold while dedup lasts for the session`() {
        val f = Fixture(); val old = f.attach(); f.warm(); f.returned()
        val beforePause = f.capture(); f.publication.invalidate()
        f.attach(); old.close()
        f.publication.publishReturns(journeyBatch(journeyEvent(receipt = 5)), f.base, beforePause) { true }
        f.returned(journeyBatch(journeyEvent(receipt = 5)))
        assertEquals(1, f.events.size)
        f.returned(); assertEquals("A prior callback cannot replay after resume", 1, f.events.size)
        f.returned(journeyBatch(journeyEvent(receipt = 5))); assertEquals(2, f.events.size)
    }

    @Test fun `a refused visibility capture cannot revive when the same guard becomes true`() {
        val f = Fixture(); f.attach(); f.warm(); val captured = f.capture()
        f.visible = false
        f.publication.publishReturns(journeyBatch(journeyEvent()), f.base, captured) { true }
        f.visible = true
        f.publication.publishReturns(journeyBatch(journeyEvent()), f.base, captured) { true }
        assertNull(f.capture()); assertTrue(f.events.isEmpty())
    }

    @Test fun `selected generation and account replacement invalidate already captured effects`() {
        val f = Fixture(); f.attach(); f.warm(); var generation = 1
        val captured = f.capture { check(generation == 1) }
        generation = 3 // Switch away and back to the same stable base.
        f.publication.publishReturns(journeyBatch(journeyEvent()), f.base, captured) { true }
        f.attach(); f.warm(); val current = f.capture()
        signedIn(f.holder, "another-account")
        f.publication.publishReturns(journeyBatch(journeyEvent()), f.base, current) { true }
        assertTrue(f.events.isEmpty())
    }

    @Test fun `a superseded read drops its own capture without revoking the current warm consumer`() {
        val f = Fixture(); f.attach(); f.warm(); var ticket = 1
        val older = f.capture { check(ticket == 1) }
        ticket = 2
        f.publication.publishReturns(journeyBatch(journeyEvent()), f.base, older) { true }
        assertTrue(f.events.isEmpty()); assertNotNull(f.capture())
        f.returned(); assertEquals(1, f.events.size)
    }

    @Test fun `the entire return batch requires completed berths and settled matching family facts`() {
        val cases = listOf(
            journeyBatch(journeyEvent(), journeyEvent("departure")) to journeyBase(),
            journeyBatch(journeyEvent()) to journeyBase("away"),
            journeyBatch(journeyEvent()) to journeyBase(construction = true),
            journeyBatch(journeyEvent(family = "cargo_cutter")) to journeyBase(family = "survey_balloon"),
            journeyBatch(journeyEvent(family = "survey_balloon", tier = 2)) to journeyBase(family = "survey_balloon"),
            journeyBatch(JsonObject(journeyEvent() + ("berthId" to JsonPrimitive("00000000-0000-4000-8000-000000000099")))) to journeyBase(),
        )
        for ((raw, base) in cases) {
            val f = Fixture(); f.attach(); f.warm(); f.returned(raw, BaseSnapshot.from(base)); assertTrue(f.events.isEmpty())
        }
        val f = Fixture(); f.attach(); f.warm(); f.returned(JsonPrimitive("bad")); assertTrue(f.events.isEmpty())
    }

    @Test fun `advanced occupied and exhausted returns match their own tier and identity domain`() {
        for (presence in listOf("occupied", "exhausted")) {
            val f = Fixture(); f.attach(); f.warm(); f.returned()
            f.returned(journeyBatch(journeyEvent(family = "cargo_cutter", tier = 2)),
                BaseSnapshot.from(journeyBase(presence, "cargo_cutter", 2)))
            assertEquals("Same receipt UUID in another family is a separate identity domain", 2, f.events.size)
        }
    }

    @Test fun `departures need the exact initial owned snapshot but not a warmed return baseline`() {
        val f = Fixture(); f.attach(); val capture = requireNotNull(f.capture())
        val event = FleetJourneyEvent.from(journeyEvent("departure"))
        f.publication.publishDeparture(event, capture) { capture.sameSnapshot(f.base.copy()) }
        assertTrue(f.events.isEmpty())
        f.publication.publishDeparture(event, capture) { capture.sameSnapshot(f.base) }
        f.publication.publishDeparture(event, capture) { capture.sameSnapshot(f.base) }
        assertEquals(1, f.events.size)
        val cold = f.publication.capture(BASE_ID, null)
        f.publication.publishDeparture(event, cold) { true }; assertEquals(1, f.events.size)
    }

    @Test fun `consumer exceptions and mid batch lease loss never retry or leak a later event`() {
        val f = Fixture(); var calls = 0
        f.attach { calls++; error("renderer unavailable") }; f.warm(); f.returned(); f.returned()
        assertEquals("A failed visual is still consumed and never replayed", 1, calls)
        f.attach { f.events += it; f.publication.invalidate() }; f.warm()
        f.returned(journeyBatch(journeyEvent(receipt = 5), journeyEvent(receipt = 6)))
        assertEquals(1, f.events.size)
    }

    @Test fun `replaced snapshots and unowned snapshots cannot warm or publish a return`() {
        val f = Fixture(); f.attach()
        f.publication.publishReturns(null, f.base, f.capture()) { false }
        f.returned(); assertTrue(f.events.isEmpty())
        val unowned = f.base.copy(player = f.base.player.copy(wallet = "another-wallet"))
        f.returned(snapshot = unowned); assertTrue(f.events.isEmpty())
    }

    private val stranger = "00000000-0000-4000-8000-000000000099"
    @Test fun `continuity - a return or departure for another installation than the snapshot's current one is never emitted`() {
        val f = Fixture(); f.attach(); f.warm()
        f.returned(journeyBatch(journeyEvent(installationId = stranger))); assertTrue("unknown installation", f.events.isEmpty())
        f.returned(journeyBatch(journeyEvent()), BaseSnapshot.from(journeyBase(identityInstallationId = null))); assertTrue("snapshot without identity", f.events.isEmpty())
        f.returned(); assertEquals("the same current installation", 1, f.events.size)
        f.publication.publishDeparture(FleetJourneyEvent.from(journeyEvent("departure", installationId = stranger)), f.capture()) { true }
        assertEquals(1, f.events.size)
        f.publication.publishDeparture(FleetJourneyEvent.from(journeyEvent("departure")), f.capture()) { true }
        assertEquals(2, f.events.size); assertEquals("departure", f.events.last().kind)
        // advanced: the identity sibling must name the same installation, family and tier
        val advanced = BaseSnapshot.from(journeyBase(family = "survey_balloon", tier = 2))
        assertNotNull(CurrentFleetIdentity.current(advanced.raw, advanced.baseId, advanced.servicePresentation, advanced.advancedServicePresentation)?.installation(JOURNEY_BERTH))
        assertNull(CurrentFleetIdentity.current(advanced.raw, advanced.baseId, advanced.servicePresentation, BaseSnapshot.from(journeyBase(family = "survey_balloon", tier = 3)).advancedServicePresentation))
    }
}
