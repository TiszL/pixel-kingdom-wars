package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Toast
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.currencyIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.ToastKind
import gg.pixelkingdomwars.nativeclient.ui.model.ToastUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: Barracks TRAIN (design/final/army/SPEC.md §2; train.png, train-full.png): the Army tall sheet's
 * TRAIN tab. Housing header + three-segment meter + legend, the training queue strip with FINISH (Gems, Seal), the
 * TROOPS section with LAST ARMY, the 4-column TroopCard grid (tap = +1, the 30 dp "−" in a 48 dp target takes one
 * back), and the pinned footer with the draft's Shards total and the gold TRAIN primary. Nothing is bought until TRAIN.
 */

/** A troop card's state (SPEC §2 TroopCard table). */
enum class TroopCardState {
    /** Tap adds one. */
    DEFAULT,
    /** At least one in the draft: green rim, "+n" badge, the "−" button. */
    CHOSEN,
    /** Not affordable: red cost; a tap says "Not enough Shards" on the Barracks (owner 2026-10-11), never navigates or auto-spends. */
    SHORT,
    /** Gated by the Barracks level or an unlock item: dim portrait, padlock, [TroopCardUi.lockReason]. */
    LOCKED,
    /** The camp and queue have no room: the grid is dimmed; a tap shows the reason. */
    NO_ROOM,
}

/** One queued training group (SPEC §2 `QueueStrip`). The first group shows its time and meter. */
@Immutable data class QueueGroupUi(
    /** Troop id. */
    val troop: String,
    /** 56 px portrait, drawn at 28 dp. */
    val portrait: String,
    /** How many in this group. */
    val count: Int,
    /** Seconds until the group's first troop is ready (head chip only); null = "…". */
    val firstRemainingSec: Long?,
    /** 0..1 of the head troop trained; null draws an empty meter. */
    val firstProgress: Float?,
    /** Screen-reader text ("4 Highlanders training, next in 42 seconds"). */
    val description: String = "",
)

/** One troop card (SPEC §2 `TroopCard`). */
@Immutable data class TroopCardUi(
    /** Troop id; handed back by every callback. */
    val troop: String,
    /** Display name ("Highlander"). */
    val name: String,
    /** 56 px portrait (`ui_portrait_<troop>_t<n>`). */
    val portrait: String,
    /** The level tag ("L3"). */
    val level: String,
    /** Housing points per troop, the pip ("2", "…"). */
    val pts: String,
    /** The per-troop Shards price; SHORT draws it red. */
    val price: PriceUi,
    /** Card state. */
    val state: TroopCardState,
    /** How many are in the draft. */
    val chosen: Int,
    /** LOCKED only: the reason in two short lines ("Unlocks at Barracks 8", "Needs an unlock item"). */
    val lockReason: String?,
    /** LOCKED only: where the unlock is earned (spec: `Destination`; here the registry row that opens it, e.g. the
     *  Barracks upgrade or the Gold Forge). */
    val lockDoor: FeatureId?,
)

/** Everything the TRAIN tab draws (SPEC §2 `TrainUi`). */
@Immutable data class TrainUi(
    /** Barracks header; chip "All ready in 6m 30s", or "Barracks ready" when the queue is empty. */
    val header: SheetHeaderUi,
    /** Ready, training, draft and capacity in points. */
    val housing: HousingUi,
    /** The queue, head first; empty collapses the strip (no FINISH). */
    val queue: List<QueueGroupUi>,
    /** FINISH (Gems price CHECKING / UNAVAILABLE / SHORT / OK); null when the queue is empty. Opens the Seal. */
    val finish: CommandUi?,
    /** Server "one free finish for your first army": FINISH reads FREE only with a SERVER_ZERO price. */
    val freeFinish: Boolean,
    /** Troop cards in catalogue unlock order. */
    val troops: List<TroopCardUi>,
    /** LAST ARMY; DISABLED with a reason when there is no previous army; null hides it. */
    val lastArmy: CommandUi?,
    /** Draft total price, "+9 pts · 8m 30s", primary "TRAIN n" (DISABLED with reason, BUSY "Sending", LOCKED). */
    val footer: FooterUi,
    /** True while the server has not answered: with no troops yet, skeleton cards; otherwise the last good view stays. */
    val loading: Boolean = false,
    /** True while the Barracks upgrades and the server pauses training: the whole panel at 60 % (the primary carries the
     *  LOCKED reason "Barracks is upgrading · 2h 10m"). */
    val paused: Boolean = false,
    /** The portrait on the ARMY tab. */
    val armyTabPortrait: String = "ui_portrait_highlander_t1",
)

