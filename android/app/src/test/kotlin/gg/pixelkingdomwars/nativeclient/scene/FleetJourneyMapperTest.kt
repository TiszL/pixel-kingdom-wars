package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.FakeApiClient
import gg.pixelkingdomwars.nativeclient.data.FleetJourneyPublication
import gg.pixelkingdomwars.nativeclient.data.ServiceArtPermission
import gg.pixelkingdomwars.nativeclient.data.JOURNEY_BERTH
import gg.pixelkingdomwars.nativeclient.data.JOURNEY_INSTALLATION
import gg.pixelkingdomwars.nativeclient.data.journeyBase
import gg.pixelkingdomwars.nativeclient.model.CurrentFleetIdentity
import gg.pixelkingdomwars.nativeclient.renderer.RenderFleetInstallationIdentity
import gg.pixelkingdomwars.nativeclient.fleetjourney.FleetJourneyEvent
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.signedIn
import gg.pixelkingdomwars.nativeclient.testHolder
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import gg.pixelkingdomwars.nativeclient.renderer.RenderJourneyKind
import gg.pixelkingdomwars.nativeclient.renderer.RenderJourneyVehicle
import gg.pixelkingdomwars.nativeclient.renderer.RenderJourneyWake
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** N-C5 app bridge: root's strict event → the renderer's typed presentation, field for field. */
class FleetJourneyMapperTest {
    private fun id(n: Int) = "0000000$n-0000-4000-8000-000000000000"
    private val legacy = buildJsonObject { put("state", "legacy"); put("visual", JsonNull) }
    private val off = buildJsonObject { put("state", "available"); put("visual", buildJsonObject { put("version", 1); put("wake", JsonNull) }) }
    private val unavailable = buildJsonObject { put("state", "unavailable"); put("visual", JsonNull) }
    private val aurora = buildJsonObject { put("state", "available"); put("visual", buildJsonObject { put("version", 1); put("wake", buildJsonObject {
        put("version", 1); put("outputId", "aurora_wake"); put("sourceId", "auroraWake")
        put("sourceManifestSha256", "a".repeat(64)); put("sourceIndexSha256", "b".repeat(64)); put("bindingSha256", "c".repeat(64)) }) }) }
    private fun event(kind: String = "departure", family: String = "starter", tier: Int? = null, wake: JsonObject = legacy) = FleetJourneyEvent.from(buildJsonObject {
        put("version", 1); put("kind", kind); put("baseId", id(1)); put("berthId", id(2)); put("installationId", id(3)); put("expeditionId", id(4))
        put("at", "2026-10-01T04:00:00.000Z"); put("vehicle", buildJsonObject { put("family", family); tier?.let { put("tier", it) } }); put("wake", wake)
        if (kind == "return") put("returnId", id(5))
    })

    @Test fun `maps kind, identities, vehicle and the producer's dedup key without reinterpretation`() {
        val departure = renderFleetJourney(event())
        assertEquals(RenderJourneyKind.DEPARTURE, departure.kind); assertEquals(id(1), departure.baseId); assertEquals(id(2), departure.berthId)
        assertEquals(id(3), departure.installationId); assertEquals(RenderJourneyVehicle("starter", null), departure.vehicle)
        assertEquals("departure:starter:${id(4)}", departure.key)
        val back = renderFleetJourney(event("return", "survey_balloon", 2, aurora))
        assertEquals(RenderJourneyKind.RETURN, back.kind); assertEquals(RenderJourneyVehicle("survey_balloon", 2), back.vehicle)
        assertEquals("return:survey_balloon:${id(5)}", back.key)
    }

    @Test fun `keeps legacy, Off, unavailable and available Wake captures distinct and copies the exact binding hashes`() {
        assertEquals(RenderJourneyWake.Legacy, renderFleetJourney(event(wake = legacy)).wake)
        assertEquals(RenderJourneyWake.Off, renderFleetJourney(event(wake = off)).wake)
        assertEquals(RenderJourneyWake.Unavailable, renderFleetJourney(event(wake = unavailable)).wake)
        assertEquals(RenderJourneyWake.Available("aurora_wake", "c".repeat(64), "a".repeat(64), "b".repeat(64)), renderFleetJourney(event(wake = aurora)).wake)
    }

