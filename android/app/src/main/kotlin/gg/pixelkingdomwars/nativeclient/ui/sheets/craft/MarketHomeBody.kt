package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.KeepEquipmentMarketCatalogue
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.economy.MarketScreen
import gg.pixelkingdomwars.nativeclient.ui.economy.MarketViewModel
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.phasee.KeepEquipmentMarketScreen
import gg.pixelkingdomwars.nativeclient.ui.phasee.KeepEquipmentMarketViewModel
import gg.pixelkingdomwars.nativeclient.ui.phasee.keepMarketName
import gg.pixelkingdomwars.nativeclient.ui.phasee.keepMarketPill
import gg.pixelkingdomwars.nativeclient.ui.phasee.keepMarketTitle
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.KeepMarketCommandContext
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketBookComplete
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketBuyRefusal
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketCommandBlock
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketCraftItems
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketListRefusal
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketLotsLive
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketOfferPlaces
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketOthersPrice
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketPriceInput
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketRawListing
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketReviewWithoutEvidence
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketSavedRecords
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketSellable
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketTakeBackRefusal
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketTypedPrice
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketTypedPriceUnits
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.marketMoneySheetUi
import java.math.BigDecimal
import kotlinx.serialization.json.JsonObject

/** Presentation choice only: the original owner retains every purchase, wallet prompt and receipt action. */
internal fun marketOriginalRequired(
    recovery: Boolean = false, initialItemId: String? = null, review: Boolean = false,
    buying: Boolean = false, saved: Boolean = false, paying: Boolean = false, mfa: Boolean = false,
    pending: Boolean = false, legacyPending: Boolean = false,
): Boolean = recovery || initialItemId != null || review || buying || saved || paying || mfa || pending || legacyPending

/** KEEP: a command review without evidence ([freshCommandReview]) stays on the designed sheet under the designed Seal;
 *  a review carrying evidence, payment review, wallet MFA and any saved purchase keep the original owner, where the
 *  payment consent (incl. the seller-account rent cap) and the recovery wording live. */
internal fun keepMarketOriginalRequired(
    recovery: Boolean = false, commandReview: Boolean = false, paymentReview: Boolean = false,
    mfa: Boolean = false, savedRecord: Boolean = false, freshCommandReview: Boolean = false,
): Boolean = recovery || (commandReview && !freshCommandReview) || paymentReview || mfa || savedRecord

internal fun keepMarketHasSavedRecord(state: KeepEquipmentMarketState): Boolean =
    state.selected != null || state.journal?.pending?.isNotEmpty() == true

/** OWNED spans every stock category; selecting a lot must open its own SELL section. */
internal fun marketHomeCategoryForItem(itemId: String): String? = when {
    itemId !in KeepEquipmentMarketCatalogue.itemIds -> null
    itemId == "crystal_fragment" -> "fragments"
    KeepEquipmentMarketCatalogue.category(itemId) == "resources" -> "materials"
    else -> "tools"
}

/** SOL vehicles have no trade owner in this app. That informational section performs no substitute book read. */
internal fun marketHomeOwnerCategory(section: String): String? = when (section) {
    "materials", "fragments" -> "resources"
    "tools" -> "items"
    else -> null
}

/** Step the same effective selection and bounded quantity that the sheet displays. */
internal fun marketHomeStepQuantity(ui: MarketSheetUi, delta: Long): Long {
    val current: Long
    val minimum: Long
    val maximum: Long
    if (ui.frame.selectedTab == MarketTab.SELL) {
        val sell = ui.sell ?: return 1L
        current = sellQuantity(sell)
        minimum = 1L
        maximum = selectedSellable(sell)?.available?.coerceAtLeast(minimum) ?: return current
    } else {
        val buy = ui.buy ?: return 1L
        val offer = selectedOffer(buy) ?: return buy.quantity.coerceAtLeast(1L)
        val bounds = buyBounds(offer)
        current = buyQuantity(buy, offer)
        minimum = bounds.first
        maximum = bounds.second
    }
    return runCatching { Math.addExact(current, delta).coerceIn(minimum, maximum) }.getOrDefault(current)
}

