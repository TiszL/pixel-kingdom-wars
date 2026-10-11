package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

private class MemoryStore(var value: String? = null) : SecretStore {
    override fun read() = value
    override fun write(value: String) { this.value = value }
    override fun clear() { value = null }
}

/** A scripted Privy: records every SDK call, can hold the browser round trip open or block a signature
 * behind an MFA prompt, never creates wallets. */
private class FakeSurface(var restored: PrivySessionState = PrivySessionState.SignedOut, var wallets: List<String> = listOf(WALLET_A),
                          val userId: String = "did:privy:u1") : PrivySurface {
    val calls = mutableListOf<String>()
    override val mfa = MutableStateFlow<PrivyMfaRequest?>(null)
    var loginFailure: Throwable? = null
    var onLogin: () -> Unit = {}
    var oauthGate: CompletableDeferred<Unit>? = null
    var mfaGate: CompletableDeferred<Unit>? = null
    var onFresh: () -> Unit = {}
    override suspend fun requireFreshTotp(expectedWallet: String, requireCurrentIdentity: () -> Unit) {
        requireCurrentIdentity(); calls += "fresh:$expectedWallet"; onFresh(); requireCurrentIdentity()
    }
    override suspend fun restore(): PrivySessionState { calls += "restore"; return restored }
    override suspend fun loginWithOAuth(provider: SocialProvider, appUrlScheme: String): PrivySessionState.Verified {
        calls += "oauth:$provider:$appUrlScheme"; onLogin(); oauthGate?.await(); loginFailure?.let { throw it }
        return PrivySessionState.Verified(userId, wallets).also { restored = it }
    }
    override suspend fun sendEmailCode(email: String) { calls += "sendCode:$email" }
    override suspend fun loginWithEmailCode(email: String, code: String): PrivySessionState.Verified {
        calls += "emailLogin:$email:$code"; onLogin(); loginFailure?.let { throw it }
        return PrivySessionState.Verified(userId, wallets).also { restored = it }
    }
    override suspend fun signer(expectedWallet: String, requireCurrentIdentity: () -> Unit): WalletSigner {
        calls += "signer:$expectedWallet"; requireCurrentIdentity()
        return object : WalletSigner {
            override val address = expectedWallet
            override suspend fun signMessage(message: ByteArray): ByteArray {
                calls += "sign:${message.toString(Charsets.UTF_8)}"
                mfaGate?.let { gate -> mfa.value = PrivyMfaRequest(userId, setOf("totp")); try { gate.await() } finally { mfa.value = null } }
                return ByteArray(64) { 7 }
            }
        }
    }
    override suspend fun submitTotp(request: PrivyMfaRequest, code: String, requireCurrentIdentity: () -> Unit) {
        calls += "totp:$code"; check(mfa.value === request) { "not the pending request" }; requireNotNull(mfaGate).complete(Unit)
    }
    override fun cancelMfa() { calls += "cancelMfa"; mfaGate?.completeExceptionally(CancellationException("Wallet verification cancelled")) }
    override suspend fun logout() { calls += "logout"; restored = PrivySessionState.SignedOut }
}

private const val WALLET_A = "DnF3JgFtAEdF7Gkcdne5DMtwyLE1S25Uyb9ip4FEfVUX"
private const val WALLET_B = "7Zk1nq9sXW3yQeU2RjJ4bF6Hc8Vd5mLtPa1Gs2Ke3Xy4"

