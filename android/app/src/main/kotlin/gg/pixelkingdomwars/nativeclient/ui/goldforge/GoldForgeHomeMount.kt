package gg.pixelkingdomwars.nativeclient.ui.goldforge

import android.annotation.SuppressLint
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.EconomyPage
import gg.pixelkingdomwars.nativeclient.data.GemsBuyState
import gg.pixelkingdomwars.nativeclient.data.miningClaimsPolicy
import gg.pixelkingdomwars.nativeclient.mining.MiningClaimStatusView
import gg.pixelkingdomwars.nativeclient.model.GemsCapability
import gg.pixelkingdomwars.nativeclient.model.NativeCapabilities
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteIdentity
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.ClaimActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemsActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GoldForgeSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GoldForgeSheetActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GoldForgeTabs
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GemsPhase
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.SmeltActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.LegacyWithdrawalsList
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import android.graphics.BitmapFactory
import androidx.compose.runtime.key
import androidx.compose.runtime.produceState
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import gg.pixelkingdomwars.nativeclient.data.ContentState
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.CartStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GoldForgeSceneUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.goldForgeSceneArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.goldForgeScenePlan
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.first
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Navigation alias for the existing Economy FORGE page; it adds no money owner or action. */
@Serializable object GoldForgeControlsRoute
@Serializable object GoldForgeLegacyControlsRoute
@Serializable object GoldForgeWalletControlsRoute

internal data class GoldForgeBuyRead(val owner: GemsBuyState, val capabilityObserved: Boolean)

/** A normal capability GET may prove OFF while the existing owner has no capability or receipt.
 * Exceptions never prove OFF. Exact state identity also rejects a concurrent owner publication.
 * Otherwise the existing owner performs its own read/recovery and retains all consent rules.
 */
internal suspend fun goldForgeBuyRead(
    state: () -> GemsBuyState,
    capability: suspend () -> GemsCapability?,
    open: suspend () -> Unit,
    guard: () -> Unit,
): GoldForgeBuyRead {
    guard()
    val before = state()
    check(!before.busy) { "A wallet purchase is already being checked." }
    if (!before.available && before.capability == null && before.saved == null) {
        val cap = capability()
        guard()
        check(state() === before) { "The wallet purchase owner changed while checking availability." }
        if (cap == null || !cap.enabled || "wallet-keep" !in cap.sources || cap.destinationAta == null)
            return GoldForgeBuyRead(before, capabilityObserved = true)
    }
    guard(); open(); guard()
    val after = state()
    check(!after.busy) { "A wallet purchase is still being checked." }
    return GoldForgeBuyRead(after, capabilityObserved = false)
}

data class GoldForgeHomeDoor(val tab: String, val label: String, val enabled: Boolean, val reason: String? = null,
    val claimEntryAvailable: Boolean = false)

internal fun goldForgeHomeActionDoor(tab: String, gemsOff: Boolean, claimEntryAvailable: Boolean? = null): GoldForgeHomeDoor = when (tab) {
    GoldForgeTabs.CLAIM -> if (claimEntryAvailable == true) GoldForgeHomeDoor(tab, "OPEN CLAIMS IN BASES", true,
        claimEntryAvailable = true) else GoldForgeHomeDoor(tab, "OPEN BASES", true,
        if (claimEntryAvailable == false) "Claims are unavailable." else "Claim availability not checked.")
    GoldForgeTabs.GEMS -> GoldForgeHomeDoor(tab, "OPEN GEMS PURCHASE", !gemsOff,
        if (gemsOff) "Purchases unavailable." else null)
    GoldForgeTabs.LEGACY -> GoldForgeHomeDoor(tab, "OPEN SAVED WALLET CONTROLS", true)
    else -> GoldForgeHomeDoor(GoldForgeTabs.SMELT, "OPEN SMELT", true)
}

internal data class GoldForgeNoticeBounds(val width: Float, val height: Float)

/** Space between the forge notice on a full-screen sheet's shelf and the sheet below it. */
internal const val GOLD_FORGE_SHELF_NOTICE_GAP_DP = 6

/** The forge notice on a full-screen sheet's shelf (owner 2026-10-06): the safe width less the 8 dp gutters, at most the
 *  former world strip's 94 dp and a quarter of the viewport tall, so the sheet below always keeps most of the screen. */
