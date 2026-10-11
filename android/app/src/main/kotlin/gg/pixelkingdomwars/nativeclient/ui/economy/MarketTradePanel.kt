package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.ui.chrome.DropdownMenu
import gg.pixelkingdomwars.nativeclient.ui.chrome.DropdownMenuItem

import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedTextField
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentAction
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentActionRole
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentActions
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPill
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import gg.pixelkingdomwars.nativeclient.ui.chrome.marketPaymentPlan
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentConfirmDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentWindowLine
import gg.pixelkingdomwars.nativeclient.ui.chrome.PayFailure
import gg.pixelkingdomwars.nativeclient.ui.chrome.paymentProgressLine
import gg.pixelkingdomwars.nativeclient.ui.chrome.paymentUncertain
import gg.pixelkingdomwars.nativeclient.ui.chrome.payWindowUrgent
import gg.pixelkingdomwars.nativeclient.ui.chrome.marketPaymentPill

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ui.*
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketOwnerSealDialog
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketSealTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.marketFreshPurchaseReview
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.marketPurchaseReviewSeal
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.*
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn

/** One BUY = one explicit gold tap that chains the repository's own reserve and pay actions. Everything that keeps
 * money safe stays below this class and is unchanged: the reserve intent and idempotency key are persisted before the
 * POST (MoneyOp), `pay()` persists `attempted` before the wallet opens and refuses a second attempt, and the store only
 * closes an unattempted reservation or a settled, hydrated one. This class never retries a mutation and never opens a
 * wallet from a lifecycle callback: the chain stops at the first error, and recovery is observe/settle polling only. */
class MarketTradeViewModel(private val repository: MarketTransactionsRepository) : ScreenViewModel() {
    val state = repository.state
    val legacyState = repository.legacy.state
    /** The purchase the player confirmed, kept so the buy dialog can follow it from RESERVING to DONE. */
    private val _buying = MutableStateFlow<MarketReview.Purchase?>(null)
    val buying: StateFlow<MarketReview.Purchase?> = _buying.asStateFlow()
    /** True only while the explicit PAY tap is running (wallet pre-flight, the wallet sheet, the first settle). */
    private val _paying = MutableStateFlow(false)
    val paying: StateFlow<Boolean> = _paying.asStateFlow()
    /** The PAY tap's own failure sentence (it carries the wallet's reason), shown until that purchase changes state.
     * `state.error` cannot hold it: every repository action clears it, and the settlement poll acts within one tick. */
    private val _payFailure = MutableStateFlow<PayFailure<Pair<String, String>>?>(null)
    val payFailure: StateFlow<String?> = combine(_payFailure, state) { failure, s -> failure?.shownFor(mark(s)) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)
    private fun mark(s: MarketTradeState) = s.saved?.let { it.quote.reservationId to it.receipt.state }
    private var itemName: (String) -> String = { it }

