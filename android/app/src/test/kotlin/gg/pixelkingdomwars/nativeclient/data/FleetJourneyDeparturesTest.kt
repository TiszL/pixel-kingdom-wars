package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.baseJson
import gg.pixelkingdomwars.nativeclient.fleetjourney.FleetJourneyEvent
import gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.CurrentFleetIdentity
import gg.pixelkingdomwars.nativeclient.network.GameApi
import gg.pixelkingdomwars.nativeclient.network.SessionCookieJar
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleHttpPort
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleProtocol
import gg.pixelkingdomwars.nativeclient.vehicle.VehicleTransport
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

/** Accepted primary original/sidecar/fleet objects, reserialized through local TLS.
 * HTTP 201/creation headers and the Home berth with its same-response current
 * visual/installation identity siblings are synthetic.
 * This tests native adapter composition, not a new primary command or Android pixels. */
class FleetJourneyDeparturesTest {
    private val pair: JsonObject = run {
        val relative = "network/src/test/resources/boundcosmetics/wake-sidecar-primary-pair.json"
        val file = listOf(File(relative), File("../$relative")).first { it.isFile }
        Json.parseToJsonElement(file.readText()).jsonObject
    }
    private fun sample(kind: String) = pair.getValue(kind).jsonObject.getValue("selected").jsonObject
    private fun tls(block: suspend (MockWebServer, OkHttpClient) -> Unit) {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val identity = HandshakeCertificates.Builder().heldCertificate(cert).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val client = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        try { MockWebServer().use { server ->
            server.useHttps(identity.sslSocketFactory(), false); server.start()
            runBlocking { block(server, client) }
        } } finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }

    private inner class Fixture(val server: MockWebServer, client: OkHttpClient) {
        val selected = sample("advanced")
        val original = selected.getValue("original").jsonObject
        val request = original.getValue("receipt").jsonObject.getValue("request").jsonObject
        val wallet = original.getValue("wallet").jsonPrimitive.content
        val baseId = request.getValue("baseId").jsonPrimitive.content
        val expeditionId = original.getValue("idempotencyKey").jsonPrimitive.content
        val fleet = selected.getValue("fleet").jsonObject
        val installedVehicle = fleet.getValue("vehicles").jsonArray.single().jsonObject
        val berthId = installedVehicle.getValue("berthId").jsonPrimitive.content
        val installationId = installedVehicle.getValue("installationId").jsonPrimitive.content
        val jar = SessionCookieJar(server.url("/"), MemoryStore())
        val game = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
        val session = AccountSession(wallet, server.url("/").toString(), jar.sessionToken())
        val holder = AccountSessionHolder(dispatcher = Dispatchers.Unconfined).also { it.replace(session) }
        val identity = StarterIdentity(session.origin.trimEnd('/'), "devnet", wallet)
        val publication = FleetJourneyPublication(session, holder)
        val retained = MemoryStore()
        val events = mutableListOf<FleetJourneyEvent>()
        val reads = mutableListOf<Pair<String, Map<String, String>>>()
        var generation = 1L
        var selectedBase: String? = baseId
        var visible = true
        var base: BaseSnapshot? = home()
        var sidecar = selected.getValue("sidecar").jsonObject
        var beforeRead: suspend () -> Unit = {}
        val departures = FleetJourneyDepartures(wallet, publication, { base }, { selectedBase }, { generation }) { path, query, guard ->
            assertEquals("Optional reads must follow owned receipt retention", original.toString(), retained.value)
            reads += path to query
            beforeRead(); guard()
            when (path) {
                "/bound-cosmetics/wakes/v1/originals/advanced/$expeditionId" -> {
                    assertTrue(query.isEmpty()); sidecar
                }
                "/bound-cosmetics/wakes/v1/current" -> {
                    assertEquals(mapOf("baseId" to baseId), query); selected.getValue("current").jsonObject
                }
                "/vehicles/fleet" -> { assertEquals(mapOf("baseId" to baseId), query); fleet }
                else -> error("Unexpected optional read $path")
            }
        }
        val transport = VehicleTransport(VehicleHttpPort(game.charterClientPort(identity, session.token)), departures::capture)
        fun home(construction: Boolean = false, buildingId: String = berthId,
                 identityInstallationId: String? = installationId): BaseSnapshot {
            val raw = baseJson(baseId)
            // Synthetic pre-command Home setup, not a captured /base response.
            // Both siblings belong to this one snapshot; production must never
            // derive current identity from the later fleet read or command event.
            return BaseSnapshot.from(JsonObject(raw + buildJsonObject {
                put("player", JsonObject(raw.getValue("player").jsonObject + ("wallet" to JsonPrimitive(wallet))))
                put("buildings", buildJsonArray { add(buildJsonObject {
                    put("id", buildingId); put("type", "berth"); put("level", 1)
                    put("tx", 1); put("ty", 1); put("underConstruction", construction)
                }) })
                put("advancedServicePresentation", buildJsonObject {
                    put("version", 1); put("berths", buildJsonArray { add(buildJsonObject {
                        put("buildingId", buildingId)
                        put("installation", if (construction) JsonNull else buildJsonObject {
                            put("family", installedVehicle.getValue("family")); put("tier", installedVehicle.getValue("tier"))
                            put("presence", "occupied")
                        })
                    }) })
                })
                if (identityInstallationId != null) put("advancedFleetIdentity", buildJsonObject {
                    put("version", 1); put("berths", buildJsonArray { add(buildJsonObject {
                        put("buildingId", buildingId)
                        put("installation", if (construction) JsonNull else buildJsonObject {
                            put("installationId", identityInstallationId)
                            put("family", installedVehicle.getValue("family")); put("tier", installedVehicle.getValue("tier"))
                        })
                    }) })
                })
            }))
        }
        fun mount(consume: (FleetJourneyEvent) -> Unit = { events += it }) =
            publication.attach(Any(), baseId, Any(), { visible }, consume)
        suspend fun dispatch(status: Int = 201, marker: Boolean = true): JsonObject {
            val response = MockResponse().setResponseCode(status).setBody(original.toString())
            if (marker) response.addHeader("x-pkw-journey-created", "1")
            server.enqueue(response)
            return transport.request("POST", "/advanced-expeditions", request, { holder.requireCurrent(session) }) { raw ->
                VehicleProtocol.expedition(raw); retained.write(raw.toString())
            }
        }
        fun assertSingleCommand() {
            assertEquals(1, server.requestCount)
            val sent = requireNotNull(server.takeRequest(2, TimeUnit.SECONDS))
            assertEquals("POST", sent.method); assertEquals("/api/advanced-expeditions", sent.path)
            assertEquals(request, Json.parseToJsonElement(sent.body.readUtf8()))
        }
        fun assertAccepted(result: JsonObject) {
            assertEquals(original, result); assertEquals(original.toString(), retained.value)
            assertSingleCommand()
        }
    }