internal fun goldForgeShelfNoticeBounds(width: Float, height: Float): GoldForgeNoticeBounds =
    GoldForgeNoticeBounds((width - 16f).coerceAtLeast(0f), minOf(94f, height * 0.25f).coerceAtLeast(0f))

internal fun goldForgeNoticeBounds(width: Float, height: Float): GoldForgeNoticeBounds {
    val layout = gg.pixelkingdomwars.nativeclient.ui.sheets.sheetHostLayout(
        gg.pixelkingdomwars.nativeclient.ui.model.SheetSize.TALL, width, height)
    val beside = layout.placement == gg.pixelkingdomwars.nativeclient.ui.sheets.SheetHostPlacement.END
    val freeWidth = if (beside) width - layout.widthDp - 16f else width - 16f -
        gg.pixelkingdomwars.nativeclient.ui.hud.HudGeometry.STACK_W - gg.pixelkingdomwars.nativeclient.ui.hud.HudGeometry.GUTTER
    val freeHeight = if (beside) height - 20f else layout.topInsetDp - 10f
    return GoldForgeNoticeBounds(minOf(272f, freeWidth.coerceAtLeast(0f)), freeHeight.coerceAtLeast(0f))
}

internal fun goldForgeHomeDoorCurrent(expected: gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry?,
    current: gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry?, door: GoldForgeHomeDoor?, tab: String): Boolean {
    val active = current ?: return false
    if (expected == null || expected !== active || door?.enabled != true || door.tab != tab) return false
    val destination = active.destination as? gg.pixelkingdomwars.nativeclient.ui.features.Destination.GoldForge ?: return false
    return (active.selectedTab ?: destination.tab)?.equals(tab, ignoreCase = true) != false
}

/** A presentation read ticket, never a payment owner, repository, queue or consent. */
internal class GoldForgeHomeReadGate(private val identity: HomeRouteIdentity) {
    private var revision = 0L
    private var closed = false
    fun begin(current: HomeRouteIdentity?, admitted: Boolean): Long? {
        if (closed || !admitted || current != identity) return null
        revision = Math.addExact(revision, 1)
        return revision
    }
    fun accepts(ticket: Long, current: HomeRouteIdentity?, admitted: Boolean) =
        !closed && ticket == revision && current == identity && admitted
    fun close() { closed = true }
}

/** Designed SMELT / CLAIM / GEMS / LEGACY over the existing live Home scene.
 * This mount constructs no money owner. SMELT and GEMS act in place only through the host's [smeltBinding] / [gemsBinding]
 * (the existing view models); without one the tab stays read-only and its notice door opens the original owner screen.
 * CLAIM and LEGACY stay read-only. Session repositories retain their original journals. CLAIM reads only its
 * authenticated status DTO. [explained] carries a binding's refusal into this mount's notice; [onAlert] reports the
 * error toast's message (null while there is none). Internal because the bindings are module types.
 */