    // ---- R1: the scene host's pure lease guard (SceneHost itself needs an Activity) ----
    private class Host { var services: Any? = Any(); var generation = 0L }
    /** The fragment as the guard sees it; [show] applies KingdomFragment's synchronous scope rule (journeyScopeChanged). */
    private class Frag { var renderer: Any? = Any(); var generation = 0L; var resumed = true; var baseId: String? = "A"; var battle = false
        fun pauseResume() { generation += 1 }; fun replaceRenderer() { generation += 1; renderer = Any() }
        fun show(baseId: String?, battle: Boolean) { if (journeyScopeChanged(this.baseId, this.battle, baseId, battle)) generation += 1; this.baseId = baseId; this.battle = battle } }

    @Test fun `R1 lease guard - current only for the exact service record, host generation, ONE fragment, its exact renderer and its lifecycle generation - nothing revives`() {
        val host = Host(); val frag = Frag(); val other = Frag()
        val guard = FleetJourneyLeaseGuard({ host.services }, { host.generation }, { f -> (f as Frag).resumed }, { f -> (f as Frag).renderer }, { f -> (f as Frag).generation })
        assertFalse(guard.isCurrent()); assertNull(guard.target()); assertNull(guard.renderer())
        val boundRenderer = frag.renderer!!
        guard.bind(host.services!!, Any(), frag, boundRenderer, frag.generation)
        assertTrue(guard.isCurrent()); assertSame(frag, guard.target()); assertSame(boundRenderer, guard.renderer())
        // The fragment paused and resumed between two observations: its generation advanced, so the lease stays dead — no false→true revival.
        frag.resumed = false; assertFalse(guard.isCurrent()); frag.pauseResume(); frag.resumed = true
        assertFalse("pause→resume advances the fragment generation; the old lease never revives", guard.isCurrent())
        // Rebind on the resumed fragment, then a renderer replacement (new identity, generation advance) ends it for good.
        guard.bind(host.services!!, Any(), frag, frag.renderer!!, frag.generation); assertTrue(guard.isCurrent())
        frag.replaceRenderer(); assertFalse(guard.isCurrent()); assertNull(guard.renderer())
        // Same-owner source/permission replacement produces a new service record: never current again; restoring it does not help.
        guard.bind(host.services!!, Any(), frag, frag.renderer!!, frag.generation); assertTrue(guard.isCurrent())
        val record = host.services; host.services = Any(); assertFalse(guard.isCurrent()); host.services = record; assertTrue(guard.isCurrent())
        host.generation += 1; assertFalse("a host revocation generation advance alone revokes", guard.isCurrent())
        // Only the bound fragment is a target; a different fragment never is.
        guard.bind(host.services!!, Any(), frag, frag.renderer!!, frag.generation); assertTrue(guard.isCurrent())
        assertNotSame(other, guard.target()); assertSame(frag, guard.target())
        // Revocation is final.
        guard.revoke(); assertFalse(guard.isCurrent()); assertNull(guard.target()); assertNull(guard.renderer())
        host.generation -= 1; assertFalse("restoring the old generation revives nothing", guard.isCurrent())
    }

    @Test fun `R1c scope rule - base identity or Home-battle mode transitions invalidate, a same-base Home refresh does not`() {
        assertFalse("same-base Home snapshot refresh", journeyScopeChanged("A", false, "A", false))
        assertFalse("battle revision replacement on the same base", journeyScopeChanged("A", true, "A", true))
        assertTrue("base A to base B", journeyScopeChanged("A", false, "B", false))
        assertTrue("base shown to none", journeyScopeChanged("A", false, null, false)); assertTrue("none to base", journeyScopeChanged(null, false, "A", false))
        assertTrue("Home to battle", journeyScopeChanged("A", false, "A", true)); assertTrue("battle to Home", journeyScopeChanged("A", true, "A", false))
    }