/** Presentation over registered owners. No observation becomes a new review, receipt or command. */
internal fun marketHomeSheetUi(
    tab: String = MarketTab.BUY,
    solItems: Boolean,
    section: String = "tools",
    browse: MarketBrowseState? = null,
    trade: MarketTradeState? = null,
    keepMarket: KeepEquipmentMarketState? = null,
    walletAddress: String,
    selectedBaseId: String? = null,
    selectedOfferId: String? = null,
    selectedItemId: String? = null,
    selectedAssetId: String? = null,
    quantity: Long = 1,
    current: Boolean,
    running: Boolean = false,
    recoveryLabel: String = if (solItems) "ORIGINAL MARKET" else "RECEIPTS",
    originalOwnerLabel: String? = null,
    level: Int? = null,
    tier: Int? = null,
    command: KeepMarketCommandContext? = null,
): MarketSheetR2Ui {
    // Public book data and account stock share the owner's current lifetime, but never establish it.
    val admitted = current && (keepMarket?.journal?.identity?.wallet?.let { it == walletAddress } != false)
    val reads = browse.takeIf { admitted }
    val keep = keepMarket.takeIf { admitted }
    val busy = running || reads?.loading == true || keep?.busy == true || trade?.busy == true
    val vehicleStall = !solItems && section == SOL_STALL_SECTION && tab == MarketTab.BUY
    // No server capability is exposed by this owner. Failed discovery is unavailable, not proof of a switch value.
    val unavailable = if (!vehicleStall && !solItems && admitted && !busy && keep?.error != null && keep.policy == null)
        "Market information is unavailable in this view. Open $recoveryLabel for original records and recovery."
        else null
    // KEEP command mode: the admitted, discovered owner's reviews run in place (KeepMarketCommandMapper). Without it,
    // or for SOL items, this stays the read-only observation it was.
    val commands = command.takeIf { !solItems && admitted && unavailable == null && keep != null }
    val bookKnown = solItems && reads?.loading == false && MarketRepository.BOOK in reads.fresh &&
        MarketRepository.BOOK !in reads.errors && reads.book != null
    val omittedWalletLots = if (bookKnown) reads?.book?.offers?.count { it.baseId == null } else null
    val category = if (solItems) "sol-items" else section.takeIf { it in setOf("materials", "tools", "fragments") } ?: "tools"
    val observed = marketMoneySheetUi(tab = tab, section = if (solItems) "sol" else category,
        browse = reads, trade = trade.takeIf { admitted }, keepMarket = keep,
        walletAddress = walletAddress, selectedBaseId = selectedBaseId,
        selectedOfferId = selectedOfferId, quantity = quantity, level = level, tier = tier)
    val observedBase = observed.copy(
        // Shared History has a fixed label. This mount names its actual recovery destination in its own footer.
        frame = observed.frame.copy(history = false),
        buy = observed.buy?.copy(category = category,
            categories = if (solItems) listOf(MarketCategoryUi(category, "SOL ITEMS", "sol")) else listOf(
                MarketCategoryUi("materials", "MATERIALS"), MarketCategoryUi("tools", "TOOLS"), MarketCategoryUi("fragments", "FRAGMENTS"),
                MarketCategoryUi(SOL_STALL_SECTION, "SOL STALL", "sol")),
        ),
        sell = observed.sell?.copy(selectedItemId = selectedItemId, qty = quantity,
            sellable = observed.sell.sellable.filter { (it.available ?: 0L) > 0L }),
    )
    val saved = commands?.let { keep?.let(::keepMarketSavedRecords) }
    // While the owner works its journal can lag a step behind (a just-sent request reads as unanswered): no recovery row
    // then; the primaries already show busy dots.
    val waiting = saved?.waiting?.takeIf { !busy }
    val block = commands?.let { keepMarketCommandBlock(selectedBaseId, it.allowed, waiting != null) }
    val listings = keep?.listings
    val bookComplete = keepMarketBookComplete(listings)
    val base = if (commands == null) observedBase else {
        val items = keepMarketCraftItems()
        val held = observedBase.buy?.held.orEmpty()
        val buy = observedBase.buy?.let { b ->
            b.copy(paymentsAvailable = commands.configured, items = items,
                offers = b.offers.map { it.copy(sellerName = gg.pixelkingdomwars.nativeclient.ui.land.shortWallet(it.sellerName)) },
                totalLots = if (bookComplete && b.hydration !is CraftHydration.Error) b.offers.size.toLong() else null)
        }
        // The frame's stores strip lists every positively held unit of the selected kingdom, across categories.
        val sell = observedBase.sell?.let { s ->
            s.copy(sellable = keepMarketSellable(held), items = items, unitPrice = keepMarketTypedPrice(commands.priceText, s.decimals),
                listingAllowed = selectedBaseId != null && s.hydration == CraftHydration.Ready)
        }
        // A refresh keeps the last complete page's count (never blanks it); a failed read shows none.
        val lots = buy?.takeIf { bookComplete && it.hydration !is CraftHydration.Error }?.offers?.size
        observedBase.copy(frame = observedBase.frame.copy(history = true, live = keepMarketLotsLive(lots)), buy = buy, sell = sell)
    }
    fun ownLoad(): CraftHydration = when {
        !admitted || reads == null || reads.loading -> CraftHydration.Loading
        MarketRepository.OWN in reads.errors -> CraftHydration.Error("Your stall could not be refreshed.")
        MarketRepository.OWN !in reads.fresh || reads.own == null -> CraftHydration.Loading
        else -> CraftHydration.Ready
    }
    val offerLoad = if (solItems) ownLoad() else CraftHydration.Error("Open original receipts to check your complete KEEP stall.")
    // This DTO proves active/reserved listings only. It cannot prove sold outcomes or cancellation authority.
    val places = if (solItems && offerLoad == CraftHydration.Ready) reads?.own.orEmpty().mapNotNull { row ->
        runCatching {
            val units = row.priceLamports.toBigInteger().longValueExactCompat().also { require(it > 0) }
            val state = when (row.status) { "active" -> StallPlaceState.ON_TABLE; "reserved" -> StallPlaceState.PAYING; else -> return@mapNotNull null }
            StallPlaceUi(row.itemId, craftItemIcon(row.itemId), "×1",
                PriceUi(Currency.SOL, BigDecimal.valueOf(units, 9).stripTrailingZeros().toPlainString(), PriceStatus.OK),
                state, if (state == StallPlaceState.PAYING) "Reserved by a buyer" else "Observed on the table",
                action = null, listingId = row.id)
        }.getOrNull()
    } else emptyList()
    val sell = base.sell
    val offers = if (commands != null) {
        // OFFERS: this kingdom's own lots on the current page, each with BACK (the owner's return review), and the
        // honest notice that a book page is not the complete stall. No sold count or place limit is invented.
        MarketOffersUi(keepMarketOfferPlaces(listings, sell?.decimals, selectedBaseId, walletAddress,
            block ?: if (busy) CHECKING_TEXT else null), null, null, base.buy?.hydration ?: CraftHydration.Loading,
            partialNotice = "The public book does not show your complete stall. Open $recoveryLabel.", placeDetails = false)
    } else MarketOffersUi(places, null, null, offerLoad,
        if (solItems) "Observed SOL item listings. Original receipts retain payment and return checks."
        else "The public book is not your complete stall. Original receipts retain every saved request.")
    val storesKnown = !solItems && admitted && sell?.hydration == CraftHydration.Ready
    val stores = if (storesKnown) base.buy!!.held.filterValues { it > 0L }.map { (id, count) ->
        LotUi(id, craftItemIcon(id), "×${groupDigits(count)}", "${keepMarketName(id)}, ${groupDigits(count)} available in your stores")
    } else emptyList()
    val walletKnown = solItems && reads?.loading == false && MarketRepository.ASSETS in reads.fresh &&
        MarketRepository.ASSETS !in reads.errors && reads.assets != null
    val assets = if (walletKnown) reads?.assets?.assets.orEmpty() else emptyList()
    val rows = assets.map { asset ->
        // The generic collection has no verified design-family portrait/tier mapping. Use a neutral item well.
        OwnedRowUi(asset.id, "ui:market-menu", asset.name,
            if (asset.frozen) "Bound to this wallet" else "In your wallet · external marketplace",
            OwnedState.OUTSIDE_ONLY, observedLabel = if (asset.frozen) "BOUND" else "EXTERNAL")
    }
    val selected = rows.firstOrNull { it.id == selectedAssetId }
    val owned = OwnedUi(stores, if (storesKnown) stores.size else null, rows,
        selected?.let { OwnedDetailUi(it.id, it.art, it.name, it.where, null, it.state) },
        primary = null, secondary = null, walletLinked = walletAddress.isNotBlank(),
        load = if (busy) CraftHydration.Loading else CraftHydration.Ready,
        storesKnown = storesKnown, walletKnown = walletKnown)
    val message = when {
        !admitted -> "Return to the current Market to read these observations."
        unavailable != null -> "Market information is unavailable. Original records remain available."
        vehicleStall -> "SOL vehicle stall"
        solItems -> "Existing SOL item market. The vehicle stall is not available in this view." +
            if ((omittedWalletLots ?: 0) > 0) " Partial book: $omittedWalletLots wallet-held ${if (omittedWalletLots == 1) "lot is" else "lots are"} shown in ORIGINAL MARKET." else ""
        else -> "Current kingdom stock and public KEEP lots. Original receipts keep their saved destination and recovery."
    }
    return MarketSheetR2Ui(base = base, section = if (vehicleStall) SOL_STALL_SECTION else category,
        solStall = if (vehicleStall) SolStallUi(filter = SOL_STALL_SECTION, lots = emptyList(), selected = null, seal = null,
            filters = base.buy?.categories.orEmpty(), total = null, available = false,
            walletLinked = walletAddress.isNotBlank(), unavailableReason = "Vehicle trading is unavailable in this app.") else null,
        sellV2 = sell?.let {
            if (commands == null) MarketSellV2Ui(it)
            else MarketSellV2Ui(it, othersPriceHint = keepMarketOthersPrice(listings, selectedSellable(it)?.itemId, walletAddress, it.decimals),
                priceEntry = commands.priceText)
        }, offers = offers, owned = owned,
        // Command mode keeps no observation footer: the designed footers act. Not admitted / unavailable stay observed.
        observation = if (commands != null) null else MarketObservationUi(message, !vehicleStall && admitted && !busy && unavailable == null &&
            (solItems || base.frame.selectedTab != MarketTab.ORDERS) && trade?.review == null &&
            keep?.commandReview == null && keep?.paymentReview == null, checking = busy && !vehicleStall,
            recoveryLabel = recoveryLabel.takeIf { admitted }, unavailable = unavailable,
            stallNotice = if (!solItems) "The public book does not show your complete stall. Open $recoveryLabel." else null,
            omittedWalletLots = omittedWalletLots,
            originalOwnerLabel = originalOwnerLabel.takeIf { admitted }),
        command = commands?.let {
            MarketCommandUi(buyBlock = block, listBlock = block,
                waiting = waiting?.let { r -> SavedOpUi(r.key) },
                completed = saved?.completed?.let { r ->
                    MarketCompletedUi(r.key, runCatching { keepMarketTitle(r) }.getOrDefault(keepMarketName(r.key)),
                        runCatching { keepMarketPill(r).label }.getOrDefault(CHECKING_TEXT), archiving = busy)
                },
                busy = busy)
        })
}

