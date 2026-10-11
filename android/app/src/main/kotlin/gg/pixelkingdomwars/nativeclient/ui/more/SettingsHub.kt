package gg.pixelkingdomwars.nativeclient.ui.more

import android.Manifest
import android.content.Intent
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.BuildConfig
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.AccountPhase
import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.diagnostics.LocalBattleReports
import gg.pixelkingdomwars.nativeclient.diagnostics.LocalExportPermit
import gg.pixelkingdomwars.nativeclient.notifications.NativeNotificationRuntime
import gg.pixelkingdomwars.nativeclient.ui.LocalSystemExperience
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.nav.graphViewModel
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ConfirmUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SettingsActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SettingsHelpActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SettingsSheetR2
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.SETTINGS_ABOUT_FEATURE
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.SETTINGS_FEEDBACK_FEATURE
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.SETTINGS_NOTIFY_ANDROID
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.SETTINGS_NOTIFY_OFF
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.SETTINGS_NOTIFY_ON
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.SETTINGS_REPORTS_CLEAR
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.SETTINGS_REPORTS_EXPORT
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.SETTINGS_REPORTS_HISTORY
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.SETTINGS_REPORTS_RAW
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.SETTINGS_SECURITY_FEATURE
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.SETTINGS_SIGN_OUT_ROW
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.applySettingsToggle
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.settingsHeldRowAction
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.settingsLiveHelpUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.settingsLiveUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.settingsNetworkLabel
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.settingsToggleRefusal
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.settingsToggleRowAction
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

private const val SETTINGS_UNAVAILABLE = "This is not available from Settings yet."
private const val SETTINGS_STALE = "Settings is waiting for another review, or your account changed. Try again or open Settings again."

/** A door or row control runs only while this card still owns its account and its read lease; otherwise it says why. */
internal class SettingsActionGate(private val current: () -> Boolean, private val explain: (String) -> Unit) {
    fun run(available: Boolean, unavailable: String = SETTINGS_UNAVAILABLE, action: () -> Unit): Boolean {
        val reason = when {
            !available -> unavailable
            !current() -> SETTINGS_STALE
            else -> null
        }
        if (reason != null) { explain(reason); return false }
        action()
        return true
    }
}

/** The owner reference and selection generation, so a replaced session with the same wallet or A -> B -> A is refused. */
internal data class SettingsAccountScope(val session: Any, val baseId: String?, val generation: Long) {
    override fun equals(other: Any?): Boolean =
        other is SettingsAccountScope && other.session === session && other.baseId == baseId && other.generation == generation
    override fun hashCode(): Int = (System.identityHashCode(session) * 31 + (baseId?.hashCode() ?: 0)) * 31 + generation.hashCode()
}

/** One SIGN OUT confirmation for the scope that raised it; every confirm or cancel consumes it. */
internal class SettingsSignOutGate {
    private var pending: SettingsAccountScope? = null
    fun request(scope: SettingsAccountScope) { pending = scope }
    fun confirm(current: SettingsAccountScope?, admitted: Boolean, action: () -> Unit): Boolean {
        val asked = pending
        pending = null
        if (asked == null || current == null || !admitted || asked != current) return false
        action()
        return true
    }
    fun cancel() { pending = null }
}

/** Where a Settings OPEN row or HELP row leads; null is a door this card does not own. */
internal enum class SettingsDoor { SECURITY, FEEDBACK, ABOUT }

internal fun settingsDoor(link: HubLink): SettingsDoor? = when (link.feature.value) {
    SETTINGS_SECURITY_FEATURE -> SettingsDoor.SECURITY
    SETTINGS_FEEDBACK_FEATURE -> SettingsDoor.FEEDBACK
    SETTINGS_ABOUT_FEATURE -> SettingsDoor.ABOUT
    else -> null
}

private val SETTINGS_TABS = setOf("GAME", "ACCOUNT", "HELP")

/**
 * The designed Settings card (settings.png, settings-help.png) for the standalone route and the typed Home sheet. Device
 * preferences save at once; the GAME "Game notifications" toggle and the local report rows keep the calls of the old
 * NotificationSettingsCard and LocalReportControls; sign out stays the existing AccountViewModel owner behind one
 * confirmation.
 */
@Composable fun SettingsHub(
    graph: AppGraph, session: SessionGraph?, wallet: WalletLogin?,
    onBack: () -> Unit, onSecurity: () -> Unit, onFeedback: () -> Unit, onCodex: () -> Unit, onAbout: () -> Unit,
    onFit: (() -> Unit)? = null, modifier: Modifier = Modifier.fillMaxSize(), hosted: Boolean = false,
    selectedTab: String? = null, onTab: ((String) -> Unit)? = null, canRead: () -> Boolean = { true },
) {
    val account by graph.account.state.collectAsState()
    val owner = remember(session, account.selectedBaseId, account.baseSelectionGeneration) {
        session?.let { SettingsAccountScope(it.session, account.selectedBaseId, account.baseSelectionGeneration) }
    }
    key(owner) {
        SettingsHubContent(graph, session, wallet, owner, account, onBack, onSecurity, onFeedback, onCodex, onAbout, onFit,
            modifier, hosted, selectedTab, onTab, canRead)
    }
}

