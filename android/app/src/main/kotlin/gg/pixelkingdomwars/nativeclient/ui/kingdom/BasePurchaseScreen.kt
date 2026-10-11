package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentAction
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentActionRole
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentActions
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.PayFailure
import gg.pixelkingdomwars.nativeclient.ui.chrome.basePurchasePlan
import gg.pixelkingdomwars.nativeclient.ui.chrome.paymentProgressLine
import gg.pixelkingdomwars.nativeclient.ui.chrome.paymentUncertain
import gg.pixelkingdomwars.nativeclient.ui.chrome.unpaidQuoteBlockedLine
import gg.pixelkingdomwars.nativeclient.ui.chrome.payWindowUrgent
import gg.pixelkingdomwars.nativeclient.ui.chrome.basePurchasePill

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.data.BasePurchaseRepository
import gg.pixelkingdomwars.nativeclient.data.BasePurchaseUiState
import gg.pixelkingdomwars.nativeclient.data.BasePurchaseSender
import gg.pixelkingdomwars.nativeclient.data.BasePurchaseWallet
import gg.pixelkingdomwars.nativeclient.data.UnpaidAttempt
import gg.pixelkingdomwars.nativeclient.network.BasePurchaseOffer
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.network.trayLabel
import gg.pixelkingdomwars.nativeclient.ui.Notice
import gg.pixelkingdomwars.nativeclient.ui.NoticeKind
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.PkwType
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import gg.pixelkingdomwars.nativeclient.ui.displayClock
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import java.math.BigDecimal
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive

/** SOL has nine fractional decimal places. Keep the integer amount exact, including in display copy. */
internal fun basePurchaseSol(lamports: String): String = BigDecimal(lamports).movePointLeft(9).stripTrailingZeros().toPlainString()

internal fun basePurchaseTitle(kind: String, buildingType: String? = null): String = when (kind) {
    "energy" -> "Raid energy"
    "energy_pack" -> "Raid energy pack"
    "builder" -> "Builder Workman"
    "expansion" -> "Plot expansion"
    "mine" -> "${buildingType?.let(::trayLabel) ?: "Building"} upgrade"
    "shield" -> "Shield extension"
    "warzone_shield" -> "Warzone shield"
    else -> "Base purchases"
}

internal fun basePurchaseAccepted(kind: String, shieldGranted: Boolean? = null, energyQuantity: Int? = null): String = when (kind) {
    "energy", "energy_pack" -> if (energyQuantity != null) "+$energyQuantity RAID ENERGY. ATTACK WHEN READY." else "ENERGY PURCHASE CONFIRMED."
    "builder" -> "BUILDER HIRED."
    "expansion" -> "LAND EXPANDED."
    "mine" -> "UPGRADE STARTED. It is ready when its build timer finishes."
    "shield" -> if (shieldGranted == true) "SHIELD EXTENDED. It stays down during a Warzone."
        else if (shieldGranted == false) "The payment was confirmed, but the shield was no longer eligible when it settled. No additional protection or refund is confirmed."
        else "SHIELD PURCHASE CONFIRMED."
    "warzone_shield" -> if (shieldGranted == true) "WARZONE SHIELD UP." else "SHIELD PURCHASE CONFIRMED."
    else -> "PURCHASED."
}

/** The success toast (web `toast()` wording where the web has one). Null = this outcome needs the plate's full
 * sentence and one OK tap instead of a toast that disappears: a paid shield the server could not grant. */
internal fun basePurchaseToast(kind: String, shieldGranted: Boolean? = null, energyQuantity: Int? = null): String? = when (kind) {
    "energy", "energy_pack" -> energyQuantity?.let { "+$it RAID ENERGY — ATTACK WHEN READY" } ?: "ENERGY REFILLED"
    "builder" -> "BUILDER HIRED"
    "expansion" -> "LAND EXPANDED"
    "mine" -> "UPGRADE STARTED"
    "shield" -> if (shieldGranted == true) "SHIELD EXTENDED" else null
    "warzone_shield" -> if (shieldGranted == true) "WARZONE SHIELD UP" else null
    else -> "PURCHASED"
}