    @Test fun `R1c lease guard - away-and-back with NO observation in between never revives the warm lease`() {
        val host = Host()
        fun bound(frag: Frag): FleetJourneyLeaseGuard {
            val guard = FleetJourneyLeaseGuard({ host.services }, { host.generation }, { f -> (f as Frag).let { it.resumed && it.baseId == "A" && !it.battle } }, { f -> (f as Frag).renderer }, { f -> (f as Frag).generation })
            guard.bind(host.services!!, Any(), frag, frag.renderer!!, frag.generation); assertTrue(guard.isCurrent()); return guard
        }
        // Base A -> base B -> base A on the same resumed fragment, no predicate read while away: dead for good.
        val frag = Frag(); val guard = bound(frag)
        frag.show("B", false); frag.show("A", false)
        assertFalse("A -> B -> A without observation", guard.isCurrent()); assertNull(guard.target())
        // Home -> battle -> Home on the same base, no observation while in battle: dead for good.
        val second = Frag(); val battleGuard = bound(second)
        second.show("A", true); second.show("A", false)
        assertFalse("Home -> battle -> Home without observation", battleGuard.isCurrent())
        // An ordinary same-base Home snapshot refresh keeps the lease current.
        val third = Frag(); val refreshGuard = bound(third)
        third.show("A", false); third.show("A", false)
        assertTrue("same-base refresh is not a scope change", refreshGuard.isCurrent())
        // While IN battle the predicate itself is false; coming back does not revive either.
        third.show("A", true); assertFalse(refreshGuard.isCurrent()); third.show("A", false); assertFalse(refreshGuard.isCurrent())
    }

    // ---- N-C5 RESIDENCY: the private host eligibility decision (pure; SceneHost needs an Activity) ----
    @Test fun `eligibility needs the owner's enabled record, exactly ONE current fragment, its exact renderer and a PREPARED generation - any mismatch yields nothing`() {
        class Frag(var current: Boolean = true, var renderer: Any? = Any(), var prepared: Boolean = true)
        val bound = Any(); val frag = Frag()
        fun eligible(record: Any? = bound, fragments: List<Frag> = listOf(frag)) =
            fleetJourneyEligibility(record, fragments, { f -> (f as Frag).current }, { f -> (f as Frag).renderer }, { r -> fragments.single { it.renderer === r }.prepared })
        assertSame("the exact renderer object is returned", frag.renderer, eligible())
        assertNull("no enabled record for this owner", eligible(record = null))
        frag.current = false; assertNull("no current Home fragment", eligible()); frag.current = true
        assertNull("two current fragments are ambiguous", eligible(fragments = listOf(frag, Frag())))
        assertSame(frag.renderer, eligible(fragments = listOf(frag, Frag(current = false))))
        frag.renderer = null; assertNull("a fragment without a renderer", eligible()); frag.renderer = Any()
        frag.prepared = false; assertNull("an unprepared generation", eligible()); frag.prepared = true
        assertSame(frag.renderer, eligible())
        // Replacing the renderer object changes the eligible identity; the old one is never returned.
        val old = frag.renderer; frag.renderer = Any(); assertNotSame(old, eligible()); assertSame(frag.renderer, eligible())
    }

    // ---- N-C5 CONTENT-MOUNT: the idempotent publication reconciliation decision (pure) ----
    @Test fun `publication reconciliation keeps a warm same-base lease, attaches late only when eligible, revokes on base loss or change`() {
        // Unchanged owner/base/content and a current lease across an ordinary same-base preparation: KEEP (warmth preserved).
        assertEquals(FleetPublicationDecision.KEEP, fleetPublicationDecision(leaseCurrent = true, leaseBaseId = "A", baseIdNow = "A", eligible = true))
        assertEquals(FleetPublicationDecision.KEEP, fleetPublicationDecision(true, "A", "A", eligible = false))
        // No lease yet: attach late only once the host is eligible (prepared admission for this base); otherwise nothing.
        assertEquals(FleetPublicationDecision.ATTACH, fleetPublicationDecision(false, null, "A", eligible = true))
        assertEquals(FleetPublicationDecision.NONE, fleetPublicationDecision(false, null, "A", eligible = false))
        // The shown base changed or vanished: the old lease is revoked (never re-targeted); nothing attaches cold here.
        assertEquals(FleetPublicationDecision.REVOKE, fleetPublicationDecision(true, "A", "B", eligible = true))
        assertEquals(FleetPublicationDecision.REVOKE, fleetPublicationDecision(true, "A", null, eligible = true))
        assertEquals(FleetPublicationDecision.NONE, fleetPublicationDecision(false, null, null, eligible = true))
        // A dead lease for the same base is not warm: it is replaced only through an eligible attach.
        assertEquals(FleetPublicationDecision.ATTACH, fleetPublicationDecision(false, "A", "A", eligible = true))
        assertEquals(FleetPublicationDecision.NONE, fleetPublicationDecision(false, "A", "A", eligible = false))
    }

