package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.Identity
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.ui.nav.GateViewModel
import gg.pixelkingdomwars.nativeclient.ui.title.EmailStep
import gg.pixelkingdomwars.nativeclient.ui.title.TitleViewModel
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Account repository stand-in: runs the sign-in attempt it is handed and routes its response like the live one. */
private class FakeAccountRepository : AccountRepository {
    val _state = MutableStateFlow(AccountState(phase = AccountPhase.SIGNED_OUT))
    override val state: StateFlow<AccountState> = _state
    val calls = mutableListOf<String>()
    override suspend fun restore() { calls += "restore" }
    override suspend fun connect(wallet: WalletLogin) { calls += "connect" }
    override suspend fun connectWith(attempt: SignInAttempt) {
        calls += "connectWith"
        val result = try { attempt.signIn(testToken()) {} } catch (error: CancellationException) { throw error } catch (error: Exception) { _state.update { it.copy(error = error.message) }; return }
        _state.update { if (result.flag("loginRequired")) it.copy(phase = AccountPhase.TOTP, pendingWallet = result.string("wallet"), error = null) else it.copy(phase = AccountPhase.SIGNED_IN, error = null) }
    }
    override suspend fun verifyTotp(code: String) { calls += "totp:$code" }
    override suspend fun logout(afterLocalSignOut: suspend () -> Unit) { calls += "logout"; _state.value = AccountState(phase = AccountPhase.SIGNED_OUT); afterLocalSignOut() }
    override suspend fun selectBase(id: String) {}
        override suspend fun activateBase(id: String, replaceBaseId: String?) { calls += "activate:$id" }
    override suspend fun refreshDirectory() {}
    override suspend fun refreshIdentity() {}
    override suspend fun loadSecurity() {}
    override fun discardSession(session: AccountSession, error: ApiException?) {}
}

private class FakeSocialLogin : SocialLogin {
    override val mfa = MutableStateFlow<PrivyMfaRequest?>(null)
    override val handOff = MutableStateFlow<SocialProvider?>(null)
    val calls = mutableListOf<String>()
    var result: JsonObject = json("""{"wallet":"$WALLET","entryPaid":false}""")
    var failure: Exception? = null
    /** Holds the SDK's browser round trip open; null models a reused Privy session that signs in-process. */
    var browserGate: CompletableDeferred<Unit>? = null
    var gate: CompletableDeferred<Unit>? = null
    override suspend fun sendEmailCode(email: String) { calls += "sendCode:$email" }
    override suspend fun signIn(method: SocialLoginMethod, session: SessionToken, requireCurrentIdentity: () -> Unit): JsonObject {
        calls += "signIn:$method"
        browserGate?.let { handOff.value = method.provider; try { it.await() } finally { handOff.value = null } }
        gate?.let { mfa.value = PrivyMfaRequest("u1", setOf("totp")); try { it.await() } finally { mfa.value = null } }
        failure?.let { throw it }
        return result
    }
    override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String) { calls += "mfa:$code"; check(mfa.value === request); gate?.complete(Unit) }
    override fun cancelMfa() { calls += "cancelMfa"; gate?.completeExceptionally(CancellationException("Wallet verification cancelled")) }
    override suspend fun logout() { calls += "logout" }
}

@OptIn(ExperimentalCoroutinesApi::class)
class TitleViewModelTest {
    @Before fun main() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun reset() { Dispatchers.resetMain() }

    private val accounts = FakeAccountRepository()
    private val social = FakeSocialLogin()
    private val marker = MemoryStore()
    private val released = mutableListOf<String?>()
    // An inline store dispatcher: the marker read in the ViewModel's init settles before the first tap, as on device it
    // must never occupy the action slot (a tap while the marker is still being read was dropped by an earlier draft).
    private fun model(configured: Boolean = true, login: SocialLogin? = social) =
        TitleViewModel(accounts, configured, { login }, SocialLoginMarker(marker, Dispatchers.Unconfined), { _, wallet -> released += wallet })

