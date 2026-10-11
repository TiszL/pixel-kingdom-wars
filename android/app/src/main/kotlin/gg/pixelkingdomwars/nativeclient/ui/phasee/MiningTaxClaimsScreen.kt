package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.ui.chrome.SurfaceInk
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.mining.MiningTaxClaimsCaps
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.Palette
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentPlate
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentDetail
import gg.pixelkingdomwars.nativeclient.ui.economy.DisclosurePlate
import gg.pixelkingdomwars.nativeclient.ui.ScreenViewModel
import gg.pixelkingdomwars.nativeclient.ui.chrome.AlertDialog
import gg.pixelkingdomwars.nativeclient.ui.chrome.Button
import gg.pixelkingdomwars.nativeclient.ui.chrome.DesignedPage
import gg.pixelkingdomwars.nativeclient.ui.chrome.OutlinedButton
import gg.pixelkingdomwars.nativeclient.ui.chrome.TextButton
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.security.SensitiveMfaDialog
import java.math.BigDecimal
import java.math.BigInteger
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

data class MiningTaxClaimsSelection(val round: String, val spot: Long, val caps: MiningTaxClaimsCaps)
/** SOL has nine decimal places. No quoted measurement becomes a hidden consent cap. */
fun miningTaxClaimsSelection(round: String, displaySpot: String, feeSol: String, rentSol: String, totalSol: String,
    policy: MiningTaxClaimsAppPolicy?): MiningTaxClaimsSelection? = runCatching {
    val admitted = requireNotNull(policy); admitted.signing()
    val max = BigInteger.ONE.shiftLeft(64) - BigInteger.ONE
    require(round.length <= 20 && round.matches(Regex("0|[1-9][0-9]{0,19}")) && round.toBigInteger() <= max)
    require(displaySpot.length in 1..19 && displaySpot.matches(Regex("[1-9][0-9]*")))
    val spot = displaySpot.toLong(); require(spot in 1..admitted.totalSpots.toLong())
    fun lamports(text: String): String {
        require(text.length in 1..30 && text.matches(Regex("(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,9})?")))
        val value = BigDecimal(text).movePointRight(9).toBigIntegerExact(); require(value <= max); return value.toString()
    }
    MiningTaxClaimsSelection(round, spot - 1, MiningTaxClaimsCaps(lamports(feeSol), lamports(rentSol), lamports(totalSol)))
}.getOrNull()
fun miningTaxClaimsEntryAvailable(state: MiningTaxClaimsState?, configured: Boolean, storageUnavailable: Boolean = false): Boolean =
    configured || storageUnavailable || state?.let { it.journal?.operation != null || it.journal?.archiveKeys?.isNotEmpty() == true || !it.loaded && it.error != null } == true
data class MiningTaxClaimsControls(val ordinal: Int?, val begin: Boolean, val review: Boolean, val sign: Boolean,
    val submit: Boolean, val check: Boolean, val archive: Boolean, val archiveFailed: Boolean,
    val prepareContinuation: Boolean, val resumeContinuation: Boolean, val activateContinuation: Boolean,
    /** Dead-end audit 2026-10-06: CLOSE a request with no recovered preparation (the repository re-reads by key first). */
    val archiveAbsent: Boolean = false)
/** Presentation hints only. The repository's final store guard checks every current
 * key/ordinal hold again immediately before a wallet or HTTP effect. */
