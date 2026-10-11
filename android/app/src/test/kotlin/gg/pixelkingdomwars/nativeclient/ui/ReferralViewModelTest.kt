package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.economy.ReferralViewModel
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class ReferralViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    @Test fun `foreground resume and Back never turn a review into a command`() = runTest {
        val f = ReferralFixture(); val model = ReferralViewModel(f.repository)
        model.foreground(); model.review("keep-ab234")?.join(); assertNotNull(model.state.value.review)
        model.dismiss(); model.foreground(); assertNull(model.state.value.review); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `process recovery and repeated foreground calls only read until explicit retry`() = runTest {
        val f = ReferralFixture(); f.api.onPost(ReferralRepository.USE) { throw IOException("lost") }; f.submit()
        val restored = ReferralFixture(f.disk); val model = ReferralViewModel(restored.repository)
        repeat(3) { model.foreground() }; assertEquals("KEEP-AB234", model.state.value.saved!!.code)
        assertNull(model.state.value.saved!!.relationship); assertEquals(1, f.api.posts.size); assertTrue(restored.api.posts.isEmpty())
    }
    @Test fun `background invalidates delayed preflight while the normalized review stays unsubmitted`() = runTest {
        val f = ReferralFixture(); val model = ReferralViewModel(f.repository); model.review("keep-ab234")?.join()
        val gate = CompletableDeferred<Unit>(); f.api.onGet(ReferralRepository.STATUS) { gate.await(); f.status() }
        val job = model.confirm(model.state.value.review!!); runCurrent(); model.dismiss(); gate.complete(Unit); job?.join()
        assertTrue(f.api.posts.isEmpty()); assertNull(f.journal.read())
    }
}
