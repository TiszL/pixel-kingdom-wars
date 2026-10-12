package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureRegistry
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureSelection
import gg.pixelkingdomwars.nativeclient.ui.features.GateContext
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File
import org.junit.Assert.*
import org.junit.Test

/**
 * Owner report 2026-10-11 (Seeker, code 34, production with Phase E Group A and Gems on): a tap on the Home level badge
 * ("Menu and profile") did nothing, and a single tap later opened a stale Gold Forge INFO request instead. Why it matters:
 * the badge is the Menu, the one door to Settings, sign-out and base selection, so it must reach Profile in every state;
 * a HUD door must never wait without a word; and a door the player asked for long ago must never open behind a newer tap.
 * The host here is wired as PkwApp wires it: blocked = routeAdmissionBlocked || reviewBlocked || bodyReviewBlocked.
 */
class HomeHudDoorDeferralTest {
    private class Fixture {
        val identity = HomeRouteIdentity(Any(), "base-a", 4)
        var current: HomeRouteIdentity? = identity
        var admission = false
        var body: () -> Boolean = { false }
        /** HomeScaffold.openHudFeature: handleFeatureDoor false falls back to the door's standalone route (ProfileRoute, ...). */
        val standalone = mutableListOf<String>()
        /** PkwApp's legacy door for a deferred badge request (ProfileRoute). */
        var legacyProfile = 0
        val reasons = mutableListOf<String>()
        val opened = mutableListOf<Destination>()
        val logged = mutableListOf<String>()
        val requests = HomeRequests()
        val host = HomeSheetRouteHost({ current }, { admission }, { reasons += it },
            bodyReviewBlocked = { body() },
            legacyFeature = { id -> if (id.value == "hud.profile") { legacyProfile++; true } else false },
            deferralDetail = { homeHeldTerms(listOf("harvester.holding" to { body() })) },
            debugLog = { logged += it })
        val mount = host.attach(identity, openLeague = { opened += it }, closeSceneSheet = { false }, openBody = { opened += it })
        val dispatcher = HomeRouteDispatcher(requests, FeatureRegistry.canonical(),
            { current?.let { HomeRouteContext(it, GateContext(baseId = it.baseId)) } }, host)

        /** PkwApp's commit-phase SideEffect. */
        fun publish() = mount.reportBlocked(admission || body())
        fun tap(id: String): Boolean = dispatcher.handleFeatureDoor(FeatureId(id)).also { if (!it) standalone += id }
        val head: HomeRequest.Open? get() = requests.pending.value as? HomeRequest.Open
    }

    @Test fun `a body review with admission clear sends the badge to the standalone Profile at the tap`() {
        val f = Fixture(); f.body = { true }; f.publish()
        assertFalse(f.host.canOpen(PROFILE, HomeTab.KINGDOM))
        f.tap("hud.profile")
        assertEquals("HomeScaffold's ProfileRoute fallback", listOf("hud.profile"), f.standalone)
        assertNull("nothing queued to replay later", f.requests.pending.value)
        assertTrue(f.opened.isEmpty()); assertTrue(f.reasons.isEmpty())
    }