fun miningTaxClaimsControls(state: MiningTaxClaimsState, actionsAllowed: Boolean, running: Boolean = false): MiningTaxClaimsControls {
    val available = !running && !state.busy; val journal = state.journal; val op = journal?.operation; val p = op?.preparation
    val ordinal = if (p == null || op.settlement != null || op.failureObserved || op.failure != null || op.continuation != null || op.continuationObserved) null else if (p.transactions.size == 2 && op.setup != null) 1 else 0
    val setupProgress = ordinal == 1 && op?.setup?.status == "setup" && op.observed.all { it == 0 } && !op.unattributedObserved
    val fresh = available && actionsAllowed && op?.continuation == null && op?.continuationObserved != true && op?.settlement == null && op?.failure == null && op?.failureObserved != true && op?.unattributedObserved != true && (journal?.settlementHeld != true || setupProgress)
    val custody = op?.transactions?.find { it.ordinal == ordinal }; val unsigned = fresh && ordinal != null && custody == null
    val reviewed = state.review?.let { it.preparation == p && it.current.status == "ready" && it.current.ordinal == ordinal?.toLong() && it.current.review != null } == true
    val continuationEligible = available && op != null && p?.transactions?.size == 2 && op.setup?.status == "setup" &&
        op.settlement == null && op.failure == null && !op.failureObserved && !op.unattributedObserved &&
        op.observed.all { it == 0 } && op.transactions.none { it.ordinal == 1 }
    return MiningTaxClaimsControls(ordinal, available && actionsAllowed && state.loaded && journal != null && op == null && !journal.settlementHeld,
        unsigned, unsigned && reviewed, fresh && ordinal != null && custody?.signed != null && !custody.submitAttempted,
        available, available && op?.settlement?.status == "settled" && !op.failureObserved && op.failure == null && op.continuation == null && !op.continuationObserved,
        available && op?.let(::taxFailedHistoryComplete) == true,
        continuationEligible && actionsAllowed && op?.continuation == null && op?.continuationObserved != true,
        continuationEligible && actionsAllowed && op?.continuation != null && op.continuation.envelope == null && !op.continuationObserved,
        continuationEligible && op?.continuation?.attempted == true && op.continuation.envelope != null,
        available && op != null && p == null && op.transactions.isEmpty() && op.observed.isEmpty() && !op.unattributedObserved && !op.failureObserved &&
            op.failure == null && op.continuation == null && !op.continuationObserved && journal?.settlementHeld != true)
}
/** Presentation of already-bound journal evidence only. Fresh authenticated GET,
 * current hold checks and atomic archival remain the repository/store boundary. */
private fun taxFailedHistoryComplete(op: MiningTaxClaimsOperation): Boolean {
    val p = op.preparation ?: return false; val failure = op.failure ?: return false
    if (op.continuation != null || op.continuationObserved || op.settlement != null || op.unattributedObserved || failure.failures.isEmpty() || op.observed.any { it !in p.transactions.indices }) return false
    val failed = failure.failures.map { it.ordinal.toInt() }.toSet()
    val setup = op.setup?.settlement?.receipt?.transactions?.indices?.toSet() ?: emptySet()
    return failed.intersect(setup).isEmpty() && p.transactions.indices.all { it in failed || it in setup }
}
fun miningTaxClaimsPhase(op: MiningTaxClaimsOperation, held: Boolean): String = when {
    op.failure != null && taxFailedHistoryComplete(op) -> "FAILED TAX CLAIM · HISTORY VERIFIED"
    op.failure != null -> "FAILED TRANSACTION · PLAN STILL HELD"
    op.failureObserved -> "FAILURE OBSERVED · CHECK SAVED HISTORY"
    op.settlement != null -> "PAYMENT RECEIPT VERIFIED"
    op.unattributedObserved || op.observed.any { it == 1 } -> "SAVED OUTCOME NEEDS VERIFICATION"
    op.continuation?.envelope != null -> "LINKED PREPARATION VERIFIED"
    op.continuation != null -> "CONTINUATION PREPARATION PENDING"
    op.continuationObserved -> "CONTINUATION OBSERVED · CHECK SAVED HISTORY"
    op.setup != null && op.transactions.none { it.ordinal == 1 } -> "SETUP VERIFIED · KEEP PAYMENT PENDING"
    held && op.setup == null -> "SAVED OUTCOME NEEDS VERIFICATION"
    op.transactions.lastOrNull()?.submitAttempted == true -> "SUBMISSION OUTCOME PENDING"
    op.transactions.lastOrNull()?.signed != null -> "WALLET APPROVED · NOT SUBMITTED"
    op.transactions.lastOrNull()?.signingStarted == true -> "WALLET OUTCOME UNKNOWN"
    op.absenceConfirmed -> "CLOSED · NO SERVER RECORD"
    op.preparation == null -> "PREPARATION OUTCOME UNKNOWN"
    else -> "CLAIM PREPARED · REVIEW REQUIRED"
}
class MiningTaxClaimsViewLifetime {
    private var active = true; private var visible = false; private var open = false; private var epoch = 0L
    @Synchronized fun start() { if (active && !visible) { visible = true; advance() } }
    @Synchronized fun setOpen(value: Boolean) { if (active && open != value) { open = value; advance() } }
    @Synchronized fun stop() { visible = false; advance() }
    @Synchronized fun invalidate() { advance() }
    @Synchronized fun dispose() { active = false; visible = false; open = false; advance() }
    private fun advance() { epoch = Math.addExact(epoch, 1L) }
    @Synchronized fun snapshot(actionsAllowed: Boolean, contentReady: Boolean, contentIdentity: String?, battleActive: Boolean) =
        MiningTaxClaimsLifecycle(active, visible, epoch, open && actionsAllowed, contentReady, contentIdentity, battleActive)
}
fun miningTaxClaimsActionsAllowed(configured: Boolean, page: MiningTaxClaimsLifecycle) = configured && page.active && page.visible &&
    page.actionsAllowed && page.contentReady && !page.contentIdentity.isNullOrBlank() && !page.battleActive

