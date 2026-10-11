package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi

/*
 * Design component: the Divine Isle panel (design/final/map/SPEC.md §5, divine-panel.png). No scene tonight: the panel
 * opens Solo Trials, Fragments and Clan Citadels directly. Two door cards (WEST Solo Trials, EAST Clan Citadels, locked
 * with art at 45 % + padlock and the reason line that goes to the Clan Hall), the lavender Crystal Fragments row with a
 * stone VIEW, and the gold SOLO TRIALS primary whose sub-line is the next state (a green "!" when a trial is ready).
 */

/** One door card (SPEC §5): side, art, title, sub-line, locked + reason. */
@Immutable data class DoorUi(
    /** "WEST" / "EAST". */
    val side: String,
    /** The 64 px site art ("site:divine-solo-active", "site:divine-clan-occupied"). */
    val art: String,
    /** "Solo Trials". */
    val title: String,
    /** "500 solo areas" (from the catalogue; "…" unknown). */
    val sub: String,
    /** Locked: art at 45 % + padlock; a tap explains [reason]. */
    val locked: Boolean = false,
    /** "Citadels: join a clan at the Clan Hall" / "Opens later on this server". */
    val reason: String? = null,
)

/** Everything the Divine panel draws (SPEC §5 `DivinePanelUi`). */
@Immutable data class DivinePanelUi(
    val solo: DoorUi,
    val clan: DoorUi,
    /** Your fragment count ("12"); "…" while unknown. */
    val fragments: String,
    /** SOLO TRIALS: caption, sub (the next state), badge (green "!" when a trial is ready), state. */
    val primary: CommandUi,
    /** The clan reason line opens the Clan Hall (false when the reason is a server-off note). */
    val clanHallLink: Boolean = true,
    /** "Win trials to hold land on the Divine Isle." */
    val intro: String = "Win trials to hold land on the Divine Isle.",
)

/** Divine panel callbacks (SPEC §5). */
@Immutable data class DivinePanelActions(
    /** The WEST door and the SOLO TRIALS primary: DivineTrials. */
    val onSolo: () -> Unit = {},
    /** The EAST door: Clan(TOURNAMENT) (registry row 90). */
    val onClan: () -> Unit = {},
    /** The clan reason line: GO to the Clan Hall. */
    val onClanHall: () -> Unit = {},
    /** VIEW: DivineFragments. */
    val onFragments: () -> Unit = {},
    /** A locked door or primary: its reason (toast). */
    val onExplain: (String) -> Unit = {},
    val onClose: () -> Unit = {},
)

/**
 * The Divine Isle panel (SPEC §5).
 *
 * Pointer rule: a HALF sheet with no scrim; only the painted frame, the two door cards and the buttons take touches.
 */
@Composable fun DivinePanel(ui: DivinePanelUi, on: DivinePanelActions, modifier: Modifier = Modifier) {
    MapSheetFrame("DIVINE ISLE", "ui:divine-navigation", on.onClose, modifier, footer = {
        val p = ui.primary
        val state = commandDrawState(p)
        PrimaryButton(p.caption, { if (state == CommandState.ENABLED) on.onSolo() else on.onExplain(p.reason ?: p.caption) }, Modifier.fillMaxWidth(),
            sub = p.sub, state = state, reason = p.reason, badge = p.badge)
    }) {
        ParchLine(ui.intro)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            DoorCard(ui.solo, { if (ui.solo.locked) on.onExplain(ui.solo.reason ?: ui.solo.title) else on.onSolo() }, Modifier.weight(1f))
            DoorCard(ui.clan, { if (ui.clan.locked) on.onExplain(ui.clan.reason ?: ui.clan.title) else on.onClan() }, Modifier.weight(1f))
        }
        val reason = ui.clan.reason
        if (ui.clan.locked && reason != null) ClanReasonLine(reason, if (ui.clanHallLink) on.onClanHall else null)
        MapRow(tint = PkwTokens.Colors.divine) {
            PkwIcon("ui:crystal-fragments", 32.dp)
            RowText("Crystal Fragments · ${ui.fragments.ifBlank { UNKNOWN }}", "Found on expeditions")
            SecondaryButton("VIEW", on.onFragments, Modifier.width(76.dp).heightIn(min = 46.dp), contentDescription = "View your Crystal Fragments")
        }
    }
}

