package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.AppGraph
import gg.pixelkingdomwars.nativeclient.SessionGraph
import gg.pixelkingdomwars.nativeclient.data.EconomyPage
import gg.pixelkingdomwars.nativeclient.data.EconomyState
import gg.pixelkingdomwars.nativeclient.data.SkrFaucetBounds
import gg.pixelkingdomwars.nativeclient.data.SkrFaucetBoundsCheck
import gg.pixelkingdomwars.nativeclient.data.SkrFaucetClient
import gg.pixelkingdomwars.nativeclient.data.SkrFaucetState
import gg.pixelkingdomwars.nativeclient.data.skrFaucetClaimable
import gg.pixelkingdomwars.nativeclient.data.skrFaucetClient
import gg.pixelkingdomwars.nativeclient.data.skrFaucetPin
import gg.pixelkingdomwars.nativeclient.data.skrFaucetSigner
import gg.pixelkingdomwars.nativeclient.model.SkrFaucetGrant
import gg.pixelkingdomwars.nativeclient.model.SkrFaucetValue
import gg.pixelkingdomwars.nativeclient.model.WalletFunds
import gg.pixelkingdomwars.nativeclient.ui.chrome.Toasts
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.FaucetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkrFaucetSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkrFaucetSheetActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkrFaucetSheetUi
import gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster
import gg.pixelkingdomwars.nativeclient.wallet.WalletLogin
import java.math.BigInteger
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * The mounted devnet SKR faucet sheet (account SPEC §6.1 faucet.png / faucet-locked.png).
 *
 * Two builds, decided once per visit by [skrFaucetPin] over the build's chain pins (`ChainPins.current?.chainProfile`,
 * [AppGraph.chainPins]), which carry the faucet only when the build's own pkwSkrFaucet switch is on beside the SKR pins
 * (owner 2026-10-10: the auction's SKR mint alone no longer lights it):
 *
 * - Every build without the faucet switch (production pinned for auctions included): truthful LOCAL states only, as before.
 *   No repository, no mint, nothing signed, never a claimable state; CLAIM and CHECK AGAIN only say
 *   [SKR_FAUCET_NOT_OPEN_IN_APP]. Shown: the wallet's SKR (the `/wallet/balances` read Profile › WALLET uses; the last
 *   good readout is kept through a failed or blank refresh), the deed rule (no land = locked card + GET LAND to the land
 *   gate), and the daily grant from the catalogue (`SKR_FAUCET.devnet.grantSkr`).
 * - Night 2026-10-06, a test build with the faucet switch and the pinned devnet test SKR (owner: "showcase any part of the game"):
 *   the claim owner (`data/SkrFaucetRepository.kt` through `AppGraph.skrFaucetClient`) with the sign-only wallet step
 *   ([skrFaucetSigner]: the player signs the claim in the wallet app on the phone; the faucet co-signs and sends it).
 *   The sheet maps the server's status ([skrFaucetClaimInput]); CLAIM is live only when the repository says it can run.
 *   The SKR card shows the wallet's pinned TEST SKR (the wallet hub's SKR row is the mainnet token).
 *
 * The SOL faucet (TEST SOL, which buys land) is a different token and route and is untouched. Mainnet has no faucet.
 */

/**
 * The faucet state this app can honestly show without reading the faucet: mainnet → [FaucetUi.Hidden] whatever the land;
 * land unknown → null (the card reads "…" and offers nothing); landless → [FaucetUi.NeedsDeed] (GET LAND); landed →
 * [FaucetUi.Unavailable] with [SKR_FAUCET_NOT_OPEN_IN_APP], or, where a claim owner exists ([claimOpen], the Profile row
 * of a pinned test build), [SKR_FAUCET_OPEN_TO_CHECK]. Never Ready or Claiming: nothing here has read the faucet.
 */
internal fun skrFaucetLocalState(devnet: Boolean, landOwned: Boolean?, claimOpen: Boolean = false): FaucetUi? = when {
    !devnet -> FaucetUi.Hidden
    landOwned == null -> null
    // A claim owner exists (the pinned test build): the server's status decides the deed rule, not this phone. The QA
    // chain lane serves deedless claims (owner N-045, 2026-10-06); a local "no land" verdict here hid CLAIM from it.
    claimOpen -> FaucetUi.Unavailable(SKR_FAUCET_OPEN_TO_CHECK)
    !landOwned -> FaucetUi.NeedsDeed
    else -> FaucetUi.Unavailable(SKR_FAUCET_NOT_OPEN_IN_APP)
}

