package gg.pixelkingdomwars.nativeclient.network

import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class StorageRecoveryTest {
    private class FailingStore : SecretStore {
        var value: String? = null
        var unreadable = false
        var undeletable = false
        var reads = 0
        var writes = 0
        var clears = 0
        override fun read(): String? { reads++; if (unreadable) throw SecretStorageException(); return value }
        override fun write(value: String) { writes++; this.value = value }
        override fun clear() { clears++; if (undeletable) throw SecretStorageException(); value = null }
    }
    @Test fun `cookie hydration is lazy and unreadable sessions fail closed without replacement`() {
        val origin = "https://play.pixelkingdomwars.com".toHttpUrl()
        val store = FailingStore().apply { value = "session=existing; Secure; Path=/"; unreadable = true }
        val jar = SessionCookieJar(origin,store)
        assertEquals(0,store.reads) // Construction remains safe for Activity/ViewModel startup.
        assertThrows(SecretStorageException::class.java) { jar.loadForRequest(origin) }
        assertThrows(SecretStorageException::class.java) { jar.saveFromResponse(origin,listOf(Cookie.parse(origin,"session=new; Secure; Path=/")!!)) }
        assertEquals(0,store.writes)
        assertEquals(0,store.clears)
        store.unreadable = false
        assertEquals("existing",jar.loadForRequest(origin).single().value)
    }
    @Test fun `malformed stored cookies are retained for recovery instead of becoming signed out`() {
        val store = FailingStore().apply { value = "broken-cookie-record" }
        val origin = "https://play.pixelkingdomwars.com".toHttpUrl()
        assertThrows(SecretStorageException::class.java) { SessionCookieJar(origin,store).loadForRequest(origin) }
        assertEquals("broken-cookie-record",store.value)
        assertEquals(0,store.clears)
    }
    @Test fun `explicit sign out drops in memory authentication even when disk removal fails`() {
        val store = FailingStore().apply { value = "session=existing; Secure; Path=/"; undeletable = true }
        val origin = "https://play.pixelkingdomwars.com".toHttpUrl()
        val jar = SessionCookieJar(origin,store)
        assertEquals(1,jar.loadForRequest(origin).size)
        assertThrows(SecretStorageException::class.java) { jar.clear() }
        assertTrue(jar.loadForRequest(origin).isEmpty())
        assertNotNull(store.value) // Error is surfaced: disk revocation is not falsely reported.
    }
}
