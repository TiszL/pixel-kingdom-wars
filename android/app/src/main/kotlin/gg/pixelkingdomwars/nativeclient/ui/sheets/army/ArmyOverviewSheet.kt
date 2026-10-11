package gg.pixelkingdomwars.nativeclient.ui.sheets.army

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.EmptyState
import gg.pixelkingdomwars.nativeclient.ui.kit.GoButton
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.SecondaryButton
import gg.pixelkingdomwars.nativeclient.ui.kit.Tag
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.EmptyStateUi
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb

/*
 * Design component: the ARMY overview (design/final/army/SPEC.md §3; army.png): the Army tall sheet's ARMY tab. Housing
 * without the draft, the troops in the camp (5-column ArmyTiles, tap = Info), the two HeroRows with GO to the Heroes
 * sheet, SAVED ARMIES (LOAD / SAVE), and the red ATTACK primary that swaps the sheet to the Raid chooser. Also the
 * combined [ArmySheet] that keeps one frame across TRAIN ↔ ARMY so the body and header cross-fade (120 ms).
 */

/** A hero's readiness in the ARMY tab (SPEC §3 `HeroRowUi.state`). */
enum class HeroState { READY, RESTING, NOT_RECRUITED, LOCKED }

/** One HeroRow (SPEC §3): portrait well with level, name, home / state line, rest meter, READY tag and GO. */
@Immutable data class HeroRowUi(
    /** Hero id ("vex"); handed back by `onHero`. */
    val hero: String,
    /** PS 11 name ("VEX"). */
    val name: String,
    /** 48 px portrait ("hero_vex_portrait"). */
    val portrait: String,
    /** Level tag ("L9", "…"). */
    val level: String,
    /** Readiness. */
    val state: HeroState,
    /** RESTING: seconds until back; null otherwise. */
    val remainingSec: Long?,
    /** RESTING: 0..1 recovered, the 10 dp meter; null draws none. */
    val progress: Float?,
    /** Where GO goes: `Heroes(hero)`, or Build shop › HEROES when not recruited (spec: `Destination`; a registry row). */
    val door: FeatureId,
    /** The VT line: the home ("Hero Altar"), "Resting · back in 1h 20m", "Not recruited". */
    val line: String,
)

/** One saved army slot (SPEC §3 `SavedArmyRow`). */
@Immutable data class SavedArmyUi(
    /** Slot number, 1-based. */
    val slot: Int,
    /** Its name ("Wall breakers"); null for an empty slot. */
    val name: String?,
    /** Up to 3 troop portraits. */
    val preview: List<String>,
    /** An empty slot: dashed row, "Empty · save today's army", SAVE. */
    val empty: Boolean,
    /** SAVE is waiting for the server: dots. */
    val busy: Boolean = false,
)

/** Everything the ARMY tab draws (SPEC §3 `ArmyUi`). */
@Immutable data class ArmyUi(
    /** Camp header; chip "Ready to raid · 42/50" (warhorn); "Camp is empty" when empty. */
    val header: SheetHeaderUi,
    /** Ready and training points (draft 0). */
    val housing: HousingUi,
    /** Seconds until the training queue is done ("· in 2m 10s" in the legend); null when nothing trains. */
    val trainingDoneInSec: Long?,
    /** Troops in the camp. */
    val troops: List<ArmyTileUi>,
    /** The heroes (Vex, Theodor). */
    val heroes: List<HeroRowUi>,
    /** Saved armies. */
    val saved: List<SavedArmyUi>,
    /** Info "42 / 50" + "Heroes 1/2 ready"; primary red ATTACK (DISABLED "Train troops first" when nothing is ready). */
    val footer: FooterUi,
    /** Loading: skeleton tiles when there is no last good view yet. */
    val loading: Boolean = false,
    /** The empty-camp state (warhorn at 40 %, "No troops yet", GO TO BARRACKS); null when troops exist. */
    val emptyCamp: EmptyStateUi? = null,
    /** Queued groups, for the TRAIN tab's red badge. */
    val queuedGroups: Int = 0,
    /** The portrait on the ARMY tab. */
    val armyTabPortrait: String = "ui_portrait_highlander_t1",
)

