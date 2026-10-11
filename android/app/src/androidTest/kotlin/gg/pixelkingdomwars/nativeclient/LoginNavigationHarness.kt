package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.view.Choreographer
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.lifecycle.viewModelScope
import androidx.navigation.compose.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.ui.boot.BootDestination
import gg.pixelkingdomwars.nativeclient.ui.boot.bootDestination
import gg.pixelkingdomwars.nativeclient.ui.nav.graphViewModel
import gg.pixelkingdomwars.nativeclient.ui.title.EmailStep
import gg.pixelkingdomwars.nativeclient.ui.title.TitleViewModel
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Test APK only: actual Compose navigation disposes entry-scoped ViewModels. All account/provider
 * replies are in memory; this proves navigation lifetime, not Seed Vault/Privy SDK authorization. */
internal object LoginNavigationHarness {
    fun verify(instrumentation: Instrumentation) {
        check(BuildConfig.DEBUG && Build.HARDWARE == "ranchu")
        val directory = File(instrumentation.targetContext.noBackupFilesDir, "login-navigation-test")
        check(directory.mkdir()) { "Preserve the previous login navigation receipt before rerunning" }
        val accounts = Accounts(); val social = Signer()
        val routes = mutableListOf<BootDestination>()
        var model: TitleViewModel? = null
        var activity: MainActivity? = null
        var stage = "launch-offline-preview"
        fun main(block: () -> Unit) = instrumentation.runOnMainSync(block)
        fun await(condition: () -> Boolean) {
            val deadline = SystemClock.uptimeMillis() + 5_000
            do {
                var ready = false; main { ready = condition() }
                if (ready) return
                SystemClock.sleep(16)
            } while (SystemClock.uptimeMillis() < deadline)
            error("Login navigation condition timed out at $stage")
        }
        fun receipt(status: String) {
            var history = ""; main { history = routes.joinToString(",") }
            File(directory, "receipt.txt").writeText("$status\nstage=$stage\nroutes=$history\n" +
                "heldFramesPerAttempt=32\noffline=true\naccountOrSdkAuthorizationTested=false\n")
        }
        fun heldTitle(original: TitleViewModel) {
            val frames = CountDownLatch(1)
            main { Choreographer.getInstance().postFrameCallback(object : Choreographer.FrameCallback {
                var remaining = 32
                override fun doFrame(time: Long) {
                    if (--remaining == 0) frames.countDown() else Choreographer.getInstance().postFrameCallback(this)
                }
            }) }
            check(frames.await(5, TimeUnit.SECONDS)) { "Android did not produce the required frames" }
            main {
                check(model === original && original.viewModelScope.coroutineContext[Job]!!.isActive)
                check(original.busy.value && accounts.state.value.busy && social.waiting)
                check(routes.last() == BootDestination.TITLE && BootDestination.LOADING !in routes)
            }
        }
        try {
            receipt("running")
            val started = instrumentation.startActivitySync(Intent(instrumentation.targetContext, MainActivity::class.java)
                .putExtra("preview", "base").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            activity = started
            main { started.setContent {
                val nav = rememberNavController()
                val account by accounts.state.collectAsState()
                val destination = bootDestination(LaunchMode.ACCOUNT, true, null, account.phase, account.busy)
                // Same inclusive replacement as PkwApp. The NavHost supplies the real entry owner.
                LaunchedEffect(destination) {
                    routes += destination
                    nav.navigate(destination.name) { popUpTo(0) { inclusive = true } }
                }
                NavHost(nav, startDestination = "boot") {
                    composable("boot") { Text("Boot") }
                    BootDestination.entries.forEach { route -> composable(route.name) {
                        if (route == BootDestination.TITLE) {
                            val title = graphViewModel(accounts) { TitleViewModel(accounts, true, { social }, null) { _, _ -> } }
                            SideEffect { model = title }
                        }
                        Text(route.name)
                    } }
                }
            } }
            await { model != null && routes == listOf(BootDestination.TITLE) }
            val title = requireNotNull(model)
            stage = "browser-refusal"; main { title.continueWith(SocialProvider.GOOGLE) }
            await { social.waiting && title.social.value.browser }; heldTitle(title)
            main { social.reply.completeExceptionally(SocialSignInException("Synthetic provider refusal")) }
            await { !title.busy.value && accounts.state.value.error == "Synthetic provider refusal" }
            stage = "email-refusal"
            main { social.reset(); title.continueWith(SocialProvider.EMAIL); title.sendEmailCode("fixture@example.invalid") }
            await { !title.busy.value && title.social.value.emailStep == EmailStep.CODE }
            main { title.verifyEmailCode("000000") }; await { social.waiting }; heldTitle(title)
            main { social.reply.completeExceptionally(SocialSignInException("Synthetic code refusal")) }
            await { !title.busy.value && accounts.state.value.error == "Synthetic code refusal" }
            main { check(title.social.value.emailStep == EmailStep.CODE); title.changeEmail(); check(title.social.value.emailStep == EmailStep.ADDRESS) }
            stage = "mfa-cancel-retry"
            main { social.reset(mfaRequired = true); title.continueWith(SocialProvider.GOOGLE) }
            await { title.social.value.mfa != null }; heldTitle(title)
            main { title.cancelPrivyMfa() }; await { !title.busy.value && !accounts.state.value.busy }
            main { check(model === title && title.social.value.mfa == null && accounts.state.value.phase == AccountPhase.SIGNED_OUT) }
            stage = "mfa-to-server-totp"
            main { social.reset(mfaRequired = true); accounts.next = AccountPhase.TOTP; title.continueWith(SocialProvider.GOOGLE) }
            await { title.social.value.mfa != null }; heldTitle(title)
            main { title.submitPrivyMfa("123456") }
            await { routes.last() == BootDestination.TOTP && !title.viewModelScope.coroutineContext[Job]!!.isActive }
            stage = "email-to-home"
            main { accounts.state.value = AccountState(phase = AccountPhase.SIGNED_OUT); accounts.next = AccountPhase.SIGNED_IN; social.reset() }
            await { model !== title && routes.last() == BootDestination.TITLE }
            val nextTitle = requireNotNull(model)
            main { nextTitle.continueWith(SocialProvider.EMAIL); nextTitle.sendEmailCode("fixture@example.invalid") }
            await { !nextTitle.busy.value && nextTitle.social.value.emailStep == EmailStep.CODE }
            main { nextTitle.verifyEmailCode("123456") }; await { social.waiting }; heldTitle(nextTitle)
            main { social.reply.complete(Unit) }
            await { routes.last() == BootDestination.HOME && !nextTitle.viewModelScope.coroutineContext[Job]!!.isActive }
            main { check(routes == listOf(BootDestination.TITLE, BootDestination.TOTP, BootDestination.TITLE, BootDestination.HOME)) }
            stage = "complete"; receipt("passed")
        } catch (error: Exception) { receipt("failed"); throw error }
        finally { main { activity?.finish() } }
    }

    private class Signer : SocialLogin {
        override val mfa = MutableStateFlow<PrivyMfaRequest?>(null)
        override val handOff = MutableStateFlow<SocialProvider?>(null)
        var reply = CompletableDeferred<Unit>(); var waiting = false; private var needsMfa = false
        fun reset(mfaRequired: Boolean = false) { check(!waiting); reply = CompletableDeferred(); needsMfa = mfaRequired }
        override suspend fun sendEmailCode(email: String) {}
        override suspend fun signIn(method: SocialLoginMethod, session: SessionToken, requireCurrentIdentity: () -> Unit): JsonObject {
            waiting = true
            if (needsMfa) mfa.value = PrivyMfaRequest("synthetic-user", setOf("totp"))
            else if (method !is SocialLoginMethod.Email) handOff.value = method.provider
            try { reply.await(); return JsonObject(emptyMap()) }
            finally { waiting = false; mfa.value = null; handOff.value = null }
        }
        override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String) { check(mfa.value === request); reply.complete(Unit) }
        override fun cancelMfa() { reply.cancel(CancellationException("Synthetic explicit cancellation")) }
        override suspend fun logout() {}
    }

