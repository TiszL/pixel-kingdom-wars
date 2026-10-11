package gg.pixelkingdomwars.nativeclient.network

import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class SessionCookieJarConcurrencyTest {
    private val origin = "https://play.pixelkingdomwars.com".toHttpUrl()
    private fun cookie(value: String) = Cookie.parse(origin, "session=$value; Secure; HttpOnly; Path=/; Max-Age=3600")!!

    private class HeldOperation {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        fun block() { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)) { "Storage was not released" } }
        fun awaitEntry() { assertTrue("Storage operation did not start", entered.await(5, TimeUnit.SECONDS)) }
    }
    private class Store : SecretStore {
        @Volatile var value: String? = null
        var beforeRead: () -> Unit = {}
        var beforeWrite: () -> Unit = {}
        var beforeClear: () -> Unit = {}
        override fun read(): String? { beforeRead(); return value }
        override fun write(value: String) { beforeWrite(); this.value = value }
        override fun clear() { beforeClear(); value = null }
    }

    /** A single-thread caller represents Main: the queued heartbeat must run while IO is held,
     * rather than measuring host speed or allowing a second caller thread to hide the wait. */
    private fun withHeldIo(io: () -> Unit, held: HeldOperation, caller: () -> Unit) {
        val storage = Executors.newSingleThreadExecutor()
        val main = Executors.newSingleThreadExecutor()
        val operation = storage.submit(io)
        try {
            held.awaitEntry()
            val check = main.submit(caller)
            val heartbeat = main.submit<Boolean> { true }
            assertTrue("Main heartbeat waited for encrypted storage", heartbeat.get(1, TimeUnit.SECONDS))
            check.get(1, TimeUnit.SECONDS)
        } finally {
            held.release.countDown()
            try { operation.get(5, TimeUnit.SECONDS) }
            finally { storage.shutdownNow(); main.shutdownNow() }
        }
    }

    @Test fun `battle identity check and caller heartbeat remain responsive during cookie persistence`() {
        val store = Store(); val jar = SessionCookieJar(origin, store)
        val session = jar.sessionToken(); val held = HeldOperation()
        store.beforeWrite = held::block
        withHeldIo({ jar.acceptResponse(session, origin, listOf(cookie("persisted"))) }, held) {
            assertSame(session, jar.sessionToken())
            jar.requireCurrent(session)
        }
        assertEquals("persisted", SessionCookieJar(origin, store).loadForRequest(origin).single().value)
    }

    @Test fun `battle identity check and caller heartbeat remain responsive during cold cookie hydration`() {
        val store = Store().apply { value = cookie("saved").toString() }
        val jar = SessionCookieJar(origin, store); val session = jar.sessionToken(); val held = HeldOperation()
        store.beforeRead = held::block
        withHeldIo({ assertEquals("saved", jar.requestCookies(session, origin).single().value) }, held) {
            assertSame(session, jar.sessionToken())
            jar.requireCurrent(session)
        }
    }

    @Test fun `identity invalidation is visible while local sign out waits for durable deletion`() {
        val store = Store(); val jar = SessionCookieJar(origin, store)
        jar.saveFromResponse(origin, listOf(cookie("old")))
        val old = jar.sessionToken(); val held = HeldOperation(); store.beforeClear = held::block
        withHeldIo({ jar.clear() }, held) {
            assertNotSame(old, jar.sessionToken())
            assertThrows(SessionSupersededException::class.java) { jar.requireCurrent(old) }
            jar.requireCurrent(jar.sessionToken())
        }
        assertNull(store.value)
        assertTrue(SessionCookieJar(origin, store).loadForRequest(origin).isEmpty())
    }

    @Test fun `stale identity stays rejected while newer account persistence is held and cannot later clear it`() {
        val store = Store(); val jar = SessionCookieJar(origin, store)
        jar.saveFromResponse(origin, listOf(cookie("old")))
        val old = jar.sessionToken(); val current = jar.beginAuthentication(old)
        val held = HeldOperation(); store.beforeWrite = held::block
        withHeldIo({ jar.acceptResponse(current, origin, listOf(cookie("new"))) }, held) {
            assertSame(current, jar.sessionToken())
            jar.requireCurrent(current)
            assertThrows(SessionSupersededException::class.java) { jar.requireCurrent(old) }
        }
        assertThrows(SessionSupersededException::class.java) { jar.acceptResponse(old, origin, listOf(cookie("late"))) }
        assertFalse(jar.clearIfCurrent(old))
        jar.finishLogout(old)
        assertEquals("new", SessionCookieJar(origin, store).loadForRequest(origin).single().value)
    }

    @Test fun `responsive checks do not publish a cookie whose durable write fails`() {
        val store = Store(); val jar = SessionCookieJar(origin, store)
        jar.saveFromResponse(origin, listOf(cookie("durable")))
        val session = jar.sessionToken(); val held = HeldOperation()
        store.beforeWrite = { held.block(); throw SecretStorageException() }
        withHeldIo({
            assertThrows(SecretStorageException::class.java) { jar.acceptResponse(session, origin, listOf(cookie("unsaved"))) }
        }, held) { jar.requireCurrent(session) }
        assertEquals("durable", jar.requestCookies(session, origin).single().value)
        assertEquals("durable", SessionCookieJar(origin, store).loadForRequest(origin).single().value)
    }

    @Test fun `failed durable deletion still invalidates the old identity and reports storage failure`() {
        val store = Store(); val jar = SessionCookieJar(origin, store)
        jar.saveFromResponse(origin, listOf(cookie("old")))
        val old = jar.sessionToken(); val held = HeldOperation()
        store.beforeClear = { held.block(); throw SecretStorageException() }
        withHeldIo({ assertThrows(SecretStorageException::class.java) { jar.clear() } }, held) {
            assertThrows(SessionSupersededException::class.java) { jar.requireCurrent(old) }
            assertNotSame(old, jar.sessionToken())
        }
        assertTrue(jar.loadForRequest(origin).isEmpty())
        assertNotNull(store.value) // Disk revocation is not falsely reported as successful.
        assertThrows(SessionSupersededException::class.java) { jar.acceptResponse(old, origin, listOf(cookie("late"))) }
    }
}