@Composable internal fun GoldForgeHomeMount(
    graph: AppGraph,
    session: SessionGraph,
    identity: HomeRouteIdentity,
    currentIdentity: () -> HomeRouteIdentity?,
    canRead: () -> Boolean,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    requestedTab: String? = null,
    selectedTab: String? = null,
    onTab: (String) -> Unit,
    onStack: (List<ResourceChipUi>?) -> Unit = {},
    onNotice: (String?) -> Unit = {},
    onDoor: (GoldForgeHomeDoor?) -> Unit = {},
    onOpenOwner: (String) -> Unit = {},
    canStartRead: () -> Boolean = canRead,
    smeltBinding: GoldForgeSmeltBinding? = null,
    gemsBinding: GoldForgeGemsBinding? = null,
    onAlert: (String?) -> Unit = {},
    explained: String? = null,
    onExplained: () -> Unit = {},
) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val readIdentity by rememberUpdatedState(currentIdentity)
    val readAllowed by rememberUpdatedState(canRead)
    val readAdmission by rememberUpdatedState(canStartRead)
    val stackReport by rememberUpdatedState(onStack)
    val noticeReport by rememberUpdatedState(onNotice)
    val doorReport by rememberUpdatedState(onDoor)
    val alertReport by rememberUpdatedState(onAlert)
    // Read at event time: a binding's Seal or payment holds refresh and close (the refresh closure outlives a frame).
    val bindingReview by rememberUpdatedState(smeltBinding?.reviewOpen == true || gemsBinding?.reviewOpen == true)
    val readsGemsWallet by rememberUpdatedState(gemsBinding != null)
    val content by graph.content.state.collectAsState()
    val home by session.base.state.collectAsState()
    val gems by session.gems.state.collectAsState()
    val buy by session.gemsBuy.state.collectAsState()
    val economy by session.economy.state.collectAsState()
    val contributionOwner = remember(session) { runCatching { session.miningContribution }.getOrNull() }
    val contribution by rememberUpdatedState(contributionOwner?.state?.collectAsState()?.value)
    val gate = remember(identity) { GoldForgeHomeReadGate(identity) }
    var reads by remember(identity) { mutableStateOf(GoldForgeHomeData(identity, session.session.wallet, loading = true)) }
    var hasReadStarted by remember(identity) { mutableStateOf(false) }
    var refreshing by remember(identity) { mutableStateOf(false) }
    var explanation by remember(identity) { mutableStateOf<String?>(null) }
    var previewKeep by remember(identity) { mutableStateOf<Long?>(null) }
    var readCatalogue by remember(identity) { mutableStateOf<kotlinx.serialization.json.JsonObject?>(null) }
    var readManifest by remember(identity) { mutableStateOf<Any?>(null) }
    var legacyBalanceRead by remember(identity) { mutableStateOf<gg.pixelkingdomwars.nativeclient.model.Balances?>(null) }
    var legacyWithdrawalsRead by remember(identity) { mutableStateOf<List<gg.pixelkingdomwars.nativeclient.model.WithdrawalRecord>?>(null) }
    var legacyHistory by remember(identity) { mutableStateOf(false) }
    // When the last good LEGACY balance or history read finished (device clock, shown only as "as of HH:mm").
    var legacyReadAt by remember(identity) { mutableStateOf<Long?>(null) }
    // Owner 2026-10-06 ("always loading"): the last settled forge and the decoded foundry outlive this mount for the Home
    // route, so a re-open draws them at once while the read pass runs (display only; see GoldForgeHomeMemory).
    val memory = gg.pixelkingdomwars.nativeclient.ui.nav.graphViewModel(session) { GoldForgeHomeMemory() }
    // SPEC §3 SMELT success: one extra spark burst in the hero when an accepted basket appears during this visit.
    val heldKey = contribution?.let { goldForgeSmeltSettlementWatch(it) }
    val seenHeld = remember(identity) { mutableStateOf(heldKey) }
    var sparkBurst by remember(identity) { mutableStateOf(0) }
    LaunchedEffect(heldKey) {
        if (heldKey != null && heldKey != seenHeld.value) sparkBurst += 1
        seenHeld.value = heldKey
    }
    LaunchedEffect(explained) { explained?.let { explanation = it; onExplained() } }
    val current = {
        graph.sessionGraph.value === session && graph.holder.current === session.session &&
            readIdentity() == identity && lifecycle.currentState == Lifecycle.State.RESUMED && readAllowed() &&
            session.gems.state.value.review == null && contributionOwner?.state?.value?.review == null
    }
    DisposableEffect(gate) {
        val report = onStack
        val notice = onNotice
        val door = onDoor
        val alert = onAlert
        onDispose { gate.close(); report(null); notice(null); door(null); alert(null) }
    }
    val refresh: suspend () -> Boolean = refresh@ {
        if (refreshing || !current() || !readAdmission()) return@refresh false
        // Never dismiss or refresh over another owner's review, or race its in-flight read.
        if (session.gems.state.value.busy || session.gems.state.value.review != null || session.gemsBuy.state.value.busy ||
            contributionOwner?.state?.value?.let { it.busy || it.review != null } == true || bindingReview) {
            explanation = "Finish the current review before refreshing the forge."
            return@refresh false
        }
        val ticket = gate.begin(readIdentity(), current() && readAdmission()) ?: return@refresh false
        hasReadStarted = true
        val catalogue = graph.content.state.value.catalogue
        val manifest = graph.content.state.value.manifest
        readCatalogue = catalogue
        readManifest = manifest
        val guard = {
            check(gate.accepts(ticket, readIdentity(), current() && readAdmission())) { "The Gold Forge view changed." }
            check(graph.content.state.value.catalogue === catalogue && graph.content.state.value.manifest === manifest) {
                "Game content changed. Refresh the forge."
            }
        }
        refreshing = true
        explanation = null
        // A routine refresh never blanks what is shown: every value is replaced only by a successful read.
        reads = reads.copy(loading = true, failures = emptyMap())
        suspend fun observe(tab: String, block: suspend () -> Unit) {
            try { guard(); block(); guard() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                if (gate.accepts(ticket, readIdentity(), current() && readAdmission()))
                    reads = reads.copy(failures = reads.failures + (tab to "The forge could not refresh. Try again."))
            }
        }
        try {
            observe("WALLET") {
                session.economy.refresh(EconomyPage.WALLET); guard()
                val state = session.economy.state.value
                check(!state.loading && state.baseId == identity.baseId)
                if (state.errors["/balances"] == null) { legacyBalanceRead = state.balances; legacyReadAt = System.currentTimeMillis() }
                check(state.errors["/wallet/balances"] == null)
                reads = reads.copy(walletFunds = state.wallet, walletCurrent = state.wallet != null)
            }
            observe("LEGACY") {
                session.economy.refresh(EconomyPage.WITHDRAWALS); guard()
                val state = session.economy.state.value
                check(!state.loading && state.baseId == identity.baseId && state.errors["/withdrawals"] == null)
                legacyWithdrawalsRead = state.withdrawals
                legacyReadAt = System.currentTimeMillis()
            }
            observe("GEMS") {
                session.gems.refresh(); guard()
                reads = reads.copy(gems = session.gems.state.value, gemsCurrent = true)
            }
            observe("buy") {
                val observed = goldForgeBuyRead(state = { session.gemsBuy.state.value }, capability = {
                    NativeCapabilities.from(session.api.get("/native/capabilities")).economy?.gems
                }, open = { session.gemsBuy.open() }, guard = guard)
                reads = reads.copy(buy = observed.owner, buyCurrent = true, buyCapabilityObserved = observed.capabilityObserved)
            }
            // The in-place GEMS tab prices MAX and the wallet line from the purchase owner's own wallet read.
            if (readsGemsWallet) observe("buyWallet") { session.gemsBuyBalances.refresh() }
            observe("SMELT") {
                val owner = requireNotNull(contributionOwner)
                check(!owner.state.value.busy && owner.state.value.review == null)
                owner.refresh(); guard()
                reads = reads.copy(contribution = owner.state.value, contributionCurrent = true)
            }
            observe("CLAIM") {
                val policy = requireNotNull(miningClaimsPolicy(catalogue))
                val status = MiningClaimStatusView.from(session.api.getMiningClaim("/claims/mining/status", guard), policy)
                guard(); check(status.wallet == session.session.wallet)
                reads = reads.copy(claimStatus = status, claimPolicy = policy, claimsCurrent = true)
            }
        } finally {
            // Clearing presentation loading does not publish read authority. A temporary admission
            // hold must not strand the bridge in Checking after the coroutine has actually stopped.
            if (gate.accepts(ticket, readIdentity(), true)) reads = reads.copy(loading = false)
            refreshing = false
        }
        true
    }
    LaunchedEffect(gate, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            snapshotFlow {
                // Read every collected owner before the guards so a review/busy hold subscribes to its release.
                val gemsBusy = gems.busy
                val buyBusy = buy.busy
                val contributionBusy = contribution?.busy == true
                current() && readAdmission() && !gemsBusy && !buyBusy && !contributionBusy
            }
                .first { admitted -> admitted && refresh() }
            awaitCancellation()
        }
    }
    @SuppressLint("StateFlowValueCalledInComposition") // Deliberate: point-in-time session identity guard (MS-UI2 Gold Forge 348ccbac, as `current` above): the live sessionGraph unbinds a replaced session in its own frame; PkwApp's root collect recomposes.
    val bound = hasReadStarted && readIdentity() == identity && graph.sessionGraph.value === session &&
        readCatalogue === content.catalogue && readManifest === content.manifest
    val data = reads.copy(
        building = home.base?.buildings?.firstOrNull { it.type == "goldforge" },
        buildingCurrent = bound && home.base?.baseId == identity.baseId && !home.loading && home.error == null,
        contribution = contribution,
        contributionCurrent = bound && ((reads.contributionCurrent && reads.contribution === contribution) ||
            contribution?.journal?.operation != null),
        gems = gems, gemsCurrent = bound && reads.gemsCurrent && reads.gems === gems,
        buy = buy, buyCurrent = bound && ((reads.buyCurrent && reads.buy === buy) || buy.saved != null),
        walletFunds = economy.wallet,
        walletCurrent = bound && reads.walletCurrent && reads.walletFunds === economy.wallet &&
            !economy.loading && economy.baseId == identity.baseId && economy.errors["/wallet/balances"] == null,
    )
    @SuppressLint("StateFlowValueCalledInComposition") // Deliberate: the same point-in-time session identity guard as `bound` (348ccbac).
    val presentationCurrent = readIdentity() == identity && graph.sessionGraph.value === session && graph.holder.current === session.session
    val projection = goldForgeHomeUi(data, if (bound || (!hasReadStarted && presentationCurrent)) identity else null,
        requestedTab, selectedTab, previewKeep)
    // Equal content from the repository's own follow-up reads is the same proof, so a refresh in flight keeps the values
    // shown. A failed LEGACY read keeps the witnessed amount, labelled with the time of the last good read (SPEC E1.1).
    val legacyFailed = economy.errors["/balances"] != null || economy.errors["/withdrawals"] != null ||
        reads.failures.containsKey("LEGACY")
    val legacy = goldForgeLegacyUi(economy, identity.baseId, current = bound && presentationCurrent,
        balanceCurrent = legacyBalanceRead != null && legacyBalanceRead == economy.balances,
        withdrawalsCurrent = legacyWithdrawalsRead != null && legacyWithdrawalsRead == economy.withdrawals,
        failedAt = legacyReadAt?.takeIf { legacyFailed }?.let {
            DateTimeFormatter.ofPattern("HH:mm", Locale.ENGLISH).withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(it))
        })
    val wantsLegacy = (selectedTab ?: requestedTab) == GoldForgeTabs.LEGACY
    // A binding draws its tab only with its own face or its saved-original recovery; otherwise the read-only face stays,
    // with its read-only actions (never one owner's face with another's callbacks). GEMS keeps the proven OFF face unless
    // a purchase is still waiting for the wallet.
    val smeltInPlace = smeltBinding?.takeIf { it.ui != null || it.recovery != null }
    val gemsInPlace = gemsBinding?.takeIf { binding -> binding.recovery != null || (binding.ui != null &&
        !(projection.sheet.gems?.phase == GemsPhase.OFF && binding.ui?.pendingRecovery != true)) }
    val freshUi = projection.sheet.let { ui ->
        val selected = if (wantsLegacy) if (legacy != null) GoldForgeTabs.LEGACY else GoldForgeTabs.CLAIM else ui.selectedTab
        val waiting = gemsBinding?.pendingBadge?.takeIf { it > 0 }
        val tabs = ui.tabs.map { tab ->
            if (tab.id == GoldForgeTabs.GEMS && waiting != null) tab.copy(badge = gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge
                .goldForgeTabs(false, waiting, false).single { it.id == GoldForgeTabs.GEMS }.badge) else tab
        }
        ui.copy(tabs = if (legacy == null) tabs else tabs +
            gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.goldForgeTabs(false, 0, true).last(),
            selectedTab = selected, history = true,
            stack = if (selected == GoldForgeTabs.LEGACY) ui.stack.filter {
                it.id == gg.pixelkingdomwars.nativeclient.ui.hud.HudIds.GEMS } else ui.stack,
            smelt = if (smeltInPlace != null) smeltInPlace.ui else ui.smelt,
            gems = if (gemsInPlace != null) gemsInPlace.ui else ui.gems,
            heroStatus = if (selected == GoldForgeTabs.LEGACY) goldForgeLegacyHero(ui.heroStatus) else ui.heroStatus)
    }
    // While the read pass runs, the values it has not answered yet keep the last settled forge (never a blank tab).
    val reading = reads.loading || !hasReadStarted
    val sheetUi = goldForgeKeptSheet(freshUi, memory.sheetFor(identity), reading)
    SideEffect {
        if (!reading && reads.failures.isEmpty() && presentationCurrent) memory.keep(identity, freshUi)
        stackReport(sheetUi.stack)
    }
    val retry: () -> Unit = { if (current() && readAdmission()) scope.launch { refresh() }
        else explanation = "Finish the current loading or review step, then try again." }
    val explain: () -> Unit = { explanation = "This Gold Forge view is read-only. Purchase and claim reviews are unavailable here." }
    val changeTab: (String) -> Unit = { tab ->
        if (current() && (tab in setOf(GoldForgeTabs.SMELT, GoldForgeTabs.CLAIM, GoldForgeTabs.GEMS) ||
                (tab == GoldForgeTabs.LEGACY && legacy != null))) {
            explanation = null; legacyHistory = false; onTab(tab)
        }
    }
    val step: (Int) -> Unit = { delta ->
        if (current()) {
            val liveBuy = session.gemsBuy.state.value
            val cap = liveBuy.capability
            if (data.buyCurrent && reads.buy === liveBuy && !liveBuy.busy && liveBuy.saved == null &&
                cap != null && liveBuy.available && cap.minConvertKeep > 0 && cap.maxConvertKeepPerTx >= cap.minConvertKeep) {
                val old = previewKeep ?: cap.minConvertKeep
                previewKeep = runCatching { Math.addExact(old, delta.toLong()) }.getOrDefault(old)
                    .coerceIn(cap.minConvertKeep, cap.maxConvertKeepPerTx)
            }
        }
    }
    // CLAIM cannot be collected from any screen yet: its CLAIM and lock taps say so plainly (claim.png, claim-locked.png).
    val claimExplanation: () -> Unit = {
        val claim = projection.sheet.claim
        explanation = claim?.closedReason ?: claim?.lock?.let { listOfNotNull("Opens ${it.date}.", it.reason).joinToString(" ") }
            ?: "The mint is unavailable right now."
    }
    val actions = GoldForgeSheetActions(onTab = changeTab,
        onClose = { if (bindingReview) explanation = "Finish the current review before closing this sheet." else onClose() },
        onHistory = { if (current()) { if (sheetUi.selectedTab == GoldForgeTabs.LEGACY) legacyHistory = !legacyHistory
            else onOpenOwner("HISTORY") } },
        smelt = smeltInPlace?.actions ?: SmeltActions(onTile = { explain() }, onTileHold = { explain() }, onMinus = { explain() },
            onSmelt = explain, onFindRaid = explain, onRetry = retry, onGoWorkshop = explain, onGoBuild = explain),
        claim = ClaimActions(onClaim = claimExplanation, onRetry = retry, onGoSmelt = { changeTab(GoldForgeTabs.SMELT) },
            // The first auction's island has no backing system in this client yet.
            onGoSeeker = { explanation = gg.pixelkingdomwars.nativeclient.ui.phasee.PHASE_E_NOT_OPEN_LINE },
            onDestinationDetails = { onOpenOwner("WALLET") }, onExplainLock = claimExplanation),
        gems = gemsInPlace?.actions ?: GemsActions(onMinus = { step(-1) }, onPlus = { step(1) }, onBuy = explain, onRetry = retry,
            onContinue = explain, onConvert = explain, onGoClaim = { changeTab(GoldForgeTabs.CLAIM) }))
    val (decodedScene, artUnavailable) = rememberGoldForgeHomeScene(content, memory)
    val scene = if (sparkBurst == 0) decodedScene else decodedScene.copy(sparkBurst = sparkBurst)
    val claimEntryAvailable = reads.claimStatus?.takeIf { bound && reads.claimsCurrent && reads.failures["CLAIM"] == null }
        ?.let { it.state != "unavailable" }
    // A tab that acts in place has no door: the old owner screen stays reachable only while its binding is missing
    // (storage or wallet sender unavailable). The frames keep the toast zone empty otherwise.
    val door = when {
        sheetUi.selectedTab == GoldForgeTabs.SMELT && smeltBinding != null -> null
        sheetUi.selectedTab == GoldForgeTabs.GEMS && gemsBinding != null -> null
        // Owner 2026-10-06 ("not even 1 old screen"): CLAIM explains in place (no claim can be collected from any screen
        // in this build) and LEGACY keeps its recovery in its own history list (header History), so neither puts an old-page
        // door in the toast zone; claim.png and legacy.png show that zone empty.
        sheetUi.selectedTab == GoldForgeTabs.CLAIM || sheetUi.selectedTab == GoldForgeTabs.LEGACY -> null
        else -> goldForgeHomeActionDoor(sheetUi.selectedTab, sheetUi.gems?.phase == GemsPhase.OFF, claimEntryAvailable)
    }
    SideEffect {
        doorReport(door)
        noticeReport(explanation ?: door?.reason ?: if (artUnavailable) "Forge artwork unavailable. Controls remain available." else null)
        alertReport(goldForgeHomeAlert(data))
    }
    // Attach the panel modifier directly to the painted frame: an extra wrapping Box would consume
    // SheetHost's END alignment in landscape. The notice belongs in the host's reserved top gap.
    val legacyActions = gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.LegacyV2Actions(
        onHistory = { id -> if (current()) { if (id == null) legacyHistory = true else onOpenOwner("LEGACY") } }, onCheck = { retry() },
        onReturn = { if (current()) onOpenOwner("LEGACY") }, onExplain = { explanation = it },
        onTab = changeTab, onClose = onClose)
    if (legacyHistory && legacy != null && sheetUi.selectedTab == GoldForgeTabs.LEGACY) {
        GoldForgeSheet(sheetUi.copy(legacy = null), actions, modifier, scene = scene) {
            SecondaryButton("BACK TO SAVED FORGE", { legacyHistory = false })
            LegacyWithdrawalsList(legacy, legacyActions)
            SecondaryButton("OPEN WALLET RECOVERY", { if (current()) onOpenOwner("LEGACY") })
        }
    } else gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge.GoldForgeSheetR2(sheetUi, legacy, actions,
        legacyActions, modifier, scene = scene) { tab ->
        // A saved original without a designed face keeps its recovery controls in place (SMELT and GEMS bindings).
        val recovery = when (tab) {
            GoldForgeTabs.SMELT -> smeltInPlace?.recovery
            GoldForgeTabs.GEMS -> gemsInPlace?.recovery
            else -> null
        }
        if (recovery != null) recovery.invoke(this) else {
            PkwText(projection.notices[tab] ?: "Forge details are unavailable. Try again.", PkwTokens.Type.body,
                color = PkwTokens.Colors.textOnParch2)
            SecondaryButton(if (refreshing) "CHECKING" else "TRY AGAIN", retry, enabled = !refreshing,
                modifier = Modifier.padding(top = 12.dp))
        }
    }
}