/** Same existing SOL owners and foreground jobs. They may settle already attempted payments; their UI stays mounted. */
@Composable fun MarketHomeBody(
    model: MarketViewModel, wallet: String, catalogue: JsonObject?, landOwned: Boolean,
    initialItemId: String?, onInventory: () -> Unit, onLand: () -> Unit, onBack: () -> Unit,
    purchaseWallet: MarketPurchaseWallet? = null, isCurrent: () -> Boolean,
) {
    var recovery by rememberSaveable(wallet, initialItemId) { mutableStateOf(initialItemId != null) }
    val trade = model.trades?.state?.collectAsState()?.value
    val buying = model.trades?.buying?.collectAsState()?.value
    val paying = model.trades?.paying?.collectAsState()?.value == true
    val legacy = model.trades?.legacyState?.collectAsState()?.value
    val mfa = purchaseWallet?.mfa?.collectAsState()?.value
    val original = marketOriginalRequired(recovery, initialItemId, review = trade?.review != null,
        buying = buying != null, saved = trade?.saved != null, paying = paying, mfa = mfa != null,
        pending = trade?.pending?.isNotEmpty() == true, legacyPending = legacy?.page?.purchases?.isNotEmpty() == true)
    SideEffect { if (original && !recovery) recovery = true }
    if (original) {
        // Reuse the exact owner and its original consent/MFA/recovery presentation. Never translate a saved intent.
        MarketScreen(model, wallet, catalogue, landOwned, initialItemId, onInventory, onLand,
            onBack = { recovery = false; onBack() }, purchaseWallet = purchaseWallet)
        return
    }
    val state by model.state.collectAsState()
    val running by model.busy.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val lifecycleState by lifecycle.currentStateFlow.collectAsState()
    val current by rememberUpdatedState { isCurrent() && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) }
    val bounds = remember(catalogue) { MarketTradeBounds.from(catalogue) }
    val definitions = (catalogue?.get("constants") as? JsonObject)?.get("ITEMS") as? JsonObject
    fun itemName(id: String) = (definitions?.get(id) as? JsonObject)?.string("name") ?: id
    LaunchedEffect(model, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { model.foreground(initialItemId) } }
    LaunchedEffect(model.trades, bounds, lifecycle) {
        model.trades?.let { owner -> lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { owner.foreground(bounds, ::itemName) } }
    }
    var tab by remember(model) { mutableStateOf(MarketTab.BUY) }
    var offer by remember(model) { mutableStateOf<String?>(null) }
    var asset by remember(model) { mutableStateOf<String?>(null) }
    val ui = marketHomeSheetUi(tab, solItems = true, browse = state, trade = trade,
        walletAddress = wallet, selectedOfferId = offer, selectedAssetId = asset,
        current = current() && lifecycleState.isAtLeast(Lifecycle.State.STARTED), running = running)
    fun read(action: () -> Unit) { if (current()) action() }
    val refresh = { read { if (ui.observation?.canRefresh == true) model.refresh() }; Unit }
    BackHandlerAt(BackPriority.SCREEN) { onBack() }
    MarketSheetR2(ui, MarketSheetR2Actions(
        base = MarketSheetActions(onClose = onBack, onTab = { read { tab = it } }, onHistory = { read { recovery = true } },
            onRetry = refresh, buy = MarketBuyActions(onSelectOffer = { id -> read { offer = id } }, onRefresh = refresh)),
        offers = MarketOffersActions(onPlace = { read { recovery = true } }, onRetry = refresh),
        owned = OwnedActions(onWalletItem = { id -> read { asset = id } }, onMoreStores = { read(onInventory) }, onCheck = refresh),
    ), Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing))
}

