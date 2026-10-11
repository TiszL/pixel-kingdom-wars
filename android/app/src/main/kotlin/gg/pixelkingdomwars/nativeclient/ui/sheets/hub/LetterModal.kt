package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlinx.coroutines.delay

/**
 * Design component: the letter modal (design/final/hub/mail-open.png, SPEC §2.4 "Letter modal layout"): a child surface
 * over the Mail inbox, not a Destination. WoodFrame x 16..396, top 214, height to content; red Close overhangs the
 * top-right corner; sender Well 60, PS 13 subject, sender line, rule, VT 20 body (6 lines then scroll), RewardStage,
 * the kingdom it goes to, and stone ARCHIVE + gold CLAIM. Close and Back both return to the inbox.
 */

/** Where a letter stands (SPEC §2.4 `LetterState`; CHECKING and FAILED added for design correction 7). */
enum class LetterState {
    /** Opened; nothing to claim. */
    READ,
    /** A reward waits: gold CLAIM. */
    CLAIMABLE,
    /** The claim is in flight: CLAIM shows dots, ARCHIVE is disabled. */
    CLAIMING,
    /** The claim's result is uncertain (timeout / lost response): "being checked" + CHECK AGAIN; never "nothing was spent". */
    CHECKING,
    /** The server receipt landed: for a claim just made ([LetterUi.closeAfterClaim]) the letter closes 160 ms later. */
    CLAIMED,
    /** The reward expired: tiles at 45 %, the expiry line, no CLAIM. */
    EXPIRED,
    /** The server authoritatively refused the claim: [LetterUi.failureLine] says why, CLAIM becomes RETRY. */
    FAILED,
}

/** Everything the open letter draws (SPEC §2.4 `LetterUi`; fields after `state` were added with defaults). */
@Immutable data class LetterUi(
    val id: String,
    /** The sender's icon in a 60 dp dark Well. */
    val senderIcon: String,
    /** PS 13 subject ("WEEKLY REWARD"). */
    val subject: String,
    /** VT 18 "sender · age". */
    val senderLine: String,
    /** VT 20 server text (6 lines, then it scrolls). */
    val body: String,
    /** RewardStage tiles (Shards, items "x2", Gems); empty hides the stage. */
    val rewards: List<ItemTileUi>,
    /** The kingdom the reward goes to ("Ironhold"); null with [needsBase] = no base selected. */
    val destination: String?,
    /** The reward needs a base: draws the "Goes to …" row (or "Select a Land Deed first"). */
    val needsBase: Boolean,
    /** "6 days" for "Claim within 6 days"; null draws none. */
    val expiresIn: String?,
    val state: LetterState,
    /** EXPIRED: "This reward expired on 2 Oct". */
    val expiredLine: String? = null,
    /** CHECKING: the honest uncertain line. */
    val checkingLine: String = "Being checked. Your reward stays in this letter until we know.",
    /** FAILED (authoritative only): what the server said, e.g. "The server refused this claim. Nothing was taken." */
    val failureLine: String? = null,
    /** "Select a Land Deed first" GO (`Profile(KINGDOMS)`). */
    val selectDeed: HubLink? = null,
    /** VT 18 server status ("Expires …", "Claimed … into base …"); null draws none. */
    val statusLine: String? = null,
    /** Why CLAIM cannot run now (busy, read hold, a saved claim, no deed): CLAIM draws disabled with this reason. */
    val claimUnavailable: String? = null,
    /** Why ARCHIVE cannot run now: ARCHIVE draws disabled and this line says why. */
    val archiveUnavailable: String? = null,
    /** Only a claim the player just saw acknowledged closes the letter; an already claimed letter stays open to read. */
    val closeAfterClaim: Boolean = false,
)

/**
 * The letter modal over the inbox. Pass the open letter, or null (it animates out: scale 0.96 → 1 + fade 160 ms in,
 * 120 ms out). Sunrays in the RewardStage turn 8°/s (none with reduced motion).
 *
 * Pointer rule: the 55 % scrim is composed only while a letter is shown; a tap on it returns to the inbox.
 */
