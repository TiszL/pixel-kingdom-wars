package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.model.Identity
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

class SecurityWalletConfirmationTest {
    private class Fixture {
        var token = testToken()
        var account = AccountState(phase = AccountPhase.TOTP, pendingWallet = WALLET)
        var embedded = true
        val calls = mutableListOf<String>()
        val prompts = MutableStateFlow<PrivyMfaRequest?>(null)
        var gate: CompletableDeferred<Unit>? = null
        var onFresh: suspend () -> Unit = {}
        val signer = object : WalletSigner {
            override val address = WALLET
            override suspend fun signMessage(message: ByteArray): ByteArray { calls += "sign"; return ByteArray(64) }
        }
        val social = object : SocialLogin {
            override val mfa = prompts
            override val handOff = MutableStateFlow<SocialProvider?>(null)
            override suspend fun sendEmailCode(email: String): Unit = error("No login")
            override suspend fun signIn(method: SocialLoginMethod, session: SessionToken, requireCurrentIdentity: () -> Unit): JsonObject = error("Never repeat game login")
            override suspend fun securitySigner(wallet: String, session: SessionToken, requireCurrentIdentity: () -> Unit): WalletSigner {
                requireCurrentIdentity(); assertEquals(WALLET, wallet); assertSame(token, session); calls += "signer"; return signer
            }
            override suspend fun requireFreshMfa(wallet: String, session: SessionToken, requireCurrentIdentity: () -> Unit) {
                requireCurrentIdentity(); calls += "fresh"; onFresh()
                gate?.let { pending ->
                    prompts.value = PrivyMfaRequest("user", setOf("totp"), fresh = true)
                    try { pending.await() } finally { prompts.value = null }
                }
                requireCurrentIdentity(); calls += "verified"
            }
            override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String) { assertSame(prompts.value, request); calls += "submit"; gate?.complete(Unit) }
            override fun cancelMfa() { calls += "cancel"; gate?.cancel(); prompts.value = null }
            override suspend fun logout(): Unit = error("No logout while signing")
        }
        fun access() = SecurityAccess(account, token, { account }) { if (it !== token) throw SessionSupersededException() }
        val intents = mutableListOf<JsonObject?>()
        fun confirmation() = SecurityWalletConfirmation(access(), { embedded }, { social }, { calls += "external"; signer }) { _, wallet, intent, guard ->
            guard(); calls += "proof"; intents += intent; wallet.signMessage("server intent".toByteArray()); guard(); "grant"
        }
    }
    private val intent = jsonBody("recoveryId" to BASE_ID, "action" to "complete")
    @Test fun `each embedded recovery proof waits for a fresh MFA verification before wallet signing`() = runBlocking {
        val f = Fixture(); val c = f.confirmation()
        repeat(2) { assertEquals("grant", c.authorize(RecentAuthPurpose.TOTP_RECOVERY, intent)) }
        assertEquals(List(2) { listOf("fresh", "verified", "signer", "proof", "sign") }.flatten(), f.calls)
        assertEquals(listOf(intent, intent), f.intents)
    }
    @Test fun `external recovery signs with original wallet without Privy MFA`() = runBlocking {
        val f = Fixture(); f.embedded = false; f.confirmation().authorize(RecentAuthPurpose.TOTP_RECOVERY, intent)
        assertEquals(listOf("external", "proof", "sign"), f.calls)
    }
    @Test fun `ordinary factor confirmation keeps SDK signing MFA separate from forced recovery MFA`() = runBlocking {
        val f = Fixture(); f.confirmation().authorize(RecentAuthPurpose.FACTOR_CHANGE, null)
        assertEquals(listOf("signer", "proof", "sign"), f.calls)
    }
    @Test fun `failed fresh verification cannot fall back to a cached signer`() = runBlocking {
        val f = Fixture(); f.onFresh = { throw IllegalStateException("Invalid new TOTP proof") }
        try { f.confirmation().authorize(RecentAuthPurpose.TOTP_RECOVERY, intent); fail("Expected refusal") } catch (_: IllegalStateException) { }
        assertEquals(listOf("fresh"), f.calls)
    }
    @Test fun `stale identity after fresh MFA cannot authorize the original action`() = runBlocking {
        val f = Fixture(); f.onFresh = { f.token = testToken() }
        try { f.confirmation().authorize(RecentAuthPurpose.TOTP_RECOVERY, intent); fail("Expected identity cancellation") } catch (_: SessionSupersededException) { }
        assertEquals(listOf("fresh"), f.calls)
    }
    @Test fun `MFA prompt belongs to this action and cancellation sends no proof`() = runBlocking {
        val f = Fixture(); f.gate = CompletableDeferred(); val c = f.confirmation()
        val job = launch { c.authorize(RecentAuthPurpose.TOTP_RECOVERY, intent) }
        val request = c.mfa.filterNotNull().first()
        assertTrue(request.fresh); c.cancelMfa(request); job.join()
        assertEquals(listOf("fresh", "cancel"), f.calls); assertNull(c.mfa.value)
    }
    @Test fun `manual MFA code completes the exact pending prompt before proof`() = runBlocking {
        val f = Fixture(); f.gate = CompletableDeferred(); val c = f.confirmation()
        val job = launch { c.authorize(RecentAuthPurpose.TOTP_RECOVERY, intent) }
        val request = c.mfa.filterNotNull().first()
        c.submitMfa(request, "123456"); job.join()
        assertEquals(listOf("fresh", "submit", "verified", "signer", "proof", "sign"), f.calls); assertNull(c.mfa.value)
    }
    @Test fun `stale prompt cannot submit or cancel a newer provider request`() = runBlocking {
        val f = Fixture(); f.gate = CompletableDeferred(); val c = f.confirmation()
        val job = launch { c.authorize(RecentAuthPurpose.TOTP_RECOVERY, intent) }
        val old = c.mfa.filterNotNull().first(); val next = PrivyMfaRequest("other", setOf("totp"))
        f.prompts.value = next
        try { c.submitMfa(old, "123456"); fail("Expected stale request refusal") } catch (_: IllegalStateException) { }
        c.cancelMfa(old); assertFalse(f.calls.contains("submit")); assertFalse(f.calls.contains("cancel"))
        job.cancelAndJoin()
    }
    @Test fun `pending-login access rejects changed wallet phase or cookie generation`() {
        val f = Fixture(); val a = f.access(); a.requireCurrent()
        f.account = AccountState(phase = AccountPhase.TOTP, pendingWallet = "other")
        assertThrows(SessionSupersededException::class.java) { a.requireCurrent() }
        f.account = AccountState(phase = AccountPhase.TOTP, pendingWallet = WALLET); f.token = testToken()
        assertThrows(SessionSupersededException::class.java) { a.requireCurrent() }
    }
    @Test fun `full-session access rejects same-wallet replacement session`() {
        val f = Fixture(); val holder = testHolder(); val original = signedIn(holder)
        f.token = original.token
        f.account = AccountState(phase = AccountPhase.SIGNED_IN, identity = Identity(WALLET), session = original)
        val access = f.access(); access.requireCurrent()
        f.account = f.account.copy(session = signedIn(holder))
        assertThrows(SessionSupersededException::class.java) { access.requireCurrent() }
    }
    @Test fun `full session cannot capture a newer cookie even before account state updates`() {
        val f = Fixture(); val original = signedIn(testHolder())
        f.account = AccountState(phase = AccountPhase.SIGNED_IN, identity = Identity(WALLET), session = original)
        assertThrows(SessionSupersededException::class.java) { f.access() }
    }
    @Test fun `withdrawal uses its full exact proof and existing signing policy without forced provider enrollment`() = runBlocking {
        val f = Fixture()
        val confirmation = SecurityWalletConfirmation(f.access(), { true }, { f.social }, { f.signer },
            proveWithdrawal = { signer, exact, guard ->
                guard(); assertSame(f.signer, signer); assertEquals(intent, exact)
                f.calls += "withdrawal-proof"; signer.signMessage("exact withdrawal".toByteArray())
                throw IllegalStateException("synthetic proof endpoint refusal")
            }, prove = { _, _, _, _ -> error("Must not use grant-only proof") })
        assertThrows(IllegalStateException::class.java) { runBlocking { confirmation.authorizeWithdrawal(intent) } }
        assertEquals(listOf("signer", "withdrawal-proof", "sign"), f.calls)
    }

}
