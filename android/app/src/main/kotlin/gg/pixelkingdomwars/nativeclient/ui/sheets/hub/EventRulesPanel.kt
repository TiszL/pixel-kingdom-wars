package gg.pixelkingdomwars.nativeclient.ui.sheets.hub

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import gg.pixelkingdomwars.nativeclient.data.PlaytestBounds
import gg.pixelkingdomwars.nativeclient.model.PlaytestCampaign
import gg.pixelkingdomwars.nativeclient.ui.kit.CloseSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.ModalScrim
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton

/**
 * Design component: the event rules behind the Founding Kingdoms header INFO (design/final/hub/event.png, SPEC R2.2 "the
 * rules sit behind the header INFO button"). A child surface over the Event card, not a Destination, drawn with the
 * letter modal's kit and geometry (SPEC §2.4): 55 % scrim, WoodFrame x 16..396 from top 214, a parchment body, the red
 * Close overhanging the top-right corner. Close, a scrim tap and Back all return to the card.
 *
 * The lines are only the wording the campaign page already shows (PlaytestCampaignScreen), with the numbers from the
 * catalogue's PLAYTEST_COMPETITIONS and the server's checkpoint. SPEC R2.2 keeps money amounts and whitelist wording off
 * the surface, so the prize USD lines and the spot-count line are not drawn here. A saved event request keeps its owner:
 * the panel only points to it (OPEN), the campaign page checks or retries it.
 */

/** What the rules panel draws. */
@Immutable data class EventRulesUi(
    /** PS 13 "RULES". */
    val title: String,
    /** VT 20 rule lines, in the campaign page's order. */
    val lines: List<String>,
    /** "A saved event request needs checking." while a saved request waits; null draws no row. */
    val savedRequest: String?,
)

/** The panel's one new title; every rule line below is existing campaign-page wording. */
internal const val EVENT_RULES_TITLE = "RULES"
/** The stone row shown while a saved participation or submission request waits for its receipt. */
internal const val EVENT_RULES_SAVED_REQUEST = "A saved event request needs checking."

/**
 * The rules for [campaign] (the card's last accepted read; null while the first read is in flight, which is the Founding
 * card's own campaign) with [bounds]' numbers. Null when the catalogue has no PLAYTEST_COMPETITIONS: no rule line is ever
 * drawn from a guessed number, and the caller says "Event rules are unavailable. Update game content."
 */
internal fun eventRulesUi(campaign: PlaytestCampaign?, bounds: PlaytestBounds?, pendingRequest: Boolean): EventRulesUi? {
    val limits = bounds ?: return null
    val lines = buildList {
        add("Campaign points start fresh. Lifetime tester points keep growing separately.")
        if ((campaign?.kind ?: "founding") == "founding") {
            add("Automatic participation")
            // The checkpoint is server state: before the first read there is nothing honest to say about it.
            if (campaign != null) {
                val checkpoint = campaign.checkpoint
                add(if (checkpoint?.available == true && checkpoint.count != null)
                    "Checkpoint ${checkpoint.count} / ${checkpoint.target}${if (checkpoint.frozen) " · held until launch" else ""}"
                else "Checkpoint verification is unavailable. The server will retry verification.")
            }
            add("Verified original minters keep their guaranteed spots after selling. Other ranked spots require deed eligibility at close. The server determines eligibility and awards.")
        } else {
            add("Only activity after launch and your participation counts. Play on ${limits.bonusDays} distinct UTC days to earn ${limits.bonusPoints} lifetime points once.")
            add("Feedback review points count toward lifetime totals. Eligible private reports can separately win Bug Scout awards. Duplicate reports are ineligible.")
            add("Daily activity, caps and streak rewards match normal play. Campaign streaks start fresh. Score ties use active days, the earliest time reaching the score, then wallet address.")
            add("One gameplay award and one Bug Scout award per wallet; a video award may also be earned. Gameplay awards follow the listed order, skipping earlier winners.")
            add("Revenge counts up to ${limits.revengeWinsPerOpponentDay} wins per opposing wallet per UTC day. Daily Defender uses active days, then longest streak. Realm Explorer counts distinct three-star stages during participation.")
            add("Videos need objective feedback and gameplay evidence. Honest criticism is welcome; praise, views and likes give no advantage.")
            limits.videoWeights.entries.joinToString(" · ") { "${it.key}: ${it.value}%" }.takeIf { it.isNotBlank() }?.let { add(it) }
        }
    }
    return EventRulesUi(EVENT_RULES_TITLE, lines, EVENT_RULES_SAVED_REQUEST.takeIf { pendingRequest })
}

