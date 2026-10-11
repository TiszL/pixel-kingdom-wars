package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.MoneyButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.TimerChip
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.TimerUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubColors
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StoneBusyButton
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well

/**
 * Design component: the devnet faucet's FaucetCard (design/final/account/faucet.png, faucet-locked.png, SPEC §6.1):
 * DAILY TEST SKR + DevTag, the SKR token 64, "+1,000 SKR", the honest line, and the gold CLAIM whose VT sub-line is the
 * one short fee line the owner asked for ("You pay the small network fee"). Locked without a deed: greyed token + padlock
 * + blue GET LAND with the deed icon. It sits in the resource drawer opened at SKR, and the WALLET tab's faucet row opens it.
 *
 * Facts it encodes (LANE-SKR-FAUCET): the catalogue's daily grant (`SKR_FAUCET.devnet.grantSkr`, never a literal) per
 * wallet per UTC day, only with a minted Kingdom Deed, devnet only (mainnet: [FaucetUi.Hidden], no card at all), signed by
 * the player's wallet (the player pays the network fee).
 *
 * The card face ([FaucetCardFace]), CLAIM ([FaucetClaimButton]) and GET LAND ([FaucetGetLandButton]) are shared with the
 * lifted-out sheet (`ui/sheets/hub/SkrFaucetSheet.kt`), so the drawer and the sheet can never draw a state differently.
 */

/** The faucet's state (SPEC §6.1 `FaucetState`). Amounts arrive formatted ("1,000"). */
sealed interface FaucetUi {
    /** Mainnet or the flag is off: nothing renders (no route). */
    @Immutable data object Hidden : FaucetUi
    /** No minted Kingdom Deed yet: locked card + GET LAND. */
    @Immutable data object NeedsDeed : FaucetUi
    /** Claimable now. */
    @Immutable data class Ready(val amount: String) : FaucetUi
    /** The money sequence is running (Check wallet → Sending → SENT). */
    @Immutable data class Claiming(val amount: String, val stage: MoneyStage) : FaucetUi
    /** Claimed this UTC day; [nextIn] is the time to the next claim ("7h 12m"). */
    @Immutable data class ClaimedToday(val nextIn: String) : FaucetUi
    /** The treasury is empty or the faucet is paused: the server's [reason], no button. */
    @Immutable data class Unavailable(val reason: String) : FaucetUi
    /** The claim's answer was lost: we are checking (never "nothing was spent"). */
    @Immutable data object Checking : FaucetUi
}

/** The faucet card's callbacks. */
@Immutable data class FaucetActions(
    /** CLAIM (READY and FAILED only): start the money sequence. On SENT the HUD counts the grant into SKR (600 ms). */
    val onClaim: () -> Unit = {},
    /** GET LAND: open the land gate. */
    val onGetLand: () -> Unit = {},
    /** CHECK AGAIN while [FaucetUi.Checking]: re-read the claim. */
    val onRecheck: () -> Unit = {},
)

/** The fee line the owner asked for (SPEC §0.7): CLAIM's own sub-line. */
internal const val FAUCET_FEE_LINE = "You pay the small network fee"

/** The card's height in faucet.png (`kcard` 238); its content is centred in it, and a taller state simply grows. */
private val FAUCET_CARD_H = 238.dp
private val FAUCET_CARD_PAD = 12.dp

/**
 * The FaucetCard (238 dp tall in the design, content centred; it grows if a state needs more). [ui] = [FaucetUi.Hidden]
 * draws nothing. [dailyAmount] is the catalogue's grant, formatted ("1,000"); "…" until the catalogue is read.
 *
 * Pointer rule: a painted card; only its button takes touches. No root pointer handling, no scrim (the drawer's 40 %
 * scrim belongs to the drawer host).
 */
@Composable fun FaucetCard(ui: FaucetUi, on: FaucetActions, modifier: Modifier = Modifier, checking: Boolean = false,
    dailyAmount: String = UNKNOWN) {
    val look = faucetLook(ui, dailyAmount) ?: return
    FaucetCardFace(look, modifier) {
        when (look.button) {
            FaucetButton.CLAIM -> FaucetClaimButton(look.stage, look.claimLabel, on.onClaim)
            FaucetButton.GET_LAND -> FaucetGetLandButton(on.onGetLand)
            FaucetButton.RECHECK -> StoneBusyButton("CHECK AGAIN", checking, on.onRecheck, Modifier.fillMaxWidth())
            FaucetButton.NONE -> look.nextIn?.let {
                TimerChip(TimerUi("Next in $it", "Next claim in $it"), Modifier.align(Alignment.CenterHorizontally))
            }
        }
    }
}

/**
 * The card face both faucet surfaces draw (faucet.png `kcard ok` / faucet-locked.png `kcard`): green rim and the ready face
 * while claimable, cream and no rim otherwise; PS 12 "DAILY TEST SKR" + DevTag; the 64 dp token (SKR art at 48, greyed with
 * a padlock while locked); the PS 16 headline (SKR green, `t-ink2` while locked) over the VT 18 line; then [button] inside
 * the card, as the frame draws it.
 */
@Composable internal fun FaucetCardFace(look: FaucetLook, modifier: Modifier = Modifier, button: @Composable ColumnScope.() -> Unit) {
    val c = PkwTokens.Colors
    AccountCard(modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
        rim = if (look.rim) c.green.face else null,
        face = if (look.rim) AccountColors.readyFace else c.cream, minHeight = FAUCET_CARD_H, contentPadding = FAUCET_CARD_PAD) {
        Box(Modifier.fillMaxWidth().heightIn(min = FAUCET_CARD_H - FAUCET_CARD_PAD * 2), contentAlignment = Alignment.Center) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    PkwText("DAILY TEST SKR", PkwTokens.Type.label, Modifier.weight(1f), color = c.textOnParch)
                    DevTag()
                }
                // faucet.png: 10 above the token row, 6 below it.
                Row(Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    FaucetToken(look.locked)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        PkwText(look.headline, PkwTokens.Type.numeralL, color = if (look.locked) c.textOnParch2 else AccountColors.skrValue)
                        PkwText(look.line, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 3)
                    }
                }
                button()
            }
        }
    }
}

