package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.BasePurchaseWallet
import gg.pixelkingdomwars.nativeclient.network.BasePurchaseOffer
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kingdom.BasePurchaseViewModel
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Seal
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BEING_CHECKED
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.HalfSheetHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.hireSubLine

/*
 * SOL base purchases in place on Home (buildings/SPEC.md R2.1 HIRE BUILDER, E1.2 EXPAND, and the SOL step of a Mine /
 * Gold Forge upgrade): the designed Seal is the consent and the sheet's primary carries the money sequence. Every money
 * step is the EXISTING owner's: `BasePurchaseViewModel.foreground / buy / retryPay / check / consumeFinished / dismiss`
 * with the EXISTING sender `BasePurchaseWallet`. This file adds no quote, signature, submission or payment code. The
 * owner keeps the security invariants: the draft and its key are persisted before the quote POST, `attempted` before the
 * wallet opens, a mutation is never retried by itself, and recovery is GET-only (its attempted-payment confirm loop is
 * the owner-approved 2026-09-18 behaviour of the purchase screen, which this flow drives the same way).
 */

/** The Home side of one SOL base purchase: the EXISTING owner [model] (`BasePurchaseViewModel(session.basePurchases)`)
 *  and the EXISTING wallet sender [sender] (`graph.basePurchaseWallet`). Nothing here quotes, signs or submits. */
internal class HomeSolPurchase(val model: BasePurchaseViewModel, val sender: BasePurchaseWallet) {
    /** True while one of its Seals, the wallet step or the wallet's MFA prompt is up; the Home mount reports its review
     *  lease blocked meanwhile (MS-C3). Written only by the composed purchase flow. */
    var consentOpen by mutableStateOf(false)
}

/** One composed purchase, as its sheet reads it. */
internal class SolPurchaseFlow(
    /** The purchase as the owner's state reads now. */
    val view: SolPurchaseView,
    /** The owner's review of this exact purchase (the Seal's fee line and land token); null until it arrives. */
    val review: BasePurchaseOffer?,
    /** The Seal is raised. */
    val sealUp: Boolean,
    /** When the Seal was armed: on raise, and again when the review's price arrives or changes. */
    val armedAtMs: Long,
    /** The owner's own sentences for this visit: the wallet's reason, its notices and its errors. */
    val messages: List<String>,
    /** A saved purchase needs its recovery door (DETAILS); never offered during the wallet step. */
    val recovery: Boolean,
    /** The sheet's purchase primary (HIRE / EXPAND / UPGRADE, RETRY, Being checked), routed by [solPrimaryTap]. */
    val primary: () -> Unit,
    /** The Seal's armed primary, routed by [solConfirmTap]. */
    val confirm: () -> Unit,
    /** The Seal's BACK, scrim tap or system Back. */
    val cancel: () -> Unit,
    /** CHECK: the owner's GET-only check of the saved purchase. */
    val check: () -> Unit,
    /** RETRY: the same saved quote, one explicit tap, only while the owner says canPay. */
    val retry: () -> Unit,
)

/**
 * Drives the owner for one purchase while its sheet is composed, as the purchase screen did: resumed -> `foreground`
 * (GET observe and the attempted-payment confirm loop; the GET-only review only once the player asks for the price by
 * raising the Seal); disposed -> `dismiss`; finished ->
 * `consumeFinished` then [onFinished] (the owner already posted its toast). [explain] receives every refusal sentence;
 * [onSealCancel] runs when the player backs out of the Seal.
 */
