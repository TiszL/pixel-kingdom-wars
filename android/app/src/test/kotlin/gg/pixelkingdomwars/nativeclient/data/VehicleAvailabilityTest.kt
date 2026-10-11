package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.vehicle.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** A9: missing content and held read services cannot admit a departure. AUTHORED / UNRUN. */
class VehicleAvailabilityTest {
    private val f = VehicleFixtures
    private inner class Fixture {
        val store = VehicleStore(VehicleFixtures.Memory(), f.identity())
        var policy: VehiclePolicy? = f.policy
        var failure: Exception? = null
        var keys = 0
        val calls = mutableListOf<Pair<String, String>>()
        val ports = object : VehiclePorts {
            override val transport = VehicleTransport(object : VehiclePort {
                override val identity = store.identity
                override suspend fun request(method: String, path: String, query: Map<String, String>, body: JsonObject?,
                    guard: () -> Unit, retain: suspend (JsonObject) -> Unit): JsonObject {
                    guard(); calls += method to path; failure?.let { throw it }
                    check(method == "GET") { "No mutation belongs to these availability reads" }
                    val raw = when (path) {
                        "/vehicles/fleet" -> buildJsonObject {
                            put("version", 1); put("wallet", f.wallet); put("baseId", f.base)
                            put("serverNow", "2035-01-01T00:00:00.000Z"); put("acceptingNewActions", false)
                            put("vehicles", JsonArray(emptyList()))
                        }
                        "/vehicles/client/routes" -> buildJsonObject {
                            put("version", 1); put("wallet", f.wallet); put("baseId", f.base); put("items", JsonArray(emptyList()))
                        }
                        "/vehicles/client/activity" -> buildJsonObject {
                            put("version", 1); put("wallet", f.wallet); put("items", JsonArray(emptyList())); put("nextCursor", JsonNull)
                        }
                        else -> f.terminal()
                    }
                    retain(raw); guard(); return raw
                }
            })
            override fun capture(fresh: Boolean): () -> Unit = {}
            override fun policy() = policy
            override fun trust() = f.pins
            override fun key(): String { keys++; error("An unavailable fleet must not create a request") }
            override fun now() = 0L
            override fun requireOwnedBase(base: String) { check(base == f.base) }
            override suspend fun live(client: JsonObject, prepared: PreparedVehicle, pins: VehicleSigningTrust,
                policy: VehiclePolicy, networkFeeLamports: String, guard: () -> Unit): () -> Unit = error("No signing review")
            override suspend fun ready(guard: () -> Unit) = error("No signing preparation")
            override suspend fun sign(prepared: PreparedVehicle, guard: () -> Unit, beforeWallet: suspend () -> Unit,
                retain: suspend (JsonObject) -> Unit) = error("No wallet dispatch")
            override suspend fun hydrate(guard: () -> Unit) = guard()
        }
        val repository = VehicleRepository(store, ports)
        suspend fun noDispatch() {
            assertEquals(0, keys)
            assertTrue(calls.all { it.first == "GET" })
            assertTrue(store.read().records.isEmpty())
        }
    }

    @Test fun `absent policy marks unavailable before activity fleet assets or departure can dispatch`() = runBlocking {
        val x = Fixture(); x.policy = null
        val actions: List<suspend () -> Unit> = listOf(
            { x.repository.open() }, { x.repository.fleet(f.base) }, { x.repository.assets() },
            { x.repository.dispatch(f.base, "unselected-installation", "unselected-route") })
        for (action in actions) {
            assertNotNull(runCatching { action() }.exceptionOrNull())
            assertEquals(VehicleUnavailable.MISSING_POLICY, x.repository.state.value.unavailable)
            assertNull(x.repository.state.value.error)
            assertFalse(x.repository.state.value.busy)
            assertTrue(x.calls.isEmpty()); x.noDispatch()
        }
    }