    private class Accounts : AccountRepository {
        override val state = MutableStateFlow(AccountState(phase = AccountPhase.SIGNED_OUT))
        var next = AccountPhase.SIGNED_IN
        private val token = SessionCookieJar("https://fixture.invalid".toHttpUrl(), object : SecretStore {
            override fun read(): String? = error("No stored credentials in this fixture")
            override fun write(value: String) = error("No stored credentials in this fixture")
            override fun clear() = error("No stored credentials in this fixture")
        }).sessionToken()
        override suspend fun connectWith(attempt: SignInAttempt) {
            state.value = state.value.copy(busy = true, error = null)
            try { attempt.signIn(token) {}; state.value = state.value.copy(phase = next) }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) { state.value = state.value.copy(error = error.message) }
            finally { state.value = state.value.copy(busy = false) }
        }
        override suspend fun restore() = error("No restoration in this fixture")
        override suspend fun connect(wallet: WalletLogin) = error("No real wallet in this fixture")
        override suspend fun verifyTotp(code: String) = error("No server in this fixture")
        override suspend fun logout(afterLocalSignOut: suspend () -> Unit) = error("No real account in this fixture")
        override suspend fun selectBase(id: String) = error("No gameplay in this fixture")
        override suspend fun activateBase(id: String, replaceBaseId: String?) = error("No gameplay in this fixture")
        override suspend fun refreshDirectory() = error("No gameplay in this fixture")
        override suspend fun refreshIdentity() = error("No real account in this fixture")
        override suspend fun loadSecurity() = error("No real account in this fixture")
        override fun discardSession(session: AccountSession, error: ApiException?) = error("No real account in this fixture")
    }
}