    suspend fun foreground(bounds: MarketTradeBounds?, itemName: (String) -> String = { it }) {
        this.itemName = itemName
        repository.legacy.refresh()
        repository.open(); if (!active) finishSaved(dropUnpaid = false)
        if (bounds == null) awaitCancellation()
        var polls = 0; var ticks = 0
        while (currentCoroutineContext().isActive) {
            delay(bounds.pollMs); ticks++
            val saved = state.value.saved
            // This resumes settlement of one attempted payment, never order creation or wallet use. A reservation
            // whose payment was never attempted is never polled. Bounded per visit; reopening the market resumes it.
            if (saved?.attempted == true && polls < POLL_BUDGET && (!saved.receipt.terminal || (saved.receipt.state == "settled" && !state.value.hydrated))) {
                polls++; repository.checkPayment()
            }
            // The server ended an attempted payment unpaid: slowly, GET-only, until the repository can prove that
            // nothing was charged and retires it (UnpaidAttempt). It never settles, so it is not the poll above.
            else if (saved?.unpaidEnd == true && !state.value.paymentFound && ticks % UNPAID_END_EVERY == 0 && polls < POLL_BUDGET) { polls++; repository.checkPayment() }
            // The explicit BUY chain finishes its own purchase; the lifecycle never closes anything underneath it.
            if (!active) finishSaved(dropUnpaid = false)
        }
    }
    fun refresh() = run { repository.legacy.refresh(); repository.open(); finishSaved(dropUnpaid = false) }
    fun refreshLegacy() = run { repository.legacy.refresh() }
    fun legacyPage(after: String?) = run { repository.legacy.page(after) }
    fun checkLegacy(purchase: LegacyMarketPurchase) = run { repository.legacy.check(purchase) }
    fun reviewListing(itemId: String, price: String) = run { repository.reviewListing(itemId, price) }
    fun reviewPurchase(offer: MarketOffer) = run { repository.reviewPurchase(offer) }
    fun reviewCancellation(id: String) = run { repository.reviewCancellation(id) }
    fun dismiss() { repository.dismissReview(); if (!active) _buying.value = null }
    /** Listing and cancellation: one confirm, no wallet. */
    fun confirm(review: MarketReview) = run { repository.confirm(review) }
    /** The gold PAY tap on the confirm plate: reserve, then straight to the wallet. */
    fun buy(review: MarketReview.Purchase, sender: MarketPurchaseSender) = run {
        // A settled or never-paid saved purchase must not block this one; the store's own guards decide what may close.
        finishSaved(dropUnpaid = true)
        if (state.value.saved != null) { repository.dismissReview(); notify("STILL CONFIRMING YOUR LAST PURCHASE — IT FINISHES BY ITSELF."); return@run }
        _buying.value = review
        repository.confirm(review)
        if (state.value.saved == null && state.value.error == null) { _buying.value = null; return@run }
        // The chain stops at the first error: a reservation that did not come back clean never opens a wallet.
        if (state.value.error == null) payIfReady(sender)
    }
    /** RETRY after a decline: the same saved reservation, one explicit tap, and only while `pay()` still allows it. */
    fun retryPay(sender: MarketPurchaseSender) = run { payIfReady(sender) }
    private suspend fun payIfReady(sender: MarketPurchaseSender) {
        val s = state.value; val saved = s.saved
        if (saved != null && !saved.attempted && saved.receipt.state == "reserved" && s.pending.none { it.kind == IntentKind.MARKET_RESERVE }) {
            _paying.value = true; _payFailure.value = null
            try { repository.pay(sender) } finally { _paying.value = false }
            state.value.let { s -> _payFailure.value = mark(s)?.let { mark -> s.error?.let { PayFailure(it, mark) } } }
        }
        finishSaved(dropUnpaid = false)
    }
    /** Closes what the store allows to close, so the next BUY is never blocked by a finished purchase: a settled and
     * hydrated one (toast), or a never-attempted one the server ended. `dropUnpaid` also leaves a still-open unpaid
     * reservation, which only the player's next BUY tap asks for. An attempted, unsettled payment is never closed
     * here; one the server ended unpaid is retired by the repository alone, on its own proof (UnpaidAttempt). */
    private suspend fun finishSaved(dropUnpaid: Boolean) {
        val s = state.value; val saved = s.saved ?: return
        if (s.pending.any { it.kind == IntentKind.MARKET_RESERVE }) return
        val settled = saved.receipt.state == "settled" && s.hydrated
        val ended = !saved.attempted && s.loaded && s.error == null && (saved.receipt.state in setOf("cancelled", "superseded") || !s.quoteFresh)
        if (!settled && !ended && !(dropUnpaid && !saved.attempted)) return
        repository.closePurchase()
        if (state.value.saved != null) return
        _buying.value = null
        if (settled) toast(if (s.destinationRefresh?.stillOwned == false) "PAYMENT CONFIRMED · ITEM DELIVERED TO ITS ORIGINAL BASE" else "BOUGHT! ${itemName(saved.quote.itemId).uppercase()} IS IN YOUR BAG")
        else if (ended && !dropUnpaid) notify("PRICE HOLD ENDED — NOTHING WAS CHARGED. TAP BUY AGAIN.")
    }
    fun command(kind: String, retry: Boolean = false) = run { repository.checkCommand(kind, retry) }
    fun checkPayment() = run { repository.checkPayment(); finishSaved(dropUnpaid = false) }
    fun close() = run { repository.closePurchase(); if (state.value.saved == null) _buying.value = null }
    fun closeBuyDialog() { if (!active) { repository.dismissReview(); _buying.value = null } }
    private companion object {
        /** Client polling budget per market visit (about ten minutes at the catalogue cadence); not a game number. */
        const val POLL_BUDGET = 240
        /** An attempted payment the server ended unpaid is re-checked every this many ticks (about 30 s); not a game number. */
        const val UNPAID_END_EVERY = 12
    }
}

