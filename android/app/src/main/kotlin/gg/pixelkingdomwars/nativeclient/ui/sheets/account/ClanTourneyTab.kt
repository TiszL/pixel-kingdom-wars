package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.band
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import gg.pixelkingdomwars.nativeclient.ui.kit.insideStepped
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.CardRow
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ClanActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.ClanSheet
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubPreviewStage
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Pips
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowChevron
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.RowText
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.SectionHeader
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.StatusTag
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.Well
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.fractionText
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.keepPortrait
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.pipFills

/**
 * Design component: Clan › TOURNEY (design/final/account/clan-tourney.png, SPEC §5.3): the event card (trophy, "CLAN
 * TOURNAMENT", "Week 41 · 16 clans", ENTERED), the ENTRY → BATTLES → RESULTS track, who entered and the roster lock,
 * PRIZE CHEST (the authored 64 px Phase E icons at 32 with counts), YOUR FIGHTS pips, last time's result, and the foot
 * RANKINGS + FIND MATCH (locked with its reason until battles open; then the red attack primary; [tourneyLook]).
 *
 * It is the TOURNEY body for the hub's `ClanSheet(tourney = { ClanTourneyBody(...) })`. The design puts RANKINGS + FIND
 * MATCH on the wood foot in place of LEAVE + CLAN CHAT, but `ClanSheet` owns that foot, so by default the body draws them
 * at its end ([ClanTourneyActions] row); a host that can swap the foot passes `withActions = false` and uses
 * [ClanTourneyFooter].
 *
 * Unobserved ([ClanTourneyUi.observationKnown] false: the existing tournament owner has not supplied an event read here):
 * the card keeps "…" for the week, no track, prizes or fights are claimed, and the foot is still RANKINGS (opens that
 * owner) + FIND MATCH locked with [TOURNEY_UNOBSERVED_REASON].
 */

/** Everything the TOURNEY tab draws (SPEC §5.3 `TourneyUiState`). */
@Immutable data class ClanTourneyUi(
    val eventId: String,
    /** "Week 41 · 16 clans" or "…". */
    val weekLine: String,
    val phase: TourneyPhase,
    val entered: Boolean,
    /** "Mira" (who entered the clan); null when not entered. */
    val enteredBy: String?,
    val enteredByTier: Int,
    /** "Roster locked: 12 of 18. You are in." (or the open-roster line). */
    val rosterLine: String,
    val inRoster: Boolean,
    val amCaptain: Boolean,
    /** The prize chest (authored icons at 32 + counts); empty hides the section. */
    val prizes: List<ItemTileUi>,
    val fightsUsed: Int?,
    val fightsMax: Int?,
    /** "Battles open Thu 18:00 UTC · 1d 4h". */
    val opensIn: String?,
    /** "Last time: 4th of 16"; null hides the row. */
    val lastTitle: String?,
    /** "You won 2 of 3 · prize collected". */
    val lastSub: String?,
    val prizeClaimable: Boolean = false,
    /** No invented event/entry/result when its separate existing owner has not supplied a read. */
    val observationKnown: Boolean = true,
)

/** Why FIND MATCH is locked while no event read exists here: matches are found with the existing tournament owner. */
internal const val TOURNEY_UNOBSERVED_REASON = "Tournament matches are found in Clan Tournaments & Prizes."

/** The TOURNEY foot's primary: [tourneyLook] for an observed event, otherwise FIND MATCH locked with its reason. */
internal fun clanTourneyFooterLook(ui: ClanTourneyUi): PrimaryLook =
    if (!ui.observationKnown) PrimaryLook("FIND MATCH", null, Verb.RED, CommandState.LOCKED, TOURNEY_UNOBSERVED_REASON)
    else tourneyLook(ui.phase, ui.entered, ui.amCaptain, ui.inRoster, ui.fightsUsed, ui.fightsMax, ui.opensIn, ui.prizeClaimable)