/** Closing a paid request requires its receipt and original destination hydration, or an explicit
 * account refresh proving the original destination is unavailable. Unknown payments stay saved. */
internal fun basePurchaseCanFinish(status: String?, attempted: Boolean, hasReceipt: Boolean,
    hydrated: Boolean, unavailable: String?): Boolean = when {
    status == "credited" -> hasReceipt && (hydrated || !unavailable.isNullOrBlank())
    status in setOf("expired", "failed") -> !attempted
    else -> false
}

/** One purchase = one explicit gold tap that chains the repository's own quote and pay actions. The money rules stay
 * below this class and are unchanged: the draft and its key are saved before POST /quote, `pay()` persists `attempted`
 * before the wallet opens and refuses a second attempt, and the store finishes only a credited+hydrated purchase or a
 * never-attempted one the server ended (an attempted one the server expired unpaid is retired by the repository alone,
 * on its own proof: UnpaidAttempt). Nothing here retries a mutation or opens a wallet from a lifecycle callback.
 *
 * Auto-confirm (owner 2026-09-18, replaces "foreground never reconciles" for ATTEMPTED payments only): while this
 * screen is resumed, an attempted pending payment is reconciled on the catalogue cadence, exactly like the web's
 * useSolPurchase loop and the native market and deposit rails. POST /deposits/:id/paid re-submits the same persisted
 * signature and POST /deposits/:id/verify is the server's idempotent observe-and-credit; neither creates an order nor
 * moves funds. A quote whose payment was never attempted is never VERIFIED by a lifecycle (verification could expire
 * it). It is only observed, slowly, with the GET that never changes it: a saved quote blocks every base purchase and
 * the store cannot close a pending one, so this visit has to see the server end it. */
class BasePurchaseViewModel(private val repository: BasePurchaseRepository) : ScreenViewModel() {
    val state = repository.state
    /** The PAY tap's own failure sentence (it carries the wallet's reason), shown until that purchase changes status.
     * `state.error` cannot hold it: every repository action clears it, and the loop below acts within one poll. */
    private val _payFailure = MutableStateFlow<PayFailure<Pair<String, String?>>?>(null)
    val payFailure: StateFlow<String?> = combine(_payFailure, state) { failure, s -> failure?.shownFor(mark(s)) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)
    private fun mark(s: BasePurchaseUiState) = s.saved?.let { it.request.key to it.purchase?.status }
    /** True only while the explicit PAY tap is running (quote, wallet pre-flight, the wallet sheet, first reconcile). */
    private val _paying = MutableStateFlow(false)
    val paying: StateFlow<Boolean> = _paying.asStateFlow()
    /** The kind that just finished by itself; the screen leaves once and consumes it. */
    private val _finished = MutableStateFlow<String?>(null)
    val finished: StateFlow<String?> = _finished.asStateFlow()
    fun consumeFinished() { _finished.value = null }
    /** This model outlives its screen. Only a mounted screen is told to leave, so a purchase that finishes after the
     * player walked away (toast only) can never close the next visit. A wallet approval pauses the screen, not this. */
    private var mounted = false