@Composable fun GoldForgeHomeNotice(message: String?, modifier: Modifier = Modifier,
    door: GoldForgeHomeDoor? = null, onOpenControls: (String) -> Unit = {}) {
    // A door is drawn on its own when there is nothing to say: the toast zone otherwise stays empty (the frames).
    if (message == null && door == null) return
    // Owner 2026-10-06 (full-screen sheets): over a full-screen forge there is no world strip, so the plate sits on the
    // sheet's shelf under the resource pills and the sheet starts below it (it reports its height); never on the header.
    val sheets = gg.pixelkingdomwars.nativeclient.ui.kit.LocalFullScreenSheets.current
    val onShelf = sheets?.active == true
    val density = androidx.compose.ui.platform.LocalDensity.current
    DisposableEffect(sheets, onShelf) { onDispose { if (sheets != null) sheets.notice = 0.dp } }
    // A plain finite ancestor; only the painted plate takes input. Long copy and large type scroll
    // within the existing host's free area, never across the title or the landscape END panel.
    BoxWithConstraints(modifier.fillMaxSize()) {
        val bounds = if (onShelf) goldForgeShelfNoticeBounds(maxWidth.value, maxHeight.value) else goldForgeNoticeBounds(maxWidth.value, maxHeight.value)
        if (bounds.width > 0f && bounds.height > 0f) Plate(PlateKind.CREAM,
            (if (onShelf) Modifier.padding(start = 8.dp, top = sheets?.shelf ?: 0.dp).onSizeChanged { size ->
                sheets?.notice = with(density) { size.height.toDp() } + GOLD_FORGE_SHELF_NOTICE_GAP_DP.dp
            } else Modifier.padding(start = 8.dp, top = 10.dp)).width(bounds.width.dp).heightIn(max = bounds.height.dp),
            contentPadding = PaddingValues(4.dp)) {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                door?.let { action -> SecondaryButton(action.label, { onOpenControls(action.tab) }, enabled = action.enabled) }
                message?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2) }
            }
        }
    }
}