/** The catalogue's daily grant ("1,000"); "…" until the catalogue is read or when it carries no valid faucet policy. */
internal fun skrFaucetDailyAmount(catalogue: JsonObject?): String =
    SkrFaucetBounds.from(catalogue)?.grantSkr?.let { exactAmount(it) } ?: UNKNOWN

/**
 * The wallet funds to show after a `/wallet/balances` refresh: the fresh read when it succeeded, else [previous]. A failed
 * read (its error set) or a state without funds never blanks an SKR amount the player already saw.
 */
internal fun skrFaucetKeptFunds(previous: WalletFunds?, state: EconomyState): WalletFunds? =
    if (state.errors["/wallet/balances"] != null) previous else state.wallet ?: previous

/** The sheet for the local state; null = no faucet (mainnet): the host closes instead of drawing. */
internal fun skrFaucetHostUi(devnet: Boolean, landOwned: Boolean?, funds: WalletFunds?, catalogue: JsonObject?): SkrFaucetSheetUi? {
    val faucet = skrFaucetLocalState(devnet, landOwned)
    if (faucet == FaucetUi.Hidden) return null
    return SkrFaucetSheetUi(
        frame = SKR_FAUCET_FRAME,
        skr = walletAmount(funds?.tokens?.get("SKR")),
        faucet = faucet,
        checking = false,
        // Money action with no owner in this app: always off, with the player-facing reason.
        claimState = CommandState.DISABLED,
        claimReason = SKR_FAUCET_NOT_OPEN_IN_APP,
        dailyAmount = skrFaucetDailyAmount(catalogue),
    )
}

/**
 * The host's actions: close, GET LAND and GO pass through; CLAIM and CHECK AGAIN only [explain] why the claim is not open
 * (never a repository call, so no tap here can start a transfer).
 */
internal fun skrFaucetHostActions(onClose: () -> Unit, onGetLand: () -> Unit, onGoSeeker: () -> Unit,
    explain: (String) -> Unit): SkrFaucetSheetActions =
    skrFaucetLiveActions(onClose = onClose, onGetLand = onGetLand, onGoSeeker = onGoSeeker,
        onRecheck = { explain(SKR_FAUCET_NOT_OPEN_IN_APP) }, onExplain = explain)

// ---- Pinned test builds: the claim owner (night 2026-10-06) ----

/** The Profile row's line in a pinned test build for a landed player: the row opens the sheet, which reads the faucet. */
internal const val SKR_FAUCET_OPEN_TO_CHECK = "Open to check today's test SKR."
/** No catalogue SKR_FAUCET block and the server's status did not confirm the daily amount: nothing is invented. */
internal const val SKR_FAUCET_AMOUNT_UNKNOWN = "The daily test SKR amount could not be confirmed. Check again later."
/** The server's faucet token is not the test SKR this build is pinned to: claiming would be refused anyway. */
internal const val SKR_FAUCET_TOKEN_MISMATCH = "This server's test SKR is not the one this build was made for."
/** The server's faucet flag is off: the sheet closes with this toast. */
internal const val SKR_FAUCET_SERVER_OFF = "Daily test SKR is off on this server."
internal const val SKR_FAUCET_UNCONFIGURED = "The test SKR faucet is not set up on this server yet."
internal const val SKR_FAUCET_PAUSED = "The test SKR faucet is paused. Check again later."
internal const val SKR_FAUCET_SELECT_BASE = "Select one of your kingdoms, then claim."
internal const val SKR_FAUCET_RETIRED_DEED = "This kingdom's deed is retired. Select another kingdom."
internal const val SKR_FAUCET_DEED_UNCHECKED = "Your deed could not be checked just now. Check again in a moment."
internal const val SKR_FAUCET_TODAY_FAILED = "Today's claim did not go through. You can claim again tomorrow."
/** How long the kit's SENT stage shows after the grant arrives, before the card settles on "Claimed". */
internal const val SKR_FAUCET_SENT_FLASH_MS = 2_500L

/** True only in a build whose faucet switch is on beside the devnet SKR pins (devnet, online). */
internal fun skrFaucetClaimOpen(graph: AppGraph): Boolean =
    skrFaucetPin(graph.chainPins?.chainProfile, graph.cluster, graph.mode.offline) != null

/** The player sentence for a server status reason, or null when another state says it (Ready, Claiming, Claimed,
 *  GET LAND, or the server flag off). An unknown reason is never actionable. */