/**
 * KEEP owner is already started by KeepEquipmentMarketRegistration; this body starts no second lifecycle job.
 * Command mode (frames 44-47, 143): BUY's reservation, LIST and TAKE BACK act in place by calling the same owner
 * (buy / list / cancel), and its fresh review is confirmed from the designed Seal over this sheet with the exact
 * tap/guard sequence of KeepEquipmentMarketScreen. Wallet payment, MFA, held evidence and a saved purchase keep the
 * original owner screen (KeepMarketCommandMapper). [entryTab] / [entryItem] open on a tab or a SELL item; a new
 * [entryStamp] re-applies them.
 */
@Composable fun KeepMarketHomeBody(
    model: KeepEquipmentMarketViewModel, selectedBase: String?, allowed: Boolean, configured: Boolean,
    back: () -> Unit, wallet: String, isCurrent: () -> Boolean,
    onHistory: (() -> Unit)? = null,
    level: Int? = null, tier: Int? = null,
    entryTab: String = MarketTab.BUY, entryItem: String? = null, entryStamp: Int = 0,
) {
    val state by model.state.collectAsState()
    val running by model.busy.collectAsState()
    var recovery by rememberSaveable(wallet) { mutableStateOf(false) }
    val mfa = model.wallet?.mfa?.collectAsState()?.value
    val records = keepMarketSavedRecords(state)
    val original = keepMarketOriginalRequired(recovery, commandReview = state.commandReview != null,
        paymentReview = state.paymentReview != null, mfa = mfa != null,
        savedRecord = records.forcesOriginal, freshCommandReview = keepMarketReviewWithoutEvidence(state))
    SideEffect { if (original && !recovery) recovery = true }
    if (original) {
        KeepEquipmentMarketScreen(model, selectedBase, allowed, configured, { recovery = false; back() })
        return
    }
    var tab by remember(model, selectedBase, entryStamp) { mutableStateOf(entryTab) }
    var section by remember(model, entryStamp) {
        mutableStateOf(entryItem?.let(::marketHomeCategoryForItem) ?: if (state.category == "resources") "materials" else "tools")
    }
    var selected by remember(model, selectedBase) { mutableStateOf<String?>(null) }
    var item by remember(model, selectedBase, entryStamp) { mutableStateOf(entryItem) }
    var quantity by remember(model, selectedBase, entryStamp) { mutableLongStateOf(1L) }
    var price by rememberSaveable(selectedBase, item) { mutableStateOf("") }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val lifecycleState by lifecycle.currentStateFlow.collectAsState()
    val current by rememberUpdatedState { isCurrent() && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) }
    val currentlyAllowed by rememberUpdatedState(allowed)
    val idle = !running && !state.busy
    val ui = marketHomeSheetUi(tab, solItems = false, section = section, keepMarket = state,
        walletAddress = wallet, selectedBaseId = selectedBase, selectedOfferId = selected, selectedItemId = item,
        quantity = quantity, current = current() && lifecycleState.isAtLeast(Lifecycle.State.STARTED), running = running,
        recoveryLabel = if (onHistory != null) "RECEIPTS" else "ORIGINAL MARKET",
        originalOwnerLabel = if (onHistory != null) "ORIGINAL MARKET" else null,
        level = level, tier = tier, command = KeepMarketCommandContext(configured, allowed, price))
    fun read(action: () -> Unit) { if (current()) action() }
    fun ownerIdle() = !model.busy.value && !model.state.value.busy
    fun explain(reason: String?) { reason?.let { Toasts.post(it) } }
    val history = { read { if (onHistory != null) onHistory() else recovery = true }; Unit }
    val refresh = { read { if (ui.observation?.canRefresh == true || (ui.command != null && ownerIdle())) model.refresh() }; Unit }
    // An owner refusal (price changed, quantity gone, kingdom changed) is told once; a notice older than this mount is not.
    val notice by model.notice.collectAsState()
    val mountedNotice = remember(model) { model.notice.value }
    LaunchedEffect(notice) { notice?.takeIf { it.error && it !== mountedNotice }?.let { Toasts.post(it.message, error = true) } }
    // The book follows the section (the entry and SELL may change it): a GET-only browse, only once the owner's own
    // foreground open has loaded the policy and only while nothing runs (read live, so it never pre-empts that open).
    LaunchedEffect(section, idle) {
        val wanted = marketHomeOwnerCategory(section)
        val now = model.state.value
        val quiet = !model.busy.value && !now.busy && now.policy != null && now.error == null
        if (wanted != null && quiet && current() && wanted != now.category) model.browse(wanted)
    }
    // A chip or stores tap always acts; while the owner works, the book follows through the effect above.
    fun chooseCategory(id: String) = read {
        if (id in setOf("materials", "tools", "fragments", SOL_STALL_SECTION)) {
            section = id; selected = null; item = null; quantity = 1L
            if (!running && !state.busy) marketHomeOwnerCategory(id)?.let { category ->
                if (category != model.state.value.category) model.browse(category)
            }
        }
    }
    fun adjustQuantity(delta: Long) = read {
        quantity = marketHomeStepQuantity(ui.base, delta)
    }
    fun chooseStoresItem(id: String) = read {
        if (ui.owned?.stores?.any { it.id == id } == true) {
            marketHomeCategoryForItem(id)?.let { category ->
                chooseCategory(category)
                item = id; tab = MarketTab.SELL; quantity = 1L
            }
        }
    }
    // SELL lists every held item; its category's book gives the "Others sell it for about" hint.
    fun chooseSellItem(id: String) = read {
        if (ui.base.sell?.sellable?.any { it.itemId == id } == true) {
            item = id; quantity = 1L
            marketHomeCategoryForItem(id)?.let { if (it != section) { section = it; selected = null } }
        }
    }
    fun buyLot(offerId: String, qty: Long) = read {
        val raw = keepMarketRawListing(model.state.value, offerId)
        val refusal = keepMarketBuyRefusal(ui.base.buy?.offers?.firstOrNull { it.offerId == offerId }, qty, raw,
            selectedBase, allowed, configured, ownerIdle(), ui.command?.waiting != null)
        if (refusal == null && raw != null) model.buy(raw, qty.toString()) else explain(refusal)
    }
    fun listLot() = read {
        val sell = ui.base.sell
        val stock = sell?.let(::selectedSellable)
        val qty = sell?.let(::sellQuantity) ?: 0L
        val units = sell?.let { keepMarketTypedPriceUnits(price, it.decimals) }
        val refusal = keepMarketListRefusal(stock, qty, units, sell?.listingAllowed == true, allowed, ownerIdle(),
            ui.command?.waiting != null)
        if (refusal == null && stock != null && units != null) model.list(stock.itemId, qty.toString(), units) else explain(refusal)
    }
    fun takeBack(listingId: String) = read {
        val raw = keepMarketRawListing(model.state.value, listingId)
        val refusal = keepMarketTakeBackRefusal(raw, selectedBase, wallet, allowed, ownerIdle(), ui.command?.waiting != null)
        if (refusal == null && raw != null) model.cancel(raw) else explain(refusal)
    }
    fun checkSaved(key: String) = read {
        // A GET-only read of the saved request by key, then its original owner screen (REVIEW / RETRY / CLOSE live there).
        if (ownerIdle()) { model.select(key); recovery = true } else explain(CHECKING_TEXT)
    }
    fun archiveRecord(key: String) = read {
        if (ownerIdle() && keepMarketSavedRecords(model.state.value).completed?.key == key) model.archive(key)
    }
    BackHandlerAt(BackPriority.SCREEN) { back() }
    MarketSheetR2(ui, MarketSheetR2Actions(
        base = MarketSheetActions(onClose = back, onTab = { read { tab = it } }, onHistory = history, onRetry = refresh,
            onLinkWallet = { explain("Link a wallet to buy") },
            buy = MarketBuyActions(onCategory = ::chooseCategory, onSelectOffer = { id -> read { selected = id; quantity = 1L } },
                onQty = ::adjustQuantity, onBuy = ::buyLot,
                onMore = { read { if (!running && !state.busy) model.page("listings") } }, onRefresh = refresh),
            sell = MarketSellActions(onSelectItem = ::chooseSellItem, onQty = ::adjustQuantity, onList = ::listLot)),
        sell = MarketSellV2Actions(onPriceText = { text -> if (keepMarketPriceInput(text)) price = text }),
        offers = MarketOffersActions(onTakeBack = ::takeBack, onRetry = refresh, onHistory = history, onExplain = ::explain),
        owned = OwnedActions(onStoresItem = ::chooseStoresItem,
            onMoreStores = { read { tab = MarketTab.SELL } }, onCheck = refresh, onExplain = ::explain),
        sol = SolStallActions(onFilter = ::chooseCategory),
        onOriginal = { read { recovery = true } },
        onCheckSaved = ::checkSaved, onArchive = ::archiveRecord,
    ), Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing))
    // The designed Seal over the sheet (market-seal.png): RESERVE / LIST / RETURN through the same owner confirm.
    val sealReview = keepMarketFreshCommandReview(state).takeIf { mfa == null }
    sealReview?.let { review ->
        val armedAt = remember(review) { System.currentTimeMillis() }
        val tap = remember(review) { MarketSealTap(review) }
        MarketOwnerSealDialog(keepMarketCommandSeal(review, selectedBase, armedAt, allowed, !idle),
            onConfirm = {
                val shown = keepMarketFreshCommandReview(model.state.value)
                val admitted = currentlyAllowed && current() && !model.busy.value && !model.state.value.busy &&
                    model.wallet?.mfa?.value == null && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
                if (tap.take(shown, admitted)) model.confirm()
            },
            onBack = { if (!model.busy.value && !model.state.value.busy && model.state.value.commandReview == review) model.dismiss() })
    }
}
