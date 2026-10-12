package gg.pixelkingdomwars.nativeclient.ui.home

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/** Source-only owner-boundary cases. No repository, controller, clock or runner is created here. */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class HomeOwnerProjectionTest {
    private class Fixture {
        val session = Any()
        val identity = HomeRouteIdentity(session, "base", 1)
        var current: HomeRouteIdentity? = identity
        var admitted = true
        var review = false
        var calls = 0
        val state = MutableStateFlow("pending original")
        val projection = HomeOwnerProjection(state, identity, { current }, { admitted }, { review })
        val read = projection.readAction<Unit> { calls++ }
    }

    @Test fun `projection retains the original state flow without a second owner`() {
        val f = Fixture()
        assertSame(f.state, f.projection.state)
        assertEquals("pending original", f.projection.currentState())
        assertEquals(0, f.calls)
    }

    @Test fun `a later owner emission is read without replacing or clearing its history`() {
        val f = Fixture()
        f.state.value = "same original checked"
        assertEquals("same original checked", f.projection.currentState())
        assertSame(f.state, f.projection.state)
        assertEquals(0, f.calls)
    }

    @Test fun `read callbacks delegate once when the original owner admits them`() {
        val f = Fixture()
        assertTrue(f.read.invoke(Unit))
        assertEquals(1, f.calls)
        assertEquals("pending original", f.state.value)
    }

    @Test fun `warming admission defers the callback without changing retained evidence`() {
        val f = Fixture(); f.admitted = false
        assertFalse(f.read.invoke(Unit))
        assertEquals(0, f.calls)
        assertEquals("pending original", f.projection.currentState())
        f.admitted = true
        assertTrue(f.read.invoke(Unit))
        assertEquals(1, f.calls)
    }

    @Test fun `callback admission is read at invocation rather than captured in the frame`() {
        val f = Fixture(); val oldFrame = f.read
        f.admitted = false
        assertFalse(oldFrame.invoke(Unit))
        f.admitted = true
        assertTrue(oldFrame.invoke(Unit))
        assertEquals(1, f.calls)
    }

    @Test fun `a replacement session with equal data cannot use the previous projection`() {
        data class Session(val wallet: String)
        val first = Session("same-wallet")
        val scope = HomeRouteIdentity(first, "base", 1)
        var current: HomeRouteIdentity? = scope
        var calls = 0
        val p = HomeOwnerProjection(MutableStateFlow("history"), scope, { current }, { true }, { false })
        val read = p.readAction<Unit> { calls++ }
        current = HomeRouteIdentity(Session("same-wallet"), "base", 1)
        assertNull(p.currentState())
        assertFalse(read.invoke(Unit))
        assertEquals(0, calls)
    }

    @Test fun `a different selected base cannot run a retained read callback`() {
        val f = Fixture(); f.current = HomeRouteIdentity(f.session, "other", 1)
        assertNull(f.projection.currentState())
        assertFalse(f.read.invoke(Unit))
        assertEquals(0, f.calls)
    }

    @Test fun `a new generation of the same base cannot run a retained callback`() {
        val f = Fixture(); f.current = HomeRouteIdentity(f.session, "base", 2)
        assertNull(f.projection.currentState())
        assertFalse(f.read.invoke(Unit))
        assertEquals(0, f.calls)
    }

    // WHY (rewritten 2026-10-11, owner report on the Seeker, code 34): this asserted that a projection with no current owner
    // counts as reviewBlocked. That held Home's body-review gate shut with nothing on screen, so the level badge (and every
    // other HUD door) deferred silently. A projection that is not current is now "not mine": still no snapshot and no read
    // (the safety this test exists for), but no longer a review that blocks the current kingdom.
    @Test fun `missing current owner cannot expose a retained snapshot or run reads`() {
        val f = Fixture(); f.current = null; f.review = true
        assertNull(f.projection.currentState())
        assertFalse("a projection with no current owner is ignored, not a blocking review", f.projection.reviewBlocked)
        assertFalse(f.read.invoke(Unit))
        assertEquals(0, f.calls)
    }

    // Owner report 2026-10-11: the stale-identity case of the same rule, with the owner's own review still saved.
    @Test fun `a projection captured for an older base generation does not block the current one`() {
        val f = Fixture(); f.review = true
        assertTrue("the current owner's saved review still blocks", f.projection.reviewBlocked)
        f.current = HomeRouteIdentity(f.session, "base", 2)
        assertFalse("not mine once its identity is stale", f.projection.reviewBlocked)
        assertNull(f.projection.currentState())
        assertFalse(f.read.invoke(Unit))
        assertEquals(0, f.calls)
    }

    @Test fun `an existing review blocks refresh but keeps the exact owner state visible`() {
        val f = Fixture(); f.review = true
        assertTrue(f.projection.reviewBlocked)
        assertFalse(f.read.invoke(Unit))
        assertEquals("pending original", f.projection.currentState())
        assertEquals(0, f.calls)
    }

    @Test fun `review removal is observed through the same exported callback`() {
        val f = Fixture(); f.review = true
        assertFalse(f.read.invoke(Unit))
        f.review = false
        assertFalse(f.projection.reviewBlocked)
        assertTrue(f.read.invoke(Unit))
        assertEquals(1, f.calls)
    }

    @Test fun `read callback arguments pass unchanged to the existing owner`() {
        val f = Fixture(); var seen: String? = null
        val next = f.projection.readAction<String> { seen = it }
        assertTrue(next.invoke("original-cursor"))
        assertEquals("original-cursor", seen)
    }

    @Test fun `a refused paged read neither advances nor rewrites its cursor`() {
        val f = Fixture(); var seen = "original-cursor"
        val next = f.projection.readAction<String> { seen = it }
        f.review = true
        assertFalse(next.invoke("next-cursor"))
        assertEquals("original-cursor", seen)
    }

    @Test fun `read failures remain owner failures without retry or false success`() {
        val f = Fixture(); var calls = 0
        val read = f.projection.readAction<Unit> { calls++; error("owner failure") }
        try { read.invoke(Unit); fail("expected the original owner failure") }
        catch (e: IllegalStateException) { assertEquals("owner failure", e.message) }
        assertEquals(1, calls)
        assertEquals("pending original", f.state.value)
    }

    @Test fun `suspend reads wait for the existing owner then delegate once`() = runTest {
        val f = Fixture(); val idle = CompletableDeferred<Unit>()
        val read = f.projection.suspendReadAction<Unit>({ idle.await() }) { f.calls++ }
        val task = launch { assertTrue(read.invoke(Unit)) }
        runCurrent(); assertEquals(0, f.calls)
        idle.complete(Unit); task.join()
        assertEquals(1, f.calls)
        assertEquals("pending original", f.state.value)
    }

    @Test fun `a scope change during the owner wait prevents a read on the replacement base`() = runTest {
        val f = Fixture(); val idle = CompletableDeferred<Unit>()
        val read = f.projection.suspendReadAction<Unit>({ idle.await() }) { f.calls++ }
        val task = launch { assertFalse(read.invoke(Unit)) }
        runCurrent(); f.current = HomeRouteIdentity(f.session, "other", 2)
        idle.complete(Unit); task.join()
        assertEquals(0, f.calls)
    }

    @Test fun `a review opened during the owner wait keeps the original pending state`() = runTest {
        val f = Fixture(); val idle = CompletableDeferred<Unit>()
        val read = f.projection.suspendReadAction<Unit>({ idle.await() }) { f.calls++ }
        val task = launch { assertFalse(read.invoke(Unit)) }
        runCurrent(); f.review = true
        idle.complete(Unit); task.join()
        assertEquals(0, f.calls)
        assertEquals("pending original", f.state.value)
    }

    @Test fun `an initially refused suspend read does not touch the owner idle queue`() = runTest {
        val f = Fixture(); f.admitted = false; var waits = 0
        val read = f.projection.suspendReadAction<Unit>({ waits++ }) { f.calls++ }
        assertFalse(read.invoke(Unit))
        assertEquals(0, waits)
        assertEquals(0, f.calls)
    }
}