/** faucet.png `.tok`: 64 dp, ink rim, light parchment face, the SKR art at 48; locked = the art at 50 % + the gold padlock
 *  4 dp inside the corner (the SKR art is already black and white, so the frame's grayscale changes nothing). */
@Composable private fun FaucetToken(locked: Boolean) {
    val c = PkwTokens.Colors
    Box(Modifier.size(64.dp).background(c.ink).padding(2.dp).background(HubColors.wellLight), contentAlignment = Alignment.Center) {
        PkwIcon("skr", 48.dp, alpha = if (locked) 0.5f else 1f)
        if (locked) PkwIcon("shape:lock", 22.dp, Modifier.align(Alignment.BottomEnd).padding(4.dp), tint = c.gold.face)
    }
}

/**
 * CLAIM: before the claim (READY) the gold PrimaryButton with the fee line as its own VT sub-line (faucet.png), drawn in
 * [state] with [reason] when the host cannot run the claim; while the money sequence runs, the kit MoneyButton (Check
 * wallet → Sending → SENT), and on FAILED its RETRY with the fee line under it (a retry pays the fee again).
 */
@Composable internal fun FaucetClaimButton(stage: MoneyStage, label: String, onClaim: () -> Unit,
    state: CommandState = CommandState.ENABLED, reason: String? = null) {
    if (stage == MoneyStage.READY) {
        PrimaryButton(label, onClaim, Modifier.fillMaxWidth(), sub = FAUCET_FEE_LINE, state = state, reason = reason)
        return
    }
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        MoneyButton(stage, label, onClaim)
        if (stage == MoneyStage.FAILED)
            PkwText(FAUCET_FEE_LINE, PkwTokens.Type.small, Modifier.padding(top = 2.dp), color = PkwTokens.Colors.textOnParch2)
    }
}

/** GET LAND (faucet-locked.png): the full-width blue primary with the 32 dp deed icon beside the label. */
@Composable internal fun FaucetGetLandButton(onGetLand: () -> Unit) {
    PrimaryButton("GET LAND", onGetLand, Modifier.fillMaxWidth(), verb = Verb.BLUE, icon = "itm_deed_earth")
}

/**
 * The SKR info card that heads the drawer at SKR (faucet.png top card, 96 tall): SKR icon 36 in a dark well, PS 12
 * "SKR 240", the VT one-line purpose, and the blue GO 64 × 60 that carries only the Seeker navigation icon (Seeker Island).
 *
 * Pointer rule: a painted card; only the GO takes touches.
 */
@Composable fun SkrInfoCard(skr: String, onGoSeeker: () -> Unit, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    AccountCard(modifier.fillMaxWidth(), minHeight = 96.dp) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Well("skr", size = 64.dp, iconSize = 36.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PkwText("SKR", PkwTokens.Type.label, color = c.textOnParch)
                    PkwText(skr, PkwTokens.Type.label, color = AccountColors.skrValue)
                }
                PkwText("Seeker token in your wallet. Bid for island spots.", PkwTokens.Type.body, color = c.textOnParch, maxLines = 3)
            }
            // The frame's GO is the icon alone (no word under it), so the kit GoButton's caption is not drawn here.
            ChunkyBox(c.blue, onGoSeeker, "Go to Seeker Island", Modifier.size(64.dp, 60.dp)) { PkwIcon("ui:seeker-navigation", 32.dp) }
        }
    }
}

// ---- Previews (faucet.png, faucet-locked.png and the SPEC's unrendered states) ----

@Composable private fun FaucetStage(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.wood).padding(8.dp)) {
        Column(Modifier.fillMaxWidth().background(PkwTokens.Colors.parchment).padding(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
    }
}

@Preview(name = "Faucet: ready (faucet.png)", widthDp = 412, heightDp = 520)
@Composable private fun FaucetReadyPreview() { FaucetStage { SkrInfoCard("240", {}); FaucetCard(FaucetUi.Ready("1,000"), FaucetActions()) } }

@Preview(name = "Faucet: locked, no deed (faucet-locked.png)", widthDp = 412, heightDp = 360)
@Composable private fun FaucetLockedPreview() { FaucetStage { FaucetCard(FaucetUi.NeedsDeed, FaucetActions(), dailyAmount = "1,000") } }

@Preview(name = "Faucet: claiming (Sending)", widthDp = 412, heightDp = 360)
@Composable private fun FaucetClaimingPreview() { FaucetStage { FaucetCard(FaucetUi.Claiming("1,000", MoneyStage.SENDING), FaucetActions()) } }

@Preview(name = "Faucet: claimed today", widthDp = 412, heightDp = 300)
@Composable private fun FaucetClaimedPreview() { FaucetStage { FaucetCard(FaucetUi.ClaimedToday("7h 12m"), FaucetActions()) } }

@Preview(name = "Faucet: unavailable (paused)", widthDp = 412, heightDp = 300)
@Composable private fun FaucetUnavailablePreview() { FaucetStage { FaucetCard(FaucetUi.Unavailable("The test SKR store is empty. Try again tomorrow."), FaucetActions()) } }

@Preview(name = "Faucet: checking a lost answer", widthDp = 412, heightDp = 320)
@Composable private fun FaucetCheckingPreview() { FaucetStage { FaucetCard(FaucetUi.Checking, FaucetActions()) } }