    // ---- N-C5 CONTENT-MOUNT R1: the ACTUAL scene-refresh routing through the EXISTING permission observer and publication ----
    /** The host's publication handling exactly as servicePermission / reconcileFleetJourneys / onJourneyInvalidate perform it, on the
     *  accepted guard, decision and publication: a published false revokes; a published true revokes then decides (ATTACH when the
     *  resumed Home fragment shows the account's base with no battle). [show] is the production effect in its order: the refresh request
     *  from the previous state, then the fragment setters (scope rule); Main dispatches the collector afterwards (the test's runCurrent). */
    private class Mount(val publication: FleetJourneyPublication, val requests: ServiceRefreshRequests, val host: Host, val frag: Frag) {
        var lease: FleetJourneyPublication.Lease? = null; var guard: FleetJourneyLeaseGuard? = null
        val published = mutableListOf<Boolean>()
        fun revoke() { host.generation += 1; guard?.revoke(); lease?.close(); lease = null; guard = null }
        fun permission(enabled: Boolean) {
            published += enabled; revoke()
            val eligible = enabled && frag.resumed && !frag.battle && frag.baseId == BASE_ID
            if (fleetPublicationDecision(guard?.isCurrent() == true, null, BASE_ID, eligible) == FleetPublicationDecision.ATTACH) attach()
        }
        private fun attach() {
            val g = FleetJourneyLeaseGuard({ host.services }, { host.generation }, { f -> (f as Frag).let { it.resumed && it.baseId == BASE_ID && !it.battle } }, { f -> (f as Frag).renderer }, { f -> (f as Frag).generation })
            g.bind(host.services!!, Any(), frag, frag.renderer!!, frag.generation)
            lease = publication.attach(Any(), BASE_ID, Any(), g::isCurrent) { }; guard = g
        }
        fun show(baseId: String?, battle: Boolean) {
            requests.requestSceneRefresh(frag.baseId, frag.battle, baseId, battle)
            val generation = frag.generation; frag.show(baseId, battle); if (frag.generation != generation) revoke()
        }
        fun warm(base: BaseSnapshot) { publication.publishReturns(null, base, publication.capture(BASE_ID, base)) { true } }
        fun isWarm(base: BaseSnapshot) = publication.capture(BASE_ID, base)?.wasWarm == true
    }

