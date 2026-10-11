package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.starter.paidStarterRealmIds
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPanel
import gg.pixelkingdomwars.nativeclient.ui.chrome.PixelPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.GameArt
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.LinearProgressIndicator
import gg.pixelkingdomwars.nativeclient.ui.economy.DisclosurePlate
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import java.time.Instant
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.*

data class RealmSalesSelection(val spot: Long, val realm: Long)
fun realmSalesSelection(spot: String, realm: String, policy: RealmSalesSavedPolicy?): RealmSalesSelection? {
    val admitted = policy ?: return null
    fun index(value: String): Long? = value.takeIf { it.length <= 19 && it.matches(Regex("0|[1-9][0-9]*")) }?.toLongOrNull()
    val s = index(spot) ?: return null; val r = index(realm) ?: return null
    return RealmSalesSelection(s, r).takeIf { s < admitted.protocol.totalSpots && r < admitted.protocol.realmCount }
}
/** Display numbering starts at one; only this boundary converts to the wire index. */
fun realmSalesDisplaySelection(spot: String, realm: Long?, policy: RealmSalesSavedPolicy?): RealmSalesSelection? {
    val display = spot.takeIf { it.length <= 19 && it.matches(Regex("[1-9][0-9]*")) }?.toLongOrNull() ?: return null
    return realm?.let { realmSalesSelection((display - 1).toString(), it.toString(), policy) }
}
/** Input feedback describes the protocol range; it never claims that a spot has an offer. */
fun realmSalesSpotError(spot: String, policy: RealmSalesSavedPolicy?): String? {
    if (spot.isEmpty() || policy == null) return null
    return if (realmSalesDisplaySelection(spot, 0, policy) == null) "Enter a whole spot number from 1 to ${policy.protocol.totalSpots}." else null
}
/** Archive keys are sorted identifiers, not dates. Only the retained last key identifies the latest record. */
fun realmSalesHistoryKeys(journal: RealmSalesJournal): List<String> =
    listOfNotNull(journal.lastArchivedKey?.takeIf { it in journal.archiveKeys }) + journal.archiveKeys.filter { it != journal.lastArchivedKey }
/** Canonical catalogue labels keyed through the pinned realm wire mapping, never JSON order. */
fun realmSalesRealmNames(catalogue: JsonObject?): Map<Long, String> {
    val names = ((catalogue?.get("modules") as? JsonObject)?.get("baseVisual") as? JsonObject)?.get("REALM_NAMES") as? JsonObject ?: return emptyMap()
    return paidStarterRealmIds.mapIndexedNotNull { index, id ->
        (names[id] as? JsonPrimitive)?.takeIf { it.isString && it.content.isNotBlank() && it.content.length <= 128 }?.let { index.toLong() to it.content }
    }.toMap()
}
data class RealmSalesPrice(val gross: String, val seller: String, val developer: String)
fun realmSalesPrice(policy: RealmSalesSavedPolicy): RealmSalesPrice {
    val rules = policy.protocol; val gross = rules.permitPriceLamports.toBigInteger(); val basis = rules.basisPoints.toBigInteger()
    return RealmSalesPrice(gross.toString(), (gross * rules.sellerBps.toBigInteger() / basis).toString(),
        (gross * rules.developerBps.toBigInteger() / basis).toString())
}
fun realmSalesEntryAvailable(state: RealmSalesState?, configured: Boolean, storageUnavailable: Boolean = false): Boolean =
    storageUnavailable || configured || state?.let { it.journal?.operation != null || it.journal?.archiveKeys?.isNotEmpty() == true || !it.loaded && it.error != null } == true

data class RealmSalesControls(val begin: Boolean, val review: Boolean, val sign: Boolean, val submit: Boolean, val check: Boolean, val archive: Boolean, val archiveRefusal: Boolean, val archiveFailed: Boolean,
    /** Dead-end audit 2026-10-06: an unanswered quote request (no refusal, no preparation) may be checked and closed. */
    val closeUnanswered: Boolean = false)