@Composable internal fun rememberSolPurchase(purchase: HomeSolPurchase, kind: String, baseId: String?, buildingId: String?,
    onFinished: () -> Unit, explain: (String) -> Unit, onSealCancel: () -> Unit = {}): SolPurchaseFlow {
    val model = purchase.model
    val sender = purchase.sender
    val state by model.state.collectAsState()
    val running by model.busy.collectAsState()
    val paying by model.paying.collectAsState()
    val payFailure by model.payFailure.collectAsState()
    val notice by model.notice.collectAsState()
    val finished by model.finished.collectAsState()
    val mfa by sender.mfa.collectAsState()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var sealUp by remember(kind, baseId, buildingId) { mutableStateOf(false) }
    var armedAt by remember { mutableLongStateOf(0L) }
    // From this visit's BUY / RETRY tap until the owner's action and its wallet step end.
    var sending by remember { mutableStateOf(false) }
    // This visit asked the owner for something: only then does a plain owner error belong on this sheet.
    var asked by remember { mutableStateOf(false) }
    // The owner reviews this purchase (GET-only: account, availability, Home) only once the player asks for its price;
    // until then the visit only observes a saved purchase. [attempt] restarts the visit to ask again after a failed or
    // spent review.
    var wantReview by remember(kind, baseId, buildingId) { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    val latestFinished by rememberUpdatedState(onFinished)
    val latestExplain by rememberUpdatedState(explain)
    val latestCancel by rememberUpdatedState(onSealCancel)
    LaunchedEffect(running, paying) { if (!running && !paying) sending = false }
    val view = solPurchaseView(state, kind, baseId, buildingId, paying, sending && (running || paying))
    fun current(): SolPurchaseView = solPurchaseView(model.state.value, kind, baseId, buildingId, model.paying.value,
        sending && (model.busy.value || model.paying.value))

    // A wallet approval leaves this Activity temporarily; the owner keeps the payment across PAUSE / STOP.
    LaunchedEffect(model, lifecycle, kind, baseId, buildingId, attempt) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { model.foreground(if (wantReview) kind else "", baseId.orEmpty(), buildingId) }
    }
    DisposableEffect(model) { onDispose { model.dismiss() } }
    // The purchase confirmed and finished itself (toast already posted): leave once, only for this purchase's kind.
    LaunchedEffect(finished) { finished?.let { done -> model.consumeFinished(); if (done == kind) latestFinished() } }
    // The review's price arrived or changed under a raised Seal: re-arm, so no tap lands on a price it did not show.
    LaunchedEffect(view.price.amount) { if (sealUp) armedAt = System.currentTimeMillis() }
    // Another purchase was saved or purchases paused: the Seal comes down (the sheet then says why).
    LaunchedEffect(view.canRaise) { if (!view.canRaise) sealUp = false }
    val consent = sealUp || mfa != null || paying
    DisposableEffect(purchase, consent) { purchase.consentOpen = consent; onDispose { purchase.consentOpen = false } }
    BackHandlerAt(BackPriority.CONFIRM, mfa != null) { mfa?.let { sender.cancelMfa(it) } }
    // Back cancels a Seal, never confirms it.
    BackHandlerAt(BackPriority.CONFIRM, sealUp) { sealUp = false; latestCancel() }

    fun raise() {
        val now = current()
        if (!now.canRaise) { sealUp = false; latestExplain(now.reason ?: SOL_NOT_AVAILABLE); return }
        val s = model.state.value
        // No review of this purchase yet: ask for it (first time, or again once the owner is idle); the Seal shows "…"
        // until its price arrives and re-arms then.
        if (solReview(s, kind, baseId, buildingId) == null && s.saved == null && (!wantReview || !s.busy)) { wantReview = true; attempt++ }
        asked = true; armedAt = System.currentTimeMillis(); sealUp = true
    }
    fun check() { asked = true; model.check() }
    fun retry() {
        val now = current()
        if (now.canRetry) { asked = true; sending = true; model.retryPay(sender) } else latestExplain(now.reason ?: SOL_GETTING_PRICE)
    }
    fun primary() {
        when (solPrimaryTap(current())) {
            SolTap.RAISE -> raise()
            SolTap.CHECK -> check()
            SolTap.RETRY -> retry()
            // The money button takes no tap while the wallet or the realm is answering.
            SolTap.WAIT -> Unit
            SolTap.EXPLAIN -> latestExplain(current().reason ?: SOL_GETTING_PRICE)
        }
    }
    fun confirm() {
        val now = current()
        val offer = solReview(model.state.value, kind, baseId, buildingId)
        when (solConfirmTap(now)) {
            SolConfirm.BUY -> if (offer != null) { sealUp = false; asked = true; sending = true; model.buy(offer, sender) }
            // The Seal stays up and waits for the review's price; the toast says so above the scrim.
            SolConfirm.WAIT_PRICE -> Toasts.post(now.reason ?: SOL_GETTING_PRICE)
            SolConfirm.REFUSE -> { sealUp = false; latestExplain(now.reason ?: SOL_NOT_AVAILABLE) }
        }
    }
    // A refusal on a READY primary is drawn by the primary itself; a reason on a payment in flight (a receipt for another
    // deed) is only said here.
    val messages = listOfNotNull(view.reason.takeIf { view.stage != MoneyStage.READY }, payFailure, notice?.message, state.notice,
        state.error?.takeIf { asked || state.saved != null }).filter { it.isNotBlank() }.distinct()
    return SolPurchaseFlow(view, solReview(state, kind, baseId, buildingId), sealUp, armedAt, messages,
        recovery = state.saved != null && !paying && view.stage != MoneyStage.CHECK_WALLET,
        primary = { primary() }, confirm = { confirm() }, cancel = { sealUp = false; latestCancel() },
        check = { check() }, retry = { retry() })
}