internal fun skrFaucetReasonText(reason: SkrFaucetValue, today: SkrFaucetGrant?): String? = when {
    !reason.known -> SKR_FAUCET_NOT_OPEN
    reason.raw == "daily_limit" -> if (today?.status?.isValue("failed") == true) SKR_FAUCET_TODAY_FAILED else null
    reason.raw == "unconfigured" -> SKR_FAUCET_UNCONFIGURED
    reason.raw == "unavailable" -> SKR_FAUCET_PAUSED
    reason.raw == "select_base" -> SKR_FAUCET_SELECT_BASE
    reason.raw == "retired_deed" -> SKR_FAUCET_RETIRED_DEED
    reason.raw == "deed_unavailable" -> SKR_FAUCET_DEED_UNCHECKED
    else -> null // ok, sign_required, pending, submitted, deed_required, disabled
}

/**
 * The repository's state → the mapper's input ([skrFaucetSheetLiveUi]). Server reasons map onto the kit's states:
 * ok → Ready (CLAIM); sign_required / pending (a reserved grant still to sign) → Ready (CLAIM continues it);
 * submitted → Claiming "Sending" while the catalogue's cadence polls, else the Checking card with CHECK AGAIN (no
 * invented cadence); daily_limit → Claimed · next in …; deed_required or no land → GET LAND; disabled → no sheet; every
 * other reason → Unavailable with its sentence. A lost claim reply → Checking. [check] null = the faucet's numbers are
 * still being resolved ("…"); [reads] = status reads finished this visit.
 */
internal fun skrFaucetClaimInput(landOwned: Boolean?, state: SkrFaucetState, check: SkrFaucetBoundsCheck?, bounds: SkrFaucetBounds?,
    decimals: Int, step: SkrClaimStep?, reads: Int): SkrFaucetInput {
    val polling = bounds?.pollMs != null
    val status = state.status
    val submitted = status?.reason?.isValue("submitted") == true
    val grantRaw = status?.grantRaw ?: bounds?.let { it.grantSkr.toBigInteger().multiply(BigInteger.TEN.pow(decimals)).toString() }
    // The server owns the deed rule (server-authoritative; the QA chain lane serves deedless claims, owner N-045): only its
    // `deed_required` answer locks the card. [landOwned] is not consulted here; a local "no land" verdict hid CLAIM from
    // a lane that had just said `ok`. With no status the real reason shows, never an invented deed verdict.
    fun off(reason: String) = SkrFaucetStatus(enabled = true, hasDeed = true, eligible = false, grantAmount = grantRaw,
        unavailableReason = reason)
    val shown = when {
        check == SkrFaucetBoundsCheck.MISMATCH -> off(SKR_FAUCET_TOKEN_MISMATCH)
        check == SkrFaucetBoundsCheck.UNCONFIRMED -> off(SKR_FAUCET_AMOUNT_UNKNOWN)
        status == null -> if (check == null || reads == 0 || state.busy) null else off(state.error ?: SKR_FAUCET_NOT_OPEN)
        else -> SkrFaucetStatus(enabled = status.enabled,
            hasDeed = !status.reason.isValue("deed_required"),
            eligible = status.reason.known && status.reason.raw in setOf("ok", "sign_required", "pending"),
            grantAmount = grantRaw, pending = submitted && polling,
            nextEligibleAt = status.nextEligibleAt.takeIf { status.reason.isValue("daily_limit") },
            unavailableReason = skrFaucetReasonText(status.reason, status.today))
    }
    return SkrFaucetInput(devnet = true, status = shown, skrBalance = null, skrDecimals = decimals, claimStep = step,
        uncertain = state.uncertain || (submitted && !polling), busy = state.busy,
        claimable = check == SkrFaucetBoundsCheck.KNOWN && skrFaucetClaimable(state), offReason = SKR_FAUCET_NOT_OPEN)
}

/**
 * The faucet sheet. [modifier] must bound the frame's height (the Home SheetHost panel does). On mainnet (or a server
 * whose faucet flag is off) it draws nothing and calls [onClose] once. [wallet] is the phone's wallet app connection; a
 * pinned test build signs the claim through it (without it, CLAIM says a wallet app is needed).
 */
@Composable fun SkrFaucetHost(graph: AppGraph, session: SessionGraph, onClose: () -> Unit, onGetLand: () -> Unit, onGoSeeker: () -> Unit,
    modifier: Modifier = Modifier, wallet: WalletLogin? = null) {
    val claimOwner = rememberSkrFaucetClient(graph, session, wallet)
    if (claimOwner != null) {
        SkrFaucetClaimHost(graph, claimOwner, onClose, onGetLand, onGoSeeker, modifier)
        return
    }
    val account by graph.account.state.collectAsState()
    val content by graph.content.state.collectAsState()
    val devnet = graph.cluster == SolanaCluster.DEVNET
    // Seeded from this session's last good read, so reopening the sheet shows the known SKR at once.
    var funds by remember(session) { mutableStateOf(skrFaucetKeptFunds(null, session.economy.state.value)) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(session, lifecycle, devnet) {
        if (!devnet) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            // The same wallet read Profile › WALLET makes (ProfileHub); a failure is recorded in state.errors.
            try { session.economy.refresh(EconomyPage.WALLET) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* the last readout stays; skrFaucetKeptFunds ignores the failed read */ }
            funds = skrFaucetKeptFunds(funds, session.economy.state.value)
        }
    }
    val ui = skrFaucetHostUi(devnet, landOwnedLive(account), funds, content.catalogue)
    if (ui == null) {
        val close by rememberUpdatedState(onClose)
        LaunchedEffect(Unit) { close() }
        return
    }
    SkrFaucetSheet(ui, skrFaucetHostActions(onClose, onGetLand, onGoSeeker) { Toasts.post(it) }, modifier)
}

