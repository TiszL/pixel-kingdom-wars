package gg.pixelkingdomwars.nativeclient.ui.phasee

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RealmPassportReadOwnerTest {
    @Test fun `readExpeditions returns the actual serialized job and leaves legacy selected kind unchanged`() = runTest {
        Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val model = RealmPassportViewModel(RealmPassportRepository(session, holder, api))
        val release = CompletableDeferred<Unit>(); val reads = mutableListOf<String>()
        api.onGet("/realm-passport/expeditions") { query ->
            reads += query.getValue("kind"); release.await(); PassportTestWire.expeditions(query.getValue("kind"))
        }
        try {
            val job = requireNotNull(model.readExpeditions("advanced"))
            assertTrue(job.isActive)
            assertNull(model.readExpeditions("starter"))
            assertEquals(listOf("advanced"), reads)
            var idle = false; val waiting = launch { model.awaitIdle(); idle = true }
            runCurrent(); assertFalse(idle)
            release.complete(Unit); waiting.join()
            assertTrue(job.isCompleted); assertTrue(idle)
            assertEquals("advanced", model.state.value.expeditions.observation!!.data!!.kind)
            assertEquals("starter", model.kind.value)
        } finally { model.viewModelScope.cancel(); Dispatchers.resetMain() }
    }

    @Test fun `dismissing the shared owner cancels its page read without publishing late rows`() = runTest {
        Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val model = RealmPassportViewModel(RealmPassportRepository(session, holder, api))
        val release = CompletableDeferred<Unit>()
        api.onGet("/realm-passport/expeditions") { release.await(); PassportTestWire.expeditions() }
        try {
            val job = requireNotNull(model.readExpeditions("starter"))
            model.dismiss(); release.complete(Unit); job.join()
            assertTrue(job.isCancelled)
            assertNull(model.state.value.expeditions.observation)
            assertFalse(model.state.value.expeditions.busy)
        } finally { model.viewModelScope.cancel(); Dispatchers.resetMain() }
    }
}
