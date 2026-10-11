package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.StarterFleetReview
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetCommand
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetRequest
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetOperation
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetProof
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetReceipt
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetRefusal
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyageFx
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.BackRegistry
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class HomeStarterFleetReviewTest {
    @Test fun `free starter opens the existing review and only explicit confirmation reaches confirm`() = runTest {
        val f = Fixture()
        assertTrue(f.control.open())
        assertEquals(listOf("review:berth-1"), f.calls)
        val review = requireNotNull(f.control.review)
        assertSame(f.state.review, review)
        assertTrue(f.control.confirm(review))
        assertEquals(listOf("review:berth-1", "confirm"), f.calls)
        assertFalse(f.control.confirm(review))
        assertEquals(1, f.calls.count { it == "confirm" })
    }

    @Test fun `stale base generation or blocked admission never starts or confirms an install`() = runTest {
        val f = Fixture(); f.allowed = false
        assertFalse(f.control.open()); assertTrue(f.calls.isEmpty())
        f.allowed = true; assertTrue(f.control.open())
        val review = requireNotNull(f.control.review)
        f.current = f.identity.copy(baseSelectionGeneration = 3)
        assertFalse(f.control.confirm(review)); assertEquals(listOf("review:berth-1"), f.calls)
        assertNull(f.control.review)
    }

    @Test fun `cancel dismisses the exact owned review without confirming or borrowing another review`() = runTest {
        val f = Fixture(); assertTrue(f.control.open())
        f.control.cancel(); assertNull(f.state.review)
        assertEquals(listOf("review:berth-1", "dismiss"), f.calls)
        val other = f.makeReview(); f.state = f.state.copy(review = other)
        f.control.cancel(); assertSame(other, f.state.review)
        assertFalse(f.control.open()); assertEquals(2, f.calls.size)
    }

    @Test fun `review returning after identity changed is retired and cannot appear on another base`() = runTest {
        val f = Fixture(); f.afterReview = { f.current = null }
        assertFalse(f.control.open()); assertNull(f.control.review); assertNull(f.state.review)
        assertEquals(listOf("review:berth-1", "dismiss"), f.calls)
    }

    @Test fun `free review uses the designed boat to berth art without a fee or signing promise`() {
        val f = Fixture(); val ui = homeStarterFleetSeal(f.makeReview(), false, 123L)
        assertNull(ui.network); assertNull(ui.cut); assertNull(ui.shortLine)
        assertFalse(ui.free) // The generic free flag says 'You sign once'; this owner has no signature.
        assertEquals("No wallet signature is needed.", ui.note)
        assertEquals("INSTALL FREE", ui.confirmLabel)
        assertEquals(123L, ui.armedAtMs)
    }

    @Test fun `busy review refuses confirmation and ordinary Back while lifecycle retirement dismisses it`() = runTest {
        val f = Fixture(); assertTrue(f.control.open())
        val review = requireNotNull(f.control.review)
        val journal = f.state.journal
        f.state = f.state.copy(busy = true)
        assertFalse(f.control.confirm(review))
        f.allowed = false // A transient admission blip during confirmation must not invalidate its epoch.
        f.control.cancel(); assertSame(review, f.state.review)
        f.control.cancel(force = true); assertNull(f.state.review)
        assertSame(journal, f.state.journal)
        assertEquals(listOf("review:berth-1", "dismiss"), f.calls)
    }

    @Test fun `lost admission after the owner returns dismisses the review before it can be confirmed`() = runTest {
        val f = Fixture(); f.afterReview = { f.allowed = false }
        assertFalse(f.control.open()); assertNull(f.control.review); assertNull(f.state.review)
        assertEquals(listOf("review:berth-1", "dismiss"), f.calls)
    }

    @Test fun `a replaced review cannot be confirmed through the previously rendered review`() = runTest {
        val f = Fixture(); assertTrue(f.control.open())
        val rendered = requireNotNull(f.control.review)
        val replacement = f.makeReview(); f.state = f.state.copy(review = replacement)
        assertFalse(f.control.confirm(rendered)); assertNull(f.control.review)
        f.control.cancel(); assertSame(replacement, f.state.review)
        assertEquals(listOf("review:berth-1"), f.calls)
    }

    @Test fun `only this seal Back registration is exempt from its own admission blocker`() {
        val registry = BackRegistry(); val presence = HomeStarterReviewPresence()
        val own = registry.register(BackPriority.CONFIRM) {}
        presence.back = own
        assertTrue(presence.ownsBack(registry.active()))
        val other = registry.register(BackPriority.CONFIRM) {}
        assertFalse(presence.ownsBack(registry.active()))
        registry.unregister(other)
        assertTrue(presence.ownsBack(registry.active()))
        registry.unregister(own)
        assertFalse(presence.ownsBack(registry.active()))
    }

    @Test fun `accepted or refused starter outcomes hand off to the existing archive owner without a new install`() = runTest {
        for (accepted in listOf(true, false)) {
            val f = Fixture(); val review = f.makeReview()
            val receipt = StarterFleetReceipt(VoyageFx.WALLET, review.command.request, VoyageFx.starterInstallation, review.view.serverNow)
            val operation = StarterFleetOperation(review.command, 1L,
                if (accepted) StarterFleetProof(VoyageFx.WALLET, review.command.key, review.view.serverNow, "accepted", receipt) else null,
                if (accepted) null else StarterFleetRefusal(409, "STARTER_BERTH_OCCUPIED"))
            f.state = f.state.copy(journal = f.state.journal.copy(operation = operation))
            assertFalse(f.control.open()); assertTrue(f.calls.isEmpty())
            val journal = f.state.journal
            assertTrue(f.control.openSavedOutcome { f.calls += "archiveOwner" })
            assertSame(journal, f.state.journal); assertEquals(listOf("archiveOwner"), f.calls)
            f.allowed = false; assertFalse(f.control.openSavedOutcome { fail("Blocked handoff") })
            f.allowed = true; f.state = f.state.copy(busy = true)
            assertFalse(f.control.openSavedOutcome { fail("Busy handoff") })
            f.state = f.state.copy(busy = false, review = review)
            assertFalse(f.control.openSavedOutcome { fail("Active review handoff") })
            f.state = f.state.copy(review = null); f.current = null
            assertFalse(f.control.openSavedOutcome { fail("Stale handoff") })
            f.current = f.identity; f.state = f.state.copy(journal = journal.copy(operation = operation.copy(proof = null, refusal = null)))
            assertFalse(f.control.openSavedOutcome { fail("Unresolved receipt must be checked, not archived") })
        }
    }

    @Test fun `foreign kingdom draft or pending starter request reaches its existing recovery owner unchanged`() = runTest {
        for (attempt in listOf<Long?>(null, 1L)) {
            val f = Fixture(); val command = f.makeReview().command.let { it.copy(request = it.request.copy(baseId = "original-kingdom")) }
            val original = StarterFleetOperation(command, attempt, null, null)
            f.state = f.state.copy(journal = f.state.journal.copy(operation = original))
            assertFalse(f.control.open()); assertTrue(f.calls.isEmpty())
            assertTrue(f.control.openSavedOutcome { f.calls += "recoveryOwner" })
            assertSame(original, f.state.journal.operation)
            assertEquals(listOf("recoveryOwner"), f.calls)
            f.current = f.identity.copy(baseSelectionGeneration = 3)
            assertFalse(f.control.openSavedOutcome { fail("Stale foreign handoff") })
            assertSame(original, f.state.journal.operation)
        }
    }

    private class Fixture {
        val identity = HomeRouteIdentity(Any(), VoyageFx.BASE, 2)
        var current: HomeRouteIdentity? = identity
        var allowed = true
        var state = VoyageFx.starterFleet(installation = null)
        val calls = mutableListOf<String>()
        var afterReview: () -> Unit = {}
        fun makeReview(): StarterFleetReview {
            val view = requireNotNull(state.view); val berth = view.eligibleBerths.single()
            return StarterFleetReview(StarterFleetCommand(StarterFleetRequest("saved-key", identity.baseId, berth.berthId), berth, null), view, 0, 2)
        }
        val control = HomeStarterFleetReviewController(identity, { current }, { allowed }, { state }, { "berth-1" },
            reviewInstall = { id -> calls += "review:$id"; state = state.copy(review = makeReview()); afterReview() },
            reviewSaved = { calls += "saved" }, confirmReview = { calls += "confirm"; state = state.copy(review = null) },
            dismissReview = { calls += "dismiss"; state = state.copy(review = null) })
    }
}