    @Test fun `R1 same-base preparation keeps the warm lease - resume, genuine false, identity and mode still revoke`() = runTest {
        val holder = testHolder(); val session = signedIn(holder); val base = BaseSnapshot.from(journeyBase())
        val api = FakeApiClient(); var permitted = true
        api.onGet("/native/capabilities") { Json.parseToJsonElement("""{"protocolVersion":1,"simVersion":17,"phaseEArt":{"version":1,"enabled":$permitted}}""").jsonObject }
        val requests = ServiceRefreshRequests() // the production routing object SceneHost owns
        val mount = Mount(FleetJourneyPublication(session, holder), requests, Host(), Frag().apply { baseId = BASE_ID })
        val permission = ServiceArtPermission(api, {}) { mount.permission(it) } // the accepted observer: false first, then the read
        var ordinary = 0L
        val fifteen = launch { requests.serviceRefreshRequests.collectLatest { ordinary += 1 } } // the plain service signal; contract 15 collected it before both contracts moved to the capability signal
        val seventeen = launch { requests.capabilityRefreshRequests.collectLatest { permission.refresh() } } // the bound-17 collection
        runCurrent()
        // Binding: the initial observation (false, then the read) attaches cold; an ordinary Home read then warms the publication.
        assertEquals(listOf(false, true), mount.published); val first = requireNotNull(mount.lease); assertEquals(1L, ordinary)
        assertFalse(mount.isWarm(base)); mount.warm(base); assertTrue(mount.isWarm(base))
        // The ACTUAL trigger for another SAME-BASE Home scene: service art refreshes (15 unchanged) but capability is NOT re-observed,
        // so no false-first revocation — THAT lease is retained and the publication stays warm.
        mount.show(BASE_ID, false); runCurrent()
        assertEquals("the existing service refresh still fires", 2L, ordinary)
        assertEquals("no false-first re-observation for a same-base preparation", listOf(false, true), mount.published)
        assertSame("the same lease is retained", first, mount.lease); assertTrue(mount.isWarm(base))
        // Explicit foreground/lifecycle (fragment resume) still re-observes: false first, then a cold re-attach.
        requests.requestServiceRefresh(); runCurrent()
        assertEquals(listOf(false, true, false, true), mount.published); assertNotSame(first, mount.lease); assertFalse(mount.isWarm(base))
        // A genuine false revokes immediately and nothing re-attaches; a later true attaches cold again.
        permitted = false; requests.requestServiceRefresh(); runCurrent()
        assertEquals(listOf(false, true, false, true, false, false), mount.published); assertNull(mount.lease)
        permitted = true; requests.requestServiceRefresh(); runCurrent(); requireNotNull(mount.lease); mount.warm(base); assertTrue(mount.isWarm(base))
        // A base-identity transition revokes synchronously (scope rule) AND re-observes; the account's base is not shown, so nothing attaches.
        mount.show("other-base", false); runCurrent()
        assertEquals(listOf(false, true, false, true, false, false, false, true, false, true), mount.published); assertNull(mount.lease)
        mount.show(BASE_ID, false); runCurrent(); val back = requireNotNull(mount.lease) // identity change back: re-observed, attached cold
        // A Home -> battle mode transition on the same base revokes synchronously AND re-observes; in battle nothing attaches.
        mount.show(BASE_ID, true); runCurrent()
        assertEquals(14, mount.published.size); assertNull(mount.lease); assertFalse(back === mount.lease)
        fifteen.cancel(); seventeen.cancel(); permission.close()
    }

    // ---- CONTINUITY: the current-only identity parsed from ONE body against its own facts → typed renderer rows (current Home only) ----
    @Test fun `identity rows come from the same body's starter and advanced identities, refuse contradiction, and frozen stays null`() {
        val starter = BaseSnapshot.from(journeyBase())
        val identity = CurrentFleetIdentity.current(starter.raw, starter.baseId, starter.servicePresentation, starter.advancedServicePresentation)
        assertEquals(listOf(RenderFleetInstallationIdentity(JOURNEY_BERTH, JOURNEY_INSTALLATION, "starter", null)), renderFleetIdentity(identity))
        val advanced = BaseSnapshot.from(journeyBase(family = "survey_balloon", tier = 2))
        assertEquals(listOf(RenderFleetInstallationIdentity(JOURNEY_BERTH, JOURNEY_INSTALLATION, "survey_balloon", 2)),
            renderFleetIdentity(CurrentFleetIdentity.current(advanced.raw, advanced.baseId, advanced.servicePresentation, advanced.advancedServicePresentation)))
        val missing = BaseSnapshot.from(journeyBase(identityInstallationId = null))
        assertNull("an occupied berth without its identity is unknown", renderFleetIdentity(CurrentFleetIdentity.current(missing.raw, missing.baseId, missing.servicePresentation, missing.advancedServicePresentation)))
        assertNull("frozen entries never carry identity", renderFleetIdentity(null))
    }
}