class MiningTaxClaimsViewModel(private val repository: MiningTaxClaimsRepository, val wallet: MiningTaxClaimsWallet? = null) : ScreenViewModel() {
    val state = repository.state
    private val mutableHistory = MutableStateFlow<MiningTaxClaimsArchive?>(null); val history = mutableHistory.asStateFlow()
    private var lastAction: Job? = null
    private fun action(block: suspend () -> Unit) = run(block).also { if (it != null) lastAction = it }
    suspend fun foreground() { lastAction?.join(); refresh()?.join() }
    fun refresh() = action { repository.awaitIdle(); repository.open() }
    fun begin(selection: MiningTaxClaimsSelection) = action { repository.begin(selection.round, selection.spot, selection.caps) }
    fun review(ordinal: Int) = action { repository.review(ordinal) }
    fun sign(ordinal: Int) = action { repository.sign(ordinal) }
    fun submit(ordinal: Int) = action { repository.submit(ordinal) }
    fun archive() = action { repository.archive() }
    fun archiveFailed() = action { repository.archiveFailed() }
    fun archiveAbsent() = action { repository.archiveAbsent() }
    fun prepareContinuation(caps: MiningTaxClaimsCaps) = action { repository.prepareContinuation(caps) }
    fun resumeContinuation() = action { repository.resumeContinuation() }
    fun activateContinuation() = action { repository.activateContinuation() }
    fun history(key: String) = action { mutableHistory.value = requireNotNull(repository.archived(key)) { "Saved tax history is unavailable" } }
    fun closeHistory() { mutableHistory.value = null }
    fun dismiss() { repository.dismiss(); closeHistory() }
    suspend fun close() { repository.close(); closeHistory() }
}
private fun taxKeep(value: String, decimals: Int?) = miningClaimsKeepAmount(value, decimals)?.let { "$it KEEP" } ?: "$value KEEP base units"

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable fun MiningTaxClaimsScreen(model: MiningTaxClaimsViewModel, actionsAllowed: Boolean,
    policy: MiningTaxClaimsAppPolicy?, onBack: () -> Unit) {
    val state by model.state.collectAsState(); val running by model.busy.collectAsState(); val notice by model.notice.collectAsState()
    val history by model.history.collectAsState(); val controls = miningTaxClaimsControls(state, actionsAllowed, running)
    val op = state.journal?.operation; val review = state.review; val ordinal = controls.ordinal
    val wallet = model.wallet; val mfa = wallet?.mfa?.collectAsState()?.value
    var round by rememberSaveable { mutableStateOf("") }; var spot by rememberSaveable { mutableStateOf("") }
    var fee by rememberSaveable { mutableStateOf("") }; var rent by rememberSaveable { mutableStateOf("") }; var total by rememberSaveable { mutableStateOf("") }
    val selection = miningTaxClaimsSelection(round, spot, fee, rent, total, policy)
    var extraFee by rememberSaveable(op?.request?.idempotencyKey) { mutableStateOf("") }
    var extraRent by rememberSaveable(op?.request?.idempotencyKey) { mutableStateOf("") }
    var extraTotal by rememberSaveable(op?.request?.idempotencyKey) { mutableStateOf("") }
    val additional = op?.let { miningTaxClaimsSelection(it.request.round, (it.request.spot + 1).toString(), extraFee, extraRent, extraTotal, policy) }
    var showHistory by rememberSaveable(state.journal?.identity) { mutableStateOf(false) }
    var showLinked by rememberSaveable(op?.request?.idempotencyKey) { mutableStateOf(false) }
    val noticeLocation = remember { BringIntoViewRequester() }
    LaunchedEffect(notice, state.error) { if (notice?.error == true || state.error != null) noticeLocation.bringIntoView() }
    val back = { model.dismiss(); onBack() }
    DisposableEffect(model) { onDispose { model.dismiss() } }
    LaunchedEffect(model) { model.foreground() }
    LaunchedEffect(actionsAllowed) { if (!actionsAllowed) model.dismiss() }
    BackHandlerAt(BackPriority.SCREEN) { back() }
    BackHandlerAt(BackPriority.CONFIRM, review != null) { model.dismiss() }
    BackHandlerAt(BackPriority.CONFIRM, history != null) { model.closeHistory() }
    BackHandlerAt(BackPriority.CONFIRM, mfa != null) { mfa?.let { wallet?.cancelMfa(it) } }
    DesignedPage("ISLAND KEEP SHARES", back) {
        Text("Collect earned island KEEP", style = MaterialTheme.typography.titleLarge, color = SurfaceInk.goldHi)
        Text("Use your original winning round and spot. Your KEEP goes to the original wallet after the claim is finalized.", color = SurfaceInk.muted)
        Text("Prepare → Review → Approve → Submit → Receipt", style = MaterialTheme.typography.labelMedium, color = SurfaceInk.goldHi)
        if (running || state.busy) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text("Checking the saved claim…", color = SurfaceInk.muted) }
        Column(Modifier.bringIntoViewRequester(noticeLocation).semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            notice?.let { Text(it.message, color = if (it.error) SurfaceInk.danger else SurfaceInk.text) }
            state.error?.takeIf { it != notice?.message }?.let { Text(it, color = SurfaceInk.danger) }
        }
        if (!actionsAllowed) Text("New claims are unavailable. Saved requests and receipts can still be checked.", color = SurfaceInk.muted)
        if (op == null && actionsAllowed) PaymentPlate("Choose your winning spot", art = "keep") {
            Text("Enter the operating round and spot shown in your island result. Preparation checks eligibility; it does not approve or submit a transaction.", color = SurfaceInk.muted)
            TaxField(round, { round = it.take(20) }, "Operating round", controls.begin)
            TaxField(spot, { spot = it.take(19) }, "Seeker spot${policy?.let { " (1–${it.totalSpots})" } ?: ""}", controls.begin)
            Text("Your SOL spending limits", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
            Text("Set separate fee and account-rent limits, then the maximum total. These limits stay with this claim; they are not a price quote.", color = SurfaceInk.muted)
            TaxField(fee, { fee = it.take(30) }, "Maximum network fee (SOL)", controls.begin)
            TaxField(rent, { rent = it.take(30) }, "Maximum account rent (SOL)", controls.begin)
            TaxField(total, { total = it.take(30) }, "Maximum total SOL", controls.begin)
            Button(onClick = { selection?.let { model.begin(it) } }, enabled = controls.begin && selection != null,
                modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp)) { Text("PREPARE KEEP CLAIM") }
        }
        op?.let { saved ->
            TaxSummary(saved, state.journal?.settlementHeld == true, policy?.tokenDecimals) {
            if (saved.preparation == null) Text("Keep this request while its preparation is recovered. Checking never prepares another claim.")
            if (saved.setup != null && saved.settlement == null && !saved.failureObserved && saved.failure == null && saved.continuation == null && !saved.continuationObserved) Text("Setup alone pays no KEEP. Review and approve the claim transaction separately.")
            if (saved.failureObserved || saved.failure != null) Text(if (controls.archiveFailed)
                "All original transactions have a saved outcome. Saving history checks them again and preserves fees, setup rent and signatures."
                else "Keep this request while its full history is checked. A failed transaction does not refund fees or prove the other transaction finished.")
            if (saved.transactions.any { it.signingStarted && it.signed == null }) Text("Wallet approval may have completed. Check the original request before taking another action.")
            if (saved.transactions.any { it.submitAttempted } && saved.settlement == null) Text("Checking the saved outcome never sends a transaction again.")
            if (controls.review && ordinal != null) OutlinedButton(onClick = { model.review(ordinal) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text(if (saved.preparation?.transactions?.get(ordinal)?.kind == "setup") "REVIEW SETUP & SOL LIMITS" else "REVIEW CLAIM & SOL LIMITS")
            }
            if (ordinal != null && saved.transactions.any { it.ordinal == ordinal && it.signed != null && !it.submitAttempted }) Button(onClick = { model.submit(ordinal) },
                enabled = controls.submit, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (saved.preparation?.transactions?.get(ordinal)?.kind == "setup") "SUBMIT SAVED SETUP" else "SUBMIT SAVED CLAIM") }
            if (controls.prepareContinuation) DisclosurePlate("EXPIRED CLAIM OPTIONS", showLinked, { showLinked = !showLinked }) {
                Text("If the original claim has expired on chain, prepare a linked claim with new SOL limits. Your setup spend remains in history. Preparation does not approve or submit a payment.")
                TaxField(extraFee, { extraFee = it.take(30) }, "Additional maximum network fee (SOL)", true)
                TaxField(extraRent, { extraRent = it.take(30) }, "Additional maximum account rent (SOL)", true)
                TaxField(extraTotal, { extraTotal = it.take(30) }, "Additional maximum total SOL", true)
                OutlinedButton(onClick = { additional?.let { model.prepareContinuation(it.caps) } }, enabled = additional != null,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("PREPARE LINKED CLAIM") }
            }
            if (controls.resumeContinuation) {
                Text("Checking is read only. Resuming repeats preparation with the same saved request and SOL limits; it never opens the wallet or submits a transaction.")
                OutlinedButton(onClick = { model.resumeContinuation() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("RESUME SAVED PREPARATION") }
            }
            if (controls.activateContinuation) {
                Text("Use the linked preparation to retire the unsigned original claim and preserve its setup history. The new claim needs a separate current review and wallet approval.")
                OutlinedButton(onClick = { model.activateContinuation() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("USE LINKED PREPARATION") }
            }
            if (controls.archiveFailed) OutlinedButton(onClick = { model.archiveFailed() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("SAVE FAILED CLAIM IN HISTORY") }
            if (controls.archive) OutlinedButton(onClick = { model.archive() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("SAVE PAYMENT RECEIPT") }
            if (controls.archiveAbsent) {
                Text("If the server has no record of this request, CLOSE checks once more and moves it to history so you can prepare a new claim.", color = SurfaceInk.muted)
                OutlinedButton(onClick = { model.archiveAbsent() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CLOSE · NO SERVER RECORD") }
            }
            }
        }
        OutlinedButton(onClick = { model.refresh() }, enabled = controls.check, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("CHECK SAVED REQUEST & RECEIPT") }
        state.journal?.let { journal ->
            DisclosurePlate("CLAIM HISTORY (${journal.archiveKeys.size})", showHistory, { showHistory = !showHistory }) {
                if (journal.archiveKeys.isEmpty()) Text("Saved payments and verified failed claims will appear here.", color = SurfaceInk.muted)
                journal.archiveKeys.forEachIndexed { index, key -> OutlinedButton(onClick = { model.history(key) }, enabled = controls.check,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(if (key == journal.lastArchivedKey) "LAST SAVED CLAIM" else "VIEW SAVED CLAIM ${index + 1}") } }
            }
        }
    }
    if (review != null && op != null && !op.failureObserved && op.failure == null && op.continuation == null && !op.continuationObserved && actionsAllowed && mfa == null) {
        val selected = requireNotNull(review.current.review); val p = review.preparation; val index = review.current.ordinal.toInt(); val setup = p.transactions[index].kind == "setup"
        AlertDialog(onDismissRequest = model::dismiss, title = { Text(if (setup) "APPROVE SETUP" else "APPROVE KEEP TAX CLAIM") }, text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PaymentPlate("Round ${p.round} · Spot ${p.spot + 1}", art = if (setup) "sol" else "keep", details = listOf(
                    PaymentDetail("Original wallet", p.wallet), PaymentDetail("Request", p.idempotencyKey), PaymentDetail("Consent expires (UTC)", p.expiresAt))) {
                    Text(if (setup) "Account setup only" else "${taxKeep(p.intended.claimBaseUnits, policy?.tokenDecimals)} expected", Modifier.fillMaxWidth(), style = MaterialTheme.typography.headlineSmall, color = SurfaceInk.goldHi)
                    if (setup) Text("This transaction only creates the required accounts. KEEP payment needs another explicit review and approval.", color = SurfaceInk.muted)
                    else Text("The final receipt confirms how much KEEP was paid.", color = SurfaceInk.muted)
                    Text("Current transaction", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
                    Text("Network fee: ${marketSol(selected.feeLamports)} SOL")
                    Text("Account rent: ${marketSol(selected.rentLamports)} SOL")
                    Text("Already paid setup fee: ${marketSol(selected.paidFeeLamports)} SOL · rent: ${marketSol(selected.paidRentLamports)} SOL", color = SurfaceInk.muted)
                    Text("Original full plan", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
                    Text("Estimated total: ${marketSol(p.fees.totalLamports)} SOL")
                    Text("Maximum network fee: ${marketSol(p.caps.maxFeeLamports)} SOL")
                    Text("Maximum account rent: ${marketSol(p.caps.maxRentLamports)} SOL")
                    Text("Maximum total: ${marketSol(p.caps.maxTotalLamports)} SOL")
                    Text("Consent expires: ${islandShareTime(p.expiresAt)}", color = SurfaceInk.muted)
                    Text("Approval saves the original signature. Submitting it is a separate action.", color = SurfaceInk.muted)
                }
            }
        }, confirmButton = { Button(onClick = { model.sign(index) }, enabled = controls.sign, modifier = Modifier.heightIn(min = 54.dp)) { Text("OPEN WALLET TO APPROVE") } },
            dismissButton = { TextButton(onClick = model::dismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("CANCEL REVIEW") } })
    }
    history?.let { archived -> AlertDialog(onDismissRequest = model::closeHistory, title = { Text("SAVED TAX HISTORY") }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) { TaxSummary(archived.operation, false, policy?.tokenDecimals) }
    }, confirmButton = { TextButton(onClick = model::closeHistory, modifier = Modifier.heightIn(min = 48.dp)) { Text("CLOSE HISTORY") } }) }
    if (mfa != null) SensitiveMfaDialog(mfa, submit = { wallet.submitMfa(mfa, it) }, cancelRequest = { wallet.cancelMfa(mfa) })
}
@Composable private fun TaxField(value: String, change: (String) -> Unit, label: String, enabled: Boolean) = OutlinedTextField(value,
    onValueChange = change, label = { Text(label) }, singleLine = true, enabled = enabled,
    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
@Composable private fun TaxSummary(op: MiningTaxClaimsOperation, held: Boolean, decimals: Int?, actions: @Composable ColumnScope.() -> Unit = {}) {
    PaymentPlate("Round ${op.request.round} · Spot ${op.request.spot + 1}", art = "keep", details = islandKeepDetails(op)) {
        Text(miningTaxClaimsPhase(op, held), style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
        islandKeepPaid(op, decimals)?.let { Text("$it paid", Modifier.fillMaxWidth(), style = MaterialTheme.typography.headlineSmall, color = SurfaceInk.goldHi) }
        Text("Original spending limits", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
        Text("Maximum fee: ${marketSol(op.request.caps.maxFeeLamports)} SOL")
        Text("Maximum rent: ${marketSol(op.request.caps.maxRentLamports)} SOL")
        Text("Maximum total: ${marketSol(op.request.caps.maxTotalLamports)} SOL")
        op.setup?.settlement?.receipt?.let { Text("Setup fee paid: ${marketSol(it.feeLamports)} SOL · rent: ${marketSol(it.rentLamports)} SOL", color = SurfaceInk.muted) }
        op.continuation?.let {
            Text("Linked claim · additional limits", style = MaterialTheme.typography.titleMedium, color = SurfaceInk.goldHi)
            Text("Maximum fee: ${marketSol(it.request.caps.maxFeeLamports)} SOL")
            Text("Maximum rent: ${marketSol(it.request.caps.maxRentLamports)} SOL")
            Text("Maximum total: ${marketSol(it.request.caps.maxTotalLamports)} SOL")
            Text("Original setup is saved separately. A linked preparation is not a KEEP payment receipt.", color = SurfaceInk.muted)
        }
        op.failure?.failures?.forEach { failed ->
            val receipt = failed.receipt
            Text("Transaction ${failed.ordinal + 1} failed · network fee charged: ${marketSol(receipt.feeLamports)} SOL", color = SurfaceInk.danger)
            Text("KEEP paid by this transaction: ${taxKeep(receipt.paidKeepBaseUnits, decimals)} · rent charged: ${marketSol(receipt.rentLamports)} SOL")
        }
        op.settlement?.settlement?.receipt?.let {
            Text("Actual total fee: ${marketSol(it.feeLamports)} SOL · rent: ${marketSol(it.rentLamports)} SOL", color = SurfaceInk.muted)
        }
        actions()
    }
}