class PrivySocialLoginTest {
    private val token = SessionCookieJar("https://localhost:18443".toHttpUrl(), MemoryStore()).sessionToken()
    private val verifies = mutableListOf<JsonObject>()
    private val marker = MemoryStore(); private val binding = MemoryStore()
    private var verify: (JsonObject) -> JsonObject = { body -> buildJsonObject { put("wallet", body.string("wallet")!!); put("entryPaid", false) } }
    private var sessionGuard: (SessionToken) -> Unit = {}
    private fun login(surface: FakeSurface) = PrivySocialLogin(surface, { _ ->
        WalletChallengeLogin({ wallet -> jsonBody("message" to "challenge for $wallet", "nonce" to "n1") }, { body -> verifies += body; verify(body) })
    }, { session -> sessionGuard(session) }, SocialLoginMarker(marker, Dispatchers.Unconfined), SocialBinding(binding, Dispatchers.Unconfined), "pixelkingdomwars")
    @Test fun `security signing reuses only the remembered verified wallet without login or cookie exchange`() = runBlocking {
        binding.value = jsonBody("userId" to "did:privy:u1", "wallet" to WALLET_A).toString()
        val surface = FakeSurface(restored = PrivySessionState.Verified("did:privy:u1", listOf(WALLET_A)))
        val signer = login(surface).securitySigner(WALLET_A, token) {}
        signer.signMessage("security intent".toByteArray())
        assertEquals(listOf("restore", "signer:$WALLET_A", "sign:security intent"), surface.calls)
        assertTrue(verifies.isEmpty()); assertNull(marker.value)
    }
    @Test fun `fresh recovery proof never uses a different remembered wallet or restored identity`() = runBlocking {
        binding.value = jsonBody("userId" to "did:privy:other", "wallet" to WALLET_A).toString()
        val surface = FakeSurface(restored = PrivySessionState.Verified("did:privy:u1", listOf(WALLET_A)))
        try { login(surface).requireFreshMfa(WALLET_A, token) {}; fail("Wrong provider identity") } catch (_: IllegalStateException) { }
        assertEquals(listOf("restore"), surface.calls); assertTrue(verifies.isEmpty())
    }
    @Test fun `fresh verification rechecks game session after provider response`() = runBlocking {
        binding.value = jsonBody("userId" to "did:privy:u1", "wallet" to WALLET_A).toString()
        val surface = FakeSurface(restored = PrivySessionState.Verified("did:privy:u1", listOf(WALLET_A)))
        surface.onFresh = { sessionGuard = { throw SessionSupersededException() } }
        try { login(surface).requireFreshMfa(WALLET_A, token) {}; fail("Superseded session") } catch (_: SessionSupersededException) { }
        assertTrue(surface.calls.contains("fresh:$WALLET_A")); assertTrue(verifies.isEmpty())
    }
    @Test fun `malformed embedded binding never falls back to external authentication`() = runBlocking {
        binding.value = "broken"
        try { SocialBinding(binding, Dispatchers.Unconfined).isBoundForSecurity(WALLET_A); fail("Expected unreadable binding refusal") }
        catch (_: SocialSignInException) { }
        assertEquals("broken", binding.value)
    }
    // Inline store dispatchers: a marker write settles before the SDK call that follows it, so an undispatched attempt
    // can be observed at the exact point the browser is open (on device the write precedes the hand-off the same way).

