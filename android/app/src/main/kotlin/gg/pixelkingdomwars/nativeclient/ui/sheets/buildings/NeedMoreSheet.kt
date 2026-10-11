package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: the generic NeedMore half sheet (design/final/buildings/SPEC.md R2.2, need-more.png; DS CostPill
 * SHORT, arch §3.2). Every SHORT cost pill in the game opens this one sheet: what is missing per resource, where each is
 * produced, and one best door. It never spends anything; every button only navigates.
 */

/** One place that makes a missing resource (SPEC R2.2 `DoorUi`; named NeedMoreDoorUi because the UPGRADE sheet's
 *  `DoorUi` already exists in this package). */
@Immutable data class NeedMoreDoorUi(
    /** 24 / 64 px icon of the place ("gem", "ui:workshop-menu", "ui:market-menu", "shards"). */
    val icon: String,
    /** PS label ("GEMS TO SHARDS", "WORKSHOP", "GO TO MINES"). */
    val label: String,
    /** The live VT hint ("8,400 Shards ready to collect"); null draws none. */
    val hint: String?,
    /** Where it goes (spec type `Destination`: `GoldForge("GEMS")`, `Workshop("REFINE")`, `Market("BUY", item)`,
     *  `Harvester()`, `Lodge("SEND")`, `BuildShop("SUPPLIES")`); here its registry row. */
    val destination: FeatureId,
    /** The place is not built: charcoal + padlock + this line ("Build a Market at Keep 6"); the tap goes to the BuildShop
     *  card ([destination] should then be that card). Null = open. */
    val locked: String? = null,
)

/** One missing resource (SPEC R2.2 `ShortfallUi`). */
@Immutable data class ShortfallUi(
    /** The currency or item key ("shards", "crownsteel"). */
    val currency: String,
    /** Its icon (24 px at 36 dp, or 64 px art at 32 dp). */
    val icon: String,
    /** PS name ("SHARDS"). */
    val name: String,
    /** What the player has ("40,943", "…"). */
    val have: String,
    /** What is needed ("52,400", "…"). */
    val need: String,
    /** The shortfall ("11,457"); counts down live when a collect lands. */
    val more: String,
    /** Where it is produced, one VT line ("Dug at Mines, or made from Gems."). */
    val sourceLine: String,
    /** One or two doors (the best door is dropped here, see [blockDoors]). */
    val doors: List<NeedMoreDoorUi>,
)

/** Everything the NeedMore sheet draws (SPEC R2.2 `NeedMoreUi`). */
@Immutable data class NeedMoreUi(
    /** What it is for, the header's right line ("Workshop LV 3"). */
    val forLabel: String,
    /** One block per missing resource; more than three scroll. Empty = the shortfall disappeared: the host closes the sheet
     *  and posts "You have enough now". */
    val blocks: List<ShortfallUi>,
    /** The server's best door across all blocks: the blue primary with its live hint. */
    val best: NeedMoreDoorUi,
    /** True while the numbers are being refreshed (loading): the 2 dp stone line; doors stay enabled (they only navigate). */
    val stale: Boolean,
)

/** NeedMore callbacks (SPEC R2.2). */
class NeedMoreActions(
    /** A door (or the best door): the sheet closes (140 ms), the camera flies 400 ms `out`, the target plate pulses once. */
    val onDoor: (FeatureId) -> Unit,
    /** Red close / Back. */
    val onClose: () -> Unit,
)

/** At most this much of the screen (SPEC R2.2: "top y ≥ 457 so it stays within 50%"); the blocks scroll inside it. */
private val BLOCKS_MAX_H = 300.dp

/**
 * The NeedMore half sheet (need-more.png): header "NEED MORE · Workshop LV 3" + red close; one blood-rimmed ShortfallBlock
 * per missing resource (icon well 44, name + red "11,457 more", have / need, where it is made, 1-2 blue door buttons 52
 * tall); the blue best-door primary "GO TO MINES · 8,400 Shards ready to collect". Blue because every button goes to a
 * place: there is no gold or green on this surface. The host places it within the bottom half and slides it in 180 ms /
 * out 140 ms; blocks fade in with a 20 ms stagger.
 *
 * Pointer rule: a HALF sheet has NO scrim. This composable is one painted wood panel (a scene-input region); only its
 * buttons take taps, and the kingdom above it closes the sheet from the scene's own tap. Nothing here is full-screen,
 * clickable on empty space, a pointerInput root, a scrim or draggable.
 */
@Composable fun NeedMoreSheet(ui: NeedMoreUi, on: NeedMoreActions, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    Plate(PlateKind.WOOD, modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            HalfSheetHeader("NEED MORE", on.onClose, right = ui.forLabel)
            Spacer(Modifier.height(6.dp))
            if (ui.stale) LoadingLine(Modifier.padding(bottom = 4.dp))
            Plate(PlateKind.PARCHMENT, Modifier.fillMaxWidth(), contentPadding = PaddingValues(8.dp), blocksScene = false) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (ui.blocks.isEmpty()) {
                        PkwText("You have enough now.", PkwTokens.Type.body, Modifier.fillMaxWidth(), color = c.textOnParch, textAlign = TextAlign.Center)
                    } else Column(Modifier.fillMaxWidth().heightIn(max = BLOCKS_MAX_H).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        ui.blocks.forEach { ShortfallBlock(it, blockDoors(it.doors, ui.best), on) }
                    }
                    BestDoor(ui.best, on)
                }
            }
        }
    }
}

