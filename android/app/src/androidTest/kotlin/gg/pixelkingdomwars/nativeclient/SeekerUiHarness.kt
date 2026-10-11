package gg.pixelkingdomwars.nativeclient

import android.app.Instrumentation
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Build
import android.view.Choreographer
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.TrainingScheduling
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.network.maxLevelFor
import gg.pixelkingdomwars.nativeclient.ui.KeepConfirmPreference
import gg.pixelkingdomwars.nativeclient.ui.KeepSpendConfirmState
import gg.pixelkingdomwars.nativeclient.ui.KeepSpendIntent
import gg.pixelkingdomwars.nativeclient.ui.KeepSpendConfirmDialog
import gg.pixelkingdomwars.nativeclient.ui.CancelJobIntent
import gg.pixelkingdomwars.nativeclient.ui.CancelJobConfirmDialog
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.boot.BootScreen
import gg.pixelkingdomwars.nativeclient.ui.boot.bootLoadingStrip
import gg.pixelkingdomwars.nativeclient.ui.boot.rememberBootTip
import gg.pixelkingdomwars.nativeclient.ui.chrome.LoadingCard
import gg.pixelkingdomwars.nativeclient.ui.PkwTheme
import gg.pixelkingdomwars.nativeclient.ui.army.ReviewTrainingDialog
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyScreen
import gg.pixelkingdomwars.nativeclient.ui.army.ResearchScreen
import gg.pixelkingdomwars.nativeclient.ui.chrome.GamePage
import gg.pixelkingdomwars.nativeclient.ui.economy.MarketTradePanel
import gg.pixelkingdomwars.nativeclient.ui.roster.InventoryScreen
import gg.pixelkingdomwars.nativeclient.ui.community.CommunityScreen
import gg.pixelkingdomwars.nativeclient.ui.community.CommunityPage
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequest
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRequests
import gg.pixelkingdomwars.nativeclient.ui.home.HomeScaffold
import gg.pixelkingdomwars.nativeclient.ui.kingdom.BuildingSheet
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomLocal
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.HeroBuildMenu
import gg.pixelkingdomwars.nativeclient.ui.kingdom.BuilderOverviewSheet
import gg.pixelkingdomwars.nativeclient.ui.kingdom.SheetConfirmation
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KeepSpendDialog
import gg.pixelkingdomwars.nativeclient.ui.kingdom.CancelJobDialog
import gg.pixelkingdomwars.nativeclient.ui.kingdom.WallRowDialog
import gg.pixelkingdomwars.nativeclient.ui.nav.BackRegistry
import gg.pixelkingdomwars.nativeclient.ui.nav.LocalBackRegistry
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** Screenshot fixtures from the owner's September 14 Seeker report. These values are test data,
 * never game constants or an account snapshot. Production components own every pixel and action gate.
 * Optional view models use existing repository seams with memory-only fixtures and a rejecting API
 * interface. That fixture graph does not use an HTTP client, retained account store or wallet.
 * The offline MainActivity host retains its normal UI preferences and lazy graph; no retained
 * account session is hydrated and no network or wallet operation is requested by these fixtures. */
internal object SeekerUiHarness {
    private val nextActivityConfiguration = java.util.concurrent.atomic.AtomicReference<Configuration?>()
    fun applyActivityConfiguration(activity: android.app.Activity) {
        if (activity is MainActivity) nextActivityConfiguration.getAndSet(null)?.let { activity.applyOverrideConfiguration(Configuration(it)) }
    }

    private val loadingModes = setOf("seeker-boot-preparing", "seeker-boot-restoring", "seeker-boot-error", "seeker-boot-retrying",
        "seeker-world-progress", "seeker-world-error", "seeker-world-preparing", "seeker-scene-base-loading", "seeker-scene-battle-loading",
        "seeker-replay-opening", "seeker-replay-error")
    private val extendedModes = setOf("seeker-hero-catalog", "seeker-hero-placed", "seeker-goldforge-funds", "seeker-builders",
        "seeker-building-keep", "seeker-building-cancel", "seeker-keep-confirm", "seeker-research-cancel", "seeker-wall-row",
        "seeker-army-queue", "seeker-research-active", "seeker-market-pending", "seeker-market-settled", "seeker-inventory-detail", "seeker-mail-detail")
    val modes = setOf("floating-hud", "seeker-barracks", "seeker-goldforge", "seeker-hud", "seeker-training-review") + loadingModes + extendedModes
    private const val BASE = "11111111-1111-4111-8111-111111111111"
    private const val WALLET = "offline-seeker-ui-fixture"
    private const val BARRACKS = "22222222-2222-4222-8222-222222222222"
    private const val GOLDFORGE = "33333333-3333-4333-8333-333333333333"