@Composable fun LetterModal(ui: LetterUi?, on: MailActions, modifier: Modifier = Modifier) {
    val close by rememberUpdatedState(on.onCloseLetter)
    Presence(ui, PkwTokens.Motion.PLATE_IN, PkwTokens.Motion.SEAL_OUT) { letter, progress, active, reduced ->
        if (letter.state == LetterState.CLAIMED && letter.closeAfterClaim) LaunchedEffect(letter.id) { delay(HubMotion.LETTER_CLOSE_AFTER_CLAIM.toLong()); close() }
        val controls = letterControls(letter.state, letter.rewards.isNotEmpty())
        Box(modifier) {
            ModalScrim(PkwTokens.Scrim.SEAL * progress(), onTap = { if (active) close() })
            // SPEC §2.4: the WoodFrame top is 214 on screen, i.e. 154 below the FULL card's top 60 (x 16..396 = 8 in).
            Box(Modifier.align(Alignment.TopCenter).padding(start = 8.dp, end = 8.dp, top = 154.dp).fillMaxWidth()
                .semantics { paneTitle = letter.subject }
                .graphicsLayer {
                    val p = progress()
                    alpha = p
                    val s = if (reduced) 1f else 0.96f + 0.04f * p
                    scaleX = s; scaleY = s
                }) {
                Plate(PlateKind.WOOD, Modifier.fillMaxWidth()) {
                    Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                        Column(Modifier.fillMaxWidth().padding(6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                Well(letter.senderIcon, size = 60.dp, iconSize = if (letter.senderIcon.startsWith("league")) 40.dp else 32.dp)
                                Column(Modifier.weight(1f).semantics(mergeDescendants = true) { heading() }) {
                                    PkwText(letter.subject, PkwTokens.Type.title, color = PkwTokens.Colors.textOnParch, maxLines = 2)
                                    PkwText(letter.senderLine, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
                                }
                            }
                            Box(Modifier.fillMaxWidth().height(3.dp).background(PkwTokens.Colors.parchmentLo))
                            Box(Modifier.fillMaxWidth().heightIn(max = 136.dp).verticalScroll(rememberScrollState())) {
                                PkwText(letter.body, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = Int.MAX_VALUE)
                            }
                            if (letter.rewards.isNotEmpty()) RewardStage(letter.rewards, tileAlpha = controls.tileAlpha)
                            if (letter.state == LetterState.EXPIRED) letter.expiredLine?.let {
                                PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.danger)
                            }
                            if (controls.recheck) PkwText(letter.checkingLine, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2)
                            if (letter.state == LetterState.FAILED) letter.failureLine?.let {
                                PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.danger, maxLines = 2)
                            }
                            letter.statusLine?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2) }
                            if (letter.needsBase && letter.state != LetterState.EXPIRED && letter.state != LetterState.CLAIMED) {
                                val deed = letter.selectDeed
                                CardRow(height = 56.dp) {
                                    Well("itm_deed_earth", light = true)
                                    if (letter.destination != null) {
                                        RowText("Goes to ${letter.destination}", letter.expiresIn?.let { "Claim within $it" })
                                        SecondaryButton("CHANGE", on.onChangeKingdom, Modifier.width(96.dp),
                                            contentDescription = "Change the kingdom this reward goes to")
                                    } else {
                                        RowText("Select a Land Deed first", letter.expiresIn?.let { "Claim within $it" })
                                        if (deed != null) GoButton({ on.onGo(deed) }, contentDescription = "Go to your kingdoms", modifier = Modifier.width(58.dp))
                                    }
                                }
                            }
                            letter.archiveUnavailable?.let { PkwText(it, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2, maxLines = 2) }
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Bottom) {
                                SecondaryButton("ARCHIVE", { on.onArchive(letter.id) }, Modifier.width(112.dp),
                                    enabled = controls.archiveEnabled && letter.archiveUnavailable == null)
                                val noBase = letter.needsBase && letter.destination == null
                                // A disabled CLAIM still takes the tap, so the host can say why (the kit draws the reason below it).
                                val claimReason = letter.claimUnavailable ?: if (noBase) "Select a Land Deed first" else null
                                when {
                                    controls.claim -> PrimaryButton(controls.claimLabel, { on.onClaim(letter.id) }, Modifier.weight(1f),
                                        verb = if (letter.state == LetterState.FAILED) Verb.RED else Verb.GOLD,
                                        state = when {
                                            controls.claimBusy -> CommandState.BUSY
                                            claimReason != null -> CommandState.DISABLED
                                            else -> CommandState.ENABLED
                                        }, reason = claimReason)
                                    controls.recheck -> StoneBusyButton("CHECK AGAIN", false, { on.onRecheck(letter.id) }, Modifier.weight(1f))
                                }
                            }
                        }
                    }
                }
                CloseSquare({ if (active) close() }, Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-18).dp), contentDescription = "Back to the inbox")
            }
        }
    }
}

@Preview(name = "Letter: claimable (mail-open.png)", widthDp = 412, heightDp = 915)
@Composable private fun LetterPreview() { HubPreviewStage { LetterModal(sampleLetter, MailActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Letter: claiming (dots, ARCHIVE off)", widthDp = 412, heightDp = 915)
@Composable private fun LetterClaimingPreview() { HubPreviewStage { LetterModal(sampleLetter.copy(state = LetterState.CLAIMING), MailActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Letter: result being checked", widthDp = 412, heightDp = 915)
@Composable private fun LetterCheckingPreview() { HubPreviewStage { LetterModal(sampleLetter.copy(state = LetterState.CHECKING), MailActions(), Modifier.fillMaxSize()) } }

@Preview(name = "Letter: expired", widthDp = 412, heightDp = 915)
@Composable private fun LetterExpiredPreview() {
    HubPreviewStage { LetterModal(sampleLetter.copy(state = LetterState.EXPIRED, expiredLine = "This reward expired on 2 Oct"), MailActions(), Modifier.fillMaxSize()) }
}

@Preview(name = "Letter: no base selected", widthDp = 412, heightDp = 915)
@Composable private fun LetterNoBasePreview() {
    HubPreviewStage { LetterModal(sampleLetter.copy(destination = null, selectDeed = sampleLink("profile.kingdoms")), MailActions(), Modifier.fillMaxSize()) }
}