/** One sheet visit: an action started on an earlier visit can no longer pass the repository's view guard. */
private class SkrFaucetVisit { @Volatile var shown = true; val epoch = AtomicLong() }

/** The claim owner for a pinned test build, or null (every other build: the local states above, exactly as before). */
@Composable private fun rememberSkrFaucetClient(graph: AppGraph, session: SessionGraph, wallet: WalletLogin?): SkrFaucetClient? {
    val visit = remember(session) { SkrFaucetVisit() }
    DisposableEffect(visit) { onDispose { visit.shown = false; visit.epoch.incrementAndGet() } }
    return remember(session, wallet, visit) {
        val profile = graph.chainPins?.chainProfile
        if (skrFaucetPin(profile, graph.cluster, graph.mode.offline) == null) null
        else runCatching {
            graph.skrFaucetClient(session, profile, graph.skrFaucetSigner(session, wallet),
                requireView = { check(visit.shown) { "The faucet sheet closed." } }, visitEpoch = { visit.epoch.get() })
        }.getOrNull()?.takeIf { it.configured }
    }
}

@Composable private fun SkrFaucetClaimHost(graph: AppGraph, client: SkrFaucetClient, onClose: () -> Unit, onGetLand: () -> Unit,
    onGoSeeker: () -> Unit, modifier: Modifier) {
    val decimals = requireNotNull(client.pin).decimals
    val account by graph.account.state.collectAsState()
    val live by client.repository.state.collectAsState()
    val reads by client.flow.reads.collectAsState()
    val testSkr by client.testSkr.collectAsState()
    // Drawn from the last settled state: an action resets canClaim while it runs, which must not flicker CLAIM.
    var settled by remember(client) { mutableStateOf(client.repository.state.value) }
    LaunchedEffect(client) { client.repository.state.collect { if (!it.busy) settled = it } }
    var check by remember(client) { mutableStateOf<SkrFaucetBoundsCheck?>(null) }
    var step by remember(client) { mutableStateOf<SkrClaimStep?>(null) }
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(client, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            launch {
                try { client.readTestSkr() }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { /* the last readout stays */ }
            }
            val resolved = client.bounds.resolve()
            check = resolved
            if (resolved == SkrFaucetBoundsCheck.KNOWN) client.flow.observe()
        }
    }
    val arrival = settled.arrival
    LaunchedEffect(arrival?.id) {
        if (arrival == null) return@LaunchedEffect
        step = SkrClaimStep.SENT
        delay(SKR_FAUCET_SENT_FLASH_MS)
        if (step == SkrClaimStep.SENT) step = null
    }
    val now by produceState(System.currentTimeMillis()) { while (true) { delay(60_000); value = System.currentTimeMillis() } }
    val input = skrFaucetClaimInput(landOwnedLive(account), settled.copy(busy = live.busy), check, client.bounds.current(),
        decimals, step, reads)
    val ui = skrFaucetSheetLiveUi(input, now)?.copy(skr = skrCompact(testSkr, decimals))
    if (ui == null) {
        val close by rememberUpdatedState(onClose)
        LaunchedEffect(Unit) { Toasts.post(SKR_FAUCET_SERVER_OFF); close() }
        return
    }
    val claim: () -> Unit = {
        if (!input.claimable) Toasts.post(ui.claimReason ?: SKR_FAUCET_NOT_OPEN)
        else if (step == null) {
            step = SkrClaimStep.SIGNING
            scope.launch {
                try { client.flow.claim()?.let { Toasts.post(it, error = true) } }
                finally { step = null }
            }
        }
    }
    SkrFaucetSheet(ui, skrFaucetLiveActions(onClose = onClose, onGetLand = onGetLand, onGoSeeker = onGoSeeker,
        onRecheck = { scope.launch { client.flow.refresh() } }, onExplain = { Toasts.post(it) }, onClaim = claim), modifier)
}