    fun capture(instrumentation: Instrumentation, mode: String, reducedMotion: Boolean = false, orientation: String? = null, profile: String? = null): String {
        check(mode in modes)
        if (mode == "floating-hud" || mode == "seeker-hud") return FloatingHudHarness.capture(instrumentation, orientation, homeOnly = mode == "seeker-hud", profileName = profile)
        require(orientation == null || orientation in setOf("portrait", "landscape")) { "Fixture orientation must be portrait or landscape" }
        check(BuildConfig.DEBUG && Build.HARDWARE == "ranchu")
        val origin = BuildConfig.API_ORIGIN.toHttpUrl()
        val labels = origin.host.split('.')
        val octets = labels.mapNotNull(String::toIntOrNull)
        val privateHost = origin.host in setOf("localhost", "127.0.0.1") ||
            (labels.size == 4 && octets.size == 4 && octets.all { it in 0..255 } &&
                (octets[0] == 10 || octets[0] == 172 && octets[1] in 16..31 || octets[0] == 192 && octets[1] == 168))
        check(origin.isHttps && origin.port == 18443 && privateHost)
        val loading = mode in loadingModes
        val bounded = loading || mode in extendedModes || mode in setOf("seeker-barracks", "seeker-goldforge")
        val context = instrumentation.targetContext
        val initialConfiguration = Configuration(context.resources.configuration)
        var configuration = Configuration(initialConfiguration)
        var activityOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        var orientationChecked = false
        val root = File(context.noBackupFilesDir, "seeker-ui")
        check(root.mkdirs() || root.isDirectory)
        val directory = File(root, "$mode-${configuration.screenWidthDp}x${configuration.screenHeightDp}-${System.currentTimeMillis()}")
        check(directory.mkdir())
        var stage = "verify-bundled-catalogue"
        var activity: MainActivity? = null
        var fixtures: SeekerUiFixtures? = null
        var nodeCount = 0
        var visibleCount = 0
        val expected = when (mode) {
            "seeker-barracks" -> listOf("BARRACKS", "FINISH NOW", "2,688 KEEP", "Close building details")
            "seeker-goldforge" -> listOf("GOLD FORGE", "MAX LEVEL", "SMELT SHARDS", "Close building details")
            "seeker-hud" -> listOf("SHARDS", "KEEP", "TROPHIES", "SOL", "SHIELD")
            "seeker-boot-preparing" -> listOf("Opening your kingdom…")
            "seeker-boot-restoring" -> listOf("Opening your kingdom…")
            "seeker-boot-error" -> listOf("Couldn't open your kingdom", "TRY AGAIN")
            "seeker-boot-retrying" -> listOf("Opening your kingdom…", "TRYING AGAIN…")
            "seeker-world-progress" -> listOf("Opening the world…", "Downloading · 50%")
            "seeker-world-error" -> listOf("Couldn't open the world", "TRY AGAIN")
            "seeker-world-preparing" -> listOf("Opening the world…")
            "seeker-scene-base-loading" -> listOf("Opening your kingdom…")
            "seeker-scene-battle-loading" -> listOf("Entering battle…")
            "seeker-replay-opening" -> listOf("Opening the replay…", "CLOSE")
            "seeker-replay-error" -> listOf("Couldn’t open this replay", "TRY AGAIN", "CLOSE")
            "seeker-hero-catalog" -> listOf("HERO ALTARS", "ALREADY PLACED", "CHOOSE ALTAR LOCATION", "REFRESH HERO CONTRACTS")
            "seeker-hero-placed" -> listOf("HERO ALTARS", "ALREADY PLACED", "REFRESH HERO CONTRACTS")
            "seeker-goldforge-funds" -> listOf("GOLD FORGE", "Not enough funds for this action.", "REFRESH BUILDING", "SMELT SHARDS")
            "seeker-builders" -> listOf("BUILDERS", "OWNED", "WORKING", "RESTING", "ALL BUILDER SLOTS OWNED", "DONE")
            "seeker-building-keep" -> listOf("SPEND KEEP?", "2,688 KEEP", "CONFIRM", "CANCEL")
            "seeker-building-cancel" -> listOf("CANCEL UPGRADE?", "REFUND +1,000 SHARDS", "KEEP GOING")
            "seeker-keep-confirm" -> listOf("SPEND KEEP?", "2,688", "CONFIRM", "CANCEL")
            "seeker-research-cancel" -> listOf("CANCEL RESEARCH?", "REFUND", "SHARDS", "KEEP GOING")
            "seeker-wall-row" -> listOf("UPGRADE WALL ROW", "OF 4 WALLS", "TOTAL", "UPGRADE 3 WALLS", "CANCEL")
            "seeker-army-queue" -> listOf("TRAIN TROOPS", "FINISH ALL", "ARMY CAPACITY", "SELECT TROOPS", "REVIEW TRAINING")
            "seeker-research-active" -> listOf("FORGE RESEARCH", "RESEARCH IN PROGRESS", "FINISH RESEARCH", "CANCEL", "UPGRADE TROOPS")
            "seeker-market-pending" -> listOf("CONFIRMING PAYMENT", "0.001 SOL", "Payment confirmation is pending.", "Check saved purchase")
            "seeker-market-settled" -> listOf("PURCHASE COMPLETE", "0.001 SOL", "Payment confirmed. Item delivered.", "DONE", "REFRESH")
            "seeker-inventory-detail" -> listOf("INVENTORY", "KEG OF HASTE", "3 owned, 3 available", "USE", "SELL ON MARKET", "Close item details")
            "seeker-mail-detail" -> listOf("KEEP MAIL", "PLAYTEST REWARD", "ATTACHED REWARD", "1,000 SHARDS", "Reward: claimed", "Claim destination:", "ARCHIVE", "BACK TO MAIL")
            else -> listOf("REVIEW TRAINING", "TRAINING COST", "ADD TO QUEUE", "CLOSE")
        }
        var counts = emptyMap<String, Int>()
        var boundedCounts = emptyMap<String, Int>()
        var scrolls = 0
        var progressRangeChecked = false
        var retryTargetChecked = false
        var width = 0
        var height = 0
        fun receipt(status: String) {
            File(directory, "receipt.json").writeText(buildJsonObject {
                put("status", status); put("stage", stage); put("mode", mode)
                put("syntheticUiOnly", true); put("productionComposables", true)
                put("accountAccessed", false); put("networkAccessRequested", false); put("walletApprovalTested", false)
                put("requestedOrientation", orientation ?: "device")
                put("activityRequestedOrientation", activityOrientation)
                put("initialScreenWidthDp", initialConfiguration.screenWidthDp); put("initialScreenHeightDp", initialConfiguration.screenHeightDp)
                put("screenWidthDp", configuration.screenWidthDp); put("screenHeightDp", configuration.screenHeightDp)
                put("actualConfigurationOrientation", when (configuration.orientation) {
                    Configuration.ORIENTATION_PORTRAIT -> "portrait"
                    Configuration.ORIENTATION_LANDSCAPE -> "landscape"
                    else -> "undefined"
                })
                put("capturedOrientation", when { width == 0 || height == 0 -> "unavailable"; width < height -> "portrait"; width > height -> "landscape"; else -> "square" })
                put("requestedOrientationChecked", orientationChecked)
                put("densityDpi", configuration.densityDpi); put("fontScale", configuration.fontScale)
                put("reducedMotion", reducedMotion); put("loadingBoundsChecked", loading && boundedCounts.size == expected.size && boundedCounts.values.all { it > 0 })
                put("controlsBoundsChecked", bounded && boundedCounts.size == expected.size && boundedCounts.values.all { it > 0 })
                put("prohibitedFixtureCalls", fixtures?.prohibitedCalls ?: 0); put("inertFixtureRefreshes", fixtures?.refreshes ?: 0)
                put("fixtureViewModelsCleared", fixtures?.cleared ?: true)
                put("capturedWidthPx", width); put("capturedHeightPx", height); put("scrollsToReachControls", scrolls)
                put("boundedVisibleExpectedLabels", buildJsonObject { boundedCounts.forEach { (label, count) -> put(label, count) } })
                put("determinateProgressRangeChecked", progressRangeChecked); put("retryTouchTargetChecked", retryTargetChecked)
                put("accessibilityNodes", nodeCount); put("visibleAccessibilityNodes", visibleCount)
                put("expectedLabels", buildJsonObject { counts.forEach { (label, count) -> put(label, count) } })
                put("visualInspectionRequired", true)
                if (File(directory, "screen.png").isFile) put("screenshotSha256", sha(File(directory, "screen.png").readBytes()))
            }.toString())
        }
        try {
            receipt("running")
            val manifest = context.assets.open("native/manifest.json").use { it.readBytes() }
            val assets = BundledContent.prepare(context.noBackupFilesDir, manifest, debug = true,
                verifier = "seeker-ui-${BuildConfig.VERSION_CODE}") { path -> context.assets.open("native/$path") }
            val catalogue = Json.parseToJsonElement(File(assets, "catalogue.json").readText()).jsonObject
            val replayContent = if (mode == "seeker-replay-error") ContentState(assets, catalogue,
                Json.parseToJsonElement(File(assets, "render-catalog.json").readText()).jsonObject) else ContentState()
            val now = System.currentTimeMillis()
            val home = fixtureHome(now)
            if (loading && profile == "large") nextActivityConfiguration.set(Configuration().apply { fontScale = 1.5f })
            stage = "launch-offline-preview"; receipt("running")
            val host = instrumentation.startActivitySync(Intent(context, MainActivity::class.java)
                .putExtra("preview", "base").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) as MainActivity
            activity = host
            check(host.intent.getStringExtra("preview") == "base")
            instrumentation.runOnMainSync {
                if (mode in setOf("seeker-army-queue", "seeker-research-active", "seeker-market-pending", "seeker-market-settled", "seeker-inventory-detail", "seeker-mail-detail"))
                    fixtures = SeekerUiFixtures(catalogue, home, System.currentTimeMillis())
                host.setContent {
                    PkwTheme {
                        CompositionLocalProvider(LocalBackRegistry provides remember { BackRegistry() }, LocalReducedMotion provides reducedMotion) {
                            // Match MainActivity's Surface: production text inherits onSurface.
                            Surface { Box {
                                if (loading) FixtureLoading(mode, replayContent)
                                else if (mode == "seeker-training-review") {
                                    Box(Modifier.fillMaxSize().background(Palette.backdrop))
                                    ReviewTrainingDialog(reviewFixture(), false, onConfirm = {}, onDismiss = {})
                                } else if (mode in setOf("seeker-building-keep", "seeker-building-cancel", "seeker-keep-confirm", "seeker-research-cancel", "seeker-wall-row")) FixtureDialog(mode, catalogue)
                                else if (fixtures != null) FixtureModelScreen(mode, requireNotNull(fixtures))
                                else FixtureKingdom(mode, catalogue, home, now)
                            } }
                        }
                    }
                }
            }
            stage = "await-layout-and-accessibility"; receipt("running")
            heldFrames(instrumentation)
            // MainActivity's offline host first applies its retained device preferences. Override
            // only this fixture Activity after replacement content has disposed those effects;
            // never write the owner's LANDSCAPE LOCK preference or system rotation settings.
            if (orientation != null) {
                val requested = if (orientation == "portrait") ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                val expectedConfiguration = if (orientation == "portrait") Configuration.ORIENTATION_PORTRAIT else Configuration.ORIENTATION_LANDSCAPE
                instrumentation.runOnMainSync { host.requestedOrientation = requested }
                stage = "await-requested-orientation"; receipt("running")
                val orientationDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                var stableFrames = 0
                var previous: Configuration? = null
                var previousSize: Pair<Int, Int>? = null
                do {
                    heldFrames(instrumentation)
                    var size = 0 to 0
                    instrumentation.runOnMainSync {
                        configuration = Configuration(host.resources.configuration)
                        activityOrientation = host.requestedOrientation
                        size = host.window.decorView.width to host.window.decorView.height
                    }
                    val shapeMatches = if (orientation == "portrait") size.first < size.second else size.first > size.second
                    val matches = activityOrientation == requested && configuration.orientation == expectedConfiguration &&
                        size.first > 0 && size.second > 0 && shapeMatches
                    stableFrames = if (!matches) 0 else if (configuration == previous && size == previousSize) stableFrames + 1 else 1
                    previous = configuration; previousSize = size
                } while (stableFrames < 2 && System.nanoTime() < orientationDeadline)
                check(stableFrames >= 2) { "Fixture did not settle in requested $orientation orientation" }
            } else instrumentation.runOnMainSync {
                configuration = Configuration(host.resources.configuration)
                activityOrientation = host.requestedOrientation
            }
            stage = "await-layout-and-accessibility"; receipt("running")
            // Accessibility is asynchronous to composition. Wait boundedly for the expected screen.
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            var nodes = emptyList<JsonObject>()
            do {
                nodes = freshAccessibility(instrumentation)
                counts = expected.associateWith { label -> nodes.count { node ->
                    listOf("text", "description").any { key -> node[key]?.jsonPrimitive?.content.orEmpty().contains(label) }
                } }
                if (if (bounded) (counts[expected.first()] ?: 0) > 0 else counts.values.all { it > 0 }) break
                Thread.sleep(100)
            } while (System.nanoTime() < deadline)
            nodeCount = nodes.size
            visibleCount = nodes.count { it["visible"]?.jsonPrimitive?.booleanOrNull == true }
            if (loading) {
                val visibleText = nodes.filter { it["visible"]?.jsonPrimitive?.booleanOrNull == true }
                    .map { it["text"]?.jsonPrimitive?.content.orEmpty() }
                check(visibleText.none { it.contains(Regex("preparing|artwork", RegexOption.IGNORE_CASE)) }) {
                    "Engineering preparation phases must stay out of player loading copy"
                }
                if (mode.startsWith("seeker-world")) {
                    check(visibleText.none { it.trim() in setOf("+", "−", "-") || it.contains("DETAILS") }) {
                        "Map controls must not sit beneath a blocking world loader"
                    }
                    if (mode != "seeker-world-progress") check(visibleText.none { it.contains("%") || it.contains("Downloading") }) {
                        "Warm world entry must not pretend to download again"
                    }
                }
                if (mode.startsWith("seeker-replay")) check(visibleText.none {
                    it.trim() in setOf("+", "−", "-", "1X", "PAUSE", "RESULT", "REPLAY") || it.contains("DESTROYED")
                }) { "Gameplay chrome must not cover replay opening or recovery" }
            }
            File(directory, "accessibility.json").writeText(JsonArray(nodes).toString())
            stage = "capture"; receipt("running")
            fun screenshot(name: String) {
                orientationChecked = false
                instrumentation.runOnMainSync {
                    configuration = Configuration(host.resources.configuration)
                    activityOrientation = host.requestedOrientation
                }
                val bitmap = requireNotNull(instrumentation.uiAutomation.takeScreenshot()) { "No Android screenshot" }
                width = bitmap.width; height = bitmap.height
                try { File(directory, name).outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) } }
                finally { bitmap.recycle() }
                if (orientation != null) {
                    val matches = if (orientation == "portrait") width < height && configuration.orientation == Configuration.ORIENTATION_PORTRAIT
                        else width > height && configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
                    check(matches) { "Captured ${width}x$height screenshot does not match requested $orientation orientation" }
                    orientationChecked = true
                }
            }
            screenshot("screen.png")
            if (bounded) {
                fun recordBounds() {
                    boundedCounts = expected.associateWith { label ->
                        val visible = nodes.filter { node -> matches(node, label) && inViewport(node, width, height) }
                        // Mail pins an ARCHIVE navigation tab above its separate detail action.
                        // Require two distinct visible targets so the tab cannot certify the action.
                        val count = if (mode == "seeker-mail-detail" && label == "ARCHIVE") {
                            visible.mapNotNull { it["clickableBounds"] as? JsonArray }.distinct().size.let { if (it >= 2) it else 0 }
                        } else visible.size
                        maxOf(boundedCounts[label] ?: 0, count)
                    }
                    counts = expected.associateWith { label -> maxOf(counts[label] ?: 0, nodes.count { matches(it, label) }) }
                    val retry = expected.firstOrNull { it in setOf("TRY AGAIN", "TRYING AGAIN…") }
                    if (retry != null) nodes.filter { matches(it, retry) && inViewport(it, width, height) }.forEach { node ->
                        val target = node["clickableBounds"] as? JsonArray
                        if (target != null) {
                            val bounds = target.map { it.jsonPrimitive.int }
                            val minimumDp = if (loading) 48f else 44f
                            val minimum = minimumDp * configuration.densityDpi / 160f
                            check(bounds[2] - bounds[0] >= minimum - 1 && bounds[3] - bounds[1] >= minimum - 1) { "Retry touch target is smaller than ${minimumDp}dp" }
                            check(node["clickableEnabled"]?.jsonPrimitive?.booleanOrNull == (mode != "seeker-boot-retrying")) { "Retry enabled state disagrees with loading state" }
                            retryTargetChecked = true
                        }
                    }
                    if (mode == "seeker-world-progress") {
                        progressRangeChecked = progressRangeChecked || nodes.any { node ->
                            val range = node["range"] as? JsonArray
                            range != null && range[0].jsonPrimitive.float == 0f && range[1].jsonPrimitive.float == 1f && range[2].jsonPrimitive.float == .5f
                        }
                    }
                }
                recordBounds()
                // Inventory has independent equipment, backpack and item-detail scroll panes.
                // Keep the selected pane's bounds so its close control can scroll out of view.
                val scrollBounds = if (mode == "seeker-inventory-detail") selectedItemScrollBounds(freshRoot(instrumentation)) else null
                // Short landscapes may legitimately scroll. Prove the retry can enter the viewport,
                // preserving both the initial and scrolled evidence rather than calling clipping a pass.
                while (boundedCounts.values.any { it == 0 } && scrolls < 6 && scrollForward(instrumentation, scrollBounds)) {
                    scrolls++
                    heldFrames(instrumentation)
                    nodes = freshAccessibility(instrumentation)
                    File(directory, "accessibility-scroll-$scrolls.json").writeText(JsonArray(nodes).toString())
                    screenshot("screen-scroll-$scrolls.png")
                    recordBounds()
                }
                check(boundedCounts.values.all { it > 0 }) { "Expected text or controls cannot be reached inside the viewport" }
                if (expected.any { it in setOf("TRY AGAIN", "TRYING AGAIN…") }) check(retryTargetChecked) { "No accessible retry touch target" }
                if (mode == "seeker-world-progress") check(progressRangeChecked) { "Verified-file progress is not exposed as 13/26" }
            }
            check(counts.values.all { it > 0 }) { "Expected UI labels were absent; inspect accessibility.json and screen.png" }
            if (mode.startsWith("seeker-replay")) {
                fun clickLabel(node: AccessibilityNodeInfo?, label: String): Boolean {
                    if (node == null || !node.refresh()) return false
                    if (node.isVisibleToUser && node.text?.toString() == label) {
                        var parent: AccessibilityNodeInfo? = node
                        while (parent != null) {
                            if (parent.isClickable && parent.isEnabled) return parent.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                            parent = parent.parent
                        }
                    }
                    return (0 until node.childCount).any { clickLabel(node.getChild(it), label) }
                }
                if (mode == "seeker-replay-error") {
                    check(clickLabel(freshRoot(instrumentation), "TRY AGAIN")) { "Replay retry is unreachable" }
                    heldFrames(instrumentation)
                    val retried = freshAccessibility(instrumentation)
                    check(retried.any { matches(it, "Couldn’t open this replay") }) { "Failed replay retry lost its recovery state" }
                    screenshot("screen-retry.png")
                }
                check(clickLabel(freshRoot(instrumentation), "CLOSE")) { "Replay close is unreachable" }
                heldFrames(instrumentation)
                check(freshAccessibility(instrumentation).any { matches(it, "REPLAY CLOSED") }) { "Close did not exit the replay presentation" }
                screenshot("screen-closed.png")
            }
            if (mode in setOf("seeker-barracks", "seeker-goldforge", "seeker-goldforge-funds")) {
                fun clickDetails(node: AccessibilityNodeInfo?): Boolean {
                    if (node == null || !node.refresh()) return false
                    if (node.isVisibleToUser && node.text?.toString() == "DETAILS") {
                        var parent: AccessibilityNodeInfo? = node
                        while (parent != null) { if (parent.isClickable && parent.isEnabled) return parent.performAction(AccessibilityNodeInfo.ACTION_CLICK); parent = parent.parent }
                    }
                    return (0 until node.childCount).any { clickDetails(node.getChild(it)) }
                }
                // The action scroller may be at its end; capture compact state before returning to its heading.
                var attempts = 0
                while (!clickDetails(freshRoot(instrumentation)) && attempts++ < 6) {
                    fun back(node: AccessibilityNodeInfo?): Boolean {
                        if (node == null || !node.refresh()) return false
                        if (node.isScrollable && node.isVisibleToUser && node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)) return true
                        return (0 until node.childCount).any { back(node.getChild(it)) }
                    }
                    check(back(freshRoot(instrumentation))) { "Building Details control is unreachable" }; heldFrames(instrumentation)
                }
                heldFrames(instrumentation); val detailNodes = freshAccessibility(instrumentation)
                screenshot("screen-details.png")
                File(directory, "accessibility-details.json").writeText(JsonArray(detailNodes).toString())
                check(detailNodes.any { matches(it, "DONE") && inViewport(it, width, height) }) { "Building Details did not open a bounded dialog" }
            }
            check((fixtures?.prohibitedCalls ?: 0) == 0) { "A fixture attempted an API or purchase action" }
            stage = "complete"; receipt("captured")
            return directory.absolutePath
        } catch (error: Exception) {
            receipt("failed")
            throw error
        } finally {
            instrumentation.runOnMainSync { activity?.finish(); fixtures?.close() }
            receipt(if (stage == "complete") "captured" else "failed")
        }
    }

    @Composable private fun FixtureLoading(mode: String, replayContent: ContentState) {
        when (mode) {
            "seeker-replay-opening", "seeker-replay-error" -> {
                var closed by remember { mutableStateOf(false) }
                if (closed) Text("REPLAY CLOSED")
                else gg.pixelkingdomwars.nativeclient.ui.battle.ReplayScreen(replayContent,
                    remember { buildJsonObject {} }, onClose = { closed = true })
            }
            // The current boot API has no contentReady distinction. Keep both fixture
            // scenarios and assertions; both now exercise the production loading strip.
            "seeker-boot-preparing", "seeker-boot-restoring" -> BootScreen(
                strip = bootLoadingStrip(error = null, retrying = false, onRetry = {}), tip = rememberBootTip())
            "seeker-boot-error", "seeker-boot-retrying" -> BootScreen(
                strip = bootLoadingStrip(
                    error = "The saved game content could not be verified. Check your connection and retry preparation.",
                    retrying = mode == "seeker-boot-retrying", onRetry = {}), tip = rememberBootTip())
            "seeker-scene-base-loading", "seeker-scene-battle-loading" -> gg.pixelkingdomwars.nativeclient.ui.chrome.LoadingOverlay(
                if (mode == "seeker-scene-battle-loading") "Entering battle…" else "Opening your kingdom…",
                art = if (mode == "seeker-scene-battle-loading") "raid" else "profile")
            else -> gg.pixelkingdomwars.nativeclient.ui.world.WorldOpeningOverlay(
                progress = if (mode == "seeker-world-progress") gg.pixelkingdomwars.nativeclient.data.WorldContentProgress(
                    gg.pixelkingdomwars.nativeclient.data.WorldContentPhase.DOWNLOADING, 13, 26) else null,
                failed = mode == "seeker-world-error", onRetry = {}, onBack = {})
        }
    }

    @Composable private fun FixtureKingdom(mode: String, catalogue: JsonObject, home: BaseState, now: Long) {
        val requests = remember { HomeRequests() }
        HomeScaffold(AccountState(phase = AccountPhase.SIGNED_IN, identity = Identity(WALLET, "UI FIXTURE", 20, true)),
            home, local = false, exitConfirmMs = null, requests = requests,
            onOpenLand = {}, onExit = {}, onOpen = {}, onProfile = {}, onRaidLog = {}, onCache = {}, onPurchases = {}, onForge = {},
            wallet = WalletFunds("4.075", emptyMap(), now), mail = MailStatus(7, 1, 1), showTasks = mode == "seeker-hud") { _, _, _, _ ->
            BoxWithConstraints(Modifier.fillMaxSize().background(Palette.backdrop)) {
                // Plain test backdrop keeps UI evidence separate from already-covered GL/terrain tests.
                Text("OFFLINE UI FIXTURE", Modifier.align(Alignment.Center), color = Palette.muted)
                val limit = minOf((maxHeight - 8.dp).coerceAtLeast(0.dp), if (maxHeight < 400.dp) maxHeight else maxHeight * .7f)
                if (mode in setOf("seeker-hero-catalog", "seeker-hero-placed")) {
                    val heroes = HeroRecruitmentState(supported = true, enabled = true, base = home.base,
                        offers = HeroAltarDefinition.all(catalogue).map { HeroAltarOffer(it, contracts = 0, recruited = mode == "seeker-hero-placed" || it.hero == "vex") })
                    Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().heightIn(max = limit)
                        .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))) {
                        HeroBuildMenu(heroes, false, onPick = {}, onRefresh = {}, onBuildings = {}, onClose = {})
                    }
                } else if (mode == "seeker-builders") {
                    BuilderOverviewSheet(requireNotNull(home.base), catalogue, now, canHire = false, onHire = {}, onViewJob = {}, onClose = {})
                } else if (mode != "seeker-hud") {
                    val id = if (mode == "seeker-barracks") BARRACKS else GOLDFORGE
                    var infoOpen by remember(mode) { mutableStateOf(false) }
                    val state = KingdomUiState(home = home, catalogue = catalogue, local = KingdomLocal(selectedBuildingId = id, infoOpen = infoOpen))
                    val building = requireNotNull(state.selectedBuilding)
                    // Same available-space rule as KingdomScreen, under the actual HUD/navigation deck.
                    Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
                        BuildingSheet(state, building, false, now, home.mine,
                            onTrain = {}, onResearch = {}, onArmy = {}, onForge = {},
                            onUpgrade = {}, onFinish = {}, onCancel = {}, onRepair = {}, onCollect = {},
                            onToggleRow = {}, onQuoteRow = {}, onToggleInfo = { infoOpen = !infoOpen }, onClose = {}, onConfirm = {},
                            maxHeight = minOf(limit, 460.dp), onRefresh = {},
                            error = if (mode == "seeker-goldforge-funds") "Not enough funds for this action. Refresh your balances and try again." else null)
                    }
                }
            }
        }
    }

    @Composable private fun FixtureDialog(mode: String, catalogue: JsonObject) {
        Box(Modifier.fillMaxSize().background(Palette.backdrop))
        when (mode) {
            "seeker-building-keep" -> KeepSpendDialog(SheetConfirmation.KeepSpend("2688", "FINISH THIS UPGRADE", {}), {}, {})
            "seeker-building-cancel" -> CancelJobDialog(SheetConfirmation.CancelJob("BARRACKS LEVEL 10→11", "1000", {}), {})
            "seeker-keep-confirm" -> {
                val state = remember { KeepSpendConfirmState(captureKeepPreference()).apply {
                    confirm(KeepSpendIntent("2688", "FINISH TRAINING THE WHOLE QUEUE", onConfirm = {}))
                } }
                KeepSpendConfirmDialog(state)
            }
            "seeker-research-cancel" -> {
                val refund = catalogue.getValue("constants").jsonObject.getValue("TROOP_LEVELING").jsonObject.getValue("researchCostKeep").jsonArray[1].jsonPrimitive.content
                CancelJobConfirmDialog(CancelJobIntent("RESEARCH", "BOWMAN LEVEL 2→3", refund, {}), {})
            }
            "seeker-wall-row" -> WallRowDialog(wallFixture(catalogue), false, false, null, {}, {}, {})
        }
    }

    @Composable private fun FixtureModelScreen(mode: String, fixtures: SeekerUiFixtures) {
        val preference = remember { captureKeepPreference() }
        when (mode) {
            "seeker-army-queue" -> {
                val requests = remember { HomeRequests().apply { request(HomeRequest.Training) } }
                val model = remember(fixtures) { fixtures.army() }
                ArmyScreen(model, preference, requests, onBack = {}, onOpenResearch = {})
            }
            "seeker-research-active" -> ResearchScreen(remember(fixtures) { fixtures.army() }, onBack = {})
            "seeker-inventory-detail" -> InventoryScreen(remember(fixtures) { fixtures.roster() }, onBack = {},
                onOpenShop = {}, onPlaceAltar = {}, onSell = {}, onViewDeeds = {})
            "seeker-mail-detail" -> CommunityScreen(remember(fixtures) { fixtures.community() }, CommunityPage.MAIL, fixtures.baseId, onBack = {})
            else -> {
                val model = remember(fixtures) { fixtures.market() }
                val state = remember(fixtures, mode) { fixtures.marketState(mode == "seeker-market-settled") }
                GamePage("MARKET", {}) {
                    MarketTradePanel(model, state, fixtures.marketWallet, fixtures.marketBounds, sender = null, itemName = { "Keg of Haste" })
                }
            }
        }
    }

    private fun captureKeepPreference() = object : KeepConfirmPreference {
        override fun on() = true
        override fun set(on: Boolean) {} // A UI-only switch never writes device preferences.
    }

    private fun wallFixture(catalogue: JsonObject): WallRowQuote {
        val costs = catalogue.getValue("constants").jsonObject.getValue("UPGRADE_COSTS").jsonObject.getValue("wall").jsonArray
        val maximum = maxLevelFor(catalogue, "wall")
        val levels = listOf(10, 10, 9, maximum)
        val walls = levels.mapIndexed { index, level -> buildJsonObject {
            put("id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa$index"); put("tx", index); put("ty", 1); put("level", level)
            if (level == maximum) { put("targetLevel", JsonNull); put("costShards", "0"); put("excluded", "max_level") }
            else { put("targetLevel", level + 1); put("costShards", costs[level - 1].jsonPrimitive.content) }
        } }
        val total = walls.sumOf { it.getValue("costShards").jsonPrimitive.content.toLong() }
        return WallRowQuote.from(buildJsonObject {
            put("baseId", BASE); put("selectedWallId", walls.first().getValue("id")); put("quoteId", "0".repeat(64)); put("keepLevel", 20)
            put("walls", JsonArray(walls)); put("totalCostShards", total.toString()); put("balanceShards", (total * 2).toString()); put("canAfford", true)
        })
    }

    internal fun fixtureHome(now: Long): BaseState {
        // Level, balance, long timer and four-digit finish quote reproduce screenshot 2/14;
        // full HUD SOL/shield values reproduce screenshot 12. They never leave this test process.
        val raw = buildJsonObject {
            put("baseId", BASE)
            put("player", buildJsonObject { put("wallet", WALLET); put("keepLevel", 20); put("trophies", "618"); put("builders", 6) })
            put("shield", buildJsonObject { put("remainingMs", 51_720_000) })
            put("energy", buildJsonObject { put("used", 0); put("free", 5); put("max", 5) })
            put("freeBuilders", 5)
            put("buildings", buildJsonArray {
                add(buildJsonObject { put("id", BARRACKS); put("type", "barracks"); put("level", 10); put("tx", 1); put("ty", 1) })
                add(buildJsonObject { put("id", GOLDFORGE); put("type", "goldforge"); put("level", 20); put("tx", 4); put("ty", 1) })
            })
            put("jobs", buildJsonArray { add(buildJsonObject {
                put("id", "44444444-4444-4444-8444-444444444444"); put("kind", "upgrade"); put("buildingId", BARRACKS)
                put("startedAt", Instant.ofEpochMilli(now - 600_000).toString())
                put("finishesAt", Instant.ofEpochMilli(now + 35_400_000).toString())
                put("finishCostKeep", "2688"); put("canCancel", true); put("refundShards", "1000")
            }) })
        }
        return BaseState(base = BaseSnapshot.from(raw), balances = Balances("80187", "437"),
            mine = MineStatus(Mining("80187", "100000", "1000", 1, 1)))
    }

    private fun reviewFixture(): ReviewedQuote {
        val raw = Json.parseToJsonElement("""{
          "requested":[{"troop":"highlander","count":10},{"troop":"bowman","count":6}],
          "queueable":[{"troop":"highlander","count":10},{"troop":"bowman","count":2}],
          "remaining":[{"troop":"bowman","count":4,"reason":"Camp capacity limit"}],
          "costShards":"1200","availableShards":"80187","completionSec":"240",
          "camp":{"used":43,"after":55,"capacity":55},"barracks":{"used":0,"after":12,"capacity":60}
        }""").jsonObject
        return ReviewedQuote(ArmyTrainingDraft(WALLET, BASE, mapOf("highlander" to "10", "bowman" to "6")),
            TrainingQuote.from(raw), buildJsonObject {}, TrainingScheduling.LEGACY)
    }

    private fun heldFrames(instrumentation: Instrumentation) {
        val done = CountDownLatch(1)
        instrumentation.runOnMainSync { Choreographer.getInstance().postFrameCallback(object : Choreographer.FrameCallback {
            var frames = 12
            override fun doFrame(frameTimeNanos: Long) {
                if (--frames == 0) done.countDown() else Choreographer.getInstance().postFrameCallback(this)
            }
        }) }
        check(done.await(5, TimeUnit.SECONDS)) { "Android did not present fixture frames" }
    }

    private fun matches(node: JsonObject, label: String) = listOf("text", "description").any {
        node[it]?.jsonPrimitive?.content.orEmpty().contains(label)
    }

    private fun inViewport(node: JsonObject, width: Int, height: Int): Boolean {
        val bounds = (node["bounds"] as? JsonArray)?.map { it.jsonPrimitive.int } ?: return false
        return node["visible"]?.jsonPrimitive?.booleanOrNull == true && bounds[2] > bounds[0] && bounds[3] > bounds[1] &&
            bounds[0] >= 0 && bounds[1] >= 0 && bounds[2] <= width && bounds[3] <= height
    }

    private fun freshRoot(instrumentation: Instrumentation): AccessibilityNodeInfo? {
        // Compose can repaint a scrolled page before UiAutomation invalidates cached descendants.
        // A cached tree can otherwise report offscreen coordinates from the preceding screenshot.
        if (Build.VERSION.SDK_INT >= 34) check(instrumentation.uiAutomation.clearCache()) { "Android accessibility cache could not be cleared" }
        return instrumentation.uiAutomation.rootInActiveWindow
    }

    private fun freshAccessibility(instrumentation: Instrumentation): List<JsonObject> {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
        var previous: List<JsonObject>? = null
        var nodes = emptyList<JsonObject>()
        do {
            try { instrumentation.uiAutomation.waitForIdle(100, 500) }
            catch (_: TimeoutException) { /* A live timer may keep emitting; fresh bounds still must pass below. */ }
            nodes = accessibility(freshRoot(instrumentation))
            if (nodes.isNotEmpty() && nodes == previous) return nodes
            previous = nodes
            Thread.sleep(50)
        } while (System.nanoTime() < deadline)
        // An idle timeout is never an acceptance result; callers still check exact visible labels.
        return nodes
    }

    private fun selectedItemScrollBounds(node: AccessibilityNodeInfo?, ancestorBounds: Rect? = null): Rect? {
        if (node == null || !node.refresh()) return null
        val bounds = if (node.isScrollable && node.isVisibleToUser) Rect().also(node::getBoundsInScreen) else ancestorBounds
        if (node.isVisibleToUser && node.contentDescription?.toString() == "Close item details") return bounds
        for (index in 0 until node.childCount) {
            selectedItemScrollBounds(node.getChild(index), bounds)?.let { return it }
        }
        return null
    }

    private fun scrollForward(instrumentation: Instrumentation, targetBounds: Rect? = null): Boolean {
        var scrolled = false
        try {
            instrumentation.uiAutomation.executeAndWaitForEvent(
                { scrolled = scrollForward(freshRoot(instrumentation), targetBounds) },
                { it.eventType == AccessibilityEvent.TYPE_VIEW_SCROLLED }, 1_500,
            ).recycle()
        } catch (_: TimeoutException) { /* Re-read uncached bounds after frames even if Android omits the event. */ }
        return scrolled
    }

    private fun scrollForward(node: AccessibilityNodeInfo?, targetBounds: Rect? = null): Boolean {
        if (node == null || !node.refresh()) return false
        val matchesTarget = targetBounds == null || Rect().also(node::getBoundsInScreen) == targetBounds
        if (node.isScrollable && matchesTarget && node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)) return true
        for (index in 0 until node.childCount) if (scrollForward(node.getChild(index), targetBounds)) return true
        return false
    }

    private fun accessibility(root: AccessibilityNodeInfo?): List<JsonObject> = buildList {
        fun visit(node: AccessibilityNodeInfo, depth: Int, clickable: Rect?, clickableEnabled: Boolean?) {
            if (!node.refresh()) return
            val rect = Rect(); node.getBoundsInScreen(rect)
            // A disabled Compose Button may omit ACTION_CLICK but must retain its full target.
            val button = node.isClickable || node.className?.toString() == "android.widget.Button"
            val target = if (button) rect else clickable
            val targetEnabled = if (button) node.isEnabled else clickableEnabled
            add(buildJsonObject {
                put("depth", depth); put("text", node.text?.toString().orEmpty()); put("description", node.contentDescription?.toString().orEmpty())
                put("visible", node.isVisibleToUser); put("clickable", node.isClickable); put("enabled", node.isEnabled)
                put("bounds", buildJsonArray { add(rect.left); add(rect.top); add(rect.right); add(rect.bottom) })
                target?.let { put("clickableBounds", buildJsonArray { add(it.left); add(it.top); add(it.right); add(it.bottom) }) }
                targetEnabled?.let { put("clickableEnabled", it) }
                node.rangeInfo?.let { put("range", buildJsonArray { add(it.min); add(it.max); add(it.current) }) }
            })
            for (index in 0 until node.childCount) node.getChild(index)?.let { visit(it, depth + 1, target, targetEnabled) }
        }
        root?.let { visit(it, 0, null, null) }
    }

    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
