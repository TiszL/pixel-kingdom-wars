package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionReview
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionCommand
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionRequest
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionOperation
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionProof
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionReceipt
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionArchive
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyageFx
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/** AUTHORED / UNRUN: execution belongs to Cedar3. */
class HomeVoyageCommandsTest {
    @Test fun `retired sheet cannot detach the replacement visibility lease`() {
        val visible = HomeVoyageVisibility()
        val identity = HomeRouteIdentity(Any(), VoyageFx.BASE, 2)
        val old = visible.attach(identity)
        val replacement = visible.attach(identity)
        visible.detach(old)
        assertTrue(visible.isCurrent(identity))
        assertFalse(visible.isCurrent(identity.copy(baseSelectionGeneration = 3)))
        visible.detach(replacement)
        assertFalse(visible.isCurrent(identity))
    }

    @Test fun `starter SEND reviews in place and confirms only the exact rendered review once`() = runTest {
        val f = Fixture()
        assertTrue(f.controller.open("coastal_survey"))
        assertEquals(listOf("review:coastal_survey"), f.calls)
        val review = requireNotNull(f.controller.review)
        assertTrue(f.controller.confirm(review))
        assertFalse(f.controller.confirm(review))
        assertEquals(listOf("review:coastal_survey", "confirm"), f.calls)
    }

    @Test fun `same base unsent draft is reviewed under its original key`() = runTest {
        val f = Fixture()
        val command = f.makeReview().command
        f.state = f.state.copy(journal = f.state.journal.copy(operation = StarterExpeditionOperation(command, null, null, null)))
        assertTrue(f.controller.open("coastal_survey"))
        assertEquals(listOf("saved"), f.calls)
        assertSame(command, f.state.journal.operation?.command)
    }

    @Test fun `attempted or foreign starter request never starts another departure`() = runTest {
        for (foreign in listOf(false, true)) {
            val f = Fixture()
            val original = f.makeReview().command
            val command = if (foreign) original.copy(request = original.request.copy(baseId = "old-base")) else original
            val operation = StarterExpeditionOperation(command, if (foreign) null else 1L, null, null)
            f.state = f.state.copy(journal = f.state.journal.copy(operation = operation))
            assertFalse(f.controller.open("coastal_survey"))
            assertTrue(f.calls.isEmpty())
            assertSame(operation, f.state.journal.operation)
        }
    }

    @Test fun `blocked identity busy owner or replaced review cannot submit`() = runTest {
        val f = Fixture()
        f.allowed = false
        assertFalse(f.controller.open("coastal_survey"))
        f.allowed = true
        assertTrue(f.controller.open("coastal_survey"))
        val review = requireNotNull(f.controller.review)
        f.state = f.state.copy(busy = true)
        assertFalse(f.controller.confirm(review))
        f.controller.cancel()
        assertSame(review, f.state.review)
        f.state = f.state.copy(busy = false, review = f.makeReview())
        assertFalse(f.controller.confirm(review))
        f.controller.cancel()
        assertNotNull(f.state.review)
        f.current = f.identity.copy(baseSelectionGeneration = 3)
        assertFalse(f.controller.open("coastal_survey"))
        assertEquals(listOf("review:coastal_survey"), f.calls)
    }

    @Test fun `lost admission retires only the returned transient review and preserves journal`() = runTest {
        val f = Fixture()
        val journal = f.state.journal
        f.afterReview = { f.current = null }
        assertFalse(f.controller.open("coastal_survey"))
        assertNull(f.controller.review)
        assertNull(f.state.review)
        assertSame(journal, f.state.journal)
        assertEquals(listOf("review:coastal_survey", "dismiss"), f.calls)
    }

    @Test fun `starter review states exact returned route terms and never promises a wallet signature`() {
        val f = Fixture()
        val ui = homeStarterDepartureSeal(f.makeReview(), false, 321L)
        assertEquals("SEND STARTER BOAT", ui.confirmLabel)
        assertEquals("No wallet signature is needed.", ui.note)
        assertTrue(ui.lines.any { it.contains("108") })
        assertTrue(ui.lines.any { it.contains("automatically") })
        assertNull(ui.network)
        assertNull(ui.cut)
        assertEquals(321L, ui.armedAtMs)
    }

    @Test fun `accepted saved departure is hydrated and preserved in history before reviewing a new trip`() = runTest {
        val f = Fixture()
        val review = f.makeReview()
        val receipt = StarterExpeditionReceipt(VoyageFx.WALLET, review.command.request, review.command.key,
            review.command.installation.installationId, review.command.route,
            "2030-01-01T10:00:00.000Z", "2030-01-01T13:20:00.000Z", "term", "hash")
        val proof = StarterExpeditionProof(VoyageFx.WALLET, review.command.key, review.view.serverNow, "accepted", receipt, null)
        val original = StarterExpeditionOperation(review.command, 1L, proof, null)
        f.state = f.state.copy(journal = f.state.journal.copy(operation = original))
        assertTrue(f.controller.open("coastal_survey"))
        assertEquals(listOf("finish", "review:coastal_survey"), f.calls)
        assertSame(original, f.state.journal.archives.single().operation)
    }

    private class Fixture {
        val identity = HomeRouteIdentity(Any(), VoyageFx.BASE, 2)
        var current: HomeRouteIdentity? = identity
        var allowed = true
        var state = VoyageFx.starter()
        val calls = mutableListOf<String>()
        var afterReview: () -> Unit = {}
        fun makeReview(): StarterExpeditionReview {
            val view = requireNotNull(state.view)
            val route = view.routes.single { it.routeId == "coastal_survey" }
            val installation = requireNotNull(view.installation)
            val command = StarterExpeditionCommand(StarterExpeditionRequest("original-key", view.baseId,
                installation.installationId, route.routeId, route.routeCatalogueVersion, route.rewardTableVersion), route, installation)
            return StarterExpeditionReview(command, view, 0, 2)
        }
        val controller = HomeStarterDepartureController(identity, { current }, { allowed }, { state },
            reviewRoute = { calls += "review:$it"; state = state.copy(review = makeReview()); afterReview() },
            reviewSaved = { calls += "saved"; state = state.copy(review = makeReview()) },
            confirmReview = { calls += "confirm"; state = state.copy(review = null) },
            dismissReview = { calls += "dismiss"; state = state.copy(review = null) },
            finishAccepted = {
                calls += "finish"
                val original = requireNotNull(state.journal.operation)
                state = state.copy(journal = state.journal.copy(operation = null,
                    archives = state.journal.archives + StarterExpeditionArchive(original, "accepted", null)))
            })
    }
}