/** TRAIN's callbacks (SPEC §1.2 + §2). */
@Immutable data class TrainActions(
    val onClose: () -> Unit = {},
    /** History: WalletHistory / BattleLog filtered to this home. */
    val onHistory: () -> Unit = {},
    /** TRAIN ↔ ARMY. */
    val onTab: (String) -> Unit = {},
    /** A tap on the sheet-mode resource stack opens the drawer at that row (spec `onResourceRow(currency)`). */
    val onResourceRow: (FeatureId) -> Unit = {},
    /** +1 of a troop to the draft (no confirm). */
    val onAdd: (String) -> Unit = {},
    /** −1 of a troop from the draft. */
    val onRemove: (String) -> Unit = {},
    /** Fill the draft with the last army (trimmed to the room left). */
    val onLastArmy: () -> Unit = {},
    /** One server order for the whole draft; Shards only, no Seal. */
    val onTrain: () -> Unit = {},
    /** Opens the Seal "FINISH TRAINING · Gems n". */
    val onFinish: () -> Unit = {},
    /** A locked card: half sheet with the reason and the GO ([TroopCardUi.lockDoor]). */
    val onLocked: (String) -> Unit = {},
    /** A short card: the host's "Not enough Shards" message on this sheet; it stays on the Barracks (owner 2026-10-11). */
    val onShort: (String) -> Unit = {},
    /** A queue chip: the tooltip plate with that group's start and finish times. */
    val onQueueChip: (Int) -> Unit = {},
    /** A card tapped while the camp is full: the reason toast. */
    val onNoRoom: (String) -> Unit = {},
    /** A SHORT price pill or command: the Need-more half sheet for that price. */
    val onNeedMore: (PriceUi) -> Unit = {},
    /** A DISABLED / LOCKED command was tapped: the host shows its reason toast. */
    val onRefused: (CommandUi) -> Unit = {},
)

/**
 * The Barracks TRAIN sheet (train.png). [modifier] must give it a bounded height (the SheetHost's TALL slot, y 104 to the
 * bottom).
 *
 * Pointer rule: this is a painted panel inside the SheetHost; it is not full-screen, has no scrim, clickable root or
 * pointerInput of its own. Only the frame, cards and buttons take touches; the host's 40 % TALL scrim exists only while
 * the sheet is shown.
 */
@Composable fun TrainSheet(ui: TrainUi, on: TrainActions, modifier: Modifier = Modifier) {
    ArmyTallSheet(ui.header, armyTabs(ARMY_TAB_TRAIN, ui.queue.size, ui.armyTabPortrait), ARMY_TAB_TRAIN,
        on.onClose, on.onHistory, on.onTab, modifier,
        footer = { TrainFooter(ui, on) }) { TrainBody(ui, on) }
}

/** The TRAIN tab's footer: the draft's Shards pill and its VT line in ink (train.png); when the camp and queue are full
 *  the off TRAIN's reason is VT 18 `#A3261A` (train-full.png). */
@Composable internal fun TrainFooter(ui: TrainUi, on: TrainActions) {
    ArmyFooter(ui.footer, on.onTrain, on.onNeedMore, on.onRefused, infoWidth = 132.dp, infoColor = PkwTokens.Colors.textOnParch,
        reasonColor = if (ui.housing.full) PkwTokens.Colors.shortText else null)
}

