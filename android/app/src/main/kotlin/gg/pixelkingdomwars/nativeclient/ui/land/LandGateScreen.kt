package gg.pixelkingdomwars.nativeclient.ui.land

import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.data.LandPhase
import gg.pixelkingdomwars.nativeclient.data.LandSigner
import gg.pixelkingdomwars.nativeclient.ops.IntentKind
import gg.pixelkingdomwars.nativeclient.ui.Copy
import gg.pixelkingdomwars.nativeclient.ui.chrome.TitleBackdrop
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kit.*
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.nav.BackHandlerAt
import gg.pixelkingdomwars.nativeclient.ui.nav.BackPriority
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.*
import gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster
import java.math.BigDecimal
import java.math.BigInteger
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay

/** Web `state/land.ts` LAND_UNLOCKS: what one on-chain payment buys, each line a server gate. */
val LAND_UNLOCKS: List<Pair<String, String>> = listOf(
    "YOUR PARCEL" to "One deed, one parcel: your own frozen land tile in the Shattered Realms, plus a Land Deed NFT in your wallet.",
    "GOLD FORGE" to "Build the Forge and turn mined Shards into KEEP you can withdraw.",
    "TRADE ON THE MARKET" to "Buy and sell items for SOL — and list your Land Deed itself. Browsing the book is free; both sides of a trade need land.",
    "RAID LANDOWNERS" to "Pick deeded bases on the globe, scout them first, and take their surplus.",
    "PVE BOUNTIES" to "Ruined-keep raids that pay a KEEP bounty three times a day.",
    "CLANS" to "Join a clan and share its chest.",
)
const val LAND_FREE_TIER = "Free already: build, mine Shards, train your army, level heroes, quests and the campaign."
const val LAND_NO_MAP_NOTE = "Until you own land you have no deeded parcel or marker on the globe: nobody can find, scout or raid you — and you cannot raid landowners either. Landless keeps are matched against each other."
const val LAND_SHARDS_NOTE = "Shards stay in the game. Only KEEP can be withdrawn."
const val FROZEN_PRICE_NOTE = "THIS EXACT TILE AND PRICE ARE FROZEN BEFORE WALLET APPROVAL."

/** Lamports as SOL text with exact decimal arithmetic (never a float). */
fun solText(lamports: String?, scale: Int = 2): String = lamports?.toBigIntegerOrNull()?.let { solText(it, scale) } ?: "—"
fun solText(lamports: BigInteger, scale: Int = 2): String = BigDecimal(lamports).movePointLeft(9).setScale(scale, java.math.RoundingMode.DOWN).toPlainString()
private fun clock(seconds: Long) = "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"

/** A once-per-second monotonic clock (`SystemClock.elapsedRealtime`) for server-anchored countdowns. */
@Composable fun monotonicClock(): Long {
    val owner = LocalLifecycleOwner.current
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(owner) { owner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { while (true) { now = SystemClock.elapsedRealtime(); delay(1_000) } } }
    return now
}