/** ARMY's callbacks (SPEC §1.2 + §3). */
@Immutable data class ArmyActions(
    val onClose: () -> Unit = {},
    val onHistory: () -> Unit = {},
    /** TRAIN ↔ ARMY (the empty state's GO TO BARRACKS calls it with "TRAIN"). */
    val onTab: (String) -> Unit = {},
    val onResourceRow: (FeatureId) -> Unit = {},
    /** A camp tile: the troop's Info half sheet (stats, research level). */
    val onTroop: (String) -> Unit = {},
    /** A hero row's GO: `Heroes(hero)` (or the row's door when not recruited). */
    val onHero: (String) -> Unit = {},
    /** LOAD: fills the TRAIN draft and switches to TRAIN; spends nothing; trims to the room left (see `trimDraft`). */
    val onLoadSaved: (Int) -> Unit = {},
    /** SAVE today's army into an empty slot. */
    val onSaveSlot: (Int) -> Unit = {},
    /** A tap on a saved army's name: its manage dialog (replace with today's army, delete). The old ArmyScreen editor was
     *  the only place for this, and it is off Home now (c-gap-army). */
    val onManageSaved: (Int) -> Unit = {},
    /** ATTACK: the sheet content swaps to `RaidChooser(MATCH)`; the frame and world stay. */
    val onAttack: () -> Unit = {},
    val onNeedMore: (PriceUi) -> Unit = {},
    val onRefused: (CommandUi) -> Unit = {},
)

/**
 * The ARMY overview sheet (army.png). [modifier] must give it a bounded height (the SheetHost's TALL slot).
 *
 * Pointer rule: a painted panel inside the SheetHost; no full-screen clickable, pointerInput, scrim or draggable here.
 * Only the frame, tiles, rows and buttons take touches.
 */
@Composable fun ArmyOverviewSheet(ui: ArmyUi, on: ArmyActions, modifier: Modifier = Modifier) {
    ArmyTallSheet(ui.header, armyTabs(ARMY_TAB_ARMY, ui.queuedGroups, ui.armyTabPortrait), ARMY_TAB_ARMY,
        on.onClose, on.onHistory, on.onTab, modifier,
        footer = { ArmyFooterBlock(ui, on) }) { ArmyBody(ui, on) }
}

/**
 * The Army sheet with both tabs in one frame (`Destination.Army(tab)`): the frame stays, the body cross-fades 120 ms and
 * the header art cross-fades Barracks ↔ Camp. Close / History / tab / resource taps go to the active tab's actions.
 *
 * Pointer rule: as [TrainSheet] and [ArmyOverviewSheet]: a painted panel only, no scrim or full-screen input.
 */
@Composable fun ArmySheet(tab: String, train: TrainUi, army: ArmyUi, onTrain: TrainActions, onArmy: ArmyActions, modifier: Modifier = Modifier,
    /** Rows the live host paints at the top of the TRAIN panel (a saved training payment's recovery); null draws nothing. */
    trainRecovery: (@Composable ColumnScope.() -> Unit)? = null) {
    val isTrain = tab != ARMY_TAB_ARMY
    ArmyTallSheet(if (isTrain) train.header else army.header, armyTabs(if (isTrain) ARMY_TAB_TRAIN else ARMY_TAB_ARMY, train.queue.size, train.armyTabPortrait),
        if (isTrain) ARMY_TAB_TRAIN else ARMY_TAB_ARMY,
        if (isTrain) onTrain.onClose else onArmy.onClose, if (isTrain) onTrain.onHistory else onArmy.onHistory,
        if (isTrain) onTrain.onTab else onArmy.onTab, modifier,
        footer = { if (isTrain) TrainFooter(train, onTrain) else ArmyFooterBlock(army, onArmy) }) {
        if (isTrain) { trainRecovery?.invoke(this); TrainBody(train, onTrain) } else ArmyBody(army, onArmy)
    }
}

