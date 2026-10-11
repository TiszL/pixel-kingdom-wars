package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Assert.*
import org.junit.Test

/** Pure owner/permission publication tests. Real ServiceContentSession type, fake no-IO
 * acquisition seam: these tests establish no verified files, renderer admission or pixels. */
class ConstructionContentAdmissionsTest {
    private class Fixture {
        val sink = ConstructionContentAdmissions()
        val owner = Any()
        val job = SupervisorJob()
        val account = AccountSession("synthetic-wallet", "https://example.invalid", testToken())
        val content = ContentState()
        val source = ServiceContentSession(job, {}) { _, _ -> error("Sink must not acquire content") }
        fun start() {
            sink.beginOwner(owner)
            sink.setSource(owner, account, content, source)
            sink.permission(owner, true)
        }
        fun close() { sink.clear(owner); source.close(); job.cancel() }
    }

    @Test fun `source and permission stay absent until an owner explicitly begins`() {
        val f = Fixture()
        try {
            assertNull(f.sink.state.value)
            f.sink.setSource(f.owner, f.account, f.content, f.source)
            f.sink.permission(f.owner, true)
            assertNull(f.sink.state.value)
            f.sink.beginOwner(f.owner)
            assertNull(f.sink.state.value)
        } finally { f.close() }
    }

    @Test fun `publishes exact producer identity and starts false without carrying an early permission`() {
        val f = Fixture()
        try {
            f.sink.beginOwner(f.owner)
            f.sink.permission(f.owner, true) // Source has not returned; never cache a positive.
            f.sink.setSource(f.owner, f.account, f.content, f.source)
            val admission = requireNotNull(f.sink.state.value)
            assertSame(f.owner, admission.ownerToken)
            assertSame(f.account, admission.account)
            assertSame(f.content, admission.content)
            assertSame(f.source, admission.serviceContent)
            assertFalse(admission.permitted)
            assertFalse(f.sink.isCurrent(admission))
            f.sink.permission(f.owner, true)
            val allowed = requireNotNull(f.sink.state.value)
            assertTrue(allowed.permitted); assertTrue(f.sink.isCurrent(allowed))
            assertFalse(f.sink.isCurrent(admission))
        } finally { f.close() }
    }

    @Test fun `permission false invalidates synchronously while source is still owned`() {
        val f = Fixture()
        try {
            f.start()
            val before = requireNotNull(f.sink.state.value)
            var invalidated = false
            val listener = f.sink.onInvalidated {
                invalidated = true
                assertFalse(f.sink.isCurrent(before))
                assertFalse(f.sink.state.value?.permitted == true)
                assertTrue("Lifecycle owner closes the source only after this notification", f.source.assets.isCurrent())
            }
            try {
                f.sink.permission(f.owner, false)
                assertTrue(invalidated)
                assertFalse(f.sink.state.value?.permitted == true)
            } finally { listener.close() }
        } finally { f.close() }
    }

    @Test fun `replacement notifies before retirement and stale owner cannot set clear or permit it`() {
        val f = Fixture()
        val nextOwner = Any()
        val nextAccount = AccountSession("synthetic-next", "https://example.invalid", testToken())
        val nextSource = ServiceContentSession(f.job, {}) { _, _ -> error("No acquisition") }
        try {
            f.start()
            val old = requireNotNull(f.sink.state.value)
            var notified = false
            val listener = f.sink.onInvalidated {
                notified = true; assertNull(f.sink.state.value)
                assertFalse(f.sink.isCurrent(old)); assertTrue(f.source.assets.isCurrent())
            }
            try { f.sink.beginOwner(nextOwner); assertTrue(notified) } finally { listener.close() }
            f.sink.setSource(nextOwner, nextAccount, f.content, nextSource)
            f.sink.permission(nextOwner, true)
            val next = requireNotNull(f.sink.state.value)
            f.sink.setSource(f.owner, f.account, f.content, f.source)
            f.sink.permission(f.owner, false)
            f.sink.permission(f.owner, true)
            f.sink.clear(f.owner)
            assertSame(next, f.sink.state.value)
            assertTrue(f.sink.isCurrent(next)); assertFalse(f.sink.isCurrent(old))
        } finally { f.sink.clear(nextOwner); nextSource.close(); f.close() }
    }

    @Test fun `clear fences late results without closing or acquiring the caller owned source`() {
        val f = Fixture()
        try {
            f.start()
            val before = requireNotNull(f.sink.state.value)
            var notifications = 0
            val listener = f.sink.onInvalidated { notifications++; assertNull(f.sink.state.value) }
            try {
                f.sink.clear(f.owner)
                assertEquals(1, notifications)
                assertFalse(f.sink.isCurrent(before)); assertTrue(f.source.assets.isCurrent())
                f.sink.setSource(f.owner, f.account, f.content, f.source)
                f.sink.permission(f.owner, true); f.sink.clear(f.owner)
                assertNull(f.sink.state.value); assertEquals(1, notifications)
            } finally { listener.close() }
        } finally { f.close() }
    }