/** The designed Land group, using the existing account-scoped checkout and wallet signer unchanged. */
@Composable fun LandGateScreen(model: LandViewModel, reason: String, kind: String, signer: LandSigner?, local: Boolean, onBack: () -> Unit, onSignedOut: () -> Unit, onExit: () -> Unit,
    onFaucet: (() -> Unit)? = null, onClaimDeed: (() -> Unit)? = null, refused: String? = null,
    onBases: (() -> Unit)? = null, onResearchPayment: (() -> Unit)? = null, researchRecoveryError: String? = null,
    onTrainingPayment: (() -> Unit)? = null, onBuilderPayment: (() -> Unit)? = null,
    onChooseOnMap: (() -> Unit)? = null, onSeeMap: (() -> Unit)? = null) {
    val state by model.state.collectAsState()
    val busy by model.busy.collectAsState()
    val notice by model.notice.collectAsState()
    val now = monotonicClock()
    val checkout = state.checkout
    var pickerVisible by rememberSaveable(model, kind) { mutableStateOf(false) }
    var confirmSignOut by remember(model) { mutableStateOf(false) }
    var review by remember(model, kind) { mutableStateOf<LandReview?>(null) }
    // Keep Back ownership even if the owner or purchase kind changes during Seal exit.
    var sealVisible by remember { mutableStateOf(false) }
    var armedAt by remember(model, kind) { mutableLongStateOf(0L) }
    var feedback by remember(model, kind) { mutableStateOf<String?>(null) }
    var awaitingQuote by remember(model, kind) { mutableStateOf(false) }
    val latestSigner by rememberUpdatedState(signer)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    fun explain(message: String) { feedback = message; Toasts.post(message) }
    fun action(command: () -> Job?) {
        if (model.state.value.checkout.purchaseKind != kind) explain("Restoring this land purchase. Please wait.")
        else if (model.busy.value || model.state.value.checkout.busy) explain("A land request is finishing. Please wait.")
        else if (command() == null) explain("A land request is finishing. Please wait.")
    }
    fun leave() { if (model.state.value.hasBase) onBack() else onExit() }
    fun reviewLand() {
        val current = model.state.value
        val hold = landPayUnavailable(current, model.busy.value, latestSigner != null, SystemClock.elapsedRealtime())
        if (hold != null) explain(hold) else {
            review = captureLandReview(current)
            sealVisible = true
            armedAt = System.currentTimeMillis()
        }
    }
    fun reserveDraft() {
        val current = model.state.value
        val hold = landDraftUnavailable(current, model.busy.value)
        // land-realm.png: realm card → SETTLE → Seal. With no hand-picked tile, SETTLE inspects and reserves the realm's
        // first free candidate through the same owner calls (landSettleTile / settleTile); the Seal follows the quote.
        val settle = landSettleTile(current, model.busy.value)
        when {
            hold == null -> action { model.reserveDrafted().also { awaitingQuote = it != null } }
            settle != null -> action { model.settleTile(settle).also { awaitingQuote = it != null } }
            else -> explain(hold)
        }
    }
    fun retryPayment() {
        val current = model.state.value
        val canRetry = current.bounds?.let { current.checkout.canRetryEntry(SystemClock.elapsedRealtime(), it) } == true
        when {
            !canRetry -> explain("The saved first-land payment cannot be retried yet. It is still being checked.")
            latestSigner == null -> explain("A wallet app is needed to approve this payment.")
            else -> action { latestSigner?.let(model::retryPayment) }
        }
    }
    fun enter(after: () -> Unit) {
        if (!model.state.value.paymentCredited) explain("Wait for the server to confirm this land payment.")
        else action { model.enterGame(after) }
    }
    fun requestSignOut() {
        val current = model.state.value.checkout
        if (model.busy.value || current.busy || current.phase == LandPhase.CONFIRMING)
            explain("Your land payment stays saved. Close this card to leave while checking finishes.")
        else confirmSignOut = true
    }
    fun back() {
        when {
            sealVisible -> review = null
            confirmSignOut -> confirmSignOut = false
            (pickerVisible || model.state.value.picker.realmId != null || model.state.value.checkout.draftedTile != null) && model.state.value.reservation == null -> {
                if (model.busy.value || model.state.value.checkout.busy) leave()
                else { model.clearRealm(); pickerVisible = false }
            }
            else -> leave()
        }
    }
    BackHandlerAt(BackPriority.CONFIRM, enabled = sealVisible || confirmSignOut) { back() }
    BackHandlerAt(BackPriority.SCREEN, enabled = !sealVisible && !confirmSignOut) { back() }
    LaunchedEffect(model, kind, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { model.open(kind) }
    }
    LaunchedEffect(model, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) { if (!model.state.value.paymentCredited) model.pollFunding(); delay(FUNDING_POLL_MS) }
        }
    }
    // Credited land remains visible until GO HOME / SEE MAP; deed minting is a separate server fact.
    LaunchedEffect(model, state.paymentCredited, state.deedReady, state.reservation?.id, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (model.state.value.paymentCredited && !model.state.value.deedReady && model.state.value.reservation != null) {
                delay(DEED_REFRESH_MS)
                model.refreshDirectory()
            }
        }
    }
    LaunchedEffect(checkout.phase, checkout.reservation, checkout.purchaseKind, checkout.cluster, state.wallet, busy) {
        review?.let { if (!landReviewCurrent(it, model.state.value)) {
            review = null
            explain("The land reservation changed. Review the current tile and price again.")
        } }
        if (awaitingQuote && !busy && checkout.phase == LandPhase.READY) {
            awaitingQuote = false
            reviewLand()
        }
        if (!busy && checkout.phase !in setOf(LandPhase.READY, LandPhase.RESERVING)) awaitingQuote = false
    }
    val common: @Composable ColumnScope.() -> Unit = {
        if (reason == "refused") LandMessage(landGateMessage(reason, state.additionalDeed, refused))
        listOfNotNull(feedback, notice?.message, checkout.unavailable, checkout.error, checkout.notice,
            state.world.unavailable, state.world.error).distinct().forEach { LandMessage(it) }
        if (busy || checkout.busy || state.picker.loading) LandMessage("A land request is finishing. Please wait.")
        LandInterrupted(state, busy || checkout.busy, model)
        if (state.world.error != null || state.world.unavailable != null || state.realms.isEmpty())
            SecondaryButton("REFRESH REALMS", { action(model::refreshWorld) }, Modifier.fillMaxWidth(),
                enabled = !busy && !checkout.busy && !state.world.loading)
    }
    // [switchAccount] false where the designed "Already own land? · SWITCH" row is already on screen (the same sign-out).
    val utilityDoors: @Composable ColumnScope.(Boolean) -> Unit = { switchAccount ->
        LandFunding(state, local, busy || checkout.busy, onFaucet, onClaimDeed, model::refreshEstimate, ::explain)
        researchRecoveryError?.let { LandMessage(it) }
        onResearchPayment?.let { SecondaryButton("CHECK RESEARCH PAYMENT", it, Modifier.fillMaxWidth()) }
        onBuilderPayment?.let { SecondaryButton("CHECK BUILDER PAYMENT", it, Modifier.fillMaxWidth()) }
        onTrainingPayment?.let { SecondaryButton("CHECK TRAINING PAYMENT", it, Modifier.fillMaxWidth()) }
        onBases?.let { SecondaryButton("SWITCH BASE", it, Modifier.fillMaxWidth(), verb = Verb.BLUE) }
        if (switchAccount) SecondaryButton("SWITCH ACCOUNT", ::requestSignOut, Modifier.fillMaxWidth())
        if (checkout.phase == LandPhase.PAYING || checkout.phase == LandPhase.CONFIRMING)
            LandMessage("Closing keeps your reservation and payment saved.")
    }
    val utilities: @Composable ColumnScope.() -> Unit = { utilityDoors(true) }
    val done = liveLandDone(state).takeIf { checkout.purchaseKind == kind }?.copy(busy = busy,
        notice = listOfNotNull(feedback, notice?.message).distinct().joinToString("\n").takeIf(String::isNotBlank),
        canSeeMap = onSeeMap != null)
    BoxWithConstraints(Modifier.fillMaxSize().background(PkwTokens.Colors.ink)) {
        // This route has no world-engine lease. The real globe remains reachable through CHOOSE ON MAP.
        TitleBackdrop(maxWidth <= maxHeight, Modifier.fillMaxSize(), brightness = .35f)
        val panel = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 4.dp, vertical = 8.dp)
        when {
            checkout.purchaseKind != kind -> HubCard(panel, header = { CompactHeader("YOUR LAND", "itm_deed_earth", ::leave) }) {
                LandMessage("Restoring this land purchase. Your saved requests stay unchanged.")
            }
            done != null -> Unit
            state.paymentCredited || state.reservation != null || checkout.phase !in setOf(LandPhase.IDLE, LandPhase.RESERVING) ->
                LandCheckoutCard(state, now, busy, signer != null, ::reviewLand, ::retryPayment,
                    { enter(onBack) }, onSeeMap?.let { open -> { enter(open) } }, ::leave, common, utilities, panel)
            pickerVisible || state.picker.realmId != null || checkout.draftedTile != null ->
                RealmPickerSheet(liveRealmPicker(state, busy), RealmPickerActions(
                    onSelectRealm = { id ->
                        val current = model.state.value
                        val row = current.realms.firstOrNull { it.realmId == id }
                        when {
                            model.busy.value || current.checkout.busy -> explain("A land request is finishing. Please wait.")
                            row == null || row.available <= 0 -> explain("That realm is full or unavailable. Refresh the realm list.")
                            id == gg.pixelkingdomwars.nativeclient.data.FantasyCatalog.SEEKER_REALM -> explain("This realm has reserved allocations and is not an ordinary land sale.")
                            else -> { model.clearRealm(); action { model.pickRealm(id) } }
                        }
                    },
                    onLockedRealm = { id -> explain(lockedRealmMessage(id, model.state.value.realmName(id))) },
                    onSettle = { reserveDraft() }, onPrimary = ::reserveDraft, onExplain = ::explain,
                    onNeedMore = { onFaucet?.invoke() ?: explain("Add SOL to your wallet, then check funding again.") },
                    onClose = ::back,
                ), panel, beforeRealms = common, afterRealms = {
                    // land-realm.png has no tile grid: SETTLE takes the realm's first free tile (reserveDraft). The old
                    // numbered tile buttons are gone; an exact tile is still chosen on the real globe (CHOOSE ON MAP).
                    LandSettleNote(state)
                    onChooseOnMap?.let { open -> SecondaryButton("CHOOSE ON MAP", {
                        if (model.busy.value || model.state.value.checkout.busy) explain("A land request is finishing. Please wait.") else open()
                    }, Modifier.fillMaxWidth(), verb = Verb.BLUE) }
                    SecondaryButton("CHOOSE A RANDOM TILE", {
                        if (model.state.value.reservationBlocked) explain("Finish checking your saved reservation first.")
                        else action { model.reserveRandom().also { awaitingQuote = it != null } }
                    }, Modifier.fillMaxWidth())
                    LandMessage("Random chooses any ordinary realm. Selecting a tile keeps your chosen realm.")
                    utilities()
                })
            else -> {
                val gate = liveLandGate(state, busy)
                LandGateCard(gate, LandGateActions(
                    onChooseRealm = {
                        val current = liveLandGate(model.state.value, model.busy.value)
                        if (current.serverOffReason != null) explain(current.serverOffReason) else pickerVisible = true
                    }, onConnectWallet = ::requestSignOut,
                    onLater = ::leave, onSwitchWallet = ::requestSignOut, onClose = ::leave,
                    onNeedMore = { onFaucet?.invoke() ?: explain("Add SOL to your wallet, then check funding again.") },
                    onExplain = ::explain,
                ), panel, beforeBenefits = common, afterBenefits = { utilityDoors(gate.alreadyOwned) })
            }
        }
        LandDoneCard(done, LandDoneActions(onSeeMap = { onSeeMap?.let { enter(it) } }, onGoHome = { enter(onBack) }))
        Seal(review?.let { liveLandSeal(it, armedAt) }, onConfirm = {
            val frozen = review
            val current = model.state.value
            val hold = landPayUnavailable(current, model.busy.value, latestSigner != null, SystemClock.elapsedRealtime())
            when {
                frozen == null -> Unit
                !landReviewCurrent(frozen, current) -> { review = null; explain("This land reservation changed. Review the current tile and price again.") }
                hold != null -> { review = null; explain(hold) }
                else -> { review = null; action { latestSigner?.let(model::pay) } }
            }
        }, onCancel = { review = null }, onExitFinished = { sealVisible = false })
        HubConfirmDialog(if (confirmSignOut) ConfirmUi("SWITCH ACCOUNT?", null, null,
            "Your progress and reserved land stay with this wallet.", "Sign in with the same account to continue.", "SIGN OUT", Verb.STONE, "STAY") else null,
            onConfirm = { confirmSignOut = false; action { model.signOut(onSignedOut) } }, onBack = { confirmSignOut = false })
    }
}

