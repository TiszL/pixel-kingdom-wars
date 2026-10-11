package gg.pixelkingdomwars.nativeclient.ui.sheets

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.IconSquare
import gg.pixelkingdomwars.nativeclient.ui.kit.ItemTile
import gg.pixelkingdomwars.nativeclient.ui.kit.PixelShapes
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.PrimaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileState
import gg.pixelkingdomwars.nativeclient.ui.model.ItemTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetFrameUi
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.model.TabUi
import gg.pixelkingdomwars.nativeclient.ui.model.TimerUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.kit.SheetFrame

/*
 * Design component: a REFERENCE sheet (DESIGN-SYSTEM §6 Sheet + Tabs + TroopCard + PrimaryButton + CostPill), the
 * Barracks TRAIN tab of design/final/army/train.png, built only from kit parts. It is not wired anywhere: it shows the
 * screen builders how SheetFrame (wood frame, header, tabs, scrolling parchment body, pinned footer), TabStrip (through
 * SheetFrameUi.tabs), cream cards, PriceChip and the one PrimaryButton compose together. The real Army sheet takes its
 * own `…Ui` from Codex's mapper; copy the structure, not the sample data.
 *
 * Pointer rule: the frame and every card are painted panels (scene-input regions); nothing here is full-screen. The
 * TALL sheet's 40 % scrim belongs to the SheetHost, under this frame, and only while the sheet is shown.
 */

/** One troop card of the sample (DESIGN-SYSTEM §6 TroopCard: 89 × 128 cream card, 60 dp portrait well, name, cost). */
@Immutable data class TroopCardSampleUi(
    val id: String,
    /** 56 px portrait art, drawn at 56 dp. */
    val portrait: String,
    val name: String,
    /** The level tag on the portrait ("L3"). */
    val level: String,
    /** How many the player owns ("2", "…"). */
    val owned: String,
    /** The per-troop cost; SHORT draws it red. */
    val price: PriceUi,
    /** How many are chosen for the next TRAIN (green rim, "+n" badge and the "−" button when > 0). */
    val chosen: Int,
    /** Non-null = locked: dimmed portrait, padlock and this reason ("Unlocks at Barracks 8"). */
    val lockedReason: String? = null,
)

/** Everything the sample TRAIN tab draws. Numbers arrive formatted; unknown is "…". */
@Immutable data class BarracksTrainSampleUi(
    val frame: SheetFrameUi,
    /** "ARMY CAMP" capacity line: current, chosen ("+9", gold), and capacity. */
    val campLabel: String,
    val campCurrent: String,
    val campChosen: String?,
    val campCapacity: String,
    /** Army fill (0..1) and the fill once queued + chosen troops land; null when unknown (draws an empty track). */
    val campFill: Float?,
    val campPending: Float?,
    /** "24 ready · 8 training · 9 chosen". */
    val legend: String,
    /** The training queue, head first. */
    val queue: List<ItemTileUi>,
    /** The Gems price to finish the queue now; null hides FINISH. */
    val finishPrice: PriceUi?,
    val troops: List<TroopCardSampleUi>,
    /** The total cost of the chosen troops and the VT line beside it ("+9 pts · 8m 30s"). */
    val total: PriceUi?,
    val totalLine: String?,
    /** The primary: "TRAIN 4" with the sub-line "joins the queue". */
    val trainLabel: String,
    val trainSub: String?,
    val trainState: CommandState,
    val trainReason: String?,
)

/** The sample's callbacks (state in, callbacks out). */
@Immutable data class BarracksTrainSampleActions(
    val onClose: () -> Unit = {},
    val onTab: (String) -> Unit = {},
    val onHistory: () -> Unit = {},
    val onQueue: (String) -> Unit = {},
    val onFinish: () -> Unit = {},
    val onLastArmy: () -> Unit = {},
    val onAdd: (String) -> Unit = {},
    val onRemove: (String) -> Unit = {},
    val onTrain: () -> Unit = {},
)

/**
 * The reference Barracks TRAIN sheet (train.png). [modifier] must give the frame a bounded height (the SheetHost does:
 * a TALL sheet runs from y 104 to the bottom).
 */
