package gg.pixelkingdomwars.nativeclient.ui.nav

import androidx.lifecycle.ViewModel
import gg.pixelkingdomwars.nativeclient.data.AccountPhase
import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import java.net.URI
import java.net.URLDecoder
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Canonical web lib/deepLink.ts: an external link may choose a screen, never an account or order. */
enum class GameLinkScreen(val query: String) { RAIDLOG("raidlog"), MAIL("mail"), BASE("base"), BASES("bases") }

object GameLinkContract {
    const val ORIGIN = "https://play.pixelkingdomwars.com"
    const val CANDIDATE_ORIGIN = "https://qa.pixelkingdomwars.com"
    const val VIEW_ACTION = "android.intent.action.VIEW"
    fun supportedOrigin(origin: String): Boolean = origin == ORIGIN || origin == CANDIDATE_ORIGIN
    /** Unsupported root URLs belong to the web game; preserve their query and fragment exactly. */
    fun browserUrl(action: String?, raw: String?, origin: String = ORIGIN): String? {
        if (action != VIEW_ACTION || raw == null || !supportedOrigin(origin)) return null
        return runCatching {
            val uri = URI(raw)
            raw.takeIf { uri.scheme.equals("https", true) && uri.rawAuthority.equals(URI(origin).host, true) &&
                uri.rawUserInfo == null && uri.port == -1 && uri.rawPath in listOf("", "/") }
        }.getOrNull()
    }
    fun parse(action: String?, raw: String?, origin: String = ORIGIN): GameLinkScreen? {
        if (action != VIEW_ACTION || raw == null || !supportedOrigin(origin)) return null
        return runCatching {
            val uri = URI(raw)
            if (!uri.scheme.equals("https", true) || !uri.rawAuthority.equals(URI(origin).host, true) ||
                uri.rawUserInfo != null || uri.port != -1 || uri.rawPath !in listOf("", "/") || uri.rawFragment != null) return null
            val pairs = (uri.rawQuery ?: return null).split('&').map { part ->
                val split = part.split('=', limit = 2)
                if (split.size != 2) return null
                URLDecoder.decode(split[0], "UTF-8") to URLDecoder.decode(split[1], "UTF-8")
            }
            if (pairs.map { it.first }.distinct().size != pairs.size || pairs.any { it.first !in setOf("screen", "client") }) return null
            val query = pairs.toMap()
            if (query["client"] != null && query["client"] != "solana-mobile") return null
            GameLinkScreen.entries.firstOrNull { it.query == query["screen"] }
        }.getOrNull()
    }
}

/** Activity ViewModel only: configuration changes retain it, process death never serializes the URL/target. */
class GameLinkViewModel : ViewModel() { val links = PendingGameLinks() }

/** All fields are navigation facts, not account authority. The holder is checked again at delivery. */
data class GameLinkEntry(
    val resumed: Boolean = false,
    val onHome: Boolean = false,
    val admitted: Boolean = false,
    val selectedBaseId: String? = null,
    val hydratedBaseId: String? = null,
    val recoveryComplete: Boolean = false,
    val blocked: Boolean = true,
) {
    val safe: Boolean get() = resumed && onHome && admitted && selectedBaseId != null &&
        selectedBaseId == hydratedBaseId && recoveryComplete && !blocked
}

/** Latest valid target wins, matching the web module variable. No storage, timers, network or mutation. */
data class BrowserGameLink(val url: String, val unavailable: Boolean = false)

class PendingGameLinks {
    private val _pending = MutableStateFlow<GameLinkScreen?>(null)
    val pending: StateFlow<GameLinkScreen?> = _pending.asStateFlow()
    private val _browser = MutableStateFlow<BrowserGameLink?>(null)
    val browser: StateFlow<BrowserGameLink?> = _browser.asStateFlow()
    private var owner: AccountSession? = null
    private var wallet: String? = null
    /** Installed only while NavHost exists; a synchronous probe closes the repeated-tap/Back race. */
    internal var visibleScreen: () -> GameLinkScreen? = { null }

    /** Restored Activity intents are already handled; a fresh onNewIntent is a new explicit tap. */
    @Synchronized fun capture(action: String?, uri: String?, restored: Boolean, account: AccountState,
                              current: AccountSession?, origin: String, offline: Boolean): Boolean {
        if (restored || offline || !GameLinkContract.supportedOrigin(origin)) return false
        val target = GameLinkContract.parse(action, uri, origin) ?: return false
        _browser.value = null
        if (target != GameLinkScreen.BASE && current != null && account.session === current &&
            account.phase == AccountPhase.SIGNED_IN && !account.busy && visibleScreen() == target) {
            clear(); return true
        }
        // Account publication and holder replacement are separate steps. A known old UI identity
        // must not become an unbound link during logout, or silently bind to its replacement.
        owner = account.session ?: current
        wallet = account.session?.wallet ?: account.admission?.wallet ?: account.pendingWallet ?: current?.wallet
        _pending.value = target
        observeIdentity(account, current)
        return true
    }

    /** Explicit incoming public web navigation, never silently dropped or loaded by the game. */
    @Synchronized fun offerBrowser(action: String?, uri: String?, restored: Boolean, offline: Boolean, origin: String = GameLinkContract.ORIGIN): Boolean {
        if (restored || offline) return false
        val url = GameLinkContract.browserUrl(action, uri, origin) ?: return false
        clear(); _browser.value = BrowserGameLink(url)
        return true
    }
    @Synchronized fun browserFailed(request: BrowserGameLink) {
        if (_browser.value === request) _browser.value = request.copy(unavailable = true)
    }
    @Synchronized fun closeBrowser(request: BrowserGameLink) { if (_browser.value === request) _browser.value = null }

    @Synchronized fun observeIdentity(account: AccountState, current: AccountSession?) {
        if (_pending.value == null) return
        val captured = owner
        if (captured != null && captured !== current) { clear(); return }
        val nextWallet = current?.wallet ?: account.admission?.wallet ?: account.pendingWallet
        if (wallet != null && ((nextWallet != null && nextWallet != wallet) ||
                (nextWallet == null && account.phase == AccountPhase.SIGNED_OUT))) { clear(); return }
        if (wallet == null) wallet = nextWallet
        if (owner == null && current != null) owner = current
    }

    /** A second notification for the screen already visible is satisfied, never queued to reopen after Back. */
    @Synchronized fun acknowledgeVisible(account: AccountState, current: AccountSession?, screen: GameLinkScreen?, resumed: Boolean) {
        observeIdentity(account, current)
        if (resumed && screen != null && screen != GameLinkScreen.BASE && _pending.value == screen &&
            current != null && account.phase == AccountPhase.SIGNED_IN && !account.busy &&
            account.session === current && owner === current) clear()
    }

    /** Atomic, non-suspending consumption: a restored/new identity cannot receive an older link. */
    @Synchronized fun take(account: AccountState, current: AccountSession?, entry: GameLinkEntry): GameLinkScreen? {
        observeIdentity(account, current)
        if (!entry.safe || account.busy || account.phase != AccountPhase.SIGNED_IN ||
            current == null || account.session !== current || owner !== current) return null
        return _pending.value.also { clear() }
    }

    private fun clear() { _pending.value = null; owner = null; wallet = null }
}