    @Test fun `held fleet and client reads retire current snapshots and cannot dispatch`() = runBlocking {
        for (code in listOf("ADVANCED_FLEET_UNAVAILABLE", "VEHICLE_CLIENT_UNAVAILABLE")) {
            val x = Fixture(); x.repository.fleet(f.base); assertNotNull(x.repository.state.value.fleet)
            x.failure = ApiException(503, code, "internal provider diagnostic")
            assertSame(x.failure, runCatching { x.repository.fleet(f.base) }.exceptionOrNull())
            assertEquals(VehicleUnavailable.SERVICE_HELD, x.repository.state.value.unavailable)
            assertNull(x.repository.state.value.error)
            assertNull(x.repository.state.value.fleet); assertNull(x.repository.state.value.routes)
            assertNull(x.repository.state.value.assets); assertNull(x.repository.state.value.review)
            val reads = x.calls.toList()
            assertNotNull(runCatching { x.repository.dispatch(f.base, "unselected-installation", "unselected-route") }.exceptionOrNull())
            assertEquals(VehicleUnavailable.SERVICE_HELD, x.repository.state.value.unavailable)
            assertEquals(reads, x.calls)
            x.noDispatch()
        }
    }

    @Test fun `an observed unavailable service blocks fresh reservation before allocating its key`() = runBlocking {
        for (missingPolicy in listOf(true, false)) {
            val x = Fixture()
            if (missingPolicy) x.policy = null else x.failure = ApiException(503, "ADVANCED_FLEET_UNAVAILABLE", "held")
            runCatching { x.repository.fleet(f.base) }
            val reason = x.repository.state.value.unavailable; assertNotNull(reason)
            val calls = x.calls.toList()
            assertNotNull(runCatching { x.repository.reserve(f.base, f.berth, f.request.charterText("assetId")) }.exceptionOrNull())
            assertEquals(reason, x.repository.state.value.unavailable)
            assertEquals(calls, x.calls); x.noDispatch()
        }
    }

    @Test fun `held activity is distinct from a retryable network failure`() = runBlocking {
        val x = Fixture(); x.failure = ApiException(503, "VEHICLE_CLIENT_UNAVAILABLE", "internal provider diagnostic")
        assertSame(x.failure, runCatching { x.repository.open() }.exceptionOrNull())
        assertEquals(VehicleUnavailable.SERVICE_HELD, x.repository.state.value.unavailable)
        assertNull(x.repository.state.value.error)
        x.failure = IOException("socket diagnostic")
        assertSame(x.failure, runCatching { x.repository.open() }.exceptionOrNull())
        assertNull(x.repository.state.value.unavailable); assertNotNull(x.repository.state.value.error)
        x.noDispatch()
    }

    // Rewritten 2026-10-06 after the Seeker test against QA: a 503 on a crafted read now always means "not open here"
    // (QA's older build names another code), so only a non-503 status or a transport error stays a retryable failure;
    // a feature code on a 500 or in a message still classifies nothing.
    @Test fun `a non 503 status or a transport error never classifies a service as held`() = runBlocking {
        for (error in listOf(ApiException(500, "ADVANCED_FLEET_UNAVAILABLE", "VEHICLE_CLIENT_UNAVAILABLE"),
            ApiException(502, "UPSTREAM_TIMEOUT", "VEHICLE_CLIENT_UNAVAILABLE"), IOException("Required value was null."))) {
            val x = Fixture(); x.failure = error
            assertSame(error, runCatching { x.repository.fleet(f.base) }.exceptionOrNull())
            assertNull(x.repository.state.value.unavailable); assertNotNull(x.repository.state.value.error)
            x.noDispatch()
        }
    }