@Composable internal fun BarracksTrainSheetSample(ui: BarracksTrainSampleUi, on: BarracksTrainSampleActions, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    SheetFrame(ui.frame, onClose = on.onClose, modifier = modifier, onTab = on.onTab, onHistory = on.onHistory,
        header = {
            // Living header stand-in: the Barracks sprite on the right; the real sheet draws the scene with walking troops.
            PkwIcon("building-barracks", 112.dp, Modifier.align(Alignment.CenterEnd).padding(end = 16.dp))
        },
        footer = {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    ui.total?.let { PriceChip(it) }
                    ui.totalLine?.let { PkwText(it, PkwTokens.Type.small, color = c.textOnParch2) }
                }
                PrimaryButton(ui.trainLabel, on.onTrain, Modifier.weight(1f), sub = ui.trainSub, state = ui.trainState, reason = ui.trainReason)
            }
        }) {
        // Army camp capacity: what is ready, training and chosen, against the camp's room.
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            PkwText(ui.campLabel, PkwTokens.Type.label, Modifier.weight(1f), color = c.textOnParch)
            PkwText(ui.campCurrent, PkwTokens.Type.label, color = c.textOnParch)
            ui.campChosen?.let { PkwText(it, PkwTokens.Type.label, color = c.gold.lo) }
            PkwText(" / ${ui.campCapacity}", PkwTokens.Type.label, color = c.textOnParch)
        }
        ProgressBar(ui.campFill, description = "${ui.campLabel}: ${ui.legend}", pending = ui.campPending, height = 14.dp)
        PkwText(ui.legend, PkwTokens.Type.small, color = c.textOnParch2)

        // The queue, and FINISH with its Gems pill above it.
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ui.queue.forEach { ItemTile(it, on.onQueue) }
            Spacer(Modifier.weight(1f))
            ui.finishPrice?.let { price ->
                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    PriceChip(price)
                    SecondaryButton("FINISH", on.onFinish, verb = Verb.GREEN, contentDescription = "Finish the queue now. ${priceDescription(price)}")
                }
            }
        }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PkwText("TROOPS", PkwTokens.Type.label, color = c.textOnParch)
            PkwText("tap to add", PkwTokens.Type.small, Modifier.weight(1f), color = c.textOnParch2)
            SecondaryButton("LAST ARMY", on.onLastArmy)
        }
        ui.troops.chunked(4).forEach { row ->
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                row.forEach { TroopCardSample(it, on.onAdd, on.onRemove, Modifier.weight(1f)) }
                repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/** A troop card from kit parts: CREAM plate, a dark portrait well, the level [Tag], the name and a [PriceChip]. A tap adds
 *  one; the 48 dp stone "−" removes one. Locked cards still answer a tap so the caller can say why. */
@Composable private fun TroopCardSample(ui: TroopCardSampleUi, onAdd: (String) -> Unit, onRemove: (String) -> Unit, modifier: Modifier) {
    val c = PkwTokens.Colors
    val locked = ui.lockedReason != null
    val spoken = listOfNotNull(ui.name, ui.level, if (locked) ui.lockedReason else priceDescription(ui.price),
        if (ui.chosen > 0) "${ui.chosen} chosen" else null).joinToString(". ")
    Box(modifier) {
        Plate(PlateKind.CREAM,
            Modifier.fillMaxWidth().heightIn(min = PkwTokens.Dims.troopCardH)
                .then(if (ui.chosen > 0) Modifier.border(3.dp, c.green.face, PixelShapes.M) else Modifier)
                .clearAndSetSemantics {
                    contentDescription = spoken; role = Role.Button
                    if (locked) disabled()
                    onClick(label = if (locked) null else "Add one", action = { onAdd(ui.id); true })
                }
                .clickable(role = Role.Button) { onAdd(ui.id) }) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Box(Modifier.size(60.dp).background(c.card, PixelShapes.S), contentAlignment = Alignment.Center) {
                    PkwIcon(ui.portrait, 56.dp, alpha = if (locked) 0.35f else 1f)
                    if (locked) PkwIcon("shape:lock", 24.dp, tint = c.gold.face)
                    else {
                        Tag(ui.level, Verb.BLUE, Modifier.align(Alignment.BottomStart))
                        PkwText(ui.owned, PkwTokens.Type.caption, Modifier.align(Alignment.TopEnd).padding(end = 3.dp), color = c.label, outline = 1.dp)
                    }
                }
                if (locked) PkwText(ui.lockedReason.orEmpty(), PkwTokens.Type.small, color = c.textOnParch2, textAlign = TextAlign.Center, maxLines = 2)
                else {
                    PkwText(ui.name, PkwTokens.Type.small, color = c.textOnParch)
                    PriceChip(ui.price)
                }
            }
        }
        if (ui.chosen > 0) {
            IconSquare("shape:minus", Verb.STONE, { onRemove(ui.id) }, "Remove one ${ui.name}", Modifier.align(Alignment.TopStart).offset(x = (-6).dp, y = (-6).dp))
            Badge(BadgeUi("+${ui.chosen}", BadgeTone.READY, "${ui.chosen} chosen"), Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp))
        }
    }
}

