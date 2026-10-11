package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.Signature
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

private const val ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
private fun base58(bytes: ByteArray): String {
    var n = BigInteger(1, bytes); val out = StringBuilder(); val radix = BigInteger.valueOf(58)
    while (n.signum() > 0) { val d = n.divideAndRemainder(radix); out.append(ALPHABET[d[1].toInt()]); n = d[0] }
    repeat(bytes.takeWhile { it == 0.toByte() }.size) { out.append('1') }
    return out.reverse().toString()
}
private fun base58Decode(text: String): ByteArray {
    var n = BigInteger.ZERO
    text.forEach { n = n.multiply(BigInteger.valueOf(58)).add(BigInteger.valueOf(ALPHABET.indexOf(it).toLong())) }
    val body = n.toByteArray().let { if (it.size > 1 && it[0] == 0.toByte()) it.copyOfRange(1, it.size) else it }
    return ByteArray(text.takeWhile { it == '1' }.length) + body
}

/** A Privy stand-in whose only embedded wallet is a real Ed25519 key, so the bytes the server receives can be verified. */
private class EmbeddedWalletSurface : PrivySurface {
    val keys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    val address = base58(keys.public.encoded.takeLast(32).toByteArray())
    val calls = mutableListOf<String>()
    override val mfa = MutableStateFlow<PrivyMfaRequest?>(null)
    override suspend fun restore(): PrivySessionState = PrivySessionState.SignedOut
    override suspend fun loginWithOAuth(provider: SocialProvider, appUrlScheme: String) = PrivySessionState.Verified("did:privy:u1", listOf(address)).also { calls += "oauth:$provider" }
    override suspend fun sendEmailCode(email: String) { calls += "sendCode" }
    override suspend fun loginWithEmailCode(email: String, code: String) = PrivySessionState.Verified("did:privy:u1", listOf(address))
    override suspend fun signer(expectedWallet: String, requireCurrentIdentity: () -> Unit): WalletSigner {
        check(expectedWallet == address) { "asked to sign with a wallet this account does not own" }
        return object : WalletSigner {
            override val address = expectedWallet
            override suspend fun signMessage(message: ByteArray): ByteArray { calls += "sign"; return Signature.getInstance("Ed25519").run { initSign(keys.private); update(message); sign() } }
        }
    }
    override suspend fun submitTotp(request: PrivyMfaRequest, code: String, requireCurrentIdentity: () -> Unit) {}
    override fun cancelMfa() {}
    override suspend fun logout() { calls += "logout" }
}

/** Social sign-in over the real HTTPS transport: the same challenge contract as MWA, signed by the existing embedded wallet. */
class SocialSignInTest {
    private class Fixture : AutoCloseable {
        private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        private val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        val cookies = MemoryStore()
        val api = GameApi.withTransport(server.url("/").toString(), SessionCookieJar(server.url("/"), cookies), "social-test", transport)
        val holder = testHolder()
        val repository = LiveAccountRepository(api, server.url("/").toString().trimEnd('/'), holder, MemoryStore(), ApiRouting()) {}
        val surface = EmbeddedWalletSurface()
        val marker = MemoryStore(); val binding = MemoryStore()
        val login = PrivySocialLogin(surface, api, SocialLoginMarker(marker), SocialBinding(binding), "pixelkingdomwars")
        val message = "play.pixelkingdomwars.com wants you to sign in with your Solana account:\n${surface.address}\n\nnonce: 0123456789abcdef0123456789abcdef0123456789abcdef"
        fun enqueue(vararg bodies: String) = bodies.forEach { server.enqueue(MockResponse().setBody(it)) }
        fun challenge() = """{"nonce":"0123456789abcdef0123456789abcdef0123456789abcdef","message":${JsonPrimitive(message)},"expiresAt":"2026-09-11T00:05:00.000Z"}"""
        fun me() = """{"wallet":"${surface.address}","name":"","keepLevel":1,"entryPaid":false,"seeker":{"linked":false}}"""
        fun bases() = """{"enabled":true,"worldId":"fantasy-v1","maxActive":5,"nextLandPurchaseKind":"entry","bases":[{"id":"$BASE_ID","status":"active","keepLevel":1,"slot":1}]}"""
        override fun close() { server.shutdown(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() }
    }