/** The market's purchase details for the collapsed DETAILS disclosure; nothing here is needed to buy. */
private fun marketPurchaseDetails(saved: SavedMarketPurchase, feeLamports: String?): List<PaymentDetail> { val q = saved.quote; return listOfNotNull(
    PaymentDetail("Seller gets", "${marketSol(q.sellerLamports)} SOL"), PaymentDetail("Market fee", "${marketSol(q.feeLamports)} SOL (${marketPercent(q.feeBps)}%)"),
    PaymentDetail("Delivers to", q.buyerBaseId ?: "wallet custody"), PaymentDetail("Seller", q.seller), PaymentDetail("Fee treasury", q.feeTreasury),
    PaymentDetail("Reservation", q.reservationId), PaymentDetail("Reference", q.reference), PaymentDetail("Network", q.cluster),
    PaymentDetail("Price held until", q.payableUntil), saved.signature?.let { PaymentDetail("Transaction", it) },
    feeLamports?.let { PaymentDetail("Network fee estimate", "${marketSol(it)} SOL") }) }

/** The small line under the price: the market fee is inside the price; the network fee is the wallet's own. */
internal fun marketFeeLine(feeBps: Int?, networkFeeLamports: String?): String = listOfNotNull(
    feeBps?.let { "INCLUDES ${marketPercent(it)}% MARKET FEE" },
    networkFeeLamports?.let { "NETWORK FEE ≈ ${marketSol(it)} SOL" } ?: "+ SMALL NETWORK FEE").joinToString(" · ")