/**
 * The lock reason under the door cards (SPEC §5, divine-panel.png): VT 18, right-aligned. The Clan Hall line is a refusal
 * on parchment, so it is drawn in [PkwTokens.Colors.shortText] (`#A3261A`, SPEC Round 2 honest note 4: never `danger` on
 * parchment) and the whole line, at least 48 dp tall, is the GO to the Clan Hall. A server-off note ([onClick] null) is a
 * plain reason in the secondary ink.
 */
@Composable private fun ClanReasonLine(reason: String, onClick: (() -> Unit)?) {
    val touch = onClick?.let { go ->
        Modifier.defaultMinSize(minHeight = PkwTokens.Dims.minTap).sceneInputRegion()
            .clearAndSetSemantics { contentDescription = "$reason. Go to the Clan Hall"; role = Role.Button; this.onClick(label = null, action = { go(); true }) }
            .clickable(role = Role.Button, onClick = go)
    } ?: Modifier
    Box(Modifier.fillMaxWidth().then(touch), contentAlignment = Alignment.CenterEnd) {
        PkwText(reason, PkwTokens.Type.small, color = if (onClick != null) PkwTokens.Colors.shortText else PkwTokens.Colors.textOnParch2,
            textAlign = TextAlign.End, maxLines = 2)
    }
}

/** A door card (SPEC §5): PS 11 side, 72 dp `#4A3F66` well with the 64 px art (45 % + padlock when locked), VT 20 title,
 *  VT 18 sub-line; 158 tall (mock padding 6 / 6 / 0); the whole card is a door. */
@Composable private fun DoorCard(ui: DoorUi, onClick: () -> Unit, modifier: Modifier) {
    val said = listOfNotNull(ui.side, ui.title, ui.sub, ui.reason?.takeIf { ui.locked }?.let { "Locked. $it" }).joinToString(". ")
    Plate(PlateKind.CREAM, modifier.heightIn(min = 158.dp).sceneInputRegion()
        .clearAndSetSemantics { contentDescription = said; role = Role.Button; this.onClick(label = null, action = { onClick(); true }) }
        .clickable(role = Role.Button, onClick = onClick)) {
        Column(Modifier.fillMaxWidth().padding(start = 6.dp, top = 6.dp, end = 6.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            PkwText(ui.side, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch2)
            ArtWell(72.dp, MapColors.divineWell, Modifier.padding(top = 2.dp)) {
                MapIcon(ui.art, 64.dp, alpha = if (ui.locked) 0.45f else 1f)
                if (ui.locked) PkwIcon("shape:lock", 24.dp, tint = PkwTokens.Colors.gold.face)
            }
            PkwText(ui.title, PkwTokens.Type.body, color = PkwTokens.Colors.textOnParch)
            PkwText(ui.sub.ifBlank { UNKNOWN }, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch2)
        }
    }
}

// ---- Previews ----

private val solo = DoorUi("WEST", "site:divine-solo-active", "Solo Trials", "500 solo areas")
private val clan = DoorUi("EAST", "site:divine-clan-occupied", "Clan Citadels", "Clan areas", locked = true,
    reason = "Citadels: join a clan at the Clan Hall")
private val trials = CommandUi(FeatureId("island.divine.trials"), "ui:divine-navigation", "SOLO TRIALS", null, true, CommandState.ENABLED, null,
    null, sub = "next trial opens in 2h")

@Composable private fun Host(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.bg).padding(horizontal = 4.dp), contentAlignment = Alignment.BottomCenter) { content() }
}

@Preview(name = "Divine Isle (divine-panel)", widthDp = 412, heightDp = 915)
@Composable private fun DivinePreview() { Host { DivinePanel(DivinePanelUi(solo, clan, "12", trials), DivinePanelActions()) } }

@Preview(name = "Trial ready", widthDp = 412, heightDp = 915)
@Composable private fun DivineReadyPreview() {
    Host {
        DivinePanel(DivinePanelUi(solo, clan.copy(locked = false, reason = null), "12",
            trials.copy(sub = "trial ready", badge = BadgeUi("!", BadgeTone.READY, "A trial is ready"))), DivinePanelActions())
    }
}

@Preview(name = "Server off + loading", widthDp = 412, heightDp = 915)
@Composable private fun DivineOffPreview() {
    val off = "Opens later on this server"
    Host {
        DivinePanel(DivinePanelUi(solo.copy(locked = true, reason = off, sub = UNKNOWN), clan.copy(reason = off, sub = UNKNOWN), UNKNOWN,
            trials.copy(state = CommandState.LOCKED, reason = off, sub = null), clanHallLink = false), DivinePanelActions())
    }
}
