package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.ui.features.BuildingSelection
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureSelection
import org.junit.Assert.*
import org.junit.Test

/** Queue transport contracts only; no request grants action or payment authority. */
class HomeOpenRequestsTest {
    @Test fun `cross tab navigation expires every consecutive open for the abandoned host`() {
        val queue = HomeRequests(); val first = request()
        queue.request(first)
        queue.request(first.copy(resources = Destination.Resources("shards")))
        queue.request(HomeRequest.Tab(HomeTab.WORLD))
        assertEquals(HomeRequest.Tab(HomeTab.WORLD), queue.pending.value)
        queue.consume(HomeRequest.Tab(HomeTab.WORLD))
        assertNull(queue.pending.value)
    }

    @Test fun `selecting another Home tab expires queued opens before later navigation`() {
        val queue = HomeRequests(); val open = request()
        queue.request(open)
        queue.request(HomeRequest.BuildMenu)
        var selected = HomeTab.KINGDOM
        queue.selectHomeTab(HomeTab.WORLD) { selected = it }
        assertEquals(HomeTab.WORLD, selected)
        assertEquals(HomeRequest.BuildMenu, queue.pending.value)
        assertEquals(HomeRouteDispatchResult.NOT_HEAD, queue.dispatchOpen(open) { error("expired callback") })
    }

    @Test fun `a later explicit cross tab request expires a blocked open head`() {
        val queue = HomeRequests(); val open = request()
        queue.request(open)
        queue.request(HomeRequest.Tab(HomeTab.WORLD))
        assertEquals(HomeRequest.Tab(HomeTab.WORLD), queue.pending.value)
        queue.consume(HomeRequest.Tab(HomeTab.WORLD))
        assertNull(queue.pending.value)
    }

    @Test fun `a new same tab command supersedes a deferred open without replay`() {
        val queue = HomeRequests(); val open = request()
        queue.request(open)
        assertEquals(HomeRouteDispatchResult.DEFERRED, queue.dispatchOpen(open) { HomeRouteDispatchResult.DEFERRED })
        queue.request(HomeRequest.BuildMenu)
        assertEquals(HomeRequest.BuildMenu, queue.pending.value)
        assertEquals(HomeRouteDispatchResult.NOT_HEAD, queue.dispatchOpen(open) { error("expired callback") })
    }

    // Owner report 2026-10-11 (Seeker, code 34): one badge tap opened a Gold Forge request deferred long before. A later
    // door for another feature retires a deferred head; the same door, and a head Home has not seen yet, keep FIFO.
    @Test fun `a later open for another door supersedes a deferred open without replay`() {
        val queue = HomeRequests(); val open = request()
        queue.request(open)
        assertEquals(HomeRouteDispatchResult.DEFERRED, queue.dispatchOpen(open) { HomeRouteDispatchResult.DEFERRED })
        val later = open.copy(featureId = FeatureId("hud.profile"))
        queue.request(later)
        assertSame(later, queue.pending.value)
        assertEquals(HomeRouteDispatchResult.NOT_HEAD, queue.dispatchOpen(open) { error("expired callback") })

        val same = HomeRequests(); same.request(open); same.deferOpen(open)
        same.request(open.copy(resources = Destination.Resources("shards")))
        assertSame("the same door keeps its waiting head", open, same.pending.value)
    }

    @Test fun `reselecting the current host tab keeps its pending open`() {
        val queue = HomeRequests(); val open = request(); queue.request(open)
        queue.selectHomeTab(HomeTab.KINGDOM) {}
        assertEquals(open, queue.pending.value)
    }

    @Test fun `typed requests explicitly retain Kingdom or World as their host`() {
        val kingdom = request()
        val world = kingdom.copy(hostTab = HomeTab.WORLD)
        assertEquals(HomeTab.KINGDOM, kingdom.homeTab)
        assertEquals(HomeTab.WORLD, world.homeTab)
        assertEquals(world.hostTab, world.homeTab)
    }

    @Test fun `typed sheets reject every legacy Home tab as a host`() {
        for (tab in HomeTab.values().filter { it != HomeTab.KINGDOM && it != HomeTab.WORLD }) {
            assertThrows(IllegalArgumentException::class.java) { request().copy(hostTab = tab) }
        }
    }