    @Test fun `continue with Google runs one social attempt through the account repository and leaves the title clean`() {
        val model = model()
        model.continueWith(SocialProvider.GOOGLE)
        assertEquals(listOf("connectWith"), accounts.calls); assertEquals(listOf("signIn:Google"), social.calls)
        assertEquals(AccountPhase.SIGNED_IN, accounts.state.value.phase)
        assertNull(model.social.value.inFlight); assertFalse(model.busy.value); assertNull(model.notice.value)
    }
    @Test fun `a pending TOTP login from a social sign-in lands on the authenticator gate and cancelling releases the pending wallet`() {
        social.result = json("""{"wallet":"$WALLET","loginRequired":true,"expiresAt":"2026-09-11T00:15:00.000Z"}""")
        val model = model()
        model.continueWith(SocialProvider.X)
        assertEquals(AccountPhase.TOTP, accounts.state.value.phase); assertEquals(WALLET, accounts.state.value.pendingWallet)
        model.cancelSignIn(null)
        assertEquals(listOf("connectWith", "logout"), accounts.calls)
        assertEquals("The pending wallet's credentials are released after the server logout", listOf(WALLET), released)
        assertEquals(AccountPhase.SIGNED_OUT, accounts.state.value.phase)
    }
    @Test fun `email asks for the address, sends the code, then signs in with that address and code`() {
        val model = model()
        model.continueWith(SocialProvider.EMAIL)
        assertEquals(EmailStep.ADDRESS, model.social.value.emailStep); assertTrue(accounts.calls.isEmpty())
        model.sendEmailCode(" player@example.com ")
        assertEquals(listOf("sendCode: player@example.com "), social.calls); assertEquals(EmailStep.CODE, model.social.value.emailStep); assertEquals("player@example.com", model.social.value.email)
        model.verifyEmailCode("123456")
        assertEquals("signIn:Email(email=player@example.com, code=123456)", social.calls.last())
        assertEquals(AccountPhase.SIGNED_IN, accounts.state.value.phase); assertEquals(EmailStep.NONE, model.social.value.emailStep)
    }
    @Test fun `a rejected email code keeps the code step open with the failure shown`() {
        social.failure = SocialSignInException("The code was not accepted. Request a new code and try again.")
        val model = model()
        model.continueWith(SocialProvider.EMAIL); model.sendEmailCode("player@example.com"); model.verifyEmailCode("000000")
        assertEquals(EmailStep.CODE, model.social.value.emailStep); assertEquals(AccountPhase.SIGNED_OUT, accounts.state.value.phase)
        assertTrue(accounts.state.value.error!!.contains("not accepted"))
        model.changeEmail(); assertEquals(EmailStep.ADDRESS, model.social.value.emailStep)
        model.cancelEmail(); assertEquals(EmailStep.NONE, model.social.value.emailStep); assertEquals("", model.social.value.email)
    }
    @Test fun `the Privy authenticator prompt is visible only while the signature waits and approving it completes the sign-in`() {
        social.gate = CompletableDeferred()
        val model = model()
        model.continueWith(SocialProvider.GOOGLE)
        assertNotNull("The SDK's MFA request reaches the screen", model.social.value.mfa); assertEquals(SocialProvider.GOOGLE, model.social.value.inFlight); assertTrue(model.busy.value)
        model.submitPrivyMfa("123456")
        assertEquals(listOf("signIn:Google", "mfa:123456"), social.calls)
        assertEquals(AccountPhase.SIGNED_IN, accounts.state.value.phase); assertNull(model.social.value.mfa); assertNull(model.social.value.inFlight); assertFalse(model.busy.value)
    }
    @Test fun `cancelling the authenticator prompt ends the sign-in without a session`() {
        social.gate = CompletableDeferred()
        val model = model()
        model.continueWith(SocialProvider.GOOGLE)
        model.cancelPrivyMfa()
        assertTrue(social.calls.contains("cancelMfa")); assertEquals(AccountPhase.SIGNED_OUT, accounts.state.value.phase)
        assertNull(model.social.value.mfa); assertNull(model.social.value.inFlight); assertFalse(model.busy.value)
        assertEquals("The player is told why the sign-in ended", Copy.PRIVY_MFA_CANCELLED, model.notice.value!!.message)
        assertNull("A cancelled signature is not a server error", accounts.state.value.error)
    }
    @Test fun `a closed browser tab reports the cancellation and re-enables the options`() {
        social.failure = SocialSignInCancelled()
        val model = model()
        model.continueWith(SocialProvider.GOOGLE)
        assertTrue(accounts.state.value.error!!.contains("cancelled")); assertEquals(AccountPhase.SIGNED_OUT, accounts.state.value.phase)
        assertNull(model.social.value.inFlight); assertFalse(model.busy.value)
        social.failure = null
        model.continueWith(SocialProvider.GOOGLE)
        assertEquals(AccountPhase.SIGNED_IN, accounts.state.value.phase)
    }
    @Test fun `the browser notice is shown only while the SDK's browser round trip is open`() {
        social.browserGate = CompletableDeferred()
        val model = model()
        val seen = mutableListOf<Boolean>()
        val watch = CoroutineScope(Dispatchers.Unconfined).launch { model.social.collect { seen += it.browser } }
        model.continueWith(SocialProvider.GOOGLE)
        assertTrue("The player is told to finish in the browser while it is open", model.social.value.browser)
        assertEquals(SocialProvider.GOOGLE, model.social.value.inFlight); assertTrue(model.busy.value)
        social.browserGate!!.complete(Unit)
        assertFalse(model.social.value.browser); assertEquals(AccountPhase.SIGNED_IN, accounts.state.value.phase)
        assertEquals(listOf(false, true, false), seen.distinctConsecutive())
        watch.cancel()
        // A reused Privy session signs in-process: the title must not tell the player to finish in a browser.
        seen.clear(); social.browserGate = null
        accounts._state.value = AccountState(phase = AccountPhase.SIGNED_OUT)
        val quiet = CoroutineScope(Dispatchers.Unconfined).launch { model.social.collect { seen += it.browser } }
        model.continueWith(SocialProvider.X)
        quiet.cancel()
        assertEquals(AccountPhase.SIGNED_IN, accounts.state.value.phase)
        assertEquals("No hand-off, no browser notice at any point of the attempt", listOf(false), seen.distinct())
    }
    @Test fun `the alpha gate's sign-out ends the server session and then the device credentials of the refused account`() {
        // Web AlphaGateScreen 'BACK — SWITCH ACCOUNT' goes through useSignOut (server logout, then Privy logout);
        // discarding the session alone would leave the Privy session for the next tap to reuse.
        accounts._state.value = AccountState(phase = AccountPhase.SIGNED_IN, identity = Identity(wallet = WALLET))
        val gates = GateViewModel(accounts) { _, wallet -> released += wallet }
        gates.signOut(null)
        assertEquals(listOf("logout"), accounts.calls)
        assertEquals("The refused wallet's credentials are released after the server logout", listOf(WALLET), released)
        assertEquals(AccountPhase.SIGNED_OUT, accounts.state.value.phase); assertFalse(gates.busy.value)
        // The gate can answer a sign-in or restore that never installed a session: the release still runs, and the
        // wallet it cannot name is left to the device's social binding (LocalCredentialRelease).
        released.clear()
        gates.signOut(null)
        assertEquals(listOf("logout", "logout"), accounts.calls); assertEquals(listOf<String?>(null), released)
    }
    @Test fun `pre admission sign out releases the retained game wallet credentials`() {
        val seeker = gg.pixelkingdomwars.nativeclient.data.SeekerIdentityStatus(false,null,null,null,null,null,false,0,false)
        accounts._state.value = AccountState(phase = AccountPhase.ALPHA,
            admission = gg.pixelkingdomwars.nativeclient.data.PendingAdmission(WALLET, gg.pixelkingdomwars.nativeclient.testToken(), seeker))
        GateViewModel(accounts) { _, wallet -> released += wallet }.signOut(null)
        assertEquals(listOf(WALLET),released); assertEquals(listOf("logout"),accounts.calls)
        assertEquals(AccountPhase.SIGNED_OUT,accounts.state.value.phase)
    }
    @Test fun `an interrupted social sign-in is announced once on the title`() {
        marker.value = "GOOGLE"
        val first = model()
        assertEquals(Copy.socialInterrupted(SocialProvider.GOOGLE), first.notice.value!!.message); assertTrue(first.notice.value!!.error)
        assertNull("The marker is consumed", marker.value)
        assertNull(model().notice.value)
    }
    @Test fun `without a Privy client the social options refuse instead of reaching the account repository`() {
        val model = model(configured = false, login = null)
        model.continueWith(SocialProvider.GOOGLE)
        assertTrue(model.notice.value!!.message.contains("not configured")); assertTrue(accounts.calls.isEmpty())
        assertFalse(model.socialConfigured)
    }
    /** Seeker incident 2026-09-17: the app remembered the last MWA wallet, so a player with Phantom or Solflare installed never
     * saw the chooser again. USE ANOTHER WALLET only forgets that pairing: no server logout, no credential release, and the
     * Privy options stay as they are. */
    @Test fun `use another wallet forgets the MWA pairing without signing out or releasing credentials`() {
        val model = model(); var forgotten = 0
        model.useAnotherWallet { forgotten++ }
        assertEquals(1, forgotten); assertEquals(Copy.WALLET_FORGOTTEN, model.notice.value?.message); assertFalse(model.notice.value!!.error)
        assertTrue(accounts.calls.isEmpty()); assertTrue(released.isEmpty()); assertTrue(social.calls.isEmpty())
        assertEquals(AccountPhase.SIGNED_OUT, accounts.state.value.phase); assertFalse(model.busy.value)
        model.dismissNotice(); assertNull(model.notice.value)
    }
}

private fun List<Boolean>.distinctConsecutive(): List<Boolean> = fold(mutableListOf()) { acc, value -> if (acc.lastOrNull() != value) acc += value; acc }
