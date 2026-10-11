package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.economy.ForgeClaimsViewModel
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class ForgeClaimsViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    @Test fun `Back and repeated foreground never submit displayed claim consent`() = runTest {
        val f = ForgeClaimFixture(); val model = ForgeClaimsViewModel(f.repo)
        model.foreground(); model.review(BASE_ID, null)?.join(); assertNotNull(model.state.value.review)
        model.dismiss(); model.foreground(); assertNull(model.state.value.review); assertTrue(f.posts.isEmpty())
    }
    @Test fun `pause during final preflight fences the claim before durable creation`() = runTest {
        val f = ForgeClaimFixture(); val model = ForgeClaimsViewModel(f.repo); model.review(BASE_ID, null)?.join()
        val wait = CompletableDeferred<Unit>(); f.beforeGet = { wait.await() }
        val job = model.confirm(model.state.value.review!!); runCurrent(); model.dismiss(); wait.complete(Unit); job?.join()
        assertTrue(f.posts.isEmpty()); assertNull(f.saved()); assertNotNull(model.notice.value)
    }
    @Test fun `pause during POST retains exact attempted claim and rejects late publication`() = runTest {
        val f = ForgeClaimFixture(); val model = ForgeClaimsViewModel(f.repo); model.review(BASE_ID, null)?.join()
        val wait = CompletableDeferred<Unit>(); val entered = CompletableDeferred<Unit>()
        f.postHandler = { _, _ -> entered.complete(Unit); wait.await(); f.proof(f.saved()!!) }
        val job = model.confirm(model.state.value.review!!); entered.await(); model.dismiss(); wait.complete(Unit); job?.join()
        assertEquals(1, f.posts.size); assertNotNull(f.saved()); assertNull(model.state.value.receipt)
    }
    @Test fun `restored uncertainty and resume use GET only without recreating consent`() = runTest {
        val f = ForgeClaimFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        try { f.claim() } catch (_: IOException) { }
        val restored = ForgeClaimFixture(f.disk); val model = ForgeClaimsViewModel(restored.repo)
        repeat(3) { model.foreground() }; assertTrue(restored.posts.isEmpty()); assertEquals(f.saved(), restored.saved())
    }
    @Test fun `accepted claim with failed balance refresh stays successful without a red action failure`() = runTest {
        val f = ForgeClaimFixture(); val model = ForgeClaimsViewModel(f.repo)
        model.review(BASE_ID, null)?.join(); f.beforeGet = { if (it == "/balances") throw IOException("offline") }
        model.confirm(model.state.value.review!!)?.join()
        assertEquals("777", model.state.value.receipt!!.result.totalKeep); assertNull(model.notice.value)
        assertNotNull(model.state.value.refreshError); assertNotNull(f.saved()!!.receipt)
        f.beforeGet = {}; model.refresh()?.join()
        assertNull(f.saved()); assertNull(model.state.value.refreshError); assertEquals(1, f.posts.size)
    }

}