/** army.png footer: PS 11 "42 / 50" and VT 18 "Heroes 1/2 ready", both in ink, beside the red ATTACK. */
@Composable private fun ArmyFooterBlock(ui: ArmyUi, on: ArmyActions) {
    ArmyFooter(ui.footer, on.onAttack, on.onNeedMore, on.onRefused, infoWidth = 128.dp, infoColor = PkwTokens.Colors.textOnParch,
        firstInfoStyle = PkwTokens.Type.caption, firstInfoColor = PkwTokens.Colors.textOnParch)
}

@Composable private fun ColumnScope.ArmyBody(ui: ArmyUi, on: ArmyActions) {
    HousingBlock(ui.housing, ui.trainingDoneInSec, showDraft = false)
    SectionLine("IN THE CAMP", "tap for stats")
    when {
        ui.loading && ui.troops.isEmpty() -> SkeletonGrid(5, 5, 88.dp)
        ui.emptyCamp != null -> EmptyState(ui.emptyCamp, onGo = { on.onTab(ARMY_TAB_TRAIN) })
        else -> CellGrid(ui.troops, 5, hGap = 2.dp) { t, m -> ArmyTile(t, on, m) }
    }
    SectionLine("HEROES", "fight with this army")
    ui.heroes.forEach { HeroRow(it, on) }
    SectionLine("SAVED ARMIES")
    ui.saved.forEach { SavedArmyRow(it, on) }
}

/** ArmyTile (72 × 88): portrait well with the level tag and the count under it; a tap opens the troop's Info. */
@Composable private fun ArmyTile(t: ArmyTileUi, on: ArmyActions, modifier: Modifier) {
    ArmyCard(modifier.heightIn(min = 88.dp), padding = PaddingValues(start = 3.dp, top = 4.dp, end = 3.dp, bottom = 6.dp),
        onClick = { on.onTroop(t.troop) }, description = t.description.ifBlank { "${t.count} ${t.troop}, ${t.level}. Tap for stats" }) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            PortraitWell(t.portrait, level = t.level)
            PkwText(t.count, PkwTokens.Type.caption, color = PkwTokens.Colors.textOnParch)
        }
    }
}

/** HeroRow (60 tall): well 52 with the 48 px portrait and level; name + line + the 150 dp rest meter (only with a real
 *  server progress, never an empty guess); READY tag; blue GO 58 × 44. */
@Composable private fun HeroRow(h: HeroRowUi, on: ArmyActions) {
    val c = PkwTokens.Colors
    ArmyCard(Modifier.fillMaxWidth().heightIn(min = 60.dp), padding = PaddingValues(start = 4.dp, top = 4.dp, end = 6.dp, bottom = 6.dp),
        body = if (h.state == HeroState.LOCKED) ArmyInk.lockedBody else null) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PortraitWell(h.portrait, wellSize = 52.dp, artSize = 48.dp, level = h.level,
                saturation = if (h.state == HeroState.NOT_RECRUITED || h.state == HeroState.LOCKED) 0.4f else 1f,
                artAlpha = if (h.state == HeroState.NOT_RECRUITED) 0.5f else 1f)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                PkwText(h.name, PkwTokens.Type.caption, color = c.textOnParch)
                PkwText(h.line, PkwTokens.Type.small, color = c.textOnParch2)
                val progress = h.progress
                if (h.state == HeroState.RESTING && progress != null) ParchMeter(progress, "${h.name} resting, ${h.line}", Modifier.width(150.dp))
            }
            if (h.state == HeroState.READY) Tag("READY", Verb.GREEN)
            GoButton({ on.onHero(h.hero) }, "Open ${h.name}", Modifier.size(58.dp, 44.dp))
        }
    }
}