    /** Mount/resume: observe the saved purchase (GET), finish what is already done, review the requested offer (GETs
     * only), then keep confirming an attempted payment until the server answers or the visit's budget runs out. */
    suspend fun foreground(kind: String = "", baseId: String = "", buildingId: String? = null) {
        mounted = true
        repository.open(kind.ifBlank { null }); if (!active) settle()
        var reviewed = false
        suspend fun reviewOnce() {
            val s = state.value
            if (reviewed || active || kind.isBlank() || baseId.isBlank() || !s.loaded || s.saved != null || s.review != null || !s.supported || !s.enabled) return
            reviewed = true; repository.review(kind, baseId, buildingId)
        }
        reviewOnce()
        val pollMs = repository.pollMs() ?: awaitCancellation()
        var polls = 0; var ticks = 0
        while (currentCoroutineContext().isActive) {
            delay(pollMs); ticks++
            val s = state.value; val saved = s.saved; val status = saved?.purchase?.status
            if (saved?.attempted == true && status == "pending" && polls < POLL_BUDGET) { polls++; repository.reconcile() }
            // Credited but its deed refresh failed: GET-only, and it is what lets the purchase close.
            else if (status == "credited" && !s.hydrated && s.unavailable.isNullOrBlank() && polls < POLL_BUDGET) { polls++; repository.check() }
            // An unpaid quote: GET-only and slow. The GET never verifies or expires it; it is how this visit learns that
            // the price window closed, that the server ended the quote (settle() then retires it), or that it can be paid again.
            else if (saved?.attempted == false && status == "pending" && ticks % UNPAID_OBSERVE_EVERY == 0 && polls < POLL_BUDGET) { polls++; repository.check() }
            // The server ended an attempted payment unpaid: GET-only and slow, until the repository can prove that
            // nothing was charged and retires it (UnpaidAttempt), so it never blocks the next purchase.
            else if (saved?.unpaidEnd == true && !s.paymentFound && ticks % UNPAID_OBSERVE_EVERY == 0 && polls < POLL_BUDGET) { polls++; repository.check() }
            if (!active) { settle(); reviewOnce() }
        }
    }
    fun review(kind: String, baseId: String, buildingId: String?) = run { repository.review(kind, baseId, buildingId) }
    /** The gold PAY tap: quote the reviewed offer, then straight to the wallet. Stops at the first error. */
    fun buy(offer: BasePurchaseOffer, sender: BasePurchaseSender) = run {
        repository.create(offer)
        // The chain stops at the first error: a quote that did not come back clean never opens a wallet.
        if (state.value.error == null) payIfReady(sender) else settle()
    }
    /** RETRY after a decline: the same saved quote, one explicit tap, only while the repository still says canPay. */
    fun retryPay(sender: BasePurchaseSender) = run { payIfReady(sender) }
    private suspend fun payIfReady(sender: BasePurchaseSender) {
        if (state.value.canPay) {
            _paying.value = true; _payFailure.value = null
            try { repository.pay(sender) } finally { _paying.value = false }
            state.value.let { s -> _payFailure.value = mark(s)?.let { mark -> s.error?.let { PayFailure(it, mark) } } }
        }
        settle()
    }
    /** Finishes what the store's own guard allows, so a done purchase never blocks the next one. */
    private suspend fun settle() {
        val s = state.value; val saved = s.saved ?: return; val purchase = saved.purchase ?: return
        val kind = saved.offer.kind; val receipt = purchase.receipt
        val toast = basePurchaseToast(kind, receipt?.shieldGranted, receipt?.energyQuantity)
        val credited = purchase.status == "credited" && receipt != null && s.hydrated && s.unavailable.isNullOrBlank() && toast != null
        val ended = !saved.attempted && purchase.status in setOf("expired", "failed")
        if (!credited && !ended) return
        repository.finish()
        if (state.value.saved != null || state.value.error != null) return
        if (credited) { toast(requireNotNull(toast)); if (mounted) _finished.value = kind } else notify("PRICE HOLD ENDED — NOTHING WAS CHARGED.")
    }
    fun retryQuote() = run { repository.retryQuote() }
    fun cancelUnquoted() = run { repository.cancelUnquoted() }
    fun reconcile() = run { repository.reconcile(); settle() }
    fun check(kind: String? = null) = run { repository.check(kind); settle() }
    fun finish(onFinished: (String) -> Unit = {}) = run {
        val kind = state.value.saved?.offer?.kind
        repository.finish()
        if (kind != null && state.value.saved == null && state.value.error == null) onFinished(kind)
    }
    /** The screen left (Back or dispose). */
    fun dismiss() { mounted = false; _finished.value = null; repository.dismiss() }
    private companion object {
        /** Client polling budget per visit (about ten minutes at the catalogue cadence); not a game number. */
        const val POLL_BUDGET = 240
        /** An unpaid quote is observed every this many ticks (about 30 s at the catalogue cadence); not a game number. */
        const val UNPAID_OBSERVE_EVERY = 12
    }
}