/** TOURNEY callbacks (SPEC §5.3). */
@Immutable data class ClanTourneyActions(
    /** FIND MATCH (battles open, in the roster, fights left). */
    val onFindMatch: () -> Unit = {},
    val onRankings: () -> Unit = {},
    /** ENTER CLAN (captain, entry open) → Seal. */
    val onEnter: () -> Unit = {},
    /** Last time's row → past results. */
    val onPast: () -> Unit = {},
    /** CLAIM PRIZE → to the selected kingdom. */
    val onClaimPrize: () -> Unit = {},
    /** A locked primary was tapped: toast this reason. */
    val onExplain: (String) -> Unit = {},
)

/** The TOURNEY body (non-scrolling; the host's slot scrolls it). Pointer rule: only its rows and buttons take touches. */
@Composable fun ClanTourneyBody(ui: ClanTourneyUi, on: ClanTourneyActions, modifier: Modifier = Modifier, withActions: Boolean = true) {
    val c = PkwTokens.Colors
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        AccountCard(Modifier.fillMaxWidth(), rim = if (ui.entered) c.green.face else null, face = if (ui.entered) AccountColors.readyFace else c.cream) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Well("trophy", size = 64.dp, light = true, iconSize = 36.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    PkwText("CLAN TOURNAMENT", PkwTokens.Type.label, color = c.textOnParch)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PkwText(ui.weekLine, PkwTokens.Type.body, Modifier.weight(1f, fill = false), color = c.textOnParch)
                        if (ui.entered) StatusTag("ENTERED", Verb.GREEN)
                    }
                }
            }
        }
        if (!ui.observationKnown) {
            NoteLine("Event phase, entry, fights and prizes are read in Clan Tournaments & Prizes.")
            if (withActions) Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                ClanTourneyFooter(ui, on, onDark = false)
            }
            return@Column
        }
        PhaseTrack(tourneySteps(ui.phase, ui.entered))
        CardRow(height = 64.dp) {
            Well(keepPortrait(ui.enteredByTier), size = 48.dp, iconSize = 36.dp)
            RowText(ui.enteredBy?.let { "$it entered the clan" } ?: "Not entered yet", ui.rosterLine)
        }
        if (ui.prizes.isNotEmpty()) {
            SectionHeader("PRIZE CHEST", note = "shared by rank")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                ui.prizes.take(4).forEach { prize ->
                    AccountCard(Modifier.size(72.dp, 80.dp).clearAndSetSemantics { contentDescription = prize.description },
                        horizontalAlignment = Alignment.CenterHorizontally, contentPadding = 6.dp) {
                        HubArt(prize.icon, 32.dp)
                        PkwText(prize.count, PkwTokens.Type.caption, color = c.textOnParch)
                    }
                }
            }
        }
        val used = ui.fightsUsed; val max = ui.fightsMax
        SectionHeader("YOUR FIGHTS", note = "${max?.toString() ?: UNKNOWN} per tournament", right = "${used?.toString() ?: UNKNOWN} of ${max?.toString() ?: UNKNOWN}")
        pipFills(used, max)?.let { Pips(it, "Fights used ${fractionText(used, max)}", height = 18.dp) }
        if (ui.lastTitle != null) CardRow(height = 64.dp, onClick = on.onPast, description = listOfNotNull(ui.lastTitle, ui.lastSub).joinToString(". ")) {
            Well("replay", size = 48.dp, light = true, iconSize = 36.dp)
            RowText(ui.lastTitle, ui.lastSub)
            RowChevron()
        }
        if (withActions) Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
            ClanTourneyFooter(ui, on, onDark = false)
        }
    }
}

/**
 * RANKINGS 112 × 60 + the tournament primary ([tourneyLook]): FIND MATCH red when battles are open, otherwise locked
 * with its reason ("Battles open Thu 18:00 UTC · 1d 4h"); ENTER CLAN / CLAIM PRIZE gold. [onDark] draws the reason in
 * the dark-plate colour (on the wood foot).
 */