/** SavedArmyRow (52 tall): slot number box 28 (PS 12 gold-hi), VT 20 name, up to three mini portraits, stone LOAD 76 × 44;
 *  an empty slot is a dashed parch-dk row on `#EFE2BB` with VT 20 "Empty · save today's army" and SAVE (dots while saving). */
@Composable private fun SavedArmyRow(s: SavedArmyUi, on: ArmyActions) {
    val c = PkwTokens.Colors
    ArmyCard(Modifier.fillMaxWidth().heightIn(min = 52.dp), dashed = s.empty, padding = PaddingValues(start = 6.dp, top = 2.dp, end = 6.dp, bottom = 4.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(28.dp).background(if (s.empty) ArmyInk.parchDk else c.ink), contentAlignment = Alignment.Center) {
                PkwText(s.slot.toString(), PkwTokens.Type.label, color = if (s.empty) c.cream else c.gold.hi)
            }
            if (s.empty) {
                PkwText("Empty · save today's army", PkwTokens.Type.body, Modifier.weight(1f), color = c.textOnParch2)
                if (s.busy) ChunkyBox(c.stone, {}, "Saving", Modifier.size(76.dp, 44.dp), enabled = false) { BusyDots() }
                else SecondaryButton("SAVE", { on.onSaveSlot(s.slot) }, Modifier.size(76.dp, 44.dp), contentDescription = "Save today's army in slot ${s.slot}")
            } else {
                // The name is the slot's manage door (48 dp tall target; LOAD keeps its own button and semantics).
                Box(Modifier.weight(1f).heightIn(min = PkwTokens.Dims.minTap)
                    .clickable(onClickLabel = "Manage ${s.name ?: "slot ${s.slot}"}", role = Role.Button) { on.onManageSaved(s.slot) },
                    contentAlignment = Alignment.CenterStart) {
                    PkwText(s.name ?: UNKNOWN, PkwTokens.Type.body, color = c.textOnParch)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) { s.preview.take(3).forEach { MiniPortrait(it) } }
                SecondaryButton("LOAD", { on.onLoadSaved(s.slot) }, Modifier.size(76.dp, 44.dp), contentDescription = "Load ${s.name ?: "slot ${s.slot}"} into TRAIN")
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------------------------------------------------

internal object ArmySheetSamples {
    val header = SheetHeaderUi("ARMY CAMP", "LV 6", HeaderChipUi("ui_icon_warhorn", "Ready to raid ·", "42/50", emphasisGreen = true),
        HeaderArtUi(SpriteRef("ui_portrait_camp_t3", 56), 1,
            ArmySamples.walkers(listOf("ui_portrait_highlander_t3", "ui_portrait_mage_t1", "ui_portrait_highlander_t3", "ui_portrait_bowman_t1"), Dir8.S, 50),
            buildingXDp = 250, buildingYDp = 10))
    private fun tile(id: String, level: String, count: String, tier: Int = 1) = ArmyTileUi(id, "ui_portrait_${id}_t$tier", level, count)
    val default = ArmyUi(
        header = header,
        housing = HousingUi(38, 4, 0, 50, 20, full = false),
        trainingDoneInSec = 130,
        troops = listOf(tile("highlander", "L3", "x8", 3), tile("bowman", "L4", "x10"), tile("kegrunner", "L2", "x2"), tile("mage", "L1", "x2"),
            tile("tunneler", "L2", "x1")),
        heroes = listOf(
            HeroRowUi("vex", "VEX", "hero_vex_portrait", "L9", HeroState.READY, null, null, FeatureId("heroaltar.hero"), "Hero Altar"),
            HeroRowUi("theodor", "THEODOR", "hero_theo_portrait", "L6", HeroState.RESTING, 4_800, 0.4f, FeatureId("siegestool.hero"),
                "Resting · back in 1h 20m"),
        ),
        saved = listOf(
            SavedArmyUi(1, "Wall breakers", listOf("ui_portrait_kegrunner_t1", "ui_portrait_giant_t1", "ui_portrait_bowman_t1"), empty = false),
            SavedArmyUi(2, "Mage push", listOf("ui_portrait_highlander_t3", "ui_portrait_mage_t1", "ui_portrait_tunneler_t1"), empty = false),
            SavedArmyUi(3, null, emptyList(), empty = true),
        ),
        footer = FooterUi(listOf("42 / 50", "Heroes 1/2 ready"), emptyList(), ArmySamples.cmd("hud.attack", "ATTACK", Verb.RED, icon = "attack")),
        queuedGroups = 2,
    )
}

@Preview(name = "ARMY: overview (army.png)", widthDp = 412, heightDp = 915)
@Composable private fun ArmyDefaultPreview() {
    SheetPreviewFrame(ArmySheetKind.ARMY) { ArmyOverviewSheet(ArmySheetSamples.default, ArmyActions(), it) }
}

@Preview(name = "ARMY: empty camp, no heroes", widthDp = 412, heightDp = 915)
@Composable private fun ArmyEmptyPreview() {
    val ui = ArmySheetSamples.default.copy(
        header = ArmySheetSamples.header.copy(chip = HeaderChipUi("ui_icon_warhorn", "Camp is empty", null)),
        housing = HousingUi(0, 0, 0, 50, 20, full = false), trainingDoneInSec = null, troops = emptyList(),
        emptyCamp = EmptyStateUi("ui_icon_warhorn", "No troops yet", "Train them at the Barracks", "GO TO BARRACKS", FeatureId("barracks.train")),
        heroes = listOf(HeroRowUi("vex", "VEX", "hero_vex_portrait", UNKNOWN, HeroState.NOT_RECRUITED, null, null, FeatureId("buildshop.heroes"), "Not recruited")),
        footer = FooterUi(listOf("0 / 50", "Heroes 0/2 ready"), emptyList(),
            ArmySamples.cmd("hud.attack", "ATTACK", Verb.RED, CommandState.DISABLED, reason = "Train troops first", icon = "attack")))
    SheetPreviewFrame(ArmySheetKind.ARMY) { ArmyOverviewSheet(ui, ArmyActions(), it) }
}

@Preview(name = "ARMY: loading (skeletons) and SAVE busy", widthDp = 412, heightDp = 915)
@Composable private fun ArmyLoadingPreview() {
    val ui = ArmySheetSamples.default.copy(loading = true, troops = emptyList(), housing = HousingUi(0, 0, 0, 0, 0, full = false, known = false),
        trainingDoneInSec = null, saved = ArmySheetSamples.default.saved.map { if (it.empty) it.copy(busy = true) else it },
        footer = FooterUi(listOf("$UNKNOWN / $UNKNOWN"), emptyList(), ArmySamples.cmd("hud.attack", "ATTACK", Verb.RED, icon = "attack")))
    SheetPreviewFrame(ArmySheetKind.ARMY) { ArmyOverviewSheet(ui, ArmyActions(), it) }
}

@Preview(name = "Army sheet, both tabs in one frame (TRAIN active)", widthDp = 412, heightDp = 915)
@Composable private fun ArmySheetCombinedPreview() {
    SheetPreviewFrame(ArmySheetKind.TRAIN) {
        ArmySheet(ARMY_TAB_TRAIN, TrainSamples.default, ArmySheetSamples.default, TrainActions(), ArmyActions(), it)
    }
}

@Preview(name = "ARMY parts on parchment", widthDp = 400, heightDp = 300)
@Composable private fun ArmyRowsPreview() {
    Column(Modifier.background(PkwTokens.Colors.parchment).padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ArmySheetSamples.default.heroes.forEach { HeroRow(it, ArmyActions()) }
        ArmySheetSamples.default.saved.forEach { SavedArmyRow(it, ArmyActions()) }
    }
}