/** The plate's header glyph per purchase kind; a mine upgrade shows the building it upgrades. */
internal fun basePurchaseArt(kind: String, buildingType: String? = null): String = when (kind) {
    "energy", "energy_pack" -> "energy"
    "builder" -> "builder"
    "expansion" -> "map"
    "mine" -> buildingType?.let { "building-$it" } ?: "build"
    "shield", "warzone_shield" -> "shield"
    else -> "shop"
}

/** The small line under the hero amount: what else the price carries (Shards, a duration, energy). */
internal fun basePurchaseFeeLine(offer: BasePurchaseOffer, quotedCostShards: String? = null, feeLamports: String? = null): String? = listOfNotNull(
    quotedCostShards?.let { "+ $it SHARDS QUOTED" } ?: offer.maxCostShards?.let { "+ UP TO $it SHARDS" },
    offer.energyQuantity?.let { "+$it RAID ENERGY" },
    offer.seconds?.toLongOrNull()?.let { "${when (offer.kind) { "shield" -> "SHIELD"; "warzone_shield" -> "SHIELD"; else -> "BUILD" }} ${fmtDur(it).uppercase()}" },
    feeLamports?.let { "NETWORK FEE ≈ ${basePurchaseSol(it)} SOL" },
).takeIf { it.isNotEmpty() }?.joinToString(" · ")

/** Price tap -> this one confirm plate -> wallet -> it confirms and closes by itself. One durable purchase can be
 * recovered from any deed, including after losing land ownership; recovery needs no tap. */