    @Test fun `typed and legacy requests retain FIFO and only the head is consumed`() {
        val queue = HomeRequests()
        val open = request()
        queue.request(HomeRequest.Tab(HomeTab.KINGDOM))
        queue.request(open)
        queue.request(HomeRequest.Training)
        queue.consume(open)
        assertEquals(HomeRequest.Tab(HomeTab.KINGDOM), queue.pending.value)
        queue.consume(HomeRequest.Tab(HomeTab.KINGDOM))
        assertEquals(open, queue.pending.value)
        queue.consume(HomeRequest.Training)
        assertEquals(open, queue.pending.value)
        queue.consume(open)
        assertEquals(HomeRequest.Training, queue.pending.value)
        queue.consume(HomeRequest.Training)
        assertNull(queue.pending.value)
    }

    @Test fun `adjacent equal typed requests coalesce so later navigation remains observable`() {
        val queue = HomeRequests()
        val open = request()
        queue.request(open)
        queue.request(open.copy())
        queue.request(HomeRequest.BuildMenu)
        queue.consume(open)
        assertEquals(HomeRequest.BuildMenu, queue.pending.value)
        queue.consume(HomeRequest.BuildMenu)
        assertNull(queue.pending.value)
    }

    @Test fun `return to the same typed request after a legacy request is retained`() {
        val queue = HomeRequests()
        val open = request()
        queue.request(open)
        queue.request(HomeRequest.BuildMenu)
        queue.request(open)
        queue.consume(open)
        queue.consume(HomeRequest.BuildMenu)
        assertEquals(open, queue.pending.value)
        queue.consume(open)
        assertNull(queue.pending.value)
    }

    @Test fun `different resource focus and host are separate queued destinations`() {
        val original = request().copy(resources = Destination.Resources("shards"))
        for (next in listOf(original.copy(resources = Destination.Resources("keep")), original.copy(hostTab = HomeTab.WORLD))) {
            val queue = HomeRequests()
            queue.request(original)
            queue.request(next)
            queue.consume(original)
            assertEquals(next, queue.pending.value)
            queue.consume(next)
            assertNull(queue.pending.value)
        }
    }

    @Test fun `equal but distinct session references never coalesce queued requests`() {
        data class Session(val wallet: String)
        val firstSession = Session("same-wallet")
        val secondSession = Session("same-wallet")
        assertEquals(firstSession, secondSession)
        assertNotSame(firstSession, secondSession)
        val first = request().copy(identity = HomeRouteIdentity(firstSession, "base-a", 2))
        val second = first.copy(identity = HomeRouteIdentity(secondSession, "base-a", 2))
        assertNotEquals(first.identity, second.identity)
        assertNotEquals(first, second)
        val queue = HomeRequests()
        queue.request(first)
        queue.request(second)
        queue.consume(first)
        assertSame(second, queue.pending.value)
    }

    @Test fun `identity equality uses the same session reference base and generation`() {
        val session = Any()
        val identity = HomeRouteIdentity(session, "base-a", 2)
        val same = HomeRouteIdentity(session, "base-a", 2)
        assertEquals(identity, same)
        assertEquals(identity.hashCode(), same.hashCode())
        assertNotEquals(identity, HomeRouteIdentity(session, "base-b", 2))
        assertNotEquals(identity, HomeRouteIdentity(session, "base-a", 3))
    }

    @Test fun `base generation and selected building changes are never coalesced`() {
        val first = request()
        val nextRequests = listOf(first.copy(identity = HomeRouteIdentity(first.identity.session, "base-a", 3)),
            first.copy(selection = FeatureSelection(building = BuildingSelection("base-a", "building-b", "workshop"))))
        for (next in nextRequests) {
            val queue = HomeRequests()
            queue.request(first)
            queue.request(next)
            queue.consume(first)
            assertEquals(next, queue.pending.value)
        }
    }

    @Test fun `Army group requests retain Kingdom and other requests keep their established tabs`() {
        assertEquals(HomeTab.KINGDOM, HomeRequest.Training.homeTab)
        assertEquals(HomeTab.KINGDOM, HomeRequest.RaidChooser.homeTab)
        assertEquals(HomeTab.KINGDOM, HomeRequest.Campaign.homeTab)
        assertEquals(HomeTab.KINGDOM, HomeRequest.BuildMenu.homeTab)
        assertEquals(HomeTab.KINGDOM, HomeRequest.HeroBuildMenu.homeTab)
        assertEquals(HomeTab.KINGDOM, HomeRequest.Builders.homeTab)
        assertEquals(HomeTab.KINGDOM, HomeRequest.FocusBuilding("building-a").homeTab)
        for (tab in HomeTab.values()) assertEquals(tab, HomeRequest.Tab(tab).homeTab)
    }

    private fun request(): HomeRequest.Open = HomeRequest.Open(FeatureId("fixture.open"),
        HomeRouteIdentity(Any(), "base-a", 2),
        FeatureSelection(building = BuildingSelection("base-a", "building-a", "workshop")))
}
