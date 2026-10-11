package gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live

import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.compactAmount
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.FaucetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.armyDuration
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkrFaucetSheetActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkrFaucetSheetUi
import java.time.Instant

/**
 * Live mapper of the devnet SKR faucet sheet ([gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SkrFaucetSheet]):
 * [SkrFaucetInput] -> [SkrFaucetSheetUi], plus the Actions stub [skrFaucetLiveActions].
 *
 * State source: NONE exists at 1a1eb4bc. There is no SkrFaucet / SkrIdentity / SkrWalletBalance class in K/data,
 * network/model or wallet/; the only faucet data layer is the SOL one (`data/FaucetRepository.kt`, `/devnet-faucet/` routes,
 * D-098), which is a different token and a different route and is NOT read here. [SkrFaucetInput] / [SkrFaucetStatus] /
 * [SkrClaimStep] below are therefore the minimal input contract this sheet needs; MS-G2 supplies the implementation (a
 * repository whose state it converts into one [SkrFaucetInput]). They are plain data: no Compose, no network types.
 *
 * Rules kept: every number is the server's (grant amount and SKR balance in base units with the mint's decimals; no
 * literal amount); unknown is "…", never "0"; CLAIM (a wallet-signed transfer, the player pays the network fee) is a
 * money action and stays DISABLED with [SKR_FAUCET_NOT_OPEN_IN_APP] unless the caller's claim owner says it can run
 * ([SkrFaucetInput.claimable]).
 *
 * Night 2026-10-06: [SkrFaucetHost] (`SkrFaucetHost.kt`) feeds this mapper from the repository in a test build that
 * carries the pinned devnet SKR identity (`skrFaucetClaimInput`); every other build keeps the host's local states.
 */

/** Lane bookkeeping only: never drawn to players (players must never read lane jargon). Kept for references in notes. */
internal const val SKR_FAUCET_CLAIM_PENDING = "wiring pending: MS-M3"

/** Why CLAIM is off, in player words: drawn as CLAIM's reason, shown on tap, and the landed player's card line. */
internal const val SKR_FAUCET_NOT_OPEN_IN_APP = "Claiming test SKR is not open in this app yet."

/** The line for a wallet the server will not serve right now when it gave neither a next time nor a reason. */
internal const val SKR_FAUCET_NOT_OPEN = "The faucet cannot take a claim from this wallet right now. Check again later."

/** The sheet's frame (no tabs, no history: the claim's receipt lives in the wallet's History). */
internal val SKR_FAUCET_FRAME = SheetFrameUi("DAILY TEST SKR", null, SheetSize.HALF, emptyList(), null)

/** One read of the server's SKR faucet status for the signed-in wallet. Every field is the server's verdict. */
data class SkrFaucetStatus(
    /** The server feature flag. False = no faucet surface at all (FaucetUi.Hidden). */
    val enabled: Boolean,
    /** The wallet holds a minted Kingdom Deed (the server's check). */
    val hasDeed: Boolean,
    /** The server would accept a claim from this wallet now. */
    val eligible: Boolean,
    /** The daily grant in SKR base units (canonical decimal string); null = the server did not say. */
    val grantAmount: String?,
    /** A grant for this wallet is already queued / in flight on the server. */
    val pending: Boolean = false,
    /** ISO-8601 instant of the next claim when this wallet already claimed this UTC day; null = not said. */
    val nextEligibleAt: String? = null,
    /** The server's player-facing reason when the faucet is paused or its test inventory is empty; null = none. */
    val unavailableReason: String? = null,
)

/** The local progress of a claim this app started (data-layer words, mapped to the kit's MoneyStage here). */
enum class SkrClaimStep { SIGNING, SENDING, SENT, FAILED }

/** Everything the faucet sheet reads. */
data class SkrFaucetInput(
    /** The build's cluster is devnet. False (mainnet) = no route, ever (D153.275). */
    val devnet: Boolean,
    /** The latest server status; null until it answers. */
    val status: SkrFaucetStatus?,
    /** The wallet's SKR in base units (canonical decimal string); null until read. */
    val skrBalance: String?,
    /** The SKR mint's decimals (from the server / chain read); null until read. Amounts without it read "…". */
    val skrDecimals: Int?,
    /** A claim this app started and has not resolved; null = none. */
    val claimStep: SkrClaimStep? = null,
    /** A claim's answer was lost: keep the card and check (never "nothing was spent"). */
    val uncertain: Boolean = false,
    /** A status read is in flight. */
    val busy: Boolean = false,
    /** The claim owner can run CLAIM now (a pinned test build's repository says so). False = CLAIM is drawn off with
     *  [offReason]; the default keeps every unwired caller exactly as before. */
    val claimable: Boolean = false,
    /** Why CLAIM is off. */
    val offReason: String = SKR_FAUCET_NOT_OPEN_IN_APP,
)