/** A `ShortfallBlock`: a cream card with a 3 dp blood rim. */
@Composable private fun ShortfallBlock(block: ShortfallUi, doors: List<NeedMoreDoorUi>, on: NeedMoreActions) {
    val c = PkwTokens.Colors
    TapCard(Modifier.fillMaxWidth(), rim = c.blood, padding = PaddingValues(start = 8.dp, top = 7.dp, end = 8.dp, bottom = 10.dp)) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {
                contentDescription = "${block.name}: need ${block.more} more. ${haveNeedLine(block.have, block.need)}. ${block.sourceLine}"
            }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.size(44.dp).background(c.ink).padding(2.dp).background(c.creamLo), contentAlignment = Alignment.Center) {
                    PkwIcon(block.icon, if (block.icon.startsWith("ui:")) 32.dp else 36.dp)
                }
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        PkwText(block.name, PkwTokens.Type.label, Modifier.weight(1f), color = c.textOnParch)
                        CountingText(block.more.ifBlank { UNKNOWN }, PkwTokens.Type.label, c.shortText)
                        PkwText(" more", PkwTokens.Type.label, color = c.shortText)
                    }
                    PkwText(haveNeedLine(block.have, block.need), PkwTokens.Type.small, color = c.textOnParch2)
                }
            }
            PkwText(block.sourceLine, PkwTokens.Type.small, Modifier.clearAndSetSemantics { }, color = c.textOnParch, maxLines = 2)
            if (doors.isNotEmpty()) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                doors.forEach { door -> DoorButton(door, on, Modifier.weight(1f)) }
            }
            doors.mapNotNull { it.locked }.forEach { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2, maxLines = 2) }
        }
    }
}

/** A blue door (52 tall: icon + PS label), or the charcoal padlocked door of a building that is not built yet. */
@Composable private fun DoorButton(door: NeedMoreDoorUi, on: NeedMoreActions, modifier: Modifier) {
    val locked = door.locked != null
    SecondaryButton(door.label, { on.onDoor(door.destination) }, modifier, verb = if (locked) Verb.CHARCOAL else Verb.BLUE,
        icon = if (locked) "shape:lock" else door.icon,
        contentDescription = listOfNotNull(door.label, door.locked ?: door.hint).joinToString(". "))
}

/** The blue best-door primary (60 tall): its icon, PS 14 label and the live VT hint. Never repeated as a block button. */
@Composable private fun BestDoor(door: NeedMoreDoorUi, on: NeedMoreActions) {
    PrimaryButton(door.label, { on.onDoor(door.destination) }, Modifier.fillMaxWidth(), verb = Verb.BLUE, icon = door.icon, sub = door.hint)
}

// ---- Previews ----

private val toMines = NeedMoreDoorUi("shards", "GO TO MINES", "8,400 Shards ready to collect", FeatureId("mine.collect"))
private val sampleNeedMore = NeedMoreUi(
    forLabel = "Workshop LV 3",
    blocks = listOf(
        ShortfallUi("shards", "shards", "SHARDS", "40,943", "52,400", "11,457", "Dug at Mines, or made from Gems.",
            listOf(NeedMoreDoorUi("gem", "GEMS TO SHARDS", null, FeatureId("goldforge.gems")), toMines)),
        ShortfallUi("crownsteel", "ui:crystal-fragments", "CROWNSTEEL", "8", "20", "12", "Refined at the Workshop, or sold at a stall.",
            listOf(NeedMoreDoorUi("ui:workshop-menu", "WORKSHOP", null, FeatureId("workshop.refine")),
                NeedMoreDoorUi("ui:market-menu", "MARKET", null, FeatureId("market.buy")))),
    ),
    best = toMines, stale = false,
)
private val previewActions = NeedMoreActions(onDoor = {}, onClose = {})

@Preview(name = "Need more: default (need-more.png)", widthDp = 412, heightDp = 915)
@Composable private fun NeedMoreDefaultPreview() = HalfSheetPreviewFrame { NeedMoreSheet(sampleNeedMore, previewActions, it) }

@Preview(name = "Need more: loading (have/need …, doors live)", widthDp = 412, heightDp = 915)
@Composable private fun NeedMoreLoadingPreview() = HalfSheetPreviewFrame {
    NeedMoreSheet(sampleNeedMore.copy(stale = true, blocks = sampleNeedMore.blocks.map { it.copy(have = UNKNOWN, need = UNKNOWN, more = UNKNOWN) }),
        previewActions, it)
}

@Preview(name = "Need more: locked door (no Market yet)", widthDp = 412, heightDp = 915)
@Composable private fun NeedMoreLockedPreview() = HalfSheetPreviewFrame {
    NeedMoreSheet(sampleNeedMore.copy(blocks = listOf(sampleNeedMore.blocks[1].copy(doors = listOf(
        NeedMoreDoorUi("ui:workshop-menu", "WORKSHOP", null, FeatureId("workshop.refine")),
        NeedMoreDoorUi("ui:market-menu", "MARKET", null, FeatureId("buildshop.market"), locked = "Build a Market at Keep 6")))),
        best = NeedMoreDoorUi("ui:workshop-menu", "GO TO WORKSHOP", "Refine 12 Crownsteel", FeatureId("workshop.refine.best"))), previewActions, it)
}

@Preview(name = "Need more: empty (enough now; the host closes it)", widthDp = 412, heightDp = 600)
@Composable private fun NeedMoreEmptyPreview() = HalfSheetPreviewFrame { NeedMoreSheet(sampleNeedMore.copy(blocks = emptyList()), previewActions, it) }