private fun realmSalesContradicted(op: RealmSalesOperation): Boolean = op.refusalContradicted ||
    (op.settlementObserved || op.settlement != null) && (op.failureObserved || op.failure != null)

data class RealmSalesReceiptAmount(val lamports: String, val label: String)
/** Displays retained amounts only. Observed but unverified outcomes never reuse the old quote as a charged fee. */
fun realmSalesReceiptAmount(op: RealmSalesOperation): RealmSalesReceiptAmount? = when {
    realmSalesContradicted(op) -> null
    op.failure != null -> RealmSalesReceiptAmount(op.failure.value.receipt.feeLamports, "Actual network fee · spent")
    op.failureObserved -> null
    op.settlement != null -> RealmSalesReceiptAmount(op.settlement.value.receipt.buyerNetPaymentLamports, "Actual purchase payment")
    op.settlementObserved -> null
    else -> op.preparation?.quote?.let { RealmSalesReceiptAmount(it.requiredLamports, "Original maximum total") }
}
fun realmSalesControls(state: RealmSalesState, actionsAllowed: Boolean, running: Boolean = false): RealmSalesControls {
    val available = !running && !state.busy; val op = state.journal?.operation
    val consistent = op == null || !realmSalesContradicted(op)
    val fresh = available && consistent && actionsAllowed && state.journal?.settlementHeld != true && op?.failureObserved != true && op?.failure == null
    val unsigned = fresh && op?.prepareRefusal == null && op?.preparation != null && !op.signingStarted && op.signed == null && op.settlement == null
    return RealmSalesControls(fresh && state.loaded && state.journal != null && op == null, unsigned,
        unsigned && state.review != null && state.review.preparation == op?.preparation,
        fresh && op?.prepareRefusal == null && op?.signed != null && !op.submitAttempted && op.settlement == null,
        available, available && consistent && op?.settlement != null && !op.failureObserved && op.failure == null,
        available && state.journal?.settlementHeld != true && op?.prepareRefusal != null && op.preparation == null &&
            !op.signingStarted && op.signed == null && !op.submitAttempted && !op.settlementObserved && op.settlement == null && !op.refusalContradicted && !op.failureObserved && op.failure == null,
        available && consistent && op?.failure != null && !op.settlementObserved && op.settlement == null && op.prepareRefusal == null,
        available && consistent && state.journal?.settlementHeld != true && op?.prepareAttempted == true && op.preparation == null && op.prepareRefusal == null &&
            !op.signingStarted && op.signed == null && !op.submitAttempted && !op.settlementObserved && op.settlement == null && !op.failureObserved && op.failure == null)
}
fun realmSalesPhase(op: RealmSalesOperation, held: Boolean): String = when {
    realmSalesContradicted(op) -> "PURCHASE OUTCOME HAS CONTRADICTORY EVIDENCE"
    op.failure != null -> "FAILED PURCHASE RECEIPT VERIFIED"
    op.failureObserved -> "FAILED PURCHASE NEEDS VERIFICATION"
    op.settlement != null -> "PURCHASE RECEIPT VERIFIED"
    held && op.prepareRefusal != null -> "REFUSED PURCHASE HAS CONTRADICTORY EVIDENCE"
    held -> "SETTLEMENT NEEDS VERIFICATION"
    op.prepareRefusal != null && op.refusalConfirmedAbsent -> "PREPARATION REFUSED · NO PURCHASE RECORDED"
    op.prepareRefusal != null -> "PREPARATION REFUSED · CHECK BEFORE ARCHIVING"
    op.attemptConfirmedAbsent -> "NO QUOTE RECORDED · CLOSED ON THIS DEVICE"
    op.submitAttempted -> "SUBMISSION OUTCOME PENDING"
    op.signed != null -> "WALLET APPROVED · NOT SUBMITTED"
    op.signingStarted -> "WALLET OUTCOME UNKNOWN"
    op.preparation == null -> "PREPARATION OUTCOME UNKNOWN"
    else -> "PURCHASE PREPARED · REVIEW REQUIRED"
}
private fun realmSalesUtc(value: String): String = runCatching { Instant.ofEpochSecond(value.toLong()).toString() }.getOrDefault("Timestamp unavailable")