private const val DEED_REFRESH_MS = 10_000L
private const val FUNDING_POLL_MS = 10_000L

@Composable private fun LandMessage(text: String) {
    PkwText(text, PkwTokens.Type.small, Modifier.fillMaxWidth().padding(vertical = 3.dp),
        color = PkwTokens.Colors.textOnParch2, maxLines = 5)
}

@Composable private fun LandInterrupted(state: LandUiState, busy: Boolean, model: LandViewModel) {
    state.interrupted.filter { it.kind == IntentKind.LAND_RESERVATION }.forEach { item ->
        AccountCard(Modifier.fillMaxWidth(), rim = PkwTokens.Colors.gold.face) {
            LandMessage(if (item.proven) "Your saved land reservation was accepted. Refresh to apply it."
                else "Your saved land reservation needs checking before another tile is reserved.")
            Copy.observation(item.lastObservation)?.let { LandMessage(it) }
            SecondaryButton(if (item.proven) "REFRESH SAVED LAND" else "CHECK SAVED LAND", { model.interrupted.check(item.kind) },
                Modifier.fillMaxWidth(), enabled = !busy)
            if (item.retryable) SecondaryButton("RETRY SAVED RESERVATION", { model.interrupted.retry(item.kind) }, Modifier.fillMaxWidth(), enabled = !busy)
            if (item.closable) SecondaryButton("CLOSE SAVED REQUEST", { model.interrupted.close(item.kind) }, Modifier.fillMaxWidth(), enabled = !busy)
        }
    }
}