    @Test fun `real TLS created advanced command retains before matching immutable wake and completed berth publication`() = tls { server, client ->
        val f = Fixture(server, client); f.mount()
        f.assertAccepted(f.dispatch())
        assertEquals(3, f.reads.size)
        val event = f.events.single()
        assertEquals("departure", event.kind); assertEquals(f.baseId, event.baseId)
        assertEquals(f.berthId, event.berthId); assertEquals(f.expeditionId, event.expeditionId)
        assertEquals("survey_balloon", event.vehicle.family); assertEquals(1, event.vehicle.tier)
        assertEquals("available", event.wake.state); assertEquals("aurora_wake", event.wake.visual?.wake?.outputId)
    }

    @Test fun `a missing same-response Home identity refuses departure despite matching retained original and fleet`() = tls { server, client ->
        val f = Fixture(server, client)
        f.base = f.home(identityInstallationId = null); f.mount()
        val snapshot = requireNotNull(f.base)
        assertNotNull(snapshot.advancedServicePresentation?.berths?.single()?.installation)
        assertNull(CurrentFleetIdentity.current(snapshot.raw, snapshot.baseId,
            snapshot.servicePresentation, snapshot.advancedServicePresentation))
        f.assertAccepted(f.dispatch())
        assertEquals(3, f.reads.size)
        assertTrue("The fleet read cannot supply an identity missing from the captured Home", f.events.isEmpty())
    }

    @Test fun `a different same-response Home installation refuses departure despite matching retained original and fleet`() = tls { server, client ->
        val f = Fixture(server, client)
        val differentInstallation = "00000000-0000-4000-8000-000000000099"
        assertNotEquals(f.installationId, differentInstallation)
        f.base = f.home(identityInstallationId = differentInstallation); f.mount()
        val snapshot = requireNotNull(f.base)
        val current = requireNotNull(CurrentFleetIdentity.current(snapshot.raw, snapshot.baseId,
            snapshot.servicePresentation, snapshot.advancedServicePresentation)?.installation(f.berthId))
        assertEquals(differentInstallation, current.installationId)
        f.assertAccepted(f.dispatch())
        assertEquals(3, f.reads.size)
        assertTrue("A valid current Home installation must match this departure's installation", f.events.isEmpty())
    }

    @Test fun `an unmounted scene never reads sidecars or queues a later departure`() = tls { server, client ->
        val f = Fixture(server, client)
        f.assertAccepted(f.dispatch()); f.mount()
        assertTrue(f.reads.isEmpty()); assertTrue(f.events.isEmpty())
    }

    @Test fun `recovered 200 and markerless 201 retain success without optional reads`() {
        for ((status, marker) in listOf(200 to true, 201 to false)) tls { server, client ->
            val f = Fixture(server, client); f.mount()
            f.assertAccepted(f.dispatch(status, marker))
            assertTrue(f.reads.isEmpty()); assertTrue(f.events.isEmpty())
        }
    }