@Composable fun BasePurchaseScreen(model: BasePurchaseViewModel, sender: BasePurchaseWallet,
    kind: String, baseId: String, buildingId: String?, onBack: () -> Unit, onEnergyFinished: () -> Unit = onBack) {
    val state by model.state.collectAsState()
    val running by model.busy.collectAsState()
    val paying by model.paying.collectAsState()
    val payFailure by model.payFailure.collectAsState()
    val finished by model.finished.collectAsState()
    val notice by model.notice.collectAsState()
    val mfa by sender.mfa.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val now = displayClock()
    val busy = state.busy || running
    val saved = state.saved
    val purchase = saved?.purchase
    val quote = purchase?.quote
    val back = { model.dismiss(); onBack() }
    val leave: (String) -> Unit = { finishedKind -> if (finishedKind in setOf("energy", "energy_pack")) onEnergyFinished() else onBack() }
    BackHandlerAt(BackPriority.SCREEN) { back() }
    BackHandlerAt(BackPriority.CONFIRM, mfa != null) { mfa?.let { sender.cancelMfa(it) } }
    DisposableEffect(model) { onDispose { model.dismiss() } }
    // A wallet approval leaves this Activity temporarily; do not invalidate it on STOP/PAUSE.
    LaunchedEffect(model, lifecycle, kind, baseId, buildingId) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { model.foreground(kind, baseId, buildingId) }
    }
    // The purchase confirmed and closed itself (toast already posted): leave once.
    LaunchedEffect(finished) { finished?.let { model.consumeFinished(); leave(it) } }
    DesignedPage(if (kind.isBlank()) "PURCHASES" else basePurchaseTitle(saved?.offer?.kind ?: kind).uppercase(), back) {
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        notice?.let { Notice(it.message, it.error, model::dismissNotice) }
        state.notice?.let { Notice(it) }
        // The PAY tap's failure sentence, exactly as the repository worded it; it outlives the polls that clear state.error.
        payFailure?.takeIf { it != notice?.message }?.let { Notice(it, true) }
        state.error?.takeIf { it != notice?.message && it != payFailure }?.let { Notice(it, true) }
        if (!state.loaded) Text("LOADING…", style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted)
        // The availability probe clears `supported` while it asks the server, so an unqualified check told a player who had
        // just tapped UPGRADE "not available" next to GETTING YOUR PRICE… (tester video, 0.5.3). Only a settled answer speaks.
        if (state.loaded && !busy && (!state.supported || !state.enabled)) Notice("This purchase is not available right now. Nothing was charged.", NoticeKind.WARN)
        if (saved == null) {
            val review = state.review
            if (review == null) {
                if (kind.isNotBlank() && baseId.isNotBlank()) PaymentPlate(basePurchaseTitle(kind).uppercase(), art = basePurchaseArt(kind),
                    actions = listOf(PaymentAction(PaymentActions.REVIEW, if (busy) "GETTING YOUR PRICE…" else "SHOW PRICE", PaymentActionRole.PRIMARY, state.loaded && state.supported && state.enabled && !busy)),
                    onAction = { model.review(kind, baseId, buildingId) })
                else PaymentPlate("PURCHASES", art = "shop") {
                    Text("NOTHING TO FINISH. Hire builders and expand from your kingdom, extend shields in the shop, refill energy when you run out.", style = PkwType.readable, color = SurfaceInk.muted)
                }
            } else {
                val price = basePurchaseSol(review.amountLamports)
                PaymentPlate(basePurchaseTitle(review.kind, review.buildingType).uppercase(), art = basePurchaseArt(review.kind, review.buildingType),
                    amount = price, feeLine = basePurchaseFeeLine(review) ?: "+ SMALL NETWORK FEE",
                    actions = listOf(
                        PaymentAction(PaymentActions.PAY, if (busy) "GETTING YOUR PRICE…" else "PAY $price SOL", PaymentActionRole.PRIMARY, !busy && state.supported && state.enabled),
                        PaymentAction(PaymentActions.BACK, "CANCEL", PaymentActionRole.GHOST, !busy)),
                    onAction = { when (it) { PaymentActions.PAY -> model.buy(review, sender); PaymentActions.BACK -> back() } },
                    details = basePurchaseOfferDetails(review)) { BasePurchaseOfferFacts(review) }
            }
        } else {
            val offer = saved.offer
            val status = purchase?.status
            val payable = status == "pending" && !saved.attempted
            val canFinish = quote != null && basePurchaseCanFinish(status, saved.attempted, purchase?.receipt != null, state.hydrated, state.unavailable)
            val price = basePurchaseSol(quote?.amountLamports ?: offer.amountLamports)
            val available = state.supported && state.enabled
            val plan = basePurchasePlan(status, saved.attempted, state.canPay, canFinish, busy, state.supported, state.enabled, price, paying, payable = state.quoteFresh && available)
            PaymentPlate(basePurchaseTitle(offer.kind, offer.buildingType).uppercase(), art = basePurchaseArt(offer.kind, offer.buildingType),
                pill = basePurchasePill(status, saved.attempted, paymentUncertain(saved.attempted, saved.signature != null, paying)),
                amount = price, feeLine = basePurchaseFeeLine(offer, quote?.quotedCostShards, state.feeLamports),
                countdown = if (payable && !paying) payWindowUrgent(quote?.payableUntil, now) else null,
                actions = plan.actions, detailActions = plan.detailActions,
                onAction = { action -> when (action) {
                    PaymentActions.PAY -> model.retryPay(sender)
                    PaymentActions.CHECK -> model.check()
                    PaymentActions.VERIFY -> model.reconcile()
                    PaymentActions.RETRY_QUOTE -> model.retryQuote()
                    PaymentActions.CANCEL_UNQUOTED -> model.cancelUnquoted()
                    PaymentActions.FINISH, PaymentActions.CLOSE -> model.finish(leave)
                } },
                details = basePurchaseOfferDetails(offer) + listOf(PaymentDetail("Purchase request", saved.request.key)) + (quote?.let { q -> listOfNotNull(
                    PaymentDetail("Network", q.rail.cluster), PaymentDetail("Wallet", q.wallet), PaymentDetail("Deposit", q.depositId), PaymentDetail("Reference", q.reference),
                    saved.signature?.let { PaymentDetail("Transaction", it) }, PaymentDetail("Price held until", q.payableUntil),
                    state.feeLamports?.let { PaymentDetail("Network fee estimate", "${basePurchaseSol(it)} SOL") }) } ?: emptyList())) {
                if (quote == null) Text("We could not confirm your price yet. Nothing was charged. Check again, or cancel.", style = PkwType.readable, color = SurfaceInk.muted)
                else when (status) {
                    "credited" -> {
                        val receipt = requireNotNull(purchase).receipt
                        Text(basePurchaseAccepted(offer.kind, receipt?.shieldGranted, receipt?.energyQuantity), style = PkwType.readable, color = SurfaceInk.success)
                        state.unavailable?.let { Notice(it) }
                    }
                    // An attempted payment the server ended unpaid clears by itself once nothing can have been charged;
                    // support is only for a payment the server received (`failed`) or one the network does know.
                    "expired", "failed" -> if (!saved.attempted) Text("PRICE HOLD ENDED — NOTHING WAS CHARGED.", style = PkwType.readable, color = SurfaceInk.muted)
                        else if (saved.unpaidEnd && !state.paymentFound) Text(UnpaidAttempt.CHECKING, style = PkwType.readable, color = SurfaceInk.muted)
                        else Notice("This purchase ended while your payment was being checked. Contact support@pixelkingdomwars.com with the deposit and transaction under DETAILS before paying again.", NoticeKind.WARN)
                    else -> paymentProgressLine(true, saved.attempted, saved.signature != null, paying)?.let { Text(it, style = PkwType.readable, color = SurfaceInk.goldHi) }
                        ?: run { if (!(state.quoteFresh && available) && !busy) Text(unpaidQuoteBlockedLine(available, quote.retryAt, now), style = PkwType.readable, color = SurfaceInk.muted) }
                }
            }
        }
    }
    mfa?.let { request -> SensitiveMfaDialog(request, submit = { sender.submitMfa(request, it) }, cancelRequest = { sender.cancelMfa(request) }) }
}