@Composable private fun LandFunding(state: LandUiState, local: Boolean, busy: Boolean, onFaucet: (() -> Unit)?, onClaimDeed: (() -> Unit)?,
    onRefresh: () -> Unit, explain: (String) -> Unit) {
    val clipboard = LocalClipboardManager.current
    val wallet = state.wallet
    SectionHeader("YOUR WALLET")
    AccountCard(Modifier.fillMaxWidth()) {
        if (state.checkout.cluster == SolanaCluster.DEVNET) DevTag()
        if (local) LandMessage(Copy.LOCAL_SERVER)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Well("sol", light = true)
            RowText(state.funding.balanceLamports?.let { "${solTextTrimmed(it)} SOL" } ?: "SOL balance unavailable",
                if (wallet == null) "No wallet connected" else shortWallet(wallet))
            if (wallet != null) SecondaryButton("COPY", {
                runCatching { clipboard.setText(AnnotatedString(wallet)) }.fold(
                    onSuccess = { explain("Wallet address copied.") }, onFailure = { explain("Wallet address could not be copied.") })
            }, Modifier.width(76.dp))
        }
        if (state.checkout.phase == LandPhase.READY) {
            if (state.checkout.estimate?.funded == false) LandMessage("Add SOL to this wallet before approving your land payment.")
            if (state.checkout.estimateUnavailable) LandMessage("Funding estimate unavailable. Your funds are checked again before wallet approval.")
            SecondaryButton(if (state.checkout.estimateLoading) "CHECKING FUNDING…" else "CHECK FUNDING AGAIN", onRefresh,
                Modifier.fillMaxWidth(), enabled = !busy && !state.checkout.estimateLoading)
        }
        if (!state.paymentCredited && state.checkout.cluster == SolanaCluster.DEVNET && onFaucet != null)
            SecondaryButton("TEST SOL", onFaucet, Modifier.fillMaxWidth(), enabled = !busy)
        onClaimDeed?.let { SecondaryButton("CLAIM A TRANSFERRED DEED", it, Modifier.fillMaxWidth(), verb = Verb.BLUE, enabled = !busy) }
    }
}

