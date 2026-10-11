package gg.pixelkingdomwars.nativeclient.ui.sheets.account.live

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ui.InterruptedBanner
import gg.pixelkingdomwars.nativeclient.ui.KeepConfirmPreference
import gg.pixelkingdomwars.nativeclient.ui.Notice
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Seal
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.rememberKeepSpendConfirm
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterViewModel
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.SuppliesActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.SuppliesSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.HomeSolPurchase
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.SolPurchaseOverlay
import kotlinx.coroutines.launch

/** Both Home BUILD and ShopRoute mount this body; the caller admits the current session AND selected base.
 * SOL taps navigate to the unchanged BasePurchase owner. KEEP taps raise the kit Seal with the existing KEEP-spend wording
 * ([suppliesKeepConsentUi]) and, on CONFIRM, re-check the offer before calling the unchanged item owner, whose interrupted
 * requests have no receipt GET and can be replayed only through its explicit saved-request controls.
 * [keepConfirm] is the player's "ask before spending KEEP" preference; null (a host that passes none) always asks.
 * [onCodex] is kept for its callers but no longer drawn: shop.png has no CODEX door (Codex stays reachable from MORE).
 * [onEconomy] is the KEEP top-up owner a SHORT price opens.
 * [solPurchase] (Home only) is the existing Home SOL purchase owner: with it a SOL offer raises the designed SOL Seal over
 * this shelf and runs its money sequence on the status row (SuppliesSolBuy.kt); without it (ShopRoute) [onPurchase] keeps
 * the purchase screen. Internal because the owner type is. */
