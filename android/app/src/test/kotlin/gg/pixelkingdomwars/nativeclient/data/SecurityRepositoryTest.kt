package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.wallet.RecentAuthPurpose
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SecurityRepositoryTest {
    private class Fixture {
        val api = FakeApiClient()
        val disk = MemoryStore()
        val store = SecurityRecoveryStore(disk, WALLET, "https://localhost:18443")
        var current = true
        var raw = status()
        val proofs = mutableListOf<Pair<RecentAuthPurpose, JsonObject?>>()
        val grants = mutableListOf<String>()
        val ended = mutableListOf<String>()
        var beforeProof: suspend () -> Unit = {}
        var keys = 0
        val transport = object : ApiClient by api {
            override suspend fun postWithRecentAuth(path: String, body: JsonObject, grant: String): JsonObject {
                grants += grant; return api.post(path, body)
            }
        }
        fun repository(loginRecovery: Boolean = false) = LiveSecurityRepository(transport,
            { if (!current) throw SessionSupersededException() },
            { purpose, intent -> proofs += purpose to intent; beforeProof(); "temporary-grant" },
            store, { ended += it }, loginRecovery, { keys++; ID })
        init { api.onGet("/2fa/status") { raw } }
    }
    companion object {
        private const val ID = "86e289aa-6055-45d9-a911-4a2317779491"
        private const val OTHER = "cfb01580-3332-4855-8252-67d09fc9edb2"
        private fun recovery(phase: String? = null, id: String = ID, receipt: Boolean = false) = json("""{
            "recoveryId":${if (phase == null) "null" else "\"$id\""},"status":${phase?.let { "\"$it\"" } ?: "null"},
            "readyAt":${if (phase == "holding") "\"2026-09-10T00:00:00Z\"" else "null"},
            "expiresAt":${if (phase != null) "\"2026-09-20T00:00:00Z\"" else "null"},"reenrollmentRequired":${phase == "completed"},
            "receipt":${if (receipt) "{\"cancelledWithdrawals\":2,\"inFlightWithdrawals\":1,\"refundedKeep\":\"9007199254740993000\"}" else "null"}}""")
        private fun status(totp: Boolean = true, email: Boolean = true, phase: String? = null, id: String = ID,
                           receipt: Boolean = false, login: Boolean = false, replacement: Boolean = false) = json("""{
            "totpEnabled":$totp,"emailVerified":$email,"email":${if (email) "\"a***@example.com\"" else "null"},
            "pendingEmail":null,"totpReady":$totp,"totpReadyAt":${if (totp) "\"2026-09-01T00:00:00Z\"" else "null"},
            "instantEligible":$totp,"instantWithdrawalsEnabled":true,"reenrollmentRequired":$replacement,
            "loginTotpRequired":$login,"recoveryEnabled":true,"recovery":${recovery(phase, id, receipt)}}""")
    }
    @Test fun `missing or mistyped factor flags fail closed instead of enabling setup`() = runBlocking {
        for (bad in listOf(JsonObject(status().filterKeys { it != "totpEnabled" }), JsonObject(status() + ("totpEnabled" to JsonPrimitive("false"))))) {
            val f = Fixture(); f.raw = bad; val repo = f.repository(); repo.refresh(); repo.enrollAuthenticator("")
            assertNull(repo.state.value.status); assertFalse(repo.state.value.fresh); assertTrue(f.api.posts.isEmpty()); assertTrue(f.proofs.isEmpty())
        }
    }
    @Test fun `status keeps exact refund amounts and does not confuse payout availability with maturity`() {
        val raw = JsonObject(status(phase = "holding", receipt = true) + ("instantWithdrawalsEnabled" to JsonPrimitive(false)))
        val s = AccountSecurityStatus.from(raw)
        assertTrue(s.instantEligible); assertFalse(s.instantWithdrawalsEnabled); assertTrue(s.factorsLocked)
        assertEquals("9007199254740993000", s.recovery.receipt!!.refundedKeep)
        assertEquals(2, s.recovery.receipt!!.cancelledWithdrawals)
        assertThrows(IllegalArgumentException::class.java) { AccountSecurityStatus.from(JsonObject(raw + ("recovery" to recovery("future_status")))) }
    }
    @Test fun `wallet rejection sends no factor mutation or durable sensitive material`() = runBlocking {
        val f = Fixture(); val repo = f.repository(); repo.refresh()
        f.beforeProof = { throw IllegalStateException("Wallet request rejected") }
        repo.disableAuthenticator("123456")
        assertTrue(f.api.posts.isEmpty()); assertNull(f.disk.value); assertTrue(repo.state.value.fresh)
        assertEquals(RecentAuthPurpose.FACTOR_CHANGE, f.proofs.single().first)
    }
    @Test fun `email change proves authenticator before email when both factors exist`() = runBlocking {
        val f = Fixture(); val repo = f.repository(); repo.refresh()
        f.api.onPost("/2fa/email/start") { body ->
            assertEquals(json("""{"email":"new@example.com","stepUp":{"method":"totp","code":"123456"}}"""), body)
            f.raw = JsonObject(f.raw + ("pendingEmail" to JsonPrimitive("n***@example.com"))); json("""{"sent":true}""")
        }
        repo.startEmail(" new@example.com ", "123456")
        assertEquals("n***@example.com", repo.state.value.status!!.pendingEmail)
        assertEquals(listOf("temporary-grant"), f.grants); assertNull(f.disk.value)
    }
    @Test fun `adding authenticator uses current email proof and hides setup material on background`() = runBlocking {
        val f = Fixture(); f.raw = status(totp = false); val repo = f.repository(); repo.refresh()
        f.api.onPost("/2fa/totp/enroll") { body ->
            assertEquals(json("""{"stepUp":{"method":"email","code":"654321"}}"""), body)
            json("""{"secret":"JBSWY3DPEHPK3PXP","otpauthUrl":"unused","qrDataUri":"unused"}""")
        }
        repo.enrollAuthenticator("654321")
        assertEquals("JBSWY3DPEHPK3PXP", repo.state.value.enrollment!!.secret)
        assertFalse(repo.state.value.toString().contains("JBSWY")); assertNull(f.disk.value)
        repo.setForeground(false)
        assertNull(repo.state.value.enrollment); assertTrue(repo.state.value.enrollmentStarted)
    }
    @Test fun `late enrollment reply cannot expose seed while screen is backgrounded`() = runBlocking {
        val f = Fixture(); f.raw = status(totp = false, email = false); val repo = f.repository(); repo.refresh()
        val sent = CompletableDeferred<Unit>(); val reply = CompletableDeferred<Unit>()
        f.api.onPost("/2fa/totp/enroll") { sent.complete(Unit); reply.await(); json("""{"secret":"JBSWY3DPEHPK3PXP"}""") }
        val job = launch { repo.enrollAuthenticator("") }; sent.await(); repo.setForeground(false); reply.complete(Unit); job.join()
        assertNull(repo.state.value.enrollment); assertTrue(repo.state.value.enrollmentStarted)
    }
    @Test fun `same-tick double tap never queues a second factor mutation`() = runBlocking {
        val f = Fixture(); val repo = f.repository(); repo.refresh()
        val proof = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.beforeProof = { proof.complete(Unit); release.await() }
        f.api.onPost("/2fa/totp/disable") { f.raw = status(totp = false); json("""{"totpEnabled":false}""") }
        val first = launch { repo.disableAuthenticator("123456") }; proof.await()
        repo.disableAuthenticator("123456"); release.complete(Unit); first.join()
        assertEquals(1, f.proofs.size); assertEquals(1, f.api.posts.size)
    }
    @Test fun `identity change during wallet approval prevents dispatch`() = runBlocking {
        val f = Fixture(); val repo = f.repository(); repo.refresh(); f.beforeProof = { f.current = false }
        try { repo.disableAuthenticator("123456"); fail("Expected identity cancellation") } catch (_: SessionSupersededException) { }
        assertTrue(f.api.posts.isEmpty()); assertTrue(f.ended.isEmpty())
    }
    @Test fun `identity change during status hydration publishes no foreign response`() = runBlocking {
        val f = Fixture(); val repo = f.repository()
        f.api.onGet("/2fa/status") { f.current = false; f.raw }
        try { repo.refresh(); fail("Expected identity cancellation") } catch (_: SessionSupersededException) { }
        assertNull(repo.state.value.status)
    }
    @Test fun `lost email reply reconciles pending address with GET and never replays POST`() = runBlocking {
        val f = Fixture(); val repo = f.repository(); repo.refresh()
        f.api.onPost("/2fa/email/start") {
            f.raw = JsonObject(f.raw + ("pendingEmail" to JsonPrimitive("n***@example.com"))); throw IOException("lost response")
        }
        repo.startEmail("new@example.com", "123456"); repo.refresh()
        assertEquals(1, f.api.posts.size); assertEquals("n***@example.com", repo.state.value.status!!.pendingEmail)
    }
    @Test fun `offline status blocks mutations until a successful explicit refresh`() = runBlocking {
        val f = Fixture(); val repo = f.repository(); repo.refresh()
        f.api.onGet("/2fa/status") { throw IOException("offline") }; repo.refresh(); repo.disableAuthenticator("123456")
        assertFalse(repo.state.value.fresh); assertTrue(f.api.posts.isEmpty()); assertTrue(f.proofs.isEmpty())
    }
    @Test fun `new recovery UUID is saved before dispatch and retained across process death after loss`() = runBlocking {
        val f = Fixture(); val repo = f.repository(); repo.refresh()
        f.api.onPost("/2fa/totp/recovery/start") { body ->
            assertEquals(ID, body.string("recoveryId")); assertEquals(ID, f.store.read()!!.recoveryId)
            assertFalse(f.disk.value!!.contains("temporary-grant")); throw IOException("lost")
        }
        repo.startRecovery(); val recreated = f.repository(); recreated.refresh()
        assertEquals(1, f.api.posts.size); assertEquals(1, f.keys)
        recreated.startRecovery()
        assertEquals(listOf(ID, ID), f.api.posts.map { it.second.string("recoveryId") }); assertEquals(1, f.keys)
        assertEquals(jsonBody("recoveryId" to ID, "action" to "start"), f.proofs.last().second)
    }
    @Test fun `recovery confirm uses email code without wallet grant and restores server refund receipt`() = runBlocking {
        val f = Fixture(); f.raw = status(phase = "email_pending"); val repo = f.repository(); repo.refresh()
        f.api.onPost("/2fa/totp/recovery/confirm") { body ->
            assertEquals(jsonBody("recoveryId" to ID, "code" to "123456"), body)
            assertFalse(f.disk.value!!.contains("123456"))
            f.raw = status(phase = "holding", receipt = true); throw IOException("response lost after refund")
        }
        repo.confirmRecovery("123456")
        assertTrue(f.proofs.isEmpty()); assertTrue(f.grants.isEmpty()); assertNull(f.disk.value)
        assertEquals("9007199254740993000", repo.state.value.status!!.recovery.receipt!!.refundedKeep)
        assertEquals(1, f.api.posts.size)
    }
    @Test fun `active recovery blocks every ordinary factor mutation`() = runBlocking {
        for (phase in listOf("email_pending", "holding")) {
            val f = Fixture(); f.raw = status(phase = phase); val repo = f.repository(); repo.refresh()
            repo.startEmail("a@example.com", "123456"); repo.disableAuthenticator("123456"); repo.setLoginProtection(true, "123456")
            repo.sendFactorEmail(); repo.enrollAuthenticator("123456"); repo.verifyAuthenticator("123456"); repo.verifyEmail("123456")
            assertTrue(f.api.posts.isEmpty()); assertTrue(f.proofs.isEmpty())
        }
    }
    @Test fun `cancelling recovery preserves original ID and only needs current authenticator code`() = runBlocking {
        val f = Fixture(); f.raw = status(phase = "holding", receipt = true); val repo = f.repository(); repo.refresh()
        f.api.onPost("/2fa/totp/recovery/cancel") {
            assertEquals(ID, it.string("recoveryId")); f.raw = status(phase = "cancelled", receipt = true); json("{}")
        }
        repo.cancelRecovery("123456")
        assertTrue(f.proofs.isEmpty()); assertNull(f.disk.value); assertNotNull(repo.state.value.status!!.recovery.receipt)
    }
    @Test fun `completion requires exact recovery intent and confirmed completion signs out`() = runBlocking {
        val f = Fixture(); f.raw = status(phase = "holding"); val repo = f.repository(); repo.refresh()
        f.api.onPost("/2fa/totp/recovery/complete") {
            assertEquals(ID, f.store.read()!!.recoveryId); buildJsonObject { put("status", recovery("completed")) }
        }
        repo.completeRecovery("123456")
        assertEquals(RecentAuthPurpose.TOTP_RECOVERY, f.proofs.single().first)
        assertEquals(jsonBody("recoveryId" to ID, "action" to "complete"), f.proofs.single().second)
        assertTrue(repo.state.value.needsSignIn); assertEquals(1, f.ended.size); assertNull(f.disk.value)
    }
    @Test fun `wrong recovery completion receipt never signs out with a success claim`() = runBlocking {
        val f = Fixture(); f.raw = status(phase = "holding"); val repo = f.repository(); repo.refresh()
        f.api.onPost("/2fa/totp/recovery/complete") { buildJsonObject { put("status", recovery("completed", OTHER)) } }
        repo.completeRecovery("123456")
        assertFalse(repo.state.value.needsSignIn); assertTrue(f.ended.isEmpty()); assertEquals(ID, f.store.read()!!.recoveryId)
    }
    @Test fun `lost completion plus revoked session asks sign-in without claiming recovery succeeded`() = runBlocking {
        val f = Fixture(); f.raw = status(phase = "holding"); val repo = f.repository(); repo.refresh()
        f.api.onPost("/2fa/totp/recovery/complete") {
            f.api.onGet("/2fa/status") { throw ApiException(401, null, "expired") }; throw IOException("lost reply")
        }
        repo.completeRecovery("123456")
        assertTrue(repo.state.value.needsSignIn); assertTrue(f.ended.single().contains("whether")); assertNotNull(f.disk.value)
    }
    @Test fun `restart observes matching completed recovery by GET only`() = runBlocking {
        val f = Fixture(); f.store.write(SavedRecoveryAction(ID, RecoveryAction.COMPLETE)); f.raw = status(totp = false, phase = "completed", replacement = true)
        val repo = f.repository(); repo.refresh()
        assertTrue(repo.state.value.needsSignIn); assertTrue(f.api.posts.isEmpty()); assertTrue(f.proofs.isEmpty()); assertNull(f.disk.value)
    }
    @Test fun `replacement verification in restricted login recovery ends that session`() = runBlocking {
        val f = Fixture(); f.raw = status(totp = false, login = true, replacement = true); val repo = f.repository(loginRecovery = true); repo.refresh()
        f.api.onPost("/2fa/totp/verify") { json("""{"totpEnabled":true}""") }
        repo.verifyAuthenticator("123456")
        assertTrue(repo.state.value.needsSignIn); assertEquals(1, f.ended.size)
    }
    @Test fun `login protection refuses invalid code or missing recovery prerequisites before wallet prompt`() = runBlocking {
        val f = Fixture(); f.raw = status(email = false); val repo = f.repository(); repo.refresh()
        repo.setLoginProtection(true, "123456"); f.raw = status(); repo.refresh(); repo.setLoginProtection(true, "12345678")
        assertTrue(f.api.posts.isEmpty()); assertTrue(f.proofs.isEmpty())
    }
    @Test fun `unreadable or cross-account journal blocks changes without deleting evidence`() = runBlocking {
        val f = Fixture(); f.disk.value = "corrupt"; val repo = f.repository(); repo.refresh(); repo.startRecovery()
        assertFalse(repo.state.value.fresh); assertTrue(f.api.posts.isEmpty()); assertEquals("corrupt", f.disk.value)
        f.store.write(SavedRecoveryAction(ID, RecoveryAction.START))
        assertThrows(IllegalStateException::class.java) { SecurityRecoveryStore(f.disk, "other-wallet", "https://localhost:18443").read() }
        Unit
    }
    @Test fun `current email proof and contact verification use fresh factor grants`() = runBlocking {
        val f = Fixture(); f.raw = status(totp = false); val repo = f.repository(); repo.refresh()
        f.api.onPost("/2fa/step-up/email") { assertEquals(json("{}"), it); json("""{"sent":true,"devCode":"654321"}""") }
        f.api.onPost("/2fa/email/verify") { assertEquals("123456", it.string("code")); json("""{"emailVerified":true}""") }
        repo.sendFactorEmail(); repo.verifyEmail("123456")
        assertEquals(2, f.proofs.size); assertTrue(f.proofs.all { it.first == RecentAuthPurpose.FACTOR_CHANGE && it.second == null })
        assertFalse(repo.state.value.toString().contains("654321")); assertNull(f.disk.value)
    }
    @Test fun `login protection changes boolean contract and keeps current session`() = runBlocking {
        val f = Fixture(); val repo = f.repository(); repo.refresh()
        f.api.onPost("/auth/login/protection") { body ->
            assertEquals(json("""{"enabled":true,"code":"123456"}"""), body); f.raw = status(login = true); json("""{"loginTotpRequired":true}""")
        }
        repo.setLoginProtection(true, "123456")
        assertTrue(repo.state.value.status!!.loginTotpRequired); assertTrue(f.ended.isEmpty())
        assertTrue(repo.state.value.notice!!.contains("other sessions"))
    }
    @Test fun `completion email uses same complete intent and retires only its delivered request`() = runBlocking {
        val f = Fixture(); f.raw = status(phase = "holding"); val repo = f.repository(); repo.refresh()
        f.api.onPost("/2fa/totp/recovery/complete/send-code") {
            assertEquals(ID, it.string("recoveryId")); assertEquals(RecoveryAction.SEND_COMPLETION, f.store.read()!!.action); json("""{"sent":true}""")
        }
        repo.sendRecoveryCompletionEmail()
        assertEquals(jsonBody("recoveryId" to ID, "action" to "complete"), f.proofs.single().second)
        assertNull(f.disk.value); assertFalse(repo.state.value.needsSignIn)
    }
    @Test fun `malformed replacement verification cannot claim replacement verified`() = runBlocking {
        val f = Fixture(); f.raw = status(totp = false, login = true, replacement = true); val repo = f.repository(loginRecovery = true); repo.refresh()
        f.api.onPost("/2fa/totp/verify") { json("""{"totpEnabled":false}""") }
        repo.verifyAuthenticator("123456")
        assertTrue(f.ended.isEmpty()); assertFalse(repo.state.value.needsSignIn); assertTrue(repo.state.value.status!!.replacementRequired)
    }
}