/** The error toast (`error.png`) in the same free zone as [GoldForgeHomeNotice], which it replaces while shown: at
 *  (8, 10), never wider than the zone a portrait or landscape sheet leaves. Only the painted toast takes input. */
@Composable internal fun GoldForgeHomeAlert(message: String, onReport: () -> Unit, onClose: () -> Unit,
    modifier: Modifier = Modifier) {
    // Owner 2026-10-06 (full-screen sheets): on a full-screen forge the error toast sits on the shelf, like the notice.
    val sheets = gg.pixelkingdomwars.nativeclient.ui.kit.LocalFullScreenSheets.current
    val onShelf = sheets?.active == true
    val density = androidx.compose.ui.platform.LocalDensity.current
    DisposableEffect(sheets, onShelf) { onDispose { if (sheets != null) sheets.notice = 0.dp } }
    BoxWithConstraints(modifier.fillMaxSize()) {
        val bounds = if (onShelf) goldForgeShelfNoticeBounds(maxWidth.value, maxHeight.value) else goldForgeNoticeBounds(maxWidth.value, maxHeight.value)
        if (bounds.width > 0f) GoldForgeAlertToast(message, onReport, onClose,
            if (onShelf) Modifier.padding(start = 8.dp, top = sheets?.shelf ?: 0.dp).widthIn(max = bounds.width.dp).onSizeChanged { size ->
                sheets?.notice = with(density) { size.height.toDp() } + GOLD_FORGE_SHELF_NOTICE_GAP_DP.dp
            } else Modifier.padding(start = 8.dp, top = 10.dp).widthIn(max = bounds.width.dp))
    }
}