/** One quiet line under the realm cards: what SETTLE will do for the chosen realm (no tile grid; land-realm.png). */
@Composable private fun LandSettleNote(state: LandUiState) {
    if (state.picker.realmId == null) return
    val line = when {
        state.checkout.draftedTile != null -> "Tile ${state.checkout.draftedTile} selected. Review reserves that exact tile and reads its price."
        state.picker.loading -> "Reading available tiles…"
        state.picker.tiles.none { !landTileHeld(it) } -> "No candidate tiles are listed. Try another realm or choose on the map."
        else -> null
    }
    line?.let { LandMessage(it) }
}

@Composable private fun LandCheckoutCard(state: LandUiState, now: Long, busy: Boolean, signerAvailable: Boolean,
    onReview: () -> Unit, onRetryPayment: () -> Unit, onHome: () -> Unit, onSeeMap: (() -> Unit)?, onClose: () -> Unit,
    common: @Composable ColumnScope.() -> Unit, utilities: @Composable ColumnScope.() -> Unit, modifier: Modifier) {
    val checkout = state.checkout
    val payReason = landPayUnavailable(state, busy, signerAvailable, now)
    val retry = state.bounds?.let { checkout.canRetryEntry(now, it) } == true
    HubCard(modifier, header = { CompactHeader("YOUR LAND", "itm_deed_earth", onClose) }, footer = {
        SecondaryButton("CLOSE", onClose, Modifier.width(100.dp).heightIn(min = 60.dp))
        when {
            state.paymentCredited -> PrimaryButton("GO HOME", onHome, Modifier.weight(1f), state = if (busy) CommandState.BUSY else CommandState.ENABLED)
            checkout.phase == LandPhase.READY -> PrimaryButton("REVIEW PAYMENT", onReview, Modifier.weight(1f),
                state = if (payReason == null) CommandState.ENABLED else CommandState.DISABLED, reason = payReason, reasonOnDark = true)
            else -> PkwText(if (checkout.phase == LandPhase.FAILED) "PAYMENT SAVED" else "CHECKING…", PkwTokens.Type.label,
                Modifier.weight(1f), color = PkwTokens.Colors.text, textAlign = TextAlign.Center, maxLines = 2)
        }
    }) {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            common()
            landCheckoutLine(state)?.let { LandMessage(it) }
            state.reservation?.let { quote ->
                AccountCard(Modifier.fillMaxWidth(), rim = PkwTokens.Colors.gold.face) {
                    PkwText(quote.fantasyLocation?.realmId?.let(state::realmName) ?: "Your reserved land", PkwTokens.Type.title,
                        color = PkwTokens.Colors.textOnParch, maxLines = 2)
                    quote.landAddress?.tileId?.let { LandMessage("Tile $it · reserved for this wallet") }
                    if (!state.paymentCredited) PriceChip(liveLandPrice(state))
                    if (checkout.phase == LandPhase.READY) checkout.payableRemainingSec(now)?.let {
                        LandMessage(if (it == 0L) "Payment window ended. Review asks the server again before any wallet approval." else "Payment window: ${clock(it)}")
                    }
                    LandMessage("This parcel stays saved when you close the card.")
                }
            }
            if (checkout.phase == LandPhase.CONFIRMING) {
                if (retry) {
                    SecondaryButton("RETRY FIRST-LAND PAYMENT", onRetryPayment, Modifier.fillMaxWidth(), enabled = !busy && !checkout.retrying && signerAvailable)
                    LandMessage("Same parcel. Your saved payment is checked first. Network fees may apply.")
                } else if (!state.additionalDeed) state.bounds?.let { bounds -> checkout.retryEntryInSec(now, bounds)?.takeIf { it > 0 }?.let {
                    LandMessage("Still waiting? The first-land retry opens in ${clock(it)}.")
                } }
                if (state.additionalDeed) LandMessage("This additional deed payment cannot be sent again while its result is uncertain.")
            }
            if (state.paymentCredited && onSeeMap != null) SecondaryButton("SEE MAP", onSeeMap, Modifier.fillMaxWidth(), verb = Verb.BLUE, enabled = !busy)
            utilities()
        }
    }
}

/**
 * A gate is not an error (owner: "strange red responses"). Owner 2026-10-06 ("UI unfinished"): the old gold-on-ink strip
 * is now the designed cream row with the deed art and, when one action clears the gate, its blue door (the land grammar
 * of account/faucet-locked.png GET LAND). Same message and same action as before.
 */
@Composable internal fun LandNotice(message: String, action: Pair<String, () -> Unit>? = null, modifier: Modifier = Modifier) {
    CardRow(modifier, height = 56.dp) {
        Well("itm_deed_earth", size = 44.dp, light = true, iconSize = 32.dp)
        PkwText(message, PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 4)
        action?.let { (label, onClick) -> SecondaryButton(label, onClick, verb = Verb.BLUE) }
    }
}