/** Foreground waits for any late owned evidence before GET-only recovery. */
class RealmSalesViewModel(private val repository: RealmSalesRepository, val wallet: RealmSalesWallet? = null) : ScreenViewModel() {
    val state = repository.state
    private val mutableHistory = MutableStateFlow<RealmSalesArchive?>(null); val history = mutableHistory.asStateFlow()
    private var lastAction: Job? = null
    private fun action(block: suspend () -> Unit) = run(block).also { if (it != null) lastAction = it }
    suspend fun foreground() { lastAction?.join(); refresh()?.join() }
    fun refresh() = action { repository.awaitIdle(); repository.open() }
    fun begin(selection: RealmSalesSelection) = action { repository.begin(selection.spot, selection.realm) }
    fun review() = action { repository.review() }
    fun sign() = action { repository.sign() }
    fun submit() = action { repository.submit() }
    fun archive() = action { repository.archive() }
    fun archiveFailed() = action { repository.archiveFailed() }
    fun archiveRefusal() = action { repository.archiveRefusal() }
    fun archiveUnanswered() = action { repository.archiveUnanswered() }
    fun history(key: String) = action { mutableHistory.value = requireNotNull(repository.archived(key)) { "The saved history is unavailable." } }
    fun closeHistory() { mutableHistory.value = null }
    fun dismiss() { repository.dismiss(); closeHistory() }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun RealmSalesScreen(model: RealmSalesViewModel, actionsAllowed: Boolean, policy: RealmSalesSavedPolicy?, realmNames: Map<Long, String>, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val notice by model.notice.collectAsState(); val running by model.busy.collectAsState()
    val history by model.history.collectAsState(); val controls = realmSalesControls(state, actionsAllowed, running)
    val op = state.journal?.operation; val review = state.review
    val wallet = model.wallet; val mfa = wallet?.mfa?.collectAsState()?.value
    var spot by rememberSaveable { mutableStateOf("") }; var realm by rememberSaveable { mutableStateOf<Long?>(null) }
    var chooseRealm by remember { mutableStateOf(false) }
    var showHistory by rememberSaveable(state.journal?.identity) { mutableStateOf(false) }
    val noticeLocation = remember { BringIntoViewRequester() }
    val spotError = realmSalesSpotError(spot, policy)
    val selection = realmSalesDisplaySelection(spot, realm?.takeIf { it in realmNames }, policy)
    val back = { model.dismiss(); onBack() }
    DisposableEffect(model) { onDispose { model.dismiss() } }
    LaunchedEffect(actionsAllowed) { if (!actionsAllowed) model.dismiss() }
    LaunchedEffect(notice, state.error) { if (notice?.error == true || state.error != null) noticeLocation.bringIntoView() }
    BackHandlerAt(BackPriority.SCREEN) { back() }
    BackHandlerAt(BackPriority.CONFIRM, review != null) { model.dismiss() }
    BackHandlerAt(BackPriority.CONFIRM, history != null) { model.closeHistory() }
    BackHandlerAt(BackPriority.CONFIRM, mfa != null) { mfa?.let { wallet?.cancelMfa(it) } }
    DesignedPage("REALM PERMITS", back) {
        Text("Explore another realm", color = SurfaceInk.goldHi, style = MaterialTheme.typography.titleLarge)
        Text("Buy a permit from a Seeker spot for access to one realm. Review the original terms before approving in your wallet.", color = SurfaceInk.muted)
        if (state.busy || running) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text("Checking purchases and saved records…", color = SurfaceInk.muted) }
        Column(Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            notice?.let { Text(it.message, color = if (it.error) SurfaceInk.danger else SurfaceInk.text) }
            state.error?.takeIf { it != notice?.message }?.let { Text(it, color = SurfaceInk.danger) }
        }
        op?.let { original ->
            RealmSalesSavedSummary(original, state.journal?.settlementHeld == true, realmNames) {
                if (realmSalesContradicted(original)) Text("Conflicting records are held. Keep this request and check again; no receipt can be archived yet.")
                else {
                    if (original.preparation == null && original.prepareRefusal == null) Text("Your original quote request is saved. Check its outcome before starting another purchase.")
                    if (original.signingStarted && original.signed == null && original.failure == null) Text("Wallet approval may have completed. Keep this request until its signature or receipt can be recovered.")
                    if (state.journal?.settlementHeld == true && original.settlement == null && original.failure == null) Text("Saved evidence needs verification. Keep this original purchase and check its outcome.")
                    if (original.prepareRefusal != null) Text("No purchase was recorded by this refusal. Saving checks the original records again and keeps the request in history.")
                    if (original.submitAttempted && original.settlement == null && !original.failureObserved && original.failure == null) Text("The submission outcome is pending. Checking never sends the transaction again.")
                }
                if (controls.review) Button(onClick = { model.review() }, modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp)) { Text("REVIEW PURCHASE") }
                if (controls.submit) Button(onClick = { model.submit() }, modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp)) { Text("SUBMIT SAVED PURCHASE") }
                if (controls.archiveRefusal) Button(onClick = { model.archiveRefusal() }, modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp)) { Text("CHECK & SAVE REFUSAL") }
                if (controls.closeUnanswered) OutlinedButton(onClick = { model.archiveUnanswered() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CHECK & CLOSE IF NO QUOTE EXISTS") }
                if (controls.archiveFailed) Button(onClick = { model.archiveFailed() }, modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp)) { Text("CHECK & SAVE RECEIPT") }
                if (controls.archive) Button(onClick = { model.archive() }, modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp)) { Text("SAVE RECEIPT TO HISTORY") }
                OutlinedButton(onClick = { model.refresh() }, enabled = controls.check, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CHECK SAVED OUTCOME") }
            }
        }
        if (!actionsAllowed) Text("New purchases are paused. Your saved requests and receipts remain available.", color = SurfaceInk.muted)
        if (op == null) {
            if (!state.loaded) Text("Loading your saved purchases…")
            else if (state.journal?.archiveKeys?.isEmpty() == true) Text("No saved purchases yet. A permit adds access to one realm; departure requirements still apply.", color = SurfaceInk.muted)
        }
        if (op == null && actionsAllowed && state.loaded) PixelPanel(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("CHOOSE YOUR PERMIT", color = SurfaceInk.goldHi, style = MaterialTheme.typography.titleMedium)
                policy?.let { rules ->
                    RealmSalesAmount(RealmSalesReceiptAmount(realmSalesPrice(rules).gross, "Permit price · before network fee and rent"))
                    Text("Added coverage: ${fmtDur(rules.protocol.permitDurationSec)}", style = MaterialTheme.typography.titleMedium)
                } ?: Text("Current permit terms are unavailable. Check again before requesting a quote.", color = SurfaceInk.muted)
                Text("Choose a realm and enter the Seeker spot number. The quote checks the offer and remaining quota; entering a number does not reserve a permit.", color = SurfaceInk.muted)
                Box {
                    OutlinedButton(onClick = { chooseRealm = true }, enabled = controls.begin && realmNames.isNotEmpty(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Text(realm?.let { realmNames[it] } ?: "CHOOSE REALM")
                    }
                    DropdownMenu(expanded = chooseRealm, onDismissRequest = { chooseRealm = false }) {
                        realmNames.filterKeys { it < (policy?.protocol?.realmCount ?: 0) }.forEach { (index, name) ->
                            DropdownMenuItem(text = { Text(name) }, onClick = { realm = index; chooseRealm = false })
                        }
                    }
                }
                if (realmNames.isEmpty()) Text("Realm names are unavailable. Saved purchases remain accessible.")
                OutlinedTextField(value = spot, onValueChange = { spot = it.take(19) }, label = { Text("Seeker spot") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), enabled = controls.begin, modifier = Modifier.fillMaxWidth(),
                    isError = spotError != null, supportingText = { Text(spotError ?: policy?.protocol?.let { "Spot number 1–${it.totalSpots}. Availability is checked in your quote." } ?: "Waiting for current permit terms.") })
                selection?.let { Text("Selected: ${realmNames[it.realm]} · Spot ${it.spot + 1}", color = SurfaceInk.goldHi, style = MaterialTheme.typography.titleSmall) }
                Button(onClick = { selection?.let { model.begin(it) } }, enabled = controls.begin && selection != null,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp)) { Text("REQUEST PURCHASE QUOTE") }
            }
        }
        state.journal?.archiveKeys?.takeIf { it.isNotEmpty() }?.let { keys ->
            DisclosurePlate("PURCHASE HISTORY (${keys.size})", showHistory, { showHistory = !showHistory }) {
                Text("Open a saved record for its original dates and payment. Current expedition access is checked when you select a route.", color = SurfaceInk.muted)
                realmSalesHistoryKeys(requireNotNull(state.journal)).forEachIndexed { index, archiveKey -> key(archiveKey) {
                    OutlinedButton(onClick = { model.history(archiveKey) }, enabled = controls.check,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Text(if (archiveKey == state.journal?.lastArchivedKey) "VIEW LATEST SAVED RECORD" else "VIEW SAVED RECORD ${index + 1}")
                    }
                } }
            }
        }
        if (op == null) OutlinedButton(onClick = { model.refresh() }, enabled = controls.check, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CHECK SAVED PURCHASES") }
    }
    if (review != null && op != null && actionsAllowed && mfa == null) AlertDialog(onDismissRequest = model::dismiss,
        title = { Text("APPROVE ORIGINAL PURCHASE") }, text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val p = review.preparation; val q = p.quote
                val rules = op.policy; val price = realmSalesPrice(rules)
                PaymentPlate("${realmNames[p.realm] ?: "Realm ${p.realm + 1}"} · Spot ${p.spot + 1}",
                    art = "sol",
                    details = listOf(PaymentDetail("Wallet", p.wallet), PaymentDetail("Seller", p.terms.seller),
                        PaymentDetail("Developer", p.terms.developer), PaymentDetail("Request", op.request.idempotencyKey))) {
                RealmSalesAmount(RealmSalesReceiptAmount(q.requiredLamports, "Maximum total you approve"))
                Text("Gross purchase price: ${marketSol(price.gross)} SOL")
                Text("Seller share: ${marketSol(price.seller)} SOL", style = MaterialTheme.typography.bodySmall)
                Text("Developer share: ${marketSol(price.developer)} SOL", style = MaterialTheme.typography.bodySmall)
                Text("Purchase debit: ${marketSol(q.paymentDebitLamports)} SOL")
                Text("Maximum network fee: ${marketSol(q.feeLamports)} SOL")
                Text("Maximum account rent: ${marketSol(q.rentLamports)} SOL")
                Text("Current required total: ${marketSol(review.current.requiredLamports)} SOL")
                Text("Quota available at review: ${review.current.quotaRemaining}")
                Text("Prior coverage in this quote: ${if (p.terms.priorExpiry == "0") "none" else realmSalesUtc(p.terms.priorExpiry)}")
                Text("Planned added coverage: ${fmtDur(rules.protocol.permitDurationSec)}")
                Text("Coverage begins when recorded or when that prior coverage ends, whichever is later. The saved receipt shows the resulting dates; this quote does not reserve access.")
                Text("Consent expires: ${realmSalesUtc(p.terms.validUntil)}")
                Text("Connect the original wallet to approve. Approval saves a signature; submission is a separate action.")
                }
            }
        }, confirmButton = { Button(onClick = { model.sign() }, enabled = controls.sign, modifier = Modifier.heightIn(min = 54.dp)) { Text("OPEN WALLET") } },
        dismissButton = { TextButton(onClick = model::dismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("CANCEL REVIEW") } })
    history?.let { archived -> AlertDialog(onDismissRequest = model::closeHistory, title = { Text("SAVED PURCHASE HISTORY") }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            RealmSalesSavedSummary(archived.operation, false, realmNames)
        }
    }, confirmButton = { TextButton(onClick = model::closeHistory, modifier = Modifier.heightIn(min = 48.dp)) { Text("CLOSE HISTORY") } }) }
    if (mfa != null) SensitiveMfaDialog(mfa, submit = { wallet.submitMfa(mfa, it) }, cancelRequest = { wallet.cancelMfa(mfa) })
}

