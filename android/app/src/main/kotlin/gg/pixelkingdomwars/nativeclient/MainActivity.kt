package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.diagnostics.SceneLoadLog
import gg.pixelkingdomwars.nativeclient.diagnostics.LoadEvent

import gg.pixelkingdomwars.nativeclient.diagnostics.LocalBattleReports
import android.content.Intent
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import gg.pixelkingdomwars.nativeclient.notifications.NativeNotificationRuntime
import gg.pixelkingdomwars.nativeclient.ui.nav.GameLinkViewModel
import gg.pixelkingdomwars.nativeclient.ui.nav.PendingGameLinks
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.DisposableEffect
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import gg.pixelkingdomwars.nativeclient.diagnostics.LocalNativeDiagnosticsEnabled
import gg.pixelkingdomwars.nativeclient.diagnostics.NativeDiagnosticsRuntime
import gg.pixelkingdomwars.nativeclient.diagnostics.NativeDiagnosticsReadout
import androidx.compose.ui.platform.createLifecycleAwareWindowRecomposer
import gg.pixelkingdomwars.nativeclient.ui.DeviceExperience
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.LocalSystemExperience
import gg.pixelkingdomwars.nativeclient.ui.LocalGameHaptic
import gg.pixelkingdomwars.nativeclient.ui.effectiveReducedMotion
import androidx.fragment.app.FragmentActivity
import com.badlogic.gdx.backends.android.AndroidFragmentApplication
import gg.pixelkingdomwars.nativeclient.data.LaunchMode
import gg.pixelkingdomwars.nativeclient.data.PrivateFleetCandidate
import gg.pixelkingdomwars.nativeclient.data.PrivateFleetContent
import gg.pixelkingdomwars.nativeclient.data.ServiceContentOwner
import gg.pixelkingdomwars.nativeclient.data.ServiceArtPermission
import gg.pixelkingdomwars.nativeclient.scene.LocalSceneHost
import gg.pixelkingdomwars.nativeclient.scene.SceneHost
import gg.pixelkingdomwars.nativeclient.scene.discardRestoredGlSurfaces
import gg.pixelkingdomwars.nativeclient.ui.PkwTheme
import gg.pixelkingdomwars.nativeclient.ui.nav.PkwApp
import gg.pixelkingdomwars.nativeclient.ui.preview.PreviewOptions
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import gg.pixelkingdomwars.nativeclient.wallet.SeekerLinkWallet

/** One activity, one Compose root. Screens are Navigation Compose destinations; the libGDX
 * kingdom lives in a fragment shared by every scene through [SceneHost]. */