/** The TRAIN tab's body (shared with [ArmySheet]). */
@Composable internal fun ColumnScope.TrainBody(ui: TrainUi, on: TrainActions) {
    val sending = ui.footer.primary.state == CommandState.BUSY
    val frozen = sending || ui.paused
    Column(Modifier.fillMaxWidth().dimmed(ui.paused, 0.6f, 1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        HousingBlock(ui.housing)
        if (ui.queue.isNotEmpty()) QueueStrip(ui, on)
        // train-full.png: "no room right now" is the ordinary VT 18 hint ink; the red is the footer's reason.
        SectionLine("TROOPS", if (ui.housing.full) "no room right now" else "tap to add") {
            ui.lastArmy?.let { cmd ->
                val off = effectiveState(cmd) != CommandState.ENABLED
                SecondaryButton(cmd.caption, { routeCommand(cmd, on.onLastArmy, on.onNeedMore, on.onRefused) }, Modifier.size(124.dp, 44.dp),
                    verb = if (off) Verb.OFF else Verb.STONE,
                    contentDescription = listOfNotNull(cmd.caption, cmd.reason?.takeIf { off }).joinToString(". "))
            }
        }
        if (ui.loading && ui.troops.isEmpty()) SkeletonGrid(4, 8, PkwTokens.Dims.troopCardH)
        else CellGrid(ui.troops, 4, modifier = Modifier.padding(top = 6.dp).dimmed(ui.housing.full, 0.6f, 0.5f)) { t, m ->
            TroopCard(t, frozen, on, m)
        }
    }
}

/** The queue strip: the head chip (118 × 52, gold rim, time + meter), the rest (52 × 52, count), and FINISH on the right
 *  with its Gems pill. Chips slide in from the right over 160 ms when they appear. */
@Composable private fun QueueStrip(ui: TrainUi, on: TrainActions) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ui.queue.forEachIndexed { i, g ->
                key(g.troop, i) {
                    Box(Modifier.enterFromRight()) {
                        if (i == 0) QueueHeadChip(g) { on.onQueueChip(0) } else QueueChip(g) { on.onQueueChip(i) }
                    }
                }
            }
        }
        ui.finish?.let { cmd ->
            val priced = cmd.copy(price = cmd.price?.let { finishPrice(it, ui.freeFinish) })
            FinishButton(priced, on.onFinish, on.onNeedMore, on.onRefused)
        }
    }
}

@Composable private fun QueueHeadChip(g: QueueGroupUi, onClick: () -> Unit) {
    val time = armyDuration(g.firstRemainingSec)
    ArmyCard(Modifier.size(118.dp, 52.dp), body = PkwTokens.Colors.selectedTint, rim = PkwTokens.Colors.gold.face, rimWidth = 2.dp,
        padding = PaddingValues(start = 4.dp, top = 3.dp, end = 5.dp, bottom = 5.dp), onClick = onClick,
        description = g.description.ifBlank { "${g.count} ${g.troop} training, next in $time" }) {
        Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            MiniPortrait(g.portrait)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    PkwText("x${g.count}", PkwTokens.Type.caption, Modifier.weight(1f), color = PkwTokens.Colors.textOnParch)
                    PkwText(time, PkwTokens.Type.small, color = PkwTokens.Colors.textOnParch)
                }
                ParchMeter(g.firstProgress, "Head of the queue: $time left", height = 10.dp)
            }
        }
    }
}

@Composable private fun QueueChip(g: QueueGroupUi, onClick: () -> Unit) {
    ArmyCard(Modifier.size(52.dp), padding = PaddingValues(4.dp), onClick = onClick,
        description = g.description.ifBlank { "${g.count} ${g.troop} queued" }) {
        MiniPortrait(g.portrait, Modifier.align(Alignment.TopStart), count = "x${g.count}")
    }
}

/** Slides a newly composed element in from the right (12 dp, 160 ms `out`); reduced motion and previews skip it. */
@Composable private fun Modifier.enterFromRight(): Modifier {
    val still = LocalReducedMotion.current || LocalInspectionMode.current
    val t = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) { if (!still) t.animateTo(1f, tween(PkwTokens.Motion.PLATE_IN, easing = PkwTokens.Motion.Out)) }
    return this.graphicsLayer { translationX = (1f - t.value) * 24.dp.toPx(); alpha = t.value }
}

