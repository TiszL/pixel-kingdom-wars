package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame
import gg.pixelkingdomwars.nativeclient.ui.kit.TimerChip
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.TimerUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.FaucetButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.FaucetCardFace
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.FaucetClaimButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.FaucetGetLandButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.FaucetLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.FaucetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.SkrInfoCard
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.faucetLook

/**
 * Design component: the devnet SKR faucet as a small HALF sheet (design/final/account SPEC §6.1 faucet.png /
 * faucet-locked.png, lifted out of the resource drawer so the Profile › WALLET faucet row and a "GET SKR" door can open it
 * on their own). The frames draw the two cards inside the RESOURCES drawer; this sheet is the documented lift-out of
 * exactly those two cards (the drawer's title plate and EVERY DAY rows belong to the drawer, not here). Built only from kit
 * parts plus the account cluster's faucet pieces: the SKR info card ([SkrInfoCard]), the card face, CLAIM and GET LAND
 * (`FaucetCardFace`, `FaucetClaimButton`, `FaucetGetLandButton` in FaucetCard.kt), the state machine ([FaucetUi]) and its
 * copy ([faucetLook]), so the drawer card and this sheet can never word or draw a state differently.
 *
 * As in the frames, the faucet's button sits inside the faucet card (under the green rim when claimable), not in a pinned
 * sheet footer. Unlike the drawer's FaucetCard, CLAIM here carries a [CommandState] and a reason, so a claim the app cannot
 * run yet is drawn DISABLED with its reason, never as a live gold button.
 *
 * Fed by `ui/sheets/hub/live/SkrFaucetHost.kt` (`skrFaucetHostUi`, the truthful local states) and by
 * `ui/sheets/hub/live/SkrFaucetLiveMapper.kt` (`skrFaucetSheetLiveUi`, for the day a claim owner exists).
 *
 * Pointer rule: SheetFrame and the cards are painted panels; only the buttons take touches. HALF: no scrim.
 */

/** Everything the faucet sheet draws. Amounts arrive formatted; unknown is "…". */
@Immutable data class SkrFaucetSheetUi(
    /** The frame: "DAILY TEST SKR", HALF, no tabs. */
    val frame: SheetFrameUi,
    /** The wallet's SKR, formatted ("21,240"), or "…" until a server/wallet read answers (never "0" by default). */
    val skr: String,
    /** The faucet state; null = the server status has not answered yet (the card reads "…" and offers nothing).
     *  [FaucetUi.Hidden] is never routed here (the mapper returns no sheet). */
    val faucet: FaucetUi?,
    /** A status re-read is in flight (CHECK AGAIN shows busy dots). */
    val checking: Boolean,
    /** CLAIM's state when the faucet is claimable; DISABLED carries [claimReason] (a tap shows it). */
    val claimState: CommandState,
    val claimReason: String?,
    /** The catalogue's daily grant, formatted ("1,000"; `SKR_FAUCET.devnet.grantSkr`) for the locked headline; "…" unknown. */
    val dailyAmount: String = UNKNOWN,
)

/** The sheet's callbacks (state in, callbacks out). */
@Immutable data class SkrFaucetSheetActions(
    val onClose: () -> Unit = {},
    /** CLAIM (also called while DISABLED so the host can show [SkrFaucetSheetUi.claimReason]). */
    val onClaim: () -> Unit = {},
    /** GET LAND: the land gate. */
    val onGetLand: () -> Unit = {},
    /** The SKR info card's GO: Seeker Island. */
    val onGoSeeker: () -> Unit = {},
    /** CHECK AGAIN while the claim's answer was lost: re-read the server status (a read, never a new claim). */
    val onRecheck: () -> Unit = {},
)

/** What the faucet card's button slot holds (the frames put it inside the card; the name predates that move). */
enum class SkrFaucetFooter {
    /** The kit MoneyButton: a claim in flight (Check wallet → Sending → SENT / RETRY) or an enabled claim. */
    CLAIM_MONEY,
    /** A claimable faucet whose CLAIM is not available: PrimaryButton in [SkrFaucetSheetUi.claimState] with its reason. */
    CLAIM_OFF,
    GET_LAND,
    RECHECK,
    /** Claimed today: the "Next in …" TimerChip, no button. */
    TIMER,
    NONE,
}