class MainActivity : FragmentActivity(), AndroidFragmentApplication.Callbacks {
    private lateinit var graph: AppGraph
    private lateinit var links: PendingGameLinks
    private lateinit var experience: DeviceExperience
    private lateinit var sceneHost: SceneHost
    @Volatile private var activeServiceOwner: ServiceContentOwner? = null
    @Volatile private var serviceContentForeground = false
    private var wallet: WalletLogin? = null
    private var seekerWallet: SeekerLinkWallet? = null
    @OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        discardRestoredGlSurfaces(supportFragmentManager)
        // Fill the physical display, including cutouts on older Android versions. HUDs own safe
        // insets; scene backgrounds remain edge-to-edge. Transient system bars stay transparent.
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        window.setSoftInputMode((window.attributes.softInputMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST.inv())
            or WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        graph = (application as PkwApplication).graph(LaunchMode.fromLaunch(BuildConfig.DEBUG, intent.getStringExtra("preview")))
        // Decode the first Home frame's shared art off Main while boot and sign-in draw (cache fill only; see prewarmShellArt).
        lifecycleScope.launch(Dispatchers.Default) { gg.pixelkingdomwars.nativeclient.ui.chrome.prewarmShellArt(resources) }
        // Scene-transitions spec §4 step 5: decode the last kingdom postcard off Main while boot draws, so a cold Home opens on it.
        gg.pixelkingdomwars.nativeclient.scene.ScenePostcards.install(noBackupFilesDir)
        lifecycleScope.launch(Dispatchers.IO) { gg.pixelkingdomwars.nativeclient.scene.ScenePostcards.prewarm() }
        // Cold-start measurement 2026-10-06: the last /base answer is parsed off Main too, so Home maps its scene without
        // waiting for /base, /balances and /tutorial (LastBasePayload).
        gg.pixelkingdomwars.nativeclient.scene.LastBasePayload.install(noBackupFilesDir)
        lifecycleScope.launch(Dispatchers.IO) { gg.pixelkingdomwars.nativeclient.scene.LastBasePayload.prewarm() }
        LocalBattleReports.initialize(applicationContext)
        lifecycleScope.launch { graph.preferences.state.collect { LocalBattleReports.setEnabled(it.localBattleReports) } }
        links = ViewModelProvider(this)[GameLinkViewModel::class.java].links
        captureGameLink(intent, restored = savedInstanceState != null)
        if (BuildConfig.DEBUG) PreviewOptions.current = PreviewOptions.fromExtras(intent.getStringExtra("previewRealm"), intent.getIntExtra("previewArt", 0),
            intent.getBooleanExtra("previewWalls", false), intent.getBooleanExtra("previewJob", false), intent.getStringExtra("previewArmy"))
        if (BuildConfig.DEBUG) gg.pixelkingdomwars.nativeclient.scene.world.WorldEngineFlags.gl30Requested = intent.getBooleanExtra("worldGl30", false)
        if (BuildConfig.DEBUG) gg.pixelkingdomwars.nativeclient.scene.world.WorldEngineFlags.legacyWorld = intent.getBooleanExtra("worldLegacy", false)
        // Only the offline source fixture is visible above keyguard; real accounts never are.
        if (BuildConfig.DEBUG && graph.mode.offline) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
            else window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        if (!graph.mode.offline) wallet = WalletLogin(this, graph.gameApi, graph.walletStore, graph.walletIdentityOrigin)
        if (!graph.mode.offline) seekerWallet = SeekerLinkWallet(this, graph.walletIdentityOrigin)
        sceneHost = SceneHost(this)
        // DeviceLog, not Log.i: candidates are R8 builds where the wallet's Log rule strips direct calls (field report 2026-10-06).
        SceneLoadLog.sink = if (BuildConfig.DEBUG || BuildConfig.NATIVE_CANDIDATE) ({ line ->
            gg.pixelkingdomwars.nativeclient.diagnostics.DeviceLog.info(if (line.startsWith("FRAMES ")) "PKWFrames" else "PKWLoad", line) }) else null
        if (!graph.mode.offline) bindServiceContent(sceneHost)
        experience = DeviceExperience(this, graph.preferences)
        lifecycle.addObserver(experience)
        experience.applyPreferences()
        // Activity-local animation context; retains Compose's normal lifecycle/frame-clock behavior.
        val recomposer = window.decorView.createLifecycleAwareWindowRecomposer(experience.motionScale, lifecycle)
        setContent(parent = recomposer) {
            val settings by graph.preferences.state.collectAsState()
            val system by experience.state.collectAsState()
            val diagnosticsEnabled = settings.diagnostics && !graph.mode.offline && system.foreground
            DisposableEffect(diagnosticsEnabled) { NativeDiagnosticsRuntime.setEnabled(diagnosticsEnabled); onDispose { NativeDiagnosticsRuntime.setEnabled(false) } }
            LaunchedEffect(settings) { experience.applyPreferences() }
            PkwTheme {
                CompositionLocalProvider(LocalSceneHost provides sceneHost,
                    LocalNativeDiagnosticsEnabled provides diagnosticsEnabled,
                    LocalReducedMotion provides effectiveReducedMotion(settings, system),
                    LocalSystemExperience provides system, gg.pixelkingdomwars.nativeclient.ui.LocalDeviceExperience provides experience, LocalGameHaptic provides experience::haptic) {
                    Surface { Box {
                        PkwApp(graph, wallet, seekerWallet, links) { finish() }
                        gg.pixelkingdomwars.nativeclient.ui.chrome.KitToastLayer()
                        NativeDiagnosticsReadout(Modifier.align(Alignment.TopStart).safeDrawingPadding())
                    } }
                }
            }
        }
    }
    /** Foreground/account/content ownership is independent of scene inventory.
     * Only exact renderer15 metadata opens an optional source; legacy14 stays inert. */
    private fun bindServiceContent(host: SceneHost) = lifecycleScope.launch {
        repeatOnLifecycle(Lifecycle.State.RESUMED) {
            combine(graph.sessionGraph, graph.content.state) { account, content -> account to content }
                .distinctUntilChanged { old, next ->
                    old.first === next.first && old.second.assets == next.second.assets &&
                        old.second.catalogue === next.second.catalogue && old.second.renderCatalogue === next.second.renderCatalogue &&
                        old.second.manifest === next.second.manifest
                }.collectLatest { (account, content) ->
                    val contract = (content.renderCatalogue?.get("rendererContractVersion") as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
                    if (account == null || content.assets == null || (contract != 15 && contract != 17)) return@collectLatest
                    // collectLatest/repeatOnLifecycle join the previous finally; retain an explicit
                    // fence so no replacement can make an unfinished retirement stale in the sink.
                    activeServiceOwner?.let { previous ->
                        withContext(NonCancellable) { runCatching { previous.requestRetirement().await() } }
                    }
                    val owner = Any()
                    val retirement = ServiceContentOwner(
                        retireAdmission = { completion, afterInvalidated ->
                            graph.constructionContentAdmissions.retire(owner, completion, afterInvalidated)
                        },
                        launchCleanup = { cleanup ->
                            lifecycleScope.launch(NonCancellable + Dispatchers.Main.immediate) { cleanup() }
                        },
                        onFailure = { failure -> android.util.Log.e("ServiceContent", "Service owner retirement failed", failure) },
                    )
                    graph.constructionContentAdmissions.beginOwner(owner)
                    val openTicket = retirement.beginOpen()
                    activeServiceOwner = retirement
                    retirement.beforeSourceClose { host.clearServices(owner) }
                    retirement.bindOwner(account.scope.coroutineContext.job)
                    fun requireCurrent() {
                        account.scope.coroutineContext.job.ensureActive(); graph.holder.requireCurrent(account.session)
                        val latest = graph.content.state.value
                        if (!serviceContentForeground || retirement.requested || activeServiceOwner !== retirement ||
                            latest.assets != content.assets || latest.catalogue !== content.catalogue ||
                            latest.renderCatalogue !== content.renderCatalogue || latest.manifest !== content.manifest)
                            throw CancellationException("Service content owner changed")
                    }
                    fun publishPermission(permitted: Boolean) {
                        graph.constructionContentAdmissions.permission(owner, permitted)
                        host.servicePermission(owner, permitted)
                    }
                    try {
                        if (contract == 15) {
                            val observation = try {
                                val admitted = graph.serviceContent.open(content, account.api,
                                    account.scope.coroutineContext.job, retirement, ::requireCurrent)
                                requireCurrent()
                                graph.constructionContentAdmissions.setSource(owner, account.session, content, admitted)
                                host.serviceSource(owner, content.assets, admitted.assets)
                                ServiceArtPermission(account.api, ::requireCurrent, ::publishPermission).also {
                                    retirement.beforeSourceClose(it::close)
                                }
                            } finally { openTicket.close() }
                            // Contract 15 follows the capability cadence too: a same-base scene preparation must not run the
                            // observer's false-first re-observation, or every base refresh revokes the construction admission.
                            host.capabilityRefreshRequests.collectLatest { observation.refresh() }
                        } else {
                            // R17 consumes only the already-published immutable directory and pins.
                            // NR5 may reuse verified metadata; each open still owns a new session and permission.
                            val opened = try {
                                val manifest = requireNotNull(content.manifest)
                                requireCurrent()
                                PrivateFleetContent(graph.serviceContent).open(
                                    PrivateFleetCandidate(manifest.contentVersion, manifest.simVersion),
                                    content.assets, manifest, account.api, account.scope.coroutineContext.job,
                                    retirement, ::requireCurrent, ::publishPermission,
                                ).also { handle ->
                                    requireCurrent()
                                    graph.constructionContentAdmissions.setSource(owner, account.session, content, handle.session)
                                    host.serviceSource(owner, content.assets, handle.session.assets, handle.fleet)
                                    account.fleetJourneys?.let { publication ->
                                        host.fleetPublication(owner, publication, { account.base.state.value.base?.baseId }, handle)
                                    }
                                }
                            } finally { openTicket.close() }
                            // Preserve the existing capability-only cadence; no second reader.
                            host.capabilityRefreshRequests.collectLatest { opened.refreshPermission() }
                        }
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { /* Optional content cannot replace the current core scene. */ }
                    finally {
                        val completion = retirement.requestRetirement()
                        openTicket.close()
                        withContext(NonCancellable) { runCatching { completion.await() } }
                        if (activeServiceOwner === retirement) activeServiceOwner = null
                    }
                }
        }
    }
    /** Scene-transitions spec §4 step 5: memory pressure drops the in-memory kingdom postcard; its disk copy stays. */
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        gg.pixelkingdomwars.nativeclient.scene.ScenePostcards.trim(level)
    }
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && ::experience.isInitialized) experience.applyFullscreen()
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent) // Retain SDK/Activity result dispatch; callback schemes are not game links.
        captureGameLink(intent, restored = false)
    }
    private fun captureGameLink(incoming: Intent, restored: Boolean) {
        if (!NativeNotificationRuntime.allowedTap(this, incoming)) {
            setIntent(Intent(incoming).setData(null).apply { removeExtra(NativeNotificationRuntime.BINDING_EXTRA) }); return
        }
        if (links.capture(incoming.action, incoming.dataString, restored, graph.account.state.value,
                graph.holder.current, graph.origin, graph.mode.offline) ||
            links.offerBrowser(incoming.action, incoming.dataString, restored, graph.mode.offline, graph.origin)) {
            // Match web history.replaceState: recreation cannot replay the consumed launch URL.
            setIntent(Intent(incoming).setData(null))
        }
    }
    override fun onStart() {
        super.onStart()
        // Owner 2026-09-27: a warm start never re-asked, so a tester row published while this process lived was never offered.
        if (::graph.isInitialized && !graph.mode.offline) graph.onForeground()
    }
    override fun onResume() {
        serviceContentForeground = true
        if (::sceneHost.isInitialized) sceneHost.resumed()
        super.onResume()
        LocalBattleReports.foreground(true)
        if (::graph.isInitialized && !graph.mode.offline) lifecycleScope.launch { graph.notifications.refresh() }
        if (::graph.isInitialized && !graph.mode.offline) lifecycleScope.launch { gg.pixelkingdomwars.nativeclient.telemetry.NativeTelemetryRuntime.flush() }
    }
    override fun onPause() {
        serviceContentForeground = false
        // Fence admission before FragmentActivity propagates pause/cancellation to fragments.
        activeServiceOwner?.requestRetirement()
        LocalBattleReports.foreground(false)
        super.onPause()
    }
    override fun onStop() {
        if (::graph.isInitialized && !graph.mode.offline) lifecycleScope.launch { gg.pixelkingdomwars.nativeclient.telemetry.NativeTelemetryRuntime.flush() }
        super.onStop()
    }
    override fun exit() { runOnUiThread { finish() } }
}