@Composable private fun SettingsHubContent(
    graph: AppGraph, session: SessionGraph?, wallet: WalletLogin?, owner: SettingsAccountScope?, account: AccountState,
    onBack: () -> Unit, onSecurity: () -> Unit, onFeedback: () -> Unit, onCodex: () -> Unit, onAbout: () -> Unit,
    onFit: (() -> Unit)?, modifier: Modifier, hosted: Boolean, selectedTab: String?, onTab: ((String) -> Unit)?,
    canRead: () -> Boolean,
) {
    val settings by graph.preferences.state.collectAsState()
    val system = LocalSystemExperience.current
    val context = LocalContext.current
    val coroutines = rememberCoroutineScope()
    val latestCanRead by rememberUpdatedState(canRead)
    // The same owner key ProfileHub uses, so both cards drive one sign-out owner.
    val accountModel = session?.let { s -> graphViewModel(s) { AccountViewModel(graph, s) } }
    val accountBusy = accountModel?.busy?.collectAsState()?.value == true
    val notifications = remember(graph) { if (graph.mode.offline) null else graph.notifications }
    val notificationState = notifications?.let { controller -> controller.state.collectAsState().value }
    val reports by LocalBattleReports.status.collectAsState()
    val feedback = session?.let { s -> s.feedback.state.collectAsState().value }
    var localTab by rememberSaveable { mutableStateOf("GAME") }
    val tab = (selectedTab ?: localTab).takeIf { it in SETTINGS_TABS } ?: "GAME"
    var rawTraces by remember { mutableStateOf(false) }
    var exportPermit by remember { mutableStateOf<LocalExportPermit?>(null) }
    var confirming by remember { mutableStateOf(false) }
    // The permission prompt's own answer; it clears once Android allows notifications again (SPEC §2.6 States).
    var notifyRefused by remember { mutableStateOf(false) }
    val signOutGate = remember { SettingsSignOutGate() }

    fun explain(reason: String) { Toasts.post(reason) }
    fun currentScope(): SettingsAccountScope? {
        val s = session ?: return null
        val now = graph.account.state.value
        if (graph.sessionGraph.value !== s || now.session !== s.session || graph.holder.current !== s.session) return null
        return SettingsAccountScope(s.session, now.selectedBaseId, now.baseSelectionGeneration)
    }
    fun ownerCurrent(): Boolean = if (owner == null) session == null else currentScope() == owner
    val gate = SettingsActionGate({ latestCanRead() && ownerCurrent() }, ::explain)

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        notifyRefused = !granted
        if (granted) notifications?.let { controller -> coroutines.launch { controller.enable() } }
        else explain("Notifications stay off until Android allows them.")
    }
    val exporter = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        val admitted = exportPermit
        exportPermit = null
        if (uri != null && admitted != null) LocalBattleReports.export(uri, admitted)
    }
    // The old card refreshed its state on open; the security row reads the existing /2fa/status owner (kept on failure).
    LaunchedEffect(notifications) { notifications?.refresh() }
    LaunchedEffect(owner, tab) {
        if (tab == "ACCOUNT" && owner != null && latestCanRead()) {
            try { graph.account.loadSecurity() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* The row keeps its last read, or "…" when there is none. */ }
        }
    }

    val signedIn = owner != null && account.phase == AccountPhase.SIGNED_IN && currentScope() == owner
    val version = "Version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"
    val ui = settingsLiveUi(settings, version, tab, systemReduceMotion = system.reduceMotion, systemHaptics = system.haptics,
        account = account.takeIf { signedIn }, navigationAvailable = signedIn,
        signOutAvailable = signedIn && accountModel != null && !accountBusy && !account.busy,
        notifications = notificationState, localReports = reports, rawTraces = rawTraces,
        confirm = if (confirming) ConfirmUi("SIGN OUT?", null, null, "Your kingdom stays.",
            "Saved requests stay on this device for recovery. Sign in again with your wallet or Google.", "SIGN OUT", Verb.STONE) else null,
        notificationPermissionRefused = notifyRefused && !NativeNotificationRuntime.permitted(context))
    // Only a fully read page is a real count; a partial page would understate new replies.
    val unread = feedback?.takeIf { it.loaded && it.nextCursor == null }?.reports?.count { it.unread }
    val help = settingsLiveHelpUi(settings, version, feedbackUnread = unread,
        systemReduceMotion = system.reduceMotion, systemHaptics = system.haptics, network = settingsNetworkLabel(graph.cluster.id))

    fun selectTab(next: String) {
        if (next in SETTINGS_TABS) { localTab = next; onTab?.invoke(next) } else explain("This Settings tab is not available.")
    }
    fun open(link: HubLink) {
        when (settingsDoor(link)) {
            SettingsDoor.SECURITY -> gate.run(signedIn, "Sign in to manage account security.") { onSecurity() }
            SettingsDoor.FEEDBACK -> gate.run(session != null, "Sign in to send feedback.") { onFeedback() }
            SettingsDoor.ABOUT -> gate.run(true) { onAbout() }
            null -> explain(SETTINGS_UNAVAILABLE)
        }
    }
    fun fit() {
        val fitBase = onFit
        gate.run(fitBase != null, "Open your kingdom to fit the base on screen.") { fitBase?.invoke() }
    }
    fun rowAction(id: String) {
        val controller = notifications
        val notify = notificationState
        val reportsReady = reports.enabled && !reports.busy
        when (id) {
            SETTINGS_SIGN_OUT_ROW -> gate.run(signedIn && accountModel != null && !accountBusy, "Sign out opens when your account is not busy.") {
                val scope = currentScope()
                if (scope != null) { signOutGate.request(scope); confirming = true } else explain(SETTINGS_STALE)
            }
            SETTINGS_NOTIFY_ON -> gate.run(signedIn && controller != null && notify != null && notify.supported && !notify.busy,
                "Notifications are not available right now.") {
                NativeNotificationRuntime.channel(context)
                if (Build.VERSION.SDK_INT >= 33 && !NativeNotificationRuntime.permitted(context)) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                else controller?.let { c -> coroutines.launch { c.enable() } }
            }
            SETTINGS_NOTIFY_OFF -> gate.run(signedIn && controller != null && notify?.busy == false, "Notifications are still updating.") {
                controller?.let { c -> coroutines.launch { c.disable() } }
            }
            SETTINGS_NOTIFY_ANDROID -> gate.run(true) {
                runCatching {
                    context.startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName))
                }.onFailure { explain("Android notification settings could not be opened on this phone.") }
            }
            SETTINGS_REPORTS_RAW -> gate.run(reportsReady, "Local reports are busy. Try again in a moment.") { rawTraces = !rawTraces }
            SETTINGS_REPORTS_HISTORY -> gate.run(reportsReady, "Local reports are busy. Try again in a moment.") {
                LocalBattleReports.inspectHistory(rawTraces)
            }
            SETTINGS_REPORTS_EXPORT -> gate.run(reportsReady, "Local reports are busy. Try again in a moment.") {
                exportPermit = LocalBattleReports.exportPermit(rawTraces)
                exporter.launch("pixel-kingdom-wars-local-report.zip")
            }
            SETTINGS_REPORTS_CLEAR -> gate.run(true) { LocalBattleReports.clear() }
            else -> explain(SETTINGS_UNAVAILABLE)
        }
    }
    // Declared after rowAction: the notification toggle runs the same row actions (local functions are not hoisted).
    fun toggle(key: String, on: Boolean) {
        gate.run(true) {
            val refusal = settingsToggleRefusal(ui.toggles, key)
            // The notification opt-in is not a device preference: it runs the old card's enable / disable owner calls.
            val notify = settingsToggleRowAction(key, on)
            if (refusal != null) explain(refusal)
            else if (notify != null) rowAction(notify)
            else if (!applySettingsToggle(graph.preferences, key, on)) explain("This setting is not available on this phone yet.")
        }
    }
    fun heldToggle(key: String) {
        // A refused permission is fixed in Android's notification settings, so the held row opens them (SPEC §2.6 States);
        // once Android allows them again the same tap runs the opt-in instead.
        val held = settingsHeldRowAction(ui.toggles, key)
        if (held == null) explain(settingsToggleRefusal(ui.toggles, key) ?: "This setting is held by Android settings.")
        else if (NativeNotificationRuntime.permitted(context)) { notifyRefused = false; rowAction(SETTINGS_NOTIFY_ON) }
        else rowAction(held)
    }
    fun cancelSignOut() { confirming = false; signOutGate.cancel() }
    fun confirmSignOut() {
        confirming = false
        val model = accountModel
        val admitted = latestCanRead() && model != null && !model.busy.value && !graph.account.state.value.busy
        if (!signOutGate.confirm(currentScope(), admitted) { model?.logout(wallet) }) explain("Your account changed. Open Settings again to sign out.")
    }

    BackHandlerAt(BackPriority.CONFIRM, confirming) { cancelSignOut() }
    if (!hosted) BackHandlerAt(BackPriority.SCREEN, !confirming) { onBack() }
    Box(modifier.then(if (hosted) Modifier else Modifier.background(PkwTokens.Colors.charcoal)
        .windowInsetsPadding(WindowInsets.safeDrawing).padding(8.dp))) {
        SettingsSheetR2(ui, help, SettingsActions(
            onTab = ::selectTab, onToggle = ::toggle, onOpen = ::open, onFit = ::fit, onBack = onBack, onClose = onBack,
            onRowAction = ::rowAction, onDisabledToggle = ::heldToggle, onConfirm = ::confirmSignOut, onConfirmBack = ::cancelSignOut,
        ), SettingsHelpActions(
            onChapter = { gate.run(true) { onCodex() } }, onOpen = ::open, onFit = ::fit, onToggle = ::toggle, onDisabledToggle = ::heldToggle,
        ), Modifier.fillMaxSize())
    }
}
