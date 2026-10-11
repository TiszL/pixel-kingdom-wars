@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package gg.pixelkingdomwars.nativeclient.ui.sheets.map

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.CommandRoute
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.commandDrawState
import gg.pixelkingdomwars.nativeclient.ui.kit.commandRoute
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: the kingdom sheet on the realm map and the globe's parcel panel (design/final/map/SPEC.md §2.3,
 * map-base.png). The header names the kingdom with its blue LV tag and the red X; Row 1 is the 76 dp snow well with the
 * keep portrait beside the shield and realm tags; Row 2 the cream "Loot is hidden until you scout" row (a rival only);
 * the facts open behind INFO; the command row is stone INFO, blue SCOUT (looking is navigation, DS §2) and the red
 * ATTACK primary last, under the right thumb. Your own kingdom is the header and a blue GO HOME only. Open land, held or
 * reserved land, the loading silhouette and a refused read use the same frame with their one primary. A half sheet.
 *
 * Not drawn, because the parcel read carries no field for it (SPEC §2.3 mock): the energy CostPill "1 of 3", the league,
 * and the "Clan: ... seen 2h ago" line; trophies and clan are facts behind INFO only when the read has them. Raids are
 * instant, so no copy here implies a trip.
 */

/** Which body the kingdom sheet draws (SPEC §2.3 states). */
enum class KingdomSheetKind {
    /** Another player's kingdom, with the parcel read's actions: INFO, SCOUT, ATTACK. */
    RIVAL,
    /** Your own deed: header + GO HOME (active) or MANAGE DEED. No SCOUT or ATTACK. */
    OWN,
    /** The parcel read is running: the map's silhouette (name, level), no commands. */
    LOADING,
    /** Open land: CHOOSE THIS LAND. */
    OPEN_LAND,
    /** Held, reserved or uninspectable land: its reason line, RETRY only after a failed re-read. */
    CLOSED_LAND,
    /** The read was refused: its words, and CHOOSE LAND (land gate) or RETRY. */
    FAILED,
}

/** Everything the kingdom sheet draws (SPEC §2.3 `KingdomPanelUi`, widened to the parcel read's other states). */
@Immutable data class KingdomPanelUi(
    /** The selected deed (catalog tile id). */
    val tileId: Int,
    val kind: KingdomSheetKind,
    /** The kingdom's name (the map's `kingdomName` rule) or the deed's place ("Deed 12, 40", "Open deed"). */
    val title: String,
    /** The blue header tag ("LV 8"); null draws none. */
    val level: String?,
    /** The keep portrait (a GameArt name) in the 76 dp snow well; null draws no well. */
    val portrait: String?,
    /** Row 1 tags: shield state, "YOU CAN ATTACK", the realm. */
    val tags: List<MapTagUi>,
    /** The INFO facts, label to value; every value is the read's or the catalogue's. */
    val facts: List<Pair<String, String>>,
    /** One line under Row 1: the land's state, the read's refusal or "Loading details...". */
    val note: String?,
    /** Blue SCOUT (a rival only). */
    val scout: CommandUi?,
    /** The red ATTACK primary (a rival only); never priced, the read has no energy field. */
    val attack: CommandUi?,
    /** The sheet's one primary when it is not a rival: GO HOME, MANAGE DEED, CHOOSE THIS LAND, CHOOSE LAND, RETRY. */
    val primary: CommandUi?,
    /** A full-width secondary under the command row: NEXT OPEN DEED (choose mode) or the host's LOOK CLOSER. */
    val secondary: CommandUi?,
    /** INFO is offered and toggles [facts]; false draws [facts] (if any) in the body without a toggle. */
    val info: Boolean,
)

/** Kingdom sheet callbacks (SPEC §2.3). */
@Immutable data class KingdomPanelActions(
    /** An ENABLED SCOUT: the existing scout entry. */
    val onScout: () -> Unit = {},
    /** An ENABLED ATTACK: the existing raid entry. */
    val onAttack: () -> Unit = {},
    /** INFO: show or hide the facts. */
    val onInfo: () -> Unit = {},
    /** An ENABLED primary (the host routes it by its command id). */
    val onPrimary: () -> Unit = {},
    /** An ENABLED secondary. */
    val onSecondary: () -> Unit = {},
    /** A DISABLED or LOCKED command's tap: its reason (toast). Never silent. */
    val onExplain: (String) -> Unit = {},
    val onClose: () -> Unit = {},
)

/**
 * The kingdom sheet (SPEC §2.3). [infoOpen] is the host's INFO toggle.
 *
 * Pointer rule: a HALF sheet with no scrim; only the painted frame and its buttons take touches. A tap on empty map
 * closes it through the scene's own tap (the host), never through a scrim here.
 */
