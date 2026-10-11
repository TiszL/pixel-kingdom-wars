package gg.pixelkingdomwars.nativeclient.ui

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.data.BoundCosmeticWakeWorkshopRepositoryTest
import gg.pixelkingdomwars.nativeclient.ui.economy.BoundCosmeticWakeWorkshopViewModel
import gg.pixelkingdomwars.nativeclient.ui.economy.wakeWorkshopEntryAvailable
import gg.pixelkingdomwars.nativeclient.ui.economy.wakeHistory
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

/** Reuses the repository's captured primary DTO fixture and explicitly injected synthetic
 * readiness. Verifies UI intent/lifecycle only, not native C5 admission or Compose pixels. */
@OptIn(ExperimentalCoroutinesApi::class)
class BoundCosmeticWakeWorkshopViewModelTest {
    private fun fixture() = BoundCosmeticWakeWorkshopRepositoryTest().Fixture()
    private suspend fun withModel(f: BoundCosmeticWakeWorkshopRepositoryTest.Fixture,
        block: suspend (BoundCosmeticWakeWorkshopViewModel) -> Unit) {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val model = BoundCosmeticWakeWorkshopViewModel(f.repository)
        try { withTimeout(5_000) { block(model) } }
        finally { model.viewModelScope.cancel(); Dispatchers.resetMain() }
    }
    @Test fun `material consent gates one confirmation and foreground waits for its original outcome`() = runBlocking<Unit> {
        val f = fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.onPost = { entered.complete(Unit); release.await(); f.accepted = true }
        withModel(f) { m -> coroutineScope {
            m.foreground(); assertEquals(0, f.posts); m.review()?.join()
            val review = requireNotNull(m.state.value.review)
            assertEquals(review.view.recipe.recipe, review.command.recipe)
            assertFalse(f.store.read().operation!!.attempted)
            m.confirm(review, false)?.join()
            assertEquals(0, f.posts); assertFalse(f.store.read().operation!!.attempted)
            assertTrue(m.notice.value!!.message.contains("permanently consumed"))
            val first = m.confirm(review, true); entered.await()
            assertNull(m.confirm(review, true))
            val foreground = async { m.foreground() }; yield(); assertFalse(foreground.isCompleted)
            release.complete(Unit); first?.join(); foreground.await()
            assertEquals(1, f.posts); assertNotNull(f.store.read().operation!!.proof)
            assertNull(m.state.value.review)
        } }
    }
    @Test fun `foreground with a lost reply observes only and keeps unknown original reachable without a kingdom`() = runBlocking<Unit> {
        val f = fixture(); f.onPost = { throw IOException("lost response") }
        withModel(f) { m ->
            m.review()?.join(); m.confirm(requireNotNull(m.state.value.review), true)?.join()
            val original = requireNotNull(f.store.read().operation); assertTrue(original.attempted); assertNull(original.proof)
            m.dismiss(); f.selected = null; f.directory = null; f.allowed = false; f.globalAllowed = false; f.art = false
            val priorReads = f.originalReads; m.foreground()
            assertTrue(f.originalReads > priorReads); assertEquals(1, f.posts); assertEquals(0, f.puts)
            assertEquals(original, f.store.read().operation); assertNull(m.state.value.review)
            assertTrue(wakeWorkshopEntryAvailable(m.state.value))
        }
    }
    @Test fun `base and admission changes retain in-flight free Off but STOP retires account publication`() = runBlocking<Unit> {
        val f = fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        withModel(f) { m ->
            m.refreshPreference()?.join()
            f.beforePut = { entered.complete(Unit); release.await() }
            val off = m.setPreference(false); entered.await()
            f.selected = null; f.generation++; f.art = false; m.invalidateAdmission()
            release.complete(Unit); off?.join()
            assertEquals(1, f.puts); assertNotNull(m.state.value.preference); assertNull(m.state.value.view)
            assertEquals("1", m.state.value.preference!!.revision)
            f.beforePut = {}; f.afterPut = { m.dismiss() }
            m.setPreference(false)?.join()
            assertEquals(2, f.puts) // The simulated server applied it; the stopped screen cannot publish it.
            assertNull(m.state.value.preference); assertNull(m.state.value.review); assertNull(m.state.value.view)
        }
    }
    @Test fun `foreground recovers archived completion before surfacing failed current stock`() = runBlocking<Unit> {
        val f = fixture(); f.seedAccepted()
        withModel(f) { m ->
            m.check()?.join(); m.archive()?.join()
            val original = f.store.read().archives.single().proof!!.receipt
            assertNull(f.store.read().operation); f.completed = true
            f.currentFails = true; f.accountFails = true; f.allowed = false; f.globalAllowed = false; f.art = false
            m.dismiss(); m.foreground()
            val recovered = m.state.value.journal.archives.single().proof!!
            assertEquals(original, recovered.receipt); assertNotNull(recovered.completion)
            assertTrue(m.notice.value!!.error); assertNull(m.state.value.view)
            assertTrue(wakeWorkshopEntryAvailable(m.state.value)); assertEquals(0, f.posts); assertEquals(0, f.puts)
        }
    }
    @Test fun `account-only setting refresh works without base or catalogue and global pause blocks UI mutations`() = runBlocking<Unit> {
        val f = fixture(); f.selected = null; f.directory = null; f.queueAvailable = false
        f.currentFails = true; f.allowed = false; f.globalAllowed = false; f.art = false
        withModel(f) { m ->
            m.refreshPreference()?.join(); assertEquals(1, f.accountReads)
            assertNotNull(m.state.value.preference); assertNull(m.state.value.view)
            m.setPreference(false)?.join(); assertEquals(0, f.puts); assertTrue(m.notice.value!!.error)
            m.review()?.join(); assertEquals(0, f.posts); assertNull(f.store.read().operation)
            f.globalAllowed = true; m.setPreference(false)?.join()
            assertEquals(1, f.puts); assertFalse(m.state.value.preference!!.enabled); assertEquals(0, f.posts)
        }
    }
    @Test fun `completed account history and unreadable journal preserve entry without current discovery`() = runBlocking<Unit> {
        assertFalse(wakeWorkshopEntryAvailable(null)); assertTrue(wakeWorkshopEntryAvailable(null, storageUnavailable = true))
        val f = fixture(); f.accepted = true; f.completed = true
        withModel(f) { m ->
            m.foreground(); assertNotNull(m.state.value.original!!.completion)
            assertNull(m.state.value.journal.operation); assertTrue(m.state.value.journal.archives.isEmpty())
            m.invalidateAdmission()
            assertFalse(m.state.value.advertised); assertNull(m.state.value.view)
            assertTrue(wakeWorkshopEntryAvailable(m.state.value))
            assertFalse(wakeWorkshopEntryAvailable(m.state.value.copy(original = null)))
            assertEquals(0, f.posts); assertEquals(0, f.puts)
        }
    }
    @Test fun `recovered completed history outranks a stale pending account original with the same key`() = runBlocking<Unit> {
        val f = fixture(); f.seedAccepted()
        withModel(f) { m ->
            m.foreground(); val pending = requireNotNull(m.state.value.original)
            assertNull(pending.completion); m.archive()?.join()
            f.completed = true; m.checkArchived(pending.idempotencyKey)?.join()
            val completed = requireNotNull(m.state.value.journal.archives.single().proof)
            assertNotNull(completed.completion); assertEquals(pending.wallet, completed.wallet)
            assertEquals(pending.idempotencyKey, completed.idempotencyKey); assertEquals(pending.receipt, completed.receipt)
            assertEquals(pending, m.state.value.original) // Account stock view was deliberately not refreshed.
            assertEquals(listOf(completed), wakeHistory(m.state.value))
            assertEquals(0, f.posts); assertEquals(0, f.puts)
        }
    }
}