    @Test fun `a body review arriving after the badge tap falls back to Profile instead of deferring silently`() {
        val f = Fixture(); f.publish()
        f.tap("hud.profile")
        val request = requireNotNull(f.head)
        f.body = { true } // e.g. harvesterReviewController.holding, before the SideEffect republishes
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertEquals(1, f.legacyProfile)
        assertNull("the handled request is consumed, never replayed", f.requests.pending.value)
        assertTrue(f.opened.isEmpty()); assertTrue(f.reasons.isEmpty())
        f.body = { false }; f.publish()
        f.tap("hud.profile")
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(requireNotNull(f.head)))
        assertEquals("admitted, the designed Profile sheet opens in place", listOf<Destination>(Destination.Profile()), f.opened)
    }

    @Test fun `both badge fallbacks are the standalone ProfileRoute`() {
        val main = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient")
        val scaffold = File(main, "ui/home/HomeScaffold.kt").readText()
        val app = File(main, "ui/nav/PkwApp.kt").readText()
        assertTrue(scaffold.contains("\"hud.profile\" -> menuActions.run(onProfile)"))
        assertTrue(app.contains("onProfile = { navController.navigate(ProfileRoute) { launchSingleTop = true } }"))
        assertTrue("the host's legacy door for a deferred badge request",
            app.contains("if (id.value == \"hud.profile\") { navController.navigate(ProfileRoute) { launchSingleTop = true }; true }"))
    }

    @Test fun `a projection with a stale identity does not hold the badge`() {
        val f = Fixture()
        val older = HomeRouteIdentity(f.identity.session, f.identity.baseId, f.identity.baseSelectionGeneration - 1)
        // Its owner still has a review saved, but for a base generation that is no longer current.
        val stale = HomeOwnerProjection(MutableStateFlow("review saved"), older, { f.current }, { true }, { true })
        f.body = { stale.reviewBlocked }; f.publish()
        assertFalse(f.host.dispatchBlocked.value)
        assertTrue(f.tap("hud.profile"))
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(requireNotNull(f.head)))
        assertEquals(listOf<Destination>(Destination.Profile()), f.opened)
        assertTrue(f.standalone.isEmpty()); assertTrue(f.reasons.isEmpty())
        val mine = HomeOwnerProjection(MutableStateFlow("review saved"), f.identity, { f.current }, { true }, { true })
        assertTrue("the current owner's review still blocks", mine.reviewBlocked)
    }

    @Test fun `Mail and Leagues deferred say they are waiting and still open once`() {
        for ((id, name, destination) in listOf(Triple("hud.mail", "Mail", Destination.Mail), Triple("hud.leagues", "Leagues", Destination.Leagues()))) {
            val f = Fixture(); f.publish()
            assertTrue(f.tap(id))
            val request = requireNotNull(f.head)
            f.body = { true }; f.publish()
            assertEquals(id, HomeRouteDispatchResult.DEFERRED, f.dispatcher.consume(request))
            assertSame("kept for a fresh gate check, not refused", request, f.requests.pending.value)
            assertEquals(listOf("$name is waiting for the current review or read to finish."), f.reasons)
            assertTrue(f.opened.isEmpty())
            f.body = { false }; f.publish()
            assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
            assertEquals(listOf(destination), f.opened)
            assertEquals("one explanation, no refusal", 1, f.reasons.size)
        }
    }

    @Test fun `a Mail tap while Home is blocked explains at the tap`() {
        val f = Fixture(); f.body = { true }; f.publish()
        assertTrue(f.tap("hud.mail"))
        assertEquals(FeatureId("hud.mail"), f.head?.featureId)
        assertEquals(listOf("Mail is waiting for the current review or read to finish."), f.reasons)
    }

    @Test fun `a deferral logs which body review term held, once per request and cause`() {
        val f = Fixture(); f.publish()
        f.tap("hud.mail")
        val request = requireNotNull(f.head)
        f.body = { true }; f.publish()
        f.dispatcher.consume(request); f.dispatcher.consume(request)
        assertEquals(listOf("deferred hud.mail mount=blocked admission=false kingdomReview=false body=harvester.holding"), f.logged)
        assertEquals("body=none", homeHeldTerms(listOf("harvester.holding" to { false })))
    }

    @Test fun `a stale deferred Gold Forge request is not replayed by a later badge tap`() {
        val f = Fixture(); f.publish()
        val forge = HomeRequest.Open(FeatureId("goldforge.open"), f.identity, FeatureSelection())
        f.requests.request(forge)
        // The consume effect saw it and it waited (PkwApp marks the head deferred before every consume).
        assertEquals(HomeRouteDispatchResult.DEFERRED, f.requests.dispatchOpen(forge) { HomeRouteDispatchResult.DEFERRED })
        assertTrue(f.tap("hud.profile"))
        assertEquals(PROFILE, f.head?.featureId)
        assertEquals(HomeRouteDispatchResult.NOT_HEAD, f.requests.dispatchOpen(forge) { error("Gold Forge replayed behind the badge") })
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(requireNotNull(f.head)))
        assertEquals(listOf<Destination>(Destination.Profile()), f.opened)
        assertNull(f.requests.pending.value)
    }

    @Test fun `a badge tap that falls back to Profile also retires the waiting Gold Forge request`() {
        val f = Fixture(); f.publish()
        val forge = HomeRequest.Open(FeatureId("goldforge.open"), f.identity, FeatureSelection())
        f.requests.request(forge)
        f.requests.deferOpen(forge)
        f.body = { true }; f.publish()
        f.tap("hud.profile")
        assertEquals(listOf("hud.profile"), f.standalone)
        assertNull("the review closing later cannot open the old Gold Forge request", f.requests.pending.value)
    }

    @Test fun `the same door and a head Home has not seen yet keep their place`() {
        val f = Fixture(); f.publish()
        val forge = HomeRequest.Open(FeatureId("goldforge.open"), f.identity, FeatureSelection())
        f.requests.request(forge)
        f.tap("hud.mail")
        assertSame("not yet seen by Home: FIFO as before", forge, f.requests.pending.value)
        val mail = HomeRequests()
        val again = HomeRequest.Open(FeatureId("hud.mail"), f.identity, FeatureSelection())
        mail.request(again); mail.deferOpen(again)
        mail.supersedeDeferredOpen(FeatureId("hud.mail"))
        assertSame("a repeat of the waiting door keeps it", again, mail.pending.value)
    }

    private companion object { val PROFILE = FeatureId("hud.profile") }
}