@Composable fun KingdomPanel(ui: KingdomPanelUi, on: KingdomPanelActions, infoOpen: Boolean, modifier: Modifier = Modifier) {
    val own = ui.kind == KingdomSheetKind.OWN
    val commands = ui.info || ui.scout != null || ui.attack != null || ui.primary != null || ui.secondary != null
    val footer: (@Composable ColumnScope.() -> Unit)? = if (commands) { { KingdomCommands(ui, on, infoOpen) } } else null
    // Your own kingdom: the header carries the keep face, since its body is empty (SPEC §2.3 "header + GO HOME").
    MapSheetFrame(ui.title, if (own) ui.portrait else null, on.onClose, modifier,
        tags = listOfNotNull(ui.level?.let { MapTagUi(it, Verb.BLUE) }), footer = footer) {
        if (!own) {
            if (ui.portrait != null || ui.tags.isNotEmpty()) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ui.portrait?.let { p ->
                        ArtWell(76.dp, MapColors.snowWell) {
                            MapIcon(p, 64.dp, contentDescription = listOfNotNull("Kingdom illustration", ui.level).joinToString(", "))
                        }
                    }
                    FlowRow(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        ui.tags.forEach { Tag(it.text, it.verb) }
                    }
                }
            }
            if (ui.kind == KingdomSheetKind.RIVAL && ui.scout != null) {
                MapRow(tint = PkwTokens.Colors.selectedTint) {
                    MapIcon("scout", 24.dp)
                    RowText("Loot is hidden until you scout", "Scout first to see loot and defences")
                }
            }
            ui.note?.let { ParchLine(it, secondary = ui.kind != KingdomSheetKind.FAILED) }
            if (ui.facts.isNotEmpty() && (infoOpen || !ui.info)) {
                MapSectionHeader("DETAILS")
                ui.facts.forEach { (label, value) -> FactLine(label, value) }
            }
        }
    }
}

/** The command row (SPEC §2.3): stone INFO 64 x 60, blue SCOUT flex 1, red ATTACK flex 1.25 last; or INFO + the one
 *  primary; then the full-width secondary. */
@Composable private fun KingdomCommands(ui: KingdomPanelUi, on: KingdomPanelActions, infoOpen: Boolean) {
    if (ui.info || ui.scout != null || ui.attack != null || ui.primary != null) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (ui.info) InfoButton(infoOpen, on.onInfo)
            // A reason both commands share is drawn once, under ATTACK; the SCOUT tap still explains it.
            ui.scout?.let { c -> CommandFace(c, Modifier.weight(1f), on, on.onScout, icon = c.icon, shownReason = c.reason?.takeIf { it != ui.attack?.reason }) }
            ui.attack?.let { c -> CommandFace(c, Modifier.weight(1.25f), on, on.onAttack) }
            ui.primary?.let { c -> CommandFace(c, Modifier.weight(1f), on, on.onPrimary) }
        }
    }
    ui.secondary?.let { c ->
        SecondaryButton(c.caption, { kingdomCommandTap(c, on.onSecondary, on.onExplain) }, Modifier.fillMaxWidth(), verb = c.verb,
            enabled = c.state != CommandState.BUSY)
    }
}

/** One 60 dp command face: a [PrimaryButton] in the command's verb and state. Every state but BUSY calls back. */
@Composable private fun CommandFace(c: CommandUi, modifier: Modifier, on: KingdomPanelActions, act: () -> Unit, icon: String? = null,
    shownReason: String? = c.reason) {
    PrimaryButton(c.caption, { kingdomCommandTap(c, act, on.onExplain) }, modifier, verb = c.verb, sub = c.sub,
        state = commandDrawState(c), reason = shownReason, badge = c.badge, icon = icon)
}

/** The stone INFO square (SPEC §2.3, 64 x 60): the info icon over its caption. */
@Composable private fun InfoButton(open: Boolean, onClick: () -> Unit) {
    ChunkyBox(PkwTokens.Colors.stone, onClick, if (open) "Hide details" else "Info", Modifier.size(64.dp, 60.dp),
        stateDescription = if (open) "Details shown" else null) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            PkwIcon("info", 24.dp)
            PkwText("INFO", PkwTokens.Type.caption, color = PkwTokens.Colors.label, outline = 1.dp)
        }
    }
}

/** One fact behind INFO: PS 11 label, VT 20 value. */
@Composable private fun FactLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) { }, verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PkwText(label.uppercase(), PkwTokens.Type.caption, Modifier.width(96.dp), color = PkwTokens.Colors.textOnParch2)
        PkwText(value, PkwTokens.Type.body, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch, maxLines = 2)
    }
}

/** A command tap ([commandRoute]): ENABLED acts; BUSY does nothing, so nothing is sent twice; any other state explains
 *  its reason, never silently. */
internal fun kingdomCommandTap(c: CommandUi, act: () -> Unit, explain: (String) -> Unit) {
    when (commandRoute(c)) {
        CommandRoute.OPEN -> act()
        CommandRoute.IGNORE -> Unit
        CommandRoute.EXPLAIN, CommandRoute.NEED_MORE -> explain(c.reason ?: c.caption)
    }
}

// ---- Preview ----

private val previewRival = KingdomPanelUi(1450, KingdomSheetKind.RIVAL, "Kaly", "LV 8", "ui_portrait_keep_t3",
    listOf(MapTagUi("NO SHIELD", Verb.RED), MapTagUi("YOU CAN ATTACK", Verb.RED), MapTagUi("FROSTVEIL", Verb.STONE)),
    listOf("Trophies" to "1,412", "Clan" to "EMB"), null,
    CommandUi(FeatureId("map.scout"), "scout", "SCOUT", null, false, CommandState.ENABLED, null, null, verb = Verb.BLUE),
    CommandUi(FeatureId("map.attack"), "attack", "ATTACK", null, true, CommandState.ENABLED, null, null, verb = Verb.RED, sub = "raid this kingdom"),
    null, null, true)

@Composable private fun KingdomHost(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(PkwTokens.Colors.bg).padding(horizontal = 4.dp), contentAlignment = Alignment.BottomCenter) { content() }
}

@Preview(name = "Rival kingdom (map-base)", widthDp = 412, heightDp = 915)
@Composable private fun KingdomPanelPreview() { KingdomHost { KingdomPanel(previewRival, KingdomPanelActions(), infoOpen = false) } }