/** The flow's Seal and the wallet's MFA prompt. Compose it inside a full-size parent and keep it composed while the
 *  sheet is (the Seal animates out on its own when [SolPurchaseFlow.sealUp] clears). */
@Composable internal fun SolPurchaseOverlay(purchase: HomeSolPurchase, flow: SolPurchaseFlow, title: String, lines: List<String>,
    gets: PriceUi? = null) {
    Seal(if (flow.sealUp) solSealUi(flow.view, title, lines, flow.armedAtMs, gets = gets) else null,
        onConfirm = flow.confirm, onCancel = flow.cancel)
    val mfa by purchase.sender.mfa.collectAsState()
    mfa?.let { request -> SensitiveMfaDialog(request, submit = { purchase.sender.submitMfa(request, it) },
        cancelRequest = { purchase.sender.cancelMfa(request) }) }
}

/**
 * The SOL step of a Mine / Gold Forge upgrade (kind "mine"; buildings/upgrade.png and info.png, SOL-step consent only):
 * opening it raises the designed Seal at once ("UPGRADE <NAME>", the owner's Shards and build-time line, "Paid from your
 * wallet. You sign once."). Under it a small half sheet carries the money sequence, "Being checked" + CHECK for an
 * uncertain answer and the stone DETAILS recovery door ([onDetails], which the mount wires to the old purchase screen).
 * Backing out of the Seal closes it ([onClose]); a finished purchase closes it too. With no [purchase] owner the old
 * purchase screen keeps this consent: [onDetails] then [onClose] run once.
 */
@Composable internal fun LivePaidUpgradeSeal(purchase: HomeSolPurchase?, baseId: String?, buildingId: String?, title: String,
    onClose: () -> Unit, onDetails: () -> Unit, modifier: Modifier = Modifier) {
    val latestDetails by rememberUpdatedState(onDetails)
    val latestClose by rememberUpdatedState(onClose)
    if (purchase == null) {
        LaunchedEffect(Unit) { latestDetails(); latestClose() }
    } else {
        var explanation by remember { mutableStateOf<String?>(null) }
        val flow = rememberSolPurchase(purchase, "mine", baseId, buildingId, onFinished = { latestClose() },
            explain = { explanation = it }, onSealCancel = { latestClose() })
        val raiseOnOpen by rememberUpdatedState(flow.primary)
        // This entry point IS the consent: it raises its Seal once (a saved purchase routes to CHECK or its reason instead).
        LaunchedEffect(Unit) { raiseOnOpen() }
        BackHandlerAt(BackPriority.SHEET) { latestClose() }
        val view = flow.view
        val review = flow.review
        val lines = listOfNotNull(SOL_UPGRADE_STARTS, solFeeLine(review), SOL_SIGN_ONCE)
        val label = title.substringBefore(' ')
        Box(modifier.fillMaxSize()) {
            LiveHalfSheetHost { placed ->
                Plate(PlateKind.WOOD, placed) {
                    Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
                        HalfSheetHeader(title, { latestClose() }, tag = review?.fromLevel?.let { "LV $it" }, tagTo = review?.toLevel?.let { "LV $it" })
                        Spacer(Modifier.height(6.dp))
                        Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), contentPadding = PaddingValues(8.dp), blocksScene = false) {
                            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                (lines.dropLast(1) + flow.messages + listOfNotNull(explanation)).distinct().forEach { line ->
                                    PkwText(line, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 3)
                                }
                                when {
                                    view.uncertain -> PrimaryButton("CHECK", flow.check, Modifier.fillMaxWidth(), verb = Verb.STONE, sub = BEING_CHECKED)
                                    view.stage != MoneyStage.READY -> MoneyButton(view.stage, label, flow.retry, Modifier.fillMaxWidth())
                                    else -> PrimaryButton(label, flow.primary, Modifier.fillMaxWidth(), sub = hireSubLine(view.price),
                                        state = if (view.canRaise) CommandState.ENABLED else CommandState.DISABLED,
                                        reason = view.reason.takeIf { !view.canRaise })
                                }
                                if (flow.recovery) SecondaryButton("DETAILS", { latestDetails() }, Modifier.fillMaxWidth())
                            }
                        }
                    }
                }
            }
            SolPurchaseOverlay(purchase, flow, title, lines)
        }
    }
}
