package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.data.WithdrawalUnwindFixture
import gg.pixelkingdomwars.nativeclient.ops.WithdrawalUnwindAction
import gg.pixelkingdomwars.nativeclient.ui.economy.WithdrawalUnwindViewModel
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class WithdrawalUnwindViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    @Test fun `Back and repeated foreground never submit displayed withdrawal consent`() = runTest {
        val f = WithdrawalUnwindFixture(); val model = WithdrawalUnwindViewModel(f.repo)
        model.foreground(); model.review(f.id, WithdrawalUnwindAction.CANCEL)?.join(); assertNotNull(model.state.value.review)
        model.dismiss(); model.foreground(); assertNull(model.state.value.review); assertTrue(f.posts.isEmpty())
    }
    @Test fun `pause during final preflight fences compensation before durable creation`() = runTest {
        val f = WithdrawalUnwindFixture(); val model = WithdrawalUnwindViewModel(f.repo); model.review(f.id, WithdrawalUnwindAction.CANCEL)?.join()
        val wait = CompletableDeferred<Unit>(); f.beforeGet = { wait.await() }
        val job = model.confirm(model.state.value.review!!); runCurrent(); model.dismiss(); wait.complete(Unit); job?.join()
        assertTrue(f.posts.isEmpty()); assertNull(f.saved()); assertNotNull(model.notice.value)
    }
    @Test fun `pause during POST retains exact attempted cancellation and fences late outcome`() = runTest {
        val f = WithdrawalUnwindFixture(); val model = WithdrawalUnwindViewModel(f.repo); model.review(f.id, WithdrawalUnwindAction.CANCEL)?.join()
        val wait = CompletableDeferred<Unit>(); val entered = CompletableDeferred<Unit>()
        f.postHandler = { _, _ -> entered.complete(Unit); wait.await(); f.accept(WithdrawalUnwindAction.CANCEL) }
        val job = model.confirm(model.state.value.review!!); entered.await(); model.dismiss(); wait.complete(Unit); job?.join()
        assertEquals(1, f.posts.size); assertNotNull(f.saved()); assertNull(model.state.value.outcome)
    }
    @Test fun `restored uncertainty and resume use history GET only without recreating consent`() = runTest {
        val f = WithdrawalUnwindFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        try { f.unwind() } catch (_: IOException) { }
        val restored = WithdrawalUnwindFixture(f.disk); val model = WithdrawalUnwindViewModel(restored.repo)
        repeat(3) { model.foreground() }; assertTrue(restored.posts.isEmpty()); assertEquals(f.saved(), restored.saved())
    }
}