    // Owner Seeker 2026-10-06 (QA, vehicles switched off): each crafted route's switched-off answer is the server saying "not
    // open", which the Berth draws as a quiet line, never RETRY. The codes are the server's own (night/server apps/api/src/game:
    // advancedFleetRoutes.ts:12, vehicleClientRoutes.ts:15, vehicleRoutes.ts:15, vehicleServiceRoutes.ts:15,
    // vehicleCraftClientRoutes.ts:12). Rewritten 2026-10-06: an older server build (QA at 912e04e0) answers the switched-off
    // feature with a bare 503 and no code, so a codeless 503 holds the service too; a 503 that names any other code is a
    // real failure and keeps RETRY.
    @Test fun `every 503 on a crafted read holds the service while a 500 stays retryable`() = runBlocking {
        for (code in listOf("ADVANCED_FLEET_UNAVAILABLE", "VEHICLE_CLIENT_UNAVAILABLE", "VEHICLE_WORKFLOW_UNAVAILABLE",
            "VEHICLE_SERVICE_WORKFLOW_UNAVAILABLE", "VEHICLE_CRAFT_UNAVAILABLE")) {
            val x = Fixture(); x.failure = ApiException(503, code, "provider diagnostic")
            assertSame(x.failure, runCatching { x.repository.fleet(f.base) }.exceptionOrNull())
            assertEquals(code, VehicleUnavailable.SERVICE_HELD, x.repository.state.value.unavailable)
            assertNull(code, x.repository.state.value.error)
            x.noDispatch()
        }
        val bare = Fixture(); bare.failure = ApiException(503, null, "Service Unavailable")
        assertSame(bare.failure, runCatching { bare.repository.fleet(f.base) }.exceptionOrNull())
        assertEquals(VehicleUnavailable.SERVICE_HELD, bare.repository.state.value.unavailable); assertNull(bare.repository.state.value.error)
        bare.noDispatch()
        // Rewritten again 2026-10-06 after the Seeker test: QA's 503 carries another code, so every 503 holds the service;
        // a 500 (or a network error) is the real failure that keeps RETRY.
        val other = Fixture(); other.failure = ApiException(503, "LEDGER_MAINTENANCE", "Service Unavailable")
        assertSame(other.failure, runCatching { other.repository.fleet(f.base) }.exceptionOrNull())
        assertEquals(VehicleUnavailable.SERVICE_HELD, other.repository.state.value.unavailable); assertNull(other.repository.state.value.error)
        other.noDispatch()
        val broken = Fixture(); broken.failure = ApiException(500, null, "Internal Server Error")
        assertSame(broken.failure, runCatching { broken.repository.fleet(f.base) }.exceptionOrNull())
        assertNull(broken.repository.state.value.unavailable); assertNotNull(broken.repository.state.value.error)
        broken.noDispatch()
    }

    // A server build without the crafted routes (production answers /vehicles/fleet 404 with no code) has the feature off too.
    // A 404 the server sends WITH a code is a real refusal of this kingdom (BASE_NOT_OWNED), never "not open".
    @Test fun `a route-absent 404 on a crafted read is the feature off but a coded 404 is a real failure`() = runBlocking {
        val reads: List<suspend (Fixture) -> Unit> = listOf({ it.repository.fleet(f.base) }, { it.repository.open() }, { it.repository.assets() })
        for (read in reads) {
            val x = Fixture(); x.failure = ApiException(404, null, "Route GET:/vehicles/fleet not found")
            assertNotNull(runCatching { read(x) }.exceptionOrNull())
            assertEquals(VehicleUnavailable.SERVICE_HELD, x.repository.state.value.unavailable)
            assertNull(x.repository.state.value.error)
            x.noDispatch()
        }
        val x = Fixture(); x.failure = ApiException(404, "BASE_NOT_OWNED", "Base not owned or inactive")
        assertSame(x.failure, runCatching { x.repository.fleet(f.base) }.exceptionOrNull())
        assertNull(x.repository.state.value.unavailable); assertNotNull(x.repository.state.value.error)
        x.noDispatch()
    }

    @Test fun `successful fleet read clears a prior held state without any departure`() = runBlocking {
        val x = Fixture(); x.failure = ApiException(503, "ADVANCED_FLEET_UNAVAILABLE", "held")
        runCatching { x.repository.fleet(f.base) }
        x.failure = null; x.repository.fleet(f.base)
        assertNull(x.repository.state.value.unavailable); assertNull(x.repository.state.value.error)
        assertNotNull(x.repository.state.value.fleet); assertNotNull(x.repository.state.value.routes)
        x.noDispatch()
    }

    @Test fun `missing current policy keeps saved originals readable and unchanged`() = runBlocking {
        val x = Fixture(); val record = x.store.adopt(f.terminal(), f.policy); val saved = x.store.read()
        x.policy = null; runCatching { x.repository.open() }
        assertEquals(saved, x.repository.state.value.journal)
        x.repository.select(record.id); x.repository.check()
        assertEquals(saved.records, x.store.read().records)
        assertEquals(record.response, x.repository.state.value.selected?.response)
        assertEquals(0, x.keys); assertTrue(x.calls.all { it.first == "GET" })
    }

    @Test fun `cancellation remains cancellation and does not become a held service`() = runBlocking {
        val x = Fixture(); x.failure = CancellationException("cancelled read")
        assertSame(x.failure, runCatching { x.repository.fleet(f.base) }.exceptionOrNull())
        assertNull(x.repository.state.value.unavailable); assertNull(x.repository.state.value.error)
        assertFalse(x.repository.state.value.busy); x.noDispatch()
    }
}