/** The identifiers an offer carries, for the DETAILS disclosure. */
private fun basePurchaseOfferDetails(offer: BasePurchaseOffer): List<PaymentDetail> =
    listOfNotNull(PaymentDetail("Original deed", offer.baseId), offer.buildingId?.let { PaymentDetail("Original building", it) })

/** What the offer buys, one short line each; the price itself is the plate's hero line. */
@Composable private fun BasePurchaseOfferFacts(offer: BasePurchaseOffer) {
    val facts = listOfNotNull(
        offer.energyQuantity?.let { "+$it RAID ENERGY" },
        offer.expectedCount?.let { if (offer.kind == "builder") "BUILDERS $it → ${it + 1}" else "EXPANSIONS $it → ${it + 1}" },
        if (offer.fromLevel != null && offer.toLevel != null) "LEVEL ${offer.fromLevel} → ${offer.toLevel}" else null,
        offer.claimTiles?.let { "NEW CLAIM $it × $it TILES" },
        offer.seconds?.toLongOrNull()?.let { "${when (offer.kind) { "shield" -> "SHIELD +"; "warzone_shield" -> "SHIELD "; else -> "BUILD TIME " }}${fmtDur(it).uppercase()}" },
        when (offer.kind) {
            "mine" -> "Payment starts the upgrade; it finishes when its build timer ends."
            "shield" -> "Extends your current shield. If the shield breaks or ends before the payment settles, it cannot be extended. Shields are down during Warzones."
            "warzone_shield" -> "Only during an active Warzone. Warzone shields do not stack."
            else -> null
        })
    facts.forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = SurfaceInk.muted) }
}
