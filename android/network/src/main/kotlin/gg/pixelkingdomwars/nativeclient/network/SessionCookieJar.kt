package gg.pixelkingdomwars.nativeclient.network

import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import kotlinx.coroutines.CancellationException

/** Process-local identity only: contains no cookie, wallet or persisted credential. */
class SessionToken internal constructor()
class SessionSupersededException : CancellationException("The account session changed; this response was discarded")

/** Scope credentials to one exact HTTPS origin, including pending TOTP cookies. */
class SessionCookieJar(private val origin: HttpUrl, private val store: SecretStore, private val now: () -> Long = System::currentTimeMillis) : CookieJar {
    private var cookies: List<Cookie>? = null
    // Main checks this identity before/after every API suspension. It must not acquire the
    // credential monitor held through Keystore and disk I/O. Mutations remain serialized below;
    // publishing only this opaque identity does not expose uncommitted cookies to requests.
    @Volatile private var token=SessionToken()
    private var loggingOut=false
    fun sessionToken(): SessionToken = token
    fun requireCurrent(expected: SessionToken) { if(expected!==token) throw SessionSupersededException() }
    @Synchronized fun beginAuthentication(expected: SessionToken = token): SessionToken {
        requireCurrent(expected)
        check(!loggingOut) { "Wait for sign-out to finish before signing in again" }
        token=SessionToken(); return token
    }
    @Synchronized internal fun beginLogout(expected: SessionToken): SessionToken {
        requireCurrent(expected)
        check(!loggingOut) { "Sign-out is already in progress" }
        token=SessionToken(); loggingOut=true; return token
    }
    @Synchronized internal fun isLogout(expected: SessionToken): Boolean { requireCurrent(expected); return loggingOut }
    @Synchronized internal fun requestCookies(expected: SessionToken, url: HttpUrl): List<Cookie> {
        requireCurrent(expected)
        if(loggingOut) throw SessionSupersededException()
        return loadForRequest(url)
    }
    @Synchronized internal fun detachLogoutCookies(expected: SessionToken, url: HttpUrl): List<Cookie> {
        requireCurrent(expected); check(loggingOut)
        val previous=loadForRequest(url)
        cookies=emptyList(); store.clear()
        return previous
    }
    @Synchronized internal fun acceptResponse(expected: SessionToken, url: HttpUrl, received: List<Cookie>) {
        requireCurrent(expected)
        if(received.isNotEmpty() && !loggingOut) saveFromResponse(url,received)
    }
    @Synchronized internal fun finishLogout(expected: SessionToken) {
        if(expected!==token) return
        cookies=emptyList(); loggingOut=false; store.clear()
    }
    @Synchronized fun clearIfCurrent(expected: SessionToken): Boolean {
        if(expected!==token) return false
        clear(); return true
    }
    // Hydrate during the request, where I/O errors reach the normal retry UI. Never treat unreadable
    // storage as an absent session or overwrite it with a new anonymous response.
    private fun hydrate(): List<Cookie> {
        cookies?.let { return it }
        val loaded = store.read()?.lineSequence()?.filter { it.isNotBlank() }?.map {
            Cookie.parse(origin,it) ?: throw SecretStorageException()
        }?.toList().orEmpty()
        cookies = loaded
        return loaded
    }
    private fun trusted(url: HttpUrl) = url.scheme == "https" && url.host == origin.host && url.port == origin.port
    @Synchronized override fun saveFromResponse(url: HttpUrl, received: List<Cookie>) {
        if (!trusted(url)) return
        val next = hydrate().toMutableList()
        received.filter { it.hostOnly && it.domain == origin.host && (it.secure || it.expiresAt <= now()) }.forEach { cookie ->
            next.removeAll { it.name == cookie.name && it.path == cookie.path && it.domain == cookie.domain }
            if (cookie.expiresAt > now()) next.add(cookie)
        }
        next.removeAll { it.expiresAt <= now() }
        if (next.isEmpty()) store.clear() else store.write(next.joinToString("\n"))
        cookies = next
    }
    @Synchronized override fun loadForRequest(url: HttpUrl): List<Cookie> {
        if (!trusted(url)) return emptyList()
        return hydrate().filter { it.expiresAt > now() && it.matches(url) }
    }
    @Synchronized fun clear() { token=SessionToken(); loggingOut=false; cookies = emptyList(); store.clear() }
}
