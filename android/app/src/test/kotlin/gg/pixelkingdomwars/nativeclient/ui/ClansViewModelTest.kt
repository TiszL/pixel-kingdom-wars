package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.community.ClansViewModel
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class ClansViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }
    @Test fun `Back and repeated foreground reads never submit the displayed clan review`() = runTest {
        val f = ClanFixture(); val model = ClansViewModel(f.repo)
        model.foreground(); model.reviewLeave(CLAN_ID, BASE_ID)?.join(); assertNotNull(model.state.value.review)
        model.dismiss(); model.foreground(); assertNull(model.state.value.review); assertTrue(f.posts.isEmpty())
    }
    @Test fun `pause during final preflight invalidates consent before a request is saved`() = runTest {
        val f = ClanFixture(); val model = ClansViewModel(f.repo); model.reviewLeave(CLAN_ID, BASE_ID)?.join()
        val wait = CompletableDeferred<Unit>(); f.beforeGet = { wait.await() }
        val job = model.confirm(requireNotNull(model.state.value.review)); runCurrent(); model.dismiss(); wait.complete(Unit); job?.join()
        assertTrue(f.posts.isEmpty()); assertNull(f.saved()); assertNotNull(model.notice.value)
    }
    @Test fun `pause during POST preserves original attempted request and cannot publish a late outcome`() = runTest {
        val f = ClanFixture(); val model = ClansViewModel(f.repo); model.reviewLeave(CLAN_ID, BASE_ID)?.join()
        val wait = CompletableDeferred<Unit>(); val entered = CompletableDeferred<Unit>()
        f.postHandler = { _, _ -> entered.complete(Unit); wait.await(); f.proof(requireNotNull(f.saved())) }
        val job = model.confirm(requireNotNull(model.state.value.review)); entered.await(); model.dismiss(); wait.complete(Unit); job?.join()
        assertEquals(1, f.posts.size); assertNotNull(f.saved()); assertNull(model.state.value.receipt)
    }
    @Test fun `restored uncertainty and repeated resume never retry without explicit player action`() = runTest {
        val f = ClanFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        try { f.leave() } catch (_: IOException) { }
        val restored = ClanFixture(f.disk); val model = ClansViewModel(restored.repo)
        repeat(3) { model.foreground() }; assertTrue(restored.posts.isEmpty()); assertNotNull(restored.saved())
        assertEquals(f.saved(), restored.saved())
    }

    @Test fun `stale refresh and review admission perform no repository reads`() = runTest {
        val f = ClanFixture(); val model = ClansViewModel(f.repo)
        val stale = { throw CancellationException("Owner changed") }
        model.refresh(stale)?.join()
        model.reviewLeave(CLAN_ID, BASE_ID, stale)?.join()
        model.reviewKick(CLAN_ID, CLAN_MEMBER, stale)?.join()
        assertTrue(f.gets.isEmpty()); assertTrue(f.posts.isEmpty()); assertNull(f.saved())
    }
    @Test fun `queued review checks captured owner at coroutine entry`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val f = ClanFixture(); val model = ClansViewModel(f.repo)
        var current = true
        val job = model.reviewLeave(CLAN_ID, BASE_ID) { if (!current) throw CancellationException("Deed generation changed") }
        current = false; job?.join()
        assertTrue(f.gets.isEmpty()); assertTrue(f.posts.isEmpty()); assertNull(model.state.value.review)
    }
    @Test fun `stale confirm does not submit or replace frozen consent`() = runTest {
        val f = ClanFixture(); val model = ClansViewModel(f.repo)
        model.reviewLeave(CLAN_ID, BASE_ID)?.join(); val review = requireNotNull(model.state.value.review)
        val reads = f.gets.size
        model.confirm(review) { throw CancellationException("Owner changed") }?.join()
        assertEquals(reads, f.gets.size); assertTrue(f.posts.isEmpty()); assertNull(f.saved())
        assertEquals(review, model.state.value.review)
    }
    @Test fun `stale explicit retry preserves the original saved request without another POST`() = runTest {
        val f = ClanFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        try { f.leave() } catch (_: IOException) { }
        val saved = requireNotNull(f.saved()); val posts = f.posts.size; val reads = f.gets.size
        val model = ClansViewModel(f.repo)
        model.retry(saved.kind) { throw CancellationException("Owner changed") }?.join()
        assertEquals(posts, f.posts.size); assertEquals(reads, f.gets.size); assertEquals(saved, f.saved())
    }
}