@Composable fun RowScope.ClanTourneyFooter(ui: ClanTourneyUi, on: ClanTourneyActions, onDark: Boolean = true) {
    val look = clanTourneyFooterLook(ui)
    SecondaryButton("RANKINGS", on.onRankings, Modifier.width(112.dp).heightIn(min = 60.dp),
        contentDescription = if (ui.observationKnown) "Tournament rankings" else "Tournament rankings, in Clan Tournaments and Prizes")
    PrimaryButton(look.label, {
        when (primaryTap(look)) {
            PrimaryTap.ACT -> when (look.label) {
                "ENTER CLAN" -> on.onEnter()
                "CLAIM PRIZE" -> on.onClaimPrize()
                else -> on.onFindMatch()
            }
            PrimaryTap.EXPLAIN -> look.reason?.let(on.onExplain)
            PrimaryTap.NEED_MORE, PrimaryTap.IGNORE -> Unit
        }
    }, Modifier.weight(1f), verb = look.verb, sub = look.sub, state = look.state, reason = look.reason, reasonOnDark = onDark,
        icon = if (look.label == "FIND MATCH" && look.state != CommandState.LOCKED) "attack" else null)
}

/** The 3-step track: 28 dp squares (green done, gold current / next, empty to come) over PS 11 labels. Paint only. */
@Composable private fun PhaseTrack(steps: List<StepTone>) {
    val c = PkwTokens.Colors
    val labels = listOf("ENTRY", "BATTLES", "RESULTS")
    Row(Modifier.fillMaxWidth().clearAndSetSemantics {
        contentDescription = labels.zip(steps).joinToString(", ") { (l, s) -> "$l ${s.name.lowercase()}" }
    }) {
        labels.zip(steps).forEach { (label, tone) ->
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val face = when (tone) { StepTone.DONE -> c.green.face; StepTone.CURRENT -> c.gold.face; StepTone.TODO -> AccountColors.emptyStep }
                Box(Modifier.size(28.dp).drawBehind {
                    val w = size.width; val h = size.height; val i = 2.dp.toPx()
                    fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
                    insideStepped(i, i, w - i, h - i, CornerProfiles.S) { drawRect(face); band(i, w - i, i, 2.dp.toPx(), c.label.copy(alpha = 0.25f)) }
                })
                PkwText(label, PkwTokens.Type.caption, color = c.textOnParch)
            }
        }
    }
}

// ---- Previews (clan-tourney.png and the SPEC's states) ----

@Preview(name = "Clan TOURNEY (clan-tourney.png)", widthDp = 412, heightDp = 915)
@Composable private fun ClanTourneyPreview() {
    HubPreviewStage {
        ClanSheet(sampleClanShell.copy(selectedTab = "TOURNEY"), ClanActions(), Modifier.fillMaxSize(),
            tourney = { ClanTourneyBody(sampleTourney, ClanTourneyActions()) })
    }
}

@Preview(name = "Clan TOURNEY body: battles open / captain not entered / not in roster", widthDp = 412, heightDp = 1400)
@Composable private fun ClanTourneyStatesPreview() {
    Column(Modifier.fillMaxSize().background(PkwTokens.Colors.parchment).padding(8.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(24.dp)) {
        ClanTourneyBody(sampleTourney.copy(phase = TourneyPhase.BATTLES, fightsUsed = 1), ClanTourneyActions())
        ClanTourneyBody(sampleTourney.copy(entered = false, enteredBy = null, amCaptain = true, rosterLine = "Roster opens when you enter"), ClanTourneyActions())
        ClanTourneyBody(sampleTourney.copy(phase = TourneyPhase.BATTLES, inRoster = false, rosterLine = "Roster locked: 12 of 18."), ClanTourneyActions())
        ClanTourneyBody(sampleTourney.copy(phase = TourneyPhase.RESULTS, prizeClaimable = true), ClanTourneyActions())
    }
}