/** An SKR amount for the card: every digit, grouped ("1,000"); "…" when the amount or the decimals are unknown. */
internal fun skrExact(amount: String?, decimals: Int?): String = if (decimals == null) UNKNOWN else exactAmount(amount, decimals)

/** The wallet SKR for the info card (≤ 6 glyphs, "21,240" / "1.2M"); "…" when unknown. */
internal fun skrCompact(amount: String?, decimals: Int?): String = if (decimals == null) UNKNOWN else compactAmount(amount, decimals)

/** "7h 12m" until [iso] from [nowMs]; "…" when missing, malformed or already past (a stale status; the next read answers). */
internal fun skrNextIn(iso: String?, nowMs: Long): String {
    val at = iso?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: return UNKNOWN
    val seconds = (at - nowMs + 999).floorDiv(1000)
    return if (seconds <= 0) UNKNOWN else armyDuration(seconds)
}

private fun SkrClaimStep.stage(): MoneyStage = when (this) {
    SkrClaimStep.SIGNING -> MoneyStage.CHECK_WALLET
    SkrClaimStep.SENDING -> MoneyStage.SENDING
    SkrClaimStep.SENT -> MoneyStage.SENT
    SkrClaimStep.FAILED -> MoneyStage.FAILED
}

/**
 * The faucet state machine (account SPEC §6.1 `FaucetState`). [FaucetUi.Hidden] = no route; null = the server status
 * has not answered (the sheet shows "…" and no button). A lost answer outranks everything on devnet, so the recovery
 * surface is never hidden by a later read; a claim in flight outranks the status it was started from.
 */
internal fun skrFaucetState(input: SkrFaucetInput, nowMs: Long): FaucetUi? {
    if (!input.devnet) return FaucetUi.Hidden
    if (input.uncertain) return FaucetUi.Checking
    val status = input.status
    val amount = skrExact(status?.grantAmount, input.skrDecimals)
    input.claimStep?.let { return FaucetUi.Claiming(amount, it.stage()) }
    if (status == null) return null
    return when {
        !status.enabled -> FaucetUi.Hidden
        !status.hasDeed -> FaucetUi.NeedsDeed
        !status.unavailableReason.isNullOrBlank() -> FaucetUi.Unavailable(status.unavailableReason)
        status.pending -> FaucetUi.Claiming(amount, MoneyStage.SENDING)
        status.eligible -> FaucetUi.Ready(amount)
        status.nextEligibleAt != null -> FaucetUi.ClaimedToday(skrNextIn(status.nextEligibleAt, nowMs))
        else -> FaucetUi.Unavailable(SKR_FAUCET_NOT_OPEN)
    }
}

/** [SkrFaucetInput] -> the sheet; null = no route (mainnet or the server flag off): the host must not open or keep it. */
fun skrFaucetSheetLiveUi(input: SkrFaucetInput, nowMs: Long): SkrFaucetSheetUi? {
    val faucet = skrFaucetState(input, nowMs)
    if (faucet == FaucetUi.Hidden) return null
    return SkrFaucetSheetUi(
        frame = SKR_FAUCET_FRAME,
        skr = skrCompact(input.skrBalance, input.skrDecimals),
        faucet = faucet,
        checking = input.busy,
        // Money action: enabled only when the claim owner says it can run (night 2026-10-06: pinned test builds).
        claimState = if (input.claimable && faucet is FaucetUi.Ready) CommandState.ENABLED else CommandState.DISABLED,
        claimReason = if (input.claimable && faucet is FaucetUi.Ready) null else input.offReason,
        // The locked headline's "n SKR a day" is the server's grant too (never a literal).
        dailyAmount = skrExact(input.status?.grantAmount, input.skrDecimals),
    )
}

/**
 * The sheet's actions. Without [onClaim] (every unwired host) CLAIM never reaches a repository: it only shows
 * [SKR_FAUCET_NOT_OPEN_IN_APP] through [onExplain] (the host's reason toast). A pinned test build's host passes its
 * claim owner's [onClaim]. Navigation and the status re-read are passed through as given.
 */
fun skrFaucetLiveActions(
    onClose: () -> Unit,
    onGetLand: () -> Unit,
    onGoSeeker: () -> Unit,
    onRecheck: () -> Unit,
    onExplain: (String) -> Unit,
    onClaim: (() -> Unit)? = null,
): SkrFaucetSheetActions = SkrFaucetSheetActions(
    onClose = onClose,
    onClaim = onClaim ?: { onExplain(SKR_FAUCET_NOT_OPEN_IN_APP) },
    onGetLand = onGetLand,
    onGoSeeker = onGoSeeker,
    onRecheck = onRecheck,
)