    @Test fun `social sign-in signs the exact server challenge with the existing embedded wallet and installs the session`() = Fixture().use { f ->
        f.enqueue(f.challenge(), """{"wallet":"${f.surface.address}","entryPaid":false}""", f.me(), f.bases(), """{"open":true}""")
        runBlocking { f.repository.connectWith { token, guard -> f.login.signIn(SocialLoginMethod.Google, token, guard) } }
        val state = f.repository.state.value
        assertEquals(state.error, AccountPhase.SIGNED_IN, state.phase); assertEquals(f.surface.address, state.wallet); assertSame(state.session, f.holder.current)
        val challenge = f.server.takeRequest(); assertEquals("/api/auth/challenge?wallet=${f.surface.address}", challenge.path)
        val verify = f.server.takeRequest(); assertEquals("/api/auth/verify", verify.path); assertEquals("POST", verify.method)
        val body = Json.parseToJsonElement(verify.body.readUtf8()).jsonObject
        assertEquals(f.surface.address, body.string("wallet")); assertEquals("0123456789abcdef0123456789abcdef0123456789abcdef", body.string("nonce"))
        assertEquals("Same session label as MWA (D-103 split)", "solana-mobile", body.string("client"))
        val verified = Signature.getInstance("Ed25519").run { initVerify(f.surface.keys.public); update(f.message.toByteArray(Charsets.UTF_8)); verify(base58Decode(body.string("signature")!!)) }
        assertTrue("The signature covers exactly the server's challenge text", verified)
        assertEquals(listOf("/api/me", "/api/bases", "/api/playtest/access"), (1..3).map { f.server.takeRequest().path })
        assertEquals(listOf("oauth:GOOGLE", "sign"), f.surface.calls)
        assertTrue("The confirmed wallet is bound to the Privy user for later sign-ins", f.binding.value!!.contains(f.surface.address))
        assertNull(f.marker.value)
    }
    @Test fun `login protection routes a social sign-in to the TOTP gate and cancelling it releases both device credentials after the server logout`() = Fixture().use { f ->
        f.enqueue(f.challenge(), """{"wallet":"${f.surface.address}","loginRequired":true,"expiresAt":"2026-09-11T00:15:00.000Z"}""")
        runBlocking { f.repository.connectWith { token, guard -> f.login.signIn(SocialLoginMethod.X, token, guard) } }
        assertEquals(AccountPhase.TOTP, f.repository.state.value.phase); assertEquals(f.surface.address, f.repository.state.value.pendingWallet)
        assertNull("No account session exists behind the gate", f.holder.current)
        repeat(2) { f.server.takeRequest() }
        f.server.enqueue(MockResponse().setResponseCode(204))
        val order = mutableListOf<String>()
        val release = LocalCredentialRelease(SocialBinding(f.binding)) { object : SocialLogin by f.login { override suspend fun logout() { order += "privy"; f.surface.logout() } } }
        runBlocking { f.repository.logout { assertEquals("The server logout was already sent", 3, f.server.requestCount); release.release({ order += "mwa" }, f.repository.state.value.pendingWallet ?: f.surface.address) } }
        assertEquals("/api/auth/logout", f.server.takeRequest().path)
        assertEquals(listOf("mwa", "privy"), order); assertEquals(AccountPhase.SIGNED_OUT, f.repository.state.value.phase)
        assertNull(f.repository.state.value.error)
    }
    @Test fun `sign-out still ends the Privy session when server revocation cannot be confirmed, and never for a wallet-app account`() = Fixture().use { f ->
        f.enqueue(f.challenge(), """{"wallet":"${f.surface.address}","entryPaid":false}""", f.me(), f.bases(), """{"open":true}""")
        runBlocking { f.repository.connectWith { token, guard -> f.login.signIn(SocialLoginMethod.Google, token, guard) } }
        repeat(5) { f.server.takeRequest() }
        f.server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"boom"}"""))
        val order = mutableListOf<String>()
        val release = LocalCredentialRelease(SocialBinding(f.binding)) { object : SocialLogin by f.login { override suspend fun logout() { order += "privy" } } }
        runBlocking { f.repository.logout { release.release({ order += "mwa" }, f.surface.address) } }
        assertEquals("/api/auth/logout", f.server.takeRequest().path)
        assertEquals("Local credentials are released once the server logout was attempted", listOf("mwa", "privy"), order)
        assertEquals(AccountPhase.SIGNED_OUT, f.repository.state.value.phase)
        assertTrue("The unconfirmed revocation stays visible", f.repository.state.value.error!!.contains("could not be confirmed"))
        order.clear()
        runBlocking { release.release({ order += "mwa" }, WALLET) }
        assertEquals("A wallet-app account never touches Privy", listOf("mwa"), order)
    }
    @Test fun `the alpha gate's sign-out after a social sign-in the server turned away at GET me ends the server session and then the Privy session`() = Fixture().use { f ->
        // /auth/verify is ungated; the canonical pre-alpha probe now retains this game identity
        // for explicit auxiliary Seeker linking without installing a playable session.
        f.enqueue(f.challenge(), """{"wallet":"${f.surface.address}","entryPaid":false}""")
        f.server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":{"code":"ALPHA_GATED","message":"playtest access needed"}}"""))
        f.enqueue("""{"wallet":"${f.surface.address}","admitted":false,"seeker":{"linked":false,"seekerWallet":null,"sgtMint":null,"memberNumber":null,"skrDomain":null,"verifiedAt":null,"stale":false,"verificationSources":0,"unconfirmed":false}}""")
        runBlocking { f.repository.connectWith { token, guard -> f.login.signIn(SocialLoginMethod.Google, token, guard) } }
        val gated = f.repository.state.value
        assertEquals(AccountPhase.ALPHA, gated.phase); assertNull(f.holder.current); assertNull("No playable session names the refused wallet", gated.wallet)
        assertEquals(f.surface.address,gated.admission!!.wallet); assertNull(gated.error)
        assertTrue("The wallet was bound to the Privy user before the server turned the account away", f.binding.value!!.contains(f.surface.address))
        repeat(4) { f.server.takeRequest() }
        f.server.enqueue(MockResponse().setResponseCode(204))
        val order = mutableListOf<String>()
        val release = LocalCredentialRelease(SocialBinding(f.binding)) { object : SocialLogin by f.login { override suspend fun logout() { order += "privy"; f.surface.logout() } } }
        // GateViewModel captures the authenticated game wallet before logout clears admission.
        runBlocking { f.repository.logout { release.release({ order += "mwa" }, gated.admission.wallet) } }
        assertEquals("/api/auth/logout", f.server.takeRequest().path)
        assertEquals("Web AlphaGateScreen → useSignOut: server logout, then the device credentials, the Privy session included", listOf("mwa", "privy"), order)
        assertEquals(AccountPhase.SIGNED_OUT, f.repository.state.value.phase); assertNull(f.repository.state.value.error)
        assertEquals("The refused account's Privy session is over, so the next tap can sign in another", listOf("oauth:GOOGLE", "sign", "logout"), f.surface.calls)
    }
}