/**
 * Returns the decorative scene and `artUnavailable` (true after any required image fails).
 * The caller keeps the sheet body usable and shows, when true:
 * "Forge artwork is unavailable in this content pack. Forge details remain available."
 * Loading does not imply a failed body, and an art failure never enables/disables a money action.
 *
 * Only local files already admitted by the content owner are read. No content request, download,
 * source-pack mutation, preview pixels or screenshot fallback is introduced. A new content root or
 * manifest recreates state synchronously, so the old generation cannot flash while its effect starts.
 * The host supplies sceneWorking from its admitted building observation. Receipt sparks stay zero.
 */
@Composable
private fun rememberGoldForgeHomeScene(content: ContentState, memory: GoldForgeHomeMemory): Pair<GoldForgeSceneUi, Boolean> {
    val directory = content.assets
    val manifest = content.manifest
    return key(directory, manifest, content.ready) {
        // Decode the cart too, but keep it hidden until the host has authoritative ingot/receipt state.
        // The host may copy(layers = goldForgeScenePlan(authoritativeCart)) without decoding again.
        val completePlan = remember { goldForgeScenePlan(CartStage.READY) }
        val visiblePlan = remember { goldForgeScenePlan(CartStage.HIDDEN) }
        // A re-open of the same content generation draws the foundry decoded on the first open (no re-hash, no blank hero).
        val cached = remember { memory.sceneFor(directory, manifest, content.ready) }
        val decoded by produceState(initialValue = cached) {
            if (cached != null) return@produceState
            val result = withContext(Dispatchers.IO) {
                val job = currentCoroutineContext()
                job.ensureActive()
                if (!content.ready || directory == null || manifest == null) {
                    emptyMap<String, ImageBitmap>() to true
                } else {
                    val pins = manifest.files.associateBy { it.path }
                    val images = linkedMapOf<String, ImageBitmap>()
                    var unavailable = false
                    for (art in goldForgeSceneArt(completePlan)) {
                        job.ensureActive()
                        try {
                            val relative = "native-goldforge/scene/$art"
                            val pin = requireNotNull(pins[relative])
                            val root = directory.canonicalFile
                            val file = File(root, relative).canonicalFile
                            require(file.toPath().startsWith(root.toPath()) && file.isFile && file.length() == pin.size)
                            val bytes = file.readBytes()
                            job.ensureActive()
                            require(bytes.size.toLong() == pin.size)
                            val hash = MessageDigest.getInstance("SHA-256").digest(bytes)
                                .joinToString("") { "%02x".format(it) }
                            require(hash == pin.sha256)
                            val layer = completePlan.first { it.art == art }
                            val width = Math.multiplyExact(layer.cellW, layer.frameCount)
                            val height = layer.cellH
                            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                            // The authored scene uses horizontal atlas strips, including one-cell stills.
                            require(bounds.outWidth == width && bounds.outHeight == height)
                            val options = BitmapFactory.Options().apply { inScaled = false }
                            val bitmap = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options))
                            job.ensureActive()
                            images[art] = bitmap.asImageBitmap()
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (_: Exception) {
                            job.ensureActive()
                            unavailable = true
                        }
                    }
                    images.toMap() to unavailable
                }
            }
            currentCoroutineContext().ensureActive()
            value = result
            memory.keepScene(directory, manifest, content.ready, result)
        }
        GoldForgeSceneUi(layers = visiblePlan, art = decoded?.first.orEmpty()) to (decoded?.second == true)
    }
}