private fun sampleTroop(id: String, name: String, level: String, owned: String, cost: String, chosen: Int = 0, short: Boolean = false) =
    TroopCardSampleUi(id, "ui_portrait_${id}_t1", name, level, owned,
        PriceUi(Currency.SHARDS, cost, if (short) PriceStatus.SHORT else PriceStatus.OK), chosen)

private val sampleTrainUi = BarracksTrainSampleUi(
    frame = SheetFrameUi("BARRACKS", null, SheetSize.TALL, listOf(
        TabUi("TRAIN", "ui:queue-status", "TRAIN", null, false),
        TabUi("ARMY", "army", "ARMY", null, false)), "TRAIN", titleTag = "LV 7",
        live = TimerUi("6m 30s", "All troops ready in 6 minutes 30 seconds"), history = true),
    campLabel = "ARMY CAMP", campCurrent = "32", campChosen = "+9", campCapacity = "50",
    campFill = 32f / 50f, campPending = 41f / 50f, legend = "24 ready · 8 training · 9 chosen",
    queue = listOf(
        ItemTileUi("q-highlander", "ui_portrait_highlander_t3", "x4", "4 Highlanders, 0:42 left", ItemTileState.SELECTED),
        ItemTileUi("q-bowman", "ui_portrait_bowman_t1", "x2", "2 Bowmen queued"),
    ),
    finishPrice = PriceUi(Currency.GEMS, "14", PriceStatus.OK),
    troops = listOf(
        sampleTroop("highlander", "Highlander", "L3", "2", "120", chosen = 3),
        sampleTroop("bowman", "Bowman", "L4", "1", "90"),
        sampleTroop("kegrunner", "Keg Runner", "L2", "1", "95"),
        sampleTroop("plunderer", "Plunderer", "L2", "1", "80"),
        sampleTroop("tunneler", "Tunneler", "L2", "2", "180"),
        sampleTroop("mage", "Mage", "L1", "3", "220", chosen = 1),
        sampleTroop("turrider", "Tur Rider", "L1", "5", "3.5K", short = true),
        TroopCardSampleUi("giant", "ui_portrait_giant_t1", "Giant", "L1", "…", PriceUi(Currency.SHARDS, null, PriceStatus.CHECKING), 0,
            lockedReason = "Unlocks at Barracks 8"),
    ),
    total = PriceUi(Currency.SHARDS, "580", PriceStatus.OK), totalLine = "+9 pts · 8m 30s",
    trainLabel = "TRAIN 4", trainSub = "joins the queue", trainState = CommandState.ENABLED, trainReason = null,
)

@Preview(name = "Reference sheet: Barracks TRAIN (train.png)", widthDp = 412, heightDp = 915)
@Composable private fun BarracksTrainSheetSamplePreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        BarracksTrainSheetSample(sampleTrainUi, BarracksTrainSampleActions(),
            Modifier.fillMaxSize().padding(start = 8.dp, end = 8.dp, top = PkwTokens.Dims.tallSheetTop))
    }
}

@Preview(name = "Reference sheet: TRAIN disabled with a reason", widthDp = 412, heightDp = 915)
@Composable private fun BarracksTrainSheetSampleBlockedPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        BarracksTrainSheetSample(sampleTrainUi.copy(campFill = null, campPending = null, legend = "…", finishPrice = null,
            trainState = CommandState.DISABLED, trainReason = "Army Camp is full"), BarracksTrainSampleActions(),
            Modifier.fillMaxSize().padding(start = 8.dp, end = 8.dp, top = PkwTokens.Dims.tallSheetTop))
    }
}

@Preview(name = "Troop cards", widthDp = 400, heightDp = 160)
@Composable private fun TroopCardSamplePreview() {
    Row(Modifier.background(PkwTokens.Colors.parchment).padding(10.dp).width(380.dp).height(140.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        sampleTrainUi.troops.filterIndexed { i, _ -> i in setOf(0, 1, 6, 7) }.forEach { TroopCardSample(it, {}, {}, Modifier.weight(1f)) }
    }
}