/**
 * One TroopCard (89 × 128): the portrait well with the level tag and the housing pip, the name and the per-troop cost.
 * CHOSEN: 3 dp green rim, "+n" badge (pops 180 ms on every change) and the "−" step. LOCKED: locked body, dim portrait,
 * padlock and the reason. Taps are routed by [troopTap]; while TRAIN is sending ([frozen]) cards ignore taps.
 */
@Composable private fun TroopCard(t: TroopCardUi, frozen: Boolean, on: TrainActions, modifier: Modifier) {
    val c = PkwTokens.Colors
    val locked = t.state == TroopCardState.LOCKED
    val short = t.state == TroopCardState.SHORT || t.price.status == PriceStatus.SHORT
    val tap = {
        when (troopTap(t.state, frozen)) {
            TroopTap.ADD -> on.onAdd(t.troop)
            TroopTap.NEED_MORE -> on.onShort(t.troop)
            TroopTap.LOCKED -> on.onLocked(t.troop)
            TroopTap.NO_ROOM -> on.onNoRoom(t.troop)
            TroopTap.IGNORE -> Unit
        }
    }
    val spoken = if (locked) "${t.name}, locked. ${t.lockReason ?: ""}"
    else listOfNotNull(t.name, "level ${t.level}", "${t.pts} housing", priceDescription(t.price),
        if (t.chosen > 0) "${t.chosen} chosen" else null, if (t.state == TroopCardState.NO_ROOM) "no room" else "tap to add one").joinToString(", ")
    Box(modifier) {
        ArmyCard(Modifier.fillMaxWidth().height(PkwTokens.Dims.troopCardH), body = if (locked) ArmyInk.lockedBody else null,
            rim = if (t.chosen > 0) c.green.face else null, padding = PaddingValues(start = 4.dp, top = 6.dp, end = 4.dp, bottom = 8.dp),
            onClick = tap, description = spoken, pressable = !frozen) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Box(contentAlignment = Alignment.Center) {
                    // army.css `.tc.lock`: the dark well, the portrait fully grey at brightness 0.45, the gold padlock.
                    PortraitWell(t.portrait, level = if (locked) null else t.level, pip = if (locked) null else t.pts,
                        saturation = if (locked) 0f else 1f, brightness = if (locked) 0.45f else 1f,
                        well = if (locked) ArmyInk.lockedWell else ArmyInk.well)
                    if (locked) PkwIcon("shape:lock", 22.dp, tint = c.gold.face)
                }
                if (locked) {
                    PkwText(t.lockReason ?: UNKNOWN, PkwTokens.Type.small, color = c.textOnParch, textAlign = TextAlign.Center, maxLines = 2)
                } else {
                    PkwText(t.name, PkwTokens.Type.small, color = c.textOnParch)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                        PkwIcon(currencyIcon(t.price.currency, t.price.icon), 24.dp)
                        PkwText(priceText(t.price), PkwTokens.Type.caption, color = if (short) c.shortText else c.textOnParch)
                    }
                }
            }
        }
        if (t.chosen > 0) {
            SmallStep("shape:minus", { if (!frozen) on.onRemove(t.troop) }, "Take one ${t.name} back",
                Modifier.align(Alignment.TopStart).offset(x = (-13).dp, y = (-15).dp))
            key(t.chosen) {
                Badge(BadgeUi("+${t.chosen}", BadgeTone.READY, "${t.chosen} chosen"), Modifier.align(Alignment.TopEnd).offset(x = 4.dp, y = (-6).dp))
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Previews (every number is placeholder sample data; real values come from the mapper)
// ---------------------------------------------------------------------------------------------------------------------

internal object TrainSamples {
    private fun troop(id: String, name: String, level: String, pts: String, cost: String, chosen: Int = 0, state: TroopCardState? = null,
        lock: String? = null) = TroopCardUi(id, name, "ui_portrait_${id}_t1", level, pts,
        ArmySamples.shards(cost, if (state == TroopCardState.SHORT) PriceStatus.SHORT else PriceStatus.OK),
        state ?: if (lock != null) TroopCardState.LOCKED else if (chosen > 0) TroopCardState.CHOSEN else TroopCardState.DEFAULT, chosen, lock,
        if (lock != null) FeatureId("barracks.upgrade") else null)

    val header = SheetHeaderUi("BARRACKS", "LV 7", HeaderChipUi("timer", "All ready in", "6m 30s"),
        HeaderArtUi(SpriteRef("ui_portrait_barracks_t3", 56), 1,
            ArmySamples.walkers(listOf("ui_portrait_highlander_t3", "ui_portrait_bowman_t1", "ui_portrait_mage_t1", "ui_portrait_tunneler_t1"), Dir8.W, 54),
            buildingXDp = 250, buildingYDp = 4))
    val troops = listOf(
        troop("highlander", "Highlander", "L3", "2", "120", chosen = 3),
        troop("bowman", "Bowman", "L4", "1", "90"),
        troop("kegrunner", "Keg Runner", "L2", "1", "95"),
        troop("plunderer", "Plunderer", "L2", "1", "80"),
        troop("tunneler", "Tunneler", "L2", "2", "180"),
        troop("mage", "Mage", "L1", "3", "220", chosen = 1),
        troop("turrider", "Tur Rider", "L1", "5", "3.5K", state = TroopCardState.SHORT),
        troop("giant", "Giant", "L1", "7", "…", lock = "Unlocks at Barracks 8"),
        troop("bilgewraith", "Bilgewraith", "L1", "2", "400"),
        troop("direwyvern", "Dire Wyvern", "L1", "8", "…", lock = "Needs an unlock item"),
    )
    val queue = listOf(
        QueueGroupUi("highlander", "ui_portrait_highlander_t3", 4, 42, 0.55f),
        QueueGroupUi("mage", "ui_portrait_mage_t1", 2, null, null),
        QueueGroupUi("bowman", "ui_portrait_bowman_t1", 1, null, null),
    )
    val default = TrainUi(
        header = header,
        housing = HousingUi(ready = 24, training = 8, draft = 9, capacity = 50, queueCap = 20, full = false),
        queue = queue,
        finish = CommandUi(FeatureId("barracks.finish"), "", "FINISH", ArmySamples.gems("14"), false, CommandState.ENABLED, null, null, verb = Verb.GREEN),
        freeFinish = false,
        troops = troops,
        lastArmy = CommandUi(FeatureId("barracks.lastArmy"), "", "LAST ARMY", null, false, CommandState.ENABLED, null, null),
        footer = FooterUi(listOf("+9 pts · 8m 30s"), listOf(ArmySamples.shards("580")),
            ArmySamples.cmd("barracks.train", "TRAIN 4", Verb.GOLD, sub = "joins the queue")),
    )
    val full = default.copy(
        housing = HousingUi(42, 8, 0, 50, 20, full = true),
        troops = troops.map { if (it.state == TroopCardState.LOCKED) it else it.copy(state = TroopCardState.NO_ROOM, chosen = 0) },
        footer = FooterUi(emptyList(), emptyList(),
            ArmySamples.cmd("barracks.train", "TRAIN", Verb.GOLD, CommandState.DISABLED, reason = "Camp and queue are full. FINISH or raid.")),
    )
}

@Preview(name = "TRAIN: picking with a queue (train.png)", widthDp = 412, heightDp = 915)
@Composable private fun TrainDefaultPreview() {
    SheetPreviewFrame(ArmySheetKind.TRAIN) { TrainSheet(TrainSamples.default, TrainActions(), it) }
}

@Preview(name = "TRAIN: camp and queue full (train-full.png)", widthDp = 412, heightDp = 915)
@Composable private fun TrainFullPreview() {
    SheetPreviewFrame(ArmySheetKind.TRAIN) { TrainSheet(TrainSamples.full, TrainActions(), it) }
}

@Preview(name = "TRAIN: empty draft, empty queue, free first finish hidden", widthDp = 412, heightDp = 915)
@Composable private fun TrainEmptyPreview() {
    val ui = TrainSamples.default.copy(
        header = TrainSamples.header.copy(chip = HeaderChipUi(null, "Barracks ready", null, DotColor.GREEN)),
        housing = HousingUi(24, 0, 0, 50, 20, full = false), queue = emptyList(), finish = null,
        troops = TrainSamples.troops.map { if (it.state == TroopCardState.CHOSEN) it.copy(state = TroopCardState.DEFAULT, chosen = 0) else it },
        footer = FooterUi(listOf("0 pts"), emptyList(),
            ArmySamples.cmd("barracks.train", "TRAIN", Verb.GOLD, CommandState.DISABLED, reason = "Tap troops to add them")))
    SheetPreviewFrame(ArmySheetKind.TRAIN) { TrainSheet(ui, TrainActions(), it) }
}

@Preview(name = "TRAIN: loading (skeletons, never 0)", widthDp = 412, heightDp = 915)
@Composable private fun TrainLoadingPreview() {
    val ui = TrainSamples.default.copy(housing = HousingUi(0, 0, 0, 0, 0, full = false, known = false), queue = emptyList(), finish = null,
        troops = emptyList(), loading = true, lastArmy = null,
        header = TrainSamples.header.copy(chip = HeaderChipUi("timer", "Checking the queue", UNKNOWN)),
        footer = FooterUi(listOf(UNKNOWN), listOf(ArmySamples.shards(null, PriceStatus.CHECKING)),
            ArmySamples.cmd("barracks.train", "TRAIN", Verb.GOLD, CommandState.DISABLED, reason = "Checking the Barracks")))
    SheetPreviewFrame(ArmySheetKind.TRAIN) { TrainSheet(ui, TrainActions(), it) }
}

@Preview(name = "TRAIN: error keeps the last values + toast", widthDp = 412, heightDp = 915)
@Composable private fun TrainErrorPreview() {
    SheetPreviewFrame(ArmySheetKind.TRAIN) { m ->
        Box(Modifier.fillMaxSize()) {
            TrainSheet(TrainSamples.default, TrainActions(), m)
            Toast(ToastUi("barracks.error", "The Barracks can't reach the server. Try again.", null, ToastKind.ERROR, null, null, true, 0L), {}, {},
                Modifier.align(Alignment.TopCenter).padding(top = 40.dp, start = 8.dp, end = 8.dp))
        }
    }
}

@Preview(name = "TRAIN: locked (Barracks upgrading)", widthDp = 412, heightDp = 915)
@Composable private fun TrainLockedPreview() {
    val ui = TrainSamples.default.copy(paused = true,
        footer = TrainSamples.default.footer.copy(primary = ArmySamples.cmd("barracks.train", "TRAIN 4", Verb.GOLD, CommandState.LOCKED,
            reason = "Barracks is upgrading · 2h 10m")))
    SheetPreviewFrame(ArmySheetKind.TRAIN) { TrainSheet(ui, TrainActions(), it) }
}

@Preview(name = "TRAIN: busy (sending) and success (draft cleared into the queue)", widthDp = 824, heightDp = 915)
@Composable private fun TrainBusySuccessPreview() {
    val busy = TrainSamples.default.copy(footer = TrainSamples.default.footer.copy(
        primary = ArmySamples.cmd("barracks.train", "Sending", Verb.GOLD, CommandState.BUSY)))
    val success = TrainSamples.default.copy(
        housing = HousingUi(24, 17, 0, 50, 20, full = false),
        queue = TrainSamples.queue + QueueGroupUi("highlander", "ui_portrait_highlander_t3", 3, null, null) +
            QueueGroupUi("mage", "ui_portrait_mage_t1", 1, null, null),
        troops = TrainSamples.troops.map { if (it.state == TroopCardState.CHOSEN) it.copy(state = TroopCardState.DEFAULT, chosen = 0) else it },
        footer = FooterUi(listOf("0 pts"), emptyList(), ArmySamples.cmd("barracks.train", "TRAIN", Verb.GOLD, CommandState.DISABLED,
            reason = "Tap troops to add them")))
    Row(Modifier.fillMaxSize().background(ArmyInk.grass)) {
        Box(Modifier.weight(1f)) { SheetPreviewFrame(ArmySheetKind.TRAIN) { TrainSheet(busy, TrainActions(), it) } }
        Box(Modifier.weight(1f)) { SheetPreviewFrame(ArmySheetKind.TRAIN) { TrainSheet(success, TrainActions(), it) } }
    }
}