    @Test fun `google signs in through the SDK, selects the only embedded wallet, signs the exact challenge and remembers the confirmed wallet`() = runBlocking {
        val surface = FakeSurface()
        surface.onLogin = { assertEquals("The marker is on disk before the browser hand-off", "GOOGLE", marker.value) }
        val result = login(surface).signIn(SocialLoginMethod.Google, token) {}
        assertEquals(listOf("restore", "oauth:GOOGLE:pixelkingdomwars", "signer:$WALLET_A", "sign:challenge for $WALLET_A"), surface.calls)
        assertEquals(jsonBody("wallet" to WALLET_A, "signature" to base58(ByteArray(64) { 7 }), "nonce" to "n1", "client" to "solana-mobile"), verifies.single())
        assertEquals(WALLET_A, result.string("wallet"))
        assertTrue("The server-confirmed wallet is bound to the Privy user", binding.value!!.contains(WALLET_A) && binding.value!!.contains("did:privy:u1"))
        assertNull("The marker is gone once the attempt settled", marker.value)
    }
    @Test fun `any verified restored Privy session is reused by a Google or X tap whichever provider created it, and unverified credentials are signed out first`() = runBlocking {
        // Web rule (apps/web/src/auth/useSocialAuth.ts): an authenticated Privy user skips login() and goes straight to
        // SIWS, so the tapped provider never decides which account signs in.
        val reused = FakeSurface(restored = PrivySessionState.Verified("did:privy:u1", listOf(WALLET_A)))
        login(reused).signIn(SocialLoginMethod.Google, token) {}
        assertEquals(listOf("restore", "signer:$WALLET_A", "sign:challenge for $WALLET_A"), reused.calls)
        assertNull("No browser opened, so no hand-off marker was ever written", marker.value)
        val other = FakeSurface(restored = PrivySessionState.Verified("did:privy:u1", listOf(WALLET_A)))
        login(other).signIn(SocialLoginMethod.X, token) {}
        assertEquals("An X tap on a Google-created session proceeds with that session, as the web does", listOf("restore", "signer:$WALLET_A", "sign:challenge for $WALLET_A"), other.calls)
        val unverified = FakeSurface(restored = PrivySessionState.Unverified)
        login(unverified).signIn(SocialLoginMethod.Google, token) {}
        assertEquals("Unverified persisted credentials never carry into a fresh sign-in", listOf("restore", "logout", "oauth:GOOGLE:pixelkingdomwars"), unverified.calls.take(3))
    }
    @Test fun `email sends the code to the typed address after ending a restored identity and signs in with that address and code`() = runBlocking {
        val surface = FakeSurface(restored = PrivySessionState.Verified("did:privy:u9", listOf(WALLET_A)))
        val login = login(surface)
        login.sendEmailCode("  player@example.com ")
        assertEquals(listOf("restore", "logout", "sendCode:player@example.com"), surface.calls)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { login.sendEmailCode("not an address") } }
        surface.calls.clear()
        surface.onLogin = { assertNull("An in-process code needs no hand-off marker; only a browser round trip can be interrupted", marker.value) }
        login.signIn(SocialLoginMethod.Email("player@example.com", "123456"), token) {}
        assertEquals("The code proves the typed address, so an email login always exchanges it (the restored identity ended when the code was requested)", listOf("restore", "emailLogin:player@example.com:123456", "signer:$WALLET_A"), surface.calls.take(3))
    }
    @Test fun `the server-confirmed wallet wins over the wallet list and its absence refuses without substitution`() = runBlocking {
        binding.value = """{"userId":"did:privy:u1","wallet":"$WALLET_B"}"""
        val surface = FakeSurface(wallets = listOf(WALLET_A, WALLET_B))
        login(surface).signIn(SocialLoginMethod.Google, token) {}
        assertTrue(surface.calls.contains("signer:$WALLET_B")); assertEquals(WALLET_B, verifies.single().string("wallet"))
        val missing = FakeSurface(wallets = listOf(WALLET_A))
        val error = assertThrows(SocialSignInException::class.java) { runBlocking { login(missing).signIn(SocialLoginMethod.Google, token) {} } }
        assertTrue(error.message!!.contains("unavailable")); assertTrue(missing.calls.none { it.startsWith("signer") })
        assertEquals("No second verification for the refused attempt", 1, verifies.size)
        assertEquals("The refused account is signed out of Privy", "logout", missing.calls.last())
        assertNull(marker.value)
    }
    @Test fun `no wallet and several wallets refuse, the app never creates one or picks the first, and the refused account is signed out so another can be tried`() = runBlocking {
        val none = FakeSurface(wallets = emptyList())
        assertTrue(assertThrows(SocialSignInException::class.java) { runBlocking { login(none).signIn(SocialLoginMethod.Google, token) {} } }.message!!.contains("no game wallet"))
        val several = FakeSurface(wallets = listOf(WALLET_A, WALLET_B))
        assertTrue(assertThrows(SocialSignInException::class.java) { runBlocking { login(several).signIn(SocialLoginMethod.Google, token) {} } }.message!!.contains("more than one"))
        assertTrue(none.calls.none { it.startsWith("signer") } && several.calls.none { it.startsWith("signer") }); assertTrue(verifies.isEmpty())
        assertNull("Nothing is bound for a refused account", binding.value)
        // Every social tap reuses a verified restored session (web rule), so a refused account left signed in
        // would be refused again on every tap; ending it lets the next tap open the browser for another account.
        assertEquals(listOf("restore", "oauth:GOOGLE:pixelkingdomwars", "logout"), none.calls)
        assertEquals(listOf("restore", "oauth:GOOGLE:pixelkingdomwars", "logout"), several.calls)
        assertEquals(PrivySessionState.SignedOut, none.restored)
    }
    @Test fun `a pending TOTP login passes through unchanged and still binds the wallet`() = runBlocking {
        verify = { body -> buildJsonObject { put("wallet", body.string("wallet")!!); put("loginRequired", true); put("expiresAt", "2026-09-11T00:15:00.000Z") } }
        val result = login(FakeSurface()).signIn(SocialLoginMethod.Google, token) {}
        assertTrue(result.flag("loginRequired")); assertEquals(WALLET_A, result.string("wallet"))
        assertTrue(binding.value!!.contains(WALLET_A))
    }
    @Test fun `a closed browser tab ends the attempt before any challenge and clears the marker`() = runBlocking {
        val surface = FakeSurface().apply { loginFailure = SocialSignInCancelled() }
        assertThrows(SocialSignInCancelled::class.java) { runBlocking { login(surface).signIn(SocialLoginMethod.Google, token) {} } }
        assertEquals(listOf("restore", "oauth:GOOGLE:pixelkingdomwars"), surface.calls); assertTrue(verifies.isEmpty())
        assertNull("The SDK answered (a closed tab is a settled attempt), so nothing is left to explain later", marker.value); assertNull(binding.value)
    }
    @Test fun `the browser hand-off is reported only while the SDK's round trip is open, and a screen destroyed mid round trip keeps the marker for the next title`() = runBlocking {
        val surface = FakeSurface().apply { oauthGate = CompletableDeferred() }
        val login = login(surface)
        val seen = mutableListOf<SocialProvider?>()
        val watch = launch(Dispatchers.Unconfined) { login.handOff.collect { seen += it } }
        val attempt = async(start = CoroutineStart.UNDISPATCHED) { login.signIn(SocialLoginMethod.Google, token) {} }
        assertEquals("The browser is open: the title may now tell the player to finish there", SocialProvider.GOOGLE, login.handOff.value)
        assertEquals("GOOGLE", marker.value)
        // The ViewModel (or process) that owned the tap is gone before the redirect returns: the SDK has no
        // continuation to resume, so only the marker can explain the interruption on the next title screen.
        attempt.cancel()
        assertThrows(CancellationException::class.java) { runBlocking { attempt.await() } }
        assertEquals(listOf(null, SocialProvider.GOOGLE, null), seen)
        assertEquals("A cancelled hand-off keeps the marker; only the SDK's own answer clears it", "GOOGLE", marker.value)
        assertTrue("No challenge for an unfinished hand-off", verifies.isEmpty())
        watch.cancel()
        // Success clears it, and the hand-off closes as soon as the SDK answers, before the wallet signs.
        marker.value = null
        val settled = FakeSurface().apply { oauthGate = CompletableDeferred() }
        val settledLogin = login(settled)
        val settledSeen = mutableListOf<SocialProvider?>()
        val settledWatch = launch(Dispatchers.Unconfined) { settledLogin.handOff.collect { settledSeen += it } }
        settled.onLogin = { settled.oauthGate!!.complete(Unit) }
        settledLogin.signIn(SocialLoginMethod.Google, token) {}
        settledWatch.cancel()
        assertEquals(listOf(null, SocialProvider.GOOGLE, null), settledSeen); assertNull(marker.value)
        assertEquals(listOf("restore", "oauth:GOOGLE:pixelkingdomwars", "signer:$WALLET_A", "sign:challenge for $WALLET_A"), settled.calls)
    }
    @Test fun `an enrolled Privy authenticator holds the signature until its code is approved, and cancelling it ends the sign-in`() = runBlocking {
        val surface = FakeSurface().apply { mfaGate = CompletableDeferred() }
        val login = login(surface)
        val attempt = async(start = CoroutineStart.UNDISPATCHED) { login.signIn(SocialLoginMethod.Google, token) {} }
        val request = withTimeout(2_000) { login.mfa.first { it != null } }!!
        assertEquals(setOf("totp"), request.methods); assertTrue("No verification while the signature waits", verifies.isEmpty())
        login.submitMfaCode(request, "123456")
        assertEquals(WALLET_A, attempt.await().string("wallet")); assertNull(login.mfa.value)
        assertEquals(listOf("totp:123456"), surface.calls.filter { it.startsWith("totp") })

        val cancelled = FakeSurface().apply { mfaGate = CompletableDeferred() }
        val cancelledLogin = login(cancelled)
        val second = async(start = CoroutineStart.UNDISPATCHED) { cancelledLogin.signIn(SocialLoginMethod.Google, token) {} }
        withTimeout(2_000) { cancelledLogin.mfa.first { it != null } }
        cancelledLogin.cancelMfa()
        assertThrows(CancellationException::class.java) { runBlocking { second.await() } }
        assertEquals("One verification in total: the cancelled attempt never reached the server", 1, verifies.size)
        assertNull(marker.value)
    }
    @Test fun `an identity or session change after the provider login stops before the challenge`() = runBlocking {
        val surface = FakeSurface()
        var current = true
        surface.onLogin = { current = false }
        assertThrows(CancellationException::class.java) { runBlocking { login(surface).signIn(SocialLoginMethod.Google, token) { if (!current) throw CancellationException("account changed") } } }
        assertTrue(surface.calls.none { it.startsWith("signer") }); assertTrue(verifies.isEmpty())
        val superseded = FakeSurface()
        sessionGuard = { throw SessionSupersededException() }
        assertThrows(SessionSupersededException::class.java) { runBlocking { login(superseded).signIn(SocialLoginMethod.Google, token) {} } }
        assertTrue("A superseded session never reaches Privy", superseded.calls.isEmpty())
    }
    @Test fun `sign-out releases the wallet app first and ends the Privy session for a bound wallet, or for an unnamed wallet once a social sign-in bound one on the device, never for a wallet-app account`() = runBlocking {
        val surface = FakeSurface()
        val order = mutableListOf<String>()
        var started = 0
        val release = LocalCredentialRelease(SocialBinding(binding)) { started++; object : SocialLogin by login(surface) { override suspend fun logout() { order += "privy"; surface.logout() } } }
        release.release({ order += "fresh" }, null)
        assertEquals("No social sign-in ever bound a wallet here: an unnamed wallet never starts Privy", listOf("fresh"), order); assertEquals(0, started)
        login(surface).signIn(SocialLoginMethod.Google, token) {}
        release.release({ order += "mwa" }, WALLET_A)
        assertEquals("The wallet app is forgotten before the Privy session ends (web useSignOut order)", listOf("fresh", "mwa", "privy"), order); assertEquals(1, started)
        release.release({ order += "mwa2" }, WALLET_B)
        assertEquals("A wallet-app account never starts Privy", listOf("fresh", "mwa", "privy", "mwa2"), order); assertEquals(1, started)
        // The alpha gate turned away an account before any session named its wallet (web AlphaGateScreen signs
        // out of Privy regardless): the device's social binding says a Privy session may be alive, so it ends.
        release.release({ order += "gate" }, null)
        assertEquals(listOf("fresh", "mwa", "privy", "mwa2", "gate", "privy"), order); assertEquals(2, started)
    }
}