/** The button slot for [ui] (pure; JVM-tested in SkrFaucetLiveMapperTest and SkrFaucetHostTest). */
fun skrFaucetFooter(ui: SkrFaucetSheetUi): SkrFaucetFooter {
    val faucet = ui.faucet ?: return SkrFaucetFooter.NONE
    return when (faucetLook(faucet, ui.dailyAmount)?.button) {
        FaucetButton.CLAIM ->
            if (faucet is FaucetUi.Claiming || ui.claimState == CommandState.ENABLED) SkrFaucetFooter.CLAIM_MONEY else SkrFaucetFooter.CLAIM_OFF
        FaucetButton.GET_LAND -> SkrFaucetFooter.GET_LAND
        FaucetButton.RECHECK -> SkrFaucetFooter.RECHECK
        FaucetButton.NONE -> if (faucet is FaucetUi.ClaimedToday) SkrFaucetFooter.TIMER else SkrFaucetFooter.NONE
        null -> SkrFaucetFooter.NONE
    }
}

/** The card's look while the status is unknown: the plain label and "…", no rim, no button. */
private val loadingLook = FaucetLook(rim = false, locked = false, headline = "Daily test SKR", line = UNKNOWN, button = FaucetButton.NONE)

/**
 * The SKR faucet sheet. [modifier] must give the frame a bounded height (the SheetHost does for a HALF sheet).
 */
@Composable fun SkrFaucetSheet(ui: SkrFaucetSheetUi, on: SkrFaucetSheetActions, modifier: Modifier = Modifier) {
    val look = if (ui.faucet == null) loadingLook else faucetLook(ui.faucet, ui.dailyAmount)
    SheetFrame(ui.frame, onClose = on.onClose, modifier = modifier) {
        SkrInfoCard(ui.skr, on.onGoSeeker)
        // faucet.png: the info card's 6 below plus the faucet card's 4 above (the body already spaces 8).
        if (look != null) FaucetCardFace(look, Modifier.padding(top = 2.dp)) {
            when (skrFaucetFooter(ui)) {
                SkrFaucetFooter.CLAIM_MONEY ->
                    FaucetClaimButton((ui.faucet as? FaucetUi.Claiming)?.stage ?: MoneyStage.READY, look.claimLabel, on.onClaim)
                SkrFaucetFooter.CLAIM_OFF ->
                    FaucetClaimButton(MoneyStage.READY, look.claimLabel, on.onClaim, state = ui.claimState, reason = ui.claimReason)
                SkrFaucetFooter.GET_LAND -> FaucetGetLandButton(on.onGetLand)
                SkrFaucetFooter.RECHECK -> StoneBusyButton("CHECK AGAIN", ui.checking, on.onRecheck, Modifier.fillMaxWidth())
                SkrFaucetFooter.TIMER -> look.nextIn?.let {
                    TimerChip(TimerUi("Next in $it", "Next claim in $it"), Modifier.align(Alignment.CenterHorizontally))
                }
                SkrFaucetFooter.NONE -> Unit
            }
        }
    }
}

// ---- Previews (sample data only; the live sheet takes its Ui from the host or the mapper) ----

private val sampleFrame = SheetFrameUi("DAILY TEST SKR", null, SheetSize.HALF, emptyList(), null)
private val sampleSheet = SkrFaucetSheetUi(sampleFrame, "21,240", FaucetUi.Ready("1,000"), checking = false,
    claimState = CommandState.DISABLED, claimReason = "Claiming test SKR is not open in this app yet.", dailyAmount = "1,000")

@Composable private fun SkrFaucetStage(ui: SkrFaucetSheetUi) {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        SkrFaucetSheet(ui, SkrFaucetSheetActions(), Modifier.fillMaxWidth().height(460.dp).align(Alignment.BottomCenter).padding(8.dp))
    }
}

@Preview(name = "SKR faucet sheet: ready, CLAIM not open in this app", widthDp = 412, heightDp = 915)
@Composable private fun SkrFaucetReadyPreview() { SkrFaucetStage(sampleSheet) }

@Preview(name = "SKR faucet sheet: no deed (faucet-locked.png)", widthDp = 412, heightDp = 915)
@Composable private fun SkrFaucetNoDeedPreview() { SkrFaucetStage(sampleSheet.copy(faucet = FaucetUi.NeedsDeed)) }

@Preview(name = "SKR faucet sheet: land owned, claim not open in this app", widthDp = 412, heightDp = 915)
@Composable private fun SkrFaucetNotOpenPreview() {
    SkrFaucetStage(sampleSheet.copy(faucet = FaucetUi.Unavailable("Claiming test SKR is not open in this app yet.")))
}

@Preview(name = "SKR faucet sheet: status unknown", widthDp = 412, heightDp = 915)
@Composable private fun SkrFaucetLoadingPreview() { SkrFaucetStage(sampleSheet.copy(skr = UNKNOWN, faucet = null)) }

@Preview(name = "SKR faucet sheet: claimed today", widthDp = 412, heightDp = 915)
@Composable private fun SkrFaucetClaimedPreview() { SkrFaucetStage(sampleSheet.copy(faucet = FaucetUi.ClaimedToday("7h 12m"))) }