    @Test fun `snapshot selection lease account and visibility loss during a suspended sidecar cannot publish`() {
        for (change in listOf("snapshot", "selection", "lease", "account", "visibility")) tls { server, client -> coroutineScope {
            val f = Fixture(server, client); val lease = f.mount()
            val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
            f.beforeRead = { entered.complete(Unit); release.await() }
            val result = async { f.dispatch() }
            withTimeout(3000) { entered.await() }
            when (change) {
                "snapshot" -> f.base = requireNotNull(f.base).copy()
                "selection" -> f.generation += 2 // Same-base ABA still invalidates the pre-POST capture.
                "lease" -> { lease.close(); f.mount() }
                "account" -> f.holder.replace(AccountSession(f.wallet, f.session.origin, f.session.token))
                "visibility" -> f.visible = false
            }
            release.complete(Unit)
            f.assertAccepted(withTimeout(3000) { result.await() })
            assertEquals(1, f.reads.size); assertTrue("Lost $change guard must drop appearance only", f.events.isEmpty())
        } }
    }

    @Test fun `malformed foreign and already returned sidecars cannot undo retained command success`() {
        for (variant in listOf("malformed", "foreign", "returned")) tls { server, client ->
            val f = Fixture(server, client); f.mount()
            f.sidecar = when (variant) {
                "malformed" -> JsonObject(f.sidecar + ("privateReceipt" to JsonPrimitive("forbidden")))
                "foreign" -> JsonObject(f.sidecar + ("wallet" to JsonPrimitive("11111111111111111111111111111112")))
                else -> f.selected.getValue("returnedSidecar").jsonObject
            }
            f.assertAccepted(f.dispatch()); assertTrue(f.events.isEmpty())
        }
    }

    @Test fun `unfinished or different berth and failing visual consumer preserve accepted original`() {
        for (variant in listOf("construction", "berth", "consumer")) tls { server, client ->
            val f = Fixture(server, client); var consumed = 0
            if (variant == "construction") f.base = f.home(construction = true)
            if (variant == "berth") f.base = f.home(buildingId = "00000000-0000-4000-8000-000000000099")
            f.mount { consumed++; error("Visual consumer unavailable") }
            f.assertAccepted(f.dispatch())
            assertEquals(if (variant == "consumer") 1 else 0, consumed)
            assertTrue(f.events.isEmpty())
        }
    }

    @Test fun `SessionApiClient starter bridge retains the accepted original before exposing HTTP creation proof`() = tls { server, client ->
        val raw = sample("starter").getValue("original").jsonObject
        val body = raw.getValue("receipt").jsonObject.getValue("request").jsonObject
        val jar = SessionCookieJar(server.url("/"), MemoryStore())
        val game = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
        val api = SessionApiClient(game, jar.sessionToken(), ApiRouting())
        val retained = MemoryStore(); var created: FreshFleetDeparture? = null
        server.enqueue(MockResponse().setResponseCode(201).addHeader("x-pkw-journey-created", "1").setBody(raw.toString()))
        val result = api.postStarterExpeditionWithDeparture("/starter-expeditions", body, {},
            { retained.write(it.toString()) }, { fail("Accepted fixture cannot refuse") }, { proof ->
                assertEquals(raw.toString(), retained.value); created = proof
            })
        assertEquals(raw, result); assertEquals(raw, requireNotNull(created).original)
        assertEquals("starter", requireNotNull(created).kind)
        assertEquals(1, server.requestCount)
        val sent = requireNotNull(server.takeRequest(2, TimeUnit.SECONDS))
        assertEquals("POST", sent.method); assertEquals("/api/starter-expeditions", sent.path)
        assertEquals(body, Json.parseToJsonElement(sent.body.readUtf8()))
    }

    @Test fun `diagnostic runs once before capture and failure preserves the optional observer`() = runBlocking {
        val holder=gg.pixelkingdomwars.nativeclient.testHolder()
        val session=gg.pixelkingdomwars.nativeclient.signedIn(holder)
        val publication=FleetJourneyPublication(session,holder)
        val snapshot=BaseSnapshot.from(journeyBase());var calls=0
        val departures=FleetJourneyDepartures(session.wallet,publication,{snapshot},{snapshot.baseId},{1L},
            diagnosticOriginal={ guard ->
                calls++;guard()
                // A local mount in the fake callback proves capture occurs afterward.
                publication.attach(Any(),requireNotNull(snapshot.baseId),Any(),{true},{})
                throw java.io.IOException("diagnostic unavailable")
            }) { _, _, _ -> error("No network or post-response read in this test") }
        // The diagnostic read is debug-only (FleetJourneyDepartures gates it on BuildConfig.DEBUG). An optimized candidate
        // debug (-PnativeOptimizedDebug=true, as the night gate runs) has DEBUG=false, so pin both variants the way
        // PrivyIdentityTest does: debuggable runs it once before capture; otherwise it never runs and nothing mounts.
        if (gg.pixelkingdomwars.nativeclient.BuildConfig.DEBUG) {
            assertNotNull(departures.capture(requireNotNull(snapshot.baseId),{}));assertEquals(1,calls)
        } else { assertNull(departures.capture(requireNotNull(snapshot.baseId),{}));assertEquals(0,calls) }
    }
}