/** The one status sentence for a saved market purchase the player is not currently paying. */
@Composable private fun MarketPurchaseStatus(saved: SavedMarketPurchase, state: MarketTradeState, paying: Boolean, senderConnected: Boolean) {
    val receiptState = saved.receipt.state
    when (receiptState) {
        "settled" -> {
            Text("PURCHASED. ITEM DELIVERED.", style = PkwType.readable, color = SurfaceInk.success)
            if (state.destinationRefresh?.stillOwned == false) Text("The receiving base now belongs to another keeper. Your payment is confirmed; its inventory is private.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
        }
        // An attempted payment the server ended unpaid clears by itself once nothing can have been charged; support is
        // only for one whose transaction the network does know.
        "cancelled", "superseded" -> Text(when {
            !saved.attempted -> "PRICE HOLD ENDED — NOTHING WAS CHARGED."
            saved.unpaidEnd && !state.paymentFound -> UnpaidAttempt.CHECKING
            else -> "This purchase ended while your payment was being checked. Contact support@pixelkingdomwars.com with the reservation under DETAILS before paying again."
        }, style = PkwType.readable, color = SurfaceInk.muted)
        else -> paymentProgressLine(true, saved.attempted, saved.signature != null, paying)?.let { Text(it, style = PkwType.readable, color = SurfaceInk.goldHi) }
            ?: run { if (!senderConnected) Notice("Reconnect your wallet to pay.", NoticeKind.WARN) }
    }
}

/** Web marketRecovery.tsx + the SELL section of ItemMarketTab. A purchase interrupted earlier shows here and finishes
 * by itself while the market is open; nothing on this plate is needed in the happy path. */
@Composable internal fun MarketTradePanel(model: MarketTradeViewModel, state: MarketTradeState, wallet: String,
    bounds: MarketTradeBounds?, sender: MarketPurchaseWallet?, itemName: (String) -> String, itemAsset: (String) -> String? = { null }, feeBps: Int? = null) {
    var item by rememberSaveable(wallet) { mutableStateOf("") }
    var price by rememberSaveable(wallet) { mutableStateOf("") }
    var choosing by remember { mutableStateOf(false) }
    val inventory = state.inventory
    val actionNotice by model.notice.collectAsState()
    val legacy by model.legacyState.collectAsState()
    val paying by model.paying.collectAsState()
    val payFailure by model.payFailure.collectAsState()
    val buying by model.buying.collectAsState()
    val listable = inventory?.catalog.orEmpty().filter { !it.dropOnly && requireNotNull(inventory).stored(it.id) > 0 }
    val now = displayClock()
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // The buy dialog carries its own failure sentence; never say it twice.
        if (buying == null) {
            // The PAY tap's failure sentence outlives the polls that clear state.error.
            payFailure?.let { DismissableNotice(it, true) }
            state.error?.takeIf { it != payFailure }?.let { DismissableNotice(it, true) }
        }
        state.notice?.let { DismissableNotice(it, false) }
        actionNotice?.let { DismissableNotice(it.message, it.error, model::dismissNotice) }
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (!state.supported) Notice("Item trading will become available when this server enables marketplace receipts. You can browse now.")
        state.pending.forEach { pending ->
            PaymentPlate(pending.label.uppercase(), art = "timer", pill = PaymentPill("CHECKING", PaymentTone.SENT),
                actions = listOf(PaymentAction(PaymentActions.CHECK, "CHECK AGAIN", PaymentActionRole.PRIMARY, !state.busy)),
                detailActions = listOfNotNull(if (pending.receipt == null && pending.attempted) PaymentAction(PaymentActions.RETRY_QUOTE, "RETRY THIS EXACT REQUEST", PaymentActionRole.SECONDARY, !state.busy) else null),
                onAction = { when (it) { PaymentActions.CHECK -> model.command(pending.kind); PaymentActions.RETRY_QUOTE -> model.command(pending.kind, true) } },
                details = listOf(PaymentDetail("Source or receiving deed", pending.baseId ?: "wallet custody"), PaymentDetail("Request", pending.idempotencyKey))) {
                Text(if (pending.receipt != null) "Saved. Refresh to finish loading it." else "We could not confirm this request yet. It is checked again when you open the market.", style = PkwType.readable, color = SurfaceInk.muted)
            }
        }
        state.saved?.takeIf { buying == null }?.let { saved ->
            val q = saved.quote
            val receiptState = saved.receipt.state
            val price = marketSol(q.priceLamports)
            val plan = marketPaymentPlan(receiptState, saved.attempted, state.canPay, sender != null, bounds != null, state.busy, state.hydrated,
                state.pending.none { it.kind == IntentKind.MARKET_RESERVE }, price, paying)
            PaymentPlate(itemName(q.itemId).uppercase(), art = itemAsset(q.itemId) ?: "bag", pill = marketPaymentPill(receiptState, saved.attempted, paymentUncertain(saved.attempted, saved.signature != null, paying)),
                amount = price, feeLine = marketFeeLine(q.feeBps, state.feeLamports),
                countdown = if (!saved.attempted && receiptState == "reserved") payWindowUrgent(q.payableUntil, now) else null,
                actions = plan.actions, detailActions = plan.detailActions,
                onAction = { when (it) { PaymentActions.PAY -> sender?.let(model::retryPay); PaymentActions.CHECK -> model.checkPayment(); PaymentActions.FINISH, PaymentActions.LEAVE -> model.close() } },
                details = marketPurchaseDetails(saved, state.feeLamports)) { MarketPurchaseStatus(saved, state, paying, sender != null) }
        }
        LegacyMarketPanel(model, legacy, state.busy, itemName)
        if (state.supported) TitledPlate("SELL AN ITEM", art = "bag") {
            Box {
                OutlinedButton(onClick = { choosing = true }, enabled = !state.busy && listable.isNotEmpty(), modifier = Modifier.fillMaxWidth()) {
                    ItemArt(listable.find { it.id == item }?.let { itemAsset(it.id) }, Modifier.size(20.dp))
                    Text(listable.find { it.id == item }?.let { itemName(it.id).uppercase() } ?: "CHOOSE ITEM")
                }
                DropdownMenu(expanded = choosing, onDismissRequest = { choosing = false }) {
                    listable.forEach { choice -> DropdownMenuItem(text = { Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ItemArt(itemAsset(choice.id), Modifier.size(20.dp)); Text("${itemName(choice.id)} · ${inventory?.stored(choice.id)} stored") } }, onClick = { item = choice.id; choosing = false }) }
                }
            }
            if (listable.isEmpty()) EmptyPlate("NOTHING TO SELL YET. EQUIPPED ITEMS CANNOT BE LISTED.")
            OutlinedTextField(price, { if (it.length <= 32) price = it }, label = { Text("PRICE IN SOL") }, singleLine = true,
                leadingIcon = { GameArt("sol", Modifier.size(18.dp)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), enabled = !state.busy, modifier = Modifier.fillMaxWidth())
            val priced = bounds?.let { b -> runCatching { b.price(price) }.getOrNull() }
            Text(listOfNotNull(bounds?.let { "${marketSol(it.minPrice.toString())}–${marketSol(it.maxPrice.toString())} SOL" }, feeBps?.let { "${marketPercent(it)}% MARKET FEE WHEN IT SELLS" }).joinToString(" · "),
                style = MaterialTheme.typography.labelSmall, color = SurfaceInk.faint)
            Button(onClick = { model.reviewListing(item, price) }, modifier = Modifier.fillMaxWidth(), enabled = !state.busy && listable.any { it.id == item } &&
                state.pending.none { it.kind == IntentKind.MARKET_LIST } && priced != null) { Text(priced?.let { "LIST FOR ${marketSol(it)} SOL" } ?: "LIST FOR SALE") }
        }
    }
}