@Composable internal fun SuppliesHomeBody(
    model: RosterViewModel,
    wallet: String,
    baseId: String?,
    isCurrent: () -> Boolean,
    onPurchase: (String, String) -> Unit,
    onBuilders: () -> Unit,
    onTab: (String) -> Unit,
    onClose: () -> Unit,
    onEconomy: () -> Unit,
    onCodex: () -> Unit,
    tabs: List<TabUi>,
    modifier: Modifier = Modifier,
    keepConfirm: KeepConfirmPreference? = null,
    solPurchase: HomeSolPurchase? = null,
) {
    val state by model.state.collectAsState()
    val busy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    var selected by rememberSaveable(wallet, baseId) { mutableStateOf<String?>(null) }
    var information by remember(wallet, baseId) { mutableStateOf<String?>(null) }
    // Inventory has no public base-id field. Each mount/base change must finish the existing owner's paired refresh
    // before old inventory can be shown or bought; its own internal base/session checks still guard submission.
    var refreshed by remember(model, wallet, baseId) { mutableStateOf(false) }
    var refreshError by remember(model, wallet, baseId) { mutableStateOf<String?>(null) }
    val currentCheck by rememberUpdatedState(isCurrent)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    val keepSpend = rememberKeepSpendConfirm(suppliesKeepPreference(keepConfirm))
    suspend fun refresh() {
        if (!currentCheck()) return
        val job = model.loadShop() ?: return
        // Only the first read for this kingdom gates the shelf (refreshed starts false per wallet/base). A later routine
        // refresh keeps the rows on screen: the owner is busy for the whole read, so the projection locks every offer
        // ("Refreshing supplies…") instead of blanking what the player was reading.
        job.join()
        if (currentCheck()) {
            // Dismissing the model notice cannot turn a failed refresh into current inventory.
            refreshError = model.notice.value?.takeIf { it.error }?.message
            refreshed = true
        }
    }
    LaunchedEffect(model, wallet, baseId, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { refresh() }
    }
    // A consent raised for another account or kingdom is dropped, never carried over.
    LaunchedEffect(keepSpend, wallet, baseId) { keepSpend.cancel() }
    BackHandlerAt(BackPriority.CONFIRM, enabled = keepSpend.pending != null) { keepSpend.cancel() }
    BackHandlerAt(BackPriority.SHEET, enabled = information != null) { information = null }
    // A SOL offer bought in place (SuppliesSolBuy.kt): one visit at a time, dropped with the account or kingdom.
    var solBuy by remember(wallet, baseId) { mutableStateOf<SuppliesSolBuy?>(null) }
    val solVisit = solPurchase?.let { owner -> solBuy?.let { buy ->
        key(buy) { rememberSuppliesSolVisit(owner, buy, onEnd = { solBuy = null }, explain = { information = it }) }
    } }
    fun latest() = projectSupplies(model.state.value, wallet, baseId, currentCheck(), model.busy.value,
        refreshed, selected, tabs, readError = refreshError ?: model.notice.value?.takeIf { it.error }?.message)
    // CONFIRM on the Seal: buy only the same item at the same server price the Seal quoted.
    fun confirmKeep(buy: SuppliesKeepBuy) {
        val target = suppliesKeepConfirmed(buy, latest())
        if (target != null) { model.buy(target.itemId) } else { information = SUPPLIES_CHANGED }
    }
    val projection = projectSupplies(state, wallet, baseId, currentCheck(), busy, refreshed, selected, tabs,
        readError = refreshError ?: notice?.takeIf { it.error }?.message)
    val actions = SuppliesActions(
        onTab = { tab -> if (!currentCheck()) information = SUPPLIES_STALE else if (tabs.any { it.id == tab }) onTab(tab) },
        onBuilders = { if (currentCheck()) onBuilders() else information = SUPPLIES_STALE },
        onClose = onClose,
        onSelectOffer = { id -> if (currentCheck()) selected = id else information = SUPPLIES_STALE },
        onBuy = { id ->
            val now = latest()
            when (val target = suppliesBuyTarget(projection, now, id)) {
                is SupplyTarget.BasePurchase -> {
                    if (solPurchase == null) { onPurchase(target.kind, target.baseId) }
                    else if (solVisit?.moving == true) { information = SUPPLIES_SOL_OPEN }
                    else { solBuy = suppliesSolBuy(target, projection.ui.offers.firstOrNull { it.id == id }?.title) }
                }
                is SupplyTarget.Item -> {
                    val buy = suppliesKeepBuy(projection, now, id)
                    if (buy == null) { information = SUPPLIES_CHANGED } else { keepSpend.confirm(suppliesKeepIntent(buy) { confirmKeep(buy) }) }
                }
                null -> information = SUPPLIES_CHANGED
            }
        },
        onInfo = { id ->
            val offer = projection.ui.offers.firstOrNull { it.id == id }
            information = offer?.let { "${it.title}\n${it.effect}\n${it.buySub.orEmpty()}${it.lockedReason?.let { reason -> "\n$reason" }.orEmpty()}" }
                ?: "Supplies and prices come from your current kingdom and the game catalogue. SOL purchases open the existing wallet review. Saved item requests stay available here."
        },
        // A SHORT KEEP price opens the existing KEEP top-up owner (the frame's GO Gold Forge › GEMS is for Gems prices).
        onNeedMore = { if (currentCheck()) onEconomy() else information = SUPPLIES_STALE },
        onExplain = { information = it },
        onCloseInfo = { information = null },
    )
    // REFRESH sits beside the status line only when there is something to refresh: shop.png draws no refresh door on a
    // healthy shelf, which refreshes itself on every resume. A tap that cannot run says why instead of doing nothing.
    val showRefresh = projection.status != null || notice?.error == true
    val refreshTap: () -> Unit = {
        if (!currentCheck()) { information = SUPPLIES_STALE }
        else if (model.busy.value) { information = "Refreshing supplies…" }
        else { scope.launch { refresh() } }
    }
    Box(modifier) {
        SuppliesSheet(projection.ui.copy(info = information), actions, Modifier.fillMaxSize(), statusContent = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (busy || state.home.loading || state.domain.loading || !refreshed) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (showRefresh) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.weight(1f)) {
                        projection.status?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 4) }
                    }
                    SecondaryButton("REFRESH", refreshTap)
                }
                notice?.let { Notice(it.message, it.error, model::dismissNotice) }
                state.domain.message?.let { Notice(it, onDismiss = model::clearNotice) }
                InterruptedBanner(state.interrupted.filter { it.kind == IntentKind.ITEM_BUY }, busy || !currentCheck(),
                    { kind -> if (currentCheck()) model.interrupted.check(kind) },
                    { kind -> if (currentCheck()) model.interrupted.close(kind) },
                    { kind -> if (currentCheck()) model.interrupted.retry(kind) })
                // A SOL buy's money sequence on the shelf itself; DETAILS (a saved purchase's recovery) is the purchase screen.
                solVisit?.let { visit -> SuppliesSolStatus(visit) { onPurchase(visit.buy.kind, visit.buy.baseId) } }
            }
        })
        if (solPurchase != null) solVisit?.let { visit -> SolPurchaseOverlay(solPurchase, visit.flow, visit.buy.title, visit.lines) }
        val pending = keepSpend.pending
        val armedAt = remember(pending) { System.currentTimeMillis() }
        Seal(pending?.let { suppliesKeepConsentUi(it, armedAt) }, onConfirm = keepSpend::accept, onCancel = keepSpend::cancel,
            modifier = Modifier.fillMaxSize())
    }
}