@Composable private fun RealmSalesSavedSummary(op: RealmSalesOperation, held: Boolean, realmNames: Map<Long, String>,
    actions: @Composable ColumnScope.() -> Unit = {}) {
    val consistent = !realmSalesContradicted(op)
    val failed = op.failure?.takeIf { consistent && !op.settlementObserved && op.settlement == null }?.value?.receipt
    val amount = realmSalesReceiptAmount(op)
    val details = listOf(PaymentDetail("Request", op.request.idempotencyKey)) + listOfNotNull(
        op.preparation?.let { PaymentDetail("Wallet", it.wallet) },
        op.preparation?.let { PaymentDetail("Purchase", it.saleId) },
        op.signed?.signature?.let { PaymentDetail("Signature", it) },
        op.preparation?.quote?.let { PaymentDetail("Original maximum total", "${marketSol(it.requiredLamports)} SOL") })
    PaymentPlate("${realmNames[op.request.realm] ?: "Realm ${op.request.realm + 1}"} · Spot ${op.request.spot + 1}",
        art = "sol", details = details) {
        Text(realmSalesPhase(op, held), color = if (consistent) SurfaceInk.goldHi else SurfaceInk.danger, style = MaterialTheme.typography.titleMedium)
        amount?.let { RealmSalesAmount(it) }
        op.prepareRefusal?.let { Text("Preparation refusal: ${it.code}") }
        if (failed != null) {
            Text("This transaction failed. No permit or new expedition access was granted; quota was unchanged.")
            Text("Purchase payment and account rent: 0 SOL. The network fee above remains spent.")
        }
        op.settlement?.takeIf { consistent && !op.failureObserved && op.failure == null }?.value?.purchase?.let { purchase ->
            Text("Purchase price: ${marketSol(purchase.priceLamports)} SOL")
            Text("Coverage starts: ${realmSalesUtc(purchase.coverageStart)}")
            Text("Coverage expires: ${realmSalesUtc(purchase.expiresAt)}")
            Text("Current expedition access is checked separately when you select a route.")
        }
        op.settlement?.takeIf { consistent && !op.failureObserved && op.failure == null }?.value?.receipt?.let { receipt ->
            Text("Wallet payment debit: ${marketSol(receipt.buyerNetPaymentLamports)} SOL")
            Text("Network fee: ${marketSol(receipt.feeLamports)} SOL")
            Text("Account rent: ${marketSol(receipt.actualRentLamports)} SOL")
        }
        actions()
    }
}

/** Currency stays readable in narrow dialogs and at large font scales; no single-line amount can hide digits. */
@Composable private fun RealmSalesAmount(amount: RealmSalesReceiptAmount) {
    PixelPlate("keep", Modifier.fillMaxWidth(), PaddingValues(10.dp)) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                GameArt("sol", Modifier.size(20.dp))
                Text(amount.label, Modifier.weight(1f), color = SurfaceInk.muted, style = MaterialTheme.typography.labelMedium)
            }
            Text("${marketSol(amount.lamports)} SOL", Modifier.fillMaxWidth(), color = SurfaceInk.gold,
                style = MaterialTheme.typography.headlineSmall)
        }
    }
}