    @Test fun `owner comparison uses reference identity even if tokens claim value equality`() {
        class Token { override fun equals(other: Any?) = other is Token; override fun hashCode() = 1 }
        val f = Fixture()
        val first = Token(); val second = Token()
        try {
            f.sink.beginOwner(first); f.sink.setSource(first, f.account, f.content, f.source)
            f.sink.permission(first, true)
            f.sink.beginOwner(second); f.sink.setSource(second, f.account, f.content, f.source)
            f.sink.permission(second, true)
            val active = requireNotNull(f.sink.state.value)
            f.sink.clear(first); f.sink.permission(first, false)
            f.sink.setSource(first, f.account, f.content, f.source)
            assertSame(active, f.sink.state.value); assertTrue(f.sink.isCurrent(active))
        } finally { f.sink.clear(second); f.close() }
    }

    @Test fun `duplicate positive source and owner observations preserve admission identity`() {
        val f = Fixture()
        try {
            f.start()
            val active = requireNotNull(f.sink.state.value)
            var invalidations = 0
            val listener = f.sink.onInvalidated { invalidations++ }
            try {
                f.sink.beginOwner(f.owner)
                f.sink.setSource(f.owner, f.account, f.content, f.source)
                f.sink.permission(f.owner, true)
                assertSame(active, f.sink.state.value); assertEquals(0, invalidations)
            } finally { listener.close() }
        } finally { f.close() }
    }

    @Test fun `replacing source under an active owner retires old admission and starts denied`() {
        val f = Fixture()
        val replacement = ServiceContentSession(f.job, {}) { _, _ -> error("No acquisition") }
        try {
            f.start()
            val old = requireNotNull(f.sink.state.value)
            var invalidated = false
            val listener = f.sink.onInvalidated { invalidated = true; assertFalse(f.sink.isCurrent(old)) }
            try {
                f.sink.setSource(f.owner, f.account, f.content, replacement)
                assertTrue(invalidated)
                val next = requireNotNull(f.sink.state.value)
                assertSame(replacement, next.serviceContent); assertFalse(next.permitted)
                assertFalse(f.sink.isCurrent(old)); assertFalse(f.sink.isCurrent(next))
            } finally { listener.close() }
        } finally { replacement.close(); f.close() }
    }

    @Test fun `live admission guard also rejects a producer that retired before the clearing callback`() {
        val f = Fixture()
        try {
            f.start(); val active = requireNotNull(f.sink.state.value)
            f.source.close()
            assertFalse(f.sink.isCurrent(active))
        } finally { f.close() }
    }

    @Test fun `listener registration is not a permission event and disposal removes only that listener`() {
        val f = Fixture()
        try {
            f.start(); var first = 0; var second = 0
            val one = f.sink.onInvalidated { first++ }
            val two = f.sink.onInvalidated { second++ }
            assertEquals(0, first); assertEquals(0, second)
            one.close(); one.close()
            try { f.sink.clear(f.owner); assertEquals(0, first); assertEquals(1, second) }
            finally { two.close() }
        } finally { f.close() }
    }

    @Test fun `one ordinary listener failure cannot skip other invalidations or clearing`() {
        val f = Fixture()
        try {
            f.start(); var notified = false
            val broken = f.sink.onInvalidated { throw IllegalStateException("Synthetic observer failure") }
            val good = f.sink.onInvalidated { notified = true }
            try { f.sink.clear(f.owner); assertTrue(notified); assertNull(f.sink.state.value) }
            finally { broken.close(); good.close() }
        } finally { f.close() }
    }

    @Test fun `reentrant newer owner during invalidation wins over the outer replacement`() {
        val f = Fixture()
        val attempted = Any(); val newer = Any()
        try {
            f.start()
            var replaced = false
            val listener = f.sink.onInvalidated {
                if (!replaced) {
                    replaced = true
                    f.sink.beginOwner(newer)
                    f.sink.setSource(newer, f.account, f.content, f.source)
                    f.sink.permission(newer, true)
                }
            }
            try { f.sink.beginOwner(attempted) } finally { listener.close() }
            val latest = requireNotNull(f.sink.state.value)
            assertSame(newer, latest.ownerToken); assertTrue(latest.permitted)
            f.sink.setSource(attempted, f.account, f.content, f.source)
            f.sink.clear(attempted)
            assertSame(latest, f.sink.state.value)
        } finally { f.sink.clear(newer); f.close() }
    }
}