/**
 * The rules panel over the Event card (scale 0.96 → 1 + fade in, as the letter). The caller composes it only while the
 * rules are open and owns Back ([onClose]).
 *
 * Pointer rule: the 55 % scrim is composed only while the panel is shown; a tap on it returns to the card.
 */
@Composable fun EventRulesPanel(ui: EventRulesUi, onClose: () -> Unit, onSavedRequest: () -> Unit, modifier: Modifier = Modifier) {
    val close by rememberUpdatedState(onClose)
    Presence(ui, PkwTokens.Motion.PLATE_IN, PkwTokens.Motion.SEAL_OUT) { rules, progress, active, reduced ->
        Box(modifier) {
            ModalScrim(PkwTokens.Scrim.SEAL * progress(), onTap = { if (active) close() })
            // SPEC §2.4: the WoodFrame top is 214 on screen, i.e. 154 below the FULL card's top 60 (x 16..396 = 8 in).
            Box(Modifier.align(Alignment.TopCenter).padding(start = 8.dp, end = 8.dp, top = 154.dp).fillMaxWidth()
                .semantics { paneTitle = "Event rules" }
                .graphicsLayer {
                    val p = progress()
                    alpha = p
                    val s = if (reduced) 1f else 0.96f + 0.04f * p
                    scaleX = s; scaleY = s
                }) {
                Plate(PlateKind.WOOD, Modifier.fillMaxWidth()) {
                    Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), blocksScene = false) {
                        Column(Modifier.fillMaxWidth().padding(6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            PkwText(rules.title, PkwTokens.Type.title, Modifier.semantics { heading() }, color = PkwTokens.Colors.textOnParch)
                            Box(Modifier.fillMaxWidth().height(3.dp).background(PkwTokens.Colors.parchmentLo))
                            Column(Modifier.fillMaxWidth().heightIn(max = 400.dp).verticalScroll(rememberScrollState()),
                                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                rules.lines.forEach { line ->
                                    PkwText(line, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch, maxLines = Int.MAX_VALUE)
                                }
                            }
                            rules.savedRequest?.let { saved ->
                                CardRow(variant = RowVariant.DIM) {
                                    PkwText(saved, PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 2)
                                    SecondaryButton("OPEN", { if (active) onSavedRequest() }, Modifier.width(96.dp),
                                        contentDescription = "Open the saved event request")
                                }
                            }
                        }
                    }
                }
                CloseSquare({ if (active) close() }, Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-18).dp), contentDescription = "Back to the event")
            }
        }
    }
}

@Preview(name = "Event rules: founding, saved request", widthDp = 412, heightDp = 915)
@Composable private fun EventRulesPreview() {
    HubPreviewStage {
        EventRulesPanel(EventRulesUi(EVENT_RULES_TITLE, listOf(
            "Campaign points start fresh. Lifetime tester points keep growing separately.",
            "Automatic participation",
            "Checkpoint 212 / 300",
            "Verified original minters keep their guaranteed spots after selling. Other ranked spots require deed eligibility at close. The server determines eligibility and awards.",
        ), EVENT_RULES_SAVED_REQUEST), {}, {}, Modifier.fillMaxSize())
    }
}
