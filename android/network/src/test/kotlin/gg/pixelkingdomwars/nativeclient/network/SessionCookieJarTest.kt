package gg.pixelkingdomwars.nativeclient.network

import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class SessionCookieJarTest {
    private val origin = "https://play.pixelkingdomwars.com".toHttpUrl()
    private class MemoryStore : SecretStore { var value: String? = null; override fun read() = value; override fun write(value: String) { this.value = value }; override fun clear() { value = null } }
    @Test fun `sessions persist across process restart without escaping production origin`() {
        val store = MemoryStore(); val jar = SessionCookieJar(origin, store)
        jar.saveFromResponse(origin, listOf(Cookie.parse(origin, "session=secret; Secure; HttpOnly; Path=/; Max-Age=3600")!!))
        assertEquals("secret", SessionCookieJar(origin, store).loadForRequest(origin).single().value)
        for (url in listOf("http://play.pixelkingdomwars.com", "https://evil.pixelkingdomwars.com", "https://play.pixelkingdomwars.com:8443")) assertTrue(jar.loadForRequest(url.toHttpUrl()).isEmpty())
    }
    @Test fun `pending login replaces full session and logout removes persisted credentials`() {
        val store = MemoryStore(); val jar = SessionCookieJar(origin, store)
        jar.saveFromResponse(origin, listOf(Cookie.parse(origin, "session=old; Secure; Path=/; Max-Age=3600")!!))
        jar.saveFromResponse(origin, listOf(Cookie.parse(origin, "session=; Path=/; Max-Age=0")!!, Cookie.parse(origin, "pending=proof; Secure; Path=/; Max-Age=300")!!))
        assertEquals(listOf("pending"), jar.loadForRequest(origin).map { it.name })
        jar.clear(); assertNull(store.value); assertTrue(SessionCookieJar(origin, store).loadForRequest(origin).isEmpty())
    }
    @Test fun `insecure and parent domain cookies never become native authentication`() {
        val jar = SessionCookieJar(origin, MemoryStore())
        jar.saveFromResponse(origin, listOf(Cookie.parse(origin, "session=unsafe; Path=/")!!, Cookie.parse(origin, "session=broad; Domain=pixelkingdomwars.com; Secure; Path=/")!!))
        assertTrue(jar.loadForRequest(origin).isEmpty())
    }
}