/** BUY: one compact confirm plate that follows the purchase from the gold tap to DONE. SELL and CANCEL LISTING: one confirm. */
@Composable internal fun MarketTradeDialogs(model: MarketTradeViewModel, state: MarketTradeState, sender: MarketPurchaseWallet?, itemName: (String) -> String,
    itemAsset: (String) -> String? = { null }, feeBps: Int? = null) {
    val mfa = sender?.mfa?.collectAsState()?.value
    val buying by model.buying.collectAsState()
    val paying by model.paying.collectAsState()
    val payFailure by model.payFailure.collectAsState()
    val now = displayClock()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    BackHandlerAt(BackPriority.CONFIRM, state.review != null || buying != null) { if (buying != null) model.closeBuyDialog() else model.dismiss() }
    BackHandlerAt(BackPriority.CONFIRM, mfa != null) { mfa?.let { sender?.cancelMfa(it) } }
    val purchase = buying ?: state.review as? MarketReview.Purchase
    val freshReview = marketFreshPurchaseReview(state, buying, paying, mfa != null)
    if (purchase != null) {
        if (freshReview == purchase) {
            val armedAt = remember(purchase) { System.currentTimeMillis() }
            val tap = remember(purchase) { MarketSealTap(purchase) }
            MarketOwnerSealDialog(marketPurchaseReviewSeal(purchase, itemName(purchase.offer.itemId),
                itemAsset(purchase.offer.itemId), feeBps, state.feeLamports, armedAt, sender != null),
                onConfirm = {
                    sender?.let { wallet ->
                        val current = marketFreshPurchaseReview(model.state.value, model.buying.value,
                            model.paying.value, wallet.mfa.value != null)
                        if (tap.take(current, !model.busy.value && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)))
                            model.buy(purchase, wallet)
                    }
                },
                onBack = { if (!model.busy.value && model.state.value.review == purchase) model.dismiss() })
        } else {
        val offer = purchase.offer
        // Only the purchase this dialog started; an older saved purchase keeps its own plate in the panel.
        val saved = state.saved?.takeIf { buying != null && it.quote.listingId == offer.id }
        val price = marketSol(offer.priceLamports)
        val working = state.busy || paying
        // Once attempted, only the PAY tap itself is "in the wallet"; a settlement poll (state.busy) must not read as one.
        val progress = if (buying == null) null else paymentProgressLine(saved != null, saved?.attempted == true, saved?.signature != null, if (saved?.attempted == true) paying else working)
        val retry = saved != null && !saved.attempted && !working
        PaymentConfirmDialog(itemName(offer.itemId).uppercase(), price, art = itemAsset(offer.itemId) ?: "bag",
            payLabel = when { working -> "WORKING…"; retry -> "RETRY · $price SOL"; else -> "PAY $price SOL" },
            payEnabled = sender != null && !working && (saved == null || state.canPay), showPay = saved?.attempted != true && (buying == null || saved != null || working),
            onPay = { sender?.let { wallet -> if (retry) model.retryPay(wallet) else if (buying == null) model.buy(purchase, wallet) } },
            onCancel = { when { working -> Unit; retry -> model.close(); buying != null -> model.closeBuyDialog(); else -> model.dismiss() } },
            onDismiss = { if (buying != null) model.closeBuyDialog() else model.dismiss() },
            cancelLabel = if (saved?.attempted == true || (buying != null && saved == null)) "CLOSE" else "CANCEL",
            feeLine = marketFeeLine(saved?.quote?.feeBps ?: feeBps, state.feeLamports), progress = progress, failure = (payFailure ?: state.error).takeIf { buying != null },
            details = saved?.let { marketPurchaseDetails(it, state.feeLamports) } ?: listOf(PaymentDetail("Seller", offer.seller), PaymentDetail("Delivers to", purchase.buyerBaseId ?: "wallet custody"), PaymentDetail("Listing", offer.id)),
            detailActions = if (saved?.attempted == true) listOf(PaymentAction(PaymentActions.CHECK, "CHECK NOW", PaymentActionRole.SECONDARY, !working)) else emptyList(),
            onAction = { if (it == PaymentActions.CHECK) model.checkPayment() }) {
            if (sender == null) Notice("Reconnect your wallet to pay.", NoticeKind.WARN)
            if (retry) payWindowUrgent(saved?.quote?.payableUntil, now)?.let { PaymentWindowLine(it) }
        }
        }
    }
    (state.review.takeIf { it !is MarketReview.Purchase })?.let { review ->
        AlertDialog(onDismissRequest = { if (!state.busy) model.dismiss() }, title = { Text(when (review) {
            is MarketReview.Listing -> "SELL ${itemName(review.itemId).uppercase()}"
            is MarketReview.Cancellation -> "CANCEL LISTING"
            is MarketReview.Purchase -> ""
        }) }, text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            when (review) {
                is MarketReview.Listing -> {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        GameArt("sol", Modifier.size(22.dp)); Text("${marketSol(review.priceLamports)} SOL", style = MaterialTheme.typography.headlineSmall, color = SurfaceInk.gold) }
                    feeBps?.let { Text("${marketPercent(it)}% MARKET FEE COMES OUT OF THE SALE.", style = MaterialTheme.typography.labelSmall, color = SurfaceInk.muted) }
                    Text("The item leaves your bag while it is listed. Cancel the listing any time to get it back.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
                }
                is MarketReview.Cancellation -> { val listing = review.consent.listing
                    Text("${itemName(listing.itemId).uppercase()} · ${marketSol(listing.priceLamports)} SOL")
                    if (listing.status == "reserved") Text("A buyer is paying for this item right now. If their payment confirms, the sale stands and the item goes to them.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
                    else Text("The item goes back to your bag.", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted) }
                is MarketReview.Purchase -> Unit
            }
        } }, confirmButton = { Button(onClick = { model.confirm(review) }, enabled = !state.busy) { Text(when (review) {
            is MarketReview.Listing -> "LIST ITEM"
            is MarketReview.Cancellation -> "YES, CANCEL"
            is MarketReview.Purchase -> ""
        }) } },
            dismissButton = { TextButton(onClick = { model.dismiss() }, enabled = !state.busy) { Text("BACK") } })
    }
    mfa?.let { request -> if (sender != null) SensitiveMfaDialog(request, submit = { sender.submitMfa(request, it) }, cancelRequest = { sender.cancelMfa(request) }) }
}
